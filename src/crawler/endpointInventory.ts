import {
    CrawlInventory,
    InventoryEndpoint,
    InventoryState,
} from '../types/inventory';

/** Version of the on-disk inventory format. Bump when a field changes meaning. */
const SCHEMA_VERSION = 1;

/**
 * Accumulates what a crawl reached, for scoring against a known endpoint map.
 *
 * Two design points worth keeping:
 *
 * 1. **Aggregation happens on the way in, not at the end.** A crawl of a large
 *    app issues tens of thousands of requests, and the overwhelming majority are
 *    repeats of an endpoint already seen. Merging into a keyed map as requests
 *    arrive keeps memory proportional to the *surface* rather than to the
 *    traffic, and keeps `snapshot()` cheap enough to call while a crawl is
 *    still running.
 * 2. **The output is deterministic.** Every array is sorted at snapshot time and
 *    nothing records a timestamp, so two crawls that reach the same surface
 *    produce byte-identical artifacts and a diff shows a coverage change rather
 *    than the order browsers happened to race in.
 */
class EndpointInventory {
    /** Endpoints keyed by `METHOD url`, which is the identity a map is scored on. */
    private readonly endpoints = new Map<string, InventoryEndpoint>();

    /** States keyed by their DOM hash, which is the crawler's own state identity. */
    private readonly states = new Map<string, InventoryState>();

    private totalRequests = 0;

    private entryPoint: string;

    /**
     * @param entryPoint - URL the crawl started from, recorded in the artifact
     * so a report can say what was crawled without being told separately.
     */
    constructor(entryPoint = '') {
        this.entryPoint = entryPoint;
    }

    /**
     * Sets the entry point after construction, for callers that learn it later.
     * @param entryPoint - URL the crawl started from
     */
    setEntryPoint(entryPoint: string): void {
        this.entryPoint = entryPoint;
    }

    /**
     * Records one in-scope request.
     *
     * Malformed URLs are ignored rather than thrown: this runs inside Puppeteer's
     * request interception handler, where an exception would abort the
     * interception and hang the page. A URL the platform cannot parse is also,
     * by definition, not one a coverage map can name.
     *
     * @param method - HTTP method
     * @param rawUrl - Absolute request URL, query and fragment included
     * @param options - Request body, content type and Puppeteer resource type
     */
    recordRequest(
        method: string,
        rawUrl: string,
        options?: { postData?: string | undefined; contentType?: string | undefined; resourceType?: string | undefined },
    ): void {
        let parsed: URL;
        try {
            parsed = new URL(rawUrl);
        } catch {
            return;
        }

        const upperMethod = (method || 'GET').toUpperCase();
        // The query string is stripped from the identity but its parameter
        // *names* are kept: /search?q=a and /search?q=b are one endpoint with one
        // parameter, not two endpoints, and it is the parameter that is attack
        // surface.
        const url = `${parsed.origin}${parsed.pathname}`;
        const key = `${upperMethod} ${url}`;

        let entry = this.endpoints.get(key);
        if (!entry) {
            entry = {
                method: upperMethod,
                url,
                queryParams: [],
                bodyParams: [],
                contentTypes: [],
                resourceTypes: [],
                requests: 0,
            };
            this.endpoints.set(key, entry);
        }

        entry.requests += 1;
        this.totalRequests += 1;

        for (const name of parsed.searchParams.keys()) {
            addUnique(entry.queryParams, name);
        }
        const contentType = options?.contentType;
        if (contentType) {
            addUnique(entry.contentTypes, contentType.split(';')[0]!.trim().toLowerCase());
        }
        if (options?.resourceType) {
            addUnique(entry.resourceTypes, options.resourceType);
        }
        for (const name of bodyParamNames(options?.postData, contentType)) {
            addUnique(entry.bodyParams, name);
        }
    }

    /**
     * Records a DOM state the crawl reached.
     *
     * Keyed on the state hash rather than the URL, matching the crawler's own
     * notion of identity: a single-page app can present many states at one URL,
     * and collapsing them would report a crawl of an SPA as a crawl of one page.
     *
     * @param state - The state to record
     */
    recordState(state: {
        url: string;
        stateHash: string;
        crawlDepth: number;
        arrivalType: string;
        actions?: number;
        inputs?: string[];
    }): void {
        if (!state.stateHash || this.states.has(state.stateHash)) {
            return;
        }
        this.states.set(state.stateHash, {
            url: state.url,
            stateHash: state.stateHash,
            crawlDepth: state.crawlDepth,
            arrivalType: state.arrivalType,
            actions: state.actions ?? 0,
            inputs: [...(state.inputs ?? [])].sort(),
        });
    }

    /**
     * Returns the inventory as a serializable, fully sorted artifact.
     *
     * Safe to call while a crawl is running — it copies rather than aliasing, so
     * a caller cannot be handed arrays that mutate underneath it as more
     * requests arrive.
     */
    snapshot(): CrawlInventory {
        const endpoints = [...this.endpoints.values()]
            .map((e) => ({
                ...e,
                queryParams: [...e.queryParams].sort(),
                bodyParams: [...e.bodyParams].sort(),
                contentTypes: [...e.contentTypes].sort(),
                resourceTypes: [...e.resourceTypes].sort(),
            }))
            .sort((a, b) => (a.url === b.url ? compare(a.method, b.method) : compare(a.url, b.url)));

        const states = [...this.states.values()]
            .map((s) => ({ ...s, inputs: [...s.inputs] }))
            .sort((a, b) => (a.url === b.url ? compare(a.stateHash, b.stateHash) : compare(a.url, b.url)));

        return {
            schemaVersion: SCHEMA_VERSION,
            entryPoint: this.entryPoint,
            stats: {
                endpoints: endpoints.length,
                states: states.length,
                requests: this.totalRequests,
            },
            endpoints,
            states,
        };
    }
}

/**
 * Appends a value if it is not already present.
 *
 * A linear scan beats a Set here: these arrays hold a handful of parameter names
 * per endpoint, and a Set per field would allocate thousands of objects across a
 * crawl to avoid a scan that never gets long.
 * @param target - Array to append to
 * @param value - Value to add if absent
 */
function addUnique(target: string[], value: string): void {
    if (value && !target.includes(value)) {
        target.push(value);
    }
}

/** Locale-independent string comparison, so sort order cannot vary by host. */
function compare(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

/**
 * Extracts parameter names from a request body.
 *
 * Only form encoding and JSON are parsed. Multipart bodies are left alone
 * deliberately: naming their parts means parsing the MIME envelope, and a
 * mis-parse would invent parameters that were never sent — worse, for a
 * coverage metric, than recording none.
 * @param postData - Raw request body
 * @param contentType - Request Content-Type header
 * @returns Parameter names, unsorted
 */
function bodyParamNames(postData?: string, contentType?: string): string[] {
    if (!postData) {
        return [];
    }
    const type = (contentType ?? '').toLowerCase();

    if (type.includes('application/json')) {
        try {
            const parsed: unknown = JSON.parse(postData);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return Object.keys(parsed as Record<string, unknown>);
            }
        } catch {
            // A body that claims JSON and is not is a fact about the app, not a
            // reason to fail a crawl; record the endpoint without parameters.
        }
        return [];
    }

    // Default to form encoding: it is what a browser sends for a submitted form
    // with no explicit type, which is the case a crawl produces most often.
    if (type === '' || type.includes('application/x-www-form-urlencoded')) {
        try {
            return [...new URLSearchParams(postData).keys()];
        } catch {
            return [];
        }
    }
    return [];
}

export default EndpointInventory;
