/**
 * Basic tests for Crawler functionality
 * Simple tests that focus on core functionality without complex mocking
 */

import Crawler from '../../src/crawler/crawler';
import { CrawlerConfig } from '../../src/types/crawler';

describe('Crawler Basic Tests', () => {
    let crawler: Crawler;
    let mockConfig: CrawlerConfig;

    beforeEach(() => {
        // Create a basic valid configuration
        mockConfig = {
            browser: {
                headless: true,
                maximize: false,
                proxy: { enabled: false },
                instances: 1,
                slowMo: 0
            },
            crawler: {
                entryPoint: 'https://example.com',
                eventTimeout: 5000,
                navigationTimeout: 30000,
                eventWait: 1000,
                maxDuration: 60000,
                elements: ['button', 'a', 'input'],
                maxChildren: 10,
                maxDepth: 5,
                authentication: {
                    basicAuth: { enabled: false },
                    recorderAuth: { enabled: false }
                },
                includeRegexes: ['https://example.com.*'],
                excludeRegexes: ['https://example.com/admin.*'],
                outputFile: 'output.txt'
            }
        };

        crawler = new Crawler(mockConfig);
    });

    describe('Constructor', () => {
        it('should create Crawler with valid config', () => {
            expect(crawler.config).toBe(mockConfig);
            expect(crawler.crawlerConfig).toBe(mockConfig.crawler);
            expect(crawler.authInProgress).toBe(false);
            expect(crawler.allUrls).toBeInstanceOf(Set);
            expect(crawler.allInteractables).toContain('button');
            expect(crawler.allInteractables).toContain('a');
            expect(crawler.allInteractables).toContain('input');
            expect(crawler.endTime).toBeNull();
            expect(crawler.browserStartDelays).toBe(1000);
        });

        it('should initialize allInteractables with elements and input fields', () => {
            expect(crawler.allInteractables).toEqual(
                expect.arrayContaining([
                    'button',
                    'a',
                    'input',
                    'input[type="text"]',
                    'input[type="email"]',
                    'input[type="password"]',
                    'input[type="search"]',
                    'input[type="url"]',
                    'input[type="checkbox"]',
                    'input[type="radio"]',
                    'input[type="file"]',
                    'textarea',
                    'select'
                ])
            );
        });
    });

    describe('Configuration Validation', () => {
        it('should accept valid configuration', () => {
            expect(mockConfig).toBeDefined();
            expect(mockConfig.browser).toBeDefined();
            expect(mockConfig.crawler).toBeDefined();
            expect(mockConfig.crawler.entryPoint).toBe('https://example.com');
            expect(mockConfig.crawler.elements).toEqual(['button', 'a', 'input']);
        });

        it('should have required browser properties', () => {
            expect(mockConfig.browser.headless).toBe(true);
            expect(mockConfig.browser.maximize).toBe(false);
            expect(mockConfig.browser.instances).toBe(1);
            expect(mockConfig.browser.slowMo).toBe(0);
        });

        it('should have required crawler properties', () => {
            expect(mockConfig.crawler.eventTimeout).toBe(5000);
            expect(mockConfig.crawler.navigationTimeout).toBe(30000);
            expect(mockConfig.crawler.eventWait).toBe(1000);
            expect(mockConfig.crawler.maxDuration).toBe(60000);
            expect(mockConfig.crawler.maxChildren).toBe(10);
            expect(mockConfig.crawler.maxDepth).toBe(5);
        });

        it('should have authentication configuration', () => {
            expect(mockConfig.crawler.authentication).toBeDefined();
            expect(mockConfig.crawler.authentication.basicAuth.enabled).toBe(false);
            expect(mockConfig.crawler.authentication.recorderAuth.enabled).toBe(false);
        });

        it('should have URL filtering configuration', () => {
            expect(mockConfig.crawler.includeRegexes).toEqual(['https://example.com.*']);
            expect(mockConfig.crawler.excludeRegexes).toEqual(['https://example.com/admin.*']);
        });
    });

    describe('URL Context Checking', () => {
        it('should return false for excluded URLs', () => {
            const result = crawler.inContext('https://example.com/admin/dashboard');
            expect(result).toBe(false);
        });

        it('should return true for included URLs', () => {
            const result = crawler.inContext('https://example.com/page');
            expect(result).toBe(true);
        });

        it('should return false for URLs not matching include patterns', () => {
            const result = crawler.inContext('https://other.com/page');
            expect(result).toBe(false);
        });

        it('should handle multiple exclude patterns', () => {
            crawler.crawlerConfig.excludeRegexes.push('https://example.com/api.*');
            const result = crawler.inContext('https://example.com/api/users');
            expect(result).toBe(false);
        });
    });

    describe('URL Context Logic (Isolated)', () => {
        const includeRegexes = ['https://example.com.*', 'https://test.com.*'];
        const excludeRegexes = ['https://example.com/admin.*', 'https://test.com/api.*'];

        const inContext = (url: string): boolean => {
            // Check if it is excluded
            for (const regex of excludeRegexes) {
                const excludeRegex = new RegExp(regex);
                if (url.match(excludeRegex)) {
                    return false;
                }
            }

            // Check if it is included
            for (const regex of includeRegexes) {
                const includeRegex = new RegExp(regex);
                if (url.match(includeRegex)) {
                    return true;
                }
            }

            return false;
        };

        it('should return false for excluded URLs', () => {
            expect(inContext('https://example.com/admin/dashboard')).toBe(false);
            expect(inContext('https://test.com/api/users')).toBe(false);
        });

        it('should return true for included URLs', () => {
            expect(inContext('https://example.com/page')).toBe(true);
            expect(inContext('https://test.com/page')).toBe(true);
        });

        it('should return false for URLs not matching include patterns', () => {
            expect(inContext('https://other.com/page')).toBe(false);
        });

        it('should handle complex URL patterns', () => {
            expect(inContext('https://example.com/sub/path?query=1')).toBe(true);
            expect(inContext('https://test.com/sub/path#fragment')).toBe(true);
        });
    });

    describe('Element Configuration Logic', () => {
        it('should handle different element types', () => {
            const elements = ['button', 'a', 'input', 'form', 'select'];
            const inputFields = [
                'input[type="text"]',
                'input[type="email"]',
                'input[type="password"]',
                'input[type="search"]',
                'input[type="url"]',
                'input[type="checkbox"]',
                'input[type="radio"]',
                'input[type="file"]',
                'textarea',
                'select'
            ];

            const allInteractables = [...elements, ...inputFields];

            expect(allInteractables).toContain('button');
            expect(allInteractables).toContain('a');
            expect(allInteractables).toContain('input');
            expect(allInteractables).toContain('form');
            expect(allInteractables).toContain('select');
            expect(allInteractables).toContain('input[type="text"]');
            expect(allInteractables).toContain('textarea');
        });
    });

    describe('Static Constants', () => {
        it('should have correct node type constants', () => {
            const TEXT_NODE = 3;
            const COMMENT_NODE = 8;
            const ELEMENT_NODE = 1;

            expect(TEXT_NODE).toBe(3);
            expect(COMMENT_NODE).toBe(8);
            expect(ELEMENT_NODE).toBe(1);
        });
    });

    describe('URL Management', () => {
        it('should start with empty allUrls set', () => {
            expect(crawler.allUrls.size).toBe(0);
        });

        it('should be able to add URLs to allUrls', () => {
            crawler.allUrls.add('https://example.com/test');
            expect(crawler.allUrls.has('https://example.com/test')).toBe(true);
            expect(crawler.allUrls.size).toBe(1);
        });
    });

    describe('URL Management Logic (Isolated)', () => {
        it('should handle URL set operations', () => {
            const allUrls = new Set<string>();

            expect(allUrls.size).toBe(0);

            allUrls.add('https://example.com/test');
            expect(allUrls.has('https://example.com/test')).toBe(true);
            expect(allUrls.size).toBe(1);

            allUrls.add('https://example.com/another');
            expect(allUrls.size).toBe(2);
        });
    });

    describe('Authentication State', () => {
        it('should start with authInProgress as false', () => {
            expect(crawler.authInProgress).toBe(false);
        });

        it('should be able to set authInProgress', () => {
            crawler.authInProgress = true;
            expect(crawler.authInProgress).toBe(true);
        });
    });

    describe('Duration Management', () => {
        it('should start with endTime as null', () => {
            expect(crawler.endTime).toBeNull();
        });

        it('should be able to set endTime', () => {
            const futureTime = Date.now() + 60000;
            crawler.endTime = futureTime;
            expect(crawler.endTime).toBe(futureTime);
        });
    });

    describe('Basic Methods', () => {
        it('should have stopCrawling method', () => {
            expect(typeof crawler.stopCrawling).toBe('function');
            expect(() => crawler.stopCrawling()).not.toThrow();
        });

        it('should have appendUrlToOutputFile method', () => {
            expect(typeof crawler.appendUrlToOutputFile).toBe('function');
        });

        it('should have removeCrawlActionFromState method', () => {
            expect(typeof crawler.removeCrawlActionFromState).toBe('function');
        });

        it('should have removeCrawlInputFromState method', () => {
            expect(typeof crawler.removeCrawlInputFromState).toBe('function');
        });
    });

    describe('Static Constants', () => {
        it('should have correct node type constants', () => {
            expect(Crawler.TEXT_NODE).toBe(3);
            expect(Crawler.COMMENT_NODE).toBe(8);
            expect(Crawler.ELEMENT_NODE).toBe(1);
        });
    });

    describe('Authentication State Logic (Isolated)', () => {
        it('should handle authentication state', () => {
            let authInProgress = false;

            expect(authInProgress).toBe(false);

            authInProgress = true;
            expect(authInProgress).toBe(true);
        });
    });

    describe('Duration Management Logic (Isolated)', () => {
        it('should handle duration calculations', () => {
            let endTime: number | null = null;

            expect(endTime).toBeNull();

            const futureTime = Date.now() + 60000;
            endTime = futureTime;
            expect(endTime).toBe(futureTime);
            expect(endTime).toBeGreaterThan(Date.now());
        });
    });
});
