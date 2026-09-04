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
});
