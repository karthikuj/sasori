import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

/** A completion callback awaiting delivery to the backend. */
export interface OutboxEvent {
    id: string;
    url: string;
    secret?: string;
    payload: Record<string, unknown>;
    attempts: number;
    createdAt: number;
    lastError?: string;
}

export interface CompletionOutboxOptions {
    /** Root directory for `pending/` and `dead-letter/`. */
    dir: string;
    /** Attempts before an event is dead-lettered. Default 12 (~34 min of backoff). */
    maxAttempts?: number;
    /** First retry delay in ms; doubles up to maxBackoffMs. Default 1000. */
    baseBackoffMs?: number;
    /** Ceiling for the backoff. Default 300000 (5 min). */
    maxBackoffMs?: number;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
    now?: () => number;
}

const PENDING_DIR = 'pending';
const DEAD_LETTER_DIR = 'dead-letter';

/**
 * Durable outbox for crawl-completion callbacks.
 *
 * The completion event is the one message Sasori sends that the backend cannot
 * reconstruct on its own: without it `crawl_status` never reaches `Completed`,
 * the scan is never finalised, and the unique-active-per-web-asset index then
 * blocks every future scan of that web asset. Losing it costs far more than the
 * crawl that produced it.
 *
 * Previously delivery was 4 in-memory retries and then silence. Here the event
 * is written to disk *before* the first attempt, so it survives a process
 * restart, a backend outage longer than the retry window, and a crash between
 * crawl completion and delivery. Events that exhaust their attempts are moved to
 * `dead-letter/` rather than deleted, so they can be inspected and replayed.
 *
 * Deliberately file-backed rather than a database: Sasori has no datastore, and
 * introducing one to hold at most a handful of pending events would be a much
 * larger change. The shared broker at Phase 2 supersedes this.
 */
export class CompletionOutbox {
    private readonly dir: string;
    private readonly maxAttempts: number;
    private readonly baseBackoffMs: number;
    private readonly maxBackoffMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    private timer?: NodeJS.Timeout;
    private draining = false;

    constructor(options: CompletionOutboxOptions) {
        this.dir = options.dir;
        this.maxAttempts = options.maxAttempts ?? 12;
        this.baseBackoffMs = options.baseBackoffMs ?? 1000;
        this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? (() => Date.now());
    }

    private get pendingDir(): string {
        return path.join(this.dir, PENDING_DIR);
    }

    private get deadLetterDir(): string {
        return path.join(this.dir, DEAD_LETTER_DIR);
    }

    /**
     * Persists the event, then attempts delivery immediately.
     *
     * Persisting first is the whole point: if the process dies between here and
     * a successful POST, the event is still on disk and will be retried after
     * restart.
     */
    async enqueue(input: {
        url: string;
        secret?: string;
        payload: Record<string, unknown>;
    }): Promise<string> {
        await fs.mkdir(this.pendingDir, { recursive: true });

        const event: OutboxEvent = {
            id: randomUUID(),
            url: input.url,
            ...(input.secret ? { secret: input.secret } : {}),
            payload: input.payload,
            attempts: 0,
            createdAt: this.now(),
        };

        await this.write(event);
        await this.tryDeliver(event);
        return event.id;
    }

    /**
     * Starts the background retry loop. Safe to call more than once.
     *
     * `unref()` keeps the timer from holding the process open — a pending
     * callback should not prevent a clean shutdown, it will be retried on the
     * next start.
     */
    start(intervalMs = 30_000): void {
        if (this.timer) {
            return;
        }
        this.timer = setInterval(() => {
            void this.drainOnce();
        }, intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            delete this.timer;
        }
    }

    /**
     * Attempts every pending event whose backoff has elapsed. Exposed so tests
     * and shutdown hooks can drain without waiting for the timer.
     */
    async drainOnce(): Promise<void> {
        if (this.draining) {
            return;
        }
        this.draining = true;
        try {
            for (const event of await this.listPending()) {
                if (this.now() < this.nextAttemptAt(event)) {
                    continue;
                }
                await this.tryDeliver(event);
            }
        } finally {
            this.draining = false;
        }
    }

    /** Number of events still awaiting delivery. */
    async pendingCount(): Promise<number> {
        return (await this.listPending()).length;
    }

    /** Events that exhausted their attempts and need manual attention. */
    async deadLetterCount(): Promise<number> {
        return (await this.readDir(this.deadLetterDir)).length;
    }

    /** Loads persisted events, including any left behind by a previous process. */
    async listPending(): Promise<OutboxEvent[]> {
        const files = await this.readDir(this.pendingDir);
        const events: OutboxEvent[] = [];

        for (const file of files) {
            try {
                const raw = await fs.readFile(path.join(this.pendingDir, file), 'utf8');
                events.push(JSON.parse(raw) as OutboxEvent);
            } catch {
                // A truncated or corrupt file must not stall every other event.
                // Leave it in place for inspection rather than deleting evidence.
            }
        }
        return events.sort((a, b) => a.createdAt - b.createdAt);
    }

    private async tryDeliver(event: OutboxEvent): Promise<void> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (event.secret) {
            headers['X-Sasori-Callback-Secret'] = event.secret;
        }

        let delivered = false;
        let failure: string | undefined;

        try {
            const response = await this.fetchImpl(event.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(event.payload),
            });
            if (response.ok) {
                delivered = true;
            } else {
                failure = `HTTP ${response.status}`;
                // A 4xx other than 429 will never succeed — a wrong callback URL
                // or a rejected secret. Dead-letter it now rather than retrying
                // for half an hour and burying the reason.
                if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                    await this.deadLetter({ ...event, attempts: event.attempts + 1, lastError: failure });
                    return;
                }
            }
        } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
        }

        if (delivered) {
            await this.remove(event.id);
            return;
        }

        const attempted: OutboxEvent = {
            ...event,
            attempts: event.attempts + 1,
            ...(failure ? { lastError: failure } : {}),
        };

        if (attempted.attempts >= this.maxAttempts) {
            await this.deadLetter(attempted);
            return;
        }
        await this.write(attempted);
    }

    private nextAttemptAt(event: OutboxEvent): number {
        if (event.attempts === 0) {
            return 0;
        }
        const backoff = Math.min(
            this.baseBackoffMs * 2 ** (event.attempts - 1),
            this.maxBackoffMs,
        );
        return event.createdAt + backoff;
    }

    private async write(event: OutboxEvent): Promise<void> {
        await fs.mkdir(this.pendingDir, { recursive: true });
        const target = path.join(this.pendingDir, `${event.id}.json`);
        // Write-then-rename so a crash mid-write cannot leave a half-parsed
        // event that the loader would have to discard.
        const tmp = `${target}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(event, null, 2), 'utf8');
        await fs.rename(tmp, target);
    }

    private async remove(id: string): Promise<void> {
        await fs.rm(path.join(this.pendingDir, `${id}.json`), { force: true });
    }

    private async deadLetter(event: OutboxEvent): Promise<void> {
        await fs.mkdir(this.deadLetterDir, { recursive: true });
        await fs.writeFile(
            path.join(this.deadLetterDir, `${event.id}.json`),
            JSON.stringify(event, null, 2),
            'utf8',
        );
        await this.remove(event.id);

        // eslint-disable-next-line no-console
        console.error(
            '[sasori outbox] DEAD-LETTER: completion callback for backend_scan_id=' +
                `${String(event.payload.backend_scan_id)} failed ${event.attempts} times ` +
                `(${event.lastError ?? 'unknown'}). The backend will not finalize this scan ` +
                `until the event is replayed from ${this.deadLetterDir}.`,
        );
    }

    private async readDir(dir: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(dir);
            return entries.filter((f) => f.endsWith('.json'));
        } catch {
            return [];
        }
    }
}
