/* Cron Jobs — what every part uses: the libraries (lib/*.js, loaded before as
 * plain scripts), constants, the texts in Cockpit's language, DOM helpers, times in
 * the server's time zone, and the state of the page.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

export const C = window.CronLogic;
export const SD = window.CronSystemd;
export const R = window.CronRuns;
const ICONS = window.AzIcons;
export const STATE_DIR = "/var/lib/cockpit-cronjobs";
export const BACKUP_DIR = STATE_DIR + "/backups";
export const RUNS_DIR = STATE_DIR + "/runs";
export const KEEP_BACKUPS = 10;
export const KEEP_RUNS = 20;
export const RUN_OUTPUT_LIMIT = 256 * 1024;
const HOUR = 3600000;
export const DAY = 24 * HOUR;

/* ---------- language ---------- */

/* Like Cockpit: the choice in Cockpit's menu (cookie CockpitLang or cockpit.lang),
   else the language Cockpit serves through ../base1/po.js. Languages without a file
   in i18n/ fall back to English. */
function cockpitLanguage() {
    let lang = null;
    try {
        const m = /(?:^|;\s*)CockpitLang=([^;]*)/.exec(document.cookie);
        if (m) lang = decodeURIComponent(m[1]);
    } catch (_) { /* no cookie */ }
    if (!lang) {
        try { lang = window.localStorage.getItem("cockpit.lang"); } catch (_) { /* no storage */ }
    }
    return lang || cockpit.language || "en";
}
const I18N = window.CronJobsI18n || {};
const WANTED = String(cockpitLanguage()).toLowerCase().split(/[-_.]/)[0];
const LANG = Object.prototype.hasOwnProperty.call(I18N, WANTED) ? WANTED : "en";
const L = I18N[LANG];
export const T = L.ui;
export const S = L.schedule;
export const LOCALE = L.locale;
document.documentElement.lang = LANG;

/* ---------- DOM helpers ---------- */

export const $ = id => document.getElementById(id);

export function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const k of Object.keys(attrs)) {
            const v = attrs[k];
            if (v === null || v === undefined || v === false) continue;
            if (k === "class") el.className = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
}
function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(k => append(el, k)); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
}
/* Replace the content; null/false/arrays as with h(). */
export function fill(el) {
    el.replaceChildren();
    for (let i = 1; i < arguments.length; i++) append(el, arguments[i]);
    return el;
}

/* Translated text: `…` marks code. Only ever creates text and <code> nodes. */
export function rich(value) {
    const s = typeof value === "function" ? value() : value;
    if (typeof s !== "string") return s;
    return s.split("`").map((part, i) => (i % 2 ? h("code", null, part) : part)).filter(x => x !== "");
}
/* Text from the system (names, paths) that goes into a rich text. */
export const codeSafe = s => String(s).replace(/`/g, "'");

export function icon(name) {
    const def = ICONS[name];
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "az-icon");
    svg.setAttribute("viewBox", def.viewBox);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", def.d);
    svg.append(path);
    return svg;
}

export function setBusyButton(btn, busy, busyText) {
    if (!btn.dataset.idle) btn.dataset.idle = btn.textContent;
    btn.textContent = busy ? busyText : btn.dataset.idle;
    btn.disabled = busy;
    btn.setAttribute("aria-busy", busy ? "true" : "false");
}

export function joinList(items) {
    if (items.length <= 1) return items.join("");
    return items.slice(0, -1).join(", ") + " " + S.and + " " + items[items.length - 1];
}
export const lowerFirst = s => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
export const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

/* ---------- time ---------- */

export const pad2 = n => String(n).padStart(2, "0");
const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return "UTC"; } })();
const dayNumber = w => Date.UTC(w.y, w.mo - 1, w.d) / DAY;

export function weekdayShort(ms, tz) {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: "short" }).format(ms).replace(/\.$/, "");
}

/* "today", "tomorrow", "yesterday", "Sun, 18.10." — in the server's time zone */
function dayLabel(ms) {
    const tz = state.tz;
    const w = C.wallParts(ms, tz);
    const n = C.wallParts(Date.now(), tz);
    const days = dayNumber(w) - dayNumber(n);
    if (days === 0) return T.today;
    if (days === 1) return T.tomorrow;
    if (days === -1) return T.yesterday;
    if (LANG === "de") return weekdayShort(ms, tz) + ", " + pad2(w.d) + "." + pad2(w.mo) + "." + (w.y !== n.y ? w.y : "");
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: "short", month: "short", day: "numeric",
                                             year: w.y !== n.y ? "numeric" : undefined }).format(ms);
}
export function clock(ms, tz) {
    const w = C.wallParts(ms, tz || state.tz);
    return pad2(w.h) + ":" + pad2(w.mi);
}
export const fmtWhen = ms => T.at(dayLabel(ms), clock(ms));     /* "today at 03:00" */
export const fmtShort = ms => dayLabel(ms) + " " + clock(ms);   /* "today 03:00" */

export function fmtRelative(ms) {
    const diff = ms - Date.now();
    const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "always" });
    const minutes = Math.ceil(diff / 60000);
    if (minutes < 60) return rtf.format(Math.max(1, minutes), "minute");
    const hours = Math.round(diff / HOUR);
    if (hours < 24) return rtf.format(hours, "hour");
    return rtf.format(Math.round(diff / DAY), "day");
}

/* The browser's time, when it differs from the server's. */
export function fmtLocal(ms) {
    if (!C.validTimeZone(BROWSER_TZ)) return null;
    const s = C.wallParts(ms, state.tz);
    const l = C.wallParts(ms, BROWSER_TZ);
    if (s.h === l.h && s.mi === l.mi && dayNumber(s) === dayNumber(l)) return null;
    const time = pad2(l.h) + ":" + pad2(l.mi);
    return T.localTime(dayNumber(s) === dayNumber(l) ? time : weekdayShort(ms, BROWSER_TZ) + " " + time);
}

export function fmtClock(ms) {
    return new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
}

/* Seconds -> "3 s", "4 min 12 s", "1 h 05 min", "2 d 3 h" */
export function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + " s";
    if (sec < 3600) return Math.floor(sec / 60) + " min" + (sec % 60 ? " " + pad2(sec % 60) + " s" : "");
    if (sec < 86400) {
        const m = Math.floor(sec % 3600 / 60);
        return Math.floor(sec / 3600) + " h" + (m ? " " + pad2(m) + " min" : "");
    }
    const hours = Math.floor(sec % 86400 / 3600);
    return Math.floor(sec / 86400) + " " + T.unitDay + (hours ? " " + hours + " h" : "");
}

/* "0:04", "12:30", "1:02:03" */
export function fmtElapsed(sec) {
    sec = Math.max(0, Math.floor(sec));
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor(sec % 3600 / 60);
    return (hh ? hh + ":" + pad2(mm) : String(mm)) + ":" + pad2(sec % 60);
}

export function tzLabel(tz) { return tz.replace(/^Etc\//, ""); }

/* ---------- state ---------- */

export const state = {
    tz: "UTC",
    host: "",
    loadedAt: 0,
    busy: false,
    root: { status: "loading" },   /* loading | ok | denied | error | missing */
    sys: null,
    sysError: null,
    basics: { mta: null, crontab: true, flavor: "debian", systemd: false, cron: null, wrapper: null },
    runs: { status: "none", byId: {} },     /* none | ok | denied | error; rootVersion: see setRoot */
    timers: { status: "none", list: [] },   /* none | ok | error */
    suAtLoad: undefined,
};
