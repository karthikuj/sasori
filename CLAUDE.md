# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Sasori (`sasori-crawl`) is a Puppeteer-based dynamic web crawler for endpoint discovery and security testing. It drives real browsers through a web app — including behind authentication — and emits every in-scope URL it touches, optionally through a proxy such as ZAP or Burp.

**This file is the source of truth for AI assistant rules in this repo.** The rules in `.cursor/rules/` are legacy and are no longer maintained; do not update them. Update this file when CLI commands, config shape, crawl-graph semantics, the auth flow, or major dependencies change.

## Commands

TypeScript 5.9 → CommonJS, Node 18+. `makefile` targets are thin wrappers over the npm scripts; either is fine (`make help` lists them).

```bash
npm run build          # prebuild cleans dist/, tsc, postbuild copies config/ → dist/
npm run dev            # tsc --watch
npm run type-check     # tsc --noEmit — use this, not lint, to gate changes
npm test               # jest
npm run test:coverage  # jest --coverage
```

Run a single test file or case:

```bash
npx jest tests/crawler/crawlStateManager.test.ts
npx jest -t 'returns null when no actions remain'
```

Running the built CLI (nothing runs from source; build first):

```bash
node dist/bin/index.js start --config ./config/config.json [--output urls.txt] [--inventory inv.json]
node dist/bin/index.js api --host 0.0.0.0 --port 8080
node dist/bin/index.js init            # copies packaged config.json into cwd
make run-cli CONFIG=path/to.json       # builds, then runs
make run-crawl CONFIG=path/to.json INVENTORY=inv.json
make run-api HOST=127.0.0.1 PORT=8080
```

### `npm run lint` is safe to run

It was not always. `.eslintrc.json` used to demand 2-space indentation while the entire codebase is written with 4, so `npm run lint` (`eslint . --ext .ts,.js --fix`) reformatted every file in the repo and buried any real diff under ~14k auto-fixes. The config was wrong, not the code; it has been corrected rather than worked around:

- **`@typescript-eslint/indent` at 4 spaces**, with `SwitchCase: 1` and `ignoreComments: true`. The TS-aware rule replaces the base `indent`, which does not understand TypeScript type annotations and "fixes" a multi-line return type into something wrong. `ignoreComments` sidesteps an ESLint defect that de-indents a comment appearing as the first token after a multi-line parameter list.
- **`no-undef` and `no-unused-vars` off**, superseded by `tsc` and `@typescript-eslint/no-unused-vars`. The base rules do not know TypeScript and reported ~160 false positives for DOM globals used inside `page.evaluate` (`Node`, `Element`, `CSS`) and for ambient types (`NodeJS`, `RequestInit`).
- **`argsIgnorePattern: "^_"`**, matching the codebase's existing `_argv` / `_next` convention.
- **`env.jest`** so test globals resolve, and an **`.eslintignore`** covering `dist/`, `release/` and `coverage/` — linting compiled output reported every finding twice.

`npm run lint` is now idempotent: it modifies nothing on a clean tree. It reports 4 genuine pre-existing errors (three `no-useless-escape` in `domPath.ts`/`domPath.test.ts`, one `no-constant-condition` in `crawlStateManager.ts`) and ~164 `no-explicit-any` warnings. `npm run type-check` remains the correctness gate; lint is now usable alongside it.

## Architecture

### Two entry modes, one crawler

`bin/index.ts` (yargs) exposes `init`, `start`, and `api`.

- **`start`** validates a config file and runs exactly one `Crawler` in-process.
- **`api`** starts an Express server (`src/api/`) that runs *many* `Crawler` instances concurrently. `ScanRegistry` holds an in-memory `Map` of scanId → scan state plus the live `Crawler`; `createApiApp` exposes `POST /api/v1/scans` (JSON body is a full crawler config), `GET /api/v1/scans`, `GET|DELETE /api/v1/scans/:id`, and `GET /health`. `ScanRegistry` takes an injectable `CrawlerFactory` — tests use it to avoid launching browsers.
- A scan POST may carry a `nara_callback` object (`url`, `secret`, `backend_scan_id`); on completion the registry hands the terminal status to `CompletionOutbox` (`src/api/completionOutbox.ts`), a file-backed queue under `SASORI_OUTBOX_DIR` (default `./.sasori/outbox`) that retries delivery across process restarts and dead-letters events it cannot deliver. Call `startBackgroundDelivery()` once at startup to drain leftovers and run the retry loop.
- Registry state itself is in-memory and per-process — not shared across hosts. Terminal scans are evicted after `terminalRetentionMs` (default 6h) or when `maxScans` (default 1000) is exceeded, and eviction happens on `createScan`, not on a timer.

### The crawl graph

The crawler models the app as a graph built at runtime in `src/crawler/`:

- **`CrawlState`** (vertex) — a DOM state: URL, `stateHash`, `crawlDepth`, `arrivalType` (`link` vs `dom`), its `CrawlAction[]` and `CrawlInput[]`, and a back-pointer `parentAction`.
- **`CrawlAction`** (edge) — one click: element tag, `cssPath`, `actionHash` (structural hash of the node plus siblings), `parentState`, optional `childState`.
- **`CrawlStateManager`** — owns `rootState` and the indexes: `stateByHash` for O(1) state merging, a ref-counted `actionSignatureRefCount` for duplicate-action detection, and an explicit LIFO `pendingFrontier` that `getNextCrawlAction()` pops from. The frontier is fed by `registerState()` and reseeded by `reindexFromRoot()`; it is **not** a DFS re-walk from the root on every call. `clearVisitedActions()` rebuilds it via a legacy DFS simulation that preserves the old ordering.

State identity is purely hash-based: after an action, `getPageHash()` strips the DOM and SHA-256s it; if that hash matches an existing state the branch collapses onto it, otherwise a new child state is created and linked.

### Replay, not backtracking

Multiple browsers share one `CrawlStateManager`, so the page in front of you is usually *not* the parent state of the action you just popped. `performAction()` compares the live page hash against `action.parentState.stateHash`; on mismatch it calls `getOptimizedReplayPlan(destination)`, which walks `parentAction` pointers upward until it finds a state reached by a `link` (a real URL) and returns that `baselineUrl` plus only the actions after it. The crawler then `goto`s the baseline and replays that short suffix. Any selector that no longer resolves during replay causes the action to be pruned from its state.

### Scope enforcement

Scope lives in request interception, not in the navigation code. Every page gets `setRequestInterception(true)`; in-scope URLs are logged/recorded and continued, out-of-scope ones are answered with a synthetic `403 Out of Sasori's scope` rather than being blocked. `inContext(url)` applies `includeRegexes` then `excludeRegexes`. While `authInProgress` is true the interceptor *temporarily widens* `includeRegexes` with whatever host the login flow hits — an SSO redirect legitimately mutates config at runtime.

### Concurrency

`startCrawling()` launches `browser.instances` browsers, staggers their starts by `browserStartDelays`, and runs `handleCrawl` on all of them against the **same** `CrawlStateManager` with no locking. `getNextCrawlAction()` popping from a shared frontier is the only coordination. Understand the race implications before touching anything in `crawlStateManager.ts` or the crawl loop.

`stopCrawling()` aborts an internal `AbortController` and closes `activeBrowsers`; the crawl loop and every retry loop check `signal.aborted` and unwind cooperatively. `wasStopped()` distinguishes a requested stop from a natural finish, which is how the API decides between `stopped` and `completed`.

### The crawl inventory

`EndpointInventory` (`src/crawler/endpointInventory.ts`) records what a crawl
actually reached, so crawler coverage can be measured without reference to any
scanner. Until it existed, a missing finding was ambiguous — the crawler may
never have arrived, or it arrived and the rule stayed silent — and those two
failures belong to different code and different people. nara-core's
`make bench-crawl` scores this artifact against a known endpoint map
(SCAN-115).

Two hooks feed it, both on paths every crawl already takes: the request
interception handler records every in-scope request, and `getNewCrawlState`
records every DOM state. Nothing walks the crawl graph afterwards, so the
inventory is correct while browsers are still adding states concurrently.

- **Endpoints** are keyed by `METHOD` plus scheme/host/path — the query string is
  stripped from the identity but its parameter *names* are kept, because
  `/search?q=a` and `/search?q=b` are one endpoint with one parameter, and the
  parameter is the attack surface. Body parameter names are parsed for form and
  JSON encodings only; a multipart body is recorded with no parameters rather
  than risk inventing ones that were never sent.
- **States** are keyed by DOM hash, matching the crawler's own identity for a
  state: an SPA presents many states at one URL, and collapsing them would
  report a crawl of an application as a crawl of one page.
- **The artifact is deterministic.** Every array is sorted at snapshot time and
  nothing records a timestamp, so two crawls that reach the same surface produce
  byte-identical files and a diff shows a coverage change rather than the order
  browsers happened to race in. Aggregation happens on the way in, so memory is
  proportional to the surface rather than to the traffic.

Reading it:

- CLI: `--inventory <path>`, written in a `finally` — a crawl that was stopped
  or died part-way still covered something, and that partial inventory is the
  evidence for what happened before it stopped.
- API: `GET /api/v1/scans/:id/inventory`. A running scan is answered from the
  live crawler (a six-hour crawl is worth watching, not only autopsying); a
  finished one from the snapshot `ScanRegistry` takes in `runScan`'s `finally`
  **before** it drops the crawler reference. Keep that ordering — without the
  snapshot, the only scans anyone scores are the ones that can no longer be
  read.

### Browser launch and MITM TLS

`Browser.getBrowserInstance` (`src/browser/browser.ts`) translates `BrowserConfig` into Puppeteer launch options. When a proxy is enabled *and* `browser.tls.extraCaCerts` is set, `prepareTlsUserDataDir` (`src/browser/tlsProfile.ts`) shells out to `certutil` to build a throwaway Chromium profile whose NSS DB trusts those PEM CAs — that is how proxied HTTPS validates properly. This is the integration point for a MITM proxy like Nara.

CA import **fails closed**: if `certutil` is missing or the PEM is unreadable, `getBrowserInstance` throws rather than launching, because configuring a CA signals that the operator wants verified TLS and silently downgrading would disable certificate verification for the whole crawl. `browser.tls.allowInsecureFallback: true` opts back into `--ignore-certificate-errors` with a loud warning. Preserve that default when touching this path.

### Authentication

`src/auth/authenticator.ts` extends `@puppeteer/replay`'s `PuppeteerRunnerExtension` and replays a DevTools Recorder JSON file. It supports a non-standard step: `type: customStep`, `name: executeScript`, with `parameters.target` holding a JS string that is passed to `page.evaluate`. HTTP Basic auth is handled separately via `page.authenticate` before the crawl starts.

### Expensive operations

Two things dominate runtime and are worth knowing before optimizing anything:

- `stripDOM` (Cheerio) removes text, comments and most attributes, then prunes every subtree that contains no configured interactable selector. It runs on serialized HTML for every hash.
- The `[click]` pseudo-selector in `crawler.elements` triggers `findNodesWithClickListeners`, a CDP sweep over every element on the page looking for click handlers. It is very heavy on large DOMs.

## Configuration

Shape is `{ browser: BrowserConfig, crawler: CrawlerSettings }`; types live in `src/types/`. See `README.md` for the full field reference and `config/config.json` for a working example.

**There are two parallel Joi layers, and they have drifted:**

| | `src/models/configModel.ts` | `src/config/configSchema.ts` |
|---|---|---|
| Used by | `ConfigValidator`, re-exported from `configLoader` — **this is the live path** for both `start` and the API | Nothing in the runtime path; presets + `validateConfig` only |
| Has `maxActionRetries` | No | Yes |
| Port range checks | No | Yes (`1..65535`) |

Because `ConfigValidator.validate` runs Joi with `stripUnknown: true`, a key that only exists in `configSchema.ts` is **silently deleted** from user configs rather than rejected. `maxActionRetries` is the live example: setting it in a config file has no effect today, and every `?? 3` fallback in `crawler.ts` wins. When adding a config option, add it to `configModel.ts` or it will not exist at runtime — and add it to `configSchema.ts` too, to stop the drift widening.

Recorder auth resolves `pptrRecording` with `path.resolve(__dirname, …)` from compiled `dist/`, so relative paths behave differently than you would expect from the source layout. Prefer absolute paths.

## Types vs. implementation

`types/crawler.ts` declares a `CrawlStateManagerInterface` with a `states: Map<…>` member that the real `CrawlStateManager` does not have — the graph is linked through `CrawlState`/`CrawlAction` pointers plus private indexes. Trust `src/crawler/crawlStateManager.ts` over the interface.

`tsconfig.json` is strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. That is why the codebase is full of `arr[i]!`, `if (!page) continue`, and conditional-spread object building (`...(x ? {x} : {})`) instead of assigning `undefined` to optional fields. Follow those patterns; `tsconfig.test.json` relaxes `noImplicitAny`/`noUnusedLocals` for tests only.

## Tests

Jest with `ts-jest`, 10s default timeout, roots are `src/`, `tests/`, `types/`. Tests mirror source layout (`tests/crawler/*` for `src/crawler/*`). `tests/setup.ts` replaces `console.warn` and `console.error` with `jest.fn()`, so a test that expects warning output must assert on those mocks rather than on stdout. It also exposes `global.testUtils.createValidConfig()` — use it instead of hand-building config objects — and a custom `toBeValidConfig` matcher (declared in `types/test.d.ts`).

Crawler tests never launch a real browser; follow the existing mocking patterns in `tests/crawler/` and the `CrawlerFactory` injection in `tests/api/scanRegistry.test.ts`.

## Notes

`docs/IMPROVEMENTS.md` is an analysis-only backlog (multi-seed crawling, robots.txt/sitemap ingestion, graph policy alternatives). Items struck through there are already implemented. It is not a commitment to build anything — do not treat entries as pending work.
