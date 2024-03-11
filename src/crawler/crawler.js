import {readFileSync, writeFileSync} from 'fs';
import Browser from '../browser/browser.js';
import CrawlAction from './crawlAction.js';
import CrawlInput from './crawlInput.js';
import CrawlState from './crawlState.js';
import CrawlStateManager from './crawlStateManager.js';
import DomPath from './domPath.js';
import {JSDOM} from 'jsdom';
import authenticate from '../auth/authenticator.js';
import chalk from 'chalk';
import {createHash} from 'crypto';

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
    this.banner = `
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
        if (!['A', 'SCRIPT', 'BASE'].includes(node.tagName) || (['A', 'BASE'].includes(node.tagName) && attr.name !== 'href') || (node.tagName === 'SCRIPT' && attr.name !== 'src')) {
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
   * Fetches all possible CrawlInputs on a CrawlState and returns them.
   * @param {Page} page
   * @return {CrawlInput[]}
   */
  async getCrawlInputs(page) {
    const domPath = new DomPath(page);
    const crawlInputs = [];
    for (const input of CrawlInput.INPUT_FIELDS) {
      const cssPath = input.CSS_PATH;
      const cssPaths = await domPath.getCssPaths(cssPath);
      crawlInputs.push(...cssPaths.map((cssPath) => {
        return new CrawlInput(input.ELEMENT, input.TYPE, cssPath);
      }));
    }

    return (crawlInputs.length !== 0) ? crawlInputs : [];
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
   * Fills out all CrawlInputs provided to it in the iterable.
   * @param {Page} page
   * @param {CrawlInput[]} crawlInputs
   */
  async fillAllInputs(page, crawlInputs) {
    for (const crawlInput of crawlInputs) {
      await crawlInput.inputFieldHandler(page);
    }
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
    if (crawlerAction.element != CrawlAction.ANCHOR) {
      await this.fillAllInputs(page, crawlerAction.parentState.crawlInputs);
    }
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
   * Creates and returns a new CrawlState using the page and crawl depth passed to it.
   * @param {Page} page
   * @param {int} crawlDepth
   * @return {CrawlState}
   */
  async getNewCrawlState(page, crawlDepth) {
    const crawlState = new CrawlState(page.url(), await this.getPageHash(page), crawlDepth, null);
    crawlState.crawlActions = await this.getCrawlActions(page, crawlState);
    crawlState.crawlInputs = await this.getCrawlInputs(page);
    return crawlState;
  }

  /**
   * Starts the crawling process.
   */
  async startCrawling() {
    console.log(chalk.greenBright.bold(this.banner));
    console.log(chalk.greenBright(`\n[INFO] Initializing browser...`));
    const browser = await Browser.getBrowserInstance();
    console.log(chalk.greenBright(`\n[INFO] Browser initialized successfully!`));
    console.log(chalk.greenBright(`\n[INFO] Sasori will now start crawling from ${this.crawlerConfig.entryPoint}`));

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
    if (this.crawlerConfig.maxDuration === 0) {
      console.log(chalk.greenBright(`\n[INFO] Max duration is set to 0, sasori will run indefinitely.`));
    } else {
      console.log(chalk.greenBright(`\n[INFO] Sasori will stop crawling at ${new Date(endTime).toTimeString()}`));
    }
    const allPages = await browser.pages();
    const page = allPages[0];
    await this.maximizeViewport(page);

    // Statically response to out-of-scope requests.
    console.log(chalk.greenBright(`\n[INFO] Setting up scope manager...`));
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
    console.log(chalk.greenBright(`\n[INFO] Scope manager started successfully!`));

    console.log(chalk.greenBright(`\n[INFO] Running initial authentication...`));
    // await this.startAuthentication(browser, page);
    await page.goto(this.crawlerConfig.entryPoint, {waitUntil: 'domcontentloaded'});

    const rootState = await this.getNewCrawlState(page, 0);
    let currentState = rootState;

    console.log(chalk.greenBright(`\n[INFO] Creating crawl state manager...`));
    const crawlManager = new CrawlStateManager(rootState);
    let nextCrawlAction = crawlManager.getNextCrawlAction();

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
          currentState = await this.getNewCrawlState(page, currentAction.getParentState().crawlDepth + 1);
          currentAction.childState = currentState;
        } else {
          currentAction.getParentState().crawlActions = currentAction.getParentState().crawlActions.filter((value)=>currentAction.actionId !== value.actionId);
        }
      }
    } while ((nextCrawlAction = crawlManager.getNextCrawlAction()) && Date.now() < endTime);

    writeFileSync('test.log', (()=>{
      let urlList = '';
      for (const url of this.allUrls) {
        urlList += (url + '\n');
      }
      return urlList;
    })());
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
