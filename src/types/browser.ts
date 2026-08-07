import { Browser as PuppeteerBrowser, LaunchOptions } from 'puppeteer';

/**
 * Trust custom CAs (e.g. Nara MITM) via NSS `certutil` in an isolated profile.
 */
export interface TlsConfig {
    /** Absolute or cwd-relative paths to PEM CA certificate files. */
    extraCaCerts?: string[];
    /**
     * Permit falling back to `--ignore-certificate-errors` when the CA cannot be
     * imported into the browser profile.
     *
     * Defaults to **false** (fail closed). When true the crawl browser accepts
     * *any* certificate, which silently disables TLS verification for all of the
     * crawler's own traffic — acceptable against a controlled local MITM, a real
     * risk on a shared or hostile network. Development only.
     */
    allowInsecureFallback?: boolean;
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
