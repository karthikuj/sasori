const {launch} = require('puppeteer');

/**
 * The Browser class is responsible for instantiating and
 * returning a properly configured browser.
 */
class Browser {
  /**
   * This static method reads the config file and initializes
   * the browser options to be passed down to puppeteer.
   * @param {Object} config
   * @return {Object}
   */
  static getBrowserConfig(config) {
    const browserConfig = {headless: 'new'};
    const args = [];
    let configJson = {};

    configJson = config;

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
     * @param {Object} config
     * @return {puppeteer.Browser}
     */
  static async getBrowserInstance(config) {
    const browserConfig = this.getBrowserConfig(config);
    const browser = await launch(browserConfig);
    return browser;
  }
}

module.exports = Browser;
