# Roadmap

As of 2026-10-14. Each stage is cut so that it is useful on its own and brings its own tests. The
order is the recommendation; stages after 1.1 are proposals until they are decided.

**Guardrails for every stage** (they keep applying):

- **Byte for byte:** lines of a crontab that a change does not touch stay exactly as they were. Every
  write is one locked root step: checksum of the version shown, verified backup, write, read back.
- **Like cron:** whatever the page runs or converts behaves as cron would: environment, `%` and `\%`,
  umask, `CRON_TZ`. Tests compare against the real tools (`systemd-analyze`, dash and bash, real cron).
- **Show first:** a change shows what it will do before it does it. Whatever can fail stops before
  anything changes; a step that changes two things (crontab and systemd) is undone as a whole.
- **Root code:** only the fixed scripts in `src/app/system.js` and `src/cockpit-cronjobs-run`. Values reach
  them as arguments or standard input, never pasted into shell code; IDs and names are checked on both
  sides.
- **Browser:** no build step, no runtime dependencies, no external resources, nothing inline (Cockpit's
  CSP). Every text in English and German. Usable on a phone.
- **Any server:** Debian/Ubuntu cron and cronie; nothing that only fits one installation.
- **Tests:** unit and browser tests for every change; end-to-end only on throwaway machines
  (`test/e2e_cockpit.py`).

---

## Stage 1 – First public version ✅

Done in 2.1.0 (see [CHANGELOG](CHANGELOG.md)): overview of all crontabs and systemd timers, timeline
of the next 24 hours, safe changes to the root crontab, recorded runs, run now, conversion to systemd
timers, English and German.

---

## Stage 1.1 – Polish ✅

Done in 2.2.0 (see [CHANGELOG](CHANGELOG.md)), together with the shared Azentrius page frame.

| # | Topic | Scope | Done when … |
|---|---|---|---|
| 1 | **Orphaned runs** | Run directories in `/var/lib/cockpit-cronjobs/runs/` whose ID no crontab line uses any more (lines edited by hand, conversions). Show them with their size and offer “Remove”. | No directory of a line that still exists is ever offered; tests with a fake runs directory |
| 2 | **Undo a conversion** | The note line written by a conversion is recognised: the job shows “converted to `NAME.timer`” with a link to the timer instead of the raw comment, and an action “Back to cron” (stop and remove the units, switch the line on, remove the note) in one step as in the conversion. | Convert → back gives a crontab identical byte for byte to the one before; units gone |
| 3 | **Symlinks in `/etc/cron.d`** | Today the page checks name, owner and mode of the file a link points to. Check in the source of Debian's cron and cronie which rules apply to the link itself, and mark skipped files with the reason. | Marked exactly as cron treats them; one test per rule |
| 4 | **End-to-end in CI** | Run `test/e2e_cockpit.py` on the GitHub runner (throwaway VM): install `cockpit-ws` and `cron`, start them, run the test. | Green check on every pull request, next to `test` |
| 5 | **Split `src/app.js`** | About 2,400 lines in one file. Split into ES modules (`<script type="module">` works under Cockpit's CSP without a build): system access, timeline, dialogs, runs, conversion. | No change in behaviour; all tests green unchanged |

---

## Stage 2 – Backups you can use ✅

Done in 2.3.0 (see [CHANGELOG](CHANGELOG.md)): the list shows when each backup was saved and what restoring
it would change; the end-to-end test compares the difference with `diff` and restores and restores back.

**Goal:** the last ten versions of the root crontab are not only kept, but useful.

- List the backups with date and size; show the difference to the current crontab line by line.
- “Restore”: writes the backup through the same locked step (with a backup of the current version
  first), so a restore can itself be undone.

**Done when …** restoring and restoring back gives the original bytes; the difference view matches
`diff` on the files.

---

## Stage 3 – Crontabs of other users ✅

Done in 2.4.0 (see [CHANGELOG](CHANGELOG.md)), only with administrative access (without it they are not
shown at all); the end-to-end test covers a second user for editing, backups, run now, recording and
conversion. Run now and conversions use the environment cron gives a job on the server.

**Goal:** the crontabs of other users can be changed with the same safety as root's (they were
read-only before).

- `crontab -u USER` in the same locked step, backups per user, user names checked against the system.
- Recording and run now as that user; conversion with `User=` in the service unit.
- `/etc/crontab` and `/etc/cron.d` stay read-only: they belong to packages and configuration
  management.

**Done when …** end-to-end tests cover a second user for editing, recording, run now and conversion.

---

## Stage 4 – Results at a glance

**Goal:** see what failed without opening each job.

- A summary of the latest runs of all recorded jobs (failed first) and of the systemd timers.
- Runs of converted jobs from the journal (`journalctl -u NAME.service`) in the same runs dialog, so a
  job keeps its history after a conversion.

**Done when …** a failing recorded job and a failing timer both show up in the summary within a
minute of the run.

---

## Stage 5 – Distribution and reach

- **Packages:** `.deb` and `.rpm` built by the release workflow, next to the archive.
- **Cockpit's Applications page:** AppStream metadata (`org.cockpit_project.cronjobs.metainfo.xml`), so
  Cron Jobs can be found and installed from Cockpit itself.
- **More translations** through `src/i18n/` (texts are already separate from the code).
- **BusyBox systems** (e.g. Alpine): `flock` without `-w`, `setsid` without `-w`, `crond` with
  `/etc/crontabs`.

---

## Technical debt

| Topic | Proposal |
|---|---|
| Upgrading the run recorder | when `cockpit-cronjobs-run` changes, raise `CRONJOBS_RUN_VERSION` (the page then offers the update); old records must stay readable |
| Shared design files (`azentrius.css`, `azentrius-theme.js`, `icons.js`, fonts) are copies | keep them byte-identical with the other Azentrius add-ons; change them only together |

---

## Deliberately not planned

- A heartbeat to an external monitor (e.g. Uptime Kuma) for each run.
- Editing `/etc/crontab` and `/etc/cron.d` (see stage 3).

---

## Open decisions

1. Stage 4: is a summary inside Cockpit enough, or should failures also notify someone (mail, ntfy, …)?
3. Stage 5: packages and the listing in Cockpit's Applications page: worth the upkeep?
