import { Browser as PuppeteerBrowser } from 'puppeteer';
import { launch } from 'puppeteer';
import Browser from '../../src/browser/browser';
import { BrowserConfig } from '../../src/types/browser';

// Mock puppeteer
jest.mock('puppeteer');

const mockLaunch = launch as jest.MockedFunction<typeof launch>;

describe('Browser', () => {
    let mockBrowser: jest.Mocked<PuppeteerBrowser>;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Create mock browser
        mockBrowser = {
            newPage: jest.fn(),
            close: jest.fn(),
            pages: jest.fn(),
            version: jest.fn(),
            userAgent: jest.fn(),
            wsEndpoint: jest.fn(),
            process: jest.fn(),
            isConnected: jest.fn(),
            disconnect: jest.fn(),
            createIncognitoBrowserContext: jest.fn(),
            browserContexts: jest.fn(),
            defaultBrowserContext: jest.fn(),
            on: jest.fn(),
            off: jest.fn(),
            removeListener: jest.fn(),
            addListener: jest.fn(),
            once: jest.fn(),
            emit: jest.fn(),
            listenerCount: jest.fn(),
            listeners: jest.fn(),
            prependListener: jest.fn(),
            prependOnceListener: jest.fn(),
            eventNames: jest.fn(),
            setMaxListeners: jest.fn(),
            getMaxListeners: jest.fn(),
            removeAllListeners: jest.fn(),
        } as any;

        // Setup launch mock
        mockLaunch.mockResolvedValue(mockBrowser);
    });

    describe('getBrowserConfig', () => {
        it('should return basic browser configuration', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [],
            });
        });

        it('should handle headless: false configuration', () => {
            const config: BrowserConfig = {
                headless: false,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: false,
                args: [],
            });
        });

        it('should add maximize argument when enabled', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: true,
                proxy: { enabled: false },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: ['--start-maximized'],
            });
        });

        it('should add proxy configuration when enabled with host and port', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 8080,
                },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [
                    '--proxy-server=127.0.0.1:8080',
                    '--ignore-certificate-errors',
                ],
            });
        });

        it('should not add proxy configuration when enabled but missing host', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: {
                    enabled: true,
                    port: 8080,
                },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [],
            });
        });

        it('should not add proxy configuration when enabled but missing port', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: {
                    enabled: true,
                    host: '127.0.0.1',
                },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [],
            });
        });

        it('should not add proxy configuration when disabled', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 8080,
                },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [],
            });
        });

        it('should add slowMo configuration when provided', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
                slowMo: 100,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [],
                slowMo: 100,
            });
        });

        it('should combine multiple configuration options', () => {
            const config: BrowserConfig = {
                headless: false,
                maximize: true,
                proxy: {
                    enabled: true,
                    host: '192.168.1.1',
                    port: 3128,
                },
                instances: 1,
                slowMo: 250,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: false,
                args: [
                    '--start-maximized',
                    '--proxy-server=192.168.1.1:3128',
                    '--ignore-certificate-errors',
                ],
                slowMo: 250,
            });
        });

        it('should handle proxy with different host and port combinations', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: {
                    enabled: true,
                    host: 'proxy.example.com',
                    port: 9000,
                },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [
                    '--proxy-server=proxy.example.com:9000',
                    '--ignore-certificate-errors',
                ],
            });
        });
    });

    describe('getBrowserInstance', () => {
        it('should create and return a browser instance', async () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            const result = await Browser.getBrowserInstance(config);

            expect(mockLaunch).toHaveBeenCalledWith({
                headless: true,
                args: [],
            });
            expect(result).toBe(mockBrowser);
        });

        it('should pass correct configuration to launch', async () => {
            const config: BrowserConfig = {
                headless: false,
                maximize: true,
                proxy: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 8080,
                },
                instances: 1,
                slowMo: 100,
            };

            await Browser.getBrowserInstance(config);

            expect(mockLaunch).toHaveBeenCalledWith({
                headless: false,
                args: [
                    '--start-maximized',
                    '--proxy-server=127.0.0.1:8080',
                    '--ignore-certificate-errors',
                ],
                slowMo: 100,
            });
        });

        it('should handle launch errors', async () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            const error = new Error('Failed to launch browser');
            mockLaunch.mockRejectedValue(error);

            await expect(Browser.getBrowserInstance(config))
                .rejects.toThrow('Failed to launch browser');
        });

        it('should handle complex configuration scenarios', async () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: true,
                proxy: {
                    enabled: true,
                    host: 'corporate-proxy.company.com',
                    port: 8080,
                },
                instances: 5,
                slowMo: 500,
            };

            await Browser.getBrowserInstance(config);

            expect(mockLaunch).toHaveBeenCalledWith({
                headless: true,
                args: [
                    '--start-maximized',
                    '--proxy-server=corporate-proxy.company.com:8080',
                    '--ignore-certificate-errors',
                ],
                slowMo: 500,
            });
        });
    });

    describe('Edge cases and error handling', () => {
        it('should handle undefined slowMo gracefully', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [],
            });
            expect(result.slowMo).toBeUndefined();
        });

        it('should handle null proxy configuration', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            // Test with proxy set to null (edge case)
            const configWithNullProxy = { ...config, proxy: null as any };

            const result = Browser.getBrowserConfig(configWithNullProxy);

            expect(result).toEqual({
                headless: true,
                args: [],
            });
        });

        it('should handle empty string host and port', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: {
                    enabled: true,
                    host: '',
                    port: 0,
                },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            expect(result).toEqual({
                headless: true,
                args: [],
            });
        });

        it('should handle zero slowMo value', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
                slowMo: 0,
            };

            const result = Browser.getBrowserConfig(config);

            // slowMo: 0 is falsy, so it won't be added to the config
            expect(result).toEqual({
                headless: true,
                args: [],
            });
        });
    });

    describe('Integration tests', () => {
        it('should work with realistic browser configuration', async () => {
            const config: BrowserConfig = {
                headless: false,
                maximize: true,
                proxy: {
                    enabled: true,
                    host: 'localhost',
                    port: 8888,
                },
                instances: 3,
                slowMo: 200,
            };

            const result = await Browser.getBrowserInstance(config);

            expect(mockLaunch).toHaveBeenCalledTimes(1);
            expect(mockLaunch).toHaveBeenCalledWith({
                headless: false,
                args: [
                    '--start-maximized',
                    '--proxy-server=localhost:8888',
                    '--ignore-certificate-errors',
                ],
                slowMo: 200,
            });
            expect(result).toBe(mockBrowser);
        });

        it('should handle multiple browser instance creation', async () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            // Create multiple instances
            const browser1 = await Browser.getBrowserInstance(config);
            const browser2 = await Browser.getBrowserInstance(config);

            expect(mockLaunch).toHaveBeenCalledTimes(2);
            expect(browser1).toBe(mockBrowser);
            expect(browser2).toBe(mockBrowser);
        });
    });

    describe('Type safety', () => {
        it('should accept valid BrowserConfig types', () => {
            const validConfig: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
                slowMo: 100,
            };

            expect(() => Browser.getBrowserConfig(validConfig)).not.toThrow();
        });

        it('should return LaunchOptions type', () => {
            const config: BrowserConfig = {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
            };

            const result = Browser.getBrowserConfig(config);

            // TypeScript should ensure this is LaunchOptions
            expect(typeof result.headless).toBe('boolean');
            expect(Array.isArray(result.args)).toBe(true);
        });
    });
});
