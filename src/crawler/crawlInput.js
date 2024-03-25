const chalk = require('chalk');
const path = require('path');

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
      {ELEMENT: 'textarea', TYPE: null, CSS_PATH: 'textarea'},
      {ELEMENT: 'select', TYPE: null, CSS_PATH: 'select'},
    ];

    this.VALUES = {
      'inputText': 'Sasori',
      'inputEmail': 'sasori@hiddensand.bot',
      'inputPassword': 'sas0riOfTheH!dd3nSand',
      'inputSearch': 'Sasori',
      'inputUrl': 'https://www.hiddensand.bot/',
    };

    this.SUPPORTED_FILE_TYPES = {
      // Images by mime type.
      'image/*': {TYPE: 'image', EXTENSION: '.png'},
      'image/avif': {TYPE: 'image', EXTENSION: '.avif'},
      'image/bmp': {TYPE: 'image', EXTENSION: '.bmp'},
      'image/gif': {TYPE: 'image', EXTENSION: '.gif'},
      'image/heic': {TYPE: 'image', EXTENSION: '.heic'},
      'image/ico': {TYPE: 'image', EXTENSION: '.ico'}, // This is erroneous and is not IANA-registered.
      'image/icon': {TYPE: 'image', EXTENSION: '.ico'}, // This is erroneous and is not IANA-registered.
      'image/jpeg': {TYPE: 'image', EXTENSION: '.jpeg'},
      'image/png': {TYPE: 'image', EXTENSION: '.png'},
      'image/svg+xml': {TYPE: 'image', EXTENSION: '.svg'},
      'image/tiff': {TYPE: 'image', EXTENSION: '.tiff'},
      'image/vnd.microsoft.icon': {TYPE: 'image', EXTENSION: '.ico'},
      'image/webp': {TYPE: 'image', EXTENSION: '.webp'},

      // Videos by mime type.
      'video/*': {TYPE: 'video', EXTENSION: '.mp4'},
      'video/x-msvideo': {TYPE: 'video', EXTENSION: '.avi'},
      'video/x-flv': {TYPE: 'video', EXTENSION: '.flv'},
      'video/x-matroska': {TYPE: 'video', EXTENSION: '.mkv'},
      'video/quicktime': {TYPE: 'video', EXTENSION: '.mov'},
      'video/mp4': {TYPE: 'video', EXTENSION: '.mp4'},
      'video/webm': {TYPE: 'video', EXTENSION: '.webm'},
      'video/x-ms-wmv': {TYPE: 'video', EXTENSION: '.wmv'},

      // Audios by mime type.
      'audio/*': {TYPE: 'audio', EXTENSION: '.mp3'},
      'audio/aac': {TYPE: 'audio', EXTENSION: '.aac'},
      'audio/amr': {TYPE: 'audio', EXTENSION: '.amr'},
      'audio/flac': {TYPE: 'audio', EXTENSION: '.flac'},
      'audio/mp3': {TYPE: 'audio', EXTENSION: '.mp3'},
      'audio/ogg': {TYPE: 'audio', EXTENSION: '.ogg'},

      // Applications by mime type.
      'application/*': {TYPE: 'application', EXTENSION: '.pdf'},
      'application/gzip': {TYPE: 'application', EXTENSION: '.gz'},
      'application/pdf': {TYPE: 'application', EXTENSION: '.pdf'},
      'application/xml': {TYPE: 'application', EXTENSION: '.xml'},
      'application/yaml': {TYPE: 'application', EXTENSION: '.yaml'},
      'application/zip': {TYPE: 'application', EXTENSION: '.zip'},

      // Texts by mime type.
      'text/*': {TYPE: 'text', EXTENSION: '.txt'},
      'text/css': {TYPE: 'text', EXTENSION: '.css'},
      'text/csv': {TYPE: 'text', EXTENSION: '.csv'},
      'text/html': {TYPE: 'text', EXTENSION: '.html'},
      'text/javascript': {TYPE: 'text', EXTENSION: '.js'},
      'text/plain': {TYPE: 'text', EXTENSION: '.txt'},

      // Images by extension.
      '.avif': {TYPE: 'image', EXTENSION: '.avif'},
      '.bmp': {TYPE: 'image', EXTENSION: '.bmp'},
      '.gif': {TYPE: 'image', EXTENSION: '.gif'},
      '.heic': {TYPE: 'image', EXTENSION: '.heic'},
      '.ico': {TYPE: 'image', EXTENSION: '.ico'},
      '.jpeg': {TYPE: 'image', EXTENSION: '.jpeg'},
      '.jpg': {TYPE: 'image', EXTENSION: '.jpg'},
      '.png': {TYPE: 'image', EXTENSION: '.png'},
      '.svg': {TYPE: 'image', EXTENSION: '.svg'},
      '.tiff': {TYPE: 'image', EXTENSION: '.tiff'},
      '.webp': {TYPE: 'image', EXTENSION: '.webp'},

      // Videos by extension.
      '.avi': {TYPE: 'video', EXTENSION: '.avi'},
      '.flv': {TYPE: 'video', EXTENSION: '.flv'},
      '.mkv': {TYPE: 'video', EXTENSION: '.mkv'},
      '.mov': {TYPE: 'video', EXTENSION: '.mov'},
      '.mp4': {TYPE: 'video', EXTENSION: '.mp4'},
      '.webm': {TYPE: 'video', EXTENSION: '.webm'},
      '.wmv': {TYPE: 'video', EXTENSION: '.wmv'},

      // Audios by extension.
      '.aac': {TYPE: 'audio', EXTENSION: '.aac'},
      '.amr': {TYPE: 'audio', EXTENSION: '.amr'},
      '.flac': {TYPE: 'audio', EXTENSION: '.flac'},
      '.mp3': {TYPE: 'audio', EXTENSION: '.mp3'},
      '.ogg': {TYPE: 'audio', EXTENSION: '.ogg'},

      // Applications by extension
      '.gz': {TYPE: 'application', EXTENSION: '.gz'},
      '.pdf': {TYPE: 'application', EXTENSION: '.pdf'},
      '.xml': {TYPE: 'application', EXTENSION: '.xml'},
      '.yaml': {TYPE: 'application', EXTENSION: '.yaml'},
      '.zip': {TYPE: 'application', EXTENSION: '.zip'},

      // Text by extension.
      '.css': {TYPE: 'text', EXTENSION: '.css'},
      '.csv': {TYPE: 'text', EXTENSION: '.csv'},
      '.html': {TYPE: 'text', EXTENSION: '.html'},
      '.js': {TYPE: 'text', EXTENSION: '.js'},
      '.txt': {TYPE: 'text', EXTENSION: '.txt'},
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

      case 'textarea':
        await this.textareaHandler(page);
        break;

      case 'select':
        await this.selectHandler(page);
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
    let node;
    try {
      node = await page.waitForSelector(this.cssPath);
    } catch ({name, message}) {
      console.error(chalk.red(`[ERROR] Could not find a node with the selector: ${this.cssPath}`));
      console.error(chalk.red(`[ERROR] ${message}`));
    }
    switch (this.type) {
      case 'text':
        try {
          await node.type(CrawlInput.VALUES['inputText']);
        } catch ({name, message}) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      case 'email':
        try {
          await node.type(CrawlInput.VALUES['inputEmail']);
        } catch ({name, message}) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      case 'password':
        try {
          await node.type(CrawlInput.VALUES['inputPassword']);
        } catch ({name, message}) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      case 'search':
        try {
          await node.type(CrawlInput.VALUES['inputSearch']);
        } catch ({name, message}) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      case 'url':
        try {
          await node.type(CrawlInput.VALUES['inputUrl']);
        } catch ({name, message}) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      case 'checkbox':
        try {
          await node.click();
        } catch ({name, message}) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      case 'radio':
        try {
          await node.click();
        } catch ({name, message}) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      case 'file':
        const filePath = await this.getFilePath(page, this.cssPath);
        try {
          await node.uploadFile(filePath);
        } catch (error) {
          console.error(chalk.red(`\n[ERROR] ${message}`));
        }
        break;

      default:
        break;
    }
  }

  /**
   * Handles all textarea elements on the given page
   * @param {Page} page
   */
  async textareaHandler(page) {
    let node;
    try {
      node = await page.waitForSelector(this.cssPath);
    } catch ({name, message}) {
      console.error(chalk.red(`[ERROR] Could not find a node with the selector: ${this.cssPath}`));
      console.error(chalk.red(`[ERROR] ${message}`));
    }

    try {
      await node.type(CrawlInput.VALUES['inputText']);
    } catch ({name, message}) {
      console.error(chalk.red(`\n[ERROR] ${message}`));
    }
  }

  /**
   * Handles all select elements on the given page
   * @param {Page} page
   */
  async selectHandler(page) {
    let node;
    try {
      node = await page.waitForSelector(this.cssPath);
    } catch ({name, message}) {
      console.error(chalk.red(`[ERROR] Could not find a node with the selector: ${this.cssPath}`));
      console.error(chalk.red(`[ERROR] ${message}`));
    }

    const firstNonEmptyValue = await node.$$eval('option', (nodes) => {
      for (const optionNode of nodes) {
        if (optionNode.value !== null && optionNode.value !== '') {
          return optionNode.value;
        }
      }
    });
    try {
      await page.select(this.cssPath, firstNonEmptyValue);
    } catch ({name, message}) {
      console.error(chalk.red(`\n[ERROR] ${message}`));
    }
  }
}

module.exports = CrawlInput;
