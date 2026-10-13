/* Cron Jobs: everything that runs on the server: spawn, reading the crontabs, the
 * runs and systemd, and every script that runs as root. Root scripts are constants;
 * values reach them as arguments or standard input, never pasted into shell code.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { B, BACKUP_DIR, C, DAY, KEEP_BACKUPS, KEEP_RUNS, R, RUNS_DIR, SD, state, STATE_DIR, T, USER_RE } from "./core.js";
import { crontabOf, takenIds } from "./crontab.js";
import { renderNotices, showAlert } from "./page.js";

/* ---------- system access ---------- */

export const SPAWN_ROOT = { superuser: "require", err: "message", environ: ["LC_ALL=C"] };

export function spawn(args, opts, input) {
    const proc = cockpit.spawn(args, opts);
    if (input !== undefined) proc.input(input);
    return Promise.resolve(proc);
}

export function errText(ex) {
    if (!ex) return "";
    return String(ex.message || ex.problem || ex).trim();
}
export function isDenied(ex) {
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

/* A user's crontab as text (root's or another user's); read as bytes, so that a
   crontab that is not UTF-8 can still be shown (read-only, see setCrontab). The
   name is checked by the caller (USER_RE). Resolves to { text, utf8 }; no crontab
   at all gives the empty text. */
export function readCrontab(user) {
    return spawn(["crontab", "-l", "-u", user], Object.assign({}, SPAWN_ROOT, { binary: true })).then(
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

/* Replaces a user's crontab in one step under a lock:
     $1    = the user: root, or a name of letters, digits, ".", "_" and "-" that the
             system knows (else exit 2)
     $2    = cksum of the version the page shows (else exit 3)
     $3    = optional: a systemd timer to enable and start right after (for a
             conversion), or with $4 = stop to stop and disable (back to cron); if
             that fails, the previous crontab is put back (exit 7)
     stdin = the new version
   The current version is backed up first: root's in BACKUP_DIR, another user's in
   BACKUP_DIR/users/USER (directories 700, files 600, the last ten of each user are
   kept; a version that already is the newest backup is not stored twice). One lock
   for all crontabs; it lives in a directory only root can write to (STATE_DIR, 711:
   other users reach their runs below it, see USER_RUNS_SCRIPT). Closing the page
   does not interrupt the script (SIGTERM and SIGHUP are ignored).
   Output: path of the backup, empty when there was no crontab before.
   Exit 2 = not a user, 3 = changed meanwhile, 4 = locked, 5 = backup failed,
   7 = timer failed, else crontab's error. */
const SAVE_SCRIPT = `set -eu
trap '' TERM HUP INT
umask 077
user=$1
expect=$2
timer="\${3-}"
verb=enable
if [ "\${4-}" = stop ]; then verb=disable; fi
case $user in ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
id -u "$user" > /dev/null 2>&1 || exit 2
dir='${BACKUP_DIR}'
if [ "$user" != root ]; then dir=$dir/users/$user; fi
install -d -m 711 '${STATE_DIR}' || exit 5
exec 9>'${STATE_DIR}/.crontab.lock'
flock -w 10 9 || exit 4
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/new"
if crontab -l -u "$user" > "$tmp/cur" 2> "$tmp/err"; then
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
  chmod 711 '${STATE_DIR}' && chmod 700 '${BACKUP_DIR}' "$dir" || exit 5
  if [ "$user" != root ]; then chmod 700 '${BACKUP_DIR}/users' || exit 5; fi
  last=$(ls -1t "$dir/$user"-*.crontab 2>/dev/null | head -n 1)
  if [ -n "$last" ] && [ "$(cksum < "$last")" = "$sum" ]; then
    f=$last
  else
    stamp="$dir/$user-$(date +%Y%m%d-%H%M%S)"
    f="$stamp.crontab"
    n=1
    while [ -e "$f" ]; do n=$((n + 1)); f="$stamp-$n.crontab"; done
    cp "$tmp/cur" "$f.tmp" || exit 5
    [ "$(cksum < "$f.tmp")" = "$sum" ] || { rm -f "$f.tmp"; exit 5; }
    mv "$f.tmp" "$f" || exit 5
  fi
  chmod 600 "$dir/$user"-*.crontab || exit 5
  ls -1t "$dir/$user"-*.crontab | tail -n +${KEEP_BACKUPS + 1} | while IFS= read -r old; do rm -f -- "$old"; done
fi
crontab -u "$user" "$tmp/new"
if [ -n "$timer" ]; then
  if ! systemctl "$verb" --now "$timer" > /dev/null 2> "$tmp/err"; then
    if [ "$have" = 1 ]; then crontab -u "$user" "$tmp/cur"; else crontab -r -u "$user"; fi
    cat "$tmp/err" >&2
    exit 7
  fi
fi
printf '%s\\n' "$f"
`;

/* user: whose crontab; expected: the text shown (exactly as crontab -l gave it),
   next: the new text, timer: optional unit to enable and start once the crontab is
   written, or to stop and disable when stop is set. */
export function saveCrontab(user, expected, next, timer, stop) {
    const args = ["sh", "-c", SAVE_SCRIPT, "cockpit-cronjobs", user, C.cksum(expected)]
        .concat(timer ? [timer].concat(stop ? ["stop"] : []) : []);
    return spawn(args, SPAWN_ROOT, next).then(out => String(out || "").trim());
}

/* All backups of a user's crontab ($1, checked as in SAVE_SCRIPT), newest first as
   SAVE_SCRIPT sees them (ls -t, so also within one second), under the crontab lock
   (shared), so that none is written or removed meanwhile. For each file a header
   "\\036MTIME SIZE NAME" (MTIME in seconds), then the file byte for byte (see
   lib/backups.js). Links and other names are left out. Exit 2 = not a user name,
   4 = locked. */
const BACKUPS_SCRIPT = `set -u
umask 077
user=$1
case $user in ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
dir='${BACKUP_DIR}'
if [ "$user" != root ]; then dir=$dir/users/$user; fi
[ -d "$dir" ] || exit 0
exec 9>'${STATE_DIR}/.crontab.lock'
flock -s -w 10 9 || exit 4
ls -1t "$dir/$user"-*.crontab 2>/dev/null | while IFS= read -r f; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  n=\${f##*/}
  case $n in "$user"-*.crontab) ;; *) continue ;; esac
  case $n in *[!A-Za-z0-9._-]*) continue ;; esac
  s=$(stat -c '%Y %s' "$f") || exit 1
  printf '\\036%s %s\\n' "$s" "$n"
  cat -- "$f" || exit 1
done || exit 1
exit 0
`;

/* Resolves to the backups of user's crontab, newest first (see B.parseBackups). */
export function readBackups(user) {
    return spawn(["sh", "-c", BACKUPS_SCRIPT, "cockpit-cronjobs", user], Object.assign({}, SPAWN_ROOT, { binary: true }))
        .then(out => B.parseBackups(typeof out === "string" ? new TextEncoder().encode(out) : out, user));
}

/* The home directories of users (cron starts their jobs there, with HOME set to it),
   from the user database; names checked by the caller (USER_RE). */
const HOMES_SCRIPT = `for u in "$@"; do getent passwd "$u" || :; done
exit 0
`;

export function readHomes(names) {
    if (!names.length) return Promise.resolve({});
    return spawn(["sh", "-c", HOMES_SCRIPT, "cockpit-cronjobs"].concat(names), { err: "ignore", environ: ["LC_ALL=C"] })
        .then(out => {
            const homes = {};
            String(out || "").split("\n").forEach(line => {
                const f = line.split(":");
                if (f.length >= 7 && names.includes(f[0]) && /^\//.test(f[5])) homes[f[0]] = f[5];
            });
            return homes;
        });
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

export function readBasics() {
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
   Every entry of /etc/cron.d gets a section "d:LMODE:LUID:MODE:UID:NLINK:NAME":
   raw mode (hex) and owner of the entry itself, then of what opening it gives
   (a link followed; empty for a link to nothing), for C.cronDSkip. Only regular
   files are read. uid tells whether it ran as root (other users' crontabs need
   that); /etc/anacrontab is only read to see which recorded jobs are still
   mentioned somewhere. */
const SYSTEM_SCRIPT = `sec() { printf '\\036%s\\n' "$1"; }
show() { tr -d '\\036' < "$1" 2>/dev/null; echo; }
name() { printf '%s' "$1" | tr -d '\\036\\n'; }
sec uid; id -u
sec etc; show /etc/crontab
for f in /etc/cron.d/*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  self=$(stat -c '%f:%u' "$f" 2>/dev/null) || self=:
  target=$(stat -L -c '%f:%u:%h' "$f" 2>/dev/null) || target=::
  sec "d:$self:$target:$(name "\${f##*/}")"
  if [ -f "$f" ]; then show "$f"; fi
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

/* File types in st_mode, as stat's %f prints it. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export function readSystem(flavor) {
    return spawn(["sh", "-c", SYSTEM_SCRIPT], { superuser: "try", err: "ignore", binary: true, environ: ["LC_ALL=C"] })
        .then(out => parseSystem(decode(out), flavor));
}

/* sys.texts: every crontab as read, for finding the recorded jobs no line uses
   any more (see orphanList). sys.userNames: whose crontabs there are (as root only). */
function parseSystem(out, flavor) {
    const sys = { etc: [], crond: [], users: [], userNames: [], periodic: [], root: false, texts: [] };
    sections(out).forEach(({ name, body }) => {
        if (name === "etc" || name === "anacron" || /^[du]:/.test(name)) sys.texts.push(body);
        if (name === "uid") sys.root = body.trim() === "0";
        else if (name === "etc") sys.etc = C.parseSystemCrontab(body);
        else if (name.startsWith("d:")) {
            const m = /^d:([0-9a-f]*):(\d*):([0-9a-f]*):(\d*):(\d*):(.*)$/.exec(name);
            if (!m) return;
            const file = m[6];
            const self = parseInt(m[1], 16);
            const mode = parseInt(m[3], 16);
            const ignored = C.cronDSkip({
                name: file,
                link: m[1] && (self & S_IFMT) === S_IFLNK ? { uid: +m[2] } : null,
                target: m[3] && m[4] && m[5] ? { regular: (mode & S_IFMT) === S_IFREG, mode: mode & 0o7777, uid: +m[4], nlink: +m[5] }
                    : null,
            }, flavor !== "cronie");
            const jobs = C.parseSystemCrontab(body);
            jobs.forEach(j => sys.crond.push(Object.assign({ file, ignored }, j)));
            /* Skipped and nothing to show (a link to nothing, a directory): the file alone. */
            if (!jobs.length && ignored) sys.crond.push({ file, ignored, schedule: null, user: null, command: null });
        } else if (name.startsWith("u:")) {
            const user = name.slice(2);
            sys.userNames.push(user);
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

/* Recorded runs of all jobs (see lib/runs.js): root's under RUNS_DIR (key ID), other
   users' under STATE_DIR/users/USER/runs (key USER/ID), each with the disk use of its
   directory in KB. A run marker whose process is gone is reported with ALIVE 0. */
const RUNS_SCRIPT = `job() {
  printf '\\036%s\\n' "$2"
  printf 'size %s\\n' "$(du -sk "$1" 2>/dev/null | cut -f1)"
  tail -n ${KEEP_RUNS} "$1/runs.jsonl" 2>/dev/null
  for r in "$1"/*.running; do
    [ -f "$r" ] || continue
    pid=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$r" | head -n 1)
    alive=0
    if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\\000' ' ' < "/proc/$pid/cmdline" | grep -q cockpit-cronjobs-run; then
      alive=1
    fi
    printf 'running %s %s\\n' "$alive" "$(head -n 1 "$r")"
  done
}
for d in '${RUNS_DIR}'/*; do
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  job "$d" "\${d##*/}"
done
for u in '${STATE_DIR}'/users/*; do
  [ -d "$u/runs" ] && [ ! -L "$u" ] && [ ! -L "$u/runs" ] || continue
  for d in "$u"/runs/*; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    job "$d" "\${u##*/}/\${d##*/}"
  done
done
exit 0
`;

export function readRuns() {
    return spawn(["sh", "-c", RUNS_SCRIPT], Object.assign({}, SPAWN_ROOT, { binary: true }))
        .then(out => R.parseRuns(decode(out)));
}

/* Where the runs of user's jobs are kept (see cockpit-cronjobs-run). */
export const runsDirOf = user => user === "root" ? RUNS_DIR : STATE_DIR + "/users/" + user + "/runs";

export function readOutput(user, id, out) {
    if (!USER_RE.test(user) || !R.ID_RE.test(id) || !R.OUT_RE.test(out)) return Promise.resolve("");
    return spawn(["tail", "-c", "65536", runsDirOf(user) + "/" + id + "/" + out + ".out"],
                 Object.assign({}, SPAWN_ROOT, { binary: true }))
        .then(decode, ex => {
            if (ex && ex.exit_status === 1) return "";
            throw ex;
        });
}

function removeRuns(user, id) {
    if (!USER_RE.test(user) || !R.ID_RE.test(id)) return Promise.resolve();
    return spawn(["rm", "-rf", "--", runsDirOf(user) + "/" + id], SPAWN_ROOT);
}

/* A copied line may share the ID; its runs stay as long as a line of user's crontab
   still uses them. */
export function removeRunsIfUnused(user, id) {
    const tab = crontabOf(user);
    if (!tab || tab.status !== "ok" || takenIds(tab.entries).has(id)) return Promise.resolve();
    return removeRuns(user, id).catch(() => {});
}

/* Gives another user ($1) a directory for the runs of the user's jobs, which the run
   recorder writes as that user: STATE_DIR/users/USER, owned by the user, mode 700.
   STATE_DIR and STATE_DIR/users get mode 711, so the user can reach it but list
   nothing. Exit 2 = not a user the system knows. */
const USER_RUNS_SCRIPT = `set -eu
user=$1
case $user in ''|root|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
id -u "$user" > /dev/null 2>&1 || exit 2
umask 077
s='${STATE_DIR}'
mkdir -p "$s/users"
chmod 711 "$s" "$s/users"
d=$s/users/$user
if [ ! -d "$d" ]; then mkdir "$d"; fi
chown -h "$user:" "$d"
chmod 700 "$d"
`;

/* Makes sure user has the directory before a job of the user is recorded; says so
   when it cannot be made. Resolves to whether it is there. */
export function ensureUserRuns(user) {
    return spawn(["sh", "-c", USER_RUNS_SCRIPT, "cockpit-cronjobs", user], SPAWN_ROOT).then(() => true, ex => {
        showAlert("danger", T.userRunsFailed(user), errText(ex));
        return false;
    });
}

/* Removes the run directories of recorded jobs that no crontab uses any more. Under
   the crontab lock, every ID is checked again: a directory stays when its ID
   appears as a word anywhere in the root crontab, /etc/crontab, /etc/anacrontab,
   /etc/cron.d or another user's crontab ("used"), or while a run is going on
   ("running"). If one of these files cannot be read, nothing is removed.
   Arguments: ID (root's runs) or USER/ID (another user's). Output:
   "removed|gone|used|running ARGUMENT" for each. Exit 4 = locked, else an error. */
const REMOVE_ORPHANS_SCRIPT = `set -u
trap '' TERM HUP INT
umask 077
[ -d '${STATE_DIR}' ] || exit 0
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
for key in "$@"; do
  case $key in
    */*)
      user=\${key%%/*}
      id=\${key#*/}
      case $user in root|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) continue ;; esac
      d='${STATE_DIR}'/users/$user/runs/$id ;;
    *)
      id=$key
      d='${RUNS_DIR}'/$id ;;
  esac
  case $id in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  [ \${#id} -le 64 ] || continue
  if [ ! -d "$d" ]; then echo "gone $key"; continue; fi
  grep -qE "(^|[^A-Za-z0-9_-])$id([^A-Za-z0-9_-]|\\$)" "$tmp/all"
  case $? in
    0) echo "used $key"; continue ;;
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
  if [ "$alive" = 1 ]; then echo "running $key"; continue; fi
  rm -rf -- "$d" || exit 1
  echo "removed $key"
done
exit 0
`;

/* keys: ID or USER/ID (see R.KEY_RE). Result: { removed: [key…], kept: [key…] };
   "gone" counts as removed. */
export function removeOrphans(keys) {
    const args = ["sh", "-c", REMOVE_ORPHANS_SCRIPT, "cockpit-cronjobs"].concat(keys.filter(k => R.KEY_RE.test(k)));
    return spawn(args, SPAWN_ROOT).then(out => {
        const res = { removed: [], kept: [] };
        String(out || "").split("\n").forEach(line => {
            const m = /^(removed|gone|used|running) (\S+)$/.exec(line);
            if (m && R.KEY_RE.test(m[2])) (m[1] === "removed" || m[1] === "gone" ? res.removed : res.kept).push(m[2]);
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

export async function installWrapper() {
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

export function wrapperCurrent() {
    return typeof state.basics.wrapper === "number" && state.basics.wrapper >= C.WRAPPER_VERSION;
}

/* Makes sure the run recorder is there before a job uses it. */
export async function ensureWrapper() {
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

export function getProp(path, iface, name) {
    return sd().call(path, DBUS_PROPS, "Get", [iface, name]).then(r => variant(r[0]));
}
function getAll(path, iface) {
    return sd().call(path, DBUS_PROPS, "GetAll", [iface]).then(r => {
        const out = {};
        Object.keys(r[0] || {}).forEach(k => { out[k] = variant(r[0][k]); });
        return out;
    });
}
export function unitPath(name) {
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

export function analyzeCalendar(specs, iterations) {
    if (!specs.length) return Promise.resolve({});
    return spawn(["sh", "-c", ANALYZE_SCRIPT, "cockpit-cronjobs", String(iterations)].concat(specs),
                 { err: "ignore", environ: ["LC_ALL=C"] })
        .then(out => {
            const res = {};
            sections(out).forEach(({ name, body }) => { res[name] = SD.parseAnalyzeCalendar(body); });
            return res;
        });
}

export async function readTimers() {
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

/* ---------- scripts of run now and of the conversion ---------- */

/* Starts the command in its own process group, so that "Stop" (SIGTERM from
   Cockpit to this shell) reaches everything the job started. Only the job gets
   the cron environment; this script keeps Cockpit's, so it finds its tools.
   $1 the user the job runs as: root's runs as root, another user's through runuser
   (that user with the user's groups, as cron runs it), $2 working directory,
   $3 shell, $4 command, then NAME=value for the job; standard input is passed on.
   Exit 2 = not a user the system knows. */
export const RUN_SCRIPT = `user=$1
cd "$2" 2>/dev/null || cd /
sh=$3
cmd=$4
shift 4
as=
if [ "$user" != root ]; then
  case $user in ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) echo "cockpit-cronjobs: not a user name" >&2; exit 2 ;; esac
  id -u "$user" > /dev/null 2>&1 || { echo "cockpit-cronjobs: the system does not know $user" >&2; exit 2; }
  as="runuser -u $user --"
fi
w=
if setsid -w true > /dev/null 2>&1; then w=-w; fi
exec 3<&0
setsid $w $as env -i "$@" "$sh" -c "$cmd" <&3 3<&- &
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

/* Writes NAME.service and NAME.timer of a conversion ($1 the name, $2 and $3 the
   units) and reloads systemd; exit 6 when a unit of that name exists already. */
export const WRITE_UNITS_SCRIPT = `set -eu
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

/* Takes back the units a failed conversion has just written ($1 the name). */
export const REMOVE_UNITS_SCRIPT = `n=$1
d=/etc/systemd/system
systemctl disable --now "$n.timer" > /dev/null 2>&1 || :
rm -f "$d/$n.service" "$d/$n.timer"
systemctl daemon-reload
`;

/* The units of a converted job in /etc/systemd/system, only when Cron Jobs wrote
   them under this name: both are files (no links), the service starts with
   SD.UNIT_HEADER, and both have the Description= of a conversion.
     $1 check:  exit 0 when both are ours, 9 when neither exists
     $1 remove: checks again, then stops, disables and removes them
     $2 the name
   Exit 8 = not ours (changed, a link, only one of them, or not written by Cron Jobs). */
export const UNITS_SCRIPT = `set -u
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
