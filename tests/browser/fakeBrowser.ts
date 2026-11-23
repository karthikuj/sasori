/**
 * A fake Chrome for browser-session and crawler tests: enough of Puppeteer's
 * Browser, Target and Page to open windows, emit `targetcreated` and
 * `disconnected`, and record what was closed. No real browser is launched.
 */

import { EventEmitter } from 'events';

let nextTargetId = 1;

export class FakePage extends EventEmitter {
    closed = false;
    currentUrl = 'about:blank';
    readonly targetId = `T${nextTargetId++}`;
    readonly evaluate = jest.fn(async (..._args: unknown[]): Promise<unknown> => []);
    readonly goto = jest.fn(async (url: string) => {
        this.currentUrl = url;
        return { ok: () => true, text: async () => '' };
    });
    readonly waitForFunction = jest.fn(async () => undefined);
    readonly waitForNetworkIdle = jest.fn(async () => undefined);
    readonly setDefaultTimeout = jest.fn();
    readonly setDefaultNavigationTimeout = jest.fn();
    readonly setViewport = jest.fn(async () => undefined);
    readonly setRequestInterception = jest.fn(async () => undefined);
    readonly authenticate = jest.fn(async () => undefined);
    readonly content = jest.fn(async () => '<html></html>');
    /** Every CDP command sent through this page, with its params. */
    readonly cdpCalls: Array<{ method: string; params: unknown }> = [];
    readonly createCDPSession = jest.fn(async () => ({
        send: async (method: string, params?: unknown) => {
            this.cdpCalls.push({ method, params });
            return {};
        },
        detach: async () => undefined,
    }));

    constructor(private readonly owner: FakeBrowser | null = null) {
        super();
    }

    url(): string {
        return this.currentUrl;
    }

    isClosed(): boolean {
        return this.closed;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.owner?.forget(this);
    }

    override off(event: string | symbol, listener: Parameters<EventEmitter['off']>[1]): this {
        return this.removeListener(event, listener);
    }
}

export class FakeTarget {
    readonly _targetId: string;

    constructor(readonly fakePage: FakePage, private readonly kind: string = 'page') {
        this._targetId = fakePage.targetId;
    }

    type(): string {
        return this.kind;
    }

    async page(): Promise<FakePage | null> {
        return this.kind === 'page' ? this.fakePage : null;
    }
}

export class FakeBrowser extends EventEmitter {
    connected = true;
    closeCalls = 0;
    windowsOpened = 0;
    readonly openPages: FakePage[] = [];
    /** Every page this browser ever had, closed ones included. */
    readonly created: FakePage[] = [];
    private readonly targets: FakeTarget[] = [];

    constructor() {
        super();
        this.addPage(new FakePage(this));
    }

    private addPage(page: FakePage): FakeTarget {
        const target = new FakeTarget(page);
        this.openPages.push(page);
        this.created.push(page);
        this.targets.push(target);
        return target;
    }

    forget(page: FakePage): void {
        const i = this.openPages.indexOf(page);
        if (i >= 0) {
            this.openPages.splice(i, 1);
        }
        // Like Chrome with a visible window: closing the last one quits it.
        if (this.openPages.length === 0 && this.connected) {
            this.crash();
        }
    }

    async pages(): Promise<FakePage[]> {
        return [...this.openPages];
    }

    async newPage(): Promise<FakePage> {
        const page = new FakePage(this);
        this.emit('targetcreated', this.addPage(page));
        return page;
    }

    /** The crawled app opening a pop-up. */
    openPopup(): FakePage {
        const page = new FakePage(this);
        this.emit('targetcreated', this.addPage(page));
        return page;
    }

    target(): { createCDPSession: () => Promise<{ send: (method: string, params: unknown) => Promise<unknown>; detach: () => Promise<void> }> } {
        return {
            createCDPSession: async () => ({
                send: async (method: string, params: unknown) => {
                    if (method !== 'Target.createTarget') {
                        throw new Error(`unexpected CDP method ${method}`);
                    }
                    const p = params as { newWindow?: boolean };
                    if (!p.newWindow) {
                        throw new Error('expected a new window, not a tab');
                    }
                    this.windowsOpened++;
                    const target = this.addPage(new FakePage(this));
                    // Chrome reports the target before createTarget answers.
                    this.emit('targetcreated', target);
                    return { targetId: target._targetId };
                },
                detach: async () => undefined,
            }),
        };
    }

    async waitForTarget(predicate: (t: FakeTarget) => boolean): Promise<FakeTarget> {
        const found = this.targets.find(predicate);
        if (!found) {
            throw new Error('target not found');
        }
        return found;
    }

    async close(): Promise<void> {
        this.closeCalls++;
        this.connected = false;
        for (const page of [...this.openPages]) {
            page.closed = true;
        }
        this.openPages.length = 0;
        this.emit('disconnected');
    }

    /** Chrome dying on its own. */
    crash(): void {
        this.connected = false;
        for (const page of [...this.openPages]) {
            page.closed = true;
        }
        this.openPages.length = 0;
        this.emit('disconnected');
    }
}

/** Lets pending promise callbacks and event handlers run. */
export const flush = async (times = 3): Promise<void> => {
    for (let i = 0; i < times; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};
