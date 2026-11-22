import { promises as fs } from 'fs';
import path from 'path';
import { CrawlerConfig } from '../types';
import { ConfigValidator } from '../models/configModel';

// Re-export ConfigValidator for convenience
export { ConfigValidator };

/**
 * Configuration loader utilities
 */
export class ConfigLoader {
    /**
       * Loads and validates configuration from a JSON file
       * @param configPath - Path to the configuration file
       * @returns Validated configuration object
       */
    static async loadFromFile(configPath: string): Promise<CrawlerConfig> {
        try {
            // Check if file exists
            await fs.access(configPath);

            // Read and parse the configuration file
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);

            // Validate the configuration
            return ConfigValidator.validate(config);
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to load configuration from ${configPath}: ${error.message}`);
            }
            throw new Error(`Failed to load configuration from ${configPath}: Unknown error`);
        }
    }

    /**
       * Loads configuration from the default config file
       * @returns Validated configuration object
       */
    static async loadDefault(): Promise<CrawlerConfig> {
        const defaultConfigPath = path.join(__dirname, '..', '..', 'config', 'config.json');
        return this.loadFromFile(defaultConfigPath);
    }

    /**
       * Creates a configuration file from a template
       * @param outputPath - Path where to save the configuration file
       * @param config - Configuration object to save (optional, uses default if not provided)
       */
    static async createConfigFile(outputPath: string, config?: CrawlerConfig): Promise<void> {
        try {
            const configToSave = config || this.getDefaultConfig();
            const configContent = JSON.stringify(configToSave, null, 4);
            await fs.writeFile(outputPath, configContent, 'utf-8');
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to create configuration file at ${outputPath}: ${error.message}`);
            }
            throw new Error(`Failed to create configuration file at ${outputPath}: Unknown error`);
        }
    }

    /**
       * Validates a configuration object without loading from file
       * @param config - Configuration object to validate
       * @returns Validated configuration object
       */
    static validateConfig(config: unknown): CrawlerConfig {
        return ConfigValidator.validate(config);
    }

    /**
       * Checks if a configuration file exists and is valid
       * @param configPath - Path to the configuration file
       * @returns True if file exists and is valid
       */
    static async isConfigValid(configPath: string): Promise<boolean> {
        try {
            await this.loadFromFile(configPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
       * Gets a default configuration object
       * @returns Default configuration
       */
    static getDefaultConfig(): CrawlerConfig {
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
                slowMo: 100,
            },
            crawler: {
                entryPoint: 'https://example.com/',
                eventTimeout: 10000,
                navigationTimeout: 30000,
                eventWait: 0,
                maxActionRetries: 3,
                maxDuration: 0,
                elements: ['a', 'button', 'input[type="submit"]', '[click]'],
                maxChildren: 0,
                maxDepth: 10,
                authentication: {
                    basicAuth: {
                        enabled: false,
                        username: '',
                        password: '',
                    },
                    recorderAuth: {
                        enabled: false,
                        pptrRecording: '',
                    },
                },
                includeRegexes: ['https?://example.com(?:/.*|)'],
                excludeRegexes: ['.*logout.*'],
            },
        };
    }
}

/**
 * Configuration constants
 */
export const CONFIG_CONSTANTS = {
    DEFAULT_CONFIG_PATH: path.join(__dirname, '..', '..', 'config', 'config.json'),
    MIN_TIMEOUT: 1000,
    MAX_TIMEOUT: 300000,
    MIN_INSTANCES: 1,
    MAX_INSTANCES: 10,
    MIN_DEPTH: 1,
    MAX_DEPTH: 100,
} as const;

/**
 * Configuration validation helpers
 */
export class ConfigHelpers {
    /**
       * Validates timeout values
       */
    static validateTimeout(timeout: number, name: string): void {
        if (timeout < CONFIG_CONSTANTS.MIN_TIMEOUT) {
            throw new Error(`${name} must be at least ${CONFIG_CONSTANTS.MIN_TIMEOUT}ms`);
        }
        if (timeout > CONFIG_CONSTANTS.MAX_TIMEOUT) {
            throw new Error(`${name} must be at most ${CONFIG_CONSTANTS.MAX_TIMEOUT}ms`);
        }
    }

    /**
       * Validates browser instances count
       */
    static validateInstances(instances: number): void {
        if (instances < CONFIG_CONSTANTS.MIN_INSTANCES) {
            throw new Error(`Browser instances must be at least ${CONFIG_CONSTANTS.MIN_INSTANCES}`);
        }
        if (instances > CONFIG_CONSTANTS.MAX_INSTANCES) {
            throw new Error(`Browser instances must be at most ${CONFIG_CONSTANTS.MAX_INSTANCES}`);
        }
    }

    /**
       * Validates crawl depth
       */
    static validateDepth(depth: number): void {
        if (depth < CONFIG_CONSTANTS.MIN_DEPTH) {
            throw new Error(`Crawl depth must be at least ${CONFIG_CONSTANTS.MIN_DEPTH}`);
        }
        if (depth > CONFIG_CONSTANTS.MAX_DEPTH) {
            throw new Error(`Crawl depth must be at most ${CONFIG_CONSTANTS.MAX_DEPTH}`);
        }
    }

    /**
       * Validates URL format
       */
    static validateUrl(url: string, name: string): void {
        try {
            new URL(url);
        } catch {
            throw new Error(`${name} must be a valid URL`);
        }
    }

    /**
       * Validates regex patterns
       */
    static validateRegexes(regexes: string[], name: string): void {
        for (const regex of regexes) {
            try {
                new RegExp(regex);
            } catch {
                throw new Error(`${name} contains invalid regex pattern: ${regex}`);
            }
        }
    }
}
