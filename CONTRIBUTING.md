# Contributing

Bug reports, ideas and pull requests for Cron Jobs are welcome. Security problems do not belong in
public issues: report them as described in [SECURITY.md](SECURITY.md). For a larger change, open an
issue first so we can agree on the approach; planned work is in [ROADMAP.md](ROADMAP.md).

## Setup

```bash
git clone https://github.com/Azentrius/cockpit-cronjobs.git
cd cockpit-cronjobs
pip install -r test/requirements.txt   # pinned check tools: playwright, ruff, shellcheck
python3 -m playwright install chromium # the browser for the browser tests
```

- The page is plain JavaScript without a build step; the root scripts and the run recorder are POSIX
  `sh`.
- Node.js (CI uses Node 22) runs the unit tests with its standard library only: there is no
  `npm install`.
- `make check` also wants `dash` and `bash`, `mawk` or `gawk`, GNU `diff` and, for the comparisons with
  systemd, `systemd-analyze`; without them those parts are skipped.

## Tests and checks

```bash
make check       # unit tests: crontab logic, systemd conversion, run recorder, cron's log, status, texts
make check-ui    # browser tests against a stand-in for Cockpit (test/web/mock-cockpit.js)
make lint        # shellcheck and ruff, as in CI
make package     # the archive with SHA256SUMS, reproducible
make packages    # .deb and .rpm in dist/ (needs dpkg-deb and rpmbuild), reproducible
make docs-shots  # the screenshots of the README into docs/ (CI keeps them as the artifact docs-screenshots)
```

The `test` workflow runs the unit tests, the browser tests, the lint and the package builds on every
push and pull request, and installs the `.deb` on Debian and the `.rpm` on Fedora. Its job `test` and
the end-to-end check `e2e` have to be green before a merge.

## End-to-end test

`test/e2e_cockpit.py` drives the page through a real Cockpit against a real cron daemon: it replaces
root's crontab, creates a user with a crontab, writes systemd units and files in `/etc/cron.d`, and
starts and stops cron. Run it **only on a throw-away machine or container, never on a server you
use** (it refuses to run without `CRONJOBS_E2E_DESTRUCTIVE=1`; the top of the file says how to set up
Cockpit for it). CI runs it on the runner's throw-away VM twice: with the Cockpit of Ubuntu 24.04 and
cron as installed, and with the Cockpit of its backports and cron at `-L 15`. A change to what the
page does with cron, systemd or the crontabs gets a step there.

## How the page is built

- **Byte for byte.** Crontab lines the user does not change are written back exactly. Every write of a
  crontab goes through `SAVE_SCRIPT` in `src/app/system.js`: lock, checksum of the version shown,
  verified backup, write, read back. Nothing else writes a crontab.
- **No values in shell code.** Root scripts are constants in `src/app/system.js`; values go in as
  arguments or standard input and are checked in the page and again in the script. In a directory
  another user owns, root removes nothing and reads no output itself.
- **Like cron.** Run now, the run recorder and conversions behave as cron does (environment, `%` and
  `\%`, umask, `$SHELL`, `CRON_TZ` with cronie), proven by tests against the real tools.
- **Show first, stop early, undo whole.** Every change shows what it will do; whatever can fail stops
  before the change, and a change of crontab and systemd together is undone together.
- **Formats are contracts.** The records of the run recorder, the crontab markers, the note and units of
  a conversion and the status for the Status Board are read by older and newer versions. A change to
  `src/cockpit-cronjobs-run` raises `CRONJOBS_RUN_VERSION` there and `WRAPPER_VERSION` in
  `src/lib/cron.js`; the status helper (`status/cronjobs-status`) reads what the page reads, and
  `test/status.test.js` compares the two.
- **Browser without network.** No CDNs, external fonts or images, no inline scripts or styles: the
  fonts ship with the page and Cockpit's strict CSP stays.
- **Any server.** Debian's and Ubuntu's cron and cronie, systemd optional; nothing that only fits one
  installation.
- **No build step, no runtime dependencies.** Plain JavaScript, POSIX `sh`.
- **Shared design files** (`src/azentrius.*`, `src/icons.js`, the fonts) are the same in every Azentrius
  add-on. Change them only together with the others.

## Requirements for a change

- **English and German.** Every user-facing text goes into `src/i18n/en.js` and `src/i18n/de.js`;
  `test/i18n.test.js` checks keys, shapes and use. German addresses the user formally ("Sie").
- **English in the repository.** Code, comments, docs, commit messages and pull requests are in
  English; the only German is the translation and the tests that check it.
- **Tests** for new behaviour; `make check`, `make check-ui` and `make lint` green.
- **SPDX header** `SPDX-License-Identifier: Apache-2.0` in every new source file.
- **Versions and changelog** are the maintainer's: the pull request that raises `const VERSION` in
  `src/app.js` adds its section to `CHANGELOG.md` (the `test` check wants one for the current
  version), and later pull requests before the release add to that section. Describe user-visible
  changes in your pull request.
- **No private data.** No secrets, tokens, passwords, host names, IP addresses, real crontabs or other
  real server data in issues, pull requests, tests or fixtures.

## Pull requests

- Open them against `main`. `main` is protected: every change goes through a pull request and is
  squash-merged once the checks `test` and `e2e` are green.
- The title becomes the commit on `main`: short, imperative, English, without a version number
  (e.g. "Show the duration of runs from cron's log").
- Keep one topic per pull request and fill in the template: what and why, how it was tested.

## License

Cron Jobs is licensed under the [Apache License 2.0](LICENSE); contributions are accepted under the
same license. Third-party material keeps its own license and is listed in [NOTICE](NOTICE); new
third-party material needs a compatible license and an entry there.
