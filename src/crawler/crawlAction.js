import {randomUUID} from 'crypto';

/**
 * The CrawlAction class specifies the action to take on an element
 * in the DOM (it is an edge in the crawl graph).
 */
class CrawlAction {
  static {
    this.ANCHOR = 'a';
  }

  /**
   * CrawlAction object constructor
   * @param {string} element
   * @param {string} action
   * @param {string} cssPath
   * @param {CrawlState} parentState
   */
  constructor(element, action, cssPath, parentState) {
    this.actionId = randomUUID();
    this.element = element;
    this.action = action;
    this.cssPath = cssPath;
    this.parentState = parentState;
    this.childState = null;
  }

  /**
   * Returns the parentState associated with the CrawlAction.
   * @return {CrawlState}
   */
  getParentState() {
    return this.parentState;
  }

  /**
   * Returns the childState associated with the CrawlAction.
   * @return {CrawlState}
   */
  getChildState() {
    return this.childState;
  }
}

export default CrawlAction;
