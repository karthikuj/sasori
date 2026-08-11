import { randomUUID } from 'crypto';
import path from 'path';

import Crawler from '../crawler/crawler';
import { ConfigValidator } from '../config/configLoader';
import { CompletionOutbox } from './completionOutbox';
import type { CrawlerConfig } from '../types/crawler';
import type { ScanRecord, ScanStatus } from './scanTypes';

export type CrawlerFactory = (config: CrawlerConfig) => Crawler;

export interface ScanRegistryOptions {
    /**
     * Durable store for completion callbacks. Defaults to a file-backed outbox
     * under SASORI_OUTBOX_DIR (or ./.sasori/outbox).
     */
    outbox?: CompletionOutbox;
    /**
     * How long a finished scan stays queryable before eviction, in ms.
     * Default 6 hours — long enough for the backend to reconcile, short enough
     * that a long-lived process does not accumulate scans forever.
     */
    terminalRetentionMs?: number;
    /**
     * Hard ceiling on retained scans. When exceeded, the oldest terminal scans
     * are evicted first. Running scans are never evicted. Default 1000.
     */
    maxScans?: number;
}

/** Terminal statuses: a scan in one of these will never change again. */
const TERMINAL_STATUSES: ReadonlySet<ScanStatus> = new Set<ScanStatus>([
    'completed',
    'stopped',
    'failed',
]);

const DEFAULT_TERMINAL_RETENTION_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_SCANS = 1000;

export type StopScanResult =
    | { ok: true }
    | { ok: false; reason: 'not_found' | 'not_running' };

interface InternalScan {
    scanId: string;
    status: ScanStatus;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    cancelRequested: boolean;
    crawler?: Crawler;
    callback?: CompletionCallbackMeta;
    backendScanId?: number;
}

interface CompletionCallbackMeta {
    url: string;
    secret?: string;
}

/**
 * In-memory registry of concurrent scans. Each scan uses its own {@link Crawler} instance.
 * Intended for a single API process; not shared across hosts.
 */
export class ScanRegistry {
    private readonly scans = new Map<string, InternalScan>();

    private readonly crawlerFactory: CrawlerFactory;

    private readonly outbox: CompletionOutbox;

    private readonly terminalRetentionMs: number;

    private readonly maxScans: number;

    constructor(crawlerFactory?: CrawlerFactory, options?: ScanRegistryOptions) {
        this.crawlerFactory = crawlerFactory ?? ((config) => new Crawler(config));
        this.outbox =
            options?.outbox ??
            new CompletionOutbox({
                dir:
                    process.env.SASORI_OUTBOX_DIR ??
                    path.join(process.cwd(), '.sasori', 'outbox'),
            });
        this.terminalRetentionMs = options?.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
        this.maxScans = options?.maxScans ?? DEFAULT_MAX_SCANS;
    }

    /**
     * Starts the outbox retry loop and re-attempts anything left over from a
     * previous process. Call once at startup.
     */
    startBackgroundDelivery(intervalMs?: number): void {
        this.outbox.start(intervalMs);
        void this.outbox.drainOnce();
    }

    /** Stops the outbox retry loop. Pending events stay on disk. */
    stopBackgroundDelivery(): void {
        this.outbox.stop();
    }

    /** Exposed for health/diagnostics: undelivered and dead-lettered counts. */
    async deliveryBacklog(): Promise<{ pending: number; deadLettered: number }> {
        return {
            pending: await this.outbox.pendingCount(),
            deadLettered: await this.outbox.deadLetterCount(),
        };
    }

    /**
     * Validates config, registers a new scan, and starts the crawl asynchronously.
     */
    createScan(rawConfig: unknown, meta?: { callback?: CompletionCallbackMeta; backendScanId?: number }): ScanRecord {
        const config = ConfigValidator.validate(rawConfig);
        const scanId = randomUUID();
        const now = Date.now();
        const internal: InternalScan = {
            scanId,
            status: 'running',
            createdAt: now,
            startedAt: now,
            cancelRequested: false,
            ...(meta?.callback ? {callback: meta.callback} : {}),
            ...(typeof meta?.backendScanId === 'number' ? {backendScanId: meta.backendScanId} : {}),
        };
        this.scans.set(scanId, internal);
        // Reclaim finished scans *after* inserting, so maxScans is an exact
        // ceiling on the map rather than a limit the new entry immediately
        // exceeds. Sweeping here rather than on a timer keeps the registry free
        // of background state — this method is the only way the map grows.
        this.evictTerminalScans();
        void this.runScan(scanId, config).catch((err) => {
            // eslint-disable-next-line no-console
            console.error(`[sasori api] scan ${scanId} unhandled rejection:`, err);
        });
        return this.toPublic(internal);
    }

    getScan(scanId: string): ScanRecord | undefined {
        const internal = this.scans.get(scanId);
        return internal ? this.toPublic(internal) : undefined;
    }

    listScans(): ScanRecord[] {
        return [...this.scans.values()].map((s) => this.toPublic(s));
    }

    /**
     * Requests cooperative stop: aborts the crawl and closes browsers if running.
     * Idempotent while status is still `running`.
     */
    stopScan(scanId: string): StopScanResult {
        const rec = this.scans.get(scanId);
        if (!rec) {
            return { ok: false, reason: 'not_found' };
        }
        if (rec.status !== 'running') {
            return { ok: false, reason: 'not_running' };
        }
        rec.cancelRequested = true;
        if (rec.crawler) {
            rec.crawler.stopCrawling();
        }
        return { ok: true };
    }

    /**
     * Drops finished scans that are older than the retention window, then
     * enforces the hard ceiling by evicting the oldest terminal scans.
     *
     * Running scans are never evicted — losing one would orphan a live crawl
     * with no way to stop or observe it. That means a registry saturated with
     * running scans can still exceed maxScans, which is the correct trade: the
     * bound exists to stop *finished* scans accumulating for the life of the
     * process, not to cap concurrency.
     *
     * Evicting a scan does not risk its completion callback — that lives in the
     * outbox, which is independent of this map by design.
     */
    private evictTerminalScans(now = Date.now()): number {
        let evicted = 0;

        for (const [scanId, scan] of this.scans) {
            if (!this.isTerminal(scan) || scan.finishedAt === undefined) {
                continue;
            }
            if (now - scan.finishedAt > this.terminalRetentionMs) {
                this.scans.delete(scanId);
                evicted += 1;
            }
        }

        if (this.scans.size <= this.maxScans) {
            return evicted;
        }

        const terminal = [...this.scans.entries()]
            .filter(([, scan]) => this.isTerminal(scan))
            .sort(([, a], [, b]) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));

        for (const [scanId] of terminal) {
            if (this.scans.size <= this.maxScans) {
                break;
            }
            this.scans.delete(scanId);
            evicted += 1;
        }
        return evicted;
    }

    private isTerminal(scan: InternalScan): boolean {
        return TERMINAL_STATUSES.has(scan.status);
    }

    private async runScan(scanId: string, config: CrawlerConfig): Promise<void> {
        const rec = this.scans.get(scanId);
        if (!rec) {
            return;
        }
        if (rec.cancelRequested) {
            rec.status = 'stopped';
            rec.finishedAt = Date.now();
            return;
        }

        try {
            const crawler = this.crawlerFactory(config);
            rec.crawler = crawler;

            // Re-check after publishing the crawler reference. stopScan may have
            // run in the window between the check above and this assignment: it
            // would have set cancelRequested but found rec.crawler undefined, so
            // it issued no stop. Without this the crawl starts anyway and the
            // user's stop is silently ignored.
            //
            // Ordering matters — the check must come *after* the assignment. A
            // stop arriving from here on finds rec.crawler set and stops the
            // crawler directly, so between the two there is no gap.
            if (rec.cancelRequested) {
                crawler.stopCrawling();
                rec.status = 'stopped';
                return;
            }

            await crawler.startCrawling();
            if (crawler.wasStopped()) {
                rec.status = 'stopped';
            } else {
                rec.status = 'completed';
            }
        } catch (err) {
            const current = this.scans.get(scanId);
            if (!current) {
                return;
            }
            const crawlerRef = current.crawler;
            if (crawlerRef?.wasStopped()) {
                current.status = 'stopped';
            } else {
                current.status = 'failed';
                current.error = err instanceof Error ? err.message : String(err);
            }
        } finally {
            const done = this.scans.get(scanId);
            if (done) {
                delete done.crawler;
                done.finishedAt = Date.now();
                void this.notifyCompletion(done);
            }
        }
    }

    /**
     * Hands the completion event to the durable outbox.
     *
     * Previously this looped four times in memory and then gave up silently, so
     * a backend that happened to be restarting when a crawl finished left the
     * scan stranded "Running" in the backend forever — which then blocked every
     * future scan of that web asset. The outbox persists the event before the
     * first attempt, so delivery now survives both a long backend outage and a
     * Sasori restart.
     */
    private async notifyCompletion(scan: InternalScan): Promise<void> {
        if (!scan.callback?.url || !scan.backendScanId) {
            return;
        }

        try {
            await this.outbox.enqueue({
                url: scan.callback.url,
                ...(scan.callback.secret ? { secret: scan.callback.secret } : {}),
                payload: {
                    backend_scan_id: scan.backendScanId,
                    sasori_scan_id: scan.scanId,
                    status: scan.status,
                    finished_at: scan.finishedAt,
                    error: scan.error,
                },
            });
        } catch (err) {
            // Reaching here means the event could not even be written to disk —
            // the one failure mode the outbox cannot absorb. Log loudly: the
            // backend will not finalize this scan without manual intervention.
            // eslint-disable-next-line no-console
            console.error(
                '[sasori api] FAILED to persist completion for backend_scan_id=' +
                    `${String(scan.backendScanId)}; the scan will remain Running in the backend:`,
                err,
            );
        }
    }

    private toPublic(internal: InternalScan): ScanRecord {
        const running = internal.status === 'running';
        const base: ScanRecord = {
            scanId: internal.scanId,
            status: internal.status,
            running,
            createdAt: internal.createdAt,
        };
        const withOptional: ScanRecord = { ...base };
        if (internal.startedAt !== undefined) {
            withOptional.startedAt = internal.startedAt;
        }
        if (internal.finishedAt !== undefined) {
            withOptional.finishedAt = internal.finishedAt;
        }
        if (internal.error !== undefined) {
            withOptional.error = internal.error;
        }
        return withOptional;
    }
}
