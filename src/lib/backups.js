/* Cron Jobs: backups of the root crontab (no DOM, no Cockpit).
 *
 * Before every change, SAVE_SCRIPT (app/system.js) copies the root crontab to
 * /var/lib/cockpit-cronjobs/backups/root-YYYYMMDD-HHMMSS[-N].crontab and keeps the last
 * ten. BACKUPS_SCRIPT prints all of them in one go; this parses that output and
 * compares two versions line by line, the way diff does.
 *
 * Loaded in the browser as window.CronBackups and in Node via require().
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root, factory) {
    "use strict";
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CronBackups = factory();
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const NAME_RE = /^root-(\d{8})-(\d{6})(?:-(\d+))?\.crontab$/;

    /* ---------- the list ---------- */

    /* Output of BACKUPS_SCRIPT (bytes): for each backup a header line
       "\x1eMTIME SIZE NAME\n" (MTIME in seconds), then exactly SIZE bytes of the file.
       Result: the backups, newest first: { name, mtime (ms), size, text } where text
       is null when the file is not UTF-8 (it can then neither be compared nor
       restored here). Throws when the output does not have this shape. */
    function parseBackups(bytes) {
        const list = [];
        let pos = 0;
        while (pos < bytes.length) {
            if (bytes[pos] !== 0x1e) throw new Error("unexpected output at byte " + pos);
            const nl = bytes.indexOf(0x0a, pos);
            if (nl < 0) throw new Error("header without end");
            const m = /^(\d+) (\d+) (.*)$/.exec(latin1(bytes.subarray(pos + 1, nl)));
            if (!m) throw new Error("bad header");
            const size = +m[2];
            const body = bytes.subarray(nl + 1, nl + 1 + size);
            if (body.length !== size) throw new Error("file shorter than its size");
            pos = nl + 1 + size;
            if (!NAME_RE.test(m[3])) continue;
            let text = null;
            try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); } catch (_) { text = null; }
            list.push({ name: m[3], mtime: +m[1] * 1000, size, text });
        }
        return list.sort(newestFirst);
    }

    function latin1(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
    }

    /* As SAVE_SCRIPT sees it (ls -t): newest first; within one second the name decides
       (time stamp, then the number added to a second backup in the same second). */
    function newestFirst(a, b) {
        if (a.mtime !== b.mtime) return b.mtime - a.mtime;
        const x = NAME_RE.exec(a.name);
        const y = NAME_RE.exec(b.name);
        const stamp = (y[1] + y[2]).localeCompare(x[1] + x[2]);
        return stamp || (+(y[3] || 1)) - (+(x[3] || 1));
    }

    /* ---------- difference ---------- */

    /* The lines of a text, each with its newline (the last one may have none), so that
       a missing newline at the end counts as a change, as with diff. */
    function lines(text) {
        return String(text || "").match(/[^\n]*\n|[^\n]+$/g) || [];
    }

    /* Which lines of a and b are changed in a shortest edit script (Myers, "An O(ND)
       difference algorithm and its variations", 1986): marks in ca and cb. Only lines
       lo … ahi - 1 of a and lo … bhi - 1 of b are compared; the rest is the same. */
    function mark(a, b, ca, cb, lo, ahi, bhi) {
        const n = ahi - lo;
        const m = bhi - lo;
        if (n === 0 || m === 0) {
            for (let i = lo; i < ahi; i++) ca[i] = true;
            for (let j = lo; j < bhi; j++) cb[j] = true;
            return;
        }
        const max = n + m;
        const off = max + 1;
        const v = new Int32Array(2 * max + 3);
        const trace = [];
        let done = false;
        for (let d = 0; d <= max && !done; d++) {
            trace.push(v.slice());
            for (let k = -d; k <= d; k += 2) {
                let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
                let y = x - k;
                while (x < n && y < m && a[lo + x] === b[lo + y]) { x++; y++; }
                v[off + k] = x;
                if (x >= n && y >= m) { done = true; break; }
            }
        }
        /* Walk back from the end; trace[d] holds the furthest points after d - 1 edits.
           Each step back: equal lines (diagonal), then the one edit that led there. */
        let x = n;
        let y = m;
        for (let d = trace.length - 1; d > 0; d--) {
            const w = trace[d];
            const k = x - y;
            const down = k === -d || (k !== d && w[off + k - 1] < w[off + k + 1]);
            const px = w[off + (down ? k + 1 : k - 1)];
            const py = px - (down ? k + 1 : k - 1);
            const sx = down ? px : px + 1;
            while (x > sx) { x--; y--; }
            if (down) cb[lo + py] = true;
            else ca[lo + px] = true;
            x = px;
            y = py;
        }
    }

    /* Moves runs of changed lines so that they look as diff shows them: merged where
       possible, as far down as possible, and next to a change in the other file when
       there is one (cf. "shift_boundaries" in GNU diff). Like diff, a run never moves
       into the lines both files start or end with (before lo, from hi on). Marks in cx
       are moved; the lines the two files share stay the same. */
    function shift(x, cx, cy, lo, hi) {
        /* gaps[k]: changed lines of the other file between its k-th and (k+1)-th
           unchanged line. */
        const gaps = [0];
        cy.forEach(c => { if (c) gaps[gaps.length - 1]++; else gaps.push(0); });
        let i = lo;
        let k = lo;   /* unchanged lines of x before i */
        while (i < hi) {
            if (!cx[i]) { i++; k++; continue; }
            let start = i;
            let end = i;
            while (end < hi && cx[end]) end++;
            let corresponding;
            let len;
            do {
                len = end - start;
                while (start > lo && x[start - 1] === x[end - 1]) {
                    cx[--start] = true;
                    cx[--end] = false;
                    k--;
                    while (start > lo && cx[start - 1]) start--;
                }
                corresponding = gaps[k] ? end : -1;
                while (end < hi && x[start] === x[end]) {
                    cx[start++] = false;
                    cx[end++] = true;
                    k++;
                    while (end < hi && cx[end]) end++;
                    if (gaps[k]) corresponding = end;
                }
            } while (len !== end - start);
            if (corresponding >= 0) {
                while (corresponding < end) {
                    cx[--start] = true;
                    cx[--end] = false;
                    k--;
                }
            }
            i = end;
        }
    }

    /* The difference from a to b (texts): [{ op: " " | "-" | "+", line }] in order;
       within a change the removed lines come before the added ones, as with diff.
       line keeps its newline. */
    function diff(aText, bText) {
        const a = lines(aText);
        const b = lines(bText);
        const ca = new Array(a.length).fill(false);
        const cb = new Array(b.length).fill(false);
        let lo = 0;
        let ahi = a.length;
        let bhi = b.length;
        while (lo < ahi && lo < bhi && a[lo] === b[lo]) lo++;
        while (ahi > lo && bhi > lo && a[ahi - 1] === b[bhi - 1]) { ahi--; bhi--; }
        mark(a, b, ca, cb, lo, ahi, bhi);
        shift(a, ca, cb, lo, ahi);
        shift(b, cb, ca, lo, bhi);
        const out = [];
        let i = 0;
        let j = 0;
        while (i < a.length || j < b.length) {
            while (i < a.length && ca[i]) out.push({ op: "-", line: a[i++] });
            while (j < b.length && cb[j]) out.push({ op: "+", line: b[j++] });
            if (i < a.length && j < b.length) {
                out.push({ op: " ", line: a[i] });
                i++;
                j++;
            }
        }
        return out;
    }

    /* Lines removed and added. */
    function counts(ops) {
        let removed = 0;
        let added = 0;
        ops.forEach(o => { if (o.op === "-") removed++; else if (o.op === "+") added++; });
        return { removed, added };
    }

    /* For showing: changed lines with up to `context` unchanged lines around them;
       longer stretches of unchanged lines become { op: "skip", count }. */
    function hunks(ops, context) {
        const keep = ops.map(() => false);
        ops.forEach((o, i) => {
            if (o.op === " ") return;
            for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
        });
        const out = [];
        let skipped = 0;
        ops.forEach((o, i) => {
            if (keep[i]) {
                if (skipped) out.push({ op: "skip", count: skipped });
                skipped = 0;
                out.push(o);
            } else {
                skipped++;
            }
        });
        if (skipped) out.push({ op: "skip", count: skipped });
        return out;
    }

    return { NAME_RE, parseBackups, lines, diff, counts, hunks };
}));
