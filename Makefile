# Cron Jobs, a Cockpit page for cron
# SPDX-License-Identifier: Apache-2.0

PREFIX ?= /usr/local
DESTDIR ?=
PKGDIR = $(DESTDIR)$(PREFIX)/share/cockpit/cronjobs
# The status for the Status Board: fixed paths (manifest.json names the helper), whatever PREFIX is.
HELPERS = $(DESTDIR)/usr/lib/cockpit-cronjobs
UNITS = $(DESTDIR)/usr/lib/systemd/system
VERSION := $(shell sed -n 's/^ *const VERSION = "\(.*\)";/\1/p' src/app.js)
# Reproducible archives: file times from the last commit.
SOURCE_DATE_EPOCH ?= $(shell git log -1 --format=%ct 2>/dev/null || date +%s)
PACKAGE = cockpit-cronjobs-$(VERSION).tar.gz

.PHONY: all install uninstall devel-install devel-uninstall check check-ui docs-shots lint dist package stage packages

all:
	@echo "Nothing to build. Try: make install, make check, make check-ui, make package, make packages"

install:
	install -d $(PKGDIR) $(PKGDIR)/app $(PKGDIR)/lib $(PKGDIR)/i18n
	install -m 644 src/index.html src/manifest.json src/*.js src/*.css src/*.woff2 src/OFL.txt \
		src/CC-BY-4.0-Font-Awesome.txt $(PKGDIR)/
	install -m 755 src/cockpit-cronjobs-run $(PKGDIR)/
	install -m 644 src/app/*.js $(PKGDIR)/app/
	install -m 644 src/lib/*.js $(PKGDIR)/lib/
	install -m 644 src/i18n/*.js $(PKGDIR)/i18n/
	install -d $(HELPERS) $(UNITS)
	install -m 755 status/cronjobs-status $(HELPERS)/
	install -m 644 status/cockpit-cronjobs-status.service status/cockpit-cronjobs-status.timer $(UNITS)/
	if [ -z "$(DESTDIR)" ]; then sh packaging/scripts/configure; fi

uninstall:
	if [ -z "$(DESTDIR)" ]; then sh packaging/scripts/remove; fi
	rm -rf $(PKGDIR) $(HELPERS)
	rm -f $(UNITS)/cockpit-cronjobs-status.service $(UNITS)/cockpit-cronjobs-status.timer
	if [ -z "$(DESTDIR)" ]; then sh packaging/scripts/removed; fi

# Cockpit also loads packages from ~/.local/share/cockpit (for the logged-in user).
devel-install:
	mkdir -p ~/.local/share/cockpit
	ln -sfn $(CURDIR)/src ~/.local/share/cockpit/cronjobs

devel-uninstall:
	rm -f ~/.local/share/cockpit/cronjobs

check:
	-node test/cron.test.js
	-node test/fuzz.test.js
	-node test/cksum.test.js
	-node test/systemd.test.js
	-node test/wrapper.test.js
	-node test/orphans.test.js
	-node test/units.test.js
	-node test/backups.test.js
	-node test/i18n.test.js
	-node test/files.test.js
	-node test/status.test.js
	-node test/menu.test.js

check-ui:
	python3 test/ui_test.py

# The screenshots of the README, into docs/ (needs Python Playwright with Chromium).
docs-shots:
	python3 test/docs_shots.py docs

# Source archive of the last commit.
dist:
	git archive --format=tar.gz --prefix=cockpit-cronjobs-$(VERSION)/ -o cockpit-cronjobs-$(VERSION)-source.tar.gz HEAD
	@echo cockpit-cronjobs-$(VERSION)-source.tar.gz

# Ready-to-install package: a directory "cronjobs" for /usr/share/cockpit or
# /usr/local/share/cockpit, with LICENSE and NOTICE, plus SHA256SUMS.
package:
	rm -rf build && mkdir -p build/cronjobs
	cp -R src/. build/cronjobs/
	cp LICENSE NOTICE build/cronjobs/
	find build/cronjobs -type d -exec chmod 755 {} +
	find build/cronjobs -type f -exec chmod 644 {} +
	chmod 755 build/cronjobs/cockpit-cronjobs-run
	cd build && tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@$(SOURCE_DATE_EPOCH) \
		-cf - cronjobs | gzip -9n > ../$(PACKAGE)
	sha256sum $(PACKAGE) > SHA256SUMS
	cd build/cronjobs && find . -type f | sort | xargs sha256sum | sed 's|  \./|  cronjobs/|' >> ../../SHA256SUMS
	rm -rf build
	@cat SHA256SUMS

# The files of the .deb and .rpm, as installed, in build/root.
stage:
	rm -rf build/root
	$(MAKE) install DESTDIR=build/root PREFIX=/usr
	install -D -m 644 packaging/de.azentrius.cronjobs.metainfo.xml \
		build/root/usr/share/metainfo/de.azentrius.cronjobs.metainfo.xml
	install -D -m 644 NOTICE build/root/usr/share/doc/cockpit-cronjobs/copyright
	install -m 644 LICENSE src/CC-BY-4.0-Font-Awesome.txt build/root/usr/share/doc/cockpit-cronjobs/

# cockpit-cronjobs_VERSION-1_all.deb and cockpit-cronjobs-VERSION-1.noarch.rpm in dist/
# (needs dpkg-deb and rpmbuild), reproducible like the archive.
packages: stage
	SOURCE_DATE_EPOCH=$(SOURCE_DATE_EPOCH) sh tools/build-packages.sh build/root $(VERSION) dist

# As in CI: shell scripts with shellcheck, Python with ruff
# (the tools: pip install -r test/requirements.txt).
# CRONJOBS_RUN_VERSION in the run recorder is read by the page (sed), not by the
# script itself, so "unused variable" (SC2034) is off for that file only.
lint:
	shellcheck --severity=warning --exclude=SC2034 src/cockpit-cronjobs-run
	shellcheck --severity=warning tools/*.sh status/cronjobs-status packaging/scripts/*
	ruff check .
