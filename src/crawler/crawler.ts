import { Browser as PuppeteerBrowser, Page } from 'puppeteer';
import { writeFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';

import ActionDiscovery from './actionDiscovery';
import ActionReplay from './actionReplay';
import Browser from '../browser/browser';
import CrawlAction from './crawlAction';
import CrawlInput from './crawlInput';
import CrawlState from './crawlState';
import CrawlStateManager from './crawlStateManager';
import { buildCrawlGraph, crawlGraphToDot, crawlGraphToMermaid, CrawlGraph, PruneReason } from './crawlGraph';

/**
 * Default ceiling on recorded crawl-graph edges.
 *
 * Sized from measurement rather than taste: a ten-minute akasuna crawl records
 * ~3,300 edges and serialises to 1.4 MB, so 200,000 edges is roughly a
 * ten-hour crawl and tens of megabytes — beyond what a browser will render or a
 * reader will read, and the point past which the artifact has stopped earning
 * the memory it costs in a process that serves every scan. Recording is opt-in
 * (`recordCrawlGraph`); this only bounds what saying yes can cost.
 */
const DEFAULT_MAX_CRAWL_GRAPH_EDGES = 200_000;
import { CrawlGraphRecorder } from './crawlGraphRecorder';
import DomStripper from './domStripper';
import EndpointInventory from './endpointInventory';
import ScopeMatcher from './scopeMatcher';
import UrlSink from './urlSink';
import { discoverSeeds, MAX_SEED_BODY_BYTES, normalizeSeedUrl } from './seedDiscovery';
import authenticate from '../auth/authenticator';
import { CrawlerConfig, CrawlerSettings } from '../types/crawler';
import { CrawlInventory } from '../types/inventory';
import { ArrivalType } from '../types/input';

/**
 * Normalises anything thrown into a message string.
 *
 * `catch (e: any)` then `const { message } = e` was the prevailing pattern here,
 * which reads a property off a value that is not necessarily an object — a
 * thrown string or `undefined` produced `undefined` and the comparison against a
 * known Puppeteer message silently took the wrong branch. `unknown` plus this
 * helper makes that impossible without changing what the happy path logs.
 *
 * @param error - The caught value.
 * @return A human-readable message.
 */
function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * The Crawler class is responsible for creating and managing the crawler.
 */
class Crawler {
    /**
     * Static constants for DOM node types
     */
    static readonly TEXT_NODE = 3;
    static readonly COMMENT_NODE = 8;
    static readonly ELEMENT_NODE = 1;

    /**
     * Crawler configuration
     */
    public readonly config: CrawlerConfig;

    /**
     * Crawler-specific settings
     */
    public readonly crawlerConfig: CrawlerSettings;

    /**
     * Authentication in progress flag
     */
    public authInProgress: boolean;

    /**
     * Set of all discovered URLs
     */
    public allUrls: Set<string>;

    /**
     * Endpoint and state inventory for this crawl — what the crawler actually
     * reached, independent of what any scanner made of it.
     */
    public readonly inventory: EndpointInventory;

    /**
     * The most recent crawl's state manager, retained only so the crawl-graph
     * dump (SCAN-197) can serialise the state/action graph in the `finally`
     * block after the crawl loop's local reference has gone out of scope.
     */
    private crawlManager: CrawlStateManager | null = null;

    /**
     * Live crawl-graph recorder, created only when `crawlGraphFile` is set. It is
     * fed at the discovery / dedup / execute / prune hooks so the dumped graph
     * shows every discovered action's fate, which end-of-crawl reconstruction
     * cannot recover after the crawler prunes the frontier (SCAN-197).
     */
    /**
     * Live crawl-graph recorder, or null when neither destination asked for one.
     * Built in the constructor rather than at crawl start so the graph is
     * readable from a crawler that has not started (or was stopped) — the API
     * serves it on demand, not only after a run.
     */
    private graphRecorder: CrawlGraphRecorder | null = null;

    /**
     * Array of all interactable elements
     */
    public allInteractables: string[];

    /**
     * Reduces a DOM to the structure that defines a page's identity.
     */
    private readonly stripper: DomStripper;

    /**
     * Scope decisions for every intercepted request.
     */
    private readonly scope: ScopeMatcher;

    /**
     * Non-blocking writer for the discovered-URL output file.
     */
    private readonly urlSink: UrlSink;

    /**
     * Per-state action and input discovery.
     */
    private readonly discovery: ActionDiscovery;

    /**
     * Replay-to-parent-state and action execution.
     */
    private readonly replay: ActionReplay;

    /**
     * End time for crawling (calculated from maxDuration)
     */
    public endTime: number | null;

    /**
     * Delay between browser starts (in milliseconds)
     */
    public browserStartDelays: number;

    /**
     * Cooperative cancellation for API mode and graceful shutdown.
     */
    private readonly abortController = new AbortController();

    /**
     * Browsers launched while this crawl is active (so {@link stopCrawling} can close them).
     */
    private activeBrowsers: PuppeteerBrowser[] = [];
    private readonly debugPages: WeakSet<Page> = new WeakSet();

    /**
     * Crawler class constructor.
     * @param config - Configuration object containing browser and crawler settings
     */
    constructor(config: CrawlerConfig) {
        this.config = config;
        this.crawlerConfig = config.crawler;
        this.authInProgress = false;
        this.allUrls = new Set<string>();
        this.inventory = new EndpointInventory(this.crawlerConfig.entryPoint);
        this.allInteractables = [...this.crawlerConfig.elements].concat(
            CrawlInput.INPUT_FIELDS.map((element) => element.CSS_PATH)
        );
        this.stripper = new DomStripper(this.allInteractables);
        this.scope = new ScopeMatcher(
            this.crawlerConfig.includeRegexes,
            this.crawlerConfig.excludeRegexes,
        );
        this.urlSink = new UrlSink(this.crawlerConfig.outputFile);
        this.discovery = new ActionDiscovery(
            this.crawlerConfig,
            this.stripper,
            (message: string) => this.debugLog(message),
        );
        this.replay = new ActionReplay(
            this.crawlerConfig,
            (page: Page) => this.getPageHash(page),
            (url: string) => this.recordDiscoveredUrl(url),
            (crawlAction: CrawlAction, reason: PruneReason) => this.graphRecorder?.recordPruned(crawlAction, reason),
        );
        this.graphRecorder = this.recordsCrawlGraph()
            ? new CrawlGraphRecorder(this.crawlerConfig.maxCrawlGraphEdges ?? DEFAULT_MAX_CRAWL_GRAPH_EDGES)
            : null;
        this.endTime = null;
        this.browserStartDelays = 1000; // 1 millisecond(s)
    }

    /**
     * Whether {@link stopCrawling} was called (or the signal was aborted).
     */
    wasStopped(): boolean {
        return this.abortController.signal.aborted;
    }

    private isDebugNetworkEnabled(): boolean {
        if (this.crawlerConfig.debugNetwork === true) {
            return true;
        }
        const env = process.env.SASORI_DEBUG_NETWORK;
        return env === '1' || env === 'true' || env === 'TRUE';
    }

    private debugLog(message: string): void {
        if (!this.isDebugNetworkEnabled()) {
            return;
        }
        console.log(chalk.yellow(`[DEBUG] ${message}`));
    }

    private attachPageDebugListeners(page: Page, pageIdx: number): void {
        if (!this.isDebugNetworkEnabled() || this.debugPages.has(page)) {
            return;
        }
        this.debugPages.add(page);

        page.on('requestfailed', (req) => {
            const failure = req.failure();
            this.debugLog(
                `page=${pageIdx} requestfailed method=${req.method()} url=${req.url()} error=${failure?.errorText ?? 'unknown'}`
            );
        });

        page.on('response', (res) => {
            if (res.status() >= 400) {
                this.debugLog(`page=${pageIdx} response status=${res.status()} url=${res.url()}`);
            }
        });

        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                this.debugLog(`page=${pageIdx} main-frame navigated url=${frame.url()}`);
            }
        });

        page.on('pageerror', (err) => {
            this.debugLog(`page=${pageIdx} pageerror message=${err.message}`);
        });
    }

    /**
     * Checks if the given URL is in context or not.
     *
     * Kept as a method on `Crawler` rather than pushing callers at
     * {@link ScopeMatcher} directly: it is the crawler's public answer to "may I
     * visit this?", and the API server and tests both ask it that way.
     *
     * @param url - URL to check
     * @return boolean indicating if URL is in context
     */
    inContext(url: string): boolean {
        return this.scope.matches(url);
    }

    /**
     * Maximizes viewport according to screensize.
     * @param page - Puppeteer page instance
     */
    async maximizeViewport(page: Page): Promise<void> {
        // Named `viewport`, not `screen`: a local `screen` would shadow the
        // browser global of the same name inside the evaluate callback, which
        // is why this used to be written as `(globalThis as any).screen`.
        const viewport = await page.evaluate(() => {
            return {
                width: screen.availWidth,
                height: screen.availHeight,
            };
        });
        await page.setViewport({ width: viewport.width, height: viewport.height });
    }

    /**
     * Starts authentication on the given browser instance.
     * @param browser - Puppeteer browser instance
     * @param page - Puppeteer page instance
     */
    async startAuthentication(browser: PuppeteerBrowser, page: Page): Promise<void> {
        this.authInProgress = true;
        try {
            const recording = this.crawlerConfig.authentication.recorderAuth.pptrRecording || '';
            // Inline JSON (shipped in the config by the Nara backend) is passed
            // through as-is; a bare filename/path is resolved against this module's
            // directory as before.
            const isInline = recording.trim().startsWith('{') || recording.trim().startsWith('[');
            await authenticate(browser, page, isInline ? recording : path.resolve(__dirname, recording));
        } finally {
            // Reset even on failure, so a crawl that recovers from a bad auth
            // doesn't stay wedged with authInProgress stuck true.
            this.authInProgress = false;
        }
        await this.maximizeViewport(page);
    }

    /**
     * Returns the SHA256 hash of the stripped DOM of the given page.
     * @param page - Puppeteer page instance
     * @return Promise resolving to the page hash string
     */
    async getPageHash(page: Page): Promise<string> {
        try {
            await page.waitForFunction(
                () => document.readyState === 'complete',
                { timeout: this.crawlerConfig.navigationTimeout }
            );
        } catch (error: unknown) {
            this.debugLog(`getPageHash readyState wait timed out url=${page.url()} error=${errorMessage(error)}`);
        }
        let html: string;
        try {
            html = await page.content();
        } catch (error: unknown) {
            const message = errorMessage(error);
            if (message === 'Execution context was destroyed, most likely because of a navigation.') {
                this.debugLog(`getPageHash execution context destroyed, waiting for navigation url=${page.url()}`);
                try {
                    await page.waitForNavigation({
                        waitUntil: ['domcontentloaded'],
                        timeout: this.crawlerConfig.navigationTimeout,
                    });
                } catch (navError: unknown) {
                    this.debugLog(`getPageHash waitForNavigation timeout url=${page.url()} error=${errorMessage(navError)}`);
                }
                html = await page.content();
            } else {
                console.error(chalk.red(`\n[ERROR] ${message}`));
                throw error;
            }
        }

        // The parse-strip-hash half is pure and lives in DomStripper; what stays
        // here is only the choreography of getting readable HTML out of a page
        // that may be navigating underneath us.
        return this.stripper.hashHtml(html);
    }

    /**
     * Creates and returns a new CrawlState using the page and crawl depth passed to it.
     * @param page - Puppeteer page instance
     * @param crawlDepth - Depth of the crawl
     * @param stateHash - Hash of the current state
     * @param crawlManager - Crawl state manager instance
     * @return Promise resolving to a new CrawlState object
     */
    async getNewCrawlState(page: Page, crawlDepth: number, stateHash: string, crawlManager: CrawlStateManager, arrivalType: ArrivalType): Promise<CrawlState> {
        // console.log(`Crawl state creator called for page: ${page.url()}`);
        const crawlState = new CrawlState(page.url(), stateHash, crawlDepth, arrivalType);
        crawlState.crawlActions = await this.discovery.getCrawlActions(
            page,
            crawlState,
            crawlManager,
            this.graphRecorder
                ? (element, cssPath, actionHash): void =>
                    this.graphRecorder?.recordDeduped(crawlState, element, cssPath, actionHash)
                : undefined
        );
        // console.log('Crawl actions found:');
        // console.log(crawlState.crawlActions.map((action) => action.cssPath));
        crawlState.crawlInputs = await this.discovery.getCrawlInputs(page, crawlState);
        // console.log(`Crawl inputs found:`);
        // console.log(crawlState.crawlInputs.map((input) => input.cssPath));
        crawlManager.registerState(crawlState);
        // Every state the crawl reaches is created here, so this is the one hook
        // the inventory needs: it does not have to walk the graph afterwards, and
        // it stays correct while browsers are still adding states concurrently.
        this.inventory.recordState({
            url: crawlState.url,
            stateHash: crawlState.stateHash,
            crawlDepth: crawlState.crawlDepth,
            arrivalType: crawlState.arrivalType,
            actions: crawlState.crawlActions.length,
            inputs: crawlState.crawlInputs.map((input) => input.cssPath),
        });
        // Feed the crawl-graph recorder: the state as a node, and every action
        // that survived dedup as a `discovered` edge (its fate is upgraded later
        // when it executes or is pruned). Deduped actions were already recorded
        // via the onDedup hook above (SCAN-197).
        if (this.graphRecorder) {
            this.graphRecorder.recordState(crawlState);
            for (const action of crawlState.crawlActions) {
                this.graphRecorder.recordDiscovered(action);
            }
        }
        return crawlState;
    }

    /**
     * Fills out all CrawlInputs provided to it in the iterable.
     * @param page - Puppeteer page instance
     * @param crawlInputs - Array of CrawlInput objects to fill
     */
    async fillAllInputs(page: Page, crawlInputs: CrawlInput[]): Promise<void> {
        await this.replay.fillAllInputs(page, crawlInputs);
    }

    /**
     * Performs the given crawlaction on page, replaying to its parent state
     * first if the page is somewhere else.
     * @param crawlManager - Crawl state manager instance
     * @param crawlerAction - The action to perform
     * @param page - Puppeteer page instance
     */
    async performAction(crawlManager: CrawlStateManager, crawlerAction: CrawlAction, page: Page): Promise<boolean> {
        return this.replay.performAction(crawlManager, crawlerAction, page);
    }

    /**
     * Removes the given CrawlAction from the parent CrawlState.
     * @param crawlManager - Crawl state manager instance
     * @param crawlAction - The action to remove
     */
    removeCrawlActionFromState(crawlManager: CrawlStateManager, crawlAction: CrawlAction, reason: PruneReason = 'unresolved'): void {
        // The graph recorder's prune hook lives inside ActionReplay's own
        // removeCrawlActionFromState — every prune, crawler- or replay-initiated,
        // funnels through it — so nothing to record here (SCAN-197). The reason
        // travels with it so the artifact can separate a healthy revisit from a
        // failed resolution (SCAN-198).
        this.replay.removeCrawlActionFromState(crawlManager, crawlAction, reason);
    }

    /**
     * Removes the given CrawlInput from the parent CrawlState.
     * @param crawlInput - The input to remove
     */
    removeCrawlInputFromState(crawlInput: CrawlInput): void {
        this.replay.removeCrawlInputFromState(crawlInput);
    }

    /**
     * Records a URL the crawl reached, logging and persisting it the first time.
     * @param url - URL that was reached.
     */
    private recordDiscoveredUrl(url: string): void {
        if (this.allUrls.has(url)) {
            return;
        }
        console.log(chalk.magenta('[URL] ') + chalk.green(url));
        this.allUrls.add(url);
        this.appendUrlToOutputFile(url);
    }

    /**
     * Append the given URL to the output file.
     * @param url - URL to append
     */
    appendUrlToOutputFile(url: string): void {
        this.urlSink.write(url);
    }

    /**
     * Flushes and closes the output file.
     * @return Promise resolving when the file is closed.
     */
    private async closeOutputFile(): Promise<void> {
        await this.urlSink.close();
    }

    /**
     * This function handles all the asynchronous crawling.
     * @param crawlManager - Crawl state manager instance
     * @param browser - Puppeteer browser instance
     * @param page - Puppeteer page instance
     * @param currentState - Current crawl state
     */
    async handleCrawl(crawlManager: CrawlStateManager, browser: PuppeteerBrowser, page: Page, currentState: CrawlState): Promise<void> {
        let nextCrawlAction: CrawlAction | null;
        try {
            while (
                !this.abortController.signal.aborted &&
                (nextCrawlAction = crawlManager.getNextCrawlAction()) &&
                (this.crawlerConfig.maxDuration === 0 || Date.now() < this.endTime!)
            ) {
                const currentAction = nextCrawlAction;

                // Another copy of this widget was clicked while this one waited on
                // the frontier, so clicking it again would re-walk ground already
                // covered. Skipping here rather than dropping it at discovery is
                // what keeps site chrome to one click per crawl while leaving a
                // page-local form free to be exercised by whichever copy the
                // frontier reaches first (SCAN-198).
                if (crawlManager.hasExecutedActionSignature(currentAction.cssPath, currentAction.actionHash)) {
                    this.removeCrawlActionFromState(crawlManager, currentAction, 'duplicate');
                    continue;
                }

                let clicked = false;
                try {
                    clicked = await this.performAction(crawlManager, currentAction, page);
                } catch (err) {
                    if (this.abortController.signal.aborted) {
                        break;
                    }
                    throw err;
                }
                // Only a dispatched click spends the signature. An action that was
                // pruned before it ran must leave the widget available to its other
                // copies, or the receipt model reintroduces the starvation it was
                // built to remove.
                if (clicked) {
                    crawlManager.markActionSignatureExecuted(currentAction.cssPath, currentAction.actionHash);
                }

                const currentStateHash = await this.getPageHash(page);
                const existingState = crawlManager.getStateByHash(currentStateHash);
                if (existingState) {
                    // The action ran and landed on a state we already hold: it is
                    // explored, not failed. Recording it as a plain prune is what
                    // made a healthy crawl look like an 80% replay failure.
                    currentState = existingState;
                    this.removeCrawlActionFromState(crawlManager, currentAction, 'revisited');
                } else {
                    if (this.inContext(page.url())) {
                        const previousUrl = currentAction.getParentState().url.split('#')[0];
                        const newUrl = page.url().split('#')[0];
                        const arrivalType: ArrivalType = (currentAction.element === CrawlAction.ANCHOR && previousUrl !== newUrl) ? 'link' : 'dom';
                        currentState = await this.getNewCrawlState(page, currentAction.getParentState().crawlDepth + 1, currentStateHash, crawlManager, arrivalType);
                        currentAction.childState = currentState;
                        if (currentState) {
                            currentState.parentAction = currentAction;
                            this.graphRecorder?.recordExecuted(currentAction, currentState);
                        }
                    } else {
                        // Ran, but left the configured scope — a boundary the crawl
                        // declines to cross, not a coverage gap.
                        this.removeCrawlActionFromState(crawlManager, currentAction, 'out-of-scope');
                    }
                }
            }
        } catch (err) {
            if (!this.abortController.signal.aborted) {
                throw err;
            }
        } finally {
            await browser.close().catch(() => undefined);
        }
    }

    /**
     * Starts the crawling process.
     */
    async startCrawling(): Promise<void> {
        try {
            console.log(chalk.greenBright('[INFO] Initializing browser...'));
            const launchResults = await Promise.allSettled(
                Array.from({ length: this.config.browser.instances }).map(
                    () => Browser.getBrowserInstance(this.config.browser),
                ),
            );
            // Publish whatever launched *before* any throw, so the finally closes
            // them. allSettled (not all) means a partial launch failure cannot
            // orphan the browsers that did start.
            this.activeBrowsers = launchResults.flatMap((r) =>
                r.status === 'fulfilled' ? [r.value] : [],
            );
            const launchFailed = launchResults.filter(
                (r): r is PromiseRejectedResult => r.status === 'rejected',
            );
            if (launchFailed.length > 0) {
                const reasons = launchFailed
                    .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
                    .join('; ');
                throw new Error(
                    `Failed to launch ${launchFailed.length}/${launchResults.length} browser(s): ${reasons}`,
                );
            }
            const browsers = this.activeBrowsers;
            console.log(chalk.greenBright('[INFO] Browser(s) initialized successfully!'));
            console.log(chalk.greenBright(`[INFO] Sasori will now start crawling from ${this.crawlerConfig.entryPoint}`));

            for (const browser of browsers) {
                // If a new tab is opened while crawling, close it
                browser.on('targetcreated', async (target) => {
                    const targetBrowser = target.browser();
                    const allTargetBrowserPages = await targetBrowser.pages();
                    const targetPage = await target.page();
                    if (targetPage && target.type() === 'page' && allTargetBrowserPages.length > 1) {
                        await targetPage.close();
                    }
                });
            }

            const startTime = Date.now();
            this.endTime = startTime + this.crawlerConfig.maxDuration;
            if (this.crawlerConfig.maxDuration === 0) {
                console.log(chalk.greenBright('[INFO] Max duration is set to 0, sasori will run indefinitely.'));
            } else {
                console.log(chalk.greenBright(`[INFO] Sasori will stop crawling at ${new Date(this.endTime).toTimeString()}`));
            }

            const allPages: Page[] = [];
            for (const [i, browser] of browsers.entries()) {
                const pages = await browser.pages();
                const page = pages[0];
                if (!page) continue;
                page.setDefaultTimeout(this.crawlerConfig.eventTimeout);
                page.setDefaultNavigationTimeout(this.crawlerConfig.navigationTimeout);
                this.attachPageDebugListeners(page, i);
                await this.maximizeViewport(page);
                allPages.push(page);
            }

            // Authenticate if basic auth is enabled
            if (this.crawlerConfig.authentication.basicAuth && this.crawlerConfig.authentication.basicAuth.enabled) {
                for (const page of allPages) {
                    await page.authenticate({
                        username: this.crawlerConfig.authentication.basicAuth.username!,
                        password: this.crawlerConfig.authentication.basicAuth.password!
                    });
                }
            }

            // Statically respond to out-of-scope requests.
            console.log(chalk.greenBright('[INFO] Setting up scope manager...'));
            for (const page of allPages) {
                await page.setRequestInterception(true);
                page.on('request', async (interceptedRequest) => {
                    if (interceptedRequest.isInterceptResolutionHandled()) return;

                    if (this.inContext(interceptedRequest.url())) {
                        // Recorded per request rather than per unique URL: the
                        // inventory aggregates by endpoint, so it needs to see
                        // every request to count them and to collect parameter
                        // names that only appear on later visits.
                        this.inventory.recordRequest(
                            interceptedRequest.method(),
                            interceptedRequest.url(),
                            {
                                postData: interceptedRequest.postData(),
                                contentType: interceptedRequest.headers()['content-type'],
                                resourceType: interceptedRequest.resourceType(),
                            },
                        );
                        if (!this.allUrls.has(interceptedRequest.url())) {
                            console.log(chalk.magentaBright('[URL] ') + chalk.green(interceptedRequest.url()));
                            this.allUrls.add(interceptedRequest.url());
                            this.appendUrlToOutputFile(interceptedRequest.url());
                        }
                    }

                    if (this.authInProgress) {
                        // A login flow that redirects to an identity provider is
                        // on a host the operator never listed; refusing it would
                        // break the crawl before it started.
                        this.scope.widenToHost(interceptedRequest.url());
                    }

                    if ((this.authInProgress === false && !this.inContext(interceptedRequest.url()))) {
                        interceptedRequest.respond({
                            status: 403,
                            contentType: 'text/plain',
                            body: 'Out of Sasori\'s scope',
                        });
                    } else {
                        interceptedRequest.continue();
                    }
                });
            }

            // Dismiss all alerts/popups
            for (const page of allPages) {
                page.on('dialog', async (dialog) => {
                    await dialog.dismiss();
                });
            }

            console.log(chalk.greenBright('[INFO] Scope manager started successfully!'));

            // Start authentication if enabled.
            const recorderAuth = this.crawlerConfig.authentication.recorderAuth;
            if (recorderAuth && recorderAuth.enabled) {
                const recording = recorderAuth.pptrRecording || '';
                console.log(
                    chalk.greenBright(
                        `[INFO] Recorder auth is ENABLED — running initial authentication across ${browsers.length} browser(s) (recording ${recording.length} bytes).`,
                    ),
                );
                // Authenticate one browser at a time, NOT all at once. Running the
                // login recording on every browser simultaneously is a thundering
                // herd — N concurrent navigations plus N password hashes (targets
                // like Kirimaru use scrypt, deliberately CPU-heavy) plus the
                // capturing proxy all spike together, and at 4 instances that
                // contention pushes the login's navigation past its timeout even
                // though 1–2 browsers are fine. The crawl loop already staggers
                // browser starts for the same reason; auth must not undo that.
                // Sequential also means each failure is caught in turn, so no
                // sibling promise rejects unhandled (which would crash API mode).
                const failedReasons: string[] = [];
                for (let i = 0; i < browsers.length; i++) {
                    const browser = browsers[i];
                    const page = allPages[i];
                    if (!browser || !page) {
                        continue;
                    }
                    try {
                        await this.startAuthentication(browser, page);
                    } catch (err) {
                        failedReasons.push(err instanceof Error ? err.message : String(err));
                    }
                }
                if (failedReasons.length > 0) {
                    const reasons = failedReasons.join('; ');
                    console.error(
                        chalk.redBright(
                            `[ERROR] Initial authentication FAILED on ${failedReasons.length}/${browsers.length} browser(s): ${reasons}`,
                        ),
                    );
                    throw new Error(`Authentication failed: ${reasons}`);
                }
                console.log(chalk.greenBright('[INFO] Initial authentication complete on all browsers.'));
            } else {
                console.log(
                    chalk.yellowBright(
                        `[INFO] Recorder auth is ${recorderAuth ? 'DISABLED' : 'NOT CONFIGURED'} — crawling without a login sequence.`,
                    ),
                );
            }

            console.log(chalk.greenBright('[INFO] Creating crawl state manager...'));
            const crawlManager = new CrawlStateManager();
            // Retain for the crawl-graph dump written in `finally` (SCAN-197).
            this.crawlManager = crawlManager;
            // Record the graph live when a dump is requested, so pruned/deduped
            // action fates survive to the dump.
            // A fresh recorder per run, so a reused crawler does not report a
            // previous crawl's edges.
            this.graphRecorder = this.recordsCrawlGraph()
                ? new CrawlGraphRecorder(this.crawlerConfig.maxCrawlGraphEdges ?? DEFAULT_MAX_CRAWL_GRAPH_EDGES)
                : null;

            if (allPages.length === 0) {
                throw new Error('No pages available for crawling');
            }

            const firstPage = allPages[0];
            if (!firstPage) {
                throw new Error('No pages available for crawling');
            }

            const roots = await this.seedCrawl(firstPage, crawlManager);
            if (this.abortController.signal.aborted) {
                return;
            }
            const rootState = roots[0];
            if (!rootState) {
                throw new Error('Crawler initialization failed: no seed URL could be loaded (exhausted retries navigating to entry point)');
            }

            const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
            const handleCrawls = browsers.map((browser, index) => async () => {
                await delay(index * this.browserStartDelays);
                const page = allPages[index];
                if (browser && page) {
                    return this.handleCrawl(crawlManager, browser, page, rootState);
                }
                return Promise.resolve();
            });
            try {
                await Promise.all(handleCrawls.map((handleCrawl) => handleCrawl()));
            } catch (err) {
                if (!this.abortController.signal.aborted) {
                    throw err;
                }
            }
            if (this.abortController.signal.aborted) {
                console.log(chalk.yellow('[INFO] Crawl stopped by request'));
                return;
            }
            console.log(chalk.greenBright.bold('Scan completed'));
        } finally {
            // Close every browser however the crawl ended — completed, stopped,
            // or thrown. The old code set activeBrowsers = [] *without* closing,
            // which orphaned the Chrome processes on any failure; they then pile
            // up and consume resources, which matters most for the long-lived API
            // service. allSettled + close is idempotent with stopCrawling()'s
            // close (a second close on an already-closed browser just no-ops).
            const launched = this.activeBrowsers;
            this.activeBrowsers = [];
            await Promise.allSettled(launched.map((browser) => browser.close()));
            // Written in `finally` on purpose: a crawl that was stopped or that
            // died part-way still covered something, and that partial inventory
            // is the evidence for what happened before it stopped. Discarding it
            // would make a timeout indistinguishable from a crawl that reached
            // nothing.
            this.writeInventoryFile();
            this.writeCrawlGraphFile();
            await this.closeOutputFile();
        }
    }

    /**
     * Navigates a page to a URL, retrying up to `maxActionRetries` times.
     * @param page - Page to drive.
     * @param url - URL to load.
     * @param label - What the URL is, for the log.
     * @return True once the page has loaded; false when every attempt failed
     * or the crawl was stopped.
     */
    private async navigateWithRetries(page: Page, url: string, label: string): Promise<boolean> {
        const maxRetries = this.crawlerConfig.maxActionRetries ?? 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (this.abortController.signal.aborted) {
                return false;
            }
            try {
                await page.goto(url, { waitUntil: ['domcontentloaded'] });
                await page.waitForFunction(() => document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
                return true;
            } catch (error) {
                console.error(chalk.red(`[ERROR] Failed to navigate to ${label} ${url} (attempt ${attempt}/${maxRetries}): ${errorMessage(error)}`));
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }
        return false;
    }

    /**
     * Builds the crawl forest's roots, one per seed URL (SCAN-229).
     *
     * The entry point is always the first seed. When `sitemap.enabled`, the
     * entry origin's robots.txt and sitemaps are read for more; `extraSeeds`
     * adds the operator's own. Each seed is loaded on `page` in turn and becomes
     * a depth-0 `link` state — its own URL is then a valid replay baseline, which
     * is all the replay planner needs to move a browser between trees.
     *
     * Runs before any browser pops the shared frontier, so none of this races.
     * A seed that fails to load, leaves scope or redirects out of it is skipped;
     * a seed whose DOM matches a state already held merges onto it rather than
     * becoming a second root. The caller decides what zero roots means.
     *
     * @param page - Page to load the seeds on.
     * @param crawlManager - Manager the roots are added to.
     * @return The roots, entry point first when it loaded.
     */
    async seedCrawl(page: Page, crawlManager: CrawlStateManager): Promise<CrawlState[]> {
        const entryPoint = this.crawlerConfig.entryPoint;
        const seeded = new Set<string>();

        await this.addSeedRoot(page, entryPoint, crawlManager, 'entry point');
        seeded.add(normalizeSeedUrl(entryPoint) ?? entryPoint);

        const discovered = this.crawlerConfig.sitemap?.enabled
            ? await this.discoverSitemapSeeds(page)
            : [];

        // Explicit seeds first: the operator asked for them by name, whereas
        // sitemap seeds are capped and fill whatever room is left.
        const candidates: string[] = [];
        for (const raw of [...(this.crawlerConfig.extraSeeds ?? []), ...discovered]) {
            const url = normalizeSeedUrl(raw);
            if (!url || seeded.has(url)) {
                continue;
            }
            seeded.add(url);
            if (!this.inContext(url)) {
                console.log(chalk.yellow(`[INFO] Skipping out-of-scope seed ${url}`));
                continue;
            }
            candidates.push(url);
        }

        for (const url of candidates) {
            if (this.abortController.signal.aborted) {
                break;
            }
            await this.addSeedRoot(page, url, crawlManager, 'seed');
        }

        const roots = crawlManager.getRootStates();
        if (roots.length > 1) {
            console.log(chalk.greenBright(`[INFO] Crawling from ${roots.length} seed states.`));
        }
        return roots;
    }

    /**
     * Loads one seed and adds it as a root, unless it fails, leaves scope, or
     * lands on a DOM state the crawl already holds.
     * @return The new root, or null when nothing was added.
     */
    private async addSeedRoot(
        page: Page,
        url: string,
        crawlManager: CrawlStateManager,
        label: string,
    ): Promise<CrawlState | null> {
        try {
            if (!(await this.navigateWithRetries(page, url, label))) {
                return null;
            }
            // A redirect can carry a seed somewhere the crawl may not go.
            if (!this.inContext(page.url())) {
                console.log(chalk.yellow(`[INFO] Seed ${url} redirected out of scope to ${page.url()}; skipping.`));
                return null;
            }
            const stateHash = await this.getPageHash(page);
            if (crawlManager.getStateByHash(stateHash)) {
                // Two seeds rendering one DOM (both redirecting to a login page,
                // say) are one state; a second root would crawl it twice.
                this.debugLog(`seed ${url} matches a known state; merged`);
                return null;
            }
            const state = await this.getNewCrawlState(page, 0, stateHash, crawlManager, 'link');
            crawlManager.addRootState(state);
            this.graphRecorder?.markRoot(state.stateId);
            return state;
        } catch (error) {
            if (!this.abortController.signal.aborted) {
                console.error(chalk.red(`[ERROR] Could not seed from ${url}: ${errorMessage(error)}`));
            }
            return null;
        }
    }

    /**
     * Reads the entry origin's robots.txt and sitemaps and returns the seed
     * URLs they list. When `respectRobots` (the default) the robots rules are
     * installed into scope for the whole crawl, so a disallowed URL is refused
     * exactly as an excluded one is. Never throws: discovery failing leaves the
     * crawl with the seeds it already has.
     * @param page - Page to fetch with.
     * @return Seed URLs, sorted and capped.
     */
    private async discoverSitemapSeeds(page: Page): Promise<string[]> {
        const settings = this.crawlerConfig.sitemap!;
        const origin = new URL(this.crawlerConfig.entryPoint).origin;
        const respectRobots = settings.respectRobots ?? true;
        try {
            const result = await discoverSeeds(
                (url) => this.fetchSeedResource(page, url),
                origin,
                {
                    maxSeedUrls: settings.maxSeedUrls ?? 100,
                    maxSitemapDepth: settings.maxSitemapDepth ?? 3,
                    maxSitemapUrls: settings.maxSitemapUrls ?? 5000,
                    respectRobots,
                    inScope: (url) => this.inContext(url),
                },
            );
            if (respectRobots && result.robotsRules.length > 0) {
                this.scope.setRobotsRules(origin, result.robotsRules);
                if (!this.inContext(this.crawlerConfig.entryPoint)) {
                    console.warn(chalk.yellow(
                        `[WARN] robots.txt disallows the entry point ${this.crawlerConfig.entryPoint}; ` +
                        'set crawler.sitemap.respectRobots to false to crawl it anyway.',
                    ));
                }
            }
            console.log(chalk.greenBright(
                `[INFO] Sitemap discovery: ${result.seeds.length} seed(s) from ${result.sitemapsRead.length} sitemap(s)` +
                (result.robots ? ', robots.txt read' : ', no robots.txt') +
                (result.truncated ? ' (capped)' : '') + '.',
            ));
            return result.seeds;
        } catch (error) {
            console.error(chalk.red(`[ERROR] Sitemap discovery failed: ${errorMessage(error)}`));
            return [];
        }
    }

    /**
     * Fetches robots.txt or a sitemap by loading it in the crawl's own page, so
     * the request carries the configured proxy, MITM CA trust and session
     * cookies without a second HTTP client. It also passes through request
     * interception like every other request, so an out-of-scope sitemap is
     * refused there too.
     * @param page - Page to load with.
     * @param url - Resource to fetch.
     * @return The body, or null on a non-2xx, a failure, or an oversized body.
     */
    async fetchSeedResource(page: Page, url: string): Promise<string | null> {
        try {
            const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
            if (!response || !response.ok()) {
                return null;
            }
            const body = await response.text();
            if (body.length > MAX_SEED_BODY_BYTES) {
                console.warn(chalk.yellow(`[WARN] Ignoring ${url}: body exceeds ${MAX_SEED_BODY_BYTES} bytes.`));
                return null;
            }
            return body;
        } catch (error) {
            this.debugLog(`fetchSeedResource failed url=${url} error=${errorMessage(error)}`);
            return null;
        }
    }

    /**
     * Returns the crawl inventory — every endpoint and DOM state reached.
     */
    /**
     * The crawl graph as it stands: states, the actions between them, and each
     * action's fate. Prefers the live recording — which is the only source that
     * knows about actions that were deduped or never executed — and falls back
     * to end-of-crawl reconstruction, which can only see the traversed tree.
     * Null when neither is available, which is the honest answer for a scan that
     * failed before a crawl graph existed.
     * @return The graph, or null when there is nothing recorded.
     */
    /**
     * Whether this crawl records a graph. Either destination wants the same
     * recording: a file for a CLI run, memory for an API scan the backend reads
     * back (SCAN-197).
     * @return True when the recorder should run.
     */
    private recordsCrawlGraph(): boolean {
        return Boolean(this.crawlerConfig.crawlGraphFile || this.crawlerConfig.recordCrawlGraph);
    }

    getCrawlGraph(): CrawlGraph | null {
        if (this.graphRecorder) {
            return this.graphRecorder.snapshot(this.crawlerConfig.entryPoint);
        }
        if (this.crawlManager) {
            return buildCrawlGraph(this.crawlManager, this.crawlerConfig.entryPoint);
        }
        return null;
    }

    getInventory(): CrawlInventory {
        return this.inventory.snapshot();
    }

    /**
     * Writes the inventory to `crawler.inventoryFile` when one is configured.
     *
     * Failure to write is reported and swallowed. The inventory is a measurement
     * artifact; letting an unwritable path turn a completed crawl into a failed
     * one would lose the crawl as well as the measurement.
     */
    writeInventoryFile(): void {
        const target = this.crawlerConfig.inventoryFile;
        if (!target) {
            return;
        }
        try {
            const fullPath = path.resolve(target);
            writeFileSync(fullPath, JSON.stringify(this.getInventory(), null, 2) + '\n');
            console.log(chalk.greenBright('[INFO] Crawl inventory written to ') + chalk.green(fullPath));
        } catch (err) {
            console.error(chalk.red('[ERROR] Could not write crawl inventory: ') + String(err));
        }
    }

    /**
     * Writes the crawl graph to `crawler.crawlGraphFile` when one is configured,
     * plus Mermaid (`.mmd`) and Graphviz (`.dot`) siblings for visualisation.
     *
     * Like the inventory, this is a diagnostic artifact: a write failure is
     * reported and swallowed so an unwritable path never turns a completed crawl
     * into a failed one, and it is written in `finally` so a stopped or
     * part-way crawl still records the graph it built (SCAN-197).
     */
    writeCrawlGraphFile(): void {
        const target = this.crawlerConfig.crawlGraphFile;
        if (!target) {
            return;
        }
        try {
            // Prefer the live recording (complete: every action's fate). Fall
            // back to end-of-crawl reconstruction (traversed tree only) if for
            // some reason no recorder ran but the manager is present.
            const graph = this.graphRecorder
                ? this.graphRecorder.snapshot(this.crawlerConfig.entryPoint)
                : this.crawlManager
                    ? buildCrawlGraph(this.crawlManager, this.crawlerConfig.entryPoint)
                    : null;
            if (!graph) {
                return;
            }
            const jsonPath = path.resolve(target);
            const base = jsonPath.replace(/\.json$/i, '');
            writeFileSync(jsonPath, JSON.stringify(graph, null, 2) + '\n');
            writeFileSync(`${base}.mmd`, crawlGraphToMermaid(graph));
            writeFileSync(`${base}.dot`, crawlGraphToDot(graph));
            console.log(
                chalk.greenBright('[INFO] Crawl graph written to ') +
                    chalk.green(`${jsonPath} (+ .mmd, .dot) — ${graph.stateCount} states, ${graph.edgeCount} edges`)
            );
        } catch (err) {
            console.error(chalk.red('[ERROR] Could not write crawl graph: ') + String(err));
        }
    }

    /**
     * Stop the crawling process.
     */
    stopCrawling(): void {
        if (this.abortController.signal.aborted) {
            return;
        }
        this.abortController.abort();
        for (const browser of this.activeBrowsers) {
            void browser.close().catch(() => undefined);
        }
    }
}

export default Crawler;
