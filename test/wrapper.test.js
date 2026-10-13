// SPDX-License-Identifier: Apache-2.0
/* Tests for the run recorder (src/cockpit-cronjobs-run) with dash and bash,
 * and for lib/runs.js. Run with: node test/wrapper.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const C = require("../src/lib/cron.js");
const R = require("../src/lib/runs.js");

const WRAPPER = path.join(__dirname, "..", "src", "cockpit-cronjobs-run");
let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }
}

const SHELLS = ["/bin/dash", "/bin/bash", "/bin/sh"].filter(s => fs.existsSync(s));

function run(shell, args, opts) {
    opts = opts || {};
    const env = Object.assign({ PATH: "/usr/bin:/bin", SHELL: "/bin/sh", CRONJOBS_STATE_DIR: opts.state }, opts.env || {});
    const r = spawnSync(shell, [WRAPPER].concat(args), { env, input: opts.input || "", maxBuffer: 64 << 20 });
    return { rc: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}
function records(state, id) {
    const f = runsDir(state, id, "runs.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
}
function tmpState() { return fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-state-")); }

/* Where the recorder keeps the runs of job id: root's under runs/, another user's
   (as these tests run in CI) under users/USER/runs/. */
const ME = os.userInfo().username;
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
function runsDir(state, id, ...rest) {
    return AS_ROOT ? path.join(state, "runs", id, ...rest) : path.join(state, "users", ME, "runs", id, ...rest);
}

t("version marker matches the page", () => {
    const text = fs.readFileSync(WRAPPER, "utf8");
    assert.ok(text.startsWith("#!/bin/sh\n"));
    assert.ok(new RegExp("^CRONJOBS_RUN_VERSION=" + C.WRAPPER_VERSION + "$", "m").test(text));
});

for (const sh of SHELLS) {
    t(sh + ": records result and output, passes output through", () => {
        const state = tmpState();
        const r = run(sh, ["job-1", "echo hello; echo oops >&2; exit 3"], { state });
        assert.strictEqual(r.rc, 3);
        assert.strictEqual(r.out, "hello\noops\n");
        const recs = records(state, "job-1");
        assert.strictEqual(recs.length, 1);
        const x = recs[0];
        assert.strictEqual(x.rc, 3);
        assert.strictEqual(x.trigger, "schedule");
        assert.strictEqual(x.bytes, 11);
        assert.strictEqual(x.truncated, false);
        assert.ok(x.end >= x.start && x.start > 1.7e9);
        assert.strictEqual(fs.readFileSync(runsDir(state, "job-1", x.out + ".out"), "utf8"), "hello\noops\n");
        const dir = fs.readdirSync(runsDir(state, "job-1")).filter(f => !f.startsWith("."));
        assert.deepStrictEqual(dir.sort(), [x.out + ".out", "runs.jsonl"].sort());
        assert.strictEqual(fs.statSync(runsDir(state, "job-1")).mode & 0o777, 0o700);
    });

    t(sh + ": big output is cut to the last 64 KiB, but passed through in full", () => {
        const state = tmpState();
        const r = run(sh, ["big", "i=0; while [ $i -lt 2000 ]; do printf '%099d\\n' $i; i=$((i+1)); done"], { state });
        assert.strictEqual(r.rc, 0);
        assert.strictEqual(r.out.length, 200000);
        const x = records(state, "big")[0];
        assert.strictEqual(x.truncated, true);
        assert.strictEqual(x.bytes, 65536);
        const kept = fs.readFileSync(runsDir(state, "big", x.out + ".out"), "utf8");
        assert.strictEqual(kept, r.out.slice(-65536));
    });

    t(sh + ": no output, no file", () => {
        const state = tmpState();
        const r = run(sh, ["quiet", "true"], { state });
        assert.strictEqual(r.rc, 0);
        const x = records(state, "quiet")[0];
        assert.strictEqual(x.out, "");
        assert.strictEqual(x.bytes, 0);
        assert.deepStrictEqual(fs.readdirSync(runsDir(state, "quiet")).filter(f => !f.startsWith(".")), ["runs.jsonl"]);
    });

    t(sh + ": keeps the last 20 runs and their output", () => {
        const state = tmpState();
        for (let k = 0; k < 25; k++) run(sh, ["many", "echo run " + k], { state });
        const recs = records(state, "many");
        assert.strictEqual(recs.length, 20);
        const outs = fs.readdirSync(runsDir(state, "many")).filter(f => f.endsWith(".out"));
        assert.strictEqual(outs.length, 20);
        assert.deepStrictEqual(outs.sort(), recs.map(x => x.out + ".out").sort());
        assert.strictEqual(fs.readFileSync(runsDir(state, "many", recs[19].out + ".out"), "utf8"), "run 24\n");
    });

    t(sh + ": manual trigger is recorded and not passed on", () => {
        const state = tmpState();
        const r = run(sh, ["man", "echo \"[${CRONJOBS_TRIGGER-unset}]\""], { state, env: { CRONJOBS_TRIGGER: "manual" } });
        assert.strictEqual(r.out, "[unset]\n");
        assert.strictEqual(records(state, "man")[0].trigger, "manual");
        run(sh, ["man", "true"], { state, env: { CRONJOBS_TRIGGER: "bogus\"" } });
        assert.strictEqual(records(state, "man")[1].trigger, "schedule");
    });

    t(sh + ": uses $SHELL like cron", () => {
        const state = tmpState();
        const r = run(sh, ["shell", "echo ${BASH_VERSION:+bash}"], { state, env: { SHELL: "/bin/bash" } });
        assert.strictEqual(r.out, "bash\n");
    });

    t(sh + ": standard input reaches the command", () => {
        const state = tmpState();
        const r = run(sh, ["in", "cat"], { state, input: "line 1\nline 2\n" });
        assert.strictEqual(r.out, "line 1\nline 2\n");
    });

    t(sh + ": runs the command even when nothing can be recorded", () => {
        const r = run(sh, ["x", "echo still; exit 4"], { state: "/proc/version/nope" });
        assert.strictEqual(r.rc, 4);
        assert.strictEqual(r.out, "still\n");
    });

    if (!AS_ROOT) {
        t(sh + ": another user's job: its runs in users/USER/runs, root's directory untouched", () => {
            const state = tmpState();
            const r = run(sh, ["mine-1", "echo mine"], { state });
            assert.strictEqual(r.rc, 0, r.err);
            assert.strictEqual(r.out, "mine\n");
            assert.strictEqual(records(state, "mine-1").length, 1);
            assert.ok(fs.existsSync(path.join(state, "users", ME, "runs", "mine-1", "runs.jsonl")));
            assert.ok(!fs.existsSync(path.join(state, "runs")));
        });

        t(sh + ": a user directory that cannot be written: the command runs anyway", () => {
            const state = tmpState();
            fs.mkdirSync(path.join(state, "users", ME), { recursive: true, mode: 0o500 });
            const r = run(sh, ["ro-1", "echo still; exit 3"], { state });
            assert.strictEqual(r.rc, 3);
            assert.strictEqual(r.out, "still\n");
            assert.deepStrictEqual(fs.readdirSync(path.join(state, "users", ME)), []);
            fs.chmodSync(path.join(state, "users", ME), 0o700);
        });
    }

    t(sh + ": bad id runs without recording", () => {
        const state = tmpState();
        const r = run(sh, ["../evil", "echo ok"], { state });
        assert.strictEqual(r.out, "ok\n");
        assert.deepStrictEqual(fs.readdirSync(state), [], "nothing made");
    });

    t(sh + ": wrong usage", () => {
        const r = run(sh, ["only-id"], { state: tmpState() });
        assert.strictEqual(r.rc, 2);
        assert.ok(/usage/.test(r.err));
    });

    t(sh + ": the job keeps its umask", () => {
        const state = tmpState();
        const r = spawnSync(sh, ["-c", "umask 022; " + sh + " " + WRAPPER + " um 'umask; touch " + state + "/made'"],
                            { env: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", CRONJOBS_STATE_DIR: state } });
        assert.strictEqual(r.stdout.toString(), "0022\n");
        assert.strictEqual(fs.statSync(path.join(state, "made")).mode & 0o777, 0o644);
        assert.strictEqual(fs.statSync(runsDir(state, "um")).mode & 0o777, 0o700);
    });

    t(sh + ": the job keeps its environment", () => {
        const state = tmpState();
        const r = run(sh, ["envx", "echo \"$dir|$max|$start|$id|$cmd|$sh\""], { state,
            env: { dir: "/srv/backup", max: "3", start: "yes", id: "i", cmd: "c", sh: "s" } });
        assert.strictEqual(r.out, "/srv/backup|3|yes|i|c|s\n");
    });

    t(sh + ": a failing recorder never breaks the job", () => {
        const state = tmpState();
        const shim = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-shim-"));
        fs.writeFileSync(path.join(shim, "tail"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const r = run(sh, ["tailfail", "i=0; while [ $i -lt 3000 ]; do echo line $i; i=$((i+1)); done; echo done"],
                      { state, env: { PATH: shim + ":/usr/bin:/bin" } });
        assert.strictEqual(r.rc, 0);
        assert.ok(r.out.endsWith("line 2999\ndone\n"));
        assert.strictEqual(records(state, "tailfail")[0].rc, 0);
    });

    t(sh + ": a run that died is recorded as aborted", () => {
        const state = tmpState();
        const dir = runsDir(state, "dead");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, "20261012T020000Z-999999.running"), '{"start":1791770400,"pid":999999,"trigger":"schedule"}\n');
        run(sh, ["dead", "echo next"], { state });
        const recs = records(state, "dead");
        assert.strictEqual(recs.length, 2);
        assert.deepStrictEqual(recs[0], { start: 1791770400, end: null, rc: null, trigger: "schedule", bytes: 0,
                                          truncated: false, out: "", aborted: true });
        assert.ok(!fs.existsSync(path.join(dir, "20261012T020000Z-999999.running")));
    });

    t(sh + ": crontab line through cron's shell", () => {
        /* The wrapped line as cron hands it to /bin/sh, with a command full of quotes. */
        const state = tmpState();
        const cmd = "echo 'it'\\''s' \"$HOME\" date +\\%F | tr a-z A-Z";
        const line = C.wrapCommand("q-0001", cmd, WRAPPER);
        const r = spawnSync(sh, ["-c", C.cronCommand(line).command],
                            { env: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", HOME: "/root", CRONJOBS_STATE_DIR: state } });
        const direct = spawnSync(sh, ["-c", C.cronCommand(cmd).command], { env: { PATH: "/usr/bin:/bin", HOME: "/root" } });
        assert.strictEqual(r.stdout.toString(), direct.stdout.toString());
        assert.strictEqual(records(state, "q-0001").length, 1);
    });
}

/* Parallel runs of one job: every record is complete JSON. */
t("parallel runs", () => {
    const state = tmpState();
    const sh = SHELLS[0];
    const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", CRONJOBS_STATE_DIR: state };
    const procs = [];
    for (let k = 0; k < 6; k++) {
        procs.push(spawnSync(sh, ["-c", `for i in 1 2 3; do ${sh} ${WRAPPER} par 'echo ${k}; sleep 0.05' & done; wait`], { env }));
    }
    const recs = records(state, "par");
    assert.strictEqual(recs.length, 18);
    recs.forEach(x => assert.strictEqual(x.rc, 0));
});

/* While running: a marker with the pid; afterwards it is gone. */
t("running marker", () => {
    const state = tmpState();
    const sh = SHELLS[0];
    const child = spawn(sh, [WRAPPER, "slow", "sleep 1"], { env: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", CRONJOBS_STATE_DIR: state } });
    const dir = runsDir(state, "slow");
    const until = Date.now() + 3000;
    let marker = null;
    while (Date.now() < until && !marker) {
        if (fs.existsSync(dir)) marker = fs.readdirSync(dir).find(f => f.endsWith(".running")) || null;
        if (!marker) spawnSync("sleep", ["0.05"]);
    }
    assert.ok(marker, "marker appears");
    const m = JSON.parse(fs.readFileSync(path.join(dir, marker), "utf8"));
    assert.strictEqual(m.pid, child.pid);
    assert.strictEqual(m.trigger, "schedule");
    spawnSync("sleep", ["1.3"]);
    assert.ok(!fs.readdirSync(dir).some(f => f.endsWith(".running")));
});

/* ---------- lib/runs.js ---------- */

t("parse runs", () => {
    const text = "\x1ebackup-db-1a2b\n" +
        '{"start":100,"end":103,"rc":0,"trigger":"schedule","bytes":5,"truncated":false,"out":"20261012T000140Z-1"}\n' +
        '{"start":200,"end":212,"rc":1,"trigger":"manual","bytes":0,"truncated":false,"out":""}\n' +
        "not json\n" +
        'running 1 {"start":300,"pid":42,"trigger":"schedule"}\n' +
        'running 0 {"start":250,"pid":41,"trigger":"schedule"}\n' +
        "\x1e../evil\n{\"start\":1}\n" +
        "\x1eempty\n";
    const r = R.parseRuns(text);
    assert.deepStrictEqual(Object.keys(r).sort(), ["backup-db-1a2b", "empty"]);
    const j = r["backup-db-1a2b"];
    assert.deepStrictEqual(j.running, [{ start: 300, pid: 42, trigger: "schedule" }]);
    assert.deepStrictEqual(j.runs.map(x => [x.start, R.outcome(x), R.duration(x)]), [[250, "aborted", null], [200, "failed", 12], [100, "ok", 3]]);
    assert.strictEqual(j.runs[1].trigger, "manual");
    assert.deepStrictEqual(r.empty, { runs: [], running: [], kb: null });
});
t("parse runs: bad output names are dropped", () => {
    const r = R.parseRuns('\x1ea\n{"start":1,"end":2,"rc":0,"out":"../../etc/shadow"}\n');
    assert.strictEqual(r.a.runs[0].out, "");
});
t("parse runs: disk use of the directory", () => {
    const r = R.parseRuns("\x1ea\nsize 24\n\x1eb\nsize \n\x1ec\nsize 1x\n");
    assert.strictEqual(r.a.kb, 24);
    assert.strictEqual(r.b.kb, null);
    assert.strictEqual(r.c.kb, null);
});

t("mentioned: the ID as a word, anywhere", () => {
    assert.ok(R.mentioned("0 1 * * *\t/usr/local/libexec/cockpit-cronjobs-run job-1a2b 'x'", "job-1a2b"));
    assert.ok(R.mentioned("# job-1a2b, converted", "job-1a2b"));
    assert.ok(R.mentioned("job-1a2b", "job-1a2b"));
    assert.ok(R.mentioned("a\njob-1a2b\nb", "job-1a2b"));
    assert.ok(!R.mentioned("old-job-1a2b", "job-1a2b"));
    assert.ok(!R.mentioned("job-1a2b3 job-1a2b_x xjob-1a2b", "job-1a2b"));
    assert.ok(!R.mentioned("", "job-1a2b"));
    assert.ok(!R.mentioned("a.b", "a.b"), "only valid IDs");
});
t("orphans: recorded jobs that no crontab mentions, not while running", () => {
    const byId = R.parseRuns(
        "\x1eused-0001\nsize 8\n" + '{"start":500,"end":501,"rc":0}\n' +
        "\x1ecomment-0002\n" +
        "\x1egone-0003\nsize 12\n" + '{"start":300,"end":301,"rc":1}\n' +
        "\x1egone-0004\n" + '{"start":100,"end":101,"rc":0}\n{"start":200,"end":201,"rc":0}\n' +
        "\x1erunning-0005\n" + 'running 1 {"start":400,"pid":7}\n' +
        "\x1edead-0006\n" + 'running 0 {"start":50,"pid":8}\n' +
        "\x1enever-0007\n");
    const text = "0 1 * * * /usr/local/libexec/cockpit-cronjobs-run used-0001 'x'\n" +
                 "# comment-0002 was here\n" +
                 "0 2 * * * root echo xgone-0004 gone-00041 gone-0004x\n";
    const o = R.orphans(byId, text);
    assert.deepStrictEqual(o.map(x => x.id), ["gone-0003", "gone-0004", "dead-0006", "never-0007"]);
    assert.deepStrictEqual(o[0], { id: "gone-0003", count: 1, last: byId["gone-0003"].runs[0], kb: 12 });
    assert.strictEqual(o[1].count, 2);
    assert.strictEqual(o[1].last.start, 200);
    assert.strictEqual(o[2].last.aborted, true);
    assert.strictEqual(o[3].last, null);
    assert.deepStrictEqual(R.orphans({}, text), []);
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
