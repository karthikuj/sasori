import { createHash } from 'crypto';
import * as cheerio from 'cheerio';

/**
 * The parts of a parsed DOM node that {@link DomStripper} actually touches.
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

/** DOM node types, as reported by domhandler. */
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/**
 * The one attribute {@link DomStripper.strip} keeps, per upper-case tag name. A
 * lookup table rather than a `switch` plus array because it is consulted once
 * per element on the crawler's hottest path, and the answer is never more than
 * one attribute.
 */
const ALLOWED_ATTRIBUTES: Readonly<Record<string, string | undefined>> = {
    A: 'href',
    BASE: 'href',
    SCRIPT: 'src',
};

/**
 * A memo over fragment stripping, keyed on raw HTML.
 */
export interface StripCache {
    /**
     * Strips a fragment, reusing the result for markup already seen.
     * @param html - Raw HTML fragment.
     * @return The stripped, serialised fragment.
     */
    strip(html: string): string;
}

/**
 * Reduces a DOM to the structure the crawler treats as a page's identity.
 *
 * This is the crawler's hottest pure-CPU path — `getPageHash` runs it once per
 * action and action discovery three times per candidate action — and it feeds
 * `stateHash`, so its output is pinned byte-for-byte by
 * `tests/crawler/stripDom.golden.test.ts`. Read that test before changing
 * anything here: a different output does not fail loudly, it silently
 * repartitions the crawl graph, and a page that used to collapse onto an
 * existing state becomes a new one for reasons invisible in a code review.
 *
 * It is a separate class from `Crawler` because it needs no `Page` and no
 * browser. That is what makes it unit-testable against a fixture corpus and
 * measurable by `bench/stripdom.bench.ts`, which is how the optimisation below
 * was shown to be both faster and unchanged.
 *
 * ## Why the algorithm looks like this
 *
 * The obvious implementation — for each element, ask "does this element or any
 * of its descendants match an interactable selector?" — costs a full subtree
 * rescan per element per selector. Every ancestor re-walks everything beneath
 * it, S times over, so the cost grows superlinearly in DOM *depth* rather than
 * in element count (measured: depth 2 to 80 raised element count 19% but time
 * 144%). See SCAN-85.
 *
 * Instead this runs a mark-and-sweep in four linear passes:
 *
 *   1. drop text and comment nodes;
 *   2. one document-wide query for the interactable selectors, then walk
 *      *upward* from each hit marking ancestors — the ancestor walk stops at the
 *      first already-marked node, so the whole propagation is O(N) amortised no
 *      matter how deep the tree is;
 *   3. strip attributes;
 *   4. one more document-wide query for elements that still match with their
 *      attributes gone, then prune top-down.
 *
 * That is two selector queries in total rather than N*S subtree scans.
 *
 * ## The two-phase matching is not an accident
 *
 * The original stripped attributes and tested interactability in the same
 * document-order loop, which means an element was tested against the selectors
 * *after* losing its attributes, while its descendants were still tested *with*
 * theirs. So `<div><input type="submit"></div>` keeps the div (the div's
 * descendant search saw the live `type` attribute) and drops the input (by the
 * time the input itself was tested, `type` was gone). That is load-bearing for
 * every hash the crawler has ever produced, so the two passes here reproduce it
 * deliberately: pass 2 matches descendants against the *original* attributes,
 * pass 4 matches an element against its *stripped* ones.
 */
export class DomStripper {
    /**
     * The interactable selectors, pre-joined into a single CSS selector list.
     *
     * Stripping needs "does anything here match any interactable selector?" — a
     * selector list answers that in one pass over the document instead of one
     * pass per selector, and the join is done once in the constructor because
     * the selector set never changes for the life of a crawl.
     */
    private readonly interactableSelector: string;

    /**
     * @param interactables - CSS selectors for elements the crawler can act on.
     */
    constructor(private readonly interactables: readonly string[]) {
        this.interactableSelector = interactables.join(', ');
    }

    /**
     * The selectors this stripper preserves.
     * @return The interactable selector list.
     */
    getInteractables(): readonly string[] {
        return this.interactables;
    }

    /**
     * Strips a parsed document in place.
     * @param $ - Cheerio API instance.
     */
    strip($: cheerio.CheerioAPI): void {
        const allElements = $('*');

        // Remove text and comment nodes.
        allElements.contents().filter((_: number, node: unknown) => {
            const nodeType = (node as DomNode).nodeType;
            return nodeType === TEXT_NODE || nodeType === COMMENT_NODE;
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
            const allowed = ALLOWED_ATTRIBUTES[node.name?.toUpperCase() ?? ''];
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

        // Change src attribute value for <script> tags. Only reachable when the
        // configured elements keep scripts — under the default selectors pass 4
        // has already removed every script.
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
     * Parses, strips and re-serialises an HTML fragment.
     *
     * `xmlMode` matches how the crawler parses pages, and it is load-bearing for
     * the output: it is why empty elements serialise as `<div/>`, which the
     * state hashes already depend on.
     *
     * @param html - Raw HTML fragment or document.
     * @return The stripped, serialised markup.
     */
    stripHtml(html: string): string {
        const $ = cheerio.load(html, { xmlMode: true }) as cheerio.CheerioAPI;
        this.strip($);
        return $.html();
    }

    /**
     * Strips markup and hashes the result — the crawler's identity for a state.
     * @param html - Raw HTML of the page.
     * @return SHA-256 of the stripped markup, hex encoded.
     */
    hashHtml(html: string): string {
        return createHash('sha256').update(this.stripHtml(html)).digest('hex');
    }

    /**
     * Creates a short-lived memo over {@link stripHtml}, keyed on raw HTML.
     *
     * Each action snapshot is stripped three times — the node and both of its
     * element siblings — so consecutive actions in a list or table strip the
     * *same* markup repeatedly: action i's next sibling is action i+1's node,
     * and action i+2's previous sibling. Memoizing collapses those three passes
     * into one for every run of adjacent actions.
     *
     * Scoped per caller rather than per crawler on purpose: keyed on markup, a
     * long-lived cache would grow with everything the crawl has ever seen, and
     * the reuse that matters is all within a single pass anyway.
     *
     * @return A cache bounded by one discovery pass's markup.
     */
    createCache(): StripCache {
        const cache = new Map<string, string>();
        return {
            strip: (html: string): string => {
                const cached = cache.get(html);
                if (cached !== undefined) {
                    return cached;
                }
                const stripped = this.stripHtml(html);
                cache.set(html, stripped);
                return stripped;
            },
        };
    }
}

export default DomStripper;
