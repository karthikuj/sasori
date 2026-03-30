import { Page } from 'puppeteer';
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
    stripDOM($: any): void;
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


