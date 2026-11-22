import type CrawlState from './crawlState';
import type CrawlAction from './crawlAction';
import {
    CRAWL_GRAPH_VERSION,
    CrawlGraph,
    CrawlGraphEdge,
    CrawlGraphEdgeStatus,
    CrawlGraphNode,
    PruneReason,
    countEdgeStatuses,
} from './crawlGraph';

/** In-progress edge status; `discovered` is internal and becomes `no-child-state`
 * at snapshot if it never reaches a terminal fate. */
type LiveEdgeStatus = 'discovered' | CrawlGraphEdgeStatus;

interface LiveEdge {
    from: string;
    to: string | null;
    toStateHash: string | null;
    element: string;
    action: string;
    cssPath: string;
    actionHash: string;
    status: LiveEdgeStatus;
}

/**
 * Live crawl-graph recorder (SCAN-197).
 *
 * End-of-crawl reconstruction (`buildCrawlGraph`) can only see the traversed
 * tree: the crawler consumes the frontier and prunes actions as it goes, so a
 * completed crawl no longer knows which actions were discovered-then-dropped.
 * That fate is exactly what diagnoses a coverage gap (was an anchor deduped at
 * discovery, or executed and pruned on a failed replay?), so it must be captured
 * *as it happens*, the same way the endpoint inventory is.
 *
 * The crawler feeds this recorder at four hooks: a state is created, an action
 * is discovered (added to the frontier) or deduped (dropped at discovery), an
 * action executes into a child, and an action is pruned. Each edge is keyed by
 * (source state, actionHash); a later executed/pruned outcome upgrades the
 * `discovered` edge in place. The recorder never mutates the crawl and holds
 * only metadata, so it is bounded by the surface, not the traffic.
 */
export class CrawlGraphRecorder {
    private readonly nodes = new Map<string, CrawlGraphNode>();
    private readonly edges = new Map<string, LiveEdge>();
    /** Root states; the first state recorded is one, and every seed is marked (SCAN-229). */
    private readonly rootStateIds = new Set<string>();
    private edgesDropped = 0;

    /**
     * @param maxEdges - Ceiling on recorded edges; 0 or undefined means no cap.
     * The recorder holds one small object per action, which is nothing at a few
     * thousand and is not nothing on a crawl that runs for hours — and in API
     * mode this process serves every scan, so it may not trade its own liveness
     * for a diagnostic. Past the ceiling no new edge is added, but edges already
     * recorded still receive their outcomes, so the partial graph stays true.
     */
    constructor(private readonly maxEdges = 0) { }

    /** Whether a new edge may still be recorded. */
    private hasRoom(): boolean {
        return this.maxEdges <= 0 || this.edges.size < this.maxEdges;
    }

    private edgeKey(fromStateId: string, actionHash: string): string {
        return `${fromStateId}|${actionHash}`;
    }

    /** Records a DOM state as a node. The first state recorded is the root. */
    recordState(state: CrawlState): void {
        if (this.rootStateIds.size === 0) {
            this.rootStateIds.add(state.stateId);
        }
        if (this.nodes.has(state.stateId)) {
            return;
        }
        this.nodes.set(state.stateId, {
            id: state.stateId,
            stateHash: state.stateHash,
            url: state.url,
            crawlDepth: state.crawlDepth,
            arrivalType: state.arrivalType,
            actions: 0, // filled from the edge tally at snapshot time
            inputs: state.crawlInputs.length,
            isRoot: this.rootStateIds.has(state.stateId),
        });
    }

    /**
     * Marks a state as a root of the crawl forest — one per seed URL. Safe to
     * call before or after the state is recorded.
     * @param stateId - The seed state's id.
     */
    markRoot(stateId: string): void {
        this.rootStateIds.add(stateId);
        const node = this.nodes.get(stateId);
        if (node) {
            node.isRoot = true;
        }
    }

    /** An action that survived dedup and was added to the frontier. */
    recordDiscovered(action: CrawlAction): void {
        const from = action.parentState.stateId;
        const key = this.edgeKey(from, action.actionHash);
        if (this.edges.has(key)) {
            return;
        }
        if (!this.hasRoom()) {
            this.edgesDropped++;
            return;
        }
        this.edges.set(key, {
            from,
            to: null,
            toStateHash: null,
            element: action.element,
            action: action.action,
            cssPath: action.cssPath,
            actionHash: action.actionHash,
            status: 'discovered',
        });
    }

    /**
     * A candidate action dropped at discovery because its signature was already
     * seen (`isCrawlActionUnique` false). It never becomes a CrawlAction, so the
     * caller passes its raw fields.
     */
    recordDeduped(fromState: CrawlState, element: string, cssPath: string, actionHash: string): void {
        const key = this.edgeKey(fromState.stateId, actionHash);
        const existing = this.edges.get(key);
        if (existing && existing.status !== 'discovered') {
            return; // already has a terminal fate
        }
        if (!existing && !this.hasRoom()) {
            this.edgesDropped++;
            return;
        }
        this.edges.set(key, {
            from: fromState.stateId,
            to: null,
            toStateHash: null,
            element,
            action: 'click',
            cssPath,
            actionHash,
            status: 'deduped',
        });
    }

    /** An action that executed and produced (or collapsed onto) a child state. */
    recordExecuted(action: CrawlAction, child: CrawlState): void {
        const key = this.edgeKey(action.parentState.stateId, action.actionHash);
        if (!this.edges.has(key) && !this.hasRoom()) {
            this.edgesDropped++;
            return;
        }
        const edge = this.edges.get(key) ?? {
            from: action.parentState.stateId,
            to: null,
            toStateHash: null,
            element: action.element,
            action: action.action,
            cssPath: action.cssPath,
            actionHash: action.actionHash,
            status: 'executed' as LiveEdgeStatus,
        };
        edge.to = child.stateId;
        edge.toStateHash = child.stateHash;
        edge.status = 'executed';
        this.edges.set(key, edge);
    }

    /**
     * An action removed from its parent state, recorded by *why* (SCAN-198).
     *
     * All three removal paths call one funnel, so the reason has to be carried
     * in rather than inferred here: an action that executed and landed on a
     * known state is a healthy revisit, an action that left the scope is a
     * healthy boundary, and only an action that never executed — its selector
     * did not resolve, or the click failed — is the coverage gap the artifact
     * exists to surface. Recording all three as `pruned` is what made a
     * perfectly healthy crawl read as an 80%-failure one.
     * @param action - The action being removed from its parent state.
     * @param reason - Why it was removed; defaults to a genuine resolution failure.
     */
    recordPruned(action: CrawlAction, reason: PruneReason = 'unresolved'): void {
        const key = this.edgeKey(action.parentState.stateId, action.actionHash);
        const edge = this.edges.get(key);
        if (edge && edge.status === 'executed') {
            return; // it already produced a child; a later removal does not undo that
        }
        if (!edge && !this.hasRoom()) {
            this.edgesDropped++;
            return;
        }
        const status: CrawlGraphEdgeStatus =
            reason === 'revisited' ? 'revisited'
                : reason === 'out-of-scope' ? 'out-of-scope'
                    // Spent by another copy of the same widget while this one
                    // waited: the same fate as a discovery-time dedup, and it
                    // reads as one in the artifact.
                    : reason === 'duplicate' ? 'deduped'
                        : 'pruned';
        this.edges.set(key, {
            from: action.parentState.stateId,
            to: null,
            toStateHash: null,
            element: action.element,
            action: action.action,
            cssPath: action.cssPath,
            actionHash: action.actionHash,
            status,
        });
    }

    /**
     * Serialises the recorded graph. Edges still `discovered` at snapshot time
     * (never executed, pruned or deduped) are emitted as `no-child-state`, the
     * same label reconstruction uses for an unresolved frontier action.
     */
    snapshot(entryPoint: string): CrawlGraph {
        const edges: CrawlGraphEdge[] = [...this.edges.values()].map((e) => ({
            ...e,
            status: e.status === 'discovered' ? 'no-child-state' : e.status,
        }));

        const outDegree = new Map<string, number>();
        for (const e of edges) {
            outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
        }

        const nodes: CrawlGraphNode[] = [...this.nodes.values()].map((n) => ({
            ...n,
            actions: outDegree.get(n.id) ?? 0,
        }));

        return {
            version: CRAWL_GRAPH_VERSION,
            entryPoint,
            source: 'recorded',
            ...(this.edgesDropped > 0 ? { truncated: true, edgesDropped: this.edgesDropped } : {}),
            stateCount: nodes.length,
            edgeCount: edges.length,
            statusCounts: countEdgeStatuses(edges),
            nodes,
            edges,
        };
    }
}
