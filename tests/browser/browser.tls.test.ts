import { launch } from 'puppeteer';
import type { Browser as PuppeteerBrowser } from 'puppeteer';

import Browser from '../../src/browser/browser';
import { prepareTlsUserDataDir } from '../../src/browser/tlsProfile';
import type { BrowserConfig } from '../../src/types/browser';

jest.mock('puppeteer');
jest.mock('../../src/browser/tlsProfile', () => ({
    prepareTlsUserDataDir: jest.fn(),
}));

const mockLaunch = launch as jest.MockedFunction<typeof launch>;
const mockPrepareTls = prepareTlsUserDataDir as jest.MockedFunction<typeof prepareTlsUserDataDir>;

// tsconfig uses exactOptionalPropertyTypes, so optional fields are built by
// conditional spread rather than assigned undefined.
function proxiedConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
    return {
        headless: true,
        maximize: false,
        instances: 1,
        proxy: { enabled: true, host: '127.0.0.1', port: 8080 },
        tls: { extraCaCerts: ['/etc/nara/ca.pem'] },
        ...overrides,
    };
}

/** Same shape, but with no `tls` key at all. */
function proxiedConfigWithoutTls(): BrowserConfig {
    return {
        headless: true,
        maximize: false,
        instances: 1,
        proxy: { enabled: true, host: '127.0.0.1', port: 8080 },
    };
}

describe('Browser TLS fallback (S4)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLaunch.mockResolvedValue({} as PuppeteerBrowser);
    });

    it('uses the imported CA profile and does not disable verification', async () => {
        mockPrepareTls.mockReturnValue('/tmp/profile');

        await Browser.getBrowserInstance(proxiedConfig());

        const options = mockLaunch.mock.calls[0]![0]!;
        expect(options.userDataDir).toBe('/tmp/profile');
        expect(options.args).not.toContain('--ignore-certificate-errors');
    });

    // The S4 regression: a failed CA import silently downgraded the browser to
    // trusting every certificate. A configured CA means the operator intends
    // verified TLS, so abandoning it must be loud, not silent.
    it('refuses to launch when the CA import fails and fallback is not permitted', async () => {
        mockPrepareTls.mockImplementation(() => {
            throw new Error('certutil not found');
        });

        await expect(Browser.getBrowserInstance(proxiedConfig())).rejects.toThrow(
            /Refusing to launch with certificate verification disabled/,
        );
        expect(mockLaunch).not.toHaveBeenCalled();
    });

    it('surfaces the underlying cause and the remedy in the error', async () => {
        mockPrepareTls.mockImplementation(() => {
            throw new Error('certutil not found');
        });

        await expect(Browser.getBrowserInstance(proxiedConfig())).rejects.toThrow(/certutil not found/);
        await expect(Browser.getBrowserInstance(proxiedConfig())).rejects.toThrow(
            /allowInsecureFallback/,
        );
    });

    it('allows the insecure fallback only when explicitly opted in', async () => {
        mockPrepareTls.mockImplementation(() => {
            throw new Error('certutil not found');
        });

        const config = proxiedConfig({
            tls: { extraCaCerts: ['/etc/nara/ca.pem'], allowInsecureFallback: true },
        });
        await Browser.getBrowserInstance(config);

        const options = mockLaunch.mock.calls[0]![0]!;
        expect(options.args).toContain('--ignore-certificate-errors');
    });

    it('warns loudly when running with verification disabled', async () => {
        mockPrepareTls.mockImplementation(() => {
            throw new Error('certutil not found');
        });

        await Browser.getBrowserInstance(
            proxiedConfig({ tls: { extraCaCerts: ['/etc/nara/ca.pem'], allowInsecureFallback: true } }),
        );

        // tests/setup.ts replaces console.warn with a jest.fn().
        const warnings = (console.warn as jest.Mock).mock.calls.flat().join(' ');
        expect(warnings).toMatch(/accept ANY certificate|verification DISABLED/i);
    });

    // No CA configured at all is the pre-existing local-dev shape and must keep
    // working — this fix targets the case where a CA was requested and failed.
    it('still proxies without a CA configured', async () => {
        await Browser.getBrowserInstance(proxiedConfigWithoutTls());

        expect(mockPrepareTls).not.toHaveBeenCalled();
        const options = mockLaunch.mock.calls[0]![0]!;
        expect(options.args).toContain('--ignore-certificate-errors');
        expect(options.args).toContain('--proxy-server=127.0.0.1:8080');
    });

    it('does not touch TLS handling when no proxy is used', async () => {
        const config = proxiedConfig({ proxy: { enabled: false } });

        await Browser.getBrowserInstance(config);

        expect(mockPrepareTls).not.toHaveBeenCalled();
        const options = mockLaunch.mock.calls[0]![0]!;
        expect(options.args).not.toContain('--ignore-certificate-errors');
    });
});
