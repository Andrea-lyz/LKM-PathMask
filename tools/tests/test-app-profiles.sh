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

# Exercise the actual service routes with no device access and a fake insmod.
# Keep fixed kernel paths out of the test copy and verify the emitted arguments.
BOOT="$WORK/boot"
mkdir "$BOOT" "$BOOT/bin" "$BOOT/module"
: > "$BOOT/modules"
: > "$BOOT/module/pathmask.ko"
sed -e "s|^PERSIST_DIR=.*|PERSIST_DIR=\"$BOOT/config\"|" \
	-e "s|^LEGACY_PERSIST_DIR=.*|LEGACY_PERSIST_DIR=\"$BOOT/unused\"|" \
	-e "s|/proc/modules|$BOOT/modules|g" \
	"$ROOT/ksu-module/service.sh" > "$BOOT/module/service.sh"
cp "$ROOT/ksu-module/app-profiles.sh" "$BOOT/module/app-profiles.sh"
# The compiler above is covered end-to-end; don't touch real kernel parameters.
cat >> "$BOOT/module/app-profiles.sh" <<'SH'

pm_apply_app_profiles() { cp "$APP_PROFILE_RULES" "$TEST_BOOT/committed"; }
SH
cat > "$BOOT/bin/insmod" <<'SH'
#!/bin/sh
case "$1" in
	*/procguard.ko)
		printf '%s\n' 'procguard 4096 0 - Live' >> "$TEST_BOOT/modules"
		: > "$TEST_BOOT/companion-loaded" ;;
	*) printf '%s\n' "$@" > "$TEST_BOOT/insmod-args" ;;
esac
SH
cat > "$BOOT/bin/cmd" <<'SH'
#!/bin/sh
[ "$1 $2 $3" = 'package list packages' ] || exit 1
printf '%s\n' 'package:com.example.notes uid:10123'
SH
printf '%s\n' '#!/bin/sh' 'exit 0' > "$BOOT/bin/log"
chmod +x "$BOOT/bin/insmod" "$BOOT/bin/log" "$BOOT/bin/cmd"
export TEST_BOOT="$BOOT"
export PATH="$BOOT/bin:$PATH"
mkdir "$BOOT/config"
SHARED="$BOOT/shared"
APP_PATH="$BOOT/own"
: > "$SHARED"
: > "$APP_PATH"
printf '%s\n' "$SHARED" > "$BOOT/config/target_path.conf"
printf '%s\n' deny > "$BOOT/config/scope_mode.conf"
printf '%s\n' 10199 > "$BOOT/config/deny_uids.conf"
printf '%s\n' 10211 > "$BOOT/config/allow_uids.conf"
printf '%s\n' 'app 0 com.example.notes 1 0' "path $APP_PATH" > "$BOOT/config/app_profiles.conf"

boot_rules() {
	rm -f "$BOOT/insmod-args" "$BOOT/committed"
	PATHMASK_INITIAL_DELAY_SECONDS=0 PATHMASK_WAIT_SECONDS=0 PATHMASK_RULE_MODE_REQUEST="$1" \
		sh "$BOOT/module/service.sh"
}

boot_rules ''
grep -Fxq "target_paths=$SHARED" "$BOOT/insmod-args"
grep -Fxq 'deny_uids=10199' "$BOOT/insmod-args"
grep -Fxq "10123 0 $APP_PATH" "$BOOT/committed"
[ ! -e "$BOOT/config/rule_mode.conf" ]
printf '  ok an upgrade without an applied mode keeps legacy behavior\n'

boot_rules deny > "$BOOT/output"
grep -Fxq 'target_paths=' "$BOOT/insmod-args"
grep -Fxq 'deny_uids=' "$BOOT/insmod-args"
grep -Fxq 'profile_mode=1' "$BOOT/insmod-args"
grep -Fxq "10123 0 $APP_PATH" "$BOOT/committed"
grep -Fxq 'PATHMASK_RULE_MODE_OK deny' "$BOOT/output"
printf '  ok selected blacklist uses only per-app rules\n'

# Dormant, malformed profiles cannot prevent a shared-path mode from starting.
printf '%s\n' 'invalid profile' > "$BOOT/config/app_profiles.conf"
boot_rules global > "$BOOT/output"
grep -Fxq "target_paths=$SHARED" "$BOOT/insmod-args"
grep -Fxq 'scope_mode=global' "$BOOT/insmod-args"
grep -Fxq 'profile_mode=0' "$BOOT/insmod-args"
[ ! -e "$BOOT/committed" ]
grep -Fxq 'PATHMASK_RULE_MODE_OK global' "$BOOT/output"
printf '%s\n' allow > "$BOOT/config/rule_mode.conf"
boot_rules ''
grep -Fxq "target_paths=$SHARED" "$BOOT/insmod-args"
grep -Fxq 'scope_mode=allow' "$BOOT/insmod-args"
grep -Fxq 'deny_uids=0,1000,2000,10211' "$BOOT/insmod-args"
[ ! -e "$BOOT/committed" ]
printf '  ok global and saved whitelist use shared paths and not app profiles\n'

: > "$BOOT/config/allow_uids.conf"
: > "$BOOT/config/allow_system_uids.conf"
if boot_rules allow > "$BOOT/output" 2>&1; then exit 1; fi
[ ! -e "$BOOT/insmod-args" ]
if grep -q PATHMASK_RULE_MODE_OK "$BOOT/output"; then exit 1; fi
printf '  ok unresolved whitelist is not falsely acknowledged\n'

: > "$BOOT/config/app_profiles.conf"
boot_rules deny > "$BOOT/output"
[ ! -e "$BOOT/insmod-args" ]
grep -Fxq 'PATHMASK_RULE_MODE_OK deny' "$BOOT/output"
printf '  ok empty blacklist starts no module, without enabling shared paths\n'

printf '%s\n' deny > "$BOOT/config/rule_mode.conf"
printf '%s\n' 'app 0 com.example.notes 1 0' "path $APP_PATH" > "$BOOT/config/app_profiles.conf"
PATHMASK_SCENE_WATCH_RELOAD=1 PATHMASK_PROFILE_REQUEST=stale boot_rules global > "$BOOT/output"
grep -Fxq 'target_paths=' "$BOOT/insmod-args"
grep -Fxq 'scope_mode=deny' "$BOOT/insmod-args"
grep -Fxq "10123 0 $APP_PATH" "$BOOT/committed"
if grep -q 'PATHMASK_RULE_MODE_OK' "$BOOT/output"; then exit 1; fi
printf '  ok background service strips inherited trial and profile requests\n'

: > "$BOOT/module/procguard.ko"
printf '%s\n' 1 > "$BOOT/config/procguard.conf"
: > "$BOOT/config/app_profiles.conf"
PATHMASK_REQUIRE_RELOAD_RECEIPT=1 boot_rules '' > "$BOOT/output"
[ ! -f "$BOOT/insmod-args" ] && [ -f "$BOOT/companion-loaded" ]
grep -Fxq 'PATHMASK_RELOAD_OK empty-blacklist' "$BOOT/output"
printf '  ok empty blacklist preserves companion activation and returns the empty receipt\n'

printf '%s\n' global > "$BOOT/config/rule_mode.conf"
printf '%s\n' "$BOOT/missing" > "$BOOT/config/target_path.conf"
if PATHMASK_REQUIRE_RELOAD_RECEIPT=1 boot_rules '' > "$BOOT/output" 2>&1; then exit 1; fi
[ ! -e "$BOOT/insmod-args" ]
if grep -q 'PATHMASK_RELOAD_OK' "$BOOT/output"; then exit 1; fi
printf '  ok shared-mode skip returns no successful reload receipt\n'

# Scene's late mount is pending and the detached watcher owns the load.
printf '%s\n' '#!/bin/sh' ': > "$TEST_BOOT/watcher-started"' > "$BOOT/module/scene-debugfs-watch.sh"
printf '%s\n' 1 > "$BOOT/config/auto_scene_debugfs.conf"
: > "$BOOT/config/target_path.conf"
PATHMASK_REQUIRE_RELOAD_RECEIPT=1 boot_rules global > "$BOOT/output"
[ ! -e "$BOOT/insmod-args" ]
grep -Fxq 'PATHMASK_RELOAD_OK scene-pending' "$BOOT/output"
grep -Fxq 'PATHMASK_RULE_MODE_OK global' "$BOOT/output"
for _ in 1 2 3 4 5; do [ -e "$BOOT/watcher-started" ] && break; sleep 1; done
[ -e "$BOOT/watcher-started" ]
printf '%s\n' 0 > "$BOOT/config/auto_scene_debugfs.conf"
printf '%s\n' "$BOOT/missing" > "$BOOT/config/target_path.conf"
printf '  ok pending Scene mount is acknowledged once the watcher owns it\n'

# Keep every operation on synthetic local inputs; no real watchers or modules.
cat > "$BOOT/bin/rmmod" <<'SH'
#!/bin/sh
: > "$TEST_BOOT/unload-attempted"
exit 1
SH
chmod +x "$BOOT/bin/rmmod"
sed -e "s|^PERSIST_DIR=.*|PERSIST_DIR=\"$BOOT/config\"|" -e "s|/proc/modules|$BOOT/modules|g" \
	"$ROOT/ksu-module/scene-debugfs-watch.sh" | awk '
	/^case "\$WATCH_SECONDS" in/ {
		print "scene_package_status() { printf installed; }"
		print "find_scene_debugfs() { return 0; }"
		print "running_targets_include_found() { return 1; }"
	}
	{ print }
' > "$BOOT/module/scene-debugfs-watch.sh"
printf '%s\n' 'pathmask 4096 0 - Live' >> "$BOOT/modules"
printf '%s\n' allow > "$BOOT/config/rule_mode.conf"
printf '%s\n' 1 > "$BOOT/config/auto_scene_debugfs.conf"
LOCK="$BOOT/config/.profile-apply-lock"
mkdir "$LOCK"
printf '%s\n' "$$" > "$LOCK/pid"
PATHMASK_RULE_MODE_REQUEST=allow PATHMASK_SCENE_WATCH_SECONDS=6 sh "$BOOT/module/scene-debugfs-watch.sh" &
watcher=$!
sleep 3
[ ! -e "$BOOT/unload-attempted" ]
printf '%s\n' deny > "$BOOT/config/rule_mode.conf"
rm -f "$LOCK/pid"
rmdir "$LOCK"
wait "$watcher"
[ ! -e "$BOOT/unload-attempted" ]
printf '  ok watcher waits for the transaction and stops after blacklist commit\n'

# A lock whose owner died must not block the watcher for its whole window.
cat > "$BOOT/bin/rmmod" <<'SH'
#!/bin/sh
: > "$TEST_BOOT/unload-attempted"
exit 0
SH
printf '%s\n' "$SHARED" > "$BOOT/config/target_path.conf"
printf '%s\n' global > "$BOOT/config/rule_mode.conf"
sh -c 'exit 0' &
dead=$!
wait "$dead"
mkdir "$LOCK"
printf '%s\n' "$dead" > "$LOCK/pid"
PATHMASK_SCENE_WATCH_SECONDS=20 sh "$BOOT/module/scene-debugfs-watch.sh"
[ -e "$BOOT/unload-attempted" ]
[ ! -e "$LOCK" ]
printf '  ok watcher reclaims a reload lock left by a dead owner\n'

# A boot run cannot overlap a WebUI transaction; a surviving lock is stale.
mkdir "$LOCK"
printf '%s\n' "$$" > "$LOCK/pid"
boot_rules '' > /dev/null 2>&1 || true
[ ! -e "$LOCK" ]
mkdir "$LOCK"
printf '%s\n' "$$" > "$LOCK/pid"
PATHMASK_REQUIRE_RELOAD_RECEIPT=1 boot_rules '' > /dev/null 2>&1 || true
[ -e "$LOCK/pid" ]
rm -f "$LOCK/pid"
rmdir "$LOCK"
printf '  ok boot clears a stale reload lock but WebUI reloads keep it\n'

# Rule mode migration. apply_mode mirrors the WebUI transaction in app.js
# applyRuleMode() with the real service entry points: prepare candidates,
# check, staged trial, receipts, replace, record.
printf 'rule mode migration\n'
: > "$BOOT/modules"
rm -f "$BOOT/module/procguard.ko" "$BOOT/config/rule_mode.conf" "$BOOT/config"/.migrated-*
printf '%s\n' 0 > "$BOOT/config/procguard.conf"
printf '%s\n' 0 > "$BOOT/config/auto_scene_debugfs.conf"
cat > "$BOOT/bin/insmod" <<'SH'
#!/bin/sh
[ -z "${TEST_INSMOD_FAIL:-}" ] || exit 1
printf '%s\n' "$@" > "$TEST_BOOT/insmod-args"
SH
cat > "$BOOT/bin/cmd" <<'SH'
#!/bin/sh
[ "$1 $2 $3 $4" = 'package list packages --user' ] || exit 1
case "$5" in
	0) printf '%s\n' 'package:com.example.notes uid:10123' \
		'package:com.example.reader uid:10146' \
		'package:com.example.shared uid:10147' \
		'package:com.example.also_shared uid:10147' ;;
	10) printf '%s\n' 'package:com.example.work uid:1010123' ;;
	*) exit 1 ;;
esac
SH
chmod +x "$BOOT/bin/insmod" "$BOOT/bin/cmd"
CONF="$BOOT/config"
LEG_A="$BOOT/legacy-a"
LEG_B="$BOOT/legacy b"
: > "$LEG_A"
: > "$LEG_B"
printf '%s\n' "$LEG_A" "any:grp:$LEG_B" 'dir:/dev/???/scene_mode_category' \
	"$BOOT/legacy-missing" '/bad,comma' '# note' "$LEG_A" > "$CONF/target_path.conf"
printf '%s\n' com.example.notes com.example.absent com.example.shared > "$CONF/deny_packages.conf"
printf '%s\n' '10146, 1010123' 10147 99999 > "$CONF/deny_uids.conf"
printf '%s\n' 0 > "$CONF/hide_dirents.conf"
printf '%s\n' 10211 > "$CONF/allow_uids.conf"
printf '%s\n' 'app 0 com.example.notes 1 1' "path $APP_PATH" > "$CONF/app_profiles.conf"

apply_mode() {
	MODE_WORK=$(mktemp -d "$CONF/.profile-write.XXXXXX")
	MODE_RC=0
	apply_mode_steps "$1" || MODE_RC=$?
	rm -rf "$MODE_WORK"
	return "$MODE_RC"
}

apply_mode_steps() {
	sh "$BOOT/module/service.sh" --migrate-rule-mode "$1" "$MODE_WORK" > "$BOOT/migration" || return 34
	MODE_REQUEST=''
	MODE_STAGED=''
	MODE_LIVE=''
	MODE_ACTIVE=''
	if [ "$1" = deny ]; then
		MODE_STAGED="$MODE_WORK/candidate"
		MODE_LIVE="$CONF/app_profiles.conf"
		sh "$BOOT/module/service.sh" --check-app-profiles "$MODE_STAGED" || return 31
		MODE_ACTIVE=$(sed -n 's/^PATHMASK_MIGRATION active //p' "$BOOT/migration")
		MODE_REQUEST=4242
	elif [ -f "$MODE_WORK/targets" ]; then
		MODE_STAGED="$MODE_WORK/targets"
		MODE_LIVE="$CONF/target_path.conf"
	fi
	rm -f "$BOOT/insmod-args" "$BOOT/committed"
	(
		export PATHMASK_RULE_MODE_REQUEST="$1" PATHMASK_REQUIRE_RELOAD_RECEIPT=1
		export PATHMASK_INITIAL_DELAY_SECONDS=0 PATHMASK_WAIT_SECONDS=0
		if [ -n "$MODE_REQUEST" ]; then
			export PATHMASK_PROFILE_REQUEST="$MODE_REQUEST" PATHMASK_APP_PROFILES_STAGE="$MODE_STAGED"
		elif [ -n "$MODE_STAGED" ]; then
			export PATHMASK_TARGET_PATHS_STAGE="$MODE_STAGED"
		fi
		sh "$BOOT/module/service.sh"
	) > "$BOOT/output" 2>&1 || return 32
	grep -Fxq "PATHMASK_RULE_MODE_OK $1" "$BOOT/output" || return 32
	if [ -n "$MODE_REQUEST" ]; then
		grep -Fxq "PATHMASK_APP_PROFILES_OK $MODE_REQUEST $MODE_ACTIVE" "$BOOT/output" || return 32
	fi
	if [ -n "$MODE_STAGED" ]; then
		mv -f "$MODE_STAGED" "$MODE_LIVE" || return 32
	fi
	printf '%s\n' "$1" > "$CONF/rule_mode.conf"
	sh "$BOOT/module/service.sh" --record-rule-mode-migration "$1" "$MODE_WORK"
}

# Count how often a path occurs in one profile block.
profile_path_count() {
	awk -v key="app $1 $2 " -v want="path $3" '
		/^app / { inside = index($0, key) == 1; next }
		inside && $0 == want { n++ }
		END { print n + 0 }
	' "$CONF/app_profiles.conf"
}

cp "$CONF/app_profiles.conf" "$BOOT/profiles-before"
cp "$CONF/target_path.conf" "$BOOT/targets-before"
if TEST_INSMOD_FAIL=1 apply_mode deny; then exit 1; fi
[ ! -e "$CONF/rule_mode.conf" ]
cmp -s "$CONF/app_profiles.conf" "$BOOT/profiles-before"
cmp -s "$CONF/target_path.conf" "$BOOT/targets-before"
if ls "$CONF"/.migrated-* > /dev/null 2>&1; then exit 1; fi
if ls -d "$CONF"/.profile-write.* > /dev/null 2>&1; then exit 1; fi
printf '  ok a failed blacklist trial leaves the mode, profiles and marks unchanged\n'

apply_mode deny
[ "$(cat "$CONF/rule_mode.conf")" = deny ]
grep -Fxq 'app 0 com.example.notes 1 1' "$CONF/app_profiles.conf"
grep -Fxq 'app 0 com.example.reader 1 0' "$CONF/app_profiles.conf"
grep -Fxq 'app 10 com.example.work 1 0' "$CONF/app_profiles.conf"
if grep -q 'com.example.shared\|com.example.absent' "$CONF/app_profiles.conf"; then exit 1; fi
for key in '0 com.example.notes' '0 com.example.reader' '10 com.example.work'; do
	# shellcheck disable=SC2086
	[ "$(profile_path_count $key "$LEG_A")" = 1 ]
	# shellcheck disable=SC2086
	[ "$(profile_path_count $key "$LEG_B")" = 1 ]
done
[ "$(profile_path_count 0 com.example.notes "$APP_PATH")" = 1 ]
[ "$(profile_path_count 0 com.example.reader "$APP_PATH")" = 0 ]
grep -Fxq "10146 0 $LEG_B" "$BOOT/committed"
grep -Fxq "1010123 0 $LEG_A" "$BOOT/committed"
grep -Fxq "10123 1 $APP_PATH" "$BOOT/committed"
grep -Fxq 'PATHMASK_APP_PROFILES_OK 4242 7' "$BOOT/output"
grep -Fxq 'target_paths=' "$BOOT/insmod-args"
grep -Fxq 'PATHMASK_MIGRATION active 7' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION app-merged 0 com.example.notes 2' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION app-new 10 com.example.work 2' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION uid-app 10146 com.example.reader' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION skip-package com.example.absent' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION skip-package com.example.shared' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION skip-uid 10147' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION skip-uid 99999' "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION skip-dynamic dir:/dev/???/scene_mode_category' "$BOOT/migration"
grep -Fxq "PATHMASK_MIGRATION skip-missing $BOOT/legacy-missing" "$BOOT/migration"
grep -Fxq 'PATHMASK_MIGRATION skip-invalid /bad,comma' "$BOOT/migration"
cmp -s "$CONF/target_path.conf" "$BOOT/targets-before"
[ -s "$CONF/deny_packages.conf" ] && [ -s "$CONF/deny_uids.conf" ]
printf '  ok legacy blacklist apps become enabled profiles with every literal shared path\n'

cp "$CONF/app_profiles.conf" "$BOOT/profiles-migrated"
apply_mode deny
cmp -s "$CONF/app_profiles.conf" "$BOOT/profiles-migrated"
grep -Fxq 'PATHMASK_MIGRATION unchanged' "$BOOT/migration"
# A path removed after the migration is not revived by switching again.
grep -vFx "path $LEG_B" "$BOOT/profiles-migrated" > "$CONF/app_profiles.conf"
cp "$CONF/app_profiles.conf" "$BOOT/profiles-edited"
apply_mode deny
cmp -s "$CONF/app_profiles.conf" "$BOOT/profiles-edited"
# Changed legacy rules merge again without duplicating any path.
printf '%s\n' "$LEG_A" > "$CONF/target_path.conf"
printf '%s\n' com.example.notes > "$CONF/deny_packages.conf"
: > "$CONF/deny_uids.conf"
apply_mode deny
[ "$(profile_path_count 0 com.example.notes "$LEG_A")" = 1 ]
[ "$(profile_path_count 0 com.example.reader "$LEG_A")" = 1 ]
[ "$(profile_path_count 0 com.example.notes "$LEG_B")" = 0 ]
grep -Fxq 'PATHMASK_MIGRATION app-merged 0 com.example.notes 0' "$BOOT/migration"
printf '  ok re-applying merges into existing profiles without duplicates or revivals\n'

# Shared-path modes: enabled per-app paths join the shared list once.
GLOB_PATH="$BOOT/glob[1]"
: > "$GLOB_PATH"
printf '%s\n' 'app 0 com.example.notes 1 1' "path $APP_PATH" "path $LEG_A" \
	'app 0 com.example.reader 1 0' "path $LEG_A" "path $GLOB_PATH" \
	'app 0 com.example.also_shared 0 0' "path $BOOT/disabled-only" > "$BOOT/profiles-shared"
cp "$BOOT/profiles-shared" "$CONF/app_profiles.conf"
printf '%s\n' "$LEG_A" "any:grp:$LEG_B" > "$CONF/target_path.conf"
cp "$CONF/target_path.conf" "$BOOT/targets-before"
if TEST_INSMOD_FAIL=1 apply_mode global; then exit 1; fi
[ "$(cat "$CONF/rule_mode.conf")" = deny ]
cmp -s "$CONF/target_path.conf" "$BOOT/targets-before"
apply_mode global
[ "$(cat "$CONF/rule_mode.conf")" = global ]
[ "$(head -n 2 "$CONF/target_path.conf")" = "$(cat "$BOOT/targets-before")" ]
[ "$(grep -cFx "$APP_PATH" "$CONF/target_path.conf")" = 1 ]
[ "$(grep -cFx "$LEG_A" "$CONF/target_path.conf")" = 1 ]
if grep -Fq "$BOOT/disabled-only" "$CONF/target_path.conf"; then exit 1; fi
if grep -Fq "$GLOB_PATH" "$CONF/target_path.conf"; then exit 1; fi
grep -Fxq "PATHMASK_MIGRATION skip-pattern $GLOB_PATH" "$BOOT/migration"
grep -Fxq "PATHMASK_MIGRATION shared-path $APP_PATH" "$BOOT/migration"
case "$(grep '^target_paths=' "$BOOT/insmod-args")" in
	*"$APP_PATH"*) ;;
	*) exit 1 ;;
esac
cmp -s "$CONF/app_profiles.conf" "$BOOT/profiles-shared"
cp "$CONF/target_path.conf" "$BOOT/targets-carried"
apply_mode allow
cmp -s "$CONF/target_path.conf" "$BOOT/targets-carried"
grep -Fxq 'PATHMASK_MIGRATION unchanged' "$BOOT/migration"
grep -Fxq 'scope_mode=allow' "$BOOT/insmod-args"
printf '  ok global/allow carry enabled per-app paths into the shared list once\n'

# A legacy path removed from the shared list is not carried back from the
# profiles it was migrated into, even after those profiles change.
grep -vFx "$LEG_A" "$CONF/target_path.conf" > "$BOOT/targets-trimmed"
cp "$BOOT/targets-trimmed" "$CONF/target_path.conf"
printf '%s\n' 'app 0 com.example.work 0 0' 'path /data/local/tmp/off' >> "$CONF/app_profiles.conf"
cp "$CONF/app_profiles.conf" "$BOOT/profiles-shared"
apply_mode global
cmp -s "$CONF/target_path.conf" "$BOOT/targets-trimmed"
# A carried path is not broadcast to every blacklist app, while the legacy
# rules edited meanwhile still merge.
printf '%s\n' com.example.notes com.example.reader > "$CONF/deny_packages.conf"
apply_mode deny
[ "$(profile_path_count 0 com.example.reader "$APP_PATH")" = 0 ]
[ "$(profile_path_count 0 com.example.notes "$APP_PATH")" = 1 ]
[ "$(profile_path_count 0 com.example.reader "$LEG_B")" = 1 ]
[ "$(profile_path_count 0 com.example.notes "$LEG_B")" = 1 ]
[ "$(profile_path_count 0 com.example.reader "$LEG_A")" = 1 ]
grep -Fxq 'app 0 com.example.also_shared 0 0' "$CONF/app_profiles.conf"
grep -Fxq 'app 0 com.example.work 0 0' "$CONF/app_profiles.conf"
printf '  ok migrated paths never travel back in the opposite direction\n'

# Nothing to migrate and no profiles: the trial confirms an empty table.
rm -f "$CONF"/.migrated-* "$CONF/app_profiles.conf"
: > "$CONF/deny_packages.conf"
: > "$CONF/deny_uids.conf"
printf '%s\n' global > "$CONF/rule_mode.conf"
apply_mode deny
grep -Fxq 'PATHMASK_APP_PROFILES_OK 4242 0' "$BOOT/output"
grep -Fxq 'PATHMASK_RELOAD_OK empty-blacklist' "$BOOT/output"
[ ! -s "$CONF/app_profiles.conf" ]
printf '  ok an empty legacy blacklist switches to an empty, acknowledged table\n'
