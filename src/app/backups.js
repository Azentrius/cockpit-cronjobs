/* Cron Jobs: backups of a crontab: the list, what restoring one would change
 * (line by line, as diff shows it), and restoring it through the same locked step as
 * every other change, which first saves the current version, so that a restore can be
 * undone the same way.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { $, B, backupDirOf, cap, fill, fmtWhen, h, icon, KEEP_BACKUPS, rich, state, T } from "./core.js";
import { errText, isDenied, readBackups } from "./system.js";
import { crontabOf, loading, restoreCrontab } from "./crontab.js";
import { showAlert } from "./page.js";
import { closeDialog, dialog, dialogError, openDialog } from "./dialogs.js";

/* Unchanged lines shown around a change. */
const CONTEXT = 3;

/* The backups of user's crontab. */
export function openBackups(user, openerKey) {
    const base = crontabOf(user);
    if (state.busy || loading || !base || base.status !== "ok") return;
    dialogError("bk-alert", null);
    $("bk-title").textContent = T.backupsTitle(user);
    $("bk-intro").textContent = T.backupsIntro(user);
    openDialog($("bk-dlg"), openerKey, { kind: "backups", base, list: null, error: null, open: null, diffs: {} },
               $("bk-close-btn"));
    const d = dialog;
    renderBackups();
    readBackups(user).then(list => { d.list = list; }, ex => {
        d.error = isDenied(ex) ? T.deniedTitle : ex && ex.exit_status === 4 ? T.lockBusy : errText(ex);
    }).finally(() => { if (dialog === d) renderBackups(); });
}

/* What restoring b would change in the crontab shown: [{ op, line }], or null when b
   is not UTF-8. */
function diffOf(d, b) {
    if (b.text === null) return null;
    if (!d.diffs[b.name]) d.diffs[b.name] = B.diff(d.base.text, b.text);
    return d.diffs[b.name];
}

function renderBackups() {
    const d = dialog;
    if (!d || d.kind !== "backups") return;
    fill($("bk-note"), rich(T.backupsNote(KEEP_BACKUPS, backupDirOf(d.base.user) + "/")));
    const body = $("bk-body");
    const focusedKey = document.activeElement && body.contains(document.activeElement)
        ? document.activeElement.dataset.key : null;
    if (d.error !== null) {
        fill(body);
        dialogError("bk-alert", d.error, T.backupsReadError);
        return;
    }
    if (!d.list) {
        fill(body, h("p", { class: "cron-state" }, T.loading));
        return;
    }
    if (!d.list.length) {
        fill(body, h("p", { class: "cron-state" }, T.backupsNone));
        return;
    }
    const rows = [];
    d.list.forEach((b, k) => {
        const ops = diffOf(d, b);
        const n = ops ? B.counts(ops) : null;
        const isOpen = d.open === b.name;
        const detailId = "bk-detail-" + k;
        rows.push(h("tr", { class: isOpen ? "is-open" : null },
            h("td", { "data-label": T.colSaved },
                h("div", { class: "cron-cell" },
                    h("span", null, cap(fmtWhen(b.mtime))),
                    h("span", { class: "az-cell-sub az-mono" }, b.name))),
            h("td", { "data-label": T.colRestoring }, changeCell(n)),
            h("td", { class: "az-cell-actions" }, ops
                ? h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "data-key": "bk:" + b.name,
                                "aria-expanded": isOpen ? "true" : "false", "aria-controls": isOpen ? detailId : null,
                                "aria-label": isOpen ? T.hideChanges : T.showChanges, title: isOpen ? T.hideChanges : T.showChanges,
                                onclick: () => toggleBackup(b.name) }, icon(isOpen ? "angle-down" : "angle-right"))
                : h("span", { class: "cron-muted" }, "—"))));
        if (isOpen) rows.push(h("tr", { class: "is-open cron-runs-output" }, h("td", { colspan: "3" }, detail(d, b, ops, n, detailId))));
    });
    fill(body, h("div", { class: "cron-runs-table" },
        h("table", { class: "az-table az-table--stack" },
            h("thead", null, h("tr", null,
                h("th", { scope: "col" }, T.colSaved),
                h("th", { scope: "col" }, T.colRestoring),
                h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.showChanges)))),
            h("tbody", null, rows))));
    if (focusedKey) {
        const el = body.querySelector('[data-key="' + focusedKey + '"]');
        if (el && !el.disabled) el.focus();
    }
}

function changeCell(n) {
    if (!n) return h("span", { class: "cron-muted" }, T.backupEncoding);
    if (n.removed + n.added === 0) return h("span", { class: "cron-muted" }, T.backupSame);
    return h("span", null, T.backupDelta(n.removed, n.added));
}

/* What restoring would change, and the button that does it. */
function detail(d, b, ops, n, id) {
    const same = n.removed + n.added === 0;
    const user = d.base.user;
    const blocked = d.base.notUtf8;
    return h("div", { class: "cron-bk-detail", id },
        same ? h("p", { class: "cron-muted" }, T.backupSameBody(user))
            : [h("p", null, rich(T.diffIntro(user))), diffView(ops)],
        blocked ? h("p", { class: "cron-muted cron-small" }, T.restoreEncoding(user)) : null,
        h("div", { class: "cron-copy-row" },
            h("button", { class: "az-btn az-btn--primary az-btn--sm", type: "button", "data-key": "restore:" + b.name,
                          "aria-busy": d.locked === b.name ? "true" : "false",
                          disabled: same || blocked || !!d.locked || state.busy, onclick: () => restore(b.name) },
              icon("history"), d.locked === b.name ? T.restoring : T.restore)));
}

/* The lines of the difference; unchanged stretches longer than the context are
   folded, each line says whether it goes or comes back. */
function diffView(ops) {
    return h("div", { class: "cron-diff az-mono", role: "group", tabindex: "0", "aria-label": T.diffLabel },
        B.hunks(ops, CONTEXT).map(o => o.op === "skip"
            ? h("div", { class: "cron-diff__skip" }, T.diffSkip(o.count))
            : h("div", { class: "cron-diff__line" + (o.op === "-" ? " is-del" : o.op === "+" ? " is-add" : ""), "data-op": o.op },
                h("span", { class: "cron-diff__mark", "aria-hidden": "true" }, o.op),
                o.op === " " ? null : h("span", { class: "az-sr" }, o.op === "-" ? T.diffRemoved : T.diffAdded),
                h("span", { class: "cron-diff__text" }, o.line.replace(/\n$/, "")),
                o.line.endsWith("\n") ? null : h("span", { class: "cron-diff__note" }, T.diffNoNewline))));
}

function toggleBackup(name) {
    const d = dialog;
    if (!d || d.kind !== "backups" || d.locked) return;
    d.open = d.open === name ? null : name;
    renderBackups();
}

/* Writes the backup as the root crontab; the root step saves the current version
   first. Closes the dialog when done, also when the crontab changed meanwhile (the
   page says so and shows the new state). */
async function restore(name) {
    const d = dialog;
    if (!d || d.kind !== "backups" || d.locked || state.busy || !d.list) return;
    const b = d.list.find(x => x.name === name);
    if (!b || b.text === null) return;
    const when = fmtWhen(b.mtime);
    const closers = [$("bk-close"), $("bk-close-btn")];
    d.locked = name;
    dialogError("bk-alert", null);
    closers.forEach(x => { x.disabled = true; });
    renderBackups();
    const res = await restoreCrontab(d.base, b.text, T.okRestored(when), { quiet: true });
    d.locked = false;
    closers.forEach(x => { x.disabled = false; });
    if (res.ok || res.conflict) {
        closeDialog(d.openerKey, true);
        if (res.ok && res.verified) showAlert("success", T.okRestored(when), [rich(res.saved), " ", T.restoredUndo]);
        return;
    }
    renderBackups();
    dialogError("bk-alert", res.error, T.restoreFailed);
    $("bk-close-btn").focus();
}
