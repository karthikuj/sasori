import { Page } from 'puppeteer';
import { CrawlerConfig } from './crawler';

/**
 * Authentication configuration interface
 */
export interface AuthenticationConfig {
    basicAuth: BasicAuthInterface;
    recorderAuth: RecorderAuthInterface;
    /** Checks the crawl is still logged in, and logs in again if not (SCAN-236). */
    sessionCheck?: SessionCheckConfig;
    /**
     * Log in again on this schedule, in milliseconds, whether or not the session
     * looks expired. The browser is restarted on a fresh profile, because a login
     * recording run in a window that is already logged in can break. 0 or absent
     * turns it off. Needs recorder auth.
     */
    reloginIntervalMs?: number;
}

/**
 * Session check settings (SCAN-236). Only used with recorder auth.
 */
export interface SessionCheckConfig {
    /** Defaults to true whenever recorder auth is on. */
    enabled?: boolean;
    /** Time between checks, in milliseconds. Defaults to 120000 (2 minutes). */
    intervalMs?: number;
    /**
     * A `GET` URL that only works while logged in, used when no check request
     * is found automatically (a server-rendered app that makes no API calls).
     */
    url?: string;
    /**
     * A regular expression (JavaScript syntax, case-sensitive) that the
     * response of `url` matches only while logged in, such as the user's name
     * on a profile page. When it stops matching, the crawl is logged out. For
     * pages that answer 200 either way and differ only in their text. Needs
     * `url`.
     */
    loggedInRegex?: string;
}

/**
 * Authentication handler interface
 */
export interface AuthenticatorInterface {
    authenticate(page: Page, config: CrawlerConfig): Promise<void>;
}

/**
 * Basic authentication interface
 */
export interface BasicAuthInterface {
    enabled: boolean;
    username?: string;
    password?: string;
}

/**
 * Recorder-based authentication interface
 */
export interface RecorderAuthInterface {
    enabled: boolean;
    pptrRecording?: string;
}

/**
 * Authentication result interface
 */
export interface AuthResult {
    success: boolean;
    error?: string;
    method: 'basic' | 'recorder' | 'none';
}

/**
 * Authentication context interface
 */
export interface AuthContext {
    page: Page;
    config: CrawlerConfig;
    retryCount: number;
    maxRetries: number;
}
