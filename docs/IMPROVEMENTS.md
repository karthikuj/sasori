# Sasori – potential improvements (backlog / notes)

This document lists **analysis-only** improvement ideas for the codebase. It is not a commitment to implement any item; use it for planning and prioritization.

---

## Graph algorithms & data structures

- ~~**`getStateByHash` / `isCrawlActionUnique`**~~ — **Done (implemented):** `CrawlStateManager` keeps `stateByHash: Map<string, CrawlState>` plus ref-counted action-signature keys (`registerActionSignature` / `unregisterActionSignature`). **`CrawlState.stateHash` is kept** on the vertex object (canonical field, `toJSON`, replay); the map only stores references. Root attach calls `attachRootState` → `reindexFromRoot`; new states call `registerState` after `getNewCrawlState`.
- ~~**`getNextCrawlAction`**~~ — **Done (implemented):** explicit **LIFO frontier** (`pendingFrontier` + `queuedActionIds`) fed by **`registerState`** / **`reindexFromRoot`** reseed; **no full root DFS scan** each call. **`clearVisitedActions`** runs a legacy DFS simulation to rebuild the frontier (same return order as before). Optional future work: **BFS / priority** policies if you want breadth-first or tunable ordering (would change behavior vs current DFS semantics).
- ~~**`getShortestPath`** (BFS)~~ — **Removed**; use **`getOptimizedReplayPlan`** only.
- The model is effectively a **tree from root** with optional state merging by hash. If you formalize **DAG** or **merged states** (multiple parents to one UI state), add explicit **dedup**, **cycle** handling, and updated replay semantics.

### ~~Multiple seed URLs (array of entry points)~~

> **Done (SCAN-229):** `CrawlStateManager` holds one root per seed (`rootStates`, with `rootState` mirroring the first). `Crawler.seedCrawl` builds them before the browsers start, in this order: `entryPoint`, `crawler.extraSeeds`, then sitemap seeds. Trees join on a shared `stateHash`, and a seed whose DOM is already held merges into it. Replay plans from the root the walk ends on. The notes below are the original analysis.

- **Today**: config exposes a single **`entryPoint`**; startup builds **one** root `CrawlState` after `goto(entryPoint)`.
- **Desired**: an **array of seed URLs** (or `entryPoints`) so crawling can start from several places without duplicating runs.
- **Graph shape**: one seed → tree-like exploration (with hash-based merges). Multiple seeds → a **forest** of disjoint subgraphs at first, until exploration discovers a **shared crawl state** (same stripped DOM **`stateHash`** as an existing `CrawlState`) — then subgraphs **join** at that vertex.
- **Design choices** (when implementing):
  - **Multiple roots** in `CrawlStateManager` vs a **virtual super-root** whose children are synthetic `goto` actions to each seed.
  - **Global** `visitedActions` / state dedup so workers do not repeat work across seeds.
  - **Scope**: all seeds must remain within `includeRegexes` (or per-seed scope rules — more complex).
  - **Ordering**: how to interleave seeds (round-robin, depth-first globally, priority).
  - **Replay**: `getOptimizedReplayPlan` assumes a path from **one** root; with multiple roots, define which baseline/root applies or generalize “nearest link baseline” per branch.
- **Relation to other items**: multi-seed support interacts with **multi-browser concurrency** (shared queue vs races) and with **indexes** (e.g. `Map<stateHash, CrawlState>`) for fast merge detection.

### ~~robots.txt and sitemap.xml (discovery & extra seeds)~~

> **Done (SCAN-229):** `src/crawler/seedDiscovery.ts` handles robots.txt per RFC 9309 and sitemaps plus sitemap indexes through cheerio's XML mode, with every limit capped. Fetches go through the crawl's own page, so they reuse the proxy, TLS trust and cookies. `respectRobots` adds the robots rules to `ScopeMatcher`. Still open: `sitemap.gz`, prioritising by `lastmod`/`priority`, and caching. The notes below are the original analysis.

**Goal:** broaden **starting URL set** using standard site signals: **`robots.txt`** (policy + `Sitemap:` lines) and **`sitemap.xml`** / **sitemap index** (`<loc>` URLs), then feed those URLs into the same **scope** and **crawl pipeline** as `entryPoint` (eventually as **additional seeds** once multi-seed exists, or as a **pre-queue** of `goto` targets).

**Why it matters**

- Many sites expose **large URL lists** only via sitemaps; crawling from a single landing page misses them.
- **`robots.txt`** is the conventional place to list **sitemap locations** and **path rules** (`Allow` / `Disallow`).

**Suggested flow (high level)**

1. **Resolve origin** from configured `entryPoint` (scheme + host + optional port).
2. **Fetch** `https://origin/robots.txt` (with timeouts, redirects, same **proxy** as the browser if configured — TBD).
3. **Parse robots.txt** (line-based; handle `User-agent: *` vs specific bots; collect **`Sitemap:`** absolute URLs).
4. **Fetch sitemaps:** union of (a) URLs from robots, (b) optional default **`/sitemap.xml`** if not already listed, (c) optional config override list.
5. **Parse XML:** support **sitemap index** (`<sitemap><loc>`) → recursively fetch child sitemaps up to a **max depth / max URLs**; **urlset** sitemaps → collect `<url><loc>` (and optionally lastmod/changefreq for prioritization later).
6. **Normalize & dedupe** URLs (strip fragments, canonicalize trailing slash policy if needed).
7. **Filter** with existing **`inContext` / `includeRegexes` / `excludeRegexes`** (same rules as navigation).
8. **Merge** into crawl: **seed queue** or **additional entry points** (depends on multi-seed design); cap total seeds (**`maxSeedUrls`**) to avoid exploding scope.

**robots.txt path rules vs crawling**

- **Honor robots (recommended default for production):** treat `Disallow` paths as **out of scope** for automated requests (aligns with common expectations; still not a legal substitute for terms of service).
- **Override for authorized testing:** config flag **`respectRobots: boolean`** (e.g. `false` only in lab/bounty programs where you have permission).
- **Clarify interaction** with today’s **403** on out-of-scope navigation: robots-derived rules should **feed the same** “allowed URL” predicate so behavior is consistent.

**Design decisions to lock before implementation**

| Topic | Options / notes |
|--------|-------------------|
| **HTTP client** | `fetch` (Node 18+), or `https` with proxy support matching Puppeteer proxy. |
| **XML parsing** | Lightweight: `fast-xml-parser` or similar; avoid loading **multi‑GB** sitemaps into memory — **streaming** or **chunked read** + caps. |
| **Limits** | `maxSitemapUrls`, max redirect hops, max sitemap index recursion, per-host rate limit. |
| **Auth** | Same host as `entryPoint` may need cookies — **first version** can skip authenticated sitemap fetch or reuse a **session** only if already implemented. |
| **Ordering** | Random shuffle vs sitemap order vs **priority** field (if extended later). |
| **Caching** | Optional TTL cache of robots/sitemap bodies to avoid refetch every run. |

**Risks / edge cases**

- **Huge** sitemaps (news, e-commerce) — must **cap** and **sample** or **prioritize** explicitly.
- **Non-standard** or **broken** XML; **internationalized** URLs; **sitemap.gz**.
- **Cross-origin** `Sitemap:` URLs — decide allow/deny.
- **JS-only** discovery — out of scope; sitemaps are **static HTTP** artifacts.

**Relation to other backlog items**

- Ties directly to **multiple seed URLs** (same graph / frontier questions).
- **Concurrency:** seed URL list may be **sharded** across workers once multi-browser is safe.

---

## Concurrency

- **Multiple browser instances** share one **`CrawlStateManager`** and call **`getNextCrawlAction`** without synchronization (documented in CLAUDE.md; popping from the shared frontier is the only coordination) — risk of **races** (duplicate work, skipped actions, corrupted `visitedActions`). Mitigations: single consumer, locked queue, partitioned managers per worker, or documented single-browser mode.

---

## Performance hotspots

- **`findNodesWithClickListeners`**: walks **all DOM nodes** and inspects listeners — very expensive on large pages. Consider scoping (e.g. visible subtree, interactive tags only), different heuristics, or throttling.
- ~~**`stripDOM`**: per-element checks against **all** interactable CSS paths~~ — **Done (SCAN-85):** a four-pass mark-and-sweep in `DomStripper`, about 13x faster on the fixture corpus, with its output pinned by the golden test.
- ~~**`getCrawlActions`** / **`page.$eval`**~~ — **Done:** batched **`page.evaluate`** (`batchFetchActionNodeSnapshots`), **per-path try/catch** in the page so one bad selector does not fail the chunk; **chunk size** `BATCH_ACTION_SELECTOR_CHUNK_SIZE` (100) per round-trip.

### Out-of-scope link pruning (`<a href>` before crawl actions)

**Problem:** `getCrawlActions` can add **click** actions for **anchors** whose **`href`**, once followed, would navigate to a URL that **`inContext()`** would already reject (403 interception, scope rules). That wastes **frontier slots**, **action hashes**, and **browser work** on navigations that will never count as in-scope.

**Desired behavior:** When the target element is a **link** (typically `A` with an `href` that implies **document navigation**), **resolve** the **absolute URL** the browser would use, then call **`inContext(resolvedUrl)`** (same predicate as request interception). If **out of scope**, **do not** enqueue a `CrawlAction` for that anchor at all.

**Why resolution must be correct**

Scope is checked on **full URLs** (scheme, host, path, query). **`href`** in HTML is often **relative** or **protocol-relative**. The browser resolves using:

1. **Document URL** — the current page’s URL (`location.href` / what you get from Puppeteer as `page.url()` after navigation).
2. **`<base href="...">`** — if present, it **replaces** the base URL for **relative** `href` values (not for absolute URLs). Multiple `<base>` tags: **first** in tree order wins per HTML.
3. Same rules as **`new URL(href, base)`** in the Web platform (WHATWG URL Standard), aligned with how Chromium resolves before navigation.

If you compare **`inContext`** against a **wrong** string (e.g. raw `href="./x"` without base), you may **drop** in-scope links or **keep** out-of-scope ones.

**Suggested implementation shape**

- Extend the **batched page evaluate** (or a dedicated pass for `a[href]`) to return, per candidate anchor: **resolved absolute URL** as the browser would (e.g. `new URL(el.getAttribute('href') ?? '', document.baseURI).href` or equivalent), **or** a sentinel for **non-navigating** links.
- In Node, **`inContext(resolved)`** → skip action if false.
- Reuse the same **precompiled regex** idea as in *Security & hygiene* for hot paths.

**Edge cases & special URLs**

| Case | Notes |
|------|--------|
| **Relative** `href` (`/path`, `./x`, `../x`) | Must use **document base** = `page.url()` adjusted for **`<base>`**. |
| **`<base href>`** | Required for correct resolution on sites that use a base; **first** base element wins. |
| **Protocol-relative** `//host/path` | Resolves to **current page’s scheme** (https/http). |
| **Fragment-only** `href="#foo"` | Resolved URL is typically **same document** + fragment; usually in-scope if the page is; avoid treating as “external” incorrectly. |
| **`javascript:`**, **`mailto:`**, **`tel:`**, **`data:`** | Not normal HTTP navigations; **do not** classify with HTTP scope alone — **skip** pruning or mark **non-nav** (still may want a click for JS-driven behavior). |
| **Empty / missing `href`** | Often **same-page** behavior; treat carefully (may still need click). |
| **`target="_blank"`** + `rel` | Does not change **resolved** URL for scope; **window open** behavior is separate. |
| **`download` attribute** | Navigation may still occur; resolution still applies. |
| **Internationalized / IDN** | Compare using **normalized** URLs (punycode) if mixing encoded forms. |

**SPA / JS-heavy caveat**

Some “buttons” use **`href="#"`** or **`javascript:void(0)`** and rely on **click handlers** for real navigation. **Blindly** skipping all `javascript:` links may reduce coverage. Mitigation: only apply **strict** pruning when **`href` clearly resolves** to an **HTTP(S)** URL that is out of scope; keep ambiguous cases as today (still add action) or use **configurable** strictness.

**Relation to other items**

- Aligns with **include/exclude regex** and **request interception** — one **canonical** “is this URL allowed?” helper shared by **interception**, **sitemap seeds**, and **anchor pruning**.
- Depends on knowing **`document.baseURI`** in the **same** document as the link — best resolved **inside the page** to match the browser.

---

## Correctness & maintainability

- ~~**`getCrawlActions` duplicate `if`/`else`~~ — **Fixed:** only the **`isCrawlActionUnique`** branch adds a `CrawlAction` and **`registerActionSignature`**; duplicates are skipped (see `crawler.ts` ~361–364).
- ~~**Dual Joi sources**~~ — **Done (SCAN-89):** `maxActionRetries` is declared in both layers, and `tests/config/schemaDrift.test.ts` fails on any key declared in only one. Original note: `src/config/configSchema.ts` vs `src/models/configModel.ts` can **drift**. The CLI uses **`ConfigValidator`** from **`configModel`**. **`maxActionRetries`** exists in schema/config JSON but may be **missing** from `configModel`’s crawler schema — with **`stripUnknown: true`**, the field might be **stripped** at validation (runtime still defaults via `?? 3`).
- **`types/crawler.ts`**: **`CrawlStateManagerInterface`** describes a **Map-based** manager that does **not** match **`CrawlStateManager`** in `crawlStateManager.ts` — misleading for contributors and tools.

---

## Robustness

- **Selectors** are fragile when class names or DOM order change; neighbor+tag hashing mitigates but does not solve all SPA churn.
- **`authenticator.ts`**: synchronous file read + `JSON.parse` — acceptable for small files; clearer errors for missing/invalid recordings would help operators.
- ~~**`stopCrawling`**: currently empty~~ — **Done:** it aborts an `AbortController` that the crawl loop and every retry loop check, and closes the active browsers.

---

## Security & hygiene

- **`CrawlInput.VALUES`**: hard-coded placeholder strings (including password-like values) — ensure these are never treated as real secrets; prefer **config/env** for controlled test data in serious deployments.
- ~~**`inContext`**: builds `new RegExp(...)` inside hot paths~~ — **Done (SCAN-87):** `ScopeMatcher` compiles each pattern once and caches it by source.

---

## Engineering cleanup

- ~~**`domPath.ts`**: duplicated in-page `Step` / path logic~~ — **Won't do:** the file is ported from Chromium DevTools and treated as vendored (see CLAUDE.md), so it is not refactored.
- ~~**`package.json`** `repository.url`~~ — **Done:** it points at `github.com/karthikuj/sasori`, the canonical remote.

---

## Previously suggested high-impact themes (summary)

1. ~~Index **`stateHash`** (and possibly action keys) for fast lookup.~~ **Done.**
2. ~~Align **Joi / `ConfigValidator`** so optional crawler fields are not accidentally stripped.~~ **Done (SCAN-89).**
3. **Document or fix** multi-browser + shared manager semantics.
4. Revisit cost of **`[click]`** / CDP-based listener discovery on large DOMs.
5. ~~Support **multiple seed URLs**~~ **Done:** (see *Multiple seed URLs* under graph algorithms) — config + manager + replay semantics. **(SCAN-229)**
6. ~~**robots.txt + sitemap.xml** discovery~~ **Done:** (see subsection under graph algorithms): fetch/parse, merge with `entryPoint`, scope filters, optional `respectRobots`, limits and proxy alignment. **(SCAN-229)**
7. **Out-of-scope link pruning** (see *Out-of-scope link pruning* under Performance): resolve `href` with **document URL** + **`<base>`**, then **`inContext`** — skip crawl actions for anchors that would navigate out of scope; handle **non-HTTP** `href` schemes and SPA edge cases carefully.
