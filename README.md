# Cron Jobs

A [Cockpit](https://cockpit-project.org) page for cron. It shows everything that is scheduled on a
server, lets you change the root crontab and those of other users safely, keeps the result of every run,
starts jobs on demand and turns cron jobs into systemd timers.

![Overview: the latest results, the next 24 hours and the root crontab](docs/overview.png)

## What it does

- **Everything that runs, in one place.** The root crontab, `/etc/crontab`, `/etc/cron.d`, the crontabs of
  other users, the scripts in `/etc/cron.hourly` … `/etc/cron.monthly`, and systemd timers. Schedules are
  written out in words; next runs are shown in server time, and in your own time when that differs.
  Files in `/etc/cron.d` that cron skips (name, owner, permissions, symbolic links, hard links) are marked
  with the reason, by the rules of the cron that is installed.
- **Three tabs.** Overview (the latest results, the next 24 hours, the root crontab and those of other
  users), systemd timers, and System (`/etc/crontab`, `/etc/cron.d`, the periodic scripts). Notices stay
  visible in every tab; switching tabs loads nothing.
- **The latest results.** The last run of every recorded job and every systemd timer in one list,
  failures first, successful ones folded away. Runs and timers are read again every half minute, so a
  failure shows within a minute without reloading.
- **Runs from the journal.** Every systemd timer gets the same runs dialog as a recorded job, from the
  journal of its service: start, duration, result and output. A job converted to a timer keeps its
  history there: the runs recorded before the conversion and those of its service since.
- **The next 24 hours.** A timeline of all cron jobs and timers. Jobs that start in the same minute are
  pointed out.
- **Safe changes to the root crontab.** Add, edit, switch off and on, delete. Lines you do not touch stay
  byte for byte. Each change is written in one locked step, only if the crontab is still the one you see,
  after a backup of the previous version; afterwards it is read back and compared.
- **Crontabs of other users.** With administrative access, every other user's crontab gets a card of its
  own and is changed the same way, through `crontab -u USER`, with backups of its own; its jobs run as
  that user. Without administrative access they are not shown at all. Run now starts their jobs as that
  user, in the user's home with cron's environment, their runs can be recorded, and a conversion gives
  a timer that runs the job as that user (`User=`).
- **Backups you can use.** The last ten versions of the root crontab, each with what restoring it would
  change, line by line as `diff` shows it. Restoring goes through the same locked step, after a backup of
  the current version, so a restore can be undone the same way.
- **The result of every run.** Turn on recording for a job and it keeps exit code, duration and output of
  its last 20 runs. Handy on servers without a mail program, where cron's output is otherwise lost.
- **Run now.** Starts a job right away with the environment cron gives it on this server (see below) and
  input after `%`, shows the output live and can stop it.
- **Convert to a systemd timer.** Creates `NAME.service` and `NAME.timer` with the same schedule (checked
  against `systemd-analyze`), the same command and environment, checks what systemd read, starts the
  timer and switches the cron line off with a note. **Back to cron** undoes it in one step: the line is
  on again exactly as before, the note is gone, and the timer is stopped and its units removed. The units
  name the crontab they come from, and back to cron removes only units converted from the crontab whose
  note it follows, so a note a user writes into their own crontab cannot reach anyone else's timer.
- **A status for the Status Board.** Failed jobs of the last 24 hours and jobs without recording, in the
  status format all Azentrius Cockpit add-ons share, readable without administrative access (see below).
- English and German, following Cockpit's language. Light and dark, following Cockpit's style. Usable on
  a phone.

| Run now | Recorded runs | Convert to systemd timer | Backups |
|---|---|---|---|
| ![Run now](docs/run-now.png) | ![Runs](docs/runs.png) | ![Convert](docs/convert.png) | ![Backups](docs/backups.png) |

## Requirements

- Cockpit 314 or newer (tested with 314, the one of Ubuntu 24.04, and 362 from its backports)
- cron: `cron` on Debian and Ubuntu, or `cronie` (Fedora, RHEL and its rebuilds, Arch, openSUSE)
- coreutils, util-linux (`flock`, `setsid`), `sed`, `grep`, `awk`: present on any normal installation
- systemd, optionally: for the timers, the timeline entries of timers, the conversion and the status for
  the Status Board

With cronie, `CRON_TZ` is taken into account for next runs, the timeline and the conversion, in every
crontab including `/etc/crontab` and `/etc/cron.d`. When the clock changes, next runs and the timeline
follow cron: when summer time ends, the repeated hour runs only the jobs with `*` in the minute or hour
field again; when it starts, jobs at a fixed time of the skipped hour run right after the change.

Changes need administrative access in Cockpit (“Limited access” turned off). Without it the page shows
the system crontabs and timers, and nothing of other users' crontabs.

## Installation

**From the Azentrius package repository** (Debian, Ubuntu, Fedora, RHEL). Set up
[packages.azentrius.com](https://packages.azentrius.com) once:

```sh
# Debian and Ubuntu
curl -fsSLO https://packages.azentrius.com/azentrius-repository.deb
sudo apt install ./azentrius-repository.deb
sudo apt update

# Fedora and RHEL
sudo rpm --import https://packages.azentrius.com/azentrius.asc
sudo dnf install https://packages.azentrius.com/azentrius-repository.rpm
```

RHEL and its derivatives use the same `dnf` set-up, but it is tested on Fedora only. The repository
has no set-up for openSUSE: there, install the `.rpm` of a release (below).

Then install **Cron Jobs** in Cockpit under **Applications** (with administrative access), or on the
console with `sudo apt install cockpit-cronjobs` or `sudo dnf install cockpit-cronjobs`. The system's
updates keep it current. The repository takes a package only after checking that this repository's
release workflow built it, and signs it.

**From the files of a release** (on openSUSE the only way). Every
[release](https://github.com/Azentrius/cockpit-cronjobs/releases) has the `.deb` and the `.rpm`,
`SHA256SUMS` and a signed build provenance. Download the package and `SHA256SUMS` into one folder,
check both, then install (`X.Y.Z` is the version):

```sh
sha256sum --ignore-missing -c SHA256SUMS                         # complete and unchanged
gh attestation verify <file> --repo Azentrius/cockpit-cronjobs   # built by this repository's release workflow

sudo apt install ./cockpit-cronjobs_X.Y.Z-1_all.deb                              # Debian, Ubuntu
sudo dnf install ./cockpit-cronjobs-X.Y.Z-1.noarch.rpm                           # Fedora, RHEL
sudo zypper install --allow-unsigned-rpm ./cockpit-cronjobs-X.Y.Z-1.noarch.rpm   # openSUSE
```

The `.rpm` of a release carries no package signature (the repository signs its own copy): `zypper`
needs `--allow-unsigned-rpm`, and the two checks above take the place of the signature. The tests
install the `.deb` on Debian 13 and the `.rpm` on Fedora 43; installing the packages on Ubuntu,
RHEL or openSUSE is untested.

On other systems the archive `cockpit-cronjobs-X.Y.Z.tar.gz` of a release holds the page:
`sudo tar -xzf cockpit-cronjobs-X.Y.Z.tar.gz -C /usr/share/cockpit`. It brings no status for the Status
Board (see below); the packages do.

**From the source.** `git clone` this repository, then `sudo make install`: the page to
`/usr/local/share/cockpit/cronjobs`, the status helper to `/usr/lib/cockpit-cronjobs` and its timer to
`/usr/lib/systemd/system`, turned on.

**From an earlier installation.** A page installed from the archive or the source is not part of the
package, and one in `/usr/local` would hide it. Remove it first, then install the package:
`sudo rm -rf /usr/share/cockpit/cronjobs` (archive) or `sudo make uninstall` in the checkout
(source). Backups, recorded runs and the run recorder stay.

**Cron Jobs** appears in Cockpit's menu; if it does not show yet, log in to Cockpit again.

For development, `make devel-install` links `src` to `~/.local/share/cockpit/cronjobs`.

## Recording runs

When you turn on “Record result and output” for a job, Cron Jobs installs a small shell script,
`/usr/local/libexec/cockpit-cronjobs-run` (once), and changes the job's line from

```
30 2 * * * /usr/local/bin/backup.sh
```

to

```
30 2 * * * /usr/local/libexec/cockpit-cronjobs-run backup-1a2b '/usr/local/bin/backup.sh'
```

The script runs the command with `$SHELL -c`, just as cron does, and passes the output through, so mail
from cron keeps working. It keeps the last 20 runs, each with up to 64 KiB of output, in
`/var/lib/cockpit-cronjobs/runs/backup-1a2b/`. If it cannot record, the command runs anyway.

A job of another user runs as that user, so it cannot write there: its runs go to
`/var/lib/cockpit-cronjobs/users/USER/runs/`, a directory that belongs to the user (mode 700). Cron Jobs
creates it when you turn on recording for the first job of that user; `/var/lib/cockpit-cronjobs` and
`/var/lib/cockpit-cronjobs/users` are then mode 711, so the user can reach it but list nothing.
Because the directory is the user's, Cron Jobs reads the output and removes the runs there as that user,
and lists only what has the form of runs: nothing the user puts there reaches beyond the user's own jobs.

- Commands with an unescaped `%` cannot be recorded (cron passes the text after `%` as input).
- Turning recording off restores the plain line and deletes the recorded runs.
- When a recorded line is changed or removed outside Cron Jobs, its runs are left over. They are listed
  under the root crontab and can be removed there. A job whose ID any crontab still mentions, even in a
  comment, is never offered, and the check is repeated as root right before anything is removed.
- The command keeps its environment and umask. Mail from cron and the `CMD` line in the system log show
  the wrapper call instead of the plain command; adjust filters that match on them.
- Jobs that record their runs need the script. Before you remove Cron Jobs, turn recording off, or leave
  the script in place.

## Status for the Status Board

Cron Jobs reports its state in the format that all Azentrius Cockpit add-ons share (schema 1), for the
Azentrius Status Board, which shows every add-on of every host in one place. `src/manifest.json` names
the helper:

```json
"azentrius": { "status": ["/usr/lib/cockpit-cronjobs/cronjobs-status", "status"] }
```

`cronjobs-status status --lang en|de` prints the status as JSON. It needs no administrative access:
`cockpit-cronjobs-status.timer` works the status out as root every 15 minutes (and two minutes after a
boot) and writes it to `/var/lib/cockpit-cronjobs/status.json` (English) and `status.de.json` (German),
mode 644; `status` only reads the file of the language asked for (German for `de` and its regions,
English for any other language). Without the file it reports `none` and why.

| Item | State |
|---|---|
| `failed` | `danger` when a recorded job failed or was aborted in the last 24 hours, or a run of a job converted to a systemd timer failed or lost its end, with the number of those jobs, their IDs and the names of the timers; `ok` when none did; `none` when no job records its runs and none was converted |
| `unrecorded` | `none` with the number of jobs that do not record their runs, whose results are therefore not known; `ok` when every job records them |
| `cron` | `ok` when the cron service runs; when it does not, `danger` if the crontabs of root and the other users have jobs, else `warning`; `none` when there is no cron service to ask |

Only the crontabs of root and the other users count: the jobs there are the ones the page can record,
read as the page reads them, and the jobs converted from them, whose runs come from the journal of
their service as on the page. A converted job counts only while both units are the ones the
conversion wrote, checked as back to cron checks them. `/etc/crontab` and `/etc/cron.d` do not count.
The files hold numbers, states, job IDs and the names of timers converted from root's crontab; no user
names, commands or output. Timers converted from another user's crontab are only counted, since the
name a conversion suggests for them begins with the user's. Each item is stale after an hour without a
new status (`stale_after`), that is four runs of the timer missed.

The packages and `make install` turn the timer on, and it stays on through upgrades. To turn it off for
good: `sudo systemctl mask --now cockpit-cronjobs-status.timer`.

## Cron's environment

Run now and a conversion to a systemd timer give a job the environment cron gives it on this server.
Cron builds it in three layers, and the page reads each one from the server:

1. What PAM sets for cron's service (`/etc/pam.d/cron`, with cronie `/etc/pam.d/crond`): through
   `pam_env`, the variables of `/etc/environment` and, on Debian and Ubuntu, `LANG` and the like from
   `/etc/default/locale`.
2. The crontab's own variables above the job, `MAILTO` included.
3. Cron's own: `SHELL` (`/bin/sh`) and `HOME` unless the crontab sets them, and `LOGNAME`. `PATH` unless
   the crontab sets it: `/usr/bin:/bin` with Debian's cron, none with Ubuntu's, which starts cron with `-P`
   (so `PATH` comes from `/etc/environment`), `/usr/bin:/bin:/usr/sbin:/sbin` with cronie, which sets
   `USER` as well.

A converted unit lists these variables with `Environment=` and removes with `UnsetEnvironment=` what
systemd would add and cron does not give, such as `USER` on Debian and Ubuntu. What is in
`/etc/environment` when you convert is copied into the unit. `/etc/security/pam_env.conf` is not read.

## Files

| Path | What |
|---|---|
| `/var/lib/cockpit-cronjobs/backups/` | The last 10 versions of the root crontab (directory 700, files 600) |
| `/var/lib/cockpit-cronjobs/backups/users/USER/` | The last 10 versions of the crontab of USER |
| `/var/lib/cockpit-cronjobs/runs/` | Recorded runs of root's jobs |
| `/var/lib/cockpit-cronjobs/users/USER/runs/` | Recorded runs of the jobs of USER (owned by USER) |
| `/usr/local/libexec/cockpit-cronjobs-run` | The run recorder |
| `/usr/lib/cockpit-cronjobs/cronjobs-status` | The status for the Status Board |
| `/usr/lib/systemd/system/cockpit-cronjobs-status.service`, `.timer` | Writes the status every 15 minutes |
| `/var/lib/cockpit-cronjobs/status.json`, `status.de.json` | The status in English and German (mode 644) |
| `/etc/systemd/system/NAME.service`, `NAME.timer` | Jobs converted to systemd timers |
| `/var/lib/cockpit-cronjobs/converting/` | While a conversion is under way: which one wrote the units of a name (directory 700) |
| `/var/lib/cockpit-cronjobs/.crontab.lock` | Lock while the crontab or the units of a conversion are written |

## Uninstall

```sh
sudo apt remove cockpit-cronjobs          # or: sudo dnf remove / sudo zypper remove cockpit-cronjobs
sudo rm -rf /usr/share/cockpit/cronjobs   # installed from the archive
sudo make uninstall                       # installed from the source
# only when no job records its runs any more:
sudo rm -f /usr/local/libexec/cockpit-cronjobs-run
sudo rm -rf /var/lib/cockpit-cronjobs
```

## Safety

- Everything that needs root goes through Cockpit's administrative access, like Cockpit's own pages.
- Commands, names and texts are passed to programs as arguments, never pasted into shell code.
- A crontab is replaced only if it is still exactly the version shown (checksum), under a lock, after a
  verified backup. User names are checked in the page and again as root (letters, digits, `.`, `_`,
  `-`, and a user the system knows); other names stay read-only.
- A crontab that could not be written back exactly is opened read-only.
- Restoring a backup writes it byte for byte through the same step, and shows first what it changes.
- Converting to a timer refuses to go on if systemd would run the job at other times than cron, or reads
  the command or its environment differently; if starting the timer fails, the cron line is switched on
  again and the units are removed.
- Back to cron only removes units that Cron Jobs wrote under that name (plain files, with the first line
  and description it gives them), checked again as root right before; if the timer cannot be stopped,
  the crontab is put back.
- The status timer only reads: it writes nothing but its two status files. In another user's directory it
  reads only what has the form of runs, as the page does (no links, regular files, under a time limit).

## Translations

Texts live in `src/i18n/`. To add a language, copy `en.js` to `<code>.js`, translate it, register it under
its code at the end of the file and add a `<script>` line to `src/index.html`. The page picks it when
Cockpit uses that language. `node test/i18n.test.js` checks that every text exists with the same shape.

## Development

```sh
make check        # unit tests: crontab logic, systemd conversion (against systemd-analyze), run recorder, removal of leftover runs, back to cron and backups (dash, bash), differences (against GNU diff), texts, the status (dash, bash; mawk, gawk)
make check-ui     # browser tests against a stand-in for Cockpit (needs Python Playwright with Chromium)
```

`test/e2e_cockpit.py` runs the main flows against a real Cockpit with real cron. It replaces root's
crontab, so only use it on a throwaway machine or container (see the top of the file). CI runs it on
every push and pull request, on the runner's throwaway VM, twice: with the Cockpit of Ubuntu 24.04 and
with the one from its backports (check `e2e`).

What comes next is in [ROADMAP.md](ROADMAP.md).

## Releasing

1. Set the new version in `src/app.js` (`const VERSION`) and add a section for it to `CHANGELOG.md`.
2. Merge to `main`.
3. On GitHub: Actions › **release** › Run workflow (branch `main`). The workflow checks that the version
   is new and matches `src/app.js`, runs all tests, builds `cockpit-cronjobs-VERSION.tar.gz`
   (`make package`) and the `.deb` and `.rpm` (`make packages`), all reproducible, with `SHA256SUMS`,
   and creates the tag `vVERSION` with a release whose notes come from `CHANGELOG.md`. It also signs a
   build provenance for each file; `gh attestation verify <file> --repo Azentrius/cockpit-cronjobs`
   shows that it was built by this workflow from this repository (the archive since 2.1.1, the
   packages since 2.6.0).
4. packages.azentrius.com takes the packages from the release within an hour
   ([Azentrius/packages](https://github.com/Azentrius/packages)).

## License

Cron Jobs is licensed under the [Apache License 2.0](LICENSE); see also [NOTICE](NOTICE). Versions up to
and including 2.1.1 were released under the GNU Lesser General Public License, version 2.1 or later.
The page contains no code from Cockpit; it uses Cockpit's API `cockpit.js` at runtime, which Cockpit
itself ships.

The fonts DM Sans, DM Serif Display and Red Hat Mono are licensed under the SIL Open Font License 1.1
([src/OFL.txt](src/OFL.txt)); the icons are Font Awesome Free 5.15.4 by Fonticons, Inc., taken over through
`@patternfly/react-icons` 6.4.0 and licensed under CC BY 4.0
([src/CC-BY-4.0-Font-Awesome.txt](src/CC-BY-4.0-Font-Awesome.txt)).

Made by [Azentrius](https://azentrius.com).
