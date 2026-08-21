/**
 * Decides whether a URL is inside the crawl's scope.
 *
 * Scope lives on the request-interception path, so this runs for every single
 * HTTP transaction every browser instance makes — it is one of the few pieces of
 * the crawler where a constant factor is worth caring about.
 *
 * It holds *references* to the caller's pattern arrays rather than copies. That
 * is deliberate and load-bearing: while authentication is in progress the
 * interceptor widens the include list with whatever host the login flow reaches,
 * because an SSO redirect legitimately changes the scope of a crawl mid-flight.
 * A snapshot taken at construction would silently ignore that.
 */
export class ScopeMatcher {
    /**
     * Compiled patterns, memoized by source string.
     *
     * Compiling inside the loop meant re-parsing the same handful of regexes
     * tens of thousands of times per crawl (SCAN-87). Keying the cache on the
     * pattern source rather than on array position is what lets the arrays stay
     * mutable without the cache ever going stale against them.
     */
    private readonly compiled = new Map<string, RegExp>();

    /**
     * @param includeRegexes - Live array of in-scope patterns.
     * @param excludeRegexes - Live array of out-of-scope patterns.
     */
    constructor(
        private readonly includeRegexes: string[],
        private readonly excludeRegexes: string[],
    ) { }

    /**
     * Whether the URL is in scope. Excludes are applied before includes.
     * @param url - URL to test.
     * @return True when the crawl may visit the URL.
     */
    matches(url: string): boolean {
        for (const pattern of this.excludeRegexes) {
            if (this.compile(pattern).test(url)) {
                return false;
            }
        }

        for (const pattern of this.includeRegexes) {
            if (this.compile(pattern).test(url)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Widens the include list to cover the URL's host, if it is not already.
     *
     * Called only while authentication is running: a login flow that redirects
     * to an identity provider is on a host the operator never listed, and
     * refusing it would break the crawl before it started.
     *
     * @param url - URL whose host should be brought into scope.
     */
    widenToHost(url: string): void {
        const authority = new URL(url).host;
        const pattern = `https?://${authority}(?:/.*|)`;
        if (!this.includeRegexes.includes(pattern)) {
            this.includeRegexes.push(pattern);
        }
    }

    /**
     * Returns the compiled form of a pattern, compiling it at most once.
     *
     * `test` rather than `String.prototype.match` at the call sites: the result
     * is only ever used as a boolean, and `match` allocates a result array on
     * every hit. None of these patterns carry the `g` flag — they are compiled
     * without flags — so `test` is stateless here and safe to reuse.
     *
     * @param pattern - Regular expression source from the crawler config.
     * @return The compiled expression.
     */
    private compile(pattern: string): RegExp {
        let compiled = this.compiled.get(pattern);
        if (!compiled) {
            compiled = new RegExp(pattern);
            this.compiled.set(pattern, compiled);
        }
        return compiled;
    }
}

export default ScopeMatcher;
