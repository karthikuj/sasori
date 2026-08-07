import { launch, Browser as PuppeteerBrowser, LaunchOptions } from 'puppeteer';
import { BrowserConfig } from '../types/browser';
import { prepareTlsUserDataDir } from './tlsProfile';

export interface BrowserLaunchExtras {
    /** Isolated profile dir with NSS CA imports (from {@link prepareTlsUserDataDir}). */
    userDataDir?: string;
    /** When true, {@link getBrowserConfig} skips `--ignore-certificate-errors` for proxied HTTPS. */
    tlsCaImported?: boolean;
}

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
        const args: string[] = [];

        browserConfig.headless = config.headless;

        if (config.maximize) {
            args.push('--start-maximized');
        }

        if (config.proxy && config.proxy.enabled) {
            if (config.proxy.host && config.proxy.port) {
                args.push(`--proxy-server=${config.proxy.host}:${config.proxy.port}`);
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
        const browser = await launch(browserConfig);
        return browser;
    }
}

export default Browser;
