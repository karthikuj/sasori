import { Browser as PuppeteerBrowser, LaunchOptions } from 'puppeteer';

/**
 * Trust custom CAs (e.g. Nara MITM) via NSS `certutil` in an isolated profile.
 */
export interface TlsConfig {
    /** Absolute or cwd-relative paths to PEM CA certificate files. */
    extraCaCerts?: string[];
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
    tls?: TlsConfig;
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
    getBrowserConfig(config: BrowserConfig): LaunchOptions;
    getBrowserInstance(config: BrowserConfig): Promise<PuppeteerBrowser>;
}

/**
 * Puppeteer browser configuration (alias for LaunchOptions)
 */
export type PuppeteerBrowserConfig = LaunchOptions;

/**
 * Browser instance management interface
 */
export interface BrowserManagerInterface {
    browsers: PuppeteerBrowser[];
    createBrowser(config: BrowserConfig): Promise<PuppeteerBrowser>;
    closeAllBrowsers(): Promise<void>;
    getAvailableBrowser(): PuppeteerBrowser | null;
}
