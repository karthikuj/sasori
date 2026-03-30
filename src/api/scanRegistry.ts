import { randomUUID } from 'crypto';

import Crawler from '../crawler/crawler';
import { ConfigValidator } from '../config/configLoader';
import type { CrawlerConfig } from '../types/crawler';
import type { ScanRecord, ScanStatus } from './scanTypes';

export type CrawlerFactory = (config: CrawlerConfig) => Crawler;

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

    constructor(crawlerFactory?: CrawlerFactory) {
        this.crawlerFactory = crawlerFactory ?? ((config) => new Crawler(config));
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

    private async notifyCompletion(scan: InternalScan): Promise<void> {
        if (!scan.callback?.url || !scan.backendScanId) {
            return;
        }
        const payload = {
            backend_scan_id: scan.backendScanId,
            sasori_scan_id: scan.scanId,
            status: scan.status,
            finished_at: scan.finishedAt,
            error: scan.error,
        };
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (scan.callback.secret) {
            headers['X-Sasori-Callback-Secret'] = scan.callback.secret;
        }

        let delayMs = 500;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            try {
                const response = await fetch(scan.callback.url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload),
                });
                if (response.ok) {
                    return;
                }
            } catch {
                // intentionally ignored, retry below
            }
            await new Promise((resolve) => {
                setTimeout(resolve, delayMs);
            });
            delayMs *= 2;
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
