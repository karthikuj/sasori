import { Browser as PuppeteerBrowser, Page, CDPSession } from 'puppeteer';
import { appendFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

import Browser from '../browser/browser';
import CrawlAction from './crawlAction';
import CrawlInput from './crawlInput';
import CrawlState from './crawlState';
import CrawlStateManager from './crawlStateManager';
import DomPath from './domPath';
import authenticate from '../auth/authenticator';
import { CrawlerConfig, CrawlerSettings } from '../types/crawler';
import { ArrivalType } from '../types/input';

/**
 * One batched `page.evaluate` result per CSS path (failures do not abort siblings).
 */
type BatchActionNodeSnapshot =
    | {
        ok: true;
        cssPath: string;
        outerHTML: string;
        tagName: string;
        prevElementOuterHTML: string | null;
        nextElementOuterHTML: string | null;
    }
    | { ok: false; cssPath: string; error: string };

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
     * Max CSS selectors per `page.evaluate` batch (limits payload / eval time per round-trip).
     */
    private static readonly BATCH_ACTION_SELECTOR_CHUNK_SIZE = 100;

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
     * Array of all interactable elements
     */
    public allInteractables: string[];

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

    /**
     * Crawler class constructor.
     * @param config - Configuration object containing browser and crawler settings
     */
    constructor(config: CrawlerConfig) {
        this.config = config;
        this.crawlerConfig = config.crawler;
        this.authInProgress = false;
        this.allUrls = new Set<string>();
        this.allInteractables = [...this.crawlerConfig.elements].concat(
            CrawlInput.INPUT_FIELDS.map((element) => element.CSS_PATH)
        );
        this.endTime = null;
        this.browserStartDelays = 1000; // 1 millisecond(s)
    }

    /**
     * Whether {@link stopCrawling} was called (or the signal was aborted).
     */
    wasStopped(): boolean {
        return this.abortController.signal.aborted;
    }

    /**
     * Strips DOM by removing useless attributes, comments and all text.
     * @param $ - Cheerio API instance
     */
    stripDOM($: cheerio.CheerioAPI): void {
        // Get all elements once and process them in a single pass
        const allElements = $('*');

        // Remove text and comment nodes
        allElements.contents().filter((_: number, node: any) =>
            node.nodeType === Crawler.TEXT_NODE || node.nodeType === Crawler.COMMENT_NODE
        ).remove();

        // Process each element for attributes and interactability in one pass
        allElements.each((_: number, element: any) => {
            // Remove attributes except href for <a> and <base>, and src for <script>
            const tagName = element.name && element.name.toUpperCase();
            const allowedAttributes: string[] = [];
            switch (tagName) {
                case 'A':
                case 'BASE':
                    allowedAttributes.push('href');
                    break;
                case 'SCRIPT':
                    allowedAttributes.push('src');
                    break;
            }
            Object.keys(element.attribs).forEach((attrName) => {
                if (!allowedAttributes.includes(attrName)) {
                    $(element).removeAttr(attrName);
                }
            });

            // Remove nodes if none of the CSS paths are found
            const found = this.allInteractables.some((cssPath) =>
                ($(element).is(cssPath) || $(element).find(cssPath).length > 0)
            );
            if (!found) {
                $(element).remove();
            }
        });

        // Change src attribute value for <script> tags
        $('script[src]').each((_: number, element: any) => {
            const srcValue = $(element).attr('src');
            if (srcValue) {
                const cleanSrc = typeof srcValue === 'string' ? srcValue : String(srcValue);
                $(element).attr('src', cleanSrc.split('?')[0] as any);
            }
        });
    }

    /**
     * Fetches all possible CrawlInputs on a CrawlState and returns them.
     * @param page - Puppeteer page instance
     * @param currentState - Current crawl state
     * @return Promise resolving to array of CrawlInput objects
     */
    async getCrawlInputs(page: Page, currentState: CrawlState): Promise<CrawlInput[]> {
        const domPath = new DomPath(page);
        const crawlInputs: CrawlInput[] = [];
        let cssPaths: string[];

        for (const input of CrawlInput.INPUT_FIELDS) {
            cssPaths = await domPath.getCssPaths(input.CSS_PATH);
            crawlInputs.push(...cssPaths.map((cssPath) => {
                return new CrawlInput(input.ELEMENT, input.TYPE, cssPath, currentState);
            }));
        }

        return (crawlInputs.length !== 0) ? crawlInputs : [];
    }

    /**
     * Function to find all nodes with click event listeners
     * @param client - CDP session client
     * @param event - Event type to search for
     * @return Promise resolving to array of CSS selectors
     */
    async findNodesWithClickListeners(client: CDPSession, event: string): Promise<string[]> {
        const { root } = await client.send('DOM.getDocument', { depth: -1 });
        const { nodeIds } = await client.send('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: '*',
        });

        const clickListeners: string[] = [];
        for (const nodeId of nodeIds) {
            try {
                // Get the RemoteObjectId for the node
                const { object } = await client.send('DOM.resolveNode', { nodeId: nodeId });
                const remoteObjectId = object.objectId;

                if (!remoteObjectId) {
                    continue;
                }

                // Get event listeners for the node
                const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: remoteObjectId });
                if (listeners.some((listener: any) => listener.type === event)) {
                    const { node } = await client.send('DOM.describeNode', { nodeId: nodeId });
                    let cssPath = '';
                    if (node.attributes && node.attributes.length > 0) {
                        const excludedAttrNameChars = ['.'];
                        const excludedAttrValueChars = ['"', '\n'];
                        for (let i = 0; i < node.attributes.length; i += 2) {
                            const attrName = node.attributes[i];
                            const attrValue = node.attributes[i + 1];
                            // Continue if the attribute name has an excluded character.
                            if (attrName && excludedAttrNameChars.some((element) => attrName.includes(element))) {
                                continue;
                            }
                            // Continue if attribute value has some excluded character.
                            if (attrValue && excludedAttrValueChars.some((element) => attrValue.includes(element))) {
                                continue;
                            }
                            if (attrName && attrValue) {
                                cssPath += `[${attrName}="${attrValue}"]`;
                            }
                        }

                        if (cssPath && node.localName) {
                            cssPath = node.localName + cssPath;
                            clickListeners.push(cssPath);
                        }
                    }
                }
            } catch (error) {
                // do nothing
            }
        }

        return clickListeners;
    }

    /**
     * Fetches outerHTML / sibling context for many selectors in one or more `page.evaluate` calls.
     * Each path is isolated with try/catch in the page context so one bad selector does not fail the batch.
     */
    private async batchFetchActionNodeSnapshots(page: Page, cssPaths: string[]): Promise<BatchActionNodeSnapshot[]> {
        if (cssPaths.length === 0) {
            return [];
        }

        const all: BatchActionNodeSnapshot[] = [];
        const chunkSize = Crawler.BATCH_ACTION_SELECTOR_CHUNK_SIZE;

        for (let offset = 0; offset < cssPaths.length; offset += chunkSize) {
            const chunk = cssPaths.slice(offset, offset + chunkSize);
            const batch = await page.evaluate((paths: string[]) => {
                const out: BatchActionNodeSnapshot[] = [];
                const doc = (globalThis as unknown as { document: { querySelector: (s: string) => unknown } }).document;
                for (const cssPath of paths) {
                    try {
                        const el = doc.querySelector(cssPath) as {
                            outerHTML: string;
                            tagName: string;
                            previousElementSibling: { outerHTML: string } | null;
                            nextElementSibling: { outerHTML: string } | null;
                        } | null;
                        if (!el) {
                            out.push({ ok: false, cssPath, error: 'not found' });
                            continue;
                        }
                        out.push({
                            ok: true,
                            cssPath,
                            outerHTML: el.outerHTML,
                            tagName: el.tagName,
                            prevElementOuterHTML: el.previousElementSibling
                                ? el.previousElementSibling.outerHTML
                                : null,
                            nextElementOuterHTML: el.nextElementSibling
                                ? el.nextElementSibling.outerHTML
                                : null,
                        });
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e);
                        out.push({ ok: false, cssPath, error: msg });
                    }
                }
                return out;
            }, chunk);
            all.push(...batch);
        }

        return all;
    }

    /**
     * Fetches all possible CrawlActions on a CrawlState and returns them.
     * @param page - Puppeteer page instance
     * @param currentState - Current crawl state
     * @param crawlManager - Crawl state manager instance
     * @return Promise resolving to array of CrawlAction objects
     */
    async getCrawlActions(page: Page, currentState: CrawlState, crawlManager: CrawlStateManager): Promise<CrawlAction[]> {
        const domPath = new DomPath(page);
        const crawlActions: CrawlAction[] = [];
        let cssPaths = new Set<string>();

        // If max crawl depth has been reached then no need to fetch more actions for the given state.
        if (this.crawlerConfig.maxDepth && currentState.getCrawlDepth() >= this.crawlerConfig.maxDepth) {
            return crawlActions;
        }

        const allCssPaths: string[] = [];

        for (const element of this.crawlerConfig.elements) {
            // Check if the selector is for an event (like [click]) or element.
            if (/^\[\w+\]$/.test(element)) {
                const event = element.substr(1, element.length - 2);
                // Enable the Debugger
                const client = await page.target().createCDPSession();
                await client.send('DOM.enable');
                await client.send('Runtime.enable');
                const allClickListeners = await this.findNodesWithClickListeners(client, event);
                for (const clickListener of allClickListeners) {
                    try {
                        allCssPaths.push(...(await domPath.getCssPaths(clickListener)));
                    } catch (error) {
                        // The query selector is invalid.
                    }
                }
            } else {
                allCssPaths.push(...(await domPath.getCssPaths(element)));
            }
        }

        // Create Set once after collecting all paths
        cssPaths = new Set(allCssPaths);
        const pathList = Array.from(cssPaths);
        const snapshots = await this.batchFetchActionNodeSnapshots(page, pathList);

        for (const snap of snapshots) {
            if (!snap.ok) {
                console.error(chalk.red(`[ERROR] batch action snapshot failed for ${snap.cssPath}: ${snap.error}`));
                continue;
            }

            try {
                const node = snap;
                const cssPath = snap.cssPath;

                const nodeCheerio = cheerio.load(node.outerHTML, { xmlMode: true });
                this.stripDOM(nodeCheerio as cheerio.CheerioAPI);
                let prevElementStrippedDOM = '';
                let nextElementStrippedDOM = '';

                if (node.prevElementOuterHTML) {
                    const prevNodeCheerio = cheerio.load(node.prevElementOuterHTML, { xmlMode: true });
                    this.stripDOM(prevNodeCheerio as cheerio.CheerioAPI);
                    prevElementStrippedDOM = prevNodeCheerio.html();
                }

                if (node.nextElementOuterHTML) {
                    const nextNodeCheerio = cheerio.load(node.nextElementOuterHTML, { xmlMode: true });
                    this.stripDOM(nextNodeCheerio as cheerio.CheerioAPI);
                    nextElementStrippedDOM = nextNodeCheerio.html();
                }

                const actionHash = createHash('sha256').update(prevElementStrippedDOM + nodeCheerio.html() + nextElementStrippedDOM).digest('hex');
                if (crawlManager.isCrawlActionUnique(cssPath, actionHash)) {
                    crawlActions.push(new CrawlAction(node.tagName, 'click', cssPath, actionHash, currentState));
                    crawlManager.registerActionSignature(cssPath, actionHash);
                }
            } catch (error) {
                console.error(error);
                continue;
            }
        }

        return (crawlActions.length !== 0) ? (this.crawlerConfig.maxChildren ? crawlActions.slice(0, this.crawlerConfig.maxChildren).reverse() : crawlActions.reverse()) : [];
    }

    /**
     * Fills out all CrawlInputs provided to it in the iterable.
     * @param page - Puppeteer page instance
     * @param crawlInputs - Array of CrawlInput objects to fill
     */
    async fillAllInputs(page: Page, crawlInputs: CrawlInput[]): Promise<void> {
        for (const crawlInput of crawlInputs) {
            try {
                await crawlInput.inputFieldHandler(page);
            } catch (error) {
                console.error(chalk.red(`[ERROR] Could not fill input field: ${crawlInput.cssPath}`));
                this.removeCrawlInputFromState(crawlInput);
            }
        }
    }

    /**
     * Performs the given crawlaction on page.
     * @param crawlManager - Crawl state manager instance
     * @param crawlerAction - The action to perform
     * @param page - Puppeteer page instance
     */
    async performAction(crawlManager: CrawlStateManager, crawlerAction: CrawlAction, page: Page): Promise<void> {
        let node;
        const currentStateHash = await this.getPageHash(page);
        if (currentStateHash !== crawlerAction.parentState.stateHash) {
            const replayPlan = crawlManager.getOptimizedReplayPlan(crawlerAction.parentState);
            if (!replayPlan) return;
            {
                const maxRetries = this.crawlerConfig.maxActionRetries ?? 3;
                let success = false;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        await page.goto(replayPlan.baselineUrl, { waitUntil: 'domcontentloaded' });
                        await page.waitForFunction(() => (globalThis as any).document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
                        success = true;
                        break;
                    } catch (error) {
                        console.error(chalk.red(`[ERROR] Failed to navigate to baseline (attempt ${attempt}/${maxRetries}): ${error instanceof Error ? error.message : 'Unknown error'}`));
                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                }
                if (!success) {
                    console.error(chalk.red('[ERROR] Exhausted retries navigating to baseline state'));
                    return;
                }
            }

            for (const crawlAction of replayPlan.actionsToReplay) {
                if (crawlAction.element !== CrawlAction.ANCHOR) {
                    // console.log('All crawlinputs:');
                    // console.log(crawlAction.parentState.crawlInputs);
                    await this.fillAllInputs(page, crawlAction.parentState.crawlInputs);
                }
                try {
                    node = await page.waitForSelector(crawlAction.cssPath);
                } catch (error) {
                    this.removeCrawlActionFromState(crawlManager, crawlAction);
                    return;
                }
                if (!node) {
                    this.removeCrawlActionFromState(crawlManager, crawlAction);
                    return;
                }
                try {
                    await node.click();
                } catch (error: any) {
                    const { message } = error;
                    if (message === 'Node is either not clickable or not an Element') {
                        try {
                            await node.evaluate((n: any) => n.click());
                        } catch (evalError) {
                            console.error(chalk.red(`\n[ERROR] ${evalError instanceof Error ? evalError.message : 'Unknown error'}`));
                            this.removeCrawlActionFromState(crawlManager, crawlAction);
                            return;
                        }
                    } else {
                        console.error(chalk.red(`\n[ERROR] ${message}`));
                        this.removeCrawlActionFromState(crawlManager, crawlAction);
                        return;
                    }
                }
            }
        }

        if (crawlerAction.element !== CrawlAction.ANCHOR) {
            await this.fillAllInputs(page, crawlerAction.parentState.crawlInputs);
        }
        try {
            node = await page.waitForSelector(crawlerAction.cssPath);
        } catch (error) {
            this.removeCrawlActionFromState(crawlManager, crawlerAction);
            return;
        }
        if (!node) {
            this.removeCrawlActionFromState(crawlManager, crawlerAction);
            return;
        }
        try {
            await node.click();
        } catch (error: any) {
            const { message } = error;
            if (message === 'Node is either not clickable or not an Element') {
                try {
                    await node.evaluate((n: any) => n.click());
                } catch (evalError) {
                    console.error(chalk.red(`\n[ERROR] ${evalError instanceof Error ? evalError.message : 'Unknown error'}`));
                }
            } else {
                console.error(chalk.red(`\n[ERROR] ${message}`));
            }
        }

        await page.waitForFunction(
            async (eventWait: number) => await new Promise<boolean>((resolve) => setTimeout(() => {
                resolve(true);
            }, eventWait)),
            { timeout: this.crawlerConfig.navigationTimeout },
            this.crawlerConfig.eventWait,
        );

        if (!this.allUrls.has(page.url())) {
            console.log(chalk.magenta('[URL] ') + chalk.green(page.url()));
            this.allUrls.add(page.url());
            if (this.crawlerConfig.outputFile) {
                this.appendUrlToOutputFile(page.url());
            }
        }
    }

    /**
     * Checks if the given URL is in context or not.
     * @param url - URL to check
     * @return boolean indicating if URL is in context
     */
    inContext(url: string): boolean {
        // Check if it is excluded
        for (const regex of this.crawlerConfig.excludeRegexes) {
            const excludeRegex = new RegExp(regex);
            if (url.match(excludeRegex)) {
                return false;
            }
        }

        // Check if it is included
        for (const regex of this.crawlerConfig.includeRegexes) {
            const includeRegex = new RegExp(regex);
            if (url.match(includeRegex)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Maximizes viewport according to screensize.
     * @param page - Puppeteer page instance
     */
    async maximizeViewport(page: Page): Promise<void> {
        const screen = await page.evaluate(() => {
            return {
                width: (globalThis as any).screen.availWidth,
                height: (globalThis as any).screen.availHeight,
            };
        });
        await page.setViewport({ width: screen.width, height: screen.height });
    }

    /**
     * Starts authentication on the given browser instance.
     * @param browser - Puppeteer browser instance
     * @param page - Puppeteer page instance
     */
    async startAuthentication(browser: PuppeteerBrowser, page: Page): Promise<void> {
        this.authInProgress = true;
        await authenticate(browser, page, path.resolve(__dirname, this.crawlerConfig.authentication.recorderAuth.pptrRecording || ''));
        this.authInProgress = false;
        await this.maximizeViewport(page);
    }

    /**
     * Returns the SHA256 hash of the stripped DOM of the given page.
     * @param page - Puppeteer page instance
     * @return Promise resolving to the page hash string
     */
    async getPageHash(page: Page): Promise<string> {
        await page.waitForFunction(() => (globalThis as any).document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
        let $: cheerio.CheerioAPI;
        try {
            $ = cheerio.load(await page.content(), { xmlMode: true }) as cheerio.CheerioAPI;
        } catch (error: any) {
            const { message } = error;
            if (message === 'Execution context was destroyed, most likely because of a navigation.') {
                await page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle0'] });
                $ = cheerio.load(await page.content(), { xmlMode: true }) as cheerio.CheerioAPI;
            } else {
                console.error(chalk.red(`\n[ERROR] ${message}`));
                throw error;
            }
        }
        this.stripDOM($);
        const pageHash = createHash('sha256').update($.html()).digest('hex');

        return pageHash;
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
        crawlState.crawlActions = await this.getCrawlActions(page, crawlState, crawlManager);
        // console.log('Crawl actions found:');
        // console.log(crawlState.crawlActions.map((action) => action.cssPath));
        crawlState.crawlInputs = await this.getCrawlInputs(page, crawlState);
        // console.log(`Crawl inputs found:`);
        // console.log(crawlState.crawlInputs.map((input) => input.cssPath));
        crawlManager.registerState(crawlState);
        return crawlState;
    }

    /**
     * Removes the given CrawlAction from the parent CrawlState.
     * @param crawlAction - The action to remove
     */
    removeCrawlActionFromState(crawlManager: CrawlStateManager, crawlAction: CrawlAction): void {
        crawlManager.unregisterActionSignature(crawlAction.cssPath, crawlAction.actionHash);
        crawlAction.getParentState().crawlActions = crawlAction.getParentState().crawlActions.filter((value) =>
            crawlAction.actionId !== value.actionId
        );
    }

    /**
     * Removes the given CrawlInput from the parent CrawlState.
     * @param crawlInput - The input to remove
     */
    removeCrawlInputFromState(crawlInput: CrawlInput): void {
        crawlInput.getParentState().crawlInputs = crawlInput.getParentState().crawlInputs.filter((value) =>
            crawlInput.inputId !== value.inputId
        );
    }

    /**
     * Append the given URL to the output file.
     * @param url - URL to append
     */
    appendUrlToOutputFile(url: string): void {
        const fullPath = path.resolve(this.crawlerConfig.outputFile!);
        appendFileSync(fullPath, url + '\n');
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
                try {
                    await this.performAction(crawlManager, currentAction, page);
                } catch (err) {
                    if (this.abortController.signal.aborted) {
                        break;
                    }
                    throw err;
                }
                const currentStateHash = await this.getPageHash(page);
                const existingState = crawlManager.getStateByHash(currentStateHash);
                if (existingState) {
                    currentState = existingState;
                    this.removeCrawlActionFromState(crawlManager, currentAction);
                } else {
                    if (this.inContext(page.url())) {
                        const previousUrl = currentAction.getParentState().url.split('#')[0];
                        const newUrl = page.url().split('#')[0];
                        const arrivalType: ArrivalType = (currentAction.element === CrawlAction.ANCHOR && previousUrl !== newUrl) ? 'link' : 'dom';
                        currentState = await this.getNewCrawlState(page, currentAction.getParentState().crawlDepth + 1, currentStateHash, crawlManager, arrivalType);
                        currentAction.childState = currentState;
                        if (currentState) {
                            currentState.parentAction = currentAction;
                        }
                    } else {
                        this.removeCrawlActionFromState(crawlManager, currentAction);
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
            const browsers = await Promise.all(
                Array.from({ length: this.config.browser.instances }).map(
                    () => Browser.getBrowserInstance(this.config.browser),
                ),
            );
            this.activeBrowsers = browsers;
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
            for (const browser of browsers) {
                const pages = await browser.pages();
                const page = pages[0];
                if (!page) continue;
                page.setDefaultTimeout(this.crawlerConfig.eventTimeout);
                page.setDefaultNavigationTimeout(this.crawlerConfig.navigationTimeout);
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
                        if (!this.allUrls.has(interceptedRequest.url())) {
                            console.log(chalk.magentaBright('[URL] ') + chalk.green(interceptedRequest.url()));
                            this.allUrls.add(interceptedRequest.url());
                            if (this.crawlerConfig.outputFile) {
                                this.appendUrlToOutputFile(interceptedRequest.url());
                            }
                        }
                    }

                    if (this.authInProgress) {
                        const parsedUrl = new URL(interceptedRequest.url());
                        const authority = parsedUrl.host;
                        const includeRegex = `https?://${authority}(?:/.*|)`;
                        if (!this.crawlerConfig.includeRegexes.includes(includeRegex)) {
                            this.crawlerConfig.includeRegexes.push(includeRegex);
                        }
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
            if (this.crawlerConfig.authentication.recorderAuth && this.crawlerConfig.authentication.recorderAuth.enabled) {
                console.log(chalk.greenBright('[INFO] Running initial authentication...'));
                await Promise.all(
                    Array.from({ length: browsers.length }).map(
                        (_, i) => {
                            const browser = browsers[i];
                            const page = allPages[i];
                            if (browser && page) {
                                return this.startAuthentication(browser, page);
                            }
                            return Promise.resolve();
                        },
                    ),
                );
            }

            console.log(chalk.greenBright('[INFO] Creating crawl state manager...'));
            const crawlManager = new CrawlStateManager();

            if (allPages.length === 0) {
                throw new Error('No pages available for crawling');
            }

            const firstPage = allPages[0];
            if (!firstPage) {
                throw new Error('No pages available for crawling');
            }

            {
                const maxRetries = this.crawlerConfig.maxActionRetries ?? 3;
                let success = false;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    if (this.abortController.signal.aborted) {
                        return;
                    }
                    try {
                        await firstPage.goto(this.crawlerConfig.entryPoint, { waitUntil: ['domcontentloaded'] });
                        await firstPage.waitForFunction(() => (globalThis as any).document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
                        success = true;
                        break;
                    } catch (error) {
                        console.error(chalk.red(`[ERROR] Failed to navigate to entry point (attempt ${attempt}/${maxRetries}): ${error instanceof Error ? error.message : 'Unknown error'}`));
                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                }
                if (!success) {
                    throw new Error('Crawler initialization failed: exhausted retries navigating to entry point');
                }
            }
            if (this.abortController.signal.aborted) {
                return;
            }
            const rootStateHash = await this.getPageHash(firstPage);
            const rootState = await this.getNewCrawlState(firstPage, 0, rootStateHash, crawlManager, 'link');
            crawlManager.attachRootState(rootState);

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
            this.activeBrowsers = [];
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
