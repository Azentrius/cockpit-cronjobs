# Cron Jobs for Cockpit
# SPDX-License-Identifier: LGPL-2.1-or-later

PREFIX ?= /usr/local
DESTDIR ?=
PKGDIR = $(DESTDIR)$(PREFIX)/share/cockpit/cronjobs
VERSION := $(shell sed -n 's/^ *const VERSION = "\(.*\)";/\1/p' src/app.js)
# Reproducible archives: file times from the last commit.
SOURCE_DATE_EPOCH ?= $(shell git log -1 --format=%ct 2>/dev/null || date +%s)
PACKAGE = cockpit-cronjobs-$(VERSION).tar.gz

.PHONY: all install uninstall devel-install devel-uninstall check check-ui lint dist package

all:
	@echo "Nothing to build. Try: make install, make check, make check-ui, make package"

install:
	install -d $(PKGDIR) $(PKGDIR)/lib $(PKGDIR)/i18n
	install -m 644 src/index.html src/manifest.json src/*.js src/*.css src/*.woff2 src/OFL.txt $(PKGDIR)/
	install -m 755 src/cockpit-cronjobs-run $(PKGDIR)/
	install -m 644 src/lib/*.js $(PKGDIR)/lib/
	install -m 644 src/i18n/*.js $(PKGDIR)/i18n/

uninstall:
	rm -rf $(PKGDIR)

# Cockpit also loads packages from ~/.local/share/cockpit (for the logged-in user).
devel-install:
	mkdir -p ~/.local/share/cockpit
	ln -sfn $(CURDIR)/src ~/.local/share/cockpit/cronjobs

devel-uninstall:
	rm -f ~/.local/share/cockpit/cronjobs

check:
	node test/cron.test.js
	node test/fuzz.test.js
	node test/cksum.test.js
	node test/systemd.test.js
	node test/wrapper.test.js
	node test/i18n.test.js

check-ui:
	python3 test/ui_test.py

# Source archive of the last commit.
dist:
	git archive --format=tar.gz --prefix=cockpit-cronjobs-$(VERSION)/ -o cockpit-cronjobs-$(VERSION)-source.tar.gz HEAD
	@echo cockpit-cronjobs-$(VERSION)-source.tar.gz

# Ready-to-install package: a directory "cronjobs" for /usr/share/cockpit or
# /usr/local/share/cockpit, plus SHA256SUMS.
package:
	rm -rf build && mkdir -p build/cronjobs
	cp -R src/. build/cronjobs/
	find build/cronjobs -type d -exec chmod 755 {} +
	find build/cronjobs -type f -exec chmod 644 {} +
	chmod 755 build/cronjobs/cockpit-cronjobs-run
	cd build && tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@$(SOURCE_DATE_EPOCH) \
		-cf - cronjobs | gzip -9n > ../$(PACKAGE)
	sha256sum $(PACKAGE) > SHA256SUMS
	cd build/cronjobs && find . -type f | sort | xargs sha256sum | sed 's|  \./|  cronjobs/|' >> ../../SHA256SUMS
	rm -rf build
	@cat SHA256SUMS

# As in CI: shell scripts with shellcheck, Python with ruff
# (the tools: pip install -r test/requirements.txt).
# CRONJOBS_RUN_VERSION in the run recorder is read by the page (sed), not by the
# script itself, so "unused variable" (SC2034) is off for that file only.
lint:
	shellcheck --severity=warning --exclude=SC2034 src/cockpit-cronjobs-run
	shellcheck --severity=warning tools/*.sh
	ruff check .
