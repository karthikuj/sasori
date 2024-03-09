import {randomUUID} from 'crypto';

/**
 * The CrawlState class specifies the state of the DOM after an action
 * on an element in the DOM (it is a vertice in the crawl graph).
 */
class CrawlState {
  /**
   * CrawlState object constructor.
   * @param {string} url
   * @param {string} stateHash
   * @param {int} crawlDepth
   * @param {CrawlInput[]} crawlInputs
   * @param {CrawlAction[]} crawlActions
   */
  constructor(url, stateHash, crawlDepth, crawlInputs, crawlActions) {
    this.stateId = randomUUID();
    this.url = url;
    this.stateHash = stateHash;
    this.crawlDepth = crawlDepth;
    this.crawlInputs = crawlInputs ? crawlInputs : [];
    this.crawlActions = crawlActions ? crawlActions : [];
  }

  /**
   * Returns the list of CrawlActions associated with the CrawlState.
   * @return {CrawlAction[]}
   */
  getCrawlActions() {
    return this.crawlActions;
  }
}

export default CrawlState;
