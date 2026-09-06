import { Page, CDPSession } from 'puppeteer';
import { createHash } from 'crypto';
import chalk from 'chalk';

import CrawlAction from './crawlAction';
import CrawlInput from './crawlInput';
import CrawlState from './crawlState';
import CrawlStateManager from './crawlStateManager';
import DomPath from './domPath';
import DomStripper from './domStripper';
import { CrawlerSettings } from '../types/crawler';

/**
 * Normalises anything thrown into a message string.
 * @param error - The caught value.
 * @return A human-readable message.
 */
function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * One batched `page.evaluate` result per CSS path (failures do not abort siblings).
 */
type BatchActionNodeSnapshot =
    | {
        ok: true;
        cssPath: string;
        outerHTML: string;
        tagName: string;
        prevElementOuterHTML: string | null;
        nextElementOuterHTML: string | null;
    }
    | { ok: false; cssPath: string; error: string };

/**
 * Finds the actions and inputs a crawl state offers.
 *
 * This is everything between "here is a loaded page" and "here are the edges
 * leaving this vertex of the crawl graph": the CDP sweep for event listeners,
 * the batched selector-to-markup round-trips, and the structural hashing that
 * decides whether an action has been seen before.
 *
 * It is separated from `Crawler` because it is where the crawler's per-state
 * cost concentrates, and because `Crawler` had grown to own it alongside browser
 * lifecycle, replay and scope (SCAN-90). Nothing here touches the crawl loop or
 * the shared `CrawlStateManager` beyond the two calls that register an action
 * signature, so it can be reasoned about without the concurrency model.
 */
export class ActionDiscovery {
    /**
     * Max CSS selectors per `page.evaluate` batch (limits payload / eval time per round-trip).
     */
    private static readonly BATCH_ACTION_SELECTOR_CHUNK_SIZE = 100;

    /**
     * How many `DOMDebugger.getEventListeners` probes may be in flight on one
     * CDP session at a time. The protocol multiplexes freely, so the ceiling
     * exists to bound memory and to avoid starving the crawl's other traffic,
     * not because the browser requires serialisation.
     */
    private static readonly CDP_LISTENER_PROBE_CONCURRENCY = 32;

    /**
     * Fraction of failed listener probes above which the sweep warns out loud
     * rather than only under the debug gate. Below it, stale nodes on a live
     * page are ordinary; above it, action discovery is systematically broken and
     * the crawl's results are misleading rather than merely incomplete.
     */
    private static readonly LISTENER_PROBE_FAILURE_WARN_RATIO = 0.25;

    /**
     * @param config - Crawler settings (elements, depth and child limits).
     * @param stripper - Shared DOM stripper, for action hashing.
     * @param debugLog - Sink for gated diagnostics.
     */
    constructor(
        private readonly config: CrawlerSettings,
        private readonly stripper: DomStripper,
        private readonly debugLog: (message: string) => void,
    ) { }

    /**
     * Fetches all possible CrawlInputs on a CrawlState and returns them.
     * @param page - Puppeteer page instance
     * @param currentState - Current crawl state
     * @return Promise resolving to array of CrawlInput objects
     */
    async getCrawlInputs(page: Page, currentState: CrawlState): Promise<CrawlInput[]> {
        const domPath = new DomPath(page);
        const crawlInputs: CrawlInput[] = [];
        let cssPaths: string[];

        // INPUT_FIELDS also feeds the DomStripper interactable set, so it stays
        // type-specific; DISCOVERY_ONLY_INPUT_FIELDS adds bare `<input>` (and any
        // other fill-only selectors) here without touching state identity
        // (SCAN-200 / SCAN-194 RC1).
        for (const input of [...CrawlInput.INPUT_FIELDS, ...CrawlInput.DISCOVERY_ONLY_INPUT_FIELDS]) {
            cssPaths = await domPath.getCssPaths(input.CSS_PATH);
            crawlInputs.push(...cssPaths.map((cssPath) => {
                return new CrawlInput(input.ELEMENT, input.TYPE, cssPath, currentState);
            }));
        }

        return (crawlInputs.length !== 0) ? crawlInputs : [];
    }

    /**
     * Function to find all nodes with click event listeners
     * @param client - CDP session client
     * @param event - Event type to search for
     * @return Promise resolving to array of CSS selectors
     */
    async findNodesWithClickListeners(client: CDPSession, event: string): Promise<string[]> {
        const { root } = await client.send('DOM.getDocument', { depth: -1 });
        const { nodeIds } = await client.send('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: '*',
        });

        // Results are placed by index rather than pushed, so the returned order
        // is document order regardless of which probes finish first. The crawl
        // inventory is deliberately deterministic; letting scheduling jitter
        // reorder the discovered selectors would leak nondeterminism into it.
        const clickListeners: (string | null)[] = new Array(nodeIds.length).fill(null);

        // Every resolved node is pinned in a named object group so a single
        // `Runtime.releaseObjectGroup` at the end frees all of them. Resolving
        // thousands of nodes per state and never releasing them leaked remote
        // object handles in the browser for the lifetime of the crawl.
        const objectGroup = `sasori-listeners-${Date.now()}`;

        let failures = 0;
        let lastFailure = '';

        /**
         * Probes one node for the event listener and records its selector.
         * @param index - Position of the node in {@link nodeIds}.
         */
        const probe = async (index: number): Promise<void> => {
            const nodeId = nodeIds[index];
            if (nodeId === undefined) {
                return;
            }
            try {
                const { object } = await client.send('DOM.resolveNode', { nodeId, objectGroup });
                const remoteObjectId = object.objectId;
                if (!remoteObjectId) {
                    return;
                }

                const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: remoteObjectId });
                if (!listeners.some((listener) => listener.type === event)) {
                    return;
                }

                const { node } = await client.send('DOM.describeNode', { nodeId });
                if (!node.attributes || node.attributes.length === 0) {
                    return;
                }

                const excludedAttrNameChars = ['.'];
                const excludedAttrValueChars = ['"', '\n'];
                let cssPath = '';
                for (let i = 0; i < node.attributes.length; i += 2) {
                    const attrName = node.attributes[i];
                    const attrValue = node.attributes[i + 1];
                    // Continue if the attribute name has an excluded character.
                    if (attrName && excludedAttrNameChars.some((element) => attrName.includes(element))) {
                        continue;
                    }
                    // Continue if attribute value has some excluded character.
                    if (attrValue && excludedAttrValueChars.some((element) => attrValue.includes(element))) {
                        continue;
                    }
                    if (attrName && attrValue) {
                        cssPath += `[${attrName}="${attrValue}"]`;
                    }
                }

                if (cssPath && node.localName) {
                    clickListeners[index] = node.localName + cssPath;
                }
            } catch (error) {
                // A node going away between the querySelectorAll and the probe
                // is expected on a live page, so a per-node log would be noise.
                // The *count* is not noise: if CDP starts failing systematically
                // the sweep finds zero listeners and reports nothing wrong, and
                // a crawl that discovers no click handlers looks identical to an
                // application that has none.
                failures++;
                lastFailure = errorMessage(error);
            }
        };

        // A fixed pool of workers pulling from a shared cursor. The original ran
        // these probes strictly one after another, so a page with N elements
        // cost 2N sequential CDP round-trips — on a large DOM that is the single
        // biggest source of latency in action discovery, and it is latency, not
        // work: the browser is idle between replies. CDP multiplexes commands on
        // one session, so overlapping them is just using the transport properly.
        let cursor = 0;
        const workerCount = Math.min(ActionDiscovery.CDP_LISTENER_PROBE_CONCURRENCY, nodeIds.length);
        const workers = Array.from({ length: workerCount }, async () => {
            for (;;) {
                const index = cursor++;
                if (index >= nodeIds.length) {
                    return;
                }
                await probe(index);
            }
        });
        await Promise.all(workers);

        try {
            await client.send('Runtime.releaseObjectGroup', { objectGroup });
        } catch (error) {
            this.debugLog(`releaseObjectGroup failed group=${objectGroup} error=${errorMessage(error)}`);
        }

        // Reported once, at the end, and only when it was widespread. A handful
        // of stale nodes is normal; most of the page failing to probe means the
        // action discovery below is not to be trusted.
        if (failures > 0) {
            const ratio = failures / nodeIds.length;
            const summary = `[INFO] ${event} listener sweep: ${failures}/${nodeIds.length} nodes could not be probed (last: ${lastFailure})`;
            if (ratio >= ActionDiscovery.LISTENER_PROBE_FAILURE_WARN_RATIO) {
                console.warn(chalk.yellow(summary));
            } else {
                this.debugLog(summary);
            }
        }

        return clickListeners.filter((cssPath): cssPath is string => cssPath !== null);
    }

    /**
     * Fetches outerHTML / sibling context for many selectors in one or more `page.evaluate` calls.
     * Each path is isolated with try/catch in the page context so one bad selector does not fail the batch.
     */
    private async batchFetchActionNodeSnapshots(page: Page, cssPaths: string[]): Promise<BatchActionNodeSnapshot[]> {
        if (cssPaths.length === 0) {
            return [];
        }

        const all: BatchActionNodeSnapshot[] = [];
        const chunkSize = ActionDiscovery.BATCH_ACTION_SELECTOR_CHUNK_SIZE;

        for (let offset = 0; offset < cssPaths.length; offset += chunkSize) {
            const chunk = cssPaths.slice(offset, offset + chunkSize);
            const batch = await page.evaluate((paths: string[]) => {
                const out: BatchActionNodeSnapshot[] = [];
                const doc = (globalThis as unknown as { document: { querySelector: (s: string) => unknown } }).document;
                for (const cssPath of paths) {
                    try {
                        const el = doc.querySelector(cssPath) as {
                            outerHTML: string;
                            tagName: string;
                            previousElementSibling: { outerHTML: string } | null;
                            nextElementSibling: { outerHTML: string } | null;
                        } | null;
                        if (!el) {
                            out.push({ ok: false, cssPath, error: 'not found' });
                            continue;
                        }
                        out.push({
                            ok: true,
                            cssPath,
                            outerHTML: el.outerHTML,
                            tagName: el.tagName,
                            prevElementOuterHTML: el.previousElementSibling
                                ? el.previousElementSibling.outerHTML
                                : null,
                            nextElementOuterHTML: el.nextElementSibling
                                ? el.nextElementSibling.outerHTML
                                : null,
                        });
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e);
                        out.push({ ok: false, cssPath, error: msg });
                    }
                }
                return out;
            }, chunk);
            all.push(...batch);
        }

        return all;
    }

    /**
     * Fetches all possible CrawlActions on a CrawlState and returns them.
     * @param page - Puppeteer page instance
     * @param currentState - Current crawl state
     * @param crawlManager - Crawl state manager instance
     * @return Promise resolving to array of CrawlAction objects
     */
    async getCrawlActions(
        page: Page,
        currentState: CrawlState,
        crawlManager: CrawlStateManager,
        onDedup?: (element: string, cssPath: string, actionHash: string) => void
    ): Promise<CrawlAction[]> {
        const domPath = new DomPath(page);
        const crawlActions: CrawlAction[] = [];
        let cssPaths = new Set<string>();

        // If max crawl depth has been reached then no need to fetch more actions for the given state.
        if (this.config.maxDepth && currentState.getCrawlDepth() >= this.config.maxDepth) {
            return crawlActions;
        }

        const allCssPaths: string[] = [];

        for (const element of this.config.elements) {
            // Check if the selector is for an event (like [click]) or element.
            if (/^\[\w+\]$/.test(element)) {
                const event = element.slice(1, -1);
                // Enable the Debugger
                const client = await page.target().createCDPSession();
                try {
                    await client.send('DOM.enable');
                    await client.send('Runtime.enable');
                    const allClickListeners = await this.findNodesWithClickListeners(client, event);
                    let invalidSelectors = 0;
                    for (const clickListener of allClickListeners) {
                        try {
                            allCssPaths.push(...(await domPath.getCssPaths(clickListener)));
                        } catch (error) {
                            // The query selector is invalid — the selector is
                            // built from raw page attributes, so a page can
                            // produce one Cheerio will not accept. Counted
                            // rather than logged per occurrence: one bad
                            // attribute on a repeated component would otherwise
                            // print thousands of identical lines.
                            invalidSelectors++;
                        }
                    }
                    if (invalidSelectors > 0) {
                        this.debugLog(
                            `getCrawlActions: ${invalidSelectors}/${allClickListeners.length} ${event} selectors were rejected url=${page.url()}`
                        );
                    }
                } finally {
                    // One session was created per event selector per state and
                    // never detached, so a long crawl accumulated CDP sessions
                    // against the same target until the browser was closed.
                    await client.detach().catch(() => undefined);
                }
            } else {
                allCssPaths.push(...(await domPath.getCssPaths(element)));
            }
        }

        // Create Set once after collecting all paths
        cssPaths = new Set(allCssPaths);
        const pathList = Array.from(cssPaths);
        const snapshots = await this.batchFetchActionNodeSnapshots(page, pathList);

        // Each snapshot is stripped three times — the node, and both of its
        // element siblings — so consecutive actions in a list or table strip the
        // *same* markup repeatedly: action i's next sibling is action i+1's
        // node, and action i+2's previous sibling. Memoizing on the raw HTML
        // collapses those three passes into one for every run of adjacent
        // actions. The cache lives only for this call, so it stays bounded by
        // one state's markup rather than growing with the crawl.
        const stripCache = this.stripper.createCache();

        for (const snap of snapshots) {
            if (!snap.ok) {
                console.error(chalk.red(`[ERROR] batch action snapshot failed for ${snap.cssPath}: ${snap.error}`));
                continue;
            }

            try {
                const node = snap;
                const cssPath = snap.cssPath;

                const nodeStrippedDOM = stripCache.strip(node.outerHTML);
                const prevElementStrippedDOM = node.prevElementOuterHTML
                    ? stripCache.strip(node.prevElementOuterHTML)
                    : '';
                const nextElementStrippedDOM = node.nextElementOuterHTML
                    ? stripCache.strip(node.nextElementOuterHTML)
                    : '';

                const actionHash = createHash('sha256').update(prevElementStrippedDOM + nodeStrippedDOM + nextElementStrippedDOM).digest('hex');
                // Keep it unless the widget has already been clicked somewhere, or
                // the graph is already holding its quota of copies waiting to be
                // clicked. Deferring the real dedup to execution is what stops a
                // single un-executed copy speaking for every page it appears on
                // (SCAN-198).
                if (crawlManager.shouldRetainAction(cssPath, actionHash)) {
                    crawlActions.push(new CrawlAction(node.tagName, 'click', cssPath, actionHash, currentState));
                    crawlManager.registerActionSignature(cssPath, actionHash);
                } else if (onDedup) {
                    // Dropped at discovery: already clicked elsewhere, or enough
                    // copies are already waiting. Reported so the crawl graph can
                    // distinguish a coverage gap caused by dedup from one caused by
                    // pruning.
                    onDedup(node.tagName, cssPath, actionHash);
                }
            } catch (error) {
                console.error(error);
                continue;
            }
        }

        return (crawlActions.length !== 0) ? (this.config.maxChildren ? crawlActions.slice(0, this.config.maxChildren).reverse() : crawlActions.reverse()) : [];
    }

}

export default ActionDiscovery;
