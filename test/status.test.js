// SPDX-License-Identifier: Apache-2.0
/* Tests for the status of Cron Jobs (status/cronjobs-status) with dash and bash, and with each awk
 * there is (mawk on Debian and Ubuntu, gawk on Fedora): the documents follow the shared status
 * format (schema 1), jobs are read as the page reads them (lib/cron.js is the oracle), failed runs
 * as lib/runs.js sees them. Run with: node test/status.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const C = require("../src/lib/cron.js");

const STATUS = path.join(__dirname, "..", "status", "cronjobs-status");
const SRC = path.join(__dirname, "..", "src");
const VERSION = /^ *const VERSION = "(.*)";/m.exec(fs.readFileSync(path.join(SRC, "app.js"), "utf8"))[1];
const WRAP = C.WRAPPER_PATH;
const NOW = Math.floor(Date.now() / 1000);
let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }
}

const SHELLS = ["/bin/dash", "/bin/bash", "/bin/sh"].filter(s => fs.existsSync(s));
/* Each awk on its own: a directory with only "awk" in it, put first in PATH. */
const AWKS = ["mawk", "gawk"].map(a => ["/usr/bin/" + a, "/bin/" + a].find(p => fs.existsSync(p))).filter(Boolean)
    .map(p => {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-awk-"));
        fs.symlinkSync(p, path.join(bin, "awk"));
        return { name: path.basename(p), bin };
    });
if (!AWKS.length) AWKS.push({ name: "awk", bin: null });
/* A user the system knows, other than root, for another user's crontab. */
const OTHER = ["daemon", "nobody", "bin"].find(u => spawnSync("id", ["-u", u]).status === 0);

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-status-"));
    const fx = { base, state: path.join(base, "state"), spool: path.join(base, "spool") };
    fs.mkdirSync(fx.state);
    fs.mkdirSync(fx.spool);
    return fx;
}
function crontab(fx, user, text) {
    fs.writeFileSync(path.join(fx.spool, user), text);
}
/* The runs directory of a job, made, as the recorder keeps it: root's in runs/ID, another
   user's in users/USER/runs/ID. */
function runsDir(fx, user, id) {
    const d = user === "root" ? path.join(fx.state, "runs", id) : path.join(fx.state, "users", user, "runs", id);
    fs.mkdirSync(d, { recursive: true });
    return d;
}
/* A line of runs.jsonl, exactly as cockpit-cronjobs-run writes it. */
function rec(start, rc) {
    if (rc === "aborted")
        return `{"start":${start},"end":null,"rc":null,"trigger":"schedule","bytes":0,"truncated":false,"out":"","aborted":true}`;
    return `{"start":${start},"end":${start + 2},"rc":${rc},"trigger":"schedule","bytes":0,"truncated":false,"out":""}`;
}
function runs(fx, user, id, lines) {
    fs.writeFileSync(path.join(runsDir(fx, user, id), "runs.jsonl"), lines.join("\n") + "\n");
}
function wrapped(id, command) {
    return C.wrapCommand(id, command);
}

function run(sh, awk, fx, args, extra) {
    const env = Object.assign({ PATH: (awk.bin ? awk.bin + ":" : "") + "/usr/bin:/bin" }, extra || {});
    if (fx) Object.assign(env, { CRONJOBS_STATE_DIR: fx.state, CRONJOBS_SPOOL_DIR: fx.spool, CRONJOBS_PAGE_DIR: SRC });
    const r = spawnSync(sh, [STATUS].concat(args), { env, encoding: "utf8" });
    return { rc: r.status, out: r.stdout, err: r.stderr };
}
/* write, then both documents as the files hold them. */
function written(sh, awk, fx) {
    const r = run(sh, awk, fx, ["write"]);
    assert.strictEqual(r.rc, 0, r.err);
    assert.strictEqual(r.out, "");
    const en = fs.readFileSync(path.join(fx.state, "status.json"), "utf8");
    const de = fs.readFileSync(path.join(fx.state, "status.de.json"), "utf8");
    return { en: contract(en), de: contract(de), raw: { en, de } };
}
const item = (doc, id) => doc.items.find(i => i.id === id);

/* ---------- the shared status format, schema 1 ---------- */

const STATES = ["none", "ok", "info", "warning", "danger"];
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/* The overall state from the items: the worst of danger, warning and info; else ok when an item
   is ok; else none. */
function overall(items) {
    for (const s of ["danger", "warning", "info"]) if (items.some(i => i.state === s)) return s;
    return items.some(i => i.state === "ok") ? "ok" : "none";
}

/* Parses one document (one line of JSON) and checks it against the format; returns it. */
function contract(text) {
    assert.ok(/^\{[^\n]*\}\n$/.test(text), "one line of JSON: " + JSON.stringify(text));
    const d = JSON.parse(text);
    assert.strictEqual(d.schema, 1);
    assert.strictEqual(d.addon, "cronjobs");
    assert.strictEqual(d.label, "Cron Jobs");
    if ("version" in d) assert.strictEqual(d.version, VERSION);
    assert.ok(ISO_RE.test(d.checked_at), d.checked_at);
    assert.ok(Math.abs(Date.parse(d.checked_at) / 1000 - NOW) < 600, "checked just now: " + d.checked_at);
    assert.ok(STATES.includes(d.state), d.state);
    assert.ok(typeof d.summary === "string" && /\S/.test(d.summary), "a summary");
    assert.ok(Array.isArray(d.items));
    d.items.forEach(i => {
        assert.ok(/^[a-z0-9-]{1,40}$/.test(i.id), i.id);
        assert.ok(STATES.includes(i.state), i.state);
        assert.ok(typeof i.title === "string" && /\S/.test(i.title));
        if ("value" in i) assert.ok(typeof i.value === "string" && /\S/.test(i.value));
        assert.ok(typeof i.detail === "string" && /\S/.test(i.detail));
        assert.ok(!("link" in i));
        assert.ok(ISO_RE.test(i.checked_at));
        assert.strictEqual(i.stale_after, 3600);
    });
    assert.deepStrictEqual(d.items.map(i => i.id), d.items.length ? ["failed", "unrecorded"] : []);
    assert.strictEqual(d.state, overall(d.items));
    return d;
}

t("the overall state follows the format", () => {
    assert.strictEqual(overall([]), "none");
    assert.strictEqual(overall([{ state: "none" }, { state: "ok" }]), "ok");
    assert.strictEqual(overall([{ state: "ok" }, { state: "info" }]), "info");
    assert.strictEqual(overall([{ state: "warning" }, { state: "danger" }, { state: "ok" }]), "danger");
});

t("the manifest names the helper for the Status Board", () => {
    const m = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
    assert.deepStrictEqual(m.azentrius, { status: ["/usr/lib/cockpit-cronjobs/cronjobs-status", "status"] });
    assert.ok(m.azentrius.status[0].startsWith("/usr/lib/cockpit-") && !m.azentrius.status[0].includes(".."));
});

t("the helper is POSIX sh, executable", () => {
    assert.ok(fs.readFileSync(STATUS, "utf8").startsWith("#!/bin/sh\n"));
    assert.ok(fs.statSync(STATUS).mode & 0o111, "executable");
});

/* Lines the page takes for jobs, or not: enabled or disabled, recorded or not, valid schedules and
   not. The page's parser (C.parseUserCrontab, C.unwrapCommand) says what each one is. */
const LINES = [
    "MAILTO=\"\"", "SHELL = /bin/bash", "FOO=bar 1 2 3 4 5 x", "  # a note", "", "   ",
    "*/5 * * * * /bin/true", "0 3 * * mon-fri /x", "0 0 1 jan,feb sun /x", "0 0 * JAN Sun /x",
    "@daily /x", "@reboot /x", "@weekly", "@DAILY /x", "@every5 /x", "@daily-x /x",
    "61 * * * * /x", "5/10 * * * * /x", "1-5/2 * * * * /x", "* * * * 7 /x", "* * * * 8 /x", "*/0 * * * * /x",
    "1,,2 * * * * /x", "1, * * * * /x", "* * * * *", "* * * * * ", "  \t30 2 * * * /x  ", "30 2 * * *\t/x\r",
    "*-5 * * * * /x", "5-1 * * * * /x", "0-59/15 0-23 1-31 1-12 0-7 /x", "a * * * * /x", "* * 0 * * /x",
    "* * * 13 * /x", "* * 32 * * /x", "007 * * * * /x", "sat-sun * * * * /x", "* * * * sat-sun /x",
    "* * * * sun-sat /x", "* * * jan-dec * /x", "* * * dec-jan * /x", "1/2/3 * * * * /x", "/5 * * * * /x",
    "#[cronjobs:off] * * * * * /off", "#[cronctl:off] * * * * * /off", "# * * * * * /off",
    `* * * * * ${WRAP} job-1 'echo hi'`,
    `* * * * * /opt/x/cockpit-cronjobs-run job-2 'it'\\''s'`,
    `* * * * * ${WRAP} job-3 echo`,
    `* * * * * ${WRAP} job-4 '   '`,
    `* * * * * ${WRAP} job!5 'x'`,
    "* * * * * cockpit-cronjobs-run job-6 'x'",
    "* * * * * /cockpit-cronjobs-run job-7 'x'",
    `* * * * * ${WRAP} ${"a".repeat(65)} 'x'`,
    `* * * * * ${WRAP} ${"b".repeat(64)} 'x'`,
    `* * * * * ${WRAP} job-8 'unterminated`,
    `@hourly ${WRAP} job-9 ''\\'''`,
    `* * * * * ${WRAP} job-10 'a' 'b'`,
    `* * * * * ${WRAP}\tjob-11\t'x'`,
    `* * * * * ${WRAP} job-12 'x'   `,
    `* * * * * ${WRAP} job-13`,
    `* * * * * ${WRAP} job-14 'x'\\'`,
    `* * * * * /a/cockpit-cronjobs-run/b/cockpit-cronjobs-run job-15 'x'`,
    `#[cronjobs:off] * * * * * ${WRAP} job-16 'x'`,
];

function expected(text) {
    const jobs = C.parseUserCrontab(text).filter(e => e.kind === "job" && e.enabled);
    return { total: jobs.length, recorded: jobs.filter(e => C.unwrapCommand(e.command)).length };
}

t("the oracle sees jobs and recordings in the lines", () => {
    const e = expected(LINES.join("\n") + "\n");
    assert.ok(e.total > 20 && e.recorded >= 6 && e.recorded < e.total, JSON.stringify(e));
});

for (const sh of SHELLS) {
    for (const awk of AWKS) {
        const name = sh + ", " + awk.name + ": ";

        t(name + "no crontabs: nothing failed, no jobs", () => {
            const fx = fixture();
            const { en, de, raw } = written(sh, awk, fx);
            assert.strictEqual(en.state, "ok");
            assert.strictEqual(en.version, VERSION);
            assert.strictEqual(en.summary, "There are no jobs in the crontabs of root and other users.");
            assert.strictEqual(de.summary, "In den Crontabs von root und anderen Benutzern gibt es keine Jobs.");
            assert.strictEqual(item(en, "failed").state, "none");
            assert.ok(!("value" in item(en, "failed")));
            assert.deepStrictEqual([item(en, "unrecorded").state, item(en, "unrecorded").value], ["ok", "0"]);
            assert.strictEqual(item(de, "unrecorded").title, "Jobs ohne Aufzeichnung");
            assert.strictEqual(fs.statSync(path.join(fx.state, "status.json")).mode & 0o777, 0o644);
            assert.strictEqual(fs.statSync(path.join(fx.state, "status.de.json")).mode & 0o777, 0o644);
            assert.strictEqual(fs.statSync(fx.state).mode & 0o777, 0o711);
            assert.deepStrictEqual(fs.readdirSync(fx.state).sort(), ["status.de.json", "status.json"]);
            /* status prints the file of the language asked for; English without --lang */
            assert.deepStrictEqual(run(sh, awk, fx, ["status", "--lang", "en"]), { rc: 0, out: raw.en, err: "" });
            assert.deepStrictEqual(run(sh, awk, fx, ["status", "--lang", "de"]), { rc: 0, out: raw.de, err: "" });
            assert.deepStrictEqual(run(sh, awk, fx, ["status"]), { rc: 0, out: raw.en, err: "" });
        });

        t(name + "jobs and recordings read as the page reads them", () => {
            const fx = fixture();
            const text = LINES.join("\n") + "\n";
            crontab(fx, "root", text);
            const e = expected(text);
            const { en, de } = written(sh, awk, fx);
            const plain = e.total - e.recorded;
            assert.deepStrictEqual([item(en, "unrecorded").state, item(en, "unrecorded").value], ["none", String(plain)]);
            assert.strictEqual(item(en, "unrecorded").detail,
                `${plain} of ${e.total} jobs in the crontabs of root and other users; their results are not known.`);
            assert.strictEqual(item(de, "unrecorded").detail,
                `${plain} von ${e.total} Jobs in den Crontabs von root und anderen Benutzern; ihre Ergebnisse sind nicht bekannt.`);
            assert.deepStrictEqual([item(en, "failed").state, item(en, "failed").value, item(en, "failed").detail],
                ["ok", "0", `Recorded jobs: ${e.recorded}, none failed.`]);
            assert.strictEqual(item(de, "failed").detail, `Aufgezeichnete Jobs: ${e.recorded}, keiner fehlgeschlagen.`);
            assert.strictEqual(en.state, "ok");
            assert.strictEqual(en.summary, "No recorded job failed in the last 24 hours.");
            assert.strictEqual(de.summary, "Kein aufgezeichneter Job ist in den letzten 24 Stunden fehlgeschlagen.");
        });

        t(name + "a failed run in the last 24 hours", () => {
            const fx = fixture();
            crontab(fx, "root", `MAILTO=""\n*/5 * * * * ${wrapped("backup-1a2b", "backup.sh")}\n@daily ${wrapped("ok-0001", "true")}\n`);
            runs(fx, "root", "backup-1a2b", [rec(NOW - 7200, 0), rec(NOW - 60, 3)]);
            runs(fx, "root", "ok-0001", [rec(NOW - 60, 0)]);
            const { en, de } = written(sh, awk, fx);
            assert.strictEqual(en.state, "danger");
            assert.strictEqual(en.summary, "1 job failed in the last 24 hours.");
            assert.strictEqual(de.summary, "1 Job ist in den letzten 24 Stunden fehlgeschlagen.");
            const f = item(en, "failed");
            assert.deepStrictEqual([f.state, f.value, f.detail], ["danger", "1", "backup-1a2b"]);
            assert.strictEqual(f.title, "Failed jobs (last 24 hours)");
            assert.strictEqual(item(de, "failed").title, "Fehlgeschlagene Jobs (letzte 24 Stunden)");
            assert.deepStrictEqual([item(en, "unrecorded").state, item(en, "unrecorded").value], ["ok", "0"]);
            assert.strictEqual(item(en, "unrecorded").detail, "Every job in the crontabs of root and other users records its runs.");
        });

        t(name + "failures older than 24 hours and successes do not count", () => {
            const fx = fixture();
            crontab(fx, "root", `* * * * * ${wrapped("old-0001", "x")}\n`);
            runs(fx, "root", "old-0001", [rec(NOW - 86400 - 120, 1), rec(NOW - 86400 - 60, "aborted"), rec(NOW - 30, 0)]);
            const { en } = written(sh, awk, fx);
            assert.deepStrictEqual([en.state, item(en, "failed").state, item(en, "failed").value], ["ok", "ok", "0"]);
        });

        t(name + "aborted runs and runs without an exit code count as failed", () => {
            const fx = fixture();
            crontab(fx, "root", `* * * * * ${wrapped("ab-0001", "x")}\n* * * * * ${wrapped("nul-0001", "x")}\n`);
            runs(fx, "root", "ab-0001", [rec(NOW - 60, "aborted")]);
            runs(fx, "root", "nul-0001", [`{"start":${NOW - 60},"end":${NOW - 50},"rc":null,"trigger":"manual","bytes":0,"truncated":false,"out":""}`]);
            const { en } = written(sh, awk, fx);
            assert.deepStrictEqual([item(en, "failed").value, item(en, "failed").detail], ["2", "ab-0001, nul-0001"]);
            assert.strictEqual(en.summary, "2 jobs failed in the last 24 hours.");
        });

        t(name + "only the last 20 runs are read, as on the page", () => {
            const fx = fixture();
            crontab(fx, "root", `* * * * * ${wrapped("many-0001", "x")}\n`);
            runs(fx, "root", "many-0001", [rec(NOW - 300, 1)].concat(Array.from({ length: 20 }, (_, k) => rec(NOW - 200 + k, 0))));
            assert.strictEqual(item(written(sh, awk, fx).en, "failed").state, "ok");
        });

        t(name + "a run whose recorder died counts as aborted, a running one does not", () => {
            const fx = fixture();
            crontab(fx, "root", `* * * * * ${wrapped("dead-0001", "x")}\n* * * * * ${wrapped("live-0001", "x")}\n` +
                                `* * * * * ${wrapped("gone-0001", "x")}\n`);
            const live = spawn("sleep", ["30"], { argv0: "cockpit-cronjobs-run", stdio: "ignore" });
            try {
                fs.writeFileSync(path.join(runsDir(fx, "root", "dead-0001"), "20261019T000000Z-1.running"),
                                 `{"start":${NOW - 60},"pid":999999999,"trigger":"schedule"}\n`);
                fs.writeFileSync(path.join(runsDir(fx, "root", "live-0001"), "20261019T000000Z-2.running"),
                                 `{"start":${NOW - 60},"pid":${live.pid},"trigger":"schedule"}\n`);
                fs.writeFileSync(path.join(runsDir(fx, "root", "gone-0001"), "20261017T000000Z-3.running"),
                                 `{"start":${NOW - 90000},"pid":999999998,"trigger":"schedule"}\n`);
                const { en } = written(sh, awk, fx);
                assert.deepStrictEqual([item(en, "failed").value, item(en, "failed").detail], ["1", "dead-0001"]);
            } finally {
                live.kill();
            }
        });

        if (OTHER) t(name + "another user's jobs count, the user's name stays out", () => {
            const fx = fixture();
            crontab(fx, "root", `* * * * * ${wrapped("same-0001", "x")}\n`);
            crontab(fx, OTHER, `@hourly ${wrapped("same-0001", "x")}\n15 3 * * * /bin/report\n`);
            runs(fx, "root", "same-0001", [rec(NOW - 60, 0)]);
            runs(fx, OTHER, "same-0001", [rec(NOW - 60, 2)]);
            const { en, de, raw } = written(sh, awk, fx);
            assert.deepStrictEqual([item(en, "failed").value, item(en, "failed").detail], ["1", "same-0001"]);
            assert.strictEqual(item(en, "unrecorded").value, "1");
            assert.strictEqual(item(de, "unrecorded").detail.indexOf("1 von 3 Jobs"), 0);
            assert.ok(!raw.en.includes(OTHER) && !raw.de.includes(OTHER), "no user name");
        });

        if (OTHER) t(name + "links in another user's directory are not followed", () => {
            const fx = fixture();
            crontab(fx, OTHER, `* * * * * ${wrapped("ln-0001", "x")}\n`);
            /* elsewhere/runs/ln-0001 has a failed run; each link below leads there */
            const elsewhere = path.join(fx.base, "elsewhere");
            const job = path.join(elsewhere, "runs", "ln-0001");
            fs.mkdirSync(job, { recursive: true });
            fs.writeFileSync(path.join(job, "runs.jsonl"), rec(NOW - 60, 1) + "\n");
            const users = path.join(fx.state, "users");
            const mine = path.join(users, OTHER);
            const failedState = () => item(written(sh, awk, fx).en, "failed").state;
            fs.mkdirSync(users);
            fs.symlinkSync(elsewhere, mine);
            assert.strictEqual(failedState(), "ok", "users/USER a link");
            fs.unlinkSync(mine);
            fs.mkdirSync(mine);
            fs.symlinkSync(path.join(elsewhere, "runs"), path.join(mine, "runs"));
            assert.strictEqual(failedState(), "ok", "users/USER/runs a link");
            fs.unlinkSync(path.join(mine, "runs"));
            fs.mkdirSync(path.join(mine, "runs"));
            fs.symlinkSync(job, path.join(mine, "runs", "ln-0001"));
            assert.strictEqual(failedState(), "ok", "the job's directory a link");
            fs.unlinkSync(path.join(mine, "runs", "ln-0001"));
            fs.mkdirSync(path.join(mine, "runs", "ln-0001"));
            fs.symlinkSync(path.join(job, "runs.jsonl"), path.join(mine, "runs", "ln-0001", "runs.jsonl"));
            assert.strictEqual(failedState(), "ok", "runs.jsonl a link");
            fs.unlinkSync(path.join(mine, "runs", "ln-0001", "runs.jsonl"));
            fs.copyFileSync(path.join(job, "runs.jsonl"), path.join(mine, "runs", "ln-0001", "runs.jsonl"));
            assert.strictEqual(failedState(), "danger", "the same run, not through a link");
        });

        t(name + "crontabs of unknown users, cron's own files and links are skipped", () => {
            const fx = fixture();
            const line = "* * * * * /bin/true\n";
            ["no-such-user-cj", ".hidden", "root~", "tmp.123", "x.tmp", "bad name"].forEach(u => crontab(fx, u, line));
            fs.writeFileSync(path.join(fx.base, "outside"), line);
            fs.symlinkSync(path.join(fx.base, "outside"), path.join(fx.spool, "bin"));
            crontab(fx, "root", line);
            assert.strictEqual(item(written(sh, awk, fx).en, "unrecorded").value, "1");
        });

        t(name + "copied lines share their ID and their runs", () => {
            const fx = fixture();
            crontab(fx, "root", `* * * * * ${wrapped("copy-0001", "x")}\n0 1 * * * ${wrapped("copy-0001", "x")}\n`);
            runs(fx, "root", "copy-0001", [rec(NOW - 60, 1)]);
            const { en } = written(sh, awk, fx);
            assert.deepStrictEqual([item(en, "failed").value, item(en, "failed").detail], ["1", "copy-0001"]);
            assert.strictEqual(item(en, "unrecorded").value, "0");
        });

        t(name + "many failed jobs: the first five by ID, then how many more", () => {
            const fx = fixture();
            const ids = ["g-7", "c-3", "a-1", "e-5", "b-2", "f-6", "d-4"];
            crontab(fx, "root", ids.map(id => `* * * * * ${wrapped(id, "x")}\n`).join(""));
            ids.forEach(id => runs(fx, "root", id, [rec(NOW - 60, 1)]));
            const { en, de } = written(sh, awk, fx);
            assert.deepStrictEqual([item(en, "failed").value, item(en, "failed").detail], ["7", "a-1, b-2, c-3, d-4, e-5 and 2 more"]);
            assert.strictEqual(item(de, "failed").detail, "a-1, b-2, c-3, d-4, e-5 und 2 weitere");
            assert.strictEqual(de.summary, "7 Jobs sind in den letzten 24 Stunden fehlgeschlagen.");
        });

        t(name + "no job records its runs: not known", () => {
            const fx = fixture();
            crontab(fx, "root", "30 1 * * 0 /usr/sbin/fstrim -a\n@reboot /bin/true\n");
            const { en, de } = written(sh, awk, fx);
            assert.strictEqual(en.state, "none");
            assert.strictEqual(en.summary, "No job records its runs, so their results are not known.");
            assert.strictEqual(de.summary, "Kein Job zeichnet seine Läufe auf, daher sind die Ergebnisse nicht bekannt.");
            assert.deepStrictEqual([item(en, "failed").state, item(en, "failed").detail], ["none", "No job records its runs."]);
            assert.deepStrictEqual([item(en, "unrecorded").state, item(en, "unrecorded").value], ["none", "2"]);
        });

        t(name + "status without a status file: none, and why", () => {
            const fx = fixture();
            for (const [lang, text] of [["en", "No status yet: cockpit-cronjobs-status.timer writes it every 15 minutes."],
                                        ["de", "Noch kein Status: cockpit-cronjobs-status.timer schreibt ihn alle 15 Minuten."]]) {
                const r = run(sh, awk, fx, ["status", "--lang", lang]);
                assert.strictEqual(r.rc, 0, r.err);
                const d = contract(r.out);
                assert.deepStrictEqual([d.state, d.summary, d.items], ["none", text, []]);
                assert.strictEqual(d.version, VERSION);
            }
            const gone = run(sh, awk, { state: path.join(fx.base, "missing"), spool: fx.spool }, ["status", "--lang", "en"]);
            assert.strictEqual(contract(gone.out).state, "none");
        });

        t(name + "status of a damaged file: none, cannot be read", () => {
            const fx = fixture();
            fs.writeFileSync(path.join(fx.state, "status.json"), "{\"broken\n");
            fs.writeFileSync(path.join(fx.state, "status.de.json"), "");
            const en = contract(run(sh, awk, fx, ["status", "--lang", "en"]).out);
            const de = contract(run(sh, awk, fx, ["status", "--lang", "de"]).out);
            assert.deepStrictEqual([en.state, en.summary], ["none", "The status file cannot be read."]);
            assert.deepStrictEqual([de.state, de.summary], ["none", "Die Statusdatei lässt sich nicht lesen."]);
        });

        t(name + "without the page, no version", () => {
            const fx = fixture();
            const r = run(sh, awk, fx, ["status"], { CRONJOBS_PAGE_DIR: fx.base });
            assert.ok(!("version" in contract(r.out)));
        });

        t(name + "the languages Cockpit may ask for", () => {
            const fx = fixture();
            const { raw } = written(sh, awk, fx);
            for (const [lang, file] of [["de-DE", "de"], ["de_AT", "de"], ["DE", "de"], ["fr", "en"], ["pt-BR", "en"],
                                        ["zh_CN", "en"], ["dea", "en"]])
                assert.deepStrictEqual(run(sh, awk, fx, ["status", "--lang", lang]), { rc: 0, out: raw[file], err: "" }, lang);
        });

        t(name + "wrong calls", () => {
            const fx = fixture();
            for (const args of [[], ["status", "--lang"], ["status", "de"], ["status", "--lang", "d"],
                                ["status", "--lang", "de-"], ["status", "--lang", "../x"], ["status", "--lang", "de\nx"],
                                ["status", "--lang", "de", "x"], ["write", "now"], ["show"]]) {
                const r = run(sh, awk, fx, args);
                assert.strictEqual(r.rc, 64, JSON.stringify(args));
                assert.strictEqual(r.out, "");
                assert.ok(/^usage: /.test(r.err));
            }
            assert.ok(!fs.existsSync(path.join(fx.state, "status.json")));
        });

        if (process.getuid() !== 0) t(name + "write needs root", () => {
            const r = run(sh, awk, null, ["write"]);
            assert.strictEqual(r.rc, 77);
            assert.ok(/needs root/.test(r.err));
        });
    }
}

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
