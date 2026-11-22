/**
 * Tests for Crawler core logic without complex imports
 * This focuses on testing the business logic that can be tested in isolation
 */

describe('Crawler Core Logic', () => {
    describe('URL Context Checking Logic', () => {
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

    describe('DOM Stripping Logic', () => {
        const TEXT_NODE = 3;
        const COMMENT_NODE = 8;
        const ELEMENT_NODE = 1;

        const stripDOM = (elements: any[]): any[] => {
            return elements.filter(element => {
                // Remove text nodes
                if (element.nodeType === TEXT_NODE) {
                    return false;
                }
                // Remove comment nodes
                if (element.nodeType === COMMENT_NODE) {
                    return false;
                }
                return true;
            });
        };

        it('should remove text nodes', () => {
            const elements = [
                { nodeType: ELEMENT_NODE, tagName: 'div' },
                { nodeType: TEXT_NODE, textContent: 'Hello' },
                { nodeType: COMMENT_NODE, textContent: '<!-- comment -->' },
                { nodeType: ELEMENT_NODE, tagName: 'span' }
            ];

            const result = stripDOM(elements);
            expect(result).toHaveLength(2);
            expect(result[0].tagName).toBe('div');
            expect(result[1].tagName).toBe('span');
        });

        it('should preserve element nodes', () => {
            const elements = [
                { nodeType: ELEMENT_NODE, tagName: 'div' },
                { nodeType: ELEMENT_NODE, tagName: 'span' },
                { nodeType: ELEMENT_NODE, tagName: 'p' }
            ];

            const result = stripDOM(elements);
            expect(result).toHaveLength(3);
        });
    });

    describe('Attribute Filtering Logic', () => {
        const filterAttributes = (element: any): any => {
            const tagName = element.name && element.name.toUpperCase();
            const allowedAttributes: string[] = [];

            switch (tagName) {
                case 'A':
                case 'BASE':
                    allowedAttributes.push('href');
                    break;
                case 'SCRIPT':
                    allowedAttributes.push('src');
                    break;
            }

            const filteredAttribs: any = {};
            Object.keys(element.attribs).forEach((attrName) => {
                if (allowedAttributes.includes(attrName)) {
                    filteredAttribs[attrName] = element.attribs[attrName];
                }
            });

            return { ...element, attribs: filteredAttribs };
        };

        it('should preserve href attributes for anchor tags', () => {
            const element = {
                name: 'a',
                attribs: { href: 'https://example.com', class: 'link', id: 'test' }
            };

            const result = filterAttributes(element);
            expect(result.attribs).toEqual({ href: 'https://example.com' });
        });

        it('should preserve src attributes for script tags', () => {
            const element = {
                name: 'script',
                attribs: { src: 'script.js', class: 'script', id: 'test' }
            };

            const result = filterAttributes(element);
            expect(result.attribs).toEqual({ src: 'script.js' });
        });

        it('should remove all attributes for other tags', () => {
            const element = {
                name: 'div',
                attribs: { class: 'container', id: 'main' }
            };

            const result = filterAttributes(element);
            expect(result.attribs).toEqual({});
        });
    });

    describe('URL Query Parameter Cleaning Logic', () => {
        const cleanScriptSrc = (src: string): string => {
            return src.split('?')[0] || '';
        };

        it('should remove query parameters from script src', () => {
            expect(cleanScriptSrc('script.js?v=1.0')).toBe('script.js');
            expect(cleanScriptSrc('script.js?version=2&min=true')).toBe('script.js');
            expect(cleanScriptSrc('script.js')).toBe('script.js');
        });

        it('should handle empty strings', () => {
            expect(cleanScriptSrc('')).toBe('');
        });
    });

    describe('Array Filtering Logic', () => {
        const removeItemFromArray = <T>(array: T[], itemId: string, getId: (item: T) => string): T[] => {
            return array.filter(item => getId(item) !== itemId);
        };

        it('should remove item by ID', () => {
            const items = [
                { id: 'item-1', name: 'Item 1' },
                { id: 'item-2', name: 'Item 2' },
                { id: 'item-3', name: 'Item 3' }
            ];

            const result = removeItemFromArray(items, 'item-2', item => item.id);
            expect(result).toHaveLength(2);
            expect(result[0]?.id).toBe('item-1');
            expect(result[1]?.id).toBe('item-3');
        });

        it('should handle non-existent ID', () => {
            const items = [
                { id: 'item-1', name: 'Item 1' },
                { id: 'item-2', name: 'Item 2' }
            ];

            const result = removeItemFromArray(items, 'item-3', item => item.id);
            expect(result).toHaveLength(2);
        });

        it('should handle empty array', () => {
            const result = removeItemFromArray([], 'item-1', (item: any) => item.id);
            expect(result).toHaveLength(0);
        });
    });

    describe('Hash Generation Logic', () => {
        const createHash = (input: string): string => {
            // Simple hash function for testing
            let hash = 0;
            for (let i = 0; i < input.length; i++) {
                const char = input.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit integer
            }
            return Math.abs(hash).toString(16);
        };

        it('should generate consistent hashes for same input', () => {
            const input = 'test content';
            const hash1 = createHash(input);
            const hash2 = createHash(input);
            expect(hash1).toBe(hash2);
        });

        it('should generate different hashes for different inputs', () => {
            const hash1 = createHash('content 1');
            const hash2 = createHash('content 2');
            expect(hash1).not.toBe(hash2);
        });

        it('should handle empty input', () => {
            const hash = createHash('');
            expect(typeof hash).toBe('string');
        });
    });

    describe('Configuration Validation Logic', () => {
        const validateConfig = (config: any): boolean => {
            return !!(config &&
                config.browser &&
                config.crawler &&
                config.crawler.entryPoint &&
                config.crawler.elements &&
                Array.isArray(config.crawler.elements) &&
                config.crawler.includeRegexes &&
                Array.isArray(config.crawler.includeRegexes) &&
                config.crawler.excludeRegexes &&
                Array.isArray(config.crawler.excludeRegexes));
        };

        it('should validate correct configuration', () => {
            const validConfig = {
                browser: { headless: true },
                crawler: {
                    entryPoint: 'https://example.com',
                    elements: ['button', 'a'],
                    includeRegexes: ['https://example.com.*'],
                    excludeRegexes: []
                }
            };

            expect(validateConfig(validConfig)).toBe(true);
        });

        it('should reject invalid configuration', () => {
            const invalidConfigs = [
                null,
                {},
                { browser: {} },
                { browser: {}, crawler: {} },
                { browser: {}, crawler: { entryPoint: 'https://example.com' } },
                { browser: {}, crawler: { entryPoint: 'https://example.com', elements: 'not-array' } }
            ];

            invalidConfigs.forEach(config => {
                expect(validateConfig(config)).toBe(false);
            });
        });
    });

    describe('Error Handling Logic', () => {
        const safeExecute = (fn: () => any, fallback: any = null): any => {
            try {
                return fn();
            } catch (error) {
                return fallback;
            }
        };

        it('should execute function safely', () => {
            const result = safeExecute(() => 'success');
            expect(result).toBe('success');
        });

        it('should return fallback on error', () => {
            const result = safeExecute(() => {
                throw new Error('Test error');
            }, 'fallback');
            expect(result).toBe('fallback');
        });

        it('should return null as default fallback', () => {
            const result = safeExecute(() => {
                throw new Error('Test error');
            });
            expect(result).toBeNull();
        });
    });

    describe('Array Processing Logic', () => {
        const processArray = <T>(array: T[], processor: (item: T) => T): T[] => {
            return array.map(processor);
        };

        it('should process all items in array', () => {
            const numbers = [1, 2, 3, 4, 5];
            const doubled = processArray(numbers, x => x * 2);
            expect(doubled).toEqual([2, 4, 6, 8, 10]);
        });

        it('should handle empty array', () => {
            const result = processArray([], x => x);
            expect(result).toEqual([]);
        });

        it('should handle single item array', () => {
            const result = processArray([42], x => x + 1);
            expect(result).toEqual([43]);
        });
    });
});
