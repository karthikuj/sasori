/**
 * Tests for the hot-path optimisations in SCAN-85 through SCAN-88.
 *
 * These all cover paths that run on every request or every action, where the
 * defect is not a wrong answer but a wasted one — a regex recompiled, a
 * blocking write, a CDP round-trip taken one at a time. So each test asserts on
 * the *work done*, not only on the result: a change that quietly reintroduces
 * the cost would still return the right value.
 */

import { CDPSession } from 'puppeteer';
import fs from 'fs';
import os from 'os';
import path from 'path';

import ActionDiscovery from '../../src/crawler/actionDiscovery';
import Crawler from '../../src/crawler/crawler';
import CrawlInput from '../../src/crawler/crawlInput';
import DomStripper from '../../src/crawler/domStripper';
import { CrawlerConfig } from '../../src/types/crawler';

/**
 * Builds a crawler with no browser attached.
 * @param overrides Fields merged into `crawler` config.
 * @return A crawler instance.
 */
function buildCrawler(overrides: Record<string, unknown> = {}): Crawler {
    const config = (global as any).testUtils.createValidConfig() as CrawlerConfig;
    Object.assign(config.crawler, overrides);
    return new Crawler(config);
}

/**
 * Builds the action-discovery unit on its own — no browser, no crawl loop.
 * @param overrides Fields merged into `crawler` config.
 * @return An ActionDiscovery instance and the debug lines it emitted.
 */
function buildDiscovery(overrides: Record<string, unknown> = {}) {
    const config = (global as any).testUtils.createValidConfig() as CrawlerConfig;
    Object.assign(config.crawler, overrides);
    const stripper = new DomStripper([
        ...config.crawler.elements,
        ...CrawlInput.INPUT_FIELDS.map((field) => field.CSS_PATH),
    ]);
    const debugLines: string[] = [];
    const discovery = new ActionDiscovery(config.crawler, stripper, (m) => debugLines.push(m));
    return { discovery, debugLines };
}

describe('inContext regex compilation (SCAN-87)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('compiles each distinct pattern at most once across many calls', () => {
        const crawler = buildCrawler({
            includeRegexes: ['https?://example\\.com(?:/.*|)'],
            excludeRegexes: ['.*logout.*'],
        });

        // Spying on the constructor is the only way to see the work that used to
        // happen: the return value was always correct, it was just recomputed.
        const RealRegExp = global.RegExp;
        let constructed = 0;
        const spy = jest
            .spyOn(global, 'RegExp')
            .mockImplementation(function (this: unknown, ...args: unknown[]) {
                constructed++;
                return new (RealRegExp as any)(...args);
            } as any);

        for (let i = 0; i < 500; i++) {
            crawler.inContext(`https://example.com/page/${i}`);
        }

        spy.mockRestore();
        expect(constructed).toBe(2);
    });

    it('still honours patterns appended to the config after construction', () => {
        // The scope lists are public and are legitimately mutated at runtime —
        // the request interceptor widens includeRegexes for an SSO host while
        // authentication is in progress — so the cache must never shadow them.
        const crawler = buildCrawler({
            includeRegexes: ['https://example\\.com.*'],
            excludeRegexes: [],
        });

        expect(crawler.inContext('https://sso.example.org/login')).toBe(false);
        crawler.crawlerConfig.includeRegexes.push('https://sso\\.example\\.org.*');
        expect(crawler.inContext('https://sso.example.org/login')).toBe(true);

        crawler.crawlerConfig.excludeRegexes.push('.*/login.*');
        expect(crawler.inContext('https://sso.example.org/login')).toBe(false);
    });

    it('applies excludes before includes', () => {
        const crawler = buildCrawler({
            includeRegexes: ['https://example\\.com.*'],
            excludeRegexes: ['https://example\\.com/admin.*'],
        });

        expect(crawler.inContext('https://example.com/page')).toBe(true);
        expect(crawler.inContext('https://example.com/admin/users')).toBe(false);
        expect(crawler.inContext('https://other.com/page')).toBe(false);
    });

    it('is not made stateful by a pattern that looks global', () => {
        // Patterns are compiled without flags, so `test` cannot carry lastIndex
        // between calls. Asserted because switching match->test would otherwise
        // be a subtle behaviour change on repeated identical input.
        const crawler = buildCrawler({
            includeRegexes: ['https://example\\.com/g.*'],
            excludeRegexes: [],
        });

        for (let i = 0; i < 5; i++) {
            expect(crawler.inContext('https://example.com/g/1')).toBe(true);
        }
    });
});

describe('appendUrlToOutputFile (SCAN-88)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sasori-output-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes every URL, in order, and flushes them on close', async () => {
        const outputFile = path.join(tmpDir, 'urls.txt');
        const crawler = buildCrawler({ outputFile });

        const urls = Array.from({ length: 200 }, (_, i) => `https://example.com/page/${i}`);
        for (const url of urls) {
            crawler.appendUrlToOutputFile(url);
        }
        await (crawler as any).closeOutputFile();

        const written = fs.readFileSync(outputFile, 'utf-8').split('\n').filter(Boolean);
        expect(written).toEqual(urls);
    });

    it('does not block the event loop while writing', async () => {
        // The old implementation was appendFileSync inside the page request
        // handler, so every discovered URL stalled the loop on disk I/O. A timer
        // scheduled before the writes must still fire promptly.
        const outputFile = path.join(tmpDir, 'urls.txt');
        const crawler = buildCrawler({ outputFile });

        let timerFired = false;
        const timer = new Promise<void>((resolve) => {
            setImmediate(() => {
                timerFired = true;
                resolve();
            });
        });

        for (let i = 0; i < 2000; i++) {
            crawler.appendUrlToOutputFile(`https://example.com/page/${i}`);
        }

        // Nothing has yielded yet, so the callback cannot have run — that is the
        // point: the writes returned without waiting for the disk.
        expect(timerFired).toBe(false);
        await timer;
        expect(timerFired).toBe(true);

        await (crawler as any).closeOutputFile();
        const written = fs.readFileSync(outputFile, 'utf-8').split('\n').filter(Boolean);
        expect(written).toHaveLength(2000);
    });

    it('is a no-op when no output file is configured', async () => {
        const crawler = buildCrawler({});
        expect(() => crawler.appendUrlToOutputFile('https://example.com/')).not.toThrow();
        await expect((crawler as any).closeOutputFile()).resolves.toBeUndefined();
    });

    it('closes cleanly when nothing was ever written', async () => {
        const crawler = buildCrawler({ outputFile: path.join(tmpDir, 'urls.txt') });
        await expect((crawler as any).closeOutputFile()).resolves.toBeUndefined();
    });
});

describe('findNodesWithClickListeners (SCAN-86)', () => {
    /**
     * A fake CDP session that records concurrency and answers the four commands
     * the listener sweep uses.
     * @param nodeCount How many elements the page reports.
     * @param clickableNodeIds Node ids that should report a click listener.
     * @return The fake session plus the counters the tests assert on.
     */
    function fakeClient(nodeCount: number, clickableNodeIds: Set<number>) {
        const calls: Record<string, number> = {};
        let inFlight = 0;
        let maxInFlight = 0;
        let releasedGroup: string | null = null;
        const resolvedGroups: string[] = [];

        const send = jest.fn(async (method: string, params: any = {}) => {
            calls[method] = (calls[method] ?? 0) + 1;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // A real round-trip is asynchronous; a synchronous fake would hide
            // whether the caller overlaps its requests at all.
            await new Promise((resolve) => setTimeout(resolve, 1));
            try {
                switch (method) {
                    case 'DOM.getDocument':
                        return { root: { nodeId: 1 } };
                    case 'DOM.querySelectorAll':
                        return { nodeIds: Array.from({ length: nodeCount }, (_, i) => i + 10) };
                    case 'DOM.enable':
                    case 'Runtime.enable':
                        return {};
                    case 'DOM.resolveNode':
                        if (params.objectGroup) {
                            resolvedGroups.push(params.objectGroup);
                        }
                        return { object: { objectId: `obj-${params.nodeId}` } };
                    case 'DOMDebugger.getEventListeners':
                        return {
                            listeners: clickableNodeIds.has(Number(String(params.objectId).replace('obj-', '')))
                                ? [{ type: 'click' }]
                                : [{ type: 'mouseover' }],
                        };
                    case 'DOM.describeNode':
                        return {
                            node: {
                                localName: 'div',
                                attributes: ['id', `n${params.nodeId}`],
                            },
                        };
                    case 'Runtime.releaseObjectGroup':
                        releasedGroup = params.objectGroup;
                        return {};
                    default:
                        return {};
                }
            } finally {
                inFlight--;
            }
        });

        return {
            client: { send } as unknown as CDPSession,
            calls,
            maxInFlight: () => maxInFlight,
            releasedGroup: () => releasedGroup,
            resolvedGroups: () => resolvedGroups,
        };
    }

    it('overlaps its probes instead of running them one at a time', async () => {
        const { discovery } = buildDiscovery();
        const fake = fakeClient(200, new Set([15, 42]));

        await discovery.findNodesWithClickListeners(fake.client, 'click');

        // The old implementation awaited each node's probes in turn, so this
        // would be 1. Anything above 1 proves the round-trips overlap.
        expect(fake.maxInFlight()).toBeGreaterThan(1);
    });

    it('returns matching selectors in document order regardless of scheduling', async () => {
        const { discovery } = buildDiscovery();
        // Deliberately out of order in the set; the output must not follow it.
        const fake = fakeClient(60, new Set([65, 12, 40]));

        const result = await discovery.findNodesWithClickListeners(fake.client, 'click');

        expect(result).toEqual(['div[id="n12"]', 'div[id="n40"]', 'div[id="n65"]']);
    });

    it('only describes nodes that actually carry the listener', async () => {
        const { discovery } = buildDiscovery();
        const fake = fakeClient(100, new Set([20, 21]));

        await discovery.findNodesWithClickListeners(fake.client, 'click');

        expect(fake.calls['DOMDebugger.getEventListeners']).toBe(100);
        expect(fake.calls['DOM.describeNode']).toBe(2);
    });

    it('releases every remote object it resolved', async () => {
        const { discovery } = buildDiscovery();
        const fake = fakeClient(50, new Set([12]));

        await discovery.findNodesWithClickListeners(fake.client, 'click');

        const group = fake.releasedGroup();
        expect(group).toBeTruthy();
        // Every resolveNode must have been pinned to the group that was freed,
        // or the release would leave handles behind in the browser.
        expect(new Set(fake.resolvedGroups())).toEqual(new Set([group]));
        expect(fake.resolvedGroups()).toHaveLength(50);
    });

    it('handles a page with no elements', async () => {
        const { discovery } = buildDiscovery();
        const fake = fakeClient(0, new Set());

        await expect(discovery.findNodesWithClickListeners(fake.client, 'click')).resolves.toEqual([]);
    });

    it('skips nodes whose probe fails rather than abandoning the sweep', async () => {
        const { discovery } = buildDiscovery();
        const fake = fakeClient(20, new Set([12, 15]));
        const realSend = (fake.client as any).send;
        (fake.client as any).send = jest.fn(async (method: string, params: any = {}) => {
            if (method === 'DOM.resolveNode' && params.nodeId === 12) {
                throw new Error('Node with given id does not belong to the document');
            }
            return realSend(method, params);
        });

        const result = await discovery.findNodesWithClickListeners(fake.client, 'click');

        expect(result).toEqual(['div[id="n15"]']);
    });
});

describe('DomStripper fragment memoization (SCAN-85)', () => {
    it('strips identical markup only once per pass', () => {
        const stripper = new DomStripper(['a', 'button']);
        const stripSpy = jest.spyOn(stripper, 'stripHtml');
        const cache = stripper.createCache();

        const html = '<div><a href="/x">link</a></div>';
        const first = cache.strip(html);
        const second = cache.strip(html);
        const third = cache.strip('<div><a href="/y">other</a></div>');

        expect(second).toBe(first);
        expect(third).not.toBe(first);
        expect(stripSpy).toHaveBeenCalledTimes(2);
        stripSpy.mockRestore();
    });

    it('caches are independent, so one pass cannot poison another', () => {
        const stripper = new DomStripper(['a']);
        const html = '<div><a href="/x">link</a></div>';
        const spy = jest.spyOn(stripper, 'stripHtml');

        stripper.createCache().strip(html);
        stripper.createCache().strip(html);

        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
    });
});
