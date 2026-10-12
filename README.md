# Cron Jobs for Cockpit

A [Cockpit](https://cockpit-project.org) page for cron. It shows everything that is scheduled on a
server, lets you change the root crontab safely, keeps the result of every run, starts jobs on demand
and turns cron jobs into systemd timers.

![Overview: the next 24 hours and the root crontab](docs/overview.png)

## What it does

- **Everything that runs, in one place.** The root crontab, `/etc/crontab`, `/etc/cron.d`, the crontabs of
  other users, the scripts in `/etc/cron.hourly` … `/etc/cron.monthly`, and systemd timers. Schedules are
  written out in words; next runs are shown in server time, and in your own time when that differs.
- **The next 24 hours.** A timeline of all cron jobs and timers. Jobs that start in the same minute are
  pointed out.
- **Safe changes to the root crontab.** Add, edit, switch off and on, delete. Lines you do not touch stay
  byte for byte. Each change is written in one locked step, only if the crontab is still the one you see,
  after a backup of the previous version; afterwards it is read back and compared.
- **The result of every run.** Turn on recording for a job and it keeps exit code, duration and output of
  its last 20 runs. Handy on servers without a mail program, where cron's output is otherwise lost.
- **Run now.** Starts a job right away with cron's environment (the crontab's variables, `PATH`, `HOME`,
  `SHELL`, input after `%`), shows the output live and can stop it.
- **Convert to a systemd timer.** Creates `NAME.service` and `NAME.timer` with the same schedule (checked
  against `systemd-analyze`), the same command and environment, checks what systemd read, starts the
  timer and switches the cron line off with a note.
- English and German, following Cockpit's language. Light and dark, following Cockpit's style. Usable on
  a phone.

| Run now | Recorded runs | Convert to systemd timer |
|---|---|---|
| ![Run now](docs/run-now.png) | ![Runs](docs/runs.png) | ![Convert](docs/convert.png) |

## Requirements

- Cockpit (tested with 360 and 362)
- cron: `cron` on Debian and Ubuntu, or `cronie` (Fedora, RHEL and its rebuilds, Arch, openSUSE)
- coreutils, util-linux (`flock`, `setsid`), `sed`, `grep` — present on any normal installation
- systemd, optionally: for the timers, the timeline entries of timers and the conversion

With cronie, `CRON_TZ` is taken into account for next runs, the timeline and the conversion.

Changes need administrative access in Cockpit (“Limited access” turned off). Without it the page shows
the system crontabs and timers.

## Installation

```sh
git clone https://github.com/Azentrius/cockpit-cronjobs.git
cd cockpit-cronjobs
sudo make install          # to /usr/local/share/cockpit/cronjobs
```

Or copy the `src` directory to `/usr/share/cockpit/cronjobs`. Log in to Cockpit again; **Cron Jobs**
appears in the menu.

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

- Commands with an unescaped `%` cannot be recorded (cron passes the text after `%` as input).
- Turning recording off restores the plain line and deletes the recorded runs.
- The command keeps its environment and umask. Mail from cron and the `CMD` line in the system log show
  the wrapper call instead of the plain command; adjust filters that match on them.
- Jobs that record their runs need the script. Before you remove Cron Jobs, turn recording off, or leave
  the script in place.

## Files

| Path | What |
|---|---|
| `/var/lib/cockpit-cronjobs/backups/` | The last 10 versions of the root crontab (directory 700, files 600) |
| `/var/lib/cockpit-cronjobs/runs/` | Recorded runs |
| `/usr/local/libexec/cockpit-cronjobs-run` | The run recorder |
| `/etc/systemd/system/NAME.service`, `NAME.timer` | Jobs converted to systemd timers |
| `/var/lib/cockpit-cronjobs/.crontab.lock` | Lock while the crontab is written |

## Uninstall

```sh
sudo make uninstall
# only when no job records its runs any more:
sudo rm -f /usr/local/libexec/cockpit-cronjobs-run
sudo rm -rf /var/lib/cockpit-cronjobs
```

## Safety

- Everything that needs root goes through Cockpit's administrative access, like Cockpit's own pages.
- Commands, names and texts are passed to programs as arguments, never pasted into shell code.
- The root crontab is replaced only if it is still exactly the version shown (checksum), under a lock,
  after a verified backup.
- A crontab that could not be written back exactly is opened read-only.
- Converting to a timer refuses to go on if systemd would run the job at other times than cron, or reads
  the command or its environment differently; if starting the timer fails, the cron line is switched on
  again and the units are removed.

## Translations

Texts live in `src/i18n/`. To add a language, copy `en.js` to `<code>.js`, translate it, register it under
its code at the end of the file and add a `<script>` line to `src/index.html`. The page picks it when
Cockpit uses that language. `node test/i18n.test.js` checks that every text exists with the same shape.

## Development

```sh
make check        # unit tests: crontab logic, systemd conversion (against systemd-analyze), run recorder (dash, bash), texts
make check-ui     # browser tests against a stand-in for Cockpit (needs Python Playwright with Chromium)
```

`test/e2e_cockpit.py` runs the main flows against a real Cockpit with real cron. It replaces root's
crontab, so only use it on a throwaway machine or container (see the top of the file).

## License

Cron Jobs is licensed under the GNU Lesser General Public License, version 2.1 or later (the license of
Cockpit itself). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The fonts DM Sans and DM Serif Display are licensed under the SIL Open Font License 1.1
([src/OFL.txt](src/OFL.txt)); the icons are Font Awesome Free 5, licensed under CC BY 4.0.

Made by [Azentrius](https://azentrius.de).
