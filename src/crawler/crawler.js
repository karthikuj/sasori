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
    this.allUrls = new Set();
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
    const crawlActions = [];
    for (const element of this.crawlerConfig.elements) {
      const cssPaths = await domPath.getCssPaths(element);
      crawlActions.push(...cssPaths.map((cssPath) => {
        return new CrawlAction(element, 'click', cssPath, currentState);
      }));
    }
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
      await page.goto(this.crawlerConfig.entryPoint, {waitUntil: 'domcontentloaded'});
      for (const crawlAction of shortestPath) {
        const node = await page.waitForSelector(crawlAction.cssPath);

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

    const node = await page.waitForSelector(crawlerAction.cssPath);
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
   * Maximizes viewport according to screensize.
   * @param {Page} page
   */
  async maximizeViewport(page) {
    const screen = await page.evaluate(() => {
      return {
        width: window.screen.availWidth,
        height: window.screen.availHeight,
      };
    });
    await page.setViewport({width: screen.width, height: screen.height});
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
    await this.maximizeViewport(page);
  }

  /**
   * Returns the SHA256 hash of the stripped DOM of the given page.
   * @param {Page} page
   * @return {string}
   */
  async getPageHash(page) {
    await page.waitForFunction(()=>document.readyState === 'complete', {timeout: this.crawlerConfig.eventTimeout});
    const pageDom = new JSDOM(await page.content());
    this.stripDOM(pageDom.window.document.documentElement);
    const pageHash = createHash('sha256').update(pageDom.serialize()).digest('hex');

    return pageHash;
  }

  /**
   * Starts the crawling process.
   */
  async startCrawling() {
    console.log(this.banner);
    console.log(`\nSasori will now start crawling from ${this.crawlerConfig.entryPoint}`);
    const browser = await Browser.getBrowserInstance();

    browser.on('targetcreated', async (target)=>{
      const targetBrowser = target.browser();
      const allTargetBrowserPages = await targetBrowser.pages();
      const targetPage = await target.page();
      if (targetPage && target.type() === 'page' && allTargetBrowserPages.length > 1) {
        await targetPage.close();
      }
    });

    const startTime = Date.now();
    const endTime = startTime + this.crawlerConfig.maxDuration;
    const allPages = await browser.pages();
    const page = allPages[0];
    await this.maximizeViewport(page);

    // Statically response to out-of-scope requests.
    await page.setRequestInterception(true);
    page.on('request', (interceptedRequest) => {
      if (interceptedRequest.isInterceptResolutionHandled()) return;

      if (this.inContext(interceptedRequest.url())) {
        this.allUrls.add(interceptedRequest.url());
      }

      if (this.authInProgress == false && !this.inContext(interceptedRequest.url())) {
        interceptedRequest.respond({
          status: 200,
          contentType: 'text/plain',
          body: 'Out of Sasori\'s scope',
        });
      } else interceptedRequest.continue();
    });

    await this.startAuthentication(browser, page);
    await page.goto(this.crawlerConfig.entryPoint, {waitUntil: 'domcontentloaded'});

    const rootState = new CrawlState(page.url(), await this.getPageHash(page), 0, null);
    rootState.crawlActions = await this.getCrawlActions(page, rootState);
    let currentState = rootState;

    const crawlManager = new CrawlStateManager(rootState);
    let nextCrawlAction = crawlManager.getNextCrawlAction(crawlManager.rootState);

    do {
      const currentAction = nextCrawlAction;
      await this.performAction(crawlManager, currentAction, page);
      const currentStateHash = await this.getPageHash(page);
      const existingState = crawlManager.getStateByHash(currentStateHash);
      if (existingState) {
        currentState = existingState;
        currentAction.getParentState().crawlActions = currentAction.getParentState().crawlActions.filter((value)=>currentAction.actionId !== value.actionId);
      } else {
        if (this.inContext(page.url())) {
          currentState = new CrawlState(page.url(), currentStateHash, currentAction.getParentState().crawlDepth + 1, null);
          currentState.crawlActions = await this.getCrawlActions(page, currentState);
          currentAction.childState = currentState;
        } else {
          currentAction.getParentState().crawlActions = currentAction.getParentState().crawlActions.filter((value)=>currentAction.actionId !== value.actionId);
        }
      }
    } while ((nextCrawlAction = crawlManager.getNextCrawlAction(crawlManager.rootState)) && Date.now() < endTime);

    console.log('\nAll crawlstates:');
    console.log(this.allUrls);
    // crawlManager.traverse(crawlManager.rootState, [crawlManager.rootState]);

    console.log('Scan completed');
    await browser.close();
  }

  /**
   * Stop the crawling process.
   */
  stopCrawling() { }
}

export default Crawler;
