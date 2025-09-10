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

        for (const cssPath of cssPaths) {
            try {
                const node = await page.$eval(cssPath, (el: any) => {
                    return {
                        outerHTML: el.outerHTML,
                        tagName: el.tagName,
                        prevElementOuterHTML: el.previousElementSibling ? el.previousElementSibling.outerHTML : null,
                        nextElementOuterHTML: el.nextElementSibling ? el.nextElementSibling.outerHTML : null,
                    };
                });

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
                } else {
                    crawlActions.push(new CrawlAction(node.tagName, 'click', cssPath, actionHash, currentState));
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
            const shortestPath = crawlManager.getShortestPath(crawlerAction.parentState);
            if (!shortestPath) return;
            // console.log('Shortest path:');
            // console.log(shortestPath.map((action) => action.cssPath));
            try {
                await page.goto(this.crawlerConfig.entryPoint, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => (globalThis as any).document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
            } catch (error) {
                console.error(chalk.red(`[ERROR] Failed to navigate to entry point: ${error instanceof Error ? error.message : 'Unknown error'}`));
                return;
            }
            for (const crawlAction of shortestPath) {
                if (crawlAction.element !== CrawlAction.ANCHOR) {
                    // console.log('All crawlinputs:');
                    // console.log(crawlAction.parentState.crawlInputs);
                    await this.fillAllInputs(page, crawlAction.parentState.crawlInputs);
                }
                try {
                    node = await page.waitForSelector(crawlAction.cssPath);
                } catch (error) {
                    this.removeCrawlActionFromState(crawlAction);
                    return;
                }
                if (!node) {
                    this.removeCrawlActionFromState(crawlAction);
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
                            this.removeCrawlActionFromState(crawlAction);
                            return;
                        }
                    } else {
                        console.error(chalk.red(`\n[ERROR] ${message}`));
                        this.removeCrawlActionFromState(crawlAction);
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
            this.removeCrawlActionFromState(crawlerAction);
            return;
        }
        if (!node) {
            this.removeCrawlActionFromState(crawlerAction);
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
    async getNewCrawlState(page: Page, crawlDepth: number, stateHash: string, crawlManager: CrawlStateManager): Promise<CrawlState> {
        // console.log(`Crawl state creator called for page: ${page.url()}`);
        const crawlState = new CrawlState(page.url(), stateHash, crawlDepth);
        crawlState.crawlActions = await this.getCrawlActions(page, crawlState, crawlManager);
        // console.log('Crawl actions found:');
        // console.log(crawlState.crawlActions.map((action) => action.cssPath));
        crawlState.crawlInputs = await this.getCrawlInputs(page, crawlState);
        // console.log(`Crawl inputs found:`);
        // console.log(crawlState.crawlInputs.map((input) => input.cssPath));
        return crawlState;
    }

    /**
     * Removes the given CrawlAction from the parent CrawlState.
     * @param crawlAction - The action to remove
     */
    removeCrawlActionFromState(crawlAction: CrawlAction): void {
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
        while ((nextCrawlAction = crawlManager.getNextCrawlAction()) && (this.crawlerConfig.maxDuration === 0 || Date.now() < this.endTime!)) {
            const currentAction = nextCrawlAction;
            // console.log('\nCurrent Action:');
            // console.log(currentAction.cssPath);
            await this.performAction(crawlManager, currentAction, page);
            // console.log('Action performed');
            const currentStateHash = await this.getPageHash(page);
            // console.log('Current state hash:');
            // console.log(currentStateHash);
            const existingState = crawlManager.getStateByHash(currentStateHash);
            if (existingState) {
                // console.log('State already exists');
                currentState = existingState;
                this.removeCrawlActionFromState(currentAction);
            } else {
                if (this.inContext(page.url())) {
                    // console.log('State does not exist, creating...');
                    currentState = await this.getNewCrawlState(page, currentAction.getParentState().crawlDepth + 1, currentStateHash, crawlManager);
                    currentAction.childState = currentState;
                } else {
                    this.removeCrawlActionFromState(currentAction);
                }
            }
        }

        await browser.close();
    }

    /**
     * Starts the crawling process.
     */
    async startCrawling(): Promise<void> {
        console.log(chalk.greenBright('[INFO] Initializing browser...'));
        const browsers = await Promise.all(
            Array.from({ length: this.config.browser.instances }).map(
                () => Browser.getBrowserInstance(this.config.browser),
            ),
        );
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

        try {
            await firstPage.goto(this.crawlerConfig.entryPoint, { waitUntil: ['domcontentloaded'] });
            await firstPage.waitForFunction(() => (globalThis as any).document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
        } catch (error) {
            console.error(chalk.red(`[ERROR] Failed to navigate to entry point during initialization: ${error instanceof Error ? error.message : 'Unknown error'}`));
            throw new Error(`Crawler initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        const rootStateHash = await this.getPageHash(firstPage);
        const rootState = await this.getNewCrawlState(firstPage, 0, rootStateHash, crawlManager);
        crawlManager.rootState = rootState;

        const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        const handleCrawls = browsers.map((browser, index) => async () => {
            await delay(index * this.browserStartDelays);
            const page = allPages[index];
            if (browser && page) {
                return this.handleCrawl(crawlManager, browser, page, rootState);
            }
            return Promise.resolve();
        });
        await Promise.all(handleCrawls.map((handleCrawl) => handleCrawl()));
        console.log(chalk.greenBright.bold('Scan completed'));
    }

    /**
     * Stop the crawling process.
     */
    stopCrawling(): void {
        // Implementation for stopping crawling if needed
    }
}

export default Crawler;
