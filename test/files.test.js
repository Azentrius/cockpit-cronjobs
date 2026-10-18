// SPDX-License-Identifier: Apache-2.0
/* The stylesheets take every file from the page itself: each url() in src/*.css names a file
 * inside src/, so nothing depends on what Cockpit happens to ship (Ubuntu's Cockpit has no
 * Red Hat Mono under /cockpit/static/fonts/). Run with: node test/files.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }
}

function urls(css) {
    return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)].map(m => m[2]);
}

const sheets = fs.readdirSync(SRC).filter(f => f.endsWith(".css"));

t("the page has stylesheets", () => {
    assert.ok(sheets.includes("azentrius.css"), "azentrius.css in src/");
});

for (const sheet of sheets) {
    const css = fs.readFileSync(path.join(SRC, sheet), "utf8");
    for (const u of urls(css)) {
        t(sheet + ": " + u, () => {
            if (u.startsWith("data:")) return;
            assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith("/"), "a relative path, not " + u);
            const file = path.resolve(SRC, u);
            assert.ok(file.startsWith(SRC + path.sep), u + " stays inside src/");
            assert.ok(fs.statSync(file).isFile(), u + " exists");
        });
    }
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
    faces.forEach(face => {
        const family = (/font-family:\s*(["']?)([^"';]+)\1/.exec(face) || [])[2];
        t(sheet + ": @font-face " + family, () => {
            assert.ok(family, "a family");
            assert.ok(urls(face).length > 0, family + " has a file of its own");
        });
    });
}

t("the url() parser", () => {
    assert.deepStrictEqual(urls('a { src: url("A.woff2") } /* url(x.png) */ b { background: url(b.png) url( \'c d.svg\' ) }'),
        ["A.woff2", "b.png", "c d.svg"]);
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
