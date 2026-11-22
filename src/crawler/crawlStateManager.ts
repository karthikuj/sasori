import CrawlState from './crawlState';
import CrawlAction from './crawlAction';

/**
 * Interface for the CrawlStateManager class
 */
export interface CrawlStateManagerInterface {
    rootState: CrawlState | null;
    visitedActions: Set<string>;

    attachRootState(root: CrawlState | null): void;
    registerState(state: CrawlState): void;
    registerActionSignature(cssPath: string, actionHash: string): void;
    unregisterActionSignature(cssPath: string, actionHash: string): void;
    shouldRetainAction(cssPath: string, actionHash: string): boolean;
    hasExecutedActionSignature(cssPath: string, actionHash: string): boolean;
    markActionSignatureExecuted(cssPath: string, actionHash: string): void;
    getStateByHash(stateHash: string): CrawlState | null;
    getStates(): CrawlState[];
    getNextCrawlAction(): CrawlAction | null;
    isCrawlActionUnique(cssPath: string, actionHash: string): boolean;
    getOptimizedReplayPlan(destinationState: CrawlState): ReplayPlan | null;
}

/**
 * The CrawlStateManager is responsible for creating and managing the crawl graph.
 * It provides methods to find states by hash, get next actions,
 * check action uniqueness, and compute replay plans between states.
 */
export class CrawlStateManager implements CrawlStateManagerInterface {
    /**
     * The root state of the crawl graph
     */
    public rootState: CrawlState | null;

    /**
     * Set of action IDs that have been visited to avoid duplicate processing
     */
    public visitedActions: Set<string>;

    /**
     * Index: stripped DOM hash → state (amortized O(1) lookup).
     * {@link CrawlState.stateHash} remains the canonical field on each vertex.
     */
    private readonly stateByHash: Map<string, CrawlState> = new Map();

    /**
     * Ref-count of (cssPath, actionHash) signatures across all actions in the graph.
     * Used for O(1) duplicate detection; decremented when actions are removed from a state.
     */
    /**
     * How many *un-executed* actions with each signature are currently held in
     * the graph. Not a claim — see {@link shouldRetainAction} — only a bound on
     * how many copies of the same widget are kept waiting at once.
     */
    private readonly actionSignatureRefCount: Map<string, number> = new Map();

    /**
     * Signatures that have actually been clicked, once each, for the life of the
     * crawl. Monotonic on purpose: this is a receipt, not a lock (SCAN-198).
     */
    private readonly executedActionSignatures: Set<string> = new Set();

    /**
     * How many un-executed copies of one signature the graph will hold.
     *
     * The dedup exists because a nav bar and a global search box appear in every
     * state, and clicking them once per page is the crawl equivalent of walking
     * in circles. But keeping exactly *one* copy made that copy a single point of
     * failure: it is claimed by whichever page discovered it first, and if the
     * frontier never reaches that page the widget is never exercised anywhere,
     * because every later copy is dropped at discovery in deference to it. That
     * is how a price-filter form present on 44 category pages ended up submitted
     * zero times — one copy parked on the frontier, eight twins discarded.
     *
     * A small redundancy removes the single point of failure without giving up
     * the bound: whichever copy the frontier reaches first spends the signature,
     * and the rest are skipped at pop time for the cost of a set lookup. Three is
     * enough that a copy has to be unlucky three times over to strand a widget,
     * and small enough that a ten-thousand-product catalogue holds three
     * "add to cart" actions rather than ten thousand.
     */
    private static readonly MAX_UNEXECUTED_TWINS = 3;

    /**
     * LIFO frontier of pending actions (array end = stack top). New states enqueue via
     * {@link registerState}; {@link reindexFromRoot} reseeds from the root only.
     */
    private readonly pendingFrontier: CrawlAction[] = [];

    /**
     * Action IDs already placed on the frontier (prevents duplicate queue entries).
     */
    private readonly queuedActionIds: Set<string> = new Set();

    /**
     * CrawlStateManager object constructor.
     * @param rootState - The root state of the crawl graph, can be null for empty manager
     * @throws {Error} If rootState is provided but is not a valid CrawlState instance
     */
    constructor(rootState?: CrawlState | null) {
        // Validate rootState if provided
        if (rootState !== null && rootState !== undefined) {
            if (!this.isValidCrawlState(rootState)) {
                throw new Error('Invalid CrawlState provided to CrawlStateManager constructor');
            }
        }

        this.rootState = rootState ?? null;
        this.visitedActions = new Set<string>();
        if (this.rootState) {
            this.reindexFromRoot();
        }
    }

    /**
     * Stable key for (cssPath, actionHash) — avoids delimiter collisions inside selectors.
     */
    public static makeActionSignatureKey(cssPath: string, actionHash: string): string {
        return JSON.stringify([cssPath, actionHash]);
    }

    /**
     * Sets the root and rebuilds hash / action-signature indexes from the crawl tree.
     * Use after the root state is fully constructed (e.g. after Crawler builds the initial state).
     */
    public attachRootState(root: CrawlState | null): void {
        if (root !== null && root !== undefined && !this.isValidCrawlState(root)) {
            throw new Error('Invalid CrawlState provided to attachRootState');
        }
        this.rootState = root ?? null;
        this.reindexFromRoot();
    }

    /**
     * Registers a vertex by {@link CrawlState.stateHash} (one canonical hash per state object).
     */
    public registerState(state: CrawlState): void {
        if (!this.isValidCrawlState(state)) {
            throw new Error('Invalid CrawlState provided to registerState');
        }
        this.stateByHash.set(state.stateHash, state);
        this.enqueueActionsForState(state);
    }

    /**
     * Pushes this state's crawl actions onto the frontier (end of array = stack top).
     * Order matches the previous DFS stack built from `[...actions]` then pop (last action first).
     */
    private enqueueActionsForState(state: CrawlState): void {
        try {
            const crawlActions = state.getCrawlActions();
            if (!Array.isArray(crawlActions)) {
                return;
            }
            for (const action of crawlActions) {
                if (!this.isValidCrawlAction(action)) {
                    continue;
                }
                if (this.queuedActionIds.has(action.actionId)) {
                    continue;
                }
                this.queuedActionIds.add(action.actionId);
                this.pendingFrontier.push(action);
            }
        } catch (error) {
            console.warn('Error enqueueing crawl actions for state:', state.stateId, error);
        }
    }

    /**
     * Clears the frontier and re-enqueues only the root state's actions (children arrive via
     * {@link registerState} when discovered). Used after {@link reindexFromRoot} rebuilds maps.
     */
    private rebuildPendingFrontierFromRoot(): void {
        this.pendingFrontier.length = 0;
        this.queuedActionIds.clear();
        if (!this.rootState || !this.isValidCrawlState(this.rootState)) {
            return;
        }
        this.enqueueActionsForState(this.rootState);
    }

    /**
     * Increments the global ref-count for an action signature when an action is added to the graph.
     */
    public registerActionSignature(cssPath: string, actionHash: string): void {
        if (typeof cssPath !== 'string' || cssPath.trim() === '') {
            throw new Error('cssPath must be a non-empty string');
        }
        if (typeof actionHash !== 'string' || actionHash.trim() === '') {
            throw new Error('actionHash must be a non-empty string');
        }
        const key = CrawlStateManager.makeActionSignatureKey(cssPath, actionHash);
        this.actionSignatureRefCount.set(key, (this.actionSignatureRefCount.get(key) ?? 0) + 1);
    }

    /**
     * Decrements the ref-count when an action is removed from a state's list.
     */
    public unregisterActionSignature(cssPath: string, actionHash: string): void {
        if (typeof cssPath !== 'string' || cssPath.trim() === '') {
            throw new Error('cssPath must be a non-empty string');
        }
        if (typeof actionHash !== 'string' || actionHash.trim() === '') {
            throw new Error('actionHash must be a non-empty string');
        }
        const key = CrawlStateManager.makeActionSignatureKey(cssPath, actionHash);
        const next = (this.actionSignatureRefCount.get(key) ?? 0) - 1;
        if (next <= 0) {
            this.actionSignatureRefCount.delete(key);
        } else {
            this.actionSignatureRefCount.set(key, next);
        }
    }

    /**
     * Rebuilds {@link stateByHash} and {@link actionSignatureRefCount} from {@link rootState}.
     */
    private reindexFromRoot(): void {
        this.stateByHash.clear();
        this.actionSignatureRefCount.clear();
        if (!this.rootState) {
            this.pendingFrontier.length = 0;
            this.queuedActionIds.clear();
            return;
        }

        const stack: CrawlState[] = [this.rootState];
        const visited = new Set<string>();

        while (stack.length > 0) {
            const currentState = stack.pop()!;

            if (visited.has(currentState.stateId)) {
                continue;
            }
            visited.add(currentState.stateId);

            if (!this.isValidCrawlState(currentState)) {
                continue;
            }

            this.stateByHash.set(currentState.stateHash, currentState);

            try {
                const crawlActions = currentState.getCrawlActions();
                if (!Array.isArray(crawlActions)) {
                    continue;
                }
                for (const action of crawlActions) {
                    if (!this.isValidCrawlAction(action)) {
                        continue;
                    }
                    this.registerActionSignature(action.cssPath, action.actionHash);
                    const childState = action.childState;
                    if (childState && this.isValidCrawlState(childState) && !visited.has(childState.stateId)) {
                        stack.push(childState);
                    }
                }
            } catch (error) {
                console.warn('Error reindexing crawl actions for state:', currentState.stateId, error);
            }
        }

        this.rebuildPendingFrontierFromRoot();
    }

    /**
     * Validates if the provided object is a valid CrawlState
     * @param state - Object to validate
     * @returns True if valid CrawlState, false otherwise
     */
    private isValidCrawlState(state: unknown): state is CrawlState {
        if (state === null || typeof state !== 'object') {
            return false;
        }
        // Duck-typed against an index signature rather than `any`. The guard
        // exists precisely because callers hand it values the compiler cannot
        // vouch for, so the narrowing has to be done by hand — but it should be
        // done once, here, instead of switching the parameter off type checking.
        const candidate = state as Record<string, unknown>;
        return (
            typeof candidate['stateId'] === 'string' &&
            typeof candidate['url'] === 'string' &&
            typeof candidate['stateHash'] === 'string' &&
            typeof candidate['crawlDepth'] === 'number' &&
            Array.isArray(candidate['crawlInputs']) &&
            Array.isArray(candidate['crawlActions']) &&
            typeof candidate['getCrawlActions'] === 'function' &&
            typeof candidate['getCrawlDepth'] === 'function' &&
            typeof candidate['getCrawlInputs'] === 'function'
        );
    }

    /**
     * Validates if the provided object is a valid CrawlAction
     * @param action - Object to validate
     * @returns True if valid CrawlAction, false otherwise
     */
    private isValidCrawlAction(action: unknown): action is CrawlAction {
        if (action === null || typeof action !== 'object') {
            return false;
        }
        const candidate = action as Record<string, unknown>;
        return (
            typeof candidate['actionId'] === 'string' &&
            typeof candidate['element'] === 'string' &&
            typeof candidate['action'] === 'string' &&
            typeof candidate['cssPath'] === 'string' &&
            typeof candidate['actionHash'] === 'string' &&
            this.isValidCrawlState(candidate['parentState']) &&
            (candidate['childState'] === null || this.isValidCrawlState(candidate['childState'])) &&
            (typeof candidate['getChildState'] === 'function' || candidate['childState'] !== undefined)
        );
    }

    /**
     * Returns CrawlState with the given stateHash if found, otherwise null.
     * Uses the internal state-by-hash index (returns null if that hash was never registered).
     * @param stateHash - The hash to search for
     * @returns The CrawlState with matching hash, or null if not found
     * @throws {Error} If stateHash is not a valid string
     */
    public getStateByHash(stateHash: string): CrawlState | null {
        if (typeof stateHash !== 'string' || stateHash.trim() === '') {
            throw new Error('stateHash must be a non-empty string');
        }

        return this.stateByHash.get(stateHash) ?? null;
    }

    /**
     * Returns every registered state, in insertion order. Used by the crawl-graph
     * exporter to serialise the full state/action graph at scan end; the crawl
     * loop itself never enumerates all states, so this exists only for tooling.
     */
    public getStates(): CrawlState[] {
        return [...this.stateByHash.values()];
    }

    /**
     * Return the next crawlAction to be performed.
     * Pops from the explicit {@link pendingFrontier} (LIFO, same order as the prior root DFS stack)
     * instead of re-traversing from the root each time.
     * @returns The next unvisited CrawlAction, or null if all actions have been visited
     */
    public getNextCrawlAction(): CrawlAction | null {
        if (!this.rootState) {
            return null;
        }

        try {
            while (this.pendingFrontier.length > 0) {
                const action = this.pendingFrontier.pop()!;
                if (!this.isValidCrawlAction(action)) {
                    continue;
                }

                let stillInParent = false;
                try {
                    stillInParent = action.parentState.crawlActions.some((a) => a.actionId === action.actionId);
                } catch {
                    continue;
                }
                if (!stillInParent) {
                    continue;
                }

                if (this.visitedActions.has(action.actionId)) {
                    continue;
                }

                this.visitedActions.add(action.actionId);
                return action;
            }
        } catch (error) {
            console.error('Error getting next crawl action:', error);
        }

        return null;
    }

    /**
     * Whether discovery should keep an action with this signature.
     *
     * Two reasons to say no: the widget has already been clicked somewhere (the
     * receipt is in), or the graph is already holding
     * {@link MAX_UNEXECUTED_TWINS} copies of it waiting to be clicked. Note what
     * is *not* a reason: another copy merely existing. That was the old rule, and
     * it let one un-executed copy speak for every page it appeared on.
     * @param cssPath - The CSS path of the candidate action.
     * @param actionHash - The structural hash of the candidate action.
     * @return True when the action should be added to its state.
     */
    public shouldRetainAction(cssPath: string, actionHash: string): boolean {
        const key = CrawlStateManager.makeActionSignatureKey(cssPath, actionHash);
        if (this.executedActionSignatures.has(key)) {
            return false;
        }
        return (this.actionSignatureRefCount.get(key) ?? 0) < CrawlStateManager.MAX_UNEXECUTED_TWINS;
    }

    /**
     * Whether this widget has already been clicked during this crawl. Checked
     * when an action is popped, so a copy that became redundant while it waited
     * costs a set lookup instead of a click and a replay.
     * @param cssPath - The CSS path of the action.
     * @param actionHash - The structural hash of the action.
     * @return True when the signature has already been executed.
     */
    public hasExecutedActionSignature(cssPath: string, actionHash: string): boolean {
        return this.executedActionSignatures.has(CrawlStateManager.makeActionSignatureKey(cssPath, actionHash));
    }

    /**
     * Records that this widget has now been clicked. Never undone: a signature
     * spent is spent, which is what holds site chrome to one click per crawl
     * rather than one per page.
     * @param cssPath - The CSS path of the action that ran.
     * @param actionHash - The structural hash of the action that ran.
     */
    public markActionSignatureExecuted(cssPath: string, actionHash: string): void {
        this.executedActionSignatures.add(CrawlStateManager.makeActionSignatureKey(cssPath, actionHash));
    }

    /**
     * Returns false if CrawlAction with the same cssPath and actionHash is found, otherwise true.
     * Retained for callers that ask the narrow question; discovery uses
     * {@link shouldRetainAction}, which also allows a bounded number of twins.
     * @param cssPath - The CSS path to check for uniqueness
     * @param actionHash - The action hash to check for uniqueness
     * @returns True if the action is unique, false if a duplicate is found
     * @throws {Error} If cssPath or actionHash are not valid strings
     */
    public isCrawlActionUnique(cssPath: string, actionHash: string): boolean {
        if (typeof cssPath !== 'string' || cssPath.trim() === '') {
            throw new Error('cssPath must be a non-empty string');
        }
        if (typeof actionHash !== 'string' || actionHash.trim() === '') {
            throw new Error('actionHash must be a non-empty string');
        }

        if (!this.rootState) {
            return true;
        }

        const key = CrawlStateManager.makeActionSignatureKey(cssPath, actionHash);
        const count = this.actionSignatureRefCount.get(key) ?? 0;
        return count === 0;
    }

    /**
     * Computes an optimized replay plan to reach a destination state.
     *
     * Strategy:
     * - Walk parent pointers from the destination toward the root.
     * - Along that path, identify the last child state that was reached via a full page navigation
     *   (i.e., its `arrivalType` is 'link'). We call this the "baseline" state.
     * - Return a plan consisting of:
     *   - baselineUrl: URL of that baseline state (or root URL if no link-based state exists yet).
     *   - actionsToReplay: only the actions that come after that baseline in the path (typically DOM interactions).
     *
     * Benefits:
     * - Jumping directly to a link-reached ancestor drastically reduces the amount of replay required
     *   versus always starting from the root and replaying all actions.
     * - DOM actions (forms, buttons, etc.) are then replayed from that nearer baseline.
     */
    public getOptimizedReplayPlan(destinationState: CrawlState): ReplayPlan | null {
        const startedAt = Date.now();
        try {
            return this.computeOptimizedReplayPlan(destinationState);
        } finally {
            this.recordReplayPlanTiming(Date.now() - startedAt);
        }
    }

    /**
     * Running stats for {@link getOptimizedReplayPlan}.
     *
     * Planning is ~O(path length) per action over a graph bounded only by
     * `maxDepth` (up to 100) and `maxChildren` (up to 1000). That is fine today,
     * but on a large SPA the cost is invisible without measurement — the crawl
     * just gets slower with nothing to point at. These counters make a real
     * regression attributable instead of a mystery.
     */
    private replayPlanCalls = 0;

    private replayPlanTotalMs = 0;

    private replayPlanMaxMs = 0;

    /** Log a warning at most once per this many slow plans, to avoid log spam. */
    private static readonly SLOW_REPLAY_PLAN_MS = 50;

    private recordReplayPlanTiming(elapsedMs: number): void {
        this.replayPlanCalls += 1;
        this.replayPlanTotalMs += elapsedMs;
        if (elapsedMs > this.replayPlanMaxMs) {
            this.replayPlanMaxMs = elapsedMs;
        }
        if (elapsedMs >= CrawlStateManager.SLOW_REPLAY_PLAN_MS) {
            // eslint-disable-next-line no-console
            console.warn(
                `[sasori] slow replay plan: ${elapsedMs}ms over ${this.stateByHash.size} states ` +
                    `(call #${this.replayPlanCalls}). If this is frequent, replay planning has ` +
                    'become the crawl bottleneck.',
            );
        }
    }

    /**
     * Snapshot of replay-planning cost for this crawl. Surfaced so the crawler
     * can report it at the end of a run.
     */
    public getReplayPlanStats(): {
        calls: number;
        totalMs: number;
        maxMs: number;
        averageMs: number;
        stateCount: number;
    } {
        return {
            calls: this.replayPlanCalls,
            totalMs: this.replayPlanTotalMs,
            maxMs: this.replayPlanMaxMs,
            averageMs: this.replayPlanCalls === 0 ? 0 : this.replayPlanTotalMs / this.replayPlanCalls,
            stateCount: this.stateByHash.size,
        };
    }

    private computeOptimizedReplayPlan(destinationState: CrawlState): ReplayPlan | null {
        if (!this.isValidCrawlState(destinationState)) {
            throw new Error('Invalid destinationState provided to getOptimizedReplayPlan method');
        }

        if (!this.rootState) {
            return null;
        }

        // If already at the root, there is nothing to replay.
        if (this.rootState === destinationState) {
            return { baselineUrl: this.rootState.url, actionsToReplay: [] };
        }

        // Walk up from destination to find the nearest link ancestor
        const reversePath: CrawlAction[] = [];
        let currentState: CrawlState | null = destinationState;
        let baselineUrl = this.rootState.url;
        let foundLinkAncestor = false;

        while (currentState && currentState !== this.rootState) {
            // Use the parentAction pointer on the state to move upward efficiently
            const parentAction: CrawlAction | null = currentState.parentAction ?? null;
            if (!parentAction) {
                break; // No path found
            }

            // If this state arrived via link, we found our baseline
            if (currentState.arrivalType === 'link') {
                baselineUrl = currentState.url;
                foundLinkAncestor = true;
                break; // Stop here - we found the nearest link ancestor
            }

            reversePath.unshift(parentAction); // Add to beginning for correct order

            // Move to parent state via the action
            currentState = parentAction.parentState;
        }

        // If we didn't reach root and didn't find a link ancestor, no valid path exists
        if (currentState !== this.rootState && !foundLinkAncestor) {
            return null;
        }

        // Return replay plan (same in both cases)
        return { baselineUrl, actionsToReplay: reversePath };
    }

    /**
     * Clears the visited actions set, allowing all actions to be considered again.
     * Rebuilds the pending frontier so subsequent {@link getNextCrawlAction} calls match the
     * legacy DFS return order (same as repeatedly running the old root DFS).
     */
    public clearVisitedActions(): void {
        this.visitedActions.clear();
        this.rebuildPendingFrontierAfterClearVisited();
    }

    /**
     * Legacy DFS scan (same logic as the pre-frontier getNextCrawlAction) using an external
     * executed set — used only to rebuild the frontier after clearVisited.
     */
    private findNextActionLegacyDFS(visitedExec: Set<string>): CrawlAction | null {
        if (!this.rootState) {
            return null;
        }

        try {
            const rootActions = this.rootState.getCrawlActions();
            if (!Array.isArray(rootActions)) {
                return null;
            }

            const stack: CrawlAction[] = [...rootActions];
            const visited = new Set<string>();

            while (stack.length > 0) {
                const currentAction = stack.pop()!;

                if (!visited.has(currentAction.actionId)) {
                    visited.add(currentAction.actionId);

                    if (this.isValidCrawlAction(currentAction)) {
                        if (!visitedExec.has(currentAction.actionId)) {
                            return currentAction;
                        }

                        const childState = currentAction.childState;
                        if (childState && this.isValidCrawlState(childState)) {
                            try {
                                const childActions = childState.getCrawlActions();
                                if (Array.isArray(childActions)) {
                                    stack.push(...childActions);
                                }
                            } catch (error) {
                                console.warn('Error getting child actions:', error);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error in findNextActionLegacyDFS:', error);
        }

        return null;
    }

    /**
     * Refills pendingFrontier from a full simulated legacy DFS pass (after visited was cleared).
     */
    private rebuildPendingFrontierAfterClearVisited(): void {
        this.pendingFrontier.length = 0;
        this.queuedActionIds.clear();
        if (!this.rootState) {
            return;
        }

        const order: CrawlAction[] = [];
        const visitedExec = new Set<string>();
        // for(;;) rather than while(true): identical semantics, and it is the
        // form no-constant-condition accepts, so the lint error here does not
        // have to be waived.
        for (;;) {
            const next = this.findNextActionLegacyDFS(visitedExec);
            if (!next) {
                break;
            }
            order.push(next);
            visitedExec.add(next.actionId);
        }

        for (let i = order.length - 1; i >= 0; i--) {
            const action = order[i]!;
            this.queuedActionIds.add(action.actionId);
            this.pendingFrontier.push(action);
        }
    }

    /**
     * Returns the total number of visited actions
     * @returns Number of visited actions
     */
    public getVisitedActionsCount(): number {
        return this.visitedActions.size;
    }

    /**
     * Returns a string representation of the CrawlStateManager
     * @returns String representation of the manager
     */
    public toString(): string {
        return `CrawlStateManager(rootState: ${this.rootState ? this.rootState.url : 'null'}, visitedActions: ${this.visitedActions.size})`;
    }
}

export interface ReplayPlan {
    baselineUrl: string;
    actionsToReplay: CrawlAction[];
}

export default CrawlStateManager;
