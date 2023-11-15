// TODO:
// 1. Crawl only if URL is in scope.
// 2. Constructor will require scope, make a getConfig() method to fetch it.

const Browser = require('../browser/browser');
const CrawlState = require('./crawlState');
const DomPath = require('./domPath');
const CrawlAction = require('./crawlAction');

class Crawler {
    constructor() {
    }

    async getCrawlActions(page, currentState) {
        const domPath = new DomPath(page);
        const cssPaths = await domPath.getCssPaths('a');
        const crawlActions = cssPaths.map((cssPath) => {
            return new CrawlAction('a', 'click', cssPath, currentState);
        });
        return (crawlActions.length !== 0) ? crawlActions : null;
    }

    async startCrawling() {
        const browser = await Browser.getBrowserInstance();
        const allPages = await browser.pages();
        const page = allPages[0];
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(10000);
        const screen = await page.evaluate(() => { return { width: window.screen.availWidth, height: window.screen.availHeight } });
        await page.setViewport({ width: screen.width, height: screen.height });

        await page.goto('https://security-crawl-maze.app/', { waitUntil: 'domcontentloaded' });

        const rootState = new CrawlState(page.url(), await page.content(), 0, null);
        rootState.crawlActions = await this.getCrawlActions(page);

        let parentState = rootState;
        let currentState = rootState;
        while (currentState.crawlActions != null) {
            const currentAction = currentState.crawlActions[0];
            await page.waitForSelector(currentAction.cssPath);
            const node = await page.$(currentAction.cssPath);
            try {
                await node.click();
            } catch ({ name, message }) {
                if (message === "Node is either not clickable or not an Element") {
                    await node.evaluate(n => n.click());
                } else {
                    console.error(message);
                }
            }

            await page.waitForNetworkIdle({idleTime: 1000})
            currentState = new CrawlState(page.url(), await page.content(), parentState.crawlDepth + 1, null);
            currentAction.childState = currentState;
            currentState.crawlActions = await this.getCrawlActions(page, currentState);
        }

        console.log("Scan completed");
    }

    stopCrawling() { }
}

module.exports = Crawler;