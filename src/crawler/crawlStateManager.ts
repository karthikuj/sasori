import CrawlState from './crawlState';
import CrawlAction from './crawlAction';

/**
 * Interface for the CrawlStateManager class
 */
export interface CrawlStateManagerInterface {
    rootState: CrawlState | null;
    visitedActions: Set<string>;

    traverse(rootState: CrawlState, visited: CrawlState[]): void;
    getStateByHash(stateHash: string): CrawlState | null;
    getNextCrawlAction(): CrawlAction | null;
    isCrawlActionUnique(cssPath: string, actionHash: string): boolean;
    getShortestPath(destinationState: CrawlState): CrawlAction[] | null;
}

/**
 * The CrawlStateManager is responsible for creating and managing the crawl graph.
 * It provides methods to traverse the state graph, find states by hash, get next actions,
 * check action uniqueness, and find shortest paths between states.
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
     * Uses iterative depth-first search to avoid stack overflow on large graphs.
     * @param stateHash - The hash to search for
     * @returns The CrawlState with matching hash, or null if not found
     * @throws {Error} If stateHash is not a valid string
     */
    public getStateByHash(stateHash: string): CrawlState | null {
        if (typeof stateHash !== 'string' || stateHash.trim() === '') {
            throw new Error('stateHash must be a non-empty string');
        }

        if (!this.rootState) {
            return null;
        }

        const stack: CrawlState[] = [this.rootState];
        const visited = new Set<string>();

        while (stack.length > 0) {
            const currentState = stack.pop()!;

            if (!visited.has(currentState.stateId)) {
                visited.add(currentState.stateId);

                if (currentState.stateHash === stateHash) {
                    return currentState;
                }

                try {
                    const crawlActions = currentState.getCrawlActions();
                    if (Array.isArray(crawlActions)) {
                        for (const action of crawlActions) {
                            if (this.isValidCrawlAction(action) &&
                                action.childState &&
                                this.isValidCrawlState(action.childState) &&
                                !visited.has(action.childState.stateId)) {
                                stack.push(action.childState);
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error getting crawl actions for state:', currentState.stateId, error);
                }
            }
        }

        return null;
    }

    /**
     * Return the next crawlAction to be performed.
     * Uses iterative depth-first search to find unvisited actions.
     * @returns The next unvisited CrawlAction, or null if all actions have been visited
     */
    public getNextCrawlAction(): CrawlAction | null {
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
                        // Check if this action has already been visited by the manager
                        if (!this.visitedActions.has(currentAction.actionId)) {
                            this.visitedActions.add(currentAction.actionId);
                            return currentAction;
                        }

                        // If this action has a child state, explore its actions
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
            console.error('Error getting next crawl action:', error);
        }

        return null;
    }

    /**
     * Returns false if CrawlAction with the same cssPath and actionHash is found, otherwise true.
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

        const stack: CrawlAction[] = [...this.rootState.getCrawlActions()];
        const visited = new Set<string>();

        while (stack.length > 0) {
            const currentAction = stack.pop()!;

            if (!visited.has(currentAction.actionId)) {
                visited.add(currentAction.actionId);

                if (this.isValidCrawlAction(currentAction) &&
                    currentAction.cssPath === cssPath &&
                    currentAction.actionHash === actionHash) {
                    return false;
                }

                const childState = currentAction.childState;
                if (childState && this.isValidCrawlState(childState)) {
                    try {
                        const childActions = childState.getCrawlActions();
                        if (Array.isArray(childActions)) {
                            stack.push(...childActions);
                        }
                    } catch (error) {
                        console.warn('Error getting child actions for uniqueness check:', error);
                    }
                }
            }
        }

        return true;
    }

    /**
     * Returns the shortest path to a CrawlState from the root state.
     * Uses breadth-first search to find the shortest path.
     * @param destinationState - The target state to find a path to
     * @returns Array of CrawlActions representing the shortest path, or null if no path exists
     * @throws {Error} If destinationState is not a valid CrawlState
     */
    public getShortestPath(destinationState: CrawlState): CrawlAction[] | null {
        if (!this.isValidCrawlState(destinationState)) {
            throw new Error('Invalid destinationState provided to getShortestPath method');
        }

        if (!this.rootState) {
            return null;
        }

        // If the destination is the root state, return empty path
        if (this.rootState === destinationState) {
            return [];
        }

        // Use a queue structure to store the current state, actions, and action count
        const queue: { state: CrawlState; actions: CrawlAction[]; actionCount: number }[] = [{
            state: this.rootState,
            actions: [],
            actionCount: 0
        }];
        const visited = new Set<string>();
        let queueIndex = 0;

        while (queueIndex < queue.length) {
            const current = queue[queueIndex++];
            if (!current) continue;

            const { state: currentState, actions: currentActions, actionCount } = current;

            if (!visited.has(currentState.stateId)) {
                visited.add(currentState.stateId);

                // If the current state is the destination state, return the actions
                if (currentState === destinationState) {
                    return currentActions;
                }

                try {
                    const crawlActions = currentState.getCrawlActions();
                    if (crawlActions) {
                        // If the crawl actions are valid, add the actions to the queue
                        for (const action of crawlActions) {
                            if (this.isValidCrawlAction(action) &&
                                action.childState &&
                                this.isValidCrawlState(action.childState) &&
                                !visited.has(action.childState.stateId)) {

                                // Reuse currentActions array and push new action to the queue
                                const newActions = currentActions.slice(0, actionCount);
                                newActions.push(action);

                                queue.push({
                                    state: action.childState,
                                    actions: newActions,
                                    actionCount: actionCount + 1
                                });
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error getting actions for BFS:', error);
                }
            }
        }

        return null;
    }

    /**
     * Clears the visited actions set, allowing all actions to be considered again
     */
    public clearVisitedActions(): void {
        this.visitedActions.clear();
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

export default CrawlStateManager;
