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

/* CRON_LOG_SCRIPT: when cron last started each command, from a stand-in for journalctl that
   prints what journalctl -o short-unix prints and notes how it was called. */
const C = require("../src/lib/cron.js");
const LOG_SCRIPT = constant(/const CRON_LOG_SCRIPT = `([\s\S]*?)`;/.exec(APP), "CRON_LOG_SCRIPT");
for (const sh of SHELLS) t(sh + ": cron's log: the newest start of each command, nothing else", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-log-"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin", "journalctl"),
        "#!/bin/sh\n" +
        "printf '%s\\n' \"$*\" > \"$FAKE_ARGS\"\n" +
        "cat <<'EOF'\n" +
        "1792500000.123456 host CRON[100]: (root) CMD (cd / && run-parts --report /etc/cron.hourly)\n" +
        "1792500060.5 host CRON[101]: pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)\n" +
        "1792503600.000001 host CRON[102]: (root) CMD (cd / && run-parts --report /etc/cron.hourly)\n" +
        "1792503000.2 host CROND[103]: (www-data) CMD (php -f /var/www/cron.php)\n" +
        "1792503100.3 host CRON[104]: (root) MAIL (mailed 10 bytes of output)\n" +
        "1792503200.4 host CRON[105]: (root) CMD (echo \": (x) CMD (y)\")\n" +
        "-- Boot 1234 --\n" +
        /* Debian's cron with -L 8 and more: the job's PID before the command, and END lines */
        "1792507200.5 host CRON[106]: (root) CMD ([4500] cd / && run-parts --report /etc/cron.hourly)\n" +
        "1792503700.1 host CRON[107]: (root) CMD ([4321] /usr/local/bin/backup.sh)\n" +
        "1792503760.1 host CRON[108]: (root) CMD ([4400] /usr/local/bin/backup.sh)\n" +
        "1792503770.1 host CRON[108]: (root) END ([4400] /usr/local/bin/backup.sh)\n" +
        "1792503780.1 host CRON[109]: (root) CMD ([ -x /usr/bin/foo ] && foo)\n" +
        "1792503790.1 host CRON[110]: (root) CMD ([12]x)\n" +
        "EOF\n", { mode: 0o755 });
    const r = spawnSync(sh, ["-c", LOG_SCRIPT], {
        env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C", FAKE_ARGS: path.join(root, "args") },
        timeout: 30000,
    });
    assert.strictEqual(r.status, 0, r.stderr.toString());
    assert.deepStrictEqual(r.stdout.toString().trim().split("\n").sort(), [
        "1792503000 (www-data) CMD (php -f /var/www/cron.php)",
        "1792503200 (root) CMD (echo \": (x) CMD (y)\")",
        "1792503760 (root) CMD (/usr/local/bin/backup.sh)",
        "1792503780 (root) CMD ([ -x /usr/bin/foo ] && foo)",
        "1792503790 (root) CMD ([12]x)",
        "1792507200 (root) CMD (cd / && run-parts --report /etc/cron.hourly)",
    ], "one line for each command, whether cron logged a PID or not; brackets that are no PID stay");
    const log = C.parseCronLog(r.stdout.toString());
    assert.strictEqual(C.lastStart(log, "root", "cd / && run-parts --report /etc/cron.hourly"), 1792507200000);
    assert.strictEqual(C.lastStart(log, "root", "/usr/local/bin/backup.sh"), 1792503760000, "with the PID");
    assert.strictEqual(C.lastStart(log, "root", "[ -x /usr/bin/foo ] && foo"), 1792503780000);
    /* only cron's own messages, by the fields journald sets: _UID 0 and _COMM cron or crond */
    assert.deepStrictEqual(fs.readFileSync(path.join(root, "args"), "utf8").trim().split(" ").filter(a => a.startsWith("_") || a.startsWith("-")),
                           ["--no-pager", "-q", "-o", "--since", "-35d", "_UID=0", "_COMM=cron", "_COMM=crond"]);
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
