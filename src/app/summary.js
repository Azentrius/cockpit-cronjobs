/* Cron Jobs: the latest results at a glance: the last run of every recorded job (in
 * every crontab the page shows) and of every active systemd timer, failures first.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { $, fill, fmtDuration, fmtShort, h, icon, keyOf, R, SD, state, T } from "./core.js";
import { jobInfo, jobsOf, runsOf } from "./crontab.js";
import { labelEl, runLabel, timerDuration, timerRunLabel } from "./page.js";
import { openRuns, openTimerRuns } from "./runs.js";

/* Whether the successful ones are listed too; failed and running ones always are. */
let showOk = false;

const ORDER = { failed: 0, running: 1, ok: 2 };
const RUNNING = { kind: "info", icon: "sync-alt" };

/* Everything with a last result: { state: "failed" | "running" | "ok", label, when (ms),
   dur (s or null), name, source, key, title, open }. A run that was aborted counts as
   failed: it needs a look as much. */
function results() {
    const out = [];
    const tabs = [["root", state.root]].concat(Object.keys(state.users).sort().map(u => [u, state.users[u]]));
    tabs.forEach(([user, tab]) => jobsOf(tab).forEach(({ e, i }) => {
        const info = jobInfo(e);
        if (!e.enabled || !info.capture) return;
        const job = runsOf(user, info.capture.id);
        if (!job) return;
        const key = keyOf(user, "sum", i);
        const item = { name: info.command, source: user === "root" ? T.rootTitle : T.userTitle(user), key,
                       title: T.showRuns, open: () => openRuns(user, i, key) };
        if (job.running.length) {
            const start = Math.min.apply(null, job.running.map(r => r.start)) * 1000;
            out.push(Object.assign(item, { state: "running", label: Object.assign({ text: T.statusRunning }, RUNNING), when: start, dur: null }));
            return;
        }
        const last = job.runs[0];
        if (!last) return;
        out.push(Object.assign(item, { state: R.outcome(last) === "ok" ? "ok" : "failed", label: runLabel(last),
                                       when: last.start * 1000, dur: R.duration(last) }));
    }));
    if (state.timers.status === "ok") state.timers.list.forEach(t => {
        if (!t.active) return;
        const from = SD.parseUnitDescription(t.description);
        const item = { name: t.name, source: from ? T.fromCrontab(from.user) : T.legendTimer, key: "sum-timer:" + t.name,
                       title: T.showRuns, open: () => openTimerRuns(t, "sum-timer:" + t.name) };
        if (t.running) {
            out.push(Object.assign(item, { state: "running", label: Object.assign({ text: T.statusRunning }, RUNNING),
                                           when: t.startUs !== null ? t.startUs : t.last, dur: null }));
            return;
        }
        const l = t.last !== null ? timerRunLabel(t) : null;
        if (!l) return;
        out.push(Object.assign(item, { state: l.kind === "success" ? "ok" : "failed", label: l, when: t.last, dur: timerDuration(t) }));
    });
    return out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.when || 0) - (a.when || 0) || a.name.localeCompare(b.name));
}

export function renderSummary() {
    const card = $("sum-card");
    const all = state.loadedAt ? results() : [];
    card.hidden = all.length === 0;
    if (card.hidden) return;
    const count = s => all.filter(x => x.state === s).length;
    const failed = count("failed");
    const running = count("running");
    const ok = count("ok");
    $("sum-desc").textContent = [failed ? T.sumFailed(failed) : T.sumNoFailures, running ? T.sumRunning(running) : null,
                                 ok ? T.sumOk(ok) : null].filter(Boolean).join(" · ");
    const rows = all.filter(x => x.state !== "ok" || showOk).map(x => h("tr", null,
        h("td", { class: "az-nowrap", "data-label": T.colResult },
            labelEl(x.label.kind, x.label.icon, x.label.text, { "data-key": x.key, title: x.title, onclick: x.open })),
        h("td", { "data-label": T.colJob },
            h("div", { class: "cron-cell" },
                h("span", { class: "az-mono" }, x.name),
                h("span", { class: "az-cell-sub" }, x.source))),
        h("td", { class: "az-nowrap", "data-label": T.colLast },
            x.when ? fmtShort(x.when) + (x.dur !== null ? " · " + fmtDuration(x.dur) : "") : "—")));
    const toggle = ok ? h("button", {
        class: "az-btn az-btn--link az-btn--sm cron-disclosure", type: "button", "data-key": "sum-toggle",
        "aria-expanded": showOk ? "true" : "false",
        onclick: () => {
            showOk = !showOk;
            renderSummary();
            const b = document.querySelector("[data-key='sum-toggle']");
            if (b) b.focus();
        },
    }, icon(showOk ? "angle-down" : "angle-right"), showOk ? T.sumHideOk : T.sumShowOk(ok)) : null;
    fill($("sum-body"),
        rows.length ? h("div", { class: "az-card__body--flush az-table-wrap" },
            h("table", { class: "az-table az-table--stack" },
                h("thead", null, h("tr", null,
                    h("th", { scope: "col" }, T.colResult),
                    h("th", { scope: "col" }, T.colJob),
                    h("th", { scope: "col" }, T.colLast))),
                h("tbody", null, rows))) : null,
        toggle ? h("div", { class: "az-card__footer" }, toggle) : null);
}
