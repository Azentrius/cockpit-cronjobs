/* Cron Jobs: run now, the recorded runs of a job, and leftover runs.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    $, C, clock, codeSafe, fill, fmtDuration, fmtElapsed, fmtShort, h, icon, joinList, KEEP_RUNS, LOCALE, R, rich,
    RUN_OUTPUT_LIMIT, setBusyButton, state, STATE_DIR, T, withFix,
} from "./core.js";
import { errText, isDenied, readJournal, readOutput, removeOrphans, RUN_SCRIPT, runsDirOf } from "./system.js";
import { convertedTimer, crontabOf, jobInfo, loadIfPending, loading, refreshRuns, rootVersion, runsOf } from "./crontab.js";
import { alertEl, labelEl, runLabel, showAlert } from "./page.js";
import { closeDialog, dialog, dialogError, openDialog } from "./dialogs.js";

/* ---------- run now ---------- */

let run = null;   /* { phase, proc, output, started, ended, rc, signal, stopped, error, timer, … } */

/* cron's environment for job index of crontab tab, as cron on this server gives it
   (see C.cronEnvModel): root's, or another user's with that user's home; a recorded
   job is marked as started by hand. */
function runEnvironment(tab, index, recorded) {
    const env = C.jobEnvironment(C.envBefore(tab.entries, index), tab.user === "root" ? null : tab.home, tab.user,
                                 state.basics.cronEnv);
    if (recorded) env.CRONJOBS_TRIGGER = "manual";
    return env;
}

/* Run job index of user's crontab now, as that user. */
export function openRun(user, index, openerKey) {
    const base = crontabOf(user);
    if (!base || base.status !== "ok") return;
    const e = base.entries[index];
    if (!e || e.kind !== "job") return;
    const info = jobInfo(e);
    const capture = info.capture;
    const env = runEnvironment(base, index, !!capture);
    const cron = C.cronCommand(e.command);
    run = { phase: "confirm", user, index, command: e.command, shown: info.command, capture,
            env, cron, proc: null, output: "", cut: false, started: 0, ended: 0, rc: null, signal: null,
            stopped: false, error: null, timer: null, raf: 0 };
    renderRunDialog();
    openDialog($("run-dlg"), openerKey, {
        kind: "run",
        onEscape: () => { if (run && run.phase !== "running") closeDialog(); },
        onClose: () => { if (run && run.timer) window.clearInterval(run.timer); run = null; },
    }, $("run-start"));
}

export function startRun() {
    if (!run || run.phase === "running") return;
    const env = run.env;
    const argv = ["/bin/sh", "-c", RUN_SCRIPT, "cockpit-cronjobs-run", run.user, env.HOME || "/", env.SHELL || "/bin/sh",
                  run.cron.command].concat(Object.keys(env).map(k => k + "=" + env[k]));
    Object.assign(run, { phase: "running", output: "", cut: false, started: Date.now(), ended: 0, rc: null,
                         signal: null, stopped: false, error: null });
    dialog.locked = true;
    /* Bytes, decoded leniently: output that is not UTF-8 must not end the channel
       (and with it the job). */
    const proc = cockpit.spawn(argv, { superuser: "require", err: "out", binary: true, directory: "/" });
    const decoder = new TextDecoder("utf-8");
    run.proc = proc;
    proc.stream(data => {
        if (!run || run.proc !== proc) return;
        run.output += typeof data === "string" ? data : decoder.decode(data, { stream: true });
        if (run.output.length > RUN_OUTPUT_LIMIT) {
            run.output = run.output.slice(run.output.length - RUN_OUTPUT_LIMIT);
            run.cut = true;
        }
        scheduleOutput();
    });
    proc.input(run.cron.stdin === null ? null : new TextEncoder().encode(run.cron.stdin));
    const finish = (rc, signal, error) => {
        if (!run || run.proc !== proc) return;
        Object.assign(run, { phase: "done", ended: Date.now(), rc, signal, error, proc: null });
        if (run.timer) { window.clearInterval(run.timer); run.timer = null; }
        if (dialog && dialog.kind === "run") dialog.locked = false;
        renderRunDialog();
        $("run-close-btn").focus();
        if (run.capture) refreshRuns();
    };
    proc.then(() => finish(0, null, null), ex => {
        if (run && run.stopped) finish(null, null, null);
        else if (ex && typeof ex.exit_status === "number") finish(ex.exit_status, null, null);
        else if (ex && ex.exit_signal) finish(null, ex.exit_signal, null);
        else finish(null, null, isDenied(ex) ? T.deniedRun : errText(ex));
    });
    run.timer = window.setInterval(updateRunStatus, 1000);
    renderRunDialog();
    $("run-stop").focus();
}

export function stopRun() {
    if (!run || run.phase !== "running" || !run.proc) return;
    run.stopped = true;
    setBusyButton($("run-stop"), true, T.stopping);
    run.proc.close("terminated");
}

function scheduleOutput() {
    if (!run || run.raf) return;
    run.raf = window.requestAnimationFrame(() => {
        if (!run) return;
        run.raf = 0;
        const log = $("run-log");
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
        log.textContent = run.output;
        if (atEnd) log.scrollTop = log.scrollHeight;
        $("run-cut").hidden = !run.cut;
    });
}

function updateRunStatus() {
    if (!run || run.phase !== "running") return;
    $("run-time").textContent = T.runElapsed(fmtElapsed((Date.now() - run.started) / 1000));
}

function renderRunDialog() {
    const r = run;
    if (!r) return;
    const confirm = r.phase === "confirm";
    const running = r.phase === "running";
    const done = r.phase === "done";
    $("run-intro").hidden = !confirm;
    $("run-intro").textContent = T.runIntro(r.user);
    $("run-cmd").textContent = r.shown;
    const env = r.env;
    const others = Object.keys(env).filter(k => !["PATH", "HOME", "SHELL", "LOGNAME", "USER", "CRONJOBS_TRIGGER"].includes(k));
    fill($("run-env"), rich(env.PATH !== undefined
        ? T.runEnv(codeSafe("PATH=" + env.PATH), codeSafe("HOME=" + env.HOME), codeSafe(env.SHELL))
        : T.runEnvNoPath(codeSafe("HOME=" + env.HOME), codeSafe(env.SHELL))),
        others.length ? [" ", rich(T.runEnvOthers(joinList(others.map(k => "`" + codeSafe(k) + "`"))))] : null,
        r.capture ? [" ", rich(T.runRecorded)] : null,
        r.cron.stdin !== null ? [" ", rich(T.runStdin)] : null);
    $("run-keep").hidden = !confirm && !running;
    $("run-status").hidden = confirm;
    $("run-log-wrap").hidden = confirm;
    if (running) {
        fill($("run-label"), labelEl("success", "check-circle", T.statusRunning));
        $("run-time").textContent = T.runElapsed(fmtElapsed((Date.now() - r.started) / 1000));
    } else if (done) {
        let l;
        if (r.error) l = labelEl("danger", "exclamation-circle", T.runCouldNotStart);
        else if (r.stopped) l = labelEl("warning", "exclamation-triangle", T.statusStopped);
        else if (r.signal) l = labelEl("danger", "exclamation-circle", T.statusSignal(r.signal));
        else if (r.rc === 0) l = labelEl("success", "check-circle", T.statusOk);
        else l = labelEl("danger", "exclamation-circle", T.statusFailed(r.rc));
        fill($("run-label"), l);
        $("run-time").textContent = T.runDone(fmtDuration((r.ended - r.started) / 1000), clock(r.ended));
    }
    if (!confirm) {
        const log = $("run-log");
        log.textContent = r.error ? r.error : r.output;
        log.classList.toggle("is-empty", !r.error && !r.output);
        if (!r.error && !r.output && done) log.textContent = T.noOutput;
        $("run-cut").hidden = !r.cut;
    }
    $("run-confirm-actions").hidden = !confirm;
    $("run-running-actions").hidden = !running;
    $("run-done-actions").hidden = !done;
    $("run-close").disabled = running;
    if (running) setBusyButton($("run-stop"), false, T.stopping);
}

/* ---------- recorded runs ---------- */

/* The runs of job index of user's crontab: those the run recorder kept, and for a job
   converted to a systemd timer from this crontab those of its service in the journal,
   so that the job keeps its history. */
export function openRuns(user, index, openerKey) {
    const tab = crontabOf(user);
    if (!tab || tab.status !== "ok") return;
    const e = tab.entries[index];
    if (!e || e.kind !== "job") return;
    const info = jobInfo(e);
    const timer = convertedTimer(tab, index);
    if (!info.capture && !timer) return;
    openDialog($("runs-dlg"), openerKey, {
        kind: "runs", user, index, line: e.line, id: info.capture ? info.capture.id : null, command: info.command,
        unit: timer ? timer.service : null, journal: null, open: null, outputs: {},
    }, $("runs-close-btn"));
    renderRunsDialog();
    if (info.capture) refreshRuns();
    if (timer) loadJournal(dialog);
}

/* The runs of systemd timer t's service, from the journal. */
export function openTimerRuns(t, openerKey) {
    openDialog($("runs-dlg"), openerKey, {
        kind: "runs", user: null, index: null, id: null, command: t.name, unit: t.service, journal: null,
        open: null, outputs: {},
    }, $("runs-close-btn"));
    renderRunsDialog();
    loadJournal(dialog);
}

function loadJournal(d) {
    readJournal(d.unit).then(runs => {
        d.journal = { status: "ok", runs };
        runs.forEach(r => { d.outputs[r.out] = r.output; });
    }, ex => {
        d.journal = { status: isDenied(ex) ? "denied" : "error", runs: d.journal ? d.journal.runs : [], error: errText(ex) };
    }).finally(() => { if (dialog === d) renderRunsDialog(); });
}

/* Reads the journal again for an open runs dialog of a service (every half minute). */
export function refreshJournal() {
    if (dialog && dialog.kind === "runs" && dialog.unit) loadJournal(dialog);
}

export function renderRunsDialog() {
    const d = dialog;
    if (!d || d.kind !== "runs") return;
    $("runs-cmd").textContent = d.command;
    const tab = d.user ? crontabOf(d.user) : null;
    const editable = !!tab && tab.status === "ok" && !tab.locked;
    $("runs-capture-off").hidden = !editable || !d.id || !!d.unit;
    fill($("runs-note"), d.id ? rich(T.runsNote(KEEP_RUNS, runsDirOf(d.user) + "/")) : null, d.id && d.unit ? " " : null,
        d.unit ? rich(T.runsJournalNote(d.unit)) : null);
    const job = d.id ? runsOf(d.user, d.id) : null;
    const body = $("runs-body");
    const focusedKey = document.activeElement && body.contains(document.activeElement)
        ? document.activeElement.dataset.key : null;
    const waiting = (d.id && !job && state.runs.status !== "denied") || (d.unit && !d.journal);
    const denied = (d.id && !job && state.runs.status === "denied") || (d.journal && d.journal.status === "denied");
    const items = (job ? job.running.map(r => ({ running: true, start: r.start, trigger: r.trigger }))
        .concat(job.runs.map(r => Object.assign({ running: false }, r))) : [])
        .concat(d.journal ? d.journal.runs.map(r => r.running ? { running: true, start: r.start, trigger: null, journal: true }
                                                              : Object.assign({ journal: true }, r)) : [])
        .sort((a, b) => b.start - a.start);
    const failed = d.journal && d.journal.status === "error"
        ? h("div", { class: "cron-dialog-alert" }, alertEl("warning", T.journalFailed, withFix(d.journal.error, T.journalFix))) : null;
    if (!items.length) {
        fill(body, failed, failed && !waiting ? null : h("p", { class: "cron-state" }, waiting ? T.loading : denied ? T.deniedTitle : T.runsEmpty));
        return;
    }
    const rows = [];
    items.forEach(r => {
        const key = r.out || ("s" + r.start);
        const label = r.running ? { kind: "success", icon: "check-circle", text: T.statusRunning } : runLabel(r);
        const dur = r.running ? null : R.duration(r);
        const hasOut = !r.running && (r.journal ? !!r.output : !!r.out);
        const isOpen = hasOut && d.open === r.out;
        const outId = "runs-out-" + key;
        rows.push(h("tr", { class: isOpen ? "is-open" : null },
            h("td", { class: "az-nowrap", "data-label": T.colStart }, fmtShort(r.start * 1000)),
            h("td", { "data-label": T.colTrigger },
                r.trigger === "manual" ? T.trigManual : r.trigger === "schedule" ? T.trigSchedule : T.trigSystemd),
            h("td", { class: "az-nowrap", "data-label": T.colDuration },
                r.running ? T.runningFor(fmtDuration(Date.now() / 1000 - r.start)) : dur === null ? "—" : fmtDuration(dur)),
            h("td", { class: "az-nowrap", "data-label": T.colResult }, labelEl(label.kind, label.icon, label.text)),
            h("td", { class: "az-cell-actions" }, hasOut
                ? h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "data-key": "out:" + key,
                                "aria-expanded": isOpen ? "true" : "false", "aria-controls": isOpen ? outId : null,
                                "aria-label": isOpen ? T.hideOutput : T.showOutput, title: isOpen ? T.hideOutput : T.showOutput,
                                onclick: () => toggleOutput(r.out) }, icon(isOpen ? "angle-down" : "angle-right"))
                : h("span", { class: "cron-muted", title: r.running ? null : T.noOutput }, r.running ? "" : "—"))));
        if (isOpen) {
            const text = d.outputs[r.out];
            rows.push(h("tr", { class: "is-open cron-runs-output" },
                h("td", { colspan: "5" },
                    h("pre", { class: "cron-log az-mono", id: outId, role: "log", tabindex: "0", "aria-label": T.runOutput },
                        text === undefined ? T.loading : text === null ? T.outputError : (text || T.noOutput)),
                    r.truncated ? h("p", { class: "cron-muted cron-small" }, T.outputTruncated) : null,
                    text ? h("div", { class: "cron-copy-row" },
                        h("button", { class: "az-btn az-btn--link az-btn--sm", type: "button", "data-key": "copy:" + key,
                                      onclick: ev => copyText(text, ev.currentTarget, outId) }, icon("copy"), T.copyOutput)) : null)));
        }
    });
    fill(body, failed, h("div", { class: "cron-runs-table" },
        h("table", { class: "az-table az-table--stack" },
            h("thead", null, h("tr", null,
                h("th", { scope: "col" }, T.colStart),
                h("th", { scope: "col" }, T.colTrigger),
                h("th", { scope: "col" }, T.colDuration),
                h("th", { scope: "col" }, T.colResult),
                h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.runOutput)))),
            h("tbody", null, rows))));
    if (focusedKey) {
        const el = body.querySelector('[data-key="' + focusedKey + '"]');
        if (el) el.focus();
    }
}

function toggleOutput(out) {
    const d = dialog;
    if (!d || d.kind !== "runs") return;
    d.open = d.open === out ? null : out;
    if (d.open && d.outputs[out] === undefined) {
        readOutput(d.user, d.id, out).then(text => { d.outputs[out] = text; }, () => { d.outputs[out] = null; })
            .finally(() => { if (dialog === d) renderRunsDialog(); });
    }
    renderRunsDialog();
}

function copyText(text, button, sourceId) {
    const ok = () => {
        const label = button.lastChild;
        const old = label.textContent;
        label.textContent = T.copied;
        window.setTimeout(() => { if (label.isConnected) label.textContent = old; }, 1500);
    };
    const fallback = () => {
        const src = $(sourceId);
        if (!src) return;
        const range = document.createRange();
        range.selectNodeContents(src);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        try { if (document.execCommand("copy")) ok(); } catch (_) { /* text stays selected */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
}

/* ---------- leftover runs ---------- */

/* Recorded jobs that no crontab uses any more (see lib/runs.js). Only when the root
   crontab, all other crontabs (read as root) and the runs are known, and the runs
   were read since the root crontab shown. */
export function orphanList() {
    if (state.root.status !== "ok" || state.runs.status !== "ok" || state.runs.rootVersion !== rootVersion ||
        !state.sys || !state.sys.root) return [];
    return R.orphans(state.runs.byId, [state.root.text].concat(state.sys.texts).join("\n"));
}

/* "12 KiB", "3,4 MiB", "1,7 GiB" (kb in KiB, as du -k gives it) */
function fmtSize(kb) {
    if (typeof kb !== "number") return "—";
    const n = v => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(v);
    if (kb < 1024) return n(kb) + " KiB";
    if (kb < 1024 * 1024) return n(kb / 1024) + " MiB";
    return n(kb / (1024 * 1024)) + " GiB";
}

/* A line under the root crontab while there are leftover runs. Only redrawn when
   something changed, so that focus stays on its button. */
export function renderOrphans() {
    const box = $("orphans");
    const list = orphanList();
    const frozen = state.busy || loading;
    const sig = list.map(o => o.id).join(" ") + (frozen ? " !" : "");
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.hidden = list.length === 0;
    fill(box, list.length === 0 ? null : [
        icon("history"),
        h("span", null, T.orphansLine(list.length)),
        h("button", { class: "az-btn az-btn--link cron-inline-link", type: "button", "data-key": "orphans",
                      disabled: frozen, onclick: () => openOrphans("orphans") }, T.orphansShow),
    ]);
}

function openOrphans(openerKey) {
    if (state.busy || loading || orphanList().length === 0) return;
    dialogError("orph-alert", null);
    openDialog($("orph-dlg"), openerKey, { kind: "orphans" }, $("orph-close-btn"));
    renderOrphansDialog();
}

export function renderOrphansDialog() {
    const d = dialog;
    if (!d || d.kind !== "orphans") return;
    const list = orphanList();
    const body = $("orph-body");
    const focusedKey = document.activeElement && body.contains(document.activeElement)
        ? document.activeElement.dataset.key : null;
    fill($("orph-note"), rich(T.orphansNote(STATE_DIR + "/")));
    $("orph-all").hidden = list.length < 2;
    if (list.length === 0) {
        fill(body, h("p", { class: "cron-state" }, T.orphansNone));
        return;
    }
    const rows = list.map(o => {
        const l = o.last ? runLabel(o.last) : null;
        return h("tr", null,
            h("td", { "data-label": T.colJobId }, o.user === "root" ? h("span", { class: "az-mono" }, o.id)
                : h("div", { class: "cron-cell" },
                    h("span", { class: "az-mono" }, o.id),
                    h("span", { class: "az-cell-sub" }, T.srcUser(o.user)))),
            h("td", { class: "az-nowrap", "data-label": T.colLast }, l
                ? h("div", { class: "cron-cell" },
                    h("span", null, labelEl(l.kind, l.icon, l.text)),
                    h("span", { class: "az-cell-sub" }, fmtShort(o.last.start * 1000)))
                : h("span", { class: "cron-muted" }, T.noRunYet)),
            h("td", { class: "az-nowrap", "data-label": T.colRuns }, String(o.count)),
            h("td", { class: "az-nowrap", "data-label": T.colSize }, fmtSize(o.kb)),
            h("td", { class: "az-cell-actions" },
                h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "data-key": "orph:" + o.key,
                              "aria-label": T.orphansRemove(o.id), title: T.orphansRemove(o.id), disabled: !!d.locked,
                              onclick: () => removeOrphanRuns([o.key]) }, icon("trash"))));
    });
    fill(body, h("div", { class: "cron-runs-table" },
        h("table", { class: "az-table az-table--stack" },
            h("thead", null, h("tr", null,
                h("th", { scope: "col" }, T.colJobId),
                h("th", { scope: "col" }, T.colLast),
                h("th", { scope: "col" }, T.colRuns),
                h("th", { scope: "col" }, T.colSize),
                h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.colActions)))),
            h("tbody", null, rows))));
    if (focusedKey) {
        const el = body.querySelector('[data-key="' + focusedKey + '"]');
        if (el && !el.disabled) el.focus();
    }
}

/* Removes the runs of the given jobs (keys: ID or USER/ID); the root script checks
   each one again. Jobs it keeps (used again, or running) are reported, and the page
   reloads, since a crontab changed outside the page. */
export async function removeOrphanRuns(keys) {
    const d = dialog;
    if (!d || d.kind !== "orphans" || d.locked || state.busy || loading || keys.length === 0) return;
    const buttons = [$("orph-close"), $("orph-close-btn")];
    d.locked = true;
    state.busy = true;
    dialogError("orph-alert", null);
    setBusyButton($("orph-all"), true, T.removing);
    buttons.forEach(b => { b.disabled = true; });
    renderOrphansDialog();
    let res = null;
    let error = null;
    try {
        res = await removeOrphans(keys);
    } catch (ex) {
        error = ex && ex.exit_status === 4 ? T.lockBusy : errText(ex);
    }
    state.busy = false;
    d.locked = false;
    setBusyButton($("orph-all"), false, T.removing);
    buttons.forEach(b => { b.disabled = false; });
    if (res) res.removed.forEach(id => { delete state.runs.byId[id]; });
    renderOrphans();
    let reload = false;
    if (error) {
        renderOrphansDialog();
        dialogError("orph-alert", error, T.orphansFailed);
        $("orph-close-btn").focus();
    } else if (res.kept.length) {
        closeDialog("orphans");
        showAlert("warning", T.orphansKeptTitle,
                  (res.removed.length ? T.okOrphansRemoved(res.removed.length) + ". " : "") +
                  T.orphansKept(joinList(res.kept.map(id => "`" + id + "`"))));
        reload = true;
    } else {
        if (res.removed.length) showAlert("success", T.okOrphansRemoved(res.removed.length));
        if (orphanList().length === 0) {
            closeDialog("orphans");
        } else {
            renderOrphansDialog();
            (d.el.querySelector("[data-key^='orph:']") || $("orph-close-btn")).focus();
        }
    }
    if (!loadIfPending(reload)) refreshRuns();
}
