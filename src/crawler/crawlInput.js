import path from 'path';

/**
 * The CrawlInput class specifies an input element in a CrawlState.
 */
class CrawlInput {
  static {
    this.INPUT_FIELDS = [
      {ELEMENT: 'input', TYPE: 'text', CSS_PATH: 'input[type="text"]'},
      {ELEMENT: 'input', TYPE: 'email', CSS_PATH: 'input[type="email"]'},
      {ELEMENT: 'input', TYPE: 'password', CSS_PATH: 'input[type="password"]'},
      {ELEMENT: 'input', TYPE: 'search', CSS_PATH: 'input[type="search"]'},
      {ELEMENT: 'input', TYPE: 'url', CSS_PATH: 'input[type="url"]'},
      {ELEMENT: 'input', TYPE: 'checkbox', CSS_PATH: 'input[type="checkbox"]'},
      {ELEMENT: 'input', TYPE: 'radio', CSS_PATH: 'input[type="radio"]'},
      {ELEMENT: 'input', TYPE: 'file', CSS_PATH: 'input[type="file"]'},
      // TODO:
      // Add <textarea> and <select> as well.
    ];

    this.VALUES = {
      'inputText': 'Sasori',
      'inputEmail': 'sasori@hiddensand.bot',
      'inputPassword': 'sas0riOfTheH!dd3nSand',
      'inputSearch': 'Sasori',
      'inputUrl': 'https://www.hiddensand.bot/',
    };

    this.SUPPORTED_FILE_TYPES = {
      'image/*': {TYPE: 'image', EXTENSION: '.png'},
      'image/avif': {TYPE: 'image', EXTENSION: '.avif'},
      'image/bmp': {TYPE: 'image', EXTENSION: '.bmp'},
      'image/gif': {TYPE: 'image', EXTENSION: '.gif'},
      'image/heic': {TYPE: 'image', EXTENSION: '.heic'},
      'image/ico': {TYPE: 'image', EXTENSION: '.ico'}, // This is erroneous and is not IANA-registered.
      'image/icon': {TYPE: 'image', EXTENSION: '.ico'}, // This is erroneous and is not IANA-registered.
      'image/jpeg': {TYPE: 'image', EXTENSION: '.jpeg'},
      'image/png': {TYPE: 'image', EXTENSION: '.png'},
      'image/tiff': {TYPE: 'image', EXTENSION: '.tiff'},
      'image/vnd.microsoft.icon': {TYPE: 'image', EXTENSION: '.ico'},
      'image/webp': {TYPE: 'image', EXTENSION: '.webp'},

      'video/*': {TYPE: 'image', EXTENSION: '.mp4'},
      'video/x-msvideo': {TYPE: 'image', EXTENSION: '.avi'},
      'video/x-flv': {TYPE: 'image', EXTENSION: '.flv'},
      'video/x-matroska': {TYPE: 'image', EXTENSION: '.mkv'},
      'video/quicktime': {TYPE: 'image', EXTENSION: '.mov'},
      'video/mp4': {TYPE: 'image', EXTENSION: '.mp4'},
      'video/webm': {TYPE: 'image', EXTENSION: '.webm'},
      'video/x-ms-wmv': {TYPE: 'image', EXTENSION: '.wmv'},

      '.avif': {TYPE: 'image', EXTENSION: '.avif'},
      '.bmp': {TYPE: 'image', EXTENSION: '.bmp'},
      '.gif': {TYPE: 'image', EXTENSION: '.gif'},
      '.heic': {TYPE: 'image', EXTENSION: '.heic'},
      '.ico': {TYPE: 'image', EXTENSION: '.ico'},
      '.jpeg': {TYPE: 'image', EXTENSION: '.jpeg'},
      '.jpg': {TYPE: 'image', EXTENSION: '.jpg'},
      '.png': {TYPE: 'image', EXTENSION: '.png'},
      '.tiff': {TYPE: 'image', EXTENSION: '.tiff'},
      '.webp': {TYPE: 'image', EXTENSION: '.webp'},

      '.avi': {TYPE: 'image', EXTENSION: '.avi'},
      '.flv': {TYPE: 'image', EXTENSION: '.flv'},
      '.mkv': {TYPE: 'image', EXTENSION: '.mkv'},
      '.mov': {TYPE: 'image', EXTENSION: '.mov'},
      '.mp4': {TYPE: 'image', EXTENSION: '.mp4'},
      '.webm': {TYPE: 'image', EXTENSION: '.webm'},
      '.wmv': {TYPE: 'image', EXTENSION: '.wmv'},
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
   * Checks the accept attribute of the <input> element with the goven CSS path and returns an appropriate file path.
   * @param {Page} page
   * @param {string} cssPath
   * @return {string}
   */
  async getFilePath(page, cssPath) {
    const acceptedFileTypes = await page.$eval(cssPath, (element) => element.getAttribute('accept'));
    const fileName = 'sasori';
    const defaultFile = path.join('resources', 'uploadFiles', 'image', `${fileName}.png`);

    if (acceptedFileTypes === null) {
      return defaultFile;
    }

    for (const acceptedFileType of acceptedFileTypes.split(',')) {
      if (Object.hasOwnProperty.call(CrawlInput.SUPPORTED_FILE_TYPES), acceptedFileType) {
        const fileType = CrawlInput.SUPPORTED_FILE_TYPES[acceptedFileType];
        return path.join('resources', 'uploadFiles', fileType.TYPE, `${fileName}${fileType.EXTENSION}`);
      }
    }

    return defaultFile;
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

      case 'search':
        await node.type(CrawlInput.VALUES['inputSearch']);
        break;

      case 'url':
        await node.type(CrawlInput.VALUES['inputUrl']);
        break;

      case 'checkbox':
        await node.click();
        break;

      case 'radio':
        await node.click();
        break;

      case 'file':
        const filePath = await this.getFilePath(page, this.cssPath);
        await node.uploadFile(filePath);
        break;

      default:
        break;
    }
  }
}

export default CrawlInput;
