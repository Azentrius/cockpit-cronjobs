# Changelog

## Unreleased

Jobs that do not record their runs show how their last run ended, where cron logs it, in the latest
results and in the status too; the descriptions say what the page does since 2.8 and 2.9; the last
start from cron's log is found however much cron logs.

- **Failures from cron's log in the status:** when Debian's cron logs failures (`-L` with 4), the item
  `failed` counts the jobs whose run cron logged as failed in the last 24 hours, read as the page reads
  them: those of `/etc/crontab` and `/etc/cron.d` by their path, those of the crontabs of root and other
  users only in number ("1 job without recording, from cron's log"), and only jobs that are still
  there and do not record their runs. `ok` then says that cron's log shows no failed job, and
  `unrecorded` that their failures show there. cron's log is read only then, from the last 24 hours.
- **Latest results:** the runs from cron's log whose end it tells (failed, OK, running) are listed too,
  marked as from cron's log, so the link of the status item leads to them.
- **Results from cron's log:** for a job that does not record its runs, and for those in `/etc/crontab`,
  `/etc/cron.d` and the crontabs the page only shows, the page reads from cron's log how the newest run
  ended, where cron logs it: Debian's cron with `-L 15` (or 2 and 4) logs the end and failures, with the
  exit status or signal, and the page shows "Failed · exit N", "OK" (an end without failure), "Running"
  and the duration; cronie logs only the end ("Ended"). A failure belongs to the run whose process it
  names. What cron logs is read from its command line; "OK" and "Running" count only for runs it
  started since then. At Debian's default (`-L 1`, starts only) the System tab says how to set the
  option. The column in the System tab is now "Last run". The end-to-end test runs a failing job under
  cron at `-L 15`.
- **Last start with cron's PID:** Debian's cron started with `-L 8` or more (the job's PID in the log)
  logs a start as `(USER) CMD ([PID] COMMAND)`; the page found no start then. It leaves the PID out
  now, so such starts count, and those logged before and after a change of the option count as one
  command. The end-to-end test runs once with cron at `-L 15`.
- **Packages:** the description of the `.deb` and `.rpm` and the AppStream data (Cockpit's Applications
  page) name the crontabs of other users, missed runs, runs from cron's log and the status for the
  Azentrius Status Board.
- **README** and **SECURITY.md:** the status names converted jobs and the cron service, the safety notes
  cron's log and jobs that do not overlap, and the parts of the page worth a security report include
  the run recorder as other users, the status helper and cron's log.

## 2.9.0 – 2026-10-21

The status follows converted jobs and the cron service, links to the page and shows in Cockpit's menu;
the page shows missed runs and when cron last started a job, records all jobs of a crontab at once and
can keep a job from starting while its previous run goes on (run recorder version 3).

- **Links for the Status Board:** every item of the status carries a `link` to its place on the page:
  `failed` `#/overview/results` (the latest results, failures first), `unrecorded`
  `#/overview/crontab` (the root crontab, the other users' after it), `cron` `#/overview/notices`
  (where the page says that cron is not running). The tile goes to the link of its most important
  item.
- **The page follows its address:** Cockpit keeps a page that is loaded and, when the Status Board
  jumps to it again, only changes its address. The page now listens to `locationchanged`: the tab at
  once, the card once the page has loaded and is shown. Every tab has an address (`#/overview`,
  `#/timers`, `#/system`), and a tab chosen on the page goes into it, so the link to the place shown
  before leads there again. Without a place the page opens on Overview as before; a path that is no
  place changes nothing.
- **Status in Cockpit's menu:** the menu entry “Cron Jobs” carries Cockpit's own status icon (red: a
  job failed or cron is stopped; yellow: a warning, or the status is more than an hour old) with the
  summary as its tooltip, judged as the Status Board judges it; nothing to do, no icon. For this
  Cockpit loads the page hidden right after the login (`preload`); until it is opened it only reads
  `/var/lib/cockpit-cronjobs/status.json` (or `status.de.json`) every five minutes and runs nothing
  else.
- **Converted jobs:** a run of a job converted to a systemd timer that failed in the last 24 hours, or
  lost its end, counts in `failed`, read from the journal of its service as the page reads it
  (`R.parseJournal`): systemd's own messages only, the last 20 runs. Before, a converted job left the
  status, since its line in the crontab is switched off. Only units the conversion wrote count, checked
  as back to cron checks them. Timers from root's crontab are named (`nightly.timer`); those from
  another user's crontab are only counted, since the name a conversion suggests for them begins with
  the user's.
- **Cron service:** a new item `cron`, read as the page reads it: `ok` while the service runs; when it
  does not, `danger` if the crontabs have jobs, else `warning`. The summary then says so first.
- **Missed runs:** when the last run of a recorded job succeeded but the next one its schedule names
  left no record five minutes after its time, the job is listed as missed, with the time it was due,
  after the failed ones and before the running ones. That is what a stopped cron, or a server that was
  down at the time, leaves behind; cron does not catch such runs up. The next run is cron's, clock
  changes and `CRON_TZ` included (`C.nextRun`); runs started by hand do not stand in for a scheduled
  one. A job with no recorded run yet is not judged: it is not known when recording began.
- **Record all:** each crontab's card offers “Record all” while one of its enabled jobs does not record
  its runs. The dialog lists those jobs with their schedules and says how many cannot be recorded (a
  `%` in the command); confirmed, the run recorder (and for another user the directory for their runs)
  comes first, then one write of the crontab through the locked step with its backup, each job wrapped
  with an ID of its own (`C.captureJobs`). Every other line stays byte for byte; when a line changed
  meanwhile, nothing is written. What the status counts as `unrecorded` is then one click away.
- **Not starting while a run goes on:** a new option in the dialog of a recorded job. The page puts
  the file `no-overlap` into the job's directory of runs, as its owner, after the crontab is written;
  the line in the crontab stays as it is, so older versions read it as before. The run recorder,
  version 3 (`CRONJOBS_RUN_VERSION`, the page offers the update as before), then checks each start
  under the lock it takes for its records: when a run of this job goes on (a run marker whose process
  is the recorder for this ID), the command does not run, the start goes into `skipped.jsonl` (the
  last 20) and the recorder ends with 75; a start by hand says so on its output. The runs dialog says
  that the job does not overlap and how many starts were skipped; a skipped start counts as one cron
  made for missed runs. Without the option nothing changes: the job overlaps as with cron.
- **Starts from cron's log:** for a job that does not record its runs ("Not recorded · started …") and
  in a new column “Last start” of `/etc/crontab`, `/etc/cron.d` and the crontabs the page only shows.
  Cron logs each start as `(USER) CMD (COMMAND)`; the page reads those of the last 35 days from the
  journal once per load, only cron's own (`_UID=0`, `_COMM=cron` or `crond`, which journald sets, so no
  one else can log a start), the newest of each, and matches them by user and by the command as cron
  logs it (`C.loggedCommand`: before the first unescaped `%`, bytes escaped as cron's `mkprint` does).
  How a run ended is not in the log, and the page says so. Without the journal it shows dashes.
- **Tests:** the unit test checks the status helper against the page's journal parser with the sample
  of systemd 259 and made-up runs (failed, killed, running, lost, older than a day, beyond the last 20,
  lines of the job that look like systemd's), units that are not a conversion's, other users' timers
  and the cron service, with dash and bash, mawk and gawk; the sample moved to
  `test/journal-sample.js`. The end-to-end test converts a failing job, finds its timer in the status,
  stops cron for real and finds that in the status and on the page. A unit test for `R.missed` (within
  and past the five minutes, a run that came, runs by hand, no run, no next run, the day summer time
  ends) and a browser test (the order, the title, the runs it opens). For record all a unit test of
  `C.captureJobs` (no ID given twice, a `%`, recorded jobs and other lines as they were) and a browser
  test (the dialog, cancelling, one write with its backup, another user's crontab). For not starting
  while a run goes on, the recorder with dash and bash (skipped silently or with a word by hand, the
  last 20 skips, beside its own slow run, not held back by another job, a dead marker or without the
  option), `R.parseRuns`, and a browser test (only with recording, set and cleared as root and as
  another user, the runs dialog, a failure to set it). For cron's log, unit tests of `C.mkprints`,
  `C.loggedCommand` and `C.parseCronLog`, the script with dash and bash against a stand-in for
  journalctl (the newest of each, other messages left out, the fields it filters on), a browser test
  (an unrecorded job, a `%` job, bytes beyond ASCII, another user's start, no log), and the end-to-end
  test finds the start of a job Debian's cron ran.
- **Tests for the links and the menu:** `test/menu.test.js` (new, Node): the icon for every state, an
  item worse than the whole, an item out of date (in German and English, with the time), what the
  board ignores, the file of the page's language, the start once shown, and every link of the helper
  a place of the page with an element to scroll to. `test/status.test.js`: the link of every item.
  The browser tests open each place, follow changes of the address while the page stays loaded, the
  tab chosen on the page in the address, paths that are no place, a reload that scrolls nowhere, the
  page loaded hidden at a place, and the icon (failed, out of date, English, no file, hidden). The
  end-to-end test loads the page without Cockpit's shell, as before; it starts there as well, since
  cockpit-ws drops the icon's `notify` without a shell.

## 2.8.1 – 2026-10-19

The list of recorded runs reads at most the last 64 KiB of each `runs.jsonl`, so another user can no
longer make it take the server's memory or send the page gigabytes.

- **Runs of other users' jobs:** the list is read as root, and the runs of another user's jobs lie in
  `/var/lib/cockpit-cronjobs/users/USER/runs/ID`, which that user owns. The page checked that
  `runs.jsonl` is a regular file and no link, then took its last 20 lines with `tail -n 20`, which keeps
  what it reads until it has seen 20 line ends. A user who swapped the file for a link to `/dev/zero`
  right after the check had root's `tail` take memory without limit for five seconds, and a file of
  gigabytes without line ends went to the page whole. Now the last 64 KiB are taken first
  (`tail -c 65536 | tail -n 20`), as the status helper of 2.8.0 does; 20 records are a few KiB. The
  other reads as root in these directories had a bound already: the run markers (`head -c 4096`) and
  the disk use (`du` under `timeout`); a run's output is read as its user. A unit test, with dash and
  bash, swaps the file for a link to `/dev/zero` between the check and the read (under a memory limit)
  and lists a file of 32 MiB.
- **Status for the Status Board:** 2.8.0 was not released on its own; its status comes with this
  release. Failed jobs of the last 24 hours and jobs without recording are worked out as root every
  15 minutes by `cockpit-cronjobs-status.timer`, which the `.deb` and `.rpm` turn on, and can be read
  without administrative access. Details under 2.8.0 in the changelog.

## 2.8.0 – 2026-10-19

A status for the Azentrius Status Board: failed jobs of the last 24 hours and jobs without recording,
readable without administrative access.

- **Status:** `/usr/lib/cockpit-cronjobs/cronjobs-status status --lang en|de` prints the state of Cron Jobs
  in the status format all Azentrius Cockpit add-ons share (schema 1), and `manifest.json` names it under
  `azentrius.status`. Two items: `failed`, the recorded jobs with a failed or aborted run in the last
  24 hours (`danger`, with their IDs), and `unrecorded`, the jobs whose results are not known because they
  do not record their runs (`none`). Only the crontabs of root and the other users count, read as the
  page reads them.
- **Timer:** `cockpit-cronjobs-status.timer` works the status out as root every 15 minutes and writes it
  to `/var/lib/cockpit-cronjobs/status.json` and `status.de.json` (mode 644; numbers, states and job IDs,
  no user names), so reading it needs no administrative access. The `.deb` and `.rpm` turn it on and,
  when they are removed, off again; `make install` and `make uninstall` do the same. The archive of a
  release holds only the page and brings no status.
- **Tests:** a unit test checks the helper against the page's own crontab parser with dash and bash,
  mawk and gawk; the packages write the status on Debian and Fedora; the end-to-end test runs the unit
  and reads the status as a user without rights.

## 2.7.4 – 2026-10-18

Azentrius moves to azentrius.com; the page itself works as before.

- **Signature:** the word mark links to azentrius.com.
- **Package repository:** README and release notes name packages.azentrius.com, the new address of the
  Azentrius package repository; packages.azentrius.de keeps serving the same packages.
- **Maintainer** of the `.deb` and `.rpm`: support@azentrius.com.

## 2.7.3 – 2026-10-18

The page brings its own monospace font, so commands and paths no longer fall back to another font under
Cockpit 314 (Ubuntu 24.04).

- **Red Hat Mono comes with the page:** commands, paths and schedules are set in Red Hat Mono, as the
  design system asks, from the page's own `RedHatMono.woff2` (a Latin subset, SIL Open Font License 1.1,
  in `OFL.txt` and NOTICE). Until now `azentrius.css` took the font from Cockpit's
  `/cockpit/static/fonts/RedHatMono/RedHatMonoVF.woff2`, which Cockpit 314 from Ubuntu 24.04 does not
  have: every load of the page got a 404 for it, and code was shown in a fallback (Courier New or the
  browser's monospace font). The shared design files gain
  the font file; the browser tests no longer stand in a font for Cockpit's, and a unit test checks that
  every `url()` in the stylesheets names a file of the page.

## 2.7.2 – 2026-10-18

The archive of a release carries the license and the notice; the page itself is unchanged.

- **Licenses in the archive:** `cockpit-cronjobs-VERSION.tar.gz` contains `LICENSE` and `NOTICE` (as
  `cronjobs/LICENSE` and `cronjobs/NOTICE`, listed in `SHA256SUMS`), as the `.deb` and `.rpm` already do.

## 2.7.1 – 2026-10-18

Fixes: conversions to one name at the same time, next runs when the clock changes, steps after a single
value, and `CRON_TZ` in `/etc/crontab` and `/etc/cron.d`.

- **Conversions at the same time:** two conversions to the same name, from two browsers or tabs, could
  both report success, the second overwriting the first one's units; if one of them failed afterwards,
  taking back its units could remove those of the other, whose crontab line was already off. Now each
  conversion owns the units it writes: they are only created when the name is free, and only the
  conversion that wrote them starts their timer or takes them back, all under the crontab lock
  (`/var/lib/cockpit-cronjobs/converting/` says which one while it is under way). Back to cron removes
  units under the same lock.
- **When the clock changes:** next runs and the timeline follow cron. When summer time ends, the repeated
  hour runs only the jobs with `*` in the minute or hour field again (until now a job every minute went
  missing for that hour), and jobs at a fixed time run once; when it starts, jobs at a fixed time of the
  skipped hour run right after the change, the others do not catch up. With cronie, jobs with `CRON_TZ`
  run as cronie runs them.
- **Steps need `*` or a range:** a schedule like `5/10 * * * *` was accepted, but Debian's cron and cronie
  both refuse it; the form now says so and names `*/10` and `5-59/10`. A timer described in words no
  longer comes out as such a schedule.
- **`CRON_TZ` in system crontabs:** with cronie, `CRON_TZ` in `/etc/crontab` and `/etc/cron.d` now counts
  for the jobs below it in the same file: the timeline draws them at the right time, and they show their
  zone with the schedule.
- Tests: next runs are compared with a port of cron's main loop around every clock change of 2026 in four
  zones; two conversions of one name at the same time, and one that fails after another finished, run
  against the root steps with dash and bash.

## 2.7.0 – 2026-10-16

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
- **Links out of the page:** "Open in Services" and the systemd timer a job was converted to carry the
  external-link-alt icon after the text. Other links, such as "Try again" or "Record runs", have no icon.
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
- **Tables no longer widen the page:** the table wrapper is positioned (`position: relative` on
  `.az-table-wrap`, as in the design system), so the hidden helper texts in a table head stay inside it
  when the table scrolls sideways.

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
