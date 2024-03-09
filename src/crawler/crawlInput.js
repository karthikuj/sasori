/**
 * The CrawlInput class specifies an input element in a CrawlState.
 */
class CrawlInput {
  /**
   * CrawlInput object constructor
   * @param {string} element
   * @param {string} cssPath
   */
  constructor(element, cssPath) {
    this.element = element;
    this.cssPath = cssPath;
  }
}

export default CrawlInput;
