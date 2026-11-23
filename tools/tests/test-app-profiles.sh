#!/bin/sh
# Run the production validator against test-only package and kernel fixtures.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
. "$ROOT/ksu-module/app-profiles.sh"

pm_inventory_for_user() {
	case "$1" in
		0) printf '%s\n' \
			'package:com.example.notes uid:10123' \
			'package:com.example.reader uid:10146' \
			'package:com.example.shared uid:10147' \
			'package:com.example.also_shared uid:10147' \
			'package:com.example.unowned uid:99123' \
			'package:com.example.admin uid:1000' \
			'package:com.example.wronguser uid:1010123' ;;
		10) printf '%s\n' 'package:com.example.work uid:1010123' ;;
		*) return 1 ;;
	esac
}

compile() {
	CASE=$(mktemp -d "$WORK/case.XXXXXX")
	cat > "$CASE/conf"
	pm_compile_app_profiles "$CASE/conf" "$CASE" 0
}

reject() {
	if compile; then
		printf 'FAIL: accepted %s\n' "$1" >&2
		exit 1
	fi
	printf '  ok rejected %s\n' "$1"
}

printf 'per-app rule validation\n'
compile <<'CONF'
# profile fixture
app 0 com.example.notes 1 1
path /data/local/tmp/example with spaces
app 0 com.example.reader 1 0
path /data/local/tmp/reader
app 10 com.example.work 1 0
path /data/local/tmp/work
app 0 com.example.disabled 0 1
path /data/local/tmp/disabled
CONF
[ "$APP_PROFILE_COUNT" = 3 ]
grep -Fxq '10123 1 /data/local/tmp/example with spaces' "$APP_PROFILE_RULES"
grep -Fxq '10146 0 /data/local/tmp/reader' "$APP_PROFILE_RULES"
grep -Fxq '1010123 0 /data/local/tmp/work' "$APP_PROFILE_RULES"
printf '  ok exact user/flag/path and inactive profile coverage\n'

compile <<'CONF'
app 0 com.example.notes 1 1
app 0 com.example.off 0 0
path /data/local/tmp/off
CONF
[ "$APP_PROFILE_COUNT" = 0 ]
[ ! -s "$APP_PROFILE_RULES" ]
printf '  ok enabled empty and disabled nonempty profiles cannot combine\n'

for pname in shared unowned admin wronguser note; do
	reject "invalid ownership for $pname" <<CONF
app 0 com.example.$pname 1 0
path /data/local/tmp/fixture
CONF
done
reject 'standalone path' <<'CONF'
path /data/local/tmp/fixture
CONF
reject 'comma in a path' <<'CONF'
app 0 com.example.notes 1 0
path /data/local/tmp/sample,name
CONF
reject 'semicolon in a path' <<'CONF'
app 0 com.example.notes 1 0
path /data/local/tmp/sample;name
CONF
reject 'duplicate path' <<'CONF'
app 0 com.example.notes 1 0
path /data/local/tmp/sample
path /data/local/tmp/sample
CONF
reject 'duplicate profile' <<'CONF'
app 0 com.example.notes 1 0
app 0 com.example.notes 0 1
CONF
{
	printf 'app 0 com.example.notes 1 0\npath /'
	awk 'BEGIN { for (i=0; i<255; i++) printf "a"; printf "\n" }'
} | reject 'path beyond the kernel byte limit'
{
	printf 'app 0 com.example.notes 1 0\npath /sample\000name\n'
} | reject 'NUL in configuration'

if pm_legacy_scope_resolved allow '' || pm_legacy_scope_resolved deny ''; then
	printf 'FAIL: legacy scope without UIDs would load\n' >&2; exit 1
fi
pm_legacy_scope_resolved allow 10123
pm_legacy_scope_resolved global ''
printf '  ok empty scoped UID sets block legacy paths\n'

compile <<'CONF'
app 0 com.example.notes 1 0
path /data/local/tmp/fixture
CONF
APP_PROFILE_PARAM="$WORK/kernel-receipt"
: > "$APP_PROFILE_PARAM"
TRACE="$WORK/commands"
MODE=reject
pm_write_app_profile() {
	printf '%s\n' "${1}" >> "$TRACE"
	case "${1}" in
		'add '*) [ "$MODE" != reject ] || return 1 ;;
		'commit '*) if [ "$MODE" = confirm ]; then printf '123 1\n' > "$APP_PROFILE_PARAM"; fi ;;
	esac
}
if pm_apply_app_profiles 123; then exit 1; fi
grep -Fxq 'abort 123' "$TRACE"
if grep -Fxq 'commit 123' "$TRACE"; then exit 1; fi
printf '  ok failed add aborts before commit\n'
MODE=stale
printf '122 1\n' > "$APP_PROFILE_PARAM"
if pm_apply_app_profiles 123; then exit 1; fi
MODE=confirm
pm_apply_app_profiles 123
printf '  ok acknowledgment must match generation and path count\n'
