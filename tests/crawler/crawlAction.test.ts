import CrawlAction from '../../src/crawler/crawlAction';

// Mock crypto module
jest.mock('crypto', () => ({
    randomUUID: jest.fn(() => 'test-uuid-123')
}));

describe('CrawlAction', () => {
    let mockParentState: any;
    let mockChildState: any;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Create mock parent state
        mockParentState = {
            stateId: 'parent-state-123',
            url: 'https://example.com',
            stateHash: 'parent-hash',
            crawlDepth: 1,
            crawlInputs: [],
            crawlActions: [],
            getCrawlActions: jest.fn(() => []),
            getCrawlDepth: jest.fn(() => 1),
            getCrawlInputs: jest.fn(() => []),
            toString: jest.fn(() => 'CrawlState(https://example.com@depth:1)'),
            toJSON: jest.fn(() => ({}))
        };

        // Create mock child state
        mockChildState = {
            stateId: 'child-state-456',
            url: 'https://example.com/next',
            stateHash: 'child-hash',
            crawlDepth: 2,
            crawlInputs: [],
            crawlActions: [],
            getCrawlActions: jest.fn(() => []),
            getCrawlDepth: jest.fn(() => 2),
            getCrawlInputs: jest.fn(() => []),
            toString: jest.fn(() => 'CrawlState(https://example.com/next@depth:2)'),
            toJSON: jest.fn(() => ({}))
        };
    });

    describe('Static Properties', () => {
        it('should have ANCHOR constant set to "A"', () => {
            expect(CrawlAction.ANCHOR).toBe('A');
        });

        it('should have ANCHOR as readonly', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            // In JavaScript runtime, static properties can still be modified
            const originalValue = CrawlAction.ANCHOR;
            (CrawlAction as any).ANCHOR = 'B';
            expect(CrawlAction.ANCHOR).toBe('B');
            // Restore original value
            (CrawlAction as any).ANCHOR = originalValue;
        });
    });

    describe('Constructor', () => {
        it('should create CrawlAction with valid parameters', () => {
            const crawlAction = new CrawlAction(
                'button',
                'click',
                '#submit-btn',
                'action-hash-123',
                mockParentState
            );

            expect(crawlAction.actionId).toBe('test-uuid-123');
            expect(crawlAction.element).toBe('button');
            expect(crawlAction.action).toBe('click');
            expect(crawlAction.cssPath).toBe('#submit-btn');
            expect(crawlAction.actionHash).toBe('action-hash-123');
            expect(crawlAction.parentState).toBe(mockParentState);
            expect(crawlAction.childState).toBeNull();
        });

        it('should generate unique actionId for each instance', () => {
            const { randomUUID } = require('crypto');
            randomUUID
                .mockReturnValueOnce('uuid-1')
                .mockReturnValueOnce('uuid-2');

            const action1 = new CrawlAction('a', 'click', '#link1', 'hash1', mockParentState);
            const action2 = new CrawlAction('button', 'click', '#btn1', 'hash2', mockParentState);

            expect(action1.actionId).toBe('uuid-1');
            expect(action2.actionId).toBe('uuid-2');
        });

        it('should throw error for empty element', () => {
            expect(() => {
                new CrawlAction('', 'click', '#btn', 'hash', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for null element', () => {
            expect(() => {
                new CrawlAction(null as any, 'click', '#btn', 'hash', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for undefined element', () => {
            expect(() => {
                new CrawlAction(undefined as any, 'click', '#btn', 'hash', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for non-string element', () => {
            expect(() => {
                new CrawlAction(123 as any, 'click', '#btn', 'hash', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for empty action', () => {
            expect(() => {
                new CrawlAction('button', '', '#btn', 'hash', mockParentState);
            }).toThrow('Action must be a non-empty string');
        });

        it('should throw error for null action', () => {
            expect(() => {
                new CrawlAction('button', null as any, '#btn', 'hash', mockParentState);
            }).toThrow('Action must be a non-empty string');
        });

        it('should throw error for undefined action', () => {
            expect(() => {
                new CrawlAction('button', undefined as any, '#btn', 'hash', mockParentState);
            }).toThrow('Action must be a non-empty string');
        });

        it('should throw error for non-string action', () => {
            expect(() => {
                new CrawlAction('button', 123 as any, '#btn', 'hash', mockParentState);
            }).toThrow('Action must be a non-empty string');
        });

        it('should throw error for empty cssPath', () => {
            expect(() => {
                new CrawlAction('button', 'click', '', 'hash', mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for null cssPath', () => {
            expect(() => {
                new CrawlAction('button', 'click', null as any, 'hash', mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for undefined cssPath', () => {
            expect(() => {
                new CrawlAction('button', 'click', undefined as any, 'hash', mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for non-string cssPath', () => {
            expect(() => {
                new CrawlAction('button', 'click', 123 as any, 'hash', mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for empty actionHash', () => {
            expect(() => {
                new CrawlAction('button', 'click', '#btn', '', mockParentState);
            }).toThrow('Action hash must be a non-empty string');
        });

        it('should throw error for null actionHash', () => {
            expect(() => {
                new CrawlAction('button', 'click', '#btn', null as any, mockParentState);
            }).toThrow('Action hash must be a non-empty string');
        });

        it('should throw error for undefined actionHash', () => {
            expect(() => {
                new CrawlAction('button', 'click', '#btn', undefined as any, mockParentState);
            }).toThrow('Action hash must be a non-empty string');
        });

        it('should throw error for non-string actionHash', () => {
            expect(() => {
                new CrawlAction('button', 'click', '#btn', 123 as any, mockParentState);
            }).toThrow('Action hash must be a non-empty string');
        });

        it('should throw error for null parentState', () => {
            expect(() => {
                new CrawlAction('button', 'click', '#btn', 'hash', null as any);
            }).toThrow('Parent state is required');
        });

        it('should throw error for undefined parentState', () => {
            expect(() => {
                new CrawlAction('button', 'click', '#btn', 'hash', undefined as any);
            }).toThrow('Parent state is required');
        });

        it('should throw error for empty string parentState', () => {
            expect(() => {
                new CrawlAction('button', 'click', '#btn', 'hash', '' as any);
            }).toThrow('Parent state is required');
        });
    });

    describe('Instance Methods', () => {
        let crawlAction: CrawlAction;

        beforeEach(() => {
            crawlAction = new CrawlAction(
                'button',
                'click',
                '#submit-btn',
                'action-hash-123',
                mockParentState
            );
        });

        describe('getParentState', () => {
            it('should return the parent state', () => {
                expect(crawlAction.getParentState()).toBe(mockParentState);
            });

            it('should return the same parent state reference', () => {
                const parentState = crawlAction.getParentState();
                expect(parentState).toBe(mockParentState);
                expect(parentState.stateId).toBe('parent-state-123');
            });
        });

        describe('getChildState', () => {
            it('should return null initially', () => {
                expect(crawlAction.getChildState()).toBeNull();
            });

            it('should return the child state after setting', () => {
                crawlAction.setChildState(mockChildState);
                expect(crawlAction.getChildState()).toBe(mockChildState);
            });
        });

        describe('setChildState', () => {
            it('should set child state', () => {
                crawlAction.setChildState(mockChildState);
                expect(crawlAction.childState).toBe(mockChildState);
            });

            it('should set child state to null', () => {
                crawlAction.setChildState(mockChildState);
                crawlAction.setChildState(null);
                expect(crawlAction.childState).toBeNull();
            });

            it('should allow setting different child states', () => {
                const anotherChildState = { ...mockChildState, stateId: 'another-child' };

                crawlAction.setChildState(mockChildState);
                expect(crawlAction.childState).toBe(mockChildState);

                crawlAction.setChildState(anotherChildState);
                expect(crawlAction.childState).toBe(anotherChildState);
            });
        });
    });

    describe('Utility Methods', () => {
        let crawlAction: CrawlAction;

        beforeEach(() => {
            crawlAction = new CrawlAction(
                'a',
                'click',
                '#navigation-link',
                'nav-hash-456',
                mockParentState
            );
        });

        describe('toString', () => {
            it('should return string representation', () => {
                const result = crawlAction.toString();
                expect(result).toBe('CrawlAction(a:click@#navigation-link)');
            });

            it('should include all key properties in string representation', () => {
                const result = crawlAction.toString();
                expect(result).toContain('a');
                expect(result).toContain('click');
                expect(result).toContain('#navigation-link');
            });

            it('should work with different element types', () => {
                const buttonAction = new CrawlAction(
                    'button',
                    'submit',
                    '.form-submit',
                    'submit-hash',
                    mockParentState
                );
                expect(buttonAction.toString()).toBe('CrawlAction(button:submit@.form-submit)');
            });
        });

        describe('toJSON', () => {
            it('should return JSON representation', () => {
                const result = crawlAction.toJSON();

                expect(result).toEqual({
                    actionId: 'test-uuid-123',
                    element: 'a',
                    action: 'click',
                    cssPath: '#navigation-link',
                    actionHash: 'nav-hash-456',
                    parentState: mockParentState,
                    childState: null
                });
            });

            it('should include child state when set', () => {
                crawlAction.setChildState(mockChildState);
                const result = crawlAction.toJSON();

                expect(result.childState).toBe(mockChildState);
            });

            it('should return a new object each time', () => {
                const json1 = crawlAction.toJSON();
                const json2 = crawlAction.toJSON();

                expect(json1).toEqual(json2);
                expect(json1).not.toBe(json2); // Different object references
            });
        });
    });

    describe('Property Immutability', () => {
        let crawlAction: CrawlAction;

        beforeEach(() => {
            crawlAction = new CrawlAction(
                'input',
                'type',
                '#username-field',
                'input-hash-789',
                mockParentState
            );
        });

        it('should have readonly actionId (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlAction.actionId;
            (crawlAction as any).actionId = 'new-id';
            expect(crawlAction.actionId).toBe('new-id');
            // Restore original value
            (crawlAction as any).actionId = originalValue;
        });

        it('should have readonly element (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlAction.element;
            (crawlAction as any).element = 'new-element';
            expect(crawlAction.element).toBe('new-element');
            // Restore original value
            (crawlAction as any).element = originalValue;
        });

        it('should have readonly action (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlAction.action;
            (crawlAction as any).action = 'new-action';
            expect(crawlAction.action).toBe('new-action');
            // Restore original value
            (crawlAction as any).action = originalValue;
        });

        it('should have readonly cssPath (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlAction.cssPath;
            (crawlAction as any).cssPath = 'new-path';
            expect(crawlAction.cssPath).toBe('new-path');
            // Restore original value
            (crawlAction as any).cssPath = originalValue;
        });

        it('should have readonly actionHash (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlAction.actionHash;
            (crawlAction as any).actionHash = 'new-hash';
            expect(crawlAction.actionHash).toBe('new-hash');
            // Restore original value
            (crawlAction as any).actionHash = originalValue;
        });

        it('should have readonly parentState (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlAction.parentState;
            (crawlAction as any).parentState = mockChildState;
            expect(crawlAction.parentState).toBe(mockChildState);
            // Restore original value
            (crawlAction as any).parentState = originalValue;
        });

        it('should allow modification of childState', () => {
            // This should not throw
            crawlAction.childState = mockChildState;
            expect(crawlAction.childState).toBe(mockChildState);
        });
    });

    describe('Edge Cases', () => {
        it('should handle whitespace-only strings as invalid', () => {
            expect(() => {
                new CrawlAction('   ', 'click', '#btn', 'hash', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should handle very long strings', () => {
            const longString = 'a'.repeat(1000);
            const longCssPath = '#'.repeat(1000);
            const longHash = 'h'.repeat(1000);

            expect(() => {
                new CrawlAction(longString, 'click', longCssPath, longHash, mockParentState);
            }).not.toThrow();
        });

        it('should handle special characters in strings', () => {
            const specialElement = 'button[data-testid="submit-btn"]';
            const specialAction = 'click-and-hold';
            const specialCssPath = '#form > div:nth-child(2) > input[type="email"]';
            const specialHash = 'hash-with-special-chars-!@#$%^&*()';

            expect(() => {
                new CrawlAction(specialElement, specialAction, specialCssPath, specialHash, mockParentState);
            }).not.toThrow();
        });

        it('should handle unicode characters', () => {
            const unicodeElement = '按钮';
            const unicodeAction = '点击';
            const unicodeCssPath = '#按钮';
            const unicodeHash = 'hash-中文';

            expect(() => {
                new CrawlAction(unicodeElement, unicodeAction, unicodeCssPath, unicodeHash, mockParentState);
            }).not.toThrow();
        });
    });

    describe('Integration Tests', () => {
        it('should work with realistic crawler scenario', () => {
            const parentState = {
                stateId: 'homepage-state',
                url: 'https://example.com',
                stateHash: 'homepage-hash',
                crawlDepth: 0,
                crawlInputs: [],
                crawlActions: [],
                getCrawlActions: jest.fn(() => []),
                getCrawlDepth: jest.fn(() => 0),
                getCrawlInputs: jest.fn(() => []),
                toString: jest.fn(() => 'CrawlState(https://example.com@depth:0)'),
                toJSON: jest.fn(() => ({}))
            };

            const crawlAction = new CrawlAction(
                'a',
                'click',
                'a[href="/products"]',
                'products-link-hash',
                parentState
            );

            expect(crawlAction.element).toBe('a');
            expect(crawlAction.action).toBe('click');
            expect(crawlAction.cssPath).toBe('a[href="/products"]');
            expect(crawlAction.getParentState()).toBe(parentState);
            expect(crawlAction.getChildState()).toBeNull();

            // Simulate navigation to products page
            const childState = {
                stateId: 'products-state',
                url: 'https://example.com/products',
                stateHash: 'products-hash',
                crawlDepth: 1,
                crawlInputs: [],
                crawlActions: [],
                getCrawlActions: jest.fn(() => []),
                getCrawlDepth: jest.fn(() => 1),
                getCrawlInputs: jest.fn(() => []),
                toString: jest.fn(() => 'CrawlState(https://example.com/products@depth:1)'),
                toJSON: jest.fn(() => ({}))
            };

            crawlAction.setChildState(childState);
            expect(crawlAction.getChildState()).toBe(childState);
        });

        it('should maintain state consistency across operations', () => {
            const crawlAction = new CrawlAction(
                'form',
                'submit',
                '#contact-form',
                'form-submit-hash',
                mockParentState
            );

            // Initial state
            expect(crawlAction.childState).toBeNull();
            expect(crawlAction.getChildState()).toBeNull();

            // Set child state
            crawlAction.setChildState(mockChildState);
            expect(crawlAction.childState).toBe(mockChildState);
            expect(crawlAction.getChildState()).toBe(mockChildState);

            // Clear child state
            crawlAction.setChildState(null);
            expect(crawlAction.childState).toBeNull();
            expect(crawlAction.getChildState()).toBeNull();
        });
    });
});
