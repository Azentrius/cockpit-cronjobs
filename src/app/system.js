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
     $5    = for a conversion, its token (see WRITE_UNITS_SCRIPT): the timer is only
             started while its units are that conversion's (else exit 8, before
             anything changes); once it runs, the conversion is finished
     stdin = the new version
   The current version is backed up first: root's in BACKUP_DIR, another user's in
   BACKUP_DIR/users/USER (directories 700, files 600, the last ten of each user are
   kept; a version that already is the newest backup is not stored twice). One lock
   for all crontabs; it lives in a directory only root can write to (STATE_DIR, 711:
   other users reach their runs below it, see USER_RUNS_SCRIPT). Closing the page
   does not interrupt the script (SIGTERM and SIGHUP are ignored).
   Output: path of the backup, empty when there was no crontab before.
   Exit 2 = not a user, 3 = changed meanwhile, 4 = locked, 5 = backup failed,
   7 = timer failed, 8 = not the conversion's units, else crontab's error. */
const SAVE_SCRIPT = `set -eu
trap '' TERM HUP INT
umask 077
user=$1
expect=$2
timer="\${3-}"
verb=enable
if [ "\${4-}" = stop ]; then verb=disable; fi
tok="\${5-}"
case $user in ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
id -u "$user" > /dev/null 2>&1 || exit 2
owner=
if [ -n "$tok" ]; then
  case $timer in *.timer) ;; *) exit 2 ;; esac
  case \${timer%.timer} in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) exit 2 ;; esac
  case $tok in *[!0-9a-f]*) exit 2 ;; esac
  [ "$verb" = enable ] || exit 2
  owner='${STATE_DIR}/converting/'\${timer%.timer}
fi
dir='${BACKUP_DIR}'
if [ "$user" != root ]; then dir=$dir/users/$user; fi
install -d -m 711 '${STATE_DIR}' || exit 5
exec 9>'${STATE_DIR}/.crontab.lock'
flock -w 10 9 || exit 4
if [ -n "$owner" ] && [ "$(cat "$owner" 2>/dev/null)" != "$tok" ]; then exit 8; fi
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
  if [ -n "$owner" ]; then rm -f "$owner"; fi
fi
printf '%s\\n' "$f"
`;

/* user: whose crontab; expected: the text shown (exactly as crontab -l gave it),
   next: the new text, timer: optional unit to enable and start once the crontab is
   written, or to stop and disable when stop is set; token: a conversion's token
   (with a timer to start). */
export function saveCrontab(user, expected, next, timer, stop, token) {
    const args = ["sh", "-c", SAVE_SCRIPT, "cockpit-cronjobs", user, C.cksum(expected)]
        .concat(timer ? [timer].concat(stop ? ["stop"] : token ? ["", token] : []) : []);
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

/* Host name, time zone as cron sees it, what is installed, and how cron gives its jobs
   their environment (C.cronEnvModel): the cron daemon's command line (running, with the
   time it started, which also says what it logs, C.cronLogs; else its unit's ExecStart),
   the environment systemd gives services, the PAM service files
   of cron (Debian) and crond (cronie) with what they include, and the env files those
   or pam_env read. File contents lose RS (\\036). All of it is readable without root. */
const BASICS_SCRIPT = `sec() { printf '\\036%s\\n' "$1"; }
show() { tr -d '\\036' < "$1" 2>/dev/null; echo; }
has_systemd() { [ -d /run/systemd/system ] && command -v systemctl > /dev/null 2>&1; }
pam_seen=' '
pam_files=
pam_walk() {
  case $1 in ''|*[!A-Za-z0-9._-]*) return ;; esac
  case $pam_seen in *" $1 "*) return ;; esac
  pam_seen="$pam_seen$1 "
  f=
  for d in /etc/pam.d /usr/lib/pam.d; do
    if [ -f "$d/$1" ]; then f=$d/$1; break; fi
  done
  [ -n "$f" ] || return
  pam_files="$pam_files $f"
  sec "pam:$1"
  show "$f"
  for n in $(sed -n -e 's/^[[:space:]]*@include[[:space:]][[:space:]]*\\([^[:space:]#]*\\).*/\\1/p' \\
                    -e 's/^[[:space:]]*-\\{0,1\\}[A-Za-z][A-Za-z]*[[:space:]][[:space:]]*include[[:space:]][[:space:]]*\\([^[:space:]#]*\\).*/\\1/p' \\
                    -e 's/^[[:space:]]*-\\{0,1\\}[A-Za-z][A-Za-z]*[[:space:]][[:space:]]*substack[[:space:]][[:space:]]*\\([^[:space:]#]*\\).*/\\1/p' "$f"); do
    pam_walk "$n"
  done
}
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
sec crond
p=$(pgrep -o -x cron 2>/dev/null || pgrep -o -x crond 2>/dev/null)
if [ -n "$p" ] && [ -r "/proc/$p/cmdline" ]; then
  printf 'run '; tr '\\000\\n' '  ' < "/proc/$p/cmdline"; echo
  a=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
  case $a in ''|*[!0-9]*) ;; *) echo "since $(( $(date +%s) - a ))" ;; esac
fi
if has_systemd; then
  for u in cron.service crond.service cronie.service; do
    if [ "$(systemctl show -p LoadState --value "$u" 2>/dev/null)" = loaded ]; then
      printf 'unit '; systemctl show -p ExecStart --value "$u" 2>/dev/null | head -n 1
      break
    fi
  done
  sec manager
  systemctl show-environment 2>/dev/null | tr -d '\\036'
fi
pam_walk cron
pam_walk crond
env_seen=' '
for e in /etc/environment $(cat /dev/null $pam_files 2>/dev/null | sed -n 's/.*[[:space:]]envfile=\\([^[:space:]#]*\\).*/\\1/p'); do
  case $e in /*) ;; *) continue ;; esac
  case $env_seen in *" $e "*) continue ;; esac
  env_seen="$env_seen$e "
  if [ -f "$e" ]; then sec "env:$e"; show "$e"; fi
done
exit 0
`;

function zoneFrom(s) {
    const m = /zoneinfo\/(?:posix\/|right\/)?(.+)$/.exec(s);
    const tz = (m ? m[1] : s).trim();
    return tz && C.validTimeZone(tz) ? tz : null;
}

/* Bytes, decoded leniently: an env file in another encoding must not take the rest down. */
export function readBasics() {
    return spawn(["sh", "-c", BASICS_SCRIPT], { err: "ignore", environ: ["LC_ALL=C"], binary: true }).then(raw => {
        const out = decode(raw);
        const res = { host: "", tz: null, mta: null, crontab: true, flavor: "debian", systemd: false,
                      cron: null, wrapper: null, cronEnv: null, managerEnv: {}, cronLogs: null };
        const daemon = { run: "", unit: "", since: "" };
        const pam = {};
        const files = {};
        sections(out).forEach(({ name, body }) => {
            const first = body.trim().split("\n")[0] || "";
            if (name.startsWith("pam:")) pam[name.slice(4)] = body;
            else if (name.startsWith("env:")) files[name.slice(4)] = body;
            else if (name === "crond") {
                body.split("\n").forEach(line => {
                    const m = /^(run|unit|since) (.*)$/.exec(line);
                    if (m) daemon[m[1]] = m[2].trim();
                });
            } else if (name === "manager") {
                body.split("\n").forEach(line => {
                    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
                    if (m) res.managerEnv[m[1]] = m[2];
                });
            } else if (name === "host") res.host = first;
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
        res.cronEnv = C.cronEnvModel({ flavor: res.flavor, args: daemon.run || daemon.unit, pam, files,
                                       managerPath: res.managerEnv.PATH || null });
        res.cronLogs = C.cronLogs(res.flavor, daemon.run, /^\d{1,12}$/.test(daemon.since) ? Number(daemon.since) * 1000 : null);
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
   any more (see orphanList). sys.userNames: whose crontabs there are (as root only).
   Every job has tz, its own zone under cronie (CRON_TZ above it in its file), else null. */
function parseSystem(out, flavor) {
    const sys = { etc: [], crond: [], users: [], userNames: [], periodic: [], root: false, texts: [] };
    const zoneOf = env => {
        const tz = flavor === "cronie" ? env.CRON_TZ : null;
        return tz && C.validTimeZone(tz) ? tz : null;
    };
    const systemJobs = body => C.parseSystemCrontab(body).map(j => Object.assign(j, { tz: zoneOf(j.env) }));
    sections(out).forEach(({ name, body }) => {
        if (name === "etc" || name === "anacron" || /^[du]:/.test(name)) sys.texts.push(body);
        if (name === "uid") sys.root = body.trim() === "0";
        else if (name === "etc") sys.etc = systemJobs(body);
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
            const jobs = systemJobs(body);
            jobs.forEach(j => sys.crond.push(Object.assign({ file, ignored }, j)));
            /* Skipped and nothing to show (a link to nothing, a directory): the file alone. */
            if (!jobs.length && ignored) sys.crond.push({ file, ignored, schedule: null, user: null, command: null, tz: null });
        } else if (name.startsWith("u:")) {
            const user = name.slice(2);
            sys.userNames.push(user);
            const entries = C.parseUserCrontab(body);
            entries.forEach((e, i) => {
                if (e.kind !== "job") return;
                sys.users.push({ user, schedule: e.schedule, command: e.command, enabled: e.enabled,
                                 tz: zoneOf(C.envBefore(entries, i)) });
            });
        } else if (name.startsWith("p:")) {
            const scripts = body.split("\n").filter(Boolean).map(x => x.replace(/^.*\//, ""))
                .filter(x => !CRONIE_SKIP_RE.test(x));
            sys.periodic.push({ dir: "/etc/cron." + name.slice(2), scripts });
        }
    });
    return sys;
}

/* Runs a command ($2…) as user $1, without a login session (no PAM, so nothing in the
   auth log). STATE_DIR/users/USER belongs to that user: whatever is opened or removed
   in there goes through this, so that a link the user puts there leads nowhere the
   user could not go anyway. Returns 2 when the system does not know the user. */
const AS_USER_FN = `as_user() {
  _uid=$(id -u "$1" 2>/dev/null) && _gid=$(id -g "$1" 2>/dev/null) || return 2
  shift
  (cd / && exec setpriv --reuid="$_uid" --regid="$_gid" --clear-groups -- "$@")
}`;

/* AS_USER_FN for one command: $1 the user (not root), then the command. */
const AS_USER_SCRIPT = `${AS_USER_FN}
user=$1
shift
case $user in ''|root|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
as_user "$user" "$@"
`;

/* argv as the owner of user's runs: as root for root's, as the user for another user's. */
function asOwner(user, argv) {
    return user === "root" ? argv : ["sh", "-c", AS_USER_SCRIPT, "cockpit-cronjobs", user].concat(argv);
}

/* Recorded runs of all jobs (see lib/runs.js): root's under RUNS_DIR (key ID), other
   users' under STATE_DIR/users/USER/runs (key USER/ID), each with the disk use of its
   directory in KB. A run marker whose process is gone is reported with ALIVE 0.
   Another user writes the directories of the user's jobs, so only what has the form
   of a job's runs is listed: directories named by an ID, no links, regular files read
   under a time limit (a FIFO cannot hold up the page), only their last bytes (a file
   swapped for a link to /dev/zero after the check fills no memory, a huge one does not
   reach the page) and without the separator \036 (nothing in them can pass for the
   runs of another job). Users the system does not know any more are left out. */
const RUNS_SCRIPT = `job() {
  id=\${1##*/}
  case $id in ''|*[!A-Za-z0-9_-]*) return ;; esac
  [ \${#id} -le 64 ] && [ -d "$1" ] && [ ! -L "$1" ] || return
  printf '\\036%s\\n' "$2$id"
  printf 'size %s\\n' "$(timeout 10 du -sk "$1" 2>/dev/null | cut -f1)"
  f=$1/runs.jsonl
  if [ -f "$f" ] && [ ! -L "$f" ]; then
    timeout 5 tail -c 65536 "$f" 2>/dev/null | tail -n ${KEEP_RUNS} | tr -d '\\036'
  fi
  for r in "$1"/*.running; do
    [ -f "$r" ] && [ ! -L "$r" ] || continue
    line=$(timeout 5 head -c 4096 "$r" 2>/dev/null | head -n 1 | tr -d '\\036')
    pid=$(printf '%s\\n' "$line" | sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
    alive=0
    if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\\000' ' ' < "/proc/$pid/cmdline" | grep -q cockpit-cronjobs-run; then
      alive=1
    fi
    printf 'running %s %s\\n' "$alive" "$line"
  done
  if [ -f "$1/no-overlap" ] && [ ! -L "$1/no-overlap" ]; then echo 'option no-overlap'; fi
  f=$1/skipped.jsonl
  if [ -f "$f" ] && [ ! -L "$f" ]; then
    timeout 5 tail -c 4096 "$f" 2>/dev/null | tail -n ${KEEP_RUNS} | tr -d '\\036' | sed 's/^/skipped /'
  fi
}
for d in '${RUNS_DIR}'/*; do
  job "$d" ""
done
for u in '${STATE_DIR}'/users/*; do
  user=\${u##*/}
  case $user in root|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) continue ;; esac
  [ -d "$u/runs" ] && [ ! -L "$u" ] && [ ! -L "$u/runs" ] || continue
  id -u "$user" > /dev/null 2>&1 || continue
  for d in "$u"/runs/*; do
    job "$d" "$user/"
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
    return spawn(asOwner(user, ["tail", "-c", "65536", runsDirOf(user) + "/" + id + "/" + out + ".out"]),
                 Object.assign({}, SPAWN_ROOT, { binary: true }))
        .then(decode, ex => {
            if (ex && ex.exit_status === 1) return "";
            throw ex;
        });
}

function removeRuns(user, id) {
    if (!USER_RE.test(user) || !R.ID_RE.test(id)) return Promise.resolve();
    return spawn(asOwner(user, ["rm", "-rf", "--", runsDirOf(user) + "/" + id]), SPAWN_ROOT);
}

/* The newest run cron started of each command, from its log in the journal of the last 35
   days. cron logs each start as "(USER) CMD (COMMAND)" (see C.loggedCommand) from the job's
   process; Debian's cron with -L 8 and more as "(USER) CMD ([PID] COMMAND)", PID being the
   job's, which is left out of the command. As far as cron logs them (C.cronLogs), the end
   and the result of that run: Debian's cron "(USER) END (COMMAND)" (or with "[PID] ") and
   "(CRON) error (grandchild #PID failed with exit status N)" or "… terminated by signal N",
   cronie "(USER) CMDEND (COMMAND)", all from the process that waits for the job. A failure
   belongs to the start of its PID; an end with a PID to that, one without to the start
   whose failure the same process logged, else to the newest start of its command (which
   is a guess only when runs of one command overlap). A PID that started no job (the one
   that feeds the job what follows a %) is left out. Only messages of root (_UID 0, which
   journald sets itself, so no other user can log a run for it) as CRON (Debian's cron) or
   CROND (cronie) count. Not by _COMM: journald reads that from /proc when it takes the
   message, and the job's process logs its start right before it becomes the shell. One line
   for each command, "START END RESULT (USER) CMD (COMMAND)": seconds, END and RESULT
   ("exit:N", "signal:N") "-" when not logged; nothing without journalctl. */
const CRON_LOG_SCRIPT = `command -v journalctl > /dev/null 2>&1 || exit 0
journalctl --no-pager -q -o short-unix --since -35d _UID=0 SYSLOG_IDENTIFIER=CRON SYSLOG_IDENTIFIER=CROND 2>/dev/null |
  awk '
  # "(USER) CMD (COMMAND)" of message m, whose event is ev; n the PID before COMMAND, or ""
  function job(m, ev,   j, c) {
    j = index(m, " " ev " (") + length(ev) + 2
    c = substr(m, j + 1, length(m) - j - 1)
    n = ""
    if (c ~ /^[[][0-9]+[]] /) { n = substr(c, 2, index(c, "]") - 2); c = substr(c, index(c, " ") + 1) }
    return substr(m, 1, index(m, ")")) " CMD (" c ")"
  }
  {
    i = index($0, ": (")
    if (i == 0) next
    m = substr($0, i + 2)
    p = substr($0, 1, i - 1)
    if (!match(p, /[[][0-9]+[]]$/)) next
    p = substr(p, RSTART + 1, RLENGTH - 2)
    split($1, t, ".")
    if (m ~ /^[(][^()]*[)] CMD [(].*[)]$/) {
      k = job(m, "CMD")
      if (n == "") n = p
      if ((k in last) && (last[k] in key) && key[last[k]] == k) delete key[last[k]]
      last[k] = n; when[k] = t[1]; key[n] = k
      delete fin[k]; delete res[k]
    } else if (m ~ /^[(]CRON[)] error [(]grandchild #[0-9]+ (failed with exit status|terminated by signal) [0-9]+/) {
      split(m, w, " ")
      n = substr(w[4], 2)
      if (!(n in key) || last[key[n]] != n) next
      if (w[5] == "failed") r = "exit:" w[9]
      else r = "signal:" w[8]
      sub(/[^0-9]+$/, "", r)
      res[key[n]] = r; mid[p] = n
    } else if (m ~ /^[(][^()]*[)] (END|CMDEND) [(].*[)]$/) {
      ev = substr(m, index(m, ") ") + 2)
      k = job(m, substr(ev, 1, index(ev, " ") - 1))
      if (n == "" && (p in mid)) n = mid[p]
      if (n == "" && (k in last)) n = last[k]
      delete mid[p]
      if ((n in key) && key[n] == k && last[k] == n && !(k in fin)) fin[k] = t[1]
    }
  }
  END {
    for (k in last) {
      e = "-"; r = "-"
      if (k in fin) e = fin[k]
      if (k in res) r = res[k]
      print when[k] " " e " " r " " k
    }
  }'
`;

export function readCronLog() {
    return spawn(["sh", "-c", CRON_LOG_SCRIPT], Object.assign({}, SPAWN_ROOT, { binary: true }))
        .then(out => C.parseCronLog(decode(out)));
}

/* Sets ($2 on) or clears ($2 off) the file no-overlap in a job's directory of runs ($1),
   which keeps the run recorder (version 3) from starting the job while a run of it goes
   on. Run as the owner of that directory, like everything in there. */
const NO_OVERLAP_SCRIPT = `umask 077
case $2 in
  on) mkdir -p -- "$1" && : > "$1/no-overlap" ;;
  off) rm -f -- "$1/no-overlap" ;;
  *) exit 2 ;;
esac
`;

export function setNoOverlap(user, id, on) {
    if (!USER_RE.test(user) || !R.ID_RE.test(id)) return Promise.reject(new Error("not a job of " + user + ": " + id));
    return spawn(asOwner(user, ["sh", "-c", NO_OVERLAP_SCRIPT, "cockpit-cronjobs", runsDirOf(user) + "/" + id, on ? "on" : "off"]),
                 SPAWN_ROOT);
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

/* One directory of leftover runs ($1), run as its owner: "gone" when it is not there,
   "used" when $2 is 1, "running" while a run is going on, else "removed". */
const REMOVE_RUN_DIR_SCRIPT = `d=$1
if [ ! -d "$d" ]; then echo gone; exit 0; fi
if [ "$2" = 1 ]; then echo used; exit 0; fi
for r in "$d"/*.running; do
  [ -f "$r" ] && [ ! -L "$r" ] || continue
  pid=$(timeout 5 head -c 4096 "$r" 2>/dev/null | sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
  if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\\000' ' ' < "/proc/$pid/cmdline" | grep -q cockpit-cronjobs-run; then
    echo running
    exit 0
  fi
done
rm -rf -- "$d" || exit 1
echo removed
`;

/* Removes the run directories of recorded jobs that no crontab uses any more. Under
   the crontab lock, every ID is checked again: a directory stays when its ID
   appears as a word anywhere in the root crontab, /etc/crontab, /etc/anacrontab,
   /etc/cron.d or another user's crontab ("used"), or while a run is going on
   ("running"). If one of these files cannot be read, nothing is removed. The
   directory itself is looked at and removed by its owner ($1, REMOVE_RUN_DIR_SCRIPT):
   another user's as that user, without a handle on the lock. Users the system does
   not know any more are skipped.
   Arguments after $1: ID (root's runs) or USER/ID (another user's). Output:
   "removed|gone|used|running ARGUMENT" for each. Exit 4 = locked, else an error. */
const REMOVE_ORPHANS_SCRIPT = `set -u
trap '' TERM HUP INT
umask 077
${AS_USER_FN}
one=$1
shift
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
  user=root
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
  grep -qE "(^|[^A-Za-z0-9_-])$id([^A-Za-z0-9_-]|\\$)" "$tmp/all"
  case $? in
    0) used=1 ;;
    1) used=0 ;;
    *) exit 1 ;;
  esac
  if [ "$user" = root ]; then
    r=$(sh -c "$one" cockpit-cronjobs "$d" "$used") || exit 1
  else
    id -u "$user" > /dev/null 2>&1 || continue
    r=$(as_user "$user" sh -c "$one" cockpit-cronjobs "$d" "$used" 9>&-) || exit 1
  fi
  case $r in
    gone|used|running|removed) echo "$r $key" ;;
    *) exit 1 ;;
  esac
done
exit 0
`;

/* keys: ID or USER/ID (see R.KEY_RE). Result: { removed: [key…], kept: [key…] };
   "gone" counts as removed. */
export function removeOrphans(keys) {
    const args = ["sh", "-c", REMOVE_ORPHANS_SCRIPT, "cockpit-cronjobs", REMOVE_RUN_DIR_SCRIPT]
        .concat(keys.filter(k => R.KEY_RE.test(k)));
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

/* How the last run of a timer's service ended (Result, exit status, times in ms), or
   whether it is running; nulls when systemd tells nothing about it. */
async function serviceRun(service) {
    const run = { result: null, status: null, startUs: null, exitUs: null, running: false };
    try {
        const path = await unitPath(service);
        const [svc, unit] = await Promise.all([getAll(path, "org.freedesktop.systemd1.Service"),
                                               getAll(path, "org.freedesktop.systemd1.Unit")]);
        run.result = svc.Result || null;
        run.status = typeof svc.ExecMainStatus === "number" ? svc.ExecMainStatus : null;
        run.startUs = usecTime(svc.ExecMainStartTimestamp);
        run.exitUs = usecTime(svc.ExecMainExitTimestamp);
        run.running = unit.ActiveState === "activating" || unit.ActiveState === "deactivating" ||
            (unit.ActiveState === "active" && svc.Type !== "oneshot" && unit.SubState === "running");
    } catch (_) { /* no service details */ }
    return run;
}

/* The journal of a service ($1, NAME.service) as `journalctl -o json`: its last entries,
   with only the fields R.parseJournal reads where journalctl can leave the others out
   (systemd 236 and later). Exit 2 = not a service name. */
const JOURNAL_SCRIPT = `u=$1
case $u in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9:_.@-]*) exit 2 ;; esac
case $u in *.service) ;; *) exit 2 ;; esac
f=MESSAGE,MESSAGE_ID,INVOCATION_ID,_SYSTEMD_INVOCATION_ID,EXIT_CODE,EXIT_STATUS,UNIT_RESULT,JOB_RESULT,_PID
journalctl -u "$u" -o json --no-pager -n 5000 --output-fields="$f" 2>/dev/null ||
  journalctl -u "$u" -o json --no-pager -n 5000
`;

/* The runs of a service from the journal (see R.parseJournal): the last KEEP_RUNS, each
   with up to 64 KB of its output, like the run recorder keeps them. */
export function readJournal(unit) {
    return spawn(["sh", "-c", JOURNAL_SCRIPT, "cockpit-cronjobs", unit], Object.assign({}, SPAWN_ROOT, { binary: true }))
        .then(out => R.parseJournal(decode(out), KEEP_RUNS, 64 * 1024));
}

/* When a timer's service last ran: the later of the timer's last trigger and the start
   of the service's last run (started by hand, it ran without the timer). */
const lastRun = (trigger, run) => run.startUs !== null && (trigger === null || run.startUs > trigger) ? run.startUs : trigger;

/* Only the last runs of the timers in list (from readTimers): when each last ran
   and how its service ended. Cheaper than readTimers, for every half minute. */
export function readTimerRuns(list) {
    return Promise.all(list.map(async t => {
        const props = await getAll(t.path, "org.freedesktop.systemd1.Timer").catch(() => null);
        const run = await serviceRun(t.service);
        return Object.assign(run, { last: lastRun(props ? usecTime(props.LastTriggerUSec) : t.last, run) });
    }));
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
            name, description: u[1], active: u[3] === "active", calendar, monotonic, next, path: u[6],
            last: usecTime(t.LastTriggerUSec), randomizedUsec: t.RandomizedDelayUSec || 0,
            persistent: !!t.Persistent, service: t.Unit || name.replace(/\.timer$/, ".service"), runs: [],
        };
        const run = await serviceRun(timer.service);
        return Object.assign(timer, run, { last: lastRun(timer.last, run) });
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

/* A conversion owns the units it writes: the page makes a token for it (32 hex digits),
   and STATE_DIR/converting/NAME holds that token from writing the units until
   SAVE_SCRIPT has started the timer, or until REMOVE_UNITS_SCRIPT has taken them back.
   Writing, starting and taking back happen under the crontab lock and check the token,
   so two conversions cannot both take a name, and a conversion that fails never
   removes the units of another one, nor those of a conversion that finished. */

/* Writes NAME.service and NAME.timer of a conversion and reloads systemd: $1 the name,
   $2 and $3 the units, $4 the conversion's token. Creates them only when neither
   exists nor is known to systemd, and removes again what it created if anything fails.
   Exit 2 = not a name or token, 4 = locked, 5 = state directory, 6 = name taken. */
export const WRITE_UNITS_SCRIPT = `set -eu
trap '' TERM HUP INT
umask 022
n=$1
tok=$4
case $n in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) exit 2 ;; esac
case $tok in *[!0-9a-f]*) exit 2 ;; esac
[ \${#tok} -eq 32 ] || exit 2
d=/etc/systemd/system
own='${STATE_DIR}/converting'
install -d -m 711 '${STATE_DIR}' || exit 5
exec 9>'${STATE_DIR}/.crontab.lock'
flock -w 10 9 || exit 4
for u in "$n.service" "$n.timer"; do
  if [ -e "$d/$u" ] || [ -L "$d/$u" ]; then exit 6; fi
  st=$(systemctl show -p LoadState --value "$u" 2>/dev/null || :)
  case $st in ''|not-found) ;; *) exit 6 ;; esac
done
madeService=0
madeTimer=0
ok=0
undo() {
  [ "$ok" = 0 ] || return 0
  if [ "$madeService" = 1 ]; then rm -f "$d/$n.service"; fi
  if [ "$madeTimer" = 1 ]; then rm -f "$d/$n.timer"; fi
  if [ "$madeService$madeTimer" != 00 ]; then systemctl daemon-reload > /dev/null 2>&1 || :; fi
  if [ "$(cat "$own/$n" 2>/dev/null)" = "$tok" ]; then rm -f "$own/$n"; fi
}
trap undo EXIT
install -d -m 700 "$own" || exit 5
printf '%s\\n' "$tok" > "$own/$n"
for u in service timer; do
  if ! (set -C; : > "$d/$n.$u") 2> /dev/null; then
    if [ -e "$d/$n.$u" ] || [ -L "$d/$n.$u" ]; then exit 6; fi
    exit 1
  fi
  if [ "$u" = service ]; then madeService=1; else madeTimer=1; fi
done
printf '%s' "$2" > "$d/$n.service"
printf '%s' "$3" > "$d/$n.timer"
systemctl daemon-reload
ok=1
`;

/* Takes back the units of a conversion that did not finish: $1 the name, $2 its token.
   Only while the token is that conversion's (see above). Exit 8 = not its units (any
   more), 4 = locked. */
export const REMOVE_UNITS_SCRIPT = `set -u
trap '' TERM HUP INT
n=$1
tok=$2
case $n in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) exit 2 ;; esac
case $tok in ''|*[!0-9a-f]*) exit 2 ;; esac
own='${STATE_DIR}/converting'
[ -f "$own/$n" ] || exit 8
exec 9>'${STATE_DIR}/.crontab.lock'
flock -w 30 9 || exit 4
[ "$(cat "$own/$n" 2>/dev/null)" = "$tok" ] || exit 8
d=/etc/systemd/system
systemctl disable --now "$n.timer" > /dev/null 2>&1 || :
rm -f "$d/$n.service" "$d/$n.timer"
rm -f "$own/$n"
systemctl daemon-reload
systemctl reset-failed "$n.service" "$n.timer" > /dev/null 2>&1 || :
`;

/* The units of a converted job in /etc/systemd/system, only when Cron Jobs wrote
   them under this name from the crontab of this user: both are files (no links), the
   service starts with the header of a conversion from that crontab (SD.unitHeader)
   and runs as that user, and both have the Description= of such a conversion. So a
   note another user writes into their own crontab cannot reach root's units or theirs.
     $1 check:  exit 0 when both are ours, 9 when neither exists
     $1 remove: checks again, then stops, disables and removes them, all under the
                crontab lock, so that no conversion writes units of that name meanwhile
     $2 the name, $3 the user (default root)
   Exit 8 = not ours (changed, a link, only one of them, or not written by Cron Jobs
   from this crontab), 4 = locked. */
export const UNITS_SCRIPT = `set -u
n=$2
u=\${3:-root}
case $n in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) exit 2 ;; esac
case $u in ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
if [ "$1" = remove ]; then
  trap '' TERM HUP INT
  install -d -m 711 '${STATE_DIR}' || exit 5
  exec 9>'${STATE_DIR}/.crontab.lock'
  flock -w 10 9 || exit 4
fi
if [ "$u" = root ]; then from='root crontab'; else from="crontab of $u"; fi
d=/etc/systemd/system
s=$d/$n.service
t=$d/$n.timer
if [ ! -e "$s" ] && [ ! -L "$s" ] && [ ! -e "$t" ] && [ ! -L "$t" ]; then exit 9; fi
if [ -L "$s" ] || [ -L "$t" ] || [ ! -f "$s" ] || [ ! -f "$t" ]; then exit 8; fi
[ "$(head -n 1 "$s")" = '${SD.UNIT_HEADER_START}'"$from:" ] || exit 8
grep -qxF "User=$u" "$s" || exit 8
grep -qxF "Description=$n (from the $from)" "$s" || exit 8
grep -qxF "Description=$n (from the $from)" "$t" || exit 8
case $1 in
  check) ;;
  remove)
    systemctl disable --now "$n.timer" > /dev/null 2>&1 || :
    rm -f "$s" "$t" || exit 1
    systemctl daemon-reload
    systemctl reset-failed "$n.service" "$n.timer" > /dev/null 2>&1 || :
    ;;
  *) exit 2 ;;
esac
`;
