const Browser = require('./src/browser/browser');
const CrawlState = require('./src/crawler/crawlState');

(async () => {
    const browser = await Browser.getBrowserInstance();
    const allPages = await browser.pages();
    const page = allPages[0];

    await page.goto('https://security-crawl-maze.app/', { waitUntil: 'networkidle0' });
    const rootState = new CrawlState(page.url(), await page.content(), await page.$$('a'), -1)
    console.log(rootState);
    // const els = await page.$$eval('a', (nodes) => {
    //     return nodes.map(node => node.href);
    // });

    // const allLinks = new Set(els);
    // for (const link of allLinks) {
    //     await page.goto(link, { waitUntil: 'networkidle0' });
    // }

})();