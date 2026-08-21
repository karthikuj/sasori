/**
 * Unit tests for {@link ScopeMatcher}, extracted from `Crawler` in SCAN-90.
 *
 * Scope is the crawler's containment boundary: everything it decides "in" gets
 * requested against a real target. It used to be reachable only by constructing
 * a whole `Crawler`, so the auth-time widening — the one part with genuinely
 * surprising behaviour — had no direct coverage at all.
 */

import ScopeMatcher from '../../src/crawler/scopeMatcher';

describe('ScopeMatcher', () => {
    it('admits included URLs and rejects unlisted ones', () => {
        const scope = new ScopeMatcher(['https://example\\.com.*'], []);

        expect(scope.matches('https://example.com/page')).toBe(true);
        expect(scope.matches('https://elsewhere.com/page')).toBe(false);
    });

    it('applies excludes before includes', () => {
        const scope = new ScopeMatcher(['https://example\\.com.*'], ['.*/logout.*']);

        expect(scope.matches('https://example.com/account')).toBe(true);
        expect(scope.matches('https://example.com/logout')).toBe(false);
    });

    it('rejects everything when the include list is empty', () => {
        // Fail closed. An empty include list is not "allow all" — a crawler that
        // defaulted open would happily walk off the target and onto the internet.
        const scope = new ScopeMatcher([], []);
        expect(scope.matches('https://example.com/')).toBe(false);
    });

    describe('widenToHost', () => {
        it('brings the URL host into scope', () => {
            const includes = ['https://example\\.com.*'];
            const scope = new ScopeMatcher(includes, []);

            expect(scope.matches('https://sso.example.org/authorize')).toBe(false);
            scope.widenToHost('https://sso.example.org/authorize?client=1');
            expect(scope.matches('https://sso.example.org/authorize')).toBe(true);
        });

        it('widens over http and https for that host', () => {
            const scope = new ScopeMatcher([], []);
            scope.widenToHost('https://idp.test/login');

            expect(scope.matches('https://idp.test/login')).toBe(true);
            expect(scope.matches('http://idp.test/login')).toBe(true);
        });

        it('keeps the port, so a different port stays out of scope', () => {
            const scope = new ScopeMatcher([], []);
            scope.widenToHost('https://idp.test:8443/login');

            expect(scope.matches('https://idp.test:8443/login')).toBe(true);
            expect(scope.matches('https://idp.test/login')).toBe(false);
        });

        it('does not duplicate a pattern it has already added', () => {
            const includes: string[] = [];
            const scope = new ScopeMatcher(includes, []);

            scope.widenToHost('https://idp.test/a');
            scope.widenToHost('https://idp.test/b');

            expect(includes).toHaveLength(1);
        });

        it('mutates the callers array, because the crawler config is the source of truth', () => {
            // The interceptor widens scope on the live config object so the
            // change is visible to anything else reading it, and so it persists
            // for the rest of the crawl rather than only inside this matcher.
            const includes: string[] = [];
            const scope = new ScopeMatcher(includes, []);

            scope.widenToHost('https://idp.test/login');

            expect(includes).toEqual(['https?://idp.test(?:/.*|)']);
        });
    });

    it('sees patterns appended to the arrays after construction', () => {
        const includes = ['https://example\\.com.*'];
        const excludes: string[] = [];
        const scope = new ScopeMatcher(includes, excludes);

        includes.push('https://other\\.com.*');
        expect(scope.matches('https://other.com/x')).toBe(true);

        excludes.push('https://other\\.com/admin.*');
        expect(scope.matches('https://other.com/admin')).toBe(false);
    });

    it('compiles each pattern once no matter how many URLs it is asked about', () => {
        const scope = new ScopeMatcher(['https://example\\.com.*'], ['.*/logout.*']);

        const RealRegExp = global.RegExp;
        let constructed = 0;
        const spy = jest
            .spyOn(global, 'RegExp')
            .mockImplementation(function (this: unknown, ...args: unknown[]) {
                constructed++;
                return new (RealRegExp as any)(...args);
            } as any);

        for (let i = 0; i < 1000; i++) {
            scope.matches(`https://example.com/page/${i}`);
        }

        spy.mockRestore();
        expect(constructed).toBe(2);
    });
});
