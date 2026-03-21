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
DIST_DIR   := ./dist
CLI_ENTRY  := $(DIST_DIR)/bin/index.js
NPM        := npm
NODE       := node

# Version / build metadata (for banners and release notes)
VERSION    := $(shell git describe --tags --always --dirty 2>/dev/null || node -p "require('./package.json').version" 2>/dev/null || echo "dev")
COMMIT     := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME := $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

# Defaults for `make run-cli` / `make run-api`
CONFIG     ?= config/config.json
HOST       ?= 0.0.0.0
PORT       ?= 8080

# ─── Phony targets ─────────────────────────────────────────
.PHONY: help check-tools install ci \
        build build-watch clean \
        run run-cli run-api \
        lint type-check format \
        test test-watch test-coverage test-ci \
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

run-api: build ## Start REST API server (override HOST= PORT= on the command line)
	@$(NODE) $(CLI_ENTRY) api --host "$(HOST)" --port "$(PORT)"

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
