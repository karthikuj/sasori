/**
 * Serializable shapes for the crawl inventory: what a crawl actually reached.
 *
 * This is the crawler's own answer to "what did you cover?", kept separate from
 * anything a scanner does with it. A missing finding is otherwise ambiguous —
 * the crawler may never have arrived, or it arrived and the rule stayed silent —
 * and those two failures belong to different code and different people.
 */

/**
 * One endpoint the crawl touched, aggregated across every request to it.
 */
export interface InventoryEndpoint {
    /** HTTP method, upper-case. */
    method: string;
    /** Absolute URL with the query string and fragment removed. */
    url: string;
    /** Query parameter names observed at this endpoint, sorted and unique. */
    queryParams: string[];
    /** Body parameter names observed at this endpoint, sorted and unique. */
    bodyParams: string[];
    /** Request content types observed, sorted and unique. */
    contentTypes: string[];
    /** Puppeteer resource types observed (document, xhr, script, ...), sorted. */
    resourceTypes: string[];
    /** How many requests were made to this endpoint. */
    requests: number;
}

/**
 * One DOM state the crawl reached. A security crawler's coverage is not only
 * URLs: two states at the same URL with different DOMs are different attack
 * surface, which is why states are inventoried alongside endpoints.
 */
export interface InventoryState {
    /** URL the state was observed at. */
    url: string;
    /** Structural hash of the stripped DOM; the crawler's identity for a state. */
    stateHash: string;
    /** Depth in the crawl tree. */
    crawlDepth: number;
    /** How the state was arrived at: a real navigation, or a DOM mutation. */
    arrivalType: string;
    /** Number of interactable actions found in the state. */
    actions: number;
    /** Input elements found in the state, as `element[type]` selectors, sorted. */
    inputs: string[];
}

/**
 * Aggregate counts, so a consumer can sanity-check a run without walking the
 * arrays.
 */
export interface InventoryStats {
    endpoints: number;
    states: number;
    requests: number;
}

/**
 * The complete artifact written at the end of a crawl.
 */
export interface CrawlInventory {
    schemaVersion: number;
    entryPoint: string;
    stats: InventoryStats;
    endpoints: InventoryEndpoint[];
    states: InventoryState[];
}
