# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub instead:
[Report a vulnerability](https://github.com/Azentrius/cockpit-cronjobs/security/advisories/new)
(tab **Security → Report a vulnerability** in this repository).

Please include:

- what is affected (page, run recorder, systemd conversion, status helper, packages;
  version or commit),
- steps to reproduce,
- the impact you expect.

We aim to acknowledge reports within 7 days. This is a small project, so a fix
may take longer; we will keep you informed and credit you in the advisory
unless you prefer to stay anonymous.

## Supported versions

Only the latest release and the latest state of the `main` branch receive
security fixes.

## Especially relevant

Cron Jobs changes the root crontab and, with administrative access, those of
other users, writes systemd units, installs a run recorder that runs as root and
as those users, and its packages bring a status helper that runs as root from a
timer. Reports are particularly welcome for:

- ways to get commands, names or texts interpreted as shell code instead of
  being passed as arguments,
- writing the root crontab without the checksum, lock or backup, or leaving it
  in a state that differs from what the page showed,
- unit names, paths or environment values that escape `/etc/systemd/system`
  or `/var/lib/cockpit-cronjobs`, or change what systemd runs,
- the run recorder (`cockpit-cronjobs-run`) exposing recorded output to other
  users or letting a job influence other jobs' records or starts,
- another user making root read, follow or remove something through that
  user's directory of runs (`/var/lib/cockpit-cronjobs/users/USER`), in the
  page or in the status helper (`cronjobs-status`),
- user names, commands or output reaching the status files, which anyone can
  read,
- a log line that passes for a start, an end or a failure cron logged itself, or
  that makes the page or the status count a failure for another job than the one
  that failed,
- release archives, packages or `SHA256SUMS` that do not match the tagged
  source.
