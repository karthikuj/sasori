// ============================================================================
// MAIN TYPE EXPORTS
// ============================================================================

// Re-export all types from individual modules
export * from './crawler';
export * from './browser';
export * from './dom';
export * from './input';
export * from './auth';

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Error types for better error handling
 */
export interface CrawlerError extends Error {
    code?: string;
    context?: Record<string, unknown>;
}

/**
 * Result type for operations that can fail
 */
export type Result<T, E = CrawlerError> =
    | { success: true; data: T }
    | { success: false; error: E };

/**
 * Generic configuration validation result
 */
export interface ValidationResult<T> {
    error?: string;
    value?: T;
}
