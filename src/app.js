/* Cron Jobs: Cockpit page.
 *
 * Root's crontab, and with administrative access those of the other users, are read
 * and written through `crontab -u USER`. Saving happens in one locked step
 * (SAVE_SCRIPT): only if the crontab is still the one shown (cksum), with a backup
 * first; afterwards it is read back and compared. Lines that are not changed stay byte
 * for byte (see lib/cron.js).
 *
 * /etc/crontab, /etc/cron.d, run-parts directories and systemd timers are shown
 * read-only. Root's jobs can record their runs (cockpit-cronjobs-run), be started
 * right away, and be converted into systemd timers.
 *
 * This file starts the page; its parts are ES modules in app/ (no build step, and
 * Cockpit's CSP allows them):
 *   core.js      libraries, constants, texts, DOM helpers, times, the page's state
 *   system.js    everything that runs on the server: every root script, D-Bus
 *   crontab.js   the root crontab as shown: loading, saving, administrative access
 *   page.js      alerts, the tables, the row menu, focus
 *   timeline.js  the next 24 hours
 *   dialogs.js   dialogs in general; add, edit, delete, confirm
 *   runs.js      run now, recorded runs, leftover runs
 *   convert.js   convert to a systemd timer and back to cron
 *   backups.js   backups of a crontab: what restoring one changes, restoring
 *   tabs.js      the tabs under the page header
 * The libraries in lib/ and the texts in i18n/ stay plain scripts (window.Cron*),
 * so that the unit tests can load them in Node.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { $, fill, icon, rich, state, T } from "./app/core.js";
import { crontabOf, jobAt, loading, refreshRuns, requestLoad, watchSuperuser } from "./app/crontab.js";
import { clearAlerts, updateNextRuns } from "./app/page.js";
import {
    closeDialog, confirmDelete, confirmOk, dialog, form, openCaptureOff, openEdit, submitEdit, updateForm,
} from "./app/dialogs.js";
import { orphanList, removeOrphanRuns, startRun, stopRun } from "./app/runs.js";
import { submitBack, submitConvert, toggleUnits, updateConvert } from "./app/convert.js";
import { openBackups } from "./app/backups.js";
import { initTabs } from "./app/tabs.js";

const VERSION = "2.3.0";

/* ---------- start ---------- */

function translateStatic() {
    document.querySelectorAll("[data-t]").forEach(el => {
        const v = T[el.dataset.t];
        if (v !== undefined) fill(el, rich(v));
    });
    document.querySelectorAll("[data-t-label]").forEach(el => el.setAttribute("aria-label", T[el.dataset.tLabel]));
    document.querySelectorAll("[data-icon]").forEach(el => el.replaceWith(icon(el.dataset.icon)));
    $("sig-version").textContent = "Cron Jobs " + VERSION;
}

function init() {
    translateStatic();
    initTabs();

    $("reload").addEventListener("click", () => { clearAlerts(); requestLoad(); });
    $("add").addEventListener("click", () => openEdit("root", null, "add"));
    $("backups").addEventListener("click", () => openBackups("root", "backups"));

    $("edit-form").addEventListener("submit", submitEdit);
    $("edit-cancel").addEventListener("click", () => closeDialog());
    $("edit-close").addEventListener("click", () => closeDialog());
    form.schedule().addEventListener("input", () => updateForm(false));
    form.command().addEventListener("input", () => updateForm(false));
    form.capture().addEventListener("change", () => updateForm(false));
    form.schedule().addEventListener("blur", () => { form.touched.schedule = true; updateForm(false); });
    form.command().addEventListener("blur", () => { form.touched.command = true; updateForm(false); });

    $("del-confirm").addEventListener("click", confirmDelete);
    $("del-cancel").addEventListener("click", () => closeDialog());
    $("del-close").addEventListener("click", () => closeDialog());

    $("confirm-ok").addEventListener("click", confirmOk);
    $("confirm-cancel").addEventListener("click", () => closeDialog());
    $("confirm-close").addEventListener("click", () => closeDialog());

    $("run-start").addEventListener("click", startRun);
    $("run-again").addEventListener("click", startRun);
    $("run-stop").addEventListener("click", stopRun);
    $("run-cancel").addEventListener("click", () => closeDialog());
    $("run-close").addEventListener("click", () => closeDialog());
    $("run-close-btn").addEventListener("click", () => closeDialog());

    $("runs-close").addEventListener("click", () => closeDialog());
    $("runs-close-btn").addEventListener("click", () => closeDialog());
    $("runs-capture-off").addEventListener("click", () => {
        const d = dialog;
        if (!d || d.kind !== "runs") return;
        const tab = crontabOf(d.user);
        if (!tab || tab.status !== "ok" || !jobAt(tab.entries, d.index, d.line)) { closeDialog(); return; }
        const key = d.openerKey;
        closeDialog();
        openCaptureOff(d.user, d.index, key);
    });

    $("orph-all").addEventListener("click", () => removeOrphanRuns(orphanList().map(o => o.id)));
    $("orph-close").addEventListener("click", () => closeDialog());
    $("orph-close-btn").addEventListener("click", () => closeDialog());

    $("conv-form").addEventListener("submit", submitConvert);
    $("conv-cancel").addEventListener("click", () => closeDialog());
    $("conv-close").addEventListener("click", () => closeDialog());
    $("conv-name").addEventListener("input", updateConvert);
    $("conv-persistent").addEventListener("change", updateConvert);
    $("conv-units-toggle").addEventListener("click", toggleUnits);

    $("bk-close").addEventListener("click", () => closeDialog());
    $("bk-close-btn").addEventListener("click", () => closeDialog());

    $("back-ok").addEventListener("click", submitBack);
    $("back-cancel").addEventListener("click", () => closeDialog());
    $("back-close").addEventListener("click", () => closeDialog());

    const onVisible = () => {
        const hidden = cockpit.hidden !== undefined ? cockpit.hidden : document.hidden;
        if (hidden || dialog || state.busy) return;
        if (Date.now() - state.loadedAt > 60000) requestLoad();
        else refreshRuns();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (typeof cockpit.addEventListener === "function") cockpit.addEventListener("visibilitychange", onVisible);

    window.setInterval(() => {
        updateNextRuns();
        const hidden = cockpit.hidden !== undefined ? cockpit.hidden : document.hidden;
        if (!hidden && !state.busy && !loading) refreshRuns();
    }, 30000);

    watchSuperuser().then(() => requestLoad());
}

init();
