<!--
Title: short, imperative, English, without a version number. It becomes the commit on main.
Security problems: do not open a pull request, see SECURITY.md.
-->

## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How tested

- [ ] `make check`
- [ ] `make check-ui`
- [ ] `make lint`
- [ ] The end-to-end test (`test/e2e_cockpit.py`, CI or a throw-away machine) when it touches cron, systemd or the crontabs

<!-- Anything else you tried, and on which system and cron. -->

## Checklist

- [ ] Every new or changed text exists in English and German (`src/i18n/en.js` and `src/i18n/de.js`)
- [ ] Crontabs are written only through `SAVE_SCRIPT`; lines that are not changed stay byte for byte
- [ ] Root scripts take values as arguments or standard input, never pasted into shell code, and check them again
- [ ] Changed formats (records of the run recorder, crontab markers, conversion note and units, the status) are read by older and newer versions; a change to `src/cockpit-cronjobs-run` raises `CRONJOBS_RUN_VERSION` and `WRAPPER_VERSION`
- [ ] User-visible changes have an entry under `## Unreleased` in `CHANGELOG.md`
- [ ] No secrets, tokens or real server data (host names, IP addresses, real crontabs) in code, tests or this description
- [ ] SPDX header on every new source file
