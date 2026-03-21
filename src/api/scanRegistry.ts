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
    createScan(rawConfig: unknown): ScanRecord {
        const config = ConfigValidator.validate(rawConfig);
        const scanId = randomUUID();
        const now = Date.now();
        const internal: InternalScan = {
            scanId,
            status: 'running',
            createdAt: now,
            startedAt: now,
            cancelRequested: false,
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
            }
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
