#!/usr/bin/env bash
#
# Diffs two crawlmaze runs recorded by bench/crawlmaze.sh.
#
# The rule this enforces is the one that makes the benchmark worth running:
# time may go down, but coverage must not. A "faster" crawler that visits less
# is not faster, it is broken — and endpoint count is the crawler's own answer
# to how much attack surface it handed the scanner.
#
# Usage: bench/crawlmaze-compare.sh [before-label] [after-label]
set -euo pipefail

BEFORE="${1:-before}"
AFTER="${2:-after}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/bench/results"

for label in "${BEFORE}" "${AFTER}"; do
    if [ ! -f "${OUT}/${label}.summary.json" ]; then
        echo "Missing ${OUT}/${label}.summary.json — run: make bench-crawlmaze LABEL=${label}" >&2
        exit 1
    fi
done

node -e '
const fs = require("fs");
const [dir, beforeLabel, afterLabel] = process.argv.slice(1);
const read = (l) => JSON.parse(fs.readFileSync(`${dir}/${l}.summary.json`, "utf-8"));
const b = read(beforeLabel);
const a = read(afterLabel);

const pad = (s, n) => String(s).padStart(n);
const rows = [
    ["wall time (s)", b.seconds, a.seconds, "lower"],
    ["endpoints", b.endpoints, a.endpoints, "higher"],
    ["states", b.states, a.states, "higher"],
    ["requests", b.requests, a.requests, "higher"],
    ["urls", b.urls, a.urls, "higher"],
];

console.log("");
console.log("  " + "metric".padEnd(16) + pad(beforeLabel, 12) + pad(afterLabel, 12) + pad("change", 12));
console.log("  " + "-".repeat(52));
let failed = false;
for (const [name, before, after, want] of rows) {
    const delta = after - before;
    const pct = before === 0 ? 0 : (delta / before) * 100;
    const sign = delta > 0 ? "+" : "";
    console.log("  " + name.padEnd(16) + pad(before, 12) + pad(after, 12) + pad(`${sign}${pct.toFixed(1)}%`, 12));
    if (want === "lower" && delta > 0) failed = true;
    if (want === "higher" && delta < 0) failed = true;
}
console.log("  " + "-".repeat(52));

const speedup = a.seconds === 0 ? 0 : b.seconds / a.seconds;
console.log(`  speedup: ${speedup.toFixed(2)}x`);
console.log("");
if (failed) {
    console.log("  FAIL: time went up, or coverage went down.");
    process.exitCode = 1;
} else {
    console.log("  PASS: faster, and coverage held or improved.");
}
' "${OUT}" "${BEFORE}" "${AFTER}"
