/**
 * Seed discovery from robots.txt and sitemaps (SCAN-229).
 *
 * The parsers are pure and the collector takes an injected fetcher, so the whole
 * path — robots grouping, rule precedence, sitemap-index recursion, every cap,
 * scope and robots filtering — is exercised here against strings and a map.
 */

import {
    compileRobotsRules,
    discoverSeeds,
    normalizeSeedUrl,
    parseRobotsTxt,
    parseSitemapXml,
    robotsAllows,
    SeedDiscoveryOptions,
    SeedFetcher,
} from '../../src/crawler/seedDiscovery';

const ORIGIN = 'https://shop.test';

/** A fetcher backed by a map; anything absent is a 404 (null). Records calls. */
function mapFetcher(files: Record<string, string>): SeedFetcher & { calls: string[] } {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
        calls.push(url);
        return Object.prototype.hasOwnProperty.call(files, url) ? files[url]! : null;
    }) as SeedFetcher & { calls: string[] };
    fetcher.calls = calls;
    return fetcher;
}

function urlset(...locs: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `  <url><loc>${l}</loc><lastmod>2026-01-01</lastmod></url>`).join('\n')}
</urlset>`;
}

function sitemapIndex(...locs: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `  <sitemap><loc>${l}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
}

function options(overrides: Partial<SeedDiscoveryOptions> = {}): SeedDiscoveryOptions {
    return {
        maxSeedUrls: 100,
        maxSitemapDepth: 3,
        maxSitemapUrls: 5000,
        respectRobots: true,
        inScope: (url) => url.startsWith(`${ORIGIN}/`),
        ...overrides,
    };
}

describe('parseRobotsTxt', () => {
    it('collects Sitemap lines regardless of group, in file order', () => {
        const robots = parseRobotsTxt([
            'Sitemap: https://shop.test/a.xml',
            'User-agent: *',
            'Disallow: /cart',
            'sitemap: https://shop.test/b.xml',
        ].join('\n'));
        expect(robots.sitemaps).toEqual(['https://shop.test/a.xml', 'https://shop.test/b.xml']);
    });

    it('uses the * group when no group names our token', () => {
        const robots = parseRobotsTxt([
            'User-agent: Googlebot',
            'Disallow: /google-only',
            '',
            'User-agent: *',
            'Disallow: /cart',
            'Allow: /cart/public',
        ].join('\n'));
        expect(robots.disallow).toEqual(['/cart']);
        expect(robots.allow).toEqual(['/cart/public']);
    });

    it('prefers a group naming our token over *, case-insensitively', () => {
        const robots = parseRobotsTxt([
            'User-agent: *',
            'Disallow: /',
            '',
            'User-agent: SASORI',
            'Disallow: /private',
        ].join('\n'));
        expect(robots.disallow).toEqual(['/private']);
    });

    it('treats consecutive User-agent lines as one group', () => {
        const robots = parseRobotsTxt([
            'User-agent: bingbot',
            'User-agent: sasori',
            'Disallow: /shared',
        ].join('\n'));
        expect(robots.disallow).toEqual(['/shared']);
    });

    it('merges every group that applies', () => {
        const robots = parseRobotsTxt([
            'User-agent: *',
            'Disallow: /a',
            'User-agent: other',
            'Disallow: /b',
            'User-agent: *',
            'Disallow: /c',
        ].join('\n'));
        expect(robots.disallow).toEqual(['/a', '/c']);
    });

    it('ignores comments, blank lines, junk, CRLF and an empty Disallow', () => {
        const robots = parseRobotsTxt(
            '# a comment\r\n\r\nnot a directive\r\nUser-agent: * # inline\r\nDisallow:\r\nDisallow: /x # why\r\n',
        );
        expect(robots.disallow).toEqual(['/x']);
        expect(robots.allow).toEqual([]);
    });

    it('drops rules that appear before any User-agent', () => {
        const robots = parseRobotsTxt('Disallow: /orphan\nUser-agent: *\nDisallow: /real');
        expect(robots.disallow).toEqual(['/real']);
    });

    it('returns empty results for an empty file', () => {
        expect(parseRobotsTxt('')).toEqual({ sitemaps: [], allow: [], disallow: [] });
    });
});

describe('robotsAllows', () => {
    it('allows everything when there are no rules', () => {
        expect(robotsAllows([], '/anything')).toBe(true);
    });

    it('treats a rule as a path prefix', () => {
        const rules = compileRobotsRules([], ['/cart']);
        expect(robotsAllows(rules, '/cart')).toBe(false);
        expect(robotsAllows(rules, '/cart/checkout')).toBe(false);
        expect(robotsAllows(rules, '/cartoons')).toBe(false); // prefix, per the RFC
        expect(robotsAllows(rules, '/shop/cart')).toBe(true);
    });

    it('lets the longest matching rule win', () => {
        const rules = compileRobotsRules(['/cart/public'], ['/cart']);
        expect(robotsAllows(rules, '/cart/secret')).toBe(false);
        expect(robotsAllows(rules, '/cart/public/item')).toBe(true);
    });

    it('lets Allow win a tie', () => {
        const rules = compileRobotsRules(['/page'], ['/page']);
        expect(robotsAllows(rules, '/page')).toBe(true);
        // Whatever order the rules arrive in: the tie is decided by kind.
        expect(robotsAllows([...rules].reverse(), '/page')).toBe(true);
    });

    it('keeps an Allow-everything-under-a-Disallow-all site crawlable where allowed', () => {
        const rules = compileRobotsRules(['/public'], ['/']);
        expect(robotsAllows(rules, '/public/docs')).toBe(true);
        expect(robotsAllows(rules, '/admin')).toBe(false);
    });

    it('supports * wildcards and a $ end anchor', () => {
        const rules = compileRobotsRules([], ['/*?sort=', '/*.pdf$']);
        expect(robotsAllows(rules, '/products?sort=price')).toBe(false);
        expect(robotsAllows(rules, '/products?page=2')).toBe(true);
        expect(robotsAllows(rules, '/files/a.pdf')).toBe(false);
        expect(robotsAllows(rules, '/files/a.pdf?download=1')).toBe(true);
    });

    it('treats regex metacharacters in a rule literally', () => {
        const rules = compileRobotsRules([], ['/a.b(c)']);
        expect(robotsAllows(rules, '/a.b(c)/x')).toBe(false);
        expect(robotsAllows(rules, '/aXb(c)/x')).toBe(true);
    });
});

describe('parseSitemapXml', () => {
    it('reads page URLs from a urlset, trimming whitespace', () => {
        const contents = parseSitemapXml(urlset('https://shop.test/a', '  https://shop.test/b  '));
        expect(contents).toEqual({ childSitemaps: [], urls: ['https://shop.test/a', 'https://shop.test/b'] });
    });

    it('reads child sitemaps from a sitemap index', () => {
        const contents = parseSitemapXml(sitemapIndex('https://shop.test/s1.xml', 'https://shop.test/s2.xml'));
        expect(contents).toEqual({ childSitemaps: ['https://shop.test/s1.xml', 'https://shop.test/s2.xml'], urls: [] });
    });

    it('decodes XML entities in a loc', () => {
        const contents = parseSitemapXml(urlset('https://shop.test/search?q=a&amp;page=2'));
        expect(contents.urls).toEqual(['https://shop.test/search?q=a&page=2']);
    });

    it('does not mistake an image sitemap loc for a page', () => {
        const xml = `<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://shop.test/p</loc><image:image><image:loc>https://cdn.test/p.jpg</image:loc></image:image></url>
</urlset>`;
        expect(parseSitemapXml(xml).urls).toEqual(['https://shop.test/p']);
    });

    it('recovers what it can from malformed or truncated XML', () => {
        const truncated = '<urlset><url><loc>https://shop.test/ok</loc></url><url><loc>https://shop.test/cut';
        expect(parseSitemapXml(truncated).urls).toEqual(['https://shop.test/ok', 'https://shop.test/cut']);
        expect(parseSitemapXml('<urlset><<<>>><url><loc></loc></url>')).toEqual({ childSitemaps: [], urls: [] });
    });

    it('yields nothing for an HTML soft-404 page', () => {
        expect(parseSitemapXml('<html><body><h1>Not found</h1><a href="/x">x</a></body></html>'))
            .toEqual({ childSitemaps: [], urls: [] });
    });

    it('reads the plain-text sitemap form, one URL per line', () => {
        const contents = parseSitemapXml('https://shop.test/a\r\n\r\nnot-a-url\nhttps://shop.test/b\n');
        expect(contents.urls).toEqual(['https://shop.test/a', 'https://shop.test/b']);
    });

    it('keeps a cross-origin loc; scope filtering is the collector\'s job', () => {
        expect(parseSitemapXml(urlset('https://other.test/x')).urls).toEqual(['https://other.test/x']);
    });
});

describe('normalizeSeedUrl', () => {
    it('drops the fragment and keeps the query', () => {
        expect(normalizeSeedUrl('https://shop.test/a?x=1#top')).toBe('https://shop.test/a?x=1');
    });

    it('resolves relative URLs against a base', () => {
        expect(normalizeSeedUrl('/b', 'https://shop.test/sitemaps/x.xml')).toBe('https://shop.test/b');
    });

    it('rejects non-http schemes and garbage', () => {
        expect(normalizeSeedUrl('mailto:a@b.test')).toBeNull();
        expect(normalizeSeedUrl('javascript:alert(1)')).toBeNull();
        expect(normalizeSeedUrl('not a url')).toBeNull();
    });
});

describe('discoverSeeds', () => {
    it('falls back to /sitemap.xml when robots.txt is missing', async () => {
        const fetcher = mapFetcher({ [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/b`, `${ORIGIN}/a`) });
        const result = await discoverSeeds(fetcher, ORIGIN, options());

        expect(result.robots).toBeNull();
        expect(result.seeds).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
        expect(fetcher.calls).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/sitemap.xml`]);
    });

    it('reads robots-declared sitemaps and the default, once each', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/robots.txt`]: `Sitemap: ${ORIGIN}/products.xml\nSitemap: ${ORIGIN}/sitemap.xml`,
            [`${ORIGIN}/products.xml`]: urlset(`${ORIGIN}/p/1`),
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/about`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options());

        expect(result.seeds).toEqual([`${ORIGIN}/about`, `${ORIGIN}/p/1`]);
        expect(result.sitemapsRead).toEqual([`${ORIGIN}/products.xml`, `${ORIGIN}/sitemap.xml`]);
        expect(fetcher.calls.filter((u) => u === `${ORIGIN}/sitemap.xml`)).toHaveLength(1);
    });

    it('recurses into a sitemap index', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: sitemapIndex(`${ORIGIN}/s1.xml`, '/s2.xml'),
            [`${ORIGIN}/s1.xml`]: urlset(`${ORIGIN}/one`),
            [`${ORIGIN}/s2.xml`]: urlset(`${ORIGIN}/two`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options());

        expect(result.seeds).toEqual([`${ORIGIN}/one`, `${ORIGIN}/two`]);
        expect(result.truncated).toBe(false);
    });

    it('stops at maxSitemapDepth and reports truncation', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: sitemapIndex(`${ORIGIN}/level1.xml`),
            [`${ORIGIN}/level1.xml`]: sitemapIndex(`${ORIGIN}/level2.xml`),
            [`${ORIGIN}/level2.xml`]: urlset(`${ORIGIN}/deep`),
        });
        const shallow = await discoverSeeds(fetcher, ORIGIN, options({ maxSitemapDepth: 1 }));
        expect(shallow.seeds).toEqual([]);
        expect(shallow.sitemapsRead).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/level1.xml`]);
        expect(shallow.truncated).toBe(true);

        const deep = await discoverSeeds(fetcher, ORIGIN, options({ maxSitemapDepth: 2 }));
        expect(deep.seeds).toEqual([`${ORIGIN}/deep`]);
    });

    it('does not loop on a sitemap index that lists itself', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: sitemapIndex(`${ORIGIN}/sitemap.xml`, `${ORIGIN}/a.xml`),
            [`${ORIGIN}/a.xml`]: sitemapIndex(`${ORIGIN}/sitemap.xml`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options({ maxSitemapDepth: 5 }));
        expect(result.sitemapsRead).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/a.xml`]);
    });

    it('caps the number of sitemap files fetched', async () => {
        const children = Array.from({ length: 10 }, (_, i) => `${ORIGIN}/s${i}.xml`);
        const files: Record<string, string> = { [`${ORIGIN}/sitemap.xml`]: sitemapIndex(...children) };
        for (const [i, child] of children.entries()) {
            files[child] = urlset(`${ORIGIN}/page${i}`);
        }
        const result = await discoverSeeds(mapFetcher(files), ORIGIN, options({ maxSitemapFiles: 3 }));

        expect(result.sitemapsRead).toHaveLength(3);
        expect(result.seeds).toEqual([`${ORIGIN}/page0`, `${ORIGIN}/page1`]);
        expect(result.truncated).toBe(true);
    });

    it('caps the URLs read across sitemaps at maxSitemapUrls', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: urlset(...Array.from({ length: 50 }, (_, i) => `${ORIGIN}/p${i}`)),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options({ maxSitemapUrls: 5 }));

        expect(result.seeds).toHaveLength(5);
        expect(result.truncated).toBe(true);
    });

    it('caps seeds at maxSeedUrls after a deterministic sort', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/c`, `${ORIGIN}/a`, `${ORIGIN}/d`, `${ORIGIN}/b`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options({ maxSeedUrls: 2 }));

        expect(result.seeds).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
        expect(result.truncated).toBe(true);
    });

    it('dedupes URLs that differ only by fragment, or repeat across sitemaps', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/robots.txt`]: `Sitemap: ${ORIGIN}/x.xml`,
            [`${ORIGIN}/x.xml`]: urlset(`${ORIGIN}/a#one`, `${ORIGIN}/a`),
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/a#two`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options());
        expect(result.seeds).toEqual([`${ORIGIN}/a`]);
    });

    it('filters seeds through scope', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/in`, `${ORIGIN}/logout`, 'https://other.test/x'),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options({
            inScope: (url) => url.startsWith(`${ORIGIN}/`) && !url.includes('logout'),
        }));
        expect(result.seeds).toEqual([`${ORIGIN}/in`]);
    });

    it('never fetches a cross-origin Sitemap line outside scope', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/robots.txt`]: 'Sitemap: https://evil.test/sitemap.xml',
            'https://evil.test/sitemap.xml': urlset(`${ORIGIN}/planted`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options());

        expect(fetcher.calls).not.toContain('https://evil.test/sitemap.xml');
        expect(result.seeds).toEqual([]);
    });

    it('fetches a cross-origin sitemap that the operator put in scope', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/robots.txt`]: 'Sitemap: https://cdn.shop.test/sitemap.xml',
            'https://cdn.shop.test/sitemap.xml': urlset(`${ORIGIN}/from-cdn`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options({
            inScope: (url) => /^https:\/\/(cdn\.)?shop\.test\//.test(url),
        }));
        expect(result.seeds).toEqual([`${ORIGIN}/from-cdn`]);
    });

    it('drops robots-disallowed seeds when respectRobots is on', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/robots.txt`]: 'User-agent: *\nDisallow: /cart\nAllow: /cart/gift',
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/cart/1`, `${ORIGIN}/cart/gift`, `${ORIGIN}/home`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options());

        expect(result.seeds).toEqual([`${ORIGIN}/cart/gift`, `${ORIGIN}/home`]);
        expect(result.robotsRules.map((r) => r.path).sort()).toEqual(['/cart', '/cart/gift']);
    });

    it('keeps disallowed seeds and returns no rules when respectRobots is off', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/robots.txt`]: 'User-agent: *\nDisallow: /cart',
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/cart/1`),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options({ respectRobots: false }));

        expect(result.seeds).toEqual([`${ORIGIN}/cart/1`]);
        expect(result.robotsRules).toEqual([]);
        expect(result.robots?.disallow).toEqual(['/cart']);
    });

    it('does not apply the origin\'s robots rules to another in-scope origin', async () => {
        const fetcher = mapFetcher({
            [`${ORIGIN}/robots.txt`]: 'User-agent: *\nDisallow: /',
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/x`, 'https://api.shop.test/x'),
        });
        const result = await discoverSeeds(fetcher, ORIGIN, options({
            inScope: (url) => /^https:\/\/(api\.)?shop\.test\//.test(url),
        }));
        expect(result.seeds).toEqual(['https://api.shop.test/x']);
    });

    it('survives a fetcher that throws, and a site with nothing at all', async () => {
        const throwing: SeedFetcher = async () => {
            throw new Error('net::ERR_CONNECTION_RESET');
        };
        const result = await discoverSeeds(throwing, ORIGIN, options());
        expect(result).toEqual({ seeds: [], robots: null, robotsRules: [], sitemapsRead: [], truncated: false });
    });

    it('accepts an origin given with a path', async () => {
        const fetcher = mapFetcher({ [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/a`) });
        const result = await discoverSeeds(fetcher, `${ORIGIN}/deep/entry?x=1`, options());
        expect(fetcher.calls[0]).toBe(`${ORIGIN}/robots.txt`);
        expect(result.seeds).toEqual([`${ORIGIN}/a`]);
    });

    it('is deterministic regardless of sitemap order', async () => {
        const a = await discoverSeeds(mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/z`, `${ORIGIN}/m`, `${ORIGIN}/a`),
        }), ORIGIN, options());
        const b = await discoverSeeds(mapFetcher({
            [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/a`, `${ORIGIN}/z`, `${ORIGIN}/m`),
        }), ORIGIN, options());
        expect(a.seeds).toEqual(b.seeds);
    });
});
