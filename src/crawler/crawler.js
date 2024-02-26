// TODO:
// 1. Crawl only if URL is in scope.
// 2. Constructor will require scope, make a getConfig() method to fetch it.

import Browser from '../browser/browser.js';
import CrawlState from './crawlState.js';
import DomPath from './domPath.js';
import CrawlAction from './crawlAction.js';
import authenticate from '../auth/authenticator.js';
import { readFileSync } from "fs";

class Crawler {
    constructor() {
        this.crawlerConfig = this.getCrawlerConfig();
        this.authInProgress = false;
    }

    getCrawlerConfig() {
        const configFilePath = new URL("../../config/config.json", import.meta.url);
        let crawlerConfig = {};

        try {
            crawlerConfig = JSON.parse(readFileSync(configFilePath, "utf-8"))["crawler"];
        } catch (error) {
            console.error("Error reading/parsing JSON file:", error.message);
        }

        return crawlerConfig;
    }

    async getCrawlActions(page, currentState) {
        const domPath = new DomPath(page);
        const cssPaths = await domPath.getCssPaths('a');
        const crawlActions = cssPaths.map((cssPath) => {
            return new CrawlAction('a', 'click', cssPath, currentState);
        });
        return (crawlActions.length !== 0) ? crawlActions : null;
    }

    async performAction(crawlerAction, page) {
        await page.waitForSelector(crawlerAction.cssPath);
        const node = await page.$(crawlerAction.cssPath);
        try {
            await node.click();
        } catch ({ name, message }) {
            if (message === "Node is either not clickable or not an Element") {
                await node.evaluate(n => n.click());
            } else {
                console.error(message);
            }
        }

        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        } catch ({ name, message }) {
            if (name === "TimeoutError" && message.includes("Navigation timeout")) {
                await page.waitForNetworkIdle({ idleTime: 1000 });
            }
        }
    }

    inContext(url) {
        for (const regex of this.crawlerConfig.includeRegexes) {
            let urlRegex = new RegExp(regex);
            if (url.match(urlRegex)) {
                return true;
            }
        }

        return false;
    }

    async startAuthentication(browser, page) {
        this.authInProgress = true;
        await authenticate(browser, page, new URL("/home/astra/Downloads/pptr.json", import.meta.url));
        this.authInProgress = false;
    }

    async startCrawling() {
        const browser = await Browser.getBrowserInstance();
        const allPages = await browser.pages();
        const page = allPages[0];
        const screen = await page.evaluate(() => { return { width: window.screen.availWidth, height: window.screen.availHeight } });
        await page.setViewport({ width: screen.width, height: screen.height });
        await page.setRequestInterception(true);
        page.on('request', interceptedRequest => {
            if (interceptedRequest.isInterceptResolutionHandled()) return;
            if (this.authInProgress == false && !this.inContext(interceptedRequest.url())) {
                console.log(interceptedRequest.url());
                interceptedRequest.respond({
                    status: 200,
                    contentType: 'text/plain',
                    body: 'Out of Sasori\'s scope'
                });
            } else interceptedRequest.continue();
        });
        await this.startAuthentication(browser, page)
        await page.goto('https://security-crawl-maze.app/', { waitUntil: 'domcontentloaded' });

        const rootState = new CrawlState(page.url(), await page.content(), 0, null);
        rootState.crawlActions = await this.getCrawlActions(page);

        let parentState = rootState;
        let currentState = rootState;
        while (currentState.crawlActions != null) {
            const currentAction = currentState.crawlActions[0];
            await this.performAction(currentAction, page);
            currentState = new CrawlState(page.url(), await page.content(), parentState.crawlDepth + 1, null);
            currentAction.childState = currentState;
            currentState.crawlActions = await this.getCrawlActions(page, currentState);
        }

        console.log("Scan completed");
    }

    stopCrawling() { }
}

export default Crawler;