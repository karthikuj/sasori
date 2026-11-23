# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Breaking
- Sasori now needs **Node.js 22.12 or newer** (`engines` in `package.json`):
  Puppeteer 25, which the security update below requires, needs it. On
  22.12 exactly, Node may print an "ExperimentalWarning" about loading an ES
  module with `require()`; it is harmless.
- Sasori is now written in TypeScript and runs from the compiled `dist/`
  directory. Build with `npm run build` and start it with
  `node dist/bin/index.js`.
- Config is validated strictly. Bad values are rejected, and keys Sasori does
  not know are dropped.
- If `browser.tls.extraCaCerts` is set and the CA cannot be imported (no
  `certutil`, or an unreadable PEM), the browser no longer launches. Before,
  it fell back to ignoring certificate errors without saying so. Set
  `browser.tls.allowInsecureFallback: true` to get the old behaviour, with a
  warning.
- `make run` now starts the REST API on port 3100, the port nara-backend
  calls. It used to print the CLI help.

### Added
- `make install-app` builds this checkout and installs it as the global
  `sasori` command, from a packed copy rather than a link; `make
  uninstall-app` removes it. The README now covers building and running from
  source with make.
- Several starting URLs. The crawl now starts from the entry point, then from
  `crawler.extraSeeds`. Each one starts its own crawl tree, and trees that reach
  the same page merge. (SCAN-229)
- Seed discovery from `robots.txt` and `sitemap.xml`, switched on with
  `crawler.sitemap.enabled`. Sitemap indexes are followed, and every limit is
  capped: `maxSeedUrls`, `maxSitemapDepth`, `maxSitemapUrls`, a file count and
  a body size. With `respectRobots` (the default), robots `Allow`/`Disallow`
  rules apply to the whole crawl, following RFC 9309. Seeding counts toward
  `maxDuration`. (SCAN-229)
- REST API mode, started with `sasori api`. It runs many crawls at once.
  Endpoints: `POST/GET /api/v1/scans`, `GET/DELETE /api/v1/scans/:id`,
  `GET /health`.
- Completion callbacks (`nara_callback`) for API scans. They go through a
  file-backed outbox that retries delivery across restarts and keeps what it
  could not deliver.
- A crawl inventory of every endpoint and DOM state the crawl reached. It is
  written to `--inventory` / `crawler.inventoryFile` and served at
  `GET /api/v1/scans/:id/inventory`, and the output is deterministic.
- A crawl-graph dump of states, actions and what happened to each action
  (`executed`, `revisited`, `out-of-scope`, `pruned`, `deduped`), as JSON plus
  Mermaid and DOT files. Set `--crawl-graph` / `crawler.crawlGraphFile`, or
  `crawler.recordCrawlGraph` to record it for API scans. `maxCrawlGraphEdges`
  bounds its size. (SCAN-197)
- Proxy CA trust: `browser.tls.extraCaCerts` imports PEM CAs into a throwaway
  Chromium profile, so HTTPS through a MITM proxy (Nara, ZAP, Burp) is
  verified.
- Elements with click handlers can be crawled, using the `[click]` selector.
- Each state records whether it was reached by following a link or by a change
  in the page (`arrivalType`), plus the action that led to it.
- Logging to a size-rotated file, configured in the optional `logging` block.
  (SCAN-181)
- Recorder login accepts the recording as inline JSON, not only a file path.
- `make` targets for building, running, packaging and benchmarking (`make
  help`). `make bench-crawlmaze` takes `BENCH_CONFIG` to run variants such as
  sitemap seeding.
- CI runs type-check, tests, build and lint on every push and pull request.

### Changed
- The npm package now contains only the built app (`dist/`), the README, the
  changelog and the licence: 190 KB instead of 5.3 MB. It used to ship the
  tests, the TypeScript sources and the README images as well.
- The crawler is split into units that can be tested on their own:
  `DomStripper`, `ActionDiscovery`, `ActionReplay`, `ScopeMatcher`, `UrlSink`
  and `seedDiscovery`.
- Duplicate actions: a widget counts as used only once it has actually been
  clicked. Up to three unclicked copies are kept, so a widget that shows up on
  many pages is still exercised. (SCAN-198)
- After each action, the crawler waits until the page has stopped changing
  before starting the next one. The wait is capped. (SCAN-198)
- Forms now get filled in. Bare `<input>` fields are filled, and pre-filled
  fields are cleared before typing. (SCAN-200, SCAN-201)
- Starting several browsers tolerates some of them failing, and recorder login
  runs on one browser at a time instead of all of them at once.
- Faster DOM stripping, the busiest part of the crawl (about 13x on the test
  fixtures). Scope regexes are compiled once rather than per request.
  (SCAN-85, SCAN-87)
- Looking up a state by its hash no longer walks the whole graph.

### Fixed
- All 65 open Dependabot alerts (6 critical, 30 high): Puppeteer 24 to 25 and
  `@puppeteer/replay` 3 to 4, which drop `extract-zip`, `proxy-agent` and
  `basic-ftp`; updated `joi`, Express's `body-parser`, `qs`, `path-to-regexp`
  and `proxy-addr`, `ws`, `ip-address` and `tar-fs`; and development tooling
  (Jest, typescript-eslint 8, and patched `glob`/`minimatch` pinned through
  `overrides` where Jest and its coverage plugin still range older ones).
  `npm audit` reports no vulnerabilities.
- `maxActionRetries` was silently removed from configs before the crawler saw
  it, so the default of 3 always applied. A test now checks that both config
  schemas declare the same keys. (SCAN-89)
- When Sasori ran behind a proxy, Chrome sent requests to localhost around the
  proxy instead of through it, so a scanning proxy never saw a local target's
  traffic.
- A stop request sent while a crawler was being created could be lost.
- Finished API scans are removed after a retention period or above a count
  limit, so the registry no longer grows forever.
- Browsers are closed however a crawl ends, so failed crawls no longer leave
  Chrome processes running.

## [1.0.1] - 2024-07-14
### Added
- Documented the `instances` setting in the README.

## [1.0.0] - 2024-07-13
### Added
- Multi-browser support
- Wait till `document.readyState` is equal to `complete`.
- Support to run custom JS while authenticating.

### Fixed
- `CrawlAction` element name bug.
- Check if CrawlAction is unique only if it is not a link.
- Replaced deprecated function `page.waitForTimeout`.

## [0.1.0] - 2024-03-30
### Added
- Initial release of the project.