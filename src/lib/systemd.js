/* Cron Jobs: systemd helpers (no DOM, no Cockpit).
 *
 *  - Turns a cron schedule into OnCalendar= expressions with the same runs.
 *  - Writes .service and .timer units for a converted job, quoted the way systemd
 *    reads them, and the note the conversion leaves in the crontab.
 *  - Reads the output of `systemd-analyze calendar --iterations=N`.
 *  - Describes timers (calendar and monotonic) in words.
 *
 * Loaded in the browser as window.CronSystemd (after lib/cron.js) and in Node via require().
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root, factory) {
    "use strict";
    if (typeof module === "object" && module.exports) module.exports = factory(require("./cron.js"));
    else root.CronSystemd = factory(root.CronLogic);
}(typeof self !== "undefined" ? self : this, function (C) {
    "use strict";

    const DOC_URL = "https://github.com/Azentrius/cockpit-cronjobs";
    const pad2 = n => String(n).padStart(2, "0");
    const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];   /* systemd order */

    /* ---------- cron -> OnCalendar ---------- */

    function runsOf(values) {
        const out = [];
        values.forEach(v => {
            const last = out[out.length - 1];
            if (last && v === last[1] + 1) last[1] = v;
            else out.push([v, v]);
        });
        return out;
    }

    function joinRuns(values, name) {
        return runsOf(values).map(([a, b]) => {
            if (a === b) return name(a);
            if (b - a >= 2) return name(a) + ".." + name(b);
            return name(a) + "," + name(b);
        }).join(",");
    }

    /* Sorted values of one field -> systemd syntax ("*", "00/15", "01..05", "06,18"). */
    function calField(values, min, max) {
        if (values.length === max - min + 1) return "*";
        if (values.length >= 3) {
            const step = values[1] - values[0];
            if (step >= 2 && values.every((v, i) => v === values[0] + i * step) &&
                    values[values.length - 1] + step > max)
                return pad2(values[0]) + "/" + step;
        }
        return joinRuns(values, pad2);
    }

    /* Cron weekdays (0 = Sunday) -> "Mon..Fri", "Sat,Sun"; null when every day. */
    function dowField(values) {
        if (values.length === 7) return null;
        const idx = values.map(v => (v + 6) % 7).sort((a, b) => a - b);
        return joinRuns(idx, i => DOW[i]);
    }

    /* Cron schedule -> { ok, specs } with one or two OnCalendar= expressions.
       cron runs a job when day of month OR weekday matches if both are restricted
       (and neither starts with "*"); systemd needs both, so that becomes two
       expressions whose union is the same. @reboot has no calendar form.
       tz: a time zone for the expressions (cronie's CRON_TZ), else the server's. */
    function calendarFromCron(schedule, tz) {
        const p = typeof schedule === "string" ? C.parseSchedule(schedule) : schedule;
        if (!p || !p.ok) return { ok: false, reason: "invalid" };
        if (p.reboot) return { ok: false, reason: "reboot" };
        const [mi, ho, dom, mon, dow] = p.fields;
        const time = calField(ho.values, 0, 23) + ":" + calField(mi.values, 0, 59) + ":00";
        const month = calField(mon.values, 1, 12);
        const day = calField(dom.values, 1, 31);
        const wd = dowField(dow.values);
        const spec = (w, d) => (w ? w + " " : "") + "*-" + month + "-" + d + " " + time + (tz ? " " + tz : "");
        if (!dom.star && !dow.star) return { ok: true, specs: [spec(null, day), spec(wd, "*")] };
        return { ok: true, specs: [spec(wd, day)] };
    }

    /* ---------- OnCalendar -> cron (only to describe timers in words) ---------- */

    const DOW_CRON = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

    /* One field; systemd's "A/B" runs from A to the end of the field, which cron
       writes "A-MAX/B" (cron has no step without a range). */
    function cronPart(text, min, max) {
        if (text === "*") return "*";
        const out = [];
        for (const part of text.split(",")) {
            let m = /^(\d+)\/(\d+)$/.exec(part);
            if (m) { out.push((+m[1] === min ? "*" : +m[1] + "-" + max) + "/" + +m[2]); continue; }
            m = /^(\d+)\.\.(\d+)(?:\/(\d+))?$/.exec(part);
            if (m) { out.push(+m[1] + "-" + +m[2] + (m[3] ? "/" + +m[3] : "")); continue; }
            if (/^\d+$/.test(part)) { out.push(String(+part)); continue; }
            return null;
        }
        return out.join(",");
    }

    function cronDow(text) {
        const out = [];
        for (const part of text.split(",")) {
            const m = /^([A-Za-z]{3})[a-z]*(?:\.\.([A-Za-z]{3})[a-z]*)?$/.exec(part);
            if (!m) return null;
            const a = DOW_CRON[m[1].toLowerCase()];
            const b = m[2] ? DOW_CRON[m[2].toLowerCase()] : null;
            if (!a || (m[2] && !b) || (b && b < a)) return null;
            out.push(b ? a + "-" + b : String(a === 7 ? 0 : a));
        }
        return out.join(",");
    }

    /* Normalized calendar spec ("Mon..Fri *-*-* 09:00:00") -> cron schedule, or null
       when cron cannot say the same (seconds, years, time zones, "~", weekday AND day). */
    function calendarToCron(spec) {
        const m = /^(?:(\S+)\s+)?(\S+)-(\S+)-(\S+)\s+(\S+):(\S+):(\S+)$/.exec(String(spec || "").trim());
        if (!m) return null;
        const [, wd, y, mo, d, h, mi, s] = m;
        if (y !== "*" || !/^0+$/.test(s)) return null;
        const fields = [cronPart(mi, 0, 59), cronPart(h, 0, 23), cronPart(d, 1, 31), cronPart(mo, 1, 12),
                        wd ? cronDow(wd) : "*"];
        if (fields.some(f => f === null)) return null;
        if (wd && fields[2] !== "*") return null;
        const text = fields.join(" ");
        return C.parseSchedule(text).ok ? text : null;
    }

    /* ---------- time spans ---------- */

    const SPAN_UNITS = [["d", 86400e6], ["h", 3600e6], ["min", 60e6], ["s", 1e6], ["ms", 1e3]];

    /* 43200000000 -> "12h", 90000000 -> "1min 30s" (as systemd writes them, two parts at most). */
    function formatSpan(usec) {
        let rest = Math.max(0, Math.round(Number(usec) || 0));
        if (rest === 0) return "0";
        const parts = [];
        for (const [unit, size] of SPAN_UNITS) {
            if (rest >= size) {
                parts.push(Math.floor(rest / size) + unit);
                rest %= size;
                if (parts.length === 2) break;
            } else if (parts.length) {
                break;
            }
        }
        return parts.join(" ") || "0";
    }

    /* ---------- describing timers ---------- */

    function describeCalendar(spec, S) {
        const cron = calendarToCron(spec);
        return cron ? C.describe(cron, S) : null;
    }

    const MONO = {
        OnBootUSec: "afterBoot", OnStartupUSec: "afterStartup", OnActiveUSec: "afterActivation",
        OnUnitActiveUSec: "afterLastStart", OnUnitInactiveUSec: "afterLastEnd",
    };

    /* timer: { calendar: [spec], monotonic: [{ base, usec }], randomizedUsec } -> words. */
    function describeTimer(timer, S) {
        const parts = [];
        (timer.calendar || []).forEach(spec => parts.push(describeCalendar(spec, S) || S.custom));
        (timer.monotonic || []).forEach(m => {
            const key = MONO[m.base];
            parts.push(key ? S[key](formatSpan(m.usec)) : S.custom);
        });
        let text = parts.length ? Array.from(new Set(parts)).join("; ") : S.custom;
        if (timer.randomizedUsec > 0) text += S.randomized;
        return text;
    }

    /* ---------- systemd-analyze calendar ---------- */

    function utcOf(m) {
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }

    /* Output of `LC_ALL=C systemd-analyze calendar --iterations=N SPEC` -> instants (ms).
       Each run is printed in local time; when the local zone is not UTC a "(in UTC)"
       line follows, otherwise the local time is UTC already. */
    function parseAnalyzeCalendar(text) {
        const out = [];
        String(text || "").split("\n").forEach(line => {
            let m = /^\s*(?:Next elapse|Iteration #\d+):\s+\S+\s+(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\b/.exec(line);
            if (m) { out.push(utcOf(m)); return; }
            m = /^\s*\(in UTC\):\s+\S+\s+(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) UTC\s*$/.exec(line);
            if (m && out.length) out[out.length - 1] = utcOf(m);
        });
        return out;
    }

    /* ---------- units ---------- */

    const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
    const UNIT_SUFFIX_RE = /\.(service|timer|socket|target|path|mount|slice|scope|device|swap|automount)$/;

    function validUnitName(name) {
        return UNIT_RE.test(name) && !UNIT_SUFFIX_RE.test(name);
    }

    function suggestUnitName(command) {
        return C.slug(C.jobName(command)) || "cron-job";
    }

    /* One word of ExecStart=: in single quotes, with C escapes for \ and ', and the
       specifier (%) and variable ($) characters doubled. */
    function execWord(word) {
        return "'" + String(word).replace(/\\/g, "\\\\").replace(/'/g, "\\'")
            .replace(/%/g, "%%").replace(/\$/g, "$$$$") + "'";
    }

    /* Environment="NAME=value" (no $ expansion there, but % specifiers). */
    function envLine(name, value) {
        return "Environment=\"" + (name + "=" + value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
            .replace(/%/g, "%%") + "\"";
    }

    /* Environment= and UnsetEnvironment= for a converted job of user (default root), so
       that it has the environment cron gives it (jobEnv, see CronLogic.jobEnvironment;
       variables like MAILTO included, as cron passes them on too), from the crontab's
       variables (cronEnv) and the environment systemd gives every service (managerEnv,
       `systemctl show-environment`). User= already gives LOGNAME, USER and HOME (the
       user's home; HOME stays when the crontab sets it); what systemd would give and cron
       does not (USER with Debian's cron, PATH when cron sets none, the manager's
       variables) is unset. */
    function serviceEnvironment(jobEnv, cronEnv, managerEnv, user) {
        user = user || "root";
        const env = Object.assign({}, jobEnv || {});
        const unset = Array.from(new Set(["USER", "PATH"].concat(Object.keys(managerEnv || {}))))
            .filter(k => !Object.prototype.hasOwnProperty.call(env, k));
        if (env.LOGNAME === user) delete env.LOGNAME;
        if (env.USER === user) delete env.USER;
        if (!cronEnv || !Object.prototype.hasOwnProperty.call(cronEnv, "HOME")) delete env.HOME;
        return { env, unset };
    }

    /* How the units of a converted job begin and describe themselves: they name the
       crontab they come from. Back to cron only removes units that carry both and run as
       that crontab's user (see UNITS_SCRIPT in app/system.js). A format: older versions
       read the root crontab's. */
    const UNIT_HEADER_START = "# Created by Cockpit Cron Jobs from this line of the ";
    const unitOrigin = user => !user || user === "root" ? "root crontab" : "crontab of " + user;
    const unitHeader = user => UNIT_HEADER_START + unitOrigin(user) + ":";
    const UNIT_HEADER = unitHeader("root");
    const unitDescription = (name, user) => name + " (from the " + unitOrigin(user) + ")";
    const DESCRIPTION_RE = /^(.+) \(from the (?:root crontab|crontab of ([A-Za-z0-9_][A-Za-z0-9._-]{0,31}))\)$/;

    /* The Description= of a timer -> { name, user } when a conversion wrote it, else null. */
    function parseUnitDescription(text) {
        const m = DESCRIPTION_RE.exec(String(text || ""));
        return m ? { name: m[1], user: m[2] || "root" } : null;
    }

    /* opts: { name, user, line, shell, command, env: {NAME: value}, unset: [NAME], workdir }
       -> text of name.service, run as user (default root). cron starts jobs in $HOME;
       WorkingDirectory=~ is the user's home. */
    function serviceUnit(opts) {
        const env = opts.env || {};
        const workdir = opts.workdir && /^\//.test(opts.workdir) ? opts.workdir.replace(/%/g, "%%") : "~";
        const lines = [
            unitHeader(opts.user),
            "#   " + String(opts.line || "").replace(/[\r\n]+/g, " "),
            "[Unit]",
            "Description=" + unitDescription(opts.name, opts.user),
            "Documentation=" + DOC_URL,
            "",
            "[Service]",
            "Type=oneshot",
            "User=" + (opts.user || "root"),
            "WorkingDirectory=" + workdir,
        ];
        Object.keys(env).sort().forEach(k => lines.push(envLine(k, env[k])));
        if (opts.unset && opts.unset.length) lines.push("UnsetEnvironment=" + opts.unset.join(" "));
        lines.push("ExecStart=" + execWord(opts.shell || "/bin/sh") + " -c " + execWord(opts.command));
        return lines.join("\n") + "\n";
    }

    /* opts: { name, user, specs: [OnCalendar], persistent } -> text of name.timer.
       AccuracySec=1s: cron starts on the minute, systemd would otherwise allow a minute. */
    function timerUnit(opts) {
        const lines = [
            "[Unit]",
            "Description=" + unitDescription(opts.name, opts.user),
            "Documentation=" + DOC_URL,
            "",
            "[Timer]",
        ];
        opts.specs.forEach(s => lines.push("OnCalendar=" + s));
        lines.push("AccuracySec=1s");
        lines.push("Persistent=" + (opts.persistent ? "true" : "false"));
        lines.push("", "[Install]", "WantedBy=timers.target");
        return lines.join("\n") + "\n";
    }

    /* Whether systemd's next runs (theirs, from `systemd-analyze calendar`) are cron's
       (ours, from a minute before up to theirs' last run): the same instants in the same
       order, none missing and none extra. Ours may start with one run more, from the
       minute systemd no longer counts. */
    function sameRuns(theirs, ours) {
        if (!theirs.length) return false;
        const k = ours.indexOf(theirs[0]);
        return (k === 0 || k === 1) && ours.length - k === theirs.length && theirs.every((t, n) => t === ours[k + n]);
    }

    /* The argv systemd should end up with for ExecStart=. */
    function expectedArgv(shell, command) {
        return [shell || "/bin/sh", "-c", command];
    }

    /* ---------- the note in the crontab ---------- */

    /* The comment a conversion puts right above the line it switches off. A format:
       older and newer versions read it. date: "YYYY-MM-DD" in server time. */
    function convertNote(name, date) {
        return "# Converted to systemd timer " + name + ".timer by Cockpit Cron Jobs on " + date +
            "; the line below is no longer used.";
    }

    const NOTE_RE = /^# Converted to systemd timer ([A-Za-z0-9][A-Za-z0-9_.-]{0,62})\.timer by Cockpit Cron Jobs on (\d{4}-\d\d-\d\d); the line below is no longer used\.$/;

    /* A line of the crontab -> { name, date } when it is that note, else null. */
    function parseConvertNote(line) {
        const m = NOTE_RE.exec(String(line || ""));
        return m && validUnitName(m[1]) ? { name: m[1], date: m[2] } : null;
    }

    return {
        DOC_URL, UNIT_HEADER, UNIT_HEADER_START, unitHeader, parseUnitDescription,
        calField, calendarFromCron, calendarToCron, describeCalendar, describeTimer,
        formatSpan, parseAnalyzeCalendar,
        validUnitName, suggestUnitName, execWord, envLine, serviceEnvironment,
        serviceUnit, timerUnit, sameRuns, expectedArgv, convertNote, parseConvertNote,
    };
}));
