#!/system/bin/sh

MODDIR=${0%/*}
MODULE_NAME=pathmask
LOG_TAG=pathmask
PERSIST_DIR=/data/adb/pathmask
AUTO_CONFIG="$PERSIST_DIR/auto_scene_debugfs.conf"
RULE_MODE_CONFIG="$PERSIST_DIR/rule_mode.conf"
RELOAD_LOCK_DIR="$PERSIST_DIR/.profile-apply-lock"
RELOAD_LOCK_HELD=0
STATE_PATH="$PERSIST_DIR/scene_debugfs_state"
PATHS_PATH="$PERSIST_DIR/scene_debugfs_paths"
BOOT_STATE_PATH="$PERSIST_DIR/boot_state"
LOCK_DIR="$PERSIST_DIR/scene_debugfs_watch.lock"
STOP_PATH="$PERSIST_DIR/scene_debugfs_watch.stop"
SCENE_PACKAGE=com.omarea.vtools
WATCH_SECONDS=${PATHMASK_SCENE_WATCH_SECONDS:-600}
WATCH_APPLIED=${PATHMASK_SCENE_APPLIED:-1}
POLL_SECONDS=2

log_i() {
	log -p i -t "$LOG_TAG" "$*" 2>/dev/null || true
}

config_enabled() {
	VALUE="$(head -n 1 "$AUTO_CONFIG" 2>/dev/null | tr -d '\r ' || true)"
	case "$VALUE" in
		1|true|True|yes|Yes|on|On) return 0 ;;
	esac
	return 1
}

scene_package_status() {
	if [ -r /data/system/packages.list ]; then
		if grep -q "^$SCENE_PACKAGE " /data/system/packages.list 2>/dev/null; then
			printf 'installed'
		else
			printf 'absent'
		fi
		return
	fi
	printf 'unknown'
}

write_state() {
	STATUS="$1"
	APPLIED="$2"
	DETAIL="$3"
	PACKAGE_STATUS="$(scene_package_status)"
	COUNT=0
	[ -n "$FOUND_PATHS" ] && COUNT="$(printf '%s\n' "$FOUND_PATHS" | grep -c . 2>/dev/null || echo 0)"
	if [ -n "$FOUND_PATHS" ]; then
		printf '%s\n' "$FOUND_PATHS" > "$PATHS_PATH" 2>/dev/null || true
	else
		: > "$PATHS_PATH" 2>/dev/null || true
	fi
	{
		printf 'enabled=1\n'
		printf 'applied_enabled=%s\n' "$APPLIED"
		printf 'status=%s\n' "$STATUS"
		printf 'package_status=%s\n' "$PACKAGE_STATUS"
		printf 'count=%s\n' "$COUNT"
		printf 'updated=%s\n' "$(date +%s 2>/dev/null || echo 0)"
		[ -n "$DETAIL" ] && printf 'detail=%s\n' "$DETAIL"
	} > "$STATE_PATH" 2>/dev/null || true
}

should_stop() {
	if [ -e "$RULE_MODE_CONFIG" ] || [ -L "$RULE_MODE_CONFIG" ]; then
		[ -f "$RULE_MODE_CONFIG" ] && [ ! -L "$RULE_MODE_CONFIG" ] || return 0
		SAVED_MODE=$(cat "$RULE_MODE_CONFIG" 2>/dev/null) || return 0
		case "$SAVED_MODE" in global|allow) ;; *) return 0 ;; esac
	fi
	config_enabled || return 0
	[ ! -e "$MODDIR/disable" ] || return 0
	[ ! -e "$MODDIR/remove" ] || return 0
	[ ! -e "$STOP_PATH" ] || return 0
	if grep -q '^state=paused$' "$BOOT_STATE_PATH" 2>/dev/null; then
		return 0
	fi
	return 1
}

find_scene_debugfs() {
	FOUND_PATHS=""
	SEEN=","
	[ -r /proc/self/mountinfo ] || return 1
	while IFS= read -r LINE || [ -n "$LINE" ]; do
		case "$LINE" in *' - '*) ;; *) continue ;; esac
		LEFT="${LINE%% - *}"
		RIGHT="${LINE#* - }"
		set -- $LEFT
		[ "$#" -ge 5 ] || continue
		MOUNT_POINT="$5"
		set -- $RIGHT
		[ "$#" -ge 1 ] || continue
		[ "$1" = debugfs ] || continue
		case "$MOUNT_POINT" in /dev/*) ;; *) continue ;; esac
		case "$MOUNT_POINT" in *'..'*|*','*|*' '*|*\\*) continue ;; esac
		[ "${#MOUNT_POINT}" -lt 256 ] || continue
		[ -e "$MOUNT_POINT" ] || continue
		CONTEXT="$(stat -c '%C' "$MOUNT_POINT" 2>/dev/null | head -n 1 | tr -d '\r')"
		[ "$CONTEXT" = 'u:object_r:debugfs:s0' ] || continue
		case "$SEEN" in *,"$MOUNT_POINT",*) continue ;; esac
		SEEN="$SEEN$MOUNT_POINT,"
		if [ -z "$FOUND_PATHS" ]; then
			FOUND_PATHS="$MOUNT_POINT"
		else
			FOUND_PATHS="$FOUND_PATHS
$MOUNT_POINT"
		fi
	done < /proc/self/mountinfo
	[ -n "$FOUND_PATHS" ]
}

running_targets_include_found() {
	RUNNING="$(cat /sys/module/$MODULE_NAME/parameters/target_paths 2>/dev/null || true)"
	[ -n "$RUNNING" ] || return 1
	OLD_IFS="$IFS"
	IFS='
'
	for ITEM in $FOUND_PATHS; do
		IFS="$OLD_IFS"
		case ",$RUNNING," in *,"$ITEM",*) ;; *) return 1 ;; esac
		IFS='
'
	done
	IFS="$OLD_IFS"
	return 0
}

case "$WATCH_SECONDS" in ''|*[!0-9]*|0) WATCH_SECONDS=600 ;; esac
mkdir -p "$PERSIST_DIR" 2>/dev/null || exit 0
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	OLD_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
	if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
		OLD_CMDLINE="$(tr '\000' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null || true)"
		case "$OLD_CMDLINE" in
			*scene-debugfs-watch.sh*) exit 0 ;;
		esac
	fi
	rm -f "$LOCK_DIR/pid" 2>/dev/null || true
	rmdir "$LOCK_DIR" 2>/dev/null || exit 0
	mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
# The reload lock is shared with the WebUI (see reloadLockShell in app.js).
# Owners record their pid so a lock left by a killed shell can be reclaimed.
reload_lock_owner_alive() {
	OWNER=$(cat "$RELOAD_LOCK_DIR/pid" 2>/dev/null) || OWNER=''
	case "$OWNER" in ''|*[!0-9]*) return 1 ;; esac
	kill -0 "$OWNER" 2>/dev/null
}

reload_lock_busy() {
	[ -d "$RELOAD_LOCK_DIR" ] && reload_lock_owner_alive
}

take_reload_lock() {
	if ! mkdir "$RELOAD_LOCK_DIR" 2>/dev/null; then
		[ -d "$RELOAD_LOCK_DIR" ] && [ ! -L "$RELOAD_LOCK_DIR" ] || return 1
		reload_lock_owner_alive && return 1
		# Give a new owner time to write its pid after mkdir.
		sleep 1
		reload_lock_owner_alive && return 1
		rm -f "$RELOAD_LOCK_DIR/pid" 2>/dev/null
		rmdir "$RELOAD_LOCK_DIR" 2>/dev/null || return 1
		mkdir "$RELOAD_LOCK_DIR" 2>/dev/null || return 1
	fi
	RELOAD_LOCK_HELD=1
	printf '%s\n' "$$" > "$RELOAD_LOCK_DIR/pid" || { release_reload_lock; return 1; }
}

release_reload_lock() {
	if [ "$RELOAD_LOCK_HELD" = 1 ]; then
		rm -f "$RELOAD_LOCK_DIR/pid" 2>/dev/null || true
		rmdir "$RELOAD_LOCK_DIR" 2>/dev/null || true
		RELOAD_LOCK_HELD=0
	fi
}

cleanup() {
	release_reload_lock
	rm -f "$LOCK_DIR/pid" 2>/dev/null || true
	rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

END=$(( $(date +%s 2>/dev/null || echo 0) + WATCH_SECONDS ))
RELOAD_FAILURES=0
FOUND_PATHS=""
log_i "Scene debugfs late watcher started (max ${WATCH_SECONDS}s)"

while :; do
	# A foreground transaction may be testing a mode that is not yet saved.
	if reload_lock_busy; then
		NOW="$(date +%s 2>/dev/null || echo 0)"
		[ "$NOW" -lt "$END" ] || exit 0
		sleep "$POLL_SECONDS"
		continue
	fi
	should_stop && {
		log_i "Scene debugfs late watcher stopped by config/module state"
		exit 0
	}
	PACKAGE_STATUS="$(scene_package_status)"
	if [ "$PACKAGE_STATUS" = absent ]; then
		FOUND_PATHS=""
		write_state no-package "$WATCH_APPLIED" "$SCENE_PACKAGE is not installed; watcher stopped"
		exit 0
	fi

	if find_scene_debugfs; then
		if ! take_reload_lock; then
			sleep "$POLL_SECONDS"
			continue
		fi
		# Re-read the saved mode and pause state under the same lock as WebUI.
		should_stop && exit 0
		if grep -q "^$MODULE_NAME " /proc/modules 2>/dev/null && running_targets_include_found; then
			write_state found 1 "runtime targets already loaded"
			exit 0
		fi

		write_state late-found-pending "$WATCH_APPLIED" "late mount found; controlled reload starting"
		if grep -q "^$MODULE_NAME " /proc/modules 2>/dev/null; then
			if ! rmmod "$MODULE_NAME" 2>/dev/null; then
				RELOAD_FAILURES=$((RELOAD_FAILURES + 1))
				if [ "$RELOAD_FAILURES" -ge 3 ]; then
					write_state late-reload-failed "$WATCH_APPLIED" "rmmod failed 3 times; use WebUI hot reload"
					exit 0
				fi
				write_state late-reload-retry "$WATCH_APPLIED" "rmmod failed; retry $RELOAD_FAILURES/3"
				release_reload_lock
				sleep 10
				continue
			fi
		fi

		PATHMASK_SCENE_WATCH_RELOAD=1 PATHMASK_INITIAL_DELAY_SECONDS=0 PATHMASK_WAIT_SECONDS=5 \
			sh "$MODDIR/service.sh" >/dev/null 2>&1 || true
		if grep -q "^$MODULE_NAME " /proc/modules 2>/dev/null && running_targets_include_found; then
			write_state late-found 1 "late mount added by controlled reload"
			log_i "Scene debugfs late watcher reloaded PathMask successfully"
		else
			AFTER_APPLIED=0
			grep -q "^$MODULE_NAME " /proc/modules 2>/dev/null && AFTER_APPLIED=1
			write_state late-reload-failed "$AFTER_APPLIED" "service reload did not load the discovered mount"
		fi
		exit 0
	fi

	NOW="$(date +%s 2>/dev/null || echo 0)"
	if [ "$NOW" -ge "$END" ]; then
		FOUND_PATHS=""
		write_state watch-timeout "$WATCH_APPLIED" "no matching /dev debugfs mount during ${WATCH_SECONDS}s background window"
		log_i "Scene debugfs late watcher timed out"
		exit 0
	fi
	sleep "$POLL_SECONDS"
done
