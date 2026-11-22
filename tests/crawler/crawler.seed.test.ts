/**
 * Crawler.seedCrawl — building the crawl forest at startup (SCAN-229).
 *
 * Driven against a fake page: a map of URL → response. Only action discovery is
 * stubbed (it needs a real DOM); state creation, the inventory, the graph
 * recorder, scope and robots handling all run for real.
 */

import { Page } from 'puppeteer';

import Crawler from '../../src/crawler/crawler';
import CrawlStateManager from '../../src/crawler/crawlStateManager';
import { CrawlerConfig } from '../../src/types/crawler';

interface FakeResource {
    status?: number;
    body?: string;
    /** Where the page ends up after loading this URL. */
    redirect?: string;
    /** DOM hash the page has once loaded; defaults to one per final URL. */
    hash?: string;
    /** Throw on this many loads before succeeding. */
    failures?: number;
}

const ENTRY = 'https://shop.test/';

function makeConfig(crawler: Record<string, unknown> = {}): CrawlerConfig {
    const base = global.testUtils.createValidConfig();
    base.crawler.entryPoint = ENTRY;
    base.crawler.includeRegexes = ['https://shop\\.test(?:/.*|)'];
    base.crawler.excludeRegexes = ['.*logout.*'];
    base.crawler.maxActionRetries = 1;
    Object.assign(base.crawler, crawler);
    return base;
}

function fakePage(site: Record<string, FakeResource>): { page: Page; loads: string[]; current: () => string } {
    let current = 'about:blank';
    const loads: string[] = [];
    const page = {
        goto: jest.fn(async (url: string) => {
            loads.push(url);
            const resource = site[url];
            if (resource?.failures) {
                resource.failures--;
                throw new Error('Navigation timeout of 30000 ms exceeded');
            }
            current = resource?.redirect ?? url;
            const status = resource ? resource.status ?? 200 : 404;
            return {
                ok: () => status >= 200 && status < 300,
                text: async () => resource?.body ?? '',
            };
        }),
        waitForFunction: jest.fn(async () => undefined),
        url: () => current,
    };
    return { page: page as unknown as Page, loads, current: () => current };
}

function makeCrawler(config: CrawlerConfig, site: Record<string, FakeResource>): Crawler {
    const crawler = new Crawler(config);
    // Action discovery needs a real DOM; it is the one unit stubbed here.
    (crawler as unknown as { discovery: unknown }).discovery = {
        getCrawlActions: jest.fn(async () => []),
        getCrawlInputs: jest.fn(async () => []),
    };
    jest.spyOn(crawler, 'getPageHash').mockImplementation(async (page: Page) => {
        const url = page.url();
        return site[url]?.hash ?? `hash:${url}`;
    });
    return crawler;
}

function urlset(...locs: string[]): string {
    return `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
}

async function seed(config: CrawlerConfig, site: Record<string, FakeResource>) {
    const crawler = makeCrawler(config, site);
    const manager = new CrawlStateManager();
    const fake = fakePage(site);
    const roots = await crawler.seedCrawl(fake.page, manager);
    return { crawler, manager, roots, ...fake, urls: roots.map((r) => r.url) };
}

describe('Crawler.seedCrawl', () => {
    describe('entry point only', () => {
        it('builds a single depth-0 link root, exactly as before', async () => {
            const { roots, manager, loads } = await seed(makeConfig(), { [ENTRY]: {} });

            expect(roots).toHaveLength(1);
            expect(roots[0]).toMatchObject({ url: ENTRY, crawlDepth: 0, arrivalType: 'link' });
            expect(manager.rootState).toBe(roots[0]);
            expect(loads).toEqual([ENTRY]); // no robots or sitemap fetch when disabled
        });

        it('returns no roots when the entry point cannot be loaded', async () => {
            const { roots } = await seed(makeConfig(), { [ENTRY]: { failures: 5 } });
            expect(roots).toEqual([]);
        });

        it('retries the entry point up to maxActionRetries', async () => {
            const { roots, loads } = await seed(makeConfig({ maxActionRetries: 2 }), { [ENTRY]: { failures: 1 } });
            expect(loads).toEqual([ENTRY, ENTRY]);
            expect(roots).toHaveLength(1);
        });

        it('records the seed state in the inventory', async () => {
            const { crawler } = await seed(makeConfig(), { [ENTRY]: {} });
            expect(crawler.getInventory().states.map((s) => s.url)).toEqual([ENTRY]);
        });
    });

    describe('extraSeeds', () => {
        it('adds a root per extra seed, after the entry point, in config order', async () => {
            const { urls } = await seed(makeConfig({
                extraSeeds: ['https://shop.test/z', 'https://shop.test/a'],
            }), { [ENTRY]: {}, 'https://shop.test/z': {}, 'https://shop.test/a': {} });

            expect(urls).toEqual([ENTRY, 'https://shop.test/z', 'https://shop.test/a']);
        });

        it('never loads an out-of-scope or excluded seed', async () => {
            const { urls, loads } = await seed(makeConfig({
                extraSeeds: ['https://other.test/x', 'https://shop.test/logout'],
            }), { [ENTRY]: {} });

            expect(urls).toEqual([ENTRY]);
            expect(loads).toEqual([ENTRY]);
        });

        it('skips duplicates of the entry point and of each other, ignoring fragments', async () => {
            const { urls, loads } = await seed(makeConfig({
                extraSeeds: ['https://shop.test/#top', 'https://shop.test/a', 'https://shop.test/a#b'],
            }), { [ENTRY]: {}, 'https://shop.test/a': {} });

            expect(urls).toEqual([ENTRY, 'https://shop.test/a']);
            expect(loads).toEqual([ENTRY, 'https://shop.test/a']);
        });

        it('merges a seed that renders a DOM already held instead of adding a root', async () => {
            const { urls, manager } = await seed(makeConfig({
                extraSeeds: ['https://shop.test/account', 'https://shop.test/orders'],
            }), {
                [ENTRY]: {},
                // Both bounce to the login page: one state, not two roots.
                'https://shop.test/account': { redirect: 'https://shop.test/login', hash: 'login' },
                'https://shop.test/orders': { redirect: 'https://shop.test/login', hash: 'login' },
                'https://shop.test/login': { hash: 'login' },
            });

            expect(urls).toEqual([ENTRY, 'https://shop.test/login']);
            expect(manager.getStates().filter((s) => s.stateHash === 'login')).toHaveLength(1);
        });

        it('merges a seed whose DOM matches the entry point', async () => {
            const { urls } = await seed(makeConfig({ extraSeeds: ['https://shop.test/index.html'] }), {
                [ENTRY]: { hash: 'home' },
                'https://shop.test/index.html': { hash: 'home' },
            });
            expect(urls).toEqual([ENTRY]);
        });

        it('skips a seed that redirects out of scope', async () => {
            const { urls } = await seed(makeConfig({ extraSeeds: ['https://shop.test/sso'] }), {
                [ENTRY]: {},
                'https://shop.test/sso': { redirect: 'https://idp.test/login' },
            });
            expect(urls).toEqual([ENTRY]);
        });

        it('skips a seed that fails and carries on with the rest', async () => {
            const { urls } = await seed(makeConfig({
                extraSeeds: ['https://shop.test/broken', 'https://shop.test/fine'],
            }), {
                [ENTRY]: {},
                'https://shop.test/broken': { failures: 9 },
                'https://shop.test/fine': {},
            });
            expect(urls).toEqual([ENTRY, 'https://shop.test/fine']);
        });

        it('still crawls from the other seeds when the entry point fails', async () => {
            const { urls, manager } = await seed(makeConfig({ extraSeeds: ['https://shop.test/fine'] }), {
                [ENTRY]: { failures: 9 },
                'https://shop.test/fine': {},
            });
            expect(urls).toEqual(['https://shop.test/fine']);
            expect(manager.rootState?.url).toBe('https://shop.test/fine');
        });

        it('isolates a seed whose hashing throws', async () => {
            const site = { [ENTRY]: {}, 'https://shop.test/bad': {}, 'https://shop.test/ok': {} };
            const crawler = makeCrawler(makeConfig({
                extraSeeds: ['https://shop.test/bad', 'https://shop.test/ok'],
            }), site);
            (crawler.getPageHash as jest.Mock).mockImplementation(async (page: Page) => {
                if (page.url().endsWith('/bad')) {
                    throw new Error('Execution context was destroyed');
                }
                return `hash:${page.url()}`;
            });
            const roots = await crawler.seedCrawl(fakePage(site).page, new CrawlStateManager());

            expect(roots.map((r) => r.url)).toEqual([ENTRY, 'https://shop.test/ok']);
        });

        it('stops seeding once the crawl is stopped', async () => {
            const site = { [ENTRY]: {}, 'https://shop.test/a': {}, 'https://shop.test/b': {} };
            const crawler = makeCrawler(makeConfig({
                extraSeeds: ['https://shop.test/a', 'https://shop.test/b'],
            }), site);
            const fake = fakePage(site);
            (fake.page.goto as jest.Mock).mockImplementationOnce(async () => {
                crawler.stopCrawling();
                return { ok: () => true, text: async () => '' };
            });
            await crawler.seedCrawl(fake.page, new CrawlStateManager());

            // The stop landed during the entry point's load; no seed after it was tried.
            expect(fake.page.goto).toHaveBeenCalledTimes(1);
        });
    });

    describe('sitemap discovery', () => {
        const site = (): Record<string, FakeResource> => ({
            [ENTRY]: {},
            'https://shop.test/robots.txt': {
                body: 'User-agent: *\nDisallow: /cart\nSitemap: https://shop.test/products.xml',
            },
            'https://shop.test/products.xml': {
                body: urlset('https://shop.test/p/2', 'https://shop.test/p/1', 'https://shop.test/cart/9'),
            },
            'https://shop.test/sitemap.xml': { body: urlset('https://shop.test/about', 'https://other.test/x') },
            'https://shop.test/p/1': {},
            'https://shop.test/p/2': {},
            'https://shop.test/about': {},
            'https://shop.test/cart/9': {},
        });

        it('seeds from every in-scope, allowed sitemap URL, sorted, after the entry point', async () => {
            const { urls } = await seed(makeConfig({ sitemap: { enabled: true } }), site());
            expect(urls).toEqual([ENTRY, 'https://shop.test/about', 'https://shop.test/p/1', 'https://shop.test/p/2']);
        });

        it('installs robots rules into scope for the whole crawl by default', async () => {
            const { crawler, loads } = await seed(makeConfig({ sitemap: { enabled: true } }), site());

            expect(crawler.inContext('https://shop.test/cart/checkout')).toBe(false);
            expect(crawler.inContext('https://shop.test/p/3')).toBe(true);
            expect(loads).not.toContain('https://shop.test/cart/9');
        });

        it('neither filters seeds nor narrows scope when respectRobots is false', async () => {
            const { urls, crawler } = await seed(makeConfig({ sitemap: { enabled: true, respectRobots: false } }), site());

            expect(urls).toContain('https://shop.test/cart/9');
            expect(crawler.inContext('https://shop.test/cart/checkout')).toBe(true);
        });

        it('caps sitemap seeds at maxSeedUrls', async () => {
            const { urls } = await seed(makeConfig({ sitemap: { enabled: true, maxSeedUrls: 1 } }), site());
            expect(urls).toEqual([ENTRY, 'https://shop.test/about']);
        });

        it('takes explicit seeds before sitemap seeds and does not load one twice', async () => {
            const { urls, loads } = await seed(makeConfig({
                sitemap: { enabled: true },
                extraSeeds: ['https://shop.test/p/2'],
            }), site());

            expect(urls).toEqual([
                ENTRY, 'https://shop.test/p/2', 'https://shop.test/about', 'https://shop.test/p/1',
            ]);
            expect(loads.filter((u) => u === 'https://shop.test/p/2')).toHaveLength(1);
        });

        it('warns when robots.txt disallows the entry point', async () => {
            const warn = console.warn as jest.Mock;
            warn.mockClear();
            await seed(makeConfig({ sitemap: { enabled: true } }), {
                [ENTRY]: {},
                'https://shop.test/robots.txt': { body: 'User-agent: *\nDisallow: /' },
            });
            expect(warn.mock.calls.flat().join(' ')).toMatch(/robots\.txt disallows the entry point/);
        });

        it('keeps the entry point when the site has no robots.txt or sitemap', async () => {
            const { urls, loads } = await seed(makeConfig({ sitemap: { enabled: true } }), { [ENTRY]: {} });

            expect(urls).toEqual([ENTRY]);
            expect(loads).toEqual([ENTRY, 'https://shop.test/robots.txt', 'https://shop.test/sitemap.xml']);
        });

        it('marks every seed as a root in the recorded crawl graph', async () => {
            const { crawler, roots } = await seed(makeConfig({ sitemap: { enabled: true }, recordCrawlGraph: true }), site());
            const graph = crawler.getCrawlGraph()!;
            const rootIds = graph.nodes.filter((n) => n.isRoot).map((n) => n.id);

            expect(rootIds.sort()).toEqual(roots.map((r) => r.stateId).sort());
            expect(rootIds).toHaveLength(4);
        });
    });

    describe('fetchSeedResource', () => {
        it('returns the body of a 2xx response', async () => {
            const crawler = makeCrawler(makeConfig(), {});
            const { page } = fakePage({ 'https://shop.test/robots.txt': { body: 'User-agent: *' } });
            await expect(crawler.fetchSeedResource(page, 'https://shop.test/robots.txt')).resolves.toBe('User-agent: *');
        });

        it('returns null for a non-2xx response', async () => {
            const crawler = makeCrawler(makeConfig(), {});
            const { page } = fakePage({ 'https://shop.test/sitemap.xml': { status: 403, body: 'Out of Sasori\'s scope' } });
            await expect(crawler.fetchSeedResource(page, 'https://shop.test/sitemap.xml')).resolves.toBeNull();
        });

        it('returns null when the load throws', async () => {
            const crawler = makeCrawler(makeConfig(), {});
            const { page } = fakePage({ 'https://shop.test/sitemap.xml': { failures: 1 } });
            await expect(crawler.fetchSeedResource(page, 'https://shop.test/sitemap.xml')).resolves.toBeNull();
        });

        it('refuses an oversized body rather than truncating it', async () => {
            const crawler = makeCrawler(makeConfig(), {});
            const { page } = fakePage({ 'https://shop.test/sitemap.xml': { body: 'x'.repeat(10 * 1024 * 1024 + 1) } });
            await expect(crawler.fetchSeedResource(page, 'https://shop.test/sitemap.xml')).resolves.toBeNull();
        });
    });
});
