/* Cron Jobs: the root crontab as the page shows it: what is known about its jobs,
 * loading everything, saving a change in one locked step, and administrative access.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { C, codeSafe, rich, SD, state, T } from "./core.js";
import {
    ensureWrapper, errText, isDenied, readBasics, readRoot, readRuns, readSystem, readTimers, removeRunsIfUnused,
    saveRoot,
} from "./system.js";
import { closeMenu, renderAll, renderRoot, restoreFocus, showAlert, updateLastRuns } from "./page.js";
import { dialog } from "./dialogs.js";
import { renderOrphansDialog, renderRunsDialog } from "./runs.js";

/* ---------- the root crontab ---------- */

/* Counts the versions of the root crontab the page has seen. Runs read before the
   current version may still hold the runs of a line the page just removed, so
   leftover runs are only shown from runs read since (see orphanList). */
export let rootVersion = 0;

/* read: { text, utf8 } from readRoot. A crontab that is not UTF-8, or would not be
   written back exactly, is shown read-only. */
function setRoot(read) {
    rootVersion++;
    const content = read.text;
    const entries = C.parseUserCrontab(content);
    const notUtf8 = !read.utf8;
    state.root = {
        status: "ok",
        text: content,
        entries,
        templateEnd: C.templateEnd(entries),
        notUtf8,
        locked: notUtf8 || !C.roundTrips(content),
        mailto: entries.some(e => e.kind === "raw" && /^\s*MAILTO\s*=/.test(e.line)),
    };
}

export function rootJobs() {
    const r = state.root;
    if (r.status !== "ok") return [];
    const out = [];
    r.entries.forEach((e, i) => { if (e.kind === "job") out.push({ e, i }); });
    return out;
}

/* The command as the user wrote it, and the recording, if any. */
export function jobInfo(e) {
    const capture = C.unwrapCommand(e.command);
    return { capture, command: capture ? capture.command : e.command };
}

export function takenIds(entries) {
    const ids = new Set();
    entries.forEach(e => {
        if (e.kind !== "job") return;
        const c = C.unwrapCommand(e.command);
        if (c) ids.add(c.id);
    });
    return ids;
}

/* A comment line right above a job (not from the Debian/Ubuntu template) is its note. */
export function noteFor(r, i) {
    if (i === 0 || i - 1 <= r.templateEnd) return null;
    const prev = r.entries[i - 1];
    if (prev.kind !== "raw") return null;
    const m = /^\s*#+\s*(\S.*)$/.exec(prev.line);
    return m ? m[1].trim() : null;
}

/* The timer a job was converted to: its line is off and the conversion's note is
   right above it (see SD.convertNote). Else null. */
export function convertedTo(r, i) {
    const e = r.entries[i];
    if (!e || e.kind !== "job" || e.enabled || i === 0 || r.entries[i - 1].kind !== "raw") return null;
    const note = SD.parseConvertNote(r.entries[i - 1].line);
    return note ? note.name : null;
}

/* cronie runs a job in CRON_TZ when the crontab sets it above the job;
   Debian's cron does not know CRON_TZ. */
export function jobTz(entries, index) {
    if (state.basics.flavor !== "cronie") return state.tz;
    const tz = C.envBefore(entries, index).CRON_TZ;
    return tz && C.validTimeZone(tz) ? tz : state.tz;
}

export function runsOf(id) {
    return state.runs.status === "ok" ? (state.runs.byId[id] || { runs: [], running: [] }) : null;
}

/* ---------- loading ---------- */

/* Loading and saving exclude each other: requestLoad waits for a running save,
   commit refuses while loading. */
export let loading = false;
let loadPending = false;

export function requestLoad() {
    if (loading || state.busy) { loadPending = true; return; }
    loading = true;
    closeMenu(false);
    load().catch(ex => console.error(ex)).finally(() => {
        loading = false;
        renderAll();
        if (loadPending && !state.busy) { loadPending = false; requestLoad(); }
    });
}

/* Loads when a load waited for a change to finish, or when reload asks for one.
   Result: whether it loads. */
export function loadIfPending(reload) {
    if (!reload && !loadPending) return false;
    loadPending = false;
    requestLoad();
    return true;
}

async function load() {
    state.suAtLoad = superuser ? superuser.Current : undefined;
    if (state.root.status !== "ok") state.root = { status: "loading" };
    renderAll();
    const basics = await readBasics().catch(() => null);
    if (basics) {
        if (basics.host) state.host = basics.host;
        state.tz = basics.tz || "UTC";
        state.basics = basics;
    }
    const [root, sys, runs, timers] = await Promise.allSettled([
        state.basics.crontab ? readRoot() : Promise.reject({ problem: "not-found" }),
        readSystem(state.basics.flavor),
        readRuns(),
        state.basics.systemd ? readTimers() : Promise.resolve(null),
    ]);
    if (root.status === "fulfilled") setRoot(root.value);
    else if (isDenied(root.reason)) state.root = { status: "denied" };
    else if (root.reason && root.reason.problem === "not-found") state.root = { status: "missing" };
    else state.root = { status: "error", message: errText(root.reason) };
    if (sys.status === "fulfilled") {
        state.sys = sys.value;
        state.sysError = null;
    } else {
        state.sys = null;
        state.sysError = errText(sys.reason);
    }
    if (runs.status === "fulfilled") state.runs = { status: "ok", byId: runs.value, rootVersion };
    else state.runs = { status: isDenied(runs.reason) ? "denied" : "error", byId: {} };
    if (timers.status === "fulfilled") state.timers = timers.value ? { status: "ok", list: timers.value } : { status: "none", list: [] };
    else state.timers = { status: "error", list: [], message: errText(timers.reason) };
    state.loadedAt = Date.now();
}

/* Only the recorded runs, e.g. after a manual run or every half minute. */
let runsLoading = false;
export function refreshRuns() {
    if (runsLoading || state.root.status !== "ok") return Promise.resolve();
    runsLoading = true;
    const version = rootVersion;
    return readRuns().then(byId => {
        if (state.runs.status === "ok" && state.runs.rootVersion > version) return;   /* a reload was faster */
        state.runs = { status: "ok", byId, rootVersion: version };
    }, ex => {
        if (isDenied(ex)) state.runs = { status: "denied", byId: {} };
    }).finally(() => {
        runsLoading = false;
        updateLastRuns();
        if (dialog && dialog.kind === "runs") renderRunsDialog();
        if (dialog && dialog.kind === "orphans") renderOrphansDialog();
    });
}

/* ---------- saving ---------- */

/* The job at index i, as long as it is exactly the line it was when the action started. */
export function jobAt(entries, i, line) {
    const e = entries[i];
    return e && e.kind === "job" && e.line === line ? e : null;
}

/* base: the state shown, which the change refers to (kept when a dialog opens or a
   switch is clicked). mutate: entries -> new entries, or null when the line no
   longer fits. opts.quiet: no success message (the caller reports); opts.timer: a
   systemd timer to enable and start in the same step, or to stop and disable with
   opts.stopTimer (see SAVE_SCRIPT).
   Result: { ok, unchanged?, conflict?, error?, timerFailed?, backup?, saved? } */
export async function commit(base, mutate, okTitle, opts) {
    opts = opts || {};
    if (state.busy) return { ok: false, error: T.stillBusy };
    if (loading) return { ok: false, error: T.stillLoading };
    if (state.root.status !== "ok") return { ok: false, conflict: true };
    if (!base || base.status !== "ok" || base.locked || (base !== state.root && base.text !== state.root.text))
        return conflict();
    const entries = mutate(base.entries);
    if (!entries) return conflict();
    const next = C.serializeUserCrontab(entries);
    if (next === C.normalizeText(base.text)) return { ok: true, unchanged: true };

    state.busy = true;
    closeMenu(false);
    renderAll();
    try {
        let backup;
        try {
            backup = await saveRoot(base.text, next, opts.timer, opts.stopTimer);
        } catch (ex) {
            if (isDenied(ex)) { state.root = { status: "denied" }; return { ok: false, conflict: true }; }
            if (ex && ex.exit_status === 3) {
                try { setRoot(await readRoot()); } catch (_) { loadPending = true; }
                return conflict();
            }
            if (ex && ex.exit_status === 4) return { ok: false, error: T.lockBusy };
            if (ex && ex.exit_status === 5)
                return { ok: false, error: T.backupFailed + (errText(ex) ? "\n" + errText(ex) : "") };
            if (ex && ex.exit_status === 7) return { ok: false, error: errText(ex), timerFailed: true };
            return { ok: false, error: errText(ex) };
        }
        const saved = backup ? T.backupAt(codeSafe(backup)) : T.noBackup;
        let after = null;
        try { after = await readRoot(); } catch (_) { loadPending = true; }
        if (after !== null) setRoot(after);
        if (after === null || C.normalizeText(after.text) !== next) {
            showAlert("warning", T.unverifiedTitle, [rich(T.unverifiedBody), " ", rich(saved)]);
        } else if (!opts.quiet) {
            showAlert("success", okTitle, saved);
        }
        return { ok: true, backup, saved };
    } finally {
        state.busy = false;
        state.loadedAt = Date.now();
        renderAll();
        if (loadPending) { loadPending = false; requestLoad(); }
    }
}

function conflict() {
    showAlert("warning", T.conflictTitle, T.conflictBody);
    if (state.root.status === "ok" && !loading && !state.busy) renderRoot();
    return { ok: false, conflict: true };
}

function reportResult(res) {
    if (res.error) showAlert("danger", T.saveErrorTitle, res.error);
    if (!res.ok) renderRoot();
}

export async function toggle(i, enabled) {
    const base = state.root;
    const line = base.entries && base.entries[i] ? base.entries[i].line : null;
    const res = await commit(base, entries => {
        const e = jobAt(entries, i, line);
        if (!e) return null;
        const copy = entries.slice();
        copy[i] = C.setEnabled(e, enabled);
        return copy;
    }, enabled ? T.okEnabled : T.okDisabled);
    reportResult(res);
    if (res.ok) refreshRuns();
    restoreFocus("toggle:" + i);
}

/* Turns recording on or off for one job. Off also deletes its recorded runs. */
export async function setCapture(i, on, focusKey, shownBase) {
    const base = shownBase || state.root;
    const e = base.entries && base.entries[i];
    if (!e || e.kind !== "job") return;
    const line = e.line;
    const before = jobInfo(e);
    if (on && !(await ensureWrapper())) { restoreFocus(focusKey); return; }
    const res = await commit(base, entries => {
        const cur = jobAt(entries, i, line);
        if (!cur) return null;
        const info = jobInfo(cur);
        if (!!info.capture === on) return entries;
        const command = on ? C.wrapCommand(C.makeJobId(info.command, takenIds(entries)), info.command)
            : info.command;
        const copy = entries.slice();
        copy[i] = C.setJob(cur, cur.schedule, command, cur.enabled);
        return copy;
    }, on ? T.okCaptureOn : T.okCaptureOff);
    if (res.ok && !on && before.capture) await removeRunsIfUnused(before.capture.id);
    reportResult(res);
    if (res.ok) refreshRuns();
    restoreFocus(focusKey);
}

/* ---------- administrative access ---------- */

let superuser = null;

export function watchSuperuser() {
    try {
        superuser = cockpit.dbus(null, { bus: "internal" }).proxy("cockpit.Superuser", "/superuser");
    } catch (_) {
        superuser = null;
        return Promise.resolve();
    }
    superuser.addEventListener("changed", () => {
        const cur = superuser.Current;
        if (cur === undefined || cur === "init" || cur === state.suAtLoad) return;
        requestLoad();
    });
    const ready = Promise.resolve(superuser.wait()).catch(() => {});
    const timeout = new Promise(resolve => window.setTimeout(resolve, 1500));
    return Promise.race([ready, timeout]);
}
