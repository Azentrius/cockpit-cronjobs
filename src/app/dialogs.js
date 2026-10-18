/* Cron Jobs: dialogs in general (focus, Escape), and adding, editing, deleting and
 * confirming.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    $, backupDirOf, C, cronNext, fill, fmtLocal, fmtWhen, h, icon, keyOf, rich, setBusyButton, state, T,
} from "./core.js";
import { ensureUserRuns, errText, installWrapper, removeRunsIfUnused, wrapperCurrent } from "./system.js";
import {
    commit, crontabOf, jobAt, jobInfo, jobsOf, jobTz, loading, noteFor, refreshRuns, setCapture, takenIds,
} from "./crontab.js";
import { alertEl, closeMenu, describe, restoreFocus } from "./page.js";

/* ---------- dialogs ---------- */

export let dialog = null;   /* { kind, el, openerKey, … } */

function focusables(root) {
    return Array.from(root.querySelectorAll("button, input, [href], [tabindex]:not([tabindex='-1'])"))
        .filter(el => !el.disabled && !el.closest("[hidden]"));
}

function onDialogKey(ev) {
    if (!dialog) return;
    if (ev.key === "Escape") {
        ev.preventDefault();
        if (dialog.onEscape) dialog.onEscape();
        else closeDialog();
    } else if (ev.key === "Tab") {
        const list = focusables(dialog.el);
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
}

export function openDialog(el, openerKey, info, focusEl) {
    closeMenu(false);
    dialog = Object.assign({ el, openerKey }, info);
    $("page").inert = true;
    el.hidden = false;
    document.addEventListener("keydown", onDialogKey, true);
    focusEl.focus();
}

export function closeDialog(focusKey, force) {
    if (!dialog || (state.busy && !force) || dialog.locked) return;
    const key = focusKey || dialog.openerKey;
    if (dialog.onClose) dialog.onClose();
    dialog.el.hidden = true;
    dialog = null;
    $("page").inert = false;
    document.removeEventListener("keydown", onDialogKey, true);
    restoreFocus(key);
}

export function dialogError(id, message, title) {
    const box = $(id);
    if (!message) { box.hidden = true; fill(box); return; }
    fill(box, alertEl("danger", title || T.saveErrorTitle, message));
    box.hidden = false;
}

/* Edit / add */

export const form = {
    schedule: () => $("f-schedule"),
    command: () => $("f-command"),
    active: () => $("f-active"),
    capture: () => $("f-capture"),
    touched: { schedule: false, command: false },
};

function checkSchedule(value, tz) {
    const s = value.trim();
    if (!s) return { ok: false, msg: T.errRequired, empty: true };
    const p = C.parseSchedule(s);
    if (!p.ok) {
        if (p.field === "count-low" || p.field === "count-high") return { ok: false, msg: T.errCount };
        return { ok: false, msg: T.errField(T.fieldNames[p.field], T.fieldRanges[p.field]) };
    }
    if (p.reboot) return { ok: true, text: p.text, help: T.bootHelp };
    const ms = cronNext(p, Date.now(), tz);
    if (ms === null) return { ok: false, msg: T.errNever };
    const local = fmtLocal(ms);
    const help = T.nextHelp(describe(p), fmtWhen(ms)) + (local ? " · " + local : "");
    return { ok: true, text: p.text, help };
}

function checkCommand(value) {
    const c = value.trim();
    if (!c) return { ok: false, msg: T.errCommand, empty: true };
    if (/[\r\n]/.test(c)) return { ok: false, msg: T.errNewline };
    return { ok: true, text: c, percent: C.hasUnescapedPercent(c) };
}

function setFieldState(input, help, ok, message) {
    input.setAttribute("aria-invalid", ok ? "false" : "true");
    help.className = ok ? "az-field__help" : "az-field__error";
    fill(help, ok ? rich(message) : [icon("exclamation-circle"), h("span", null, rich(message))]);
}

/* Errors show once a field was left (touched) or on saving (showAll); until then the
   field keeps its help. */
export function updateForm(showAll) {
    const d = dialog && dialog.kind === "edit" ? dialog : null;
    const user = d ? d.base.user : "root";
    const mailto = d ? d.base.mailto : state.root.mailto;
    const sched = checkSchedule(form.schedule().value, d ? d.tz : null);
    const cmd = checkCommand(form.command().value);
    const showSched = showAll || form.touched.schedule;
    const showCmd = showAll || form.touched.command;

    if (sched.ok) setFieldState(form.schedule(), $("f-schedule-help"), true, sched.help);
    else if (showSched) setFieldState(form.schedule(), $("f-schedule-help"), false, sched.msg);
    else setFieldState(form.schedule(), $("f-schedule-help"), true, T.scheduleHelp);

    const capture = form.capture();
    const recorded = capture.checked && !capture.disabled;
    const cmdHelp = state.basics.mta === false && !mailto
        ? (recorded ? T.commandHelpNoMtaRecorded(user) : T.commandHelpNoMta(user))
        : mailto ? T.commandHelpMailto(user) : T.commandHelp(user);
    if (!cmd.ok && showCmd) setFieldState(form.command(), $("f-command-help"), false, cmd.msg);
    else setFieldState(form.command(), $("f-command-help"), true, cmdHelp);

    const warn = $("f-command-warn");
    warn.hidden = !(cmd.ok && cmd.percent);
    if (!warn.hidden) fill(warn, icon("exclamation-triangle"), h("span", null, rich(T.percentWarn)));

    const blocked = cmd.ok && cmd.percent;
    capture.disabled = blocked;
    fill($("f-capture-help"), rich(blocked ? T.cannotCapture : T.captureHelp(C.WRAPPER_PATH)));
    return { sched, cmd };
}

/* Add (index null) or edit a job of user's crontab. */
export function openEdit(user, index, openerKey) {
    const base = crontabOf(user);
    if (state.busy || loading || !base || base.status !== "ok" || base.locked) return;
    const e = index === null ? null : base.entries[index];
    if (index !== null && (!e || e.kind !== "job")) return;
    const info = e ? jobInfo(e) : null;
    $("edit-title").textContent = e ? T.editTitle : T.addTitle;
    $("edit-sub").textContent = user === "root" ? "" : T.userTitle(user);
    $("edit-sub").hidden = user === "root";
    form.schedule().value = e ? e.schedule : "";
    form.command().value = e ? info.command : "";
    form.active().checked = e ? e.enabled : true;
    form.capture().checked = e ? !!info.capture : true;
    form.touched.schedule = false;
    form.touched.command = false;
    dialogError("edit-alert", null);
    setBusyButton($("edit-save"), false, T.saving);
    updateForm(false);
    const tz = jobTz(base.entries, index === null ? base.entries.length : index);
    openDialog($("edit-dlg"), openerKey, { kind: "edit", index, base, line: e ? e.line : null,
                                            capture: info ? info.capture : null, tz }, form.schedule());
    updateForm(false);
}

export async function submitEdit(ev) {
    ev.preventDefault();
    if (!dialog || dialog.kind !== "edit" || state.busy) return;
    form.touched.schedule = true;
    form.touched.command = true;
    const { sched, cmd } = updateForm(true);
    if (!sched.ok) { form.schedule().focus(); return; }
    if (!cmd.ok) { form.command().focus(); return; }
    const d = dialog;
    const user = d.base.user;
    const capture = form.capture().checked && C.canCapture(cmd.text);
    const enabled = form.active().checked;
    dialogError("edit-alert", null);
    setBusyButton($("edit-save"), true, T.saving);
    $("edit-cancel").disabled = true;
    $("edit-close").disabled = true;
    d.locked = true;
    const done = () => {
        d.locked = false;
        setBusyButton($("edit-save"), false, T.saving);
        $("edit-cancel").disabled = false;
        $("edit-close").disabled = false;
    };
    if (capture && !wrapperCurrent()) {
        try {
            await installWrapper();
        } catch (ex) {
            done();
            dialogError("edit-alert", errText(ex), T.wrapperFailed);
            return;
        }
    }
    if (capture && user !== "root" && !(await ensureUserRuns(user))) {
        done();
        return;
    }
    const command = capture
        ? C.wrapCommand(d.capture ? d.capture.id : C.makeJobId(cmd.text, takenIds(d.base.entries)), cmd.text,
                        d.capture ? d.capture.path : undefined)
        : cmd.text;
    const check = C.splitJob(sched.text + " " + command, false);
    if (!check || check.command !== command) {
        done();
        dialogError("edit-alert", T.errLine);
        return;
    }
    const { index, base, line } = d;
    const res = await commit(base, entries => {
        const copy = entries.slice();
        if (index === null) {
            copy.push(C.newJob(sched.text, command, enabled));
        } else {
            const e = jobAt(entries, index, line);
            if (!e) return null;
            copy[index] = C.setJob(e, sched.text, command, enabled);
        }
        return copy;
    }, index === null ? T.okAdded : T.okEdited);
    done();
    if (res.ok && d.capture && !capture) await removeRunsIfUnused(user, d.capture.id);
    if (res.ok || res.conflict) {
        let key = d.openerKey;
        if (res.ok && index === null) {
            const jobs = jobsOf(crontabOf(user));
            if (jobs.length) key = keyOf(user, "edit", jobs[jobs.length - 1].i);
        }
        closeDialog(key);
        if (res.ok) refreshRuns();
    } else if (res.error) {
        dialogError("edit-alert", res.error);
        $("edit-save").focus();
    }
}

/* Delete. A comment right above the job (shown as its note) goes with it, else it
   would stick to the next job. Recorded runs are deleted as well. */
export function openDelete(user, index, openerKey) {
    const base = crontabOf(user);
    if (state.busy || loading || !base || base.status !== "ok" || base.locked) return;
    const e = base.entries[index];
    if (!e || e.kind !== "job") return;
    const info = jobInfo(e);
    const hasNote = noteFor(base, index) !== null;
    const noteIndex = hasNote ? index - 1 : null;
    const noteLine = hasNote ? base.entries[index - 1].line : null;
    $("del-intro").textContent = hasNote ? T.delIntroNote(user) : T.delIntro(user);
    $("del-line").textContent = (hasNote ? noteLine + "\n" : "") + e.schedule + "  " + info.command;
    fill($("del-backup"), rich(T.delBackup(backupDirOf(user) + "/")));
    $("del-runs").hidden = !info.capture;
    fill($("del-runs"), rich(T.delRuns));
    dialogError("del-alert", null);
    setBusyButton($("del-confirm"), false, T.deleting);
    openDialog($("del-dlg"), openerKey, { kind: "delete", index, base, line: e.line, noteIndex, noteLine,
                                           capture: info.capture }, $("del-cancel"));
}

export async function confirmDelete() {
    if (!dialog || dialog.kind !== "delete" || state.busy) return;
    const { index, base, line, noteIndex, noteLine, capture } = dialog;
    dialogError("del-alert", null);
    setBusyButton($("del-confirm"), true, T.deleting);
    $("del-cancel").disabled = true;
    $("del-close").disabled = true;
    const res = await commit(base, entries => {
        if (!jobAt(entries, index, line)) return null;
        if (noteIndex !== null && (!entries[noteIndex] || entries[noteIndex].line !== noteLine)) return null;
        return entries.filter((_, j) => j !== index && j !== noteIndex);
    }, T.okDeleted);
    setBusyButton($("del-confirm"), false, T.deleting);
    $("del-cancel").disabled = false;
    $("del-close").disabled = false;
    if (res.ok && capture) await removeRunsIfUnused(base.user, capture.id);
    if (res.ok) refreshRuns();
    if (res.ok || res.conflict) {
        const user = base.user;
        const jobs = jobsOf(crontabOf(user));
        const first = noteIndex !== null ? noteIndex : index;
        const next = jobs.find(x => x.i >= first) || jobs[jobs.length - 1];
        closeDialog(next ? keyOf(user, "more", next.i) : keyOf(user, "add"));
    } else if (res.error) {
        dialogError("del-alert", res.error);
        $("del-confirm").focus();
    }
}

/* Confirm turning recording off */
export function openCaptureOff(user, index, openerKey) {
    const base = crontabOf(user);
    if (state.busy || loading || !base || base.status !== "ok" || base.locked) return;
    const e = base.entries[index];
    if (!e || e.kind !== "job" || !jobInfo(e).capture) return;
    $("confirm-title").textContent = T.captureOffTitle;
    fill($("confirm-body"), rich(T.captureOffBody));
    $("confirm-ok").textContent = T.captureOff;
    openDialog($("confirm-dlg"), openerKey, {
        kind: "confirm",
        action: () => setCapture(user, index, false, openerKey, base),
    }, $("confirm-cancel"));
}

export function confirmOk() {
    if (!dialog || dialog.kind !== "confirm") return;
    const action = dialog.action;
    closeDialog();
    action();
}
