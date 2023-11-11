const puppeteer = require('puppeteer');
const proxyServer = '127.0.0.1:8081';

(async () => {
    const browser = await puppeteer.launch({ headless: false, args: ['--start-maximized', `--proxy-server=${proxyServer}`] });
    const allPages = await browser.pages();
    const page = allPages[0];

    await page.goto('https://security-crawl-maze.app/', { waitUntil: 'networkidle0' });
    const els = await page.$$eval('a', (nodes) => {
        return nodes.map(node => node.href);
    });

    const allLinks = new Set(els);
    console.log(allLinks);
    for (const link of allLinks) {
        await page.goto(link);
    }

})();