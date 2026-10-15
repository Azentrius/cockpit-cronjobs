/* Cron Jobs: the page itself: alerts and notices, the crontabs (root's and, with
 * administrative access, those of other users), systemd timers and the read-only
 * crontabs, focus, and the row menu.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    $, C, cap, clock, fill, fmtClock, fmtDuration, fmtLocal, fmtRelative, fmtShort, fmtWhen, h, icon, keyOf, R, rich,
    S, SD, state, T, tzLabel,
} from "./core.js";
import { errText, installWrapper } from "./system.js";
import {
    convertedTimer, convertedTo, crontabOf, jobInfo, jobsOf, jobTz, loading, noteFor, requestLoad, runsOf, setCapture, toggle,
} from "./crontab.js";
import { renderTimeline } from "./timeline.js";
import { renderSummary } from "./summary.js";
import { openCaptureOff, openDelete, openEdit } from "./dialogs.js";
import { openRun, openRuns, openTimerRuns, renderOrphans, renderOrphansDialog } from "./runs.js";
import { convertBlocker, openBack, openConvert } from "./convert.js";
import { openBackups } from "./backups.js";
import { hiddenBesidesTabs, showTabOf } from "./tabs.js";

/* ---------- alerts ---------- */

const ALERT_ICON = { success: "check-circle", warning: "exclamation-triangle", danger: "exclamation-circle", info: "info-circle" };

export function alertEl(kind, title, body, actions) {
    return h("div", { class: "az-alert az-alert--" + kind, role: kind === "danger" ? "alert" : "status" },
        h("span", { class: "az-alert__icon" }, icon(ALERT_ICON[kind])),
        h("p", { class: "az-alert__title" }, rich(title)),
        body ? h("p", { class: "az-alert__body" }, rich(body)) : null,
        actions ? h("div", { class: "az-alert__actions" }, actions) : null);
}

export function showAlert(kind, title, body) {
    fill($("alerts"), alertEl(kind, title, body));
}
export function clearAlerts() { fill($("alerts")); }

/* Lasting notes about the server: no mail program, cron not running, run recorder. */
export function renderNotices() {
    const b = state.basics;
    const out = [];
    const capturedJobs = [state.root].concat(Object.values(state.users)).flatMap(jobsOf).filter(({ e }) => {
        const c = jobInfo(e).capture;
        return c && c.path === C.WRAPPER_PATH;
    });
    if (b.cron && !b.cron.active) {
        out.push(alertEl("warning", T.cronDownTitle, T.cronDownBody, b.cron.unit && b.systemd
            ? h("button", { class: "az-btn az-btn--link", type: "button",
                            onclick: () => cockpit.jump("/system/services#/" + encodeURIComponent(b.cron.unit), cockpit.transport.host) },
                T.openServices)
            : null));
    }
    if (capturedJobs.length && b.wrapper === "missing") {
        out.push(alertEl("danger", T.wrapperMissingTitle, T.wrapperMissingBody(capturedJobs.length, C.WRAPPER_PATH),
            h("button", { class: "az-btn az-btn--secondary", type: "button", id: "wrapper-install",
                          disabled: state.busy || loading, onclick: () => repairWrapper() }, icon("plus"), T.install)));
    } else if (typeof b.wrapper === "number" && b.wrapper < C.WRAPPER_VERSION) {
        out.push(alertEl("warning", T.wrapperOldTitle, T.wrapperOldBody(C.WRAPPER_PATH),
            h("button", { class: "az-btn az-btn--secondary", type: "button", id: "wrapper-install",
                          disabled: state.busy || loading, onclick: () => repairWrapper() }, icon("sync-alt"), T.update)));
    }
    if (b.mta === false && state.root.status === "ok" && !state.root.mailto) {
        out.push(alertEl("info", T.noMtaTitle, T.noMtaBody));
    }
    fill($("notices"), out);
}

async function repairWrapper() {
    const btn = $("wrapper-install");
    if (btn) btn.disabled = true;
    try {
        await installWrapper();
        showAlert("success", T.wrapperInstalled, T.wrapperInstalledBody(C.WRAPPER_PATH));
    } catch (ex) {
        showAlert("danger", T.wrapperFailed, errText(ex));
    }
    renderNotices();
}

/* ---------- rendering ---------- */

export function renderAll() {
    renderHeader();
    renderNotices();
    renderSummary();
    renderTimeline();
    renderCrontabs();
    renderOrphans();
    renderTimers();
    renderSystem();
    renderOrphansDialog();
}

/* "Refresh" is off while the page loads (and says so) or saves. */
function renderHeader() {
    $("sig-host").textContent = state.host;
    $("sig-host").hidden = !state.host;
    const meta = [];
    if (state.loadedAt) meta.push(T.loadedAt(fmtClock(state.loadedAt)));
    if (state.sys) meta.push(T.serverTz(tzLabel(state.tz)));
    $("meta").textContent = meta.join(" · ");
    $("reload").disabled = state.busy || loading;
    $("reload").setAttribute("aria-busy", loading ? "true" : "false");
    $("reload-label").textContent = loading ? T.refreshing : T.refresh;
}

export function describe(schedule) {
    return C.describe(schedule, S) || S.custom;
}

function scheduleCell(schedule, tz) {
    return h("div", { class: "cron-cell" },
        h("span", null, describe(schedule)),
        h("span", { class: "az-cell-sub az-mono" }, schedule + (tz && tz !== state.tz ? " · " + tzLabel(tz) : "")));
}

function nextCell(r, e, i) {
    if (!e.enabled) return h("span", { class: "cron-muted" }, "—");
    const p = C.parseSchedule(e.schedule);
    if (p.reboot) return h("span", null, T.nextBoot);
    const ms = C.nextRun(p, Date.now(), jobTz(r.entries, i));
    if (ms === null) return h("span", null, T.neverRuns);
    return whenCell(ms);
}

function whenCell(ms) {
    const sub = [fmtRelative(ms), fmtLocal(ms)].filter(Boolean).join(" · ");
    return h("div", { class: "cron-cell" },
        h("span", null, cap(fmtWhen(ms))),
        h("span", { class: "az-cell-sub" }, sub));
}

/* Result label of a run: { kind, icon, text } */
export function runLabel(r) {
    const o = R.outcome(r);
    if (o === "ok") return { kind: "success", icon: "check-circle", text: T.statusOk };
    if (o === "failed") return { kind: "danger", icon: "exclamation-circle", text: T.statusFailed(r.rc) };
    return { kind: "warning", icon: "exclamation-triangle", text: T.statusAborted };
}

/* A status label; with attrs it is a button that wraps the label. */
export function labelEl(kind, iconName, text, attrs) {
    const label = h("span", { class: "az-label az-label--" + kind }, iconName ? icon(iconName) : null, text);
    return attrs ? h("button", Object.assign({ type: "button", class: "cron-label-btn" }, attrs), label) : label;
}

/* id of the element with the command of job i, which describes the row's controls. */
const cmdIdOf = (user, i) => user === "root" ? "cmd-" + i : "cmd-" + user + "-" + i;

/* The last run of job i of user's crontab; for a job converted to a systemd timer, the
   timer's (its runs are in the journal then). */
function lastCell(user, e, i, editable, frozen) {
    const info = jobInfo(e);
    const cmdId = cmdIdOf(user, i);
    const timer = convertedTimer(crontabOf(user), i);
    if (timer) {
        const runsKey = keyOf(user, "runs", i);
        const open = { "data-key": runsKey, "aria-describedby": cmdId, title: T.showRuns,
                       onclick: () => openRuns(user, i, runsKey) };
        if (timer.running) return h("div", { class: "cron-cell" }, h("span", null, labelEl("info", "sync-alt", T.statusRunning, open)));
        const l = timer.last !== null ? timerRunLabel(timer) : null;
        if (!l) return h("span", { class: "cron-muted" }, T.noRunYet);
        const d = timerDuration(timer);
        return h("div", { class: "cron-cell" },
            h("span", null, labelEl(l.kind, l.icon, l.text, open)),
            h("span", { class: "az-cell-sub" }, fmtShort(timer.last) + (d !== null ? " · " + fmtDuration(d) : "")));
    }
    if (!info.capture) {
        if (!e.enabled) return h("span", { class: "cron-muted" }, "—");
        const can = editable && C.canCapture(info.command);
        const key = keyOf(user, "capture", i);
        return h("div", { class: "cron-cell" },
            h("span", { class: "cron-muted" }, T.notRecorded),
            can ? h("button", { class: "az-btn az-btn--link cron-inline-link", type: "button", disabled: frozen,
                                "data-key": key, "aria-describedby": cmdId,
                                onclick: () => setCapture(user, i, true, key) }, T.recordLink) : null);
    }
    const job = runsOf(user, info.capture.id);
    if (!job) return h("span", { class: "cron-muted" }, "—");
    const runsKey = keyOf(user, "runs", i);
    const open = { "data-key": runsKey, "aria-describedby": cmdId, title: T.showRuns,
                   onclick: () => openRuns(user, i, runsKey) };
    if (job.running.length) {
        const start = Math.min.apply(null, job.running.map(r => r.start)) * 1000;
        return h("div", { class: "cron-cell" },
            h("span", null, labelEl("info", "sync-alt", T.statusRunning, open)),
            h("span", { class: "az-cell-sub" }, T.runningSince(clock(start), fmtDuration((Date.now() - start) / 1000))));
    }
    const last = job.runs[0];
    if (!last) return h("span", { class: "cron-muted" }, T.noRunYet);
    const l = runLabel(last);
    const d = R.duration(last);
    return h("div", { class: "cron-cell" },
        h("span", null, labelEl(l.kind, l.icon, l.text, open)),
        h("span", { class: "az-cell-sub" }, fmtShort(last.start * 1000) + (d !== null ? " · " + fmtDuration(d) : "")));
}

/* The crontabs: root's card (in index.html), then one card for each other user. */
export function renderCrontabs() {
    renderCrontab(state.root, { body: $("root-body"), add: $("add"), backups: $("backups") });
    renderUserCards();
}

/* The cards of the other users' crontabs, only with administrative access; built
   afresh each time, like the rows. */
function renderUserCards() {
    const box = $("user-crontabs");
    const users = Object.keys(state.users).sort();
    box.hidden = users.length === 0;
    fill(box, users.map(user => {
        const id = "ut-" + user;
        const button = (action, iconName, text, onclick) => h("button", {
            class: "az-btn az-btn--secondary az-btn--sm", type: "button", "data-key": keyOf(user, action), onclick,
        }, icon(iconName), text);
        const els = {
            body: h("div", { id: id + "-body" }),
            add: button("add", "plus", T.add, () => openEdit(user, null, keyOf(user, "add"))),
            backups: button("backups", "history", T.backups, () => openBackups(user, keyOf(user, "backups"))),
        };
        renderCrontab(state.users[user], els);
        return h("section", { class: "az-card", "aria-labelledby": id + "-title", "data-user": user },
            h("div", { class: "az-card__header" },
                h("div", null,
                    h("h2", { class: "az-card__title", id: id + "-title" }, T.userTitle(user)),
                    h("p", { class: "az-card__desc" }, rich(T.userDesc(user)))),
                h("div", { class: "az-card__actions" }, els.backups, els.add)),
            els.body);
    }));
}

/* One crontab r into els.body, with its buttons els.add and els.backups. Every job
   can be switched, edited, deleted and run now; root's can also be recorded and
   converted. */
function renderCrontab(r, els) {
    const user = r.user;
    const body = els.body;
    const jobs = jobsOf(r);
    const editable = r.status === "ok" && !r.locked;
    const frozen = state.busy || loading;
    els.add.hidden = !(editable && jobs.length > 0);
    els.add.disabled = frozen;
    els.backups.hidden = r.status !== "ok";
    els.backups.disabled = frozen;

    if (r.status === "loading") {
        fill(body, h("p", { class: "cron-state" }, T.loading));
        return;
    }
    if (r.status === "denied") {
        fill(body, h("div", { class: "az-empty" },
            h("span", { class: "az-empty__icon" }, icon("info-circle")),
            h("h3", { class: "az-empty__title" }, T.deniedTitle),
            h("p", { class: "az-empty__body" }, rich(T.deniedBody))));
        return;
    }
    if (r.status === "missing") {
        fill(body, h("div", { class: "cron-card-alert" }, alertEl("warning", T.noCrontabTitle, T.noCrontabBody)));
        return;
    }
    if (r.status === "error") {
        fill(body, h("div", { class: "cron-card-alert" },
            alertEl("danger", T.readErrorTitle(user), r.message,
                    h("button", { class: "az-btn az-btn--link", type: "button", onclick: () => requestLoad() }, T.retry))));
        return;
    }
    if (jobs.length === 0) {
        const key = keyOf(user, "add-empty");
        fill(body, h("div", { class: "az-empty" },
            h("span", { class: "az-empty__icon" }, icon("clock")),
            h("h3", { class: "az-empty__title" }, T.emptyTitle),
            h("p", { class: "az-empty__body" }, T.emptyBody(user)),
            editable ? h("div", { class: "az-empty__actions" },
                h("button", { class: "az-btn az-btn--secondary az-btn--sm", type: "button", "data-key": key,
                              disabled: frozen, onclick: () => openEdit(user, null, key) },
                  icon("plus"), T.add)) : null));
        return;
    }

    const isRoot = user === "root";
    const rows = jobs.map(({ e, i }) => {
        const cmdId = cmdIdOf(user, i);
        const note = noteFor(r, i);
        const timer = convertedTo(r, i);
        const info = jobInfo(e);
        const toggleCell = editable
            ? h("label", { class: "az-switch" },
                h("input", { type: "checkbox", role: "switch", checked: e.enabled, disabled: frozen,
                             "aria-describedby": cmdId, "data-key": keyOf(user, "toggle", i),
                             onchange: ev => toggle(user, i, ev.target.checked) }),
                h("span", { class: "az-switch__track" }),
                h("span", { class: "az-sr" }, T.activeSr))
            : h("span", { class: "cron-muted" }, e.enabled ? T.on : T.off);
        const btn = (action, label, iconName, onclick, extra) => h("button", Object.assign({
            class: "az-btn az-btn--plain az-btn--sm", type: "button", "aria-label": label, title: label,
            "aria-describedby": cmdId, disabled: frozen, "data-key": keyOf(user, action, i), onclick }, extra || {}),
            icon(iconName));
        return h("tr", { class: e.enabled ? null : "is-off" },
            h("td", { class: "az-cell-toggle", "data-label": T.colActive }, toggleCell),
            h("td", { class: "az-nowrap", "data-label": T.colSchedule }, scheduleCell(e.schedule, jobTz(r.entries, i))),
            h("td", { class: "az-nowrap", "data-label": T.colNext, "data-next": isRoot ? i : user + ":" + i }, nextCell(r, e, i)),
            h("td", { class: "az-nowrap", "data-label": T.colLast, "data-last": isRoot ? i : user + ":" + i },
                lastCell(user, e, i, editable, frozen)),
            h("td", { "data-label": T.colCommand },
                h("div", { class: "cron-cell" },
                    h("span", { class: "az-mono", id: cmdId }, info.command),
                    timer ? h("span", { class: "az-cell-sub" }, T.convertedTo, " ",
                        h("button", { class: "az-btn az-btn--link cron-inline-link", type: "button", "data-key": keyOf(user, "timer", i),
                                      title: T.openInCockpit(timer + ".timer"), onclick: () => jumpToUnit(timer + ".timer") },
                          timer + ".timer"))
                        : note ? h("span", { class: "az-cell-sub" }, note) : null)),
            h("td", { class: "az-cell-actions" },
                r.notUtf8 ? null : btn("run", T.actRun, "play", () => openRun(user, i, keyOf(user, "run", i))),
                editable ? btn("edit", T.actEdit, "pencil-alt", () => openEdit(user, i, keyOf(user, "edit", i))) : null,
                menuItems(r, i).length ? btn("more", T.actMore, "ellipsis-v", ev => openRowMenu(r, i, ev.currentTarget),
                    { "aria-haspopup": "menu", "aria-expanded": "false" }) : null));
    });

    const head = h("tr", null,
        h("th", { class: "cron-col-toggle", scope: "col" }, T.colActive),
        h("th", { scope: "col" }, T.colSchedule),
        h("th", { scope: "col" }, T.colNext),
        h("th", { scope: "col" }, T.colLast),
        h("th", { scope: "col" }, T.colCommand),
        h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.colActions)));

    fill(body,
        r.locked ? h("div", { class: "cron-card-alert" },
            alertEl("warning", T.lockedTitle, r.notUtf8 ? T.lockedEncodingBody : T.lockedBody)) : null,
        h("div", { class: "az-card__body--flush az-table-wrap" },
            h("table", { class: "az-table az-table--stack cron-root-table" }, h("thead", null, head), h("tbody", null, rows))));
}

export function updateNextRuns() {
    document.querySelectorAll("td[data-next]").forEach(td => {
        const v = td.dataset.next;
        const c = v.lastIndexOf(":");
        const r = crontabOf(c < 0 ? "root" : v.slice(0, c));
        const i = +v.slice(c + 1);
        const e = r && r.status === "ok" ? r.entries[i] : null;
        if (e && e.kind === "job") fill(td, nextCell(r, e, i));
    });
    document.querySelectorAll("td[data-timer-next]").forEach(td => {
        const t = state.timers.list[+td.dataset.timerNext];
        if (t) fill(td, timerNextCell(t));
    });
}

export function updateLastRuns() {
    if (state.busy || loading) return;
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    document.querySelectorAll("td[data-last]").forEach(td => {
        const v = td.dataset.last;
        const c = v.lastIndexOf(":");
        const user = c < 0 ? "root" : v.slice(0, c);
        const r = crontabOf(user);
        const i = +v.slice(c + 1);
        const e = r && r.status === "ok" ? r.entries[i] : null;
        if (e && e.kind === "job") fill(td, lastCell(user, e, i, !r.locked, false));
    });
    renderOrphans();
    renderSummary();
    if (focused && !document.activeElement.isConnected) restoreFocus(focused);
    renderNotices();
}

/* After the timers' last runs were read again (refreshTimers). */
export function updateTimerRuns() {
    if (state.busy || loading) return;
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    renderTimers();
    renderSummary();
    if (focused && !document.activeElement.isConnected) restoreFocus(focused);
}

/* ---------- systemd timers ---------- */

function jumpToUnit(unit) {
    cockpit.jump("/system/services#/" + encodeURIComponent(unit), cockpit.transport.host);
}

function timerNextCell(t) {
    if (!t.active) return h("span", { class: "cron-muted" }, T.timerInactive);
    if (t.next === null) return h("span", { class: "cron-muted" }, "—");
    return whenCell(t.next);
}

/* How timer t's last run ended, as a label ({ kind, icon, text }), or null when systemd
   tells no result; and how long it took, in seconds (or null). */
export function timerRunLabel(t) {
    if (t.result === "success") return { kind: "success", icon: "check-circle", text: T.statusOk };
    if (t.result === "exit-code" && t.status !== null) return { kind: "danger", icon: "exclamation-circle", text: T.statusFailed(t.status) };
    if (t.result) return { kind: "danger", icon: "exclamation-circle", text: T.statusResult(t.result) };
    return null;
}
export const timerDuration = t => t.startUs !== null && t.exitUs !== null && t.exitUs >= t.startUs ? (t.exitUs - t.startUs) / 1000 : null;

function timerLastCell(t) {
    if (t.running) return h("div", { class: "cron-cell" }, h("span", null, labelEl("info", "sync-alt", T.statusRunning)));
    if (t.last === null) return h("span", { class: "cron-muted" }, T.noRunYet);
    const l = timerRunLabel(t);
    const label = l ? labelEl(l.kind, l.icon, l.text) : null;
    const dur = timerDuration(t);
    return h("div", { class: "cron-cell" },
        label ? h("span", null, label) : null,
        h("span", { class: label ? "az-cell-sub" : null }, fmtShort(t.last) + (dur !== null ? " · " + fmtDuration(dur) : "")));
}

function renderTimers() {
    const card = $("timers-card");
    const tm = state.timers;
    card.hidden = tm.status === "none" || (tm.status === "ok" && tm.list.length === 0);
    /* Without systemd or without timers the tab says so, once the page has loaded. */
    $("timers-none").hidden = !card.hidden || !state.loadedAt;
    if (card.hidden) return;
    if (tm.status === "error") {
        fill($("timers-body"), h("div", { class: "cron-card-alert" }, alertEl("warning", T.timersErrorTitle, tm.message)));
        return;
    }
    fill($("timers-body"), h("div", { class: "az-card__body--flush az-table-wrap" },
        h("table", { class: "az-table az-table--stack" },
            h("thead", null, h("tr", null,
                h("th", { scope: "col" }, T.colTimer),
                h("th", { scope: "col" }, T.colSchedule),
                h("th", { scope: "col" }, T.colNext),
                h("th", { scope: "col" }, T.colLast),
                h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.colActions)))),
            h("tbody", null, tm.list.map((t, k) => {
                const ours = SD.parseUnitDescription(t.description);
                const specs = t.calendar.concat(t.monotonic.map(m => m.base.replace(/USec$/, "Sec") + "=" + SD.formatSpan(m.usec)));
                const sub = specs.join(" · ") + (t.randomizedUsec ? " · " + T.randomUpTo(SD.formatSpan(t.randomizedUsec)) : "");
                return h("tr", { class: t.active ? null : "is-off" },
                    h("td", { class: "az-nowrap", "data-label": T.colTimer },
                        h("div", { class: "cron-cell" },
                            h("span", { class: "az-mono" }, t.name),
                            h("span", { class: "az-cell-sub" }, ours ? T.fromCrontab(ours.user) : t.description))),
                    h("td", { "data-label": T.colSchedule },
                        h("div", { class: "cron-cell" },
                            h("span", null, SD.describeTimer(t, S)),
                            sub ? h("span", { class: "az-cell-sub az-mono" }, sub) : null)),
                    h("td", { class: "az-nowrap", "data-label": T.colNext, "data-timer-next": k }, timerNextCell(t)),
                    h("td", { class: "az-nowrap", "data-label": T.colLast }, timerLastCell(t)),
                    h("td", { class: "az-cell-actions" },
                        h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "data-key": "timer-runs:" + t.name,
                                      "aria-label": T.showRuns, title: T.showRuns,
                                      onclick: () => openTimerRuns(t, "timer-runs:" + t.name) },
                          icon("history")),
                        h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "aria-label": T.openInCockpit(t.name),
                                      title: T.openInCockpit(t.name),
                                      onclick: () => jumpToUnit(t.name) },
                          icon("external-link-alt"))));
            })))));
}

/* ---------- read-only crontabs ---------- */

function readOnlyTable(cols, rows) {
    return h("div", { class: "az-card__body--flush az-table-wrap" },
        h("table", { class: "az-table az-table--stack" },
            h("thead", null, h("tr", null, cols.map(c => h("th", { scope: "col" }, c)))),
            h("tbody", null, rows)));
}

function emptyState() { return h("p", { class: "cron-state" }, T.noEntries); }

function renderSystem() {
    const sys = state.sys;
    ["etc-card", "crond-card", "users-card", "periodic-card"].forEach(id => { $(id).hidden = !sys; });
    fill($("sys-alerts"), !sys && state.sysError !== null
        ? alertEl("warning", T.sysErrorTitle, state.sysError) : null);
    if (!sys) return;

    fill($("etc-body"), sys.etc.length === 0 ? emptyState() : readOnlyTable(
        [T.colSchedule, T.colUser, T.colCommand],
        sys.etc.map(j => h("tr", null,
            h("td", { class: "az-nowrap", "data-label": T.colSchedule }, scheduleCell(j.schedule)),
            h("td", { class: "az-nowrap", "data-label": T.colUser }, j.user),
            h("td", { "data-label": T.colCommand }, h("span", { class: "az-mono" }, j.command))))));

    fill($("crond-body"), sys.crond.length === 0 ? emptyState() : readOnlyTable(
        [T.colFile, T.colSchedule, T.colUser, T.colCommand],
        sys.crond.map(j => h("tr", { class: j.ignored ? "is-off" : null },
            h("td", { "data-label": T.colFile },
                h("div", { class: "cron-cell" },
                    h("div", { class: "cron-title-row" },
                        h("span", { class: "az-mono" }, j.file),
                        j.ignored ? h("span", { class: "az-label az-label--warning", title: T.ignoredWhy[j.ignored] }, T.ignored) : null),
                    j.ignored ? h("span", { class: "az-cell-sub cron-ignored-why" }, T.ignoredWhy[j.ignored]) : null)),
            h("td", { class: "az-nowrap", "data-label": T.colSchedule },
                j.schedule ? scheduleCell(j.schedule) : h("span", { class: "cron-muted" }, "—")),
            h("td", { class: "az-nowrap", "data-label": T.colUser }, j.user || h("span", { class: "cron-muted" }, "—")),
            h("td", { "data-label": T.colCommand },
                j.command ? h("span", { class: "az-mono" }, j.command) : h("span", { class: "cron-muted" }, "—"))))));

    /* Users whose crontabs the page cannot change (names it does not take) */
    const readOnlyUsers = sys.users.filter(j => !state.users[j.user]);
    $("users-card").hidden = readOnlyUsers.length === 0;
    fill($("users-body"), readOnlyTable(
        [T.colUser, T.colSchedule, T.colCommand],
        readOnlyUsers.map(j => h("tr", { class: j.enabled ? null : "is-off" },
            h("td", { class: "az-nowrap", "data-label": T.colUser }, j.user),
            h("td", { class: "az-nowrap", "data-label": T.colSchedule }, scheduleCell(j.schedule)),
            h("td", { "data-label": T.colCommand }, h("span", { class: "az-mono" }, j.command))))));

    $("periodic-card").hidden = sys.periodic.length === 0;
    fill($("periodic-body"), readOnlyTable(
        [T.colDir, T.colScripts],
        sys.periodic.map(p => h("tr", null,
            h("td", { class: "az-nowrap", "data-label": T.colDir }, h("span", { class: "az-mono" }, p.dir)),
            h("td", { "data-label": T.colScripts },
                p.scripts.length === 0 ? h("span", { class: "cron-muted" }, T.none)
                    : h("div", { class: "cron-chips" }, p.scripts.map(s => h("span", { class: "az-label" }, s))))))));
}

/* ---------- focus ---------- */

/* Focus on the element with this data-key (see keyOf), or else on the row's menu
   button, the add button of the same crontab, root's, the title; its tab is shown
   first. */
export function restoreFocus(key) {
    const byKey = k => document.querySelector('[data-key="' + k + '"]');
    const usable = x => x && !x.disabled && !hiddenBesidesTabs(x);
    let el = key ? byKey(key) : null;
    const row = key ? /^[a-z-]+(?::([A-Za-z0-9_][A-Za-z0-9._-]*))?:(\d+)$/.exec(key) : null;
    const of = key ? /^[a-z-]+:([A-Za-z0-9_][A-Za-z0-9._-]*)$/.exec(key) : null;
    const user = row && row[1] ? row[1] : of && !/^\d+$/.test(of[1]) ? of[1] : "root";
    if (!usable(el) && row) el = byKey(keyOf(user, "more", row[2]));
    if (!usable(el)) {
        el = [byKey(keyOf(user, "add")), byKey(keyOf(user, "add-empty")), $("add"), byKey("add-empty"), $("page-title")]
            .find(usable);
    }
    if (el) {
        showTabOf(el);
        el.focus();
    }
}

/* ---------- row menu ---------- */

let menu = null;   /* { el, button, onDoc } */

export function closeMenu(focusButton) {
    if (!menu) return;
    const m = menu;
    menu = null;
    m.el.remove();
    m.button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", m.onDoc, true);
    window.removeEventListener("resize", m.onResize);
    if (focusButton && m.button.isConnected) m.button.focus();
}

/* The row menu of job i in crontab r. */
function menuItems(r, i) {
    const e = r.entries[i];
    const info = jobInfo(e);
    const editable = r.status === "ok" && !r.locked;
    const more = keyOf(r.user, "more", i);
    const items = [];
    if (info.capture || convertedTimer(r, i)) items.push({ label: T.showRuns, icon: "history", action: () => openRuns(r.user, i, more) });
    if (editable) {
        if (info.capture) {
            items.push({ label: T.captureOff, action: () => openCaptureOff(r.user, i, more) });
        } else {
            const can = C.canCapture(info.command);
            items.push({ label: T.captureOn, icon: "history", disabled: !can, hint: can ? null : T.cannotCapture,
                         action: () => setCapture(r.user, i, true, more) });
        }
    }
    if (editable) {
        if (state.basics.systemd && convertedTo(r, i)) {
            items.push({ label: T.backToCron, icon: "exchange-alt", action: () => openBack(r.user, i, more) });
        } else if (state.basics.systemd && state.timers.status === "ok") {
            const why = convertBlocker(r, i);
            items.push({ label: T.convert, icon: "exchange-alt", disabled: !!why, hint: why,
                         action: () => openConvert(r.user, i, more) });
        }
    }
    if (editable) {
        if (items.length) items.push("sep");
        items.push({ label: T.actDelete, icon: "trash", danger: true, action: () => openDelete(r.user, i, more) });
    }
    return items;
}

function openRowMenu(r, i, button) {
    if (menu && menu.button === button) { closeMenu(true); return; }
    closeMenu(false);
    const items = menuItems(r, i);
    if (!items.length) return;
    const el = h("div", { class: "cron-menu", role: "menu", "aria-label": T.actMore, id: "row-menu" },
        items.map(it => it === "sep" ? h("div", { class: "cron-menu__sep", role: "separator" })
            : h("button", {
                type: "button", role: "menuitem", tabindex: "-1",
                class: "cron-menu__item" + (it.danger ? " is-danger" : ""),
                "aria-disabled": it.disabled ? "true" : null,
                onclick: () => { if (it.disabled) return; closeMenu(false); it.action(); },
            }, it.icon ? icon(it.icon) : h("span", { class: "cron-menu__spacer" }),
            h("span", { class: "cron-menu__text" }, it.label,
              it.hint ? h("span", { class: "cron-menu__hint" }, it.hint) : null))));
    document.body.append(el);
    const rect = button.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = rect.right - width;
    left = Math.max(8, Math.min(left, document.documentElement.clientWidth - width - 8));
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8 && rect.top - height - 4 > 8) top = rect.top - height - 4;
    el.style.left = (left + window.scrollX) + "px";
    el.style.top = (top + window.scrollY) + "px";

    const all = Array.from(el.querySelectorAll("[role=menuitem]"));
    const move = (from, step) => {
        const n = all.length;
        let k = from;
        for (let tries = 0; tries < n; tries++) {
            k = (k + step + n) % n;
            if (all[k].getAttribute("aria-disabled") !== "true") { all[k].focus(); return; }
        }
    };
    el.addEventListener("keydown", ev => {
        const cur = all.indexOf(document.activeElement);
        if (ev.key === "ArrowDown") { ev.preventDefault(); move(cur, 1); }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); move(cur < 0 ? 0 : cur, -1); }
        else if (ev.key === "Home") { ev.preventDefault(); move(-1, 1); }
        else if (ev.key === "End") { ev.preventDefault(); move(0, -1); }
        else if (ev.key === "Escape") { ev.preventDefault(); closeMenu(true); }
        else if (ev.key === "Tab") { closeMenu(true); }
    });
    const onDoc = ev => {
        if (!el.contains(ev.target) && ev.target !== button && !button.contains(ev.target)) closeMenu(false);
    };
    const onResize = () => closeMenu(false);
    menu = { el, button, onDoc, onResize };
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("resize", onResize);
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-controls", "row-menu");
    move(-1, 1);
}
