import { promises as fs } from 'fs';
import path from 'path';
import { ConfigLoader, ConfigHelpers } from '../../src/config/configLoader';

// Mock fs module
jest.mock('fs', () => ({
    promises: {
        access: jest.fn(),
        readFile: jest.fn(),
        writeFile: jest.fn(),
    },
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('Configuration Loader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('loadFromFile', () => {
        it('should load and validate configuration from file', async () => {
            const mockConfig = testUtils.createValidConfig();
            const configPath = '/path/to/config.json';

            mockFs.access.mockResolvedValue(undefined);
            mockFs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

            const result = await ConfigLoader.loadFromFile(configPath);

            expect(mockFs.access).toHaveBeenCalledWith(configPath);
            expect(mockFs.readFile).toHaveBeenCalledWith(configPath, 'utf-8');
            expect(result).toBeValidConfig();
            expect(result.browser.instances).toBe(4);
        });

        it('should throw error when file does not exist', async () => {
            const configPath = '/path/to/nonexistent.json';

            mockFs.access.mockRejectedValue(new Error('ENOENT: no such file or directory'));

            await expect(ConfigLoader.loadFromFile(configPath))
                .rejects
                .toThrow('Failed to load configuration from /path/to/nonexistent.json: ENOENT: no such file or directory');
        });

        it('should throw error when file contains invalid JSON', async () => {
            const configPath = '/path/to/invalid.json';

            mockFs.access.mockResolvedValue(undefined);
            mockFs.readFile.mockResolvedValue('invalid json content');

            await expect(ConfigLoader.loadFromFile(configPath))
                .rejects
                .toThrow('Failed to load configuration from /path/to/invalid.json');
        });

        it('should throw error when configuration is invalid', async () => {
            const configPath = '/path/to/invalid-config.json';
            const invalidConfig = { browser: { headless: 'invalid' } };

            mockFs.access.mockResolvedValue(undefined);
            mockFs.readFile.mockResolvedValue(JSON.stringify(invalidConfig));

            await expect(ConfigLoader.loadFromFile(configPath))
                .rejects
                .toThrow('Failed to load configuration from /path/to/invalid-config.json');
        });
    });

    describe('loadDefault', () => {
        it('should load default configuration file', async () => {
            const mockConfig = testUtils.createValidConfig();
            const expectedPath = path.join(__dirname, '..', '..', 'config', 'config.json');

            mockFs.access.mockResolvedValue(undefined);
            mockFs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

            const result = await ConfigLoader.loadDefault();

            expect(mockFs.access).toHaveBeenCalledWith(expectedPath);
            expect(mockFs.readFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
            expect(result).toBeValidConfig();
        });
    });

    describe('createConfigFile', () => {
        it('should create configuration file with provided config', async () => {
            const outputPath = '/path/to/output.json';
            const config = testUtils.createValidConfig();

            mockFs.writeFile.mockResolvedValue(undefined);

            await ConfigLoader.createConfigFile(outputPath, config);

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                outputPath,
                JSON.stringify(config, null, 4),
                'utf-8'
            );
        });

        it('should create configuration file with default config when none provided', async () => {
            const outputPath = '/path/to/output.json';

            mockFs.writeFile.mockResolvedValue(undefined);

            await ConfigLoader.createConfigFile(outputPath);

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                outputPath,
                expect.stringContaining('"browser"'),
                'utf-8'
            );
        });

        it('should throw error when file creation fails', async () => {
            const outputPath = '/path/to/output.json';
            const config = testUtils.createValidConfig();

            mockFs.writeFile.mockRejectedValue(new Error('Permission denied'));

            await expect(ConfigLoader.createConfigFile(outputPath, config))
                .rejects
                .toThrow('Failed to create configuration file at /path/to/output.json: Permission denied');
        });
    });

    describe('validateConfig', () => {
        it('should validate configuration object', () => {
            const validConfig = testUtils.createValidConfig();

            const result = ConfigLoader.validateConfig(validConfig);

            expect(result).toBeValidConfig();
            expect(result.browser.instances).toBe(4);
        });

        it('should throw error for invalid configuration', () => {
            const invalidConfig = { browser: { headless: 'invalid' } };

            expect(() => {
                ConfigLoader.validateConfig(invalidConfig);
            }).toThrow('Configuration validation failed');
        });
    });

    describe('isConfigValid', () => {
        it('should return true for valid configuration file', async () => {
            const configPath = '/path/to/valid.json';
            const mockConfig = testUtils.createValidConfig();

            mockFs.access.mockResolvedValue(undefined);
            mockFs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

            const result = await ConfigLoader.isConfigValid(configPath);

            expect(result).toBe(true);
        });

        it('should return false for invalid configuration file', async () => {
            const configPath = '/path/to/invalid.json';
            const invalidConfig = { browser: { headless: 'invalid' } };

            mockFs.access.mockResolvedValue(undefined);
            mockFs.readFile.mockResolvedValue(JSON.stringify(invalidConfig));

            const result = await ConfigLoader.isConfigValid(configPath);

            expect(result).toBe(false);
        });

        it('should return false when file does not exist', async () => {
            const configPath = '/path/to/nonexistent.json';

            mockFs.access.mockRejectedValue(new Error('ENOENT'));

            const result = await ConfigLoader.isConfigValid(configPath);

            expect(result).toBe(false);
        });
    });

    describe('ConfigHelpers', () => {
        describe('validateTimeout', () => {
            it('should validate timeout within range', () => {
                expect(() => {
                    ConfigHelpers.validateTimeout(5000, 'testTimeout');
                }).not.toThrow();
            });

            it('should throw error for timeout too low', () => {
                expect(() => {
                    ConfigHelpers.validateTimeout(500, 'testTimeout');
                }).toThrow('testTimeout must be at least 1000ms');
            });

            it('should throw error for timeout too high', () => {
                expect(() => {
                    ConfigHelpers.validateTimeout(500000, 'testTimeout');
                }).toThrow('testTimeout must be at most 300000ms');
            });
        });

        describe('validateInstances', () => {
            it('should validate instances within range', () => {
                expect(() => {
                    ConfigHelpers.validateInstances(5);
                }).not.toThrow();
            });

            it('should throw error for instances too low', () => {
                expect(() => {
                    ConfigHelpers.validateInstances(0);
                }).toThrow('Browser instances must be at least 1');
            });

            it('should throw error for instances too high', () => {
                expect(() => {
                    ConfigHelpers.validateInstances(15);
                }).toThrow('Browser instances must be at most 10');
            });
        });

        describe('validateDepth', () => {
            it('should validate depth within range', () => {
                expect(() => {
                    ConfigHelpers.validateDepth(5);
                }).not.toThrow();
            });

            it('should throw error for depth too low', () => {
                expect(() => {
                    ConfigHelpers.validateDepth(0);
                }).toThrow('Crawl depth must be at least 1');
            });

            it('should throw error for depth too high', () => {
                expect(() => {
                    ConfigHelpers.validateDepth(150);
                }).toThrow('Crawl depth must be at most 100');
            });
        });

        describe('validateUrl', () => {
            it('should validate valid URL', () => {
                expect(() => {
                    ConfigHelpers.validateUrl('https://example.com', 'testUrl');
                }).not.toThrow();
            });

            it('should throw error for invalid URL', () => {
                expect(() => {
                    ConfigHelpers.validateUrl('not-a-url', 'testUrl');
                }).toThrow('testUrl must be a valid URL');
            });
        });

        describe('validateRegexes', () => {
            it('should validate valid regex patterns', () => {
                expect(() => {
                    ConfigHelpers.validateRegexes(['^https://', '.*test.*'], 'testRegexes');
                }).not.toThrow();
            });

            it('should throw error for invalid regex pattern', () => {
                expect(() => {
                    ConfigHelpers.validateRegexes(['[invalid', 'valid'], 'testRegexes');
                }).toThrow('testRegexes contains invalid regex pattern: [invalid');
            });
        });
    });
});
