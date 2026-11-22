import { randomUUID } from 'crypto';
import CrawlInput from './crawlInput';
import CrawlAction from './crawlAction';
import { CrawlState as CrawlStateInterface, ArrivalType } from '../types/input';

/**
 * The CrawlState class specifies the state of the DOM after an action
 * on an element in the DOM (it is a vertex in the crawl graph).
 */
class CrawlState implements CrawlStateInterface {
    /**
     * Unique identifier for this state
     */
    public readonly stateId: string;

    /**
     * URL of the page in this state
     */
    public readonly url: string;

    /**
     * Hash representing the DOM state
     */
    public readonly stateHash: string;

    /**
     * Depth of this state in the crawl tree
     */
    public readonly crawlDepth: number;

    /**
     * How this state was achieved: via a link navigation or DOM interaction
     */
    public readonly arrivalType: ArrivalType;

    /**
     * List of input elements found in this state
     */
    public crawlInputs: CrawlInput[];

    /**
     * List of actions that can be performed from this state
     */
    public crawlActions: CrawlAction[];

    /**
     * Action that led to this state (parent edge in the crawl graph)
     * Not included in JSON to avoid circular references
     */
    public parentAction?: CrawlAction | null;

    /**
     * CrawlState object constructor
     * @param url - URL of the page in this state
     * @param stateHash - Hash representing the DOM state
     * @param crawlDepth - Depth of this state in the crawl tree
     * @param crawlInputs - List of input elements found in this state
     * @param crawlActions - List of actions that can be performed from this state
     */
    constructor(
        url: string,
        stateHash: string,
        crawlDepth: number,
        arrivalType: ArrivalType,
        crawlInputs?: CrawlInput[],
        crawlActions?: CrawlAction[]
    ) {
        // Validate required parameters
        if (!url || typeof url !== 'string' || url.trim() === '') {
            throw new Error('URL must be a non-empty string');
        }
        if (!stateHash || typeof stateHash !== 'string' || stateHash.trim() === '') {
            throw new Error('State hash must be a non-empty string');
        }
        if (typeof crawlDepth !== 'number' || crawlDepth < 0 || !Number.isInteger(crawlDepth)) {
            throw new Error('Crawl depth must be a non-negative integer');
        }

        this.stateId = randomUUID();
        this.url = url;
        this.stateHash = stateHash;
        this.crawlDepth = crawlDepth;
        this.arrivalType = arrivalType;
        this.crawlInputs = crawlInputs || [];
        this.crawlActions = crawlActions || [];
        this.parentAction = null;
    }

    /**
     * Returns the list of CrawlActions associated with the CrawlState
     * @returns Array of CrawlAction objects
     */
    getCrawlActions(): CrawlAction[] {
        return this.crawlActions;
    }

    /**
     * Returns the crawlDepth associated with the CrawlState
     * @returns The crawl depth as a number
     */
    getCrawlDepth(): number {
        return this.crawlDepth;
    }

    /**
     * Returns the list of CrawlInputs associated with the CrawlState
     * @returns Array of CrawlInput objects
     */
    getCrawlInputs(): CrawlInput[] {
        return this.crawlInputs;
    }

    /**
     * Returns a string representation of the CrawlState
     * @returns String representation of the state
     */
    toString(): string {
        return `CrawlState(${this.url}@depth:${this.crawlDepth})`;
    }

    /**
     * Returns a JSON representation of the CrawlState
     * @returns JSON object representation of the state
     */
    toJSON(): Partial<CrawlState> {
        return {
            stateId: this.stateId,
            url: this.url,
            stateHash: this.stateHash,
            crawlDepth: this.crawlDepth,
            arrivalType: this.arrivalType,
            crawlInputs: this.crawlInputs,
            crawlActions: this.crawlActions,
        };
    }
}

export default CrawlState;
