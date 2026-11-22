/**
 * Both crawl-graph sources mark every seed as a root (SCAN-229). The artifact
 * is how a coverage gap is diagnosed, so it must show where each tree started.
 */

import CrawlStateManager from '../../src/crawler/crawlStateManager';
import CrawlState from '../../src/crawler/crawlState';
import CrawlAction from '../../src/crawler/crawlAction';
import { buildCrawlGraph, crawlGraphToDot, crawlGraphToMermaid } from '../../src/crawler/crawlGraph';
import { CrawlGraphRecorder } from '../../src/crawler/crawlGraphRecorder';

function forest(): { manager: CrawlStateManager; a: CrawlState; b: CrawlState; child: CrawlState } {
    const a = new CrawlState('https://site.test/a', 'ha', 0, 'link');
    const b = new CrawlState('https://site.test/b', 'hb', 0, 'link');
    const child = new CrawlState('https://site.test/b#x', 'hx', 1, 'dom');
    const action = new CrawlAction('button', 'click', '#x', 'ah-x', b);
    action.setChildState(child);
    child.parentAction = action;
    b.crawlActions.push(action);
    const manager = new CrawlStateManager(a);
    manager.addRootState(b);
    return { manager, a, b, child };
}

describe('buildCrawlGraph with several roots', () => {
    it('marks every root and nothing else', () => {
        const { manager, a, b, child } = forest();
        const graph = buildCrawlGraph(manager, a.url);
        const isRoot = Object.fromEntries(graph.nodes.map((n) => [n.id, n.isRoot]));

        expect(isRoot).toEqual({ [a.stateId]: true, [b.stateId]: true, [child.stateId]: false });
    });

    it('draws each root with the root shape in Mermaid and DOT', () => {
        const { manager, a } = forest();
        const graph = buildCrawlGraph(manager, a.url);
        expect(crawlGraphToMermaid(graph).match(/\(\[/g)).toHaveLength(2);
        expect(crawlGraphToDot(graph).match(/fillcolor/g)).toHaveLength(2);
    });

    it('is byte-identical across builds of the same forest', () => {
        const { manager, a } = forest();
        expect(JSON.stringify(buildCrawlGraph(manager, a.url))).toBe(JSON.stringify(buildCrawlGraph(manager, a.url)));
    });
});

describe('CrawlGraphRecorder.markRoot', () => {
    it('still treats the first recorded state as a root', () => {
        const rec = new CrawlGraphRecorder();
        const a = new CrawlState('https://site.test/a', 'ha', 0, 'link');
        const b = new CrawlState('https://site.test/b', 'hb', 0, 'link');
        rec.recordState(a);
        rec.recordState(b);
        const roots = rec.snapshot(a.url).nodes.filter((n) => n.isRoot).map((n) => n.id);
        expect(roots).toEqual([a.stateId]);
    });

    it('upgrades a state already recorded', () => {
        const rec = new CrawlGraphRecorder();
        const a = new CrawlState('https://site.test/a', 'ha', 0, 'link');
        const b = new CrawlState('https://site.test/b', 'hb', 0, 'link');
        rec.recordState(a);
        rec.recordState(b);
        rec.markRoot(b.stateId);
        const roots = rec.snapshot(a.url).nodes.filter((n) => n.isRoot).map((n) => n.id);
        expect(roots).toEqual([a.stateId, b.stateId]);
    });

    it('applies to a state recorded after it was marked', () => {
        const rec = new CrawlGraphRecorder();
        const b = new CrawlState('https://site.test/b', 'hb', 0, 'link');
        rec.markRoot(b.stateId);
        const a = new CrawlState('https://site.test/a', 'ha', 0, 'link');
        rec.recordState(a);
        rec.recordState(b);
        const roots = rec.snapshot(a.url).nodes.filter((n) => n.isRoot).map((n) => n.id);
        expect(roots).toEqual([b.stateId]);
    });
});
