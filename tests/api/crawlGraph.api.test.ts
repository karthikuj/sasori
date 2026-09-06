/**
 * The crawl graph over the API (SCAN-197 follow-up).
 *
 * The recorder used to be switched on by `crawlGraphFile` alone, so it ran only
 * for a hand-run CLI crawl — and never for a scan driven through the API, which
 * is the only way Nara runs Sasori. The artifact that exists to diagnose a
 * coverage gap was therefore unavailable in exactly the runs whose coverage
 * anyone was investigating; two separate investigations into a missing endpoint
 * had to infer from the crawl's side effects what this file would have said
 * outright.
 *
 * `recordCrawlGraph` turns the recording on without asking the server to write
 * files, and the graph is served the same way the inventory is: live while the
 * scan runs, from a snapshot once it has ended.
 */

import request from 'supertest';

import { createApiApp } from '../../src/api/createApiApp';
import { ScanRegistry } from '../../src/api/scanRegistry';
import Crawler from '../../src/crawler/crawler';
import CrawlState from '../../src/crawler/crawlState';
import type { CrawlerConfig } from '../../src/types/crawler';

function config(recordCrawlGraph: boolean): CrawlerConfig {
    return {
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
            ...(recordCrawlGraph ? { recordCrawlGraph: true } : {}),
        },
    };
}

/**
 * A registry whose crawler records one state into the graph and finishes, so a
 * scan completes without launching a browser.
 */
function registryRecording(recordCrawlGraph: boolean): ScanRegistry {
    return new ScanRegistry(() => {
        const crawler = new Crawler(config(recordCrawlGraph));
        jest.spyOn(crawler, 'startCrawling').mockImplementation(async () => {
            // Reach into the same hook the crawl loop uses, so the test exercises
            // the recorder rather than a stand-in for it.
            const recorder = (crawler as unknown as { graphRecorder: { recordState(s: CrawlState): void } | null }).graphRecorder;
            recorder?.recordState(new CrawlState('https://example.com/', 'root-hash', 0, 'link'));
        });
        return crawler;
    });
}

async function waitForTerminal(registry: ScanRegistry, scanId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (registry.getScan(scanId)?.running === false) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('scan did not finish');
}

describe('crawl graph over the API', () => {
    it('serves the graph of a finished scan when recording is on', async () => {
        const registry = registryRecording(true);
        const app = createApiApp(registry);

        const created = await request(app).post('/api/v1/scans').send(config(true));
        expect(created.status).toBe(201);
        await waitForTerminal(registry, created.body.scanId);

        const res = await request(app).get(`/api/v1/scans/${created.body.scanId}/crawl-graph`);
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('recorded');
        expect(res.body.entryPoint).toBe('https://example.com');
        expect(res.body.stateCount).toBe(1);
        expect(res.body.statusCounts).toHaveProperty('revisited');
    });

    // The crawler reference is dropped when a scan ends, to release the browser.
    // The graph has to survive that the way the inventory does, or it is readable
    // only while the scan is running — which is never when someone asks.
    it('still serves the graph after the crawler reference is released', async () => {
        const registry = registryRecording(true);
        const app = createApiApp(registry);

        const created = await request(app).post('/api/v1/scans').send(config(true));
        await waitForTerminal(registry, created.body.scanId);

        const record = registry.getScan(created.body.scanId) as unknown as { crawler?: unknown };
        expect(record.crawler).toBeUndefined();

        const res = await request(app).get(`/api/v1/scans/${created.body.scanId}/crawl-graph`);
        expect(res.status).toBe(200);
        expect(res.body.stateCount).toBe(1);
    });

    it('answers 404 for a scan that recorded no graph', async () => {
        const registry = registryRecording(false);
        const app = createApiApp(registry);

        const created = await request(app).post('/api/v1/scans').send(config(false));
        await waitForTerminal(registry, created.body.scanId);

        const res = await request(app).get(`/api/v1/scans/${created.body.scanId}/crawl-graph`);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no crawl graph/i);
    });

    it('answers 404 for an unknown scan', async () => {
        const app = createApiApp(registryRecording(true));
        const res = await request(app).get('/api/v1/scans/does-not-exist/crawl-graph');
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
});
