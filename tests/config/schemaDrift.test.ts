/**
 * Guards the two parallel Joi layers against drifting apart again (SCAN-89).
 *
 * `src/models/configModel.ts` is the live validator — `ConfigValidator` runs it
 * for both `sasori start` and the API — while `src/config/configSchema.ts`
 * backs the presets and its own `validateConfig`. Because the live path runs
 * Joi with `stripUnknown: true`, a key declared in only *one* of them is not
 * rejected and not warned about: it is silently deleted from the user's config.
 *
 * That failure mode is invisible by construction, which is what makes it
 * dangerous. `maxActionRetries` sat in `configSchema.ts` alone and was read by
 * `crawler.ts` as `?? 3`, so anyone tuning retry behaviour was editing a value
 * thrown away before the crawler saw it. The same nearly happened again with
 * `browser.tls.allowInsecureFallback`, which would have made a documented
 * security escape hatch inert.
 *
 * So this test compares the declared key sets structurally. It is the reason a
 * future option added to one file cannot quietly fail to exist in the other —
 * a comment in CLAUDE.md was not enough the last two times.
 */

import Joi from 'joi';

import configModel from '../../src/models/configModel';
import { configSchema } from '../../src/config/configSchema';

/** A Joi `describe()` result, narrowed to the part this test walks. */
interface SchemaDescription {
    keys?: Record<string, SchemaDescription>;
}

/**
 * Extracts every declared key path from a Joi `describe()` result.
 *
 * Walks the description rather than the schema objects because Joi's internal
 * representation is not public, whereas the description is a documented, stable
 * shape — and it is already fully expanded, so the walk recurses over plain data
 * and cannot loop.
 *
 * @param description Joi description to inspect.
 * @param prefix Dotted path accumulated so far.
 * @return Sorted list of dotted key paths.
 */
function keysOfDescription(description: SchemaDescription, prefix = ''): string[] {
    const keys = description.keys;
    if (!keys) {
        return [];
    }

    const out: string[] = [];
    for (const [name, child] of Object.entries(keys)) {
        const dotted = prefix ? `${prefix}.${name}` : name;
        out.push(dotted);
        out.push(...keysOfDescription(child, dotted));
    }
    return out.sort();
}

/**
 * Convenience wrapper: describe a schema, then list its key paths.
 * @param schema Joi schema to inspect.
 * @return Sorted list of dotted key paths.
 */
function declaredKeys(schema: Joi.Schema): string[] {
    return keysOfDescription(schema.describe() as SchemaDescription);
}

describe('config schema drift (SCAN-89)', () => {
    it('declares exactly the same keys in both Joi layers', () => {
        const live = declaredKeys(configModel);
        const secondary = declaredKeys(configSchema);

        const onlyInSchema = secondary.filter((k) => !live.includes(k));
        const onlyInModel = live.filter((k) => !secondary.includes(k));

        // Reported as named arrays rather than a bare set comparison so the
        // failure message says which key would be silently stripped, and from
        // which side — that is the whole diagnostic.
        expect({ onlyInSchema, onlyInModel }).toEqual({ onlyInSchema: [], onlyInModel: [] });
    });

    it('declares every optional key that CrawlerSettings exposes to the crawler', () => {
        // The type is the third place these keys are written down. A key that
        // exists in `CrawlerSettings` and is read by `crawler.ts` but declared
        // in neither schema behaves exactly like the maxActionRetries bug.
        const live = declaredKeys(configModel);
        for (const key of [
            'crawler.maxActionRetries',
            'crawler.debugNetwork',
            'crawler.outputFile',
            'crawler.inventoryFile',
            'browser.tls.allowInsecureFallback',
            'browser.tls.extraCaCerts',
        ]) {
            expect(live).toContain(key);
        }
    });
});

describe('maxActionRetries reaches the crawler (SCAN-89)', () => {
    /**
     * Builds a minimal valid config with the given crawler overrides.
     * @param overrides Crawler settings to merge in.
     * @return A config object suitable for validation.
     */
    function configWith(overrides: Record<string, unknown>): Record<string, unknown> {
        const base = (global as any).testUtils.createValidConfig();
        Object.assign(base.crawler, overrides);
        return base;
    }

    it('survives validation instead of being stripped', () => {
        const { ConfigValidator } = require('../../src/models/configModel');
        const validated = ConfigValidator.validate(configWith({ maxActionRetries: 7 }));
        expect(validated.crawler.maxActionRetries).toBe(7);
    });

    it('is still optional', () => {
        const { ConfigValidator } = require('../../src/models/configModel');
        const validated = ConfigValidator.validate(configWith({}));
        expect(validated.crawler.maxActionRetries).toBeUndefined();
    });

    it('rejects 0, which would skip the retry loop body entirely', () => {
        const { ConfigValidator } = require('../../src/models/configModel');
        expect(() => ConfigValidator.validate(configWith({ maxActionRetries: 0 }))).toThrow(
            /maxActionRetries/,
        );
    });

    it('rejects a value above the supported ceiling', () => {
        const { ConfigValidator } = require('../../src/models/configModel');
        expect(() => ConfigValidator.validate(configWith({ maxActionRetries: 99 }))).toThrow(
            /maxActionRetries/,
        );
    });
});
