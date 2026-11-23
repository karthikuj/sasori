/**
 * Lets the crawl stop every worker of a browser between actions, and start
 * them again (SCAN-236).
 *
 * A worker calls {@link enter} before each action and {@link leave} after it.
 * {@link pause} stops new actions from starting and resolves once every action
 * already running has finished, so whoever paused knows no worker is touching
 * the browser. It waits for the workers to say so, never for a fixed delay.
 *
 * Re-login uses it to restart the browser underneath the workers. Pausing a
 * crawl on request (SCAN-231) is the same operation.
 */
export class PauseGate {
    private paused = false;
    private cancelled = false;
    private busy = 0;
    private resumeWaiters: Array<() => void> = [];
    private drainWaiters: Array<() => void> = [];

    /**
     * Waits while the gate is paused, then counts the caller as busy.
     * @return False when the gate was cancelled: the worker should stop.
     */
    async enter(): Promise<boolean> {
        while (this.paused && !this.cancelled) {
            await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
        }
        if (this.cancelled) {
            return false;
        }
        this.busy++;
        return true;
    }

    /** Marks the caller's action as finished. Call once per successful {@link enter}. */
    leave(): void {
        if (this.busy > 0) {
            this.busy--;
        }
        if (this.busy === 0) {
            this.flush('drain');
        }
    }

    /**
     * Stops new actions from starting.
     * @return Resolves once no action is running.
     */
    async pause(): Promise<void> {
        this.paused = true;
        if (this.busy === 0 || this.cancelled) {
            return;
        }
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }

    /** Lets waiting workers continue. */
    resume(): void {
        this.paused = false;
        this.flush('resume');
    }

    /**
     * Releases everyone for good: waiting workers get false from {@link enter},
     * and a pending {@link pause} resolves. Used when the crawl ends.
     */
    cancel(): void {
        this.cancelled = true;
        this.flush('resume');
        this.flush('drain');
    }

    isPaused(): boolean {
        return this.paused;
    }

    /** Number of actions running now. */
    busyCount(): number {
        return this.busy;
    }

    private flush(which: 'resume' | 'drain'): void {
        const waiters = which === 'resume' ? this.resumeWaiters : this.drainWaiters;
        if (which === 'resume') {
            this.resumeWaiters = [];
        } else {
            this.drainWaiters = [];
        }
        for (const resolve of waiters) {
            resolve();
        }
    }
}

export default PauseGate;
