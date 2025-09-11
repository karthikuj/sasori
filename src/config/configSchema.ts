import Joi from 'joi';
import { CrawlerConfig, BrowserConfig, CrawlerSettings, AuthenticationConfig, BasicAuthConfig, RecorderAuthConfig, ProxyConfig } from '../types';

/**
 * Configuration schema definitions with TypeScript integration
 */

/**
 * Proxy configuration schema
 */
export const proxySchema = Joi.object<ProxyConfig>({
    enabled: Joi.boolean().required(),
    host: Joi.string().hostname().when('enabled', {
        is: true,
        then: Joi.string().hostname().required(),
        otherwise: Joi.string().hostname().allow(''),
    }),
    port: Joi.number().integer().min(1).max(65535).when('enabled', {
        is: true,
        then: Joi.number().integer().min(1).max(65535).required(),
        otherwise: Joi.number().integer().min(1).max(65535).allow(0),
    }),
}).required();

/**
 * Basic authentication schema
 */
export const basicAuthSchema = Joi.object<BasicAuthConfig>({
    enabled: Joi.boolean().required(),
    username: Joi.string().min(1).when('enabled', {
        is: true,
        then: Joi.string().min(1).required(),
        otherwise: Joi.string().allow(''),
    }),
    password: Joi.string().min(1).when('enabled', {
        is: true,
        then: Joi.string().min(1).required(),
        otherwise: Joi.string().allow(''),
    }),
}).required();

/**
 * Recorder authentication schema
 */
export const recorderAuthSchema = Joi.object<RecorderAuthConfig>({
    enabled: Joi.boolean().required(),
    pptrRecording: Joi.string().min(1).when('enabled', {
        is: true,
        then: Joi.string().min(1).required(),
        otherwise: Joi.string().allow(''),
    }),
}).required();

/**
 * Authentication configuration schema
 */
export const authenticationSchema = Joi.object<AuthenticationConfig>({
    basicAuth: basicAuthSchema,
    recorderAuth: recorderAuthSchema,
}).required();

/**
 * Browser configuration schema
 */
export const browserSchema = Joi.object<BrowserConfig>({
    headless: Joi.boolean().default(false),
    maximize: Joi.boolean().default(true),
    proxy: proxySchema,
    instances: Joi.number().integer().min(1).max(10).required(),
    slowMo: Joi.number().integer().min(0).max(5000).optional(),
}).required();

/**
 * Crawler settings schema
 */
export const crawlerSchema = Joi.object<CrawlerSettings>({
    entryPoint: Joi.string().uri().required(),
    eventTimeout: Joi.number().integer().min(1000).max(300000).required(),
    navigationTimeout: Joi.number().integer().min(1000).max(300000).required(),
    eventWait: Joi.number().integer().min(0).max(10000).required(),
    maxActionRetries: Joi.number().integer().min(0).max(10).optional(),
    maxDuration: Joi.number().integer().min(0).max(3600000).required(), // 1 hour max
    elements: Joi.array().items(Joi.string().min(1)).min(1).required(),
    maxChildren: Joi.number().integer().min(0).max(1000).required(),
    maxDepth: Joi.number().integer().min(1).max(100).required(),
    authentication: authenticationSchema,
    includeRegexes: Joi.array().items(Joi.string().min(1)).min(1).required(),
    excludeRegexes: Joi.array().items(Joi.string()).required(),
    outputFile: Joi.string().optional(),
}).required();

/**
 * Main configuration schema
 */
export const configSchema = Joi.object<CrawlerConfig>({
    browser: browserSchema,
    crawler: crawlerSchema,
}).required();

/**
 * Configuration validation options
 */
export const validationOptions: Joi.ValidationOptions = {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
    allowUnknown: false,
};

/**
 * Validates a configuration object
 * @param config - Configuration to validate
 * @returns Validation result
 */
export function validateConfig(config: unknown): Joi.ValidationResult<CrawlerConfig> {
    return configSchema.validate(config, validationOptions);
}

/**
 * Configuration presets for common use cases
 */
export const configPresets = {
    /**
       * Development configuration
       */
    development: {
        browser: {
            headless: false,
            maximize: true,
            proxy: { enabled: false, host: '', port: 0 },
            instances: 2,
            slowMo: 100,
        },
        crawler: {
            entryPoint: 'https://localhost:3000/',
            eventTimeout: 5000,
            navigationTimeout: 15000,
            eventWait: 1000,
            maxActionRetries: 3,
            maxDuration: 300000, // 5 minutes
            elements: ['a', 'button', 'input[type="submit"]'],
            maxChildren: 10,
            maxDepth: 3,
            authentication: {
                basicAuth: { enabled: false, username: '', password: '' },
                recorderAuth: { enabled: false, pptrRecording: '' },
            },
            includeRegexes: ['https?://localhost:3000(?:/.*|)'],
            excludeRegexes: ['.*logout.*', '.*admin.*'],
        },
    } as CrawlerConfig,

    /**
       * Production configuration
       */
    production: {
        browser: {
            headless: true,
            maximize: false,
            proxy: { enabled: false, host: '', port: 0 },
            instances: 4,
            // slowMo disabled by default in production for speed
            // Note: omitted to keep undefined as expected by tests
        },
        crawler: {
            entryPoint: 'https://example.com/',
            eventTimeout: 10000,
            navigationTimeout: 30000,
            eventWait: 0,
            maxActionRetries: 3,
            maxDuration: 1800000, // 30 minutes
            elements: ['a', 'button', 'input[type="submit"]', '[click]'],
            maxChildren: 0,
            maxDepth: 10,
            authentication: {
                basicAuth: { enabled: false, username: '', password: '' },
                recorderAuth: { enabled: false, pptrRecording: '' },
            },
            includeRegexes: ['https?://example.com(?:/.*|)'],
            excludeRegexes: ['.*logout.*'],
        },
    } as CrawlerConfig,

    /**
       * Security testing configuration
       */
    security: {
        browser: {
            headless: false,
            maximize: true,
            proxy: { enabled: false, host: '', port: 0 },
            instances: 1,
            slowMo: 500,
        },
        crawler: {
            entryPoint: 'https://security-crawl-maze.app/',
            eventTimeout: 15000,
            navigationTimeout: 45000,
            eventWait: 2000,
            maxActionRetries: 3,
            maxDuration: 3600000, // 1 hour
            elements: ['a', 'button', 'input[type="submit"]', 'input[type="text"]', 'input[type="password"]', '[click]'],
            maxChildren: 0,
            maxDepth: 15,
            authentication: {
                basicAuth: { enabled: false, username: '', password: '' },
                recorderAuth: { enabled: false, pptrRecording: '' },
            },
            includeRegexes: ['https?://security-crawl-maze.app(?:/.*|)'],
            excludeRegexes: ['.*logout.*', '.*admin.*', '.*test.*'],
        },
    } as CrawlerConfig,
};

/**
 * Gets a configuration preset by name
 * @param presetName - Name of the preset
 * @returns Configuration preset
 */
export function getConfigPreset(presetName: keyof typeof configPresets): CrawlerConfig {
    const preset = configPresets[presetName];
    if (!preset) {
        throw new Error(`Unknown configuration preset: ${presetName}`);
    }
    return preset;
}

/**
 * Lists available configuration presets
 * @returns Array of preset names
 */
export function getAvailablePresets(): string[] {
    return Object.keys(configPresets);
}
