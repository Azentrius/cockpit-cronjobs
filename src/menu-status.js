/* Cron Jobs: the status icon next to the menu entry, and the moment the page itself starts.
 *
 * A page can set the status of its own menu entry only: Cockpit's shell files
 * cockpit.transport.control("notify", {page_status}) under the page of the frame that sends
 * it. So manifest.json asks Cockpit to load this page right after the login ("preload", as
 * Cockpit's own Software updates page does), hidden, and this file reads nothing but the
 * status that cockpit-cronjobs-status.timer writes for the Status Board
 * (/var/lib/cockpit-cronjobs/status.json, in German status.de.json; mode 644, so without
 * administrative access too), every five minutes again. It judges it as the Status Board
 * does: never better than an item, an item older than its stale_after a warning; then
 *   danger -> "error", warning -> "warning", info -> "info", ok and none: no icon.
 * The tooltip is the summary in the page's language, with the time when it is out of date.
 *
 * app.js waits for `shown`: the first time the page is shown. cockpit.hidden can be trusted
 * once a first answer is back: the shell sends a hidden frame its hint right after "init"
 * (Cockpit 264 to 360), and messages from the shell arrive in order.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function () {
    "use strict";

    const READ_EVERY = 5 * 60 * 1000;    /* the timer writes every 15 minutes */
    const TYPES = { danger: "error", warning: "warning", info: "info" };   /* Cockpit's page status types */
    const SEVERITY = { danger: 0, warning: 1, info: 2 };
    const ZONED_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    /* The page's language, as app/core.js takes it (cockpitLanguage): the choice in Cockpit's
       menu, else the one of ../base1/po.js; only German and English have a status file. */
    function language() {
        let lang = null;
        try {
            const m = /(?:^|;\s*)CockpitLang=([^;]*)/.exec(document.cookie);
            if (m) lang = decodeURIComponent(m[1]);
        } catch (_) { /* no cookie */ }
        if (!lang) {
            try { lang = window.localStorage.getItem("cockpit.lang"); } catch (_) { /* no storage */ }
        }
        return String(lang || cockpit.language || "en").toLowerCase().split(/[-_.]/)[0] === "de" ? "de" : "en";
    }
    const LANG = language();
    const I18N = window.CronJobsI18n || {};
    const L = I18N[LANG] || I18N.en;
    const T = L.ui;
    const FILE = "/var/lib/cockpit-cronjobs/" + (LANG === "de" ? "status.de.json" : "status.json");

    /* The menu's status for a status document at `now` (ms): {type, title}, or null for no icon. */
    function statusOf(doc, now) {
        if (!doc || typeof doc !== "object" || doc.schema !== 1 || !Array.isArray(doc.items)) return null;
        let worst = own(SEVERITY, doc.state) ? doc.state : null;
        let since = null;                /* the oldest checked_at of an item that is out of date */
        doc.items.forEach(it => {
            if (!it || typeof it !== "object") return;
            if (own(SEVERITY, it.state) && (worst === null || SEVERITY[it.state] < SEVERITY[worst])) worst = it.state;
            const at = typeof it.checked_at === "string" && ZONED_RE.test(it.checked_at) ? Date.parse(it.checked_at) : NaN;
            const after = it.stale_after;
            if (!isNaN(at) && Number.isInteger(after) && after > 0 && now - at > after * 1000)
                since = since === null ? at : Math.min(since, at);
        });
        if (since !== null && (worst === null || SEVERITY[worst] > SEVERITY.warning)) worst = "warning";
        if (worst === null) return null;
        const summary = typeof doc.summary === "string" ? doc.summary.slice(0, 200) : "";
        if (since === null) return { type: TYPES[worst], title: summary };
        const when = new Date(since).toLocaleString(L.locale, { dateStyle: "short", timeStyle: "short" });
        return { type: TYPES[worst], title: T.menuStale(summary, when) };
    }

    /* Sent only when it changed; the first time always (a reloaded frame may find the shell
       still showing what it sent before). */
    let sent;
    function notify(status) {
        const json = JSON.stringify(status);
        if (json === sent) return;
        sent = json;
        cockpit.transport.control("notify", { page_status: status });
    }

    let answered;
    const firstAnswer = new Promise(resolve => { answered = resolve; });

    /* A missing or unreadable file shows no icon. */
    function read() {
        Promise.resolve().then(() => cockpit.file(FILE).read())
            .then(text => JSON.parse(text || "null"))
            .catch(() => null)
            .then(doc => {
                notify(statusOf(doc, Date.now()));
                answered();
            });
    }
    read();
    window.setInterval(read, READ_EVERY);
    /* Should no answer come at all, the shell's hint has long arrived by then. */
    cockpit.transport.wait(() => window.setTimeout(answered, 3000));

    const shown = firstAnswer.then(() => new Promise(resolve => {
        function check() {
            if (cockpit.hidden) return;
            cockpit.removeEventListener("visibilitychange", check);
            resolve();
        }
        cockpit.addEventListener("visibilitychange", check);
        check();
    }));

    window.CronJobsMenuStatus = { shown, statusOf };
}());
