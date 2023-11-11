const Browser = require('./src/browser/browser');
const CrawlState = require('./src/crawler/crawlState');
const DomPath = require('./src/crawler/domPath');

(async () => {
    const browser = await Browser.getBrowserInstance();
    const allPages = await browser.pages();
    const page = allPages[0];

    await page.goto('https://security-crawl-maze.app/', { waitUntil: 'networkidle0' });
    const domPath = new DomPath(page);
    const xPaths = await domPath.getXPaths();
    const rootState = new CrawlState(page.url(), await page.content(), null);
    for (const xPath of xPaths) {
        const allNodes = await page.$x(xPath);
        const node = allNodes[0];
        node.click();
        await page.waitForNavigation();
        page.goBack();
        await page.waitForNavigation();
    }

    // const els = await page.$$eval('a', (nodes) => {
    //     return nodes.map(node => node.href);
    // });

    // const allLinks = new Set(els);
    // for (const link of allLinks) {
    //     await page.goto(link, { waitUntil: 'networkidle0' });
    // }

})();