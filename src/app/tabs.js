/* Cron Jobs: the tabs under the page header (WAI-ARIA tabs pattern): Overview,
 * systemd timers, System. Switching only shows another panel and loads nothing; a tab
 * chosen on the page goes into the address, and a reload keeps the tab that is shown.
 * The address also leads to a place on the page (the Status Board's links, see "places").
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { $, state } from "./core.js";

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

/* A tab chosen on the page: shown, and into the address unless the address names it already,
   so that a later link to the place shown before is a change of the address again. */
function chooseTab(tab, focus) {
    selectTab(tab, focus);
    const name = tab.id.replace(/^tab-/, "");
    if (locationPath()[0] !== name && cockpit.location && typeof cockpit.location.go === "function")
        cockpit.location.go([name]);
}

/* Before focusing something in a panel that is not shown: switch to its tab. */
export function showTabOf(el) {
    const panel = el && el.closest('[role="tabpanel"]');
    if (panel && panel.hidden) chooseTab($(panel.getAttribute("aria-labelledby")), false);
}

/* Hidden, other than by a panel that is not shown (showTabOf can show that). */
export function hiddenBesidesTabs(el) {
    const hidden = el.closest("[hidden]");
    if (!hidden) return false;
    if (hidden.getAttribute("role") !== "tabpanel") return true;
    return !!(hidden.parentElement && hidden.parentElement.closest("[hidden]"));
}

/* ---------- places: where the Status Board's links lead ---------- */

/* The status (status/cronjobs-status, link()) links each item to a place on this page: a
   tab, then a part of it, by the element to scroll to.
     #/overview/results   the latest results, failures first   (failed)
     #/overview/crontab   the root crontab, the other users' after it   (unrecorded)
     #/overview/notices   the notices, such as "cron is not running"   (cron)
   and #/overview/next, #/system/users and every tab by its name. Cockpit keeps a loaded page
   and, when the board jumps to it again, only changes its address (locationchanged). So every
   address shows its tab at once and scrolls to its part once, when the page has loaded and is
   shown. No place: the first tab; a path that is no place changes nothing. */
const PLACES = {
    overview: { results: "sum-card", next: "tl-card", crontab: "root-card", notices: "notices" },
    timers: {},
    system: { users: "users-card" },
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
let place = null;   /* the id of the element still to scroll to */

function locationPath() {
    const path = cockpit.location && cockpit.location.path;
    return Array.isArray(path) ? path : [];
}

function followLocation() {
    const [name, part] = locationPath();
    if (name === undefined) {
        place = null;
        selectTab($("tab-overview"), false);
        return;
    }
    if (!own(PLACES, name)) return;
    selectTab($("tab-" + name), false);
    place = own(PLACES[name], part) ? PLACES[name][part] : null;
    scrollToPlace();
}

/* After every rendering of the page (renderAll) and when it is shown again. */
export function scrollToPlace() {
    if (!place || cockpit.hidden || !state.loadedAt) return;
    const el = $(place);
    place = null;
    if (el && !el.closest("[hidden]") && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
}

/* Click; arrow keys move between the tabs and show them, Home and End go to the first
   and the last; only the tab shown can be reached with Tab. Then the address, and every
   change of it. */
export function initTabs() {
    tabs().forEach(t => t.addEventListener("click", () => chooseTab(t, false)));
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
        chooseTab(next, true);
    });
    if (typeof cockpit.addEventListener === "function") {
        cockpit.addEventListener("locationchanged", followLocation);
        cockpit.addEventListener("visibilitychange", scrollToPlace);
    }
    followLocation();
}
