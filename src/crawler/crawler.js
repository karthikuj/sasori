const Browser = require('../browser/browser.js');
const CrawlAction = require('./crawlAction.js');
const CrawlInput = require('./crawlInput.js');
const CrawlState = require('./crawlState.js');
const CrawlStateManager = require('./crawlStateManager.js');
const DomPath = require('./domPath.js');
const {appendFileSync} = require('fs');
const authenticate = require('../auth/authenticator.js');
const chalk = require('chalk');
const cheerio = require('cheerio');
const {createHash} = require('crypto');
const path = require('path');

/**
 * The Crawler class is responsible for creating and managing the crawler.
 */
class Crawler {
  static {
    this.TEXT_NODE = 3;
    this.COMMENT_NODE = 8;
    this.ELEMENT_NODE = 1;
  }

  /**
   * Crawler class contructor.
   * @param {Object} config
   */
  constructor(config) {
    this.config = config;
    this.crawlerConfig = config.crawler;
    this.authInProgress = false;
    this.allUrls = new Set();
    this.allInteractables = [...this.crawlerConfig.elements].concat(CrawlInput.INPUT_FIELDS.map((element) => element.CSS_PATH));
  }

  /**
   * Strips DOM by removing useless attributes, comments and all text.
   * @param {CheerioAPI} $
   */
  stripDOM($) {
    // Remove text nodes
    $('*').contents().filter((_, node) => node.nodeType === Crawler.TEXT_NODE).remove();

    // Remove comment nodes
    $('*').contents().filter((_, node) => node.nodeType === Crawler.COMMENT_NODE).remove();

    // Remove attributes except href for <a> and <base>, and src for <script>
    $('*').each((_, element) => {
      const tagName = element.name && element.name.toUpperCase();
      const allowedAttributes = [];
      switch (tagName) {
        case 'A':
        case 'BASE':
          allowedAttributes.push('href');
          break;
        case 'SCRIPT':
          allowedAttributes.push('src');
          break;
      }
      Object.keys(element.attribs).forEach((attrName) => {
        if (!allowedAttributes.includes(attrName)) {
          $(element).removeAttr(attrName);
        }
      });
    });

    // Remove nodes if none of the CSS paths are found
    $('*').each((_, element) => {
      const found = this.allInteractables.some((cssPath) => ($(element).is(cssPath) || $(element).find(cssPath).length > 0));
      if (!found) {
        $(element).remove();
      }
    });

    // Change src attribute value for <script> tags
    $('script[src]').each((_, element) => {
      const srcValue = $(element).attr('src');
      $(element).attr('src', srcValue.split('?')[0]);
    });
  }

  /**
   * Fetches all possible CrawlInputs on a CrawlState and returns them.
   * @param {Page} page
   * @param {CrawlState} currentState
   * @return {CrawlInput[]}
   */
  async getCrawlInputs(page, currentState) {
    const domPath = new DomPath(page);
    const crawlInputs = [];
    for (const input of CrawlInput.INPUT_FIELDS) {
      const cssPath = input.CSS_PATH;
      const cssPaths = await domPath.getCssPaths(cssPath);
      crawlInputs.push(...cssPaths.map((cssPath) => {
        return new CrawlInput(input.ELEMENT, input.TYPE, cssPath, currentState);
      }));
    }

    return (crawlInputs.length !== 0) ? crawlInputs : [];
  }

  /**
   * Fetches all possible CrawlActions on a CrawlState and returns them.
   * @param {Page} page
   * @param {CrawlState} currentState
   * @param {CrawlStateManager} crawlManager
   * @return {CrawlAction[]}
   */
  async getCrawlActions(page, currentState, crawlManager) {
    const domPath = new DomPath(page);
    const crawlActions = [];

    // If max crawl depth has been reached then no need to fetch more actions for the given state.
    if (this.crawlerConfig.maxDepth && currentState.getCrawlDepth() >= this.crawlerConfig.maxDepth) {
      return crawlActions;
    }

    for (const element of this.crawlerConfig.elements) {
      const cssPaths = await domPath.getCssPaths(element);
      for (const cssPath of cssPaths) {
        const node = await page.$eval(cssPath, (el) => el.outerHTML);
        const actionHash = createHash('sha256').update(node).digest('hex');
        if (crawlManager.isCrawlActionUnique(cssPath, actionHash)) {
          crawlActions.push(new CrawlAction(element, 'click', cssPath, actionHash, currentState));
        } else {
        }
      }
    }

    return (crawlActions.length !== 0) ? (this.crawlerConfig.maxChildren ? crawlActions.slice(0, this.crawlerConfig.maxChildren).reverse() : crawlActions.reverse()) : [];
  }

  /**
   * Fills out all CrawlInputs provided to it in the iterable.
   * @param {Page} page
   * @param {CrawlInput[]} crawlInputs
   */
  async fillAllInputs(page, crawlInputs) {
    for (const crawlInput of crawlInputs) {
      try {
        await crawlInput.inputFieldHandler(page);
      } catch (error) {
        console.error(chalk.red(`[ERROR] Could not fill input field: ${crawlInput.cssPath}`));
        this.removeCrawlInputFromState(crawlInput);
      }
    }
  }

  /**
   * Performs the given crawlaction on page.
   * @param {CrawlStateManager} crawlManager
   * @param {CrawlAction} crawlerAction
   * @param {Page} page
   */
  async performAction(crawlManager, crawlerAction, page) {
    let node;
    const currentStateHash = await this.getPageHash(page);
    if (currentStateHash !== crawlerAction.parentState.stateHash) {
      const shortestPath = crawlManager.getShortestPath(crawlerAction.parentState);
      // console.log('Shortest path:');
      // console.log(shortestPath.map((action) => action.cssPath));
      await page.goto(this.crawlerConfig.entryPoint, {waitUntil: 'domcontentloaded'});
      for (const crawlAction of shortestPath) {
        if (crawlAction.element != CrawlAction.ANCHOR) {
          // console.log('All crawlinputs:');
          // console.log(crawlAction.parentState.crawlInputs);
          await this.fillAllInputs(page, crawlAction.parentState.crawlInputs);
        }
        try {
          node = await page.waitForSelector(crawlAction.cssPath);
        } catch (error) {
          this.removeCrawlActionFromState(crawlAction);
          return;
        }
        try {
          await node.click();
        } catch ({name, message}) {
          if (message === 'Node is either not clickable or not an Element') {
            try {
              await node.evaluate((n) => n.click());
            } catch (error) {
              console.error(chalk.red(`\n[ERROR] ${error.message}`));
              this.removeCrawlActionFromState(crawlAction);
              return;
            }
          } else {
            console.error(chalk.red(`\n[ERROR] ${message}`));
            this.removeCrawlActionFromState(crawlAction);
            return;
          }
        }
      }
    }

    if (crawlerAction.element != CrawlAction.ANCHOR) {
      await this.fillAllInputs(page, crawlerAction.parentState.crawlInputs);
    }
    try {
      node = await page.waitForSelector(crawlerAction.cssPath);
    } catch (error) {
      this.removeCrawlActionFromState(crawlerAction);
      return;
    }
    try {
      await node.click();
    } catch ({name, message}) {
      if (message === 'Node is either not clickable or not an Element') {
        try {
          await node.evaluate((n) => n.click());
        } catch (error) {
          console.error(chalk.red(`\n[ERROR] ${error.message}`));
        }
      } else {
        console.error(chalk.red(`\n[ERROR] ${message}`));
      }
    }

    await page.waitForTimeout(this.crawlerConfig.eventWait);
    if (!this.allUrls.has(page.url())) {
      console.log(chalk.magenta(`[URL] `) + chalk.green(page.url()));
      this.allUrls.add(page.url());
      if (this.crawlerConfig.outputFile) {
        this.appendUrlToOutputFile(page.url());
      }
    }
  }

  /**
   * Checks if the given URL is in context or not.
   * @param {string} url
   * @return {boolean}
   */
  inContext(url) {
    // Check if it is excluded
    for (const regex of this.crawlerConfig.excludeRegexes) {
      const excludeRegex = new RegExp(regex);
      if (url.match(excludeRegex)) {
        return false;
      }
    }

    // Check if it is included
    for (const regex of this.crawlerConfig.includeRegexes) {
      const includeRegex = new RegExp(regex);
      if (url.match(includeRegex)) {
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
    await authenticate(browser, page, path.resolve(__dirname, this.crawlerConfig.authentication.scriptAuth.pptrRecording));
    this.authInProgress = false;
    await this.maximizeViewport(page);
  }

  /**
   * Returns the SHA256 hash of the stripped DOM of the given page.
   * @param {Page} page
   * @return {string}
   */
  async getPageHash(page) {
    await page.waitForFunction(()=>document.readyState === 'complete', {timeout: this.crawlerConfig.navigationTimeout});
    let $;
    try {
      $ = cheerio.load(await page.content(), {xmlMode: true});
    } catch ({name, message}) {
      if (message === 'Execution context was destroyed, most likely because of a navigation.') {
        await page.waitForNavigation({waitUntil: ['domcontentloaded', 'networkidle0']});
        $ = cheerio.load(await page.content(), {xmlMode: true});
      } else {
        console.error(chalk.red(`\n[ERROR] ${message}`));
      }
    }
    this.stripDOM($);
    const pageHash = createHash('sha256').update($.html()).digest('hex');

    return pageHash;
  }

  /**
   * Creates and returns a new CrawlState using the page and crawl depth passed to it.
   * @param {Page} page
   * @param {int} crawlDepth
   * @param {string} stateHash
   * @param {CrawlStateManager} crawlManager
   * @return {CrawlState}
   */
  async getNewCrawlState(page, crawlDepth, stateHash, crawlManager) {
    // console.log(`Crawl state creator called for page: ${page.url()}`);
    const crawlState = new CrawlState(page.url(), stateHash, crawlDepth);
    crawlState.crawlActions = await this.getCrawlActions(page, crawlState, crawlManager);
    // console.log('Crawl actions found:');
    // console.log(crawlState.crawlActions.map((action) => action.cssPath));
    crawlState.crawlInputs = await this.getCrawlInputs(page, crawlState);
    // console.log(`Crawl inputs found:`);
    // console.log(crawlState.crawlInputs.map((input) => input.cssPath));
    return crawlState;
  }

  /**
   * Removes the given CrawlAction from the parent CrawlState.
   * @param {CrawlAction} crawlAction
   */
  removeCrawlActionFromState(crawlAction) {
    crawlAction.getParentState().crawlActions = crawlAction.getParentState().crawlActions.filter((value)=>crawlAction.actionId !== value.actionId);
  }

  /**
   * Removes the given CrawlInput from the parent CrawlState.
   * @param {CrawlInput} crawlInput
   */
  removeCrawlInputFromState(crawlInput) {
    crawlInput.getParentState().crawlInputs = crawlInput.getParentState().crawlInputs.filter((value)=>crawlInput.inputId !== value.inputId);
  }

  /**
   * Append the given URL to the output file.
   * @param {string} url
   */
  appendUrlToOutputFile(url) {
    const fullPath = path.resolve(this.crawlerConfig.outputFile);
    appendFileSync(fullPath, url + '\n');
  }

  /**
   * Starts the crawling process.
   */
  async startCrawling() {
    console.log(chalk.greenBright(`[INFO] Initializing browser...`));
    const browser = await Browser.getBrowserInstance(this.config.browser);
    console.log(chalk.greenBright(`[INFO] Browser initialized successfully!`));
    console.log(chalk.greenBright(`[INFO] Sasori will now start crawling from ${this.crawlerConfig.entryPoint}`));

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
      console.log(chalk.greenBright(`[INFO] Max duration is set to 0, sasori will run indefinitely.`));
    } else {
      console.log(chalk.greenBright(`[INFO] Sasori will stop crawling at ${new Date(endTime).toTimeString()}`));
    }
    const allPages = await browser.pages();
    const page = allPages[0];
    page.setDefaultTimeout(this.crawlerConfig.eventTimeout);
    page.setDefaultNavigationTimeout(this.crawlerConfig.navigationTimeout);
    await this.maximizeViewport(page);

    // Authenticate if basic auth is enabled
    if (this.crawlerConfig.authentication.basicAuth && this.crawlerConfig.authentication.basicAuth.enabled) {
      await page.authenticate({username: this.crawlerConfig.authentication.basicAuth.username, password: this.crawlerConfig.authentication.basicAuth.password});
    }

    // Statically response to out-of-scope requests.
    console.log(chalk.greenBright(`[INFO] Setting up scope manager...`));
    await page.setRequestInterception(true);
    page.on('request', async (interceptedRequest) => {
      if (interceptedRequest.isInterceptResolutionHandled()) return;

      if (this.inContext(interceptedRequest.url())) {
        if (!this.allUrls.has(interceptedRequest.url())) {
          console.log(chalk.magentaBright(`[URL] `) + chalk.green(interceptedRequest.url()));
          this.allUrls.add(interceptedRequest.url());
          if (this.crawlerConfig.outputFile) {
            this.appendUrlToOutputFile(interceptedRequest.url());
          }
        }
      }

      if (this.authInProgress) {
        const parsedUrl = new URL(interceptedRequest.url());
        const authority = parsedUrl.host;
        const includeRegex = `https?://${authority}(?:/.*|)`;
        if (!this.crawlerConfig.includeRegexes.includes(includeRegex)) {
          this.crawlerConfig.includeRegexes.push(includeRegex);
        }
      }

      if ((this.authInProgress == false && !this.inContext(interceptedRequest.url()))) {
        interceptedRequest.respond({
          status: 403,
          contentType: 'text/plain',
          body: 'Out of Sasori\'s scope',
        });
      } else interceptedRequest.continue();
    });

    // Dismiss all alerts/popups
    page.on('dialog', async (dialog) => {
      await dialog.dismiss();
    });

    console.log(chalk.greenBright(`[INFO] Scope manager started successfully!`));

    // Start authentication if enabled.
    if (this.crawlerConfig.authentication.scriptAuth && this.crawlerConfig.authentication.scriptAuth.enabled) {
      console.log(chalk.greenBright(`[INFO] Running initial authentication...`));
      await this.startAuthentication(browser, page);
    }

    console.log(chalk.greenBright(`[INFO] Creating crawl state manager...`));
    const crawlManager = new CrawlStateManager();

    await page.goto(this.crawlerConfig.entryPoint, {waitUntil: ['domcontentloaded', 'networkidle0']});
    const rootStateHash = await this.getPageHash(page);
    const rootState = await this.getNewCrawlState(page, 0, rootStateHash, crawlManager);
    crawlManager.rootState = rootState;
    let currentState = rootState;

    let nextCrawlAction = crawlManager.getNextCrawlAction();

    while ((nextCrawlAction = crawlManager.getNextCrawlAction()) && (this.crawlerConfig.maxDuration === 0 || Date.now() < endTime)) {
      const currentAction = nextCrawlAction;
      // console.log('\nCurrent Action:');
      // console.log(currentAction.cssPath);
      await this.performAction(crawlManager, currentAction, page);
      // console.log('Action performed');
      const currentStateHash = await this.getPageHash(page);
      // console.log('Current state hash:');
      // console.log(currentStateHash);
      const existingState = crawlManager.getStateByHash(currentStateHash);
      if (existingState) {
        // console.log('State already exists');
        currentState = existingState;
        this.removeCrawlActionFromState(currentAction);
      } else {
        if (this.inContext(page.url())) {
          // console.log('State does not exist, creating...');
          currentState = await this.getNewCrawlState(page, currentAction.getParentState().crawlDepth + 1, currentStateHash, crawlManager);
          currentAction.childState = currentState;
        } else {
          this.removeCrawlActionFromState(currentAction);
        }
      }
    }

    console.log(chalk.greenBright.bold('Scan completed'));
    await browser.close();
  }

  /**
   * Stop the crawling process.
   */
  stopCrawling() { }
}

module.exports = Crawler;
