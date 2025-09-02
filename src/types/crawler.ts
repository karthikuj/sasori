import { Page } from 'puppeteer';
import { CrawlInput, CrawlAction } from './input';
import { BrowserConfig } from './browser';
import { AuthenticationConfig } from './auth';

/**
 * Represents the state of the DOM after an action (vertex in crawl graph)
 */
export interface CrawlState {
    stateId: string;
    url: string;
    stateHash: string;
    crawlDepth: number;
    crawlInputs: CrawlInput[];
    crawlActions: CrawlAction[];
}

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
    getCrawlInputs(page: Page, currentState: any): Promise<CrawlInput[]>;
    getCrawlActions(page: Page, currentState: any): Promise<CrawlAction[]>;
}

/**
 * Crawler state manager interface
 */
export interface CrawlStateManagerInterface {
    states: Map<string, any>; // Will be CrawlState when imported
    addState(state: any): void; // Will be CrawlState when imported
    getState(stateId: string): any | undefined; // Will be CrawlState when imported
    hasState(stateId: string): boolean;
    getAllStates(): any[]; // Will be CrawlState[] when imported
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


