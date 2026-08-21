import { Browser as PuppeteerBrowser, Page, CDPSession } from 'puppeteer';
import { WriteStream, createWriteStream, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

import Browser from '../browser/browser';
import CrawlAction from './crawlAction';
import CrawlInput from './crawlInput';
import CrawlState from './crawlState';
import CrawlStateManager from './crawlStateManager';
import DomPath from './domPath';
import EndpointInventory from './endpointInventory';
import authenticate from '../auth/authenticator';
import { CrawlerConfig, CrawlerSettings } from '../types/crawler';
import { CrawlInventory } from '../types/inventory';
import { ArrivalType } from '../types/input';

/**
 * The parts of a parsed DOM node that {@link Crawler.stripDOM} actually touches.
 *
 * Declared structurally rather than imported from `domhandler` because the repo
 * still carries `@types/cheerio@0.22`, whose legacy `Element` union is not
 * assignable to the modern one and makes any direct import unusable at the
 * Cheerio callback boundary. This describes exactly the surface used, so the
 * single cast at each boundary stays honest instead of widening to `any`.
 */
interface DomNode {
    /**
     * Domhandler's node kind: `tag`/`script`/`style` are elements, and
     * everything else (`text`, `comment`, `directive`, `cdata`, `root`) is not.
     *
     * This is the discriminator to trust, **not** `nodeType`: domhandler reports
     * `nodeType` 1 for a `<!DOCTYPE>` directive as well as for real elements,
     * because the DOM spec has no node type for a directive. A prune pass that
     * walks the tree by `nodeType` therefore deletes the doctype, which the old
     * per-element loop never could — it iterated `$('*')`, and Cheerio's
     * universal selector only ever yields elements.
     */
    type: string;
    nodeType: number;
    name?: string;
    attribs?: Record<string, string>;
    parent?: DomNode | null;
    children?: DomNode[];
}

/** Domhandler node types that represent an element. */
const ELEMENT_NODE_TYPES: ReadonlySet<string> = new Set(['tag', 'script', 'style']);

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
 * The Crawler class is responsible for creating and managing the crawler.
 */
class Crawler {
    /**
     * Static constants for DOM node types
     */
    static readonly TEXT_NODE = 3;
    static readonly COMMENT_NODE = 8;
    static readonly ELEMENT_NODE = 1;

    /**
     * Max CSS selectors per `page.evaluate` batch (limits payload / eval time per round-trip).
     */
    private static readonly BATCH_ACTION_SELECTOR_CHUNK_SIZE = 100;

    /**
     * The one attribute `stripDOM` keeps, per upper-case tag name. A lookup
     * table rather than a `switch` plus array because it is consulted once per
     * element on the crawler's hottest path, and the answer is never more than
     * one attribute.
     */
    private static readonly ALLOWED_ATTRIBUTES: Readonly<Record<string, string | undefined>> = {
        A: 'href',
        BASE: 'href',
        SCRIPT: 'src',
    };

    /**
     * How many `DOMDebugger.getEventListeners` probes may be in flight on one
     * CDP session at a time. The protocol multiplexes freely, so the ceiling
     * exists to bound memory and to avoid starving the crawl's other traffic,
     * not because the browser requires serialisation.
     */
    private static readonly CDP_LISTENER_PROBE_CONCURRENCY = 32;

    /**
     * Crawler configuration
     */
    public readonly config: CrawlerConfig;

    /**
     * Crawler-specific settings
     */
    public readonly crawlerConfig: CrawlerSettings;

    /**
     * Authentication in progress flag
     */
    public authInProgress: boolean;

    /**
     * Set of all discovered URLs
     */
    public allUrls: Set<string>;

    /**
     * Endpoint and state inventory for this crawl — what the crawler actually
     * reached, independent of what any scanner made of it.
     */
    public readonly inventory: EndpointInventory;

    /**
     * Array of all interactable elements
     */
    public allInteractables: string[];

    /**
     * {@link allInteractables} pre-joined into a single CSS selector list.
     *
     * `stripDOM` needs "does anything here match any interactable selector?" —
     * a selector list answers that in one pass over the document instead of one
     * pass per selector, and the join is done once at construction because the
     * selector set never changes for the life of a crawl.
     */
    private readonly interactableSelector: string;

    /**
     * Compiled `includeRegexes` / `excludeRegexes`, memoized by pattern source.
     *
     * `inContext` runs on every intercepted request, and the interceptor is on
     * the path of every single HTTP transaction the crawl makes. Compiling the
     * patterns there meant re-parsing the same handful of regexes tens of
     * thousands of times per crawl. Caching by source string rather than
     * snapshotting the arrays is deliberate: the scope lists are public and are
     * legitimately mutated at runtime — an SSO redirect widens `includeRegexes`
     * mid-crawl — so the cache must never be able to go stale against them.
     */
    private readonly compiledRegexes = new Map<string, RegExp>();

    /**
     * Append stream for `crawler.outputFile`, opened on first use.
     */
    private outputFileStream: WriteStream | null = null;

    /**
     * End time for crawling (calculated from maxDuration)
     */
    public endTime: number | null;

    /**
     * Delay between browser starts (in milliseconds)
     */
    public browserStartDelays: number;

    /**
     * Cooperative cancellation for API mode and graceful shutdown.
     */
    private readonly abortController = new AbortController();

    /**
     * Browsers launched while this crawl is active (so {@link stopCrawling} can close them).
     */
    private activeBrowsers: PuppeteerBrowser[] = [];
    private readonly debugPages: WeakSet<Page> = new WeakSet();

    /**
     * Crawler class constructor.
     * @param config - Configuration object containing browser and crawler settings
     */
    constructor(config: CrawlerConfig) {
        this.config = config;
        this.crawlerConfig = config.crawler;
        this.authInProgress = false;
        this.allUrls = new Set<string>();
        this.inventory = new EndpointInventory(this.crawlerConfig.entryPoint);
        this.allInteractables = [...this.crawlerConfig.elements].concat(
            CrawlInput.INPUT_FIELDS.map((element) => element.CSS_PATH)
        );
        this.interactableSelector = this.allInteractables.join(', ');
        this.endTime = null;
        this.browserStartDelays = 1000; // 1 millisecond(s)
    }

    /**
     * Whether {@link stopCrawling} was called (or the signal was aborted).
     */
    wasStopped(): boolean {
        return this.abortController.signal.aborted;
    }

    private isDebugNetworkEnabled(): boolean {
        if (this.crawlerConfig.debugNetwork === true) {
            return true;
        }
        const env = process.env.SASORI_DEBUG_NETWORK;
        return env === '1' || env === 'true' || env === 'TRUE';
    }

    private debugLog(message: string): void {
        if (!this.isDebugNetworkEnabled()) {
            return;
        }
        console.log(chalk.yellow(`[DEBUG] ${message}`));
    }

    private attachPageDebugListeners(page: Page, pageIdx: number): void {
        if (!this.isDebugNetworkEnabled() || this.debugPages.has(page)) {
            return;
        }
        this.debugPages.add(page);

        page.on('requestfailed', (req) => {
            const failure = req.failure();
            this.debugLog(
                `page=${pageIdx} requestfailed method=${req.method()} url=${req.url()} error=${failure?.errorText ?? 'unknown'}`
            );
        });

        page.on('response', (res) => {
            if (res.status() >= 400) {
                this.debugLog(`page=${pageIdx} response status=${res.status()} url=${res.url()}`);
            }
        });

        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                this.debugLog(`page=${pageIdx} main-frame navigated url=${frame.url()}`);
            }
        });

        page.on('pageerror', (err) => {
            this.debugLog(`page=${pageIdx} pageerror message=${err.message}`);
        });
    }

    /**
     * Strips DOM by removing useless attributes, comments and all text.
     *
     * This is the crawler's hottest pure-CPU path — `getPageHash` runs it once
     * per action and `getCrawlActions` three times per candidate action — and it
     * feeds `stateHash`, so its output is pinned byte-for-byte by
     * `tests/crawler/stripDom.golden.test.ts`. Read that test before changing
     * anything here: a different output does not fail loudly, it silently
     * repartitions the crawl graph.
     *
     * ## Why it is written this way
     *
     * The obvious implementation — for each element, ask "does this element or
     * any of its descendants match an interactable selector?" — costs a full
     * subtree rescan per element per selector. Every ancestor re-walks
     * everything beneath it, S times over, so the cost grows superlinearly in
     * DOM *depth* rather than in element count (measured: depth 2 → 80 raised
     * element count 19% but time 144%). See SCAN-85.
     *
     * Instead this runs a mark-and-sweep in four linear passes:
     *
     *   1. drop text and comment nodes, exactly as before;
     *   2. one document-wide query for the interactable selectors, then walk
     *      *upward* from each hit marking ancestors — the ancestor walk stops at
     *      the first already-marked node, so the whole propagation is O(N)
     *      amortised no matter how deep the tree is;
     *   3. strip attributes;
     *   4. one more document-wide query for elements that still match with
     *      their attributes gone, then prune top-down.
     *
     * That is two selector queries in total rather than N·S subtree scans.
     *
     * ## The two-phase matching is not an accident
     *
     * The original stripped attributes and tested interactability in the same
     * document-order loop, which means an element was tested against the
     * selectors *after* losing its attributes, while its descendants were still
     * tested *with* theirs. So `<div><input type="submit"></div>` keeps the div
     * (the div's descendant search saw the live `type` attribute) and drops the
     * input (by the time the input itself was tested, `type` was gone). That is
     * load-bearing for every hash the crawler has ever produced, so the two
     * passes here reproduce it deliberately: pass 2 matches descendants against
     * the *original* attributes, pass 4 matches an element against its
     * *stripped* ones.
     *
     * @param $ - Cheerio API instance
     */
    stripDOM($: cheerio.CheerioAPI): void {
        const allElements = $('*');

        // Remove text and comment nodes.
        allElements.contents().filter((_: number, node: unknown) => {
            const nodeType = (node as DomNode).nodeType;
            return nodeType === Crawler.TEXT_NODE || nodeType === Crawler.COMMENT_NODE;
        }).remove();

        // Pass 1 — mark every element that has an interactable *descendant*,
        // matched while attributes are still intact. Walking up from each hit
        // and stopping at the first marked ancestor visits each node at most
        // once across the whole propagation.
        const hasInteractableDescendant = new Set<DomNode>();
        const descendantHits = $(this.interactableSelector);
        for (let i = 0; i < descendantHits.length; i++) {
            let ancestor = (descendantHits[i] as DomNode | undefined)?.parent ?? null;
            while (ancestor && !hasInteractableDescendant.has(ancestor)) {
                hasInteractableDescendant.add(ancestor);
                ancestor = ancestor.parent ?? null;
            }
        }

        // Pass 2 — strip attributes, keeping href for <a>/<base> and src for
        // <script>. Rebuilding `attribs` in place is cheaper than a removeAttr
        // call per attribute and preserves the relative order of what is kept,
        // which the serialised output depends on.
        allElements.each((_: number, element: unknown) => {
            const node = element as DomNode;
            const attribs = node.attribs;
            if (!attribs) {
                return;
            }
            const allowed = Crawler.ALLOWED_ATTRIBUTES[node.name?.toUpperCase() ?? ''];
            for (const attrName of Object.keys(attribs)) {
                if (allowed !== attrName) {
                    delete attribs[attrName];
                }
            }
        });

        // Pass 3 — elements that still match on their own, now that attributes
        // are gone. This is the `$(element).is(...)` half of the original test.
        const selfInteractable = new Set<DomNode>();
        const selfHits = $(this.interactableSelector);
        for (let i = 0; i < selfHits.length; i++) {
            const hit = selfHits[i] as DomNode | undefined;
            if (hit) {
                selfInteractable.add(hit);
            }
        }

        // Pass 4 — prune top-down. Removing a node takes its subtree with it, so
        // descending into a doomed subtree would be wasted work; collecting the
        // roots and removing them in one call keeps it to a single Cheerio
        // wrapper allocation.
        const doomed: DomNode[] = [];
        const stack: DomNode[] = [];
        const root = $.root()[0] as DomNode | undefined;
        const rootChildren = root?.children ?? [];
        for (let i = rootChildren.length - 1; i >= 0; i--) {
            stack.push(rootChildren[i]!);
        }
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (!ELEMENT_NODE_TYPES.has(node.type)) {
                continue;
            }
            if (!selfInteractable.has(node) && !hasInteractableDescendant.has(node)) {
                doomed.push(node);
                continue;
            }
            const children = node.children ?? [];
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push(children[i]!);
            }
        }
        if (doomed.length > 0) {
            $(doomed as unknown as cheerio.Element[]).remove();
        }

        // Change src attribute value for <script> tags. Only reachable when
        // `crawler.elements` is configured to keep scripts — under the default
        // selectors pass 4 has already removed every script.
        $('script[src]').each((_: number, element: unknown) => {
            const attribs = (element as DomNode).attribs;
            const srcValue = attribs?.['src'];
            if (srcValue) {
                const queryStart = srcValue.indexOf('?');
                if (queryStart !== -1) {
                    attribs!['src'] = srcValue.slice(0, queryStart);
                }
            }
        });
    }

    /**
     * Creates a short-lived memo over {@link stripDOM} keyed on raw HTML.
     *
     * Scoped per caller rather than per crawler on purpose: keyed on markup, a
     * long-lived cache would grow with everything the crawl has ever seen, and
     * the reuse that matters is all within a single pass anyway.
     *
     * @return An object whose `strip` parses, strips and serialises a fragment.
     */
    private createStripCache(): { strip: (html: string) => string } {
        const cache = new Map<string, string>();
        return {
            strip: (html: string): string => {
                const cached = cache.get(html);
                if (cached !== undefined) {
                    return cached;
                }
                const $ = cheerio.load(html, { xmlMode: true }) as cheerio.CheerioAPI;
                this.stripDOM($);
                const stripped = $.html();
                cache.set(html, stripped);
                return stripped;
            },
        };
    }

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

        for (const input of CrawlInput.INPUT_FIELDS) {
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
                // A node can go away between the querySelectorAll and the probe;
                // that is expected on a live page and not worth reporting.
            }
        };

        // A fixed pool of workers pulling from a shared cursor. The original ran
        // these probes strictly one after another, so a page with N elements
        // cost 2N sequential CDP round-trips — on a large DOM that is the single
        // biggest source of latency in action discovery, and it is latency, not
        // work: the browser is idle between replies. CDP multiplexes commands on
        // one session, so overlapping them is just using the transport properly.
        let cursor = 0;
        const workerCount = Math.min(Crawler.CDP_LISTENER_PROBE_CONCURRENCY, nodeIds.length);
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
            // The page may already have navigated away; the objects went with it.
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
        const chunkSize = Crawler.BATCH_ACTION_SELECTOR_CHUNK_SIZE;

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
    async getCrawlActions(page: Page, currentState: CrawlState, crawlManager: CrawlStateManager): Promise<CrawlAction[]> {
        const domPath = new DomPath(page);
        const crawlActions: CrawlAction[] = [];
        let cssPaths = new Set<string>();

        // If max crawl depth has been reached then no need to fetch more actions for the given state.
        if (this.crawlerConfig.maxDepth && currentState.getCrawlDepth() >= this.crawlerConfig.maxDepth) {
            return crawlActions;
        }

        const allCssPaths: string[] = [];

        for (const element of this.crawlerConfig.elements) {
            // Check if the selector is for an event (like [click]) or element.
            if (/^\[\w+\]$/.test(element)) {
                const event = element.slice(1, -1);
                // Enable the Debugger
                const client = await page.target().createCDPSession();
                try {
                    await client.send('DOM.enable');
                    await client.send('Runtime.enable');
                    const allClickListeners = await this.findNodesWithClickListeners(client, event);
                    for (const clickListener of allClickListeners) {
                        try {
                            allCssPaths.push(...(await domPath.getCssPaths(clickListener)));
                        } catch (error) {
                            // The query selector is invalid.
                        }
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
        const stripCache = this.createStripCache();

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
                if (crawlManager.isCrawlActionUnique(cssPath, actionHash)) {
                    crawlActions.push(new CrawlAction(node.tagName, 'click', cssPath, actionHash, currentState));
                    crawlManager.registerActionSignature(cssPath, actionHash);
                }
            } catch (error) {
                console.error(error);
                continue;
            }
        }

        return (crawlActions.length !== 0) ? (this.crawlerConfig.maxChildren ? crawlActions.slice(0, this.crawlerConfig.maxChildren).reverse() : crawlActions.reverse()) : [];
    }

    /**
     * Fills out all CrawlInputs provided to it in the iterable.
     * @param page - Puppeteer page instance
     * @param crawlInputs - Array of CrawlInput objects to fill
     */
    async fillAllInputs(page: Page, crawlInputs: CrawlInput[]): Promise<void> {
        for (const crawlInput of crawlInputs) {
            try {
                await crawlInput.inputFieldHandler(page);
            } catch (error) {
                console.error(chalk.red(`[ERROR] Could not fill input field: ${crawlInput.cssPath}`));
                this.removeCrawlInputFromState(crawlInput);
            }
        }
    }

    /**
     * Performs the given crawlaction on page.
     * @param crawlManager - Crawl state manager instance
     * @param crawlerAction - The action to perform
     * @param page - Puppeteer page instance
     */
    async performAction(crawlManager: CrawlStateManager, crawlerAction: CrawlAction, page: Page): Promise<void> {
        let node;
        const currentStateHash = await this.getPageHash(page);
        if (currentStateHash !== crawlerAction.parentState.stateHash) {
            const replayPlan = crawlManager.getOptimizedReplayPlan(crawlerAction.parentState);
            // // Log the replay plan in detail
            // console.log('[Crawl] Replay Plan:');
            // if (replayPlan) {
            //     console.log('\tBaseline URL:', replayPlan.baselineUrl);
            //     if (Array.isArray(replayPlan.actionsToReplay)) {
            //         console.log('\tActions To Replay:');
            //         replayPlan.actionsToReplay.forEach((action: any, idx: number) => {
            //             console.log(`\t  [${idx}]`);
            //             console.log(`\t    Element: ${action.element}`);
            //             console.log(`\t    Action Type: ${action.action}`);
            //             console.log(`\t    CSS Path: ${action.cssPath}`);
            //             console.log(`\t    Action Hash: ${action.actionHash}`);
            //             if (action.parentState) {
            //                 console.log(`\t    Parent State Hash: ${action.parentState.stateHash}`);
            //                 if (Array.isArray(action.parentState.crawlInputs)) {
            //                     console.log(`\t    Parent Crawl Inputs: [${action.parentState.crawlInputs.map((i: any) => i.cssPath).join(', ')}]`);
            //                 }
            //             }
            //         });
            //         console.log('\t  Current Crawl Action:');
            //         console.log(`\t    Element: ${crawlerAction.element}`);
            //         console.log(`\t    Action Type: ${crawlerAction.action}`);
            //         console.log(`\t    CSS Path: ${crawlerAction.cssPath}`);
            //         console.log(`\t    Action Hash: ${crawlerAction.actionHash}`);
            //     } else {
            //         console.log('\tNo actions to replay.');
            //     }
            // } else {
            //     console.log('\tNo replay plan available.');
            // }
            if (!replayPlan) return;
            {
                const maxRetries = this.crawlerConfig.maxActionRetries ?? 3;
                let success = false;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        await page.goto(replayPlan.baselineUrl, { waitUntil: 'domcontentloaded' });
                        await page.waitForFunction(() => (globalThis as any).document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
                        success = true;
                        break;
                    } catch (error) {
                        console.error(chalk.red(`[ERROR] Failed to navigate to baseline (attempt ${attempt}/${maxRetries}): ${error instanceof Error ? error.message : 'Unknown error'}`));
                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                }
                if (!success) {
                    console.error(chalk.red('[ERROR] Exhausted retries navigating to baseline state'));
                    return;
                }
            }

            for (const crawlAction of replayPlan.actionsToReplay) {
                if (crawlAction.element !== CrawlAction.ANCHOR) {
                    // console.log('All crawlinputs:');
                    // console.log(crawlAction.parentState.crawlInputs);
                    await this.fillAllInputs(page, crawlAction.parentState.crawlInputs);
                }
                try {
                    node = await page.waitForSelector(crawlAction.cssPath);
                } catch (error) {
                    this.removeCrawlActionFromState(crawlManager, crawlAction);
                    return;
                }
                if (!node) {
                    this.removeCrawlActionFromState(crawlManager, crawlAction);
                    return;
                }
                try {
                    await node.click();
                } catch (error: any) {
                    const { message } = error;
                    if (message === 'Node is either not clickable or not an Element') {
                        try {
                            await node.evaluate((n: any) => n.click());
                        } catch (evalError) {
                            console.error(chalk.red(`\n[ERROR] ${evalError instanceof Error ? evalError.message : 'Unknown error'}`));
                            this.removeCrawlActionFromState(crawlManager, crawlAction);
                            return;
                        }
                    } else {
                        console.error(chalk.red(`\n[ERROR] ${message}`));
                        this.removeCrawlActionFromState(crawlManager, crawlAction);
                        return;
                    }
                }
            }
        }

        if (crawlerAction.element !== CrawlAction.ANCHOR) {
            await this.fillAllInputs(page, crawlerAction.parentState.crawlInputs);
        }
        try {
            node = await page.waitForSelector(crawlerAction.cssPath);
        } catch (error) {
            this.removeCrawlActionFromState(crawlManager, crawlerAction);
            return;
        }
        if (!node) {
            this.removeCrawlActionFromState(crawlManager, crawlerAction);
            return;
        }
        try {
            await node.click();
        } catch (error: any) {
            const { message } = error;
            if (message === 'Node is either not clickable or not an Element') {
                try {
                    await node.evaluate((n: any) => n.click());
                } catch (evalError) {
                    console.error(chalk.red(`\n[ERROR] ${evalError instanceof Error ? evalError.message : 'Unknown error'}`));
                }
            } else {
                console.error(chalk.red(`\n[ERROR] ${message}`));
            }
        }

        await page.waitForFunction(
            async (eventWait: number) => await new Promise<boolean>((resolve) => setTimeout(() => {
                resolve(true);
            }, eventWait)),
            { timeout: this.crawlerConfig.navigationTimeout },
            this.crawlerConfig.eventWait,
        );

        if (!this.allUrls.has(page.url())) {
            console.log(chalk.magenta('[URL] ') + chalk.green(page.url()));
            this.allUrls.add(page.url());
            this.appendUrlToOutputFile(page.url());
        }
    }

    /**
     * Checks if the given URL is in context or not.
     * @param url - URL to check
     * @return boolean indicating if URL is in context
     */
    inContext(url: string): boolean {
        // Check if it is excluded
        for (const regex of this.crawlerConfig.excludeRegexes) {
            if (this.compileRegex(regex).test(url)) {
                return false;
            }
        }

        // Check if it is included
        for (const regex of this.crawlerConfig.includeRegexes) {
            if (this.compileRegex(regex).test(url)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Returns the compiled form of a scope pattern, compiling it at most once.
     *
     * `test` rather than `String.prototype.match` at the call sites: the result
     * is only ever used as a boolean, and `match` allocates a result array on
     * every hit. None of these patterns carry the `g` flag — `new RegExp` is
     * called without flags — so `test` is stateless here and safe to reuse.
     *
     * @param pattern - Regular expression source from the crawler config.
     * @return The compiled expression.
     */
    private compileRegex(pattern: string): RegExp {
        let compiled = this.compiledRegexes.get(pattern);
        if (!compiled) {
            compiled = new RegExp(pattern);
            this.compiledRegexes.set(pattern, compiled);
        }
        return compiled;
    }

    /**
     * Maximizes viewport according to screensize.
     * @param page - Puppeteer page instance
     */
    async maximizeViewport(page: Page): Promise<void> {
        const screen = await page.evaluate(() => {
            return {
                width: (globalThis as any).screen.availWidth,
                height: (globalThis as any).screen.availHeight,
            };
        });
        await page.setViewport({ width: screen.width, height: screen.height });
    }

    /**
     * Starts authentication on the given browser instance.
     * @param browser - Puppeteer browser instance
     * @param page - Puppeteer page instance
     */
    async startAuthentication(browser: PuppeteerBrowser, page: Page): Promise<void> {
        this.authInProgress = true;
        await authenticate(browser, page, path.resolve(__dirname, this.crawlerConfig.authentication.recorderAuth.pptrRecording || ''));
        this.authInProgress = false;
        await this.maximizeViewport(page);
    }

    /**
     * Returns the SHA256 hash of the stripped DOM of the given page.
     * @param page - Puppeteer page instance
     * @return Promise resolving to the page hash string
     */
    async getPageHash(page: Page): Promise<string> {
        try {
            await page.waitForFunction(
                () => (globalThis as any).document.readyState === 'complete',
                { timeout: this.crawlerConfig.navigationTimeout }
            );
        } catch (error: any) {
            this.debugLog(
                `getPageHash readyState wait timed out url=${page.url()} error=${error instanceof Error ? error.message : String(error)}`
            );
        }
        let $: cheerio.CheerioAPI;
        try {
            $ = cheerio.load(await page.content(), { xmlMode: true }) as cheerio.CheerioAPI;
        } catch (error: any) {
            const { message } = error;
            if (message === 'Execution context was destroyed, most likely because of a navigation.') {
                this.debugLog(`getPageHash execution context destroyed, waiting for navigation url=${page.url()}`);
                try {
                    await page.waitForNavigation({
                        waitUntil: ['domcontentloaded'],
                        timeout: this.crawlerConfig.navigationTimeout,
                    });
                } catch (navError: any) {
                    this.debugLog(
                        `getPageHash waitForNavigation timeout url=${page.url()} error=${navError instanceof Error ? navError.message : String(navError)}`
                    );
                }
                $ = cheerio.load(await page.content(), { xmlMode: true }) as cheerio.CheerioAPI;
            } else {
                console.error(chalk.red(`\n[ERROR] ${message}`));
                throw error;
            }
        }
        this.stripDOM($);
        const pageHash = createHash('sha256').update($.html()).digest('hex');

        return pageHash;
    }

    /**
     * Creates and returns a new CrawlState using the page and crawl depth passed to it.
     * @param page - Puppeteer page instance
     * @param crawlDepth - Depth of the crawl
     * @param stateHash - Hash of the current state
     * @param crawlManager - Crawl state manager instance
     * @return Promise resolving to a new CrawlState object
     */
    async getNewCrawlState(page: Page, crawlDepth: number, stateHash: string, crawlManager: CrawlStateManager, arrivalType: ArrivalType): Promise<CrawlState> {
        // console.log(`Crawl state creator called for page: ${page.url()}`);
        const crawlState = new CrawlState(page.url(), stateHash, crawlDepth, arrivalType);
        crawlState.crawlActions = await this.getCrawlActions(page, crawlState, crawlManager);
        // console.log('Crawl actions found:');
        // console.log(crawlState.crawlActions.map((action) => action.cssPath));
        crawlState.crawlInputs = await this.getCrawlInputs(page, crawlState);
        // console.log(`Crawl inputs found:`);
        // console.log(crawlState.crawlInputs.map((input) => input.cssPath));
        crawlManager.registerState(crawlState);
        // Every state the crawl reaches is created here, so this is the one hook
        // the inventory needs: it does not have to walk the graph afterwards, and
        // it stays correct while browsers are still adding states concurrently.
        this.inventory.recordState({
            url: crawlState.url,
            stateHash: crawlState.stateHash,
            crawlDepth: crawlState.crawlDepth,
            arrivalType: crawlState.arrivalType,
            actions: crawlState.crawlActions.length,
            inputs: crawlState.crawlInputs.map((input) => input.cssPath),
        });
        return crawlState;
    }

    /**
     * Removes the given CrawlAction from the parent CrawlState.
     * @param crawlAction - The action to remove
     */
    removeCrawlActionFromState(crawlManager: CrawlStateManager, crawlAction: CrawlAction): void {
        crawlManager.unregisterActionSignature(crawlAction.cssPath, crawlAction.actionHash);
        crawlAction.getParentState().crawlActions = crawlAction.getParentState().crawlActions.filter((value) =>
            crawlAction.actionId !== value.actionId
        );
    }

    /**
     * Removes the given CrawlInput from the parent CrawlState.
     * @param crawlInput - The input to remove
     */
    removeCrawlInputFromState(crawlInput: CrawlInput): void {
        crawlInput.getParentState().crawlInputs = crawlInput.getParentState().crawlInputs.filter((value) =>
            crawlInput.inputId !== value.inputId
        );
    }

    /**
     * Append the given URL to the output file.
     *
     * Called from inside the `page.on('request')` handler, which is the single
     * most latency-sensitive place in the crawler: every intercepted request
     * waits behind it, across every browser instance. It used to `appendFileSync`
     * — a blocking write, plus a `path.resolve` of the same string — so each
     * newly discovered URL stalled the event loop on disk I/O.
     *
     * A write stream fixes both: the path is resolved once when the stream is
     * opened, and `write` hands off to libuv instead of blocking. Ordering is
     * still guaranteed, because a stream serialises its own queued writes.
     *
     * @param url - URL to append
     */
    appendUrlToOutputFile(url: string): void {
        const target = this.crawlerConfig.outputFile;
        if (!target) {
            return;
        }
        if (!this.outputFileStream) {
            // 'a' rather than 'w': `bin/index.ts` truncates the file up front so
            // a run starts clean, and opening for append here keeps that single
            // truncation authoritative instead of racing it.
            this.outputFileStream = createWriteStream(path.resolve(target), { flags: 'a' });
            this.outputFileStream.on('error', (err: Error) => {
                console.error(chalk.red(`[ERROR] Could not write to output file: ${err.message}`));
            });
        }
        this.outputFileStream.write(url + '\n');
    }

    /**
     * Flushes and closes the output stream, resolving once the data is on its
     * way to the OS.
     *
     * A buffered stream that is never closed can lose its tail when the process
     * exits, which would silently truncate the URL list a crawl exists to
     * produce — so this is awaited in `startCrawling`'s `finally`, alongside the
     * inventory write.
     *
     * @return Promise resolving when the stream is closed.
     */
    private async closeOutputFile(): Promise<void> {
        const stream = this.outputFileStream;
        if (!stream) {
            return;
        }
        this.outputFileStream = null;
        await new Promise<void>((resolve) => {
            stream.end(() => resolve());
        });
    }

    /**
     * This function handles all the asynchronous crawling.
     * @param crawlManager - Crawl state manager instance
     * @param browser - Puppeteer browser instance
     * @param page - Puppeteer page instance
     * @param currentState - Current crawl state
     */
    async handleCrawl(crawlManager: CrawlStateManager, browser: PuppeteerBrowser, page: Page, currentState: CrawlState): Promise<void> {
        let nextCrawlAction: CrawlAction | null;
        try {
            while (
                !this.abortController.signal.aborted &&
                (nextCrawlAction = crawlManager.getNextCrawlAction()) &&
                (this.crawlerConfig.maxDuration === 0 || Date.now() < this.endTime!)
            ) {
                const currentAction = nextCrawlAction;
                try {
                    await this.performAction(crawlManager, currentAction, page);
                } catch (err) {
                    if (this.abortController.signal.aborted) {
                        break;
                    }
                    throw err;
                }
                const currentStateHash = await this.getPageHash(page);
                const existingState = crawlManager.getStateByHash(currentStateHash);
                if (existingState) {
                    currentState = existingState;
                    this.removeCrawlActionFromState(crawlManager, currentAction);
                } else {
                    if (this.inContext(page.url())) {
                        const previousUrl = currentAction.getParentState().url.split('#')[0];
                        const newUrl = page.url().split('#')[0];
                        const arrivalType: ArrivalType = (currentAction.element === CrawlAction.ANCHOR && previousUrl !== newUrl) ? 'link' : 'dom';
                        currentState = await this.getNewCrawlState(page, currentAction.getParentState().crawlDepth + 1, currentStateHash, crawlManager, arrivalType);
                        currentAction.childState = currentState;
                        if (currentState) {
                            currentState.parentAction = currentAction;
                        }
                    } else {
                        this.removeCrawlActionFromState(crawlManager, currentAction);
                    }
                }
            }
        } catch (err) {
            if (!this.abortController.signal.aborted) {
                throw err;
            }
        } finally {
            await browser.close().catch(() => undefined);
        }
    }

    /**
     * Starts the crawling process.
     */
    async startCrawling(): Promise<void> {
        try {
            console.log(chalk.greenBright('[INFO] Initializing browser...'));
            const browsers = await Promise.all(
                Array.from({ length: this.config.browser.instances }).map(
                    () => Browser.getBrowserInstance(this.config.browser),
                ),
            );
            this.activeBrowsers = browsers;
            console.log(chalk.greenBright('[INFO] Browser(s) initialized successfully!'));
            console.log(chalk.greenBright(`[INFO] Sasori will now start crawling from ${this.crawlerConfig.entryPoint}`));

            for (const browser of browsers) {
                // If a new tab is opened while crawling, close it
                browser.on('targetcreated', async (target) => {
                    const targetBrowser = target.browser();
                    const allTargetBrowserPages = await targetBrowser.pages();
                    const targetPage = await target.page();
                    if (targetPage && target.type() === 'page' && allTargetBrowserPages.length > 1) {
                        await targetPage.close();
                    }
                });
            }

            const startTime = Date.now();
            this.endTime = startTime + this.crawlerConfig.maxDuration;
            if (this.crawlerConfig.maxDuration === 0) {
                console.log(chalk.greenBright('[INFO] Max duration is set to 0, sasori will run indefinitely.'));
            } else {
                console.log(chalk.greenBright(`[INFO] Sasori will stop crawling at ${new Date(this.endTime).toTimeString()}`));
            }

            const allPages: Page[] = [];
            for (const [i, browser] of browsers.entries()) {
                const pages = await browser.pages();
                const page = pages[0];
                if (!page) continue;
                page.setDefaultTimeout(this.crawlerConfig.eventTimeout);
                page.setDefaultNavigationTimeout(this.crawlerConfig.navigationTimeout);
                this.attachPageDebugListeners(page, i);
                await this.maximizeViewport(page);
                allPages.push(page);
            }

            // Authenticate if basic auth is enabled
            if (this.crawlerConfig.authentication.basicAuth && this.crawlerConfig.authentication.basicAuth.enabled) {
                for (const page of allPages) {
                    await page.authenticate({
                        username: this.crawlerConfig.authentication.basicAuth.username!,
                        password: this.crawlerConfig.authentication.basicAuth.password!
                    });
                }
            }

            // Statically respond to out-of-scope requests.
            console.log(chalk.greenBright('[INFO] Setting up scope manager...'));
            for (const page of allPages) {
                await page.setRequestInterception(true);
                page.on('request', async (interceptedRequest) => {
                    if (interceptedRequest.isInterceptResolutionHandled()) return;

                    if (this.inContext(interceptedRequest.url())) {
                        // Recorded per request rather than per unique URL: the
                        // inventory aggregates by endpoint, so it needs to see
                        // every request to count them and to collect parameter
                        // names that only appear on later visits.
                        this.inventory.recordRequest(
                            interceptedRequest.method(),
                            interceptedRequest.url(),
                            {
                                postData: interceptedRequest.postData(),
                                contentType: interceptedRequest.headers()['content-type'],
                                resourceType: interceptedRequest.resourceType(),
                            },
                        );
                        if (!this.allUrls.has(interceptedRequest.url())) {
                            console.log(chalk.magentaBright('[URL] ') + chalk.green(interceptedRequest.url()));
                            this.allUrls.add(interceptedRequest.url());
                            this.appendUrlToOutputFile(interceptedRequest.url());
                        }
                    }

                    if (this.authInProgress) {
                        const parsedUrl = new URL(interceptedRequest.url());
                        const authority = parsedUrl.host;
                        const includeRegex = `https?://${authority}(?:/.*|)`;
                        if (!this.crawlerConfig.includeRegexes.includes(includeRegex)) {
                            this.crawlerConfig.includeRegexes.push(includeRegex);
                        }
                    }

                    if ((this.authInProgress === false && !this.inContext(interceptedRequest.url()))) {
                        interceptedRequest.respond({
                            status: 403,
                            contentType: 'text/plain',
                            body: 'Out of Sasori\'s scope',
                        });
                    } else {
                        interceptedRequest.continue();
                    }
                });
            }

            // Dismiss all alerts/popups
            for (const page of allPages) {
                page.on('dialog', async (dialog) => {
                    await dialog.dismiss();
                });
            }

            console.log(chalk.greenBright('[INFO] Scope manager started successfully!'));

            // Start authentication if enabled.
            if (this.crawlerConfig.authentication.recorderAuth && this.crawlerConfig.authentication.recorderAuth.enabled) {
                console.log(chalk.greenBright('[INFO] Running initial authentication...'));
                await Promise.all(
                    Array.from({ length: browsers.length }).map(
                        (_, i) => {
                            const browser = browsers[i];
                            const page = allPages[i];
                            if (browser && page) {
                                return this.startAuthentication(browser, page);
                            }
                            return Promise.resolve();
                        },
                    ),
                );
            }

            console.log(chalk.greenBright('[INFO] Creating crawl state manager...'));
            const crawlManager = new CrawlStateManager();

            if (allPages.length === 0) {
                throw new Error('No pages available for crawling');
            }

            const firstPage = allPages[0];
            if (!firstPage) {
                throw new Error('No pages available for crawling');
            }

            {
                const maxRetries = this.crawlerConfig.maxActionRetries ?? 3;
                let success = false;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    if (this.abortController.signal.aborted) {
                        return;
                    }
                    try {
                        await firstPage.goto(this.crawlerConfig.entryPoint, { waitUntil: ['domcontentloaded'] });
                        await firstPage.waitForFunction(() => (globalThis as any).document.readyState === 'complete', { timeout: this.crawlerConfig.navigationTimeout });
                        success = true;
                        break;
                    } catch (error) {
                        console.error(chalk.red(`[ERROR] Failed to navigate to entry point (attempt ${attempt}/${maxRetries}): ${error instanceof Error ? error.message : 'Unknown error'}`));
                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                }
                if (!success) {
                    throw new Error('Crawler initialization failed: exhausted retries navigating to entry point');
                }
            }
            if (this.abortController.signal.aborted) {
                return;
            }
            const rootStateHash = await this.getPageHash(firstPage);
            const rootState = await this.getNewCrawlState(firstPage, 0, rootStateHash, crawlManager, 'link');
            crawlManager.attachRootState(rootState);

            const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
            const handleCrawls = browsers.map((browser, index) => async () => {
                await delay(index * this.browserStartDelays);
                const page = allPages[index];
                if (browser && page) {
                    return this.handleCrawl(crawlManager, browser, page, rootState);
                }
                return Promise.resolve();
            });
            try {
                await Promise.all(handleCrawls.map((handleCrawl) => handleCrawl()));
            } catch (err) {
                if (!this.abortController.signal.aborted) {
                    throw err;
                }
            }
            if (this.abortController.signal.aborted) {
                console.log(chalk.yellow('[INFO] Crawl stopped by request'));
                return;
            }
            console.log(chalk.greenBright.bold('Scan completed'));
        } finally {
            this.activeBrowsers = [];
            // Written in `finally` on purpose: a crawl that was stopped or that
            // died part-way still covered something, and that partial inventory
            // is the evidence for what happened before it stopped. Discarding it
            // would make a timeout indistinguishable from a crawl that reached
            // nothing.
            this.writeInventoryFile();
            await this.closeOutputFile();
        }
    }

    /**
     * Returns the crawl inventory — every endpoint and DOM state reached.
     */
    getInventory(): CrawlInventory {
        return this.inventory.snapshot();
    }

    /**
     * Writes the inventory to `crawler.inventoryFile` when one is configured.
     *
     * Failure to write is reported and swallowed. The inventory is a measurement
     * artifact; letting an unwritable path turn a completed crawl into a failed
     * one would lose the crawl as well as the measurement.
     */
    writeInventoryFile(): void {
        const target = this.crawlerConfig.inventoryFile;
        if (!target) {
            return;
        }
        try {
            const fullPath = path.resolve(target);
            writeFileSync(fullPath, JSON.stringify(this.getInventory(), null, 2) + '\n');
            console.log(chalk.greenBright('[INFO] Crawl inventory written to ') + chalk.green(fullPath));
        } catch (err) {
            console.error(chalk.red('[ERROR] Could not write crawl inventory: ') + String(err));
        }
    }

    /**
     * Stop the crawling process.
     */
    stopCrawling(): void {
        if (this.abortController.signal.aborted) {
            return;
        }
        this.abortController.abort();
        for (const browser of this.activeBrowsers) {
            void browser.close().catch(() => undefined);
        }
    }
}

export default Crawler;
