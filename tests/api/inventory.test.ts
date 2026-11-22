import request from 'supertest';

import { createApiApp } from '../../src/api/createApiApp';
import { ScanRegistry } from '../../src/api/scanRegistry';
import Crawler from '../../src/crawler/crawler';
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

/**
 * Builds a registry whose crawler records one endpoint and then finishes, so a
 * scan can complete without launching a browser.
 */
function registryWithCrawledEndpoint(): ScanRegistry {
    return new ScanRegistry(() => {
        const crawler = new Crawler(minimalConfig);
        jest.spyOn(crawler, 'startCrawling').mockImplementation(async () => {
            crawler.inventory.recordRequest('GET', 'https://example.com/discovered?q=1');
        });
        return crawler;
    });
}

/** Waits for a scan to leave the running state. */
async function waitForTerminal(registry: ScanRegistry, scanId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (registry.getScan(scanId)?.running === false) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('scan did not finish');
}

describe('crawl inventory over the API', () => {
    it('serves the inventory of a finished scan', async () => {
        const registry = registryWithCrawledEndpoint();
        const app = createApiApp(registry);

        const created = await request(app).post('/api/v1/scans').send(minimalConfig);
        expect(created.status).toBe(201);
        await waitForTerminal(registry, created.body.scanId);

        const res = await request(app).get(`/api/v1/scans/${created.body.scanId}/inventory`);
        expect(res.status).toBe(200);
        expect(res.body.schemaVersion).toBe(1);
        expect(res.body.entryPoint).toBe('https://example.com');
        expect(res.body.endpoints).toHaveLength(1);
        expect(res.body.endpoints[0].url).toBe('https://example.com/discovered');
        expect(res.body.endpoints[0].queryParams).toEqual(['q']);
    });

    // The registry drops its crawler reference when a scan ends, to release the
    // browser and the crawl graph. The inventory has to survive that, or the
    // only scans anyone scores are the ones that cannot be read.
    it('keeps the inventory after the crawler reference is released', async () => {
        const registry = registryWithCrawledEndpoint();
        const created = registry.createScan(minimalConfig);
        await waitForTerminal(registry, created.scanId);

        expect(registry.getScan(created.scanId)?.status).toBe('completed');
        expect(registry.getInventory(created.scanId)?.stats.endpoints).toBe(1);
    });

    it('serves a running scan from the live crawler', async () => {
        let release: (() => void) | undefined;
        const registry = new ScanRegistry(() => {
            const crawler = new Crawler(minimalConfig);
            jest.spyOn(crawler, 'startCrawling').mockImplementation(async () => {
                crawler.inventory.recordRequest('GET', 'https://example.com/partial');
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
            });
            return crawler;
        });

        const created = registry.createScan(minimalConfig);
        for (let i = 0; i < 100 && !release; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // A six-hour crawl is worth watching, not only autopsying.
        expect(registry.getScan(created.scanId)?.running).toBe(true);
        expect(registry.getInventory(created.scanId)?.stats.endpoints).toBe(1);

        release?.();
        await waitForTerminal(registry, created.scanId);
    });

    it('404s for an unknown scan', async () => {
        const app = createApiApp(new ScanRegistry());
        const res = await request(app).get('/api/v1/scans/does-not-exist/inventory');
        expect(res.status).toBe(404);
        expect(res.body.error).toBeDefined();
    });
});
