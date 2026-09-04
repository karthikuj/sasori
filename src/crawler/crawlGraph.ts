import type CrawlStateManager from './crawlStateManager';
import type CrawlState from './crawlState';

/**
 * Serialisable crawl-graph artifact (SCAN-197).
 *
 * The crawl builds a state graph in memory — {@link CrawlStateManager} holds the
 * states (keyed by DOM hash) and each `CrawlAction` links a `parentState` to the
 * `childState` it produced. The endpoint inventory persists only the states and
 * their coverage; this artifact persists the *edges* and each action's execution
 * status, which is what makes a coverage failure diagnosable after the fact
 * (e.g. "was this anchor deduped at discovery, or executed and dropped?").
 *
 * The JSON form is the source of truth; {@link crawlGraphToMermaid} and
 * {@link crawlGraphToDot} are pure converters for visualisation.
 */

/** Bump when a field changes meaning, mirroring the inventory's versioning. */
export const CRAWL_GRAPH_VERSION = 1;

export interface CrawlGraphNode {
    /** Stable per-state-object id; the graph keys edges on it. */
    id: string;
    /** DOM-state hash (the crawler's own notion of identity). */
    stateHash: string;
    url: string;
    crawlDepth: number;
    arrivalType: string;
    /** Out-degree in the reconstructed graph (child states + surviving no-child
     * actions). Not the count of *discovered* actions — that is pruned during
     * the crawl; read the inventory for it. */
    actions: number;
    /** Number of input fields discovered on this state. */
    inputs: number;
    isRoot: boolean;
}

/**
 * One edge. `status`:
 *   - `executed`       — the action ran and produced this child state. These are
 *     reconstructed from each state's `parentAction` back-pointer, which the
 *     crawler sets when an action creates a state and never prunes, so they
 *     survive to the end of the crawl.
 *   - `no-child-state` — a discovered action still on its state's `crawlActions`
 *     list with no child. Only visible when the crawl is *stopped mid-way*: on a
 *     completed crawl the frontier is drained and such actions are pruned
 *     (`removeCrawlActionFromState`), so a completed crawl shows the traversed
 *     tree and few or no `no-child-state` edges. Capturing every discovered
 *     action's fate regardless of pruning needs live recording during the crawl
 *     (a follow-up); this reconstruction is best-effort from end state.
 */
export interface CrawlGraphEdge {
    from: string;
    to: string | null;
    toStateHash: string | null;
    element: string;
    action: string;
    cssPath: string;
    actionHash: string;
    status: 'executed' | 'no-child-state';
}

export interface CrawlGraph {
    version: number;
    entryPoint: string;
    stateCount: number;
    edgeCount: number;
    executedEdgeCount: number;
    nodes: CrawlGraphNode[];
    edges: CrawlGraphEdge[];
}

/**
 * Walks the state manager and builds the serialisable crawl graph. Pure: it
 * reads the manager, mutates nothing, and does no I/O.
 */
export function buildCrawlGraph(manager: CrawlStateManager, entryPoint: string): CrawlGraph {
    const states = manager.getStates();
    const root = manager.rootState;

    const edges: CrawlGraphEdge[] = [];
    const seen = new Set<string>();
    const key = (from: string, to: string | null, hash: string): string => `${from}|${to ?? ''}|${hash}`;

    // Primary, reliable source: each non-root state's `parentAction` — the edge
    // that created it. This back-pointer survives frontier consumption and
    // action pruning, so it is present for the whole traversed tree even on a
    // completed crawl.
    for (const state of states) {
        const pa = state.parentAction;
        if (!pa) {
            continue;
        }
        const from = pa.parentState.stateId;
        const k = key(from, state.stateId, pa.actionHash);
        if (seen.has(k)) {
            continue;
        }
        seen.add(k);
        edges.push({
            from,
            to: state.stateId,
            toStateHash: state.stateHash,
            element: pa.element,
            action: pa.action,
            cssPath: pa.cssPath,
            actionHash: pa.actionHash,
            status: 'executed',
        });
    }

    // Best-effort supplement: any actions still on a state's `crawlActions` list
    // (i.e. not yet consumed/pruned — the case for a crawl stopped mid-way).
    // Executed ones usually duplicate a parentAction edge and are deduped; the
    // no-child ones are the discovered-but-unexecuted frontier at stop time.
    for (const state of states) {
        for (const action of state.crawlActions) {
            const child = action.childState;
            const k = key(state.stateId, child ? child.stateId : null, action.actionHash);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            edges.push({
                from: state.stateId,
                to: child ? child.stateId : null,
                toStateHash: child ? child.stateHash : null,
                element: action.element,
                action: action.action,
                cssPath: action.cssPath,
                actionHash: action.actionHash,
                status: child ? 'executed' : 'no-child-state',
            });
        }
    }

    // Node's `actions` is its out-degree in the reconstructed graph (child
    // states plus any surviving no-child actions). The count of *discovered*
    // actions is not recoverable after the crawl prunes them — read the
    // inventory for that.
    const outDegree = new Map<string, number>();
    for (const e of edges) {
        outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    }

    const nodes: CrawlGraphNode[] = states.map((state: CrawlState) => ({
        id: state.stateId,
        stateHash: state.stateHash,
        url: state.url,
        crawlDepth: state.crawlDepth,
        arrivalType: state.arrivalType,
        actions: outDegree.get(state.stateId) ?? 0,
        inputs: state.crawlInputs.length,
        isRoot: root != null && state.stateId === root.stateId,
    }));

    return {
        version: CRAWL_GRAPH_VERSION,
        entryPoint,
        stateCount: nodes.length,
        edgeCount: edges.length,
        executedEdgeCount: edges.filter((e) => e.status === 'executed').length,
        nodes,
        edges,
    };
}

/** Trims a label to keep the rendered graph legible. */
function truncate(text: string, max = 48): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Short, stable node handle for Mermaid/DOT (ids can contain unsafe chars). */
function handle(id: string): string {
    return 'n_' + id.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Renders the graph as a Mermaid flowchart. Executed edges are solid and point
 * to the child state; no-child actions are dashed edges to a per-action terminal
 * so a dropped/unexecuted action is still visible (this is the RC2 signal).
 * Best for scoped crawls — it renders anywhere Mermaid does.
 */
export function crawlGraphToMermaid(graph: CrawlGraph): string {
    const lines: string[] = ['flowchart TD'];
    for (const n of graph.nodes) {
        const label = truncate(`${n.url}\n#${n.stateHash.slice(0, 8)} d=${n.crawlDepth}`);
        const shape = n.isRoot ? ['([', '])'] : ['["', '"]'];
        lines.push(`  ${handle(n.id)}${shape[0]}${label.replace(/"/g, '\'')}${shape[1]}`);
    }
    let dead = 0;
    for (const e of graph.edges) {
        const edgeLabel = truncate(`${e.element}:${e.cssPath}`, 40).replace(/["|]/g, '\'');
        if (e.to) {
            lines.push(`  ${handle(e.from)} -->|${edgeLabel}| ${handle(e.to)}`);
        } else {
            const sink = `dead_${dead++}`;
            lines.push(`  ${sink}["∅ ${edgeLabel}"]`);
            lines.push(`  ${handle(e.from)} -. no-child .-> ${sink}`);
        }
    }
    return lines.join('\n') + '\n';
}

/**
 * Renders the graph as Graphviz DOT. Better than Mermaid for the full
 * thousands-of-states graph, where `dot`/`sfdp` layout scales. No-child actions
 * are dashed edges to a shared, unlabelled sink kept per source state.
 */
export function crawlGraphToDot(graph: CrawlGraph): string {
    const lines: string[] = ['digraph crawl {', '  rankdir=LR;', '  node [shape=box,fontsize=10];'];
    for (const n of graph.nodes) {
        const label = `${n.url}\\n#${n.stateHash.slice(0, 8)} d=${n.crawlDepth}`.replace(/"/g, '\\"');
        const attrs = n.isRoot ? ',style=filled,fillcolor="#cde"' : '';
        lines.push(`  "${n.id}" [label="${label}"${attrs}];`);
    }
    let dead = 0;
    for (const e of graph.edges) {
        const edgeLabel = truncate(`${e.element}:${e.cssPath}`, 40).replace(/"/g, '\\"');
        if (e.to) {
            lines.push(`  "${e.from}" -> "${e.to}" [label="${edgeLabel}"];`);
        } else {
            const sink = `dead_${dead++}`;
            lines.push(`  "${sink}" [label="∅ ${edgeLabel}",shape=note,style=dashed];`);
            lines.push(`  "${e.from}" -> "${sink}" [style=dashed];`);
        }
    }
    lines.push('}');
    return lines.join('\n') + '\n';
}
