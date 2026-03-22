import Joi from 'joi';
import {
    CrawlerConfig,
    BrowserConfig,
    CrawlerSettings,
    AuthenticationConfig,
    BasicAuthConfig,
    RecorderAuthConfig,
    ProxyConfig,
} from '../types';

/**
 * Proxy model for the proxy configuration of the crawler
 */
const proxyModel: Joi.ObjectSchema<ProxyConfig> = Joi.object({
    enabled: Joi.boolean().required(),
    host: Joi.string().hostname().when('enabled', {
        is: true,
        then: Joi.string().hostname().required(),
        otherwise: Joi.string().hostname().allow(''),
    }),
    port: Joi.number().integer().when('enabled', {
        is: true,
        then: Joi.number().integer().required(),
        otherwise: Joi.number().integer().allow(0),
    }),
}).required();

/**
 * Basic auth model for HTTP basic authentication.
 */
const basicAuthModel: Joi.ObjectSchema<BasicAuthConfig> = Joi.object({
    enabled: Joi.boolean().required(),
    username: Joi.string().when('enabled', {
        is: true,
        then: Joi.string().required(),
        otherwise: Joi.string().allow(''),
    }),
    password: Joi.string().when('enabled', {
        is: true,
        then: Joi.string().required(),
        otherwise: Joi.string().allow(''),
    }),
}).required();

/**
 * Recorder auth model for pptr recorder based auth configurations.
 */
const recorderAuthModel: Joi.ObjectSchema<RecorderAuthConfig> = Joi.object({
    enabled: Joi.boolean().required(),
    pptrRecording: Joi.string().when('enabled', {
        is: true,
        then: Joi.string().required(),
        otherwise: Joi.string().allow(''),
    }),
}).required();

/**
 * Authentication model for all the authentication configurations.
 */
const authenticationModel: Joi.ObjectSchema<AuthenticationConfig> = Joi.object({
    basicAuth: basicAuthModel,
    recorderAuth: recorderAuthModel,
});

/**
 * Optional TLS trust (PEM CA files for Chromium via NSS certutil).
 */
const tlsModel = Joi.object({
    extraCaCerts: Joi.array().items(Joi.string().min(1)).optional(),
}).optional();

/**
 * Browser model for the browser configuration of the crawler.
 */
const browserModel: Joi.ObjectSchema<BrowserConfig> = Joi.object({
    headless: Joi.boolean(),
    maximize: Joi.boolean(),
    proxy: proxyModel,
    instances: Joi.number().integer().min(1).max(10).required(),
    slowMo: Joi.number().integer().min(0).max(5000).optional(),
    tls: tlsModel,
});

/**
 * Crawler model for the main crawler configurations.
 */
const crawlerModel: Joi.ObjectSchema<CrawlerSettings> = Joi.object({
    entryPoint: Joi.string().uri().required(),
    eventTimeout: Joi.number().integer().min(1000).max(300000).required(),
    navigationTimeout: Joi.number().integer().min(1000).max(300000).required(),
    eventWait: Joi.number().integer().min(0).max(10000).required(),
    maxDuration: Joi.number().integer().min(0).max(3600000).required(),
    elements: Joi.array().items(Joi.string()).min(1).required(),
    maxChildren: Joi.number().integer().min(0).max(1000).required(),
    maxDepth: Joi.number().integer().min(1).max(100).required(),
    authentication: authenticationModel,
    includeRegexes: Joi.array().items(Joi.string()).min(1).required(),
    excludeRegexes: Joi.array().items(Joi.string()).required(),
    outputFile: Joi.string().optional(),
}).required();

/**
 * The entire crawler config validation schema.
 */
const configModel: Joi.ObjectSchema<CrawlerConfig> = Joi.object({
    browser: browserModel,
    crawler: crawlerModel,
});

/**
 * Validates a configuration object against the schema
 * @param config - The configuration object to validate
 * @returns Validation result with error or validated config
 */
export function validateConfig(config: unknown): { error?: string; value?: CrawlerConfig } {
    const { error, value } = configModel.validate(config, {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
    });

    if (error) {
        const errorMessage = error.details
            .map((detail) => `${detail.path.join('.')}: ${detail.message}`)
            .join('; ');
        return { error: errorMessage };
    }

    return { value: value as CrawlerConfig };
}

/**
 * Creates a default configuration object
 * @returns Default configuration
 */
export function createDefaultConfig(): CrawlerConfig {
    return {
        browser: {
            headless: false,
            maximize: true,
            proxy: {
                enabled: false,
                host: '127.0.0.1',
                port: 8080,
            },
            instances: 4,
        },
        crawler: {
            entryPoint: 'https://example.com/',
            eventTimeout: 10000,
            navigationTimeout: 30000,
            eventWait: 0,
            maxDuration: 0,
            elements: ['a', 'button', 'input[type="submit"]'],
            maxChildren: 0,
            maxDepth: 10,
            authentication: {
                basicAuth: {
                    enabled: false,
                    username: 'username',
                    password: 'password',
                },
                recorderAuth: {
                    enabled: false,
                    pptrRecording: '/path/to/login/recording',
                },
            },
            includeRegexes: ['https?://example.com(?:/.*|)'],
            excludeRegexes: ['.*logout.*'],
        },
    };
}

/**
 * Configuration validation utilities
 */
export class ConfigValidator {
    /**
       * Validates and sanitizes a configuration object
       */
    static validate(config: unknown): CrawlerConfig {
        const result = validateConfig(config);
        if (result.error) {
            throw new Error(`Configuration validation failed: ${result.error}`);
        }
        return result.value!;
    }

    /**
       * Validates a configuration file path and loads it
       */
    static async validateFromFile(filePath: string): Promise<CrawlerConfig> {
        try {
            const fs = await import('fs/promises');
            const configContent = await fs.readFile(filePath, 'utf-8');
            const config = JSON.parse(configContent);
            return this.validate(config);
        } catch (error) {
            throw new Error(`Failed to load configuration from ${filePath}: ${error}`);
        }
    }

    /**
       * Checks if a configuration object is valid without throwing
       */
    static isValid(config: unknown): config is CrawlerConfig {
        const result = validateConfig(config);
        return !result.error;
    }
}

export default configModel;
