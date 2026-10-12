/* Cron Jobs — Cockpit page.
 *
 * The root crontab is read and written through `crontab -u root`. Saving happens in
 * one locked step (SAVE_SCRIPT): only if the crontab is still the one shown (cksum),
 * with a backup first; afterwards it is read back and compared. Lines that are not
 * changed stay byte for byte (see lib/cron.js).
 *
 * /etc/crontab, /etc/cron.d, other users' crontabs, run-parts directories and systemd
 * timers are shown read-only. Jobs can record their runs (cockpit-cronjobs-run), be
 * started right away, and be converted into systemd timers.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
(function () {
    "use strict";

    const C = window.CronLogic;
    const SD = window.CronSystemd;
    const R = window.CronRuns;
    const ICONS = window.AzIcons;
    const VERSION = "2.1.1";
    const STATE_DIR = "/var/lib/cockpit-cronjobs";
    const BACKUP_DIR = STATE_DIR + "/backups";
    const RUNS_DIR = STATE_DIR + "/runs";
    const KEEP_BACKUPS = 10;
    const KEEP_RUNS = 20;
    const RUN_OUTPUT_LIMIT = 256 * 1024;
    const HOUR = 3600000;
    const DAY = 24 * HOUR;

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
    const T = L.ui;
    const S = L.schedule;
    const LOCALE = L.locale;
    document.documentElement.lang = LANG;

    /* ---------- DOM helpers ---------- */

    const $ = id => document.getElementById(id);

    function h(tag, attrs) {
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
    function fill(el) {
        el.replaceChildren();
        for (let i = 1; i < arguments.length; i++) append(el, arguments[i]);
        return el;
    }

    /* Translated text: `…` marks code. Only ever creates text and <code> nodes. */
    function rich(value) {
        const s = typeof value === "function" ? value() : value;
        if (typeof s !== "string") return s;
        return s.split("`").map((part, i) => (i % 2 ? h("code", null, part) : part)).filter(x => x !== "");
    }
    /* Text from the system (names, paths) that goes into a rich text. */
    const codeSafe = s => String(s).replace(/`/g, "'");

    function icon(name) {
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

    function setBusyButton(btn, busy, busyText) {
        if (!btn.dataset.idle) btn.dataset.idle = btn.textContent;
        btn.textContent = busy ? busyText : btn.dataset.idle;
        btn.disabled = busy;
        btn.setAttribute("aria-busy", busy ? "true" : "false");
    }

    function joinList(items) {
        if (items.length <= 1) return items.join("");
        return items.slice(0, -1).join(", ") + " " + S.and + " " + items[items.length - 1];
    }
    const lowerFirst = s => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

    /* ---------- time ---------- */

    const pad2 = n => String(n).padStart(2, "0");
    const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return "UTC"; } })();
    const dayNumber = w => Date.UTC(w.y, w.mo - 1, w.d) / DAY;

    function weekdayShort(ms, tz) {
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
    function clock(ms, tz) {
        const w = C.wallParts(ms, tz || state.tz);
        return pad2(w.h) + ":" + pad2(w.mi);
    }
    const fmtWhen = ms => T.at(dayLabel(ms), clock(ms));     /* "today at 03:00" */
    const fmtShort = ms => dayLabel(ms) + " " + clock(ms);   /* "today 03:00" */

    function fmtRelative(ms) {
        const diff = ms - Date.now();
        const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "always" });
        const minutes = Math.ceil(diff / 60000);
        if (minutes < 60) return rtf.format(Math.max(1, minutes), "minute");
        const hours = Math.round(diff / HOUR);
        if (hours < 24) return rtf.format(hours, "hour");
        return rtf.format(Math.round(diff / DAY), "day");
    }

    /* The browser's time, when it differs from the server's. */
    function fmtLocal(ms) {
        if (!C.validTimeZone(BROWSER_TZ)) return null;
        const s = C.wallParts(ms, state.tz);
        const l = C.wallParts(ms, BROWSER_TZ);
        if (s.h === l.h && s.mi === l.mi && dayNumber(s) === dayNumber(l)) return null;
        const time = pad2(l.h) + ":" + pad2(l.mi);
        return T.localTime(dayNumber(s) === dayNumber(l) ? time : weekdayShort(ms, BROWSER_TZ) + " " + time);
    }

    function fmtClock(ms) {
        return new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
    }

    /* Seconds -> "3 s", "4 min 12 s", "1 h 05 min", "2 d 3 h" */
    function fmtDuration(sec) {
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
    function fmtElapsed(sec) {
        sec = Math.max(0, Math.floor(sec));
        const hh = Math.floor(sec / 3600);
        const mm = Math.floor(sec % 3600 / 60);
        return (hh ? hh + ":" + pad2(mm) : String(mm)) + ":" + pad2(sec % 60);
    }

    function tzLabel(tz) { return tz.replace(/^Etc\//, ""); }

    /* ---------- system access ---------- */

    const SPAWN_ROOT = { superuser: "require", err: "message", environ: ["LC_ALL=C"] };
    const SPAWN_USER = { err: "message", environ: ["LC_ALL=C"] };

    function spawn(args, opts, input) {
        const proc = cockpit.spawn(args, opts);
        if (input !== undefined) proc.input(input);
        return Promise.resolve(proc);
    }

    function errText(ex) {
        if (!ex) return "";
        return String(ex.message || ex.problem || ex).trim();
    }
    function isDenied(ex) {
        return !!ex && (ex.problem === "access-denied" || ex.problem === "not-authorized" ||
                        /must be privileged/i.test(ex.message || ""));
    }

    function sections(out) {
        return String(out || "").split("\x1e").slice(1).map(chunk => {
            const nl = chunk.indexOf("\n");
            return { name: nl < 0 ? chunk : chunk.slice(0, nl), body: nl < 0 ? "" : chunk.slice(nl + 1) };
        });
    }
    const decode = out => typeof out === "string" ? out : new TextDecoder("utf-8").decode(out);

    /* The root crontab as text; read as bytes, so that a crontab that is not UTF-8 can
       still be shown (read-only, see setRoot). Resolves to { text, utf8 }. */
    function readRoot() {
        return spawn(["crontab", "-l", "-u", "root"], Object.assign({}, SPAWN_ROOT, { binary: true })).then(
            out => {
                const bytes = typeof out === "string" ? new TextEncoder().encode(out) : out;
                try {
                    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), utf8: true };
                } catch (_) {
                    return { text: new TextDecoder("utf-8").decode(bytes), utf8: false };
                }
            },
            ex => {
                if (ex && ex.exit_status === 1 && /no crontab/i.test(ex.message || "")) return { text: "", utf8: true };
                throw ex;
            });
    }

    /* Replaces the root crontab in one step under a lock:
         $1    = cksum of the version the page shows (else exit 3)
         $2    = optional: a systemd timer to enable and start right after (for a
                 conversion), or with $3 = stop to stop and disable (back to cron); if
                 that fails, the previous crontab is put back (exit 7)
         stdin = the new version
       The current version is backed up first (directory 700, files 600, the last ten are
       kept; a version that already is the newest backup is not stored twice).
       The lock lives in a directory only root can write to. Closing the page does not
       interrupt the script (SIGTERM and SIGHUP are ignored).
       Output: path of the backup, empty when there was no crontab before.
       Exit 3 = changed meanwhile, 4 = locked, 5 = backup failed, 7 = timer failed,
       else crontab's error. */
    const SAVE_SCRIPT = `set -eu
trap '' TERM HUP INT
umask 077
expect="$1"
timer="\${2-}"
verb=enable
if [ "\${3-}" = stop ]; then verb=disable; fi
dir='${BACKUP_DIR}'
install -d -m 700 '${STATE_DIR}' || exit 5
exec 9>'${STATE_DIR}/.crontab.lock'
flock -w 10 9 || exit 4
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/new"
if crontab -l -u root > "$tmp/cur" 2> "$tmp/err"; then
  have=1
elif grep -q "no crontab for" "$tmp/err"; then
  have=0
  : > "$tmp/cur"
else
  cat "$tmp/err" >&2
  exit 1
fi
sum=$(cksum < "$tmp/cur")
[ "$sum" = "$expect" ] || exit 3
f=
if [ "$have" = 1 ]; then
  install -d -m 700 "$dir" || exit 5
  chmod 700 '${STATE_DIR}' "$dir" || exit 5
  last=$(ls -1t "$dir"/root-*.crontab 2>/dev/null | head -n 1)
  if [ -n "$last" ] && [ "$(cksum < "$last")" = "$sum" ]; then
    f=$last
  else
    stamp="$dir/root-$(date +%Y%m%d-%H%M%S)"
    f="$stamp.crontab"
    n=1
    while [ -e "$f" ]; do n=$((n + 1)); f="$stamp-$n.crontab"; done
    cp "$tmp/cur" "$f.tmp" || exit 5
    [ "$(cksum < "$f.tmp")" = "$sum" ] || { rm -f "$f.tmp"; exit 5; }
    mv "$f.tmp" "$f" || exit 5
  fi
  chmod 600 "$dir"/root-*.crontab || exit 5
  ls -1t "$dir"/root-*.crontab | tail -n +${KEEP_BACKUPS + 1} | while IFS= read -r old; do rm -f -- "$old"; done
fi
crontab -u root "$tmp/new"
if [ -n "$timer" ]; then
  if ! systemctl "$verb" --now "$timer" > /dev/null 2> "$tmp/err"; then
    if [ "$have" = 1 ]; then crontab -u root "$tmp/cur"; else crontab -r -u root; fi
    cat "$tmp/err" >&2
    exit 7
  fi
fi
printf '%s\\n' "$f"
`;

    /* expected: the text shown (exactly as crontab -l gave it), next: the new text,
       timer: optional unit to enable and start once the crontab is written, or to stop
       and disable when stop is set. */
    function saveRoot(expected, next, timer, stop) {
        const args = ["sh", "-c", SAVE_SCRIPT, "cockpit-cronjobs", C.cksum(expected)]
            .concat(timer ? [timer].concat(stop ? ["stop"] : []) : []);
        return spawn(args, SPAWN_ROOT, next).then(out => String(out || "").trim());
    }

    /* Host name, time zone as cron sees it, and what is installed. */
    const BASICS_SCRIPT = `sec() { printf '\\036%s\\n' "$1"; }
has_systemd() { [ -d /run/systemd/system ] && command -v systemctl > /dev/null 2>&1; }
sec host; hostname 2>/dev/null || cat /etc/hostname 2>/dev/null
sec tz; timedatectl show -p Timezone --value 2>/dev/null
sec tz; readlink /etc/localtime 2>/dev/null
sec tz; cat /etc/timezone 2>/dev/null
sec mta; if [ -x /usr/sbin/sendmail ] || [ -x /usr/lib/sendmail ]; then echo yes; else echo no; fi
sec crontab; if command -v crontab > /dev/null 2>&1; then echo yes; else echo no; fi
sec flavor; if [ -x /usr/sbin/crond ] || [ ! -f /etc/debian_version ]; then echo cronie; else echo debian; fi
sec systemd; if has_systemd; then echo yes; else echo no; fi
sec cron
if has_systemd; then
  for u in cron.service crond.service cronie.service; do
    if [ "$(systemctl show -p LoadState --value "$u" 2>/dev/null)" = loaded ]; then
      echo "$u $(systemctl is-active "$u" 2>/dev/null)"
      break
    fi
  done
elif command -v pgrep > /dev/null 2>&1; then
  if pgrep -x cron > /dev/null || pgrep -x crond > /dev/null; then echo "- active"; else echo "- inactive"; fi
fi
sec wrapper
w='${C.WRAPPER_PATH}'
if [ -f "$w" ]; then
  v=$(sed -n 's/^CRONJOBS_RUN_VERSION=\\([0-9][0-9]*\\).*/\\1/p' "$w" | head -n 1)
  [ -x "$w" ] || v=0
  echo "\${v:-0}"
else
  echo missing
fi
exit 0
`;

    function zoneFrom(s) {
        const m = /zoneinfo\/(?:posix\/|right\/)?(.+)$/.exec(s);
        const tz = (m ? m[1] : s).trim();
        return tz && C.validTimeZone(tz) ? tz : null;
    }

    function readBasics() {
        return spawn(["sh", "-c", BASICS_SCRIPT], { err: "ignore", environ: ["LC_ALL=C"] }).then(out => {
            const res = { host: "", tz: null, mta: null, crontab: true, flavor: "debian", systemd: false,
                          cron: null, wrapper: null };
            sections(out).forEach(({ name, body }) => {
                const first = body.trim().split("\n")[0] || "";
                if (name === "host") res.host = first;
                else if (name === "tz" && !res.tz) res.tz = zoneFrom(first);
                else if (name === "mta") res.mta = first === "yes";
                else if (name === "crontab") res.crontab = first !== "no";
                else if (name === "flavor") res.flavor = first === "cronie" ? "cronie" : "debian";
                else if (name === "systemd") res.systemd = first === "yes";
                else if (name === "cron" && first) {
                    const [unit, st] = first.split(/\s+/);
                    res.cron = { unit: unit === "-" ? null : unit, active: st === "active" };
                } else if (name === "wrapper") res.wrapper = first === "missing" ? "missing" : (parseInt(first, 10) || 0);
            });
            return res;
        });
    }

    /* Everything read-only in one call; as root when available, else as the user.
       Sections start with RS (\\036) and their name; RS is removed from all file contents,
       so that nobody can fake a section with a line in their own crontab. Read as bytes,
       so that a file in another encoding does not take everything else down with it.
       cron.d sections carry owner and mode: cron skips files that are not root's or
       that others can write to. uid tells whether it ran as root (other users'
       crontabs need that); /etc/anacrontab is only read to see which recorded jobs
       are still mentioned somewhere. */
    const SYSTEM_SCRIPT = `sec() { printf '\\036%s\\n' "$1"; }
show() { tr -d '\\036' < "$1" 2>/dev/null; echo; }
name() { printf '%s' "$1" | tr -d '\\036\\n'; }
sec uid; id -u
sec etc; show /etc/crontab
for f in /etc/cron.d/*; do
  [ -f "$f" ] || continue
  sec "d:$(stat -L -c '%u:%a' "$f" 2>/dev/null):$(name "\${f##*/}")"; show "$f"
done
if [ -f /etc/anacrontab ]; then sec anacron; show /etc/anacrontab; fi
spool=
for d in /var/spool/cron/crontabs /var/spool/cron/tabs /var/spool/cron; do
  if [ -d "$d" ]; then spool=$d; break; fi
done
if [ -n "$spool" ]; then
  for f in "$spool"/*; do
    [ -f "$f" ] || continue
    u=\${f##*/}
    case $u in root|.*|*~|*.tmp|tmp.*) continue ;; esac
    sec "u:$(name "$u")"; show "$f"
  done
fi
debian_rp=0
if run-parts --version 2>/dev/null | grep -qi debian; then debian_rp=1; fi
for p in hourly daily weekly monthly; do
  d=/etc/cron.$p
  [ -d "$d" ] || continue
  sec "p:$p"
  if [ $debian_rp = 1 ]; then
    run-parts --test "$d" 2>/dev/null
  else
    for f in "$d"/*; do
      [ -f "$f" ] && [ -x "$f" ] && printf '%s\\n' "$f"
    done
  fi
done
exit 0
`;

    /* Names run-parts of cronie (Fedora, RHEL, …) skips. */
    const CRONIE_SKIP_RE = /(~|,|\.rpm(save|orig|new)|\.swp|\.cfsaved|\.dpkg-[a-z]+)$/;

    function readSystem(flavor) {
        return spawn(["sh", "-c", SYSTEM_SCRIPT], { superuser: "try", err: "ignore", binary: true, environ: ["LC_ALL=C"] })
            .then(out => parseSystem(decode(out), flavor));
    }

    /* sys.texts: every crontab as read, for finding the recorded jobs no line uses
       any more (see orphanList). */
    function parseSystem(out, flavor) {
        const sys = { etc: [], crond: [], users: [], periodic: [], root: false, texts: [] };
        sections(out).forEach(({ name, body }) => {
            if (name === "etc" || name === "anacron" || /^[du]:/.test(name)) sys.texts.push(body);
            if (name === "uid") sys.root = body.trim() === "0";
            else if (name === "etc") sys.etc = C.parseSystemCrontab(body);
            else if (name.startsWith("d:")) {
                const m = /^d:(\d*):([0-7]*):(.*)$/.exec(name);
                if (!m) return;
                const file = m[3];
                const badName = !C.cronDNameValid(file, flavor !== "cronie");
                const badOwner = (m[1] !== "" && m[1] !== "0") || (m[2] !== "" && (parseInt(m[2], 8) & 0o022) !== 0);
                const ignored = badName ? "name" : badOwner ? "owner" : null;
                C.parseSystemCrontab(body).forEach(j => sys.crond.push(Object.assign({ file, ignored }, j)));
            } else if (name.startsWith("u:")) {
                const user = name.slice(2);
                const entries = C.parseUserCrontab(body);
                entries.forEach((e, i) => {
                    if (e.kind !== "job") return;
                    const cronTz = flavor === "cronie" ? C.envBefore(entries, i).CRON_TZ : null;
                    sys.users.push({ user, schedule: e.schedule, command: e.command, enabled: e.enabled,
                                     tz: cronTz && C.validTimeZone(cronTz) ? cronTz : null });
                });
            } else if (name.startsWith("p:")) {
                const scripts = body.split("\n").filter(Boolean).map(x => x.replace(/^.*\//, ""))
                    .filter(x => !CRONIE_SKIP_RE.test(x));
                sys.periodic.push({ dir: "/etc/cron." + name.slice(2), scripts });
            }
        });
        return sys;
    }

    /* Recorded runs of all jobs (see lib/runs.js), with the disk use of each
       directory in KB. A run marker whose process is gone is reported with ALIVE 0. */
    const RUNS_SCRIPT = `base='${RUNS_DIR}'
[ -d "$base" ] || exit 0
for d in "$base"/*; do
  [ -d "$d" ] || continue
  printf '\\036%s\\n' "\${d##*/}"
  printf 'size %s\\n' "$(du -sk "$d" 2>/dev/null | cut -f1)"
  tail -n ${KEEP_RUNS} "$d/runs.jsonl" 2>/dev/null
  for r in "$d"/*.running; do
    [ -f "$r" ] || continue
    pid=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$r" | head -n 1)
    alive=0
    if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\\000' ' ' < "/proc/$pid/cmdline" | grep -q cockpit-cronjobs-run; then
      alive=1
    fi
    printf 'running %s %s\\n' "$alive" "$(head -n 1 "$r")"
  done
done
exit 0
`;

    function readRuns() {
        return spawn(["sh", "-c", RUNS_SCRIPT], Object.assign({}, SPAWN_ROOT, { binary: true }))
            .then(out => R.parseRuns(decode(out)));
    }

    function readOutput(id, out) {
        if (!R.ID_RE.test(id) || !R.OUT_RE.test(out)) return Promise.resolve("");
        return spawn(["tail", "-c", "65536", RUNS_DIR + "/" + id + "/" + out + ".out"],
                     Object.assign({}, SPAWN_ROOT, { binary: true }))
            .then(decode, ex => {
                if (ex && ex.exit_status === 1) return "";
                throw ex;
            });
    }

    function removeRuns(id) {
        if (!R.ID_RE.test(id)) return Promise.resolve();
        return spawn(["rm", "-rf", "--", RUNS_DIR + "/" + id], SPAWN_ROOT);
    }

    /* A copied line may share the ID; its runs stay as long as a line still uses them. */
    function removeRunsIfUnused(id) {
        if (state.root.status !== "ok" || takenIds(state.root.entries).has(id)) return Promise.resolve();
        return removeRuns(id).catch(() => {});
    }

    /* Removes the run directories of recorded jobs that no crontab uses any more. Under
       the crontab lock, every ID is checked again: a directory stays when its ID
       appears as a word anywhere in the root crontab, /etc/crontab, /etc/anacrontab,
       /etc/cron.d or another user's crontab ("used"), or while a run is going on
       ("running"). If one of these files cannot be read, nothing is removed.
       Arguments: the IDs. Output: "removed|gone|used|running ID" for each.
       Exit 4 = locked, else an error. */
    const REMOVE_ORPHANS_SCRIPT = `set -u
trap '' TERM HUP INT
umask 077
base='${RUNS_DIR}'
[ -d "$base" ] || exit 0
exec 9>'${STATE_DIR}/.crontab.lock'
flock -w 10 9 || exit 4
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
if ! crontab -l -u root > "$tmp/all" 2> "$tmp/err"; then
  grep -q "no crontab for" "$tmp/err" || { cat "$tmp/err" >&2; exit 1; }
  : > "$tmp/all"
fi
for f in /etc/crontab /etc/anacrontab /etc/cron.d/* /var/spool/cron/crontabs/* /var/spool/cron/tabs/* /var/spool/cron/*; do
  [ -f "$f" ] || continue
  { cat -- "$f" && echo; } >> "$tmp/all" || exit 1
done
for id in "$@"; do
  case $id in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  [ \${#id} -le 64 ] || continue
  d=$base/$id
  if [ ! -d "$d" ]; then echo "gone $id"; continue; fi
  grep -qE "(^|[^A-Za-z0-9_-])$id([^A-Za-z0-9_-]|\\$)" "$tmp/all"
  case $? in
    0) echo "used $id"; continue ;;
    1) ;;
    *) exit 1 ;;
  esac
  alive=0
  for r in "$d"/*.running; do
    [ -f "$r" ] || continue
    pid=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$r" | head -n 1)
    if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\\000' ' ' < "/proc/$pid/cmdline" | grep -q cockpit-cronjobs-run; then
      alive=1
    fi
  done
  if [ "$alive" = 1 ]; then echo "running $id"; continue; fi
  rm -rf -- "$d" || exit 1
  echo "removed $id"
done
exit 0
`;

    /* Result: { removed: [ID…], kept: [ID…] }; "gone" counts as removed. */
    function removeOrphans(ids) {
        const args = ["sh", "-c", REMOVE_ORPHANS_SCRIPT, "cockpit-cronjobs"].concat(ids.filter(id => R.ID_RE.test(id)));
        return spawn(args, SPAWN_ROOT).then(out => {
            const res = { removed: [], kept: [] };
            String(out || "").split("\n").forEach(line => {
                const m = /^(removed|gone|used|running) ([A-Za-z0-9_-]{1,64})$/.exec(line);
                if (m) (m[1] === "removed" || m[1] === "gone" ? res.removed : res.kept).push(m[2]);
            });
            return res;
        });
    }

    /* Installs the run recorder that comes with this page: written next to the target
       and renamed, so a job never sees half a file. */
    const INSTALL_WRAPPER_SCRIPT = `set -eu
umask 022
target=$1
dir=\${target%/*}
mkdir -p "$dir"
tmp=$(mktemp "$dir/.cockpit-cronjobs-run.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$target"
trap - EXIT
`;

    async function installWrapper() {
        let text;
        try {
            const resp = await fetch("cockpit-cronjobs-run", { cache: "no-store", credentials: "same-origin" });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            text = await resp.text();
        } catch (ex) {
            throw new Error(T.wrapperNoCopy + " " + errText(ex));
        }
        if (!text.startsWith("#!/bin/sh\n") || !new RegExp("^CRONJOBS_RUN_VERSION=" + C.WRAPPER_VERSION + "$", "m").test(text))
            throw new Error(T.wrapperNoCopy);
        await spawn(["sh", "-c", INSTALL_WRAPPER_SCRIPT, "cockpit-cronjobs", C.WRAPPER_PATH], SPAWN_ROOT, text);
        state.basics.wrapper = C.WRAPPER_VERSION;
    }

    function wrapperCurrent() {
        return typeof state.basics.wrapper === "number" && state.basics.wrapper >= C.WRAPPER_VERSION;
    }

    /* Makes sure the run recorder is there before a job uses it. */
    async function ensureWrapper() {
        if (wrapperCurrent()) return true;
        try {
            await installWrapper();
            renderNotices();
            return true;
        } catch (ex) {
            showAlert("danger", T.wrapperFailed, errText(ex));
            return false;
        }
    }

    /* ---------- systemd ---------- */

    const SD_BUS = "org.freedesktop.systemd1";
    const SD_PATH = "/org/freedesktop/systemd1";
    const SD_MGR = "org.freedesktop.systemd1.Manager";
    const DBUS_PROPS = "org.freedesktop.DBus.Properties";
    const U64_NONE = 2 ** 63;
    let sdClient = null;

    function sd() {
        if (!sdClient) sdClient = cockpit.dbus(SD_BUS, { superuser: "try" });
        return sdClient;
    }
    const variant = x => (x && typeof x === "object" && "v" in x && "t" in x) ? x.v : x;
    const usecTime = us => (typeof us === "number" && us > 0 && us < U64_NONE) ? us / 1000 : null;

    function getProp(path, iface, name) {
        return sd().call(path, DBUS_PROPS, "Get", [iface, name]).then(r => variant(r[0]));
    }
    function getAll(path, iface) {
        return sd().call(path, DBUS_PROPS, "GetAll", [iface]).then(r => {
            const out = {};
            Object.keys(r[0] || {}).forEach(k => { out[k] = variant(r[0][k]); });
            return out;
        });
    }
    function unitPath(name) {
        return sd().call(SD_PATH, SD_MGR, "GetUnit", [name]).then(r => r[0],
            () => sd().call(SD_PATH, SD_MGR, "LoadUnit", [name]).then(r => r[0]));
    }

    /* Runs of calendar specs: `systemd-analyze calendar --iterations=N` for each. */
    const ANALYZE_SCRIPT = `n=$1
shift
for s in "$@"; do
  printf '\\036%s\\n' "$s"
  systemd-analyze calendar --iterations="$n" "$s" 2>/dev/null || systemd-analyze calendar "$s" 2>/dev/null
done
exit 0
`;

    function analyzeCalendar(specs, iterations) {
        if (!specs.length) return Promise.resolve({});
        return spawn(["sh", "-c", ANALYZE_SCRIPT, "cockpit-cronjobs", String(iterations)].concat(specs),
                     { err: "ignore", environ: ["LC_ALL=C"] })
            .then(out => {
                const res = {};
                sections(out).forEach(({ name, body }) => { res[name] = SD.parseAnalyzeCalendar(body); });
                return res;
            });
    }

    async function readTimers() {
        const [units] = await sd().call(SD_PATH, SD_MGR, "ListUnitsByPatterns", [[], ["*.timer"]]);
        let offset = null;   /* realtime - monotonic, in µs */
        try {
            const [rt, mono] = await Promise.all([getProp(SD_PATH, SD_MGR, "UserspaceTimestamp"),
                                                  getProp(SD_PATH, SD_MGR, "UserspaceTimestampMonotonic")]);
            if (rt > 0 && mono > 0) offset = rt - mono;
        } catch (_) { /* monotonic timers then show no next run */ }

        const list = await Promise.all(units.map(async u => {
            const name = u[0];
            const t = await getAll(u[6], "org.freedesktop.systemd1.Timer");
            const calendar = (t.TimersCalendar || []).map(x => x[1]);
            const monotonic = (t.TimersMonotonic || []).map(x => ({ base: x[0], usec: x[1] }));
            let next = usecTime(t.NextElapseUSecRealtime);
            const nextMono = usecTime(t.NextElapseUSecMonotonic);
            if (nextMono !== null && offset !== null) {
                const n = nextMono + offset / 1000;
                if (next === null || n < next) next = n;
            }
            const timer = {
                name, description: u[1], active: u[3] === "active", calendar, monotonic, next,
                last: usecTime(t.LastTriggerUSec), randomizedUsec: t.RandomizedDelayUSec || 0,
                persistent: !!t.Persistent, service: t.Unit || name.replace(/\.timer$/, ".service"),
                result: null, status: null, startUs: null, exitUs: null, running: false, runs: [],
            };
            try {
                const path = await unitPath(timer.service);
                const [svc, unit] = await Promise.all([getAll(path, "org.freedesktop.systemd1.Service"),
                                                       getAll(path, "org.freedesktop.systemd1.Unit")]);
                timer.result = svc.Result || null;
                timer.status = typeof svc.ExecMainStatus === "number" ? svc.ExecMainStatus : null;
                timer.startUs = usecTime(svc.ExecMainStartTimestamp);
                timer.exitUs = usecTime(svc.ExecMainExitTimestamp);
                timer.running = unit.ActiveState === "activating" || unit.ActiveState === "deactivating" ||
                    (unit.ActiveState === "active" && svc.Type !== "oneshot" && unit.SubState === "running");
            } catch (_) { /* no service details */ }
            return timer;
        }));

        /* Runs in the next 24 hours, for the timeline. Randomized timers: only the
           next run is known. */
        const specs = Array.from(new Set([].concat(...list.filter(t => t.active && !t.randomizedUsec)
            .map(t => t.calendar))));
        let iter = {};
        try { iter = await analyzeCalendar(specs, 25); } catch (_) { iter = {}; }
        list.forEach(t => {
            if (!t.active) return;
            const runs = new Set();
            if (!t.randomizedUsec) t.calendar.forEach(s => (iter[s] || []).forEach(ms => runs.add(ms)));
            if (t.next !== null) runs.add(t.next);
            t.runs = Array.from(runs).sort((a, b) => a - b);
            t.band = !t.randomizedUsec && t.calendar.some(s => (iter[s] || []).length >= 25 &&
                                                         iter[s][24] - Date.now() <= DAY);
        });
        list.sort((a, b) => (a.next === null) - (b.next === null) || (a.next || 0) - (b.next || 0) ||
                            a.name.localeCompare(b.name));
        return list;
    }

    /* ---------- state ---------- */

    const state = {
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

    /* Counts the versions of the root crontab the page has seen. Runs read before the
       current version may still hold the runs of a line the page just removed, so
       leftover runs are only shown from runs read since (see orphanList). */
    let rootVersion = 0;

    /* read: { text, utf8 } from readRoot. A crontab that is not UTF-8, or would not be
       written back exactly, is shown read-only. */
    function setRoot(read) {
        rootVersion++;
        const content = read.text;
        const entries = C.parseUserCrontab(content);
        const notUtf8 = !read.utf8;
        state.root = {
            status: "ok",
            text: content,
            entries,
            templateEnd: C.templateEnd(entries),
            notUtf8,
            locked: notUtf8 || !C.roundTrips(content),
            mailto: entries.some(e => e.kind === "raw" && /^\s*MAILTO\s*=/.test(e.line)),
        };
    }

    function rootJobs() {
        const r = state.root;
        if (r.status !== "ok") return [];
        const out = [];
        r.entries.forEach((e, i) => { if (e.kind === "job") out.push({ e, i }); });
        return out;
    }

    /* The command as the user wrote it, and the recording, if any. */
    function jobInfo(e) {
        const capture = C.unwrapCommand(e.command);
        return { capture, command: capture ? capture.command : e.command };
    }

    function takenIds(entries) {
        const ids = new Set();
        entries.forEach(e => {
            if (e.kind !== "job") return;
            const c = C.unwrapCommand(e.command);
            if (c) ids.add(c.id);
        });
        return ids;
    }

    /* A comment line right above a job (not from the Debian/Ubuntu template) is its note. */
    function noteFor(r, i) {
        if (i === 0 || i - 1 <= r.templateEnd) return null;
        const prev = r.entries[i - 1];
        if (prev.kind !== "raw") return null;
        const m = /^\s*#+\s*(\S.*)$/.exec(prev.line);
        return m ? m[1].trim() : null;
    }

    /* The timer a job was converted to: its line is off and the conversion's note is
       right above it (see SD.convertNote). Else null. */
    function convertedTo(r, i) {
        const e = r.entries[i];
        if (!e || e.kind !== "job" || e.enabled || i === 0 || r.entries[i - 1].kind !== "raw") return null;
        const note = SD.parseConvertNote(r.entries[i - 1].line);
        return note ? note.name : null;
    }

    /* cronie runs a job in CRON_TZ when the crontab sets it above the job;
       Debian's cron does not know CRON_TZ. */
    function jobTz(entries, index) {
        if (state.basics.flavor !== "cronie") return state.tz;
        const tz = C.envBefore(entries, index).CRON_TZ;
        return tz && C.validTimeZone(tz) ? tz : state.tz;
    }

    function runsOf(id) {
        return state.runs.status === "ok" ? (state.runs.byId[id] || { runs: [], running: [] }) : null;
    }

    /* ---------- loading ---------- */

    /* Loading and saving exclude each other: requestLoad waits for a running save,
       commit refuses while loading. */
    let loading = false;
    let loadPending = false;

    function requestLoad() {
        if (loading || state.busy) { loadPending = true; return; }
        loading = true;
        closeMenu(false);
        load().catch(ex => console.error(ex)).finally(() => {
            loading = false;
            renderAll();
            if (loadPending && !state.busy) { loadPending = false; requestLoad(); }
        });
    }

    async function load() {
        state.suAtLoad = superuser ? superuser.Current : undefined;
        if (state.root.status !== "ok") state.root = { status: "loading" };
        renderAll();
        const basics = await readBasics().catch(() => null);
        if (basics) {
            if (basics.host) state.host = basics.host;
            state.tz = basics.tz || "UTC";
            state.basics = basics;
        }
        const [root, sys, runs, timers] = await Promise.allSettled([
            state.basics.crontab ? readRoot() : Promise.reject({ problem: "not-found" }),
            readSystem(state.basics.flavor),
            readRuns(),
            state.basics.systemd ? readTimers() : Promise.resolve(null),
        ]);
        if (root.status === "fulfilled") setRoot(root.value);
        else if (isDenied(root.reason)) state.root = { status: "denied" };
        else if (root.reason && root.reason.problem === "not-found") state.root = { status: "missing" };
        else state.root = { status: "error", message: errText(root.reason) };
        if (sys.status === "fulfilled") {
            state.sys = sys.value;
            state.sysError = null;
        } else {
            state.sys = null;
            state.sysError = errText(sys.reason);
        }
        if (runs.status === "fulfilled") state.runs = { status: "ok", byId: runs.value, rootVersion };
        else state.runs = { status: isDenied(runs.reason) ? "denied" : "error", byId: {} };
        if (timers.status === "fulfilled") state.timers = timers.value ? { status: "ok", list: timers.value } : { status: "none", list: [] };
        else state.timers = { status: "error", list: [], message: errText(timers.reason) };
        state.loadedAt = Date.now();
    }

    /* Only the recorded runs, e.g. after a manual run or every half minute. */
    let runsLoading = false;
    function refreshRuns() {
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
    function jobAt(entries, i, line) {
        const e = entries[i];
        return e && e.kind === "job" && e.line === line ? e : null;
    }

    /* base: the state shown, which the change refers to (kept when a dialog opens or a
       switch is clicked). mutate: entries -> new entries, or null when the line no
       longer fits. opts.quiet: no success message (the caller reports); opts.timer: a
       systemd timer to enable and start in the same step, or to stop and disable with
       opts.stopTimer (see SAVE_SCRIPT).
       Result: { ok, unchanged?, conflict?, error?, timerFailed?, backup?, saved? } */
    async function commit(base, mutate, okTitle, opts) {
        opts = opts || {};
        if (state.busy) return { ok: false, error: T.stillBusy };
        if (loading) return { ok: false, error: T.stillLoading };
        if (state.root.status !== "ok") return { ok: false, conflict: true };
        if (!base || base.status !== "ok" || base.locked || (base !== state.root && base.text !== state.root.text))
            return conflict();
        const entries = mutate(base.entries);
        if (!entries) return conflict();
        const next = C.serializeUserCrontab(entries);
        if (next === C.normalizeText(base.text)) return { ok: true, unchanged: true };

        state.busy = true;
        closeMenu(false);
        renderAll();
        try {
            let backup;
            try {
                backup = await saveRoot(base.text, next, opts.timer, opts.stopTimer);
            } catch (ex) {
                if (isDenied(ex)) { state.root = { status: "denied" }; return { ok: false, conflict: true }; }
                if (ex && ex.exit_status === 3) {
                    try { setRoot(await readRoot()); } catch (_) { loadPending = true; }
                    return conflict();
                }
                if (ex && ex.exit_status === 4) return { ok: false, error: T.lockBusy };
                if (ex && ex.exit_status === 5)
                    return { ok: false, error: T.backupFailed + (errText(ex) ? "\n" + errText(ex) : "") };
                if (ex && ex.exit_status === 7) return { ok: false, error: errText(ex), timerFailed: true };
                return { ok: false, error: errText(ex) };
            }
            const saved = backup ? T.backupAt(codeSafe(backup)) : T.noBackup;
            let after = null;
            try { after = await readRoot(); } catch (_) { loadPending = true; }
            if (after !== null) setRoot(after);
            if (after === null || C.normalizeText(after.text) !== next) {
                showAlert("warning", T.unverifiedTitle, [rich(T.unverifiedBody), " ", rich(saved)]);
            } else if (!opts.quiet) {
                showAlert("success", okTitle, saved);
            }
            return { ok: true, backup, saved };
        } finally {
            state.busy = false;
            state.loadedAt = Date.now();
            renderAll();
            if (loadPending) { loadPending = false; requestLoad(); }
        }
    }

    function conflict() {
        showAlert("warning", T.conflictTitle, T.conflictBody);
        if (state.root.status === "ok" && !loading && !state.busy) renderRoot();
        return { ok: false, conflict: true };
    }

    function reportResult(res) {
        if (res.error) showAlert("danger", T.saveErrorTitle, res.error);
        if (!res.ok) renderRoot();
    }

    async function toggle(i, enabled) {
        const base = state.root;
        const line = base.entries && base.entries[i] ? base.entries[i].line : null;
        const res = await commit(base, entries => {
            const e = jobAt(entries, i, line);
            if (!e) return null;
            const copy = entries.slice();
            copy[i] = C.setEnabled(e, enabled);
            return copy;
        }, enabled ? T.okEnabled : T.okDisabled);
        reportResult(res);
        if (res.ok) refreshRuns();
        restoreFocus("toggle:" + i);
    }

    /* Turns recording on or off for one job. Off also deletes its recorded runs. */
    async function setCapture(i, on, focusKey, shownBase) {
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

    /* ---------- alerts ---------- */

    const ALERT_ICON = { success: "check-circle", warning: "exclamation-triangle", danger: "exclamation-circle", info: "info-circle" };

    function alertEl(kind, title, body, actions) {
        return h("div", { class: "az-alert az-alert--" + kind, role: kind === "danger" ? "alert" : "status" },
            h("span", { class: "az-alert__icon" }, icon(ALERT_ICON[kind])),
            h("p", { class: "az-alert__title" }, rich(title)),
            body ? h("p", { class: "az-alert__body" }, rich(body)) : null,
            actions ? h("div", { class: "az-alert__actions" }, actions) : null);
    }

    function showAlert(kind, title, body) {
        fill($("alerts"), alertEl(kind, title, body));
    }
    function clearAlerts() { fill($("alerts")); }

    /* Lasting notes about the server: no mail program, cron not running, run recorder. */
    function renderNotices() {
        const b = state.basics;
        const out = [];
        const capturedJobs = rootJobs().filter(({ e }) => {
            const c = jobInfo(e).capture;
            return c && c.path === C.WRAPPER_PATH;
        });
        if (b.cron && !b.cron.active) {
            out.push(alertEl("warning", T.cronDownTitle, T.cronDownBody, b.cron.unit && b.systemd
                ? h("button", { class: "az-btn az-btn--link", type: "button",
                                onclick: () => cockpit.jump("/system/services#/" + encodeURIComponent(b.cron.unit), cockpit.transport.host) },
                    T.openServices)
                : null));
        }
        if (capturedJobs.length && b.wrapper === "missing") {
            out.push(alertEl("danger", T.wrapperMissingTitle, T.wrapperMissingBody(capturedJobs.length, C.WRAPPER_PATH),
                h("button", { class: "az-btn az-btn--secondary", type: "button", id: "wrapper-install",
                              disabled: state.busy || loading, onclick: () => repairWrapper() }, T.install)));
        } else if (typeof b.wrapper === "number" && b.wrapper < C.WRAPPER_VERSION) {
            out.push(alertEl("warning", T.wrapperOldTitle, T.wrapperOldBody(C.WRAPPER_PATH),
                h("button", { class: "az-btn az-btn--secondary", type: "button", id: "wrapper-install",
                              disabled: state.busy || loading, onclick: () => repairWrapper() }, T.update)));
        }
        if (b.mta === false && state.root.status === "ok" && !state.root.mailto) {
            out.push(alertEl("info", T.noMtaTitle, T.noMtaBody));
        }
        fill($("notices"), out);
    }

    async function repairWrapper() {
        const btn = $("wrapper-install");
        if (btn) btn.disabled = true;
        try {
            await installWrapper();
            showAlert("success", T.wrapperInstalled, T.wrapperInstalledBody(C.WRAPPER_PATH));
        } catch (ex) {
            showAlert("danger", T.wrapperFailed, errText(ex));
        }
        renderNotices();
    }

    /* ---------- rendering ---------- */

    function renderAll() {
        renderHeader();
        renderNotices();
        renderTimeline();
        renderRoot();
        renderOrphans();
        renderTimers();
        renderSystem();
        renderOrphansDialog();
    }

    function renderHeader() {
        fill($("page-desc"), T.pageDesc(state.host));
        $("sig-host").textContent = state.host;
        $("sig-host").hidden = !state.host;
        const meta = [];
        if (state.loadedAt) meta.push(T.loadedAt(fmtClock(state.loadedAt)));
        if (state.sys) meta.push(T.serverTz(tzLabel(state.tz)));
        $("meta").textContent = meta.join(" · ");
        $("reload").disabled = state.busy || loading;
    }

    function describe(schedule) {
        return C.describe(schedule, S) || S.custom;
    }

    function scheduleCell(schedule, tz) {
        return h("div", { class: "cron-cell" },
            h("span", null, describe(schedule)),
            h("span", { class: "az-cell-sub az-mono" }, schedule + (tz && tz !== state.tz ? " · " + tzLabel(tz) : "")));
    }

    function nextCell(e, i) {
        if (!e.enabled) return h("span", { class: "cron-muted" }, "—");
        const p = C.parseSchedule(e.schedule);
        if (p.reboot) return h("span", null, T.nextBoot);
        const ms = C.nextRun(p, Date.now(), jobTz(state.root.entries, i));
        if (ms === null) return h("span", null, T.neverRuns);
        return whenCell(ms);
    }

    function whenCell(ms) {
        const sub = [fmtRelative(ms), fmtLocal(ms)].filter(Boolean).join(" · ");
        return h("div", { class: "cron-cell" },
            h("span", null, cap(fmtWhen(ms))),
            h("span", { class: "az-cell-sub" }, sub));
    }

    /* Result label of a run: { kind, icon, text } */
    function runLabel(r) {
        const o = R.outcome(r);
        if (o === "ok") return { kind: "success", icon: "check-circle", text: T.statusOk };
        if (o === "failed") return { kind: "danger", icon: "exclamation-circle", text: T.statusFailed(r.rc) };
        return { kind: "warning", icon: "exclamation-triangle", text: T.statusAborted };
    }

    /* A status label; with attrs it is a button that wraps the label. */
    function labelEl(kind, iconName, text, attrs) {
        const label = h("span", { class: "az-label az-label--" + kind }, iconName ? icon(iconName) : null, text);
        return attrs ? h("button", Object.assign({ type: "button", class: "cron-label-btn" }, attrs), label) : label;
    }

    function lastCell(e, i, editable, frozen) {
        const info = jobInfo(e);
        if (!info.capture) {
            if (!e.enabled) return h("span", { class: "cron-muted" }, "—");
            const can = editable && C.canCapture(info.command);
            return h("div", { class: "cron-cell" },
                h("span", { class: "cron-muted" }, T.notRecorded),
                can ? h("button", { class: "az-btn az-btn--link cron-inline-link", type: "button", disabled: frozen,
                                    "data-key": "capture:" + i, "aria-describedby": "cmd-" + i,
                                    onclick: () => setCapture(i, true, "capture:" + i) }, T.recordLink) : null);
        }
        const job = runsOf(info.capture.id);
        if (!job) return h("span", { class: "cron-muted" }, "—");
        const open = { "data-key": "runs:" + i, "aria-describedby": "cmd-" + i, title: T.showRuns,
                       onclick: () => openRuns(i, "runs:" + i) };
        if (job.running.length) {
            const start = Math.min.apply(null, job.running.map(r => r.start)) * 1000;
            return h("div", { class: "cron-cell" },
                h("span", null, labelEl("info", "sync-alt", T.statusRunning, open)),
                h("span", { class: "az-cell-sub" }, T.runningSince(clock(start), fmtDuration((Date.now() - start) / 1000))));
        }
        const last = job.runs[0];
        if (!last) return h("span", { class: "cron-muted" }, T.noRunYet);
        const l = runLabel(last);
        const d = R.duration(last);
        return h("div", { class: "cron-cell" },
            h("span", null, labelEl(l.kind, l.icon, l.text, open)),
            h("span", { class: "az-cell-sub" }, fmtShort(last.start * 1000) + (d !== null ? " · " + fmtDuration(d) : "")));
    }

    function renderRoot() {
        const body = $("root-body");
        const r = state.root;
        const jobs = rootJobs();
        const editable = r.status === "ok" && !r.locked;
        const add = $("add");
        add.hidden = !(editable && jobs.length > 0);
        const frozen = state.busy || loading;
        add.disabled = frozen;

        if (r.status === "loading") {
            fill(body, h("p", { class: "cron-state" }, T.loading));
            return;
        }
        if (r.status === "denied") {
            fill(body, h("div", { class: "az-empty" },
                h("span", { class: "az-empty__icon" }, icon("info-circle")),
                h("h3", { class: "az-empty__title" }, T.deniedTitle),
                h("p", { class: "az-empty__body" }, rich(T.deniedBody))));
            return;
        }
        if (r.status === "missing") {
            fill(body, h("div", { class: "cron-card-alert" }, alertEl("warning", T.noCrontabTitle, T.noCrontabBody)));
            return;
        }
        if (r.status === "error") {
            fill(body, h("div", { class: "cron-card-alert" },
                alertEl("danger", T.readErrorTitle, r.message,
                        h("button", { class: "az-btn az-btn--link", type: "button", onclick: () => requestLoad() }, T.retry))));
            return;
        }
        if (jobs.length === 0) {
            fill(body, h("div", { class: "az-empty" },
                h("span", { class: "az-empty__icon" }, icon("clock")),
                h("h3", { class: "az-empty__title" }, T.emptyTitle),
                h("p", { class: "az-empty__body" }, T.emptyBody),
                editable ? h("div", { class: "az-empty__actions" },
                    h("button", { class: "az-btn az-btn--primary", type: "button", "data-key": "add-empty",
                                  disabled: frozen, onclick: () => openEdit(null, "add-empty") },
                      icon("plus"), T.add)) : null));
            return;
        }

        const rows = jobs.map(({ e, i }) => {
            const cmdId = "cmd-" + i;
            const note = noteFor(r, i);
            const timer = convertedTo(r, i);
            const info = jobInfo(e);
            const toggleCell = editable
                ? h("label", { class: "az-switch" },
                    h("input", { type: "checkbox", role: "switch", checked: e.enabled, disabled: frozen,
                                 "aria-describedby": cmdId, "data-key": "toggle:" + i,
                                 onchange: ev => toggle(i, ev.target.checked) }),
                    h("span", { class: "az-switch__track" }),
                    h("span", { class: "az-sr" }, T.activeSr))
                : h("span", { class: "cron-muted" }, e.enabled ? T.on : T.off);
            const btn = (key, label, iconName, onclick, extra) => h("button", Object.assign({
                class: "az-btn az-btn--plain az-btn--sm", type: "button", "aria-label": label, title: label,
                "aria-describedby": cmdId, disabled: frozen, "data-key": key + ":" + i, onclick }, extra || {}), icon(iconName));
            return h("tr", { class: e.enabled ? null : "is-off" },
                h("td", { class: "az-cell-toggle", "data-label": T.colActive }, toggleCell),
                h("td", { class: "az-nowrap", "data-label": T.colSchedule }, scheduleCell(e.schedule, jobTz(r.entries, i))),
                h("td", { class: "az-nowrap", "data-label": T.colNext, "data-next": i }, nextCell(e, i)),
                h("td", { class: "az-nowrap", "data-label": T.colLast, "data-last": i }, lastCell(e, i, editable, frozen)),
                h("td", { "data-label": T.colCommand },
                    h("div", { class: "cron-cell" },
                        h("span", { class: "az-mono", id: cmdId }, info.command),
                        timer ? h("span", { class: "az-cell-sub" }, T.convertedTo, " ",
                            h("button", { class: "az-btn az-btn--link cron-inline-link", type: "button", "data-key": "timer:" + i,
                                          title: T.openInCockpit(timer + ".timer"), onclick: () => jumpToUnit(timer + ".timer") },
                              timer + ".timer"))
                            : note ? h("span", { class: "az-cell-sub" }, note) : null)),
                h("td", { class: "az-cell-actions" },
                    r.notUtf8 ? null : btn("run", T.actRun, "play", () => openRun(i, "run:" + i)),
                    editable ? btn("edit", T.actEdit, "pencil-alt", () => openEdit(i, "edit:" + i)) : null,
                    menuItems(i).length ? btn("more", T.actMore, "ellipsis-v", ev => openRowMenu(i, ev.currentTarget),
                        { "aria-haspopup": "menu", "aria-expanded": "false" }) : null));
        });

        const head = h("tr", null,
            h("th", { class: "cron-col-toggle", scope: "col" }, T.colActive),
            h("th", { scope: "col" }, T.colSchedule),
            h("th", { scope: "col" }, T.colNext),
            h("th", { scope: "col" }, T.colLast),
            h("th", { scope: "col" }, T.colCommand),
            h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.colActions)));

        fill(body,
            r.locked ? h("div", { class: "cron-card-alert" },
                alertEl("warning", T.lockedTitle, r.notUtf8 ? T.lockedEncodingBody : T.lockedBody)) : null,
            h("div", { class: "az-card__body--flush az-table-wrap" },
                h("table", { class: "az-table az-table--stack cron-root-table" }, h("thead", null, head), h("tbody", null, rows))));
    }

    function updateNextRuns() {
        const r = state.root;
        if (r.status !== "ok") return;
        document.querySelectorAll("td[data-next]").forEach(td => {
            const e = r.entries[+td.dataset.next];
            if (e && e.kind === "job") fill(td, nextCell(e, +td.dataset.next));
        });
        document.querySelectorAll("td[data-timer-next]").forEach(td => {
            const t = state.timers.list[+td.dataset.timerNext];
            if (t) fill(td, timerNextCell(t));
        });
    }

    function updateLastRuns() {
        const r = state.root;
        if (r.status !== "ok" || state.busy || loading) return;
        const editable = !r.locked;
        const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
        document.querySelectorAll("td[data-last]").forEach(td => {
            const i = +td.dataset.last;
            const e = r.entries[i];
            if (e && e.kind === "job") fill(td, lastCell(e, i, editable, false));
        });
        renderOrphans();
        if (focused && !document.activeElement.isConnected) restoreFocus(focused);
        renderNotices();
    }

    /* ---------- timeline ---------- */

    /* Rows of everything that runs in (from, to]: { name, src, kind, runs, band } */
    function timelineRows(from, to) {
        const rows = [];
        const addCron = (name, src, schedule, group, tz) => {
            const p = C.parseSchedule(schedule);
            if (!p.ok || p.reboot) return;
            const runs = C.runsBetween(p, from, to, tz || state.tz, 25);
            if (!runs.length) return;
            rows.push({ name, src: src + " · " + lowerFirst(describe(schedule)), kind: "cron", runs,
                        band: runs.length > 24, group });
        };
        rootJobs().forEach(({ e, i }) => {
            if (e.enabled) addCron(C.jobName(jobInfo(e).command), T.srcRoot, e.schedule, 0, jobTz(state.root.entries, i));
        });
        if (state.sys) {
            state.sys.etc.forEach(j => addCron(C.jobName(j.command), "/etc/crontab", j.schedule, 1));
            state.sys.crond.forEach(j => { if (!j.ignored) addCron(j.file, "/etc/cron.d", j.schedule, 2); });
            state.sys.users.forEach(j => { if (j.enabled) addCron(C.jobName(j.command), T.srcUser(j.user), j.schedule, 3, j.tz); });
        }
        state.timers.list.forEach(t => {
            if (!t.active) return;
            const runs = t.runs.filter(ms => ms > from && ms <= to);
            if (!runs.length && !t.band) return;
            const what = t.randomizedUsec ? T.randomizedShort : lowerFirst(SD.describeTimer(t, S));
            rows.push({ name: t.name, src: T.srcTimer + " · " + what, kind: "timer", runs, band: !!t.band, group: 4 });
        });
        rows.sort((a, b) => a.group - b.group || (a.runs[0] || 0) - (b.runs[0] || 0) || a.name.localeCompare(b.name));
        return rows;
    }

    /* Starts in the same minute (rows that run more often than hourly are left out). */
    function overlaps(rows) {
        const byMinute = new Map();
        rows.forEach(row => {
            if (row.band) return;
            row.runs.forEach(ms => {
                const key = Math.floor(ms / 60000);
                if (!byMinute.has(key)) byMinute.set(key, new Set());
                byMinute.get(key).add(row.name);
            });
        });
        return Array.from(byMinute.entries()).filter(([, names]) => names.size >= 2)
            .sort((a, b) => b[1].size - a[1].size || a[0] - b[0])
            .slice(0, 2)
            .sort((a, b) => a[0] - b[0])
            .map(([minute, names]) => ({ ms: minute * 60000, names: Array.from(names) }));
    }

    function renderTimeline() {
        const card = $("tl-card");
        const body = $("tl-body");
        const ready = state.root.status !== "loading" && (state.sys || state.timers.list.length);
        card.hidden = !ready;
        if (!ready) return;
        const from = Date.now();
        const to = from + DAY;
        const rows = timelineRows(from, to);
        const pct = ms => ((ms - from) / DAY * 100).toFixed(3) + "%";
        const place = (el, ms) => { el.style.insetInlineStart = pct(ms); return el; };

        if (!rows.length) {
            fill(body, h("p", { class: "cron-state" }, T.tlEmpty));
            return;
        }

        /* Ticks every two hours, midnight with the weekday. */
        const ticks = [];
        const midnights = [];
        for (let t = Math.ceil(from / 900000) * 900000; t <= to; t += 900000) {
            const w = C.wallParts(t, state.tz);
            if (w.mi !== 0) continue;
            if (w.h === 0) midnights.push(t);
            if (w.h % 2) continue;
            const label = (w.h === 0 ? weekdayShort(t, state.tz) + " " : "") + pad2(w.h) + ":00";
            ticks.push({ t, label, minor: w.h % 6 !== 0 });
        }

        const scale = h("div", { class: "cron-tl-scale", "aria-hidden": "true" },
            h("span"),
            h("div", { class: "cron-tl-ticks" },
                ticks.map(k => place(h("span", { class: "cron-tl-tick" + (k.minor ? " is-minor" : "") }, k.label), k.t))));

        const grid = h("div", { class: "cron-tl-grid", "aria-hidden": "true" },
            ticks.map(k => place(h("span", { class: "cron-tl-line" }), k.t)),
            midnights.map(t => place(h("span", { class: "cron-tl-midnight" }), t)),
            h("span", { class: "cron-tl-now" }));

        const list = h("ul", { class: "cron-tl-rows", "aria-label": T.tlTitle },
            rows.map(row => {
                const times = row.band ? row.src : row.runs.slice(0, 6).map(ms => clock(ms)).join(", ") +
                    (row.runs.length > 6 ? " " + T.tlMore(row.runs.length - 6) : "");
                return h("li", { class: "cron-tl-row" },
                    h("div", { class: "cron-tl-label" },
                        h("span", { class: "cron-tl-name az-mono", title: row.name }, row.name),
                        h("span", { class: "cron-tl-src", title: row.src }, row.src),
                        h("span", { class: "az-sr" }, ": " + times)),
                    h("div", { class: "cron-tl-track", "aria-hidden": "true" },
                        row.band ? h("span", { class: "cron-tl-band" + (row.kind === "timer" ? " is-timer" : "") }) : null,
                        row.band ? null : row.runs.map(ms => place(h("span", {
                            class: "cron-tl-mark" + (row.kind === "timer" ? " is-timer" : ""),
                            title: clock(ms) + " · " + row.name }), ms))));
            }));

        const hints = overlaps(rows).map(o => h("p", { class: "cron-tl-hint" }, icon("info-circle"),
            h("span", null, rich(T.tlOverlap(clock(o.ms), joinList(o.names.map(n => "`" + codeSafe(n) + "`")))))));

        fill(body, scale, h("div", { class: "cron-tl-body" }, grid, list), hints);
    }

    /* ---------- systemd timers ---------- */

    function jumpToUnit(unit) {
        cockpit.jump("/system/services#/" + encodeURIComponent(unit), cockpit.transport.host);
    }

    function timerNextCell(t) {
        if (!t.active) return h("span", { class: "cron-muted" }, T.timerInactive);
        if (t.next === null) return h("span", { class: "cron-muted" }, "—");
        return whenCell(t.next);
    }

    function timerLastCell(t) {
        if (t.running) return h("div", { class: "cron-cell" }, h("span", null, labelEl("info", "sync-alt", T.statusRunning)));
        if (t.last === null) return h("span", { class: "cron-muted" }, T.noRunYet);
        let label = null;
        if (t.result === "success") label = labelEl("success", "check-circle", T.statusOk);
        else if (t.result === "exit-code" && t.status !== null) label = labelEl("danger", "exclamation-circle", T.statusFailed(t.status));
        else if (t.result) label = labelEl("danger", "exclamation-circle", T.statusResult(t.result));
        const dur = t.startUs !== null && t.exitUs !== null && t.exitUs >= t.startUs ? (t.exitUs - t.startUs) / 1000 : null;
        return h("div", { class: "cron-cell" },
            label ? h("span", null, label) : null,
            h("span", { class: label ? "az-cell-sub" : null }, fmtShort(t.last) + (dur !== null ? " · " + fmtDuration(dur) : "")));
    }

    function renderTimers() {
        const card = $("timers-card");
        const tm = state.timers;
        card.hidden = tm.status === "none" || (tm.status === "ok" && tm.list.length === 0);
        if (card.hidden) return;
        if (tm.status === "error") {
            fill($("timers-body"), h("div", { class: "cron-card-alert" }, alertEl("warning", T.timersErrorTitle, tm.message)));
            return;
        }
        fill($("timers-body"), h("div", { class: "az-card__body--flush az-table-wrap" },
            h("table", { class: "az-table az-table--stack" },
                h("thead", null, h("tr", null,
                    h("th", { scope: "col" }, T.colTimer),
                    h("th", { scope: "col" }, T.colSchedule),
                    h("th", { scope: "col" }, T.colNext),
                    h("th", { scope: "col" }, T.colLast),
                    h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.colActions)))),
                h("tbody", null, tm.list.map((t, k) => {
                    const ours = / \(from the root crontab\)$/.test(t.description || "");
                    const specs = t.calendar.concat(t.monotonic.map(m => m.base.replace(/USec$/, "Sec") + "=" + SD.formatSpan(m.usec)));
                    const sub = specs.join(" · ") + (t.randomizedUsec ? " · " + T.randomUpTo(SD.formatSpan(t.randomizedUsec)) : "");
                    return h("tr", { class: t.active ? null : "is-off" },
                        h("td", { class: "az-nowrap", "data-label": T.colTimer },
                            h("div", { class: "cron-cell" },
                                h("span", { class: "az-mono" }, t.name),
                                h("span", { class: "az-cell-sub" }, ours ? T.fromCrontab : t.description))),
                        h("td", { "data-label": T.colSchedule },
                            h("div", { class: "cron-cell" },
                                h("span", null, SD.describeTimer(t, S)),
                                sub ? h("span", { class: "az-cell-sub az-mono" }, sub) : null)),
                        h("td", { class: "az-nowrap", "data-label": T.colNext, "data-timer-next": k }, timerNextCell(t)),
                        h("td", { class: "az-nowrap", "data-label": T.colLast }, timerLastCell(t)),
                        h("td", { class: "az-cell-actions" },
                            h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "aria-label": T.openInCockpit(t.name),
                                          title: T.openInCockpit(t.name),
                                          onclick: () => jumpToUnit(t.name) },
                              icon("external-link-alt"))));
                })))));
    }

    /* ---------- read-only crontabs ---------- */

    function readOnlyTable(cols, rows) {
        return h("div", { class: "az-card__body--flush az-table-wrap" },
            h("table", { class: "az-table az-table--stack" },
                h("thead", null, h("tr", null, cols.map(c => h("th", { scope: "col" }, c)))),
                h("tbody", null, rows)));
    }

    function emptyState() { return h("p", { class: "cron-state" }, T.noEntries); }

    function renderSystem() {
        const sys = state.sys;
        ["etc-card", "crond-card", "users-card", "periodic-card"].forEach(id => { $(id).hidden = !sys; });
        fill($("sys-alerts"), !sys && state.sysError !== null
            ? alertEl("warning", T.sysErrorTitle, state.sysError) : null);
        if (!sys) return;

        fill($("etc-body"), sys.etc.length === 0 ? emptyState() : readOnlyTable(
            [T.colSchedule, T.colUser, T.colCommand],
            sys.etc.map(j => h("tr", null,
                h("td", { class: "az-nowrap", "data-label": T.colSchedule }, scheduleCell(j.schedule)),
                h("td", { class: "az-nowrap", "data-label": T.colUser }, j.user),
                h("td", { "data-label": T.colCommand }, h("span", { class: "az-mono" }, j.command))))));

        fill($("crond-body"), sys.crond.length === 0 ? emptyState() : readOnlyTable(
            [T.colFile, T.colSchedule, T.colUser, T.colCommand],
            sys.crond.map(j => h("tr", { class: j.ignored ? "is-off" : null },
                h("td", { class: "az-nowrap", "data-label": T.colFile },
                    h("div", { class: "cron-title-row" },
                        h("span", { class: "az-mono" }, j.file),
                        j.ignored ? h("span", { class: "az-label az-label--warning",
                                                title: j.ignored === "name" ? T.ignoredHint : T.ignoredOwner }, T.ignored) : null)),
                h("td", { class: "az-nowrap", "data-label": T.colSchedule }, scheduleCell(j.schedule)),
                h("td", { class: "az-nowrap", "data-label": T.colUser }, j.user),
                h("td", { "data-label": T.colCommand }, h("span", { class: "az-mono" }, j.command))))));

        $("users-card").hidden = sys.users.length === 0;
        fill($("users-body"), readOnlyTable(
            [T.colUser, T.colSchedule, T.colCommand],
            sys.users.map(j => h("tr", { class: j.enabled ? null : "is-off" },
                h("td", { class: "az-nowrap", "data-label": T.colUser }, j.user),
                h("td", { class: "az-nowrap", "data-label": T.colSchedule }, scheduleCell(j.schedule)),
                h("td", { "data-label": T.colCommand }, h("span", { class: "az-mono" }, j.command))))));

        $("periodic-card").hidden = sys.periodic.length === 0;
        fill($("periodic-body"), readOnlyTable(
            [T.colDir, T.colScripts],
            sys.periodic.map(p => h("tr", null,
                h("td", { class: "az-nowrap", "data-label": T.colDir }, h("span", { class: "az-mono" }, p.dir)),
                h("td", { "data-label": T.colScripts },
                    p.scripts.length === 0 ? h("span", { class: "cron-muted" }, T.none)
                        : h("div", { class: "cron-chips" }, p.scripts.map(s => h("span", { class: "az-label" }, s))))))));
    }

    /* ---------- focus ---------- */

    function restoreFocus(key) {
        let el = key ? document.querySelector('[data-key="' + key + '"]') : null;
        if (!el || el.disabled || el.closest("[hidden]")) {
            const m = key ? /^[a-z-]+:(\d+)$/.exec(key) : null;
            if (m) el = document.querySelector('[data-key="more:' + m[1] + '"]');
        }
        if (!el || el.disabled || el.closest("[hidden]")) {
            el = [$("add"), document.querySelector('[data-key="add-empty"]'), $("page-title")]
                .find(x => x && !x.disabled && !x.closest("[hidden]"));
        }
        if (el) el.focus();
    }

    /* ---------- row menu ---------- */

    let menu = null;   /* { el, button, onDoc } */

    function closeMenu(focusButton) {
        if (!menu) return;
        const m = menu;
        menu = null;
        m.el.remove();
        m.button.setAttribute("aria-expanded", "false");
        document.removeEventListener("mousedown", m.onDoc, true);
        window.removeEventListener("resize", m.onResize);
        if (focusButton && m.button.isConnected) m.button.focus();
    }

    function menuItems(i) {
        const r = state.root;
        const e = r.entries[i];
        const info = jobInfo(e);
        const editable = r.status === "ok" && !r.locked;
        const items = [];
        if (info.capture) items.push({ label: T.showRuns, icon: "history", action: () => openRuns(i, "more:" + i) });
        if (editable) {
            if (info.capture) {
                items.push({ label: T.captureOff, action: () => openCaptureOff(i, "more:" + i) });
            } else {
                const can = C.canCapture(info.command);
                items.push({ label: T.captureOn, icon: "history", disabled: !can, hint: can ? null : T.cannotCapture,
                             action: () => setCapture(i, true, "more:" + i) });
            }
            if (state.basics.systemd && convertedTo(r, i)) {
                items.push({ label: T.backToCron, icon: "exchange-alt", action: () => openBack(i, "more:" + i) });
            } else if (state.basics.systemd && state.timers.status === "ok") {
                const why = convertBlocker(e, info, i);
                items.push({ label: T.convert, icon: "exchange-alt", disabled: !!why, hint: why,
                             action: () => openConvert(i, "more:" + i) });
            }
            items.push("sep");
            items.push({ label: T.actDelete, icon: "trash", danger: true, action: () => openDelete(i, "more:" + i) });
        }
        return items;
    }

    function openRowMenu(i, button) {
        if (menu && menu.button === button) { closeMenu(true); return; }
        closeMenu(false);
        const items = menuItems(i);
        if (!items.length) return;
        const el = h("div", { class: "cron-menu", role: "menu", "aria-label": T.actMore, id: "row-menu" },
            items.map(it => it === "sep" ? h("div", { class: "cron-menu__sep", role: "separator" })
                : h("button", {
                    type: "button", role: "menuitem", tabindex: "-1",
                    class: "cron-menu__item" + (it.danger ? " is-danger" : ""),
                    "aria-disabled": it.disabled ? "true" : null,
                    onclick: () => { if (it.disabled) return; closeMenu(false); it.action(); },
                }, it.icon ? icon(it.icon) : h("span", { class: "cron-menu__spacer" }),
                h("span", { class: "cron-menu__text" }, it.label,
                  it.hint ? h("span", { class: "cron-menu__hint" }, it.hint) : null))));
        document.body.append(el);
        const rect = button.getBoundingClientRect();
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        let left = rect.right - width;
        left = Math.max(8, Math.min(left, document.documentElement.clientWidth - width - 8));
        let top = rect.bottom + 4;
        if (top + height > window.innerHeight - 8 && rect.top - height - 4 > 8) top = rect.top - height - 4;
        el.style.left = (left + window.scrollX) + "px";
        el.style.top = (top + window.scrollY) + "px";

        const all = Array.from(el.querySelectorAll("[role=menuitem]"));
        const move = (from, step) => {
            const n = all.length;
            let k = from;
            for (let tries = 0; tries < n; tries++) {
                k = (k + step + n) % n;
                if (all[k].getAttribute("aria-disabled") !== "true") { all[k].focus(); return; }
            }
        };
        el.addEventListener("keydown", ev => {
            const cur = all.indexOf(document.activeElement);
            if (ev.key === "ArrowDown") { ev.preventDefault(); move(cur, 1); }
            else if (ev.key === "ArrowUp") { ev.preventDefault(); move(cur < 0 ? 0 : cur, -1); }
            else if (ev.key === "Home") { ev.preventDefault(); move(-1, 1); }
            else if (ev.key === "End") { ev.preventDefault(); move(0, -1); }
            else if (ev.key === "Escape") { ev.preventDefault(); closeMenu(true); }
            else if (ev.key === "Tab") { closeMenu(true); }
        });
        const onDoc = ev => {
            if (!el.contains(ev.target) && ev.target !== button && !button.contains(ev.target)) closeMenu(false);
        };
        const onResize = () => closeMenu(false);
        menu = { el, button, onDoc, onResize };
        document.addEventListener("mousedown", onDoc, true);
        window.addEventListener("resize", onResize);
        button.setAttribute("aria-expanded", "true");
        button.setAttribute("aria-controls", "row-menu");
        move(-1, 1);
    }

    /* ---------- dialogs ---------- */

    let dialog = null;   /* { kind, el, openerKey, … } */

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

    function openDialog(el, openerKey, info, focusEl) {
        closeMenu(false);
        dialog = Object.assign({ el, openerKey }, info);
        $("page").inert = true;
        el.hidden = false;
        document.addEventListener("keydown", onDialogKey, true);
        focusEl.focus();
    }

    function closeDialog(focusKey, force) {
        if (!dialog || (state.busy && !force) || dialog.locked) return;
        const key = focusKey || dialog.openerKey;
        if (dialog.onClose) dialog.onClose();
        dialog.el.hidden = true;
        dialog = null;
        $("page").inert = false;
        document.removeEventListener("keydown", onDialogKey, true);
        restoreFocus(key);
    }

    function dialogError(id, message, title) {
        const box = $(id);
        if (!message) { box.hidden = true; fill(box); return; }
        fill(box, alertEl("danger", title || T.saveErrorTitle, message));
        box.hidden = false;
    }

    /* Edit / add */

    const form = {
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
        const ms = C.nextRun(p, Date.now(), tz || state.tz);
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

    function updateForm(showAll) {
        const d = dialog && dialog.kind === "edit" ? dialog : null;
        const sched = checkSchedule(form.schedule().value, d ? d.tz : null);
        const cmd = checkCommand(form.command().value);
        const showSched = showAll || form.touched.schedule;
        const showCmd = showAll || form.touched.command;

        if (sched.ok) setFieldState(form.schedule(), $("f-schedule-help"), true, sched.help);
        else if (showSched || !sched.empty) setFieldState(form.schedule(), $("f-schedule-help"), false, sched.msg);
        else setFieldState(form.schedule(), $("f-schedule-help"), true, T.scheduleHelp);

        const capture = form.capture();
        const cmdHelp = state.basics.mta === false && !state.root.mailto
            ? (capture.checked && !capture.disabled ? T.commandHelpNoMtaRecorded : T.commandHelpNoMta)
            : state.root.mailto ? T.commandHelpMailto : T.commandHelp;
        if (!cmd.ok && (showCmd || !cmd.empty)) setFieldState(form.command(), $("f-command-help"), false, cmd.msg);
        else setFieldState(form.command(), $("f-command-help"), true, cmdHelp);

        const warn = $("f-command-warn");
        warn.hidden = !(cmd.ok && cmd.percent);
        if (!warn.hidden) fill(warn, icon("exclamation-triangle"), h("span", null, rich(T.percentWarn)));

        const blocked = cmd.ok && cmd.percent;
        capture.disabled = blocked;
        fill($("f-capture-help"), rich(blocked ? T.cannotCapture : T.captureHelp(C.WRAPPER_PATH)));
        return { sched, cmd };
    }

    function openEdit(index, openerKey) {
        if (state.busy || loading || state.root.status !== "ok" || state.root.locked) return;
        const base = state.root;
        const e = index === null ? null : base.entries[index];
        if (index !== null && (!e || e.kind !== "job")) return;
        const info = e ? jobInfo(e) : null;
        $("edit-title").textContent = e ? T.editTitle : T.addTitle;
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

    async function submitEdit(ev) {
        ev.preventDefault();
        if (!dialog || dialog.kind !== "edit" || state.busy) return;
        const { sched, cmd } = updateForm(true);
        if (!sched.ok) { form.schedule().focus(); return; }
        if (!cmd.ok) { form.command().focus(); return; }
        const d = dialog;
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
        if (res.ok && d.capture && !capture) await removeRunsIfUnused(d.capture.id);
        if (res.ok || res.conflict) {
            let key = d.openerKey;
            if (res.ok && index === null) {
                const jobs = rootJobs();
                if (jobs.length) key = "edit:" + jobs[jobs.length - 1].i;
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
    function openDelete(index, openerKey) {
        if (state.busy || loading || state.root.status !== "ok" || state.root.locked) return;
        const base = state.root;
        const e = base.entries[index];
        if (!e || e.kind !== "job") return;
        const info = jobInfo(e);
        const hasNote = noteFor(base, index) !== null;
        const noteIndex = hasNote ? index - 1 : null;
        const noteLine = hasNote ? base.entries[index - 1].line : null;
        $("del-intro").textContent = hasNote ? T.delIntroNote : T.delIntro;
        $("del-line").textContent = (hasNote ? noteLine + "\n" : "") + e.schedule + "  " + info.command;
        fill($("del-backup"), rich(T.delBackup(BACKUP_DIR + "/")));
        $("del-runs").hidden = !info.capture;
        fill($("del-runs"), rich(T.delRuns));
        dialogError("del-alert", null);
        setBusyButton($("del-confirm"), false, T.deleting);
        openDialog($("del-dlg"), openerKey, { kind: "delete", index, base, line: e.line, noteIndex, noteLine,
                                               capture: info.capture }, $("del-cancel"));
    }

    async function confirmDelete() {
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
        if (res.ok && capture) await removeRunsIfUnused(capture.id);
        if (res.ok) refreshRuns();
        if (res.ok || res.conflict) {
            const jobs = rootJobs();
            const first = noteIndex !== null ? noteIndex : index;
            const next = jobs.find(x => x.i >= first) || jobs[jobs.length - 1];
            closeDialog(next ? "more:" + next.i : "add");
        } else if (res.error) {
            dialogError("del-alert", res.error);
            $("del-confirm").focus();
        }
    }

    /* Confirm turning recording off */
    function openCaptureOff(index, openerKey) {
        if (state.busy || loading || state.root.status !== "ok" || state.root.locked) return;
        const base = state.root;
        const e = base.entries[index];
        if (!e || e.kind !== "job" || !jobInfo(e).capture) return;
        $("confirm-title").textContent = T.captureOffTitle;
        fill($("confirm-body"), rich(T.captureOffBody));
        $("confirm-ok").textContent = T.captureOff;
        openDialog($("confirm-dlg"), openerKey, {
            kind: "confirm",
            action: () => setCapture(index, false, openerKey, base),
        }, $("confirm-cancel"));
    }

    function confirmOk() {
        if (!dialog || dialog.kind !== "confirm") return;
        const action = dialog.action;
        closeDialog();
        action();
    }

    /* ---------- run now ---------- */

    /* Starts the command in its own process group, so that "Stop" (SIGTERM from
       Cockpit to this shell) reaches everything the job started. Only the job gets
       the cron environment; this script keeps Cockpit's, so it finds its tools.
       $1 working directory, $2 shell, $3 command, then NAME=value for the job;
       standard input is passed on. */
    const RUN_SCRIPT = `cd "$1" 2>/dev/null || cd /
sh=$2
cmd=$3
shift 3
w=
if setsid -w true > /dev/null 2>&1; then w=-w; fi
exec 3<&0
setsid $w env -i "$@" "$sh" -c "$cmd" <&3 3<&- &
pid=$!
exec 3<&-
trap 'kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null' TERM INT HUP
while :; do
  wait "$pid"
  rc=$?
  kill -0 "$pid" 2>/dev/null || break
done
exit "$rc"
`;

    let run = null;   /* { phase, proc, output, started, ended, rc, signal, stopped, error, timer, … } */

    /* cron's environment for the job; a recorded job is marked as started by hand. */
    function runEnvironment(entries, index, recorded) {
        const env = SD.jobEnvironment(C.envBefore(entries, index), null);
        if (recorded) env.CRONJOBS_TRIGGER = "manual";
        return env;
    }

    function openRun(index, openerKey) {
        if (state.root.status !== "ok") return;
        const base = state.root;
        const e = base.entries[index];
        if (!e || e.kind !== "job") return;
        const info = jobInfo(e);
        const env = runEnvironment(base.entries, index, !!info.capture);
        const cron = C.cronCommand(e.command);
        run = { phase: "confirm", index, command: e.command, shown: info.command, capture: info.capture,
                env, cron, proc: null, output: "", cut: false, started: 0, ended: 0, rc: null, signal: null,
                stopped: false, error: null, timer: null, raf: 0 };
        renderRunDialog();
        openDialog($("run-dlg"), openerKey, {
            kind: "run",
            onEscape: () => { if (run && run.phase !== "running") closeDialog(); },
            onClose: () => { if (run && run.timer) window.clearInterval(run.timer); run = null; },
        }, $("run-start"));
    }

    function startRun() {
        if (!run || run.phase === "running") return;
        const env = run.env;
        const argv = ["/bin/sh", "-c", RUN_SCRIPT, "cockpit-cronjobs-run", env.HOME || "/", env.SHELL || "/bin/sh",
                      run.cron.command].concat(Object.keys(env).map(k => k + "=" + env[k]));
        Object.assign(run, { phase: "running", output: "", cut: false, started: Date.now(), ended: 0, rc: null,
                             signal: null, stopped: false, error: null });
        dialog.locked = true;
        /* Bytes, decoded leniently: output that is not UTF-8 must not end the channel
           (and with it the job). */
        const proc = cockpit.spawn(argv, { superuser: "require", err: "out", binary: true, directory: "/" });
        const decoder = new TextDecoder("utf-8");
        run.proc = proc;
        proc.stream(data => {
            if (!run || run.proc !== proc) return;
            run.output += typeof data === "string" ? data : decoder.decode(data, { stream: true });
            if (run.output.length > RUN_OUTPUT_LIMIT) {
                run.output = run.output.slice(run.output.length - RUN_OUTPUT_LIMIT);
                run.cut = true;
            }
            scheduleOutput();
        });
        proc.input(run.cron.stdin === null ? null : new TextEncoder().encode(run.cron.stdin));
        const finish = (rc, signal, error) => {
            if (!run || run.proc !== proc) return;
            Object.assign(run, { phase: "done", ended: Date.now(), rc, signal, error, proc: null });
            if (run.timer) { window.clearInterval(run.timer); run.timer = null; }
            if (dialog && dialog.kind === "run") dialog.locked = false;
            renderRunDialog();
            $("run-close-btn").focus();
            if (run.capture) refreshRuns();
        };
        proc.then(() => finish(0, null, null), ex => {
            if (run && run.stopped) finish(null, null, null);
            else if (ex && typeof ex.exit_status === "number") finish(ex.exit_status, null, null);
            else if (ex && ex.exit_signal) finish(null, ex.exit_signal, null);
            else finish(null, null, isDenied(ex) ? T.deniedRun : errText(ex));
        });
        run.timer = window.setInterval(updateRunStatus, 1000);
        renderRunDialog();
        $("run-stop").focus();
    }

    function stopRun() {
        if (!run || run.phase !== "running" || !run.proc) return;
        run.stopped = true;
        setBusyButton($("run-stop"), true, T.stopping);
        run.proc.close("terminated");
    }

    function scheduleOutput() {
        if (!run || run.raf) return;
        run.raf = window.requestAnimationFrame(() => {
            if (!run) return;
            run.raf = 0;
            const log = $("run-log");
            const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
            log.textContent = run.output;
            if (atEnd) log.scrollTop = log.scrollHeight;
            $("run-cut").hidden = !run.cut;
        });
    }

    function updateRunStatus() {
        if (!run || run.phase !== "running") return;
        $("run-time").textContent = T.runElapsed(fmtElapsed((Date.now() - run.started) / 1000));
    }

    function renderRunDialog() {
        const r = run;
        if (!r) return;
        const confirm = r.phase === "confirm";
        const running = r.phase === "running";
        const done = r.phase === "done";
        $("run-intro").hidden = !confirm;
        $("run-cmd").textContent = r.shown;
        const env = r.env;
        fill($("run-env"), rich(T.runEnv(codeSafe("PATH=" + env.PATH), codeSafe("HOME=" + env.HOME), codeSafe(env.SHELL))),
            r.capture ? [" ", rich(T.runRecorded)] : null,
            r.cron.stdin !== null ? [" ", rich(T.runStdin)] : null);
        $("run-keep").hidden = !confirm && !running;
        $("run-status").hidden = confirm;
        $("run-log-wrap").hidden = confirm;
        if (running) {
            fill($("run-label"), labelEl("info", "sync-alt", T.statusRunning));
            $("run-time").textContent = T.runElapsed(fmtElapsed((Date.now() - r.started) / 1000));
        } else if (done) {
            let l;
            if (r.error) l = labelEl("danger", "exclamation-circle", T.runCouldNotStart);
            else if (r.stopped) l = labelEl("warning", "exclamation-triangle", T.statusStopped);
            else if (r.signal) l = labelEl("danger", "exclamation-circle", T.statusSignal(r.signal));
            else if (r.rc === 0) l = labelEl("success", "check-circle", T.statusOk);
            else l = labelEl("danger", "exclamation-circle", T.statusFailed(r.rc));
            fill($("run-label"), l);
            $("run-time").textContent = T.runDone(fmtDuration((r.ended - r.started) / 1000), clock(r.ended));
        }
        if (!confirm) {
            const log = $("run-log");
            log.textContent = r.error ? r.error : r.output;
            log.classList.toggle("is-empty", !r.error && !r.output);
            if (!r.error && !r.output && done) log.textContent = T.noOutput;
            $("run-cut").hidden = !r.cut;
        }
        $("run-confirm-actions").hidden = !confirm;
        $("run-running-actions").hidden = !running;
        $("run-done-actions").hidden = !done;
        $("run-close").disabled = running;
        if (running) setBusyButton($("run-stop"), false, T.stopping);
    }

    /* ---------- recorded runs ---------- */

    function openRuns(index, openerKey) {
        if (state.root.status !== "ok") return;
        const e = state.root.entries[index];
        if (!e || e.kind !== "job") return;
        const info = jobInfo(e);
        if (!info.capture) return;
        openDialog($("runs-dlg"), openerKey, {
            kind: "runs", index, line: e.line, id: info.capture.id, command: info.command,
            open: null, outputs: {},
        }, $("runs-close-btn"));
        renderRunsDialog();
        refreshRuns();
    }

    function renderRunsDialog() {
        const d = dialog;
        if (!d || d.kind !== "runs") return;
        $("runs-cmd").textContent = d.command;
        const editable = state.root.status === "ok" && !state.root.locked;
        $("runs-capture-off").hidden = !editable;
        fill($("runs-note"), rich(T.runsNote(KEEP_RUNS, RUNS_DIR + "/")));
        const job = runsOf(d.id);
        const body = $("runs-body");
        const focusedKey = document.activeElement && body.contains(document.activeElement)
            ? document.activeElement.dataset.key : null;
        if (!job) {
            fill(body, h("p", { class: "cron-state" }, state.runs.status === "denied" ? T.deniedTitle : T.loading));
            return;
        }
        const items = job.running.map(r => ({ running: true, start: r.start, trigger: r.trigger }))
            .concat(job.runs.map(r => Object.assign({ running: false }, r)));
        if (!items.length) {
            fill(body, h("p", { class: "cron-state" }, T.runsEmpty));
            return;
        }
        const rows = [];
        items.forEach(r => {
            const key = r.out || ("s" + r.start);
            const label = r.running ? { kind: "info", icon: "sync-alt", text: T.statusRunning } : runLabel(r);
            const dur = r.running ? null : R.duration(r);
            const hasOut = !r.running && !!r.out;
            const isOpen = hasOut && d.open === r.out;
            const outId = "runs-out-" + key;
            rows.push(h("tr", { class: isOpen ? "is-open" : null },
                h("td", { class: "az-nowrap", "data-label": T.colStart }, fmtShort(r.start * 1000)),
                h("td", { "data-label": T.colTrigger }, r.trigger === "manual" ? T.trigManual : T.trigSchedule),
                h("td", { class: "az-nowrap", "data-label": T.colDuration },
                    r.running ? T.runningFor(fmtDuration(Date.now() / 1000 - r.start)) : dur === null ? "—" : fmtDuration(dur)),
                h("td", { class: "az-nowrap", "data-label": T.colResult }, labelEl(label.kind, label.icon, label.text)),
                h("td", { class: "az-cell-actions" }, hasOut
                    ? h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "data-key": "out:" + key,
                                    "aria-expanded": isOpen ? "true" : "false", "aria-controls": isOpen ? outId : null,
                                    "aria-label": isOpen ? T.hideOutput : T.showOutput, title: isOpen ? T.hideOutput : T.showOutput,
                                    onclick: () => toggleOutput(r.out) }, icon(isOpen ? "angle-down" : "angle-right"))
                    : h("span", { class: "cron-muted", title: r.running ? null : T.noOutput }, r.running ? "" : "—"))));
            if (isOpen) {
                const text = d.outputs[r.out];
                rows.push(h("tr", { class: "is-open cron-runs-output" },
                    h("td", { colspan: "5" },
                        h("pre", { class: "cron-log az-mono", id: outId, role: "log", tabindex: "0", "aria-label": T.runOutput },
                            text === undefined ? T.loading : text === null ? T.outputError : (text || T.noOutput)),
                        r.truncated ? h("p", { class: "cron-muted cron-small" }, T.outputTruncated) : null,
                        text ? h("div", { class: "cron-copy-row" },
                            h("button", { class: "az-btn az-btn--link az-btn--sm", type: "button", "data-key": "copy:" + key,
                                          onclick: ev => copyText(text, ev.currentTarget, outId) }, icon("copy"), T.copyOutput)) : null)));
            }
        });
        fill(body, h("div", { class: "cron-runs-table" },
            h("table", { class: "az-table az-table--stack" },
                h("thead", null, h("tr", null,
                    h("th", { scope: "col" }, T.colStart),
                    h("th", { scope: "col" }, T.colTrigger),
                    h("th", { scope: "col" }, T.colDuration),
                    h("th", { scope: "col" }, T.colResult),
                    h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.runOutput)))),
                h("tbody", null, rows))));
        if (focusedKey) {
            const el = body.querySelector('[data-key="' + focusedKey + '"]');
            if (el) el.focus();
        }
    }

    function toggleOutput(out) {
        const d = dialog;
        if (!d || d.kind !== "runs") return;
        d.open = d.open === out ? null : out;
        if (d.open && d.outputs[out] === undefined) {
            readOutput(d.id, out).then(text => { d.outputs[out] = text; }, () => { d.outputs[out] = null; })
                .finally(() => { if (dialog === d) renderRunsDialog(); });
        }
        renderRunsDialog();
    }

    function copyText(text, button, sourceId) {
        const ok = () => {
            const label = button.lastChild;
            const old = label.textContent;
            label.textContent = T.copied;
            window.setTimeout(() => { if (label.isConnected) label.textContent = old; }, 1500);
        };
        const fallback = () => {
            const src = $(sourceId);
            if (!src) return;
            const range = document.createRange();
            range.selectNodeContents(src);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            try { if (document.execCommand("copy")) ok(); } catch (_) { /* text stays selected */ }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
        else fallback();
    }

    /* ---------- leftover runs ---------- */

    /* Recorded jobs that no crontab uses any more (see lib/runs.js). Only when the root
       crontab, all other crontabs (read as root) and the runs are known, and the runs
       were read since the root crontab shown. */
    function orphanList() {
        if (state.root.status !== "ok" || state.runs.status !== "ok" || state.runs.rootVersion !== rootVersion ||
            !state.sys || !state.sys.root) return [];
        return R.orphans(state.runs.byId, [state.root.text].concat(state.sys.texts).join("\n"));
    }

    /* "12 KB", "3.4 MB" */
    function fmtSize(kb) {
        if (typeof kb !== "number") return "—";
        if (kb < 1024) return kb + " KB";
        return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(kb / 1024) + " MB";
    }

    /* A line under the root crontab while there are leftover runs. Only redrawn when
       something changed, so that focus stays on its button. */
    function renderOrphans() {
        const box = $("orphans");
        const list = orphanList();
        const frozen = state.busy || loading;
        const sig = list.map(o => o.id).join(" ") + (frozen ? " !" : "");
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.hidden = list.length === 0;
        fill(box, list.length === 0 ? null : [
            icon("history"),
            h("span", null, T.orphansLine(list.length)),
            h("button", { class: "az-btn az-btn--link cron-inline-link", type: "button", "data-key": "orphans",
                          disabled: frozen, onclick: () => openOrphans("orphans") }, T.orphansShow),
        ]);
    }

    function openOrphans(openerKey) {
        if (state.busy || loading || orphanList().length === 0) return;
        dialogError("orph-alert", null);
        openDialog($("orph-dlg"), openerKey, { kind: "orphans" }, $("orph-close-btn"));
        renderOrphansDialog();
    }

    function renderOrphansDialog() {
        const d = dialog;
        if (!d || d.kind !== "orphans") return;
        const list = orphanList();
        const body = $("orph-body");
        const focusedKey = document.activeElement && body.contains(document.activeElement)
            ? document.activeElement.dataset.key : null;
        fill($("orph-note"), rich(T.orphansNote(RUNS_DIR + "/")));
        $("orph-all").hidden = list.length < 2;
        if (list.length === 0) {
            fill(body, h("p", { class: "cron-state" }, T.orphansNone));
            return;
        }
        const rows = list.map(o => {
            const l = o.last ? runLabel(o.last) : null;
            return h("tr", null,
                h("td", { "data-label": T.colJobId }, h("span", { class: "az-mono" }, o.id)),
                h("td", { class: "az-nowrap", "data-label": T.colLast }, l
                    ? h("div", { class: "cron-cell" },
                        h("span", null, labelEl(l.kind, l.icon, l.text)),
                        h("span", { class: "az-cell-sub" }, fmtShort(o.last.start * 1000)))
                    : h("span", { class: "cron-muted" }, T.noRunYet)),
                h("td", { class: "az-nowrap", "data-label": T.colRuns }, String(o.count)),
                h("td", { class: "az-nowrap", "data-label": T.colSize }, fmtSize(o.kb)),
                h("td", { class: "az-cell-actions" },
                    h("button", { class: "az-btn az-btn--plain az-btn--sm", type: "button", "data-key": "orph:" + o.id,
                                  "aria-label": T.orphansRemove(o.id), title: T.orphansRemove(o.id), disabled: !!d.locked,
                                  onclick: () => removeOrphanRuns([o.id]) }, icon("trash"))));
        });
        fill(body, h("div", { class: "cron-runs-table" },
            h("table", { class: "az-table az-table--stack" },
                h("thead", null, h("tr", null,
                    h("th", { scope: "col" }, T.colJobId),
                    h("th", { scope: "col" }, T.colLast),
                    h("th", { scope: "col" }, T.colRuns),
                    h("th", { scope: "col" }, T.colSize),
                    h("th", { scope: "col" }, h("span", { class: "az-sr" }, T.colActions)))),
                h("tbody", null, rows))));
        if (focusedKey) {
            const el = body.querySelector('[data-key="' + focusedKey + '"]');
            if (el && !el.disabled) el.focus();
        }
    }

    /* Removes the runs of the given jobs; the root script checks each one again. Jobs
       it keeps (used again, or running) are reported, and the page reloads, since a
       crontab changed outside the page. */
    async function removeOrphanRuns(ids) {
        const d = dialog;
        if (!d || d.kind !== "orphans" || d.locked || state.busy || loading || ids.length === 0) return;
        const buttons = [$("orph-close"), $("orph-close-btn")];
        d.locked = true;
        state.busy = true;
        dialogError("orph-alert", null);
        setBusyButton($("orph-all"), true, T.removing);
        buttons.forEach(b => { b.disabled = true; });
        renderOrphansDialog();
        let res = null;
        let error = null;
        try {
            res = await removeOrphans(ids);
        } catch (ex) {
            error = ex && ex.exit_status === 4 ? T.lockBusy : errText(ex);
        }
        state.busy = false;
        d.locked = false;
        setBusyButton($("orph-all"), false, T.removing);
        buttons.forEach(b => { b.disabled = false; });
        if (res) res.removed.forEach(id => { delete state.runs.byId[id]; });
        renderOrphans();
        if (error) {
            renderOrphansDialog();
            dialogError("orph-alert", error, T.orphansFailed);
            $("orph-close-btn").focus();
        } else if (res.kept.length) {
            closeDialog("orphans");
            showAlert("warning", T.orphansKeptTitle,
                      (res.removed.length ? T.okOrphansRemoved(res.removed.length) + ". " : "") +
                      T.orphansKept(joinList(res.kept.map(id => "`" + id + "`"))));
            loadPending = true;
        } else {
            if (res.removed.length) showAlert("success", T.okOrphansRemoved(res.removed.length));
            if (orphanList().length === 0) {
                closeDialog("orphans");
            } else {
                renderOrphansDialog();
                (d.el.querySelector("[data-key^='orph:']") || $("orph-close-btn")).focus();
            }
        }
        if (loadPending) { loadPending = false; requestLoad(); }
        else refreshRuns();
    }

    /* ---------- convert to systemd timer ---------- */

    function convertBlocker(e, info, i) {
        if (!e.enabled) return T.convNotActive;
        if (state.basics.flavor === "cronie" && C.envBefore(state.root.entries, i).RANDOM_DELAY) return T.convRandomDelay;
        const cal = SD.calendarFromCron(e.schedule);
        if (!cal.ok) return cal.reason === "reboot" ? T.convReboot : T.convInvalid;
        if (C.hasUnescapedPercent(info.command)) return T.convPercent;
        return null;
    }

    function openConvert(index, openerKey) {
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

    function updateConvert() {
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

    const WRITE_UNITS_SCRIPT = `set -eu
umask 022
n=$1
d=/etc/systemd/system
for u in "$n.service" "$n.timer"; do
  if [ -e "$d/$u" ] || [ -L "$d/$u" ]; then exit 6; fi
  st=$(systemctl show -p LoadState --value "$u" 2>/dev/null || :)
  case $st in ''|not-found) ;; *) exit 6 ;; esac
done
printf '%s' "$2" > "$d/.$n.service.tmp"
printf '%s' "$3" > "$d/.$n.timer.tmp"
mv -f "$d/.$n.service.tmp" "$d/$n.service"
mv -f "$d/.$n.timer.tmp" "$d/$n.timer"
systemctl daemon-reload
`;

    const REMOVE_UNITS_SCRIPT = `n=$1
d=/etc/systemd/system
systemctl disable --now "$n.timer" > /dev/null 2>&1 || :
rm -f "$d/$n.service" "$d/$n.timer"
systemctl daemon-reload
`;

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

    async function submitConvert(ev) {
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

    function toggleUnits() {
        const btn = $("conv-units-toggle");
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        $("conv-units").hidden = !open;
        fill(btn, icon(open ? "angle-down" : "angle-right"), open ? T.convHideUnits : T.convShowUnits);
    }

    /* ---------- back to cron ---------- */

    /* The units of a converted job in /etc/systemd/system, only when Cron Jobs wrote
       them under this name: both are files (no links), the service starts with
       SD.UNIT_HEADER, and both have the Description= of a conversion.
         $1 check:  exit 0 when both are ours, 9 when neither exists
         $1 remove: checks again, then stops, disables and removes them
         $2 the name
       Exit 8 = not ours (changed, a link, only one of them, or not written by Cron Jobs). */
    const UNITS_SCRIPT = `set -u
n=$2
case $n in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) exit 2 ;; esac
d=/etc/systemd/system
s=$d/$n.service
t=$d/$n.timer
if [ ! -e "$s" ] && [ ! -L "$s" ] && [ ! -e "$t" ] && [ ! -L "$t" ]; then exit 9; fi
if [ -L "$s" ] || [ -L "$t" ] || [ ! -f "$s" ] || [ ! -f "$t" ]; then exit 8; fi
[ "$(head -n 1 "$s")" = '${SD.UNIT_HEADER}' ] || exit 8
grep -qxF "Description=$n (from the root crontab)" "$s" || exit 8
grep -qxF "Description=$n (from the root crontab)" "$t" || exit 8
case $1 in
  check) ;;
  remove)
    trap '' TERM HUP INT
    systemctl disable --now "$n.timer" > /dev/null 2>&1 || :
    rm -f "$s" "$t" || exit 1
    systemctl daemon-reload
    systemctl reset-failed "$n.service" "$n.timer" > /dev/null 2>&1 || :
    ;;
  *) exit 2 ;;
esac
`;

    function unitsStep(step, name) {
        return spawn(["sh", "-c", UNITS_SCRIPT, "cockpit-cronjobs", step, name], SPAWN_ROOT);
    }

    /* Shows what going back does, after checking the units: ours, missing (only the
       line goes back on) or foreign (nothing is done). */
    function openBack(index, openerKey) {
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
    async function submitBack() {
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

    let superuser = null;

    function watchSuperuser() {
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

    function init() {
        translateStatic();

        $("reload").addEventListener("click", () => { clearAlerts(); requestLoad(); });
        $("add").addEventListener("click", () => openEdit(null, "add"));

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
            const e = state.root.status === "ok" ? state.root.entries[d.index] : null;
            if (!jobAt(state.root.entries || [], d.index, d.line) || !e) { closeDialog(); return; }
            const key = d.openerKey;
            closeDialog();
            openCaptureOff(d.index, key);
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
}());
