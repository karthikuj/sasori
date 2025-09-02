/**
 * Jest test setup file
 * This file runs before all tests
 */

// Set test environment variables
process.env.NODE_ENV = 'test';

// Mock console methods to reduce noise in tests
global.console = {
    ...console,
    // Uncomment to suppress console.log during tests
    // log: jest.fn(),
    // debug: jest.fn(),
    // info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

// Global test utilities
(global as any).testUtils = {
    // Helper to create valid config objects
    createValidConfig: () => ({
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
    }),
};

// Extend Jest matchers if needed
expect.extend({
    // Custom matcher for configuration validation
    toBeValidConfig(received) {
        const pass = typeof received === 'object' &&
            received !== null &&
            received.browser &&
            received.crawler;

        if (pass) {
            return {
                message: () => `expected ${received} not to be a valid config object`,
                pass: true,
            };
        } else {
            return {
                message: () => `expected ${received} to be a valid config object`,
                pass: false,
            };
        }
    },
});

// Type declarations for global test utilities are in types/test.d.ts
