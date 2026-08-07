import CrawlAction from '../../src/crawler/crawlAction';
import CrawlState from '../../src/crawler/crawlState';
import CrawlStateManager from '../../src/crawler/crawlStateManager';

/**
 * Instrumentation for S5. Replay planning is ~O(path length) per action over a
 * graph bounded only by maxDepth/maxChildren; these counters are what make a
 * real slowdown attributable instead of "the crawl just got slower".
 */
describe('CrawlStateManager replay-plan instrumentation (S5)', () => {
    let rootState: CrawlState;
    let childState: CrawlState;
    let stateManager: CrawlStateManager;

    beforeEach(() => {
        jest.clearAllMocks();

        childState = new CrawlState('https://example.com/page1', 'child-hash', 1, 'dom', [], []);
        rootState = new CrawlState('https://example.com', 'root-hash', 0, 'link', [], []);

        const action = new CrawlAction('button', 'click', '#submit-btn', 'action-hash-1', rootState);
        action.childState = childState;
        childState.parentAction = action;
        (rootState as unknown as { crawlActions: CrawlAction[] }).crawlActions = [action];
        rootState.getCrawlActions = jest.fn().mockReturnValue([action]);

        stateManager = new CrawlStateManager(rootState);
    });

    it('starts with empty stats', () => {
        const stats = stateManager.getReplayPlanStats();
        expect(stats.calls).toBe(0);
        expect(stats.totalMs).toBe(0);
        expect(stats.averageMs).toBe(0);
    });

    it('counts every replay-plan computation', () => {
        stateManager.getOptimizedReplayPlan(childState);
        stateManager.getOptimizedReplayPlan(childState);
        stateManager.getOptimizedReplayPlan(rootState);

        expect(stateManager.getReplayPlanStats().calls).toBe(3);
    });

    it('reports a non-negative average once called', () => {
        stateManager.getOptimizedReplayPlan(childState);

        const stats = stateManager.getReplayPlanStats();
        expect(stats.averageMs).toBeGreaterThanOrEqual(0);
        expect(stats.maxMs).toBeGreaterThanOrEqual(0);
        expect(stats.totalMs).toBeGreaterThanOrEqual(0);
    });

    // Instrumentation must not swallow the error the caller relies on.
    it('still throws on an invalid destination, and counts the attempt', () => {
        expect(() => stateManager.getOptimizedReplayPlan({} as CrawlState)).toThrow(
            'Invalid destinationState provided to getOptimizedReplayPlan method',
        );
        expect(stateManager.getReplayPlanStats().calls).toBe(1);
    });

    // The measurement must not change what the planner returns.
    it('returns the same plan as before instrumentation', () => {
        const plan = stateManager.getOptimizedReplayPlan(childState);

        expect(plan).not.toBeNull();
        expect(plan!.baselineUrl).toBe('https://example.com');
        expect(plan!.actionsToReplay).toHaveLength(1);
    });

    it('returns an empty plan for the root state', () => {
        const plan = stateManager.getOptimizedReplayPlan(rootState);

        expect(plan).toEqual({ baselineUrl: 'https://example.com', actionsToReplay: [] });
        expect(stateManager.getReplayPlanStats().calls).toBe(1);
    });
});
