import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import Crawler from '../../src/crawler/crawler';
import { CompletionOutbox } from '../../src/api/completionOutbox';
import { ScanRegistry } from '../../src/api/scanRegistry';
import type { CrawlerConfig } from '../../src/types/crawler';

const minimalConfig: CrawlerConfig = {
    browser: {
        headless: true,
        maximize: false,
        proxy: { enabled: false },
        instances: 1,
        slowMo: 0,
    },
    crawler: {
        entryPoint: 'https://example.com',
        eventTimeout: 5000,
        navigationTimeout: 30000,
        eventWait: 0,
        maxDuration: 1,
        elements: ['a'],
        maxChildren: 1,
        maxDepth: 1,
        authentication: {
            basicAuth: { enabled: false },
            recorderAuth: { enabled: false },
        },
        includeRegexes: ['https?://example\\.com(?:/.*|)'],
        excludeRegexes: [],
    },
};

async function tempOutbox(fetchImpl?: jest.Mock): Promise<CompletionOutbox> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sasori-registry-'));
    return new CompletionOutbox({
        dir,
        fetchImpl: (fetchImpl ?? jest.fn().mockResolvedValue({ ok: true, status: 200 })) as unknown as typeof fetch,
        baseBackoffMs: 0,
    });
}

/** Lets a test control exactly when the crawl finishes. */
function deferredCrawler(): { crawler: Crawler; finish: () => void; stopCrawling: jest.Mock } {
    const crawler = new Crawler(minimalConfig);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    jest.spyOn(crawler, 'startCrawling').mockImplementation(() => gate);
    const stopCrawling = jest.fn();
    jest.spyOn(crawler, 'stopCrawling').mockImplementation(stopCrawling);

    return { crawler, finish: release, stopCrawling };
}

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Polls until `predicate` holds. Needed because completion delivery goes through
 * the outbox, which does real filesystem work — a fixed number of microtask
 * flushes is not enough to cover it and would make these tests flaky.
 */
async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs = 3000,
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for: ${description}`);
}

describe('ScanRegistry — stop race (S3)', () => {
    // The regression: stopScan lands after createScan returns but before
    // rec.crawler is assigned. cancelRequested is set, but stopScan finds no
    // crawler to stop, and runScan then starts crawling anyway.
    it('honours a stop that arrives before the crawler is assigned', async () => {
        let built!: ReturnType<typeof deferredCrawler>;
        let stopResult: ReturnType<ScanRegistry['stopScan']> | undefined;

        // The factory runs inside runScan, after the scan is in the map but
        // before rec.crawler is assigned — precisely the window the bug lived in.
        // Stopping from here reproduces it: stopScan sets cancelRequested but
        // finds no crawler to stop.
        const registry: ScanRegistry = new ScanRegistry(
            () => {
                const running = registry.listScans().find((s) => s.status === 'running');
                if (running) {
                    stopResult = registry.stopScan(running.scanId);
                }
                built = deferredCrawler();
                return built.crawler;
            },
            { outbox: await tempOutbox() },
        );

        const record = registry.createScan(minimalConfig);
        await flush();
        await flush();

        // Confirms the test actually exercised the race rather than passing
        // vacuously.
        expect(stopResult).toEqual({ ok: true });
        expect(built.crawler.startCrawling).not.toHaveBeenCalled();
        expect(built.stopCrawling).toHaveBeenCalled();
        expect(registry.getScan(record.scanId)?.status).toBe('stopped');
    });

    it('still stops normally when the crawler is already assigned', async () => {
        const built = deferredCrawler();
        const registry = new ScanRegistry(() => built.crawler, { outbox: await tempOutbox() });

        const record = registry.createScan(minimalConfig);
        await flush();

        expect(registry.stopScan(record.scanId)).toEqual({ ok: true });
        expect(built.stopCrawling).toHaveBeenCalled();

        built.finish();
        await flush();
    });

    it('reports not_running once the scan has finished', async () => {
        const registry = new ScanRegistry(
            () => {
                const c = new Crawler(minimalConfig);
                jest.spyOn(c, 'startCrawling').mockResolvedValue(undefined);
                jest.spyOn(c, 'wasStopped').mockReturnValue(false);
                return c;
            },
            { outbox: await tempOutbox() },
        );

        const record = registry.createScan(minimalConfig);
        await flush();
        await flush();

        expect(registry.stopScan(record.scanId)).toEqual({ ok: false, reason: 'not_running' });
    });
});

describe('ScanRegistry — retention (S2)', () => {
    const finishedRegistry = async (options: {
        terminalRetentionMs?: number;
        maxScans?: number;
    }): Promise<ScanRegistry> =>
        new ScanRegistry(
            () => {
                const c = new Crawler(minimalConfig);
                jest.spyOn(c, 'startCrawling').mockResolvedValue(undefined);
                jest.spyOn(c, 'wasStopped').mockReturnValue(false);
                return c;
            },
            { outbox: await tempOutbox(), ...options },
        );

    it('evicts terminal scans past the retention window', async () => {
        const registry = await finishedRegistry({ terminalRetentionMs: 0 });

        const first = registry.createScan(minimalConfig);
        await waitFor(
            () => registry.getScan(first.scanId)?.status === 'completed',
            'first scan to finish',
        );

        // Creating another scan sweeps the expired one.
        registry.createScan(minimalConfig);
        await flush();

        expect(registry.getScan(first.scanId)).toBeUndefined();
    });

    it('keeps terminal scans inside the retention window', async () => {
        const registry = await finishedRegistry({ terminalRetentionMs: 60_000 });

        const first = registry.createScan(minimalConfig);
        await waitFor(
            () => registry.getScan(first.scanId)?.status === 'completed',
            'first scan to finish',
        );

        registry.createScan(minimalConfig);
        await flush();

        expect(registry.getScan(first.scanId)).toBeDefined();
    });

    it('enforces the hard ceiling by dropping the oldest finished scans', async () => {
        const registry = await finishedRegistry({ terminalRetentionMs: 60_000, maxScans: 3 });

        const ids: string[] = [];
        for (let i = 0; i < 6; i += 1) {
            const id = registry.createScan(minimalConfig).scanId;
            ids.push(id);
            await waitFor(
                () => registry.getScan(id) === undefined || registry.getScan(id)?.status === 'completed',
                `scan ${i} to finish`,
            );
        }

        expect(registry.listScans().length).toBeLessThanOrEqual(3);
        // Oldest gone, newest kept.
        expect(registry.getScan(ids[0]!)).toBeUndefined();
        expect(registry.getScan(ids[5]!)).toBeDefined();
    });

    // Evicting a live crawl would orphan it with no way to stop or observe it.
    it('never evicts a running scan, even over the ceiling', async () => {
        const gates: Array<() => void> = [];
        const registry = new ScanRegistry(
            () => {
                const built = deferredCrawler();
                gates.push(built.finish);
                return built.crawler;
            },
            { outbox: await tempOutbox(), terminalRetentionMs: 0, maxScans: 2 },
        );

        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
            ids.push(registry.createScan(minimalConfig).scanId);
            await flush();
        }

        for (const id of ids) {
            expect(registry.getScan(id)?.status).toBe('running');
        }

        gates.forEach((finish) => finish());
        await flush();
    });
});

describe('ScanRegistry — completion delivery (S1)', () => {
    it('routes the completion callback through the durable outbox', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        const outbox = await tempOutbox(fetchImpl);
        const registry = new ScanRegistry(
            () => {
                const c = new Crawler(minimalConfig);
                jest.spyOn(c, 'startCrawling').mockResolvedValue(undefined);
                jest.spyOn(c, 'wasStopped').mockReturnValue(false);
                return c;
            },
            { outbox },
        );

        registry.createScan(minimalConfig, {
            callback: { url: 'http://backend/crawl-complete', secret: 'shh' },
            backendScanId: 99,
        });
        await waitFor(
            async () => fetchImpl.mock.calls.length > 0 && (await outbox.pendingCount()) === 0,
            'completion callback to be delivered and cleared from the outbox',
        );

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.backend_scan_id).toBe(99);
        expect(body.status).toBe('completed');
        expect(await outbox.pendingCount()).toBe(0);
    });

    // The whole point of S1: the crawl result is not lost when the backend is
    // unreachable at exactly the wrong moment.
    it('retains the completion event when the backend is down', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const outbox = await tempOutbox(fetchImpl);
        const registry = new ScanRegistry(
            () => {
                const c = new Crawler(minimalConfig);
                jest.spyOn(c, 'startCrawling').mockResolvedValue(undefined);
                jest.spyOn(c, 'wasStopped').mockReturnValue(false);
                return c;
            },
            { outbox },
        );

        registry.createScan(minimalConfig, {
            callback: { url: 'http://backend/crawl-complete' },
            backendScanId: 7,
        });
        await waitFor(async () => (await outbox.pendingCount()) === 1, 'event to be persisted');

        expect(await outbox.pendingCount()).toBe(1);
        expect(await registry.deliveryBacklog()).toEqual({ pending: 1, deadLettered: 0 });
    });

    it('does not enqueue anything when no callback was configured', async () => {
        const fetchImpl = jest.fn();
        const outbox = await tempOutbox(fetchImpl);
        const registry = new ScanRegistry(
            () => {
                const c = new Crawler(minimalConfig);
                jest.spyOn(c, 'startCrawling').mockResolvedValue(undefined);
                jest.spyOn(c, 'wasStopped').mockReturnValue(false);
                return c;
            },
            { outbox },
        );

        registry.createScan(minimalConfig);
        await flush();
        await flush();

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(await outbox.pendingCount()).toBe(0);
    });
});
