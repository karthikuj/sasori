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

describe('createApiApp', () => {
    it('GET /health returns ok', async () => {
        const app = createApiApp(new ScanRegistry());
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
    });

    it('POST /api/v1/scans returns 400 on invalid body', async () => {
        const app = createApiApp(new ScanRegistry());
        const res = await request(app).post('/api/v1/scans').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it('POST /api/v1/scans creates a scan', async () => {
        const registry = new ScanRegistry(() => {
            const c = new Crawler(minimalConfig);
            jest.spyOn(c, 'startCrawling').mockResolvedValue(undefined);
            return c;
        });
        const app = createApiApp(registry);
        const res = await request(app).post('/api/v1/scans').send(minimalConfig);
        expect(res.status).toBe(201);
        expect(res.body.scanId).toBeTruthy();
        expect(res.body.running).toBe(true);
    });

    it('GET unknown scan returns 404', async () => {
        const app = createApiApp(new ScanRegistry());
        const res = await request(app).get('/api/v1/scans/00000000-0000-0000-0000-000000000000');
        expect(res.status).toBe(404);
    });
});
