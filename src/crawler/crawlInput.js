/**
 * The CrawlInput class specifies an input element in a CrawlState.
 */
class CrawlInput {
  static {
    this.INPUTS = [
      {ELEMENT: 'input', TYPE: 'text', CSS_PATH: 'input[type="text"]'},
      {ELEMENT: 'input', TYPE: 'email', CSS_PATH: 'input[type="email"]'},
      {ELEMENT: 'input', TYPE: 'password', CSS_PATH: 'input[type="password"]'},
    ];
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
