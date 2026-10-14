# Cron Jobs for Cockpit

A [Cockpit](https://cockpit-project.org) page for cron. It shows everything that is scheduled on a
server, lets you change the root crontab and those of other users safely, keeps the result of every run,
starts jobs on demand and turns cron jobs into systemd timers.

![Overview: the next 24 hours and the root crontab](docs/overview.png)

## What it does

- **Everything that runs, in one place.** The root crontab, `/etc/crontab`, `/etc/cron.d`, the crontabs of
  other users, the scripts in `/etc/cron.hourly` … `/etc/cron.monthly`, and systemd timers. Schedules are
  written out in words; next runs are shown in server time, and in your own time when that differs.
  Files in `/etc/cron.d` that cron skips (name, owner, permissions, symbolic links, hard links) are marked
  with the reason, by the rules of the cron that is installed.
- **Three tabs.** Overview (the next 24 hours, the root crontab and those of other users), systemd timers,
  and System (`/etc/crontab`, `/etc/cron.d`, the periodic scripts). Notices stay visible in every tab;
  switching tabs loads nothing.
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
- English and German, following Cockpit's language. Light and dark, following Cockpit's style. Usable on
  a phone.

| Run now | Recorded runs | Convert to systemd timer | Backups |
|---|---|---|---|
| ![Run now](docs/run-now.png) | ![Runs](docs/runs.png) | ![Convert](docs/convert.png) | ![Backups](docs/backups.png) |

## Requirements

- Cockpit (tested with 360 and 362)
- cron: `cron` on Debian and Ubuntu, or `cronie` (Fedora, RHEL and its rebuilds, Arch, openSUSE)
- coreutils, util-linux (`flock`, `setsid`), `sed`, `grep`: present on any normal installation
- systemd, optionally: for the timers, the timeline entries of timers and the conversion

With cronie, `CRON_TZ` is taken into account for next runs, the timeline and the conversion.

Changes need administrative access in Cockpit (“Limited access” turned off). Without it the page shows
the system crontabs and timers, and nothing of other users' crontabs.

## Installation

From a [release](https://github.com/Azentrius/cockpit-cronjobs/releases) (replace the version):

```sh
curl -LO https://github.com/Azentrius/cockpit-cronjobs/releases/download/v2.4.0/cockpit-cronjobs-2.4.0.tar.gz
curl -LO https://github.com/Azentrius/cockpit-cronjobs/releases/download/v2.4.0/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
gh attestation verify cockpit-cronjobs-2.4.0.tar.gz --repo Azentrius/cockpit-cronjobs   # optional, needs gh
sudo tar -xzf cockpit-cronjobs-2.4.0.tar.gz -C /usr/share/cockpit
```

Or from the source:

```sh
git clone https://github.com/Azentrius/cockpit-cronjobs.git
cd cockpit-cronjobs
sudo make install          # to /usr/local/share/cockpit/cronjobs
```

Log in to Cockpit again; **Cron Jobs** appears in the menu. To update, install the new version the
same way.

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
| `/etc/systemd/system/NAME.service`, `NAME.timer` | Jobs converted to systemd timers |
| `/var/lib/cockpit-cronjobs/.crontab.lock` | Lock while the crontab is written |

## Uninstall

```sh
sudo rm -rf /usr/share/cockpit/cronjobs   # installed from a release
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

## Translations

Texts live in `src/i18n/`. To add a language, copy `en.js` to `<code>.js`, translate it, register it under
its code at the end of the file and add a `<script>` line to `src/index.html`. The page picks it when
Cockpit uses that language. `node test/i18n.test.js` checks that every text exists with the same shape.

## Development

```sh
make check        # unit tests: crontab logic, systemd conversion (against systemd-analyze), run recorder, removal of leftover runs, back to cron and backups (dash, bash), differences (against GNU diff), texts
make check-ui     # browser tests against a stand-in for Cockpit (needs Python Playwright with Chromium)
```

`test/e2e_cockpit.py` runs the main flows against a real Cockpit with real cron. It replaces root's
crontab, so only use it on a throwaway machine or container (see the top of the file). CI runs it on
every push and pull request, on the runner's throwaway VM (job `e2e`).

What comes next is in [ROADMAP.md](ROADMAP.md).

## Releasing

1. Set the new version in `src/app.js` (`const VERSION`) and add a section for it to `CHANGELOG.md`.
2. Merge to `main`.
3. On GitHub: Actions › **release** › Run workflow (branch `main`). The workflow checks that the version
   is new and matches `src/app.js`, runs all tests, builds `cockpit-cronjobs-VERSION.tar.gz` with
   `SHA256SUMS` (`make package`, reproducible) and creates the tag `vVERSION` with a release whose
   notes come from `CHANGELOG.md`. It also signs a build provenance for the archive; for releases after 2.1.0,
   `gh attestation verify cockpit-cronjobs-VERSION.tar.gz --repo Azentrius/cockpit-cronjobs` shows
   that a release archive was built by this workflow from this repository.

## License

Cron Jobs is licensed under the [Apache License 2.0](LICENSE); see also [NOTICE](NOTICE). Versions up to
and including 2.1.1 were released under the GNU Lesser General Public License, version 2.1 or later.
The page contains no code from Cockpit; it uses Cockpit's API `cockpit.js` at runtime, which Cockpit
itself ships.

The fonts DM Sans and DM Serif Display are licensed under the SIL Open Font License 1.1
([src/OFL.txt](src/OFL.txt)); the icons are Font Awesome Free 5, licensed under CC BY 4.0.

Made by [Azentrius](https://azentrius.de).
