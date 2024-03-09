/**
 * The CrawlInput class specifies an input element in a CrawlState.
 */
class CrawlInput {
  static {
    this.INPUT_FIELDS = [
      {ELEMENT: 'input', TYPE: 'text', CSS_PATH: 'input[type="text"]'},
      {ELEMENT: 'input', TYPE: 'email', CSS_PATH: 'input[type="email"]'},
      {ELEMENT: 'input', TYPE: 'password', CSS_PATH: 'input[type="password"]'},
    ];

    this.VALUES = {
      'inputText': 'Sasori',
      'inputEmail': 'sasori@hiddensand.bot',
      'inputPassword': 'sas0riOfTheH!dd3nSand',
    };
  }

  /**
   * CrawlInput object constructor
   * @param {string} element
   * @param {string} type
   * @param {string} cssPath
   */
  constructor(element, type, cssPath) {
    this.element = element;
    this.type = type;
    this.cssPath = cssPath;
  }

  /**
   * Handles all input fields on the given page
   * @param {Page} page
   */
  async inputFieldHandler(page) {
    switch (this.element) {
      case 'input':
        await this.inputHandler(page);
        break;

      default:
        break;
    }
  }

  /**
   * Handles all input elements on the given page
   * @param {Page} page
   */
  async inputHandler(page) {
    const node = await page.waitForSelector(this.cssPath);
    switch (this.type) {
      case 'text':
        await node.type(CrawlInput.VALUES['inputText']);
        break;

      case 'email':
        await node.type(CrawlInput.VALUES['inputEmail']);
        break;

      case 'password':
        await node.type(CrawlInput.VALUES['inputPassword']);
        break;

      default:
        break;
    }
  }
}

export default CrawlInput;
