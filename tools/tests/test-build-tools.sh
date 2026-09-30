#!/bin/sh
# Offline integration tests. All ko files are text fixtures, not loadable modules.
set -eu
SOURCE_ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
FIXTURE_ROOT=$(mktemp -d /tmp/pathmask-tool-test.XXXXXX)
REAL_MAKE=$(command -v make)
cleanup() {
	case "$FIXTURE_ROOT" in
	/tmp/pathmask-tool-test.*) rm -rf -- "$FIXTURE_ROOT" ;;
	*) echo "Refusing fixture cleanup: $FIXTURE_ROOT" >&2 ;;
	esac
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

PACKAGE_ROOT="$FIXTURE_ROOT/package with spaces"
mkdir -p "$PACKAGE_ROOT/tools"
cp "$SOURCE_ROOT/tools/package_ksu.sh" "$PACKAGE_ROOT/tools/"
cp -R "$SOURCE_ROOT/ksu-module" "$PACKAGE_ROOT/"
check_package() {
	python3 - "$PACKAGE_ROOT/out/test.zip" "$1" "$2" "$SOURCE_ROOT/ksu-module" <<'PY'
import pathlib, sys, zipfile
archive, marker, url, template = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    assert z.read("pathmask.ko").decode() == marker, "wrong module selected"
    updates = [s for s in z.read("module.prop").decode().splitlines() if s.startswith("updateJson=")]
    assert updates == (["updateJson=" + url] if url else []), updates
    for conf in pathlib.Path(template).glob("*.conf"):
        assert z.read(conf.name).decode().replace("\r\n", "\n") == conf.read_text(), conf.name
PY
}
for kmi in android12-5.10 android13-5.10 android13-5.15 android14-5.15 \
	android14-6.1 android15-6.6 android16-6.12 android17-6.18; do
	mkdir -p "$PACKAGE_ROOT/kernel/out/$kmi"
	printf '%s' "$kmi" > "$PACKAGE_ROOT/kernel/out/$kmi/pathmask.ko"
	printf '%s' "guard-$kmi" > "$PACKAGE_ROOT/kernel/out/$kmi/procguard.ko"
	sh "$PACKAGE_ROOT/tools/package_ksu.sh" "kernel/out/$kmi/pathmask.ko" out/test.zip > "$FIXTURE_ROOT/package.log"
	check_package "$kmi" "https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/$kmi.json"
	python3 - "$PACKAGE_ROOT/out/test.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert "procguard.ko" in z.namelist(), "sibling procguard missing"
PY
done
latest="$PACKAGE_ROOT/kernel/out/android15-6.6/pathmask.ko"
touch -t 203001010000 "$latest"
url=https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/android15-6.6.json
sh "$PACKAGE_ROOT/tools/package_ksu.sh" "" out/test.zip > "$FIXTURE_ROOT/package.log"
check_package android15-6.6 "$url"
sh "$PACKAGE_ROOT/tools/package_ksu.sh" "$latest" out/test.zip > "$FIXTURE_ROOT/package.log"
check_package android15-6.6 "$url"
NO_UPDATE_JSON=1 sh "$PACKAGE_ROOT/tools/package_ksu.sh" "$latest" out/test.zip > "$FIXTURE_ROOT/package.log"
check_package android15-6.6 ""
UPDATE_JSON_URL=https://example.invalid/update.json sh "$PACKAGE_ROOT/tools/package_ksu.sh" "$latest" out/test.zip > "$FIXTURE_ROOT/package.log"
check_package android15-6.6 https://example.invalid/update.json
printf '%s' prefixed > "$PACKAGE_ROOT/out/android14-6.1_pathmask.ko"
sh "$PACKAGE_ROOT/tools/package_ksu.sh" out/android14-6.1_pathmask.ko out/test.zip > "$FIXTURE_ROOT/package.log"
check_package prefixed https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/android14-6.1.json
mkdir -p "$PACKAGE_ROOT/kernel/out/androidbad-6.6"
printf '%s' invalid-kmi > "$PACKAGE_ROOT/kernel/out/androidbad-6.6/pathmask.ko"
sh "$PACKAGE_ROOT/tools/package_ksu.sh" kernel/out/androidbad-6.6/pathmask.ko out/test.zip > "$FIXTURE_ROOT/package.log"
check_package invalid-kmi ""
rm -rf -- "$PACKAGE_ROOT/kernel/out"
printf '%s' legacy > "$PACKAGE_ROOT/kernel/pathmask.ko"
sh "$PACKAGE_ROOT/tools/package_ksu.sh" "" out/test.zip > "$FIXTURE_ROOT/package.log"
check_package legacy ""
echo "PASS 15 shell packaging cases and bundled defaults"

version=$(sed -n 's/^version=//p' "$SOURCE_ROOT/ksu-module/module.prop" | tr -d '\r')
sh "$SOURCE_ROOT/tools/release_notes.sh" "$version" version > "$FIXTURE_ROOT/version-notes.md"
grep -q "^# PathMask $version$" "$FIXTURE_ROOT/version-notes.md"
grep -q '^## 简体中文$' "$FIXTURE_ROOT/version-notes.md"
grep -q '^## English$' "$FIXTURE_ROOT/version-notes.md"
[ "$(grep -c '^# PathMask ' "$FIXTURE_ROOT/version-notes.md")" -eq 1 ]
sh "$SOURCE_ROOT/tools/release_notes.sh" "$version" rolling > "$FIXTURE_ROOT/rolling-notes.md"
grep -q 'Rolling prerelease' "$FIXTURE_ROOT/rolling-notes.md"
grep -q '^## English$' "$FIXTURE_ROOT/rolling-notes.md"
if sh "$SOURCE_ROOT/tools/release_notes.sh" missing-version > "$FIXTURE_ROOT/missing-notes.md"; then
	echo "Release notes accepted a missing version" >&2
	exit 1
fi
echo "PASS version/rolling bilingual release notes and missing-version rejection"

# Real local Git repositories exercise pins without network access.
sdk_source="$FIXTURE_ROOT/sdk-source"
dep_source="$FIXTURE_ROOT/dep-source"
git -c init.defaultBranch=main init -q "$sdk_source"
mkdir -p "$sdk_source/scripts"
printf '%s\n' '#!/bin/sh' 'set -eu' \
	'[ -d deps/KallRecon ] && exit 0' \
	'git clone -q "$PATHMASK_TEST_DEP_SOURCE" deps/KallRecon' \
	'pin=$(awk '\''$1 == "KallRecon" { print $2 }'\'' deps.lst)' \
	'git -C deps/KallRecon checkout --detach -q "$pin"' > "$sdk_source/scripts/sdk"
git -C "$sdk_source" add scripts/sdk
git -C "$sdk_source" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm sdk
sdk_pin=$(git -C "$sdk_source" rev-parse HEAD)
git -c init.defaultBranch=main init -q "$dep_source"
printf '%s\n' pinned > "$dep_source/data"
git -C "$dep_source" add data
git -C "$dep_source" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm pinned
dep_pin=$(git -C "$dep_source" rev-parse HEAD)
printf '%s\n' newer > "$dep_source/data"
git -C "$dep_source" add data
git -C "$dep_source" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm newer
dep_new=$(git -C "$dep_source" rev-parse HEAD)
export PATHMASK_TEST_DEP_SOURCE="$dep_source"
new_case() {
	case_root="$FIXTURE_ROOT/$1/kernel"
	mkdir -p "$case_root/scripts"
	cp "$SOURCE_ROOT/kernel/scripts/fetch-deps.sh" "$case_root/scripts/"
	git clone -q "$sdk_source" "$case_root/.sdk"
	printf '%s\n' "$sdk_pin" > "$case_root/.sdk-version"
	printf 'KallRecon %s\n' "$dep_pin" > "$case_root/deps.lst"
}
expect_rejected() {
	if sh "$case_root/scripts/fetch-deps.sh" > "$FIXTURE_ROOT/rejection.log" 2>&1; then
		echo "Expected dependency rejection: $1" >&2
		exit 1
	fi
	grep -q "$1" "$FIXTURE_ROOT/rejection.log"
}
new_case fresh
sh "$case_root/scripts/fetch-deps.sh" > "$FIXTURE_ROOT/deps.log"
[ "$(git -C "$case_root/deps/KallRecon" rev-parse HEAD)" = "$dep_pin" ]
sh "$case_root/scripts/fetch-deps.sh" > "$FIXTURE_ROOT/deps.log"
printf '%s\n' local-change >> "$case_root/deps/KallRecon/data"
expect_rejected "has local changes"
grep -q local-change "$case_root/deps/KallRecon/data"
new_case mismatch
mkdir -p "$case_root/deps"
git clone -q "$dep_source" "$case_root/deps/KallRecon"
expect_rejected "expected $dep_pin"
[ "$(git -C "$case_root/deps/KallRecon" rev-parse HEAD)" = "$dep_new" ]
new_case dirty-sdk
printf '%s\n' '# local-change' >> "$case_root/.sdk/scripts/sdk"
expect_rejected ".sdk has local changes"
grep -q local-change "$case_root/.sdk/scripts/sdk"
new_case short-sdk-pin
printf '%s\n' 8392512 > "$case_root/.sdk-version"
expect_rejected "full 40-character"
new_case short-dep-pin
printf '%s\n' 'KallRecon 8392512' > "$case_root/deps.lst"
expect_rejected "full 40-character"
new_case nongit
mkdir -p "$case_root/deps/KallRecon"
printf '%s\n' preserved > "$case_root/deps/KallRecon/data"
expect_rejected "not a Git checkout"
grep -q preserved "$case_root/deps/KallRecon/data"
echo "PASS fresh/cached dependency pins and six preserved rejection cases"

# Mock only Docker/make: execute the wrapper's real fetch/clean/build sequence.
new_case build
cp "$SOURCE_ROOT/kernel/scripts/build-ddkk.sh" "$case_root/scripts/"
mock_bin="$FIXTURE_ROOT/mock-bin"
mkdir -p "$mock_bin"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$@" > "$PATHMASK_TEST_DOCKER_LOG"' \
	'while [ "$1" != sh ]; do shift; done' \
	'cd "$PATHMASK_TEST_KERNEL"' '"$@"' > "$mock_bin/docker"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$*" >> "$PATHMASK_TEST_MAKE_LOG"' \
	'if [ "$1" = clean ]; then [ -z "$PATHMASK_TEST_FAIL_CLEAN" ]; exit; fi' \
	'target=$(printf "%s\n" "$*" | sed -n "s/^VER=//p")' \
	'mkdir -p "out/$target"; printf "%s" fixture > "out/$target/pathmask.ko"' > "$mock_bin/make"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$@" > "$PATHMASK_TEST_FORMAT_LOG"' > "$mock_bin/clang-format"
chmod +x "$mock_bin/docker" "$mock_bin/make" "$mock_bin/clang-format"
export PATH="$mock_bin:$PATH"
export PATHMASK_TEST_KERNEL="$case_root"
export PATHMASK_TEST_DOCKER_LOG="$FIXTURE_ROOT/docker.log"
export PATHMASK_TEST_MAKE_LOG="$FIXTURE_ROOT/make.log"
export PATHMASK_TEST_FORMAT_LOG="$FIXTURE_ROOT/format.log"
export PATHMASK_TEST_FAIL_CLEAN=""
sh "$case_root/scripts/build-ddkk.sh" android15-6.6 > "$FIXTURE_ROOT/build.log"
grep -q 'ghcr.io/ylarod/ddk-min:android15-6.6-20260828' "$PATHMASK_TEST_DOCKER_LOG"
grep -q '^clean VER=android15-6.6$' "$PATHMASK_TEST_MAKE_LOG"
grep -q '^VER=android15-6.6$' "$PATHMASK_TEST_MAKE_LOG"
[ "$(git -C "$case_root/deps/KallRecon" rev-parse HEAD)" = "$dep_pin" ]
: > "$PATHMASK_TEST_MAKE_LOG"
export PATHMASK_TEST_FAIL_CLEAN=1
if sh "$case_root/scripts/build-ddkk.sh" android15-6.6 > "$FIXTURE_ROOT/build.log" 2>&1; then
	echo "Wrapper ignored clean failure" >&2
	exit 1
fi
! grep -q '^VER=' "$PATHMASK_TEST_MAKE_LOG"
echo "PASS local wrapper fetch order, target, image, and failure propagation"

format_root="$FIXTURE_ROOT/format/kernel"
mkdir -p "$format_root/src" "$format_root/.sdk/builtin" "$format_root/deps" "$format_root/out"
cp "$SOURCE_ROOT/kernel/Makefile" "$format_root/"
touch "$format_root/src/own.c" "$format_root/.sdk/builtin/vendor.c" "$format_root/deps/vendor.h" "$format_root/out/generated.c"
"$REAL_MAKE" -C "$format_root" format > "$FIXTURE_ROOT/format-make.log"
grep -q '^src/own.c$' "$PATHMASK_TEST_FORMAT_LOG"
! grep -Eq 'vendor|generated' "$PATHMASK_TEST_FORMAT_LOG"
echo "PASS format without dependencies and source-only scope"
