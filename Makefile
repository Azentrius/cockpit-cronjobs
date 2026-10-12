# Cron Jobs for Cockpit
# SPDX-License-Identifier: LGPL-2.1-or-later

PREFIX ?= /usr/local
DESTDIR ?=
PKGDIR = $(DESTDIR)$(PREFIX)/share/cockpit/cronjobs
VERSION := $(shell sed -n 's/^ *const VERSION = "\(.*\)";/\1/p' src/app.js)

.PHONY: all install uninstall devel-install devel-uninstall check check-ui dist

all:
	@echo "Nothing to build. Try: make install, make check, make check-ui, make dist"

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

dist:
	git archive --format=tar.gz --prefix=cockpit-cronjobs-$(VERSION)/ -o cockpit-cronjobs-$(VERSION).tar.gz HEAD
	@echo cockpit-cronjobs-$(VERSION).tar.gz
