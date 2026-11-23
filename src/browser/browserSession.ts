import { Browser as PuppeteerBrowser, Page, Target } from 'puppeteer';

import Browser, { LaunchedBrowser } from './browser';
import { removeUserDataDir } from './tlsProfile';
import { BrowserConfig } from '../types/browser';

export type BrowserLauncher = (config: BrowserConfig) => Promise<LaunchedBrowser>;

/**
 * Puppeteer keeps a target's CDP id on an internal field. Reading it is the
 * only way to match the target `Target.createTarget` made with the one
 * Puppeteer then reports.
 */
function targetIdOf(target: Target): string | undefined {
    return (target as unknown as { _targetId?: string })._targetId;
}

/**
 * One Chrome and the windows Sasori opened in it (SCAN-236).
 *
 * Every window of a browser shares its cookie jar and storage, so a browser
 * logged in once has every window logged in. In `shared` mode the crawl runs
 * one session with one window per worker; in `perBrowser` mode it runs one
 * session per worker, as Sasori did before.
 *
 * The session owns three things the crawler used to get wrong with several
 * workers in one browser:
 *
 * - **Pop-ups.** A page the crawled app opens is closed, but Sasori's own
 *   windows are tracked and never are. The old handler closed any page once the
 *   browser had more than one, which in a shared browser is every worker.
 * - **Closing.** Workers close their own window; only the session closes the
 *   browser, once.
 * - **The profile.** A profile Sasori made is deleted when the browser closes,
 *   however the crawl ended.
 */
export class BrowserSession {
    private browser: PuppeteerBrowser | null = null;
    private userDataDir: string | null = null;
    private readonly ownPages = new Set<Page>();
    private readonly pendingWindows = new Set<Promise<unknown>>();
    private ready: Promise<void> = Promise.resolve();
    private closing = false;
    private generation = 0;

    /**
     * @param config - Browser configuration.
     * @param onUnexpectedDisconnect - Called when the browser goes away without
     *   Sasori closing it: a crash.
     * @param launcher - Launches the browser; injected by tests.
     */
    constructor(
        private readonly config: BrowserConfig,
        private readonly onUnexpectedDisconnect: (session: BrowserSession) => void = () => undefined,
        private readonly launcher: BrowserLauncher = (c) => Browser.launchBrowser(c),
    ) { }

    /**
     * Launches the browser.
     * @return Its first page, the session's control window.
     */
    async launch(): Promise<Page> {
        if (this.browser) {
            throw new Error('Browser session is already running');
        }
        let markReady: () => void = () => undefined;
        this.ready = new Promise<void>((resolve) => {
            markReady = resolve;
        });
        try {
            const launched = await this.launcher(this.config);
            this.browser = launched.browser;
            this.userDataDir = launched.userDataDir;
            this.closing = false;
            const generation = ++this.generation;
            const browser = launched.browser;

            browser.on('disconnected', () => {
                if (!this.closing && generation === this.generation) {
                    this.onUnexpectedDisconnect(this);
                }
            });
            browser.on('targetcreated', (target: Target) => {
                void this.closeForeignPage(target);
            });

            const pages = await browser.pages();
            const control = pages[0] ?? (await browser.newPage());
            this.ownPages.add(control);
            return control;
        } finally {
            markReady();
        }
    }

    /**
     * Opens a new window in this browser. A window, not a tab: a background tab
     * has its timers and rendering throttled, and an earlier attempt to run the
     * workers as tabs failed.
     * @return The window's page.
     */
    async openWindow(): Promise<Page> {
        const browser = this.requireBrowser();
        const opening = (async (): Promise<Page> => {
            const cdp = await browser.target().createCDPSession();
            try {
                const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
                const target = await browser.waitForTarget((t) => targetIdOf(t) === targetId);
                const page = await target.page();
                if (!page) {
                    throw new Error('New browser window has no page');
                }
                this.ownPages.add(page);
                return page;
            } finally {
                await cdp.detach().catch(() => undefined);
            }
        })();
        this.pendingWindows.add(opening);
        try {
            return await opening;
        } finally {
            this.pendingWindows.delete(opening);
        }
    }

    /** Closes one of this session's windows, leaving the browser running. */
    async closeWindow(page: Page): Promise<void> {
        this.ownPages.delete(page);
        await page.close().catch(() => undefined);
    }

    /** Whether the page is one of Sasori's own windows in this browser. */
    isOwnPage(page: Page): boolean {
        return this.ownPages.has(page);
    }

    /** Whether the browser is still there: launched, not closed, not crashed. */
    isConnected(): boolean {
        return this.browser !== null && !this.closing && this.browser.connected;
    }

    isRunning(): boolean {
        return this.browser !== null && !this.closing;
    }

    /** The running browser. Throws when the session is not running. */
    requireBrowser(): PuppeteerBrowser {
        if (!this.browser || this.closing) {
            throw new Error('Browser session is not running');
        }
        return this.browser;
    }

    /**
     * Closes the browser and deletes the profile Sasori made for it. Safe to
     * call more than once, and on a browser that already crashed.
     */
    async close(): Promise<void> {
        const browser = this.browser;
        const userDataDir = this.userDataDir;
        this.closing = true;
        this.browser = null;
        this.userDataDir = null;
        this.ownPages.clear();
        if (browser) {
            await browser.close().catch(() => undefined);
        }
        removeUserDataDir(userDataDir);
    }

    /**
     * Closes a page the crawled app opened. The handler used to close any page
     * once the browser had more than one; with several workers in one browser,
     * that closed the workers.
     */
    private async closeForeignPage(target: Target): Promise<void> {
        if (target.type() !== 'page') {
            return;
        }
        try {
            // A window Sasori is opening shows up here before openWindow has
            // registered it; wait for it, and for the launch, before judging.
            await this.ready;
            await Promise.allSettled([...this.pendingWindows]);
            const page = await target.page();
            if (page && !this.ownPages.has(page) && this.browser && !this.closing) {
                await page.close();
            }
        } catch {
            // The page or the browser went away first; nothing to close.
        }
    }
}

export default BrowserSession;
