/* Cron Jobs: converting a job to a systemd timer, and going back to cron.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { $, backupDirOf, C, fill, h, icon, pad2, rich, SD, setBusyButton, state, T } from "./core.js";
import {
    analyzeCalendar, errText, getProp, REMOVE_UNITS_SCRIPT, spawn, SPAWN_ROOT, unitPath, UNITS_SCRIPT,
    WRITE_UNITS_SCRIPT,
} from "./system.js";
import { commit, convertedTo, crontabOf, jobAt, jobInfo, jobTz, loading, requestLoad } from "./crontab.js";
import { describe, showAlert } from "./page.js";
import { closeDialog, dialog, dialogError, openDialog } from "./dialogs.js";

/* ---------- convert to systemd timer ---------- */

/* Why job i of crontab tab cannot be converted, or null. */
export function convertBlocker(tab, i) {
    const e = tab.entries[i];
    if (!e.enabled) return T.convNotActive;
    if (state.basics.flavor === "cronie" && C.envBefore(tab.entries, i).RANDOM_DELAY) return T.convRandomDelay;
    const cal = SD.calendarFromCron(e.schedule);
    if (!cal.ok) return cal.reason === "reboot" ? T.convReboot : T.convInvalid;
    if (C.hasUnescapedPercent(jobInfo(e).command)) return T.convPercent;
    return null;
}

/* A unit name from the command; another user's carries the user's name in front. */
function suggestName(user, command) {
    const name = SD.suggestUnitName(command);
    return user !== "root" && SD.validUnitName(user + "-" + name) ? user + "-" + name : name;
}

/* Convert job index of user's crontab; the timer runs it as that user. */
export function openConvert(user, index, openerKey) {
    const base = crontabOf(user);
    if (state.busy || loading || !base || base.status !== "ok" || base.locked) return;
    const e = base.entries[index];
    if (!e || e.kind !== "job") return;
    const info = jobInfo(e);
    if (convertBlocker(base, index)) return;
    const tz = jobTz(base.entries, index);
    const cal = SD.calendarFromCron(e.schedule, tz !== state.tz ? tz : null);
    const cronEnv = C.envBefore(base.entries, index);
    const jobEnv = C.jobEnvironment(cronEnv, user === "root" ? null : base.home, user, state.basics.cronEnv);
    const { env, unset } = SD.serviceEnvironment(jobEnv, cronEnv, state.basics.managerEnv, user);
    const taken = new Set(state.timers.list.map(t => t.name.replace(/\.timer$/, "")));
    let name = suggestName(user, info.command);
    for (let n = 2; taken.has(name); n++) name = suggestName(user, info.command) + "-" + n;
    $("conv-intro").textContent = T.convIntro(user);
    $("conv-after").textContent = T.convAfter(user);
    $("conv-name").value = name;
    $("conv-persistent").checked = false;
    $("conv-cron").textContent = e.schedule;
    fill($("conv-cal"), cal.specs.map(s => h("span", { class: "cron-conv-spec" }, "OnCalendar=" + s)));
    $("conv-units").hidden = true;
    $("conv-units-toggle").setAttribute("aria-expanded", "false");
    dialogError("conv-alert", null);
    setBusyButton($("conv-ok"), false, T.converting);
    $("conv-cancel").disabled = false;
    $("conv-close").disabled = false;
    openDialog($("conv-dlg"), openerKey, {
        kind: "convert", user, index, base, line: e.line, schedule: e.schedule, specs: cal.specs,
        command: C.cronCommand(info.command).command, shell: env.SHELL || "/bin/sh", env, unset, tz,
        workdir: cronEnv.HOME || null, verified: null, nameTouched: false,
    }, $("conv-name"));
    updateConvert();
    verifyConvert(dialog);
}

function convertUnits(d) {
    const name = $("conv-name").value.trim();
    return {
        name,
        service: SD.serviceUnit({ name, user: d.user, line: d.line, shell: d.shell, command: d.command, env: d.env,
                                  unset: d.unset, workdir: d.workdir }),
        timer: SD.timerUnit({ name, user: d.user, specs: d.specs, persistent: $("conv-persistent").checked }),
    };
}

/* The name's error shows once the field was left or on converting (like Save in the
   edit dialog); until then the help names no unit. */
export function updateConvert() {
    const d = dialog;
    if (!d || d.kind !== "convert") return;
    const u = convertUnits(d);
    const valid = SD.validUnitName(u.name);
    const showError = !valid && d.nameTouched;
    const input = $("conv-name");
    input.setAttribute("aria-invalid", showError ? "true" : "false");
    const help = $("conv-name-help");
    help.className = showError ? "az-field__error" : "az-field__help";
    if (showError) fill(help, icon("exclamation-circle"), h("span", null, T.convNameInvalid));
    else fill(help, rich(T.convNameHelp(valid ? u.name : "…")));
    $("conv-service").textContent = "# " + (valid ? u.name : "…") + ".service\n" + u.service;
    $("conv-timer").textContent = "# " + (valid ? u.name : "…") + ".timer\n" + u.timer;
    const v = d.verified;
    const check = $("conv-check");
    check.className = "az-field__help cron-check" + (v && !v.ok ? " is-bad" : "") + (v && v.ok ? " is-good" : "");
    if (v === null) fill(check, T.convChecking);
    else if (v.ok) fill(check, icon("check-circle"), h("span", null, T.convChecked(describe(d.schedule), v.count)));
    else fill(check, icon("exclamation-circle"), h("span", null, v.error ? T.convCheckFailed(v.error) : T.convMismatch));
    $("conv-ok").disabled = state.busy || !v || !v.ok;
}

/* The name field was left: from now on its error shows. */
export function touchConvertName() {
    const d = dialog;
    if (!d || d.kind !== "convert" || d.nameTouched) return;
    d.nameTouched = true;
    updateConvert();
}

/* The next runs must be the same under systemd as under cron. Ours are computed up to
   the last run systemd lists, however far ahead that is (a yearly job, the 29th of
   February), so that rare schedules are checked as fully as frequent ones. */
async function verifyConvert(d) {
    let res;
    try {
        const t0 = Date.now() - 60000;
        const iter = await analyzeCalendar(d.specs, 5);
        const theirs = Array.from(new Set([].concat(...d.specs.map(s => iter[s] || [])))).sort((a, b) => a - b).slice(0, 5);
        const ours = theirs.length ? C.runsBetween(d.schedule, t0, theirs[theirs.length - 1], d.tz, theirs.length + 2) : [];
        res = SD.sameRuns(theirs, ours) ? { ok: true, count: theirs.length } : { ok: false };
    } catch (ex) {
        res = { ok: false, error: errText(ex) };
    }
    if (dialog !== d) return;
    d.verified = res;
    updateConvert();
}

/* What systemd made of User=, ExecStart=, Environment= and UnsetEnvironment= must be what we meant. */
async function verifyUnit(name, user, shell, command, env, unset) {
    const path = await unitPath(name + ".service");
    const [runAs, exec, environment, unsetEnv] = await Promise.all([
        getProp(path, "org.freedesktop.systemd1.Service", "User"),
        getProp(path, "org.freedesktop.systemd1.Service", "ExecStart"),
        getProp(path, "org.freedesktop.systemd1.Service", "Environment"),
        unset.length ? getProp(path, "org.freedesktop.systemd1.Service", "UnsetEnvironment") : [],
    ]);
    if (runAs !== user) return false;
    if (!unset.every(k => (unsetEnv || []).includes(k))) return false;
    /* systemd keeps "$$" in the stored command line and turns it into "$" when it
       starts the service; either form means what we wrote. */
    const argv = exec && exec[0] ? exec[0][1] : null;
    const want = SD.expectedArgv(shell, command);
    const same = (a, b) => a === b || a === b.replace(/\$/g, "$$$$");
    if (!argv || argv.length !== want.length || argv.some((a, k) => !same(a, want[k]))) return false;
    const have = new Set(environment || []);
    return Object.keys(env).every(k => have.has(k + "=" + env[k]));
}

function convertNote(name) {
    const w = C.wallParts(Date.now(), state.tz);
    return SD.convertNote(name, w.y + "-" + pad2(w.mo) + "-" + pad2(w.d));
}

export async function submitConvert(ev) {
    ev.preventDefault();
    const d = dialog;
    if (!d || d.kind !== "convert" || state.busy) return;
    const u = convertUnits(d);
    if (!SD.validUnitName(u.name)) {
        d.nameTouched = true;
        updateConvert();
        $("conv-name").focus();
        return;
    }
    if (!d.verified || !d.verified.ok) return;
    dialogError("conv-alert", null);
    setBusyButton($("conv-ok"), true, T.converting);
    $("conv-cancel").disabled = true;
    $("conv-close").disabled = true;
    d.locked = true;
    const done = () => {
        d.locked = false;
        setBusyButton($("conv-ok"), false, T.converting);
        $("conv-cancel").disabled = false;
        $("conv-close").disabled = false;
        updateConvert();
    };
    const fail = async (message, written) => {
        if (written) await spawn(["sh", "-c", REMOVE_UNITS_SCRIPT, "cockpit-cronjobs", u.name], SPAWN_ROOT).catch(() => {});
        done();
        dialogError("conv-alert", message, T.convFailed);
    };

    try {
        await spawn(["sh", "-c", WRITE_UNITS_SCRIPT, "cockpit-cronjobs", u.name, u.service, u.timer], SPAWN_ROOT);
    } catch (ex) {
        if (ex && ex.exit_status === 6) { await fail(T.convNameTaken(u.name), false); $("conv-name").focus(); return; }
        await fail(errText(ex), true);
        return;
    }
    let good = false;
    try { good = await verifyUnit(u.name, d.user, d.shell, d.command, d.env, d.unset || []); } catch (_) { good = false; }
    if (!good) { await fail(T.convUnitMismatch, true); return; }

    /* Switching the cron line off and starting the timer happen in one root step
       (SAVE_SCRIPT); if the timer cannot start, the script puts the crontab back. */
    const note = convertNote(u.name);
    const res = await commit(d.base, entries => {
        const cur = jobAt(entries, d.index, d.line);
        if (!cur) return null;
        const copy = entries.slice();
        copy[d.index] = C.setEnabled(cur, false);
        copy.splice(d.index, 0, C.rawLine(note));
        return copy;
    }, null, { quiet: true, timer: u.name + ".timer" });
    if (!res.ok) {
        await fail((res.error || T.conflictBody(d.user)) + (res.timerFailed ? "\n" + T.convRolledBack : ""), true);
        if (res.timerFailed) requestLoad();
        return;
    }
    d.locked = false;
    closeDialog(d.openerKey, true);
    showAlert("success", T.okConverted(u.name), [rich(T.okConvertedBody), " ", rich(res.saved)]);
    requestLoad();
}

export function toggleUnits() {
    const btn = $("conv-units-toggle");
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    $("conv-units").hidden = !open;
    fill(btn, icon(open ? "angle-down" : "angle-right"), open ? T.convHideUnits : T.convShowUnits);
}

/* ---------- back to cron ---------- */

/* Checks (or removes) the units of a conversion from user's crontab (UNITS_SCRIPT). */
function unitsStep(step, name, user) {
    return spawn(["sh", "-c", UNITS_SCRIPT, "cockpit-cronjobs", step, name, user], SPAWN_ROOT);
}

/* Shows what going back does for job index of user's crontab, after checking the units:
   ours, missing (only the line goes back on) or foreign (nothing is done). Units count
   as ours only when they were converted from this crontab. */
export function openBack(user, index, openerKey) {
    const base = crontabOf(user);
    if (state.busy || loading || !base || base.status !== "ok" || base.locked) return;
    const name = convertedTo(base, index);
    if (!name) return;
    const e = base.entries[index];
    $("back-line-intro").textContent = T.backLineIntro(user);
    $("back-line").textContent = e.schedule + "  " + jobInfo(e).command;
    fill($("back-units"), rich(T.backUnits(name)));
    fill($("back-backup"), rich(T.delBackup(backupDirOf(user) + "/")));
    dialogError("back-alert", null);
    setBusyButton($("back-ok"), false, T.backing);
    openDialog($("back-dlg"), openerKey, {
        kind: "back", user, index, base, line: e.line, noteLine: base.entries[index - 1].line, name, units: null, why: "",
    }, $("back-cancel"));
    renderBack();
    unitsStep("check", name, user).then(() => "ours", ex => {
        if (ex && ex.exit_status === 9) return "missing";
        if (ex && ex.exit_status === 8) return "foreign";
        if (dialog && dialog.kind === "back") dialog.why = errText(ex);
        return "error";
    }).then(units => {
        if (!dialog || dialog.kind !== "back" || dialog.name !== name) return;
        dialog.units = units;
        renderBack();
    });
}

function renderBack() {
    const d = dialog;
    if (!d || d.kind !== "back") return;
    const check = $("back-check");
    const good = d.units === "ours" || d.units === "missing";
    check.className = "az-field__help cron-check" + (d.units && !good ? " is-bad" : "") + (d.units === "ours" ? " is-good" : "");
    if (d.units === null) fill(check, T.backChecking);
    else if (d.units === "ours") fill(check, icon("check-circle"), h("span", null, T.backUnitsOk));
    else if (d.units === "missing") fill(check, icon("info-circle"), h("span", null, rich(T.backUnitsMissing(d.name))));
    else if (d.units === "foreign") fill(check, icon("exclamation-circle"), h("span", null, rich(T.backUnitsForeign(d.name))));
    else fill(check, icon("exclamation-circle"), h("span", null, T.backCheckFailed(d.why)));
    $("back-units").hidden = d.units === "missing";
    $("back-ok").disabled = state.busy || !!d.locked || !good;
}

/* Switching the line back on, removing the note and stopping the timer are one
   root step (SAVE_SCRIPT): if the timer cannot be stopped, the crontab is put
   back. The unit files are removed afterwards, after another check. */
export async function submitBack() {
    const d = dialog;
    if (!d || d.kind !== "back" || state.busy || d.locked) return;
    if (d.units !== "ours" && d.units !== "missing") return;
    dialogError("back-alert", null);
    setBusyButton($("back-ok"), true, T.backing);
    $("back-cancel").disabled = true;
    $("back-close").disabled = true;
    d.locked = true;
    const done = () => {
        d.locked = false;
        setBusyButton($("back-ok"), false, T.backing);
        $("back-cancel").disabled = false;
        $("back-close").disabled = false;
        renderBack();
    };
    const res = await commit(d.base, entries => {
        const cur = jobAt(entries, d.index, d.line);
        const note = entries[d.index - 1];
        if (!cur || !note || note.line !== d.noteLine) return null;
        const copy = entries.slice();
        copy[d.index] = C.setEnabled(cur, true);
        copy.splice(d.index - 1, 1);
        return copy;
    }, null, { quiet: true, timer: d.units === "ours" ? d.name + ".timer" : null, stopTimer: true });
    if (!res.ok) {
        done();
        dialogError("back-alert", (res.error || T.conflictBody(d.user)) + (res.timerFailed ? "\n" + T.backRolledBack : ""), T.backFailed);
        if (res.timerFailed) requestLoad();
        return;
    }
    let left = null;
    if (d.units === "ours") {
        try {
            await unitsStep("remove", d.name, d.user);
        } catch (ex) {
            left = ex && ex.exit_status === 8 ? T.backUnitsChanged : errText(ex);
        }
    }
    d.locked = false;
    closeDialog(d.openerKey, true);
    if (left) showAlert("warning", T.okBackUnitsLeft(d.name), [left, " ", rich(res.saved)]);
    else showAlert("success", T.okBack, [d.units === "ours" ? [rich(T.okBackBody(d.name)), " "] : null, rich(res.saved)]);
    requestLoad();
}
