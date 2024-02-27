import Browser from '../browser/browser.js';
import CrawlAction from './crawlAction.js';
import CrawlState from './crawlState.js';
import DomPath from './domPath.js';
import authenticate from '../auth/authenticator.js';
import {readFileSync} from 'fs';
// import {JSDOM} from 'jsdom';

/**
 * The Crawler class is responsible for creating and managing the crawler.
 */
class Crawler {
  /**
      * Crawler class contructor.
      */
  constructor() {
    this.crawlerConfig = this.getCrawlerConfig();
    this.authInProgress = false;
  }

  /**
     * Strips DOM by removing useless attributes, comments and all text.
     * @param {Object} node
     */
  stripDOM(node) {
    // If the node is a text node or comment node, remove its content
    if (node.nodeType === node.TEXT_NODE ||
        node.nodeType === node.COMMENT_NODE) {
      node.nodeValue = '';
    }

    // Remove attributes from element nodes
    if (node.nodeType === node.ELEMENT_NODE) {
      Array.from(node.attributes).forEach((attr) => {
        if (['href', 'src'].indexOf(attr.name) == -1) {
          node.removeAttribute(attr.name);
        }
      });
    }

    // Recursively strip child nodes
    node.childNodes.forEach((child) => stripDOM(child));
  }

  /**
   * Fetches and returns crawlConfig
   * @return {Object} crawlConfig
   */
  getCrawlerConfig() {
    const configFilePath = new URL('../../config/config.json', import.meta.url);
    let crawlerConfig = {};

    try {
      crawlerConfig = JSON.parse(
          readFileSync(configFilePath, 'utf-8'),
      )['crawler'];
    } catch (error) {
      console.error('Error reading/parsing JSON file:', error.message);
    }

    return crawlerConfig;
  }

  /**
   * Fetches all possible CrawlActions on a CrawlState and returns them.
   * @param {Page} page
   * @param {CrawlState} currentState
   * @return {(CrawlAction[] | null)}
   */
  async getCrawlActions(page, currentState) {
    const domPath = new DomPath(page);
    const cssPaths = await domPath.getCssPaths('a');
    const crawlActions = cssPaths.map((cssPath) => {
      return new CrawlAction('a', 'click', cssPath, currentState);
    });
    return (crawlActions.length !== 0) ? crawlActions : null;
  }

  /**
   * Performs the given crawlaction on page.
   * @param {CrawlAction} crawlerAction
   * @param {Page} page
   */
  async performAction(crawlerAction, page) {
    await page.waitForSelector(crawlerAction.cssPath);
    const node = await page.$(crawlerAction.cssPath);
    try {
      await node.click();
    } catch ({name, message}) {
      if (message === 'Node is either not clickable or not an Element') {
        await node.evaluate((n) => n.click());
      } else {
        console.error(message);
      }
    }

    try {
      await page.waitForNavigation({waitUntil: 'domcontentloaded'});
    } catch ({name, message}) {
      if (name === 'TimeoutError' && message.includes('Navigation timeout')) {
        await page.waitForNetworkIdle({idleTime: 1000});
      }
    }
  }

  /**
   * Checks if the given URL is in context or not.
   * @param {string} url
   * @return {boolean}
   */
  inContext(url) {
    for (const regex of this.crawlerConfig.includeRegexes) {
      const urlRegex = new RegExp(regex);
      if (url.match(urlRegex)) {
        return true;
      }
    }

    return false;
  }

  async startAuthentication(browser, page) {
    this.authInProgress = true;
    await authenticate(browser, page, new URL('/home/astra/Downloads/pptr.json', import.meta.url));
    this.authInProgress = false;
  }

  async startCrawling() {
    const browser = await Browser.getBrowserInstance();
    const allPages = await browser.pages();
    const page = allPages[0];
    const screen = await page.evaluate(() => {
      return {width: window.screen.availWidth, height: window.screen.availHeight};
    });
    await page.setViewport({width: screen.width, height: screen.height});
    await page.setRequestInterception(true);
    page.on('request', (interceptedRequest) => {
      if (interceptedRequest.isInterceptResolutionHandled()) return;
      if (this.authInProgress == false && !this.inContext(interceptedRequest.url())) {
        console.log(interceptedRequest.url());
        interceptedRequest.respond({
          status: 200,
          contentType: 'text/plain',
          body: 'Out of Sasori\'s scope',
        });
      } else interceptedRequest.continue();
    });
    await this.startAuthentication(browser, page);
    await page.goto('https://security-crawl-maze.app/', {waitUntil: 'domcontentloaded'});

    const rootState = new CrawlState(page.url(), await page.content(), 0, null);
    rootState.crawlActions = await this.getCrawlActions(page);

    const parentState = rootState;
    let currentState = rootState;

    // const sampleOneHashDigest = crypto.createHash(algorithm).update(sampleOneStrippedHtml).digest('hex');
    // stripDOM(sampleOneDom.window.document.documentElement);

    while (currentState.crawlActions != null) {
      const currentAction = currentState.crawlActions[0];
      await this.performAction(currentAction, page);
      currentState = new CrawlState(page.url(), await page.content(), parentState.crawlDepth + 1, null);
      currentAction.childState = currentState;
      currentState.crawlActions = await this.getCrawlActions(page, currentState);
    }

    console.log('Scan completed');
  }

  stopCrawling() { }
}

export default Crawler;
