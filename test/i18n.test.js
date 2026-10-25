// SPDX-License-Identifier: Apache-2.0
/* Every text the page uses exists in every language, with the same shape.
 * Run with: node test/i18n.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const LANGS = fs.readdirSync(path.join(SRC, "i18n")).filter(f => f.endsWith(".js")).map(f => f.replace(/\.js$/, ""));
const texts = Object.fromEntries(LANGS.map(l => [l, require(path.join(SRC, "i18n", l + ".js"))]));
const app = ["app.js", "menu-status.js"].concat(fs.readdirSync(path.join(SRC, "app")).filter(f => f.endsWith(".js")).map(f => path.join("app", f)))
    .map(f => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");
const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const libs = ["cron.js", "systemd.js"].map(f => fs.readFileSync(path.join(SRC, "lib", f), "utf8")).join("\n");

let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.message); process.exitCode = 1; }
}

const shape = v => Array.isArray(v) ? "array:" + v.length : typeof v === "function" ? "function:" + v.length
    : v && typeof v === "object" ? "object:" + Object.keys(v).sort().join(",") : typeof v;

t("languages", () => assert.deepStrictEqual(LANGS.sort(), ["de", "en"]));
t("every language file is loaded by the page", () => LANGS.forEach(l => assert.ok(html.includes(`<script src="i18n/${l}.js"></script>`), l)));

for (const part of ["ui", "schedule"]) {
    const keys = Object.keys(texts.en[part]).sort();
    LANGS.forEach(l => t(`${l}.${part} has the same keys and shapes as en`, () => {
        const mine = Object.keys(texts[l][part]).sort();
        const optional = part === "schedule" ? ["dowName"] : [];
        assert.deepStrictEqual(mine.filter(k => !optional.includes(k)), keys.filter(k => !optional.includes(k)));
        mine.forEach(k => assert.strictEqual(shape(texts[l][part][k]), shape(texts.en[part][k]), k));
    }));
}

const used = new Set();
(app.match(/\bT\.([A-Za-z]+)/g) || []).forEach(m => used.add(m.slice(2)));
(html.match(/data-t(?:-label)?="([A-Za-z]+)"/g) || []).forEach(m => used.add(/"(.*)"/.exec(m)[1]));
t("every ui text the page uses exists", () => {
    LANGS.forEach(l => used.forEach(k => assert.ok(k in texts[l].ui, `${l}: ${k}`)));
});
t("no unused ui texts", () => {
    const unused = Object.keys(texts.en.ui).filter(k => !used.has(k));
    assert.deepStrictEqual(unused, []);
});

const usedS = new Set();
(app + libs).replace(/\bS\.([A-Za-z]+)/g, (_, k) => usedS.add(k));
["afterBoot", "afterStartup", "afterActivation", "afterLastStart", "afterLastEnd"].forEach(k => usedS.add(k));
t("every schedule text used exists", () => {
    LANGS.forEach(l => usedS.forEach(k => {
        if (k === "dowName") return;
        assert.ok(k in texts[l].schedule, `${l}: ${k}`);
    }));
});

t("functions return strings", () => {
    LANGS.forEach(l => ["ui", "schedule"].forEach(part => Object.entries(texts[l][part]).forEach(([k, v]) => {
        if (typeof v !== "function") return;
        const args = Array.from({ length: v.length }, (_, i) => "x" + i);
        assert.strictEqual(typeof v.apply(null, args), "string", `${l}.${k}`);
    })));
});

t("code marks come in pairs", () => {
    LANGS.forEach(l => Object.entries(texts[l].ui).forEach(([k, v]) => {
        const s = typeof v === "function" ? v.apply(null, Array.from({ length: v.length }, () => "1")) : v;
        if (typeof s !== "string") return;
        assert.strictEqual((s.match(/`/g) || []).length % 2, 0, `${l}.${k}`);
    }));
});

/* The line the hint on cron's log gives for systemd, read as systemd reads Environment=: words
   split at spaces outside double quotes, the quotes removed. It must set EXTRA_OPTS to all of
   "-L 15"; unquoted, systemd sets "-L" alone and cron does not start. */
t("the hint's line for systemd sets the whole option", () => {
    LANGS.forEach(l => {
        const line = (texts[l].ui.cronLogHintBody.match(/`(Environment=[^`]*)`/) || [])[1];
        assert.ok(line, l);
        const words = (line.slice("Environment=".length).match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(w => w.replace(/"/g, ""));
        assert.deepStrictEqual(words, ["EXTRA_OPTS=-L 15"], l);
    });
});

/* The notice that PAM refuses cron's jobs: the users with PAM's reasons and when go in unchanged,
   and it says where to look (crond's journal) and what is a common cause, as code. */
t("the notice on PAM refusing jobs names who, why, when and where to look", () => {
    LANGS.forEach(l => {
        const ui = texts[l].ui;
        const who = ui.pamRefusedUser("root", "Critical error - immediate abort");
        assert.strictEqual(who, "root (Critical error - immediate abort)", l);
        const body = ui.pamRefusedBody(who + " " + ui.pamRefusedMore(3), "WHEN");
        assert.ok(body.includes(who + " ") && body.includes("WHEN"), l + ": " + body);
        assert.ok(body.includes("`journalctl -t crond`") && body.includes("`/etc/environment`") && body.includes("`export`"), l);
        assert.ok(ui.pamRefusedMore(3).includes("3") && ui.pamRefusedMore(1).includes("1") &&
                  ui.pamRefusedMore(1) !== ui.pamRefusedMore(3).replace("3", "1"), l + ": one and more");
    });
});

/* Where cron opens a logind session for each job, the run dialog and the conversion name it with
   the variables run now and a unit do not get (C.cronEnvModel); the end-to-end test looks for
   "logind". */
t("the notes on cron's logind session name it and its variables", () => {
    LANGS.forEach(l => ["runLogind", "convLogind"].forEach(k => {
        const s = texts[l].ui[k];
        assert.ok(/logind/.test(s) && s.includes("`XDG_SESSION_ID`") && s.includes("`XDG_RUNTIME_DIR`"), `${l}.${k}`);
    }));
});

t("locales", () => {
    assert.strictEqual(texts.de.locale, "de-DE");
    assert.strictEqual(texts.en.locale, "en-US");
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
