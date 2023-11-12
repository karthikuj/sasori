const Browser = require('./src/browser/browser');
const CrawlState = require('./src/crawler/crawlState');
const DomPath = require('./src/crawler/domPath');

(async () => {
    const browser = await Browser.getBrowserInstance();
    const allPages = await browser.pages();
    const page = allPages[0];

    await page.goto('https://security-crawl-maze.app/', { waitUntil: 'networkidle0' });
    const domPath = new DomPath(page);
    const cssPaths = await domPath.getCssPaths();
    const rootState = new CrawlState(page.url(), await page.content(), null);
    for (const cssPath of cssPaths) {
        const node = await page.$(cssPath);
        node.click();
        await page.waitForNavigation();
        page.goBack();
        await page.waitForNavigation();
    }
})();