import { ConfigValidator } from '../../src/models/configModel';
import { validateConfig, getConfigPreset, getAvailablePresets } from '../../src/config/configSchema';

describe('Configuration Validation', () => {
    describe('ConfigValidator', () => {
        describe('validate', () => {
            it('should validate a correct configuration', () => {
                const validConfig = testUtils.createValidConfig();

                expect(() => {
                    const result = ConfigValidator.validate(validConfig);
                    expect(result).toBeValidConfig();
                    expect(result.browser.instances).toBe(4);
                    expect(result.crawler.entryPoint).toBe('https://example.com/');
                }).not.toThrow();
            });

            it('should reject invalid configuration with detailed errors', () => {
                const invalidConfig = {
                    browser: {
                        headless: 'invalid', // Should be boolean
                        instances: -1, // Should be positive
                    },
                    crawler: {
                        entryPoint: 'not-a-url', // Should be valid URL
                        elements: [], // Should have at least one element
                    },
                };

                expect(() => {
                    ConfigValidator.validate(invalidConfig);
                }).toThrow('Configuration validation failed');
            });

            it('should handle missing required fields', () => {
                const incompleteConfig = {
                    browser: {
                        instances: 4,
                    },
                };

                expect(() => {
                    ConfigValidator.validate(incompleteConfig);
                }).toThrow('Configuration validation failed');
            });

            it('should validate authentication configurations correctly', () => {
                const configWithAuth = {
                    ...testUtils.createValidConfig(),
                    crawler: {
                        ...testUtils.createValidConfig().crawler,
                        authentication: {
                            basicAuth: {
                                enabled: true,
                                username: 'testuser',
                                password: 'testpass',
                            },
                            recorderAuth: {
                                enabled: false,
                                pptrRecording: '',
                            },
                        },
                    },
                };

                expect(() => {
                    const result = ConfigValidator.validate(configWithAuth);
                    expect(result.crawler.authentication.basicAuth.enabled).toBe(true);
                    expect(result.crawler.authentication.basicAuth.username).toBe('testuser');
                }).not.toThrow();
            });

            it('should reject enabled authentication without credentials', () => {
                const configWithInvalidAuth = {
                    ...testUtils.createValidConfig(),
                    crawler: {
                        ...testUtils.createValidConfig().crawler,
                        authentication: {
                            basicAuth: {
                                enabled: true,
                                username: '', // Should be required when enabled
                                password: '',
                            },
                            recorderAuth: {
                                enabled: false,
                                pptrRecording: '',
                            },
                        },
                    },
                };

                expect(() => {
                    ConfigValidator.validate(configWithInvalidAuth);
                }).toThrow('Configuration validation failed');
            });
        });

        describe('isValid', () => {
            it('should return true for valid configuration', () => {
                const validConfig = testUtils.createValidConfig();
                expect(ConfigValidator.isValid(validConfig)).toBe(true);
            });

            it('should return false for invalid configuration', () => {
                const invalidConfig = {
                    browser: { headless: 'invalid' },
                    crawler: { entryPoint: 'not-a-url' },
                };
                expect(ConfigValidator.isValid(invalidConfig)).toBe(false);
            });
        });
    });

    describe('Joi Schema Validation', () => {
        describe('validateConfig', () => {
            it('should validate configuration using Joi schema', () => {
                const validConfig = testUtils.createValidConfig();
                const result = validateConfig(validConfig);

                expect(result.error).toBeUndefined();
                expect(result.value).toBeDefined();
                expect(result.value?.browser.instances).toBe(4);
            });

            it('should return validation errors for invalid config', () => {
                const invalidConfig = {
                    browser: { headless: 'invalid' },
                    crawler: { entryPoint: 'not-a-url' },
                };

                const result = validateConfig(invalidConfig);
                expect(result.error).toBeDefined();
                expect(result.error?.message).toContain('must be a boolean');
            });
        });
    });

    describe('Configuration Presets', () => {
        describe('getConfigPreset', () => {
            it('should return development preset', () => {
                const preset = getConfigPreset('development');

                expect(preset.browser.headless).toBe(false);
                expect(preset.browser.instances).toBe(2);
                expect(preset.crawler.entryPoint).toBe('https://localhost:3000/');
                expect(preset.browser.slowMo).toBe(100);
            });

            it('should return production preset', () => {
                const preset = getConfigPreset('production');

                expect(preset.browser.headless).toBe(true);
                expect(preset.browser.instances).toBe(4);
                expect(preset.crawler.entryPoint).toBe('https://example.com/');
                expect(preset.browser.slowMo).toBeUndefined();
            });

            it('should return security preset', () => {
                const preset = getConfigPreset('security');

                expect(preset.browser.headless).toBe(false);
                expect(preset.browser.instances).toBe(1);
                expect(preset.crawler.entryPoint).toBe('https://security-crawl-maze.app/');
                expect(preset.browser.slowMo).toBe(500);
                expect(preset.crawler.maxDepth).toBe(15);
            });

            it('should throw error for unknown preset', () => {
                expect(() => {
                    getConfigPreset('unknown' as any);
                }).toThrow('Unknown configuration preset: unknown');
            });
        });

        describe('getAvailablePresets', () => {
            it('should return list of available presets', () => {
                const presets = getAvailablePresets();

                expect(presets).toContain('development');
                expect(presets).toContain('production');
                expect(presets).toContain('security');
                expect(presets.length).toBe(3);
            });
        });
    });

    describe('Configuration Edge Cases', () => {
        it('should handle proxy configuration correctly', () => {
            const configWithProxy = {
                ...testUtils.createValidConfig(),
                browser: {
                    ...testUtils.createValidConfig().browser,
                    proxy: {
                        enabled: true,
                        host: 'proxy.example.com',
                        port: 3128,
                    },
                },
            };

            expect(() => {
                const result = ConfigValidator.validate(configWithProxy);
                expect(result.browser.proxy.enabled).toBe(true);
                expect(result.browser.proxy.host).toBe('proxy.example.com');
                expect(result.browser.proxy.port).toBe(3128);
            }).not.toThrow();
        });

        it('should handle disabled proxy with empty values', () => {
            const configWithDisabledProxy = {
                ...testUtils.createValidConfig(),
                browser: {
                    ...testUtils.createValidConfig().browser,
                    proxy: {
                        enabled: false,
                        host: '',
                        port: 0,
                    },
                },
            };

            expect(() => {
                const result = ConfigValidator.validate(configWithDisabledProxy);
                expect(result.browser.proxy.enabled).toBe(false);
            }).not.toThrow();
        });

        it('should validate timeout ranges', () => {
            const configWithInvalidTimeouts = {
                ...testUtils.createValidConfig(),
                crawler: {
                    ...testUtils.createValidConfig().crawler,
                    eventTimeout: 500, // Too low
                    navigationTimeout: 500000, // Too high
                },
            };

            expect(() => {
                ConfigValidator.validate(configWithInvalidTimeouts);
            }).toThrow('Configuration validation failed');
        });

        it('should validate browser instances range', () => {
            const configWithInvalidInstances = {
                ...testUtils.createValidConfig(),
                browser: {
                    ...testUtils.createValidConfig().browser,
                    instances: 15, // Too high
                },
            };

            expect(() => {
                ConfigValidator.validate(configWithInvalidInstances);
            }).toThrow('Configuration validation failed');
        });

        it('should validate crawl depth range', () => {
            const configWithInvalidDepth = {
                ...testUtils.createValidConfig(),
                crawler: {
                    ...testUtils.createValidConfig().crawler,
                    maxDepth: 0, // Too low
                },
            };

            expect(() => {
                ConfigValidator.validate(configWithInvalidDepth);
            }).toThrow('Configuration validation failed');
        });
    });
});
