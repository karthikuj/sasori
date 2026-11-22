import { createStream, RotatingFileStream } from 'rotating-file-stream';
import { inspect } from 'util';
import path from 'path';
import fs from 'fs';
import { LoggingConfig } from '../types';

/**
 * File logging with rotation (SCAN-181).
 *
 * Sasori logs through `console.*` (often chalk-colored). Rather than refactor
 * every call site, `setupLogging` tees console output to a size-rotated log file
 * (via rotating-file-stream) so a crawl's logs survive to disk instead of only
 * scrolling past on stdout. Color codes are stripped from the file copy.
 */

// Matches ANSI SGR escapes (chalk colors). The ESC control char is inherent to
// what we're stripping, so the control-char lint is intentionally disabled here.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

const DEFAULT_MAX_SIZE_MB = 100;
const DEFAULT_MAX_BACKUPS = 20;

let stream: RotatingFileStream | null = null;

/**
 * Configures file logging from the optional `logging` config block. A missing or
 * fileless config leaves the previous stdout-only behaviour untouched.
 * Idempotent: calling it again while already set up is a no-op.
 */
export function setupLogging(cfg?: LoggingConfig): void {
    if (stream) {
        return;
    }
    const file = cfg?.file?.trim();
    if (!file) {
        return; // stdout only
    }

    const dir = path.dirname(file);
    if (dir && dir !== '.') {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            // fall through — createStream will surface any real problem
        }
    }

    const maxSizeMB = cfg?.maxSizeMB && cfg.maxSizeMB > 0 ? cfg.maxSizeMB : DEFAULT_MAX_SIZE_MB;
    const maxBackups = cfg?.maxBackups && cfg.maxBackups > 0 ? cfg.maxBackups : DEFAULT_MAX_BACKUPS;
    const compress = cfg?.compress !== false; // default true
    const alsoConsole = cfg?.console !== false; // default true

    try {
        stream = createStream(path.basename(file), {
            path: dir || '.',
            size: `${maxSizeMB}M`,
            maxFiles: maxBackups,
            compress: compress ? 'gzip' : false,
        });
    } catch (err) {
        // Keep console logging if the file sink can't be created.
        // eslint-disable-next-line no-console
        console.error(`[logging] could not open log file ${file}: ${String(err)}`);
        return;
    }

    const levels: Array<['log' | 'info' | 'warn' | 'error' | 'debug', string]> = [
        ['log', 'INFO'],
        ['info', 'INFO'],
        ['warn', 'WARN'],
        ['error', 'ERROR'],
        ['debug', 'DEBUG'],
    ];

    for (const [method, level] of levels) {
        const original = console[method].bind(console);
        console[method] = (...args: unknown[]): void => {
            if (alsoConsole) {
                original(...args);
            }
            try {
                const line = args
                    .map((a) => (typeof a === 'string' ? a : inspect(a)))
                    .join(' ')
                    .replace(ANSI, '');
                stream?.write(`${new Date().toISOString()} ${level} ${line}\n`);
            } catch {
                // Logging must never throw.
            }
        };
    }
}
