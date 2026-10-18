// SPDX-License-Identifier: Apache-2.0
/* Tests for the root steps of going back to cron, with dash and bash: SAVE_SCRIPT
 * stopping a timer (and putting the crontab back when that fails) and UNITS_SCRIPT,
 * which only removes units Cron Jobs wrote. Fake crontab and systemctl commands, a
 * fake /etc/systemd/system. Run with: node test/units.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const C = require("../src/lib/cron.js");
const SD = require("../src/lib/systemd.js");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app", "system.js"), "utf8");
let passed = 0;
function t(name, fn) {
    try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.stack || e.message); process.exitCode = 1; }
}

const SHELLS = ["/bin/dash", "/bin/bash"].filter(s => fs.existsSync(s));
if (spawnSync("sh", ["-c", "command -v flock"]).status !== 0 || SHELLS.length === 0) {
    console.log("skipped: needs flock and dash or bash");
    process.exit(0);
}

/* A root script exactly as the page has it, with the constants it uses. */
function appScript(name, values) {
    const m = new RegExp("const " + name + " = `([\\s\\S]*?)`;").exec(APP);
    assert.ok(m, name + " in app/system.js");
    return new Function(...Object.keys(values), "return `" + m[1] + "`;")(...Object.values(values));
}

/* A fake root: bin/crontab keeps root's crontab in root.crontab, bin/systemctl logs its
   arguments to systemctl.log and fails for the verb in FAKE_FAIL. */
function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-units-"));
    ["bin", "state", "etc/systemd/system"].forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }));
    fs.writeFileSync(path.join(root, "bin", "crontab"),
        "#!/bin/sh\n" +
        "f=\"$FAKE/root.crontab\"\n" +
        "case \"$1 $2 $3\" in\n" +
        "  '-l -u root') [ -f \"$f\" ] || { echo 'no crontab for root' >&2; exit 1; }; cat \"$f\" ;;\n" +
        "  '-r -u root') rm -f \"$f\" ;;\n" +
        "  '-u root '*) cat \"$3\" > \"$f\" ;;\n" +
        "  *) echo \"fake crontab: $*\" >&2; exit 2 ;;\n" +
        "esac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, "bin", "systemctl"),
        "#!/bin/sh\n" +
        "echo \"$*\" >> \"$FAKE/systemctl.log\"\n" +
        "if [ \"$1\" = show ] && [ -n \"${FAKE_SLOW-}\" ]; then sleep \"$FAKE_SLOW\"; fi\n" +
        "if [ -n \"${FAKE_FAIL-}\" ] && [ \"$1\" = \"$FAKE_FAIL\" ]; then echo \"Failed to $1 unit: Access denied\" >&2; exit 1; fi\n",
        { mode: 0o755 });
    return root;
}
function run(shell, root, script, args, opts) {
    opts = opts || {};
    const r = spawnSync(shell, ["-c", script, "cockpit-cronjobs"].concat(args), {
        env: Object.assign({ PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C", FAKE: root }, opts.env || {}),
        input: opts.input || "",
        timeout: 30000,
    });
    return { rc: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}
const read = (root, f) => fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null;

/* ---------- SAVE_SCRIPT with a timer ---------- */

function save(root) {
    return appScript("SAVE_SCRIPT", { BACKUP_DIR: root + "/state/backups", STATE_DIR: root + "/state", KEEP_BACKUPS: 10 });
}
const BEFORE = "MAILTO=\"\"\n# Converted to systemd timer trim.timer by Cockpit Cron Jobs on 2026-10-12; the line below is no longer used.\n" +
               "#[cronjobs:off] 30 1 * * 0\t/usr/sbin/fstrim -a\n# ü\n";
const AFTER = "MAILTO=\"\"\n30 1 * * 0\t/usr/sbin/fstrim -a\n# ü\n";

for (const sh of SHELLS) {
    t(sh + ": back to cron writes the crontab, then stops and disables the timer", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), BEFORE);
        const r = run(sh, root, save(root), ["root", C.cksum(BEFORE), "trim.timer", "stop"], { input: AFTER });
        assert.strictEqual(r.rc, 0, r.err);
        assert.strictEqual(read(root, "root.crontab"), AFTER);
        assert.strictEqual(read(root, "systemctl.log"), "disable --now trim.timer\n");
        const backup = r.out.trim();
        assert.ok(backup.startsWith(root + "/state/backups/root-"), backup);
        assert.strictEqual(fs.readFileSync(backup, "utf8"), BEFORE);
    });

    t(sh + ": when the timer cannot be stopped, the crontab is put back byte for byte", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), BEFORE);
        const r = run(sh, root, save(root), ["root", C.cksum(BEFORE), "trim.timer", "stop"], { input: AFTER, env: { FAKE_FAIL: "disable" } });
        assert.strictEqual(r.rc, 7);
        assert.ok(/Access denied/.test(r.err), r.err);
        assert.strictEqual(read(root, "root.crontab"), BEFORE);
    });

    t(sh + ": a conversion still enables and starts the timer", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), AFTER);
        const r = run(sh, root, save(root), ["root", C.cksum(AFTER), "trim.timer"], { input: BEFORE });
        assert.strictEqual(r.rc, 0, r.err);
        assert.strictEqual(read(root, "root.crontab"), BEFORE);
        assert.strictEqual(read(root, "systemctl.log"), "enable --now trim.timer\n");
    });

    t(sh + ": without a crontab before, a failed timer leaves none", () => {
        const root = setup();
        const r = run(sh, root, save(root), ["root", C.cksum(""), "trim.timer"], { input: AFTER, env: { FAKE_FAIL: "enable" } });
        assert.strictEqual(r.rc, 7);
        assert.strictEqual(read(root, "root.crontab"), null);
    });

    t(sh + ": a crontab changed meanwhile is not touched", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), BEFORE + "0 4 * * * other\n");
        const r = run(sh, root, save(root), ["root", C.cksum(BEFORE), "trim.timer", "stop"], { input: AFTER });
        assert.strictEqual(r.rc, 3);
        assert.strictEqual(read(root, "root.crontab"), BEFORE + "0 4 * * * other\n");
        assert.strictEqual(read(root, "systemctl.log"), null);
    });
}

/* ---------- UNITS_SCRIPT ---------- */

function units(root) {
    const s = appScript("UNITS_SCRIPT", { SD, STATE_DIR: root + "/state" });
    assert.ok(s.includes("d=/etc/systemd/system\n"));
    return s.replace("d=/etc/systemd/system\n", "d=" + root + "/etc/systemd/system\n");
}
const UNITS = "etc/systemd/system/";
function writeUnits(root, name, as) {
    const service = SD.serviceUnit({ name: as || name, line: "30 1 * * 0 /usr/sbin/fstrim -a", shell: "/bin/sh",
                                     command: "/usr/sbin/fstrim -a", env: {} });
    const timer = SD.timerUnit({ name: as || name, specs: ["Sun *-*-* 01:30:00"], persistent: false });
    fs.writeFileSync(path.join(root, UNITS, name + ".service"), service);
    fs.writeFileSync(path.join(root, UNITS, name + ".timer"), timer);
}

for (const sh of SHELLS) {
    t(sh + ": units: ours, missing, or not ours", () => {
        const check = (root, name) => run(sh, root, units(root), ["check", name]).rc;
        let root = setup();
        writeUnits(root, "trim");
        assert.strictEqual(check(root, "trim"), 0);
        assert.strictEqual(check(root, "other"), 9);
        assert.strictEqual(read(root, "systemctl.log"), null, "a check changes nothing");

        fs.unlinkSync(path.join(root, UNITS, "trim.service"));
        assert.strictEqual(check(root, "trim"), 8, "only the timer");

        root = setup();
        writeUnits(root, "trim");
        fs.writeFileSync(path.join(root, UNITS, "trim.service"),
                         read(root, UNITS + "trim.service").replace(SD.UNIT_HEADER, "# Written by hand"));
        assert.strictEqual(check(root, "trim"), 8, "header changed");

        root = setup();
        writeUnits(root, "trim", "trim2");
        assert.strictEqual(check(root, "trim"), 8, "units of another name");

        root = setup();
        writeUnits(root, "real");
        fs.copyFileSync(path.join(root, UNITS, "real.timer"), path.join(root, UNITS, "trim.timer"));
        fs.symlinkSync(path.join(root, UNITS, "real.service"), path.join(root, UNITS, "trim.service"));
        assert.strictEqual(check(root, "trim"), 8, "a link");

        assert.strictEqual(check(root, "../real"), 2);
        assert.strictEqual(check(root, "-x"), 2);
        assert.strictEqual(check(root, ""), 2);
        assert.strictEqual(run(sh, root, units(root), ["delete", "real"]).rc, 2);
    });

    t(sh + ": units: removed only when ours", () => {
        const root = setup();
        writeUnits(root, "trim");
        writeUnits(root, "keep");
        fs.writeFileSync(path.join(root, UNITS, "keep.timer"), read(root, UNITS + "keep.timer") + "# changed\nPersistent=true\n");
        fs.writeFileSync(path.join(root, UNITS, "keep.service"), read(root, UNITS + "keep.service").replace("(from the root crontab)", "(mine)"));
        let r = run(sh, root, units(root), ["remove", "keep"]);
        assert.strictEqual(r.rc, 8);
        assert.ok(fs.existsSync(path.join(root, UNITS, "keep.service")) && fs.existsSync(path.join(root, UNITS, "keep.timer")));
        assert.strictEqual(read(root, "systemctl.log"), null);

        r = run(sh, root, units(root), ["remove", "trim"]);
        assert.strictEqual(r.rc, 0, r.err);
        assert.ok(!fs.existsSync(path.join(root, UNITS, "trim.service")) && !fs.existsSync(path.join(root, UNITS, "trim.timer")));
        assert.strictEqual(read(root, "systemctl.log"), "disable --now trim.timer\ndaemon-reload\nreset-failed trim.service trim.timer\n");
    });

    t(sh + ": units: removing waits for the crontab lock", () => {
        const root = setup();
        writeUnits(root, "trim");
        const r = spawnSync("sh", ["-c", "flock \"$1\" sleep 2 & sleep 0.5; t0=$(date +%s%N)\n" +
                                   "\"$2\" -c \"$3\" cockpit-cronjobs remove trim; echo \"rc=$?\"\n" +
                                   "echo \"waited=$(( ($(date +%s%N) - t0) / 1000000 ))\"; wait",
                                   "lock", root + "/state/.crontab.lock", sh, units(root)],
                            { env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C", FAKE: root }, timeout: 30000 });
        const out = r.stdout.toString();
        assert.ok(/rc=0/.test(out) && +(/waited=(\d+)/.exec(out) || [0, 0])[1] >= 1000, out + r.stderr.toString());
        assert.ok(!fs.existsSync(path.join(root, UNITS, "trim.service")));
    });
}

/* ---------- a conversion owns its units: WRITE_UNITS_SCRIPT, SAVE_SCRIPT, REMOVE_UNITS_SCRIPT ---------- */

function inRoot(root, name) {
    const s = appScript(name, { STATE_DIR: root + "/state" });
    assert.ok(s.includes("d=/etc/systemd/system\n"), name);
    return s.replace("d=/etc/systemd/system\n", "d=" + root + "/etc/systemd/system\n");
}
const TOKEN_A = "0123456789abcdef0123456789abcdef";
const TOKEN_B = "fedcba9876543210fedcba9876543210";
const unitsOf = who => ({
    service: SD.serviceUnit({ name: "trim", line: "30 1 * * 0 " + who, shell: "/bin/sh", command: who, env: {} }),
    timer: SD.timerUnit({ name: "trim", specs: ["Sun *-*-* 01:30:00"], persistent: false }) + "# " + who + "\n",
});
const A = unitsOf("/usr/sbin/fstrim -a");
const Bu = unitsOf("/usr/local/bin/other");
const write = (sh, root, u, token, env) => run(sh, root, inRoot(root, "WRITE_UNITS_SCRIPT"), ["trim", u.service, u.timer, token], { env });
const takeBack = (sh, root, token) => run(sh, root, inRoot(root, "REMOVE_UNITS_SCRIPT"), ["trim", token]);
const start = (sh, root, token, env) => {
    const cur = read(root, "root.crontab") || "";
    return run(sh, root, save(root), ["root", C.cksum(cur), "trim.timer", "", token],
               { input: cur.replace("30 1 * * 0 /usr/sbin/fstrim -a", "#[cronjobs:off] 30 1 * * 0 /usr/sbin/fstrim -a"), env });
};
const owner = root => read(root, "state/converting/trim");
const unitFiles = root => [read(root, UNITS + "trim.service"), read(root, UNITS + "trim.timer")];
const JOB = "30 1 * * 0 /usr/sbin/fstrim -a\n";

for (const sh of SHELLS) {
    t(sh + ": two conversions of one name at the same time: one writes, the other finds the name taken", () => {
        const root = setup();
        /* systemctl show takes a second, so both look at the name before either writes */
        const r = spawnSync("sh", ["-c",
            "\"$SH\" -c \"$W\" cockpit-cronjobs trim \"$S1\" \"$T1\" \"$K1\" > /dev/null 2>&1 & a=$!\n" +
            "\"$SH\" -c \"$W\" cockpit-cronjobs trim \"$S2\" \"$T2\" \"$K2\" > /dev/null 2>&1 & b=$!\n" +
            "wait $a; echo \"a=$?\"; wait $b; echo \"b=$?\"\n"], {
            env: { PATH: path.join(root, "bin") + ":/usr/bin:/bin", LC_ALL: "C", FAKE: root, FAKE_SLOW: "1", SH: sh,
                   W: inRoot(root, "WRITE_UNITS_SCRIPT"), S1: A.service, T1: A.timer, K1: TOKEN_A, S2: Bu.service, T2: Bu.timer, K2: TOKEN_B },
            timeout: 60000,
        });
        const rc = Object.fromEntries(r.stdout.toString().trim().split("\n").map(l => l.split("=")));
        assert.deepStrictEqual(Object.values(rc).sort(), ["0", "6"], r.stdout.toString() + r.stderr.toString());
        const [winner, token] = rc.a === "0" ? [A, TOKEN_A] : [Bu, TOKEN_B];
        assert.deepStrictEqual(unitFiles(root), [winner.service, winner.timer], "the units of the one that wrote, whole");
        assert.strictEqual(owner(root), token + "\n");
        assert.strictEqual((read(root, "systemctl.log").match(/^daemon-reload$/mg) || []).length, 1);
    });

    t(sh + ": the second conversion fails after the first finished: the first one's units stay", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), JOB);
        assert.strictEqual(write(sh, root, A, TOKEN_A).rc, 0);
        assert.strictEqual(write(sh, root, Bu, TOKEN_B).rc, 6, "name taken");
        let r = start(sh, root, TOKEN_A);
        assert.strictEqual(r.rc, 0, r.err);
        assert.strictEqual(owner(root), null, "a finished conversion keeps no token");
        r = takeBack(sh, root, TOKEN_B);
        assert.strictEqual(r.rc, 8, "the second one takes nothing back");
        r = takeBack(sh, root, TOKEN_A);
        assert.strictEqual(r.rc, 8, "a finished conversion is not taken back either");
        assert.deepStrictEqual(unitFiles(root), [A.service, A.timer]);
        assert.ok(!/disable/.test(read(root, "systemctl.log")), read(root, "systemctl.log"));
        assert.strictEqual(read(root, "root.crontab"), "#[cronjobs:off] " + JOB);
    });

    t(sh + ": the second conversion fails before the first finished: the first one still finishes", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), JOB);
        assert.strictEqual(write(sh, root, A, TOKEN_A).rc, 0);
        assert.strictEqual(write(sh, root, Bu, TOKEN_B).rc, 6);
        assert.strictEqual(takeBack(sh, root, TOKEN_B).rc, 8);
        assert.strictEqual(start(sh, root, TOKEN_B).rc, 8, "nor can it start the first one's timer");
        assert.strictEqual(read(root, "root.crontab"), JOB, "and nothing changed");
        assert.strictEqual(start(sh, root, TOKEN_A).rc, 0);
        assert.deepStrictEqual(unitFiles(root), [A.service, A.timer]);
        assert.strictEqual(read(root, "systemctl.log").split("\n").filter(l => /^(enable|disable)/.test(l)).join(";"), "enable --now trim.timer");
    });

    t(sh + ": a conversion takes back only its own units, also after they were replaced", () => {
        const root = setup();
        assert.strictEqual(write(sh, root, A, TOKEN_A).rc, 0);
        /* A's units go (by hand); B converts under the same name */
        fs.unlinkSync(path.join(root, UNITS, "trim.service"));
        fs.unlinkSync(path.join(root, UNITS, "trim.timer"));
        assert.strictEqual(write(sh, root, Bu, TOKEN_B).rc, 0);
        assert.strictEqual(takeBack(sh, root, TOKEN_A).rc, 8);
        assert.deepStrictEqual(unitFiles(root), [Bu.service, Bu.timer]);
        const r = takeBack(sh, root, TOKEN_B);
        assert.strictEqual(r.rc, 0, r.err);
        assert.deepStrictEqual(unitFiles(root), [null, null]);
        assert.strictEqual(owner(root), null);
        assert.ok(/disable --now trim.timer\ndaemon-reload\nreset-failed trim.service trim.timer\n$/.test(read(root, "systemctl.log")));
    });

    t(sh + ": when the timer cannot start, the crontab goes back and the units can still be taken back", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), JOB);
        assert.strictEqual(write(sh, root, A, TOKEN_A).rc, 0);
        assert.strictEqual(start(sh, root, TOKEN_A, { FAKE_FAIL: "enable" }).rc, 7);
        assert.strictEqual(read(root, "root.crontab"), JOB);
        assert.strictEqual(owner(root), TOKEN_A + "\n");
        assert.strictEqual(takeBack(sh, root, TOKEN_A).rc, 0);
        assert.deepStrictEqual(unitFiles(root), [null, null]);
    });

    t(sh + ": writing removes what it created when it fails, and leaves what was there", () => {
        let root = setup();
        let r = write(sh, root, A, TOKEN_A, { FAKE_FAIL: "daemon-reload" });
        assert.notStrictEqual(r.rc, 0);
        assert.deepStrictEqual(unitFiles(root), [null, null]);
        assert.strictEqual(owner(root), null);

        root = setup();
        fs.writeFileSync(path.join(root, UNITS, "trim.timer"), "mine\n");
        r = write(sh, root, A, TOKEN_A);
        assert.strictEqual(r.rc, 6);
        assert.deepStrictEqual(unitFiles(root), [null, "mine\n"]);
        assert.strictEqual(owner(root), null);

        root = setup();
        fs.symlinkSync("/nonexistent", path.join(root, UNITS, "trim.service"));
        assert.strictEqual(write(sh, root, A, TOKEN_A).rc, 6, "a link to nothing takes the name too");
    });

    t(sh + ": names and tokens are checked", () => {
        const root = setup();
        const W = inRoot(root, "WRITE_UNITS_SCRIPT");
        assert.strictEqual(run(sh, root, W, ["../x", "s", "t", TOKEN_A]).rc, 2);
        assert.strictEqual(run(sh, root, W, ["trim", "s", "t", "short"]).rc, 2);
        assert.strictEqual(run(sh, root, W, ["trim", "s", "t", TOKEN_A.toUpperCase()]).rc, 2);
        assert.strictEqual(run(sh, root, inRoot(root, "REMOVE_UNITS_SCRIPT"), ["trim", ""]).rc, 2);
        assert.strictEqual(run(sh, root, save(root), ["root", C.cksum(""), "../../x.timer", "", TOKEN_A], { input: JOB }).rc, 2);
        assert.strictEqual(run(sh, root, save(root), ["root", C.cksum(""), "trim.timer", "stop", TOKEN_A], { input: JOB }).rc, 2);
        assert.deepStrictEqual(unitFiles(root), [null, null]);
        assert.strictEqual(read(root, "root.crontab"), null);
    });
}

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
