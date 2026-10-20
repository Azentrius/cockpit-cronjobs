// SPDX-License-Identifier: Apache-2.0
/* Stand-in for cockpit.js in the browser tests of Cron Jobs.
 * Behaves like a Debian/Ubuntu server with cron, systemd and a few timers.
 * Query parameters: su, root=none, tz, tzmode=fallback, mta, systemd=no, cron=inactive,
 * wrapper=missing|0, delay. Tests change window.__mock at run time. */
(function () {
    "use strict";
    const params = new URLSearchParams(location.search);
    const C = () => window.CronLogic;
    const SD = () => window.CronSystemd;

    const TEMPLATE = [
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
    ].join("\n") + "\n";

    const WRAP = "/usr/local/libexec/cockpit-cronjobs-run";
    const ROOT_DEFAULT = TEMPLATE +
        "# GeoIP database for Plausible\n" +
        "0 3 2 * *\t" + WRAP + " update-geoip-1a2b '/opt/plausible/update-geoip.sh'\n" +
        "30 1 * * 0 /usr/sbin/fstrim -a\n" +
        "#[cronctl:off] 0 5 * * 1 tar -zcf /var/backups/home.tgz /home/\n" +
        "*/10 * * * * test -x /opt/x && echo '<b>not bold</b>' > /dev/null\n" +
        "@reboot /usr/local/bin/warmup.sh\n";

    const SYS = {
        etc: "SHELL=/bin/sh\n# m h dom mon dow user\tcommand\n" +
             "17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n" +
             "25 6\t* * *\troot\ttest -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }\n" +
             "47 6\t* * 7\troot\ttest -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.weekly; }\n" +
             "52 6\t1 * *\troot\ttest -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.monthly; }\n",
        crond: {
            "certbot": "SHELL=/bin/sh\n0 */12 * * * root test -x /usr/bin/certbot -a \\! -d /run/systemd/system && perl -e 'sleep int(rand(43200))' && certbot -q renew\n",
            "e2scrub_all": "30 3 * * 0 root test -e /run/systemd/system || SERVICE_MODE=1 /usr/lib/x86_64-linux-gnu/e2fsprogs/e2scrub_all_cron\n10 3 * * * root test -e /run/systemd/system || SERVICE_MODE=1 /sbin/e2scrub_all -A -r\n",
            "sysstat.dpkg-old": "5-55/10 * * * * root command -v debian-sa1 > /dev/null && debian-sa1 1 1\n",
            "latin1": "0 1 * * * root echo caf\x01 > /dev/null\n",
            "userfile": "0 2 * * * root /home/eve/run.sh\n",
        },
        /* As in SYSTEM_SCRIPT: raw mode (hex) and owner of the entry, then mode, owner and
           hard links of what opening it gives; default a regular file of root, 0644. */
        crondMeta: { "userfile": "81a4:1000:81a4:1000:1" },
        /* Other users' crontabs as crontab -l -u USER gives them (the spool file has a header
           line more); null: the file is there, but crontab cannot read it (user unknown). */
        users: { "www-data": "*/5 * * * * php -f /var/www/nextcloud/cron.php\n" },
        periodic: { hourly: [], daily: ["apt-compat", "dpkg", "logrotate", "man-db"], weekly: ["man-db"], monthly: [] },
    };

    const now = () => Math.floor(Date.now() / 1000);
    const RUNS = {
        "update-geoip-1a2b": {
            runs: [
                { start: now() - 86400 * 3, end: now() - 86400 * 3 + 252, rc: 0, trigger: "schedule", bytes: 31, truncated: false, out: "20261009T030000Z-101" },
                { start: now() - 86400 * 2, end: now() - 86400 * 2 + 3, rc: 0, trigger: "manual", bytes: 0, truncated: false, out: "" },
                { start: now() - 7200, end: now() - 7188, rc: 1, trigger: "schedule", bytes: 120, truncated: true, out: "20261012T010000Z-202" },
            ],
            running: [],
            kb: 16,
        },
        /* No line uses this one any more: a leftover. */
        "gone-0000": { runs: [{ start: now() - 600, end: now() - 590, rc: 0, trigger: "schedule", bytes: 0, truncated: false, out: "" }],
                       running: [], kb: 8 },
    };
    const OUTPUTS = {
        "update-geoip-1a2b/20261009T030000Z-101": "GeoLite2-City.mmdb aktualisiert\n",
        "update-geoip-1a2b/20261012T010000Z-202": "Fetching GeoLite2-City …\ncurl: (22) The requested URL returned error: 401\nupdate-geoip: download failed\n",
    };

    const wrapperParam = params.get("wrapper");
    /* What `cronjobs-status write` leaves for the menu icon, one line of JSON per language: ok, one
       failed job, out of date (written two hours ago, stale after one), or no files at all. */
    function statusFiles(kind) {
        if (kind === "missing") return {};
        const at = new Date(Date.now() - (kind === "stale" ? 2 * 3600e3 : 60e3)).toISOString().replace(/\.\d+Z$/, "Z");
        const bad = kind === "failed";
        const doc = de => {
            const say = (en, d) => de ? d : en;
            const item = (id, state, title, value, detail, link) =>
                ({ id, state, title, value, detail, link, checked_at: at, stale_after: 3600 });
            return JSON.stringify({
                schema: 1, addon: "cronjobs", label: "Cron Jobs", checked_at: at, state: bad ? "danger" : "ok",
                summary: bad ? say("1 job failed in the last 24 hours.", "1 Job ist in den letzten 24 Stunden fehlgeschlagen.")
                    : say("No recorded job failed in the last 24 hours.", "Kein aufgezeichneter Job ist in den letzten 24 Stunden fehlgeschlagen."),
                items: [
                    item("failed", bad ? "danger" : "ok", say("Failed jobs (last 24 hours)", "Fehlgeschlagene Jobs (letzte 24 Stunden)"),
                         bad ? "1" : "0", bad ? "update-geoip-1a2b" : say("Recorded jobs: 1, none failed.", "Aufgezeichnete Jobs: 1, keiner fehlgeschlagen."),
                         "#/overview/results"),
                    item("cron", "ok", say("Cron service", "Cron-Dienst"), say("running", "läuft"),
                         say("cron is running.", "cron läuft."), "#/overview/notices"),
                ],
            }) + "\n";
        };
        return { "/var/lib/cockpit-cronjobs/status.json": doc(false), "/var/lib/cockpit-cronjobs/status.de.json": doc(true) };
    }

    const M = window.__mock = {
        superuser: params.get("su") || "sudo",
        root: params.get("root") === "none" ? null : ROOT_DEFAULT,
        sys: SYS,
        runs: RUNS,
        outputs: OUTPUTS,
        /* Backups of the root crontab, oldest first: { path, content, mtime (s) [, latin1] }.
           latin1: a byte 0x01 in content is read as 0xE9 (not UTF-8). */
        backups: [],
        backupSeq: 0,
        userWrites: [],
        userRunsMade: [],
        failUserRuns: null,
        /* NO_OVERLAP_SCRIPT calls: [key of the runs, "on" or "off"] */
        noOverlapSets: [],
        failNoOverlap: null,
        /* commands run as another user: [user, command…] */
        asUser: [],
        /* UNITS_SCRIPT calls: [step, name, user]; wrongUser: what systemd reports as User= */
        unitChecks: [],
        wrongUser: null,
        timerChanges: {},
        /* journalctl -u UNIT -o json output by unit; else made up from the timers (journalOutput) */
        journal: {},
        journalReads: [],
        /* getent passwd, after the name */
        passwd: { "www-data": "33:33:www-data:/var/www:/usr/sbin/nologin", "ghost": "1001:1001::/home/ghost:/bin/sh" },
        userConflictNext: null,
        calls: [],
        jumps: [],
        /* cockpit.file: the status files the menu icon reads (status=ok|failed|stale|missing), what
           was read, and what the page sent the shell (transport.control). */
        files: statusFiles(params.get("status") || "ok"),
        fileReads: [],
        notes: [],
        writes: 0,
        delay: +(params.get("delay") || 40),
        failWrite: null,
        failBackup: null,
        failBackups: null,
        conflictNext: null,
        failSystem: false,
        failTimers: false,
        lockBusy: false,
        systemd: params.get("systemd") !== "no",
        cronActive: params.get("cron") !== "inactive",
        /* the run recorder installed: the version the page wants (C.WRAPPER_VERSION), 0 for an old one */
        wrapper: wrapperParam === "missing" ? null : { version: wrapperParam === "0" ? 0 : 3 },
        wrapperInstalls: [],
        removedRuns: [],
        orphanCalls: [],
        units: {},
        /* STATE_DIR/converting: the token of each conversion in progress, by unit name */
        converting: {},
        /* REMOVE_UNITS_SCRIPT calls: [name, removed] */
        takeBacks: [],
        enabled: [],
        failEnable: null,
        failDisable: null,
        unitsRemoved: [],
        analyzeShift: 0,
        mangleExec: false,
        runs_started: [],
        runningProcs: [],
    };

    const tz = () => params.get("tz") || "Etc/UTC";

    /* How cron gives jobs their environment (?cronenv=): Debian's cron by default (PATH
       /usr/bin:/bin, LANG from /etc/default/locale, a proxy from /etc/environment);
       "ubuntu": started with -P, PATH from /etc/environment; "nopath": -P without a PATH
       anywhere. With ?flavor=cronie: cronie's crond and system-auth. Then what systemd
       gives every service. */
    function cronEnvOutput() {
        const mode = params.get("cronenv") || "debian";
        const cronie = params.get("flavor") === "cronie";
        const sec = (n, body) => "\x1e" + n + "\n" + body + "\n";
        let out = sec("crond", "run /usr/sbin/" + (cronie ? "crond -n" : "cron -f" + (mode === "debian" ? "" : " -P")));
        if (M.systemd) out += sec("manager", "LANG=C.UTF-8\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin");
        if (cronie) {
            out += sec("pam:crond", "account    required   pam_access.so\naccount    include    system-auth\n" +
                                    "session    required   pam_loginuid.so\nsession    include    system-auth\nauth       include    system-auth");
            out += sec("pam:system-auth", "auth        required      pam_env.so\nauth        sufficient    pam_unix.so\n" +
                                          "session     required      pam_unix.so");
        } else {
            out += sec("pam:cron", "@include common-auth\nsession    required     pam_loginuid.so\n" +
                                   "session       required   pam_env.so\n# In addition, read system locale information\n" +
                                   "session       required   pam_env.so envfile=/etc/default/locale\n" +
                                   "@include common-account\n@include common-session-noninteractive\nsession    required   pam_limits.so");
            ["common-auth", "common-account", "common-session-noninteractive"].forEach(n => {
                out += sec("pam:" + n, "# " + n + "\n" + n.replace("common-", "").replace("-noninteractive", "") + " required pam_unix.so");
            });
            out += sec("env:/etc/default/locale", "LANG=C.UTF-8");
        }
        const env = mode === "ubuntu" ? "PATH=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin\"\n" : "";
        out += sec("env:/etc/environment", env + (mode === "nopath" ? "" : "# proxy for jobs\nexport http_proxy=\"http://proxy.example:3128\"\n"));
        return out;
    }

    function basicsOutput() {
        const fallback = params.get("tzmode") === "fallback";
        return "\x1ehost\npublic-host\n" +
               "\x1etz\n" + (fallback ? "n/a" : tz()) + "\n" +
               "\x1etz\n/usr/share/zoneinfo/" + tz() + "\n" +
               "\x1etz\n" +
               "\x1emta\n" + (params.get("mta") || "yes") + "\n" +
               "\x1ecrontab\nyes\n" +
               "\x1eflavor\n" + (params.get("flavor") || "debian") + "\n" +
               "\x1esystemd\n" + (M.systemd ? "yes" : "no") + "\n" +
               "\x1ecron\n" + (M.systemd ? "cron.service " + (M.cronActive ? "active" : "inactive") : "") + "\n" +
               "\x1ewrapper\n" + (M.wrapper ? M.wrapper.version : "missing") + "\n" +
               cronEnvOutput();
    }

    function systemOutput(privileged) {
        const out = [];
        const sec = n => out.push("\x1e" + n + "\n");
        sec("uid"); out.push((privileged ? "0" : "1000") + "\n");
        sec("etc"); out.push(M.sys.etc + "\n");
        Object.keys(M.sys.crond).forEach(f => { sec("d:" + (M.sys.crondMeta[f] || "81a4:0:81a4:0:1") + ":" + f); out.push(M.sys.crond[f] + "\n"); });
        if (privileged) Object.keys(M.sys.users).forEach(u => {
            sec("u:" + u);
            out.push("# DO NOT EDIT THIS FILE - edit the master and reinstall.\n" + (M.sys.users[u] || "") + "\n");
        });
        Object.keys(M.sys.periodic).forEach(p => {
            sec("p:" + p);
            M.sys.periodic[p].forEach(s => out.push("/etc/cron." + p + "/" + s + "\n"));
        });
        return out.join("");
    }

    function runsOutput() {
        const out = [];
        Object.keys(M.runs).forEach(id => {
            out.push("\x1e" + id + "\n");
            out.push("size " + (M.runs[id].kb || 4) + "\n");
            M.runs[id].runs.slice().reverse().forEach(r => out.push(JSON.stringify(r) + "\n"));
            M.runs[id].running.forEach(r => out.push("running " + (r.alive === false ? 0 : 1) + " " +
                JSON.stringify({ start: r.start, pid: r.pid || 4242, trigger: r.trigger || "schedule" }) + "\n"));
            if (M.runs[id].noOverlap) out.push("option no-overlap\n");
            (M.runs[id].skipped || []).forEach(s => out.push("skipped " + JSON.stringify(s) + "\n"));
        });
        return out.join("");
    }

    /* systemd-analyze calendar, computed with the page's own logic (good enough here). */
    function analyzeOutput(n, specs) {
        return specs.map(spec => {
            const m = /^(.*) ([A-Za-z]+\/[A-Za-z_]+)$/.exec(spec);
            const zone = m ? m[2] : tz();
            const cron = SD().calendarToCron(m ? m[1] : spec);
            let text = "\x1e" + spec + "\n";
            if (!cron) return text;
            let t = Date.now();
            for (let i = 0; i < n; i++) {
                const next = C().nextRun(cron, t, zone);
                if (next === null) break;
                const ms = next + M.analyzeShift;
                const d = new Date(ms);
                const stamp = d.toISOString().slice(0, 10) + " " + d.toISOString().slice(11, 19);
                text += (i === 0 ? "    Next elapse: " : "   Iteration #" + (i + 1) + ": ") + "Mon " + stamp + " UTC\n";
                t = next;
            }
            return text;
        }).join("");
    }

    /* The key of the runs a path is in (root's: ID/…, another user's: USER/ID/…). */
    function runsKey(path) {
        const m = /^\/var\/lib\/cockpit-cronjobs\/users\/([^/]+)\/runs\/(.*)$/.exec(path);
        return m ? m[1] + "/" + m[2] : path.replace("/var/lib/cockpit-cronjobs/runs/", "");
    }

    function fail(o) { const e = new Error(o.message || o.problem); Object.assign(e, o); throw e; }

    /* systemd's reading of ExecStart= (single quotes, C escapes, %% and $$). */
    function words(line) {
        const out = [];
        let i = 0;
        while (i < line.length) {
            while (line[i] === " ") i++;
            if (i >= line.length) break;
            let w = "";
            const q = line[i] === "'" || line[i] === "\"" ? line[i++] : null;
            while (i < line.length && (q ? line[i] !== q : line[i] !== " ")) {
                if (line[i] === "\\") { w += line[i + 1]; i += 2; } else { w += line[i++]; }
            }
            if (q) i++;
            out.push(w.replace(/%%/g, "%").replace(/\$\$/g, "$"));
        }
        return out;
    }
    function unitExec(name) {
        const u = M.units[name];
        const m = u && /^ExecStart=(.*)$/m.exec(u.service);
        if (!m) return [];
        const argv = words(m[1]);
        if (M.mangleExec) argv[2] = argv[2] + " ";
        return [[argv[0], argv, false, 0, 0, 0, 0, 0, 0, 0]];
    }
    function unitEnv(name) {
        const u = M.units[name];
        if (!u) return [];
        const out = [];
        u.service.split("\n").forEach(l => { if (l.startsWith("Environment=")) out.push(...words(l.slice(12))); });
        return out;
    }
    function unitUnset(name) {
        const u = M.units[name];
        const m = u && /^UnsetEnvironment=(.*)$/m.exec(u.service);
        return m ? m[1].split(/\s+/).filter(Boolean) : [];
    }

    function handle(args, opts, input) {
        const privileged = M.superuser !== "none";
        if (opts && opts.superuser === "require" && !privileged)
            fail({ problem: "access-denied", message: "" });
        const script = args[0] === "sh" ? args[2] : "";
        /* A command as another user (AS_USER_SCRIPT): user, then the command */
        if (/^as_user "\$user" "\$@"$/m.test(script)) {
            M.asUser.push(args.slice(4));
            return handle(args.slice(5), opts, input);
        }
        if (args[0] === "crontab" && args.includes("-l")) {
            const user = args[args.indexOf("-u") + 1];
            if (user !== "root") {
                if (!(user in M.sys.users)) fail({ exit_status: 1, problem: null, message: "no crontab for " + user + "\n" });
                if (M.sys.users[user] === null) fail({ exit_status: 1, problem: null, message: "crontab: user '" + user + "' unknown\n" });
                return opts.binary ? new TextEncoder().encode(M.sys.users[user]) : M.sys.users[user];
            }
            if (M.conflictNext !== null) { M.root = M.conflictNext; M.conflictNext = null; }
            if (M.root === null) fail({ exit_status: 1, problem: null, message: "no crontab for root\n" });
            const bytes = new TextEncoder().encode(M.root);
            return opts.binary ? (M.latin1 ? bytes.map(b => b === 0x01 ? 0xE9 : b) : bytes) : M.root;
        }
        /* Whether a job may overlap its previous run (NO_OVERLAP_SCRIPT): the directory, on or off */
        if (/: > "\$1\/no-overlap"/.test(script)) {
            if (M.failNoOverlap) fail({ exit_status: 1, problem: null, message: M.failNoOverlap });
            const key = runsKey(args[4]);
            M.noOverlapSets.push([key, args[5]]);
            M.runs[key] = M.runs[key] || { runs: [], running: [], kb: 4 };
            M.runs[key].noOverlap = args[5] === "on";
            return "";
        }
        /* Removing leftover runs: the script checks every ID again against all crontabs. */
        if (/for key in "\$@"/.test(script)) {
            if (M.lockBusy) fail({ exit_status: 4, problem: null, message: "" });
            const all = [M.root || "", M.sys.etc].concat(Object.values(M.sys.crond), Object.values(M.sys.users).map(t => t || "")).join("\n");
            const words = new Set(all.split(/[^A-Za-z0-9_-]+/));
            M.orphanCalls.push(args.slice(5));
            /* $1 the script for one directory, then the keys: ID (root's runs) or USER/ID */
            return args.slice(5).map(id => {
                if (!M.runs[id]) return "gone " + id;
                if (words.has(id.slice(id.indexOf("/") + 1))) return "used " + id;
                if (M.runs[id].running.some(r => r.alive !== false)) return "running " + id;
                delete M.runs[id];
                M.removedRuns.push(id);
                return "removed " + id;
            }).join("\n") + "\n";
        }
        /* WRITE_UNITS_SCRIPT: name, service, timer, token. The name is taken (exit 6) when a
           unit of it exists; the token stays with the units until SAVE_SCRIPT starts the
           timer or REMOVE_UNITS_SCRIPT takes them back. */
        if (/\(set -C; : > /.test(script)) {
            const name = args[4];
            if (M.lockBusy) fail({ exit_status: 4, problem: null, message: "" });
            if (M.units[name] || ["logrotate", "apt-daily"].includes(name)) fail({ exit_status: 6, problem: null, message: "" });
            M.units[name] = { service: args[5], timer: args[6] };
            M.converting[name] = args[7];
            /* another conversion takes the name over right after (its token, its units) */
            if (M.stealAfterWrite) { M.converting[name] = "f".repeat(32); M.stealAfterWrite = false; }
            return "";
        }
        /* REMOVE_UNITS_SCRIPT: name, token; only the units of the conversion with that token. */
        if (/\ntok=\$2\n/.test(script)) {
            const [name, token] = args.slice(4);
            const ours = !!M.converting[name] && M.converting[name] === token;
            M.takeBacks.push([name, ours]);
            if (!ours) fail({ exit_status: 8, problem: null, message: "" });
            delete M.units[name];
            delete M.converting[name];
            M.enabled = M.enabled.filter(n => n !== name + ".timer");
            return "";
        }
        /* Back to cron: units checked (and removed) only when the page wrote them from
           this user's crontab (header, User=, Description=). */
        if (/\n {2}check\) ;;/.test(script)) {
            const [step, name, user] = args.slice(4);
            const who = user || "root";
            const from = who === "root" ? "root crontab" : "crontab of " + who;
            const u = M.units[name];
            if (step === "remove" && M.lockBusy) fail({ exit_status: 4, problem: null, message: "" });
            if (!u) fail({ exit_status: 9, problem: null, message: "" });
            M.unitChecks.push([step, name, who]);
            const ours = u.service.split("\n")[0] === "# Created by Cockpit Cron Jobs from this line of the " + from + ":" &&
                u.service.split("\n").includes("User=" + who) && u.timer.split("\n").includes("Description=" + name + " (from the " + from + ")");
            if (u.foreign || !ours) fail({ exit_status: 8, problem: null, message: "" });
            if (step === "remove") {
                delete M.units[name];
                M.enabled = M.enabled.filter(n => n !== name + ".timer");
                M.unitsRemoved.push(name);
            }
            return "";
        }
        /* SAVE_SCRIPT: user, cksum, [timer [stop | "" token]] */
        if (/flock -w 10 9/.test(script)) {
            const user = args[4];
            if (M.lockBusy) fail({ exit_status: 4, problem: null, message: "" });
            if (user !== "root" && !(user in M.sys.users)) fail({ exit_status: 2, problem: null, message: "" });
            const token = args[8];
            if (token && M.converting[args[6].replace(/\.timer$/, "")] !== token) fail({ exit_status: 8, problem: null, message: "" });
            if (user === "root" && M.conflictNext !== null) { M.root = M.conflictNext; M.conflictNext = null; }
            if (user !== "root" && M.userConflictNext) {
                M.sys.users[user] = M.userConflictNext;
                M.userConflictNext = null;
            }
            const had = user === "root" ? M.root : M.sys.users[user];
            const cur = had === null || had === undefined ? "" : had;
            if (C().cksum(cur) !== args[5]) fail({ exit_status: 3, problem: null, message: "" });
            let path = "";
            if (had !== null && had !== undefined) {
                if (M.failBackup) fail({ exit_status: 5, problem: null, message: M.failBackup });
                const mine = M.backups.filter(b => (b.user || "root") === user);
                const last = mine[mine.length - 1];
                if (last && last.content === cur) {
                    path = last.path;
                } else {
                    const seq = M.backupSeq++;
                    const dir = "/var/lib/cockpit-cronjobs/backups" + (user === "root" ? "" : "/users/" + user);
                    path = dir + "/" + user + "-20261012-0" + (100 + seq) + "00.crontab";
                    M.backups.push({ path, user, content: cur, mtime: M.backups.reduce((t, b) => Math.max(t, b.mtime + 1), now()) });
                    if (mine.length + 1 > 10) M.backups.splice(M.backups.indexOf(mine[0]), 1);
                }
            }
            if (M.failWrite) fail({ exit_status: 1, problem: null, message: M.failWrite });
            const timer = args[6];
            const stop = args[7] === "stop";
            if (timer && !stop && M.failEnable) fail({ exit_status: 7, problem: null, message: M.failEnable });
            if (timer && stop && M.failDisable) fail({ exit_status: 7, problem: null, message: M.failDisable });
            M.writes++;
            if (timer && stop) M.enabled = M.enabled.filter(n => n !== timer);
            else if (timer) M.enabled.push(timer);
            if (token) delete M.converting[timer.replace(/\.timer$/, "")];
            if (user !== "root") {
                M.sys.users[user] = input;
                M.userWrites.push({ user, text: input });
                return path + "\n";
            }
            M.root = input;
            return path + "\n";
        }
        /* The backups, newest first (ls -t): header "\x1eMTIME SIZE NAME", then the file. */
        if (/flock -s -w 10 9/.test(script)) {
            if (M.lockBusy) fail({ exit_status: 4, problem: null, message: "" });
            if (M.failBackups) fail({ exit_status: 1, problem: null, message: M.failBackups });
            const parts = [];
            const user = args[4];
            M.backups.filter(b => (b.user || "root") === user).reverse().sort((a, b) => b.mtime - a.mtime).forEach(b => {
                let bytes = new TextEncoder().encode(b.content);
                if (b.latin1) bytes = bytes.map(x => x === 0x01 ? 0xE9 : x);
                parts.push(new TextEncoder().encode("\x1e" + b.mtime + " " + bytes.length + " " + b.path.replace(/^.*\//, "") + "\n"), bytes);
            });
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let pos = 0;
            parts.forEach(p => { out.set(p, pos); pos += p.length; });
            return out;
        }
        /* A directory for another user's runs */
        if (/chown -h "\$user:"/.test(script)) {
            if (M.failUserRuns) fail({ exit_status: 1, problem: null, message: M.failUserRuns });
            M.userRunsMade.push(args[4]);
            return "";
        }
        /* The user database: getent passwd for each name */
        if (/getent passwd/.test(script)) {
            return args.slice(4).filter(u => M.passwd[u]).map(u => u + ":x:" + M.passwd[u] + "\n").join("");
        }
        if (/sec host/.test(script)) return basicsOutput();
        if (/sec etc/.test(script)) {
            if (M.failSystem) fail({ exit_status: 2, problem: null, message: "sh: broken" });
            const out = systemOutput(privileged && opts.superuser === "try");
            if (!opts.binary) {
                if (out.includes("\x01")) fail({ problem: "protocol-error", message: "invalid UTF-8" });
                return out;
            }
            return new TextEncoder().encode(out).map(b => b === 1 ? 0xE9 : b);
        }
        if (/runs\.jsonl/.test(script)) return new TextEncoder().encode(runsOutput());
        if (args[0] === "tail" && args[1] === "-c") {
            const key = runsKey(args[3]).replace(/\.out$/, "");
            if (!(key in M.outputs)) fail({ exit_status: 1, problem: null, message: "tail: cannot open" });
            return new TextEncoder().encode(M.outputs[key]);
        }
        if (args[0] === "rm" && args[1] === "-rf") {
            const id = runsKey(args[3]);
            M.removedRuns.push(id);
            delete M.runs[id];
            return "";
        }
        if (/cockpit-cronjobs-run\.XXXXXX/.test(script)) {
            const m = /^CRONJOBS_RUN_VERSION=(\d+)$/m.exec(input || "");
            M.wrapperInstalls.push({ target: args[4], bytes: (input || "").length });
            M.wrapper = { version: m ? +m[1] : 0, text: input };
            return "";
        }
        if (/systemd-analyze calendar/.test(script)) return analyzeOutput(+args[4], args.slice(5));
        if (/journalctl -u/.test(script)) {
            M.journalReads.push(args[4]);
            if (M.journal[args[4]] === false) fail({ exit_status: 1, problem: null, message: "journal unreadable" });
            return journalOutput(args[4]);
        }
        fail({ problem: "not-found", message: "unexpected command " + JSON.stringify(args) });
    }

    /* "Run now": /bin/sh -c RUN_SCRIPT name user home shell command NAME=value… */
    function startJob(args, opts, proc, api, getInput) {
        const env = args.slice(8);
        const command = args[7];
        const input = getInput();
        M.runs_started.push({ env, command, user: args[4], shell: args[6], home: args[5], opts,
                              input: input === null ? null : new TextDecoder().decode(input) });
        if (opts.superuser === "require" && M.superuser === "none") { api.reject({ problem: "access-denied", message: "" }); return; }
        const lines = /fail/.test(command) ? ["Loading …", "Error: broken"] : ["Loading 12 feeds …", "news.example.org 34 new entries", "done"];
        const forever = /sleep/.test(command);
        let i = 0;
        const timer = setInterval(() => {
            if (api.closed) { clearInterval(timer); return; }
            if (i < lines.length) { api.emit(new TextEncoder().encode(lines[i++] + "\n")); return; }
            if (forever) return;
            clearInterval(timer);
            if (/fail/.test(command)) api.reject({ exit_status: 1, problem: null, message: "" });
            else api.resolve("");
        }, 60);
        M.runningProcs.push(api);
    }

    function spawn(args, opts) {
        M.calls.push({ args, opts });
        let input = null;
        let resolve, reject;
        const p = new Promise((res, rej) => { resolve = res; reject = rej; });
        let streamCb = null;
        const api = {
            closed: false,
            resolve: v => { if (!api.closed) { api.closed = true; resolve(v); } },
            reject: e => { if (!api.closed) { api.closed = true; reject(Object.assign(new Error(e.message || e.problem || ""), e)); } },
            emit: d => { if (streamCb) streamCb(d); },
        };
        const proc = {
            then: (a, b) => p.then(a, b),
            catch: f => p.catch(f),
            finally: f => p.finally(f),
            input(d) { input = d; return proc; },
            stream(cb) { streamCb = cb; return proc; },
            close(problem) {
                setTimeout(() => api.reject({ problem: problem || "terminated", message: problem || "terminated" }), 30);
            },
        };
        if (args[0] === "/bin/sh" && /setsid/.test(args[2] || "")) {
            setTimeout(() => startJob(args, opts, proc, api, () => input), M.delay);
            return proc;
        }
        setTimeout(() => {
            try { api.resolve(handle(args, opts, input)); } catch (ex) { api.reject(ex); }
        }, M.delay);
        return proc;
    }

    /* ---------- D-Bus: cockpit.Superuser and systemd ---------- */

    const listeners = [];
    const su = {
        Current: M.superuser,
        addEventListener(ev, f) { if (ev === "changed") listeners.push(f); },
        wait() { return Promise.resolve(); },
    };
    M.setSuperuser = v => { M.superuser = v; su.Current = v; listeners.forEach(f => f()); };

    const BOOT_MONO = 1000e6;                 /* µs since boot at "userspace" */
    const bootRt = () => (Date.now() - 3 * 86400000) * 1000;
    const usNow = () => Date.now() * 1000;

    function nextCal(spec) {
        const cron = SD().calendarToCron(spec);
        const ms = cron ? C().nextRun(cron, Date.now(), tz()) : null;
        return ms === null ? 0 : ms * 1000;
    }

    const TIMERS = () => {
        const list = [
            { name: "apt-daily.timer", desc: "Daily apt download activities", cal: ["*-*-* 06,18:00:00"], rand: 43200e6,
              service: "apt-daily.service", result: "success", status: 0, dur: 9e6 },
            { name: "logrotate.timer", desc: "Daily rotation of log files", cal: ["*-*-* 00:00:00"], service: "logrotate.service",
              result: "success", status: 0, dur: 1e6 },
            { name: "fstrim.timer", desc: "Discard unused filesystem blocks once a week", cal: ["Mon *-*-* 00:00:00"],
              service: "fstrim.service", result: "exit-code", status: 32, dur: 4e6 },
            { name: "systemd-tmpfiles-clean.timer", desc: "Daily Cleanup of Temporary Directories",
              mono: [["OnBootUSec", 900e6], ["OnUnitActiveUSec", 86400e6]], service: "systemd-tmpfiles-clean.service",
              result: "success", status: 0, dur: 1e6 },
            { name: "backup-files.timer", desc: "backup-files (from the root crontab)", cal: ["*-*-* 01:00:00"],
              service: "backup-files.service", result: "success", status: 0, dur: 120e6, running: true },
            { name: "motd-news.timer", desc: "Message of the Day", cal: ["*-*-* 00,12:00:00"], inactive: true,
              service: "motd-news.service", result: "success", status: 0, dur: 1e6 },
        ];
        Object.keys(M.units).forEach(n => {
            const m = /^OnCalendar=(.*)$/m.exec(M.units[n].timer);
            const d = /^Description=(.*)$/m.exec(M.units[n].timer);
            list.push({ name: n + ".timer", desc: d ? d[1] : n, cal: m ? [m[1]] : [],
                        service: n + ".service", result: null, status: 0, never: true, inactive: !M.enabled.includes(n + ".timer") });
        });
        /* M.timerChanges: { NAME: { result, status, ago (µs since the last run), never, running } } */
        return list.map(t => Object.assign(t, M.timerChanges[t.name] || {}));
    };
    const pathOf = name => "/org/freedesktop/systemd1/unit/" + name.replace(/[^A-Za-z0-9]/g, c => "_" + c.charCodeAt(0).toString(16));
    const V = (t, v) => ({ t, v });

    /* journalctl -u UNIT -o json: M.journal[UNIT] when given, else three runs of the service of a
       timer (a day apart; the last as the timer's result says, running when it runs). */
    function journalOutput(unit) {
        if (typeof M.journal[unit] === "string") return M.journal[unit];
        const t = TIMERS().find(x => x.service === unit);
        if (!t || t.never) return "";
        const hex = Array.from(unit).map(c => c.charCodeAt(0).toString(16)).join("");
        const id = n => (n.toString(16) + hex).padEnd(32, "0").slice(0, 32);
        const lines = [];
        const add = (us, own, iid, o) => lines.push(JSON.stringify(Object.assign({ __REALTIME_TIMESTAMP: String(Math.round(us)),
            _PID: own ? "1" : "4242" }, own ? { INVOCATION_ID: iid } : { _SYSTEMD_INVOCATION_ID: iid }, o)));
        const last = t.ago || 6 * 3600e6;
        [{ ago: last + 2 * 86400e6, ok: true }, { ago: last + 86400e6, ok: true },
         { ago: last, ok: (t.result || "success") === "success", status: t.status, running: t.running }].forEach((r, n) => {
            const iid = id(n);
            const start = usNow() - r.ago;
            const end = start + (t.dur || 1e6);
            add(start, true, iid, { MESSAGE_ID: "7d4958e842da4a758f6c1cdc7b36dcc5", MESSAGE: "Starting " + unit + "..." });
            add(start + 1000, false, iid, { MESSAGE: "run " + (n + 1) + " of " + unit });
            if (r.running) return;
            if (r.ok) {
                add(end, true, iid, { MESSAGE_ID: "7ad2d189f7e94e70a38c781354912448", MESSAGE: unit + ": Deactivated successfully." });
                add(end + 100, true, iid, { MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", JOB_RESULT: "done", MESSAGE: "Finished " + unit + "." });
                return;
            }
            add(end - 100, false, iid, { MESSAGE: [101, 114, 114, 111, 114, 58, 32, 0xe9] });
            add(end, true, iid, { MESSAGE_ID: "98e322203f7a4ed290d09fe03c09fe15", EXIT_CODE: "exited", EXIT_STATUS: String(r.status || 1),
                                  MESSAGE: unit + ": Main process exited, code=exited, status=" + (r.status || 1) });
            add(end + 50, true, iid, { MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "exit-code",
                                       MESSAGE: unit + ": Failed with result 'exit-code'." });
            add(end + 100, true, iid, { MESSAGE_ID: "be02cf6855d2428ba40df7e9d022f03d", JOB_RESULT: "failed", MESSAGE: "Failed to start " + unit + "." });
        });
        return lines.join("\n") + "\n";
    }

    function timerProps(t) {
        const calNext = (t.cal || []).map(nextCal).filter(Boolean);
        let rt = calNext.length ? Math.min.apply(null, calNext) : 0;
        if (rt && t.rand) rt += 41 * 60e6;
        const monoNow = BOOT_MONO + (usNow() - bootRt());
        const mono = t.mono ? monoNow + 5 * 3600e6 : 0;
        return {
            Unit: V("s", t.service),
            TimersCalendar: V("a(sst)", (t.cal || []).map(s => ["OnCalendar", s, 0])),
            TimersMonotonic: V("a(stt)", (t.mono || []).map(([b, us]) => [b, us, 0])),
            NextElapseUSecRealtime: V("t", t.inactive ? 0 : rt),
            NextElapseUSecMonotonic: V("t", t.inactive ? 0 : mono),
            LastTriggerUSec: V("t", t.never ? 0 : usNow() - (t.ago || 6 * 3600e6)),
            RandomizedDelayUSec: V("t", t.rand || 0),
            Persistent: V("b", true),
        };
    }

    function systemdClient() {
        return {
            call(path, iface, method, args) {
                return new Promise((resolve, reject) => setTimeout(() => {
                    try { resolve(systemdCall(path, iface, method, args)); } catch (ex) { reject(ex); }
                }, 5));
            },
            close() {},
        };
    }

    function systemdCall(path, iface, method, args) {
        const timers = TIMERS();
        if (method === "ListUnitsByPatterns") {
            if (M.failTimers) throw new Error("Access denied by policy");
            return [timers.map(t => [t.name, t.desc, "loaded", t.inactive ? "inactive" : "active", t.inactive ? "dead" : "waiting",
                                     "", pathOf(t.name), 0, "", "/"])];
        }
        if (method === "GetUnit" || method === "LoadUnit") {
            const name = args[0];
            const known = timers.some(t => t.service === name || t.name === name) || M.units[name.replace(/\.service$/, "")];
            if (!known && method === "GetUnit") { const e = new Error("not loaded"); e.name = "org.freedesktop.systemd1.NoSuchUnit"; throw e; }
            return [pathOf(name)];
        }
        if (iface === "org.freedesktop.DBus.Properties" && method === "Get") {
            const [ifc, prop] = args;
            if (path === "/org/freedesktop/systemd1") {
                if (prop === "UserspaceTimestamp") return [V("t", bootRt())];
                if (prop === "UserspaceTimestampMonotonic") return [V("t", BOOT_MONO)];
            }
            const unit = Object.keys(M.units).find(n => pathOf(n + ".service") === path);
            if (unit && prop === "ExecStart") return [V("a(sasbttttuii)", unitExec(unit))];
            if (unit && prop === "Environment") return [V("as", unitEnv(unit))];
            if (unit && prop === "UnsetEnvironment") return [V("as", unitUnset(unit))];
            if (unit && prop === "User") {
                const m = /^User=(.*)$/m.exec(M.units[unit].service);
                return [V("s", M.wrongUser || (m ? m[1] : ""))];
            }
            throw new Error("unknown property " + ifc + "." + prop);
        }
        if (iface === "org.freedesktop.DBus.Properties" && method === "GetAll") {
            const ifc = args[0];
            const t = timers.find(x => pathOf(x.name) === path);
            if (t && ifc === "org.freedesktop.systemd1.Timer") return [timerProps(t)];
            const s = timers.find(x => pathOf(x.service) === path);
            if (s && ifc === "org.freedesktop.systemd1.Service") {
                const start = usNow() - (s.ago || 6 * 3600e6);
                return [{ Result: V("s", s.result || "success"), ExecMainStatus: V("i", s.status || 0),
                          ExecMainStartTimestamp: V("t", s.never ? 0 : start),
                          ExecMainExitTimestamp: V("t", s.never || s.running ? 0 : start + (s.dur || 0)),
                          Type: V("s", "oneshot") }];
            }
            if (s && ifc === "org.freedesktop.systemd1.Unit")
                return [{ ActiveState: V("s", s.running ? "activating" : "inactive"), SubState: V("s", s.running ? "start" : "dead") }];
            throw new Error("unknown object " + path + " " + ifc);
        }
        throw new Error("unexpected D-Bus call " + method);
    }

    /* Events of cockpit.js: visibilitychange when the shell's hint changes cockpit.hidden
       (M.hint), locationchanged on the frame's hashchange, as cockpit.js sends them. */
    const handlers = { visibilitychange: [], locationchanged: [] };
    const fire = type => handlers[type].slice().forEach(f => f());
    window.addEventListener("hashchange", () => fire("locationchanged"));
    M.hint = hidden => { window.cockpit.hidden = hidden; fire("visibilitychange"); };

    window.cockpit = {
        language: "en",
        transport: {
            host: "localhost",
            wait(cb) { setTimeout(cb, 0); },
            control(command, options) { M.notes.push([command, JSON.parse(JSON.stringify(options))]); },
        },
        /* ?hidden=1: loaded hidden, as Cockpit preloads the page after the login. */
        hidden: params.get("hidden") === "1",
        /* The frame's address: #/a/b is the path ["a", "b"]; go() changes it as cockpit.js does. */
        get location() {
            const path = window.location.hash.replace(/^#/, "").split("?")[0].split("/").filter(Boolean);
            return { path, go: p => { window.location.hash = "#/" + p.join("/"); } };
        },
        file(path) {
            return {
                read() {
                    M.fileReads.push(path);
                    return new Promise(resolve => setTimeout(() => resolve(M.files[path] === undefined ? null : M.files[path]), 5));
                },
            };
        },
        spawn,
        dbus: (name, opts) => {
            if (name === null) return { proxy: () => su };
            if (name === "org.freedesktop.systemd1") {
                if (!M.systemd) throw new Error("no systemd");
                return systemdClient();
            }
            throw new Error("unexpected bus " + name);
        },
        jump: (path, host) => M.jumps.push([path, host]),
        addEventListener: (type, f) => { if (handlers[type]) handlers[type].push(f); },
        removeEventListener: (type, f) => {
            if (handlers[type]) handlers[type] = handlers[type].filter(x => x !== f);
        },
    };
}());
