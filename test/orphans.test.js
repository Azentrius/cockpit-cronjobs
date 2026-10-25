// SPDX-License-Identifier: Apache-2.0
/* Tests for the root scripts that remove leftover runs (REMOVE_ORPHANS_SCRIPT in
 * src/app/system.js), list the runs (RUNS_SCRIPT) and read cron's log (CRON_LOG_SCRIPT),
 * with dash and bash, against a fake state directory, fake crontabs and a fake journal.
 * Run with: node test/orphans.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const R = require("../src/lib/runs.js");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app", "system.js"), "utf8");
let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }
}

const SHELLS = ["/bin/dash", "/bin/bash"].filter(s => fs.existsSync(s));
const HAVE_FLOCK = spawnSync("sh", ["-c", "command -v flock"]).status === 0;
const HAVE_PROC = fs.existsSync("/proc/self/cmdline");

/* The scripts exactly as the page runs them, with their paths moved into a fake root. */
function constant(m, name) {
    assert.ok(m, name + " in app/system.js");
    return m[1];
}
const AS_USER_FN = new Function("return `" + constant(/const AS_USER_FN = `([\s\S]*?)`;/.exec(APP), "AS_USER_FN") + "`;")();
const ONE_DIR = new Function("return `" + constant(/const REMOVE_RUN_DIR_SCRIPT = `([\s\S]*?)`;/.exec(APP), "REMOVE_RUN_DIR_SCRIPT") + "`;")();
function script(root) {
    const src = constant(/const REMOVE_ORPHANS_SCRIPT = `([\s\S]*?)`;/.exec(APP), "REMOVE_ORPHANS_SCRIPT");
    const text = new Function("RUNS_DIR", "STATE_DIR", "AS_USER_FN", "return `" + src + "`;")(root + "/state/runs", root + "/state", AS_USER_FN);
    const moved = text.replace(/(^|\s)\/(etc|var\/spool)\//gm, "$1" + root + "/$2/");
    assert.ok(!/(^|\s)\/(etc|var\/spool)\//m.test(moved), "every crontab path moved");
    return moved;
}
function listScript(root) {
    const src = constant(/const RUNS_SCRIPT = `([\s\S]*?)`;/.exec(APP), "RUNS_SCRIPT");
    return new Function("RUNS_DIR", "STATE_DIR", "KEEP_RUNS", "return `" + src + "`;")(root + "/state/runs", root + "/state", 20);
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
    /* two users, alice and bob; setpriv notes the uid and the directory (sh -c SCRIPT NAME DIR USED), then runs the command */
    fs.writeFileSync(path.join(root, "bin", "id"),
        "#!/bin/sh\n" +
        "case \"$2\" in alice) echo 1001 ;; bob) echo 1002 ;; *) exit 1 ;; esac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, "bin", "setpriv"),
        "#!/bin/sh\n" +
        "uid=\n" +
        "while [ $# -gt 0 ]; do\n" +
        "  case $1 in --reuid=*) uid=${1#--reuid=} ;; --) shift; break ;; esac\n" +
        "  shift\n" +
        "done\n" +
        "echo \"$uid $5\" >> \"$FAKE_AS\"\n" +
        "exec \"$@\"\n", { mode: 0o755 });
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
    const r = spawnSync(shell, ["-c", script(root), "cockpit-cronjobs", ONE_DIR].concat(ids), {
        env: Object.assign({ PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C",
                             FAKE_CRONTAB: path.join(root, "root.crontab"), FAKE_AS: path.join(root, "as.log") }, env || {}),
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

    t(sh + ": without a runs directory there is nothing to remove", () => {
        const root = setup({ root: "" });
        fs.rmdirSync(path.join(root, "state", "runs"));
        const r = run(sh, root, ["a-0001"]);
        assert.strictEqual(r.rc, 0, r.err);
        assert.strictEqual(r.out, "gone a-0001\n");
    });

    /* Stage 3: the runs of another user's jobs, in users/USER/runs, by the key USER/ID. */
    t(sh + ": runs of other users' jobs, by USER/ID", () => {
        const root = setup({ jobs: ["root-0006"], root: "",
                             files: { "var/spool/cron/crontabs/alice": "0 1 * * * " + WRAP + " used-0002 'true'\n" } });
        const userRuns = (user, id) => {
            const d = path.join(root, "state", "users", user, "runs", id);
            fs.mkdirSync(d, { recursive: true });
            return d;
        };
        userRuns("alice", "gone-0001");
        userRuns("alice", "used-0002");
        const bobs = userRuns("bob", "x-0003");
        const carols = userRuns("carol", "x-0005");
        const r = run(sh, root, ["root-0006", "alice/gone-0001", "alice/used-0002", "bob/missing-0004", "carol/x-0005",
                                 "root/x-0003", "../bob/x-0003", "bob/../x", "b b/x-0003", "alice/a/b"]);
        assert.strictEqual(r.rc, 0, r.err);
        assert.deepStrictEqual(r.out.trim().split("\n"),
                               ["removed root-0006", "removed alice/gone-0001", "used alice/used-0002", "gone bob/missing-0004"]);
        assert.deepStrictEqual(fs.readdirSync(path.join(root, "state", "users", "alice", "runs")), ["used-0002"]);
        assert.ok(fs.existsSync(bobs), "names that are not keys touch nothing");
        assert.ok(fs.existsSync(carols), "a user the system does not know is skipped");
        const users = path.join(root, "state", "users");
        assert.deepStrictEqual(fs.readFileSync(path.join(root, "as.log"), "utf8").trim().split("\n"),
                               ["1001 " + users + "/alice/runs/gone-0001", "1001 " + users + "/alice/runs/used-0002",
                                "1002 " + users + "/bob/runs/missing-0004"],
                               "each user's directory looked at and removed as that user, root's as root");
    });

    /* RUNS_SCRIPT: another user writes the directories of the user's jobs, so nothing
       there may pass for the runs of another job, and nothing there may hold up the page. */
    t(sh + ": the list of runs takes from users' directories only what has the form of runs", () => {
        const root = setup({ jobs: ["root-0001"], root: "" });
        const users = path.join(root, "state", "users");
        const dir = (...p) => {
            const d = path.join(users, ...p);
            fs.mkdirSync(d, { recursive: true });
            return d;
        };
        const rec = start => '{"start":' + start + ',"end":' + (start + 1) + ',"rc":0,"trigger":"schedule","bytes":0,"truncated":false,"out":""}\n';
        fs.writeFileSync(path.join(dir("alice", "runs", "a-0002"), "runs.jsonl"), rec(100) + "\x1eroot-0001\n" + rec(200) + "x\x1ebob/b-0009\n");
        fs.writeFileSync(path.join(dir("alice", "runs", "a-0002"), "20261013T120000Z-7.running"), '{"start":300,"pid":7}\n\x1eroot-0001\n');
        fs.writeFileSync(path.join(dir("alice", "runs", "x\x1eroot-0001"), "runs.jsonl"), rec(400));
        fs.writeFileSync(path.join(dir("alice", "runs", "bad name"), "runs.jsonl"), rec(400));
        const elsewhere = dir("..", "elsewhere", "link-0003");
        fs.writeFileSync(path.join(elsewhere, "runs.jsonl"), rec(500));
        fs.symlinkSync(elsewhere, path.join(users, "alice", "runs", "link-0003"));
        assert.strictEqual(spawnSync("mkfifo", [path.join(dir("alice", "runs", "fifo-0004"), "runs.jsonl")]).status, 0);
        fs.symlinkSync(path.join(root, "state", "runs", "root-0001", "runs.jsonl"), path.join(dir("alice", "runs", "ln-0005"), "runs.jsonl"));
        fs.writeFileSync(path.join(dir("carol", "runs", "c-0006"), "runs.jsonl"), rec(600));
        fs.symlinkSync(path.join(root, "state", "runs"), path.join(dir("bob"), "runs"));
        const started = Date.now();
        const r = spawnSync(sh, ["-c", listScript(root)], {
            env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C" },
            timeout: 30000,
        });
        assert.strictEqual(r.status, 0, r.stderr.toString());
        assert.ok(Date.now() - started < 4000, "a FIFO holds nothing up");
        const byId = R.parseRuns(r.stdout.toString());
        assert.deepStrictEqual(Object.keys(byId).sort(), ["alice/a-0002", "alice/fifo-0004", "alice/ln-0005", "root-0001"],
                               "only directories named by an ID, no links, no users the system does not know");
        assert.deepStrictEqual(byId["root-0001"].runs.map(x => x.start), [1791770400], "root's job as it is");
        assert.deepStrictEqual(byId["root-0001"].running, []);
        assert.deepStrictEqual(byId["alice/a-0002"].runs.map(x => x.start), [300, 200, 100], "the user's own runs, the dead marker as aborted");
        assert.deepStrictEqual(byId["alice/fifo-0004"].runs, []);
        assert.deepStrictEqual(byId["alice/ln-0005"].runs, [], "a link to a file is not read");
    });

    t(sh + ": the list of runs says which jobs do not overlap, and the starts they skipped", () => {
        const root = setup({ jobs: ["root-0001", "root-0002"], root: "" });
        const runs = path.join(root, "state", "runs");
        fs.writeFileSync(path.join(runs, "root-0001", "no-overlap"), "");
        fs.writeFileSync(path.join(runs, "root-0001", "skipped.jsonl"), '{"start":10,"trigger":"schedule"}\n{"start":20,"trigger":"manual"}\n');
        /* the last 20 lines, without the separator: nothing in there passes for another job */
        fs.writeFileSync(path.join(runs, "root-0002", "skipped.jsonl"),
                         Array.from({ length: 30 }, (_, k) => `{"start":${100 + k},"trigger":"schedule"}\n`).join("") + "\x1eroot-0003\n");
        /* links in a user's directory are not followed */
        const alice = path.join(root, "state", "users", "alice", "runs", "a-0002");
        fs.mkdirSync(alice, { recursive: true });
        fs.symlinkSync(path.join(runs, "root-0001", "no-overlap"), path.join(alice, "no-overlap"));
        fs.symlinkSync(path.join(runs, "root-0001", "skipped.jsonl"), path.join(alice, "skipped.jsonl"));
        const r = spawnSync(sh, ["-c", listScript(root)], {
            env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C" },
            timeout: 30000,
        });
        assert.strictEqual(r.status, 0, r.stderr.toString());
        const byId = R.parseRuns(r.stdout.toString());
        assert.deepStrictEqual(Object.keys(byId).sort(), ["alice/a-0002", "root-0001", "root-0002"]);
        assert.deepStrictEqual([byId["root-0001"].noOverlap, byId["root-0001"].skipped.map(x => [x.start, x.trigger])],
                               [true, [[20, "manual"], [10, "schedule"]]]);
        assert.deepStrictEqual([byId["root-0002"].noOverlap, byId["root-0002"].skipped.map(x => x.start)],
                               [false, Array.from({ length: 19 }, (_, k) => 129 - k)]);
        assert.deepStrictEqual([byId["alice/a-0002"].noOverlap, byId["alice/a-0002"].skipped], [false, []]);
        assert.strictEqual(byId["root-0001"].runs.length, 1, "skipped starts are no runs");
    });

    /* Only the last 64 KiB of a user's runs.jsonl are read: a file far larger than the recorder
       writes does not reach the page, and one the user swaps for a link to /dev/zero after the
       check (here: timeout does it right before the read) fills no memory. The memory limit keeps
       a read without that bound from taking the machine down. */
    t(sh + ": the list of runs reads only the last bytes of a user's runs", () => {
        const root = setup({ jobs: ["root-0001"], root: "" });
        const rec = start => '{"start":' + start + ',"end":' + (start + 1) + ',"rc":0,"trigger":"schedule","bytes":0,"truncated":false,"out":""}\n';
        const runs = id => {
            const d = path.join(root, "state", "users", "alice", "runs", id);
            fs.mkdirSync(d, { recursive: true });
            return path.join(d, "runs.jsonl");
        };
        const big = runs("big-0001");
        fs.writeFileSync(big, "");
        fs.truncateSync(big, 32 << 20);
        fs.appendFileSync(big, "\n" + rec(100));
        const swapped = runs("swap-0002");
        fs.writeFileSync(swapped, rec(200));
        fs.writeFileSync(runs("next-0003"), rec(300));
        const real = spawnSync("sh", ["-c", "command -v timeout"]).stdout.toString().trim();
        assert.ok(real, "timeout is there");
        fs.writeFileSync(path.join(root, "bin", "timeout"),
            "#!/bin/sh\n" +
            "for a in \"$@\"; do\n" +
            "  case $a in */swap-0002/runs.jsonl) rm -f \"$a\" && ln -s /dev/zero \"$a\" ;; esac\n" +
            "done\n" +
            "\"$REAL_TIMEOUT\" \"$@\"\n" +
            "rc=$?\n" +
            "echo \"$rc $*\" >> \"$FAKE_READS\"\n" +
            "exit $rc\n", { mode: 0o755 });
        const reads = path.join(root, "reads.log");
        const r = spawnSync(sh, ["-c", "ulimit -v 524288 || exit 9\n" + listScript(root)], {
            env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C", REAL_TIMEOUT: real, FAKE_READS: reads },
            timeout: 30000,
            maxBuffer: 64 << 20,
        });
        assert.strictEqual(r.status, 0, r.stderr.toString());
        assert.ok(fs.lstatSync(swapped).isSymbolicLink(), "swapped after the check");
        const read = fs.readFileSync(reads, "utf8").split("\n").find(l => l.endsWith("/swap-0002/runs.jsonl"));
        assert.ok(read && read.startsWith("0 "), "the read of /dev/zero ends by itself: " + read);
        const out = r.stdout.toString("latin1");
        out.split("\x1e").slice(1).forEach(s => assert.ok(s.length < 65536 + 256, s.slice(0, 40) + ": " + s.length + " bytes"));
        const byId = R.parseRuns(out);
        assert.deepStrictEqual(byId["alice/big-0001"].runs.map(x => x.start), [100], "the last record of a huge file");
        assert.deepStrictEqual(byId["alice/swap-0002"].runs, []);
        assert.deepStrictEqual(byId["alice/next-0003"].runs.map(x => x.start), [300], "the jobs after it as they are");
        assert.deepStrictEqual(byId["root-0001"].runs.map(x => x.start), [1791770400]);
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

/* CRON_LOG_SCRIPT: the newest run cron started of each command, with its end and result as
   far as cron logged them, from a stand-in for journalctl that prints what journalctl -o
   short-unix prints (in the journal's order) and notes how it was called. The lines are those
   of Debian's cron 3.0pl1 (do_command.c) and cronie 1.7 at the -L given. */
const C = require("../src/lib/cron.js");
const LOG_SCRIPT = constant(/const CRON_LOG_SCRIPT = `([\s\S]*?)`;/.exec(APP), "CRON_LOG_SCRIPT");
for (const sh of SHELLS) t(sh + ": cron's log: the newest run of each command, its end and result", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-log-"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin", "journalctl"),
        "#!/bin/sh\n" +
        "printf '%s\\n' \"$*\" > \"$FAKE_ARGS\"\n" +
        "cat <<'EOF'\n" +
        /* -L 1: starts only, from the job's process */
        "1792500000.123456 host CRON[100]: (root) CMD (cd / && run-parts --report /etc/cron.hourly)\n" +
        "1792500060.5 host CRON[101]: pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)\n" +
        "1792503000.2 host CROND[103]: (www-data) CMD (php -f /var/www/cron.php)\n" +
        "1792503100.3 host CRON[104]: (root) MAIL (mailed 10 bytes of output)\n" +
        "1792503200.4 host CRON[105]: (root) CMD (echo \": (x) CMD (y)\")\n" +
        "1792503600.000001 host CRON[102]: (root) CMD (cd / && run-parts --report /etc/cron.hourly)\n" +
        "-- Boot 1234 --\n" +
        /* -L 15: the job's PID before the command, the end and failures from the process that waits */
        "1792503700.1 host CRON[106]: (root) CMD ([4321] /usr/local/bin/backup.sh)\n" +
        "1792503760.1 host CRON[107]: (root) CMD ([4400] /usr/local/bin/backup.sh)\n" +
        "1792503770.1 host CRON[107]: (root) END ([4400] /usr/local/bin/backup.sh)\n" +
        "1792503780.1 host CRON[108]: (root) CMD ([ -x /usr/bin/foo ] && foo)\n" +
        "1792503790.1 host CRON[109]: (root) CMD ([12]x)\n" +
        "1792503800.1 host CRON[110]: (root) CMD ([4501] /usr/local/bin/fail.sh)\n" +
        "1792503801.1 host CRON[110]: (CRON) error (grandchild #4501 failed with exit status 3)\n" +
        "1792503801.2 host CRON[110]: (root) END ([4501] /usr/local/bin/fail.sh)\n" +
        "1792503900.1 host CRON[111]: (root) CMD ([4600] sleep 999)\n" +
        /* -L 7: no PID; a failure names the job's PID, which logged the start itself */
        "1792504000.1 host CRON[4701]: (www-data) CMD (php -f /var/www/cron.php)\n" +
        "1792504002.1 host CRON[4700]: (CRON) error (grandchild #4701 terminated by signal 11, dumped core)\n" +
        "1792504002.2 host CRON[4700]: (www-data) END (php -f /var/www/cron.php)\n" +
        "1792504100.1 host CRON[4801]: (root) CMD (cat > /tmp/x)\n" +
        "1792504101.1 host CRON[4800]: (CRON) error (grandchild #4802 terminated by signal 13)\n" +
        "1792504101.2 host CRON[4800]: (root) END (cat > /tmp/x)\n" +
        "1792504200.1 host CRON[4901]: (root) CMD (slow)\n" +
        "1792504260.1 host CRON[4903]: (root) CMD (slow)\n" +
        "1792504290.1 host CRON[4900]: (root) END (slow)\n" +
        "1792504300.1 host CRON[5001]: (root) CMD (flaky)\n" +
        "1792504301.1 host CRON[5000]: (CRON) error (grandchild #5001 failed with exit status 1)\n" +
        "1792504301.2 host CRON[5000]: (root) END (flaky)\n" +
        "1792504360.1 host CRON[5061]: (root) CMD (flaky)\n" +
        "1792504400.1 host CRON[5101]: (root) CMD (a)\n" +
        "1792504401.1 host CRON[5100]: (CRON) error (grandchild #5101 failed with exit status 2)\n" +
        "1792504500.1 host CRON[5101]: (root) CMD (b)\n" +
        "1792504600.1 host CRON[5301]: (root) CMD (c)\n" +
        "1792504660.1 host CRON[5361]: (root) CMD (c)\n" +
        "1792504661.1 host CRON[5300]: (CRON) error (grandchild #5301 failed with exit status 5)\n" +
        "1792504700.1 host CRON[5401]: (root) CMD (echo ') END (x)')\n" +
        "1792504701.1 host CRON[5400]: (root) END (echo ') END (x)')\n" +
        /* cronie: start and end, no result */
        "1792504800.1 host CROND[5501]: (root) CMD (/usr/bin/true)\n" +
        "1792504805.1 host CROND[5500]: (root) CMDEND (/usr/bin/true)\n" +
        "1792504900.1 host CRON[5601]: (root) CMD (no end of the line\n" +
        "EOF\n", { mode: 0o755 });
    const r = spawnSync(sh, ["-c", LOG_SCRIPT], {
        env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C", FAKE_ARGS: path.join(root, "args") },
        timeout: 30000,
    });
    assert.strictEqual(r.status, 0, r.stderr.toString());
    assert.deepStrictEqual(r.stdout.toString().trim().split("\n").sort(), [
        "1792503200 - - (root) CMD (echo \": (x) CMD (y)\")",
        "1792503600 - - (root) CMD (cd / && run-parts --report /etc/cron.hourly)",
        "1792503760 1792503770 - (root) CMD (/usr/local/bin/backup.sh)",
        "1792503780 - - (root) CMD ([ -x /usr/bin/foo ] && foo)",
        "1792503790 - - (root) CMD ([12]x)",
        "1792503800 1792503801 exit:3 (root) CMD (/usr/local/bin/fail.sh)",
        "1792503900 - - (root) CMD (sleep 999)",
        "1792504000 1792504002 signal:11 (www-data) CMD (php -f /var/www/cron.php)",
        "1792504100 1792504101 - (root) CMD (cat > /tmp/x)",
        "1792504260 ? - (root) CMD (slow)",
        "1792504360 - - (root) CMD (flaky)",
        "1792504400 - exit:2 (root) CMD (a)",
        "1792504500 - - (root) CMD (b)",
        "1792504660 - - (root) CMD (c)",
        "1792504700 1792504701 - (root) CMD (echo ') END (x)')",
        "1792504800 1792504805 - (root) CMD (/usr/bin/true)",
    ], "one line for each command, whether cron logged a PID or not; brackets that are no PID stay; a failure " +
       "of a PID that started no job (what feeds the % input), of an older run, or before a newer start is not " +
       "the newest run's; a PID used again keeps what the other job's run had; an end without PID belongs to " +
       "the newest run (a guess only when runs overlap)");
    const log = C.parseCronLog(r.stdout.toString());
    assert.strictEqual(C.lastStart(log, "root", "cd / && run-parts --report /etc/cron.hourly"), 1792503600000);
    assert.deepStrictEqual(C.lastRun(log, "root", "/usr/local/bin/fail.sh"),
                           { start: 1792503800000, end: 1792503801000, result: { exit: 3 } }, "with the PID");
    assert.strictEqual(C.lastStart(log, "root", "[ -x /usr/bin/foo ] && foo"), 1792503780000);
    /* only messages of root (_UID, which journald sets) as CRON, CROND or crond; not by _COMM, which
       journald may read after the job's process became its shell */
    assert.deepStrictEqual(fs.readFileSync(path.join(root, "args"), "utf8").trim().split(" ").filter(a => /^[-_A-Z]/.test(a)),
                           ["--no-pager", "-o", "--since", "-35d", "_UID=0", "SYSLOG_IDENTIFIER=CRON", "SYSLOG_IDENTIFIER=CROND",
                            "SYSLOG_IDENTIFIER=crond"]);
    assert.deepStrictEqual(C.parsePamRefusals(r.stdout.toString()), [], "no refusal in that log");
});

/* cronie 1.7.0 with Linux-PAM that reads /etc/environment with libeconf (Rocky Linux 10): a line
   pam_env cannot read makes PAM refuse every job, logged as crond (the process that would start the
   job, before it calls itself CROND). A user's refusal counts until a job of theirs starts; another
   boot changes nothing; the lines around it are read as before. */
for (const sh of SHELLS) t(sh + ": cron's log: whose jobs PAM refused, until a job of theirs starts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-log-"));
    fs.mkdirSync(path.join(root, "bin"));
    const refuse = (sec, pid, user, reason) =>
        `${sec}.5 host crond[${pid}]: pam_env(crond:setcred): Unable to read configuration file /etc//environment line 3: Missing delimiter\n` +
        `${sec}.5 host crond[${pid}]: (${user}) PAM ERROR (${reason})\n` +
        `${sec}.5 host crond[${pid}]: (${user}) FAILED to authorize user with PAM (${reason})\n`;
    fs.writeFileSync(path.join(root, "bin", "journalctl"), "#!/bin/sh\ncat <<'EOF'\n" +
        "1792800000.1 host crond[700]: (CRON) STARTUP (1.7.0)\n" +
        "1792800060.1 host CROND[7001]: (root) CMD (/usr/bin/true)\n" +
        "1792800061.1 host CROND[7000]: (root) CMDEND (/usr/bin/true)\n" +
        refuse(1792800120, 7040, "root", "Critical error - immediate abort") +
        refuse(1792800120, 7041, "alice", "Critical error - immediate abort") +
        /* www-data: refused, then a job of theirs starts again */
        refuse(1792800180, 7050, "www-data", "Critical error - immediate abort") +
        "1792800240.1 host CROND[7061]: (www-data) CMD (php -f /var/www/cron.php)\n" +
        "-- Boot 0123456789abcdef0123456789abcdef --\n" +
        /* root: refused again, for another reason; alice's refusal stays over the boot */
        refuse(1792800300, 7070, "root", "Permission denied") +
        /* a start whose command looks like a refusal is a start; a refusal without a reason is none */
        "1792800360.1 host CROND[7081]: (bob) CMD (echo ') FAILED to authorize user with PAM (x)')\n" +
        "1792800420.1 host crond[7090]: (carol) FAILED to authorize user with PAM\n" +
        "EOF\n", { mode: 0o755 });
    const r = spawnSync(sh, ["-c", LOG_SCRIPT], { env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C" }, timeout: 30000 });
    assert.strictEqual(r.status, 0, r.stderr.toString());
    assert.deepStrictEqual(r.stdout.toString().trim().split("\n").sort(), [
        "1792800060 1792800061 - (root) CMD (/usr/bin/true)",
        "1792800240 - - (www-data) CMD (php -f /var/www/cron.php)",
        "1792800360 - - (bob) CMD (echo ') FAILED to authorize user with PAM (x)')",
        "PAM 1792800120 (alice) (Critical error - immediate abort)",
        "PAM 1792800300 (root) (Permission denied)",
    ], "the newest refusal of each user no start of theirs followed, with PAM's reason; the runs as before");
    assert.deepStrictEqual(C.parsePamRefusals(r.stdout.toString()), [
        { user: "root", at: 1792800300000, reason: "Permission denied" },
        { user: "alice", at: 1792800120000, reason: "Critical error - immediate abort" },
    ]);
    assert.strictEqual(C.parseCronLog(r.stdout.toString()).size, 3, "the PAM lines are no runs");
});

/* A PID used again after its run (by what feeds a job its input after %, which logs no start and
   can die of SIGPIPE), or on another boot, says nothing about that run; nor does a failure that
   another process than the one that started the run logs. */
for (const sh of SHELLS) t(sh + ": cron's log: a PID used again is not the old run's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-log-"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin", "journalctl"),
        "#!/bin/sh\ncat <<'EOF'\n" +
        /* -L 15: A ends, B's feeder gets A's PID 201 and dies, B fails */
        "1792600000.1 host CRON[200]: (root) CMD ([201] /opt/a.sh)\n" +
        "1792600001.1 host CRON[200]: (root) END ([201] /opt/a.sh)\n" +
        "1792600100.1 host CRON[300]: (root) CMD ([301] /opt/b.sh)\n" +
        "1792600101.1 host CRON[300]: (CRON) error (grandchild #201 terminated by signal 13)\n" +
        "1792600102.1 host CRON[300]: (CRON) error (grandchild #301 failed with exit status 2)\n" +
        "1792600103.1 host CRON[300]: (root) END ([301] /opt/b.sh)\n" +
        /* -L 7: no PIDs in the lines; C's start from 401 itself, its end from 400 */
        "1792600200.1 host CRON[401]: (root) CMD (/opt/c.sh)\n" +
        "1792600201.1 host CRON[400]: (root) END (/opt/c.sh)\n" +
        "1792600300.1 host CRON[501]: (root) CMD (/opt/d.sh)\n" +
        "1792600301.1 host CRON[500]: (CRON) error (grandchild #401 terminated by signal 13)\n" +
        "1792600302.1 host CRON[500]: (root) END (/opt/d.sh)\n" +
        /* -L 5: no ends; E's PID belongs to the boot before */
        "1792600400.1 host CRON[601]: (root) CMD (/opt/e.sh)\n" +
        "-- Boot 0123456789abcdef0123456789abcdef --\n" +
        "1792600500.1 host CRON[701]: (root) CMD (/opt/f.sh)\n" +
        "1792600501.1 host CRON[700]: (CRON) error (grandchild #601 failed with exit status 9)\n" +
        /* -L 13: G still open, but the failure comes from H's process, not from G's */
        "1792600600.1 host CRON[800]: (root) CMD ([801] /opt/g.sh)\n" +
        "1792600700.1 host CRON[900]: (root) CMD ([901] /opt/h.sh)\n" +
        "1792600701.1 host CRON[900]: (CRON) error (grandchild #801 terminated by signal 13)\n" +
        "EOF\n", { mode: 0o755 });
    const r = spawnSync(sh, ["-c", LOG_SCRIPT], { env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C" }, timeout: 30000 });
    assert.strictEqual(r.status, 0, r.stderr.toString());
    assert.deepStrictEqual(r.stdout.toString().trim().split("\n").sort(), [
        "1792600000 1792600001 - (root) CMD (/opt/a.sh)",
        "1792600100 1792600103 exit:2 (root) CMD (/opt/b.sh)",
        "1792600200 1792600201 - (root) CMD (/opt/c.sh)",
        "1792600300 1792600302 - (root) CMD (/opt/d.sh)",
        "1792600400 - - (root) CMD (/opt/e.sh)",
        "1792600500 - - (root) CMD (/opt/f.sh)",
        "1792600600 - - (root) CMD (/opt/g.sh)",
        "1792600700 - - (root) CMD (/opt/h.sh)",
    ], "A, C, E and G keep what their own runs logged; B's own failure counts");
});

/* Overlapping runs of one command, ends without PIDs (-L 7): an end that could be either run's must
   not close the newer one, whose own failure comes later; the other order too; -L 15 as control. */
for (const sh of SHELLS) t(sh + ": cron's log: overlapping runs, an end that could be either's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-log-"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin", "journalctl"), "#!/bin/sh\ncat <<'EOF'\n" +
        "1792710000.1 host CRON[201]: (root) CMD (/opt/r.sh)\n1792710060.1 host CRON[301]: (root) CMD (/opt/r.sh)\n" +
        "1792710070.1 host CRON[200]: (root) END (/opt/r.sh)\n" +
        "1792710080.1 host CRON[300]: (CRON) error (grandchild #301 failed with exit status 3)\n" +
        "1792710081.1 host CRON[300]: (root) END (/opt/r.sh)\n" +
        "1792711000.1 host CRON[401]: (root) CMD (/opt/v.sh)\n1792711060.1 host CRON[501]: (root) CMD (/opt/v.sh)\n" +
        "1792711070.1 host CRON[500]: (CRON) error (grandchild #501 failed with exit status 3)\n" +
        "1792711071.1 host CRON[500]: (root) END (/opt/v.sh)\n1792711080.1 host CRON[400]: (root) END (/opt/v.sh)\n" +
        "1792712000.1 host CRON[600]: (root) CMD ([601] /opt/q.sh)\n1792712060.1 host CRON[700]: (root) CMD ([701] /opt/q.sh)\n" +
        "1792712070.1 host CRON[600]: (root) END ([601] /opt/q.sh)\n" +
        "1792712080.1 host CRON[700]: (CRON) error (grandchild #701 failed with exit status 3)\n" +
        "1792712081.1 host CRON[700]: (root) END ([701] /opt/q.sh)\n" +
        "1792713000.1 host CRON[801]: (root) CMD (/opt/u.sh)\n1792713060.1 host CRON[901]: (root) CMD (/opt/u.sh)\n" +
        "1792713070.1 host CRON[800]: (root) END (/opt/u.sh)\n" +
        "EOF\n", { mode: 0o755 });
    const r = spawnSync(sh, ["-c", LOG_SCRIPT], { env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C" }, timeout: 30000 });
    assert.strictEqual(r.status, 0, r.stderr.toString());
    assert.deepStrictEqual(r.stdout.toString().trim().split("\n").sort(), [
        "1792710060 1792710081 exit:3 (root) CMD (/opt/r.sh)",
        "1792711060 1792711071 exit:3 (root) CMD (/opt/v.sh)",
        "1792712060 1792712081 exit:3 (root) CMD (/opt/q.sh)",
        "1792713060 ? - (root) CMD (/opt/u.sh)",
    ], "the newer run keeps its own failure; an end that could be either's leaves the newer one's end unknown");
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
