import { Page } from 'puppeteer';
import chalk from 'chalk';

import CrawlAction from './crawlAction';
import CrawlInput from './crawlInput';
import CrawlStateManager from './crawlStateManager';
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
    /**
     * @param config - Crawler settings (timeouts and retry budget).
     * @param hashPage - Computes the current page's state hash.
     * @param recordUrl - Records a URL the page settled on after an action.
     */
    constructor(
        private readonly config: CrawlerSettings,
        private readonly hashPage: (page: Page) => Promise<string>,
        private readonly recordUrl: (url: string) => void,
        private readonly onPrune?: (crawlAction: CrawlAction) => void,
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
    async performAction(crawlManager: CrawlStateManager, crawlerAction: CrawlAction, page: Page): Promise<void> {
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
            if (!replayPlan) return;
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
                } catch (error: unknown) {
                    const message = errorMessage(error);
                    if (message === 'Node is either not clickable or not an Element') {
                        try {
                            await node.evaluate((n: Element) => (n as HTMLElement).click());
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

        await page.waitForFunction(
            async (eventWait: number) => await new Promise<boolean>((resolve) => setTimeout(() => {
                resolve(true);
            }, eventWait)),
            { timeout: this.config.navigationTimeout },
            this.config.eventWait,
        );

        // An action can navigate, and the URL it lands on may be one no request
        // interceptor reported — a same-document route change, for instance. The
        // crawler owns the discovered-URL set, so recording goes back through it.
        this.recordUrl(page.url());
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
        // Every prune — whether initiated by the crawl loop or by a replay
        // failure inside performAction — funnels through here, so this is the one
        // place the crawl-graph recorder needs to see them (SCAN-197).
        this.onPrune?.(crawlAction);
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
