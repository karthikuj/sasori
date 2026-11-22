import { Page } from 'puppeteer';

// `cheerio.CheerioAPI` below resolves through the ambient global namespace that
// the repo's legacy `@types/cheerio@0.22` declares, so no import is needed here —
// and adding one is an error, because it would be unused.
import { CrawlInput, CrawlAction, CrawlState } from './input';
import { BrowserConfig } from './browser';
import { AuthenticationConfig } from './auth';

/**
 * Represents the state of the DOM after an action (vertex in crawl graph)
 * This interface is now defined in input.ts to avoid circular dependencies
 */

/**
 * Main Crawler class interface
 */
export interface CrawlerInterface {
    config: CrawlerConfig;
    crawlerConfig: CrawlerSettings;
    authInProgress: boolean;
    allUrls: Set<string>;
    allInteractables: string[];
    endTime: Date | null;
    browserStartDelays: number;

    startCrawling(): Promise<void>;
    stripDOM($: cheerio.CheerioAPI): void;
    getCrawlInputs(page: Page, currentState: CrawlState): Promise<CrawlInput[]>;
    getCrawlActions(page: Page, currentState: CrawlState): Promise<CrawlAction[]>;
}

/**
 * Crawler state manager interface
 */
export interface CrawlStateManagerInterface {
    states: Map<string, CrawlState>;
    addState(state: CrawlState): void;
    getState(stateId: string): CrawlState | undefined;
    hasState(stateId: string): boolean;
    getAllStates(): CrawlState[];
}

/**
 * Crawler configuration interface
 */
export interface CrawlerConfig {
    browser: BrowserConfig;
    crawler: CrawlerSettings;
    logging?: LoggingConfig;
}

/**
 * File-logging configuration (SCAN-181). When `file` is set, console output is
 * teed to a size-rotated log file (via rotating-file-stream) so a crawl's logs
 * survive rather than only scrolling past on stdout. All fields are optional with
 * sane defaults.
 */
export interface LoggingConfig {
    file?: string;        // log file path (empty/omitted = stdout only)
    console?: boolean;    // also keep writing to stdout (default true)
    maxSizeMB?: number;   // rotate when the file exceeds this size (default 100)
    maxBackups?: number;  // keep at most this many rotated files (default 20)
    maxAgeDays?: number;  // keep rotated files this long (default 30)
    compress?: boolean;   // gzip rotated files (default true)
}



/**
 * Main crawler settings interface
 */
export interface CrawlerSettings {
    entryPoint: string;
    eventTimeout: number;
    navigationTimeout: number;
    eventWait: number;
    debugNetwork?: boolean;
    maxActionRetries?: number;
    maxDuration: number;
    elements: string[];
    maxChildren: number;
    maxDepth: number;
    authentication: AuthenticationConfig;
    includeRegexes: string[];
    excludeRegexes: string[];
    outputFile?: string;

    /**
     * Path to write the crawl inventory (endpoints and DOM states reached) to,
     * as JSON, when the crawl finishes. Measured coverage is what separates a
     * crawler regression from a scanner one, so it is written even for a crawl
     * that was stopped part-way.
     */
    inventoryFile?: string;

    /**
     * Path to write the crawl graph (states + action/edge execution status) to,
     * as JSON, when the crawl finishes. Unlike the inventory (states only), this
     * records the edges and each action's status, so a coverage failure can be
     * diagnosed after the fact. Mermaid (`.mmd`) and Graphviz (`.dot`) siblings
     * are written next to it for visualisation. Written even for a crawl that was
     * stopped part-way, and opt-in like `inventoryFile` (SCAN-197).
     */
    crawlGraphFile?: string;
    /**
     * Record the crawl graph in memory even when no `crawlGraphFile` is set.
     *
     * The recorder used to be switched on by the file path alone, which meant a
     * scan driven through the API — the only way Nara runs Sasori — recorded
     * nothing at all, and the artifact that diagnoses a coverage gap was
     * available exactly where nobody was looking (a hand-run CLI crawl). Serving
     * it from memory keeps the server writing no files.
     */
    recordCrawlGraph?: boolean;
    /**
     * Ceiling on recorded edges. The recorder holds one small object per action,
     * which is nothing at a few thousand and is not nothing on a crawl that runs
     * for hours — and this process serves every scan, so it may not trade its own
     * liveness for a diagnostic. Past the cap no *new* edge is added and the
     * graph is marked truncated; edges already recorded still receive their
     * outcomes, so what the artifact does contain stays true. 0 means no cap.
     */
    maxCrawlGraphEdges?: number;
}

/**
 * Basic authentication configuration
 */
export interface BasicAuthConfig {
    enabled: boolean;
    username?: string;
    password?: string;
}

/**
 * Recorder-based authentication configuration
 */
export interface RecorderAuthConfig {
    enabled: boolean;
    pptrRecording?: string;
}


