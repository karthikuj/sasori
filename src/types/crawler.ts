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


