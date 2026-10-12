/* Tests for cron.js — run with: node test/cron.test.js */
"use strict";
const assert = require("assert");
const C = require("../src/lib/cron.js");
const DE_S = require("../src/i18n/de.js").schedule;
const EN_S = require("../src/i18n/en.js").schedule;

let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.message); process.exitCode = 1; }
}

const UBUNTU_TEMPLATE = [
    "# Edit this file to introduce tasks to be run by cron.",
    "# ",
    "# Each task to run has to be defined through a single line",
    "# indicating with different fields when the task will be run",
    "# and what command to run for the task",
    "# ",
    "# To define the time you can provide concrete values for",
    "# minute (m), hour (h), day of month (dom), month (mon),",
    "# and day of week (dow) or use '*' in these fields (for 'any').",
    "# ",
    "# Notice that tasks will be started based on the cron's system",
    "# daemon's notion of time and timezones.",
    "# ",
    "# Output of the crontab jobs (including errors) is sent through",
    "# email to the user the crontab file belongs to (unless redirected).",
    "# ",
    "# For example, you can run a backup of all your user accounts",
    "# at 5 a.m every week with:",
    "# 0 5 * * 1 tar -zcf /var/backups/home.tgz /home/",
    "# ",
    "# For more information see the manual pages of crontab(5) and cron(8)",
    "# ",
    "# m h  dom mon dow   command",
].join("\n");

const REAL_LIKE = UBUNTU_TEMPLATE + "\n" + [
    "MAILTO=\"\"",
    "0 3 2 * * /opt/plausible/update-geoip.sh >/dev/null 2>&1",
    "30 1 * * 0\t/usr/sbin/fstrim -a",
    "# 15 4 * * * /usr/local/bin/old-job.sh",
    "",
    "  @reboot   /usr/local/bin/at-boot.sh   ",
].join("\n") + "\n";

/* ---------- round trip ---------- */

t("round trip: template + jobs", () => assert.ok(C.roundTrips(REAL_LIKE)));
t("round trip: empty", () => assert.ok(C.roundTrips("")));
t("round trip: no trailing newline is normalized", () => {
    const s = "0 1 * * * a";
    assert.strictEqual(C.serializeUserCrontab(C.parseUserCrontab(s)), s + "\n");
    assert.ok(C.roundTrips(s));
});
t("round trip: CRLF kept", () => assert.ok(C.roundTrips("0 1 * * * a\r\n# x\r\n")));
t("round trip: blank lines at end kept", () => assert.ok(C.roundTrips("0 1 * * * a\n\n\n")));
t("round trip: odd lines kept", () => {
    const s = "garbage line that is not cron\n61 1 * * * bad-minute\n# comment\nSHELL=/bin/bash\n";
    assert.ok(C.roundTrips(s));
    const jobs = C.parseUserCrontab(s).filter(e => e.kind === "job");
    assert.strictEqual(jobs.length, 0);
});

/* ---------- classification ---------- */

t("template example is not a job", () => {
    const e = C.parseUserCrontab(REAL_LIKE);
    const jobs = e.filter(x => x.kind === "job");
    assert.deepStrictEqual(jobs.map(j => j.command), [
        "/opt/plausible/update-geoip.sh >/dev/null 2>&1",
        "/usr/sbin/fstrim -a",
        "/usr/local/bin/old-job.sh",
        "/usr/local/bin/at-boot.sh",
    ]);
    assert.deepStrictEqual(jobs.map(j => j.enabled), [true, true, false, true]);
    assert.strictEqual(jobs[3].schedule, "@reboot");
});
t("without template header a commented job counts as disabled", () => {
    const e = C.parseUserCrontab("# 0 5 * * 1 tar -zcf /x /y\n");
    assert.strictEqual(e[0].kind, "job");
    assert.strictEqual(e[0].enabled, false);
});
t("marker line is a disabled job", () => {
    const e = C.parseUserCrontab("#[cronjobs:off] 0 5 * * 1 /bin/true\n");
    assert.strictEqual(e[0].kind, "job");
    assert.strictEqual(e[0].enabled, false);
    assert.strictEqual(e[0].prefix, "#[cronjobs:off] ");
});
t("commented env and prose stay raw", () => {
    const e = C.parseUserCrontab("# MAILTO=root\n# run every night\n");
    assert.ok(e.every(x => x.kind === "raw"));
});

/* ---------- edits keep the rest byte for byte ---------- */

function jobIndex(entries, n) { return entries.map((e, i) => [e, i]).filter(x => x[0].kind === "job")[n][1]; }

t("disable keeps original text after marker", () => {
    const e = C.parseUserCrontab(REAL_LIKE);
    const i = jobIndex(e, 1);
    e[i] = C.setEnabled(e[i], false);
    const out = C.serializeUserCrontab(e);
    assert.ok(out.includes("\n#[cronjobs:off] 30 1 * * 0\t/usr/sbin/fstrim -a\n"));
    assert.strictEqual(out.replace("#[cronjobs:off] 30 1 * * 0\t", "30 1 * * 0\t"), REAL_LIKE);
});
t("disable then enable restores exact line", () => {
    let e = C.parseUserCrontab(REAL_LIKE);
    const i = jobIndex(e, 1);
    e[i] = C.setEnabled(C.setEnabled(e[i], false), true);
    assert.strictEqual(C.serializeUserCrontab(e), REAL_LIKE);
});
t("enable legacy disabled job strips '# '", () => {
    const e = C.parseUserCrontab(REAL_LIKE);
    const i = jobIndex(e, 2);
    e[i] = C.setEnabled(e[i], true);
    const out = C.serializeUserCrontab(e);
    assert.ok(out.includes("\n15 4 * * * /usr/local/bin/old-job.sh\n"));
    assert.ok(!out.includes("# 15 4"));
});
t("edit replaces only that line", () => {
    const e = C.parseUserCrontab(REAL_LIKE);
    const i = jobIndex(e, 0);
    e[i] = C.setJob(e[i], "0 4 2 * *", "/opt/plausible/update-geoip.sh", true);
    const out = C.serializeUserCrontab(e);
    const a = out.split("\n");
    const b = REAL_LIKE.split("\n");
    assert.strictEqual(a.length, b.length);
    const diff = a.map((l, k) => l === b[k] ? null : k).filter(k => k !== null);
    assert.deepStrictEqual(diff, [i]);
    assert.strictEqual(a[i], "0 4 2 * * /opt/plausible/update-geoip.sh");
});
t("edit disabled job keeps it disabled with its prefix", () => {
    const e = C.parseUserCrontab(REAL_LIKE);
    const i = jobIndex(e, 2);
    e[i] = C.setJob(e[i], "15 5 * * *", "/usr/local/bin/old-job.sh", false);
    assert.ok(C.serializeUserCrontab(e).includes("\n# 15 5 * * * /usr/local/bin/old-job.sh\n"));
});
t("add to empty crontab", () => {
    const e = C.parseUserCrontab("");
    e.push(C.newJob("@daily", "/bin/true"));
    assert.strictEqual(C.serializeUserCrontab(e), "@daily /bin/true\n");
});
t("delete removes only that line", () => {
    const e = C.parseUserCrontab(REAL_LIKE);
    const i = jobIndex(e, 0);
    e.splice(i, 1);
    const out = C.serializeUserCrontab(e);
    assert.strictEqual(out, REAL_LIKE.replace("0 3 2 * * /opt/plausible/update-geoip.sh >/dev/null 2>&1\n", ""));
});
t("added job is parsed back as the same job", () => {
    const e = C.parseUserCrontab(REAL_LIKE);
    e.push(C.newJob("*/10 * * * 1-5", "/usr/bin/env FOO=1 /bin/echo 'a  b'", false));
    const back = C.parseUserCrontab(C.serializeUserCrontab(e)).filter(x => x.kind === "job").pop();
    assert.strictEqual(back.schedule, "*/10 * * * 1-5");
    assert.strictEqual(back.command, "/usr/bin/env FOO=1 /bin/echo 'a  b'");
    assert.strictEqual(back.enabled, false);
});

/* ---------- validation ---------- */

const valid = ["* * * * *", "0 3 * * *", "*/15 * * * *", "0 9-17 * * 1-5", "0 0 1,15 * *",
    "30 2 * * sun", "0 0 1 jan *", "0 */2 * * *", "5/10 * * * *", "0 0 * * 7", "0 0 * * mon-fri",
    "@daily", "@reboot", "@hourly", "0-59/5 1,2,3 1-31/2 1-12 0-7"];
const invalid = ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *",
    "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *", "@sometimes", "1,,2 * * * *",
    "1-2-3 * * * *", "* * * foo *"];
valid.forEach(s => t("valid: " + s, () => assert.ok(C.parseSchedule(s).ok, s)));
invalid.forEach(s => t("invalid: " + s, () => assert.ok(!C.parseSchedule(s).ok, s)));
t("dow 7 is sunday", () => assert.deepStrictEqual(C.parseField("7", { key: "dow", min: 0, max: 7, names: [], nameBase: 0 }).values, [0]));

/* ---------- descriptions ---------- */

const DE = {
    "0 3 2 * *": "Am 2. jedes Monats um 03:00",
    "30 1 * * 0": "Sonntags um 01:30",
    "17 * * * *": "Stündlich zu Minute 17",
    "25 6 * * *": "Täglich um 06:25",
    "47 6 * * 7": "Sonntags um 06:47",
    "52 6 1 * *": "Am 1. jedes Monats um 06:52",
    "0 */12 * * *": "Alle 12 Stunden",
    "10 3 * * *": "Täglich um 03:10",
    "30 3 * * 0": "Sonntags um 03:30",
    "* * * * *": "Jede Minute",
    "*/15 * * * *": "Alle 15 Minuten",
    "*/15 * * * 1-5": "Alle 15 Minuten, montags bis freitags",
    "0 6,18 * * *": "Täglich um 06:00 und 18:00",
    "0 0 1 1 *": "Am 1. Januar um 00:00",
    "0 4 * * 1,3,5": "Montags, mittwochs und freitags um 04:00",
    "0 0 1,15 * *": "Am 1. und 15. jedes Monats um 00:00",
    "0 0 1 * 1": "Am 1. jedes Monats oder montags um 00:00",
    "0 * * * *": "Stündlich",
    "0 2 * 1-3 *": "Von Januar bis März um 02:00",
    "0 9-17 * * 1-5": "Stündlich von 9 bis 17 Uhr, montags bis freitags",
    "@reboot": "Beim Systemstart",
    "@daily": "Täglich um 00:00",
    "@weekly": "Sonntags um 00:00",
    "0 0 * * 5-7": "Freitags bis sonntags um 00:00",
    "09,39 * * * *": "Stündlich zu Minute 9 und 39",
    "0,30 * * * 1-5": "Stündlich zu Minute 0 und 30, montags bis freitags",
};
Object.keys(DE).forEach(s => t("de: " + s, () => assert.strictEqual(C.describe(s, DE_S), DE[s])));
const EN = {
    "0 3 2 * *": "On day 2 of every month at 03:00",
    "30 1 * * 0": "On Sundays at 01:30",
    "25 6 * * *": "Daily at 06:25",
    "*/15 * * * 1-5": "Every 15 minutes, Monday to Friday",
    "0 0 1 1 *": "On January 1 at 00:00",
    "@reboot": "At system start",
    "09,39 * * * *": "Hourly at minutes 9 and 39",
};
Object.keys(EN).forEach(s => t("en: " + s, () => assert.strictEqual(C.describe(s, EN_S), EN[s])));
t("unusual schedule has no description", () => assert.strictEqual(C.describe("1-10/3 2,4 * * *", DE_S), null));

/* ---------- next run vs. brute force ---------- */

function matches(p, w) {
    const f = p.fields;
    const dow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
    if (!f[0].values.includes(w.mi) || !f[1].values.includes(w.h) || !f[3].values.includes(w.mo)) return false;
    const domOk = f[2].values.includes(w.d);
    const dowOk = f[4].values.includes(dow);
    return (f[2].star || f[4].star) ? (domOk && dowOk) : (domOk || dowOk);
}
function brute(sched, fromMs, tz, maxMinutes) {
    const p = C.parseSchedule(sched);
    let ms = Math.floor(fromMs / 60000) * 60000 + 60000;
    for (let i = 0; i < maxMinutes; i++, ms += 60000) {
        if (matches(p, C.wallParts(ms, tz))) return ms;
    }
    return undefined;
}
const SCHEDS = ["0 3 * * *", "30 1 * * 0", "*/7 * * * *", "0 3 2 * *", "15 2 * * *", "0 */6 * * 1-5",
    "45 23 31 * *", "0 0 1,15 * 1", "5 4 * * sun", "0 2 29 2 *", "@hourly", "@monthly", "59 1 * * *"];
const FROMS = [Date.UTC(2026, 9, 12, 0, 1), Date.UTC(2026, 2, 28, 23, 30), Date.UTC(2026, 9, 24, 23, 59),
    Date.UTC(2026, 11, 31, 23, 59, 30)];
for (const tz of ["UTC", "Europe/Berlin"]) {
    for (const s of SCHEDS) {
        for (const from of FROMS) {
            t(`next ${tz} ${s} from ${new Date(from).toISOString()}`, () => {
                const got = C.nextRun(s, from, tz);
                const exp = brute(s, from, tz, 60 * 24 * 40);
                if (exp === undefined) { assert.ok(got === null || got - from > 40 * 86400000); return; }
                // DST start in Berlin (2026-03-29 02:00 -> 03:00): cron runs jobs of the
                // skipped hour right after the jump, the minute walk skips them.
                const gap = tz === "Europe/Berlin" && got >= Date.UTC(2026, 2, 29, 1) && got < Date.UTC(2026, 2, 29, 2);
                if (gap && exp > got) return;
                assert.strictEqual(new Date(got).toISOString(), new Date(exp).toISOString());
            });
        }
    }
}
t("leap day finds 2028", () => {
    const got = C.nextRun("0 0 29 2 *", Date.UTC(2026, 9, 12), "UTC");
    assert.strictEqual(new Date(got).toISOString(), "2028-02-29T00:00:00.000Z");
});
t("impossible date never runs", () => assert.strictEqual(C.nextRun("0 0 31 2 *", Date.UTC(2026, 0, 1), "UTC"), null));
t("reboot has no next run", () => assert.strictEqual(C.nextRun("@reboot", Date.now(), "UTC"), null));

/* ---------- small helpers ---------- */

t("percent detection", () => {
    assert.ok(C.hasUnescapedPercent("date +%Y"));
    assert.ok(!C.hasUnescapedPercent("date +\\%Y"));
    assert.ok(!C.hasUnescapedPercent("/bin/true"));
});
t("cron.d names: Debian cron", () => {
    assert.ok(C.cronDNameValid("e2scrub_all", true));
    assert.ok(C.cronDNameValid("backup-daily-sync", true));
    assert.ok(!C.cronDNameValid("certbot.dpkg-old", true));
    assert.ok(!C.cronDNameValid("job.sh", true));
    assert.ok(!C.cronDNameValid("job~", true));
});
t("cron.d names: cronie", () => {
    assert.ok(C.cronDNameValid("0hourly", false));
    assert.ok(C.cronDNameValid("job.sh", false));
    assert.ok(!C.cronDNameValid(".hidden", false));
    assert.ok(!C.cronDNameValid("job~", false));
    assert.ok(!C.cronDNameValid("raid-check.rpmnew", false));
});
t("system crontab parsing", () => {
    const s = "SHELL=/bin/sh\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n" +
              "@reboot www-data /x\n# 1 2 3 4 5 root no\n";
    const r = C.parseSystemCrontab(s);
    assert.deepStrictEqual(r.map(x => [x.schedule, x.user]), [["17 * * * *", "root"], ["@reboot", "www-data"]]);
    assert.strictEqual(r[0].command, "cd / && run-parts --report /etc/cron.hourly");
});


/* ---------- what cron hands to the shell ---------- */

t("cronCommand: no percent", () => assert.deepStrictEqual(C.cronCommand("echo a"), { command: "echo a", stdin: null }));
t("cronCommand: escaped percent", () => assert.deepStrictEqual(C.cronCommand("date +\\%F"), { command: "date +%F", stdin: null }));
t("cronCommand: input after percent", () => assert.deepStrictEqual(C.cronCommand("mail -s x root%line 1%line 2"),
    { command: "mail -s x root", stdin: "line 1\nline 2\n" }));
t("cronCommand: double backslash before percent ends the command", () =>
    assert.deepStrictEqual(C.cronCommand("echo a\\\\%b"), { command: "echo a\\\\", stdin: "b\n" }));
t("cronCommand: other backslashes stay", () => assert.deepStrictEqual(C.cronCommand("grep \\. x"), { command: "grep \\. x", stdin: null }));
t("cronCommand: escaped percent in input", () => assert.deepStrictEqual(C.cronCommand("cat%50\\% done"), { command: "cat", stdin: "50% done\n" }));
t("percent detection follows cron", () => {
    assert.ok(C.hasUnescapedPercent("date +%Y"));
    assert.ok(!C.hasUnescapedPercent("date +\\%Y"));
    assert.ok(C.hasUnescapedPercent("x \\\\%"));
    assert.ok(!C.hasUnescapedPercent("/bin/true"));
});

/* ---------- environment ---------- */

t("env lines", () => {
    assert.deepStrictEqual(C.parseEnvLine("MAILTO=\"\""), { name: "MAILTO", value: "" });
    assert.deepStrictEqual(C.parseEnvLine("  PATH = /usr/local/bin:/usr/bin "), { name: "PATH", value: "/usr/local/bin:/usr/bin" });
    assert.deepStrictEqual(C.parseEnvLine("A='b c'"), { name: "A", value: "b c" });
    assert.strictEqual(C.parseEnvLine("# A=b"), null);
    assert.strictEqual(C.parseEnvLine("0 1 * * * A=b cmd"), null);
});
t("envBefore applies to the lines below only", () => {
    const e = C.parseUserCrontab("SHELL=/bin/bash\n0 1 * * * a\nPATH=/x\n0 2 * * * b\n");
    assert.deepStrictEqual(C.envBefore(e, 1), { SHELL: "/bin/bash" });
    assert.deepStrictEqual(C.envBefore(e, 3), { SHELL: "/bin/bash", PATH: "/x" });
});

/* ---------- recording wrapper lines ---------- */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-"));
const fake = path.join(tmp, "cockpit-cronjobs-run");
fs.writeFileSync(fake, "#!/bin/sh\nprintf '%s' \"$2\"\n", { mode: 0o755 });

const COMMANDS = ["/usr/local/bin/backup-db.sh", "echo 'it''s' \"$HOME\" `date` $(id -u)", "date +\\%F > /tmp/x",
    "printf '\\%s\\n' a\\ b", "cd /tmp && ls -1 | wc -l >> /var/log/n 2>&1", "echo \\\\\\%", "test -x /x || { echo no; exit 1; }",
    "echo 'single '\\'' quote'", "echo \"double \\\" quote\""];
COMMANDS.forEach(cmd => t("wrap round trip: " + cmd, () => {
    assert.ok(C.canCapture(cmd));
    const line = C.wrapCommand("job-1a2b", cmd, fake);
    const un = C.unwrapCommand(line);
    assert.deepStrictEqual(un, { path: fake, id: "job-1a2b", command: cmd });
    /* What cron makes of the wrapped line must hand the wrapper what cron would have
       made of the original line. */
    for (const sh of ["/bin/sh", "/bin/bash"]) {
        const got = execFileSync(sh, ["-c", C.cronCommand(line).command]).toString();
        assert.strictEqual(got, C.cronCommand(cmd).command, sh);
    }
    const job = C.splitJob("0 1 * * * " + line, false);
    assert.strictEqual(job.command, line);
}));
t("unwrap ignores other commands", () => {
    assert.strictEqual(C.unwrapCommand("/usr/local/bin/backup.sh"), null);
    assert.strictEqual(C.unwrapCommand("/usr/local/libexec/cockpit-cronjobs-run id \"double quoted\""), null);
    assert.strictEqual(C.unwrapCommand("/usr/local/libexec/cockpit-cronjobs-run bad/id 'x'"), null);
    assert.strictEqual(C.unwrapCommand("cockpit-cronjobs-run id 'x'"), null);
    assert.strictEqual(C.unwrapCommand("/usr/local/libexec/cockpit-cronjobs-run id ''"), null);
});
t("cannot capture % or line breaks", () => {
    assert.ok(!C.canCapture("date +%F"));
    assert.ok(!C.canCapture("a\nb"));
    assert.ok(C.canCapture("date +\\%F"));
});
t("job ids", () => {
    const seq = [0x1a2b, 0x1a2b, 0x00ff];
    const rnd = () => seq.shift();
    const taken = new Set();
    const a = C.makeJobId("/usr/local/bin/Backup-DB.sh --all", taken, rnd);
    assert.strictEqual(a, "backup-db-1a2b");
    taken.add(a);
    assert.strictEqual(C.makeJobId("/usr/local/bin/Backup-DB.sh", taken, rnd), "backup-db-00ff");
    assert.ok(C.JOB_ID_RE.test(C.makeJobId("!!!")));
    assert.ok(/^job-[0-9a-f]{4}$/.test(C.makeJobId("!!!")));
});
t("job names", () => {
    assert.strictEqual(C.jobName("/usr/local/bin/backup-db.sh >/dev/null 2>&1"), "backup-db.sh");
    assert.strictEqual(C.jobName("cd / && run-parts --report /etc/cron.hourly"), "cron.hourly");
    assert.strictEqual(C.jobName("test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }"), "cron.daily");
    assert.strictEqual(C.jobName("test -x /usr/bin/certbot -a \\! -d /run/systemd/system && perl -e 'sleep int(rand(43200))' && certbot -q renew"), "certbot");
    assert.strictEqual(C.jobName("FOO=1 nice -n 10 /opt/x/run.py"), "run.py");
    assert.strictEqual(C.jobName("sleep 30"), "sleep");
    assert.strictEqual(C.slug("Backup DB.sh"), "backup-db");
});
t("old marker still means off", () => {
    const e = C.parseUserCrontab("#[cronctl:off] 0 5 * * 1 /bin/true\n");
    assert.strictEqual(e[0].enabled, false);
    e[0] = C.setEnabled(e[0], true);
    assert.strictEqual(C.serializeUserCrontab(e), "0 5 * * 1 /bin/true\n");
});
t("runsBetween", () => {
    const from = Date.UTC(2026, 9, 12, 10, 6);
    const runs = C.runsBetween("*/15 * * * *", from, from + 3600000, "UTC", 100);
    assert.deepStrictEqual(runs.map(ms => new Date(ms).toISOString().slice(11, 16)), ["10:15", "10:30", "10:45", "11:00"]);
    assert.strictEqual(C.runsBetween("* * * * *", from, from + 86400000, "UTC", 25).length, 25);
    assert.deepStrictEqual(C.runsBetween("@reboot", from, from + 86400000, "UTC"), []);
});
t("template end", () => {
    assert.strictEqual(C.templateEnd(C.parseUserCrontab(REAL_LIKE)), 22);
    assert.strictEqual(C.templateEnd(C.parseUserCrontab("0 1 * * * a\n")), -1);
});

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
