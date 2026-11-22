import { ConfigValidator } from '../../src/config/configLoader';

/**
 * `ConfigValidator` runs Joi with `stripUnknown`, so a key that is not declared
 * in `src/models/configModel.ts` is silently deleted rather than rejected. That
 * makes "the option has no effect" the default failure mode for a config field
 * added in the wrong place — invisible unless something asserts on it.
 *
 * These tests pin `browser.tls.allowInsecureFallback` to the live validation
 * path, because if it is stripped the S4 escape hatch appears to do nothing and
 * a developer without certutil cannot launch at all.
 */
describe('browser.tls.allowInsecureFallback survives validation', () => {
    const configWithTls = (tls: Record<string, unknown>): Record<string, unknown> => ({
        ...global.testUtils.createValidConfig(),
        browser: {
            headless: true,
            maximize: false,
            instances: 1,
            proxy: { enabled: true, host: '127.0.0.1', port: 8080 },
            tls,
        },
    });

    it('preserves allowInsecureFallback: true', () => {
        const validated = ConfigValidator.validate(
            configWithTls({ extraCaCerts: ['/etc/nara/ca.pem'], allowInsecureFallback: true }),
        );

        expect(validated.browser.tls?.allowInsecureFallback).toBe(true);
    });

    it('defaults to false — fail closed — when omitted', () => {
        const validated = ConfigValidator.validate(
            configWithTls({ extraCaCerts: ['/etc/nara/ca.pem'] }),
        );

        expect(validated.browser.tls?.allowInsecureFallback).toBe(false);
    });

    it('preserves an explicit false', () => {
        const validated = ConfigValidator.validate(
            configWithTls({ extraCaCerts: ['/etc/nara/ca.pem'], allowInsecureFallback: false }),
        );

        expect(validated.browser.tls?.allowInsecureFallback).toBe(false);
    });

    it('still carries extraCaCerts through', () => {
        const validated = ConfigValidator.validate(
            configWithTls({ extraCaCerts: ['/etc/nara/ca.pem'], allowInsecureFallback: true }),
        );

        expect(validated.browser.tls?.extraCaCerts).toEqual(['/etc/nara/ca.pem']);
    });
});
