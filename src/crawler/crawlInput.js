/**
 * The CrawlInput class specifies an input element in a CrawlState.
 */
class CrawlInput {
  static {
    this.INPUTS = {
      TEXT: 'input[type="text"]',
      EMAIL: 'input[type="email"]',
      PASSWORD: 'input[type="password"]',
    };
  }

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
