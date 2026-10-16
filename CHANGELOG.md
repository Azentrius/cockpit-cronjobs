# Changelog

## Unreleased

The page follows the Azentrius design system more closely: states, controls, alerts and texts.

- **Running is a good state:** a job or timer that runs shows "Running" as a success label with the
  check-circle icon, no longer as a hint with sync-alt. "Ignored" in `/etc/cron.d` carries the warning
  triangle.
- **Checkboxes in forms:** "Record result and output", "Job is active" and "Catch up on missed runs" are
  checkboxes, since they only apply with Save or Convert. The switches in the tables stay: they apply at
  once.
- **Alerts above their card:** that cron is not installed, that a crontab or the systemd timers could not
  be read, or that a crontab opened read-only now shows above the card it is about, and the card says what
  it waits for. These errors also say how to fix them, as do those of the journal, of an output and of the
  backups.
- **Field errors once a field is left:** the edit dialog, and the name in the convert dialog, show an error
  when the field is left or on saving or converting, not while typing. "Convert job" no longer turns grey
  for an invalid name; it leads back to the field.
- **Run recorder:** it is updated with "Update" and the arrow-circle-up icon. "Update" and "Install run
  recorder" are link buttons in their alerts.
- **Actions in alerts carry an icon** like every text button: "Try again" sync-alt, "Open in Services"
  external-link-alt.
- **Buttons name their object:** "Run job", "Stop job", "Convert job", "Record runs", "Review runs",
  "Remove all runs" and "Install run recorder".
- **German texts:** errors address the reader as "Sie" ("Geben Sie einen Befehl ein.") instead of the
  infinitive.
- **Sizes:** in KiB, MiB and GiB, which they always were (1024 based), with a decimal comma in German.
- **No systemd timers:** the systemd timers tab shows an empty state in a card and says whether the server
  has no systemd or no timers.
- **Details:** every control is at least 29 px high on the desktop (44 px on phones), the inline links and
  the result labels too; the row menu shows focus as a 2 px ring; spacing comes from the scale of
  4, 8, 16, 24, 32 and 48 px only; notes in the changes of a backup are no longer italic.
- **Signature:** the word mark links to azentrius.de; a link to the source code follows version and host.
- **Icons:** `icons.js`, NOTICE and the README name where the icons come from (Font Awesome Free 5.15.4 by
  Fonticons, Inc., through `@patternfly/react-icons` 6.4.0). The license text, CC BY 4.0, comes along as
  `CC-BY-4.0-Font-Awesome.txt`, installed with the page and in the packages' documentation.
- Tests: the browser tests check the checkboxes, the alerts above their cards, field errors only after a
  field is left, controls of at least 29 px, the signature and an empty state for the timers.
- **Name with the dot:** the page title reads "Cron Jobs." with the dot of the Azentrius wordmark, the way
  the design system now shows a product name without a suffix. The menu, the signature and AppStream keep
  the plain "Cron Jobs", and the README and NOTICE drop "for Cockpit" from the name.
- **Shared design files:** `azentrius.css` gains `az-page-title--dot`, the project-page classes
  `az-btn--lg` and `az-eyebrow` and their spacing tokens; `tools/build-packages.sh` can name packages
  that a package replaces under a new name (`CONFLICTS` in `packaging/package.conf`).

## 2.6.0 – 2026-10-16

Packages: Cron Jobs comes as `cockpit-cronjobs` (`.deb` and `.rpm`) from the Azentrius package
repository, packages.azentrius.de, and Cockpit lists it under Applications.

- **Packages:** every release has `cockpit-cronjobs_VERSION-1_all.deb` and
  `cockpit-cronjobs-VERSION-1.noarch.rpm` next to the archive, in `SHA256SUMS` and with a signed build
  provenance. They install the page to `/usr/share/cockpit/cronjobs` and need `cockpit-bridge` and a
  cron daemon (`cron` or another `cron-daemon` on Debian and Ubuntu, `cronie` or `cron` in RPM). The
  builds are reproducible: CI builds them twice and compares the bytes, then installs them on Debian 13
  and Fedora 43.
- **Cockpit's Applications page:** the packages carry AppStream data (`de.azentrius.cronjobs`, English
  and German). With the package repository set up (one package, `azentrius-repository`), Cockpit lists
  Cron Jobs under Applications and installs it with a click, and the system's updates keep it current.
  The repository takes a package only after checking that this repository's release workflow built it.
- **Installation:** the README installs from the package repository, from the files of a release or
  from the source, and says how to switch from an earlier installation.

## 2.5.0 – 2026-10-15

Results at a glance: the latest result of every recorded job and systemd timer at the top of the overview,
failures first, and the runs of every timer from the journal.

- **The latest results:** a new card at the top of the overview lists the last run of every recorded job
  (in every crontab the page shows) and of every active systemd timer: failed and aborted ones first,
  newest first, then those running, then the successful ones, folded away behind a button. A result opens
  the runs of its job or timer. The page reads the runs and the timers' results again every half minute,
  so a failure shows within a minute without reloading; coming back to the page with a dialog open, it
  reads them too.
- **Runs from the journal:** every systemd timer gets the runs dialog of a recorded job, from the journal
  of its service: start, duration, result and output. The systemd timers tab has a button for it. A job
  converted to a timer keeps its history: its row shows the timer's last run, and its runs dialog lists
  the runs recorded before the conversion together with those of its service since.
- The last run of a timer is the later of its last trigger and the last start of its service, so a
  service started by hand shows as run.
- **Fix:** jobs with rare schedules, such as yearly ones or those on the 29th of February, could not be
  converted to a systemd timer: the check compared five runs, but computed cron's own only 800 days ahead.
  It now computes them up to the last run systemd lists.
- Tests: the end-to-end test lets a recorded job and a timer fail under the real cron and systemd and
  finds both in the latest results without reloading, reads runs from the real journal, and converts a
  yearly and a leap day job; the journal parser is tested with real output of systemd 259.

## 2.4.0 – 2026-10-14

Crontabs of other users, with administrative access: changed, run, recorded and converted with the same
safety as root's. Run now and conversions now give a job the environment cron gives it.

- **Crontabs of other users:** with administrative access, every other user's crontab gets a card of its
  own on the overview and is changed the same way as root's: through `crontab -u USER` in one locked
  step, after a backup of its own (the last ten in `/var/lib/cockpit-cronjobs/backups/users/USER/`),
  which can be compared and restored like root's. Without administrative access they are not shown at
  all. `/etc/crontab` and `/etc/cron.d` stay read-only.
- **Run now as that user:** another user's job runs as that user (through `runuser`), in the user's
  home, with cron's environment for that user.
- **Recording for other users:** the run recorder (version 2; the page installs it again) records a job
  of another user as that user, in `/var/lib/cockpit-cronjobs/users/USER/runs/`, a directory that
  belongs to the user; `/var/lib/cockpit-cronjobs` and its `users` directory become mode 711. Cron Jobs
  reads output and removes runs there as that user, and lists only what has the form of runs.
- **Conversion for other users:** the timer runs the job with `User=USER`, in the user's home. Units
  name the crontab they come from, and back to cron removes only units converted from the crontab whose
  note it follows, so a note a user writes into their own crontab cannot reach anyone else's timer. The
  systemd timers tab names the crontab a timer came from.
- **Cron's environment:** run now and conversions read from the server how cron builds a job's
  environment (PAM's variables from `/etc/environment` and, on Debian and Ubuntu, the locale; the
  crontab's variables; cron's own) and use exactly that. On Ubuntu, which starts cron with `-P`, `PATH`
  now comes from `/etc/environment` as under cron, and `USER` is no longer set where cron sets none. A
  converted unit lists the variables and unsets what systemd would add on its own. The run dialog names
  the other variables it sets.
- Tests: the end-to-end test covers a second user for editing, backups, run now, recording and
  conversion, compares the whole environment of a job under cron with run now and with a converted
  unit, and tries a link in a user's run directory and a forged conversion note.

## 2.3.0 – 2026-10-13

Backups you can use: compare any of the last ten versions of the root crontab with the current one, and
restore it.

- **Backups:** a new button in the root crontab card lists the backups, newest first, each with what
  restoring it would change. Opening one shows the difference line by line, as `diff` shows it. Restoring
  writes the backup byte for byte through the same locked step as every other change, after a backup of
  the current version, so a restore can be undone the same way.
- Shared design files: `icons.js` has the `ban` icon (for the other add-ons); `azentrius-theme.js`
  changed only in a comment.
- Tests: two tests that failed now and then without a change in the code wait for what they check; the
  end-to-end test is a required check.

## 2.2.0 – 2026-10-12

The shared Azentrius page frame, the polish of stage 1.1 of the roadmap, and a new license.

- **Page frame:** a one-line header without a description; “Refresh” is the only filled button on the
  page, with the time of the data next to it, and says “Loading …” while it loads. Tabs right under the
  header: Overview (timeline and root crontab), systemd timers, and System (`/etc/crontab`,
  `/etc/cron.d`, other users, periodic scripts). Notices and messages stay visible in every tab;
  switching tabs loads nothing. “Add job” is an outlined button; text buttons carry an icon.
- **Leftover runs:** recorded runs of lines that were changed or removed outside the page are listed
  under the root crontab and can be removed. A job that any crontab still mentions is never offered,
  and the check is repeated as root right before anything is removed.
- **Back to cron:** a conversion to a systemd timer can be undone in one step. The crontab is byte for
  byte as before; only units that Cron Jobs wrote are removed.
- **`/etc/cron.d`:** entries are marked exactly as the installed cron skips them (symbolic links, owner,
  permissions, hard links), with cron's reason.
- **Tests and code:** the end-to-end test runs in CI against a real Cockpit and cron; `app.js` is split
  into ES modules, still without a build step.
- Shared design files as in the design system: `azentrius.css` (page header, tabs) and `icons.js`
  (`check`, `arrow-circle-up` for the other add-ons).
- **License:** the Apache License 2.0. Versions up to and including 2.1.1 were released under the GNU
  Lesser General Public License, version 2.1 or later.

## 2.1.1 – 2026-10-12

Maintenance release: the page is unchanged, the release is verifiable.

- **Build provenance:** the release archive comes with a signed build provenance;
  `gh attestation verify cockpit-cronjobs-2.1.1.tar.gz --repo Azentrius/cockpit-cronjobs` checks
  that it was built by the release workflow from this repository.
- **Security policy:** `SECURITY.md` describes private vulnerability reporting.
- **CI:** workflow actions pinned by commit SHA and kept current by Dependabot; checkouts keep no
  token.

## 2.1.0 – 2026-10-12

First public version.

- Overview of the root crontab, `/etc/crontab`, `/etc/cron.d`, other users' crontabs, the
  `/etc/cron.hourly` … `/etc/cron.monthly` scripts and systemd timers, with schedules in words.
- Timeline of the next 24 hours for cron jobs and timers; jobs that start in the same minute are pointed out.
- Safe changes to the root crontab: untouched lines stay byte for byte; every change is one locked step
  with checksum check, verified backup and read-back.
- Recorded runs: exit code, duration and output of the last 20 runs per job (`cockpit-cronjobs-run`).
- Run now with cron's environment, live output and stop.
- Convert jobs to systemd timers, checked against `systemd-analyze` and verified through D-Bus.
- English and German, following Cockpit's language; light and dark, following Cockpit's style.
- Works with Debian/Ubuntu cron and cronie (incl. `CRON_TZ`).
