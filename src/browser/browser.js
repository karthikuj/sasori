import {launch} from 'puppeteer';
import {readFileSync} from 'fs';

/**
 * The Browser class is responsible for instantiating and
 * returning a properly configured browser.
 */
class Browser {
  /**
   * This static method reads the config file and initializes
   * the browser options to be passed down to puppeteer.
   * @param {string} configPath
   * @return {Object}
   */
  static getBrowserConfig(configPath) {
    const configFilePath = new URL(configPath, import.meta.url);
    const browserConfig = {headless: 'new'};
    const args = [];
    let configJson = {};

    try {
      configJson = JSON.parse(readFileSync(configFilePath, 'utf-8'))['browser'];
    } catch (error) {
      console.error('Error reading/parsing JSON file:', error.message);
    }

    browserConfig.headless = configJson.headless ? 'new' : false;
    if (configJson.maximize) {
      args.push('--start-maximized');
    }
    if (configJson.proxy && configJson.proxy.enabled) {
      args.push(
          `--proxy-server=${configJson.proxy.host}:${configJson.proxy.port}`,
      );
    }
    if (configJson.slowMo) {
      browserConfig.slowMo = configJson.slowMo;
    }
    browserConfig.args = args;

    return browserConfig;
  }

  /**
     * This static method initializes the browser to be used while crawling.
     * @param {string} configPath
     * @return {puppeteer.Browser}
     */
  static async getBrowserInstance(configPath) {
    const browserConfig = this.getBrowserConfig(configPath);
    const browser = await launch(browserConfig);
    return browser;
  }
}

export default Browser;
