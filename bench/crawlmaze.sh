#!/usr/bin/env bash
#
# Timed crawl of Google's Security Crawl Maze (https://security-crawl-maze.app/).
#
# The maze is a public testbed whose whole purpose is to link resources in every
# way a valid HTML document can, so it exercises the crawler's discovery paths
# far more evenly than any single real site. We use it as the repo's end-to-end
# performance and coverage gate: a change may make the crawl faster, but it must
# not make it find less.
#
# Usage: bench/crawlmaze.sh <label>
#   e.g. bench/crawlmaze.sh before
#
# Writes bench/results/<label>.{json,urls,log} and prints wall time plus the
# endpoint / state / request counts.
set -euo pipefail

LABEL="${1:-run}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/bench/results"
mkdir -p "${OUT}"

# BENCH_CONFIG swaps in a variant, e.g. bench/crawlmaze.sitemap.config.json to
# measure sitemap/robots seed discovery (SCAN-229). Default is the plain crawl.
CONFIG="${BENCH_CONFIG:-${ROOT}/bench/crawlmaze.config.json}"
INVENTORY="${OUT}/${LABEL}.json"
URLS="${OUT}/${LABEL}.urls"
LOG="${OUT}/${LABEL}.log"

if [ ! -f "${ROOT}/dist/bin/index.js" ]; then
    echo "dist/ is missing — run 'make build' first." >&2
    exit 1
fi

echo "[bench] crawling security-crawl-maze.app (label: ${LABEL}, config: ${CONFIG})"

START=$(date +%s%3N)
node "${ROOT}/dist/bin/index.js" start \
    --config "${CONFIG}" \
    --output "${URLS}" \
    --inventory "${INVENTORY}" >"${LOG}" 2>&1
END=$(date +%s%3N)

ELAPSED_MS=$(( END - START ))

node -e '
const fs = require("fs");
const [inv, urls, elapsedMs, label] = process.argv.slice(1);
const i = JSON.parse(fs.readFileSync(inv, "utf-8"));
const urlCount = fs.readFileSync(urls, "utf-8").split("\n").filter(Boolean).length;
const row = {
    label,
    seconds: Number((Number(elapsedMs) / 1000).toFixed(1)),
    endpoints: i.stats.endpoints,
    states: i.stats.states,
    requests: i.stats.requests,
    urls: urlCount,
};
console.log("");
console.log("  label      " + row.label);
console.log("  wall time  " + row.seconds + "s");
console.log("  endpoints  " + row.endpoints);
console.log("  states     " + row.states);
console.log("  requests   " + row.requests);
console.log("  urls       " + row.urls);
console.log("");
fs.writeFileSync(inv.replace(/\.json$/, ".summary.json"), JSON.stringify(row, null, 2) + "\n");
' "${INVENTORY}" "${URLS}" "${ELAPSED_MS}" "${LABEL}"
