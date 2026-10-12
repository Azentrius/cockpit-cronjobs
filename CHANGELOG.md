# Changelog

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
