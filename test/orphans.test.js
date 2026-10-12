/* Tests for the root script that removes leftover runs (REMOVE_ORPHANS_SCRIPT in
 * src/app/system.js), with dash and bash, against a fake state directory and fake crontabs.
 * Run with: node test/orphans.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app", "system.js"), "utf8");
let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }
}

const SHELLS = ["/bin/dash", "/bin/bash"].filter(s => fs.existsSync(s));
const HAVE_FLOCK = spawnSync("sh", ["-c", "command -v flock"]).status === 0;
const HAVE_PROC = fs.existsSync("/proc/self/cmdline");

/* The script exactly as the page runs it, with its paths moved into a fake root. */
function script(root) {
    const m = /const REMOVE_ORPHANS_SCRIPT = `([\s\S]*?)`;/.exec(APP);
    assert.ok(m, "REMOVE_ORPHANS_SCRIPT in app/system.js");
    const text = new Function("RUNS_DIR", "STATE_DIR", "return `" + m[1] + "`;")(root + "/state/runs", root + "/state");
    const moved = text.replace(/(^|\s)\/(etc|var\/spool)\//gm, "$1" + root + "/$2/");
    assert.ok(!/(^|\s)\/(etc|var\/spool)\//m.test(moved), "every crontab path moved");
    return moved;
}

/* A fake root: runs of the given jobs, the root crontab (none when undefined), other files. */
function setup(o) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-orphans-"));
    ["state/runs", "etc/cron.d", "var/spool/cron/crontabs", "bin"].forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }));
    fs.writeFileSync(path.join(root, "bin", "crontab"),
        "#!/bin/sh\n" +
        "[ -z \"${FAKE_FAIL-}\" ] || { echo 'crontab: cannot read' >&2; exit 1; }\n" +
        "[ -f \"$FAKE_CRONTAB\" ] || { echo 'no crontab for root' >&2; exit 1; }\n" +
        "cat \"$FAKE_CRONTAB\"\n", { mode: 0o755 });
    (o.jobs || []).forEach(id => {
        const dir = path.join(root, "state", "runs", id);
        fs.mkdirSync(dir, { mode: 0o700 });
        fs.writeFileSync(path.join(dir, "runs.jsonl"), '{"start":1791770400,"end":1791770401,"rc":0,"trigger":"schedule","bytes":0,"truncated":false,"out":""}\n');
    });
    if (o.root !== undefined) fs.writeFileSync(path.join(root, "root.crontab"), o.root);
    Object.keys(o.files || {}).forEach(p => fs.writeFileSync(path.join(root, p), o.files[p]));
    return root;
}

function run(shell, root, ids, env) {
    const r = spawnSync(shell, ["-c", script(root), "cockpit-cronjobs"].concat(ids), {
        env: Object.assign({ PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C",
                             FAKE_CRONTAB: path.join(root, "root.crontab") }, env || {}),
        timeout: 30000,
    });
    return { rc: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}
const left = root => fs.readdirSync(path.join(root, "state", "runs")).sort();
const WRAP = "/usr/local/libexec/cockpit-cronjobs-run";

if (!HAVE_FLOCK || SHELLS.length === 0) {
    console.log("skipped: needs flock and dash or bash");
    process.exit(0);
}

for (const sh of SHELLS) {
    t(sh + ": removes what no crontab mentions, keeps the rest", () => {
        const root = setup({
            jobs: ["root-0001", "crond-0002", "user-0003", "anacron-0004", "etc-0005", "gone-0006", "near-0007"],
            root: "MAILTO=\"\"\n30 2 * * * " + WRAP + " root-0001 '/usr/local/bin/backup.sh'\n",
            files: {
                "etc/crontab": "17 * * * * root\t" + WRAP + "\tetc-0005 'true'\n",
                "etc/cron.d/backup": "0 3 * * * root " + WRAP + " crond-0002 'true'",
                "etc/anacrontab": "1 5 daily " + WRAP + " anacron-0004 'run-parts /etc/cron.daily'\n",
                "var/spool/cron/crontabs/alice": "# user-0003 is off for now\n",
                "var/spool/cron/crontabs/bob": "0 4 * * * echo xnear-0007 near-00071 near-0007_\n",
            },
        });
        const r = run(sh, root, ["root-0001", "crond-0002", "user-0003", "anacron-0004", "etc-0005", "gone-0006",
                                 "near-0007", "missing-0008", "../state", "a b"]);
        assert.strictEqual(r.rc, 0, r.err);
        assert.deepStrictEqual(r.out.trim().split("\n"), [
            "used root-0001", "used crond-0002", "used user-0003", "used anacron-0004", "used etc-0005",
            "removed gone-0006", "removed near-0007", "gone missing-0008"]);
        assert.deepStrictEqual(left(root), ["anacron-0004", "crond-0002", "etc-0005", "root-0001", "user-0003"]);
        assert.ok(fs.existsSync(path.join(root, "state", ".crontab.lock")), "takes the crontab lock");
    });

    t(sh + ": no root crontab at all", () => {
        const root = setup({ jobs: ["a-0001"] });
        const r = run(sh, root, ["a-0001"]);
        assert.strictEqual(r.rc, 0, r.err);
        assert.strictEqual(r.out, "removed a-0001\n");
        assert.deepStrictEqual(left(root), []);
    });

    t(sh + ": a crontab that cannot be read stops everything", () => {
        const root = setup({ jobs: ["a-0001"], root: "" });
        const r = run(sh, root, ["a-0001"], { FAKE_FAIL: "1" });
        assert.strictEqual(r.rc, 1);
        assert.ok(/cannot read/.test(r.err), r.err);
        assert.strictEqual(r.out, "");
        assert.deepStrictEqual(left(root), ["a-0001"]);
    });

    t(sh + ": a link is removed, not what it points to", () => {
        const root = setup({ root: "" });
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-outside-"));
        fs.writeFileSync(path.join(outside, "keep"), "x");
        fs.symlinkSync(outside, path.join(root, "state", "runs", "link-0001"));
        const r = run(sh, root, ["link-0001"]);
        assert.strictEqual(r.out, "removed link-0001\n");
        assert.deepStrictEqual(left(root), []);
        assert.ok(fs.existsSync(path.join(outside, "keep")));
    });

    t(sh + ": without a runs directory there is nothing to do", () => {
        const root = setup({ root: "" });
        fs.rmdirSync(path.join(root, "state", "runs"));
        const r = run(sh, root, ["a-0001"]);
        assert.strictEqual(r.rc, 0, r.err);
        assert.strictEqual(r.out, "");
    });
}

if (HAVE_PROC) {
    /* A run that is going on keeps its directory; a marker of a dead run does not. */
    t("a run going on is kept", () => {
        const root = setup({ jobs: ["busy-0001", "dead-0002"], root: "" });
        const child = spawn("sh", ["-c", "sleep 20; :", "cockpit-cronjobs-run"], { stdio: "ignore" });
        try {
            const marker = (id, pid) => fs.writeFileSync(path.join(root, "state", "runs", id, "20261012T020000Z-" + pid + ".running"),
                                                         '{"start":1791770400,"pid":' + pid + ',"trigger":"schedule"}\n');
            marker("busy-0001", child.pid);
            marker("dead-0002", 999999);
            const r = run(SHELLS[0], root, ["busy-0001", "dead-0002"]);
            assert.strictEqual(r.out, "running busy-0001\nremoved dead-0002\n");
            assert.deepStrictEqual(left(root), ["busy-0001"]);
        } finally {
            child.kill();
        }
    });
}

/* Someone else holds the crontab lock: exit 4 after ten seconds, nothing removed. */
t("locked", () => {
    const root = setup({ jobs: ["a-0001"], root: "" });
    const lock = path.join(root, "state", ".crontab.lock");
    const held = lock + ".held";
    const holder = spawn("sh", ["-c", "exec 9>\"$1\"; flock 9; : > \"$2\"; exec sleep 30", "holder", lock, held], { stdio: "ignore" });
    try {
        const until = Date.now() + 5000;
        while (!fs.existsSync(held) && Date.now() < until) spawnSync("sleep", ["0.05"]);
        assert.ok(fs.existsSync(held), "lock held");
        const r = run(SHELLS[0], root, ["a-0001"]);
        assert.strictEqual(r.rc, 4);
        assert.deepStrictEqual(left(root), ["a-0001"]);
    } finally {
        holder.kill();
    }
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
