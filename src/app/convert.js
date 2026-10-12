/* Cron Jobs: converting a job to a systemd timer, and going back to cron.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { $, BACKUP_DIR, C, DAY, fill, h, icon, pad2, rich, SD, setBusyButton, state, T } from "./core.js";
import {
    analyzeCalendar, errText, getProp, REMOVE_UNITS_SCRIPT, spawn, SPAWN_ROOT, unitPath, UNITS_SCRIPT,
    WRITE_UNITS_SCRIPT,
} from "./system.js";
import { commit, convertedTo, jobAt, jobInfo, jobTz, loading, requestLoad } from "./crontab.js";
import { describe, showAlert } from "./page.js";
import { closeDialog, dialog, dialogError, openDialog } from "./dialogs.js";

/* ---------- convert to systemd timer ---------- */

export function convertBlocker(e, info, i) {
    if (!e.enabled) return T.convNotActive;
    if (state.basics.flavor === "cronie" && C.envBefore(state.root.entries, i).RANDOM_DELAY) return T.convRandomDelay;
    const cal = SD.calendarFromCron(e.schedule);
    if (!cal.ok) return cal.reason === "reboot" ? T.convReboot : T.convInvalid;
    if (C.hasUnescapedPercent(info.command)) return T.convPercent;
    return null;
}

export function openConvert(index, openerKey) {
    if (state.busy || loading || state.root.status !== "ok" || state.root.locked) return;
    const base = state.root;
    const e = base.entries[index];
    if (!e || e.kind !== "job") return;
    const info = jobInfo(e);
    if (convertBlocker(e, info, index)) return;
    const tz = jobTz(base.entries, index);
    const cal = SD.calendarFromCron(e.schedule, tz !== state.tz ? tz : null);
    const cronEnv = C.envBefore(base.entries, index);
    const env = SD.serviceEnvironment(cronEnv);
    const taken = new Set(state.timers.list.map(t => t.name.replace(/\.timer$/, "")));
    let name = SD.suggestUnitName(info.command);
    for (let n = 2; taken.has(name); n++) name = SD.suggestUnitName(info.command) + "-" + n;
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
        kind: "convert", index, base, line: e.line, schedule: e.schedule, specs: cal.specs,
        command: C.cronCommand(info.command).command, shell: env.SHELL || "/bin/sh", env, tz,
        workdir: cronEnv.HOME || null, verified: null,
    }, $("conv-name"));
    updateConvert();
    verifyConvert(dialog);
}

function convertUnits(d) {
    const name = $("conv-name").value.trim();
    return {
        name,
        service: SD.serviceUnit({ name, line: d.line, shell: d.shell, command: d.command, env: d.env,
                                  workdir: d.workdir }),
        timer: SD.timerUnit({ name, specs: d.specs, persistent: $("conv-persistent").checked }),
    };
}

export function updateConvert() {
    const d = dialog;
    if (!d || d.kind !== "convert") return;
    const u = convertUnits(d);
    const valid = SD.validUnitName(u.name);
    const input = $("conv-name");
    input.setAttribute("aria-invalid", valid ? "false" : "true");
    const help = $("conv-name-help");
    help.className = valid ? "az-field__help" : "az-field__error";
    if (valid) fill(help, rich(T.convNameHelp(u.name)));
    else fill(help, icon("exclamation-circle"), h("span", null, T.convNameInvalid));
    $("conv-service").textContent = "# " + (valid ? u.name : "…") + ".service\n" + u.service;
    $("conv-timer").textContent = "# " + (valid ? u.name : "…") + ".timer\n" + u.timer;
    const v = d.verified;
    const check = $("conv-check");
    check.className = "az-field__help cron-check" + (v && !v.ok ? " is-bad" : "") + (v && v.ok ? " is-good" : "");
    if (v === null) fill(check, T.convChecking);
    else if (v.ok) fill(check, icon("check-circle"), h("span", null, T.convChecked(describe(d.schedule), v.count)));
    else fill(check, icon("exclamation-circle"), h("span", null, v.error ? T.convCheckFailed(v.error) : T.convMismatch));
    $("conv-ok").disabled = state.busy || !valid || !v || !v.ok;
}

/* The next runs must be the same under systemd as under cron. */
async function verifyConvert(d) {
    let res;
    try {
        const t0 = Date.now() - 60000;
        const iter = await analyzeCalendar(d.specs, 5);
        const theirs = Array.from(new Set([].concat(...d.specs.map(s => iter[s] || [])))).sort((a, b) => a - b).slice(0, 5);
        const ours = C.runsBetween(d.schedule, t0, t0 + 800 * DAY, d.tz, 7);
        const k = ours.indexOf(theirs[0]);
        const ok = theirs.length > 0 && k >= 0 && k <= 1 && theirs.every((t, n) => t === ours[k + n]);
        res = ok ? { ok: true, count: theirs.length } : { ok: false };
    } catch (ex) {
        res = { ok: false, error: errText(ex) };
    }
    if (dialog !== d) return;
    d.verified = res;
    updateConvert();
}

/* What systemd made of ExecStart= and Environment= must be what we meant. */
async function verifyUnit(name, shell, command, env) {
    const path = await unitPath(name + ".service");
    const [exec, environment] = await Promise.all([
        getProp(path, "org.freedesktop.systemd1.Service", "ExecStart"),
        getProp(path, "org.freedesktop.systemd1.Service", "Environment"),
    ]);
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
    if (!SD.validUnitName(u.name)) { $("conv-name").focus(); return; }
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
    try { good = await verifyUnit(u.name, d.shell, d.command, d.env); } catch (_) { good = false; }
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
        await fail((res.error || T.conflictBody) + (res.timerFailed ? "\n" + T.convRolledBack : ""), true);
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

function unitsStep(step, name) {
    return spawn(["sh", "-c", UNITS_SCRIPT, "cockpit-cronjobs", step, name], SPAWN_ROOT);
}

/* Shows what going back does, after checking the units: ours, missing (only the
   line goes back on) or foreign (nothing is done). */
export function openBack(index, openerKey) {
    if (state.busy || loading || state.root.status !== "ok" || state.root.locked) return;
    const base = state.root;
    const name = convertedTo(base, index);
    if (!name) return;
    const e = base.entries[index];
    $("back-line").textContent = e.schedule + "  " + jobInfo(e).command;
    fill($("back-units"), rich(T.backUnits(name)));
    fill($("back-backup"), rich(T.delBackup(BACKUP_DIR + "/")));
    dialogError("back-alert", null);
    setBusyButton($("back-ok"), false, T.backing);
    openDialog($("back-dlg"), openerKey, {
        kind: "back", index, base, line: e.line, noteLine: base.entries[index - 1].line, name, units: null, why: "",
    }, $("back-cancel"));
    renderBack();
    unitsStep("check", name).then(() => "ours", ex => {
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
        dialogError("back-alert", (res.error || T.conflictBody) + (res.timerFailed ? "\n" + T.backRolledBack : ""), T.backFailed);
        if (res.timerFailed) requestLoad();
        return;
    }
    let left = null;
    if (d.units === "ours") {
        try {
            await unitsStep("remove", d.name);
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
