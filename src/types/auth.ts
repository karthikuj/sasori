import { Page } from 'puppeteer';
import { CrawlerConfig } from './crawler';

/**
 * Authentication configuration interface
 */
export interface AuthenticationConfig {
    basicAuth: BasicAuthInterface;
    recorderAuth: RecorderAuthInterface;
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
