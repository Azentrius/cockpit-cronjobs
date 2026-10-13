/* Cron Jobs: the timeline of the next 24 hours: when the jobs and timers run, and
 * which start in the same minute.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    $, C, clock, codeSafe, DAY, fill, h, icon, joinList, lowerFirst, pad2, rich, S, SD, state, T, weekdayShort,
} from "./core.js";
import { jobInfo, jobsOf, jobTz, rootJobs } from "./crontab.js";
import { describe } from "./page.js";

/* ---------- timeline ---------- */

/* Rows of everything that runs in (from, to]: { name, src, kind, runs, band } */
function timelineRows(from, to) {
    const rows = [];
    const addCron = (name, src, schedule, group, tz) => {
        const p = C.parseSchedule(schedule);
        if (!p.ok || p.reboot) return;
        const runs = C.runsBetween(p, from, to, tz || state.tz, 25);
        if (!runs.length) return;
        rows.push({ name, src: src + " · " + lowerFirst(describe(schedule)), kind: "cron", runs,
                    band: runs.length > 24, group });
    };
    rootJobs().forEach(({ e, i }) => {
        if (e.enabled) addCron(C.jobName(jobInfo(e).command), T.srcRoot, e.schedule, 0, jobTz(state.root.entries, i));
    });
    if (state.sys) {
        state.sys.etc.forEach(j => addCron(C.jobName(j.command), "/etc/crontab", j.schedule, 1));
        state.sys.crond.forEach(j => { if (!j.ignored) addCron(j.file, "/etc/cron.d", j.schedule, 2); });
        /* Other users: as the page shows their crontabs (also right after a change), else as read */
        Object.keys(state.users).forEach(user => jobsOf(state.users[user]).forEach(({ e, i }) => {
            if (e.enabled) addCron(C.jobName(e.command), T.srcUser(user), e.schedule, 3, jobTz(state.users[user].entries, i));
        }));
        state.sys.users.forEach(j => {
            if (j.enabled && !state.users[j.user]) addCron(C.jobName(j.command), T.srcUser(j.user), j.schedule, 3, j.tz);
        });
    }
    state.timers.list.forEach(t => {
        if (!t.active) return;
        const runs = t.runs.filter(ms => ms > from && ms <= to);
        if (!runs.length && !t.band) return;
        const what = t.randomizedUsec ? T.randomizedShort : lowerFirst(SD.describeTimer(t, S));
        rows.push({ name: t.name, src: T.srcTimer + " · " + what, kind: "timer", runs, band: !!t.band, group: 4 });
    });
    rows.sort((a, b) => a.group - b.group || (a.runs[0] || 0) - (b.runs[0] || 0) || a.name.localeCompare(b.name));
    return rows;
}

/* Starts in the same minute (rows that run more often than hourly are left out). */
function overlaps(rows) {
    const byMinute = new Map();
    rows.forEach(row => {
        if (row.band) return;
        row.runs.forEach(ms => {
            const key = Math.floor(ms / 60000);
            if (!byMinute.has(key)) byMinute.set(key, new Set());
            byMinute.get(key).add(row.name);
        });
    });
    return Array.from(byMinute.entries()).filter(([, names]) => names.size >= 2)
        .sort((a, b) => b[1].size - a[1].size || a[0] - b[0])
        .slice(0, 2)
        .sort((a, b) => a[0] - b[0])
        .map(([minute, names]) => ({ ms: minute * 60000, names: Array.from(names) }));
}

export function renderTimeline() {
    const card = $("tl-card");
    const body = $("tl-body");
    const ready = state.root.status !== "loading" && (state.sys || state.timers.list.length);
    card.hidden = !ready;
    if (!ready) return;
    const from = Date.now();
    const to = from + DAY;
    const rows = timelineRows(from, to);
    const pct = ms => ((ms - from) / DAY * 100).toFixed(3) + "%";
    const place = (el, ms) => { el.style.insetInlineStart = pct(ms); return el; };

    if (!rows.length) {
        fill(body, h("p", { class: "cron-state" }, T.tlEmpty));
        return;
    }

    /* Ticks every two hours, midnight with the weekday. */
    const ticks = [];
    const midnights = [];
    for (let t = Math.ceil(from / 900000) * 900000; t <= to; t += 900000) {
        const w = C.wallParts(t, state.tz);
        if (w.mi !== 0) continue;
        if (w.h === 0) midnights.push(t);
        if (w.h % 2) continue;
        const label = (w.h === 0 ? weekdayShort(t, state.tz) + " " : "") + pad2(w.h) + ":00";
        ticks.push({ t, label, minor: w.h % 6 !== 0 });
    }

    const scale = h("div", { class: "cron-tl-scale", "aria-hidden": "true" },
        h("span"),
        h("div", { class: "cron-tl-ticks" },
            ticks.map(k => place(h("span", { class: "cron-tl-tick" + (k.minor ? " is-minor" : "") }, k.label), k.t))));

    const grid = h("div", { class: "cron-tl-grid", "aria-hidden": "true" },
        ticks.map(k => place(h("span", { class: "cron-tl-line" }), k.t)),
        midnights.map(t => place(h("span", { class: "cron-tl-midnight" }), t)),
        h("span", { class: "cron-tl-now" }));

    const list = h("ul", { class: "cron-tl-rows", "aria-label": T.tlTitle },
        rows.map(row => {
            const times = row.band ? row.src : row.runs.slice(0, 6).map(ms => clock(ms)).join(", ") +
                (row.runs.length > 6 ? " " + T.tlMore(row.runs.length - 6) : "");
            return h("li", { class: "cron-tl-row" },
                h("div", { class: "cron-tl-label" },
                    h("span", { class: "cron-tl-name az-mono", title: row.name }, row.name),
                    h("span", { class: "cron-tl-src", title: row.src }, row.src),
                    h("span", { class: "az-sr" }, ": " + times)),
                h("div", { class: "cron-tl-track", "aria-hidden": "true" },
                    row.band ? h("span", { class: "cron-tl-band" + (row.kind === "timer" ? " is-timer" : "") }) : null,
                    row.band ? null : row.runs.map(ms => place(h("span", {
                        class: "cron-tl-mark" + (row.kind === "timer" ? " is-timer" : ""),
                        title: clock(ms) + " · " + row.name }), ms))));
        }));

    const hints = overlaps(rows).map(o => h("p", { class: "cron-tl-hint" }, icon("info-circle"),
        h("span", null, rich(T.tlOverlap(clock(o.ms), joinList(o.names.map(n => "`" + codeSafe(n) + "`")))))));

    fill(body, scale, h("div", { class: "cron-tl-body" }, grid, list), hints);
}
