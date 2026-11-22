/**
 * The crawl forest: several seed roots in one CrawlStateManager (SCAN-229).
 *
 * Every seed is a depth-0 `link` state, so replay needs no new machinery — but
 * the manager must index, enqueue and plan across all roots, and the replay
 * baseline for a state must come from *its own* tree's root, never from
 * whichever root happens to be first.
 */

import CrawlStateManager from '../../src/crawler/crawlStateManager';
import CrawlState from '../../src/crawler/crawlState';
import CrawlAction from '../../src/crawler/crawlAction';

function seed(path: string, hash: string): CrawlState {
    return new CrawlState(`https://site.test${path}`, hash, 0, 'link');
}

/** Adds an action on `parent` leading to a new child state, wired as the crawler wires it. */
function grow(
    parent: CrawlState,
    css: string,
    childHash: string,
    arrival: 'link' | 'dom' = 'dom',
    childPath = `${parent.url.replace('https://site.test', '')}#${childHash}`,
): { action: CrawlAction; child: CrawlState } {
    const action = new CrawlAction('button', 'click', css, `ah-${css}`, parent);
    const child = new CrawlState(`https://site.test${childPath}`, childHash, parent.crawlDepth + 1, arrival);
    action.setChildState(child);
    child.parentAction = action;
    parent.crawlActions.push(action);
    return { action, child };
}

/** Adds an action with no child yet — a frontier entry. */
function pending(parent: CrawlState, css: string): CrawlAction {
    const action = new CrawlAction('button', 'click', css, `ah-${css}`, parent);
    parent.crawlActions.push(action);
    return action;
}

function drain(manager: CrawlStateManager): CrawlAction[] {
    const out: CrawlAction[] = [];
    for (let next = manager.getNextCrawlAction(); next; next = manager.getNextCrawlAction()) {
        out.push(next);
    }
    return out;
}

describe('CrawlStateManager — multiple roots', () => {
    describe('adding roots', () => {
        it('keeps roots in insertion order and mirrors the first as rootState', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const manager = new CrawlStateManager();
            manager.addRootState(a);
            manager.addRootState(b);

            expect(manager.getRootStates()).toEqual([a, b]);
            expect(manager.rootState).toBe(a);
        });

        it('ignores a root added twice', () => {
            const a = seed('/a', 'ha');
            const manager = new CrawlStateManager(a);
            manager.addRootState(a);
            expect(manager.getRootStates()).toEqual([a]);
        });

        it('returns a copy that cannot reorder the manager', () => {
            const manager = new CrawlStateManager(seed('/a', 'ha'));
            manager.getRootStates().reverse().push(seed('/x', 'hx'));
            expect(manager.getRootStates()).toHaveLength(1);
        });

        it('rejects an invalid root', () => {
            expect(() => new CrawlStateManager().addRootState({} as CrawlState))
                .toThrow('Invalid CrawlState provided to addRootState');
        });

        it('attachRootState still resets the forest to a single root', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const c = seed('/c', 'hc');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);
            manager.attachRootState(c);

            expect(manager.getRootStates()).toEqual([c]);
            expect(manager.getStateByHash('ha')).toBeNull();
            expect(manager.getStateByHash('hc')).toBe(c);
        });

        it('attachRootState(null) empties the forest', () => {
            const manager = new CrawlStateManager(seed('/a', 'ha'));
            manager.attachRootState(null);
            expect(manager.getRootStates()).toEqual([]);
            expect(manager.rootState).toBeNull();
            expect(manager.getNextCrawlAction()).toBeNull();
        });

        it('reports the root count in toString', () => {
            const manager = new CrawlStateManager(seed('/a', 'ha'));
            manager.addRootState(seed('/b', 'hb'));
            expect(manager.toString()).toContain('roots: 2');
        });
    });

    describe('indexing', () => {
        it('indexes every state of every tree', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const { child: a1 } = grow(a, '#a1', 'ha1');
            const { child: b1 } = grow(b, '#b1', 'hb1');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            expect(manager.getStateByHash('ha1')).toBe(a1);
            expect(manager.getStateByHash('hb1')).toBe(b1);
            expect(manager.getStates()).toHaveLength(4);
        });

        it('indexes a state shared by two trees once (forest join)', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const { child: shared } = grow(a, '#to-shared', 'h-shared');
            // B's branch reached the same DOM: the crawler collapses it onto the
            // existing state, so both trees point at one CrawlState.
            const join = new CrawlAction('button', 'click', '#b-to-shared', 'ah-join', b);
            join.setChildState(shared);
            b.crawlActions.push(join);
            pending(shared, '#deeper');

            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            const sharedStates = manager.getStates().filter((s) => s.stateHash === 'h-shared');
            expect(sharedStates).toEqual([shared]);
            expect(manager.getStates()).toHaveLength(3);
            // Its action is counted once, not once per tree that reaches it.
            expect(manager.isCrawlActionUnique('#deeper', 'ah-#deeper')).toBe(false);
            expect(manager.shouldRetainAction('#deeper', 'ah-#deeper')).toBe(true);
        });

        it('counts action signatures across all roots for dedup', () => {
            // A nav link present on three seed pages: each copy registers, so a
            // fourth copy is dropped at discovery (MAX_UNEXECUTED_TWINS = 3).
            const roots = ['/a', '/b', '/c'].map((p, i) => seed(p, `h${i}`));
            for (const root of roots) {
                root.crawlActions.push(new CrawlAction('a', 'click', 'nav > a', 'nav-hash', root));
            }
            const manager = new CrawlStateManager();
            for (const root of roots) {
                manager.addRootState(root);
            }
            expect(manager.shouldRetainAction('nav > a', 'nav-hash')).toBe(false);
        });
    });

    describe('frontier', () => {
        it('serves actions from every root', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const aAction = pending(a, '#a');
            const bAction = pending(b, '#b');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            expect(new Set(drain(manager))).toEqual(new Set([aAction, bAction]));
        });

        it('explores the entry point (first root) before later seeds', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const c = seed('/c', 'hc');
            const aAction = pending(a, '#a');
            const bAction = pending(b, '#b');
            const cAction = pending(c, '#c');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);
            manager.addRootState(c);

            expect(drain(manager)).toEqual([aAction, bAction, cAction]);
        });

        it('matches the legacy DFS order after clearVisitedActions', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            pending(a, '#a1');
            pending(a, '#a2');
            pending(b, '#b1');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            const first = drain(manager);
            manager.clearVisitedActions();
            expect(drain(manager)).toEqual(first);
        });

        it('serves nothing when there are no roots', () => {
            expect(new CrawlStateManager().getNextCrawlAction()).toBeNull();
        });

        it('does not re-serve an action already popped when a root is added', () => {
            const a = seed('/a', 'ha');
            const aAction = pending(a, '#a');
            const manager = new CrawlStateManager(a);
            expect(manager.getNextCrawlAction()).toBe(aAction);

            const b = seed('/b', 'hb');
            const bAction = pending(b, '#b');
            manager.addRootState(b);
            expect(drain(manager)).toEqual([bAction]);
        });
    });

    describe('replay planning', () => {
        it('replays a state in a later tree from that tree\'s own seed', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const { action: b1, child: y } = grow(b, '#b1', 'hy');
            const { action: y1, child: z } = grow(y, '#y1', 'hz');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            const plan = manager.getOptimizedReplayPlan(z);
            expect(plan).toEqual({ baselineUrl: 'https://site.test/b', actionsToReplay: [b1, y1] });
        });

        it('needs nothing replayed to reach any root', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            expect(manager.getOptimizedReplayPlan(a)).toEqual({ baselineUrl: 'https://site.test/a', actionsToReplay: [] });
            expect(manager.getOptimizedReplayPlan(b)).toEqual({ baselineUrl: 'https://site.test/b', actionsToReplay: [] });
        });

        it('still stops at the nearest link ancestor inside a seed\'s tree', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const { child: page } = grow(b, '#nav', 'h-page', 'link', '/b/page');
            const { action: p1, child: modal } = grow(page, '#open', 'h-modal');
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            expect(manager.getOptimizedReplayPlan(modal))
                .toEqual({ baselineUrl: 'https://site.test/b/page', actionsToReplay: [p1] });
        });

        it('plans through a forest join from the tree that owns the parent pointer', () => {
            const a = seed('/a', 'ha');
            const b = seed('/b', 'hb');
            const { action: toShared, child: shared } = grow(b, '#to-shared', 'h-shared');
            const join = new CrawlAction('button', 'click', '#a-to-shared', 'ah-join', a);
            join.setChildState(shared);
            a.crawlActions.push(join);
            const manager = new CrawlStateManager(a);
            manager.addRootState(b);

            expect(manager.getOptimizedReplayPlan(shared))
                .toEqual({ baselineUrl: 'https://site.test/b', actionsToReplay: [toShared] });
        });

        it('returns null for a state with no path to any root', () => {
            const a = seed('/a', 'ha');
            const manager = new CrawlStateManager(a);
            manager.addRootState(seed('/b', 'hb'));
            const orphan = new CrawlState('https://site.test/orphan', 'h-orphan', 2, 'dom');
            expect(manager.getOptimizedReplayPlan(orphan)).toBeNull();
        });

        it('returns null when there are no roots', () => {
            const state = seed('/a', 'ha');
            expect(new CrawlStateManager().getOptimizedReplayPlan(state)).toBeNull();
        });
    });
});
