import CrawlStateManager from '../../src/crawler/crawlStateManager';
import CrawlState from '../../src/crawler/crawlState';
import CrawlAction from '../../src/crawler/crawlAction';

// Mock crypto module
let uuidCounter = 0;
jest.mock('crypto', () => ({
    randomUUID: jest.fn(() => `test-uuid-${++uuidCounter}`)
}));

describe('CrawlStateManager', () => {
    let stateManager: CrawlStateManager;
    let mockRootState: CrawlState;
    let mockChildState: CrawlState;
    let mockAction: CrawlAction;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Create child state first
        mockChildState = new CrawlState(
            'https://example.com/page1',
            'child-hash',
            1,
            'dom',
            [],
            []
        );

        // Create root state first
        mockRootState = new CrawlState(
            'https://example.com',
            'root-hash',
            0,
            'link',
            [],
            []
        );

        // Create action that connects root to child
        mockAction = new CrawlAction(
            'button',
            'click',
            '#submit-btn',
            'action-hash-1',
            mockRootState
        );

        // Set up the relationship
        mockAction.childState = mockChildState;

        // Add action to root state by modifying the internal array
        (mockRootState as any).crawlActions = [mockAction];

        // Mock the getCrawlActions method to return the action
        mockRootState.getCrawlActions = jest.fn().mockReturnValue([mockAction]);

        stateManager = new CrawlStateManager(mockRootState);
    });

    describe('Constructor', () => {
        it('should create CrawlStateManager with root state', () => {
            expect(stateManager.rootState).toBeDefined();
            expect(stateManager.visitedActions).toBeInstanceOf(Set);
            expect(stateManager.visitedActions.size).toBe(0);
        });

        it('should create CrawlStateManager with null root state', () => {
            const emptyManager = new CrawlStateManager(null);
            expect(emptyManager.rootState).toBeNull();
            expect(emptyManager.visitedActions).toBeInstanceOf(Set);
        });

        it('should create CrawlStateManager with undefined root state', () => {
            const emptyManager = new CrawlStateManager(undefined);
            expect(emptyManager.rootState).toBeNull();
            expect(emptyManager.visitedActions).toBeInstanceOf(Set);
        });

        it('should throw error for invalid root state', () => {
            expect(() => {
                new CrawlStateManager({} as any);
            }).toThrow('Invalid CrawlState provided to CrawlStateManager constructor');
        });
    });

    describe('getStateByHash', () => {
        it('should return state with matching hash', () => {
            const result = stateManager.getStateByHash('root-hash');
            expect(result).toBe(stateManager.rootState);
        });

        it('should return child state with matching hash', () => {
            const result = stateManager.getStateByHash('child-hash');
            expect(result).not.toBeNull();
            expect(result?.stateHash).toBe('child-hash');
            expect(result?.url).toBe('https://example.com/page1');
        });

        it('should return null for non-existent hash', () => {
            const result = stateManager.getStateByHash('non-existent-hash');
            expect(result).toBeNull();
        });

        it('should return null when root state is null', () => {
            const emptyManager = new CrawlStateManager(null);
            const result = emptyManager.getStateByHash('any-hash');
            expect(result).toBeNull();
        });

        it('should throw error for invalid stateHash', () => {
            expect(() => {
                stateManager.getStateByHash('');
            }).toThrow('stateHash must be a non-empty string');
        });
    });

    describe('getNextCrawlAction', () => {
        it('should return first unvisited action', () => {
            const result = stateManager.getNextCrawlAction();
            expect(result).toBe(mockAction);
            expect(stateManager.visitedActions.has(mockAction.actionId)).toBe(true);
        });

        it('should return null when all actions are visited', () => {
            stateManager.getNextCrawlAction(); // Visit first action
            const result = stateManager.getNextCrawlAction();
            expect(result).toBeNull();
        });

        it('should return null when root state is null', () => {
            const emptyManager = new CrawlStateManager(null);
            const result = emptyManager.getNextCrawlAction();
            expect(result).toBeNull();
        });
    });

    describe('isCrawlActionUnique', () => {
        it('should return true for unique action', () => {
            const result = stateManager.isCrawlActionUnique('unique-path', 'unique-hash');
            expect(result).toBe(true);
        });

        it('should return false for duplicate action', () => {
            const result = stateManager.isCrawlActionUnique('#submit-btn', 'action-hash-1');
            expect(result).toBe(false);
        });

        it('should return true when root state is null', () => {
            const emptyManager = new CrawlStateManager(null);
            const result = emptyManager.isCrawlActionUnique('any-path', 'any-hash');
            expect(result).toBe(true);
        });

        it('should throw error for invalid cssPath', () => {
            expect(() => {
                stateManager.isCrawlActionUnique('', 'valid-hash');
            }).toThrow('cssPath must be a non-empty string');
        });

        it('should throw error for invalid actionHash', () => {
            expect(() => {
                stateManager.isCrawlActionUnique('valid-path', '');
            }).toThrow('actionHash must be a non-empty string');
        });
    });

    describe('Utility Methods', () => {
        it('should clear visited actions', () => {
            stateManager.getNextCrawlAction(); // Visit an action
            expect(stateManager.visitedActions.size).toBe(1);

            stateManager.clearVisitedActions();
            expect(stateManager.visitedActions.size).toBe(0);
        });

        it('should return visited actions count', () => {
            expect(stateManager.getVisitedActionsCount()).toBe(0);

            stateManager.getNextCrawlAction(); // Visit an action
            expect(stateManager.getVisitedActionsCount()).toBe(1);
        });

        it('should return string representation', () => {
            const result = stateManager.toString();
            expect(result).toContain('CrawlStateManager');
            expect(result).toContain('https://example.com');
            expect(result).toContain('visitedActions: 0');
        });
    });

    describe('Error Handling', () => {
        it('should handle errors during search gracefully', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            const invalidState = {
                stateId: 'test-id',
                url: 'https://test.com',
                stateHash: 'test-hash',
                crawlDepth: 0,
                crawlInputs: [],
                crawlActions: [],
                getCrawlActions: jest.fn().mockImplementation(() => {
                    throw new Error('Test error');
                }),
                getCrawlDepth: jest.fn().mockReturnValue(0),
                getCrawlInputs: jest.fn().mockReturnValue([])
            } as any;

            const manager = new CrawlStateManager(invalidState);
            const result = manager.getStateByHash('test-hash');
            expect(result).toBe(invalidState);
            // Constructor runs reindexFromRoot, which calls getCrawlActions on the root — expect one warn.
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });
    });
});