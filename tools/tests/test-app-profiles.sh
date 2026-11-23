#!/bin/sh
# Exercises the per-app rule compiler in ksu-module/service.sh without a
# device: the functions are extracted from the real script (so the test
# cannot drift into testing a copy) and run against stubbed platform calls.
#
# Run: sh tools/tests/test-app-profiles.sh
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SERVICE="$ROOT/ksu-module/service.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FAIL=0
fail() { printf 'FAIL %s\n' "$*"; FAIL=$((FAIL + 1)); }
pass() { printf '  ok %s\n' "$*"; }

# Pull the per-app block out of the real script.
awk '/^# Per-app rules$/,/^}$/' "$SERVICE" > /dev/null 2>&1 || true
sed -n '/^# ---------------------------------------------------------------------------$/,$p' "$SERVICE" \
	| sed -n '1,/^}$/p' > /dev/null 2>&1 || true

BLOCK="$WORK/block.sh"
awk '
	/^has_app_profiles\(\) \{/ { on = 1 }
	on { print }
	on && /^}$/ { depth++ }
' "$SERVICE" > /dev/null 2>&1 || true

# Extract from has_app_profiles() through the end of apply_app_profiles().
awk '
	/^has_app_profiles\(\) \{/ { keep = 1 }
	keep { print }
	keep && /^apply_app_profiles\(\) \{/ { in_apply = 1 }
	in_apply && /^}$/ { exit }
' "$SERVICE" > "$BLOCK"

if ! grep -q '^apply_app_profiles() {' "$BLOCK"; then
	printf 'could not extract the per-app block\n'
	exit 1
fi

PERSIST_DIR="$WORK"
APP_PROFILES_CONFIG="$WORK/app_profiles.conf"
APP_PROFILE_RULES_TMP="$WORK/app_profiles.rules"
APP_PROFILE_PARAM="$WORK/app_profiles.param"
APP_PROFILES_ACTIVE=0

log_i() { :; }
log_e() { printf 'log_e %s\n' "$*" >&2; }

# Source the real functions first: the block defines its own
# package_to_uid_for_user(), so the platform stubs have to come after it or
# they would be shadowed instead of shadowing.
. "$BLOCK"

package_to_uid() { :; }
package_to_uid_for_user() {
	case "$1" in
		com.example.notes) printf '10123\n' ;;
		com.example.reader) printf '10146\n' ;;
		com.example.work) printf '1010123\n' ;;
		*) printf '' ;;
	esac
}
if ! command -v build_app_profile_rules > /dev/null 2>&1; then
	printf 'extracted block does not define build_app_profile_rules\n'
	exit 1
fi

run_compile() {
	: > "$APP_PROFILES_CONFIG"
	cat >> "$APP_PROFILES_CONFIG"
	APP_PROFILES_ACTIVE=0
	build_app_profile_rules
}

printf 'per-app rule compiler\n'

run_compile <<'CONF'
# comment line
app 0 com.example.notes 1 1
path /data/local/tmp/a
path /data/local/tmp/a
path /storage/emulated/0/b

app 0 com.example.reader 1 0
path /data/local/tmp/c

app 0 com.example.disabled 0 1
path /data/local/tmp/never

app 0 com.unknown.pkg 1 0
path /data/local/tmp/skip
CONF

if [ "$APP_PROFILES_ACTIVE" = "1" ]; then pass "activates when rules compile"; else fail "APP_PROFILES_ACTIVE not set"; fi

if grep -qx '@10123:d:/data/local/tmp/a,/storage/emulated/0/b' "$APP_PROFILE_RULES_TMP"; then
	pass "enabled app with dirent filtering, duplicate path dropped"
else
	fail "unexpected rule for notes: $(cat "$APP_PROFILE_RULES_TMP")"
fi

if grep -qx '@10146:-:/data/local/tmp/c' "$APP_PROFILE_RULES_TMP"; then
	pass "second app keeps its own flags"
else
	fail "reader rule missing: $(cat "$APP_PROFILE_RULES_TMP")"
fi

if grep -q 'never\|skip' "$APP_PROFILE_RULES_TMP"; then
	fail "disabled or unresolvable apps must not emit rules"
else
	pass "disabled and unresolvable apps skipped"
fi

# Work-profile users must resolve through the explicit user argument.
run_compile <<'CONF'
app 10 com.example.work 1 0
path /data/local/tmp/work
CONF
if grep -qx '@1010123:-:/data/local/tmp/work' "$APP_PROFILE_RULES_TMP"; then
	pass "work-profile UID preserved"
else
	fail "work profile rule wrong: $(cat "$APP_PROFILE_RULES_TMP")"
fi

# A long path list must be split so every sysfs write stays inside one page.
run_compile <<'CONF'
app 0 com.example.notes 1 1
CONF
i=0
while [ "$i" -lt 60 ]; do
	printf 'path /data/local/tmp/some/long/path/segment-%02d/with/a/long/name\n' "$i" >> "$APP_PROFILES_CONFIG"
	i=$((i + 1))
done
APP_PROFILES_ACTIVE=0
build_app_profile_rules
if [ "$(grep -c . "$APP_PROFILE_RULES_TMP")" -gt 1 ]; then
	pass "long path list split across writes"
else
	fail "long list was not split"
fi
if [ "$(awk 'length > 3000 { print }' "$APP_PROFILE_RULES_TMP" | wc -l)" -eq 0 ]; then
	pass "every write stays under the page budget"
else
	fail "a write exceeds the page budget"
fi

# No profile file at all means the legacy path is untouched.
rm -f "$APP_PROFILES_CONFIG"
APP_PROFILES_ACTIVE=1
build_app_profile_rules
if [ "$APP_PROFILES_ACTIVE" = "0" ]; then pass "absent file yields no rules"; else fail "absent file still active"; fi

if has_app_profiles; then fail "has_app_profiles true without a file"; else pass "has_app_profiles false without a file"; fi

if [ "$FAIL" -eq 0 ]; then
	printf '\nall per-app compiler checks passed\n'
	exit 0
fi
printf '\n%s check(s) failed\n' "$FAIL"
exit 1
