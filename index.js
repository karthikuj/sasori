const Browser = require('./src/browser/browser');
const CrawlState = require('./src/crawler/crawlState');
const DomPath = require('./src/crawler/domPath');
const CrawlAction = require('./src/crawler/crawlAction');

(async () => {
    const browser = await Browser.getBrowserInstance();
    const allPages = await browser.pages();
    const page = allPages[0];
    const screen = await page.evaluate(() => { return { width: window.screen.availWidth, height: window.screen.availHeight } });
    await page.setViewport({ width: screen.width, height: screen.height });

    await page.goto('https://security-crawl-maze.app/', { waitUntil: 'networkidle0' });
    const domPath = new DomPath(page);
    const cssPaths = await domPath.getCssPaths('a');
    const rootState = new CrawlState(page.url(), await page.content(), null, []);
    for (const cssPath of cssPaths) {
        rootState.crawlActions.push(new CrawlAction('a', 'click', cssPath));
        await page.waitForSelector(cssPath);
        const node = await page.$(cssPath);
        node.click();
        await page.waitForNavigation();
        page.goto(rootState.url);
        await page.waitForNavigation();
    }
})();