import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CompletionOutbox } from '../../src/api/completionOutbox';

/** Fresh temp dir per test so nothing leaks between cases or into the repo. */
async function tempDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'sasori-outbox-'));
}

function okResponse(): Response {
    return { ok: true, status: 200 } as Response;
}

function errorResponse(status: number): Response {
    return { ok: false, status } as Response;
}

const payload = { backend_scan_id: 42, status: 'completed' };

describe('CompletionOutbox', () => {
    it('delivers on the first attempt and leaves nothing pending', async () => {
        const dir = await tempDir();
        const fetchImpl = jest.fn().mockResolvedValue(okResponse());
        const outbox = new CompletionOutbox({ dir, fetchImpl: fetchImpl as unknown as typeof fetch });

        await outbox.enqueue({ url: 'http://backend/cb', payload });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(await outbox.pendingCount()).toBe(0);
    });

    it('sends the callback secret when configured', async () => {
        const dir = await tempDir();
        const fetchImpl = jest.fn().mockResolvedValue(okResponse());
        const outbox = new CompletionOutbox({ dir, fetchImpl: fetchImpl as unknown as typeof fetch });

        await outbox.enqueue({ url: 'http://backend/cb', secret: 'shh', payload });

        const init = fetchImpl.mock.calls[0]![1] as RequestInit;
        expect((init.headers as Record<string, string>)['X-Sasori-Callback-Secret']).toBe('shh');
    });

    // The S1 regression: a backend that is down when the crawl finishes used to
    // lose the completion event entirely.
    it('persists the event when delivery fails', async () => {
        const dir = await tempDir();
        const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const outbox = new CompletionOutbox({ dir, fetchImpl: fetchImpl as unknown as typeof fetch });

        await outbox.enqueue({ url: 'http://backend/cb', payload });

        expect(await outbox.pendingCount()).toBe(1);
        const [event] = await outbox.listPending();
        expect(event!.attempts).toBe(1);
        expect(event!.lastError).toContain('ECONNREFUSED');
    });

    it('retries a persisted event and clears it once the backend recovers', async () => {
        const dir = await tempDir();
        const fetchImpl = jest
            .fn()
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValue(okResponse());
        const outbox = new CompletionOutbox({
            dir,
            fetchImpl: fetchImpl as unknown as typeof fetch,
            baseBackoffMs: 0,
        });

        await outbox.enqueue({ url: 'http://backend/cb', payload });
        expect(await outbox.pendingCount()).toBe(1);

        await outbox.drainOnce();

        expect(await outbox.pendingCount()).toBe(0);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    // The property that makes this a *durable* outbox rather than a retry loop:
    // a completely separate instance, as after a process restart, still finds
    // and delivers the event.
    it('recovers events left behind by a previous process', async () => {
        const dir = await tempDir();

        const failing = new CompletionOutbox({
            dir,
            fetchImpl: jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch,
        });
        await failing.enqueue({ url: 'http://backend/cb', payload });
        expect(await failing.pendingCount()).toBe(1);

        // Simulate a restart: new instance, same directory.
        const recoveredFetch = jest.fn().mockResolvedValue(okResponse());
        const restarted = new CompletionOutbox({
            dir,
            fetchImpl: recoveredFetch as unknown as typeof fetch,
            baseBackoffMs: 0,
        });

        expect(await restarted.pendingCount()).toBe(1);
        await restarted.drainOnce();

        expect(await restarted.pendingCount()).toBe(0);
        expect(recoveredFetch).toHaveBeenCalledTimes(1);
    });

    it('dead-letters after exhausting attempts instead of deleting the event', async () => {
        const dir = await tempDir();
        const outbox = new CompletionOutbox({
            dir,
            fetchImpl: jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch,
            maxAttempts: 3,
            baseBackoffMs: 0,
        });

        await outbox.enqueue({ url: 'http://backend/cb', payload });
        await outbox.drainOnce();
        await outbox.drainOnce();

        expect(await outbox.pendingCount()).toBe(0);
        expect(await outbox.deadLetterCount()).toBe(1);

        // The event body must survive for replay, not just a marker.
        const files = await fs.readdir(path.join(dir, 'dead-letter'));
        const raw = await fs.readFile(path.join(dir, 'dead-letter', files[0]!), 'utf8');
        expect(JSON.parse(raw).payload.backend_scan_id).toBe(42);
    });

    // Retrying a 401 or a wrong URL for half an hour just buries the reason.
    it('dead-letters a permanent 4xx immediately', async () => {
        const dir = await tempDir();
        const fetchImpl = jest.fn().mockResolvedValue(errorResponse(401));
        const outbox = new CompletionOutbox({
            dir,
            fetchImpl: fetchImpl as unknown as typeof fetch,
            baseBackoffMs: 0,
        });

        await outbox.enqueue({ url: 'http://backend/cb', payload });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(await outbox.pendingCount()).toBe(0);
        expect(await outbox.deadLetterCount()).toBe(1);
    });

    it('keeps retrying a 5xx and a 429', async () => {
        for (const status of [500, 503, 429]) {
            const dir = await tempDir();
            const outbox = new CompletionOutbox({
                dir,
                fetchImpl: jest.fn().mockResolvedValue(errorResponse(status)) as unknown as typeof fetch,
                baseBackoffMs: 0,
            });

            await outbox.enqueue({ url: 'http://backend/cb', payload });

            expect(await outbox.pendingCount()).toBe(1);
            expect(await outbox.deadLetterCount()).toBe(0);
        }
    });

    it('respects backoff before retrying', async () => {
        const dir = await tempDir();
        let clock = 1_000_000;
        const fetchImpl = jest.fn().mockRejectedValue(new Error('down'));
        const outbox = new CompletionOutbox({
            dir,
            fetchImpl: fetchImpl as unknown as typeof fetch,
            baseBackoffMs: 10_000,
            now: () => clock,
        });

        await outbox.enqueue({ url: 'http://backend/cb', payload });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        // Too soon — must not retry yet.
        await outbox.drainOnce();
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        clock += 20_000;
        await outbox.drainOnce();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('ignores a corrupt event file rather than stalling the queue', async () => {
        const dir = await tempDir();
        const fetchImpl = jest.fn().mockResolvedValue(okResponse());
        const outbox = new CompletionOutbox({
            dir,
            fetchImpl: fetchImpl as unknown as typeof fetch,
            baseBackoffMs: 0,
        });

        await fs.mkdir(path.join(dir, 'pending'), { recursive: true });
        await fs.writeFile(path.join(dir, 'pending', 'garbage.json'), '{not json', 'utf8');

        const failing = new CompletionOutbox({
            dir,
            fetchImpl: jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch,
        });
        await failing.enqueue({ url: 'http://backend/cb', payload });

        // The good event still gets delivered despite the corrupt neighbour.
        await outbox.drainOnce();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
