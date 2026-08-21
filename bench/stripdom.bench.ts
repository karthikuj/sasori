/**
 * Micro-benchmark for `Crawler.stripDOM`.
 *
 * `stripDOM` is the crawler's hottest pure-CPU path: `getPageHash` runs it once
 * per action and `getCrawlActions` runs it three times per *candidate* action
 * (the node plus both siblings), so a state with fifty candidates costs about a
 * hundred and fifty invocations. Wall-clock crawl time is dominated by the
 * browser and the network, which makes end-to-end timings a blunt instrument for
 * this function — hence a dedicated harness.
 *
 * The fixtures are shared with the golden-output test, so a run that gets faster
 * here and still passes `stripDom.golden.test.ts` is faster *and* unchanged.
 *
 * Usage:
 *     make bench-stripdom
 *     npx ts-node bench/stripdom.bench.ts            # all fixtures
 *     npx ts-node bench/stripdom.bench.ts synth-deep # substring filter
 */

import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

import CrawlInput from '../src/crawler/crawlInput';
import DomStripper from '../src/crawler/domStripper';

const FIXTURE_SUBPATH = path.join('tests', 'fixtures', 'stripdom');

/**
 * Finds the fixture directory by walking up from this file until it appears.
 *
 * Needed because this benchmark is compiled and run from `dist/bench/`, like
 * everything else in the repo, while the fixtures it shares with the golden test
 * stay in the source tree — so a `__dirname`-relative path is wrong in exactly
 * one of the two locations. Anchoring on the fixtures rather than on
 * `package.json` is deliberate: `bin/index.ts` imports `package.json` for the
 * version banner, so `tsc` emits a copy into `dist/`, and a search for that file
 * stops one directory too early.
 * @return Absolute path to the fixture directory.
 */
function findFixtureDir(): string {
    let dir = __dirname;
    for (;;) {
        const candidate = path.join(dir, FIXTURE_SUBPATH);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`Could not locate ${FIXTURE_SUBPATH} above ${__dirname}`);
        }
        dir = parent;
    }
}

const FIXTURE_DIR = findFixtureDir();

/** Matches the shipped `config/config.json` element set. */
const ELEMENTS = ['a', 'button', 'input[type="submit"]', '[click]'];

/** Untimed passes before measurement, so V8 has tiered the hot loop up. */
const WARMUP_ITERATIONS = 3;

/** Timed passes; the reported figure is the median, which ignores GC outliers. */
const MEASURED_ITERATIONS = 7;

/**
 * Builds the stripper with the production selector set.
 *
 * No browser, no config file, no `Crawler` — which is the point: before SCAN-90
 * this function was a forty-line fake `CrawlerConfig` cast through `unknown`,
 * because stripping was a method on a class that wanted a live `Page`.
 * @return A stripper matching the shipped defaults.
 */
function buildStripper(): DomStripper {
    return new DomStripper([
        ...ELEMENTS,
        ...CrawlInput.INPUT_FIELDS.map((field) => field.CSS_PATH),
    ]);
}

/**
 * Counts elements in a fixture, so the report can show cost against DOM size.
 * @param html Fixture source.
 * @return Number of element nodes.
 */
function elementCount(html: string): number {
    return cheerio.load(html, { xmlMode: true })('*').length;
}

/**
 * Median of a sample. Preferred over the mean because a single GC pause during
 * a seven-iteration run would otherwise dominate the reported figure.
 * @param values Sample values.
 * @return The median.
 */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[mid]!;
    }
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Times one fixture. Parsing is included in neither the warm-up nor the
 * measurement: `stripDOM` mutates the tree it is given, so each iteration must
 * start from a freshly parsed copy, and charging Cheerio's parser to `stripDOM`
 * would hide the very thing being measured.
 * @param stripper Stripper supplying the selectors.
 * @param html Fixture source.
 * @return Median milliseconds per `stripDOM` call.
 */
function timeFixture(stripper: DomStripper, html: string): number {
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        const $ = cheerio.load(html, { xmlMode: true }) as cheerio.CheerioAPI;
        stripper.strip($);
    }

    const samples: number[] = [];
    for (let i = 0; i < MEASURED_ITERATIONS; i++) {
        const $ = cheerio.load(html, { xmlMode: true }) as cheerio.CheerioAPI;
        const start = process.hrtime.bigint();
        stripper.strip($);
        const end = process.hrtime.bigint();
        samples.push(Number(end - start) / 1e6);
    }

    return median(samples);
}

/**
 * Entry point.
 */
function main(): void {
    const filter = process.argv[2];
    const stripper = buildStripper();

    const fixtures = fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.html'))
        .filter((f) => !filter || f.includes(filter))
        .sort();

    if (fixtures.length === 0) {
        console.error(`No fixtures matched${filter ? ` "${filter}"` : ''} in ${FIXTURE_DIR}`);
        process.exitCode = 1;
        return;
    }

    console.log('');
    console.log('  stripDOM — median of ' + MEASURED_ITERATIONS + ' runs after ' + WARMUP_ITERATIONS + ' warm-ups');
    console.log('');
    console.log('  ' + 'fixture'.padEnd(34) + 'elements'.padStart(10) + 'ms'.padStart(12) + 'µs/element'.padStart(14));
    console.log('  ' + '-'.repeat(70));

    let total = 0;
    for (const fixture of fixtures) {
        const html = fs.readFileSync(path.join(FIXTURE_DIR, fixture), 'utf-8');
        const elements = elementCount(html);
        const ms = timeFixture(stripper, html);
        total += ms;
        const perElement = elements > 0 ? (ms * 1000) / elements : 0;
        console.log(
            '  ' +
                fixture.padEnd(34) +
                String(elements).padStart(10) +
                ms.toFixed(2).padStart(12) +
                perElement.toFixed(2).padStart(14),
        );
    }

    console.log('  ' + '-'.repeat(70));
    console.log('  ' + 'total'.padEnd(34) + ''.padStart(10) + total.toFixed(2).padStart(12));
    console.log('');
}

main();
