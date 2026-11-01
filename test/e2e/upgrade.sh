#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The upgrade test of Cron Jobs, on a throw-away machine with systemd and a running cron daemon (CI
# only, never on a server): job upgrade on the runner itself with Debian's cron and the .deb, and the
# suite upgrade of job e2e-el in a Rocky Linux VM with cronie, SELinux enforcing and the .rpm. It
# replaces root's crontab, gives the user cjuser a crontab, and installs, upgrades and removes the
# package. In three steps, so that the workflow can mark the audit log after the first (tools/vm.sh
# avc-mark) and fail on any SELinux denial after the last (avc-check):
#
#   sudo env OUT=upgrade-session sh test/e2e/upgrade.sh old OLD.deb|OLD.rpm
#   sudo env OUT=upgrade-session sh test/e2e/upgrade.sh new NEW.deb|NEW.rpm
#   sudo env OUT=upgrade-session sh test/e2e/upgrade.sh remove
#
# old     The previous release, as its GitHub release serves it (test/e2e/release-asset.sh), set
#         up as an administrator sets it up on its page: the run recorder that comes with it, jobs
#         of root and of cjuser that record their runs (one of each fails) and one of each that
#         does not. cron records runs of all four. Then that release's status unit: with SELinux
#         enforcing it fails, as 2.10.2 does there (systemd runs the helper in init_t, which may
#         not read the crontab of cjuser: an AVC denial, "cannot read the crontab of cjuser", and
#         no status for the Status Board); without SELinux it writes the status.
# new     The package of this build over it, as an update from the package repository does (as a
#         reinstall while this build has the version of that release, before a release raises
#         it): both crontabs byte for byte, every recorded run with its output, the run recorder,
#         the user's directory of runs and the status timer (enabled, active) as before; systemd
#         runs the units of this build. The status the upgrade writes, and the unit run once more
#         after cron recorded again, counts the two failed jobs by their IDs and the two without
#         recording, read as nobody and as cjuser, in English and German, without user names.
# remove  The package removed: its files, its units and the status files are gone and systemd no
#         longer knows the timer; the crontabs, the recorded runs and the run recorder stay
#         (README, "Uninstall"), and cron goes on recording.
#
# Writes OUT/report.md (each step adds to it) and the raw answers; what a later step compares with
# is in OUT/keep. Exit 1 at the first check that fails.
set -eu
usage="usage: upgrade.sh old OLD.deb|OLD.rpm | new NEW.deb|NEW.rpm | remove"
phase=${1:?$usage}
out=${OUT:-upgrade-session}
case $out in /*) ;; *) out=$PWD/$out ;; esac
keep=$out/keep
report=$out/report.md
mkdir -p "$keep"

state=/var/lib/cockpit-cronjobs
wrap=/usr/local/libexec/cockpit-cronjobs-run
page=/usr/share/cockpit/cronjobs
helper=/usr/lib/cockpit-cronjobs/cronjobs-status
timer=cockpit-cronjobs-status.timer
service=cockpit-cronjobs-status.service
user=cjuser
# The jobs that record their runs (USER:ID), and the IDs of those that fail and of those that do not.
jobs="root:upgrade-ok-1a2b root:upgrade-fail-3c4d $user:report-5e6f $user:sync-7a8b"
failing="sync-7a8b upgrade-fail-3c4d"
passing="report-5e6f upgrade-ok-1a2b"
audit=/var/log/audit/audit.log
selinux=0
if command -v getenforce > /dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then selinux=1; fi
step=$(cat "$keep/step" 2> /dev/null || echo 0)

ok() { echo "- ok: $*" | tee -a "$report"; }
fail() { echo "- FAILED: $*" | tee -a "$report"; exit 1; }
next() { step=$((step + 1)); echo "$step" > "$keep/step"; printf '\n## %s. %s\n\n' "$step" "$*" | tee -a "$report"; }
note() { echo "  $*" | tee -a "$report"; }

kind_of() {
    case $1 in
        *.deb) echo deb ;;
        *.rpm) echo rpm ;;
        *) echo "upgrade.sh: a .deb or an .rpm, not $1" >&2; exit 64 ;;
    esac
}
# "installed VERSION" while the package is installed, anything else when not.
installed() {
    if [ "$kind" = deb ]; then
        dpkg-query -W -f '${db:Status-Status} ${Version}' cockpit-cronjobs 2> /dev/null || true
    else
        rpm -q --qf 'installed %{VERSION}-%{RELEASE}' cockpit-cronjobs 2> /dev/null || true
    fi
}
version_of() {
    if [ "$kind" = deb ]; then dpkg-deb -f "$1" Version; else rpm -qp --qf '%{VERSION}-%{RELEASE}' "$1" 2> /dev/null; fi
}
# install_package FILE NAME: as an update from the package repository installs it; the output in
# OUT/NAME.txt.
install_package() {
    if [ "$kind" = deb ]; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$1" > "$out/$2.txt" 2>&1
    else
        dnf install -y -q "$1" > "$out/$2.txt" 2>&1
    fi
}
# reinstall_package FILE NAME: the same version again (dpkg and rpm run the package's scripts as
# for an upgrade: postinst configure, %post with two versions installed).
reinstall_package() {
    if [ "$kind" = deb ]; then
        dpkg -i "$1" > "$out/$2.txt" 2>&1
    else
        dnf reinstall -y -q "$1" > "$out/$2.txt" 2>&1
    fi
}
remove_package() {
    if [ "$kind" = deb ]; then
        DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq cockpit-cronjobs > "$out/$1.txt" 2>&1
    else
        dnf remove -y -q cockpit-cronjobs > "$out/$1.txt" 2>&1
    fi
}
cron_unit() {
    for u in cron.service crond.service; do
        if [ "$(systemctl show -p LoadState --value "$u" 2> /dev/null)" = loaded ]; then echo "$u"; return; fi
    done
}
page_version() { sed -n 's/^ *const VERSION = "\(.*\)";/\1/p' "$page/app.js"; }
timer_state() { echo "$(systemctl is-enabled "$timer" 2> /dev/null || true) $(systemctl is-active "$timer" 2> /dev/null || true)"; }
# The status as the user $1 gets it, in the language $2 (what the Status Board and the menu icon read).
status_as() { setpriv --reuid="$(id -u "$1")" --regid="$(id -g "$1")" --clear-groups "$helper" status --lang "$2"; }
# Lines of the audit log after line $1 that tell of an SELinux denial.
denials_after() { tail -n +"$(($1 + 1))" "$audit" | grep -E 'type=(AVC|USER_AVC|SELINUX_ERR|USER_SELINUX_ERR) ' || true; }

# check_status FILE LANG WANT: the status document FILE in LANG against WANT: "none" (no status
# written) or "counted" (the two failed jobs by their IDs, the two without recording, cron running).
# Prints what is wrong and returns 1 then.
check_status() {
    python3 - "$1" "$2" "$3" "$cron" "$user" "$failing" "$passing" "$(page_version)" << 'EOF'
import json, sys
path, lang, want, unit, user, failing, passing, version = sys.argv[1:]
text = open(path, encoding="utf-8").read()
try:
    d = json.loads(text)
except ValueError as e:
    sys.exit(f"not JSON ({e}): {text[:400]!r}")
de = lang == "de"
bad = []


def need(cond, what):
    if not cond:
        bad.append(what)


need(d.get("schema") == 1 and d.get("addon") == "cronjobs", "schema 1 of cronjobs")
items = {i.get("id"): i for i in d.get("items", [])}
if want == "none":
    need(d.get("state") == "none" and not items, "state none, no items")
    need(("Noch kein Status" if de else "No status yet") in d.get("summary", ""), "the summary says there is no status yet")
else:
    need(d.get("version") == version, f"version {version}")
    need(d.get("state") == "danger", "state danger")
    need(d.get("summary") == ("2 Jobs sind in den letzten 24 Stunden fehlgeschlagen." if de else "2 jobs failed in the last 24 hours."),
         "the summary")
    f = items.get("failed", {})
    need(f.get("state") == "danger" and f.get("value") == "2" and f.get("detail") == ", ".join(sorted(failing.split())),
         "failed: danger, 2, the IDs of the two")
    need(f.get("link") == "#/overview/results", "failed links to the latest results")
    u = items.get("unrecorded", {})
    need(u.get("state") == "none" and u.get("value") == "2" and u.get("detail", "").startswith("2 von 6 Jobs" if de else "2 of 6 jobs"),
         "unrecorded: 2 of 6 jobs")
    c = items.get("cron", {})
    need(c.get("state") == "ok" and c.get("value") == ("läuft" if de else "running") and
         c.get("detail") == (f"{unit} läuft." if de else f"{unit} is running."), "cron: running")
    need(not any(i in text for i in passing.split()), "no job that did not fail")
need(user not in text, "no user name")
if bad:
    print("; ".join(bad) + ": " + text)
    sys.exit(1)
EOF
}

# scheduled USER ID SINCE: how many runs cron started of the job have a record from SINCE on.
scheduled() {
    if [ "$1" = root ]; then f=$state/runs/$2/runs.jsonl; else f=$state/users/$1/runs/$2/runs.jsonl; fi
    if [ ! -f "$f" ]; then echo 0; return; fi
    awk -v since="$3" '/"trigger":"schedule"/ && match($0, /"start":[0-9]+/) && substr($0, RSTART + 8, RLENGTH - 8) + 0 >= since + 0 { n++ }
        END { print n + 0 }' "$f"
}
# wait_runs SINCE: waits up to three minutes until cron has recorded a run of every job from SINCE
# on (they run every minute); prints the jobs without one when it gives up.
wait_runs() {
    end=$(($(date +%s) + 180))
    while :; do
        missing=
        for j in $jobs; do
            [ "$(scheduled "${j%%:*}" "${j#*:}" "$1")" -gt 0 ] || missing="$missing $j"
        done
        [ -n "$missing" ] || return 0
        if [ "$(date +%s)" -ge "$end" ]; then echo "$missing"; return 1; fi
        sleep 3
    done
}
# Waits until no recorded run goes on and the next start is ten seconds away or more, so that a
# copy of the runs holds whole records.
quiet_runs() {
    for _ in $(seq 1 120); do
        s=$(($(date +%s) % 60))
        if [ "$s" -ge 10 ] && [ "$s" -le 45 ] && [ -z "$(find "$state/runs" "$state/users" -name '*.running' 2> /dev/null)" ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}
# Whether every file of the runs that the step old copied is there as it was; runs.jsonl may have
# grown by the runs since (the run recorder adds a line for each and keeps the last 20). Prints how
# many files, or the first that is not.
kept_runs() {
    (cd "$keep/runs" && find . -type f) > "$keep/runs.list"
    n=0
    while read -r f; do
        f=${f#./}
        case $f in
            */runs.jsonl)
                if ! awk 'NR == FNR { now[$0] = 1; next } !($0 in now) { lost = 1 } END { exit lost }' "$state/$f" "$keep/runs/$f" 2> /dev/null; then
                    echo "$f lost records"
                    return 1
                fi ;;
            *)
                if ! cmp -s "$state/$f" "$keep/runs/$f"; then
                    echo "$f changed or gone"
                    return 1
                fi ;;
        esac
        n=$((n + 1))
    done < "$keep/runs.list"
    echo "$n files"
}
# The crontabs of root and cjuser as the step old wrote them (through a pipe: crontab may run in a
# domain of its own under SELinux).
same_crontabs() {
    crontab -l -u root | cmp -s - "$keep/root.tab" || { echo "root's crontab changed"; return 1; }
    crontab -l -u "$user" | cmp -s - "$keep/user.tab" || { echo "the crontab of $user changed"; return 1; }
}

old() {
    pkg=$1
    kind=$(kind_of "$pkg")
    case $pkg in /*) ;; *) pkg=$PWD/$pkg ;; esac
    echo "$kind" > "$keep/kind"
    echo "# Cron Jobs: upgrade" > "$report"
    step=0
    old_version=$(version_of "$pkg")
    echo "$old_version" > "$keep/old-version"
    cron=$(cron_unit)
    [ -n "$cron" ] || fail "no cron service (cron.service or crond.service)"
    command -v python3 > /dev/null || fail "python3 is missing"

    next "The previous release, $old_version"
    if [ "$selinux" = 1 ]; then note "SELinux: $(getenforce), $(rpm -q selinux-policy-targeted 2> /dev/null || true)"; else note "SELinux: not enforcing"; fi
    install_package "$pkg" install-old || { cat "$out/install-old.txt"; fail "install $pkg"; }
    [ "$(installed)" = "installed $old_version" ] || fail "installed: $(installed)"
    systemctl enable --now "$cron" > /dev/null 2>&1 || fail "start $cron"
    if [ "$kind" = deb ]; then
        note "$(dpkg-query -W -f '${Package} ${Version}, ' cockpit-cronjobs cockpit-bridge cron 2> /dev/null || true)"
    else
        note "$(rpm -q cockpit-cronjobs cockpit-bridge cronie | paste -sd ' ' -)"
    fi
    [ "$(timer_state)" = "enabled active" ] || fail "the status timer after the install: $(timer_state)"
    ok "$old_version installed, $cron running, the status timer enabled and active"

    next "Set up as on its page: the run recorder, jobs of root and of $user"
    # The run recorder that comes with that release, where its page installs it
    # (INSTALL_WRAPPER_SCRIPT: mode 755).
    install -D -m 755 "$page/cockpit-cronjobs-run" "$wrap"
    ok "run recorder $(sed -n 's/^CRONJOBS_RUN_VERSION=//p' "$wrap") at $wrap"
    t_setup=$(date +%s)
    cat > "$keep/root.tab" << EOF
MAILTO=""
# Records its runs; succeeds.
* * * * * $wrap upgrade-ok-1a2b 'echo recorded run of root'
# Records its runs; fails.
* * * * * $wrap upgrade-fail-3c4d 'echo failing run of root; exit 3'
# Does not record its runs.
0 5 1 1 * true # plain job of root
EOF
    cat "$keep/root.tab" | crontab -u root -
    if [ "$selinux" = 1 ]; then
        # With only root's crontab: does the unit of that release read it? A note, not a check.
        rm -f "$state/status.json" "$state/status.de.json"
        mark=$(wc -l < "$audit")
        since=$(date +%s)
        rc=0
        systemctl start "$service" > /dev/null 2>&1 || rc=$?
        sleep 3
        said=$(journalctl -u "$service" --since "@$since" --no-pager -o cat 2> /dev/null | grep 'cronjobs-status:' | tail -n 1 || true)
        written=none
        if [ -f "$state/status.json" ]; then written=written; fi
        note "With only root's crontab ($(ls -Z /var/spool/cron/root | cut -d ' ' -f 1)), the status unit of $old_version:" \
            "exit $rc, $(denials_after "$mark" | wc -l) SELinux denials, status file $written. ${said:-}"
        systemctl reset-failed "$service" 2> /dev/null || true
    fi
    id -u "$user" > /dev/null 2>&1 || useradd -m -s /bin/sh "$user"
    # The user's directory of runs, as the page makes it (USER_RUNS_SCRIPT).
    (
        umask 077
        mkdir -p "$state/users"
        chmod 711 "$state" "$state/users"
        [ -d "$state/users/$user" ] || mkdir "$state/users/$user"
        chown -h "$user:" "$state/users/$user"
        chmod 700 "$state/users/$user"
    )
    cat > "$keep/user.tab" << EOF
MAILTO=""
* * * * * $wrap report-5e6f 'echo recorded run of the user'
* * * * * $wrap sync-7a8b 'echo failing run of the user >&2; exit 4'
15 3 * * * true # plain job of the user
EOF
    cat "$keep/user.tab" | crontab -u "$user" -
    msg=$(same_crontabs) || fail "$msg right after writing"
    ok "root's crontab and that of $user: two jobs each that record their runs (one fails), one that does not"

    next "cron records runs of all four"
    missing=$(wait_runs "$t_setup") || fail "no run cron recorded of$missing"
    grep -q '"rc":3,' "$state/runs/upgrade-fail-3c4d/runs.jsonl" || fail "root's failing job: no exit code 3"
    grep -q '"rc":4,' "$state/users/$user/runs/sync-7a8b/runs.jsonl" || fail "the failing job of $user: no exit code 4"
    grep -q '"rc":0,' "$state/users/$user/runs/report-5e6f/runs.jsonl" || fail "the job of $user that succeeds: no exit code 0"
    grep -qx 'failing run of the user' "$state/users/$user/runs/sync-7a8b/"*.out || fail "the output of the failing job of $user"
    [ "$(stat -c %U "$state/users/$user/runs/sync-7a8b/runs.jsonl")" = "$user" ] || fail "the runs of $user are not the user's"
    ok "a run of each job recorded, with its exit code and output; those of $user as $user"

    next "The status unit of $old_version"
    rm -f "$state/status.json" "$state/status.de.json"
    if [ "$selinux" = 1 ]; then mark=$(wc -l < "$audit"); fi
    since=$(date +%s)
    rc=0
    systemctl start "$service" > "$out/old-unit.txt" 2>&1 || rc=$?
    journalctl -u "$service" --since "@$since" --no-pager -o cat > "$out/old-unit-journal.txt" 2>&1 || true
    status_as nobody en > "$out/old-status.json" || fail "status as nobody: $(cat "$out/old-status.json")"
    if [ "$selinux" = 1 ]; then
        [ "$rc" != 0 ] || fail "the unit of $old_version ran under SELinux enforcing: the old failure did not show"
        grep -qx "cronjobs-status: cannot read the crontab of $user" "$out/old-unit-journal.txt" ||
            fail "the unit failed, but not for the crontab of $user: $(cat "$out/old-unit-journal.txt")"
        # auditd writes asynchronously.
        for _ in $(seq 1 10); do
            denials_after "$mark" | grep 'scontext=system_u:system_r:init_t:' | grep -E 'tcontext=[^ ]*:user_cron_spool_t:' > "$out/old-avc.txt" || true
            [ ! -s "$out/old-avc.txt" ] || break
            sleep 1
        done
        [ -s "$out/old-avc.txt" ] || fail "no SELinux denial of init_t for the crontabs (user_cron_spool_t): $(denials_after "$mark")"
        [ ! -e "$state/status.json" ] || fail "a status file was written"
        msg=$(check_status "$out/old-status.json" en none) || fail "the status as nobody: $msg"
        ok "as on systems with SELinux enforcing, the unit fails (exit $rc): \"$(cat "$out/old-unit-journal.txt" | grep cronjobs-status: | tail -n 1)\""
        while read -r line; do note "$line"; done < "$out/old-avc.txt"
        ok "no status for the Status Board: as nobody it says $(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["summary"])' "$out/old-status.json")"
    else
        [ "$rc" = 0 ] || fail "the unit of $old_version: $(cat "$out/old-unit.txt" "$out/old-unit-journal.txt")"
        msg=$(check_status "$out/old-status.json" en counted) || fail "the status as nobody: $msg"
        ok "the unit writes the status (no SELinux here); as nobody it counts the two failed jobs by their IDs"
    fi

    next "What the upgrade has to keep"
    quiet_runs || fail "recorded runs did not stop going on"
    rm -rf "$keep/runs"
    mkdir -p "$keep/runs"
    cp -a "$state/runs" "$state/users" "$keep/runs/"
    cp -p "$wrap" "$keep/wrap"
    stat -c '%U %a' "$state/users/$user" > "$keep/user-dir"
    timer_state > "$keep/timer"
    [ "$(cat "$keep/timer")" = "enabled active" ] || fail "the status timer before the upgrade: $(cat "$keep/timer")"
    ok "the crontabs, $( (cd "$keep/runs" && find . -type f) | wc -l) files of recorded runs, the run recorder, the status timer ($(cat "$keep/timer"))"
    if [ "$selinux" = 1 ]; then
        # The timer of that release starts its unit at :00, :15, :30 and :45 (up to a minute late):
        # a denial after the workflow's mark, before the upgrade replaced the unit, would fail the
        # job. So this step ends at least four minutes before the next quarter of an hour.
        while s=$(($(date +%s) % 900)); [ "$s" -lt 90 ] || [ "$s" -gt 660 ]; do sleep 5; done
    fi
}

new() {
    pkg=$1
    kind=$(cat "$keep/kind")
    [ "$(kind_of "$pkg")" = "$kind" ] || fail "this build is a .$(kind_of "$pkg"), the previous release a .$kind"
    case $pkg in /*) ;; *) pkg=$PWD/$pkg ;; esac
    old_version=$(cat "$keep/old-version")
    new_version=$(version_of "$pkg")
    cron=$(cron_unit)

    next "This build, $new_version, over $old_version"
    t_up=$(date +%s)
    if [ "$new_version" = "$old_version" ]; then
        note "This build has the version of the previous release: no release has raised it yet. Installed over it"
        note "as a reinstall ($([ "$kind" = deb ] && echo 'dpkg -i' || echo 'dnf reinstall')), which runs the package's scripts as an upgrade does."
        reinstall_package "$pkg" install-new || { cat "$out/install-new.txt"; fail "reinstall $pkg"; }
    else
        install_package "$pkg" install-new || { cat "$out/install-new.txt"; fail "upgrade to $pkg"; }
    fi
    [ "$(installed)" = "installed $new_version" ] || fail "installed: $(installed)"
    grep -qxF "ExecStart=/bin/sh $helper write" "/usr/lib/systemd/system/$service" ||
        fail "the status unit is not the one of this build: $(grep ExecStart= "/usr/lib/systemd/system/$service")"
    [ "$(systemctl show -p NeedDaemonReload --value "$service")" = no ] || fail "systemd still has the units of $old_version"
    ok "$new_version installed; systemd has its status unit (ExecStart through /bin/sh)"

    next "Crontabs, recorded runs, run recorder and status timer as before"
    msg=$(same_crontabs) || fail "$msg"
    ok "both crontabs byte for byte"
    msg=$(kept_runs) || fail "recorded runs: $msg"
    ok "every recorded run and its output as before ($msg)"
    cmp -s "$wrap" "$keep/wrap" || fail "the run recorder changed"
    [ "$(stat -c '%U %a' "$state/users/$user")" = "$(cat "$keep/user-dir")" ] || fail "the directory of $user: $(stat -c '%U %a' "$state/users/$user")"
    ok "the run recorder untouched, the directory of runs of $user still the user's ($(cat "$keep/user-dir"))"
    [ "$(timer_state)" = "$(cat "$keep/timer")" ] || fail "the status timer: $(timer_state), before: $(cat "$keep/timer")"
    ok "the status timer as before: $(timer_state)"

    next "The status the upgrade writes"
    # The package starts the unit right away (packaging/scripts/configure, --no-block).
    end=$(($(date +%s) + 120))
    while :; do
        a=$(systemctl show -p ActiveState --value "$service")
        m=$(stat -c %Y "$state/status.json" 2> /dev/null || echo 0)
        if [ "$m" -ge "$t_up" ] && [ "$a" != activating ]; then break; fi
        [ "$(date +%s)" -lt "$end" ] || fail "no status from the unit the upgrade started (ActiveState $a)"
        sleep 2
    done
    [ "$(systemctl show -p Result --value "$service")" = success ] ||
        fail "the unit: $(systemctl show -p Result --value "$service"); $(journalctl -u "$service" --since "@$t_up" --no-pager -o cat)"
    [ "$(stat -c %a "$state/status.json") $(stat -c %a "$state/status.de.json")" = "644 644" ] || fail "status files not of mode 644"
    status_as nobody en > "$out/new-status.json" || fail "status as nobody: $(cat "$out/new-status.json")"
    msg=$(check_status "$out/new-status.json" en counted) || fail "the status as nobody: $msg"
    ok "written by the unit the upgrade started: as nobody it counts the two failed jobs by their IDs"
    since=$(date +%s)
    systemctl start "$service" > "$out/new-unit.txt" 2>&1 ||
        fail "the unit: $(cat "$out/new-unit.txt"); $(journalctl -u "$service" --since "@$since" --no-pager -o cat)"
    ok "the unit runs again, exit 0"

    next "cron goes on recording, and the status counts it"
    missing=$(wait_runs "$t_up") || fail "no run after the upgrade of$missing"
    ok "a run of each job after the upgrade, recorded as before"
    systemctl start "$service" > "$out/new-unit-2.txt" 2>&1 || fail "the unit: $(cat "$out/new-unit-2.txt")"
    for who in nobody "$user"; do
        for lang in en de; do
            status_as "$who" "$lang" > "$out/status-$who-$lang.json" || fail "status as $who ($lang): $(cat "$out/status-$who-$lang.json")"
            msg=$(check_status "$out/status-$who-$lang.json" "$lang" counted) || fail "the status as $who ($lang): $msg"
        done
    done
    ok "as nobody and as $user, in English and German: the two failed jobs by their IDs, 2 of 6 jobs without recording, $cron running, no user name"
    if [ "$selinux" = 1 ]; then note "Whether SELinux denied anything from the upgrade on, the workflow checks after the removal (tools/vm.sh avc-check)."; fi
}

remove() {
    kind=$(cat "$keep/kind")

    next "The package removed"
    t_rm=$(date +%s)
    remove_package remove || { cat "$out/remove.txt"; fail "remove the package"; }
    case $(installed) in "installed "*) fail "still installed: $(installed)" ;; esac
    for p in "$page" /usr/lib/cockpit-cronjobs "/usr/lib/systemd/system/$service" "/usr/lib/systemd/system/$timer" \
            /usr/share/metainfo/de.azentrius.cronjobs.metainfo.xml /usr/share/doc/cockpit-cronjobs \
            "$state/status.json" "$state/status.de.json" "/etc/systemd/system/timers.target.wants/$timer"; do
        [ ! -e "$p" ] && [ ! -L "$p" ] || fail "left behind: $p"
    done
    ok "the page, the status helper, its units, the AppStream data, the documentation and the status files are gone"
    [ "$(systemctl show -p LoadState --value "$timer")" = not-found ] && [ "$(systemctl show -p LoadState --value "$service")" = not-found ] ||
        fail "systemd still knows the status units: $(systemctl show -p LoadState --value "$timer") $(systemctl show -p LoadState --value "$service")"
    ok "systemd no longer knows the status timer and its service"

    next "What stays: crontabs, recorded runs, run recorder"
    msg=$(same_crontabs) || fail "$msg"
    msg=$(kept_runs) || fail "recorded runs: $msg"
    cmp -s "$wrap" "$keep/wrap" || fail "the run recorder changed or is gone"
    ok "both crontabs byte for byte, every recorded run ($msg), the run recorder"
    missing=$(wait_runs "$t_rm") || fail "no run after the removal of$missing"
    ok "cron goes on recording the jobs that record their runs"
}

case $phase in
    old) old "${2:?$usage}" ;;
    new) new "${2:?$usage}" ;;
    remove) remove ;;
    *) echo "$usage" >&2; exit 64 ;;
esac
