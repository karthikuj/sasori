import CrawlState from '../../src/crawler/crawlState';

// Mock crypto module
jest.mock('crypto', () => ({
    randomUUID: jest.fn(() => 'test-uuid-123')
}));

describe('CrawlState', () => {
    let mockCrawlInputs: any[];
    let mockCrawlActions: any[];

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Create mock crawl inputs
        mockCrawlInputs = [
            {
                inputId: 'input-1',
                element: 'input',
                type: 'text',
                cssPath: 'input[type="text"]',
                parentState: null
            },
            {
                inputId: 'input-2',
                element: 'textarea',
                type: null,
                cssPath: 'textarea',
                parentState: null
            }
        ];

        // Create mock crawl actions
        mockCrawlActions = [
            {
                actionId: 'action-1',
                element: 'button',
                action: 'click',
                cssPath: '#submit-btn',
                actionHash: 'action-hash-1',
                parentState: null,
                childState: null
            },
            {
                actionId: 'action-2',
                element: 'a',
                action: 'click',
                cssPath: 'a[href="/next"]',
                actionHash: 'action-hash-2',
                parentState: null,
                childState: null
            }
        ];
    });

    describe('Constructor', () => {
        it('should create CrawlState with valid parameters', () => {
            const crawlState = new CrawlState(
                'https://example.com',
                'state-hash-123',
                1,
                mockCrawlInputs,
                mockCrawlActions
            );

            expect(crawlState.stateId).toBe('test-uuid-123');
            expect(crawlState.url).toBe('https://example.com');
            expect(crawlState.stateHash).toBe('state-hash-123');
            expect(crawlState.crawlDepth).toBe(1);
            expect(crawlState.crawlInputs).toEqual(mockCrawlInputs);
            expect(crawlState.crawlActions).toEqual(mockCrawlActions);
        });

        it('should create CrawlState with empty arrays when not provided', () => {
            const crawlState = new CrawlState(
                'https://example.com',
                'state-hash-123',
                0
            );

            expect(crawlState.crawlInputs).toEqual([]);
            expect(crawlState.crawlActions).toEqual([]);
        });

        it('should throw error for empty URL', () => {
            expect(() => {
                new CrawlState('', 'state-hash-123', 1);
            }).toThrow('URL must be a non-empty string');
        });

        it('should throw error for null URL', () => {
            expect(() => {
                new CrawlState(null as any, 'state-hash-123', 1);
            }).toThrow('URL must be a non-empty string');
        });

        it('should throw error for undefined URL', () => {
            expect(() => {
                new CrawlState(undefined as any, 'state-hash-123', 1);
            }).toThrow('URL must be a non-empty string');
        });

        it('should throw error for whitespace-only URL', () => {
            expect(() => {
                new CrawlState('   ', 'state-hash-123', 1);
            }).toThrow('URL must be a non-empty string');
        });

        it('should throw error for non-string URL', () => {
            expect(() => {
                new CrawlState(123 as any, 'state-hash-123', 1);
            }).toThrow('URL must be a non-empty string');
        });

        it('should throw error for empty stateHash', () => {
            expect(() => {
                new CrawlState('https://example.com', '', 1);
            }).toThrow('State hash must be a non-empty string');
        });

        it('should throw error for null stateHash', () => {
            expect(() => {
                new CrawlState('https://example.com', null as any, 1);
            }).toThrow('State hash must be a non-empty string');
        });

        it('should throw error for undefined stateHash', () => {
            expect(() => {
                new CrawlState('https://example.com', undefined as any, 1);
            }).toThrow('State hash must be a non-empty string');
        });

        it('should throw error for whitespace-only stateHash', () => {
            expect(() => {
                new CrawlState('https://example.com', '   ', 1);
            }).toThrow('State hash must be a non-empty string');
        });

        it('should throw error for non-string stateHash', () => {
            expect(() => {
                new CrawlState('https://example.com', 123 as any, 1);
            }).toThrow('State hash must be a non-empty string');
        });

        it('should throw error for negative crawlDepth', () => {
            expect(() => {
                new CrawlState('https://example.com', 'state-hash-123', -1);
            }).toThrow('Crawl depth must be a non-negative integer');
        });

        it('should throw error for non-integer crawlDepth', () => {
            expect(() => {
                new CrawlState('https://example.com', 'state-hash-123', 1.5);
            }).toThrow('Crawl depth must be a non-negative integer');
        });

        it('should throw error for non-number crawlDepth', () => {
            expect(() => {
                new CrawlState('https://example.com', 'state-hash-123', '1' as any);
            }).toThrow('Crawl depth must be a non-negative integer');
        });

        it('should accept zero crawlDepth', () => {
            expect(() => {
                new CrawlState('https://example.com', 'state-hash-123', 0);
            }).not.toThrow();
        });
    });

    describe('Instance Methods', () => {
        let crawlState: CrawlState;

        beforeEach(() => {
            crawlState = new CrawlState(
                'https://example.com',
                'state-hash-123',
                2,
                mockCrawlInputs,
                mockCrawlActions
            );
        });

        describe('getCrawlActions', () => {
            it('should return the crawl actions', () => {
                expect(crawlState.getCrawlActions()).toEqual(mockCrawlActions);
            });

            it('should return the same reference', () => {
                const actions = crawlState.getCrawlActions();
                expect(actions).toBe(mockCrawlActions);
            });
        });

        describe('getCrawlDepth', () => {
            it('should return the crawl depth', () => {
                expect(crawlState.getCrawlDepth()).toBe(2);
            });
        });

        describe('getCrawlInputs', () => {
            it('should return the crawl inputs', () => {
                expect(crawlState.getCrawlInputs()).toEqual(mockCrawlInputs);
            });

            it('should return the same reference', () => {
                const inputs = crawlState.getCrawlInputs();
                expect(inputs).toBe(mockCrawlInputs);
            });
        });
    });

    describe('Utility Methods', () => {
        let crawlState: CrawlState;

        beforeEach(() => {
            crawlState = new CrawlState(
                'https://example.com/products',
                'products-state-hash',
                3,
                mockCrawlInputs,
                mockCrawlActions
            );
        });

        describe('toString', () => {
            it('should return string representation', () => {
                const result = crawlState.toString();
                expect(result).toBe('CrawlState(https://example.com/products@depth:3)');
            });

            it('should include URL and depth in string representation', () => {
                const result = crawlState.toString();
                expect(result).toContain('https://example.com/products');
                expect(result).toContain('depth:3');
            });
        });

        describe('toJSON', () => {
            it('should return JSON representation', () => {
                const result = crawlState.toJSON();

                expect(result).toEqual({
                    stateId: 'test-uuid-123',
                    url: 'https://example.com/products',
                    stateHash: 'products-state-hash',
                    crawlDepth: 3,
                    crawlInputs: mockCrawlInputs,
                    crawlActions: mockCrawlActions,
                });
            });

            it('should return a new object each time', () => {
                const json1 = crawlState.toJSON();
                const json2 = crawlState.toJSON();

                expect(json1).toEqual(json2);
                expect(json1).not.toBe(json2); // Different object references
            });
        });
    });

    describe('Property Immutability', () => {
        let crawlState: CrawlState;

        beforeEach(() => {
            crawlState = new CrawlState(
                'https://example.com',
                'state-hash-123',
                1,
                mockCrawlInputs,
                mockCrawlActions
            );
        });

        it('should have readonly stateId (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlState.stateId;
            (crawlState as any).stateId = 'new-id';
            expect(crawlState.stateId).toBe('new-id');
            // Restore original value
            (crawlState as any).stateId = originalValue;
        });

        it('should have readonly url (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlState.url;
            (crawlState as any).url = 'https://new-url.com';
            expect(crawlState.url).toBe('https://new-url.com');
            // Restore original value
            (crawlState as any).url = originalValue;
        });

        it('should have readonly stateHash (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlState.stateHash;
            (crawlState as any).stateHash = 'new-hash';
            expect(crawlState.stateHash).toBe('new-hash');
            // Restore original value
            (crawlState as any).stateHash = originalValue;
        });

        it('should have readonly crawlDepth (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlState.crawlDepth;
            (crawlState as any).crawlDepth = 999;
            expect(crawlState.crawlDepth).toBe(999);
            // Restore original value
            (crawlState as any).crawlDepth = originalValue;
        });

        it('should have readonly crawlInputs (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlState.crawlInputs;
            (crawlState as any).crawlInputs = [];
            expect(crawlState.crawlInputs).toEqual([]);
            // Restore original value
            (crawlState as any).crawlInputs = originalValue;
        });

        it('should have readonly crawlActions (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlState.crawlActions;
            (crawlState as any).crawlActions = [];
            expect(crawlState.crawlActions).toEqual([]);
            // Restore original value
            (crawlState as any).crawlActions = originalValue;
        });
    });

    describe('Edge Cases', () => {
        it('should handle very long URLs', () => {
            const longUrl = 'https://example.com/' + 'a'.repeat(1000);
            expect(() => {
                new CrawlState(longUrl, 'state-hash-123', 1);
            }).not.toThrow();
        });

        it('should handle very long state hashes', () => {
            const longHash = 'hash-' + 'a'.repeat(1000);
            expect(() => {
                new CrawlState('https://example.com', longHash, 1);
            }).not.toThrow();
        });

        it('should handle special characters in URL', () => {
            const specialUrl = 'https://example.com/path?query=value&other=test#fragment';
            expect(() => {
                new CrawlState(specialUrl, 'state-hash-123', 1);
            }).not.toThrow();
        });

        it('should handle special characters in state hash', () => {
            const specialHash = 'hash-with-special-chars-!@#$%^&*()';
            expect(() => {
                new CrawlState('https://example.com', specialHash, 1);
            }).not.toThrow();
        });

        it('should handle unicode characters in URL', () => {
            const unicodeUrl = 'https://example.com/中文路径';
            expect(() => {
                new CrawlState(unicodeUrl, 'state-hash-123', 1);
            }).not.toThrow();
        });

        it('should handle unicode characters in state hash', () => {
            const unicodeHash = 'hash-中文';
            expect(() => {
                new CrawlState('https://example.com', unicodeHash, 1);
            }).not.toThrow();
        });
    });

    describe('Integration Tests', () => {
        it('should work with realistic crawler scenario', () => {
            const crawlState = new CrawlState(
                'https://example.com/products',
                'products-state-hash',
                1,
                mockCrawlInputs,
                mockCrawlActions
            );

            expect(crawlState.url).toBe('https://example.com/products');
            expect(crawlState.stateHash).toBe('products-state-hash');
            expect(crawlState.crawlDepth).toBe(1);
            expect(crawlState.getCrawlInputs()).toEqual(mockCrawlInputs);
            expect(crawlState.getCrawlActions()).toEqual(mockCrawlActions);
        });

        it('should maintain state consistency across operations', () => {
            const crawlState = new CrawlState(
                'https://example.com',
                'state-hash-123',
                2,
                mockCrawlInputs,
                mockCrawlActions
            );

            // Test getters return consistent data
            expect(crawlState.getCrawlInputs()).toBe(crawlState.crawlInputs);
            expect(crawlState.getCrawlActions()).toBe(crawlState.crawlActions);
            expect(crawlState.getCrawlDepth()).toBe(crawlState.crawlDepth);

            // Test JSON representation includes all data
            const json = crawlState.toJSON();
            expect(json.url).toBe(crawlState.url);
            expect(json.stateHash).toBe(crawlState.stateHash);
            expect(json.crawlDepth).toBe(crawlState.crawlDepth);
            expect(json.crawlInputs).toBe(crawlState.crawlInputs);
            expect(json.crawlActions).toBe(crawlState.crawlActions);
        });
    });
});
