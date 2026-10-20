// SPDX-License-Identifier: Apache-2.0
/* Tests for cron.js. Run with: node test/cron.test.js */
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
    "30 2 * * sun", "0 0 1 jan *", "0 */2 * * *", "5-59/10 * * * *", "0 0 * * 7", "0 0 * * mon-fri",
    "@daily", "@reboot", "@hourly", "0-59/5 1,2,3 1-31/2 1-12 0-7", "0 0 * jan-dec/3 *", "0 0 1,10-20/5 * *"];
/* A step needs "*" or a range in front: "5/10" is refused by Debian's cron ("Step specified
   without range") and by cronie (get_range in entry.c), in every field. */
const invalid = ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *",
    "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *", "@sometimes", "1,,2 * * * *",
    "1-2-3 * * * *", "* * * foo *", "5/10 * * * *", "0 3/6 * * *", "0 0 1/2 * *", "0 0 * jan/3 *", "0 0 * * mon/2",
    "1,5/10 * * * *"];
valid.forEach(s => t("valid: " + s, () => assert.ok(C.parseSchedule(s).ok, s)));
invalid.forEach(s => t("invalid: " + s, () => assert.ok(!C.parseSchedule(s).ok, s)));
t("steps after * or a range", () => {
    assert.deepStrictEqual(C.parseSchedule("*/10 * * * *").fields[0].values, [0, 10, 20, 30, 40, 50]);
    assert.deepStrictEqual(C.parseSchedule("5-59/10 * * * *").fields[0].values, [5, 15, 25, 35, 45, 55]);
    assert.deepStrictEqual(C.parseSchedule("0 0 * jan-dec/3 *").fields[3].values, [1, 4, 7, 10]);
    assert.strictEqual(C.parseSchedule("0 3/6 * * *").field, "hour");
    assert.strictEqual(C.splitJob("5/10 * * * * /bin/true", false), null, "cron does not read such a line as a job");
});
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
/* cron's main loop (cron.c of Debian's cron and of cronie 1.7.2), minute by minute: the
   minutes in (fromMs, toMs] in which it starts the job. Every minute it compares its
   clock (local time in minutes) with the minute it handled last (timeDiff): 1 is the
   normal case; 2 to 5 runs all it missed; 6 to 180 the wildcard jobs of now and the
   fixed ones it missed (summer time starts); 0 down to -180 only the wildcard jobs of
   now (summer time ends); anything else counts as the clock being set. cronie reads a
   job with CRON_TZ (serverTz given, tz its zone) in that zone at the real time, and not
   at all while it catches up with the offset it had before. */
const offsets = new Map();
function zoneWall(ms, tz) {
    const key = tz + " " + ms;
    if (!offsets.has(key)) offsets.set(key, C.wallParts(ms, tz));
    return offsets.get(key);
}
function cronLoop(sched, fromMs, toMs, tz, serverTz) {
    const p = C.parseSchedule(sched);
    const own = !!serverTz;
    const server = own ? serverTz : tz;
    const wild = p.fields[0].star || p.fields[1].star;
    const clock = M => { const w = zoneWall(M * 60000, server); return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) / 60000; };
    const wallOf = v => {
        const d = new Date(v * 60000);
        return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
    };
    const runs = [];
    let M = Math.floor(fromMs / 60000) - 600;
    let gmtOff = clock(M) - M;
    let virtual = clock(M);
    for (M++; M * 60000 <= toMs; M++) {
        const oldOff = gmtOff;
        const now = clock(M);
        gmtOff = now - M;
        let run = false;
        const find = (v, doWild, doFixed, vOff) => {
            const hit = own ? vOff === gmtOff && matches(p, zoneWall((v - vOff) * 60000, tz)) : matches(p, wallOf(v));
            if (hit && (wild ? doWild : doFixed)) run = true;
        };
        const diff = now - virtual;
        if (diff === 1 || diff > 180 || diff < -180) {
            virtual = now;
            find(now, true, true, gmtOff);
        } else if (diff > 5) {
            find(now, true, false, gmtOff);
            for (let v = virtual + 1; v <= now; v++) find(v, false, true, v < now ? oldOff : gmtOff);
            virtual = now;
        } else if (diff > 0) {
            for (let v = virtual + 1; v <= now; v++) find(v, true, true, v < now ? oldOff : gmtOff);
            virtual = now;
        } else {
            find(now, true, false, gmtOff);
        }
        if (run && M * 60000 > fromMs) runs.push(M * 60000);
    }
    return runs;
}
const isoList = list => list.map(ms => new Date(ms).toISOString());

for (const tz of ["UTC", "Europe/Berlin"]) {
    for (const s of SCHEDS) {
        for (const from of FROMS) {
            t(`next ${tz} ${s} from ${new Date(from).toISOString()}`, () => {
                const got = C.nextRun(s, from, tz);
                /* UTC never changes, so there each minute counts once; in Berlin, three
                   days of cron's loop (the summer time starts or ends in two of them). */
                const days = tz === "UTC" ? 40 : 3;
                const exp = tz === "UTC" ? brute(s, from, tz, 60 * 24 * days) : cronLoop(s, from, from + days * 86400000, tz)[0];
                if (exp === undefined) { assert.ok(got === null || got - from > days * 86400000); return; }
                assert.strictEqual(new Date(got).toISOString(), new Date(exp).toISOString());
            });
        }
    }
}

/* Around every change of the clock in 2026, in zones with an hour (Berlin, New York,
   Sydney) and with half an hour (Lord Howe Island), all runs as cron's loop has them. */
function changesIn(tz, year) {
    const out = [];
    let prev = null;
    for (let ms = Date.UTC(year, 0, 1); ms < Date.UTC(year + 1, 0, 1); ms += 3600000) {
        const w = C.wallParts(ms, tz);
        const off = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - ms;
        if (prev !== null && off !== prev) out.push(ms);
        prev = off;
    }
    return out;
}
const DST_SCHEDS = ["* * * * *", "*/7 * * * *", "0 * * * *", "30 * * * *", "@hourly", "@daily", "0 2 * * *",
    "30 2 * * *", "15 2 * * *", "59 1 * * *", "0 3 * * *", "30 1 * * *", "45 0 * * *", "*/10 2 * * *",
    "*/15 0-3 * * *", "0 */2 * * *", "5 1-3 * * *", "0,30 2 * * 0", "0-59/20 2 * * *", "30 2,3 * * *",
    "0 1,2 * * *", "45 2 25 10 *", "30 2 29 3 *", "0 2 * * 0", "15 3 * * *", "30 0 * * *", "0 4 * * *"];
const ZONES = [["Europe/Berlin"], ["America/New_York"], ["Australia/Sydney"], ["Australia/Lord_Howe"],
    ["UTC", "Europe/Berlin"], ["America/New_York", "Europe/Berlin"], ["Europe/Berlin", "Europe/Berlin"],
    ["Europe/Berlin", "UTC"], ["Australia/Lord_Howe", "America/New_York"]];
for (const [tz, serverTz] of ZONES) {
    const changes = changesIn(tz, 2026).concat(serverTz ? changesIn(serverTz, 2026) : []);
    assert.ok(tz === "UTC" ? changes.length === 2 : changes.length >= 2, tz + " changes its clock");
    for (const at of changes) {
        const from = at - 14 * 3600000;
        const to = at + 12 * 3600000;
        t(`as cron's loop: ${tz}${serverTz ? " (CRON_TZ, cron in " + serverTz + ")" : ""} around ${new Date(at).toISOString()}`, () => {
            for (const s of DST_SCHEDS) {
                assert.deepStrictEqual(isoList(C.runsBetween(s, from, to, tz, 5000, serverTz)), isoList(cronLoop(s, from, to, tz, serverTz)), s);
            }
        });
    }
}

const B = "Europe/Berlin";
const on = (s, from, to, tz, serverTz) => isoList(C.runsBetween(s, Date.parse(from), Date.parse(to), tz || B, 100, serverTz));
t("summer time ends: a job every minute runs on in the repeated hour", () => {
    assert.strictEqual(new Date(C.nextRun("* * * * *", Date.parse("2026-10-25T00:59:00Z"), B)).toISOString(),
                       "2026-10-25T01:00:00.000Z");
});
t("summer time ends: a job at a fixed time runs once", () => {
    assert.deepStrictEqual(on("30 2 * * *", "2026-10-24T22:00:00Z", "2026-10-25T22:00:00Z"), ["2026-10-25T00:30:00.000Z"]);
    assert.deepStrictEqual(on("0 1,2 * * *", "2026-10-24T22:00:00Z", "2026-10-25T22:00:00Z"),
                           ["2026-10-24T23:00:00.000Z", "2026-10-25T00:00:00.000Z"]);
});
t("summer time ends: wildcard jobs run in both passes", () => {
    assert.deepStrictEqual(on("*/30 2 * * *", "2026-10-24T22:00:00Z", "2026-10-25T22:00:00Z"),
                           ["2026-10-25T00:00:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-25T01:00:00.000Z", "2026-10-25T01:30:00.000Z"]);
    assert.deepStrictEqual(on("0 * * * *", "2026-10-24T23:30:00Z", "2026-10-25T02:30:00Z"),
                           ["2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z", "2026-10-25T02:00:00.000Z"]);
});
t("summer time starts: fixed times of the skipped hour run right after the jump, once", () => {
    assert.deepStrictEqual(on("30 2 * * *", "2026-03-28T22:00:00Z", "2026-03-29T22:00:00Z"), ["2026-03-29T01:00:00.000Z"]);
    assert.deepStrictEqual(on("15,45 2 * * *", "2026-03-28T22:00:00Z", "2026-03-29T22:00:00Z"), ["2026-03-29T01:00:00.000Z"]);
    assert.deepStrictEqual(on("0 3 * * *", "2026-03-28T22:00:00Z", "2026-03-29T22:00:00Z"), ["2026-03-29T01:00:00.000Z"]);
});
t("summer time starts: wildcard jobs of the skipped hour do not catch up", () => {
    assert.deepStrictEqual(on("*/30 2 * * *", "2026-03-28T22:00:00Z", "2026-03-29T22:00:00Z"), []);
    assert.deepStrictEqual(on("0 * * * *", "2026-03-28T23:30:00Z", "2026-03-29T01:30:00Z"),
                           ["2026-03-29T00:00:00.000Z", "2026-03-29T01:00:00.000Z"]);
});
t("CRON_TZ (cronie): read in its zone; a fixed time in cron's repeated hour does not run", () => {
    assert.deepStrictEqual(on("0 0 * * *", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", "UTC", B), ["2026-07-02T00:00:00.000Z"]);
    assert.deepStrictEqual(on("30 1 * * *", "2026-10-24T22:00:00Z", "2026-10-25T22:00:00Z", "UTC", B), []);
    assert.deepStrictEqual(on("*/30 1 * * *", "2026-10-24T22:00:00Z", "2026-10-25T22:00:00Z", "UTC", B),
                           ["2026-10-25T01:00:00.000Z", "2026-10-25T01:30:00.000Z"]);
    assert.deepStrictEqual(on("30 2 * * *", "2026-03-28T22:00:00Z", "2026-03-29T22:00:00Z", B, B), [], "no catching up");
});
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

/* What cron reads in /etc/cron.d, as in database.c of Debian's cron and of cronie. */
const FILE = { regular: true, mode: 0o644, uid: 0, nlink: 1 };
const entry = (o, t) => Object.assign({ name: "job", link: null, target: t === null ? null : Object.assign({}, FILE, t) }, o);
const skip = (debian, o, t) => C.cronDSkip(entry(o, t || {}), debian);
t("cron.d, Debian: a plain file of root, 0644, one link is read", () => assert.strictEqual(skip(true, {}), null));
t("cron.d, Debian: name", () => assert.strictEqual(skip(true, { name: "job.sh" }), "name"));
t("cron.d, Debian: a link of root to such a file is read", () => assert.strictEqual(skip(true, { link: { uid: 0 } }), null));
t("cron.d, Debian: a link not owned by root", () => assert.strictEqual(skip(true, { link: { uid: 1000 } }), "linkOwner"));
t("cron.d, Debian: the link's owner comes first", () =>
    assert.strictEqual(C.cronDSkip(entry({ link: { uid: 1000 } }, null), true), "linkOwner"));
t("cron.d, Debian: a link to nothing", () => assert.strictEqual(C.cronDSkip(entry({ link: { uid: 0 } }, null), true), "broken"));
t("cron.d, Debian: not owned by root", () => assert.strictEqual(skip(true, {}, { uid: 1000 }), "owner"));
t("cron.d, Debian: the owner comes before the type", () =>
    assert.strictEqual(skip(true, {}, { uid: 1000, regular: false }), "owner"));
t("cron.d, Debian: not a regular file", () => assert.strictEqual(skip(true, { link: { uid: 0 } }, { regular: false }), "notFile"));
t("cron.d, Debian: writable by group", () => assert.strictEqual(skip(true, {}, { mode: 0o664 }), "writable"));
t("cron.d, Debian: writable by others", () => assert.strictEqual(skip(true, {}, { mode: 0o646 }), "writable"));
t("cron.d, Debian: more than one hard link", () => assert.strictEqual(skip(true, {}, { nlink: 2 }), "links"));
t("cron.d, Debian: executable or 0600 is fine", () => {
    assert.strictEqual(skip(true, {}, { mode: 0o755 }), null);
    assert.strictEqual(skip(true, {}, { mode: 0o600 }), null);
});
t("cron.d, cronie: a plain file of root, 0644 is read", () => assert.strictEqual(skip(false, {}), null));
t("cron.d, cronie: name", () => assert.strictEqual(skip(false, { name: "job~" }), "name"));
t("cron.d, cronie: the link itself is not checked", () => assert.strictEqual(skip(false, { link: { uid: 1000 } }), null));
t("cron.d, cronie: a link to nothing", () => assert.strictEqual(C.cronDSkip(entry({ link: { uid: 1000 } }, null), false), "broken"));
t("cron.d, cronie: not a regular file", () => assert.strictEqual(skip(false, {}, { regular: false, uid: 1000 }), "notFile"));
t("cron.d, cronie: writable by group or others", () => {
    assert.strictEqual(skip(false, {}, { mode: 0o664 }), "writable");
    assert.strictEqual(skip(false, {}, { mode: 0o602 }), "writable");
});
t("cron.d, cronie: executable, setuid, sticky or not readable by the owner", () => {
    [0o755, 0o744, 0o654, 0o4644, 0o1644, 0o244, 0o645].forEach(mode => assert.strictEqual(skip(false, {}, { mode }), "mode", mode.toString(8)));
    [0o644, 0o600, 0o400, 0o640, 0o444].forEach(mode => assert.strictEqual(skip(false, {}, { mode }), null, mode.toString(8)));
});
t("cron.d, cronie: the mode comes before the owner", () => assert.strictEqual(skip(false, {}, { mode: 0o755, uid: 1000 }), "mode"));
t("cron.d, cronie: not owned by root", () => assert.strictEqual(skip(false, {}, { uid: 1000 }), "owner"));
t("cron.d, cronie: hard links do not matter", () => assert.strictEqual(skip(false, {}, { nlink: 3 }), null));
t("system crontab parsing", () => {
    const s = "SHELL=/bin/sh\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n" +
              "@reboot www-data /x\n# 1 2 3 4 5 root no\n";
    const r = C.parseSystemCrontab(s);
    assert.deepStrictEqual(r.map(x => [x.schedule, x.user]), [["17 * * * *", "root"], ["@reboot", "www-data"]]);
    assert.strictEqual(r[0].command, "cd / && run-parts --report /etc/cron.hourly");
});
t("system crontab: each job has the variables set above it in its file", () => {
    const s = "SHELL=/bin/sh\nCRON_TZ=UTC\n0 0 * * * root a\nCRON_TZ = \"America/New_York\"\n0 0 * * * root b\n" +
              "# CRON_TZ=Asia/Tokyo\nMAILTO=''\n@daily root c\n";
    const r = C.parseSystemCrontab(s);
    assert.deepStrictEqual(r.map(x => [x.command, x.env.CRON_TZ, x.env.MAILTO]),
                           [["a", "UTC", undefined], ["b", "America/New_York", undefined], ["c", "America/New_York", ""]]);
    assert.strictEqual(r[0].env.SHELL, "/bin/sh");
    assert.notStrictEqual(r[0].env, r[1].env, "a copy for each job");
    assert.deepStrictEqual(C.parseSystemCrontab("0 0 * * * root d\n")[0].env, {}, "every file starts without any");
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

/* ---------- the environment cron gives a job ---------- */

/* PAM files as Debian (debian/cron.pam), cronie (pam/crond) and Fedora's authselect ship them. */
const PAM_DEBIAN = {
    cron: "# The PAM configuration file for the cron daemon\n\n@include common-auth\n\n" +
          "# Sets the loginuid process attribute\nsession    required     pam_loginuid.so\n\n" +
          "# Read environment variables from pam_env's default files, /etc/environment\n" +
          "# and /etc/security/pam_env.conf.\nsession       required   pam_env.so\n\n" +
          "# In addition, read system locale information\nsession       required   pam_env.so envfile=/etc/default/locale\n\n" +
          "@include common-account\n@include common-session-noninteractive\n\n" +
          "# Sets up user limits, please define limits for cron tasks\n# through /etc/security/limits.conf\n" +
          "session    required   pam_limits.so\n",
    "common-auth": "auth\t[success=1 default=ignore]\tpam_unix.so nullok\nauth\trequisite\t\t\tpam_deny.so\nauth\trequired\t\t\tpam_permit.so\n",
    "common-account": "account\t[success=1 new_authtok_reqd=done default=ignore]\tpam_unix.so\naccount\trequisite\t\t\tpam_deny.so\n",
    "common-session-noninteractive": "session\t[default=1]\t\t\tpam_permit.so\nsession\trequisite\t\t\tpam_deny.so\n" +
                                     "session\trequired\t\t\tpam_permit.so\nsession optional\t\t\tpam_umask.so\nsession\trequired\tpam_unix.so \n",
};
const PAM_CRONIE = {
    crond: "#\n# The PAM configuration file for the cron daemon\n#\n#\n# Although no PAM authentication is called, auth modules\n" +
           "# are used for credential setting\nauth       include    password-auth\naccount    required   pam_access.so\n" +
           "account    include    password-auth\n-session   optional   pam_keyinit.so revoke\n-session   optional   pam_limits.so\n" +
           "session    required   pam_loginuid.so\nsession    include    password-auth\n",
    "password-auth": "auth        required      pam_env.so\nauth        sufficient    pam_unix.so try_first_pass nullok\n" +
                     "auth        required      pam_deny.so\n\nsession     optional      pam_keyinit.so revoke\n" +
                     "-session    optional      pam_systemd.so\nsession     required      pam_unix.so\n",
};
t("PAM lines: includes, brackets, comments", () => {
    assert.deepStrictEqual(C.pamLines("@include common-auth\nsession [success=1 default=ignore] pam_succeed_if.so quiet # x\n" +
                                      "-session optional pam_systemd.so\nauth substack system-auth\n# auth include no\n"),
                           [{ include: "common-auth", type: null },
                            { type: "session", module: "pam_succeed_if.so", args: ["quiet"] },
                            { type: "session", module: "pam_systemd.so", args: [] },
                            { include: "system-auth", type: "auth" }]);
    assert.deepStrictEqual(C.pamLines("session required pam_env.so [envfile=/etc/my env]")[0].args, ["envfile=/etc/my env"]);
});
t("pam_env lines of cron's PAM service, in the order cron applies them", () => {
    assert.deepStrictEqual(C.pamEnvModules(PAM_DEBIAN, "cron", ["session", "auth"]), [[], ["envfile=/etc/default/locale"]]);
    assert.deepStrictEqual(C.pamEnvModules(PAM_CRONIE, "crond", ["auth", "session"]), [[]]);
    assert.deepStrictEqual(C.pamEnvModules({ cron: "@include cron\nsession required pam_env.so" }, "cron", ["session"]).length, 9,
                           "an include loop ends");
    assert.deepStrictEqual(C.pamEnvModules({}, "cron", ["session"]), []);
});
t("env files read the way pam_env reads them", () => {
    const env = C.applyEnvFile({ KEEP: "1", GONE: "x" },
        "# comment\n  PATH=\"/usr/local/bin:/usr/bin\"\nexport http_proxy=http://proxy:3128\nexport  TWO=no\n" +
        "PLAIN=a b # c\nSINGLE='s'\nINNER=\"a\"b\"\nOPEN=\"x\nTRAIL=\"x\" \nBAD-NAME=1\n=empty\nGONE\nLONG=a\\\n  b\nCR=v\r\nEMPTY=\n");
    assert.deepStrictEqual(env, { KEEP: "1", PATH: "/usr/local/bin:/usr/bin", http_proxy: "http://proxy:3128", PLAIN: "a b ",
                                  SINGLE: "s", INNER: "a\"b", OPEN: "x", TRAIL: "x\" ", LONG: "ab", CR: "v\r", EMPTY: "" });
});
t("cron's environment model: Debian, Ubuntu (-P), cronie", () => {
    const files = { "/etc/environment": "PATH=\"/usr/local/sbin:/usr/bin:/snap/bin\"\nhttp_proxy=http://p:1\n",
                    "/etc/default/locale": "LANG=de_DE.UTF-8\n" };
    const debian = C.cronEnvModel({ flavor: "debian", args: "/usr/sbin/cron -f", pam: PAM_DEBIAN, files });
    assert.deepStrictEqual(debian, { pam: { PATH: "/usr/local/sbin:/usr/bin:/snap/bin", http_proxy: "http://p:1", LANG: "de_DE.UTF-8" },
                                     path: "/usr/bin:/bin", user: false });
    const ubuntu = C.cronEnvModel({ flavor: "debian", pam: PAM_DEBIAN, files,
                                    args: "{ path=/usr/sbin/cron ; argv[]=/usr/sbin/cron -f -P $EXTRA_OPTS ; ignore_errors=no }" });
    assert.strictEqual(ubuntu.path, null, "-P in the unit: no default");
    assert.strictEqual(C.cronEnvModel({ flavor: "debian", args: "/usr/sbin/cron -fP" }).path, null, "-fP");
    assert.strictEqual(C.cronEnvModel({ flavor: "debian", args: "/usr/sbin/cron -f -L 15" }).path, "/usr/bin:/bin");
    const cronie = C.cronEnvModel({ flavor: "cronie", args: "/usr/sbin/crond -n", pam: PAM_CRONIE, files });
    assert.deepStrictEqual(cronie, { pam: { PATH: "/usr/local/sbin:/usr/bin:/snap/bin", http_proxy: "http://p:1" },
                                     path: "/usr/bin:/bin:/usr/sbin:/sbin", user: true });
    assert.strictEqual(C.cronEnvModel({ flavor: "cronie", args: "/usr/sbin/crond -n -P", managerPath: "/x:/y" }).path, "/x:/y",
                       "cronie -P: its own PATH");
    assert.deepStrictEqual(C.cronEnvModel({ flavor: "debian", pam: { cron: "session required pam_env.so readenv=0" }, files }).pam, {},
                           "readenv=0");
});
t("the environment of a job: PAM's, overridden by the crontab's and cron's own", () => {
    const model = { pam: { PATH: "/from/pam", LANG: "C.UTF-8", SHELL: "/bin/zsh", LOGNAME: "x", http_proxy: "p" }, path: null, user: false };
    assert.deepStrictEqual(C.jobEnvironment({ MAILTO: "", X: "1" }, null, "root", model),
                           { PATH: "/from/pam", LANG: "C.UTF-8", SHELL: "/bin/sh", LOGNAME: "root", http_proxy: "p", MAILTO: "",
                             X: "1", HOME: "/root" });
    assert.deepStrictEqual(C.jobEnvironment({ PATH: "/opt/bin" }, "/var/www", "www-data",
                                            { pam: { PATH: "/from/pam" }, path: "/usr/bin:/bin:/usr/sbin:/sbin", user: true }),
                           { PATH: "/opt/bin", SHELL: "/bin/sh", HOME: "/var/www", LOGNAME: "www-data", USER: "www-data" });
    assert.deepStrictEqual(C.jobEnvironment({}, null, "root"),
                           { SHELL: "/bin/sh", HOME: "/root", PATH: "/usr/bin:/bin", LOGNAME: "root" }, "no model: Debian's cron");
    assert.strictEqual(C.jobEnvironment({}, null, "nobody").HOME, "/", "no home known: /");
    assert.strictEqual(C.jobEnvironment({ HOME: "/srv" }, "/var/www", "www-data").HOME, "/srv", "the crontab's HOME wins");
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
t("cron's log: commands as cron writes them, the newest start of each", () => {
    assert.strictEqual(C.mkprints("a\tb\x01\x7f"), "a^Ib^A^?", "control characters as ^X, DEL as ^?");
    assert.strictEqual(C.mkprints("café €"), "caf\\303\\251 \\342\\202\\254", "bytes from 128 as \\ooo");
    assert.strictEqual(C.loggedCommand("date +\\%F > /tmp/x%input%more"), "date +%F > /tmp/x", "as cron runs it: before the first %");
    assert.strictEqual(C.loggedCommand("echo a\\\\b 'x'"), "echo a\\\\b 'x'", "other backslashes stay");
    const log = C.parseCronLog([
        "1792500000 (root) CMD (cd / && run-parts --report /etc/cron.hourly)",
        "1792503600 (root) CMD (cd / && run-parts --report /etc/cron.hourly)",
        "1792503000 (www-data) CMD (php -f /var/www/cron.php)",
        "1792503200 (root) CMD (echo \": (x) CMD (y)\")",
        "1792503300 (root) CMD (date +%F > /tmp/x)",
        "1792503400 (root) MAIL (mailed 10 bytes)", "x (root) CMD (y)", "1792503500 (a b) CMD (y)", "",
    ].join("\n"));
    assert.strictEqual(log.size, 4);
    assert.strictEqual(C.lastStart(log, "root", "cd / && run-parts --report /etc/cron.hourly"), 1792503600000, "the newest");
    assert.strictEqual(C.lastStart(log, "www-data", "php -f /var/www/cron.php"), 1792503000000);
    assert.strictEqual(C.lastStart(log, "root", "php -f /var/www/cron.php"), null, "another user's start is not root's");
    assert.strictEqual(C.lastStart(log, "root", "echo \": (x) CMD (y)\""), 1792503200000, "brackets in the command");
    assert.strictEqual(C.lastStart(log, "root", "date +\\%F > /tmp/x%in"), 1792503300000, "a job with %");
    assert.strictEqual(C.lastStart(null, "root", "x"), null, "no log");
});
t("record all: the jobs at the indexes recorded in one change, each with an ID of its own", () => {
    const W = C.WRAPPER_PATH;
    const text = "MAILTO=\"\"\n# nightly\n0 1 * * * /usr/local/bin/backup.sh\n" +
                 `*/5 * * * * ${W} backup-0001 '/usr/local/bin/backup.sh'\n` +
                 "0 2 * * * date +%F\n#[cronjobs:off] 0 3 * * * /usr/local/bin/backup.sh\n@reboot  /usr/local/bin/warmup.sh\n";
    const entries = C.parseUserCrontab(text);
    const before = JSON.stringify(entries);
    const seq = [0x0001, 0x0001, 0x0002, 0x0002, 0x0003, 0x0007];
    const out = C.captureJobs(entries, entries.map((e, i) => i), () => seq.shift());
    assert.strictEqual(JSON.stringify(entries), before, "the entries given stay as they are");
    const lines = C.serializeUserCrontab(out).split("\n");
    assert.deepStrictEqual(lines, [
        "MAILTO=\"\"", "# nightly",
        `0 1 * * * ${W} backup-0002 '/usr/local/bin/backup.sh'`,
        `*/5 * * * * ${W} backup-0001 '/usr/local/bin/backup.sh'`,
        "0 2 * * * date +%F",
        `#[cronjobs:off] 0 3 * * * ${W} backup-0003 '/usr/local/bin/backup.sh'`,
        `@reboot ${W} warmup-0007 '/usr/local/bin/warmup.sh'`, "",
    ], "an ID taken in the crontab or by an earlier job is not given twice; a % and lines that are no job stay");
    assert.deepStrictEqual(seq, [], "an ID for each job recorded, none for the others");
    const again = C.captureJobs(out, out.map((e, i) => i), () => 9);
    assert.strictEqual(C.serializeUserCrontab(again), C.serializeUserCrontab(out), "recorded jobs stay as they are");
    assert.strictEqual(C.serializeUserCrontab(C.captureJobs(entries, [])), text, "no index: byte for byte");
    assert.strictEqual(C.serializeUserCrontab(C.captureJobs(entries, [1, 4, 99])), text, "a comment, a %, no line");
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
