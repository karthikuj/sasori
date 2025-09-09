import { randomUUID } from 'crypto';
import CrawlState from './crawlState';
import { CrawlAction as CrawlActionInterface, CrawlActionInterface as CrawlActionClassInterface } from '../types/input';

/**
 * The CrawlAction class specifies the action to take on an element
 * in the DOM (it is an edge in the crawl graph).
 */
class CrawlAction implements CrawlActionInterface, CrawlActionClassInterface {
    /**
     * Static constant for anchor element type
     */
    static readonly ANCHOR: string = 'A';

    /**
     * Unique identifier for this action
     */
    public readonly actionId: string;

    /**
     * The element type this action targets
     */
    public readonly element: string;

    /**
     * The action to perform on the element
     */
    public readonly action: string;

    /**
     * CSS path to locate the element
     */
    public readonly cssPath: string;

    /**
     * Hash identifier for this action
     */
    public readonly actionHash: string;

    /**
     * The parent state from which this action originates
     */
    public readonly parentState: CrawlState;

    /**
     * The child state resulting from this action (initially null)
     */
    public childState: CrawlState | null;

    /**
     * CrawlAction object constructor
     * @param element - The element type this action targets
     * @param action - The action to perform on the element
     * @param cssPath - CSS path to locate the element
     * @param actionHash - Hash identifier for this action
     * @param parentState - The parent state from which this action originates
     */
    constructor(
        element: string,
        action: string,
        cssPath: string,
        actionHash: string,
        parentState: CrawlState
    ) {
        // Validate required parameters
        if (!element || typeof element !== 'string' || element.trim() === '') {
            throw new Error('Element must be a non-empty string');
        }
        if (!action || typeof action !== 'string' || action.trim() === '') {
            throw new Error('Action must be a non-empty string');
        }
        if (!cssPath || typeof cssPath !== 'string' || cssPath.trim() === '') {
            throw new Error('CSS path must be a non-empty string');
        }
        if (!actionHash || typeof actionHash !== 'string' || actionHash.trim() === '') {
            throw new Error('Action hash must be a non-empty string');
        }
        if (!parentState) {
            throw new Error('Parent state is required');
        }

        this.actionId = randomUUID();
        this.element = element;
        this.action = action;
        this.cssPath = cssPath;
        this.actionHash = actionHash;
        this.parentState = parentState;
        this.childState = null;
    }

    /**
     * Returns the parentState associated with the CrawlAction.
     * @returns The parent state from which this action originates
     */
    getParentState(): CrawlState {
        return this.parentState;
    }

    /**
     * Returns the childState associated with the CrawlAction.
     * @returns The child state resulting from this action, or null if not yet set
     */
    getChildState(): CrawlState | null {
        return this.childState;
    }

    /**
     * Sets the child state for this action
     * @param childState - The child state resulting from this action
     */
    setChildState(childState: CrawlState | null): void {
        this.childState = childState;
    }

    /**
     * Returns a string representation of the CrawlAction
     * @returns String representation of the action
     */
    toString(): string {
        return `CrawlAction(${this.element}:${this.action}@${this.cssPath})`;
    }

    /**
     * Returns a JSON representation of the CrawlAction
     * @returns JSON object representation of the action
     */
    toJSON(): Partial<CrawlActionInterface> {
        return {
            actionId: this.actionId,
            element: this.element,
            action: this.action,
            cssPath: this.cssPath,
            actionHash: this.actionHash,
            parentState: this.parentState,
            childState: this.childState,
        };
    }
}

export default CrawlAction;
