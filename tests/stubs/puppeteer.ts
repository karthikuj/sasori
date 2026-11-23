/**
 * Jest stand-in for `puppeteer`.
 *
 * Puppeteer 25 ships only as ES modules. Node 22.12+ can `require()` them, which
 * is how the built CommonJS app loads it, but Jest's own module loader cannot,
 * so jest.config.js maps `puppeteer` here. Unit tests never launch a browser
 * (see CLAUDE.md): suites that need `launch` mock it with `jest.mock('puppeteer')`,
 * which mocks this module, and anything that reaches the real thing fails loudly.
 */
function notInTests(name: string): never {
    throw new Error(`puppeteer.${name}() is not available in unit tests; mock it with jest.mock('puppeteer').`);
}

export function launch(..._args: unknown[]): never {
    return notInTests('launch');
}

export function connect(..._args: unknown[]): never {
    return notInTests('connect');
}

export default { launch, connect };
