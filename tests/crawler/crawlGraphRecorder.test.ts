import CrawlState from '../../src/crawler/crawlState';
import CrawlAction from '../../src/crawler/crawlAction';
import { CrawlGraphRecorder } from '../../src/crawler/crawlGraphRecorder';

let idCounter = 0;
jest.mock('crypto', () => ({
    ...jest.requireActual('crypto'),
    randomUUID: jest.fn(() => `id-${++idCounter}`),
}));

describe('CrawlGraphRecorder', () => {
    beforeEach(() => {
        idCounter = 0;
    });

    function state(url: string, hash: string, depth: number): CrawlState {
        return new CrawlState(url, hash, depth, 'link');
    }

    it('records each action fate: executed, pruned, deduped, and still-discovered', () => {
        const rec = new CrawlGraphRecorder();
        const root = state('http://x/account', 'root', 0);
        const child = state('http://x/account/orders', 'orders', 1);

        const executed = new CrawlAction('a', 'click', 'a[href="/account/orders"]', 'h-ok', root);
        const pruned = new CrawlAction('a', 'click', 'a[href="/account/settings"]', 'h-prune', root);
        const pending = new CrawlAction('a', 'click', 'a[href="/account/reviews/new"]', 'h-pending', root);
        root.crawlActions = [executed, pruned, pending];

        rec.recordState(root);
        for (const a of root.crawlActions) {
            rec.recordDiscovered(a);
        }
        // one deduped candidate that never became a CrawlAction
        rec.recordDeduped(root, 'a', 'a[href="/account/messages"]', 'h-dup');

        rec.recordExecuted(executed, child);
        rec.recordState(child);
        rec.recordPruned(pruned);
        // `pending` is left as discovered → becomes no-child-state at snapshot

        const g = rec.snapshot('http://x/account');

        expect(g.source).toBe('recorded');
        expect(g.stateCount).toBe(2);
        expect(g.statusCounts).toMatchObject({
            executed: 1,
            pruned: 1,
            deduped: 1,
            'no-child-state': 1,
        });

        const byHash = (h: string): string | undefined => g.edges.find((e) => e.actionHash === h)?.status;
        expect(byHash('h-ok')).toBe('executed');
        expect(byHash('h-prune')).toBe('pruned');
        expect(byHash('h-dup')).toBe('deduped');
        expect(byHash('h-pending')).toBe('no-child-state');

        // the executed edge points at the child; the root is marked root
        const exec = g.edges.find((e) => e.actionHash === 'h-ok');
        expect(exec?.to).toBe(child.stateId);
        expect(g.nodes.find((n) => n.id === root.stateId)?.isRoot).toBe(true);
        // out-degree: root has all four edges
        expect(g.nodes.find((n) => n.id === root.stateId)?.actions).toBe(4);
    });

    it('does not let a later prune undo a recorded execution', () => {
        const rec = new CrawlGraphRecorder();
        const root = state('http://x/', 'r', 0);
        const child = state('http://x/a', 'c', 1);
        const a = new CrawlAction('a', 'click', 'a', 'h', root);
        rec.recordState(root);
        rec.recordDiscovered(a);
        rec.recordExecuted(a, child);
        rec.recordPruned(a); // stale prune arriving after execution
        expect(rec.snapshot('http://x/').statusCounts.executed).toBe(1);
        expect(rec.snapshot('http://x/').statusCounts.pruned).toBe(0);
    });

    // SCAN-198. Every removal funnels through removeCrawlActionFromState, so
    // before this the artifact called all of them `pruned` — and a crawl where
    // nearly every action executed and landed on an already-known state read as
    // a catastrophic replay failure. The whole point of the graph is to answer
    // "was this a coverage gap?", and it cannot if a healthy revisit and a
    // selector that would not resolve are the same word.
    describe('removal reasons (SCAN-198)', () => {
        it('separates a healthy revisit and an out-of-scope landing from a real prune', () => {
            const rec = new CrawlGraphRecorder();
            const root = state('http://x/', 'root', 0);
            const revisited = new CrawlAction('a', 'click', 'a.one', 'h-revisit', root);
            const outOfScope = new CrawlAction('a', 'click', 'a.two', 'h-scope', root);
            const unresolved = new CrawlAction('button', 'click', 'form > button', 'h-gone', root);
            root.crawlActions = [revisited, outOfScope, unresolved];

            rec.recordState(root);
            for (const a of root.crawlActions) {
                rec.recordDiscovered(a);
            }

            rec.recordPruned(revisited, 'revisited');
            rec.recordPruned(outOfScope, 'out-of-scope');
            rec.recordPruned(unresolved, 'unresolved');

            const counts = rec.snapshot('http://x/').statusCounts;
            expect(counts).toMatchObject({
                revisited: 1,
                'out-of-scope': 1,
                pruned: 1,
            });
        });

        it('defaults to a real prune, so a replay failure is never silently counted as healthy', () => {
            const rec = new CrawlGraphRecorder();
            const root = state('http://x/', 'root', 0);
            const a = new CrawlAction('button', 'click', 'form > button', 'h', root);
            root.crawlActions = [a];
            rec.recordState(root);
            rec.recordDiscovered(a);

            rec.recordPruned(a); // no reason given — the replay failure paths

            expect(rec.snapshot('http://x/').statusCounts.pruned).toBe(1);
            expect(rec.snapshot('http://x/').statusCounts.revisited).toBe(0);
        });

        it('keeps an executed edge executed whatever reason arrives later', () => {
            const rec = new CrawlGraphRecorder();
            const root = state('http://x/', 'root', 0);
            const child = state('http://x/a', 'c', 1);
            const a = new CrawlAction('a', 'click', 'a', 'h', root);
            rec.recordState(root);
            rec.recordDiscovered(a);
            rec.recordExecuted(a, child);

            rec.recordPruned(a, 'revisited');

            const counts = rec.snapshot('http://x/').statusCounts;
            expect(counts.executed).toBe(1);
            expect(counts.revisited).toBe(0);
        });
    });

    // The recorder holds one object per action, and in API mode this process
    // serves every scan — so a diagnostic may not be allowed to grow without
    // bound. Past the ceiling the graph stops growing and says so, rather than
    // silently looking like a crawl that discovered less.
    describe('edge ceiling', () => {
        it('stops recording new edges past the cap and reports the graph truncated', () => {
            const rec = new CrawlGraphRecorder(2);
            const root = state('http://x/', 'root', 0);
            rec.recordState(root);
            for (let i = 0; i < 5; i++) {
                rec.recordDiscovered(new CrawlAction('a', 'click', `a:nth-child(${i})`, `h-${i}`, root));
            }

            const g = rec.snapshot('http://x/');
            expect(g.edgeCount).toBe(2);
            expect(g.truncated).toBe(true);
            expect(g.edgesDropped).toBe(3);
        });

        it('still records outcomes for edges it already holds, so the partial graph stays true', () => {
            const rec = new CrawlGraphRecorder(1);
            const root = state('http://x/', 'root', 0);
            const child = state('http://x/a', 'c', 1);
            const kept = new CrawlAction('a', 'click', 'a.one', 'h-kept', root);
            const dropped = new CrawlAction('a', 'click', 'a.two', 'h-dropped', root);
            rec.recordState(root);
            rec.recordDiscovered(kept);
            rec.recordDiscovered(dropped); // over the ceiling

            rec.recordExecuted(kept, child);

            const g = rec.snapshot('http://x/');
            expect(g.statusCounts.executed).toBe(1);
            expect(g.edgesDropped).toBe(1);
        });

        it('is uncapped when no ceiling is given', () => {
            const rec = new CrawlGraphRecorder();
            const root = state('http://x/', 'root', 0);
            rec.recordState(root);
            for (let i = 0; i < 50; i++) {
                rec.recordDiscovered(new CrawlAction('a', 'click', `a:nth-child(${i})`, `h-${i}`, root));
            }
            const g = rec.snapshot('http://x/');
            expect(g.edgeCount).toBe(50);
            expect(g.truncated).toBeUndefined();
        });
    });
});
