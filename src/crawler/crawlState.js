import {randomUUID} from 'crypto';

/**
 * The CrawlState class specifies the state of the DOM after an action
 * on an element in the DOM (it is a vertice in the crawl graph).
 */
class CrawlState {
  /**
   *
   * @param {string} url
   * @param {string} dom
   * @param {int} crawlDepth
   * @param {CrawlAction[]} crawlActions
   */
  constructor(url, dom, crawlDepth, crawlActions) {
    this.stateId = randomUUID();
    this.url = url;
    this.dom = dom;
    this.crawlDepth = crawlDepth;
    this.crawlActions = crawlActions;
  }

  // TODO:
  //     1. Add equals method to compare CrawlStates.
  //     2. Add getStrippedDom method.
}

export default CrawlState;
