# Notes for working on this repository

## What this is

Cron Jobs, a Cockpit page for cron: it shows every crontab and systemd timer on a server, changes the
root crontab and (with administrative access) those of other users safely, records the result of runs,
runs jobs on demand and converts jobs into systemd timers.

- Overview and use: `README.md`
- What comes next: `ROADMAP.md`
- What changed: `CHANGELOG.md`

## Working together

- Big picture first in a few sentences, then details; the recommendation first, then the reasons.
- For anything that runs as root on a server, say briefly what the user has to understand to answer
  for it, and what can be left to the machine.

## Repository conventions

The same in every Azentrius repository.

- **Language.** Everything in the repository is English: code, comments, docs, commit messages, pull
  requests, test names and test data. The only German is the German translation and the tests that
  check it. User-facing texts always exist in English and German; German addresses the user formally
  (“Sie”). Answer the user in the language they write in.
- **Versions.** Semantic Versioning; the version lives in exactly one place (see “Releases and the
  repository”). Tags are `vX.Y.Z`.
- **Changelog.** `CHANGELOG.md`, newest first. Each version gets `## X.Y.Z – YYYY-MM-DD`, a one-line
  summary, then bullets. The pull request that raises the version adds its section.
- **Pull requests.** `main` is protected: every change goes through a pull request and is
  squash-merged once the `test` check is green; the branch is deleted afterwards. The PR title becomes
  the commit on `main`: short, imperative, English, without version numbers.
- **Authorship.** Commits on `main` are authored by the maintainer (the squash merge takes care of
  that). Commits, pull requests and files carry no co-author trailers and no “generated with” lines.

Here the German translation is `src/i18n/de.js`, checked by `test/i18n.test.js`.

## Repository baseline

The same in every Azentrius repository; keep it when changing the repository or its settings.

- **Security.** `SECURITY.md` with private vulnerability reporting; secret scanning with push
  protection; Dependabot alerts and security updates; Dependabot version updates for every
  ecosystem in use and for GitHub Actions; CodeQL default setup.
- **Branches and tags.** Ruleset `main`: pull request, squash only, linear history, no deletion or
  force push, required check `test`. Ruleset `release tags`: `v*` cannot be deleted or moved.
- **CI.** The job `test` runs every test and every lint on each push and pull request. Actions are
  pinned by commit SHA with the version as a comment; checkouts use `persist-credentials: false`;
  the token is read-only unless a job needs more. Check tools are pinned as well, so Dependabot keeps
  them current.
- **Releases.** Only the `release` workflow makes releases, on request, from `main`: it checks the
  version against the code and the existing tags, runs all tests, builds the artifact with
  `SHA256SUMS`, signs a build provenance (`gh attestation verify`) and takes the notes from
  `CHANGELOG.md`. Releases are immutable. Files that are not for users stay out of the artifact.
- **Licensing.** Apache-2.0: `LICENSE` in the root, an SPDX header in every source file, `NOTICE`
  for third-party material.

Here: check tools in `test/requirements.txt` (pip); lint is `make lint` (`shellcheck --severity=warning`
for the shell scripts, `ruff check` with the rules in `ruff.toml`); the artifacts are the archive
(`make package`, only `src/`) and the `.deb` and `.rpm` (`make packages`, built by
`tools/build-packages.sh` from `packaging/`; `test` installs them on Debian and Fedora). Ruleset
`main` requires the check `e2e` as well (the end-to-end test, see “Commands”), so a pull request is
merged only when `test` and `e2e` are green.

## Layout

```
src/                      the Cockpit package (installed as /usr/share/cockpit/cronjobs), no build step
  index.html, app.js      the page; app.js starts it (and holds VERSION), its parts are ES modules in app/
  app/system.js           everything that runs on the server; all root scripts (SAVE_SCRIPT, RUN_SCRIPT, …)
  app/core.js             libraries, constants, texts, DOM helpers, times, the page's state
  app/crontab.js          the crontabs as shown (root's, other users' with admin access): loading, saving
                          (commit, restoreCrontab), administrative access
  app/page.js, summary.js, timeline.js, dialogs.js, runs.js, convert.js, backups.js, tabs.js   the page,
                          the latest results, the timeline, dialogs, run now and recorded runs, conversion
                          and back to cron, backups, the tabs
  lib/cron.js             crontab parsing and writing (byte for byte), schedules, next runs, cron's % rules
  lib/systemd.js          cron → OnCalendar, unit files, systemd-analyze output
  lib/runs.js             records of the run recorder, and runs of a service from its journal
  lib/backups.js          the list of backups, the difference between two versions (as diff shows it)
  i18n/en.js, i18n/de.js  all texts; `…` marks code
  cockpit-cronjobs-run    the run recorder (POSIX sh), installed by the page to /usr/local/libexec/
  azentrius.*, icons.js, *.woff2   shared design files, identical in all Azentrius add-ons
test/                     unit tests (node), browser tests (Playwright against test/web/mock-cockpit.js),
                          test/e2e_cockpit.py (real Cockpit and cron, destructive)
tools/release-notes.sh    notes for a release from CHANGELOG.md
tools/build-packages.sh   .deb and .rpm from a staged tree; the same file in every Azentrius add-on
packaging/                package.conf (name, description, dependencies), the AppStream metainfo
.github/workflows/        test with jobs test and e2e (every push and PR), release (on request)
```

## Commands

```sh
make check                # unit tests; also compares conversions with the real systemd-analyze and the
                          # difference of two versions with GNU diff
make check-ui             # browser tests (needs Python Playwright with Chromium)
make package              # cockpit-cronjobs-VERSION.tar.gz + SHA256SUMS, reproducible
make packages             # dist/*.deb and dist/*.rpm (needs dpkg-deb and rpmbuild), reproducible
CRONJOBS_E2E_DESTRUCTIVE=1 python3 test/e2e_cockpit.py   # only on a throwaway machine, see the file
```

CI runs the end-to-end test as job `e2e` on the runner's VM, set up as below; it is a required check
next to `test`. The screenshots are kept as the artifact `e2e-screenshots`.

A real Cockpit for testing (in a container, as root): install `cockpit-ws cockpit-bridge cockpit-system
cron`, link `src` to `/usr/share/cockpit/cronjobs`, start `cron` and
`/usr/lib/cockpit/cockpit-ws --no-tls --port 9091 --address 127.0.0.1 --local-session=cockpit-bridge`,
then open `http://127.0.0.1:9091/cockpit/@localhost/cronjobs/index.html` directly. Only one client at a
time; without a system bus Cockpit's own pages crash the bridge, this page does not.

## Rules (not negotiable)

1. **Byte for byte.** Untouched crontab lines are written back exactly. Every write of a crontab
   (root's or another user's) goes through `SAVE_SCRIPT`: lock, checksum of the version shown,
   verified backup, write, read back. Never write a crontab any other way.
2. **No values in shell code.** Root scripts are constants; values go in as arguments or standard
   input. Check IDs, unit names and file names in the page and again in the script. In a directory
   another user owns (`users/USER`), root removes nothing and reads no output itself: that goes
   through `as_user` (setpriv, no PAM session). The run list, which root reads there, takes only what
   has the form it expects: names checked, no links, regular files under `timeout`, separators stripped.
3. **Like cron.** Run now, the run recorder and conversions must behave as cron does (environment,
   `%`/`\%`, umask, `$SHELL`, `CRON_TZ` with cronie). Prove it with tests against the real tools.
4. **Show first, stop early, undo whole.** Anything that can fail stops before the change. A change of
   crontab and systemd together is undone together.
5. **Formats are contracts.** `runs.jsonl`, `*.running` and where they live (`runs/ID` for root's
   jobs, `users/USER/runs/ID` for other users', written by the recorder as that user), the wrapper's
   command line, the crontab markers (`#[cronjobs:off]`, still reading `#[cronctl:off]`), the conversion note
   (`SD.convertNote`) and the first line, description and `User=` of converted units (back to cron
   looks for them; `SD.unitHeader`, "… (from the root crontab)" or "… (from the crontab of USER)") are
   read by older and newer versions.
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

- The version lives in `const VERSION` in `src/app.js`; `make package`, the `test` check and the
  release workflow read it from there.
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

- **The modules in `src/app/`** import each other in a circle (the page calls dialogs, dialogs save,
  saving renders the page). That works because only `core.js` and `system.js` compute values when
  they load; everything else runs later. A module can read another one's `let` (`dialog`, `loading`,
  `rootVersion`) but not assign it: changes go through a function of the module that owns it
  (e.g. `loadIfPending`) or through `state`.
- **Cockpit bridge:** closing a spawn sends SIGTERM to the direct child only, so `RUN_SCRIPT` starts
  the job in its own process group (`setsid`) and forwards the signal. Text channels must be valid
  UTF-8 or the channel (and the job) ends, so read and run with `binary: true` and decode leniently.
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
  or `/var/spool/cron`. What each skips in `/etc/cron.d` (from their `database.c`, see `C.cronDSkip`):
  Debian's cron checks a symlink's own owner, then the target's owner, type, group/other write bits
  and hard link count; cronie follows links without checking them, then wants a regular file with
  `(mode & 07533) == 0400` (so nothing executable) owned by root. The end-to-end test compares the
  page with what Debian's cron logs.
- **cron's environment** (`C.cronEnvModel`, `C.jobEnvironment`, read by `BASICS_SCRIPT`): PAM's variables
  first (`pam_env`: `/etc/environment`, on Debian and Ubuntu also `/etc/default/locale`), then the
  crontab's (all of them, `MAILTO` too), then cron's own: `SHELL`, `HOME`, `LOGNAME`, and `PATH` unless
  set. Debian's cron sets `PATH=/usr/bin:/bin` and no `USER`; Ubuntu's unit starts it with `-P`, so it
  sets no `PATH` at all and the one from `/etc/environment` applies; cronie sets
  `/usr/bin:/bin:/usr/sbin:/sbin` and `USER`. `pam_env` drops a quote only at the start and as the last
  character, and `#` ends a value anywhere. The end-to-end test compares the whole environment of cron,
  run now and a converted unit.
- **Runs in the journal** (`R.parseJournal`, `readJournal`): `journalctl -u NAME.service -o json`, grouped
  by invocation: systemd's own messages carry `INVOCATION_ID` (and `_PID` 1), the job's lines
  `_SYSTEMD_INVOCATION_ID`. The end and result come from structured messages (`MESSAGE_ID`): "Deactivated
  successfully" (systemd 246+) or "Finished" with `JOB_RESULT=done` for success, "Main process exited"
  with `EXIT_CODE`/`EXIT_STATUS` and "Failed with result" (`UNIT_RESULT`) for failures; success logs no
  exit status. Lines that are not UTF-8 come as a list of bytes. The unit test uses real output of
  systemd 259; the end-to-end test reads the journal of real units.
- **`/run/lock`** is world-writable on Debian and Ubuntu; locks for root belong in a root-only directory
  (here `/var/lib/cockpit-cronjobs/.crontab.lock`).
