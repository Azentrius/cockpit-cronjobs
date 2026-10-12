/* Cron Jobs: the tabs under the page header (WAI-ARIA tabs pattern): Overview,
 * systemd timers, System. Switching only shows another panel; it loads nothing and
 * does not change the address, and a reload keeps the tab that is shown.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { $ } from "./core.js";

const tabs = () => Array.from($("tabs").querySelectorAll('[role="tab"]'));

/* Shows the panel of a tab; focus: move the focus to the tab as well (keyboard). */
export function selectTab(tab, focus) {
    tabs().forEach(t => {
        const on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        if (on) t.removeAttribute("tabindex");
        else t.setAttribute("tabindex", "-1");
        $(t.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) tab.focus();
}

/* Before focusing something in a panel that is not shown: switch to its tab. */
export function showTabOf(el) {
    const panel = el && el.closest('[role="tabpanel"]');
    if (panel && panel.hidden) selectTab($(panel.getAttribute("aria-labelledby")), false);
}

/* Hidden, other than by a panel that is not shown (showTabOf can show that). */
export function hiddenBesidesTabs(el) {
    const hidden = el.closest("[hidden]");
    if (!hidden) return false;
    if (hidden.getAttribute("role") !== "tabpanel") return true;
    return !!(hidden.parentElement && hidden.parentElement.closest("[hidden]"));
}

/* Click; arrow keys move between the tabs and show them, Home and End go to the first
   and the last; only the tab shown can be reached with Tab. */
export function initTabs() {
    tabs().forEach(t => t.addEventListener("click", () => selectTab(t, false)));
    $("tabs").addEventListener("keydown", ev => {
        const all = tabs();
        const k = all.indexOf(document.activeElement);
        if (k < 0) return;
        let next = null;
        if (ev.key === "ArrowRight") next = all[(k + 1) % all.length];
        else if (ev.key === "ArrowLeft") next = all[(k - 1 + all.length) % all.length];
        else if (ev.key === "Home") next = all[0];
        else if (ev.key === "End") next = all[all.length - 1];
        if (!next) return;
        ev.preventDefault();
        selectTab(next, true);
    });
}
