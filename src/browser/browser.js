const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

class Browser {

    /**
     * This static method reads the config file and initializes 
     * the browser options to be passed down to puppeteer.
     * @returns {Object}
     */
    static getBrowserConfig() {
        const configFilePath = path.resolve(__dirname, "../../config/config.json");
        const browserConfig = { headless: "new" };
        const args = [];
        let configJson = {};

        try {
            configJson = JSON.parse(fs.readFileSync(configFilePath, "utf-8"))["browser"];
        } catch (error) {
            console.error("Error reading/parsing JSON file:", error.message);
        }

        browserConfig.headless = configJson.headless ? "new" : false;
        if (configJson.maximize) {
            args.push("--start-maximized")
        }
        if (configJson.proxy && configJson.proxy.enabled) {
            args.push(`--proxy-server=${configJson.proxy.host}:${configJson.proxy.port}`)
        }
        browserConfig.args = args;

        return browserConfig;
    }

    /**
     * This static method initializes the browser to be used while crawling. 
     * @returns {puppeteer.Browser}
     */
    static async getBrowserInstance() {
        const browserConfig = this.getBrowserConfig();
        const browser = await puppeteer.launch(browserConfig)
        return browser;
    }
}

module.exports = Browser;