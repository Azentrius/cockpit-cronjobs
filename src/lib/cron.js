/* Cron Jobs — crontab logic (no DOM, no Cockpit).
 *
 *  - Parses a user crontab into entries without losing anything: every line
 *    that is not touched is written back byte for byte.
 *  - Validates schedules field by field (ranges, steps, names).
 *  - Describes schedules in words (texts come from the language files).
 *  - Computes the next runs in the server's time zone.
 *  - Wraps and unwraps commands for run capture (cockpit-cronjobs-run).
 *
 * Loaded in the browser as window.CronLogic and in Node via require().
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root, factory) {
    "use strict";
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CronLogic = factory();
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    /* ---------- schedules ---------- */

    const NICKNAMES = {
        "@yearly": "0 0 1 1 *",
        "@annually": "0 0 1 1 *",
        "@monthly": "0 0 1 * *",
        "@weekly": "0 0 * * 0",
        "@daily": "0 0 * * *",
        "@midnight": "0 0 * * *",
        "@hourly": "0 * * * *",
    };
    const REBOOT = "@reboot";

    const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

    const FIELDS = [
        { key: "minute", min: 0, max: 59 },
        { key: "hour", min: 0, max: 23 },
        { key: "dom", min: 1, max: 31 },
        { key: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
        { key: "dow", min: 0, max: 7, names: DOW_NAMES, nameBase: 0 },
    ];

    function parseValue(tok, spec) {
        if (/^\d+$/.test(tok)) {
            const n = parseInt(tok, 10);
            return (n >= spec.min && n <= spec.max) ? n : null;
        }
        if (spec.names && /^[a-z]{3}$/i.test(tok)) {
            const i = spec.names.indexOf(tok.toLowerCase());
            return i >= 0 ? i + spec.nameBase : null;
        }
        return null;
    }

    /* One field -> { raw, star, values: sorted array } or null when invalid. */
    function parseField(text, spec) {
        if (typeof text !== "string" || text === "") return null;
        const set = new Set();
        for (const item of text.split(",")) {
            const m = /^([^/]+)(?:\/(\d+))?$/.exec(item);
            if (!m) return null;
            const step = m[2] === undefined ? 1 : parseInt(m[2], 10);
            if (step < 1) return null;
            let lo;
            let hi;
            if (m[1] === "*") {
                lo = spec.min;
                hi = spec.max;
            } else {
                const r = m[1].split("-");
                if (r.length > 2) return null;
                lo = parseValue(r[0], spec);
                if (lo === null) return null;
                if (r.length === 2) {
                    hi = parseValue(r[1], spec);
                    if (hi === null || hi < lo) return null;
                } else {
                    hi = m[2] === undefined ? lo : spec.max; // "5/10" = 5-max/10
                }
            }
            for (let v = lo; v <= hi; v += step) set.add(spec.key === "dow" && v === 7 ? 0 : v);
        }
        return {
            raw: text,
            spec,
            star: text.charAt(0) === "*",
            values: Array.from(set).sort((a, b) => a - b),
        };
    }

    /* Schedule text -> { ok, nick, reboot, fields[], text } or { ok:false, field } */
    function parseSchedule(text) {
        const s = String(text || "").trim();
        if (s === REBOOT) return { ok: true, reboot: true, nick: s, text: s };
        if (Object.prototype.hasOwnProperty.call(NICKNAMES, s))
            return Object.assign(parseSchedule(NICKNAMES[s]), { nick: s, text: s });
        const parts = s.split(/\s+/);
        if (parts.length !== 5) return { ok: false, field: parts.length < 5 ? "count-low" : "count-high" };
        const fields = [];
        for (let i = 0; i < 5; i++) {
            const f = parseField(parts[i], FIELDS[i]);
            if (!f) return { ok: false, field: FIELDS[i].key };
            fields.push(f);
        }
        return { ok: true, reboot: false, nick: null, fields, text: parts.join(" ") };
    }

    /* A field that matches every possible value. */
    function isFull(f) {
        const count = f.spec.key === "dow" ? 7 : f.spec.max - f.spec.min + 1;
        return f.values.length === count;
    }

    /* ---------- crontab lines ---------- */

    const ENV_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/;
    const MARKER = "#[cronjobs:off] ";
    const MARKER_RE = /^(#\[(?:cronjobs|cronctl):off\] ?)(.*)$/;
    const COMMENT_RE = /^(\s*#+\s*)(.*)$/;
    const TEMPLATE_END_RE = /^#\s*m\s+h\s+dom\s+mon\s+dow\s+command\s*$/;

    /* "sched... command" -> { schedule, command } or null. Keeps nothing else. */
    function splitJob(text, withUser) {
        const t = text.replace(/^\s+/, "");
        if (t === "" || t.charAt(0) === "#" || ENV_RE.test(t)) return null;
        let m;
        if (t.charAt(0) === "@") {
            m = withUser ? /^(@\w+)\s+(\S+)\s+(.*\S)\s*$/.exec(t) : /^(@\w+)\s+(.*\S)\s*$/.exec(t);
            if (!m) return null;
            if (m[1] !== REBOOT && !Object.prototype.hasOwnProperty.call(NICKNAMES, m[1])) return null;
            return withUser
                ? { schedule: m[1], user: m[2], command: m[3] }
                : { schedule: m[1], command: m[2] };
        }
        m = withUser
            ? /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*\S)\s*$/.exec(t)
            : /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*\S)\s*$/.exec(t);
        if (!m) return null;
        const schedule = [m[1], m[2], m[3], m[4], m[5]].join(" ");
        if (!parseSchedule(schedule).ok) return null;
        return withUser
            ? { schedule, user: m[6], command: m[7] }
            : { schedule, command: m[6] };
    }

    /* Split text into lines; remembers whether it ended with a newline. */
    function splitLines(text) {
        const s = String(text || "");
        if (s === "") return { lines: [], trailingNewline: true };
        const lines = s.split("\n");
        const trailingNewline = lines[lines.length - 1] === "";
        if (trailingNewline) lines.pop();
        return { lines, trailingNewline };
    }

    /*
     * User crontab -> entries.
     *   { kind: "raw",  line }
     *   { kind: "job",  line, body, prefix, enabled, schedule, command }
     * A disabled job is a commented job line: either our marker
     * "#[cronjobs:off] " (older versions: "#[cronctl:off] ") or "# " written by hand.
     * Commented examples inside the Ubuntu/Debian template header (everything
     * up to "# m h  dom mon dow   command") stay comments.
     */
    function parseUserCrontab(text) {
        const { lines } = splitLines(text);
        let templateEnd = -1;
        for (let i = 0; i < lines.length; i++) {
            if (TEMPLATE_END_RE.test(lines[i].trim())) { templateEnd = i; break; }
        }
        const entries = [];
        lines.forEach((line, i) => {
            const job = splitJob(line, false);
            if (job) {
                entries.push({ kind: "job", line, body: line, prefix: "", enabled: true,
                               schedule: job.schedule, command: job.command });
                return;
            }
            let m = MARKER_RE.exec(line);
            if (m) {
                const inner = splitJob(m[2], false);
                if (inner) {
                    entries.push({ kind: "job", line, body: m[2], prefix: m[1], enabled: false,
                                   schedule: inner.schedule, command: inner.command });
                    return;
                }
            }
            if (i > templateEnd) {
                m = COMMENT_RE.exec(line);
                if (m) {
                    const inner = splitJob(m[2], false);
                    if (inner) {
                        entries.push({ kind: "job", line, body: m[2], prefix: m[1], enabled: false,
                                       schedule: inner.schedule, command: inner.command });
                        return;
                    }
                }
            }
            entries.push({ kind: "raw", line });
        });
        return entries;
    }

    /* Index of the "# m h dom mon dow command" line of the Debian/Ubuntu template, or -1. */
    function templateEnd(entries) {
        for (let i = 0; i < entries.length; i++)
            if (entries[i].kind === "raw" && TEMPLATE_END_RE.test(entries[i].line.trim())) return i;
        return -1;
    }

    function entryLine(e) {
        if (e.kind === "raw") return e.line;
        if (!e.dirty) return e.line;
        return e.enabled ? e.body : (e.prefix || MARKER) + e.body;
    }

    /* Entries -> crontab text. Always ends with a newline (crontab needs it). */
    function serializeUserCrontab(entries) {
        if (entries.length === 0) return "";
        return entries.map(entryLine).join("\n") + "\n";
    }

    function normalizeText(text) {
        const s = String(text || "");
        if (s === "" || s.endsWith("\n")) return s;
        return s + "\n";
    }

    /* True when reading and writing back would not change a single byte. */
    function roundTrips(text) {
        return serializeUserCrontab(parseUserCrontab(text)) === normalizeText(text);
    }

    /* Changes on entries (all return a new object; the caller replaces it). */
    function setEnabled(e, enabled) {
        if (e.enabled === enabled) return e;
        return Object.assign({}, e, { enabled, dirty: true });
    }
    function setJob(e, schedule, command, enabled) {
        const body = schedule.trim() + " " + command.trim();
        return Object.assign({}, e, { body, schedule: schedule.trim(), command: command.trim(),
                                      enabled, dirty: true });
    }
    function newJob(schedule, command, enabled) {
        return setJob({ kind: "job", line: "", prefix: "" }, schedule, command, enabled !== false);
    }
    function rawLine(line) {
        return { kind: "raw", line };
    }

    /* System crontab (/etc/crontab, /etc/cron.d/*): jobs with a user field. */
    function parseSystemCrontab(text) {
        const out = [];
        splitLines(text).lines.forEach(line => {
            const j = splitJob(line, true);
            if (j) out.push(j);
        });
        return out;
    }

    /* Whether cron reads a file in /etc/cron.d with this name.
       Debian/Ubuntu cron: only run-parts names. cronie (Fedora, RHEL, …): everything
       except hidden files, names starting with #, backups and package-manager leftovers. */
    function cronDNameValid(name, debian) {
        if (debian) return /^[A-Za-z0-9_-]+$/.test(name);
        return !/^[.#]/.test(name) && !/~$/.test(name) && !/\.(rpmnew|rpmorig|rpmsave)$/.test(name);
    }

    /* What cron hands to the shell, exactly as cron's do_command does it: the command
       up to the first unescaped "%" ("\%" becomes "%", other backslashes stay), and the
       rest as standard input with "%" as line breaks (stdin null when there is none). */
    function cronCommand(text) {
        const s = String(text);
        let command = "";
        let escaped = false;
        let i = 0;
        for (; i < s.length; i++) {
            const ch = s[i];
            if (escaped) {
                escaped = false;
                command = ch === "%" ? command.slice(0, -1) + "%" : command + ch;
                continue;
            }
            if (ch === "%") break;
            if (ch === "\\") escaped = true;
            command += ch;
        }
        if (i >= s.length) return { command, stdin: null };
        let stdin = "";
        escaped = false;
        for (i++; i < s.length; i++) {
            let ch = s[i];
            if (escaped) {
                if (ch !== "%") stdin += "\\";
            } else if (ch === "%") {
                ch = "\n";
            }
            escaped = ch === "\\";
            if (!escaped) stdin += ch;
        }
        if (escaped) stdin += "\\";
        if (!stdin.endsWith("\n")) stdin += "\n";
        return { command, stdin };
    }

    /* "%" in a crontab command becomes a newline unless escaped as "\%". */
    function hasUnescapedPercent(command) {
        return cronCommand(command).stdin !== null;
    }

    /* ---------- environment assignments in a crontab ---------- */

    const ENV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

    function parseEnvLine(line) {
        const m = ENV_LINE_RE.exec(line);
        if (!m) return null;
        let v = m[2];
        if (v.length >= 2 && (v[0] === "\"" || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
        return { name: m[1], value: v };
    }

    /* The variables in effect for the entry at index (cron applies them to the lines below). */
    function envBefore(entries, index) {
        const env = {};
        for (let i = 0; i < index && i < entries.length; i++) {
            if (entries[i].kind !== "raw") continue;
            const v = parseEnvLine(entries[i].line);
            if (v) env[v.name] = v.value;
        }
        return env;
    }

    /* ---------- run capture (cockpit-cronjobs-run) ---------- */

    const WRAPPER_PATH = "/usr/local/libexec/cockpit-cronjobs-run";
    const WRAPPER_VERSION = 1;   /* CRONJOBS_RUN_VERSION in src/cockpit-cronjobs-run */
    const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const CAPTURE_RE = /^(\/\S*\/cockpit-cronjobs-run)\s+([A-Za-z0-9_-]{1,64})\s+(\S.*)$/;

    function shellQuote(s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    /* Undo shellQuote: only a sequence of '…' and \' is accepted. */
    function shellUnquote(s) {
        if (!s) return null;
        let out = "";
        let i = 0;
        while (i < s.length) {
            if (s[i] === "'") {
                const j = s.indexOf("'", i + 1);
                if (j < 0) return null;
                out += s.slice(i + 1, j);
                i = j + 1;
            } else if (s[i] === "\\" && s[i + 1] === "'") {
                out += "'";
                i += 2;
            } else {
                return null;
            }
        }
        return out;
    }

    /* "…/cockpit-cronjobs-run ID 'command'" -> { path, id, command } or null. */
    function unwrapCommand(command) {
        const m = CAPTURE_RE.exec(String(command || ""));
        if (!m) return null;
        const inner = shellUnquote(m[3]);
        if (inner === null || inner.trim() === "") return null;
        return { path: m[1], id: m[2], command: inner };
    }

    function wrapCommand(id, command, path) {
        return (path || WRAPPER_PATH) + " " + id + " " + shellQuote(command);
    }

    /* A "%" outside "\%" would end the command inside the quotes, and a line break
       cannot be part of a crontab line. */
    function canCapture(command) {
        return !hasUnescapedPercent(command) && !/[\r\n]/.test(command);
    }

    /* "backup-db.sh" -> "backup-db": lower case, [a-z0-9_-], at most 24 characters. */
    function slug(name) {
        return String(name || "").replace(/\.(sh|py|pl|rb|php|bash)$/i, "").toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 24).replace(/[-_]+$/, "");
    }

    /* Short readable ID from the program name, plus 4 random hex digits. */
    function makeJobId(command, taken, random) {
        const base = slug(jobName(command)) || "job";
        const rnd = random || (() => Math.floor(Math.random() * 65536));
        for (let i = 0; i < 1000; i++) {
            const id = base + "-" + rnd().toString(16).padStart(4, "0");
            if (!taken || !taken.has(id)) return id;
        }
        throw new Error("no free job id");
    }

    /* POSIX cksum (CRC-32, MSB first, length appended) of the UTF-8 bytes:
       "CRC SIZE", exactly what `cksum < file` prints. Used to make sure the
       crontab on disk is still the one shown before it is replaced. */
    let crcTable = null;
    function cksum(str) {
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i << 24;
                for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? (c << 1) ^ 0x04C11DB7 : c << 1;
                crcTable[i] = c >>> 0;
            }
        }
        const bytes = new TextEncoder().encode(String(str));
        let crc = 0;
        const step = b => { crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]) >>> 0; };
        for (let i = 0; i < bytes.length; i++) step(bytes[i]);
        for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
        return ((~crc) >>> 0) + " " + bytes.length;
    }

    /* ---------- time zones and next run ---------- */

    function validTimeZone(tz) {
        if (!tz) return false;
        try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (_) { return false; }
    }

    const partsCache = {};
    function wallParts(ms, tz) {
        let fmt = partsCache[tz];
        if (!fmt) {
            fmt = partsCache[tz] = new Intl.DateTimeFormat("en-US", {
                timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric",
                day: "numeric", hour: "numeric", minute: "numeric",
            });
        }
        const p = {};
        fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
        return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
    }

    /* Wall clock in tz -> instant (ms).
     * Repeated hour (DST end): the first occurrence, as cron runs it then.
     * Skipped hour (DST start): the time after the jump; cron runs such jobs
     * right after the change. */
    function wallToInstant(wallMs, tz) {
        const wallOf = ms => { const w = wallParts(ms, tz); return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi); };
        const offsetAt = ms => wallOf(ms) - Math.floor(ms / 60000) * 60000;
        const a = wallMs - offsetAt(wallMs - 43200000);
        const b = wallMs - offsetAt(wallMs + 43200000);
        const exact = [a, b].filter(ms => wallOf(ms) === wallMs);
        if (exact.length) return Math.min.apply(null, exact);
        return Math.max(a, b);
    }

    function dayMatches(f, y, mo, d) {
        const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
        const domOk = f[2].values.includes(d);
        const dowOk = f[4].values.includes(dow);
        if (f[2].star || f[4].star) return domOk && dowOk;
        return domOk || dowOk;
    }

    /* Next run strictly after `fromMs`, as an instant (ms); null if never/@reboot. */
    function nextRun(schedule, fromMs, tz) {
        const p = typeof schedule === "string" ? parseSchedule(schedule) : schedule;
        if (!p || !p.ok || p.reboot) return null;
        tz = validTimeZone(tz) ? tz : "UTC";
        const f = p.fields;
        const w = wallParts(fromMs, tz);
        let t = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) + 60000;
        const limit = Date.UTC(w.y + 6, 0, 1);
        for (let guard = 0; guard < 200000 && t < limit; guard++) {
            const dt = new Date(t);
            const y = dt.getUTCFullYear();
            const mo = dt.getUTCMonth() + 1;
            const d = dt.getUTCDate();
            const h = dt.getUTCHours();
            const mi = dt.getUTCMinutes();
            if (!f[3].values.includes(mo)) { t = Date.UTC(y, mo, 1); continue; }
            if (!dayMatches(f, y, mo, d)) { t = Date.UTC(y, mo - 1, d + 1); continue; }
            if (!f[1].values.includes(h)) { t = Date.UTC(y, mo - 1, d, h + 1); continue; }
            if (!f[0].values.includes(mi)) {
                const nm = f[0].values.find(v => v > mi);
                t = nm === undefined ? Date.UTC(y, mo - 1, d, h + 1) : Date.UTC(y, mo - 1, d, h, nm);
                continue;
            }
            const inst = wallToInstant(t, tz);
            if (inst > fromMs) return inst;
            t += 60000;
        }
        return null;
    }

    /* All runs in (fromMs, toMs], at most `max`. */
    function runsBetween(schedule, fromMs, toMs, tz, max) {
        const p = typeof schedule === "string" ? parseSchedule(schedule) : schedule;
        const out = [];
        let t = fromMs;
        const limit = max || 2000;
        while (out.length < limit) {
            const n = nextRun(p, t, tz);
            if (n === null || n > toMs) break;
            out.push(n);
            t = n;
        }
        return out;
    }

    /* ---------- descriptions ---------- */

    const pad2 = n => String(n).padStart(2, "0");

    function joinList(items, S) {
        if (items.length <= 1) return items.join("");
        return items.slice(0, -1).join(", ") + " " + S.and + " " + items[items.length - 1];
    }

    /* A field that is exactly one contiguous range "a-b" (no step): [a, b]. */
    function simpleRange(f) {
        const m = /^(\w+)-(\w+)$/.exec(f.raw);
        if (!m) return null;
        const a = parseValue(m[1], f.spec);
        const b = parseValue(m[2], f.spec);
        return (a === null || b === null) ? null : [a, b];
    }
    const isSingle = f => !f.star && f.values.length === 1 && !/[-/,]/.test(f.raw);
    const isList = f => !f.star && !/[-/]/.test(f.raw);
    const stepOf = f => { const m = /^\*\/(\d+)$/.exec(f.raw); return m ? parseInt(m[1], 10) : null; };

    function timePart(f, S) {
        const [mi, ho] = f;
        if (mi.star && !stepOf(mi) && ho.star && !stepOf(ho)) return { freq: true, text: S.everyMinute };
        const ms = stepOf(mi);
        if (ms && ho.star && !stepOf(ho)) return { freq: true, text: S.everyNMinutes(ms) };
        if (ms && simpleRange(ho)) {
            const [a, b] = simpleRange(ho);
            return { freq: true, text: S.everyNMinutes(ms) + " " + S.hourRange(a, b) };
        }
        if (isSingle(mi)) {
            const m = mi.values[0];
            if (ho.star && !stepOf(ho)) return { freq: true, text: m === 0 ? S.hourly : S.hourlyAt(m) };
            const hs = stepOf(ho);
            if (hs) return { freq: true, text: m === 0 ? S.everyNHours(hs) : S.everyNHoursAt(hs, m) };
            if (simpleRange(ho)) {
                const [a, b] = simpleRange(ho);
                return { freq: true, text: (m === 0 ? S.hourly : S.hourlyAt(m)) + " " + S.hourRange(a, b) };
            }
            if (isList(ho) && ho.values.length <= 6)
                return { freq: false, text: S.at(joinList(ho.values.map(h => pad2(h) + ":" + pad2(m)), S)) };
        }
        if (isList(mi) && ho.star && !stepOf(ho) && mi.values.length <= 6)
            return { freq: true, text: S.hourlyAtList(joinList(mi.values.map(String), S)) };
        if (isList(mi) && isSingle(ho) && mi.values.length <= 6) {
            const h = ho.values[0];
            return { freq: false, text: S.at(joinList(mi.values.map(m => pad2(h) + ":" + pad2(m)), S)) };
        }
        return null;
    }

    function dowPart(f, S) {
        if (isList(f) && f.values.length <= 6) return joinList(f.values.map(v => S.dowAdverb[v]), S);
        const r = simpleRange(f);
        if (r) {
            const names = S.dowName || S.dowAdverb;
            const a = r[0] === 7 ? 0 : r[0];
            const b = r[1] === 7 ? 0 : r[1];
            return S.dowRange(names[a], names[b]);
        }
        return null;
    }

    function domPart(f, S) {
        if (isSingle(f)) return S.domOne(f.values[0]);
        if (isList(f) && f.values.length <= 6) return S.domList(joinList(f.values.map(S.ord), S));
        const r = simpleRange(f);
        if (r) return S.domRange(r[0], r[1]);
        return null;
    }

    function monthPart(f, S) {
        if (isList(f) && f.values.length <= 6) return S.inMonths(joinList(f.values.map(v => S.months[v - 1]), S));
        const r = simpleRange(f);
        if (r) return S.monthRange(S.months[r[0] - 1], S.months[r[1] - 1]);
        return null;
    }

    function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

    /* Human description or null when the schedule is too unusual.
       S: the "schedule" texts of a language file. */
    function describe(schedule, S) {
        const p = typeof schedule === "string" ? parseSchedule(schedule) : schedule;
        if (!p || !p.ok || !S) return null;
        if (p.reboot) return S.reboot;
        const f = p.fields;
        const time = timePart(f, S);
        if (!time) return null;
        const [, , dom, mon, dow] = f;
        const domR = !dom.star;
        const dowR = !dow.star;
        const monR = !mon.star;

        let day = null;
        if (!domR && !dowR && !monR) {
            day = time.freq ? null : S.daily;
        } else if (domR && !dowR && monR && isSingle(dom) && isSingle(mon)) {
            day = S.domMonth(dom.values[0], S.months[mon.values[0] - 1]);
        } else {
            const parts = [];
            if (domR) { const x = domPart(dom, S); if (!x) return null; parts.push(x); }
            if (dowR) { const x = dowPart(dow, S); if (!x) return null; parts.push(x); }
            const both = domR && dowR;
            let d = both ? parts.join(" " + S.or + " ") : parts.join(" ");
            if (monR) { const x = monthPart(mon, S); if (!x) return null; d = d ? d + " " + x : x; }
            day = d;
        }
        if (!day) return cap(time.text);
        return time.freq ? cap(time.text) + ", " + day : cap(day) + " " + time.text;
    }

    /* A short name for a job: the cron.X directory run-parts runs, else the first
       real program, without its path. Conditions and waits (test, cd, sleep, …) are
       skipped, and so are programs that only start another one (nice, timeout, …). */
    const SKIP_SEGMENT = new Set(["cd", "test", "[", "true", "false", "sleep", "perl", "if", "then", "echo", ":"]);
    const PREFIXES = new Set(["nice", "ionice", "timeout", "flock", "sudo", "exec", "env", "command", "chronic",
                              "run-one", "nohup", "setsid", "stdbuf", "time", "systemd-cat"]);
    const INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "python", "python3", "php", "node", "ruby", "perl"]);
    const base = w => w.replace(/^.*\//, "");
    function jobName(command) {
        const s = String(command || "");
        const rp = /run-parts\b[^|;&]*?\/etc\/(cron\.[a-z]+)/.exec(s);
        if (rp) return rp[1];
        const segments = s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''").split(/&&|\|\||[;|(){}]/);
        let first = null;
        for (const seg of segments) {
            const words = seg.trim().split(/\s+/).filter(w => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
            let k = 0;
            while (k < words.length && PREFIXES.has(base(words[k]))) {
                const prefix = base(words[k++]);
                while (k < words.length && /^(-|\d)/.test(words[k])) {
                    k += prefix === "sudo" && /^-[ugCDhpRrTU]$/.test(words[k]) ? 2 : 1;
                }
                if (prefix === "flock" && k < words.length - 1) k++;
                while (k < words.length && /^-/.test(words[k])) k++;
            }
            let prog = k < words.length ? base(words[k]) : "";
            if (!prog || prog === "''") continue;
            if (INTERPRETERS.has(prog) && !(prog === "perl" && words[k + 1] === "-e")) {
                const script = words.slice(k + 1).find(w => !/^-/.test(w));
                if (script && /[/.]/.test(script) && script !== "''") prog = base(script);
            }
            if (first === null) first = prog;
            if (!SKIP_SEGMENT.has(prog)) return prog;
        }
        return first || s.trim().split(/\s+/)[0] || "";
    }

    return {
        NICKNAMES, MARKER, WRAPPER_PATH, WRAPPER_VERSION, JOB_ID_RE,
        parseField, parseSchedule, isFull, splitJob,
        parseUserCrontab, serializeUserCrontab, roundTrips, normalizeText, templateEnd,
        setEnabled, setJob, newJob, rawLine, entryLine,
        parseSystemCrontab, cronDNameValid, hasUnescapedPercent, cronCommand,
        parseEnvLine, envBefore,
        shellQuote, shellUnquote, unwrapCommand, wrapCommand, canCapture, makeJobId, jobName, slug,
        cksum,
        validTimeZone, wallParts, wallToInstant, nextRun, runsBetween,
        describe,
    };
}));
