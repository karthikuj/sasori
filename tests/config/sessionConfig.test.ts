/**
 * SCAN-236 settings: browser.sessionMode, crawler.authentication.sessionCheck
 * and reloginIntervalMs, in both Joi layers.
 */

import { ConfigValidator } from '../../src/models/configModel';
import { validateConfig } from '../../src/config/configSchema';
import { CrawlerConfig } from '../../src/types/crawler';

type Layer = { name: string; check: (config: unknown) => { ok: boolean; value?: CrawlerConfig } };

const layers: Layer[] = [
    {
        name: 'configModel (live)',
        check: (config) => {
            try {
                return { ok: true, value: ConfigValidator.validate(config) };
            } catch {
                return { ok: false };
            }
        },
    },
    {
        name: 'configSchema',
        check: (config) => {
            const result = validateConfig(config);
            return result.error ? { ok: false } : { ok: true, value: result.value };
        },
    },
];

function config(browser: Record<string, unknown> = {}, auth: Record<string, unknown> = {}) {
    const c = testUtils.createValidConfig() as unknown as CrawlerConfig;
    Object.assign(c.browser, browser);
    Object.assign(c.crawler.authentication, auth);
    return c;
}

describe.each(layers)('$name', ({ check }) => {
    it('keeps every new key (none is stripped)', () => {
        const result = check(config(
            { sessionMode: 'perBrowser' },
            { sessionCheck: { enabled: true, intervalMs: 120000, url: 'https://example.com/api/me' }, reloginIntervalMs: 3600000 },
        ));
        expect(result.ok).toBe(true);
        expect(result.value!.browser.sessionMode).toBe('perBrowser');
        expect(result.value!.crawler.authentication.sessionCheck).toEqual({
            enabled: true, intervalMs: 120000, url: 'https://example.com/api/me',
        });
        expect(result.value!.crawler.authentication.reloginIntervalMs).toBe(3600000);
    });

    it('accepts a config with none of them', () => {
        const result = check(config());
        expect(result.ok).toBe(true);
        expect(result.value!.browser.sessionMode).toBeUndefined();
    });

    it.each(['shared', 'perBrowser'])('accepts sessionMode %s', (mode) => {
        expect(check(config({ sessionMode: mode })).ok).toBe(true);
    });

    it.each(['tabs', 'single', '', 1])('rejects sessionMode %p', (mode) => {
        expect(check(config({ sessionMode: mode })).ok).toBe(false);
    });

    it('rejects a check interval under 10 seconds, and a non-http check URL', () => {
        expect(check(config({}, { sessionCheck: { intervalMs: 5000 } })).ok).toBe(false);
        expect(check(config({}, { sessionCheck: { url: 'ftp://example.com/me' } })).ok).toBe(false);
        expect(check(config({}, { sessionCheck: { url: 'not a url' } })).ok).toBe(false);
    });

    it('accepts loggedInRegex with a url, and keeps it', () => {
        const result = check(config({}, { sessionCheck: { url: 'https://example.com/me', loggedInRegex: 'Welcome! \\w+' } }));
        expect(result.ok).toBe(true);
        expect(result.value!.crawler.authentication.sessionCheck!.loggedInRegex).toBe('Welcome! \\w+');
    });

    it('rejects loggedInRegex without a url, an invalid pattern, and an empty one', () => {
        expect(check(config({}, { sessionCheck: { loggedInRegex: 'x' } })).ok).toBe(false);
        expect(check(config({}, { sessionCheck: { url: 'https://example.com/me', loggedInRegex: '(unclosed' } })).ok).toBe(false);
        expect(check(config({}, { sessionCheck: { url: 'https://example.com/me', loggedInRegex: '' } })).ok).toBe(false);
    });

    it('accepts reloginIntervalMs 0 (off) or a minute and more, nothing in between', () => {
        expect(check(config({}, { reloginIntervalMs: 0 })).ok).toBe(true);
        expect(check(config({}, { reloginIntervalMs: 60000 })).ok).toBe(true);
        expect(check(config({}, { reloginIntervalMs: 30000 })).ok).toBe(false);
        expect(check(config({}, { reloginIntervalMs: -1 })).ok).toBe(false);
    });
});
