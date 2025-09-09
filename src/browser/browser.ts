import { launch, Browser as PuppeteerBrowser, LaunchOptions } from 'puppeteer';
import { BrowserConfig } from '../types/browser';

/**
 * The Browser class is responsible for instantiating and
 * returning a properly configured browser.
 */
class Browser {
    /**
     * This static method reads the config file and initializes
     * the browser options to be passed down to puppeteer.
     * @param config - Browser configuration object
     * @return Puppeteer browser configuration
     */
    static getBrowserConfig(config: BrowserConfig): LaunchOptions {
        const browserConfig: LaunchOptions = { headless: true };
        const args: string[] = [];

        browserConfig.headless = config.headless;

        if (config.maximize) {
            args.push('--start-maximized');
        }

        if (config.proxy && config.proxy.enabled) {
            if (config.proxy.host && config.proxy.port) {
                args.push(
                    `--proxy-server=${config.proxy.host}:${config.proxy.port}`,
                );
                args.push('--ignore-certificate-errors');
            }
        }

        if (config.slowMo) {
            browserConfig.slowMo = config.slowMo;
        }

        browserConfig.args = args;

        return browserConfig;
    }

    /**
     * This static method initializes the browser to be used while crawling.
     * @param config - Browser configuration object
     * @return Promise that resolves to a Puppeteer browser instance
     */
    static async getBrowserInstance(config: BrowserConfig): Promise<PuppeteerBrowser> {
        const browserConfig = this.getBrowserConfig(config);
        const browser = await launch(browserConfig);
        return browser;
    }
}

export default Browser;
