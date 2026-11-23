# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Sasori (`sasori-crawl`) is a Puppeteer-based dynamic web crawler for endpoint discovery and security testing. It drives real browsers through a web app — including behind authentication — and emits every in-scope URL it touches, optionally through a proxy such as ZAP or Burp.

**This file is the source of truth for AI assistant rules in this repo.** (The old `.cursor/rules/` files duplicated it and had gone stale, so they were removed.) Update this file when CLI commands, config shape, crawl-graph semantics, the auth flow, or major dependencies change.

## Commands

TypeScript 5.9 → CommonJS, Node 22.12+ (Puppeteer 25's minimum). `makefile` targets are thin wrappers over the npm scripts; either is fine (`make help` lists them).

```bash
npm run build          # prebuild cleans dist/, tsc, postbuild copies config/ → dist/
npm run dev            # tsc --watch
npm run type-check     # tsc --noEmit — use this, not lint, to gate changes
npm test               # jest
npm run test:coverage  # jest --coverage
```

Benchmarks have no npm script — they run from `dist/`, so go through make:

```bash
make bench-stripdom               # micro-benchmark DomStripper (FILTER=synth-deep to narrow)
make bench-crawlmaze LABEL=before # timed crawl of security-crawl-maze.app
make bench-crawlmaze-after        # crawl again, then diff against `before`
make bench-crawlmaze LABEL=sitemap BENCH_CONFIG=bench/crawlmaze.sitemap.config.json
                                  # same crawl with robots.txt/sitemap seeding on
```

`make bench-stripdom` is the one to reach for when changing DOM stripping: it is
deterministic and takes seconds, whereas end-to-end crawl time is dominated by
the browser and the network and drowns that signal out. `bench-crawlmaze` is the
end-to-end gate, and `bench/crawlmaze-compare.sh` **fails if time went up or if
coverage went down** — a crawler that got faster by visiting less is not faster.

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
make install-app                  # build, npm pack, npm install -g the tarball (the `sasori` command)
make uninstall-app
```

`make install-app` installs a packed copy, not `npm link`: a link would point
at `dist/`, which every build deletes first (`prebuild` cleans it), so the
installed command would break mid-build. What the package contains is the
`files` list in `package.json` (`dist/bin`, `dist/src`, `dist/config`,
`dist/package.json`). `dist/package.json` is easy to forget: `bin/index.ts`
imports `../package.json` for the version, so tsc emits a copy next to
`dist/bin`, and a package without it fails on start with
`Cannot find module '../package.json'`. A new runtime file outside those paths
must be added to the list, or the installed app will not have it.

### `npm run lint` is safe to run

It was not always. `.eslintrc.json` used to demand 2-space indentation while the entire codebase is written with 4, so `npm run lint` (`eslint . --ext .ts,.js --fix`) reformatted every file in the repo and buried any real diff under ~14k auto-fixes. The config was wrong, not the code; it has been corrected rather than worked around:

- **`@typescript-eslint/indent` at 4 spaces**, with `SwitchCase: 1` and `ignoreComments: true`. The TS-aware rule replaces the base `indent`, which does not understand TypeScript type annotations and "fixes" a multi-line return type into something wrong. `ignoreComments` sidesteps an ESLint defect that de-indents a comment appearing as the first token after a multi-line parameter list.
- **`no-undef` and `no-unused-vars` off**, superseded by `tsc` and `@typescript-eslint/no-unused-vars`. The base rules do not know TypeScript and reported ~160 false positives for DOM globals used inside `page.evaluate` (`Node`, `Element`, `CSS`) and for ambient types (`NodeJS`, `RequestInit`).
- **`argsIgnorePattern: "^_"`**, matching the codebase's existing `_argv` / `_next` convention.
- **`env.jest`** so test globals resolve, and an **`.eslintignore`** covering `dist/`, `release/` and `coverage/` — linting compiled output reported every finding twice.

Since typescript-eslint 8, `indent` comes from `@stylistic/eslint-plugin` (`@stylistic/indent`, same options), because typescript-eslint dropped its formatting rules; and `no-unused-vars` sets `caughtErrors: "none"`, keeping the v7 default rather than flagging every unused `catch (error)`.

`npm run lint` is now idempotent: it modifies nothing on a clean tree. It reports 4 genuine pre-existing errors (three `no-useless-escape` in `domPath.ts`/`domPath.test.ts`, one `no-constant-condition` in `crawlStateManager.ts`) and ~164 `no-explicit-any` warnings. `npm run type-check` remains the correctness gate; lint is now usable alongside it.

### CI

`.github/workflows/ci.yml` runs on every push and pull request: `npm ci`,
`npm run type-check`, `npm test`, then `npm run build` — the crawler only ever
runs from `dist/`, so a build that breaks is a product that does not run even
when every test passes. `tsc` is the correctness gate here, not eslint; the
strict settings are what catch the mistakes that matter.

Lint is a separate job and **blocks on errors**. The four the repo used to carry
were fixed when CI was added (two redundant `\/` escapes inside character
classes in `domPath.ts`, one in its test, and a `while (true)` rewritten as
`for (;;)`), so a new error is genuinely new. The ~164 `no-explicit-any`
warnings do not block: failing on them would make every pull request red for
reasons unrelated to its change, which teaches people to ignore the colour.
Ratchet them down with `--max-warnings` once someone is driving that backlog.

The job calls `eslint` directly rather than `npm run lint`, which carries
`--fix`: a CI step that rewrites the tree reports on code that is not the code
under review.

nara-core's nightly benchmark checks this repository out and rebuilds it, so a
change here that breaks the build turns that run red too (SCAN-116).

## Commit conventions

**Do not credit Claude, or any AI assistant, in a commit.** No
`Co-Authored-By: Claude …` trailer, no "generated with" footer, and no mention of
Claude or Anthropic in the subject or body. This holds even though Claude Code's
own default behaviour is to append that trailer — the repository's convention
wins, so the trailer is left off.

The same goes for pull-request descriptions.

Nothing else about commit style changes: a precise subject line and a body that
explains *why* the change is right, with the measurement or the failing case that
motivated it, is still the bar.

### Update the changelog on every branch

**Every branch updates `CHANGELOG.md` before it is merged.** Add an entry under
`## Unreleased`, in the section that fits: `Breaking`, `Added`, `Changed` or
`Fixed`. Write it for someone upgrading Sasori: what changed for them, not how
it was built. Give the ticket ID where there is one, and put anything that can
break an existing config or command under `Breaking`.

This is a rule because the changelog has already decayed once. It stopped at
1.0.0 in July 2024 and missed 39 commits, the TypeScript port and API mode among
them, until it was rebuilt from git history. A changelog written at release time
is reconstructed from memory, and the breaking changes are what get lost.

A branch with no user-visible effect, such as a test-only change or a CI tweak,
still says so in its pull request, so a missing entry is a decision and not an
oversight. The file uses CRLF line endings; keep them.

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

**Several roots (SCAN-229).** The graph is a *forest*: one depth-0 `link` root per seed URL (`entryPoint` first, then `extraSeeds`, then sitemap seeds), held in `rootStates` with `rootState` mirroring the first. `Crawler.seedCrawl` builds them on one page before any browser pops the frontier, so seeding never races. Trees join wherever two branches reach the same hash, and a seed whose DOM is already held merges instead of becoming a root. Replay needed no new logic: each root is reached by a full navigation, so `getOptimizedReplayPlan` stops at a state's own seed. The one rule to keep: when no `link` ancestor is found, the baseline is the root the walk *ended on*, never `rootStates[0]`. The frontier is rebuilt with the entry point's actions on top, so its tree is explored first.

State identity is purely hash-based: after an action, `getPageHash()` strips the DOM and SHA-256s it; if that hash matches an existing state the branch collapses onto it, otherwise a new child state is created and linked.

### Replay, not backtracking

Multiple browsers share one `CrawlStateManager`, so the page in front of you is usually *not* the parent state of the action you just popped. `performAction()` compares the live page hash against `action.parentState.stateHash`; on mismatch it calls `getOptimizedReplayPlan(destination)`, which walks `parentAction` pointers upward until it finds a state reached by a `link` (a real URL) and returns that `baselineUrl` plus only the actions after it. The crawler then `goto`s the baseline and replays that short suffix. Any selector that no longer resolves during replay causes the action to be pruned from its state.

### Scope enforcement

Scope lives in request interception, not in the navigation code. Every page gets `setRequestInterception(true)`; in-scope URLs are logged/recorded and continued, out-of-scope ones are answered with a synthetic `403 Out of Sasori's scope` rather than being blocked. `inContext(url)` applies `excludeRegexes`, then any installed robots.txt rules, then `includeRegexes`. Robots rules are installed only when `sitemap.enabled` and `sitemap.respectRobots` (the default). They are kept per origin and follow RFC 9309: the longest match wins, an `Allow` wins a tie, and `*`/`$` work. They can only narrow scope. While `authInProgress` is true the interceptor *temporarily widens* `includeRegexes` with whatever host the login flow hits — an SSO redirect legitimately mutates config at runtime.

### Concurrency: sessions, workers, windows (SCAN-236)

`browser.instances` is the number of **workers**. A worker (`CrawlWorker`) is one window taking actions off the shared frontier. A **session** (`CrawlSession`) is one browser (`BrowserSession`, `src/browser/browserSession.ts`) and its workers:

- `browser.sessionMode: "shared"` (default): one session holding every worker. Chrome is launched once, the login recording runs once in the session's **control window** (its first page, which then becomes the first worker's window), and every other worker gets its own window via CDP `Target.createTarget({ newWindow: true })`. All windows share the browser's cookie jar and storage, so they are all logged in. Windows, not tabs: a tab-based proof of concept failed, and background tabs are throttled (the `--disable-*-throttling` flags in `browser.ts` cover covered windows).
- `"perBrowser"`: one session per worker, each logging in on its own, as before. For apps whose login lives only in `sessionStorage`, which is per window.

Sessions start one after another, never in parallel (N parallel logins against a CPU-heavy password hash push navigation past its timeout). Every worker runs `handleCrawl` against the **same** `CrawlStateManager` with no locking; `getNextCrawlAction()` popping from a shared frontier is the only coordination. Understand the race implications before touching anything in `crawlStateManager.ts` or the crawl loop.

Rules that keep several workers in one browser from breaking each other:

- **A worker closes only its own window**, never the browser, and never the browser's last window (Chrome quits when its last window closes, which looks like a crash). Browsers close once, in `startCrawling`'s `finally`, which also deletes any profile Sasori made.
- **Pop-ups**: `BrowserSession` tracks its own pages and closes only pages the crawled app opened. The old handler closed any page once a browser had more than one, i.e. every worker.
- **Per-window setup** (`setupPage`): timeouts, viewport, Basic auth, request interception and dialog dismissal are applied to every window, including windows reopened after a restart.
- **Scope widening during login is per page** (`authPages`), so one browser logging in does not let the others leave scope.

Each session has a `PauseGate` (`src/crawler/pauseGate.ts`). Workers `enter()` before each action and `leave()` after; `pause()` resolves only when no action is running. Restarts use it, and pausing a crawl on request (SCAN-231) should reuse it.

`stopCrawling()` aborts an internal `AbortController`, cancels the gates and closes every session; the crawl loop and every retry loop check `signal.aborted` and unwind cooperatively. `wasStopped()` distinguishes a requested stop from a natural finish, which is how the API decides between `stopped` and `completed`. A crawl that cannot go on (three failed re-logins) sets `crawlFailure` instead, so it is reported as failed, not stopped.

### Session checks, re-login and crash recovery (SCAN-236)

With recorder auth, `logInAndObserve` records the app's own requests while the recording runs and the landing page settles. `chooseSessionCheck` picks the check. **Automatic**: only API requests (fetch/XHR **`GET`**, never a write or a page load), in scope, 2xx in the browser. Each candidate (`classifyRequest`) is sent twice logged in and once **without credentials**, **straight to the target from Node** (`src/auth/directRequest.ts`), never through the browser or the proxy, so no unauthenticated copy lands in the inventory. `classifyCandidate` makes it a **`status`** check when the status tells them apart (401/403, another status class, or a redirect elsewhere), else a **`body`** check with markers (`deriveMarkers`: tokens in both logged-in answers and not in the logged-out one, so per-request values never qualify; emails rank first); `pickCheck` prefers a status check. If nothing qualifies, Sasori says it found no endpoint and asks for a configured one; it never guesses. **Configured**: `sessionCheck.url` with `loggedInRegex` is a **`regex`** check (the pattern must match right after login, or the check is refused); `url` alone is classified like a candidate. `judgeProbe` reads every answer by its kind. The rules are pure, in `src/auth/sessionCheck.ts`.

No window is kept aside for the check. Every `intervalMs` (default 120 s) the timer starts a **check round** (`runSessionCheckRound`): pause the session's gate, which waits for every running action to finish and starts no new one; borrow one worker's window (`borrowWindow`); send the check from it (`runSessionCheck`); on a logout, log in again **in that window** (`logInAgainInPlace`); resume. Logging in again in place needs no restart and no new windows: every window shares the browser's cookie jar and storage, so the others are logged in as soon as this one is, and each worker's next action reloads from a real URL that carries the new session. Before the recording runs, `clearSessionData` clears every cookie (`Network.clearBrowserCookies`) and the app origins' storage, so the login page behaves as on a fresh profile. The check is an in-page `fetch` (`probeInPage`) and must be sent from the app's own origin, or the browser may block it as cross-site or drop SameSite cookies and it would look like a logout: a window on another origin first loads `checkPageUrl` (where the app landed after login), a window already on that origin sends it as it is. One round runs at a time, and none runs during a restart. A 5xx or failed request is `inconclusive`, never a logout. The check follows the app's latest `Authorization` header, so a token the app refreshes is not mistaken for a logout.

`restartSession` handles a scheduled re-login (`reloginIntervalMs`), a crash, and a logout whose in-place login failed: pause the session's workers, close the browser and delete its profile, launch fresh, log in once, reopen the workers' windows, find the check again, resume. A fresh profile every time, because a recording replayed in an already logged-in window can break. Three failures in a row end the crawl with an error. A worker whose action is interrupted puts the action back (`requeueAction`); a worker whose window alone was closed gets a new window without a restart. Pages crawled before a logout was noticed are kept as they are; re-running them is SCAN-237.

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

### The crawl-graph dump (SCAN-197)

The inventory records *states* (what was reached); the crawl-graph dump records
the *edges* and each action's execution status, which is what makes a coverage
failure diagnosable after the fact — "was this anchor deduped at discovery, or
executed and dropped?". `src/crawler/crawlGraph.ts` walks `CrawlStateManager`
(via `getStates()`) and serialises nodes (states) and edges (`CrawlAction`s,
each `from` → `to`|null with a `status` of `executed` / `no-child-state`). A
`no-child-state` edge is an action that was discovered but produced no child
state — it was never executed, changed nothing, or was pruned on a failed
replay. Actions deduped at *discovery* (`isCrawlActionUnique` false) never enter
a state's `crawlActions`, so they are absent from the graph by design, and that
absence is itself the signal that dedup, not execution, dropped them.

`buildCrawlGraph` is pure; `crawlGraphToMermaid` / `crawlGraphToDot` are pure
converters (Mermaid for scoped crawls and rendering anywhere, DOT for the full
thousands-of-states graph). `Crawler.writeCrawlGraphFile` writes the JSON plus
`.mmd`/`.dot` siblings in the same `finally` as the inventory, gated on
`crawler.crawlGraphFile`, and swallows write failures for the same reason — a
diagnostic artifact must never turn a completed crawl into a failed one.

- CLI: `--crawl-graph <path>` (alias `-g`). Make: `make run-crawl CRAWL_GRAPH=…`.
- Like every config key it is declared in **both** Joi layers (`configModel.ts`
  and `configSchema.ts`); `schemaDrift.test.ts` enforces that.

### Browser launch and MITM TLS

`Browser.getBrowserInstance` (`src/browser/browser.ts`) translates `BrowserConfig` into Puppeteer launch options. When a proxy is enabled *and* `browser.tls.extraCaCerts` is set, `prepareTlsUserDataDir` (`src/browser/tlsProfile.ts`) shells out to `certutil` to build a throwaway Chromium profile whose NSS DB trusts those PEM CAs — that is how proxied HTTPS validates properly. This is the integration point for a MITM proxy like Nara.

CA import **fails closed**: if `certutil` is missing or the PEM is unreadable, `getBrowserInstance` throws rather than launching, because configuring a CA signals that the operator wants verified TLS and silently downgrading would disable certificate verification for the whole crawl. `browser.tls.allowInsecureFallback: true` opts back into `--ignore-certificate-errors` with a loud warning. Preserve that default when touching this path.

### Authentication

`src/auth/authenticator.ts` extends `@puppeteer/replay`'s `PuppeteerRunnerExtension` and replays a DevTools Recorder JSON file. It supports a non-standard step: `type: customStep`, `name: executeScript`, with `parameters.target` holding a JS string that is passed to `page.evaluate`. HTTP Basic auth is handled separately via `page.authenticate`, applied to every window in `setupPage`. With several workers, the recording runs once per session, not once per worker (see Concurrency).

### The units inside `src/crawler/`

`crawler.ts` used to own everything and was ~1,000 lines. It is now orchestration
plus delegating facades, and the work lives in units that can be constructed and
tested without a browser (SCAN-90). `Crawler`'s public surface did not change, so
call sites and tests still go through it.

| Unit | Owns |
|---|---|
| `DomStripper` | `stripDOM`, fragment stripping, state hashing, the per-pass strip memo |
| `ActionDiscovery` | the CDP listener sweep, batched selector snapshots, `getCrawlActions` / `getCrawlInputs` |
| `ActionReplay` | `performAction`, input filling, pruning selectors that no longer resolve |
| `ScopeMatcher` | `inContext` and the auth-time include widening |
| `UrlSink` | the discovered-URL output stream |
| `seedDiscovery` | robots.txt / sitemap parsing, RFC 9309 rule matching, capped seed collection behind an injected fetcher (SCAN-229) |
| `PauseGate` | stopping a session's workers between actions, and resuming them (SCAN-236) |

Outside `src/crawler/`: `BrowserSession` (`src/browser/`) owns one Chrome, its windows, pop-up closing and profile cleanup; `sessionCheck` and `directRequest` (`src/auth/`) hold the session-check rules and the credential-less request.

### Do not modify `domPath.ts`

`src/crawler/domPath.ts` (CSS-path and XPath generation) is ported from
Chromium's own DevTools source and is trusted as-is. **Do not rewrite, "fix", or
refactor it** — if selector generation appears to be the problem, the bug is
almost certainly elsewhere (the DOM changed between when the path was generated
and when it is replayed, replay timing, etc.), not in this file. Treat it as a
vendored dependency.

### Expensive operations

- **`DomStripper.strip` is the hottest pure-CPU path.** `getPageHash` runs it once
  per action and `ActionDiscovery` three times per *candidate* action (node plus
  both siblings), so a state with fifty candidates costs ~150 invocations. It is
  a four-pass mark-and-sweep, not a per-element subtree search — the naive
  version's cost grew in DOM *depth*, and removing that was ~13x on the fixture
  corpus (SCAN-85).
- **Its output is pinned byte-for-byte** by `tests/crawler/stripDom.golden.test.ts`
  because it feeds `stateHash`. A change there does not fail loudly; it silently
  repartitions the crawl graph. Regenerate the goldens only deliberately
  (`UPDATE_STRIPDOM_GOLDEN=1`) and read the diff as a report on how coverage will
  move.
- **Watch out for `nodeType` when walking a Cheerio tree.** domhandler reports
  `nodeType` 1 for a `<!DOCTYPE>` directive as well as for real elements, so a
  walk keyed on it deletes the doctype. Key on the `type` discriminator
  (`tag`/`script`/`style`) instead.
- The `[click]` pseudo-selector in `crawler.elements` triggers
  `findNodesWithClickListeners`, a CDP sweep over every element on the page. The
  probes now run through a bounded worker pool rather than strictly sequentially,
  and results are placed by index so document order survives the concurrency —
  the inventory is deliberately deterministic and must stay that way.

## Configuration

Shape is `{ browser: BrowserConfig, crawler: CrawlerSettings, logging?: LoggingConfig }`; types live in `src/types/`. See `README.md` for the full field reference and `config/config.json` for a working example.

**Logging (SCAN-181):** the optional `logging` block (`file`, `console`, `maxSizeMB`, `maxBackups`, `maxAgeDays`, `compress`) tees `console.*` output to a size-rotated log file via `rotating-file-stream` (`src/logger/logger.ts`, `setupLogging`). `start` configures it from the run's config; `api` configures it once at startup from the default `config/config.json` (logging is process-wide, not per-scan). An absent block keeps the old stdout-only behaviour. Being a top-level config key, `logging` must be declared in **both** Joi layers (`configModel.ts` and `configSchema.ts`) or `schemaDrift.test.ts` fails.

**There are two parallel Joi layers, and only one is live:**

| | `src/models/configModel.ts` | `src/config/configSchema.ts` |
|---|---|---|
| Used by | `ConfigValidator`, re-exported from `configLoader` — **this is the live path** for both `start` and the API | Nothing in the runtime path; presets + `validateConfig` only |

Because `ConfigValidator.validate` runs Joi with `stripUnknown: true`, a key that
only exists in `configSchema.ts` is **silently deleted** from user configs rather
than rejected. When adding a config option, add it to **both** — `configModel.ts`
or it will not exist at runtime, and `configSchema.ts` to keep them aligned.

`tests/config/schemaDrift.test.ts` now enforces that: it compares the declared
key sets and names the offending key on failure. It exists because this bug is
invisible by construction and had already happened twice — `maxActionRetries` was
read by `crawler.ts` but declared only in `configSchema.ts`, so setting it did
nothing and the `?? 3` fallback always won; and `browser.tls.allowInsecureFallback`
nearly shipped the same way, which would have left a documented security escape
hatch inert. A warning in this file was not enough either time (SCAN-89).

Recorder auth resolves `pptrRecording` with `path.resolve(__dirname, …)` from compiled `dist/`, so relative paths behave differently than you would expect from the source layout. Prefer absolute paths.

## Types vs. implementation

`types/crawler.ts` declares a `CrawlStateManagerInterface` with a `states: Map<…>` member that the real `CrawlStateManager` does not have — the graph is linked through `CrawlState`/`CrawlAction` pointers plus private indexes. Trust `src/crawler/crawlStateManager.ts` over the interface.

`tsconfig.json` is strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. That is why the codebase is full of `arr[i]!`, `if (!page) continue`, and conditional-spread object building (`...(x ? {x} : {})`) instead of assigning `undefined` to optional fields. Follow those patterns; `tsconfig.test.json` relaxes `noImplicitAny`/`noUnusedLocals` for tests only.

## Tests

Jest with `ts-jest`, 10s default timeout, roots are `src/`, `tests/`, `types/`. Tests mirror source layout (`tests/crawler/*` for `src/crawler/*`). `tests/setup.ts` replaces `console.warn` and `console.error` with `jest.fn()`, so a test that expects warning output must assert on those mocks rather than on stdout. It also exposes `global.testUtils.createValidConfig()` — use it instead of hand-building config objects — and a custom `toBeValidConfig` matcher (declared in `types/test.d.ts`).

Crawler tests never launch a real browser; follow the existing mocking patterns in `tests/crawler/` and the `CrawlerFactory` injection in `tests/api/scanRegistry.test.ts`. For whole crawls with sessions, windows, restarts and crashes, `tests/browser/fakeBrowser.ts` is a fake Chrome (it emits `targetcreated`/`disconnected` and quits when its last window closes, as headful Chrome does); inject it through `crawler.browserLauncher`, as `tests/crawler/crawler.sessions.test.ts` does.

**Puppeteer and `@puppeteer/replay` are ES modules only** (Puppeteer 25, replay 4). The built CommonJS app loads them with Node's `require()` of ESM, which is why Node 22.12+ is required, but Jest's own module loader cannot. `jest.config.js` therefore maps both to CommonJS stand-ins in `tests/stubs/` with the same value exports (`launch`, `connect`; `createRunner`, `PuppeteerRunnerExtension`). `jest.mock('puppeteer')` mocks the stand-in exactly as it mocked the real package, and anything that reaches an unmocked stand-in throws. If code starts using another value export from either package, add it to the stand-in.

Crawler tests never launch a real browser; follow the existing mocking patterns in `tests/crawler/` and the `CrawlerFactory` injection in `tests/api/scanRegistry.test.ts`.

## Notes

`docs/IMPROVEMENTS.md` is an analysis-only backlog (multi-seed crawling, robots.txt/sitemap ingestion, graph policy alternatives). Items struck through there are already implemented. It is not a commitment to build anything — do not treat entries as pending work.
