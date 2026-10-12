#!/bin/sh
# Prints the section of CHANGELOG.md for one version ("## 2.1.0 …" up to the next "## ").
# Exit 1 when there is none.
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eu
version=${1:?usage: release-notes.sh VERSION}
file=${2:-CHANGELOG.md}
[ -f "$file" ] || exit 1
notes=$(awk -v v="$version" '
    /^## / {
        if (found) exit
        head = $0
        sub(/^## +\[?/, "", head)
        split(head, w, /[] ]/)
        if (w[1] == v) { found = 1; next }
    }
    found { print }
    END { exit found ? 0 : 1 }
' "$file") || exit 1
printf '%s\n' "$notes" | sed -e '/./,$!d'
