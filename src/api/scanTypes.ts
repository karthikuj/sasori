/**
 * Public API types for HTTP scan management (no implementation details).
 */

export type ScanStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Serializable scan state returned by GET /api/v1/scans/:id.
 */
export interface ScanRecord {
    scanId: string;
    status: ScanStatus;
    /** True while the crawl task is in progress (including before the browser launches). */
    running: boolean;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
}
