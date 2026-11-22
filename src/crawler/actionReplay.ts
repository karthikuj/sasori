import { Page } from 'puppeteer';
import chalk from 'chalk';

import CrawlAction from './crawlAction';
import CrawlInput from './crawlInput';
import CrawlStateManager from './crawlStateManager';
import { PruneReason } from './crawlGraph';
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
 * Puts a browser in front of the state an action belongs to, then performs it.
 *
 * Multiple browsers share one `CrawlStateManager`, so the page in front of you
 * is usually *not* the parent state of the action just popped off the frontier.
 * Rather than backtrack, the crawler compares the live page hash against the
 * action's parent state and, on a mismatch, replays: navigate to the nearest
 * ancestor state that was reached by a real URL, then re-perform only the
 * actions after it.
 *
 * Split out of `Crawler` in SCAN-90 because it is a self-contained concern — it
 * reads the crawl graph and drives one page, and touches none of the crawl
 * loop's shared, unlocked state beyond pruning selectors that no longer resolve.
 */
export class ActionReplay {
    /** DOM/network must be quiet this long for the page to count as settled. */
    private static readonly SETTLE_QUIET_MS = 500;

    /** Hard cap on the post-action settle, so a forever-mutating live page (or a
     * forever-chatty network) cannot stall the crawl one action at a time. */
    private static readonly SETTLE_CAP_MS = 3000;

    /**
     * @param config - Crawler settings (timeouts and retry budget).
     * @param hashPage - Computes the current page's state hash.
     * @param recordUrl - Records a URL the page settled on after an action.
     */
    constructor(
        private readonly config: CrawlerSettings,
        private readonly hashPage: (page: Page) => Promise<string>,
        private readonly recordUrl: (url: string) => void,
        private readonly onPrune?: (crawlAction: CrawlAction, reason: PruneReason) => void,
    ) { }

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
    async performAction(crawlManager: CrawlStateManager, crawlerAction: CrawlAction, page: Page): Promise<boolean> {
        let node;
        const currentStateHash = await this.hashPage(page);
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
            if (!replayPlan) return false;
            {
                const maxRetries = this.config.maxActionRetries ?? 3;
                let success = false;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        await page.goto(replayPlan.baselineUrl, { waitUntil: 'domcontentloaded' });
                        await page.waitForFunction(() => document.readyState === 'complete', { timeout: this.config.navigationTimeout });
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
                    return false;
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
                    return false;
                }
                if (!node) {
                    this.removeCrawlActionFromState(crawlManager, crawlAction);
                    return false;
                }
                try {
                    await node.click();
                } catch (error: unknown) {
                    const message = errorMessage(error);
                    if (message === 'Node is either not clickable or not an Element') {
                        try {
                            await node.evaluate((n: Element) => (n as HTMLElement).click());
                        } catch (evalError) {
                            console.error(chalk.red(`\n[ERROR] ${evalError instanceof Error ? evalError.message : 'Unknown error'}`));
                            this.removeCrawlActionFromState(crawlManager, crawlAction);
                            return false;
                        }
                    } else {
                        console.error(chalk.red(`\n[ERROR] ${message}`));
                        this.removeCrawlActionFromState(crawlManager, crawlAction);
                        return false;
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
            return false;
        }
        if (!node) {
            this.removeCrawlActionFromState(crawlManager, crawlerAction);
            return false;
        }
        try {
            await node.click();
        } catch (error: unknown) {
            const message = errorMessage(error);
            if (message === 'Node is either not clickable or not an Element') {
                try {
                    await node.evaluate((n: Element) => (n as HTMLElement).click());
                } catch (evalError) {
                    console.error(chalk.red(`\n[ERROR] ${evalError instanceof Error ? evalError.message : 'Unknown error'}`));
                }
            } else {
                console.error(chalk.red(`\n[ERROR] ${message}`));
            }
        }

        // Let the action settle before returning. A click can start an async
        // navigation — including a SPA soft-navigation (history.pushState + an
        // RSC/XHR fetch) that fires no frame-navigation event — and if we return
        // while it is still in flight, the next action races it: the crawl loop's
        // getPageHash reads the pre-navigation state (so no replay is triggered)
        // and the next selector resolution then fails when the route change lands
        // mid-wait, pruning an action that was perfectly valid. Gating on network
        // idle (a readiness signal, not a fixed sleep) settles both hard and soft
        // navigations and returns promptly for a click that changed nothing
        // (SCAN-198).
        await this.settleAfterAction(page);

        // An action can navigate, and the URL it lands on may be one no request
        // interceptor reported — a same-document route change, for instance. The
        // crawler owns the discovered-URL set, so recording goes back through it.
        this.recordUrl(page.url());

        // The click was dispatched. Only then may the caller spend this widget's
        // signature: marking one that was pruned before it ever ran would strand
        // every other copy of it, which is precisely the failure the receipt model
        // exists to remove (SCAN-198).
        return true;
    }

    /**
     * Waits for the page to settle after an action's click, so the next action
     * never races an in-flight navigation.
     *
     * The signal we need is a DOM one — "the route has rendered and the page is
     * stable" — not a network one. Network idle catches an SPA soft-navigation's
     * RSC/XHR fetch, but on a chatty target (polling, streaming, analytics
     * heartbeats) the network never idles, so waiting on it alone would burn the
     * full timeout on every action. So the primary signal is a short DOM-quiet
     * window (a MutationObserver seeing no mutations for `SETTLE_QUIET_MS`),
     * which stabilises even while the network keeps chattering; it is raced with
     * network idle so an ordinary page still resolves the instant its fetch
     * settles. Both are bounded by `SETTLE_CAP_MS` so a pathological page (a live
     * feed that mutates forever) cannot stall the crawl. All rejections are
     * swallowed — a settle is best-effort, and the replay hash-check is the
     * backstop if the page is still not where we expect.
     */
    private async settleAfterAction(page: Page): Promise<void> {
        await Promise.race([
            this.waitForDomQuiet(page, ActionReplay.SETTLE_QUIET_MS, ActionReplay.SETTLE_CAP_MS).catch(() => undefined),
            page.waitForNetworkIdle({ idleTime: ActionReplay.SETTLE_QUIET_MS, timeout: ActionReplay.SETTLE_CAP_MS }).catch(() => undefined),
        ]);

        if (this.config.eventWait && this.config.eventWait > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.config.eventWait));
        }
    }

    /**
     * Resolves once the DOM has had no mutations for `quietMs`, or `capMs`
     * elapses — whichever first. Runs entirely in the page. If the page performs
     * a full document navigation the execution context is destroyed and the
     * evaluate rejects; the caller swallows that (the network-idle arm or the
     * subsequent hash-check covers the hard-navigation case).
     */
    private async waitForDomQuiet(page: Page, quietMs: number, capMs: number): Promise<void> {
        await page.evaluate(
            (quiet: number, cap: number) => {
                // Access browser globals via a cast, the way the other in-page
                // evaluates in this codebase do, so the Node tsconfig lib need not
                // include the DOM types.
                const g = globalThis as unknown as {
                    MutationObserver: new (cb: () => void) => { observe: (target: unknown, opts: unknown) => void; disconnect: () => void };
                    document: { documentElement: unknown };
                    setTimeout: (fn: () => void, ms: number) => number;
                    clearTimeout: (id: number) => void;
                };
                return new Promise<void>((resolve) => {
                    let quietTimer = g.setTimeout(resolve, quiet);
                    const observer = new g.MutationObserver(() => {
                        g.clearTimeout(quietTimer);
                        quietTimer = g.setTimeout(resolve, quiet);
                    });
                    observer.observe(g.document.documentElement, {
                        subtree: true,
                        childList: true,
                        attributes: true,
                        characterData: true,
                    });
                    g.setTimeout(() => {
                        observer.disconnect();
                        g.clearTimeout(quietTimer);
                        resolve();
                    }, cap);
                });
            },
            quietMs,
            capMs,
        );
    }

    /**
     * Removes the given CrawlAction from the parent CrawlState.
     * @param crawlManager - Crawl state manager instance.
     * @param crawlAction - The action to remove.
     * @param reason - Why it is being removed. Defaults to `unresolved`, the
     * replay failures below; the crawl loop passes the healthy reasons
     * (`revisited`, `out-of-scope`) so the crawl graph can tell a coverage gap
     * from an action that simply landed somewhere already known (SCAN-198).
     */
    removeCrawlActionFromState(crawlManager: CrawlStateManager, crawlAction: CrawlAction, reason: PruneReason = 'unresolved'): void {
        crawlManager.unregisterActionSignature(crawlAction.cssPath, crawlAction.actionHash);
        crawlAction.getParentState().crawlActions = crawlAction.getParentState().crawlActions.filter((value) =>
            crawlAction.actionId !== value.actionId
        );
        // Every prune — whether initiated by the crawl loop or by a replay
        // failure inside performAction — funnels through here, so this is the one
        // place the crawl-graph recorder needs to see them (SCAN-197).
        this.onPrune?.(crawlAction, reason);
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

}

export default ActionReplay;
