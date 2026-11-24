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
mkdir "$BOOT/config/.profile-apply-lock"
PATHMASK_RULE_MODE_REQUEST=allow PATHMASK_SCENE_WATCH_SECONDS=6 sh "$BOOT/module/scene-debugfs-watch.sh" &
watcher=$!
sleep 1
[ ! -e "$BOOT/unload-attempted" ]
printf '%s\n' deny > "$BOOT/config/rule_mode.conf"
rmdir "$BOOT/config/.profile-apply-lock"
wait "$watcher"
[ ! -e "$BOOT/unload-attempted" ]
printf '  ok watcher waits for the transaction and stops after blacklist commit\n'
