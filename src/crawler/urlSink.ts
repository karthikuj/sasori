import { WriteStream, createWriteStream } from 'fs';
import path from 'path';
import chalk from 'chalk';

/**
 * Appends discovered URLs to the crawl's output file.
 *
 * Written to from inside the `page.on('request')` handler, which is the most
 * latency-sensitive place in the crawler: every intercepted request, across
 * every browser instance, waits behind it. The original used `appendFileSync`
 * plus a `path.resolve` of the same string on every call, so each newly
 * discovered URL stalled the event loop on disk I/O (SCAN-88).
 *
 * A write stream fixes both halves: the path is resolved once when the stream
 * opens, and `write` hands off to libuv instead of blocking. Ordering still
 * holds, because a stream serialises its own queued writes.
 */
export class UrlSink {
    private stream: WriteStream | null = null;

    /**
     * @param outputFile - Destination path, or undefined to discard writes.
     */
    constructor(private readonly outputFile: string | undefined) { }

    /**
     * Whether this sink will actually write anywhere.
     * @return True when an output file is configured.
     */
    isEnabled(): boolean {
        return Boolean(this.outputFile);
    }

    /**
     * Queues a URL for writing. Returns immediately.
     * @param url - URL to append.
     */
    write(url: string): void {
        if (!this.outputFile) {
            return;
        }
        if (!this.stream) {
            // 'a' rather than 'w': the CLI truncates the file up front so a run
            // starts clean, and opening for append here keeps that single
            // truncation authoritative instead of racing it.
            this.stream = createWriteStream(path.resolve(this.outputFile), { flags: 'a' });
            this.stream.on('error', (err: Error) => {
                console.error(chalk.red(`[ERROR] Could not write to output file: ${err.message}`));
            });
        }
        this.stream.write(url + '\n');
    }

    /**
     * Flushes and closes the stream.
     *
     * A buffered stream that is never closed can lose its tail when the process
     * exits, which would silently truncate the URL list a crawl exists to
     * produce — so this is awaited in the crawl's `finally`, alongside the
     * inventory write.
     *
     * @return Promise resolving once the stream is closed.
     */
    async close(): Promise<void> {
        const stream = this.stream;
        if (!stream) {
            return;
        }
        this.stream = null;
        await new Promise<void>((resolve) => {
            stream.end(() => resolve());
        });
    }
}

export default UrlSink;
