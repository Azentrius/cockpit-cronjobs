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
        const r = run(sh, root, save(root), [C.cksum(BEFORE), "trim.timer", "stop"], { input: AFTER });
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
        const r = run(sh, root, save(root), [C.cksum(BEFORE), "trim.timer", "stop"], { input: AFTER, env: { FAKE_FAIL: "disable" } });
        assert.strictEqual(r.rc, 7);
        assert.ok(/Access denied/.test(r.err), r.err);
        assert.strictEqual(read(root, "root.crontab"), BEFORE);
    });

    t(sh + ": a conversion still enables and starts the timer", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), AFTER);
        const r = run(sh, root, save(root), [C.cksum(AFTER), "trim.timer"], { input: BEFORE });
        assert.strictEqual(r.rc, 0, r.err);
        assert.strictEqual(read(root, "root.crontab"), BEFORE);
        assert.strictEqual(read(root, "systemctl.log"), "enable --now trim.timer\n");
    });

    t(sh + ": without a crontab before, a failed timer leaves none", () => {
        const root = setup();
        const r = run(sh, root, save(root), [C.cksum(""), "trim.timer"], { input: AFTER, env: { FAKE_FAIL: "enable" } });
        assert.strictEqual(r.rc, 7);
        assert.strictEqual(read(root, "root.crontab"), null);
    });

    t(sh + ": a crontab changed meanwhile is not touched", () => {
        const root = setup();
        fs.writeFileSync(path.join(root, "root.crontab"), BEFORE + "0 4 * * * other\n");
        const r = run(sh, root, save(root), [C.cksum(BEFORE), "trim.timer", "stop"], { input: AFTER });
        assert.strictEqual(r.rc, 3);
        assert.strictEqual(read(root, "root.crontab"), BEFORE + "0 4 * * * other\n");
        assert.strictEqual(read(root, "systemctl.log"), null);
    });
}

/* ---------- UNITS_SCRIPT ---------- */

function units(root) {
    const s = appScript("UNITS_SCRIPT", { SD });
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
}

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
