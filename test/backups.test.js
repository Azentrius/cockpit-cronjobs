// SPDX-License-Identifier: Apache-2.0
/* Tests for the backups of the root crontab: the difference (src/lib/backups.js)
 * against GNU diff, the list as BACKUPS_SCRIPT (src/app/system.js) prints it, with
 * dash and bash, and restoring through SAVE_SCRIPT: restoring and restoring back
 * gives the original bytes. Run with: node test/backups.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const B = require("../src/lib/backups.js");
const C = require("../src/lib/cron.js");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app", "system.js"), "utf8");
let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }
}

const gnuDiff = spawnSync("diff", ["--version"]);
const HAVE_DIFF = gnuDiff.status === 0 && /GNU diffutils/.test(gnuDiff.stdout.toString());
const SHELLS = ["/bin/dash", "/bin/bash"].filter(s => fs.existsSync(s));
const HAVE_FLOCK = spawnSync("sh", ["-c", "command -v flock"]).status === 0;

/* A deterministic random source, so that a failure can be repeated. */
function random(seed) {
    return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}

/* ---------- the difference ---------- */

/* As diff prints it with these line formats; a line without newline gets one, as
   in the result of B.diff written out the same way. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-diff-"));
function gnu(a, b) {
    fs.writeFileSync(path.join(tmp, "a"), a);
    fs.writeFileSync(path.join(tmp, "b"), b);
    const r = spawnSync("diff", ["--old-line-format=-%L", "--new-line-format=+%L", "--unchanged-line-format= %L",
                                 path.join(tmp, "a"), path.join(tmp, "b")]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr.toString());
    return r.stdout.toString();
}
const ours = (a, b) => B.diff(a, b).map(o => o.op + o.line).join("");
const changed = s => s.split("\n").filter(l => l[0] === "-" || l[0] === "+").length;

/* The lines kept and removed give a, those kept and added give b. */
function valid(a, b, ops) {
    return ops.filter(o => o.op !== "+").map(o => o.line).join("") === a &&
           ops.filter(o => o.op !== "-").map(o => o.line).join("") === b;
}

const TEMPLATE = ["# Edit this file to introduce tasks to be run by cron.", "# ",
                  "# For more information see the manual pages of crontab(5) and cron(8)", "# ",
                  "# m h  dom mon dow   command"].join("\n") + "\n";
const ROOT = TEMPLATE + "MAILTO=\"\"\n\n# backups\n30 2 * * * /usr/local/bin/backup.sh\n" +
             "0 3 2 * *\t/usr/local/libexec/cockpit-cronjobs-run update-geoip-1a2b '/opt/plausible/update-geoip.sh'\n" +
             "\n# nightly\n0 4 * * * /usr/bin/apt-get -qq update  \n30 1 * * 0 /usr/sbin/fstrim -a\n" +
             "*/10 * * * * test -x /opt/x && echo 'é ü' > /dev/null\n@reboot /usr/local/bin/warmup.sh\n";

const CASES = {
    "one line changed": ROOT.replace("30 2 * * *", "45 2 * * *"),
    "a job switched off": ROOT.replace("30 1 * * 0", "#[cronjobs:off] 30 1 * * 0"),
    "a job added at the end": ROOT + "15 * * * * /usr/local/bin/new.sh\n",
    "a job added at the start": "15 * * * * /usr/local/bin/new.sh\n" + ROOT,
    "a job with its note removed": ROOT.replace("\n# nightly\n0 4 * * * /usr/bin/apt-get -qq update  \n", "\n"),
    "a blank line and a note added": ROOT.replace("@reboot", "\n# at boot\n@reboot"),
    "a line moved up": ROOT.replace("@reboot /usr/local/bin/warmup.sh\n", "").replace("MAILTO=\"\"\n", "MAILTO=\"\"\n@reboot /usr/local/bin/warmup.sh\n"),
    "a line moved down": ROOT.replace("30 2 * * * /usr/local/bin/backup.sh\n", "") + "30 2 * * * /usr/local/bin/backup.sh\n",
    "the template removed": ROOT.replace(TEMPLATE, ""),
    "a conversion: line off and a note": ROOT.replace("30 2 * * * /usr/local/bin/backup.sh\n",
        "# Converted to systemd timer backup.timer by Cockpit Cron Jobs on 2026-10-12; the line below is no longer used.\n" +
        "#[cronjobs:off] 30 2 * * * /usr/local/bin/backup.sh\n"),
    "several changes": ROOT.replace("30 2", "31 2").replace("# nightly\n", "").replace("@reboot", "@reboot nice"),
    "empty": "",
    "something else entirely": "SHELL=/bin/bash\n0 0 * * * /bin/true\n",
    "the same": ROOT,
};

t("the difference: as GNU diff shows it", () => {
    if (!HAVE_DIFF) { console.log("skipped: needs GNU diff"); return; }
    Object.keys(CASES).forEach(name => {
        const b = CASES[name];
        for (const [x, y] of [[ROOT, b], [b, ROOT]]) {
            assert.strictEqual(ours(x, y), gnu(x, y), name);
            assert.ok(valid(x, y, B.diff(x, y)), name + ": valid");
        }
    });
});

/* Random edits of crontab-like text, as they happen: lines changed, switched off,
   added with a note, removed, moved; blank lines and notes repeat. */
t("the difference: random edits of crontabs, as GNU diff shows them", () => {
    if (!HAVE_DIFF) return;
    const rnd = random(7);
    const pick = list => list[Math.floor(rnd() * list.length)];
    const SAME = ["", "#", "# backups", "MAILTO=\"\"", "SHELL=/bin/sh", "PATH=/usr/bin:/bin"];
    let n = 0;
    const job = () => pick(["*/5", "0", "30", "15"]) + " " + pick(["*", "3", "2"]) + " * * * /usr/local/bin/task-" + (n++) + ".sh";
    for (let k = 0; k < 300; k++) {
        const a = [];
        for (let i = 3 + Math.floor(rnd() * 12); i > 0; i--) a.push(rnd() < 0.3 ? pick(SAME) : job());
        const b = a.slice();
        for (let s = 1 + Math.floor(rnd() * 3); s > 0; s--) {
            const i = Math.floor(rnd() * (b.length + 1));
            const j = Math.min(i, b.length - 1);
            const r = rnd();
            if (r < 0.2) b.splice(i, 0, job());
            else if (r < 0.35) b.splice(i, 0, pick(SAME), job());
            else if (r < 0.5 && b.length) b.splice(j, 1);
            else if (r < 0.65 && b.length) b[j] = "#[cronjobs:off] " + b[j];
            else if (r < 0.8 && b.length) b[j] = b[j].replace(/^\S+/, "45");
            else if (b.length > 1) b.splice(Math.floor(rnd() * (b.length - 1)), 0, b.splice(j, 1)[0]);
        }
        const x = a.join("\n") + "\n";
        const y = b.join("\n") + "\n";
        assert.strictEqual(ours(x, y), gnu(x, y), JSON.stringify({ x, y }));
    }
});

/* Text made of few different lines has many shortest differences; GNU diff picks
   one of them by details of its search. Here: as short as diff's, and correct. */
t("the difference: random text with many equal lines, as short as GNU diff's", () => {
    if (!HAVE_DIFF) return;
    const rnd = random(1);
    for (let k = 0; k < 400; k++) {
        const kinds = 2 + Math.floor(rnd() * 5);
        const gen = () => {
            let s = "";
            for (let i = Math.floor(rnd() * 12); i > 0; i--) s += "abcdefg"[Math.floor(rnd() * kinds)] + "\n";
            return s;
        };
        const x = gen();
        const y = gen();
        const ops = B.diff(x, y);
        assert.ok(valid(x, y, ops), JSON.stringify({ x, y }));
        assert.strictEqual(changed(ours(x, y)), changed(gnu(x, y)), JSON.stringify({ x, y }));
    }
});

t("the difference: a missing newline at the end is a change", () => {
    assert.deepStrictEqual(B.diff("a\nb\n", "a\nb"), [{ op: " ", line: "a\n" }, { op: "-", line: "b\n" }, { op: "+", line: "b" }]);
    assert.deepStrictEqual(B.diff("", ""), []);
    assert.deepStrictEqual(B.counts(B.diff("a\n", "b\nc\n")), { removed: 1, added: 2 });
});

t("the difference: long unchanged stretches are folded", () => {
    const a = Array.from({ length: 21 }, (_, i) => "line " + i + "\n").join("");
    const b = a.replace("line 10\n", "line ten\n");
    const shown = B.hunks(B.diff(a, b), 3);
    assert.deepStrictEqual(shown.map(o => o.op === "skip" ? "skip " + o.count : o.op + o.line.trim()), [
        "skip 7", " line 7", " line 8", " line 9", "-line 10", "+line ten", " line 11", " line 12", " line 13", "skip 7"]);
    assert.deepStrictEqual(B.hunks(B.diff(a, a), 3), [{ op: "skip", count: 21 }]);
});

/* ---------- the list ---------- */

function listing(files) {
    return Buffer.concat(files.map(([name, mtime, body]) => {
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
        return Buffer.concat([Buffer.from("\x1e" + mtime + " " + bytes.length + " " + name + "\n"), bytes]);
    }));
}

t("the list: newest first, files byte for byte, other names left out", () => {
    const list = B.parseBackups(new Uint8Array(listing([
        ["root-20261012-101010.crontab", 1791770410, "a\n"],
        ["root-20261012-101010-3.crontab", 1791770410, "c\n\x1e 9 9 fake\n"],
        ["notes.txt", 1791770500, "x\n"],
        ["root-20261012-101010-2.crontab", 1791770410, "b\n"],
        ["root-20261013-080000.crontab", 1791878400, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])],
        ["root-20261011-235959.crontab", 1791763199, "﻿bom\n"],
        ["root-20261012-120000.crontab", 1791777600, ""],
    ])));
    assert.deepStrictEqual(list.map(b => [b.name, b.text]), [
        ["root-20261013-080000.crontab", null],
        ["root-20261012-120000.crontab", ""],
        ["root-20261012-101010-3.crontab", "c\n\x1e 9 9 fake\n"],
        ["root-20261012-101010-2.crontab", "b\n"],
        ["root-20261012-101010.crontab", "a\n"],
        ["root-20261011-235959.crontab", "﻿bom\n"],
    ]);
    assert.strictEqual(list[0].mtime, 1791878400000);
    assert.strictEqual(list[0].size, 5);
    assert.deepStrictEqual(B.parseBackups(new Uint8Array(0)), []);
    assert.throws(() => B.parseBackups(new Uint8Array(Buffer.from("junk"))));
    assert.throws(() => B.parseBackups(new Uint8Array(Buffer.from("\x1e1 10 root-20261012-101010.crontab\nshort"))));
});

/* ---------- the root scripts, with dash and bash ---------- */

/* A root script exactly as the page has it, with the constants it uses. */
function appScript(name, values) {
    const m = new RegExp("const " + name + " = `([\\s\\S]*?)`;").exec(APP);
    assert.ok(m, name + " in app/system.js");
    return new Function(...Object.keys(values), "return `" + m[1] + "`;")(...Object.values(values));
}
const listScript = root => appScript("BACKUPS_SCRIPT", { BACKUP_DIR: root + "/state/backups", STATE_DIR: root + "/state" });
const saveScript = root => appScript("SAVE_SCRIPT", { BACKUP_DIR: root + "/state/backups", STATE_DIR: root + "/state", KEEP_BACKUPS: 10 });

/* A fake root: bin/crontab keeps root's crontab in root.crontab. */
function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-backups-"));
    ["bin", "state"].forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }));
    fs.writeFileSync(path.join(root, "bin", "crontab"),
        "#!/bin/sh\n" +
        "f=\"$FAKE/root.crontab\"\n" +
        "case \"$1 $2 $3\" in\n" +
        "  '-l -u root') [ -f \"$f\" ] || { echo 'no crontab for root' >&2; exit 1; }; cat \"$f\" ;;\n" +
        "  '-u root '*) cat \"$3\" > \"$f\" ;;\n" +
        "  *) echo \"fake crontab: $*\" >&2; exit 2 ;;\n" +
        "esac\n", { mode: 0o755 });
    return root;
}
function run(shell, root, script, args, input) {
    const r = spawnSync(shell, ["-c", script, "cockpit-cronjobs"].concat(args), {
        env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C", FAKE: root },
        input: input === undefined ? "" : input,
        timeout: 30000,
    });
    return { rc: r.status, out: r.stdout, err: r.stderr.toString() };
}
/* What the page does: read the list, then write a backup's text through SAVE_SCRIPT
   (Cockpit passes the text on as UTF-8). */
function list(shell, root) {
    const r = run(shell, root, listScript(root), []);
    assert.strictEqual(r.rc, 0, r.err);
    return B.parseBackups(new Uint8Array(r.out));
}
function save(shell, root, text) {
    const cur = fs.existsSync(path.join(root, "root.crontab")) ? fs.readFileSync(path.join(root, "root.crontab"), "utf8") : "";
    const r = run(shell, root, saveScript(root), [C.cksum(cur)], Buffer.from(text, "utf8"));
    assert.strictEqual(r.rc, 0, r.err);
}
const crontab = root => fs.readFileSync(path.join(root, "root.crontab"));

if (SHELLS.length === 0 || !HAVE_FLOCK) {
    console.log("skipped the root scripts: needs flock and dash or bash");
} else {
    for (const sh of SHELLS) {
        t(sh + ": the list holds every backup byte for byte, and nothing else", () => {
            const root = setup();
            const dir = path.join(root, "state", "backups");
            fs.mkdirSync(dir, { mode: 0o700 });
            const outside = path.join(root, "outside.crontab");
            fs.writeFileSync(outside, "not a backup\n");
            const files = {
                "root-20261012-101010.crontab": Buffer.from("MAILTO=\"\"\n# ü\t \n30 2 * * * /bin/true\n"),
                "root-20261012-101010-2.crontab": Buffer.from("\x1e1 1 root-20261012-000000.crontab\n"),
                "root-20261012-120000.crontab": Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]),
                "root-20261012-130000.crontab": Buffer.alloc(0),
                "root-x y.crontab": Buffer.from("odd name\n"),
            };
            Object.keys(files).forEach((f, i) => {
                fs.writeFileSync(path.join(dir, f), files[f]);
                fs.utimesSync(path.join(dir, f), 1791770410 + i, 1791770410 + i);
            });
            fs.symlinkSync(outside, path.join(dir, "root-20261012-140000.crontab"));
            fs.mkdirSync(path.join(dir, "root-20261012-150000.crontab"));
            const got = list(sh, root);
            assert.deepStrictEqual(got.map(b => b.name), ["root-20261012-130000.crontab", "root-20261012-120000.crontab",
                                                          "root-20261012-101010-2.crontab", "root-20261012-101010.crontab"]);
            assert.deepStrictEqual(got.map(b => b.text), ["", null, "\x1e1 1 root-20261012-000000.crontab\n",
                                                          "MAILTO=\"\"\n# ü\t \n30 2 * * * /bin/true\n"]);
            assert.deepStrictEqual(got.map(b => b.mtime / 1000), [1791770413, 1791770412, 1791770411, 1791770410]);
        });

        t(sh + ": no backups yet", () => {
            const root = setup();
            const r = run(sh, root, listScript(root), []);
            assert.strictEqual(r.rc, 0, r.err);
            assert.strictEqual(r.out.length, 0);
        });

        /* The done criterion of stage 2: restoring and restoring back gives the
           original bytes, and each restore can be undone the same way. */
        t(sh + ": restoring and restoring back gives the original bytes", () => {
            const root = setup();
            const A = TEMPLATE + "MAILTO=\"\"\n# ü, tabs\tand spaces at the end  \n30 2 * * * /usr/local/bin/backup.sh\n\n";
            const Bt = A.replace("30 2", "45 3") + "0 * * * * /bin/true\n";
            fs.writeFileSync(path.join(root, "root.crontab"), A);
            const original = crontab(root);
            save(sh, root, Bt);
            const changedBytes = crontab(root);
            let got = list(sh, root);
            assert.strictEqual(got.length, 1);
            assert.strictEqual(got[0].text, A);
            save(sh, root, got[0].text);
            assert.ok(crontab(root).equals(original), "restored byte for byte");
            got = list(sh, root);
            assert.deepStrictEqual(got.map(b => b.text), [Bt, A], "the version before the restore is the newest backup");
            save(sh, root, got[0].text);
            assert.ok(crontab(root).equals(changedBytes), "restored back byte for byte");
        });

        t(sh + ": ten backups are kept, newest first", () => {
            const root = setup();
            fs.writeFileSync(path.join(root, "root.crontab"), "# version 0\n");
            for (let i = 1; i <= 12; i++) save(sh, root, "# version " + i + "\n");
            const got = list(sh, root);
            assert.deepStrictEqual(got.map(b => b.text), Array.from({ length: 10 }, (_, i) => "# version " + (11 - i) + "\n"));
        });
    }

    /* SAVE_SCRIPT holds the lock while it writes: the list waits, then gives up. */
    t("locked", () => {
        const root = setup();
        fs.mkdirSync(path.join(root, "state", "backups"));
        const lock = path.join(root, "state", ".crontab.lock");
        const held = lock + ".held";
        const holder = spawn("sh", ["-c", "exec 9>\"$1\"; flock 9; : > \"$2\"; exec sleep 30", "holder", lock, held], { stdio: "ignore" });
        try {
            const until = Date.now() + 5000;
            while (!fs.existsSync(held) && Date.now() < until) spawnSync("sleep", ["0.05"]);
            assert.ok(fs.existsSync(held), "lock held");
            const r = run(SHELLS[0], root, listScript(root), []);
            assert.strictEqual(r.rc, 4);
            assert.strictEqual(r.out.length, 0);
        } finally {
            holder.kill();
        }
    });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
