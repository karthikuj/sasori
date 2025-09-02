import { Browser as PuppeteerBrowser } from 'puppeteer';

/**
 * Browser configuration interface
 */
export interface BrowserConfig {
    headless: boolean;
    maximize: boolean;
    proxy: ProxyConfig;
    instances: number;
    slowMo?: number;
}

/**
 * Proxy configuration interface
 */
export interface ProxyConfig {
    enabled: boolean;
    host?: string;
    port?: number;
}

/**
 * Browser class interface for Puppeteer browser management
 */
export interface BrowserInterface {
    getBrowserConfig(config: BrowserConfig): PuppeteerBrowserConfig;
    getBrowserInstance(config: BrowserConfig): Promise<PuppeteerBrowser>;
}

/**
 * Browser configuration interface
 */
export interface BrowserConfig {
    headless: boolean;
    maximize: boolean;
    proxy: ProxyConfig;
    instances: number;
    slowMo?: number;
}

/**
 * Proxy configuration interface
 */
export interface ProxyConfig {
    enabled: boolean;
    host?: string;
    port?: number;
}

/**
 * Puppeteer browser configuration
 */
export interface PuppeteerBrowserConfig {
    headless: boolean | 'new';
    args: string[];
    slowMo?: number;
}

/**
 * Browser instance management interface
 */
export interface BrowserManagerInterface {
    browsers: PuppeteerBrowser[];
    createBrowser(config: BrowserConfig): Promise<PuppeteerBrowser>;
    closeAllBrowsers(): Promise<void>;
    getAvailableBrowser(): PuppeteerBrowser | null;
}
