// SPDX-License-Identifier: Apache-2.0
/* Tests for lib/systemd.js. Run with: node test/systemd.test.js
 * Where systemd-analyze is installed, converted schedules are checked against it. */
"use strict";
const assert = require("assert");
const { execFileSync } = require("child_process");
const C = require("../src/lib/cron.js");
const SD = require("../src/lib/systemd.js");
const DE_S = require("../src/i18n/de.js").schedule;
const EN_S = require("../src/i18n/en.js").schedule;

let passed = 0;
let skipped = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.message); process.exitCode = 1; }
}

/* ---------- cron -> OnCalendar ---------- */

const CAL = {
    "30 2 * * *": ["*-*-* 02:30:00"],
    "*/15 * * * *": ["*-*-* *:00/15:00"],
    "0 9-17 * * 1-5": ["Mon..Fri *-*-* 09..17:00:00"],
    "0 6,18 * * *": ["*-*-* 06,18:00:00"],
    "0 0 1 * 1": ["*-*-01 00:00:00", "Mon *-*-* 00:00:00"],
    "0 0 * * 0,6": ["Sat,Sun *-*-* 00:00:00"],
    "0 0 * * 5-7": ["Fri..Sun *-*-* 00:00:00"],
    "0 0 * * 0-1": ["Mon,Sun *-*-* 00:00:00"],
    "@daily": ["*-*-* 00:00:00"],
    "@hourly": ["*-*-* *:00:00"],
    "@weekly": ["Sun *-*-* 00:00:00"],
    "@yearly": ["*-01-01 00:00:00"],
    "0 3 2 * *": ["*-*-02 03:00:00"],
    "5 4 * jan,jul *": ["*-01,07-* 04:05:00"],
    "0 */2 * * *": ["*-*-* 00/2:00:00"],
    "0 0 */2 * 1-5": ["Mon..Fri *-*-01/2 00:00:00"],
    "1,2,3,10 * * * *": ["*-*-* *:01..03,10:00"],
    "0 1 1-31 * *": ["*-*-* 01:00:00"],
};
Object.keys(CAL).forEach(s => t("calendar: " + s, () => {
    const r = SD.calendarFromCron(s);
    assert.ok(r.ok, s);
    assert.deepStrictEqual(r.specs, CAL[s]);
}));
t("calendar with a time zone", () => assert.deepStrictEqual(SD.calendarFromCron("30 2 * * *", "America/New_York").specs,
                                                             ["*-*-* 02:30:00 America/New_York"]));
t("calendar: @reboot", () => assert.deepStrictEqual(SD.calendarFromCron("@reboot"), { ok: false, reason: "reboot" }));
t("calendar: invalid", () => assert.strictEqual(SD.calendarFromCron("61 * * * *").ok, false));

/* Compare with systemd itself: the union of the expressions must give the same runs. */
function analyze(spec, n, tz) {
    const out = execFileSync("systemd-analyze", ["calendar", "--iterations=" + n, spec],
                             { env: { LC_ALL: "C", TZ: tz, PATH: process.env.PATH } }).toString();
    return SD.parseAnalyzeCalendar(out);
}
let haveAnalyze = false;
try { execFileSync("systemd-analyze", ["--version"]); haveAnalyze = true; } catch (_) { /* not installed */ }

const SCHEDULES = Object.keys(CAL).concat(["45 23 31 * *", "0 0 1,15 * 1", "59 1 * * *", "0 2 29 2 *",
    "*/7 3-5 * * *", "15 */6 * * 1-5", "0 12 * 2-11 sat", "30 4 1 1 *", "0,30 8-18 * * 1-5", "5-55/10 * * * *",
    "0 0 1-7 * 1", "0 22 * * 7"]);
if (haveAnalyze) {
    for (const tz of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"]) {
        SCHEDULES.forEach(s => t(`systemd agrees (${tz}): ${s}`, () => {
            const specs = SD.calendarFromCron(s).specs;
            const theirs = Array.from(new Set([].concat(...specs.map(x => analyze(x, 12, tz))))).sort((a, b) => a - b).slice(0, 12);
            const now = Date.now();
            const horizon = now + 5 * 365 * 86400000;
            const ours = C.runsBetween(s, now - 120000, horizon + 86400000, tz, 14);
            theirs.splice(0, theirs.length, ...theirs.filter(x => x <= horizon));
            const k = ours.indexOf(theirs[0]);
            assert.ok(k >= 0 && k <= 2, "first run " + new Date(theirs[0]).toISOString() + " vs " + ours.slice(0, 3).map(x => new Date(x).toISOString()));
            assert.deepStrictEqual(theirs.map(x => new Date(x).toISOString()),
                                   ours.slice(k, k + theirs.length).map(x => new Date(x).toISOString()));
        }));
    }
    t("systemd agrees on a calendar in another zone (CRON_TZ)", () => {
        const specs = SD.calendarFromCron("30 2 * * 1-5", "America/New_York").specs;
        const theirs = analyze(specs[0], 6, "Europe/Berlin");
        const now = Date.now();
        const ours = C.runsBetween("30 2 * * 1-5", now, now + 30 * 86400000, "America/New_York", 6);
        assert.deepStrictEqual(theirs, ours);
    });
} else {
    skipped++;
}

/* ---------- systemd-analyze output ---------- */

t("analyze output, local zone not UTC", () => {
    const out = "  Original form: daily\nNormalized form: *-*-* 00:00:00\n    Next elapse: Tue 2026-10-13 00:00:00 CEST\n" +
                "       (in UTC): Mon 2026-10-12 22:00:00 UTC\n       From now: 21h left\n" +
                "   Iteration #2: Wed 2026-10-14 00:00:00 CEST\n       (in UTC): Tue 2026-10-13 22:00:00 UTC\n" +
                "       From now: 1 day 21h left\n";
    assert.deepStrictEqual(SD.parseAnalyzeCalendar(out).map(x => new Date(x).toISOString()),
                           ["2026-10-12T22:00:00.000Z", "2026-10-13T22:00:00.000Z"]);
});
t("analyze output, UTC", () => {
    const out = "Normalized form: *-*-* 00:00:00\n    Next elapse: Tue 2026-10-13 00:00:00 UTC\n       From now: 21h left\n" +
                "   Iteration #2: Wed 2026-10-14 00:00:00 UTC\n";
    assert.deepStrictEqual(SD.parseAnalyzeCalendar(out).map(x => new Date(x).toISOString()),
                           ["2026-10-13T00:00:00.000Z", "2026-10-14T00:00:00.000Z"]);
});
t("analyze output, other zone without DST (no UTC line)", () => {
    const out = "    Next elapse: Tue 2026-10-13 00:00:00 GMT\n";
    assert.deepStrictEqual(SD.parseAnalyzeCalendar(out), [Date.UTC(2026, 9, 13)]);
});
t("analyze output, nothing", () => assert.deepStrictEqual(SD.parseAnalyzeCalendar("Failed to parse calendar specification"), []));

/* ---------- OnCalendar -> cron, descriptions ---------- */

const BACK = {
    "*-*-* 00:00:00": "0 0 * * *",
    "Mon *-*-* 00:00:00": "0 0 * * 1",
    "*-*-* 06,18:00:00": "0 6,18 * * *",
    "*-*-01 00:00:00": "0 0 1 * *",
    "*-*-* *:00/15:00": "*/15 * * * *",
    "Mon..Fri *-*-* 09:00:00": "0 9 * * 1-5",
    "Sat,Sun *-*-* 10:30:00": "30 10 * * 6,0",
    "Fri..Sun *-*-* 01:00:00": "0 1 * * 5-7",
    "*-*-* 00/2:00:00": "0 */2 * * *",
    "*-*-* 01..05:00:00": "0 1-5 * * *",
};
Object.keys(BACK).forEach(spec => t("back to cron: " + spec, () => assert.strictEqual(SD.calendarToCron(spec), BACK[spec])));
["*-*-* 00:00:30", "2027-*-* 00:00:00", "*-*-* 00:00:00 Europe/Berlin", "Mon *-*-01 00:00:00", "*-*~01 00:00:00", "garbage"]
    .forEach(spec => t("no cron for: " + spec, () => assert.strictEqual(SD.calendarToCron(spec), null)));

t("describe timers", () => {
    assert.strictEqual(SD.describeTimer({ calendar: ["*-*-* 00:00:00"], monotonic: [] }, DE_S), "Täglich um 00:00");
    assert.strictEqual(SD.describeTimer({ calendar: ["Mon *-*-* 00:00:00"], monotonic: [] }, EN_S), "On Mondays at 00:00");
    assert.strictEqual(SD.describeTimer({ calendar: ["*-*-* 06,18:00:00"], monotonic: [], randomizedUsec: 43200e6 }, DE_S),
                       "Täglich um 06:00 und 18:00, zufällig verzögert");
    assert.strictEqual(SD.describeTimer({ calendar: [], monotonic: [{ base: "OnBootUSec", usec: 900e6 }] }, DE_S),
                       "15min nach dem Systemstart");
    assert.strictEqual(SD.describeTimer({ calendar: [], monotonic: [{ base: "OnUnitActiveUSec", usec: 86400e6 }] }, EN_S),
                       "every 1d after the last start");
    assert.strictEqual(SD.describeTimer({ calendar: ["*-*-* 00:00:30"], monotonic: [] }, EN_S), "Custom schedule");
});
t("time spans", () => {
    assert.strictEqual(SD.formatSpan(43200e6), "12h");
    assert.strictEqual(SD.formatSpan(90e6), "1min 30s");
    assert.strictEqual(SD.formatSpan(86400e6 + 3600e6 + 60e6), "1d 1h");
    assert.strictEqual(SD.formatSpan(0), "0");
    assert.strictEqual(SD.formatSpan(1500), "1ms");
});

/* ---------- units ---------- */

t("unit names", () => {
    ["backup-db", "a", "x_y.z", "Backup2"].forEach(n => assert.ok(SD.validUnitName(n), n));
    ["", "-x", ".x", "a b", "a/b", "x.service", "x.timer", "a@b", "ä", "x".repeat(64)].forEach(n => assert.ok(!SD.validUnitName(n), n));
    assert.strictEqual(SD.suggestUnitName("/usr/local/bin/backup-db.sh >/dev/null"), "backup-db");
    assert.strictEqual(SD.suggestUnitName("!!!"), "cron-job");
});

/* A small reader for systemd's quoting (single quotes with C escapes, %% and $$), to
   check that what we write reads back as the original. The page itself verifies the
   real result through D-Bus before anything else changes. */
function systemdWords(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
        while (line[i] === " ") i++;
        if (i >= line.length) break;
        let w = "";
        if (line[i] === "'") {
            i++;
            while (i < line.length && line[i] !== "'") {
                if (line[i] === "\\") { w += line[i + 1]; i += 2; } else { w += line[i++]; }
            }
            i++;
        } else {
            while (i < line.length && line[i] !== " ") w += line[i++];
        }
        out.push(w.replace(/%%/g, "%").replace(/\$\$/g, "$"));
    }
    return out;
}
const NASTY = ["/usr/local/bin/backup-db.sh", "echo 'a' \"$HOME\" 100% \\n done", "printf '%s\\n' \\\\x", "a\\'b", "$$ ${X} %n %%"];
NASTY.forEach(cmd => t("ExecStart quoting: " + cmd, () => {
    const unit = SD.serviceUnit({ name: "x", line: "0 1 * * * " + cmd, shell: "/bin/sh", command: cmd, env: {} });
    const exec = /^ExecStart=(.*)$/m.exec(unit)[1];
    assert.deepStrictEqual(systemdWords(exec), ["/bin/sh", "-c", cmd]);
}));
t("Environment quoting", () => {
    assert.strictEqual(SD.envLine("A", "b c"), 'Environment="A=b c"');
    assert.strictEqual(SD.envLine("P", "50%"), 'Environment="P=50%%"');
    assert.strictEqual(SD.envLine("Q", 'say "hi" \\o/'), 'Environment="Q=say \\"hi\\" \\\\o/"');
});
t("service unit", () => {
    const env = SD.serviceEnvironment({ MAILTO: "", PATH: "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/bash" });
    assert.deepStrictEqual(env, { SHELL: "/bin/bash", PATH: "/usr/local/bin:/usr/bin:/bin" });
    const u = SD.serviceUnit({ name: "backup-db", line: "30 2 * * * /usr/local/bin/backup-db.sh", shell: "/bin/bash",
                               command: "/usr/local/bin/backup-db.sh", env });
    assert.ok(u.includes("\n[Service]\nType=oneshot\nUser=root\nWorkingDirectory=~\n"));
    assert.ok(u.includes('Environment="PATH=/usr/local/bin:/usr/bin:/bin"\nEnvironment="SHELL=/bin/bash"\n'));
    assert.ok(u.includes("ExecStart='/bin/bash' -c '/usr/local/bin/backup-db.sh'\n"));
    assert.ok(u.includes("#   30 2 * * * /usr/local/bin/backup-db.sh\n"));
    assert.ok(u.includes("Documentation=" + SD.DOC_URL));
    assert.ok(!/MAILTO|LOGNAME|USER=/.test(u));
    const home = SD.serviceUnit({ name: "x", shell: "/bin/sh", command: "true", env: SD.serviceEnvironment({ HOME: "/srv" }), workdir: "/srv" });
    assert.ok(home.includes("WorkingDirectory=/srv\n") && home.includes('Environment="HOME=/srv"'));
});
t("timer unit", () => {
    const u = SD.timerUnit({ name: "backup-db", specs: ["*-*-01 00:00:00", "Mon *-*-* 00:00:00"], persistent: false });
    assert.strictEqual(u, "[Unit]\nDescription=backup-db (from the root crontab)\nDocumentation=" + SD.DOC_URL + "\n\n" +
        "[Timer]\nOnCalendar=*-*-01 00:00:00\nOnCalendar=Mon *-*-* 00:00:00\nAccuracySec=1s\nPersistent=false\n\n" +
        "[Install]\nWantedBy=timers.target\n");
});
t("units start the way back to cron recognises them", () => {
    const service = SD.serviceUnit({ name: "x", line: "0 1 * * * true", shell: "/bin/sh", command: "true", env: {} }).split("\n");
    assert.strictEqual(service[0], SD.UNIT_HEADER);
    assert.ok(service.includes("Description=x (from the root crontab)"));
    assert.ok(SD.timerUnit({ name: "x", specs: ["*-*-* 01:00:00"], persistent: false }).split("\n")
        .includes("Description=x (from the root crontab)"));
});
t("conversion note", () => {
    const note = SD.convertNote("backup-db", "2026-10-12");
    /* The text since 2.1.0: older and newer versions read it. */
    assert.strictEqual(note, "# Converted to systemd timer backup-db.timer by Cockpit Cron Jobs on 2026-10-12; " +
                             "the line below is no longer used.");
    assert.deepStrictEqual(SD.parseConvertNote(note), { name: "backup-db", date: "2026-10-12" });
    assert.deepStrictEqual(SD.parseConvertNote(SD.convertNote("db.v2", "2026-01-02")), { name: "db.v2", date: "2026-01-02" });
    [note + " ", " " + note, "#" + note, note.replace("backup-db", "-x"), note.replace("backup-db", "x.timer"),
     note.replace("backup-db", "a b"), note.replace("2026-10-12", "12.10.2026"), "# backup-db", "", null]
        .forEach(line => assert.strictEqual(SD.parseConvertNote(line), null, String(line)));
});
if (haveAnalyze) {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    t("systemd-analyze verify accepts the units", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-units-"));
        const env = SD.serviceEnvironment({ PATH: "/usr/bin:/bin", X: "50% \"q\" \\" });
        fs.writeFileSync(path.join(dir, "cj-test.service"), SD.serviceUnit({ name: "cj-test", line: "x", shell: "/bin/sh",
            command: "echo 'it''s' \"$HOME\" 100% \\n", env }));
        fs.writeFileSync(path.join(dir, "cj-test.timer"), SD.timerUnit({ name: "cj-test", specs: ["Mon..Fri *-*-* 09..17:00:00"], persistent: true }));
        const out = execFileSync("systemd-analyze", ["verify", "--man=no", path.join(dir, "cj-test.service"), path.join(dir, "cj-test.timer")],
                                 { env: { SYSTEMD_LOG_LEVEL: "warning", PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] }).toString();
        assert.strictEqual(out.trim(), "");
    });
}

console.log(`${passed} passed${skipped ? ", systemd-analyze checks skipped (not installed)" : ""}${process.exitCode ? ", some FAILED" : ""}`);
