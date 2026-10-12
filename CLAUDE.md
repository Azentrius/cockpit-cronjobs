# CLAUDE.md – notes for working on this repository

## What this is

Cron Jobs, a Cockpit page for cron: it shows every crontab and systemd timer on a server, changes the
root crontab safely, records the result of runs, runs jobs on demand and converts jobs into systemd
timers.

- Overview and use: `README.md`
- What comes next: `ROADMAP.md`
- What changed: `CHANGELOG.md`

## Working together

- Talk to the user **in German**: the big picture in a few sentences first, then details; the
  recommendation first, then the reasons.
- Everything in this repository is **English**: code, comments, commit messages, pull requests, docs,
  test data. The only German is the German translation (`src/i18n/de.js`) and the tests that check it.
- UI texts always in **English and German**.
- For anything that runs as root on a server, say briefly what the user has to understand to answer
  for it, and what can be left to the machine.

## Layout

```
src/                      the Cockpit package (installed as /usr/share/cockpit/cronjobs), no build step
  index.html, app.js      the page; all root scripts (SAVE_SCRIPT, RUN_SCRIPT, …) live in app.js
  lib/cron.js             crontab parsing and writing (byte for byte), schedules, next runs, cron's % rules
  lib/systemd.js          cron → OnCalendar, unit files, systemd-analyze output
  lib/runs.js             records of the run recorder
  i18n/en.js, i18n/de.js  all texts; `…` marks code
  cockpit-cronjobs-run    the run recorder (POSIX sh), installed by the page to /usr/local/libexec/
  azentrius.*, icons.js, *.woff2   shared design files, identical in all Azentrius add-ons
test/                     unit tests (node), browser tests (Playwright against test/web/mock-cockpit.js),
                          test/e2e_cockpit.py (real Cockpit and cron, destructive)
tools/release-notes.sh    notes for a release from CHANGELOG.md
.github/workflows/        test (every push and PR), release (on request)
```

## Commands

```sh
make check                # unit tests; also compares conversions with the real systemd-analyze
make check-ui             # browser tests (needs Python Playwright with Chromium)
make package              # cockpit-cronjobs-VERSION.tar.gz + SHA256SUMS, reproducible
CRONJOBS_E2E_DESTRUCTIVE=1 python3 test/e2e_cockpit.py   # only on a throwaway machine, see the file
```

A real Cockpit for testing (in a container, as root): install `cockpit-ws cockpit-bridge cockpit-system
cron`, link `src` to `/usr/share/cockpit/cronjobs`, start `cron` and
`/usr/lib/cockpit/cockpit-ws --no-tls --port 9091 --address 127.0.0.1 --local-session=cockpit-bridge`,
then open `http://127.0.0.1:9091/cockpit/@localhost/cronjobs/index.html` directly. Only one client at a
time; without a system bus Cockpit's own pages crash the bridge, this page does not.

## Rules (not negotiable)

1. **Byte for byte.** Untouched crontab lines are written back exactly. Every write of the root
   crontab goes through `SAVE_SCRIPT`: lock, checksum of the version shown, verified backup, write,
   read back. Never write a crontab any other way.
2. **No values in shell code.** Root scripts are constants; values go in as arguments or standard
   input. Check IDs, unit names and file names in the page and again in the script.
3. **Like cron.** Run now, the run recorder and conversions must behave as cron does (environment,
   `%`/`\%`, umask, `$SHELL`, `CRON_TZ` with cronie). Prove it with tests against the real tools.
4. **Show first, stop early, undo whole.** Anything that can fail stops before the change. A change of
   crontab and systemd together is undone together.
5. **Formats are contracts.** `runs.jsonl`, `*.running`, the wrapper's command line and the crontab
   markers (`#[cronjobs:off]`, still reading `#[cronctl:off]`) are read by older and newer versions.
   When `cockpit-cronjobs-run` changes, raise `CRONJOBS_RUN_VERSION` there and `WRAPPER_VERSION` in
   `src/lib/cron.js`.
6. **Browser without network.** No CDNs, no external fonts or images, no inline scripts or styles,
   no `style` attributes (set styles through the DOM). Cockpit's CSP stays strict.
7. **Two languages.** Every new text in `src/i18n/en.js` and `src/i18n/de.js`; `test/i18n.test.js`
   checks keys, shapes and use. German addresses the user formally (“Sie”), like Cockpit.
8. **Any server.** Debian/Ubuntu cron and cronie, systemd optional. No assumptions about one host.
9. **Never test on real crontabs.** End-to-end only on throwaway machines.
10. **No build step, no runtime dependencies.** Plain JS, POSIX shell; `node_modules` only for tests.

## Releases and the repository

- `main` is protected: changes only through pull requests (squash merge), the `test` check must be green.
- Release: raise `const VERSION` in `src/app.js`, add a section to `CHANGELOG.md`, merge, then
  Actions › release › Run workflow on `main`. The workflow checks the version, runs all tests, builds
  the package and creates tag and release.
- From Claude sessions the GitHub API cannot create tags or releases, delete branches or change
  settings; starting the release workflow works. Code-scanning alerts and branches are handled by the
  user.

## Putting it on a server

1. Take the archive and `SHA256SUMS` of a release; check `sha256sum --ignore-missing -c SHA256SUMS`.
2. Back up the installed version, unpack to `/usr/share/cockpit` (gives `cronjobs/`), check every file
   against `SHA256SUMS`.
3. Reload Cockpit in the browser. The run recorder is updated from the page when its version changed.
4. Do not retype files into a server by hand or through a chat tool; fetch them and compare checksums.

## Useful knowledge

- **Cockpit bridge:** closing a spawn sends SIGTERM to the direct child only, so `RUN_SCRIPT` starts
  the job in its own process group (`setsid`) and forwards the signal. Text channels must be valid
  UTF-8 or the channel (and the job) ends — read and run with `binary: true` and decode leniently.
- **dash:** `kill -TERM -- -PGID` fails ("Illegal number"); use `kill -TERM -PGID`.
- **Pipes:** opening `/dev/fd/N` fails when stdout is a socket (e.g. under some supervisors), so the run
  recorder uses a FIFO.
- **cron's `%`:** an unescaped `%` ends the command and the rest becomes standard input; `\%` becomes
  `%` even inside quotes. `C.cronCommand()` mirrors cron's `do_command` exactly.
- **systemd:** `ExecStart=` needs `%%` for `%` and `$$` for `$`; the stored command line (D-Bus
  `ExecStart`) still contains `$$`. Monotonic timers: realtime = monotonic +
  (`UserspaceTimestamp` − `UserspaceTimestampMonotonic`). `systemd-analyze calendar` prints a
  `(in UTC)` line only when the local zone is not UTC.
- **cron flavours:** Debian's cron ignores `CRON_TZ`, cronie honours it; `run-parts --test` exists only
  in Debian's run-parts; spool in `/var/spool/cron/crontabs` (Debian), `/var/spool/cron/tabs` (SUSE)
  or `/var/spool/cron`; cron skips `/etc/cron.d` files that are not root's or are writable by others.
- **`/run/lock`** is world-writable on Debian and Ubuntu; locks for root belong in a root-only directory
  (here `/var/lib/cockpit-cronjobs/.crontab.lock`).
