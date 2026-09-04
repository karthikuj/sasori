import CrawlStateManager from '../../src/crawler/crawlStateManager';
import CrawlState from '../../src/crawler/crawlState';
import CrawlAction from '../../src/crawler/crawlAction';
import {
    buildCrawlGraph,
    crawlGraphToMermaid,
    crawlGraphToDot,
    CRAWL_GRAPH_VERSION,
} from '../../src/crawler/crawlGraph';

let idCounter = 0;
jest.mock('crypto', () => ({
    ...jest.requireActual('crypto'),
    randomUUID: jest.fn(() => `id-${++idCounter}`),
}));

describe('crawlGraph', () => {
    beforeEach(() => {
        idCounter = 0;
    });

    /**
     * Builds a tiny graph: root --(executed)--> child, plus a second action on
     * the root that was discovered but never produced a child state (the RC2
     * "dropped/unexecuted action" signal).
     */
    function buildManager(): { manager: CrawlStateManager; root: CrawlState; child: CrawlState } {
        const root = new CrawlState('https://x/account', 'roothash', 0, 'link');
        const child = new CrawlState('https://x/account/messages', 'childhash', 1, 'link');

        const executed = new CrawlAction('a', 'click', 'a[href="/account/messages"]', 'hash-msg', root);
        executed.setChildState(child);
        const dropped = new CrawlAction('a', 'click', 'a[href="/account/settings"]', 'hash-set', root);
        // dropped.childState stays null — discovered but no child state recorded.

        root.crawlActions = [executed, dropped];
        child.crawlActions = [];

        const manager = new CrawlStateManager(root);
        manager.registerState(root);
        manager.registerState(child);
        return { manager, root, child };
    }

    it('serialises nodes and edges with execution status', () => {
        const { manager, root, child } = buildManager();
        const graph = buildCrawlGraph(manager, 'https://x/account');

        expect(graph.version).toBe(CRAWL_GRAPH_VERSION);
        expect(graph.entryPoint).toBe('https://x/account');
        expect(graph.stateCount).toBe(2);
        expect(graph.edgeCount).toBe(2);
        expect(graph.executedEdgeCount).toBe(1);

        const rootNode = graph.nodes.find((n) => n.id === root.stateId);
        expect(rootNode).toMatchObject({ url: 'https://x/account', crawlDepth: 0, actions: 2, isRoot: true });
        const childNode = graph.nodes.find((n) => n.id === child.stateId);
        expect(childNode).toMatchObject({ url: 'https://x/account/messages', isRoot: false });

        const executedEdge = graph.edges.find((e) => e.cssPath === 'a[href="/account/messages"]');
        expect(executedEdge).toMatchObject({ from: root.stateId, to: child.stateId, status: 'executed' });

        const droppedEdge = graph.edges.find((e) => e.cssPath === 'a[href="/account/settings"]');
        expect(droppedEdge).toMatchObject({ from: root.stateId, to: null, status: 'no-child-state' });
    });

    it('renders Mermaid with the root node and both edge kinds', () => {
        const { manager } = buildManager();
        const mmd = crawlGraphToMermaid(buildCrawlGraph(manager, 'https://x/account'));
        expect(mmd).toContain('flowchart TD');
        expect(mmd).toContain('/account/messages'); // executed edge target node
        expect(mmd).toContain('-->|'); // a solid executed edge
        expect(mmd).toContain('no-child'); // the dashed dropped-action edge
        expect(mmd).toContain('/account/settings'); // dropped action's cssPath is shown
    });

    it('renders DOT with nodes and edges', () => {
        const { manager } = buildManager();
        const dot = crawlGraphToDot(buildCrawlGraph(manager, 'https://x/account'));
        expect(dot).toContain('digraph crawl {');
        expect(dot).toContain('/account/messages');
        expect(dot).toContain('style=dashed'); // the no-child edge
        expect(dot.trim().endsWith('}')).toBe(true);
    });

    it('marks an empty crawl as zero states without throwing', () => {
        const graph = buildCrawlGraph(new CrawlStateManager(), 'https://x/');
        expect(graph.stateCount).toBe(0);
        expect(graph.edges).toHaveLength(0);
        expect(crawlGraphToMermaid(graph)).toContain('flowchart TD');
    });
});
