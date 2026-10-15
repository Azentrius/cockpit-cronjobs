/* Cron Jobs: recorded runs (no DOM, no Cockpit).
 *
 * cockpit-cronjobs-run keeps, per job ID, under /var/lib/cockpit-cronjobs/runs/ID/:
 *   runs.jsonl      one JSON object per finished run, newest last (at most 20):
 *                   { start, end, rc, trigger, bytes, truncated, out [, aborted] }
 *   STAMP.out       the last 64 KiB of that run's output (stdout and stderr)
 *   STAMP.running   { start, pid, trigger } while a run is going on
 * The page reads all of it with one script (see readRuns in app/system.js); this parses it
 * and finds the jobs that no crontab uses any more.
 *
 * Loaded in the browser as window.CronRuns and in Node via require().
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root, factory) {
    "use strict";
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CronRuns = factory();
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const OUT_RE = /^[0-9A-Za-z_-]{1,64}$/;
    /* The key of a recorded job: its ID for root's jobs, USER/ID for another user's. */
    const KEY_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}\/)?[A-Za-z0-9_-]{1,64}$/;
    const keyOf = (user, id) => user === "root" ? id : user + "/" + id;
    const idOfKey = key => key.slice(key.indexOf("/") + 1);
    const userOfKey = key => key.indexOf("/") < 0 ? "root" : key.slice(0, key.indexOf("/"));
    const num = v => (typeof v === "number" && isFinite(v) ? v : null);

    function record(o) {
        if (!o || typeof o !== "object") return null;
        const start = num(o.start);
        if (start === null) return null;
        return {
            start,
            end: num(o.end),
            rc: num(o.rc),
            trigger: o.trigger === "manual" ? "manual" : "schedule",
            bytes: num(o.bytes) || 0,
            truncated: o.truncated === true,
            out: typeof o.out === "string" && OUT_RE.test(o.out) ? o.out : "",
            aborted: o.aborted === true,
        };
    }

    function parseJson(text) {
        try { return JSON.parse(text); } catch (_) { return null; }
    }

    /* Script output -> { KEY: { runs: [newest first], running: [{ start, pid, trigger }], kb } }.
       Sections start with "\x1eKEY" (ID, or USER/ID for another user's job); lines are records ("{…}"), "size KB" (disk use of
       the directory, kb null when missing) or "running ALIVE {…}" for a run marker
       (ALIVE 0: the run died without finishing). */
    function parseRuns(text) {
        const out = {};
        String(text || "").split("\x1e").slice(1).forEach(chunk => {
            const lines = chunk.split("\n");
            const id = lines.shift().trim();
            if (!KEY_RE.test(id)) return;
            const job = { runs: [], running: [], kb: null };
            lines.forEach(line => {
                if (line.charAt(0) === "{") {
                    const r = record(parseJson(line));
                    if (r) job.runs.push(r);
                    return;
                }
                const s = /^size (\d+)\s*$/.exec(line);
                if (s) { job.kb = parseInt(s[1], 10); return; }
                const m = /^running ([01]) (\{.*\})\s*$/.exec(line);
                if (!m) return;
                const o = parseJson(m[2]);
                const r = record(o);
                if (!r) return;
                if (m[1] === "1") job.running.push({ start: r.start, pid: num(o.pid), trigger: r.trigger });
                else job.runs.push(Object.assign(r, { aborted: true, end: null, rc: null, out: "" }));
            });
            job.runs.sort((a, b) => b.start - a.start);
            out[id] = job;
        });
        return out;
    }

    /* "ok" | "failed" | "aborted" for a finished run. */
    function outcome(r) {
        if (r.aborted || r.rc === null) return "aborted";
        return r.rc === 0 ? "ok" : "failed";
    }

    /* ---------- runs from the journal ---------- */

    /* The structured messages systemd logs about a unit (MESSAGE_ID, see systemd's catalog). */
    const JOURNAL_MSG = {
        jobDone: "39f53479d3a045ac8e11786248231fbf",     /* "Finished …" (oneshot), "Started …"; JOB_RESULT=done */
        jobFailed: "be02cf6855d2428ba40df7e9d022f03d",   /* "Failed to start …"; JOB_RESULT=failed */
        succeeded: "7ad2d189f7e94e70a38c781354912448",   /* "…: Deactivated successfully." (systemd 246 and later) */
        failed: "d9b373ed55a64feb8242e02dbe79a49c",      /* "…: Failed with result '…'."; UNIT_RESULT */
        exited: "98e322203f7a4ed290d09fe03c09fe15",      /* "…: Main process exited, code=…, status=…"; EXIT_CODE, EXIT_STATUS */
    };
    const INVOCATION_RE = /^[0-9a-f]{32}$/;

    /* A journal field as text: a string, or bytes (journalctl gives those that are not
       UTF-8 as a list of numbers), decoded leniently. */
    function journalText(v) {
        if (typeof v === "string") return v;
        if (Array.isArray(v) && v.every(b => typeof b === "number")) return new TextDecoder("utf-8").decode(Uint8Array.from(v));
        return "";
    }

    /* The runs of a service from `journalctl -u NAME.service -o json` (one object per
       line), one per invocation: systemd's own messages about it carry INVOCATION_ID, the
       lines the job wrote _SYSTEMD_INVOCATION_ID. Newest first, at most keep, in the
       form of recorded runs (times in seconds, trigger unknown: null), with the output
       (its last limit characters) as output. A run without an end is running when it is
       the newest, else it lost its end (aborted). */
    function parseJournal(text, keep, limit) {
        const byId = new Map();
        String(text || "").split("\n").forEach(line => {
            if (line.charAt(0) !== "{") return;
            const o = parseJson(line);
            if (!o || typeof o !== "object") return;
            const own = String(o._PID) === "1";
            const id = own ? o.INVOCATION_ID : o._SYSTEMD_INVOCATION_ID;
            const ts = Number(o.__REALTIME_TIMESTAMP) / 1e6;
            if (typeof id !== "string" || !INVOCATION_RE.test(id) || !isFinite(ts) || ts <= 0) return;
            let r = byId.get(id);
            if (!r) byId.set(id, r = { id, start: ts, end: null, rc: null, signal: false, ok: false, failed: false, lines: [] });
            r.start = Math.min(r.start, ts);
            if (!own) {
                r.lines.push(journalText(o.MESSAGE));
                return;
            }
            const m = o.MESSAGE_ID;
            if (m === JOURNAL_MSG.exited) {
                if (o.EXIT_CODE === "exited") r.rc = parseInt(o.EXIT_STATUS, 10);
                else if (o.EXIT_CODE) r.signal = true;
            } else if (m === JOURNAL_MSG.succeeded || (m === JOURNAL_MSG.jobDone && o.JOB_RESULT === "done")) {
                r.ok = true;
                r.end = Math.max(r.end || 0, ts);
            } else if (m === JOURNAL_MSG.failed || m === JOURNAL_MSG.jobFailed) {
                r.failed = true;
                r.end = Math.max(r.end || 0, ts);
                if (o.UNIT_RESULT && o.UNIT_RESULT !== "exit-code") r.signal = true;
            }
        });
        const runs = Array.from(byId.values()).sort((a, b) => b.start - a.start);
        return runs.slice(0, keep || runs.length).map((r, k) => {
            let output = r.lines.join("\n");
            const truncated = !!limit && output.length > limit;
            if (truncated) output = output.slice(output.length - limit);
            const done = r.ok || r.failed;
            const rc = r.failed ? (r.signal || isNaN(r.rc) ? null : r.rc) : r.ok ? 0 : null;
            return {
                start: r.start, end: done ? r.end : null, rc, trigger: null, bytes: output.length, truncated,
                out: r.id, aborted: r.failed ? rc === null : !done && k > 0, running: !done && k === 0, output,
            };
        });
    }

    /* Seconds a run took, or null. */
    function duration(r) {
        return r.end !== null && r.end >= r.start ? r.end - r.start : null;
    }

    /* The words of a text: runs of the characters an ID is made of. */
    function words(text) {
        return new Set(String(text || "").split(/[^A-Za-z0-9_-]+/));
    }

    /* Whether the ID appears as a word anywhere in the text, comments included. Wider
       than the run recorder's command line on purpose: an ID that a crontab still
       mentions is never offered for removal. */
    function mentioned(text, id) {
        return ID_RE.test(id) && words(text).has(id);
    }

    /* Recorded jobs that no crontab mentions any more (lines changed or removed by
       hand): [{ key, user, id, count, last, kb }], the most recent last run first. A
       job with a run going on is never one of them.
       byId: from parseRuns; text: all crontabs together. */
    function orphans(byId, text) {
        const used = words(text);
        return Object.keys(byId)
            .filter(key => byId[key].running.length === 0 && !used.has(idOfKey(key)))
            .map(key => ({ key, user: userOfKey(key), id: idOfKey(key), count: byId[key].runs.length,
                           last: byId[key].runs[0] || null, kb: byId[key].kb }))
            .sort((a, b) => (b.last ? b.last.start : 0) - (a.last ? a.last.start : 0) || a.key.localeCompare(b.key));
    }

    return { ID_RE, OUT_RE, KEY_RE, keyOf, parseRuns, parseJournal, outcome, duration, mentioned, orphans };
}));
