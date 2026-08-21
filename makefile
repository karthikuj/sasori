# ─────────────────────────────────────────────────────────────
#  Sasori (sasori-crawl) — Makefile
#  Node.js / TypeScript crawler (Puppeteer). Delegates to npm scripts.
# ─────────────────────────────────────────────────────────────

# ─── Load .env (optional: tool paths, CI secrets, etc.) ─────
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

# ─── Project config ─────────────────────────────────────────
APP_NAME   := sasori-crawl
PKG_FILE   := ./package.json
DIST_DIR    := ./dist
CLI_ENTRY   := $(DIST_DIR)/bin/index.js
PACKAGE_DIR := ./release
NPM         := npm
NODE        := node

# Version / build metadata (for banners and release notes)
VERSION    := $(shell git describe --tags --always --dirty 2>/dev/null || node -p "require('./package.json').version" 2>/dev/null || echo "dev")
COMMIT     := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME := $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

# Defaults for `make run-cli` / `make run-api`
CONFIG     ?= config/config.json
# Where `make run-crawl` writes the crawl inventory (endpoints and DOM states
# reached). It is what nara-core's coverage benchmark scores, so a crawl worth
# measuring should always be run with one.
INVENTORY  ?= inventory.json
HOST       ?= 0.0.0.0
PORT       ?= 8080

# ─── Phony targets ─────────────────────────────────────────
.PHONY: help check-tools install ci \
        build build-watch clean \
        run run-cli run-api run-crawl \
        package-zip \
        lint type-check format \
        test test-watch test-coverage test-ci \
        bench bench-stripdom bench-crawlmaze bench-crawlmaze-before bench-crawlmaze-after \
        version

.DEFAULT_GOAL := help

# ═════════════════════════════════════════════════════════════
##@ General
# ═════════════════════════════════════════════════════════════

help: ## Display this help screen
	@echo ""
	@echo "  \033[1m$(APP_NAME)\033[0m — Makefile"
	@echo "  version \033[33m$(VERSION)\033[0m  commit \033[33m$(COMMIT)\033[0m"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf ""} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m  %s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)
	@echo ""

check-tools: ## Verify Node.js and npm are on PATH
	@command -v node >/dev/null 2>&1 && echo "  ✅ node $$(command -v node)" || (echo "  ❌ node not found — install Node.js 18+ (https://nodejs.org/)"; exit 1)
	@command -v npm >/dev/null 2>&1 && echo "  ✅ npm $$(command -v npm)" || (echo "  ❌ npm not found (expected with Node.js)"; exit 1)

version: ## Print package version and git metadata
	@echo "$(APP_NAME) $(VERSION)  commit=$(COMMIT)  built=$(BUILD_TIME)"

install: check-tools ## Install dependencies (npm install)
	@echo "Installing npm dependencies..."
	@$(NPM) install
	@echo "Done."

ci: type-check lint test-ci ## CI pipeline: type-check + lint + test (coverage)

# ═════════════════════════════════════════════════════════════
##@ Build & Run
# ═════════════════════════════════════════════════════════════

build: check-tools ## Compile TypeScript and copy config/ → dist/
	@echo "Building $(APP_NAME)..."
	@$(NPM) run build
	@echo "Built → $(CLI_ENTRY)"

build-watch: check-tools ## TypeScript watch mode (same as npm run dev)
	@$(NPM) run dev

clean: ## Remove dist/ (npm run clean)
	@echo "Cleaning..."
	@$(NPM) run clean
	@echo "Done."

run: build ## Run built CLI with no args (prints yargs help)
	@$(NODE) $(CLI_ENTRY)

run-cli: build ## Run a crawl: CONFIG=path/to/config.json (default: config/config.json)
	@test -f "$(CONFIG)" || (echo "Config not found: $(CONFIG)  (set CONFIG=...)"; exit 1)
	@$(NODE) $(CLI_ENTRY) start --config "$(CONFIG)"

run-crawl: build ## Run a crawl and write the inventory: CONFIG=... INVENTORY=... (default inventory.json)
	@test -f "$(CONFIG)" || (echo "Config not found: $(CONFIG)  (set CONFIG=...)"; exit 1)
	@$(NODE) $(CLI_ENTRY) start --config "$(CONFIG)" --inventory "$(INVENTORY)"
	@echo "Crawl inventory: $(INVENTORY)"

run-api: build ## Start REST API server (override HOST= PORT= on the command line)
	@$(NODE) $(CLI_ENTRY) api --host "$(HOST)" --port "$(PORT)"

package-zip: ## Zip minimal prod bundle for `npm ci` + `npm start` (requires `make build` first)
	@command -v zip >/dev/null 2>&1 || { echo "  ❌ zip NOT found. Install with: sudo apt install zip"; exit 1; }
	@test -f $(CLI_ENTRY) || { echo "  ❌ $(CLI_ENTRY) missing. Run: make build"; exit 1; }
	@test -d $(DIST_DIR)/config || { echo "  ❌ $(DIST_DIR)/config missing (postbuild copy). Run: make build"; exit 1; }
	@test -f package.json || { echo "  ❌ package.json missing"; exit 1; }
	@test -f package-lock.json || { echo "  ❌ package-lock.json missing"; exit 1; }
	@test -f makefile || { echo "  ❌ makefile missing"; exit 1; }
	@mkdir -p $(PACKAGE_DIR)
	@archive="$(PACKAGE_DIR)/$(APP_NAME).zip"; \
	echo "Creating $$archive (dist/, package.json, package-lock.json, makefile) ..."; \
	zip -rq "$$archive" dist package.json package-lock.json makefile; \
	echo "Done → $$archive"; \
	echo "  On server: unzip, then \`npm ci\` (installs node_modules; not in zip)."; \
	echo "  CLI: \`npm start\` or \`node dist/bin/index.js …\`. API e.g. \`npm start -- api --host 0.0.0.0 --port 8080\`."

# ═════════════════════════════════════════════════════════════
##@ Code quality
# ═════════════════════════════════════════════════════════════

lint: check-tools ## ESLint (with --fix per package.json)
	@$(NPM) run lint

type-check: check-tools ## TypeScript --noEmit
	@$(NPM) run type-check

format: lint ## Alias: eslint with fix (project uses eslint for TS)

# ═════════════════════════════════════════════════════════════
##@ Tests
# ═════════════════════════════════════════════════════════════

test: check-tools ## Run Jest test suite
	@$(NPM) test

test-watch: check-tools ## Jest watch mode
	@$(NPM) run test:watch

test-coverage: check-tools ## Jest with coverage report
	@$(NPM) run test:coverage

test-ci: check-tools ## Jest CI mode with coverage (non-interactive)
	@$(NPM) run test:ci

# ═════════════════════════════════════════════════════════════
##@ Benchmarks
# ═════════════════════════════════════════════════════════════
#
# Two levels, because they answer different questions.
#
# `bench-stripdom` measures the crawler's hottest pure-CPU function against a
# fixed fixture corpus. It is fast, deterministic, and the right tool for
# judging a change to DOM stripping — end-to-end crawl time is dominated by the
# browser and the network, which drowns that signal out.
#
# `bench-crawlmaze` crawls Google's Security Crawl Maze, a public testbed built
# to link resources in every way a valid HTML document can. It is the
# end-to-end gate: a change may make the crawl faster, but it must not make it
# find less. Run BEFORE=... and AFTER=... around a change and compare.

bench: bench-stripdom ## Run the fast micro-benchmarks

bench-stripdom: build ## Micro-benchmark DomStripper over the fixture corpus (FILTER= to narrow)
	@$(NODE) $(DIST_DIR)/bench/stripdom.bench.js $(FILTER)

bench-crawlmaze: build ## Timed crawl of security-crawl-maze.app: LABEL=before|after
	@bench/crawlmaze.sh "$(LABEL)"

bench-crawlmaze-before: build ## Record the pre-change crawlmaze baseline
	@bench/crawlmaze.sh before

bench-crawlmaze-after: build ## Record the post-change crawlmaze result and diff it
	@bench/crawlmaze.sh after
	@bench/crawlmaze-compare.sh
