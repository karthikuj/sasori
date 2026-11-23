import { Browser as PuppeteerBrowser, HTTPResponse, Page } from 'puppeteer';
import { writeFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';

import ActionDiscovery from './actionDiscovery';
import ActionReplay from './actionReplay';
import BrowserSession, { BrowserLauncher } from '../browser/browserSession';
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
import { requestDirect, toProbeResult } from '../auth/directRequest';
import {
    DEFAULT_SESSION_CHECK_INTERVAL_MS,
    ObservedRequest,
    ProbeResult,
    SessionCheckRequest,
    classifyCandidate,
    pickCheck,
    statusDiffers,
    judgeProbe,
    rankCandidates,
    refreshCheckToken,
    replayableHeaders,
    sessionStorageLoginKeys,
    stripCredentials,
} from '../auth/sessionCheck';
import PauseGate from './pauseGate';
import { SessionMode } from '../types/browser';
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

/** A session check's verdict, or null when no check ran. */
type CheckVerdictOrNone = 'ok' | 'loggedOut' | 'inconclusive' | null;

/**
 * The origin of a URL, or null for one that has none (`about:blank`, an error
 * page) so it never matches.
 */
function originOf(url: string): string | null {
    try {
        const origin = new URL(url).origin;
        return origin === 'null' ? null : origin;
    } catch {
        return null;
    }
}

/** Attempts at logging in again before the crawl gives up (SCAN-236). */
export const MAX_RELOGIN_ATTEMPTS = 3;

/** Longest wait for the app to go quiet after login, while its requests are recorded. */
const POST_LOGIN_IDLE_CAP_MS = 10_000;

/**
 * One crawl worker: a window that takes actions off the shared frontier. Its
 * page is replaced when its browser restarts.
 */
export interface CrawlWorker {
    index: number;
    session: CrawlSession;
    page: Page | null;
    /** The frontier ran dry for this worker; it is not reopened on a restart. */
    done: boolean;
}

/**
 * One browser and the workers in it. `shared` mode has one session with every
 * worker; `perBrowser` mode has one session per worker (SCAN-236).
 */
export interface CrawlSession {
    index: number;
    browser: BrowserSession;
    gate: PauseGate;
    workers: CrawlWorker[];
    /** The window the login recording runs in; afterwards, the first worker's window. */
    controlPage: Page | null;
    check: SessionCheckRequest | null;
    /**
     * The page the app landed on after login, where its own API calls came
     * from. A check is sent from a page on this origin, so the browser treats
     * it exactly as it treats the app's own request (cross-site rules,
     * SameSite cookies).
     */
    checkPageUrl: string | null;
    checkTimer: NodeJS.Timeout | null;
    reloginTimer: NodeJS.Timeout | null;
    checkRunning: boolean;
    restarting: Promise<void> | null;
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
     * Browser sessions of the running crawl, so {@link stopCrawling} can close
     * them (SCAN-236).
     */
    private sessions: CrawlSession[] = [];

    /**
     * Set when the crawl cannot go on, such as a login that failed
     * {@link MAX_RELOGIN_ATTEMPTS} times. Workers stop, and startCrawling throws it.
     */
    private crawlFailure: Error | null = null;

    /** True once the workers are crawling; a crash before that fails the crawl. */
    private crawlLoopStarted = false;

    /**
     * Pages running the login recording. Scope is widened only for these, so a
     * login in one browser does not let every other browser leave scope.
     */
    private readonly authPages: WeakSet<Page> = new WeakSet();

    /** Whether the sessionStorage warning was given, so a restart does not repeat it. */
    private sessionStorageWarned = false;
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
            // Puppeteer 25 types this as unknown: a page can throw anything.
            this.debugLog(`page=${pageIdx} pageerror message=${errorMessage(err)}`);
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
        this.authPages.add(page);
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
            this.authPages.delete(page);
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
     * Whether the crawl should stop: stopped on request, or failed.
     */
    private isFinished(): boolean {
        return this.abortController.signal.aborted || this.crawlFailure !== null;
    }

    /**
     * This function handles all the asynchronous crawling for one worker.
     *
     * The worker passes its session's {@link PauseGate} before every action, so
     * a re-login can stop it between actions and swap its window underneath it
     * (SCAN-236). When it is done it closes its own window, never the browser:
     * other workers may still be crawling in it.
     * @param crawlManager - Crawl state manager instance
     * @param worker - The worker, whose page may change between actions
     * @param currentState - Current crawl state
     */
    async handleCrawl(crawlManager: CrawlStateManager, worker: CrawlWorker, currentState: CrawlState): Promise<void> {
        const gate = worker.session.gate;
        try {
            while (
                !this.isFinished() &&
                (this.crawlerConfig.maxDuration === 0 || Date.now() < this.endTime!)
            ) {
                if (!(await gate.enter())) {
                    break;
                }
                let interrupted = false;
                let exhausted = false;
                let nextCrawlAction: CrawlAction | null = null;
                const page = worker.page;
                try {
                    if (!this.isFinished()) {
                        if (!page) {
                            // Lost its window and has not got a new one yet.
                            interrupted = true;
                        } else {
                            nextCrawlAction = crawlManager.getNextCrawlAction();
                            if (!nextCrawlAction) {
                                exhausted = true;
                            } else {
                                currentState = await this.crawlOneAction(crawlManager, nextCrawlAction, page, currentState);
                            }
                        }
                    }
                } catch (err) {
                    if (!this.isFinished()) {
                        if (page && this.wasInterrupted(worker, page)) {
                            // The browser or the window went away mid-action.
                            // The action did not fail; put it back for whoever
                            // is next.
                            if (nextCrawlAction) {
                                crawlManager.requeueAction(nextCrawlAction);
                            }
                            interrupted = true;
                        } else {
                            throw err;
                        }
                    }
                } finally {
                    gate.leave();
                }
                if (exhausted) {
                    worker.done = true;
                    break;
                }
                if (interrupted) {
                    await this.recoverWorker(worker);
                }
            }
        } catch (err) {
            if (!this.isFinished()) {
                throw err;
            }
        } finally {
            const page = worker.page;
            worker.page = null;
            // Close only this worker's window, and never the browser's last
            // one: Chrome quits when its last window closes, which would look
            // like a crash. The browser closes once, at the end of the crawl.
            const session = worker.session;
            const othersOpen = session.workers.some((w) => w !== worker && w.page !== null) ||
                (session.controlPage !== null && session.controlPage !== page && !session.controlPage.isClosed());
            if (page && othersOpen) {
                await session.browser.closeWindow(page);
            }
        }
    }

    /**
     * Performs one action and records where it led.
     * @return The state the page is in afterwards.
     */
    private async crawlOneAction(
        crawlManager: CrawlStateManager,
        currentAction: CrawlAction,
        page: Page,
        currentState: CrawlState,
    ): Promise<CrawlState> {
        // Another copy of this widget was clicked while this one waited on
        // the frontier, so clicking it again would re-walk ground already
        // covered. Skipping here rather than dropping it at discovery is
        // what keeps site chrome to one click per crawl while leaving a
        // page-local form free to be exercised by whichever copy the
        // frontier reaches first (SCAN-198).
        if (crawlManager.hasExecutedActionSignature(currentAction.cssPath, currentAction.actionHash)) {
            this.removeCrawlActionFromState(crawlManager, currentAction, 'duplicate');
            return currentState;
        }

        let clicked = false;
        try {
            clicked = await this.performAction(crawlManager, currentAction, page);
        } catch (err) {
            if (this.abortController.signal.aborted) {
                return currentState;
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
            this.removeCrawlActionFromState(crawlManager, currentAction, 'revisited');
            return existingState;
        }
        if (this.inContext(page.url())) {
            const previousUrl = currentAction.getParentState().url.split('#')[0];
            const newUrl = page.url().split('#')[0];
            const arrivalType: ArrivalType = (currentAction.element === CrawlAction.ANCHOR && previousUrl !== newUrl) ? 'link' : 'dom';
            const newState = await this.getNewCrawlState(page, currentAction.getParentState().crawlDepth + 1, currentStateHash, crawlManager, arrivalType);
            currentAction.childState = newState;
            if (newState) {
                newState.parentAction = currentAction;
                this.graphRecorder?.recordExecuted(currentAction, newState);
            }
            return newState;
        }
        // Ran, but left the configured scope — a boundary the crawl
        // declines to cross, not a coverage gap.
        this.removeCrawlActionFromState(crawlManager, currentAction, 'out-of-scope');
        return currentState;
    }

    /**
     * Whether a worker's error came from its window or browser going away
     * rather than from the action itself.
     */
    private wasInterrupted(worker: CrawlWorker, page: Page): boolean {
        const session = worker.session;
        return worker.page !== page ||
            page.isClosed() ||
            session.restarting !== null ||
            !session.browser.isConnected();
    }

    /**
     * Gets an interrupted worker going again. When only its window closed (the
     * app called `window.close()`, say), it gets a new window. When the browser
     * went away, the browser restarts.
     */
    private async recoverWorker(worker: CrawlWorker): Promise<void> {
        const session = worker.session;
        if (session.restarting) {
            await session.restarting;
            return;
        }
        if (session.browser.isConnected()) {
            try {
                const page = await session.browser.openWindow();
                await this.setupPage(page, worker.index, session);
                worker.page = page;
                return;
            } catch (err) {
                if (this.isFinished()) {
                    return;
                }
                console.warn(chalk.yellow(`[WARN] Could not reopen window ${worker.index}: ${errorMessage(err)}`));
            }
        }
        await this.restartSession(session, 'browser crashed');
    }

    /** The configured session mode; `shared` unless set. */
    private sessionMode(): SessionMode {
        return this.config.browser.sessionMode ?? 'shared';
    }

    /** Whether the crawl checks it is still logged in (SCAN-236). */
    private checksSession(): boolean {
        const auth = this.crawlerConfig.authentication;
        return Boolean(auth.recorderAuth?.enabled) && auth.sessionCheck?.enabled !== false;
    }

    /**
     * Applies the per-window setup: timeouts, viewport, debug listeners, Basic
     * auth, scope enforcement and dialog dismissal. Every window gets it, the
     * ones opened after a restart included.
     * @param page - The window's page.
     * @param pageIdx - Index for the debug log.
     * @param session - The session the window belongs to.
     */
    private async setupPage(page: Page, pageIdx: number, session: CrawlSession): Promise<void> {
        page.setDefaultTimeout(this.crawlerConfig.eventTimeout);
        page.setDefaultNavigationTimeout(this.crawlerConfig.navigationTimeout);
        this.attachPageDebugListeners(page, pageIdx);
        await this.maximizeViewport(page);

        const basicAuth = this.crawlerConfig.authentication.basicAuth;
        if (basicAuth && basicAuth.enabled) {
            await page.authenticate({
                username: basicAuth.username!,
                password: basicAuth.password!,
            });
        }

        // Statically respond to out-of-scope requests.
        await page.setRequestInterception(true);
        page.on('request', (interceptedRequest) => {
            if (interceptedRequest.isInterceptResolutionHandled()) return;

            const url = interceptedRequest.url();
            const inScope = this.inContext(url);
            if (inScope) {
                // Recorded per request rather than per unique URL: the
                // inventory aggregates by endpoint, so it needs to see
                // every request to count them and to collect parameter
                // names that only appear on later visits.
                this.inventory.recordRequest(
                    interceptedRequest.method(),
                    url,
                    {
                        postData: interceptedRequest.postData(),
                        contentType: interceptedRequest.headers()['content-type'],
                        resourceType: interceptedRequest.resourceType(),
                    },
                );
                if (!this.allUrls.has(url)) {
                    console.log(chalk.magentaBright('[URL] ') + chalk.green(url));
                    this.allUrls.add(url);
                    this.appendUrlToOutputFile(url);
                }
                // Follow the app's own token, so a token it refreshed is not
                // mistaken for a logout by the next check.
                if (session.check) {
                    refreshCheckToken(session.check, url, interceptedRequest.headers());
                }
            }

            const authenticating = this.authPages.has(page);
            if (authenticating) {
                // A login flow that redirects to an identity provider is
                // on a host the operator never listed; refusing it would
                // break the crawl before it started.
                this.scope.widenToHost(url);
            }

            if (!authenticating && !inScope) {
                void interceptedRequest.respond({
                    status: 403,
                    contentType: 'text/plain',
                    body: 'Out of Sasori\'s scope',
                });
            } else {
                void interceptedRequest.continue();
            }
        });

        // Dismiss all alerts/popups
        page.on('dialog', async (dialog) => {
            await dialog.dismiss().catch(() => undefined);
        });
    }

    /**
     * Launches a session's browser, logs in once, and opens its workers'
     * windows. Used both at the start of the crawl and by every restart.
     * @param session - The session to start.
     */
    private async startSession(session: CrawlSession): Promise<void> {
        const control = await session.browser.launch();
        session.controlPage = control;
        session.check = null;
        const firstWorker = session.workers[0];
        await this.setupPage(control, firstWorker ? firstWorker.index : session.index, session);

        const recorderAuth = this.crawlerConfig.authentication.recorderAuth;
        let observed: ObservedRequest[] = [];
        if (recorderAuth && recorderAuth.enabled) {
            observed = await this.logInAndObserve(session, control);
        }

        // The check is chosen now, while the control window is still on the
        // page the app landed on and nothing is crawling yet.
        session.checkPageUrl = this.inContext(control.url()) ? control.url() : this.crawlerConfig.entryPoint;
        if (this.checksSession()) {
            session.check = await this.chooseSessionCheck(observed, control);
        }

        // The control window is the first worker's; the rest get new windows.
        // No window is kept aside for the checks: each check pauses every
        // worker and borrows one of their windows.
        const pending = session.workers.filter((w) => !w.done);
        let reuseControl = true;
        for (const worker of pending) {
            if (reuseControl) {
                worker.page = control;
                reuseControl = false;
                continue;
            }
            const page = await session.browser.openWindow();
            await this.setupPage(page, worker.index, session);
            worker.page = page;
        }
    }

    /**
     * Runs the login recording in the control window, recording the requests
     * the app makes while logging in and landing on its first page.
     * @return The app's requests, in the order it made them.
     */
    private async logInAndObserve(session: CrawlSession, control: Page): Promise<ObservedRequest[]> {
        const observed: ObservedRequest[] = [];
        const onResponse = (response: HTTPResponse): void => {
            const request = response.request();
            observed.push({
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                status: response.status(),
                headers: request.headers(),
            });
        };
        control.on('response', onResponse);
        try {
            await this.startAuthentication(session.browser.requireBrowser(), control);
            // The app makes its first API calls after landing; wait for it to go
            // quiet so they are recorded. Capped, for apps that poll forever.
            await control.waitForNetworkIdle({
                idleTime: 500,
                timeout: Math.min(this.crawlerConfig.navigationTimeout, POST_LOGIN_IDLE_CAP_MS),
            }).catch(() => undefined);
        } finally {
            control.off('response', onResponse);
        }
        await this.warnIfLoginInSessionStorage(control, session);
        return observed;
    }

    /**
     * In `shared` mode, warns when the login seems to live in `sessionStorage`,
     * which is per window: the other windows would then not be logged in.
     */
    private async warnIfLoginInSessionStorage(control: Page, session: CrawlSession): Promise<void> {
        if (this.sessionStorageWarned || this.sessionMode() !== 'shared' || session.workers.length < 2) {
            return;
        }
        try {
            const entries = await control.evaluate(() => {
                const out: Array<[string, string]> = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    if (key !== null) {
                        out.push([key, sessionStorage.getItem(key) ?? '']);
                    }
                }
                return out;
            });
            const keys = sessionStorageLoginKeys(entries);
            if (keys.length > 0) {
                this.sessionStorageWarned = true;
                console.warn(chalk.yellowBright(
                    `[WARN] The login seems to be kept in sessionStorage (${keys.join(', ')}). sessionStorage is per window, ` +
                    'so the other crawl windows may not be logged in. If the crawl reaches only logged-out pages, ' +
                    'set browser.sessionMode to "perBrowser".',
                ));
            }
        } catch (err) {
            this.debugLog(`sessionStorage check failed: ${errorMessage(err)}`);
        }
    }

    /**
     * Picks the session check (SCAN-236).
     *
     * **Configured** (`sessionCheck.url`): that URL is the check. With
     * `sessionCheck.loggedInRegex` the pattern decides, and it must match the
     * answer right after login, or the check is refused: a pattern that does
     * not match while logged in would report a logout on every check. Without
     * a pattern, the URL is classified like a candidate below.
     *
     * **Automatic**: only the app's own API requests are tried — a fetch/XHR
     * `GET` in scope, 2xx in the browser — best-ranked first. Each is sent
     * twice from the logged-in window and once without credentials, straight
     * to the target from Node (never through the browser or the proxy, so no
     * unauthenticated copy reaches the inventory). One whose status changes
     * without the login is preferred; one whose body changes is taken
     * otherwise. When none does — an app that makes no API calls after login,
     * like a server-rendered one — Sasori says so and asks for a configured URL
     * and pattern rather than guess.
     * @return The check, or null when none qualifies.
     */
    private async chooseSessionCheck(observed: ObservedRequest[], control: Page): Promise<SessionCheckRequest | null> {
        const settings = this.crawlerConfig.authentication.sessionCheck;
        const configured = settings?.url;
        if (configured) {
            return this.configuredSessionCheck(configured, settings?.loggedInRegex, control);
        }

        const checks: Array<SessionCheckRequest | null> = [];
        for (const candidate of rankCandidates(observed, (url) => this.inContext(url))) {
            const check = await this.classifyRequest(candidate.url, candidate.headers, control);
            checks.push(check);
            if (check?.kind === 'status') {
                break; // the best kind; the rest cannot beat it
            }
        }
        const check = pickCheck(checks);
        if (check) {
            console.log(chalk.greenBright(
                `[INFO] Session check: GET ${check.url}, every ${this.sessionCheckIntervalMs() / 1000}s ` +
                `(${check.kind === 'status' ? 'the status changes without the login' : `the body changes without the login; markers: ${check.markers!.join(', ')}`}).`,
            ));
            return check;
        }
        console.warn(chalk.yellowBright(
            '[WARN] Could not find a session-check endpoint: no API request the app made after login answers with a ' +
            'different status or body without the login. The session is not being checked. Set ' +
            'crawler.authentication.sessionCheck.url to a GET URL that only works while logged in, and ' +
            'sessionCheck.loggedInRegex to a pattern its response matches only while logged in.',
        ));
        return null;
    }

    /** The check for an operator-configured URL, with or without a pattern. */
    private async configuredSessionCheck(url: string, loggedInRegex: string | undefined, control: Page): Promise<SessionCheckRequest | null> {
        if (loggedInRegex) {
            const baseline = await this.probeInPage(control, url, {});
            if (baseline.status >= 200 && baseline.status < 300 && new RegExp(loggedInRegex).test(baseline.body)) {
                console.log(chalk.greenBright(`[INFO] Session check: ${url} must match /${loggedInRegex}/ (configured).`));
                return { url, headers: {}, baseline, kind: 'regex', loggedInRegex };
            }
            console.warn(chalk.yellowBright(
                `[WARN] Session check URL ${url} answered ${baseline.status} right after login, and its response ` +
                `${new RegExp(loggedInRegex).test(baseline.body) ? 'matches' : 'does not match'} /${loggedInRegex}/. ` +
                'The pattern must match the response while logged in; the session is not being checked.',
            ));
            return null;
        }
        const check = await this.classifyRequest(url, {}, control);
        if (check) {
            console.log(chalk.greenBright(
                `[INFO] Session check: ${url} (configured; ${check.kind === 'status' ? 'the status changes without the login' : `markers: ${check.markers!.join(', ')}`}).`,
            ));
            return check;
        }
        console.warn(chalk.yellowBright(
            `[WARN] Session check URL ${url} answers the same with and without the login. Set ` +
            'crawler.authentication.sessionCheck.loggedInRegex to a pattern its response matches only while logged in; ' +
            'the session is not being checked.',
        ));
        return null;
    }

    /**
     * Sends a request twice from the logged-in window and once without
     * credentials, and classifies what tells a logout apart.
     * @return The check, or null when the request does not depend on the login.
     */
    private async classifyRequest(url: string, sentHeaders: Record<string, string>, control: Page): Promise<SessionCheckRequest | null> {
        const headers = replayableHeaders(sentHeaders);
        const loggedIn = await this.probeInPage(control, url, headers);
        if (loggedIn.status < 200 || loggedIn.status >= 300) {
            return null;
        }
        const tls = this.config.browser.tls;
        const loggedOut = await requestDirect(url, stripCredentials(sentHeaders), {
            timeoutMs: this.crawlerConfig.navigationTimeout,
            ...(tls?.extraCaCerts ? { caPaths: tls.extraCaCerts } : {}),
            allowInsecure: tls?.allowInsecureFallback === true,
        });
        if (loggedOut.status === 0) {
            this.debugLog(`session check candidate ${url} unreachable without the browser`);
            return null;
        }
        // A second logged-in answer only matters when the status alone does
        // not tell them apart; skip the request otherwise.
        const loggedInAgain = statusDiffers(loggedIn, loggedOut) ? loggedIn : await this.probeInPage(control, url, headers);
        return classifyCandidate({ url, headers, loggedIn, loggedInAgain, loggedOut });
    }

    private sessionCheckIntervalMs(): number {
        return this.crawlerConfig.authentication.sessionCheck?.intervalMs ?? DEFAULT_SESSION_CHECK_INTERVAL_MS;
    }

    /**
     * Sends the check from inside a window, so it carries the session's cookies
     * exactly as the app's own request does.
     * @return The answer, with status 0 when the request failed.
     */
    async probeInPage(page: Page, url: string, headers: Record<string, string>): Promise<ProbeResult> {
        try {
            const raw = await page.evaluate(async (target: string, sent: Record<string, string>) => {
                const response = await fetch(target, {
                    method: 'GET',
                    headers: sent,
                    credentials: 'include',
                    cache: 'no-store',
                    redirect: 'follow',
                });
                return {
                    status: response.status,
                    contentType: response.headers.get('content-type') ?? '',
                    finalUrl: response.url || target,
                    body: (await response.text()).slice(0, 256 * 1024),
                };
            }, url, headers);
            return toProbeResult(raw.status, raw.contentType, raw.finalUrl, raw.body);
        } catch (err) {
            this.debugLog(`session check request failed url=${url} error=${errorMessage(err)}`);
            return { status: 0, contentType: '', finalUrl: url, body: '' };
        }
    }

    /** Starts the session check and scheduled re-login timers. */
    private startSessionTimers(session: CrawlSession): void {
        this.stopSessionTimers(session);
        if (this.isFinished()) {
            return;
        }
        if (session.check) {
            session.checkTimer = setInterval(() => {
                void this.runSessionCheckRound(session);
            }, this.sessionCheckIntervalMs());
            session.checkTimer.unref?.();
        }
        const reloginMs = this.crawlerConfig.authentication.reloginIntervalMs ?? 0;
        if (reloginMs > 0 && this.crawlerConfig.authentication.recorderAuth?.enabled) {
            session.reloginTimer = setInterval(() => {
                void this.restartSession(session, 'scheduled re-login');
            }, reloginMs);
            session.reloginTimer.unref?.();
        }
    }

    private stopSessionTimers(session: CrawlSession): void {
        if (session.checkTimer) {
            clearInterval(session.checkTimer);
            session.checkTimer = null;
        }
        if (session.reloginTimer) {
            clearInterval(session.reloginTimer);
            session.reloginTimer = null;
        }
    }

    /**
     * One round of the session check (SCAN-236), run on every timer tick.
     *
     * 1. Pause every worker of the session. Each finishes the action it is
     *    performing first; no action is cut short.
     * 2. Borrow one worker's window and send the check from it.
     * 3. If the session is logged out, log in again in that same window
     *    ({@link logInAgainInPlace}). Every window shares the browser's cookie
     *    jar and storage, so the other windows are logged in too and need no
     *    restart: each one's next action reloads from a real URL, which
     *    carries the new session.
     * 4. Resume every worker.
     *
     * If logging in again in place fails, the round falls back to a full
     * restart of the browser ({@link restartSession}), which retries and ends
     * the crawl after {@link MAX_RELOGIN_ATTEMPTS} failures.
     * @param session - The session to check.
     * @return The check's verdict, or null when no round ran.
     */
    async runSessionCheckRound(session: CrawlSession): Promise<CheckVerdictOrNone> {
        if (!session.check || session.restarting || session.checkRunning || this.isFinished()) {
            return null;
        }
        session.checkRunning = true;
        let restartReason: string | null = null;
        let verdict: CheckVerdictOrNone = null;
        try {
            await session.gate.pause();
            const page = this.borrowWindow(session);
            if (!page || this.isFinished() || session.restarting) {
                return null;
            }
            verdict = await this.runSessionCheck(session, page);
            if (verdict === 'loggedOut') {
                console.warn(chalk.yellowBright(
                    `[WARN] Logged out; every window of browser ${session.index} is paused. Logging in again in one window.`,
                ));
                try {
                    await this.logInAgainInPlace(session, page);
                    console.log(chalk.greenBright(`[INFO] Logged in again in browser ${session.index}; resuming every window.`));
                } catch (err) {
                    if (!this.isFinished()) {
                        console.error(chalk.red(`[ERROR] Logging in again in place failed: ${errorMessage(err)}. Restarting the browser.`));
                        restartReason = 'logged out; logging in again in place failed';
                    }
                }
            }
            return verdict;
        } finally {
            session.checkRunning = false;
            if (restartReason) {
                // The restart pauses the gate itself; start it before resuming
                // so no worker slips an action in between.
                void this.restartSession(session, restartReason);
            }
            session.gate.resume();
        }
    }

    /** A worker window of the session to send the check from, or null if none is open. */
    private borrowWindow(session: CrawlSession): Page | null {
        for (const worker of session.workers) {
            if (worker.page && !worker.page.isClosed()) {
                return worker.page;
            }
        }
        return null;
    }

    /**
     * Sends the session check from the given window and judges the answer.
     *
     * The check must be sent from a page on the app's own origin: from
     * anywhere else the browser may block it as cross-site or leave out
     * SameSite cookies, and a check failing for that reason would look like a
     * logout. So a window on another origin first loads the page the app
     * landed on after login; a window already on that origin sends it as it
     * is. The worker's next action replays back to its own state, as after any
     * navigation.
     * @param session - The session to check.
     * @param page - The window to send the check from. Its worker must be paused.
     * @return The verdict, or null when there is nothing to check.
     */
    async runSessionCheck(session: CrawlSession, page: Page): Promise<CheckVerdictOrNone> {
        const check = session.check;
        if (!check || this.isFinished()) {
            return null;
        }
        if (!(await this.putOnCheckOrigin(session, page))) {
            this.debugLog(`session check skipped: could not load ${session.checkPageUrl}`);
            return 'inconclusive';
        }
        const observed = await this.probeInPage(page, check.url, check.headers);
        const verdict = judgeProbe(check, observed);
        if (verdict === 'loggedOut') {
            console.warn(chalk.yellowBright(
                `[WARN] Session check ${check.url} answered ${observed.status} (${observed.finalUrl}): logged out.`,
            ));
        } else if (verdict === 'inconclusive') {
            this.debugLog(`session check inconclusive status=${observed.status} url=${check.url}`);
        }
        return verdict;
    }

    /**
     * Logs in again in one window while every other window waits (SCAN-236).
     *
     * The dead session's cookies are cleared first, browser-wide, along with
     * the app's own storage. That puts the login page in the state a fresh
     * profile would show it, so a leftover "remember me" cookie or stale token
     * cannot change how it behaves under the recording. Then the recording
     * runs, the check is found again (a new session may use different
     * requests), and the new session is verified.
     * @param session - The session to log in again.
     * @param page - The window to log in in. Every worker must be paused.
     * @throws When the login or the verification fails.
     */
    private async logInAgainInPlace(session: CrawlSession, page: Page): Promise<void> {
        await this.clearSessionData(page, session);
        const observed = await this.logInAndObserve(session, page);
        session.checkPageUrl = this.inContext(page.url()) ? page.url() : this.crawlerConfig.entryPoint;
        const check = await this.chooseSessionCheck(observed, page);
        if (!check) {
            throw new Error('no request depends on the login after logging in again; the login did not work');
        }
        session.check = check;
    }

    /**
     * Clears every cookie in the browser, and `localStorage`, IndexedDB and
     * the cache storage of the app's origins. Run only while every worker is
     * paused.
     */
    private async clearSessionData(page: Page, session: CrawlSession): Promise<void> {
        const cdp = await page.createCDPSession();
        try {
            await cdp.send('Network.clearBrowserCookies');
            const origins = new Set<string>();
            for (const url of [session.checkPageUrl, this.crawlerConfig.entryPoint, page.url()]) {
                const origin = url ? originOf(url) : null;
                if (origin) {
                    origins.add(origin);
                }
            }
            for (const origin of origins) {
                await cdp.send('Storage.clearDataForOrigin', {
                    origin,
                    storageTypes: 'local_storage,indexeddb,cache_storage,service_workers,websql',
                }).catch(() => undefined);
            }
        } finally {
            await cdp.detach().catch(() => undefined);
        }
    }

    /**
     * Makes sure the window is on the origin of the page the app landed on
     * after login, loading that page when it is not.
     * @return False when the page could not be loaded.
     */
    private async putOnCheckOrigin(session: CrawlSession, page: Page): Promise<boolean> {
        const target = session.checkPageUrl ?? this.crawlerConfig.entryPoint;
        if (originOf(page.url()) === originOf(target)) {
            return true;
        }
        try {
            await page.goto(target, { waitUntil: 'domcontentloaded' });
            return true;
        } catch (err) {
            this.debugLog(`session check page load failed url=${target} error=${errorMessage(err)}`);
            return false;
        }
    }

    /**
     * Restarts a session's browser and logs in again (SCAN-236).
     *
     * Every worker of the session is paused first, and the restart waits for
     * the actions already running to finish. Then the browser is closed, its
     * profile deleted, and a fresh browser is launched on a new profile, logged
     * in once and given its workers' windows. A fresh profile even after a
     * detected logout means one code path, and nothing left from the dead
     * session can change how the login page behaves. A recording replayed in a
     * window that is already logged in can break, which is why a scheduled
     * re-login does the same.
     *
     * After {@link MAX_RELOGIN_ATTEMPTS} failures in a row the crawl ends with
     * an error rather than carry on logged out. Concurrent calls share one
     * restart.
     * @param session - The session to restart.
     * @param reason - Why, for the log.
     */
    restartSession(session: CrawlSession, reason: string): Promise<void> {
        if (session.restarting) {
            return session.restarting;
        }
        if (this.isFinished()) {
            return Promise.resolve();
        }
        const hadCheck = session.check !== null;
        session.restarting = (async (): Promise<void> => {
            this.stopSessionTimers(session);
            console.warn(chalk.yellowBright(`[WARN] Restarting browser ${session.index} (${reason}); pausing its workers.`));
            await session.gate.pause();
            let lastError = '';
            for (let attempt = 1; attempt <= MAX_RELOGIN_ATTEMPTS; attempt++) {
                if (this.isFinished()) {
                    return;
                }
                try {
                    await session.browser.close();
                    for (const worker of session.workers) {
                        worker.page = null;
                    }
                    await this.startSession(session);
                    if (hadCheck && this.checksSession() && !session.check) {
                        throw new Error('no request depends on the login after logging in again; the login did not work');
                    }
                    console.log(chalk.greenBright(`[INFO] Browser ${session.index} restarted (${reason}); resuming.`));
                    this.startSessionTimers(session);
                    return;
                } catch (err) {
                    if (this.isFinished()) {
                        return;
                    }
                    lastError = errorMessage(err);
                    console.error(chalk.red(
                        `[ERROR] Restarting browser ${session.index} failed (attempt ${attempt}/${MAX_RELOGIN_ATTEMPTS}): ${lastError}`,
                    ));
                }
            }
            this.failCrawl(new Error(
                `Could not log in again after ${MAX_RELOGIN_ATTEMPTS} attempts (${reason}): ${lastError}`,
            ));
        })().finally(() => {
            session.restarting = null;
            session.gate.resume();
        });
        return session.restarting;
    }

    /**
     * Ends the crawl with an error: every worker stops, and startCrawling throws
     * it once they have. Inventory and crawl graph are still written.
     */
    private failCrawl(error: Error): void {
        if (this.crawlFailure) {
            return;
        }
        console.error(chalk.redBright(`[ERROR] ${error.message}`));
        this.crawlFailure = error;
        for (const session of this.sessions) {
            this.stopSessionTimers(session);
            session.gate.cancel();
            void session.browser.close();
        }
    }

    /** Called when a browser goes away without Sasori closing it. */
    private onBrowserDisconnected(session: CrawlSession): void {
        if (this.isFinished() || !this.crawlLoopStarted) {
            return;
        }
        console.error(chalk.red(`[ERROR] Browser ${session.index} disconnected unexpectedly.`));
        void this.restartSession(session, 'browser crashed');
    }

    /**
     * Builds the crawl's sessions: one with every worker in `shared` mode, one
     * per worker in `perBrowser` mode.
     */
    private buildSessions(): CrawlSession[] {
        const instances = this.config.browser.instances;
        const shared = this.sessionMode() === 'shared';
        const sessionCount = shared ? 1 : instances;
        const sessions: CrawlSession[] = [];
        let workerIndex = 0;
        for (let i = 0; i < sessionCount; i++) {
            const session: CrawlSession = {
                index: i,
                browser: new BrowserSession(
                    this.config.browser,
                    (s) => {
                        const owner = this.sessions.find((c) => c.browser === s);
                        if (owner) {
                            this.onBrowserDisconnected(owner);
                        }
                    },
                    this.browserLauncher,
                ),
                gate: new PauseGate(),
                workers: [],
                controlPage: null,
                check: null,
                checkPageUrl: null,
                checkTimer: null,
                reloginTimer: null,
                checkRunning: false,
                restarting: null,
            };
            const perSession = shared ? instances : 1;
            for (let w = 0; w < perSession; w++) {
                session.workers.push({ index: workerIndex++, session, page: null, done: false });
            }
            sessions.push(session);
        }
        return sessions;
    }

    /**
     * Launches browsers; tests replace it to avoid starting Chrome.
     */
    browserLauncher: BrowserLauncher | undefined = undefined;

    /**
     * Starts the crawling process.
     */
    async startCrawling(): Promise<void> {
        this.crawlFailure = null;
        this.crawlLoopStarted = false;
        try {
            const mode = this.sessionMode();
            const instances = this.config.browser.instances;
            this.sessions = this.buildSessions();
            console.log(chalk.greenBright(
                mode === 'shared'
                    ? `[INFO] Initializing browser: one browser, ${instances} crawl window(s), one login (sessionMode "shared").`
                    : `[INFO] Initializing browsers: ${instances} browser(s), one login each (sessionMode "perBrowser").`,
            ));

            const startTime = Date.now();
            this.endTime = startTime + this.crawlerConfig.maxDuration;
            if (this.crawlerConfig.maxDuration === 0) {
                console.log(chalk.greenBright('[INFO] Max duration is set to 0, sasori will run indefinitely.'));
            } else {
                console.log(chalk.greenBright(`[INFO] Sasori will stop crawling at ${new Date(this.endTime).toTimeString()}`));
            }

            const recorderAuth = this.crawlerConfig.authentication.recorderAuth;
            if (recorderAuth && recorderAuth.enabled) {
                console.log(chalk.greenBright(
                    `[INFO] Recorder auth is ENABLED — logging in ${this.sessions.length === 1 ? 'once' : `once per browser (${this.sessions.length})`} ` +
                    `(recording ${(recorderAuth.pptrRecording || '').length} bytes).`,
                ));
            } else {
                console.log(chalk.yellowBright(
                    `[INFO] Recorder auth is ${recorderAuth ? 'DISABLED' : 'NOT CONFIGURED'} — crawling without a login sequence.`,
                ));
            }

            // One session at a time, NOT all at once. Logging in on every browser
            // simultaneously is a thundering herd — N concurrent navigations plus
            // N password hashes (targets like Kirimaru use scrypt, deliberately
            // CPU-heavy) plus the capturing proxy all spike together, and at 4
            // instances that contention pushes the login's navigation past its
            // timeout. In `shared` mode there is only one login anyway.
            for (const session of this.sessions) {
                if (this.abortController.signal.aborted) {
                    return;
                }
                try {
                    await this.startSession(session);
                } catch (err) {
                    const reason = errorMessage(err);
                    console.error(chalk.redBright(`[ERROR] Starting browser ${session.index} FAILED: ${reason}`));
                    throw new Error(
                        recorderAuth?.enabled ? `Authentication failed: ${reason}` : `Failed to launch browser: ${reason}`,
                    );
                }
            }
            console.log(chalk.greenBright('[INFO] Browser(s) initialized successfully!'));
            console.log(chalk.greenBright(`[INFO] Sasori will now start crawling from ${this.crawlerConfig.entryPoint}`));

            console.log(chalk.greenBright('[INFO] Creating crawl state manager...'));
            const crawlManager = new CrawlStateManager();
            // Retain for the crawl-graph dump written in `finally` (SCAN-197).
            this.crawlManager = crawlManager;
            // A fresh recorder per run, so a reused crawler does not report a
            // previous crawl's edges.
            this.graphRecorder = this.recordsCrawlGraph()
                ? new CrawlGraphRecorder(this.crawlerConfig.maxCrawlGraphEdges ?? DEFAULT_MAX_CRAWL_GRAPH_EDGES)
                : null;

            const workers = this.sessions.flatMap((session) => session.workers);
            const firstPage = workers[0]?.page;
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

            // Checks start only now: a restart during seeding would close the
            // page the seeds are loading on.
            this.crawlLoopStarted = true;
            for (const session of this.sessions) {
                this.startSessionTimers(session);
            }

            const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
            try {
                await Promise.all(workers.map(async (worker, index) => {
                    await delay(index * this.browserStartDelays);
                    return this.handleCrawl(crawlManager, worker, rootState);
                }));
            } catch (err) {
                if (!this.isFinished()) {
                    throw err;
                }
            } finally {
                // The browsers close next; that is not a crash.
                this.crawlLoopStarted = false;
                for (const session of this.sessions) {
                    this.stopSessionTimers(session);
                }
            }
            if (this.crawlFailure) {
                throw this.crawlFailure;
            }
            if (this.abortController.signal.aborted) {
                console.log(chalk.yellow('[INFO] Crawl stopped by request'));
                return;
            }
            console.log(chalk.greenBright.bold('Scan completed'));
        } finally {
            // Close every browser however the crawl ended — completed, stopped,
            // or thrown — and delete the profiles Sasori made for them. Closing
            // is idempotent with stopCrawling()'s close.
            const sessions = this.sessions;
            for (const session of sessions) {
                this.stopSessionTimers(session);
                session.gate.cancel();
            }
            await Promise.allSettled(sessions.map((session) => session.browser.close()));
            this.sessions = [];
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

        // maxDuration bounds the whole crawl, seeding included. Seeds load one at
        // a time on one page, so a large seed list would otherwise spend the
        // crawl's entire budget before any browser started clicking.
        const discovered = this.crawlerConfig.sitemap?.enabled && !this.isPastEndTime()
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

        for (const [index, url] of candidates.entries()) {
            if (this.abortController.signal.aborted) {
                break;
            }
            if (this.isPastEndTime()) {
                console.warn(chalk.yellow(
                    `[WARN] maxDuration reached while seeding; skipping the last ${candidates.length - index} of ${candidates.length} seed(s).`,
                ));
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
     * Whether the crawl's time budget is spent. False when there is no budget
     * (`maxDuration` 0) or the crawl has not started its clock.
     */
    private isPastEndTime(): boolean {
        return this.crawlerConfig.maxDuration !== 0 && this.endTime !== null && Date.now() >= this.endTime;
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
        for (const session of this.sessions) {
            this.stopSessionTimers(session);
            session.gate.cancel();
            void session.browser.close();
        }
    }
}

export default Crawler;
