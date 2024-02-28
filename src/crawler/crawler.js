import Browser from '../browser/browser.js';
import CrawlAction from './crawlAction.js';
import CrawlState from './crawlState.js';
import CrawlStateManager from './crawlStateManager.js';
import DomPath from './domPath.js';
import {JSDOM} from 'jsdom';
import authenticate from '../auth/authenticator.js';
import {createHash} from 'crypto';
import {readFileSync} from 'fs';

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
    this.banner = `\x1b[32m
                              :.            :   
                             .+              =. 
                             ++.            .-= 
                            :++==   .  .   :===:
                            -+++.   :  :    =++-
                              ==    .--.   .-=. 
                               :+: .-:.-. :=:   
                             .-::--:-::::--:::. 
                            -: .:-..::::..::. :-
                            - ::  ..:::: :  :: -
                              -  -. :--: .-  -  
                              :  -   --.  :. :  
                                 :   ..   :     


                                    SASORI
                                    v1.0.0

    `;
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
    node.childNodes.forEach((child) => this.stripDOM(child));
  }

  /**
   * Fetches and returns crawlConfig
   * @return {Object} crawlConfig
   */
  getCrawlerConfig() {
    const configFilePath = new URL('../../config/config.json', import.meta.url);
    let crawlerConfig = {};

    try {
      crawlerConfig = JSON.parse(readFileSync(configFilePath, 'utf-8'))['crawler'];
    } catch (error) {
      console.error('Error reading/parsing JSON file:', error.message);
    }

    return crawlerConfig;
  }

  /**
   * Fetches all possible CrawlActions on a CrawlState and returns them.
   * @param {Page} page
   * @param {CrawlState} currentState
   * @return {CrawlAction[]}
   */
  async getCrawlActions(page, currentState) {
    const domPath = new DomPath(page);
    const cssPaths = await domPath.getCssPaths('a');
    const crawlActions = cssPaths.map((cssPath) => {
      return new CrawlAction('a', 'click', cssPath, currentState);
    });
    return (crawlActions.length !== 0) ? crawlActions : [];
  }

  /**
   * Performs the given crawlaction on page.
   * @param {CrawlStateManager} crawlManager
   * @param {CrawlAction} crawlerAction
   * @param {Page} page
   */
  async performAction(crawlManager, crawlerAction, page) {
    const currentStateHash = await this.getPageHash(page);
    if (currentStateHash !== crawlerAction.parentState.stateHash) {
      const shortestPath = crawlManager.getShortestPath(crawlerAction.parentState);
      console.log(shortestPath);
      await page.goto('https://security-crawl-maze.app/', {waitUntil: 'domcontentloaded'});
      for (const crawlAction of shortestPath) {
        await page.waitForSelector(crawlAction.cssPath);
        const node = await page.$(crawlAction.cssPath);

        try {
          await node.click();
        } catch ({name, message}) {
          if (message === 'Node is either not clickable or not an Element') {
            await node.evaluate((n) => n.click());
          } else {
            console.error(message);
          }
        }
      }
    }

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

  /**
   * Starts authentication on the given browser instance.
   * @param {Browser} browser
   * @param {Page} page
   */
  async startAuthentication(browser, page) {
    this.authInProgress = true;
    await authenticate(browser, page, new URL('/home/astra/Downloads/pptr.json', import.meta.url));
    this.authInProgress = false;
  }

  /**
   * Returns the SHA256 hash of the stripped DOM of the given page.
   * @param {Page} page
   * @return {string}
   */
  async getPageHash(page) {
    const rootStateDom = new JSDOM(await page.content());
    this.stripDOM(rootStateDom.window.document.documentElement);
    const rootStateHash = createHash('sha256').update(rootStateDom.serialize()).digest('hex');

    return rootStateHash;
  }

  /**
   * Starts the crawling process.
   */
  async startCrawling() {
    // console.log(this.banner);
    const browser = await Browser.getBrowserInstance();
    const allPages = await browser.pages();
    const page = allPages[0];
    const screen = await page.evaluate(() => {
      return {
        width: window.screen.availWidth,
        height: window.screen.availHeight,
      };
    });
    await page.setViewport({width: screen.width, height: screen.height});
    await page.setRequestInterception(true);

    // Statically response to out-of-scope requests.
    page.on('request', (interceptedRequest) => {
      if (interceptedRequest.isInterceptResolutionHandled()) return;

      if (
        this.authInProgress == false &&
        !this.inContext(interceptedRequest.url())
      ) {
        interceptedRequest.respond({
          status: 200,
          contentType: 'text/plain',
          body: 'Out of Sasori\'s scope',
        });
      } else interceptedRequest.continue();
    });

    await this.startAuthentication(browser, page);
    await page.goto('https://security-crawl-maze.app/', {waitUntil: 'domcontentloaded'});

    const rootState = new CrawlState(page.url(), await this.getPageHash(page), 0, null);
    rootState.crawlActions = await this.getCrawlActions(page, rootState);
    let parentState = rootState;

    const crawlManager = new CrawlStateManager(rootState);
    let nextCrawlAction = crawlManager.getNextCrawlAction(crawlManager.rootState, null);

    do {
      const currentAction = nextCrawlAction;
      // console.log(currentAction);
      console.log(`-----------------------------------------------------------`);
      await this.performAction(crawlManager, currentAction, page);
      const currentStateHash = await this.getPageHash(page);
      const existingState = crawlManager.getStateByHash(crawlManager.rootState, [crawlManager.rootState], currentStateHash);
      if (existingState) {
        console.log(`State exists: ${existingState.url}`);
        currentAction.childState = existingState;
      } else {
        if (this.inContext(page.url())) {
          const currentState = new CrawlState(page.url(), currentStateHash, parentState.crawlDepth + 1, null);
          console.log(`Adding new state: ${currentState.url}`);
          currentAction.childState = currentState;
          currentState.crawlActions = await this.getCrawlActions(page, currentState);
          parentState = currentState;
        }
      }
    } while ((nextCrawlAction = crawlManager.getNextCrawlAction(crawlManager.rootState, nextCrawlAction)));

    console.log(nextCrawlAction);
    console.log('Scan completed');
    await browser.close();
    crawlManager.traverse(crawlManager.rootState, [crawlManager.rootState]);
  }

  /**
   * Stop the crawling process.
   */
  stopCrawling() { }
}

export default Crawler;
