import * as cheerio from 'cheerio';

/**
 * Seed discovery from robots.txt and sitemap.xml (SCAN-229).
 *
 * A crawl that starts from one entry point reaches only what that page links
 * to, and large parts of a site are listed in its sitemap and linked from
 * nowhere a crawler starts. This module turns a site's robots.txt and
 * sitemaps into extra seed URLs.
 *
 * Everything here is pure except {@link discoverSeeds}, and that only talks to
 * the network through an injected {@link SeedFetcher}. The crawler supplies one
 * backed by a browser page, so the fetches reuse the proxy, MITM TLS trust and
 * session cookies the crawl already has; tests supply a map. Nothing in this
 * file needs a browser to be tested.
 */

/** Fetches a URL's body as text, or null when it is missing or unusable. */
export type SeedFetcher = (url: string) => Promise<string | null>;

/** What robots.txt says, before any of it is applied. */
export interface RobotsTxt {
    /** `Sitemap:` URLs, in file order. These apply to every user agent. */
    sitemaps: string[];
    /** `Allow:` paths from the group that applies to us. */
    allow: string[];
    /** `Disallow:` paths from the group that applies to us; empty values dropped. */
    disallow: string[];
}

/** One compiled robots.txt path rule. */
export interface RobotsRule {
    allow: boolean;
    /** The rule as written; its length decides precedence. */
    path: string;
    pattern: RegExp;
}

/** What a sitemap file lists. */
export interface SitemapContents {
    /** `<sitemapindex>` children — further sitemaps to read. */
    childSitemaps: string[];
    /** `<urlset>` page URLs. */
    urls: string[];
}

export interface SeedDiscoveryOptions {
    /** Most seed URLs to return, after filtering. */
    maxSeedUrls: number;
    /** How many levels of sitemap index to follow; 0 reads only the top-level sitemaps. */
    maxSitemapDepth: number;
    /** Most `<loc>` page URLs to read across all sitemaps before stopping. */
    maxSitemapUrls: number;
    /** Most sitemap files to fetch. An index may list tens of thousands. */
    maxSitemapFiles?: number;
    /** Whether robots.txt Allow/Disallow rules filter the seeds. */
    respectRobots: boolean;
    /** The crawl's scope predicate. Sitemaps and seeds outside it are never used. */
    inScope: (url: string) => boolean;
    /** robots.txt product token whose group applies; falls back to `*`. */
    userAgent?: string;
}

export interface SeedDiscoveryResult {
    /** Normalised, deduplicated, in-scope, allowed seed URLs, sorted, capped. */
    seeds: string[];
    /** Parsed robots.txt, or null when there was none. */
    robots: RobotsTxt | null;
    /** Compiled rules to enforce; empty unless `respectRobots` and robots had rules. */
    robotsRules: RobotsRule[];
    /** Sitemap files that were fetched and parsed, in fetch order. */
    sitemapsRead: string[];
    /** True when a cap stopped discovery before it ran out of input. */
    truncated: boolean;
}

/** Default ceiling on sitemap files fetched in one discovery pass. */
export const DEFAULT_MAX_SITEMAP_FILES = 50;

/**
 * Ceiling on one robots.txt or sitemap body. The protocol caps a sitemap at
 * 50 MB uncompressed; a body past this is refused, not truncated, because a
 * cut-off `<loc>` still parses as a valid but wrong URL.
 */
export const MAX_SEED_BODY_BYTES = 10 * 1024 * 1024;

/** robots.txt product token Sasori answers to. */
export const DEFAULT_ROBOTS_USER_AGENT = 'sasori';

/**
 * Parses robots.txt per RFC 9309.
 *
 * Consecutive `User-agent` lines open one group, and the group's rules follow
 * them. The groups naming our product token apply; if none does, the `*`
 * groups do. Several matching groups are merged, as the RFC requires.
 * `Sitemap:` lines are not part of any group and are always collected.
 *
 * @param text - robots.txt body.
 * @param userAgent - Product token to select a group for.
 * @return Sitemaps plus the applicable allow and disallow paths.
 */
export function parseRobotsTxt(text: string, userAgent: string = DEFAULT_ROBOTS_USER_AGENT): RobotsTxt {
    interface Group { agents: string[]; allow: string[]; disallow: string[] }
    const groups: Group[] = [];
    const sitemaps: string[] = [];
    let current: Group | null = null;
    let lastWasAgent = false;

    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        const colon = line.indexOf(':');
        if (colon <= 0) {
            continue;
        }
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();

        if (key === 'user-agent') {
            if (!current || !lastWasAgent) {
                current = { agents: [], allow: [], disallow: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;

        if (key === 'sitemap') {
            if (value) {
                sitemaps.push(value);
            }
        } else if (key === 'allow' && current) {
            if (value) {
                current.allow.push(value);
            }
        } else if (key === 'disallow' && current) {
            // An empty Disallow means "nothing is disallowed".
            if (value) {
                current.disallow.push(value);
            }
        }
    }

    const token = userAgent.toLowerCase();
    let applicable = groups.filter((g) => g.agents.includes(token));
    if (applicable.length === 0) {
        applicable = groups.filter((g) => g.agents.includes('*'));
    }

    return {
        sitemaps,
        allow: applicable.flatMap((g) => g.allow),
        disallow: applicable.flatMap((g) => g.disallow),
    };
}

/**
 * Compiles robots.txt paths into matchers. `*` matches any run of characters
 * and a trailing `$` anchors the end, per RFC 9309; everything else is literal
 * and the match is a prefix match.
 * @param allow - Allow paths.
 * @param disallow - Disallow paths.
 * @return Compiled rules.
 */
export function compileRobotsRules(allow: string[], disallow: string[]): RobotsRule[] {
    const compile = (path: string, isAllow: boolean): RobotsRule => {
        const anchored = path.endsWith('$');
        const body = anchored ? path.slice(0, -1) : path;
        const source = body
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*');
        return { allow: isAllow, path, pattern: new RegExp(`^${source}${anchored ? '$' : ''}`) };
    };
    return [
        ...allow.filter((p) => p.length > 0).map((p) => compile(p, true)),
        ...disallow.filter((p) => p.length > 0).map((p) => compile(p, false)),
    ];
}

/**
 * Whether robots.txt rules allow a path. The most specific (longest) matching
 * rule wins and an allow wins a tie, per RFC 9309; no matching rule allows.
 * @param rules - Compiled rules for the URL's origin.
 * @param pathAndQuery - The URL's path plus query string.
 * @return True when the path may be crawled.
 */
export function robotsAllows(rules: RobotsRule[], pathAndQuery: string): boolean {
    let best: RobotsRule | null = null;
    for (const rule of rules) {
        if (!rule.pattern.test(pathAndQuery)) {
            continue;
        }
        if (
            !best ||
            rule.path.length > best.path.length ||
            (rule.path.length === best.path.length && rule.allow && !best.allow)
        ) {
            best = rule;
        }
    }
    return best ? best.allow : true;
}

/**
 * Parses a sitemap or sitemap index.
 *
 * Uses cheerio's lenient XML mode (already a dependency, via the DOM stripper),
 * so a truncated or malformed file yields whatever `<loc>` entries it does
 * contain instead of throwing. A body with no markup at all is read as the
 * protocol's plain-text form, one URL per line.
 *
 * @param text - Sitemap body.
 * @return Child sitemaps and page URLs, in document order, whitespace trimmed.
 */
export function parseSitemapXml(text: string): SitemapContents {
    if (!text.includes('<')) {
        const urls = text
            .split(/\r\n|\r|\n/)
            .map((l) => l.trim())
            .filter((l) => /^https?:\/\//i.test(l));
        return { childSitemaps: [], urls };
    }
    try {
        const $ = cheerio.load(text, { xmlMode: true });
        const locs = (selector: string): string[] =>
            $(selector)
                .map((_i, el) => $(el).text().trim())
                .get()
                .filter((loc: string) => loc.length > 0);
        return { childSitemaps: locs('sitemap > loc'), urls: locs('url > loc') };
    } catch {
        return { childSitemaps: [], urls: [] };
    }
}

/**
 * Normalises a candidate seed: resolves it against `base`, keeps only http(s),
 * and drops the fragment (the server never sees it, so two URLs that differ
 * only there are one page).
 * @param raw - URL as found.
 * @param base - Base to resolve a relative URL against.
 * @return The normalised URL, or null when it is unusable.
 */
export function normalizeSeedUrl(raw: string, base?: string): string | null {
    let url: URL;
    try {
        url = base === undefined ? new URL(raw.trim()) : new URL(raw.trim(), base);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    url.hash = '';
    return url.href;
}

/**
 * Discovers seed URLs for an origin from its robots.txt and sitemaps.
 *
 * Reads `/robots.txt`, then every sitemap it names plus the conventional
 * `/sitemap.xml`, following sitemap indexes breadth-first up to
 * `maxSitemapDepth`. Only in-scope sitemaps are fetched, so a cross-origin
 * `Sitemap:` line is ignored unless the operator put that host in scope.
 *
 * Every cap is mandatory: a news or shop sitemap lists millions of URLs, and
 * seeds are crawled, so an uncapped sitemap is an uncapped crawl. Output is
 * sorted so two runs against the same site seed in the same order and the
 * crawl artifacts stay comparable.
 *
 * A fetch that fails or returns nothing is skipped; discovery never throws on
 * account of the site.
 *
 * @param fetcher - Fetches a body; null for missing or unusable.
 * @param origin - Origin to discover for (e.g. `https://example.com`).
 * @param options - Caps, scope and robots handling.
 * @return The seeds and what was learned on the way.
 */
export async function discoverSeeds(
    fetcher: SeedFetcher,
    origin: string,
    options: SeedDiscoveryOptions,
): Promise<SeedDiscoveryResult> {
    const base = new URL(origin).origin;
    const maxFiles = options.maxSitemapFiles ?? DEFAULT_MAX_SITEMAP_FILES;
    const safeFetch = async (url: string): Promise<string | null> => {
        try {
            return await fetcher(url);
        } catch {
            return null;
        }
    };

    const robotsText = await safeFetch(`${base}/robots.txt`);
    const robots = robotsText === null ? null : parseRobotsTxt(robotsText, options.userAgent);
    const robotsRules = options.respectRobots && robots
        ? compileRobotsRules(robots.allow, robots.disallow)
        : [];

    const queue: Array<{ url: string; depth: number }> = [];
    const queued = new Set<string>();
    const enqueue = (raw: string, depth: number, relativeTo: string): void => {
        const url = normalizeSeedUrl(raw, relativeTo);
        if (!url || queued.has(url) || !options.inScope(url)) {
            return;
        }
        queued.add(url);
        queue.push({ url, depth });
    };
    for (const sitemap of robots?.sitemaps ?? []) {
        enqueue(sitemap, 0, base);
    }
    enqueue('/sitemap.xml', 0, base);

    const sitemapsRead: string[] = [];
    const found: string[] = [];
    let truncated = false;

    for (let i = 0; i < queue.length; i++) {
        if (sitemapsRead.length >= maxFiles || found.length >= options.maxSitemapUrls) {
            truncated = true;
            break;
        }
        const { url, depth } = queue[i]!;
        const body = await safeFetch(url);
        if (body === null) {
            continue;
        }
        sitemapsRead.push(url);
        const contents = parseSitemapXml(body);
        if (depth < options.maxSitemapDepth) {
            for (const child of contents.childSitemaps) {
                enqueue(child, depth + 1, url);
            }
        } else if (contents.childSitemaps.length > 0) {
            truncated = true;
        }
        for (const loc of contents.urls) {
            if (found.length >= options.maxSitemapUrls) {
                truncated = true;
                break;
            }
            found.push(loc);
        }
    }

    const unique = new Set<string>();
    for (const loc of found) {
        const url = normalizeSeedUrl(loc, base);
        if (!url || !options.inScope(url)) {
            continue;
        }
        if (robotsRules.length > 0 && new URL(url).origin === base) {
            const parsed = new URL(url);
            if (!robotsAllows(robotsRules, parsed.pathname + parsed.search)) {
                continue;
            }
        }
        unique.add(url);
    }

    const sorted = [...unique].sort();
    if (sorted.length > options.maxSeedUrls) {
        truncated = true;
    }

    return {
        seeds: sorted.slice(0, options.maxSeedUrls),
        robots,
        robotsRules,
        sitemapsRead,
        truncated,
    };
}
