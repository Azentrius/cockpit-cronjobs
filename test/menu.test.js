// SPDX-License-Identifier: Apache-2.0
/* Tests for the status icon in Cockpit's menu (src/menu-status.js) and for the places the status
 * links to (link() in status/cronjobs-status, PLACES in src/app/tabs.js), in Node without a
 * browser: the icon as the Status Board judges the status (never better than an item, an item
 * out of date a warning), its tooltip in English and German, the file of the page's language, and
 * every link of the status a place of the page with an element to scroll to.
 * test/ui_test.py checks the same in the browser. Run with: node test/menu.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src");
const MENU = fs.readFileSync(path.join(SRC, "menu-status.js"), "utf8");
const I18N = ["en", "de"].map(l => fs.readFileSync(path.join(SRC, "i18n", l + ".js"), "utf8")).join("\n");
const NOW = Date.parse("2026-10-20T10:00:00Z");
let passed = 0;
const pending = [];
function t(name, fn) {
    pending.push(Promise.resolve().then(fn).then(() => { passed++; },
        e => { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }));
}

/* menu-status.js in a window of its own: { statusOf, reads, notes, shown, cockpit }. */
function load({ language = "de", cookie = "", hidden = false, files = {} } = {}) {
    const reads = [], notes = [], timers = [];
    const listeners = [];
    const cockpit = {
        language, hidden,
        file: p => ({ read: () => { reads.push(p); return Promise.resolve(p in files ? files[p] : null); } }),
        transport: { wait: cb => cb(), control: (c, o) => notes.push([c, JSON.parse(JSON.stringify(o))]) },
        addEventListener: (type, f) => { if (type === "visibilitychange") listeners.push(f); },
        removeEventListener: (type, f) => { const k = listeners.indexOf(f); if (k >= 0) listeners.splice(k, 1); },
    };
    const window = {
        cockpit,
        localStorage: { getItem: () => null },
        setInterval: (fn, ms) => timers.push(["interval", ms]),
        setTimeout: (fn, ms) => timers.push(["timeout", ms]),
    };
    window.window = window;
    window.self = window;
    window.document = { cookie };
    /* The script's clock is NOW, as the documents below are: with the real clock they would turn
       out of date an hour after NOW. */
    window.Date = class extends Date {};
    window.Date.now = () => NOW;
    const ctx = vm.createContext(window);
    vm.runInContext(I18N, ctx);
    vm.runInContext(MENU, ctx);
    const M = ctx.CronJobsMenuStatus;
    return { statusOf: (doc, now) => JSON.parse(JSON.stringify(M.statusOf(doc, now === undefined ? NOW : now))), M, reads, notes,
             timers, cockpit, hint: h => { cockpit.hidden = h; listeners.slice().forEach(f => f()); } };
}

const at = minutes => new Date(NOW - minutes * 60000).toISOString().replace(/\.\d+Z$/, "Z");
function doc(state, summary, items) {
    return { schema: 1, addon: "cronjobs", label: "Cron Jobs", checked_at: at(1), state, summary, items };
}
const item = (id, state, ago = 1, more = {}) => Object.assign({ id, state, title: id, detail: id, checked_at: at(ago), stale_after: 3600 }, more);

t("states as Cockpit's page status types; ok and none: no icon", () => {
    const m = load();
    assert.deepStrictEqual(m.statusOf(doc("danger", "1 Job ist fehlgeschlagen.", [item("failed", "danger")])),
                           { type: "error", title: "1 Job ist fehlgeschlagen." });
    assert.deepStrictEqual(m.statusOf(doc("warning", "W.", [item("cron", "warning")])), { type: "warning", title: "W." });
    assert.deepStrictEqual(m.statusOf(doc("info", "I.", [item("x", "info")])), { type: "info", title: "I." });
    assert.strictEqual(m.statusOf(doc("ok", "Alles gut.", [item("failed", "ok"), item("cron", "ok")])), null);
    assert.strictEqual(m.statusOf(doc("none", "Noch kein Status.", [])), null);
});

t("never better than an item, as the Status Board", () => {
    const m = load();
    assert.deepStrictEqual(m.statusOf(doc("ok", "S.", [item("failed", "ok"), item("cron", "danger")])), { type: "error", title: "S." });
    assert.deepStrictEqual(m.statusOf(doc("info", "S.", [item("a", "info"), item("b", "warning")])), { type: "warning", title: "S." });
});

t("an item older than its stale_after: at least a warning, the tooltip says since when", () => {
    const de = load(), en = load({ language: "en" });
    const old = doc("ok", "Kein Job ist fehlgeschlagen.", [item("failed", "ok", 61), item("cron", "ok", 61)]);
    const when = new Date(Date.parse(at(61))).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
    assert.deepStrictEqual(de.statusOf(old), { type: "warning", title: `Kein Job ist fehlgeschlagen. (Stand ${when}, veraltet)` });
    const whenEn = new Date(Date.parse(at(61))).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
    assert.deepStrictEqual(en.statusOf(Object.assign({}, old, { summary: "No job failed." })),
                           { type: "warning", title: `No job failed. (as of ${whenEn}, out of date)` });
    assert.strictEqual(de.statusOf(doc("ok", "S.", [item("failed", "ok", 59)])), null, "59 minutes: not yet");
    const failed = de.statusOf(doc("danger", "1 Job.", [item("failed", "danger", 120)]));
    assert.strictEqual(failed.type, "error", "a danger stays a danger when out of date");
    assert.ok(failed.title.startsWith("1 Job. (Stand ") && failed.title.endsWith(", veraltet)"), failed.title);
    /* the oldest item names the time */
    const two = de.statusOf(doc("ok", "S.", [item("a", "ok", 200), item("b", "ok", 90)]));
    assert.ok(two.title.includes(new Date(Date.parse(at(200))).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })), two.title);
});

t("what the board ignores is ignored: no zone, no stale_after, odd values", () => {
    const m = load();
    assert.strictEqual(m.statusOf(doc("ok", "S.", [item("a", "ok", 600, { checked_at: "2026-10-20T00:00:00" })])), null, "no zone");
    assert.strictEqual(m.statusOf(doc("ok", "S.", [item("a", "ok", 600, { stale_after: undefined })])), null, "no stale_after");
    assert.strictEqual(m.statusOf(doc("ok", "S.", [item("a", "ok", 600, { stale_after: "3600" })])), null, "stale_after as text");
    assert.strictEqual(m.statusOf(doc("ok", "S.", [null, 3, item("a", "bad")])), null, "odd items");
    assert.strictEqual(m.statusOf(Object.assign(doc("danger", "S.", []), { schema: 2 })), null, "another schema");
    assert.strictEqual(m.statusOf(Object.assign(doc("danger", "S.", []), { items: "x" })), null, "no list of items");
    [null, 3, "x", []].forEach(d => assert.strictEqual(m.statusOf(d), null, JSON.stringify(d)));
    assert.strictEqual(m.statusOf(doc("danger", "x".repeat(300), [])).title.length, 200, "the summary cut as the board cuts it");
    assert.deepStrictEqual(m.statusOf(doc("danger", 42, [])), { type: "error", title: "" }, "no summary text");
});

t("the file of the page's language, read and sent once, then every five minutes", async () => {
    const files = { "/var/lib/cockpit-cronjobs/status.de.json": JSON.stringify(doc("danger", "1 Job.", [item("failed", "danger")])) + "\n",
                    "/var/lib/cockpit-cronjobs/status.json": JSON.stringify(doc("danger", "1 job.", [item("failed", "danger")])) + "\n" };
    for (const [opts, file, title] of [[{ language: "de" }, "status.de.json", "1 Job."], [{ language: "en" }, "status.json", "1 job."],
                                        [{ language: "fr" }, "status.json", "1 job."], [{ language: "de-AT" }, "status.de.json", "1 Job."],
                                        [{ language: "de", cookie: "CockpitLang=en-us" }, "status.json", "1 job."],
                                        [{ language: "en", cookie: "x=1; CockpitLang=de-de" }, "status.de.json", "1 Job."]]) {
        const m = load(Object.assign({ files }, opts));
        await new Promise(r => setImmediate(r));
        assert.deepStrictEqual(m.reads, ["/var/lib/cockpit-cronjobs/" + file], JSON.stringify(opts));
        assert.deepStrictEqual(m.notes, [["notify", { page_status: { type: "error", title } }]], JSON.stringify(opts));
        assert.deepStrictEqual(m.timers.filter(x => x[0] === "interval"), [["interval", 300000]]);
    }
    const none = load();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(none.notes, [["notify", { page_status: null }]], "no file: no icon, but sent");
    const broken = load({ files: { "/var/lib/cockpit-cronjobs/status.de.json": "{broken" } });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(broken.notes, [["notify", { page_status: null }]], "unreadable: no icon");
});

t("the page starts when it is shown: at once, or after the shell's hint", async () => {
    let started = false;
    const open = load();
    open.M.shown.then(() => { started = true; });
    await new Promise(r => setImmediate(r));
    assert.ok(started, "opened directly: started after the first answer");
    started = false;
    const pre = load({ hidden: true });
    pre.M.shown.then(() => { started = true; });
    await new Promise(r => setImmediate(r));
    assert.ok(!started, "preloaded hidden: not started");
    pre.hint(false);
    await new Promise(r => setImmediate(r));
    assert.ok(started, "shown: started");
});

/* ---------- the places the status links to ---------- */

t("every link of the status is a place of the page, with an element to scroll to", () => {
    const helper = fs.readFileSync(path.join(__dirname, "..", "status", "cronjobs-status"), "utf8");
    const body = /\nlink\(\) \{\n([\s\S]*?)\n\}\n/.exec(helper)[1];
    const links = {};
    body.replace(/^\s+([a-z0-9-]+)\) printf '([^']*)' ;;$/gm, (_, id, link) => { links[id] = link; });
    assert.deepStrictEqual(links, { failed: "#/overview/results", unrecorded: "#/overview/crontab", cron: "#/overview/notices" });
    const tabs = fs.readFileSync(path.join(SRC, "app", "tabs.js"), "utf8");
    const PLACES = new Function("return " + /\nconst PLACES = (\{[\s\S]*?\n\});\n/.exec(tabs)[1])();
    const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
    Object.keys(PLACES).forEach(tab => {
        assert.ok(html.includes(`id="tab-${tab}"`), "a tab " + tab);
        Object.values(PLACES[tab]).forEach(id => assert.ok(html.includes(`id="${id}"`), "an element " + id));
    });
    Object.values(links).forEach(link => {
        assert.ok(/^#\/[A-Za-z0-9/_-]{0,80}$/.test(link), "as the Status Board takes it: " + link);
        const [tab, part] = link.slice(2).split("/");
        assert.ok(Object.prototype.hasOwnProperty.call(PLACES, tab), link + ": a tab");
        assert.ok(Object.prototype.hasOwnProperty.call(PLACES[tab], part), link + ": a place in it");
    });
});

Promise.all(pending).then(() => console.log(`${passed} passed`));
