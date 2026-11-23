/**
 * Crawler with browser sessions (SCAN-236): one browser logged in once with a
 * window per worker, session checks, re-login and crash recovery.
 *
 * Runs whole crawls against fake browsers (tests/browser/fakeBrowser.ts). Only
 * what needs a real page is stubbed: action discovery, clicking, page hashing,
 * the in-page check request and the login recording. Sessions, windows, the
 * pause gate, the frontier and the restart routine all run for real.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Browser as PuppeteerBrowser, Page } from 'puppeteer';

import Crawler, { CrawlSession, MAX_RELOGIN_ATTEMPTS } from '../../src/crawler/crawler';
import CrawlAction from '../../src/crawler/crawlAction';
import CrawlState from '../../src/crawler/crawlState';
import { CrawlerConfig } from '../../src/types/crawler';
import { ProbeResult } from '../../src/auth/sessionCheck';
import { FakeBrowser, FakePage, flush } from '../browser/fakeBrowser';

jest.mock('../../src/auth/authenticator', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/auth/directRequest', () => {
    const actual = jest.requireActual('../../src/auth/directRequest');
    return { ...actual, requestDirect: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const authenticate = require('../../src/auth/authenticator').default as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const requestDirect = require('../../src/auth/directRequest').requestDirect as jest.Mock;

const ENTRY = 'https://app.test/';

/**
 * Every temporary directory a test makes, removed after each test. The crawl
 * deletes its own profiles, and tests assert that, but a failing test can stop
 * before the crawl does; nothing a test makes may outlive it.
 */
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}
afterEach(() => {
    logSpy?.mockRestore();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
const ME = 'https://app.test/api/me';
const LOGGED_IN: ProbeResult = { status: 200, contentType: 'application/json', finalUrl: ME, body: '{"id":1,"email":"buyer1@app.test"}' };
const LOGGED_OUT: ProbeResult = { status: 401, contentType: 'application/json', finalUrl: ME, body: '{"error":"unauthorized"}' };

function makeConfig(opts: {
    instances?: number;
    sessionMode?: 'shared' | 'perBrowser';
    recorder?: boolean;
    sessionCheck?: Record<string, unknown>;
    reloginIntervalMs?: number;
    inventoryFile?: string;
} = {}): CrawlerConfig {
    const config = global.testUtils.createValidConfig() as CrawlerConfig;
    config.browser.instances = opts.instances ?? 4;
    if (opts.sessionMode) {
        config.browser.sessionMode = opts.sessionMode;
    }
    config.crawler.entryPoint = ENTRY;
    config.crawler.includeRegexes = ['https://app\\.test(?:/.*|)'];
    config.crawler.maxActionRetries = 1;
    config.crawler.authentication.recorderAuth = { enabled: opts.recorder ?? true, pptrRecording: '{"steps":[]}' };
    if (opts.sessionCheck) {
        config.crawler.authentication.sessionCheck = opts.sessionCheck;
    }
    if (opts.reloginIntervalMs !== undefined) {
        config.crawler.authentication.reloginIntervalMs = opts.reloginIntervalMs;
    }
    if (opts.inventoryFile) {
        config.crawler.inventoryFile = opts.inventoryFile;
    }
    return config;
}

interface Harness {
    crawler: Crawler;
    browsers: FakeBrowser[];
    profiles: string[];
    /** Every action performed, with the page it ran on. */
    performed: Array<{ cssPath: string; page: FakePage }>;
    probe: jest.Mock;
    sessions: () => CrawlSession[];
}

/**
 * Builds a crawler whose entry point has `actions` links, each leading to a
 * page with no further actions.
 * @param onAction - Runs inside each click, before it returns.
 */
function harness(config: CrawlerConfig, actions: number, onAction?: (n: number, page: FakePage, h: Harness) => Promise<void> | void): Harness {
    const crawler = new Crawler(config);
    crawler.browserStartDelays = 0;
    const browsers: FakeBrowser[] = [];
    const profiles: string[] = [];
    crawler.browserLauncher = async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        const profile = tempDir('sasori-tls-test-');
        profiles.push(profile);
        return { browser: browser as unknown as PuppeteerBrowser, userDataDir: profile };
    };

    (crawler as unknown as { discovery: unknown }).discovery = {
        getCrawlActions: jest.fn(async (_page: Page, state: CrawlState) =>
            state.url === ENTRY
                ? Array.from({ length: actions }, (_, i) => new CrawlAction('a', 'click', `#link${i}`, `hash${i}`, state))
                : []),
        getCrawlInputs: jest.fn(async () => []),
    };
    jest.spyOn(crawler, 'maximizeViewport').mockResolvedValue(undefined);
    jest.spyOn(crawler, 'getPageHash').mockImplementation(async (page: Page) => `hash:${page.url()}`);

    const h: Harness = {
        crawler,
        browsers,
        profiles,
        performed: [],
        probe: jest.fn(async () => LOGGED_IN),
        sessions: () => (crawler as unknown as { sessions: CrawlSession[] }).sessions,
    };
    // Copy the headers: the check updates its own object in place.
    jest.spyOn(crawler, 'probeInPage').mockImplementation((page, url, headers) => h.probe(page, url, { ...headers }));

    let n = 0;
    jest.spyOn(crawler, 'performAction').mockImplementation(async (_m, action: CrawlAction, page: Page) => {
        const fake = page as unknown as FakePage;
        const call = ++n;
        await onAction?.(call, fake, h);
        if (fake.closed) {
            throw new Error('Protocol error: Target closed');
        }
        h.performed.push({ cssPath: action.cssPath, page: fake });
        fake.currentUrl = `${ENTRY}${action.cssPath.slice(1)}`;
        return true;
    });
    return h;
}

/** The login recording: the app lands and calls its API, as a real app does. */
function appLogsIn(): void {
    authenticate.mockImplementation(appLogin);
}

async function appLogin(_browser: unknown, page: FakePage): Promise<void> {
    {
        page.currentUrl = `${ENTRY}dashboard`;
        for (const [url, method, type] of [
            [`${ENTRY}assets/app.js`, 'GET', 'script'],
            [`${ENTRY}api/track`, 'POST', 'fetch'],
            [`${ENTRY}api/feed`, 'GET', 'fetch'],
            [ME, 'GET', 'xhr'],
        ] as const) {
            page.emit('response', {
                status: () => 200,
                request: () => ({ url: () => url, method: () => method, resourceType: () => type, headers: () => ({ cookie: 'sid=1' }) }),
            });
        }
    }
}

let logSpy: jest.SpyInstance;
beforeEach(() => {
    jest.clearAllMocks();
    // Asserted on by the tests that check which session check was chosen.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    appLogsIn();
    // Without credentials the API answers 401: it depends on the login.
    requestDirect.mockResolvedValue(LOGGED_OUT);
});

describe('shared mode (the default)', () => {
    it('runs one browser, logs in once, and gives every worker its own window', async () => {
        let control: FakePage | null = null;
        const h = harness(makeConfig({ instances: 4 }), 8, async (_n, _page, hh) => {
            control = hh.sessions()[0]!.controlPage as unknown as FakePage;
            await flush(1); // let the other workers interleave, as real clicks do
        });
        await h.crawler.startCrawling();

        expect(h.browsers).toHaveLength(1);
        expect(authenticate).toHaveBeenCalledTimes(1);
        // No window is kept aside for the checks: the login window is the first
        // worker's, and the other three are new windows.
        expect(h.browsers[0]!.windowsOpened).toBe(3);
        expect(h.performed).toHaveLength(8);
        const workerPages = new Set(h.performed.map((p) => p.page));
        expect(workerPages.size).toBe(4);
        expect(control).not.toBeNull();
        expect(workerPages.has(control!)).toBe(true);
    });

    it('closes the browser once, at the end, and deletes its profile', async () => {
        const h = harness(makeConfig({ instances: 3 }), 6);
        await h.crawler.startCrawling();
        expect(h.browsers[0]!.closeCalls).toBe(1);
        expect(h.profiles.every((p) => !existsSync(p))).toBe(true);
    });

    it('a worker that runs out of work closes only its own window', async () => {
        let browserClosesWhileCrawling = -1;
        const h = harness(makeConfig({ instances: 2 }), 1, (_n, _page, hh) => {
            browserClosesWhileCrawling = hh.browsers[0]!.closeCalls;
        });
        await h.crawler.startCrawling();
        expect(browserClosesWhileCrawling).toBe(0);
        expect(h.browsers[0]!.closeCalls).toBe(1);
    });

    it('chooses a login-dependent fetch/XHR GET as the check, and never the POST or the script', async () => {
        const h = harness(makeConfig({ instances: 1 }), 1);
        await h.crawler.startCrawling();
        const tried = requestDirect.mock.calls.map((c) => c[0]);
        expect(tried[0]).toBe(ME); // the session endpoint is tried first
        expect(tried).not.toContain(`${ENTRY}api/track`);
        expect(tried).not.toContain(`${ENTRY}assets/app.js`);
    });

    it('sends the credential-less request with no cookie', async () => {
        const h = harness(makeConfig({ instances: 1 }), 1);
        await h.crawler.startCrawling();
        for (const [, headers] of requestDirect.mock.calls) {
            expect(headers.cookie).toBeUndefined();
            expect(headers.authorization).toBeUndefined();
        }
    });

    it('skips a public request, and says it found no endpoint, asking for a URL and a pattern', async () => {
        requestDirect.mockResolvedValue(LOGGED_IN);
        const h = harness(makeConfig({ instances: 1 }), 1);
        await h.crawler.startCrawling();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not find a session-check endpoint'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('sessionCheck.loggedInRegex'));
    });

    it('never considers page loads, only API requests (an app with no API calls gets no check)', async () => {
        authenticate.mockImplementation(async (_b: unknown, page: FakePage) => {
            for (const url of [`${ENTRY}loginPoll`, `${ENTRY}dashboard`]) {
                page.emit('response', {
                    status: () => 200,
                    request: () => ({ url: () => url, method: () => 'GET', resourceType: () => 'document', headers: () => ({}) }),
                });
            }
        });
        const h = harness(makeConfig({ instances: 1 }), 1);
        await h.crawler.startCrawling();
        expect(requestDirect).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not find a session-check endpoint'));
    });

    it('uses a body check when only the body changes without the login', async () => {
        // 200 either way; the logged-out body lacks the user's email.
        requestDirect.mockResolvedValue({ ...LOGGED_IN, body: '{"error":"sign in"}' });
        const h = harness(makeConfig({ instances: 1 }), 3, (n, _page, hh) => {
            if (n === 1) {
                hh.probe.mockResolvedValueOnce({ ...LOGGED_IN, body: '{"guest":true}' }); // 200, but no marker
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
            }
        });
        await h.crawler.startCrawling();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('markers: buyer1@app.test'));
        expect(authenticate).toHaveBeenCalledTimes(2); // the markerless 200 was a logout
    });

    it('prefers a status check to a better-ranked body check', async () => {
        // /api/me (ranked first) differs only in body; /api/feed gets a 401.
        requestDirect.mockImplementation(async (url: string) =>
            url === ME ? { ...LOGGED_IN, body: '{"error":"sign in"}' } : LOGGED_OUT);
        const h = harness(makeConfig({ instances: 1 }), 1);
        await h.crawler.startCrawling();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`GET ${ENTRY}api/feed`));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('the status changes without the login'));
    });

    it('a configured URL and pattern: checks the pattern, sends no credential-less request', async () => {
        const h = harness(makeConfig({ instances: 1, sessionCheck: { url: `${ENTRY}whoami`, loggedInRegex: 'buyer1@app\\.test' } }), 3, (n, _page, hh) => {
            if (n === 1) {
                hh.probe.mockResolvedValueOnce({ ...LOGGED_IN, body: 'Please sign in' }); // 200, no match
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
            }
        });
        await h.crawler.startCrawling();
        expect(requestDirect).not.toHaveBeenCalled();
        expect(h.probe).toHaveBeenCalledWith(expect.anything(), `${ENTRY}whoami`, {});
        expect(authenticate).toHaveBeenCalledTimes(2); // the pattern stopped matching: a logout
    });

    it('refuses a pattern that does not match right after login, rather than report a logout every check', async () => {
        const h = harness(makeConfig({ instances: 1, sessionCheck: { url: `${ENTRY}whoami`, loggedInRegex: 'Welcome! \\w+' } }), 1);
        await h.crawler.startCrawling();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('does not match'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('the session is not being checked'));
    });

    it('a configured URL without a pattern is classified like a candidate', async () => {
        const h = harness(makeConfig({ instances: 1, sessionCheck: { url: `${ENTRY}whoami` } }), 1);
        await h.crawler.startCrawling();
        expect(requestDirect).toHaveBeenCalledWith(`${ENTRY}whoami`, expect.anything(), expect.anything());
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('(configured; the status changes without the login)'));
    });

    it('a configured URL that answers the same either way asks for a pattern', async () => {
        requestDirect.mockResolvedValue(LOGGED_IN);
        const h = harness(makeConfig({ instances: 1, sessionCheck: { url: `${ENTRY}whoami` } }), 1);
        await h.crawler.startCrawling();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('answers the same with and without the login'));
    });

    it('warns, suggesting perBrowser, when the login seems to live in sessionStorage', async () => {
        const h = harness(makeConfig({ instances: 2 }), 1);
        const launch = h.crawler.browserLauncher!;
        h.crawler.browserLauncher = async (c) => {
            const launched = await launch(c);
            const control = (launched.browser as unknown as FakeBrowser).openPages[0]!;
            control.evaluate.mockResolvedValue([['accessToken', 'abc']]);
            return launched;
        };
        await h.crawler.startCrawling();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('perBrowser'));
    });

    it('does not warn about sessionStorage with a single worker', async () => {
        const h = harness(makeConfig({ instances: 1 }), 1);
        const launch = h.crawler.browserLauncher!;
        h.crawler.browserLauncher = async (c) => {
            const launched = await launch(c);
            (launched.browser as unknown as FakeBrowser).openPages[0]!.evaluate.mockResolvedValue([['accessToken', 'abc']]);
            return launched;
        };
        await h.crawler.startCrawling();
        expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('sessionStorage'));
    });
});

describe('without recorder auth', () => {
    it('with one instance, crawls in the first window and opens none (unchanged behaviour)', async () => {
        const h = harness(makeConfig({ instances: 1, recorder: false }), 3);
        await h.crawler.startCrawling();
        expect(authenticate).not.toHaveBeenCalled();
        expect(h.browsers[0]!.windowsOpened).toBe(0);
        expect(h.performed).toHaveLength(3);
        expect(h.probe).not.toHaveBeenCalled();
    });

    it('with several, the first window is a worker and the rest are new windows', async () => {
        const h = harness(makeConfig({ instances: 3, recorder: false }), 3);
        await h.crawler.startCrawling();
        expect(h.browsers).toHaveLength(1);
        expect(h.browsers[0]!.windowsOpened).toBe(2);
    });
});

describe('perBrowser mode', () => {
    it('runs one browser and one login per worker, as Sasori did before', async () => {
        const h = harness(makeConfig({ instances: 3, sessionMode: 'perBrowser' }), 6);
        await h.crawler.startCrawling();
        expect(h.browsers).toHaveLength(3);
        expect(authenticate).toHaveBeenCalledTimes(3);
        expect(h.performed).toHaveLength(6);
        expect(h.browsers.every((b) => b.closeCalls === 1)).toBe(true);
        expect(h.profiles.every((p) => !existsSync(p))).toBe(true);
    });

    it('logs in again only in the browser that was logged out, without restarting it', async () => {
        const h = harness(makeConfig({ instances: 2, sessionMode: 'perBrowser' }), 8, async (n, _page, hh) => {
            if (n === 2) {
                hh.probe.mockResolvedValueOnce(LOGGED_OUT);
                void hh.crawler.runSessionCheckRound(hh.sessions()[1]!);
            }
            await flush(1);
        });
        await h.crawler.startCrawling();
        expect(h.browsers).toHaveLength(2); // no restart
        expect(authenticate).toHaveBeenCalledTimes(3); // two at the start, one again
        expect(authenticate.mock.calls[2]![0]).toBe(h.browsers[1]); // in the logged-out browser
        expect(h.performed).toHaveLength(8);
    });
});

describe('session check and re-login', () => {
    it('on a logout: pauses every window, logs in again in one of them, and resumes them all without a restart', async () => {
        let verdict: unknown = null;
        const h = harness(makeConfig({ instances: 2 }), 10, async (n, _page, hh) => {
            if (n === 3) {
                hh.probe.mockResolvedValueOnce(LOGGED_OUT);
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!).then((v) => {
                    verdict = v;
                });
            }
            await flush(1);
        });
        await h.crawler.startCrawling();

        expect(verdict).toBe('loggedOut');
        expect(h.browsers).toHaveLength(1); // the browser was not restarted
        expect(h.browsers[0]!.windowsOpened).toBe(1); // nor any window reopened
        expect(authenticate).toHaveBeenCalledTimes(2);
        // Every action ran exactly once, all in the original windows.
        expect(h.performed.map((p) => p.cssPath).sort()).toEqual(
            Array.from({ length: 10 }, (_, i) => `#link${i}`).sort(),
        );
        expect(h.performed.every((p) => h.browsers[0]!.created.includes(p.page))).toBe(true);
        expect(h.profiles.every((p) => !existsSync(p))).toBe(true);
    });

    it('waits for every running action, and starts none, while it checks and logs in again', async () => {
        const events: string[] = [];
        let busy = 0;
        let releaseSlow: () => void = () => undefined;
        const slow = new Promise<void>((resolve) => {
            releaseSlow = resolve;
        });
        const h = harness(makeConfig({ instances: 2 }), 6, async (n, _page, hh) => {
            busy++;
            if (n === 1) {
                // Worker A starts a long action; the round is requested meanwhile.
                hh.probe.mockImplementationOnce(async () => {
                    events.push(`check (busy workers: ${busy})`);
                    return LOGGED_OUT;
                });
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
                setTimeout(() => {
                    events.push('slow action ends');
                    releaseSlow();
                }, 30);
                await slow;
            } else {
                events.push(`action ${n}`);
            }
            busy--;
        });
        authenticate.mockImplementation(async (b: unknown, page: FakePage) => {
            events.push(`login (busy workers: ${busy})`);
            await appLogin(b, page);
        });
        await h.crawler.startCrawling();
        const check = events.indexOf('check (busy workers: 0)');
        expect(events.indexOf('slow action ends')).toBeGreaterThanOrEqual(0);
        expect(check).toBeGreaterThan(events.indexOf('slow action ends'));
        expect(events[check + 1]).toBe('login (busy workers: 0)');
    });

    it('clears the dead session (cookies and app storage) before logging in again', async () => {
        let cleared: string[] = [];
        const h = harness(makeConfig({ instances: 1 }), 3, (n, _page, hh) => {
            if (n === 1) {
                hh.probe.mockResolvedValueOnce(LOGGED_OUT);
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
            }
        });
        authenticate.mockImplementation(async (b: unknown, page: FakePage) => {
            cleared = page.cdpCalls.map((c) => c.method);
            await appLogin(b, page);
        });
        await h.crawler.startCrawling();
        expect(authenticate).toHaveBeenCalledTimes(2);
        expect(cleared).toContain('Network.clearBrowserCookies');
        expect(cleared).toContain('Storage.clearDataForOrigin');
    });

    it('a passing check changes nothing', async () => {
        const h = harness(makeConfig({ instances: 2 }), 4, async (n, page, hh) => {
            if (n === 1) {
                expect(await hh.crawler.runSessionCheck(hh.sessions()[0]!, page as unknown as Page)).toBe('ok');
            }
        });
        await h.crawler.startCrawling();
        expect(h.browsers).toHaveLength(1);
        expect(authenticate).toHaveBeenCalledTimes(1);
    });

    it('an inconclusive check (server error) does not log in again', async () => {
        let verdict: unknown = null;
        const h = harness(makeConfig({ instances: 1 }), 3, (n, _page, hh) => {
            if (n === 1) {
                hh.probe.mockResolvedValueOnce({ ...LOGGED_IN, status: 503 });
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!).then((v) => {
                    verdict = v;
                });
            }
        });
        await h.crawler.startCrawling();
        expect(verdict).toBe('inconclusive');
        expect(authenticate).toHaveBeenCalledTimes(1);
    });

    it('falls back to restarting the browser when logging in again in place fails', async () => {
        const h = harness(makeConfig({ instances: 1 }), 4, (n, _page, hh) => {
            if (n === 1) {
                authenticate.mockRejectedValueOnce(new Error('login form not found'));
                hh.probe.mockResolvedValueOnce(LOGGED_OUT);
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
            }
        });
        await h.crawler.startCrawling();
        expect(h.browsers).toHaveLength(2); // the restart's fresh browser
        expect(authenticate).toHaveBeenCalledTimes(3); // start, in place (failed), restart
        expect(h.performed).toHaveLength(4);
    });

    it('ends the crawl with an error when logging in fails in place and on three restarts, and still writes the inventory', async () => {
        const inventoryFile = join(tempDir('sasori-inv-'), 'inventory.json');
        const h = harness(makeConfig({ instances: 2, inventoryFile }), 6, (n, _page, hh) => {
            if (n === 2) {
                authenticate.mockRejectedValue(new Error('login form not found'));
                hh.probe.mockResolvedValueOnce(LOGGED_OUT);
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
            }
        });
        await expect(h.crawler.startCrawling()).rejects.toThrow(`Could not log in again after ${MAX_RELOGIN_ATTEMPTS} attempts`);
        expect(authenticate).toHaveBeenCalledTimes(1 + 1 + MAX_RELOGIN_ATTEMPTS);
        expect(existsSync(inventoryFile)).toBe(true);
        expect(JSON.parse(readFileSync(inventoryFile, 'utf8')).states.length).toBeGreaterThan(0);
        expect(h.profiles.every((p) => !existsSync(p))).toBe(true);
        expect(h.crawler.wasStopped()).toBe(false); // a failure, not a stop
    });

    it('counts a login that finds no login-dependent request as a failure', async () => {
        const h = harness(makeConfig({ instances: 1 }), 4, (n, _page, hh) => {
            if (n === 1) {
                // Logging in again "succeeds" but the API stays public: not logged in.
                requestDirect.mockResolvedValue(LOGGED_IN);
                hh.probe.mockResolvedValueOnce(LOGGED_OUT);
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
            }
        });
        await expect(h.crawler.startCrawling()).rejects.toThrow('the login did not work');
    });

    it('does nothing while the browser is restarting', async () => {
        let verdict: unknown = 'not run';
        const h = harness(makeConfig({ instances: 1 }), 2, (n, _page, hh) => {
            if (n === 1) {
                const session = hh.sessions()[0]!;
                void hh.crawler.restartSession(session, 'test');
                void hh.crawler.runSessionCheckRound(session).then((v) => {
                    verdict = v;
                });
            }
        });
        await h.crawler.startCrawling();
        expect(verdict).toBeNull();
    });

    it('runs one round at a time', async () => {
        const verdicts: unknown[] = [];
        const h = harness(makeConfig({ instances: 1 }), 2, (n, _page, hh) => {
            if (n === 1) {
                const session = hh.sessions()[0]!;
                for (let i = 0; i < 3; i++) {
                    void hh.crawler.runSessionCheckRound(session).then((v) => verdicts.push(v));
                }
            }
        });
        await h.crawler.startCrawling();
        expect(verdicts.sort()).toEqual(['ok', null, null].sort());
    });

    it('runs scheduled re-login on its timer, on a fresh browser each time', async () => {
        const h = harness(makeConfig({ instances: 1, reloginIntervalMs: 25 }), 8, async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });
        await h.crawler.startCrawling();
        expect(h.browsers.length).toBeGreaterThanOrEqual(2);
        expect(authenticate).toHaveBeenCalledTimes(h.browsers.length);
        expect(h.performed).toHaveLength(8);
        expect(h.profiles.every((p) => !existsSync(p))).toBe(true);
    });

    it('runs the check on its timer', async () => {
        const h = harness(makeConfig({ instances: 1, sessionCheck: { intervalMs: 20 } }), 6, async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });
        await h.crawler.startCrawling();
        // One probe to choose the check, then the timed ones.
        expect(h.probe.mock.calls.length).toBeGreaterThan(2);
    });

    it('does not check at all with sessionCheck.enabled false', async () => {
        const h = harness(makeConfig({ instances: 2, sessionCheck: { enabled: false } }), 2);
        await h.crawler.startCrawling();
        expect(h.probe).not.toHaveBeenCalled();
        expect(requestDirect).not.toHaveBeenCalled();
        // Unchecked: the control window is the first worker's.
        expect(h.browsers[0]!.windowsOpened).toBe(1);
    });
});

describe('the check borrows a worker window', () => {
    it('opens no window for the checks, with checks on or off', async () => {
        const on = harness(makeConfig({ instances: 3 }), 3);
        await on.crawler.startCrawling();
        const off = harness(makeConfig({ instances: 3, sessionCheck: { enabled: false } }), 3);
        await off.crawler.startCrawling();
        expect(on.browsers[0]!.windowsOpened).toBe(2);
        expect(off.browsers[0]!.windowsOpened).toBe(2);
    });

    it('sends the check from one of the workers\' windows', async () => {
        const workerPages = new Set<FakePage>();
        let checkedFrom: FakePage | null = null;
        const h = harness(makeConfig({ instances: 2 }), 4, (n, page, hh) => {
            workerPages.add(page);
            if (n === 1) {
                hh.probe.mockImplementationOnce(async (p: FakePage) => {
                    checkedFrom = p;
                    return LOGGED_IN;
                });
                void hh.crawler.runSessionCheckRound(hh.sessions()[0]!);
            }
        });
        await h.crawler.startCrawling();
        expect(checkedFrom).not.toBeNull();
        expect(h.browsers[0]!.created).toContain(checkedFrom);
    });

    it('sends the check where it is when the window is already on the app origin', async () => {
        const h = harness(makeConfig({ instances: 1 }), 1, async (_n, page, hh) => {
            page.currentUrl = `${ENTRY}orders/7`;
            page.goto.mockClear();
            await hh.crawler.runSessionCheck(hh.sessions()[0]!, page as unknown as Page);
            expect(page.goto).not.toHaveBeenCalled();
        });
        await h.crawler.startCrawling();
        expect(h.probe).toHaveBeenCalledTimes(2);
    });

    it('first loads the page the app landed on when the window is on another origin', async () => {
        const h = harness(makeConfig({ instances: 1 }), 1, async (_n, page, hh) => {
            page.currentUrl = 'https://cdn.other/asset';
            page.goto.mockClear();
            await hh.crawler.runSessionCheck(hh.sessions()[0]!, page as unknown as Page);
            expect(page.goto).toHaveBeenCalledWith(`${ENTRY}dashboard`, expect.anything());
        });
        await h.crawler.startCrawling();
    });

    it('is inconclusive, not a logout, when the landing page cannot be loaded', async () => {
        let verdict: unknown;
        const h = harness(makeConfig({ instances: 1 }), 1, async (_n, page, hh) => {
            page.currentUrl = 'about:blank';
            page.goto.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'));
            verdict = await hh.crawler.runSessionCheck(hh.sessions()[0]!, page as unknown as Page);
        });
        await h.crawler.startCrawling();
        expect(verdict).toBe('inconclusive');
        expect(h.browsers).toHaveLength(1);
    });
});

describe('browser crash', () => {
    it('restarts the browser and resumes; the interrupted action runs again', async () => {
        const h = harness(makeConfig({ instances: 2 }), 6, (n, _page, hh) => {
            if (n === 2) {
                hh.browsers[0]!.crash();
            }
        });
        await h.crawler.startCrawling();
        expect(h.browsers).toHaveLength(2);
        expect(authenticate).toHaveBeenCalledTimes(2);
        expect(h.performed.map((p) => p.cssPath).sort()).toEqual(
            Array.from({ length: 6 }, (_, i) => `#link${i}`).sort(),
        );
    });

    it('gives a worker whose window the app closed a new window, without restarting the browser', async () => {
        const h = harness(makeConfig({ instances: 2 }), 4, async (n, page) => {
            if (n === 1) {
                await page.close();
            }
        });
        await h.crawler.startCrawling();
        expect(h.browsers).toHaveLength(1);
        expect(h.browsers[0]!.windowsOpened).toBe(2); // the second worker's, then one replacement
        expect(h.performed).toHaveLength(4);
    });
});

describe('scope enforcement per window', () => {
    function interceptedRequest(url: string) {
        return {
            url: () => url,
            method: () => 'GET',
            headers: () => ({}),
            postData: () => undefined,
            resourceType: () => 'document',
            isInterceptResolutionHandled: () => false,
            continue: jest.fn(async () => undefined),
            respond: jest.fn(async () => undefined),
        };
    }

    it('lets the login window leave scope while it logs in, and refuses out-of-scope requests from workers', async () => {
        const sso = interceptedRequest('https://sso.other/authorize');
        const fromWorker = interceptedRequest('https://tracker.other/pixel');
        authenticate.mockImplementation(async (_b: unknown, page: FakePage) => {
            page.emit('request', sso);
        });
        const h = harness(makeConfig({ instances: 2 }), 2, (n, page) => {
            if (n === 1) {
                page.emit('request', fromWorker);
            }
        });
        await h.crawler.startCrawling();
        expect(sso.continue).toHaveBeenCalled();
        expect(sso.respond).not.toHaveBeenCalled();
        expect(fromWorker.respond).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
        expect(fromWorker.continue).not.toHaveBeenCalled();
    });

    it('a login in one browser does not open scope for the other browsers (perBrowser)', async () => {
        const fromOther = interceptedRequest('https://tracker.other/pixel');
        const h = harness(makeConfig({ instances: 2, sessionMode: 'perBrowser' }), 4, async (n, _page, hh) => {
            if (n === 1) {
                // Browser 1 logs in again; browser 0's worker makes an out-of-scope request meanwhile.
                const other = hh.sessions()[0]!.workers[0]!.page as unknown as FakePage;
                authenticate.mockImplementationOnce(async (b: unknown, page: FakePage) => {
                    other.emit('request', fromOther);
                    await appLogin(b, page);
                });
                hh.probe.mockResolvedValueOnce(LOGGED_OUT);
                void hh.crawler.runSessionCheckRound(hh.sessions()[1]!);
            }
        });
        await h.crawler.startCrawling();
        expect(authenticate).toHaveBeenCalledTimes(3);
        expect(fromOther.respond).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    });
});

describe('crash detection', () => {
    it('starts the restart as soon as Chrome disconnects, before any worker trips over it', async () => {
        let restartingAtOnce: boolean | null = null;
        const h = harness(makeConfig({ instances: 2 }), 4, async (n, _page, hh) => {
            if (n === 2) {
                hh.browsers[0]!.crash();
                restartingAtOnce = hh.sessions()[0]!.restarting !== null;
            }
        });
        await h.crawler.startCrawling();
        expect(restartingAtOnce).toBe(true);
    });

    it('a crash while starting up fails the crawl instead of restarting', async () => {
        authenticate.mockImplementation(async (browser: FakeBrowser) => {
            browser.crash();
            throw new Error('Target closed');
        });
        const h = harness(makeConfig({ instances: 2 }), 2);
        await expect(h.crawler.startCrawling()).rejects.toThrow('Authentication failed');
        await flush();
        expect(h.browsers).toHaveLength(1);
    });
});

describe('a token the app refreshes', () => {
    it('is used by the next check, so it is not mistaken for a logout', async () => {
        authenticate.mockImplementation(async (_b: unknown, page: FakePage) => {
            page.emit('response', {
                status: () => 200,
                request: () => ({ url: () => ME, method: () => 'GET', resourceType: () => 'fetch', headers: () => ({ authorization: 'Bearer t1' }) }),
            });
        });
        const h = harness(makeConfig({ instances: 1 }), 2, async (n, page, hh) => {
            if (n === 1) {
                page.emit('request', {
                    url: () => `${ENTRY}api/feed`,
                    method: () => 'GET',
                    headers: () => ({ authorization: 'Bearer t2' }),
                    postData: () => undefined,
                    resourceType: () => 'fetch',
                    isInterceptResolutionHandled: () => false,
                    continue: jest.fn(async () => undefined),
                    respond: jest.fn(async () => undefined),
                });
                await hh.crawler.runSessionCheck(hh.sessions()[0]!, page as unknown as Page);
            }
        });
        await h.crawler.startCrawling();
        const calls = h.probe.mock.calls;
        expect(calls[0]![2]).toEqual({ authorization: 'Bearer t1' }); // choosing the check
        expect(calls[calls.length - 1]![2]).toEqual({ authorization: 'Bearer t2' }); // the check itself
    });
});

describe('start and stop', () => {
    it('fails with the auth error when the first login fails, and closes the browser', async () => {
        authenticate.mockRejectedValue(new Error('bad recording'));
        const h = harness(makeConfig({ instances: 2 }), 2);
        await expect(h.crawler.startCrawling()).rejects.toThrow('Authentication failed: bad recording');
        expect(h.browsers[0]!.closeCalls).toBe(1);
        expect(h.profiles.every((p) => !existsSync(p))).toBe(true);
    });

    it('a stop request ends the crawl without a restart, and closes everything', async () => {
        const h = harness(makeConfig({ instances: 2 }), 6, (n, _page, hh) => {
            if (n === 2) {
                hh.crawler.stopCrawling();
            }
        });
        await h.crawler.startCrawling();
        expect(h.crawler.wasStopped()).toBe(true);
        expect(h.browsers).toHaveLength(1);
        expect(h.profiles.every((p) => !existsSync(p))).toBe(true);
    });
});
