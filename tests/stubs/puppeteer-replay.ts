/**
 * Jest stand-in for `@puppeteer/replay`, which is ES modules only from v4 on —
 * see tests/stubs/puppeteer.ts for why Jest needs it. It has the value exports
 * Sasori uses, so `jest.mock('@puppeteer/replay')` mocks them like the real ones.
 */
export class PuppeteerRunnerExtension {
    constructor(
        public browser: unknown,
        public page: unknown,
        public opts?: unknown,
    ) { }

    async beforeAllSteps(_flow?: unknown): Promise<void> { }

    async beforeEachStep(_step?: unknown, _flow?: unknown): Promise<void> { }

    async runStep(_step?: unknown, _flow?: unknown): Promise<void> { }

    async afterEachStep(_step?: unknown, _flow?: unknown): Promise<void> { }

    async afterAllSteps(_flow?: unknown): Promise<void> { }
}

export async function createRunner(..._args: unknown[]): Promise<never> {
    throw new Error('@puppeteer/replay.createRunner() is not available in unit tests; mock it with jest.mock(\'@puppeteer/replay\').');
}
