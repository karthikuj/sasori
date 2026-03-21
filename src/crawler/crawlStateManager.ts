import CrawlState from './crawlState';
import CrawlAction from './crawlAction';

/**
 * Interface for the CrawlStateManager class
 */
export interface CrawlStateManagerInterface {
    rootState: CrawlState | null;
    visitedActions: Set<string>;

    traverse(rootState: CrawlState, visited: CrawlState[]): void;
    attachRootState(root: CrawlState | null): void;
    registerState(state: CrawlState): void;
    registerActionSignature(cssPath: string, actionHash: string): void;
    unregisterActionSignature(cssPath: string, actionHash: string): void;
    getStateByHash(stateHash: string): CrawlState | null;
    getNextCrawlAction(): CrawlAction | null;
    isCrawlActionUnique(cssPath: string, actionHash: string): boolean;
    getOptimizedReplayPlan(destinationState: CrawlState): ReplayPlan | null;
}

/**
 * The CrawlStateManager is responsible for creating and managing the crawl graph.
 * It provides methods to traverse the state graph, find states by hash, get next actions,
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
    private readonly actionSignatureRefCount: Map<string, number> = new Map();

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
    private isValidCrawlState(state: any): state is CrawlState {
        return (
            state &&
            typeof state === 'object' &&
            typeof state.stateId === 'string' &&
            typeof state.url === 'string' &&
            typeof state.stateHash === 'string' &&
            typeof state.crawlDepth === 'number' &&
            Array.isArray(state.crawlInputs) &&
            Array.isArray(state.crawlActions) &&
            typeof state.getCrawlActions === 'function' &&
            typeof state.getCrawlDepth === 'function' &&
            typeof state.getCrawlInputs === 'function'
        );
    }

    /**
     * Traverse the state graph starting from the given root state.
     * This method performs a depth-first traversal and logs each state's URL.
     * @param rootState - The state to start traversal from
     * @param visited - Array to track visited states (passed by reference)
     * @throws {Error} If rootState is null or invalid
     */
    public traverse(rootState: CrawlState, visited: CrawlState[]): void {
        if (!this.isValidCrawlState(rootState)) {
            throw new Error('Invalid rootState provided to traverse method');
        }

        if (!Array.isArray(visited)) {
            throw new Error('Visited parameter must be an array');
        }

        console.log(rootState.url);

        try {
            const crawlActions = rootState.getCrawlActions();
            if (!Array.isArray(crawlActions)) {
                throw new Error('getCrawlActions() must return an array');
            }

            for (const action of crawlActions) {
                if (!this.isValidCrawlAction(action)) {
                    console.warn('Invalid crawl action found, skipping:', action);
                    continue;
                }

                if (action.childState && !visited.includes(action.childState)) {
                    visited.push(action.childState);
                    this.traverse(action.childState, visited);
                }
            }
        } catch (error) {
            console.error('Error during traversal:', error);
            throw new Error(`Traversal failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Validates if the provided object is a valid CrawlAction
     * @param action - Object to validate
     * @returns True if valid CrawlAction, false otherwise
     */
    private isValidCrawlAction(action: any): action is CrawlAction {
        return (
            action &&
            typeof action === 'object' &&
            typeof action.actionId === 'string' &&
            typeof action.element === 'string' &&
            typeof action.action === 'string' &&
            typeof action.cssPath === 'string' &&
            typeof action.actionHash === 'string' &&
            this.isValidCrawlState(action.parentState) &&
            (action.childState === null || this.isValidCrawlState(action.childState)) &&
            (typeof action.getChildState === 'function' || action.childState !== undefined)
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
     * Returns false if CrawlAction with the same cssPath and actionHash is found, otherwise true.
     * Uses a ref-count index for O(1) average-time checks when the root is attached.
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
        while (true) {
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
