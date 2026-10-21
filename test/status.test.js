// SPDX-License-Identifier: Apache-2.0
/* Tests for the status of Cron Jobs (status/cronjobs-status) with dash and bash, and with each awk
 * there is (mawk on Debian and Ubuntu, gawk on Fedora): the documents follow the shared status
 * format (schema 1), jobs are read as the page reads them (lib/cron.js is the oracle), failed runs
 * as lib/runs.js sees them, recorded or from the journal of a converted job, and the cron service
 * as the page asks for it. Run with: node test/status.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const C = require("../src/lib/cron.js");
const R = require("../src/lib/runs.js");
const SD = require("../src/lib/systemd.js");
const SAMPLE = require("./journal-sample.js");

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

/* Stand-ins for systemctl, pgrep and journalctl, first in PATH, answering as the real ones do for
   what the helper asks: the cron service FAKE_CRON ("UNIT STATE", or empty for none), the processes
   FAKE_PGREP (names), the journal of NAME.service from FAKE_JOURNAL/NAME.service.json and, without
   -u, cron's log from FAKE_JOURNAL/cron.log (as -o short-unix prints it), each from --since on as
   journalctl takes it. Each call of journalctl is logged to FAKE_JOURNAL/calls ("-" for cron's log). */
const FAKES = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-fakes-"));
fs.writeFileSync(path.join(FAKES, "systemctl"), `#!/bin/sh
for last; do :; done
set -f
set -- "$1" $FAKE_CRON
case $1 in
    show) if [ "\${2-}" = "$last" ]; then echo loaded; else echo not-found; fi ;;
    is-active) if [ "\${2-}" = "$last" ]; then echo "$3"; [ "$3" = active ]; else echo inactive; exit 3; fi ;;
    *) exit 1 ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(FAKES, "pgrep"), `#!/bin/sh
[ "$1" = -x ] || exit 2
case " $FAKE_PGREP " in *" $2 "*) exit 0 ;; esac
exit 1
`, { mode: 0o755 });
fs.writeFileSync(path.join(FAKES, "journalctl"), `#!/bin/sh
unit= since=0
while [ $# -gt 0 ]; do
    case $1 in
        -u) unit=$2; shift ;;
        --since) since=\${2#@}; shift ;;
    esac
    shift
done
echo "\${unit:--} $since" >> "$FAKE_JOURNAL/calls"
if [ -z "$unit" ]; then
    [ -f "$FAKE_JOURNAL/cron.log" ] || exit 0
    awk -v since="$since" '$1 + 0 >= since + 0' "$FAKE_JOURNAL/cron.log"
    exit 0
fi
f=$FAKE_JOURNAL/$unit.json
if [ ! -f "$f" ]; then echo "-- No entries --"; exit 0; fi
awk -v since="$since" '{
    if (match($0, /"__REALTIME_TIMESTAMP":"[0-9]+"/) && substr($0, RSTART + 24, RLENGTH - 25) + 0 < since * 1000000) next
    print
}' "$f"
`, { mode: 0o755 });

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-status-"));
    const fx = { base, state: path.join(base, "state"), spool: path.join(base, "spool"), units: path.join(base, "units"),
                 journal: path.join(base, "journal"), etc: path.join(base, "etc"), cron: "", pgrep: "", systemd: "yes",
                 cronArgs: undefined };
    for (const d of [fx.state, fx.spool, fx.units, fx.journal, fx.etc, path.join(fx.etc, "cron.d")]) fs.mkdirSync(d);
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
    const env = { PATH: FAKES + ":" + (awk.bin ? awk.bin + ":" : "") + "/usr/bin:/bin" };
    if (fx) Object.assign(env, { CRONJOBS_STATE_DIR: fx.state, CRONJOBS_SPOOL_DIR: fx.spool, CRONJOBS_PAGE_DIR: SRC });
    if (fx && fx.units) Object.assign(env, { CRONJOBS_UNIT_DIR: fx.units, CRONJOBS_SYSTEMD: fx.systemd, FAKE_JOURNAL: fx.journal,
                                             FAKE_CRON: fx.cron, FAKE_PGREP: fx.pgrep, CRONJOBS_ETC_DIR: fx.etc });
    if (fx && fx.cronArgs !== undefined) env.CRONJOBS_CRON_ARGS = fx.cronArgs;
    Object.assign(env, extra || {});
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
/* Where each item leads on the page (PLACES in src/app/tabs.js; test/ui_test.py follows them). */
const LINKS = { failed: "#/overview/results", unrecorded: "#/overview/crontab", cron: "#/overview/notices" };

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
        /* The place on the page, as the Status Board takes a link (LINK_RE in its src/lib/status.js). */
        assert.strictEqual(i.link, LINKS[i.id], i.id + " links its place");
        assert.ok(/^#\/[A-Za-z0-9/_-]{0,80}$/.test(i.link), i.link);
        assert.ok(ISO_RE.test(i.checked_at));
        assert.strictEqual(i.stale_after, 3600);
    });
    assert.deepStrictEqual(d.items.map(i => i.id), d.items.length ? ["failed", "unrecorded", "cron"] : []);
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

/* ---------- jobs converted to systemd timers ---------- */

/* NAME.service and NAME.timer as a conversion from the crontab of user writes them (lib/systemd.js). */
function convertedUnits(fx, name, user) {
    const command = "/usr/local/bin/" + name;
    fs.writeFileSync(path.join(fx.units, name + ".service"),
                     SD.serviceUnit({ name, user, line: "0 5 * * * " + command, shell: "/bin/sh", command, env: {} }));
    fs.writeFileSync(path.join(fx.units, name + ".timer"), SD.timerUnit({ name, user, specs: ["*-*-* 05:00:00"], persistent: false }));
}

/* The messages systemd logs about a run (see JOURNAL_MSG in lib/runs.js). */
const MSG = { starting: "7d4958e842da4a758f6c1cdc7b36dcc5", jobDone: "39f53479d3a045ac8e11786248231fbf",
              jobFailed: "be02cf6855d2428ba40df7e9d022f03d", succeeded: "7ad2d189f7e94e70a38c781354912448",
              failed: "d9b373ed55a64feb8242e02dbe79a49c", exited: "98e322203f7a4ed290d09fe03c09fe15" };
const usec = s => String(Math.round(s * 1e6));
let invocations = 0;

/* The journal of one run of a service, as journal-sample.js has them from systemd 259: started at t
   (seconds), ended by end: "ok", an exit code, "killed", or null for no end (running, or lost). */
function journalRun(t, end) {
    const id = (++invocations).toString(16).padStart(32, "0");
    const own = (s, fields) => JSON.stringify(Object.assign({ __REALTIME_TIMESTAMP: usec(s), _PID: "1", INVOCATION_ID: id }, fields));
    const lines = [own(t, { MESSAGE_ID: MSG.starting, MESSAGE: "Starting job.service..." }),
                   JSON.stringify({ __REALTIME_TIMESTAMP: usec(t + 0.1), _PID: "4242", _SYSTEMD_INVOCATION_ID: id, MESSAGE: "working" })];
    if (end === "ok") {
        lines.push(own(t + 0.2, { MESSAGE_ID: MSG.succeeded, MESSAGE: "job.service: Deactivated successfully." }),
                   own(t + 0.3, { MESSAGE_ID: MSG.jobDone, JOB_RESULT: "done", MESSAGE: "Finished job.service." }));
    } else if (end !== null) {
        const killed = end === "killed";
        lines.push(own(t + 0.2, { MESSAGE_ID: MSG.exited, EXIT_CODE: killed ? "killed" : "exited", EXIT_STATUS: killed ? "9" : String(end),
                                  MESSAGE: "job.service: Main process exited" }),
                   own(t + 0.3, { MESSAGE_ID: MSG.failed, UNIT_RESULT: killed ? "signal" : "exit-code",
                                  MESSAGE: "job.service: Failed with result." }),
                   own(t + 0.4, { MESSAGE_ID: MSG.jobFailed, JOB_RESULT: "failed", MESSAGE: "Failed to start job.service." }));
    }
    return lines;
}
function journal(fx, name, lines) {
    fs.writeFileSync(path.join(fx.journal, name + ".service.json"), lines.join("\n") + "\n");
}
/* The sample of systemd 259, moved so that it ends ago seconds before now. */
function sample(ago) {
    const stamps = SAMPLE.map(l => Number(JSON.parse(l).__REALTIME_TIMESTAMP));
    const shift = (NOW - ago) * 1e6 - Math.max(...stamps);
    return SAMPLE.map((l, k) => Object.assign(JSON.parse(l), { __REALTIME_TIMESTAMP: String(stamps[k] + shift) }))
        .map(o => JSON.stringify(o));
}
/* Whether a run of the last 24 hours in the journal failed or lost its end, as the page sees it. */
function pageSaysFailed(lines) {
    return R.parseJournal(lines.join("\n") + "\n", 20, 0).some(r => r.start >= NOW - 86400 && !r.running && R.outcome(r) !== "ok");
}
function journalCalls(fx) {
    const f = path.join(fx.journal, "calls");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n") : [];
}

/* ---------- cron's log ---------- */

/* An awk program of the helper, as it is there. */
const HELPER = fs.readFileSync(STATUS, "utf8");
const awkProgram = name => {
    const m = new RegExp("^" + name + "='([\\s\\S]*?)'$", "m").exec(HELPER);
    assert.ok(m, name);
    return m[1];
};
const runAwk = (awk, args, input) => spawnSync(awk.bin ? path.join(awk.bin, "awk") : "awk", args,
                                              { input, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } });

/* Commands with what cron does to them before it logs them: the % rules, bytes it escapes. */
const LOGGED = ["/bin/true", "date +\\%F > /tmp/x%input%more", "echo a\\\\%b", "echo a\\\\b 'x'", "printf 'café €'",
                "echo \x7f \x01", "echo\ttab", "echo 100%", "%", "\\%", "echo \\\\\\%", "echo '%' \"\\%\"", "a  b   c"];

for (const awk of AWKS.filter(a => a.bin)) {
    t(awk.name + ": jobs named as cron logs them, as the page names them (C.loggedCommand)", () => {
        const user = LOGGED.map(c => "* * * * * " + c).join("\n") + `\n@daily ${WRAP} rec-0001 'x'\n`;
        let r = runAwk(awk, ["-v", "q='", "-v", "owner=root", "-v", "sys=0", awkProgram("JOBS_AWK")], user);
        assert.strictEqual(r.status, 0, r.stderr.toString());
        assert.deepStrictEqual(r.stdout.toString("latin1").trim().split("\n"),
            C.parseUserCrontab(user).filter(e => e.kind === "job" && e.enabled)
                .map(e => C.unwrapCommand(e.command) ? "J rec-0001" : `U (root) CMD (${C.loggedCommand(e.command)})`));
        const system = "SHELL=/bin/sh\n" + LOGGED.map(c => "* * * * * root " + c).join("\n") +
                       "\n@daily www-data\tphp -f /var/www/café.php\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n";
        r = runAwk(awk, ["-v", "q='", "-v", "sys=1", awkProgram("JOBS_AWK")], system);
        assert.strictEqual(r.status, 0, r.stderr.toString());
        assert.deepStrictEqual(r.stdout.toString("latin1").trim().split("\n"),
            C.parseSystemCrontab(system).map(j => `U (${j.user}) CMD (${C.loggedCommand(j.command)})`));
    });

    t(awk.name + ": whether cron logs failures, read as the page reads it (C.cronLogs)", () => {
        for (const args of ["/usr/sbin/cron -f -P", "/usr/sbin/cron -f -P -L 15", "/usr/sbin/cron -fL7", "/usr/sbin/cron -L 5",
                            "/usr/sbin/cron -L 15 -L 2", "/usr/sbin/cron -L x", "/usr/sbin/cron -x ext -L 4", "/usr/sbin/cron -f -- -L 15",
                            "/usr/sbin/cron -L -1", "/usr/sbin/cron -L 4abc", "/usr/sbin/cron -L", "/usr/sbin/cron -L 12", "/usr/sbin/cron -L 3"]) {
            const r = runAwk(awk, [awkProgram("LEVEL_AWK")], args + "\n");
            assert.strictEqual(r.status === 0, C.cronLogs("debian", args, 0).failure, args);
        }
    });
}

/* A line of cron's log as journalctl -o short-unix prints it. */
const logLine = (sec, pid, msg) => `${sec}.250000 host CRON[${pid}]: ${msg}`;
function cronLog(fx, lines) {
    fs.writeFileSync(path.join(fx.journal, "cron.log"), lines.join("\n") + "\n");
}
const L15 = "/usr/sbin/cron -f -P -L 15";

for (const sh of SHELLS) {
    for (const awk of AWKS) {
        const name = sh + ", " + awk.name + ": ";

        t(name + "failures in cron's log count: jobs of /etc/crontab and /etc/cron.d by path, the others in number", () => {
            const fx = fixture();
            fx.cronArgs = L15;
            crontab(fx, "root", `MAILTO=""\n*/5 * * * * /usr/local/bin/backup.sh\n0 1 * * * date +\\%F > /tmp/x%input\n` +
                                `@daily /usr/local/bin/ok.sh\n* * * * * ${wrapped("rec-0001", "x")}\n`);
            runs(fx, "root", "rec-0001", [rec(NOW - 60, 0)]);
            fs.writeFileSync(path.join(fx.etc, "crontab"), "SHELL=/bin/sh\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n");
            fs.writeFileSync(path.join(fx.etc, "cron.d", "hibiscus-daily-sync"), "30 4 * * * root /opt/hibiscus/sync.sh\n");
            fs.writeFileSync(path.join(fx.etc, "cron.d", "web"), "45 4 * * * www-data\tphp -f /var/www/café.php\n");
            fs.writeFileSync(path.join(fx.etc, "cron.d", "not.read"), "0 3 * * * root /gone.sh\n");
            const cmd = (user, command, pid) => `(${user}) CMD ([${pid}] ${C.loggedCommand(command)})`;
            const fails = (pid, how) => `(CRON) error (grandchild #${pid} ${how})`;
            cronLog(fx, [
                /* more than 24 hours ago */
                logLine(NOW - 90000, 90, cmd("root", "/usr/local/bin/ok.sh", 91)), logLine(NOW - 89999, 90, fails(91, "failed with exit status 1")),
                logLine(NOW - 600, 100, cmd("root", "/usr/local/bin/backup.sh", 101)),
                logLine(NOW - 599, 100, fails(101, "failed with exit status 2")),
                logLine(NOW - 599, 100, `(root) END ([101] /usr/local/bin/backup.sh)`),
                logLine(NOW - 590, 110, cmd("root", "date +\\%F > /tmp/x%input", 111)),
                logLine(NOW - 589, 110, fails(111, "terminated by signal 9")),
                logLine(NOW - 580, 120, cmd("root", "/opt/hibiscus/sync.sh", 121)), logLine(NOW - 579, 120, fails(121, "failed with exit status 1")),
                logLine(NOW - 570, 130, cmd("www-data", "php -f /var/www/café.php", 131)),
                logLine(NOW - 569, 130, fails(131, "failed with exit status 255")),
                /* a job that is no longer there, one cron does not read, the run recorder, what feeds a % */
                logLine(NOW - 560, 140, cmd("root", "/gone.sh", 141)), logLine(NOW - 559, 140, fails(141, "failed with exit status 1")),
                logLine(NOW - 550, 150, cmd("root", `${WRAP} rec-0001 'x'`, 151)), logLine(NOW - 549, 150, fails(151, "failed with exit status 3")),
                logLine(NOW - 540, 160, cmd("root", "/usr/local/bin/ok.sh", 161)), logLine(NOW - 539, 160, fails(162, "terminated by signal 13")),
                logLine(NOW - 539, 160, "(root) END ([161] /usr/local/bin/ok.sh)"),
                /* without -L 8: the PID of the line that logged the start */
                logLine(NOW - 300, 171, "(root) CMD (cd / && run-parts --report /etc/cron.hourly)"),
                logLine(NOW - 299, 170, fails(171, "failed with exit status 1")),
            ]);
            const { en, de } = written(sh, awk, fx);
            const f = item(en, "failed");
            assert.deepStrictEqual([en.state, f.state, f.value, f.detail],
                                   ["danger", "danger", "5", "/etc/cron.d/hibiscus-daily-sync, /etc/cron.d/web, /etc/crontab and 2 more"]);
            assert.strictEqual(item(de, "failed").detail, "/etc/cron.d/hibiscus-daily-sync, /etc/cron.d/web, /etc/crontab und 2 weitere");
            assert.strictEqual(en.summary, "5 jobs failed in the last 24 hours.");
            assert.strictEqual(item(en, "unrecorded").detail,
                               "3 of 4 jobs in the crontabs of root and other users; their failures show in cron's log.");
            assert.strictEqual(item(de, "unrecorded").detail,
                               "3 von 4 Jobs in den Crontabs von root und anderen Benutzern; ihre Fehlschläge zeigt das Log von cron.");
            const calls = journalCalls(fx).filter(c => c.startsWith("- "));
            assert.strictEqual(calls.length, 1, calls.join("; "));
            assert.ok(Math.abs(Number(calls[0].split(" ")[1]) - (NOW - 86400)) < 600, calls[0]);
        });

        t(name + "only failures in cron's log: what the detail says without paths", () => {
            const fx = fixture();
            fx.cronArgs = L15;
            crontab(fx, "root", "*/5 * * * * /usr/local/bin/backup.sh\n");
            cronLog(fx, [logLine(NOW - 600, 100, "(root) CMD ([101] /usr/local/bin/backup.sh)"),
                         logLine(NOW - 599, 100, "(CRON) error (grandchild #101 failed with exit status 2)")]);
            let d = written(sh, awk, fx);
            assert.deepStrictEqual([item(d.en, "failed").value, item(d.en, "failed").detail], ["1", "1 job without recording, from cron's log"]);
            assert.strictEqual(item(d.de, "failed").detail, "1 Job ohne Aufzeichnung, aus dem Log von cron");
            if (!OTHER) return;
            crontab(fx, OTHER, "15 3 * * * /bin/report\n");
            convertedUnits(fx, `${OTHER}-backup`, OTHER);
            journal(fx, `${OTHER}-backup`, journalRun(NOW - 200, "killed"));
            cronLog(fx, [logLine(NOW - 600, 100, "(root) CMD ([101] /usr/local/bin/backup.sh)"),
                         logLine(NOW - 599, 100, "(CRON) error (grandchild #101 failed with exit status 2)"),
                         logLine(NOW - 500, 200, `(${OTHER}) CMD ([201] /bin/report)`),
                         logLine(NOW - 499, 200, "(CRON) error (grandchild #201 failed with exit status 1)")]);
            d = written(sh, awk, fx);
            assert.deepStrictEqual([item(d.en, "failed").value, item(d.en, "failed").detail],
                                   ["3", "2 jobs without recording, from cron's log; 1 timer converted from the crontab of another user"]);
            assert.strictEqual(item(d.de, "failed").detail,
                               "2 Jobs ohne Aufzeichnung, aus dem Log von cron; 1 aus der Crontab eines anderen Benutzers umgewandelter Timer");
            assert.ok(!d.raw.en.includes(OTHER) && !d.raw.de.includes(OTHER), "no user name");
        });

        t(name + "cron logs failures, none failed: ok, and says so", () => {
            const fx = fixture();
            fx.cronArgs = L15;
            crontab(fx, "root", "30 1 * * 0 /usr/sbin/fstrim -a\n");
            cronLog(fx, [logLine(NOW - 600, 100, "(root) CMD ([101] /usr/sbin/fstrim -a)"), logLine(NOW - 590, 100, "(root) END ([101] /usr/sbin/fstrim -a)")]);
            let d = written(sh, awk, fx);
            assert.deepStrictEqual([d.en.state, item(d.en, "failed").state, item(d.en, "failed").value, item(d.en, "failed").detail],
                                   ["ok", "ok", "0", "cron's log shows no failed job."]);
            assert.strictEqual(item(d.de, "failed").detail, "Das Log von cron zeigt keinen fehlgeschlagenen Job.");
            assert.strictEqual(d.en.summary, "No job failed in the last 24 hours.");
            assert.strictEqual(d.de.summary, "Kein Job ist in den letzten 24 Stunden fehlgeschlagen.");
            crontab(fx, "root", `30 1 * * 0 /usr/sbin/fstrim -a\n* * * * * ${wrapped("rec-0001", "x")}\n`);
            runs(fx, "root", "rec-0001", [rec(NOW - 60, 0)]);
            d = written(sh, awk, fx);
            assert.strictEqual(item(d.en, "failed").detail, "Recorded jobs: 1, none failed, and cron's log shows no failed job.");
            assert.strictEqual(item(d.de, "failed").detail, "Aufgezeichnete Jobs: 1, keiner fehlgeschlagen, und das Log von cron zeigt keinen fehlgeschlagenen Job.");
            convertedUnits(fx, "nightly", "root");
            journal(fx, "nightly", journalRun(NOW - 300, "ok"));
            d = written(sh, awk, fx);
            assert.strictEqual(item(d.en, "failed").detail,
                               "Recorded jobs: 1, timers converted from cron: 1; none failed, and cron's log shows no failed job.");
        });

        t(name + "cron logs no failures: its log is not read", () => {
            for (const args of ["/usr/sbin/cron -f -P", "/usr/sbin/cron -f -P -L 11", undefined]) {
                const fx = fixture();
                fx.cronArgs = args;
                crontab(fx, "root", "*/5 * * * * /usr/local/bin/backup.sh\n");
                cronLog(fx, [logLine(NOW - 600, 100, "(root) CMD ([101] /usr/local/bin/backup.sh)"),
                             logLine(NOW - 599, 100, "(CRON) error (grandchild #101 failed with exit status 2)")]);
                const { en } = written(sh, awk, fx);
                assert.deepStrictEqual([item(en, "failed").state, item(en, "failed").detail], ["none", "No job records its runs."], String(args));
                assert.strictEqual(item(en, "unrecorded").detail,
                                   "1 of 1 jobs in the crontabs of root and other users; their results are not known.");
                assert.deepStrictEqual(journalCalls(fx), [], "not read: " + args);
            }
        });

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

        t(name + "a converted job whose service failed counts, by the name of its timer", () => {
            const fx = fixture();
            crontab(fx, "root", `MAILTO=""\n# Converted to systemd timer nightly.timer by Cockpit Cron Jobs on 2026-10-20; ` +
                                `the line below is no longer used.\n#[cronjobs:off] 0 5 * * * /usr/local/bin/nightly\n` +
                                `*/5 * * * * ${wrapped("backup-1a2b", "backup.sh")}\n`);
            runs(fx, "root", "backup-1a2b", [rec(NOW - 60, 1)]);
            convertedUnits(fx, "nightly", "root");
            journal(fx, "nightly", journalRun(NOW - 7200, "ok").concat(journalRun(NOW - 600, 3)));
            const { en, de } = written(sh, awk, fx);
            assert.deepStrictEqual([en.state, item(en, "failed").value, item(en, "failed").detail], ["danger", "2", "backup-1a2b, nightly.timer"]);
            assert.strictEqual(item(de, "failed").detail, "backup-1a2b, nightly.timer");
            assert.strictEqual(en.summary, "2 jobs failed in the last 24 hours.");
            assert.deepStrictEqual([item(en, "unrecorded").state, item(en, "unrecorded").value], ["ok", "0"], "the line that is off is no job");
            /* the journal of that service only, from 24 hours ago */
            const calls = journalCalls(fx);
            assert.strictEqual(calls.length, 1, calls.join("; "));
            const [unit, since] = calls[0].split(" ");
            assert.strictEqual(unit, "nightly.service");
            assert.ok(Math.abs(Number(since) - (NOW - 86400)) < 600, since);
        });

        t(name + "converted jobs that ran fine, or have not run yet", () => {
            const fx = fixture();
            convertedUnits(fx, "fine-1", "root");
            convertedUnits(fx, "fine-2", "root");
            journal(fx, "fine-1", journalRun(NOW - 3600, "ok").concat(journalRun(NOW - 120, null)));
            const { en, de } = written(sh, awk, fx);
            const f = item(en, "failed");
            assert.deepStrictEqual([en.state, f.state, f.value, f.detail],
                                   ["ok", "ok", "0", "Recorded jobs: 0, timers converted from cron: 2; none failed."]);
            assert.strictEqual(item(de, "failed").detail, "Aufgezeichnete Jobs: 0, aus cron umgewandelte Timer: 2; keiner fehlgeschlagen.");
            assert.strictEqual(en.summary, "No recorded job and no converted timer failed in the last 24 hours.");
            assert.strictEqual(de.summary, "Kein aufgezeichneter Job und kein umgewandelter Timer ist in den letzten 24 Stunden fehlgeschlagen.");
            assert.strictEqual(journalCalls(fx).length, 2);
        });

        t(name + "the runs of a converted job, read from the journal as the page reads them", () => {
            const ok = journalRun(NOW - 300, "ok");
            const id = JSON.parse(ok[0]).INVOCATION_ID;
            /* lines the job writes itself, made to look like systemd's: they carry its own _PID */
            const forged = [
                JSON.stringify({ __REALTIME_TIMESTAMP: usec(NOW - 299), _PID: "4242", _SYSTEMD_INVOCATION_ID: id, INVOCATION_ID: id,
                                 MESSAGE_ID: MSG.failed, UNIT_RESULT: "exit-code", MESSAGE: "job.service: Failed with result." }),
                JSON.stringify({ MESSAGE: `x","_PID":"1","INVOCATION_ID":"${id}","MESSAGE_ID":"${MSG.failed}","y":"`,
                                 __REALTIME_TIMESTAMP: usec(NOW - 298), _PID: "4242", _SYSTEMD_INVOCATION_ID: id }),
            ];
            const twenty = k => journalRun(NOW - 3000 + k * 60, "ok");
            const cases = [
                ["the sample of systemd 259: failed, failed, killed", sample(300), true],
                ["its first run alone, a success", sample(300).slice(0, 5), false],
                ["a run going on", sample(300).slice(0, 3), false],
                ["a run that lost its end", sample(300).slice(0, 3).concat(journalRun(NOW - 60, "ok")), true],
                ["killed", journalRun(NOW - 300, "killed"), true],
                ["failed more than a day ago", journalRun(NOW - 90000, 2).concat(journalRun(NOW - 60, "ok")), false],
                ["a failure before the last 20 runs", journalRun(NOW - 4000, 1).concat(...Array.from({ length: 20 }, (_, k) => twenty(k))), false],
                ["a failure among the last 20 runs", journalRun(NOW - 4000, 1).concat(...Array.from({ length: 19 }, (_, k) => twenty(k))), true],
                ["lines of the job that look like systemd's", ok.concat(forged), false],
                ["no entries", [], false],
            ];
            for (const [what, lines, failed] of cases) {
                assert.strictEqual(pageSaysFailed(lines), failed, "the page: " + what);
                const fx = fixture();
                convertedUnits(fx, "job", "root");
                if (lines.length) journal(fx, "job", lines);
                assert.strictEqual(item(written(sh, awk, fx).en, "failed").state, failed ? "danger" : "ok", what);
            }
        });

        t(name + "units that are not a conversion's do not count", () => {
            const fx = fixture();
            const failing = unit => journal(fx, unit, journalRun(NOW - 300, 1));
            /* written by hand */
            fs.writeFileSync(path.join(fx.units, "hand.service"), "[Unit]\nDescription=hand\n\n[Service]\nExecStart=/bin/false\n");
            fs.writeFileSync(path.join(fx.units, "hand.timer"), "[Timer]\nOnCalendar=daily\n");
            failing("hand");
            /* a conversion's service through a link */
            const elsewhere = { units: path.join(fx.base, "elsewhere") };
            fs.mkdirSync(elsewhere.units);
            convertedUnits(elsewhere, "linked", "root");
            fs.symlinkSync(path.join(elsewhere.units, "linked.service"), path.join(fx.units, "linked.service"));
            fs.copyFileSync(path.join(elsewhere.units, "linked.timer"), path.join(fx.units, "linked.timer"));
            failing("linked");
            /* a service without its timer */
            convertedUnits(fx, "alone", "root");
            fs.unlinkSync(path.join(fx.units, "alone.timer"));
            failing("alone");
            /* the description of another name */
            convertedUnits(fx, "renamed", "root");
            fs.writeFileSync(path.join(fx.units, "renamed.timer"), SD.timerUnit({ name: "other", specs: ["daily"], persistent: false }));
            failing("renamed");
            /* from another user's crontab, but running as root */
            if (OTHER) {
                convertedUnits(fx, "mixed", OTHER);
                const s = path.join(fx.units, "mixed.service");
                fs.writeFileSync(s, fs.readFileSync(s, "utf8").replace(`User=${OTHER}\n`, "User=root\n"));
                failing("mixed");
            }
            /* a timer of systemd-run: in the journal only */
            failing("transient");
            const { en } = written(sh, awk, fx);
            assert.deepStrictEqual([item(en, "failed").state, item(en, "failed").detail], ["none", "No job records its runs."]);
            assert.deepStrictEqual(journalCalls(fx), [], "no journal read");
        });

        if (OTHER) t(name + "converted jobs of other users count, their names stay out", () => {
            const fx = fixture();
            convertedUnits(fx, `${OTHER}-report`, OTHER);
            journal(fx, `${OTHER}-report`, journalRun(NOW - 300, 4));
            let d = written(sh, awk, fx);
            assert.deepStrictEqual([item(d.en, "failed").value, item(d.en, "failed").detail], ["1", "1 timer converted from the crontab of another user"]);
            assert.strictEqual(item(d.de, "failed").detail, "1 aus der Crontab eines anderen Benutzers umgewandelter Timer");
            convertedUnits(fx, `${OTHER}-backup`, OTHER);
            journal(fx, `${OTHER}-backup`, journalRun(NOW - 200, "killed"));
            d = written(sh, awk, fx);
            assert.deepStrictEqual([item(d.en, "failed").value, item(d.en, "failed").detail], ["2", "2 timers converted from the crontabs of other users"]);
            assert.strictEqual(item(d.de, "failed").detail, "2 aus Crontabs anderer Benutzer umgewandelte Timer");
            convertedUnits(fx, "nightly", "root");
            journal(fx, "nightly", journalRun(NOW - 100, 1));
            d = written(sh, awk, fx);
            assert.deepStrictEqual([item(d.en, "failed").value, item(d.en, "failed").detail], ["3", "nightly.timer and 2 more"]);
            assert.strictEqual(item(d.de, "failed").detail, "nightly.timer und 2 weitere");
            assert.ok(!d.raw.en.includes(OTHER) && !d.raw.de.includes(OTHER), "no user name");
        });

        t(name + "without systemd, no converted job is read", () => {
            const fx = fixture();
            fx.systemd = "no";
            convertedUnits(fx, "nightly", "root");
            journal(fx, "nightly", journalRun(NOW - 300, 1));
            const { en } = written(sh, awk, fx);
            assert.strictEqual(item(en, "failed").state, "none");
            assert.deepStrictEqual(journalCalls(fx), []);
        });

        t(name + "the cron service, as the page asks for it", () => {
            const cron = (setup, jobs) => {
                const fx = fixture();
                Object.assign(fx, setup);
                if (jobs) crontab(fx, "root", jobs);
                const d = written(sh, awk, fx);
                return { en: d.en, de: d.de, c: item(d.en, "cron"), cde: item(d.de, "cron") };
            };
            let r = cron({});
            assert.deepStrictEqual([r.c.state, "value" in r.c, r.c.detail, r.cde.detail],
                                   ["none", false, "No cron service was found.", "Es wurde kein cron-Dienst gefunden."]);
            assert.deepStrictEqual([r.c.title, r.cde.title], ["Cron service", "Cron-Dienst"]);
            r = cron({ cron: "cron.service active" }, "* * * * * /bin/true\n");
            assert.deepStrictEqual([r.c.state, r.c.value, r.c.detail, r.cde.value, r.cde.detail],
                                   ["ok", "running", "cron.service is running.", "läuft", "cron.service läuft."]);
            assert.strictEqual(r.en.state, "ok", "known to run: ok, though no job records its runs");
            r = cron({ cron: "cronie.service active" });
            assert.strictEqual(r.c.detail, "cronie.service is running.");
            r = cron({ systemd: "no", pgrep: "crond" });
            assert.deepStrictEqual([r.c.state, r.c.detail, r.cde.detail], ["ok", "cron is running.", "cron läuft."]);
            /* stopped: a danger when the crontabs have jobs, else a warning */
            r = cron({ cron: "cron.service inactive" }, "* * * * * /bin/true\n");
            assert.deepStrictEqual([r.en.state, r.c.state, r.c.value, r.c.detail, r.cde.value, r.cde.detail],
                                   ["danger", "danger", "stopped", "cron.service is not running, so no cron job starts.", "gestoppt",
                                    "cron.service läuft nicht, daher startet kein cron-Job."]);
            assert.strictEqual(r.en.summary, "The cron service is not running, so no cron job starts.");
            assert.strictEqual(r.de.summary, "Der cron-Dienst läuft nicht, daher startet kein cron-Job.");
            r = cron({ cron: "crond.service failed" });
            assert.deepStrictEqual([r.en.state, r.c.state, r.c.detail], ["warning", "warning", "crond.service is not running, so no cron job starts."]);
            r = cron({ systemd: "no", pgrep: "" });
            assert.deepStrictEqual([r.c.state, r.c.detail], ["warning", "cron is not running, so no cron job starts."]);
            /* and a failed job besides */
            const fx = fixture();
            fx.cron = "cron.service inactive";
            crontab(fx, "root", `* * * * * ${wrapped("late-0001", "x")}\n`);
            runs(fx, "root", "late-0001", [rec(NOW - 60, 1)]);
            const d = written(sh, awk, fx);
            assert.strictEqual(d.en.summary, "The cron service is not running, so no cron job starts. 1 job failed in the last 24 hours.");
            assert.strictEqual(d.de.summary, "Der cron-Dienst läuft nicht, daher startet kein cron-Job. 1 Job ist in den letzten 24 Stunden fehlgeschlagen.");
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
