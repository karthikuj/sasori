/**
 * Action dedup: a receipt, not a lock (SCAN-198).
 *
 * The dedup exists for a good reason — a nav bar and a global search box are in
 * every state, and clicking them once per page is the crawl equivalent of
 * walking in circles. What made it misfire was *when* it was decided. The
 * signature was claimed at discovery by whichever page saw the widget first and
 * released only when that copy was removed, so:
 *
 *   - a copy that never reached the front of the frontier held the signature for
 *     the whole crawl, and every later copy was dropped in deference to it — the
 *     widget was then exercised nowhere. A price-filter form present on 44
 *     category pages was submitted zero times this way: one copy parked, eight
 *     twins discarded.
 *   - and because the claim *was* released once a copy executed, the next page
 *     rediscovered the same nav link and clicked it again. Measured on one crawl:
 *     18 distinct chrome widgets, 82 clicks.
 *
 * Both follow from the same mistake, so both are fixed by the same move: keep a
 * bounded number of copies, decide at execution, and never release.
 */

import CrawlAction from '../../src/crawler/crawlAction';
import CrawlState from '../../src/crawler/crawlState';
import { CrawlStateManager } from '../../src/crawler/crawlStateManager';

describe('action signatures', () => {
    const CSS = 'BODY > MAIN > FORM > BUTTON';
    const HASH = 'widget-hash';

    function managerWithRoot(): { manager: CrawlStateManager; root: CrawlState } {
        const manager = new CrawlStateManager();
        const root = new CrawlState('http://x/', 'root-hash', 0, 'link');
        manager.attachRootState(root);
        return { manager, root };
    }

    it('keeps a bounded number of un-executed copies instead of exactly one', () => {
        const { manager } = managerWithRoot();

        // Three pages discover the same widget; none has been clicked yet.
        for (let i = 0; i < 3; i++) {
            expect(manager.shouldRetainAction(CSS, HASH)).toBe(true);
            manager.registerActionSignature(CSS, HASH);
        }

        // The fourth is dropped — the point of the bound.
        expect(manager.shouldRetainAction(CSS, HASH)).toBe(false);
    });

    it('stops retaining copies once the widget has actually been clicked', () => {
        const { manager } = managerWithRoot();
        expect(manager.shouldRetainAction(CSS, HASH)).toBe(true);

        manager.markActionSignatureExecuted(CSS, HASH);

        expect(manager.shouldRetainAction(CSS, HASH)).toBe(false);
        expect(manager.hasExecutedActionSignature(CSS, HASH)).toBe(true);
    });

    // The regression that mattered: the old rule released the signature when the
    // executed copy was removed from its state, so the next page discovered the
    // same nav link and clicked it again — 82 clicks for 18 widgets.
    it('does not let removing an executed copy license another click', () => {
        const { manager } = managerWithRoot();
        manager.registerActionSignature(CSS, HASH);
        manager.markActionSignatureExecuted(CSS, HASH);

        manager.unregisterActionSignature(CSS, HASH); // the copy leaves its state

        expect(manager.hasExecutedActionSignature(CSS, HASH)).toBe(true);
        expect(manager.shouldRetainAction(CSS, HASH)).toBe(false);
    });

    // The other half: an un-executed copy must not speak for the pages that come
    // after it. Removing one (pruned, out of scope, whatever) frees its slot, and
    // a later page can still contribute its own copy.
    it('lets a later page contribute a copy while none has been clicked', () => {
        const { manager } = managerWithRoot();
        for (let i = 0; i < 3; i++) {
            manager.registerActionSignature(CSS, HASH);
        }
        expect(manager.shouldRetainAction(CSS, HASH)).toBe(false);

        manager.unregisterActionSignature(CSS, HASH);

        expect(manager.shouldRetainAction(CSS, HASH)).toBe(true);
        expect(manager.hasExecutedActionSignature(CSS, HASH)).toBe(false);
    });

    it('scopes the receipt to the exact widget, not to any button anywhere', () => {
        const { manager } = managerWithRoot();
        manager.markActionSignatureExecuted(CSS, HASH);

        expect(manager.hasExecutedActionSignature(CSS, 'a-different-neighbourhood')).toBe(false);
        expect(manager.hasExecutedActionSignature('BODY > HEADER > FORM > BUTTON', HASH)).toBe(false);
    });

    it('survives a reindex — a spent signature stays spent', () => {
        const { manager, root } = managerWithRoot();
        const action = new CrawlAction('BUTTON', 'click', CSS, HASH, root);
        root.crawlActions = [action];
        manager.registerActionSignature(CSS, HASH);
        manager.markActionSignatureExecuted(CSS, HASH);

        // Reindexing rebuilds the twin counts from the graph; the receipts are
        // not part of the graph and must not be rebuilt away with them.
        manager.attachRootState(root);

        expect(manager.hasExecutedActionSignature(CSS, HASH)).toBe(true);
    });

    // The hole this nearly opened: performAction can return without clicking
    // (a selector that no longer resolves prunes the action). Spending the
    // signature there would strand every other copy of the widget — the exact
    // starvation the receipt model exists to remove, just relocated.
    it('a pruned action must not spend the signature', () => {
        const { manager } = managerWithRoot();
        manager.registerActionSignature(CSS, HASH);

        // performAction returned false: nothing was clicked, so no receipt.
        manager.unregisterActionSignature(CSS, HASH);

        expect(manager.hasExecutedActionSignature(CSS, HASH)).toBe(false);
        expect(manager.shouldRetainAction(CSS, HASH)).toBe(true);
    });
});
