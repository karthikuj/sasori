#!/usr/bin/env node
/**
 * Regenerates the synthetic fixtures in this directory.
 *
 * The hand-written `case-*.html` and the fetched `real-*.html` files are edited
 * by hand and are NOT touched here; only `synth-*.html` is generated. They exist
 * because `stripDOM`'s cost is driven by DOM *depth*, not element count, and no
 * real page in the corpus is deep enough to show that. Keeping the generator in
 * the repo means the depth curve can be re-measured on identical input later.
 *
 * Usage: node tests/fixtures/stripdom/generate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A flat page: one container holding `count` sibling blocks, a fixed fraction of
 * which are interactable.
 * @param {number} count Number of sibling blocks.
 * @return {string} HTML document.
 */
function flat(count) {
    const parts = [];
    for (let i = 0; i < count; i++) {
        if (i % 4 === 0) {
            parts.push(`<div class="row r${i}" data-idx="${i}"><a href="/item/${i}" title="item ${i}">Item ${i}</a></div>`);
        } else if (i % 4 === 1) {
            parts.push(`<div class="row r${i}"><span class="label">Label ${i}</span><em>text ${i}</em></div>`);
        } else if (i % 4 === 2) {
            parts.push(`<div class="row r${i}"><input type="text" name="f${i}" placeholder="p${i}"></div>`);
        } else {
            parts.push(`<div class="row r${i}"><p>paragraph ${i} <!-- c${i} --></p></div>`);
        }
    }
    return `<!DOCTYPE html><html><head><title>flat ${count}</title></head><body><main id="root">${parts.join('')}</main></body></html>`;
}

/**
 * A deep page: a single chain of `depth` nested divs with an interactable leaf,
 * plus a little sibling noise at each level so the tree is not a bare list.
 * @param {number} depth Nesting depth of the chain.
 * @return {string} HTML document.
 */
function deep(depth) {
    let inner = '<a href="/leaf" class="leaf">leaf</a><input type="submit" value="go">';
    for (let d = depth; d > 0; d--) {
        inner = `<div class="d${d}" data-depth="${d}"><span>noise ${d}</span>${inner}</div>`;
    }
    return `<!DOCTYPE html><html><head><title>deep ${depth}</title></head><body><main id="root">${inner}</main></body></html>`;
}

const here = __dirname;
const files = {
    'synth-flat-400.html': flat(400),
    'synth-flat-2400.html': flat(2400),
    'synth-deep-2.html': deep(2),
    'synth-deep-40.html': deep(40),
    'synth-deep-80.html': deep(80),
};

for (const [name, html] of Object.entries(files)) {
    fs.writeFileSync(path.join(here, name), html + '\n');
    console.log(`wrote ${name} (${html.length} bytes)`);
}
