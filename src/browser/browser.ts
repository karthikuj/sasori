import { launch, Browser as PuppeteerBrowser, LaunchOptions } from 'puppeteer';
import { BrowserConfig } from '../types/browser';
import { prepareTlsUserDataDir, removeUserDataDir } from './tlsProfile';

export interface BrowserLaunchExtras {
    /** Isolated profile dir with NSS CA imports (from {@link prepareTlsUserDataDir}). */
    userDataDir?: string;
    /** When true, {@link getBrowserConfig} skips `--ignore-certificate-errors` for proxied HTTPS. */
    tlsCaImported?: boolean;
}

/** A launched browser and the profile directory Sasori made for it, if any. */
export interface LaunchedBrowser {
    browser: PuppeteerBrowser;
    /**
     * Profile directory Sasori created (only for `browser.tls.extraCaCerts`).
     * The caller deletes it once the browser has closed. Null when Puppeteer
     * manages the profile itself, which it deletes on close.
     */
    userDataDir: string | null;
}

/**
 * Flags that stop Chrome slowing down windows that are not in front.
 *
 * Crawl workers are windows of one browser (SCAN-236), and only one window can
 * be in front. Without these, a covered window's timers and rendering are
 * throttled, and a worker in it would crawl slower than the one on top.
 */
export const NO_BACKGROUND_THROTTLING_ARGS: readonly string[] = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
];

/**
 * Flags that make Chrome load an `http://` URL as `http://`.
 *
 * Since Chrome 157 (Puppeteer 25), Chrome tries `https://` first for every
 * `http://` navigation (`HttpsUpgrades`), and when that fails it blocks the
 * page with `net::ERR_BLOCKED_BY_CLIENT` instead of falling back
 * (`HttpsFirstBalancedMode`). Sasori could not crawl any plain-HTTP site off
 * localhost: even `http://neverssl.com` failed, as did a site whose HTTPS
 * certificate had expired. With only the blocking turned off, Chrome still
 * sends an `https://` request to the target before every `http://` one, and
 * those are requests nobody asked the crawler to make; they would reach the
 * proxy and the inventory. Turning off both makes Chrome request exactly the
 * URL it is given. HTTPS sites are unaffected.
 */
export const NO_HTTPS_UPGRADE_ARGS: readonly string[] = [
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedMode',
];

/** Flags every crawl browser is launched with. */
export const BASE_LAUNCH_ARGS: readonly string[] = [...NO_BACKGROUND_THROTTLING_ARGS, ...NO_HTTPS_UPGRADE_ARGS];

/**
 * The Browser class is responsible for instantiating and
 * returning a properly configured browser.
 */
class Browser {
    /**
     * This static method reads the config file and initializes
     * the browser options to be passed down to puppeteer.
     * @param config - Browser configuration object
     * @param extras - Optional user data dir and TLS flags (see {@link BrowserLaunchExtras})
     * @return Puppeteer browser configuration
     */
    static getBrowserConfig(config: BrowserConfig, extras?: BrowserLaunchExtras): LaunchOptions {
        const browserConfig: LaunchOptions = { headless: true };
        const args: string[] = [...BASE_LAUNCH_ARGS];

        browserConfig.headless = config.headless;

        if (config.maximize) {
            args.push('--start-maximized');
        }

        if (config.proxy && config.proxy.enabled) {
            if (config.proxy.host && config.proxy.port) {
                args.push(`--proxy-server=${config.proxy.host}:${config.proxy.port}`);
                // Chrome bypasses the proxy for loopback addresses by default,
                // so `--proxy-server` alone silently does nothing for a target
                // on localhost or 127.0.0.1. That is not an edge case: it is
                // every locally-hosted application anyone points the scanner
                // at, and the symptom is a clean crawl that produces no
                // findings, because Nara's proxy never saw a single request.
                // "<-loopback>" removes loopback from the bypass list.
                args.push('--proxy-bypass-list=<-loopback>');
                if (!extras?.tlsCaImported) {
                    // Reached only when getBrowserInstance has already established
                    // that insecure fallback is permitted (or when no CA was
                    // configured at all). It is a genuine security downgrade —
                    // every certificate the crawler sees is accepted — so it is
                    // logged as a warning rather than an informational line.
                    console.warn(
                        '[sasori] TLS verification DISABLED for the crawl browser ' +
                            '(--ignore-certificate-errors). Development use only.',
                    );
                    args.push('--ignore-certificate-errors');
                }
            }
        }

        if (config.slowMo) {
            browserConfig.slowMo = config.slowMo;
        }

        if (extras?.userDataDir) {
            browserConfig.userDataDir = extras.userDataDir;
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
        return (await this.launchBrowser(config)).browser;
    }

    /**
     * Launches a browser and reports the profile directory made for it, so the
     * caller can delete it after closing the browser.
     * @param config - Browser configuration object
     * @return The browser and its Sasori-made profile directory, if any
     */
    static async launchBrowser(config: BrowserConfig): Promise<LaunchedBrowser> {
        let extras: BrowserLaunchExtras | undefined;
        const caPaths = config.tls?.extraCaCerts?.filter((p) => p && p.trim().length > 0);

        if (config.proxy?.enabled && caPaths?.length) {
            try {
                const userDataDir = prepareTlsUserDataDir(caPaths);
                extras = { userDataDir, tlsCaImported: true };
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);

                // Fail closed. A CA that cannot be imported used to downgrade the
                // browser to trusting *every* certificate, which is a silent loss
                // of TLS verification for all of the crawler's traffic — fine
                // against a local MITM, dangerous on a shared or hostile network.
                // Since a CA was explicitly configured, the operator intends
                // verified TLS; quietly abandoning that is the wrong default.
                if (!config.tls?.allowInsecureFallback) {
                    throw new Error(
                        `[sasori] browser.tls.extraCaCerts: ${msg}. Refusing to launch ` +
                            'with certificate verification disabled. Fix the CA import ' +
                            '(certutil/NSS must be installed and the PEM readable), or set ' +
                            'browser.tls.allowInsecureFallback: true to accept any ' +
                            'certificate — development only.',
                    );
                }

                console.warn(
                    `[sasori] browser.tls.extraCaCerts: ${msg} — allowInsecureFallback is ` +
                        'enabled, so the crawl browser will accept ANY certificate. ' +
                        'Do not use this outside development.',
                );
            }
        }

        const browserConfig = this.getBrowserConfig(config, extras);
        try {
            const browser = await launch(browserConfig);
            return { browser, userDataDir: extras?.userDataDir ?? null };
        } catch (e) {
            removeUserDataDir(extras?.userDataDir);
            throw e;
        }
    }
}

export default Browser;
