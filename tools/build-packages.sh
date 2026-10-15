#!/bin/sh
# Builds the .deb and the .rpm of an Azentrius Cockpit add-on from a staged root tree.
#
#   tools/build-packages.sh ROOT VERSION OUTDIR
#
# ROOT holds the files as installed (usr/share/cockpit/…, usr/share/metainfo/…, usr/share/doc/…).
# The package details come from packaging/package.conf; maintainer scripts, if the package has
# any, from packaging/deb/{postinst,prerm,postrm} and packaging/rpm/{post,preun,postun}.
# Reproducible: all times are SOURCE_DATE_EPOCH. Needs dpkg-deb and rpmbuild.
# The same file in every Azentrius Cockpit add-on; change it in all of them together.
# SPDX-License-Identifier: Apache-2.0
set -eu

root=$(cd "${1:?usage: build-packages.sh ROOT VERSION OUTDIR}" && pwd)
version=${2:?version}
mkdir -p "${3:?outdir}"
out=$(cd "$3" && pwd)
epoch=${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH must be set}
here=$(pwd)
NAME= SUMMARY= DESCRIPTION= HOMEPAGE= MAINTAINER= LICENSE= DEB_DEPENDS= RPM_REQUIRES= FILES=
# shellcheck source=/dev/null
. "$here/packaging/package.conf"
for var in NAME SUMMARY DESCRIPTION HOMEPAGE MAINTAINER LICENSE DEB_DEPENDS RPM_REQUIRES FILES; do
    eval "[ -n \"\$$var\" ]" || { echo "packaging/package.conf: $var is empty" >&2; exit 1; }
done

# 2.6.0-rc.1 sorts before 2.6.0 only with "~" in both formats.
upstream=$(printf '%s' "$version" | tr '-' '~')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ---- .deb
deb_version=$upstream-1
mkdir -p "$work/deb"
cp -a "$root/." "$work/deb/"
mkdir -m 755 "$work/deb/DEBIAN"
{
    echo "Package: $NAME"
    echo "Version: $deb_version"
    echo "Architecture: all"
    echo "Maintainer: $MAINTAINER"
    echo "Installed-Size: $(du -sk "$root" | cut -f1)"
    echo "Depends: $(printf '%s\n' "$DEB_DEPENDS" | paste -sd ',' - | sed 's/,/, /g')"
    echo "Section: admin"
    echo "Priority: optional"
    echo "Homepage: $HOMEPAGE"
    echo "Description: $SUMMARY"
    printf '%s\n' "$DESCRIPTION" | fold -s -w 78 | sed 's/ *$//; s/^/ /'
} > "$work/deb/DEBIAN/control"
for script in postinst prerm postrm; do
    if [ -f "$here/packaging/deb/$script" ]; then
        install -m 755 "$here/packaging/deb/$script" "$work/deb/DEBIAN/$script"
    fi
done
(cd "$work/deb" && find . -path ./DEBIAN -prune -o -type f -print | sed 's|^\./||' | LC_ALL=C sort |
    xargs md5sum > DEBIAN/md5sums)
chmod 644 "$work/deb/DEBIAN/control" "$work/deb/DEBIAN/md5sums"
find "$work/deb" -exec touch -h -d "@$epoch" {} +
deb=$out/${NAME}_${deb_version}_all.deb
SOURCE_DATE_EPOCH=$epoch dpkg-deb --root-owner-group -Zxz --build "$work/deb" "$deb" > /dev/null

# ---- .rpm
mkdir -p "$work/rpm/SPECS" "$work/rpm/BUILD"
spec=$work/rpm/SPECS/$NAME.spec
{
    echo "Name: $NAME"
    echo "Version: $upstream"
    echo "Release: 1"
    echo "Summary: $SUMMARY"
    echo "License: $LICENSE"
    echo "URL: $HOMEPAGE"
    echo "BuildArch: noarch"
    printf '%s\n' "$RPM_REQUIRES" | sed 's/^/Requires: /'
    echo
    echo "%description"
    printf '%s\n' "$DESCRIPTION" | fold -s -w 78 | sed 's/ *$//'
    echo
    echo "%install"
    echo "cp -a '$root/.' '%{buildroot}/'"
    for script in post preun postun; do
        if [ -f "$here/packaging/rpm/$script" ]; then
            echo
            echo "%$script"
            cat "$here/packaging/rpm/$script"
        fi
    done
    echo
    echo "%files"
    printf '%s\n' "$FILES"
} > "$spec"
rpmbuild -bb --quiet \
    --define "_topdir $work/rpm" \
    --define "_rpmdir $out" \
    --define "_build_name_fmt %%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm" \
    --define "_buildhost reproducible" \
    --define "use_source_date_epoch_as_buildtime 1" \
    --define "clamp_mtime_to_source_date_epoch 1" \
    --define "_binary_payload w9.xzdio" \
    --define "__os_install_post %{nil}" \
    --define "debug_package %{nil}" \
    --define "_build_id_links none" \
    "$spec"
rpm=$out/$NAME-$upstream-1.noarch.rpm

[ -f "$deb" ] && [ -f "$rpm" ]
echo "$deb"
echo "$rpm"
