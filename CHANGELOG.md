# Changelog

## 2.2.0 – 2026-10-12

The shared Azentrius page frame, and the polish of stage 1.1 of the roadmap.

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
