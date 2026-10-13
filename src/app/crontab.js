/* Cron Jobs: the crontabs as the page shows them (root's, and with administrative
 * access those of other users): what is known about their jobs, loading everything,
 * saving a change in one locked step, and administrative access.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { C, codeSafe, keyOf, rich, SD, state, T, USER_RE } from "./core.js";
import {
    ensureWrapper, errText, isDenied, readBasics, readCrontab, readHomes, readRuns, readSystem, readTimers,
    removeRunsIfUnused, saveCrontab,
} from "./system.js";
import { closeMenu, renderAll, renderCrontabs, restoreFocus, showAlert, updateLastRuns } from "./page.js";
import { dialog } from "./dialogs.js";
import { renderOrphansDialog, renderRunsDialog } from "./runs.js";

/* ---------- the crontabs ---------- */

/* Counts the versions of the crontabs the page has seen. Runs read before the
   current version may still hold the runs of a line the page just removed, so
   leftover runs are only shown from runs read since (see orphanList). */
export let rootVersion = 0;

/* The crontab of user as shown: state.root for root, else state.users[user]
   (undefined when the page does not know it). */
export function crontabOf(user) {
    return user === "root" ? state.root : state.users[user];
}

/* read: { text, utf8 } from readCrontab. A crontab that is not UTF-8, or would not be
   written back exactly, is shown read-only. home: another user's home directory (from
   the user database, for run now). */
function tabOf(user, read, home) {
    rootVersion++;
    const content = read.text;
    const entries = C.parseUserCrontab(content);
    const notUtf8 = !read.utf8;
    return {
        status: "ok",
        user,
        text: content,
        entries,
        templateEnd: C.templateEnd(entries),
        notUtf8,
        locked: notUtf8 || !C.roundTrips(content),
        mailto: entries.some(e => e.kind === "raw" && /^\s*MAILTO\s*=/.test(e.line)),
        home: home || null,
    };
}

function setCrontab(user, read) {
    if (user === "root") state.root = tabOf(user, read);
    else state.users[user] = tabOf(user, read, state.users[user] && state.users[user].home);
}

/* The jobs of a crontab: [{ e, i }] with i the index of the entry. */
export function jobsOf(tab) {
    if (!tab || tab.status !== "ok") return [];
    const out = [];
    tab.entries.forEach((e, i) => { if (e.kind === "job") out.push({ e, i }); });
    return out;
}

export function rootJobs() {
    return jobsOf(state.root);
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
    if (state.root.status !== "ok") state.root = { status: "loading", user: "root" };
    renderAll();
    const basics = await readBasics().catch(() => null);
    if (basics) {
        if (basics.host) state.host = basics.host;
        state.tz = basics.tz || "UTC";
        state.basics = basics;
    }
    const [root, sys, runs, timers] = await Promise.allSettled([
        state.basics.crontab ? readCrontab("root") : Promise.reject({ problem: "not-found" }),
        readSystem(state.basics.flavor),
        readRuns(),
        state.basics.systemd ? readTimers() : Promise.resolve(null),
    ]);
    if (root.status === "fulfilled") setCrontab("root", root.value);
    else if (isDenied(root.reason)) state.root = { status: "denied", user: "root" };
    else if (root.reason && root.reason.problem === "not-found") state.root = { status: "missing", user: "root" };
    else state.root = { status: "error", user: "root", message: errText(root.reason) };
    if (sys.status === "fulfilled") {
        state.sys = sys.value;
        state.sysError = null;
    } else {
        state.sys = null;
        state.sysError = errText(sys.reason);
    }
    await loadUsers();
    if (runs.status === "fulfilled") state.runs = { status: "ok", byId: runs.value, rootVersion };
    else state.runs = { status: isDenied(runs.reason) ? "denied" : "error", byId: {} };
    if (timers.status === "fulfilled") state.timers = timers.value ? { status: "ok", list: timers.value } : { status: "none", list: [] };
    else state.timers = { status: "error", list: [], message: errText(timers.reason) };
    state.loadedAt = Date.now();
}

/* The crontabs of the other users, read through crontab -l as root, only with
   administrative access (the system read tells whose there are). Names the root
   scripts would refuse stay out (they remain read-only under System). */
async function loadUsers() {
    const sys = state.sys;
    if (!sys || !sys.root || !state.basics.crontab) {
        state.users = {};
        return;
    }
    const names = sys.userNames.filter(u => u !== "root" && USER_RE.test(u)).sort();
    const [reads, homes] = await Promise.all([Promise.allSettled(names.map(u => readCrontab(u))),
                                              readHomes(names).catch(() => ({}))]);
    const users = {};
    reads.forEach((r, k) => {
        users[names[k]] = r.status === "fulfilled" ? tabOf(names[k], r.value, homes[names[k]])
            : { status: "error", user: names[k], message: errText(r.reason) };
    });
    state.users = users;
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
   Result: { ok, unchanged?, conflict?, error?, timerFailed?, backup?, saved?, verified? }
   (verified: read back as written; if not, a warning is shown already). */
export function commit(base, mutate, okTitle, opts) {
    const refused = refuse(base, base && base.locked);
    if (refused) return Promise.resolve(refused);
    const entries = mutate(base.entries);
    if (!entries) return Promise.resolve(conflict(base.user));
    return write(base, C.serializeUserCrontab(entries), C.normalizeText, okTitle, opts || {});
}

/* Writes an earlier version (a backup) as it is, through the same locked step. Also
   on a crontab shown read-only, as nothing of it is kept; only not on one that is
   not UTF-8, whose checksum the page cannot know. Result as with commit. */
export function restoreCrontab(base, text, okTitle, opts) {
    const refused = refuse(base, base && base.notUtf8);
    if (refused) return Promise.resolve(refused);
    return write(base, text, s => s, okTitle, opts || {});
}

/* Why a change of base (a crontab as shown) cannot be written now, or null. */
function refuse(base, readOnly) {
    if (state.busy) return { ok: false, error: T.stillBusy };
    if (loading) return { ok: false, error: T.stillLoading };
    const user = base && base.user;
    const current = user ? crontabOf(user) : null;
    if (!current || current.status !== "ok") return { ok: false, conflict: true };
    if (base.status !== "ok" || readOnly || (base !== current && base.text !== current.text))
        return conflict(user);
    return null;
}

/* next: the new text; same: how it compares with what crontab -l gives back. */
async function write(base, next, same, okTitle, opts) {
    if (next === same(base.text)) return { ok: true, unchanged: true };
    const user = base.user;

    state.busy = true;
    closeMenu(false);
    renderAll();
    try {
        let backup;
        try {
            backup = await saveCrontab(user, base.text, next, opts.timer, opts.stopTimer);
        } catch (ex) {
            if (isDenied(ex)) { loadPending = true; return { ok: false, conflict: true }; }
            if (ex && ex.exit_status === 3) {
                try { setCrontab(user, await readCrontab(user)); } catch (_) { loadPending = true; }
                return conflict(user);
            }
            if (ex && ex.exit_status === 4) return { ok: false, error: T.lockBusy };
            if (ex && ex.exit_status === 5)
                return { ok: false, error: T.backupFailed + (errText(ex) ? "\n" + errText(ex) : "") };
            if (ex && ex.exit_status === 7) return { ok: false, error: errText(ex), timerFailed: true };
            return { ok: false, error: errText(ex) };
        }
        const saved = backup ? T.backupAt(codeSafe(backup)) : T.noBackup(user);
        let after = null;
        try { after = await readCrontab(user); } catch (_) { loadPending = true; }
        if (after !== null) setCrontab(user, after);
        const verified = after !== null && same(after.text) === next;
        if (!verified) {
            showAlert("warning", T.unverifiedTitle, [rich(T.unverifiedBody), " ", rich(saved)]);
        } else if (!opts.quiet) {
            showAlert("success", okTitle, saved);
        }
        return { ok: true, backup, saved, verified };
    } finally {
        state.busy = false;
        state.loadedAt = Date.now();
        renderAll();
        if (loadPending) { loadPending = false; requestLoad(); }
    }
}

function conflict(user) {
    showAlert("warning", T.conflictTitle, T.conflictBody(user));
    if (!loading && !state.busy) renderCrontabs();
    return { ok: false, conflict: true };
}

function reportResult(res) {
    if (res.error) showAlert("danger", T.saveErrorTitle, res.error);
    if (!res.ok) renderCrontabs();
}

export async function toggle(user, i, enabled) {
    const base = crontabOf(user);
    const line = base && base.entries && base.entries[i] ? base.entries[i].line : null;
    const res = await commit(base, entries => {
        const e = jobAt(entries, i, line);
        if (!e) return null;
        const copy = entries.slice();
        copy[i] = C.setEnabled(e, enabled);
        return copy;
    }, enabled ? T.okEnabled : T.okDisabled);
    reportResult(res);
    if (res.ok) refreshRuns();
    restoreFocus(keyOf(user, "toggle", i));
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
