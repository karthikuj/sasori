/**
 * Golden-output tests for `DomStripper`.
 *
 * `stripDOM` feeds `stateHash`, which is the crawler's entire notion of state
 * identity: two DOM states are "the same place" iff their stripped HTML hashes
 * match. A change in `stripDOM`'s output is therefore not a cosmetic diff — it
 * silently repartitions the crawl graph, so a page that used to collapse onto an
 * existing state becomes a new one (or vice versa) and coverage moves for
 * reasons nobody can see in a code review.
 *
 * These tests pin the output byte-for-byte over a corpus of real pages, tricky
 * hand-written cases, and generated deep/flat DOMs. They exist so `stripDOM` can
 * be *optimised* — which is the point of SCAN-85 — without its behaviour being
 * changed by accident along the way.
 *
 * Regenerate deliberately, never reflexively:
 *
 *     UPDATE_STRIPDOM_GOLDEN=1 npx jest tests/crawler/stripDom.golden.test.ts
 *
 * and read the resulting diff as a report on how crawl coverage will move.
 */

import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

import CrawlInput from '../../src/crawler/crawlInput';
import DomStripper from '../../src/crawler/domStripper';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'stripdom');
const GOLDEN_FILE = path.join(FIXTURE_DIR, 'golden.json');

/**
 * Two selector profiles, because `crawler.elements` is user configuration and
 * the two shapes exercise different branches: `default` is the shipped
 * `config/config.json` set and includes the `[click]` pseudo-selector, which is
 * a real attribute selector as far as `stripDOM` is concerned; `links-only`
 * strips the page down much harder and catches over-eager pruning.
 */
const SELECTOR_PROFILES: Record<string, string[]> = {
    'default': ['a', 'button', 'input[type="submit"]', '[click]'],
    'links-only': ['a'],
};

/**
 * Builds a stripper for the given configured elements.
 *
 * The crawler always appends the input-field selectors to whatever
 * `crawler.elements` holds, so the same is done here — testing the stripper
 * against a selector set the product never actually uses would pin the wrong
 * behaviour.
 * @param elements Value for `crawler.elements`.
 * @return A stripper with the production selector set.
 */
function crawlerWithElements(elements: string[]): DomStripper {
    return new DomStripper([
        ...elements,
        ...CrawlInput.INPUT_FIELDS.map((field) => field.CSS_PATH),
    ]);
}

/**
 * Runs the production stripping path: parse exactly as `getPageHash` does,
 * strip, serialise.
 * @param stripper Stripper supplying the interactable selectors.
 * @param html Raw fixture HTML.
 * @return The stripped HTML that would be hashed into a `stateHash`.
 */
function strip(stripper: DomStripper, html: string): string {
    const $ = cheerio.load(html, { xmlMode: true }) as cheerio.CheerioAPI;
    stripper.strip($);
    return $.html();
}

const fixtures = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.html'))
    .sort();

describe('DomStripper golden output', () => {
    it('has a non-empty fixture corpus', () => {
        expect(fixtures.length).toBeGreaterThan(10);
    });

    const produced: Record<string, string> = {};
    const recording = process.env.UPDATE_STRIPDOM_GOLDEN === '1';
    // Read once, not per case. Keys are looked up with `Object.keys(...)` and
    // direct indexing rather than `toHaveProperty`, which treats the `.html` in
    // a key as a nested property path and silently matches nothing.
    const golden: Record<string, string> = recording
        ? {}
        : (JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf-8')) as Record<string, string>);

    for (const profileName of Object.keys(SELECTOR_PROFILES).sort()) {
        const elements = SELECTOR_PROFILES[profileName]!;

        describe(`profile: ${profileName}`, () => {
            const crawler = crawlerWithElements(elements);

            for (const fixture of fixtures) {
                const key = `${profileName}::${fixture}`;

                it(`matches golden output for ${fixture}`, () => {
                    const html = fs.readFileSync(path.join(FIXTURE_DIR, fixture), 'utf-8');
                    const output = strip(crawler, html);
                    produced[key] = output;

                    if (recording) {
                        // Recording run: assert nothing, collect everything.
                        return;
                    }

                    expect(Object.keys(golden)).toContain(key);
                    expect(output).toBe(golden[key]);
                });
            }
        });
    }

    afterAll(() => {
        if (!recording) {
            return;
        }
        const ordered: Record<string, string> = {};
        for (const key of Object.keys(produced).sort()) {
            ordered[key] = produced[key]!;
        }
        fs.writeFileSync(GOLDEN_FILE, JSON.stringify(ordered, null, 2) + '\n');
        // eslint-disable-next-line no-console
        console.log(`[golden] rewrote ${GOLDEN_FILE} with ${Object.keys(ordered).length} entries`);
    });
});

describe('DomStripper behaviour', () => {
    const crawler = crawlerWithElements(SELECTOR_PROFILES['default']!);

    it('keeps href on anchors and drops every other attribute', () => {
        const out = strip(crawler, '<html><body><a href="/x" title="t" class="c">link</a></body></html>');
        expect(out).toContain('href="/x"');
        expect(out).not.toContain('title=');
        expect(out).not.toContain('class=');
    });

    it('prunes script tags entirely under the default selectors', () => {
        // `script` is not an interactable and cannot contain one, so the pruning
        // pass removes it before the trailing `script[src]` query-string cleanup
        // ever sees it. That cleanup is therefore reachable only when
        // `crawler.elements` is configured to keep scripts — pinned here so the
        // dependency between the two passes is visible rather than surprising.
        const out = strip(crawler, '<html><body><script src="/a.js?v=1"></script><a href="/x">l</a></body></html>');
        expect(out).not.toContain('script');
        expect(out).toContain('href="/x"');
    });

    it('strips the query string from script src when scripts are kept', () => {
        const keepsScripts = crawlerWithElements(['a', 'script']);
        const out = strip(keepsScripts, '<html><body><script src="/a.js?v=1&amp;x=2"></script></body></html>');
        expect(out).toContain('src="/a.js"');
        expect(out).not.toContain('v=1');
    });

    it('removes text and comment nodes', () => {
        const out = strip(crawler, '<html><body><a href="/x">visible text</a><!-- gone --></body></html>');
        expect(out).not.toContain('visible text');
        expect(out).not.toContain('gone');
    });

    it('prunes subtrees that contain no interactable element', () => {
        const out = strip(
            crawler,
            '<html><body><div id="keep"><a href="/x">l</a></div>' +
                '<div id="drop"><span><p>nothing</p></span></div></body></html>',
        );
        expect(out).toBe('<html><body><div><a href="/x"/></div></body></html>');
    });

    it('keeps an ancestor of an input[type=submit] while dropping the input itself', () => {
        // Attribute stripping runs in document order, so by the time the input
        // is tested against `input[type="submit"]` its own `type` attribute is
        // already gone and it no longer matches — but its ancestor was tested
        // first, while the attribute was still present, and was kept. This is
        // long-standing behaviour that the state hash depends on; it is pinned
        // here so an optimisation cannot quietly "fix" it.
        const out = strip(crawler, '<html><body><div><input type="submit" /></div></body></html>');
        expect(out).toBe('<html><body><div/></body></html>');
    });

    it('drops an element whose only match came from its own stripped attributes', () => {
        // Same mechanism seen from the other side: `[click]` cannot match the
        // element carrying the attribute, because the attribute is gone by the
        // time that element is tested — only an *ancestor*, tested earlier, sees
        // it. So the carrier is pruned and its parent survives.
        const out = strip(crawler, '<html><body><section><div click="go()"/></section></body></html>');
        expect(out).toBe('<html><body><section/></body></html>');
    });

    it('is idempotent on already-stripped output', () => {
        const once = strip(crawler, '<html><body><div><a href="/x" class="c">t</a></div></body></html>');
        const twice = strip(crawler, once);
        expect(twice).toBe(once);
    });
});
