import Crawler from '../../src/crawler/crawler';
import { ScanRegistry } from '../../src/api/scanRegistry';
import type { CrawlerConfig } from '../../src/types/crawler';

describe('ScanRegistry', () => {
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

    it('rejects invalid config', () => {
        const registry = new ScanRegistry();
        expect(() => registry.createScan({})).toThrow();
    });

    it('creates a scan and exposes running state', () => {
        const registry = new ScanRegistry(() => {
            const c = new Crawler(minimalConfig);
            jest.spyOn(c, 'startCrawling').mockResolvedValue(undefined);
            return c;
        });
        const record = registry.createScan(minimalConfig);
        expect(record.scanId).toBeTruthy();
        expect(record.status).toBe('running');
        expect(record.running).toBe(true);
        expect(registry.getScan(record.scanId)).toBeDefined();
    });

    it('stopScan returns not_found for unknown id', () => {
        const registry = new ScanRegistry();
        expect(registry.stopScan('00000000-0000-0000-0000-000000000000')).toEqual({
            ok: false,
            reason: 'not_found',
        });
    });
});
