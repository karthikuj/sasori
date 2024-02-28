import {randomUUID} from 'crypto';

/**
 * The CrawlAction class specifies the action to take on an element
 * in the DOM (it is an edge in the crawl graph).
 */
class CrawlAction {
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
   * Returns the ChildState associated with the CrawlAction.
   * @return {CrawlState}
   */
  getChildState() {
    return this.childState;
  }
}

// TODO:
//      1. Check if it is interactable. If not don't add it or remove it.
//         Error:  Node is either not clickable or not an Element
//      2. Add getters and setters for properties.

export default CrawlAction;
