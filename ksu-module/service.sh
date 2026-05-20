#!/system/bin/sh

MODDIR=${0%/*}
MODULE_ID=pathmask
LEGACY_MODULE_ID=nohello-demo
LOG_TAG=pathmask
KO_NAME=pathmask.ko
KO_PATH="$MODDIR/$KO_NAME"
PERSIST_DIR="/data/adb/pathmask"
LEGACY_PERSIST_DIR="/data/adb/nohello"
LOAD_FAIL_COUNT_PATH="$PERSIST_DIR/load_fail_count"
LOAD_FAIL_REASON_PATH="$PERSIST_DIR/load_fail_reason"
LOAD_FAIL_LIMIT=3

MOD_CONFIG_PATH="$MODDIR/target_path.conf"
MOD_HIDE_DIRENTS_CONFIG="$MODDIR/hide_dirents.conf"
MOD_SCOPE_MODE_CONFIG="$MODDIR/scope_mode.conf"
MOD_DENY_UIDS_CONFIG="$MODDIR/deny_uids.conf"
MOD_DENY_PACKAGES_CONFIG="$MODDIR/deny_packages.conf"
MOD_WAIT_SECONDS_CONFIG="$MODDIR/wait_seconds.conf"

CONFIG_PATH="$PERSIST_DIR/target_path.conf"
HIDE_DIRENTS_CONFIG="$PERSIST_DIR/hide_dirents.conf"
SCOPE_MODE_CONFIG="$PERSIST_DIR/scope_mode.conf"
DENY_UIDS_CONFIG="$PERSIST_DIR/deny_uids.conf"
DENY_PACKAGES_CONFIG="$PERSIST_DIR/deny_packages.conf"
WAIT_SECONDS_CONFIG="$PERSIST_DIR/wait_seconds.conf"
LEGACY_TARGET_WAIT_SECONDS_CONFIG="$PERSIST_DIR/target_wait_seconds.conf"
LEGACY_PACKAGE_WAIT_SECONDS_CONFIG="$PERSIST_DIR/package_wait_seconds.conf"
BOOT_STATE_PATH="$PERSIST_DIR/boot_state"

TARGET_PATHS=""
HIDE_DIRENTS=1
SCOPE_MODE=deny
DENY_UIDS=""
WAIT_SECONDS=90
UNRESOLVED_PACKAGES=0

read_load_failure_count() {
	COUNT=0
	if [ -f "$LOAD_FAIL_COUNT_PATH" ]; then
		COUNT="$(head -n 1 "$LOAD_FAIL_COUNT_PATH" 2>/dev/null | tr -d '\r ' || true)"
	fi

	case "$COUNT" in
		''|*[!0-9]*)
			COUNT=0
			;;
	esac

	printf '%s\n' "$COUNT"
}

reset_load_failure_guard() {
	rm -f "$LOAD_FAIL_COUNT_PATH" "$LOAD_FAIL_REASON_PATH" 2>/dev/null || true
}

record_load_failure() {
	REASON="$1"
	COUNT="$(read_load_failure_count)"
	COUNT=$((COUNT + 1))
	mkdir -p "$PERSIST_DIR" 2>/dev/null || true
	printf '%s\n' "$COUNT" > "$LOAD_FAIL_COUNT_PATH" 2>/dev/null || true
	printf '%s\n' "$REASON" > "$LOAD_FAIL_REASON_PATH" 2>/dev/null || true
	log_e "load failure $COUNT/$LOAD_FAIL_LIMIT: $REASON"
}

should_skip_after_load_failures() {
	[ "${PATHMASK_IGNORE_FAIL_GUARD:-0}" = "1" ] && return 1

	COUNT="$(read_load_failure_count)"
	if [ "$COUNT" -ge "$LOAD_FAIL_LIMIT" ]; then
		if [ -f "$LOAD_FAIL_REASON_PATH" ]; then
			REASON="$(head -n 1 "$LOAD_FAIL_REASON_PATH" 2>/dev/null || true)"
		else
			REASON=""
		fi
		log_e "skip loading after $COUNT consecutive failures; reason=$REASON"
		log_e "use WebUI save-and-hot-reload or delete $LOAD_FAIL_COUNT_PATH to retry"
		return 0
	fi

	return 1
}

log_i() {
	log -p i -t "$LOG_TAG" "$*"
}

log_e() {
	log -p e -t "$LOG_TAG" "$*"
}

write_boot_state() {
	STATE="$1"
	DETAIL="$2"
	DEADLINE="$3"

	[ -d "$PERSIST_DIR" ] || mkdir -p "$PERSIST_DIR" 2>/dev/null || return 0

	{
		printf 'state=%s\n' "$STATE"
		printf 'updated=%s\n' "$(date +%s 2>/dev/null || echo 0)"
		[ -n "$DEADLINE" ] && printf 'deadline=%s\n' "$DEADLINE"
		[ -n "$DETAIL" ] && printf 'detail=%s\n' "$DETAIL"
	} > "$BOOT_STATE_PATH" 2>/dev/null || true
}

clear_boot_state() {
	rm -f "$BOOT_STATE_PATH" 2>/dev/null || true
}

migrate_legacy_wait_seconds() {
	# Combine the old per-phase wait files into a single wait_seconds.conf
	# (taking the larger value), then drop the legacy files. Idempotent.
	[ -f "$WAIT_SECONDS_CONFIG" ] && {
		rm -f "$LEGACY_TARGET_WAIT_SECONDS_CONFIG" \
			"$LEGACY_PACKAGE_WAIT_SECONDS_CONFIG" 2>/dev/null || true
		return
	}

	OLD_TARGET=""
	OLD_PACKAGE=""
	[ -f "$LEGACY_TARGET_WAIT_SECONDS_CONFIG" ] && \
		OLD_TARGET="$(head -n 1 "$LEGACY_TARGET_WAIT_SECONDS_CONFIG" 2>/dev/null | tr -d '\r ')"
	[ -f "$LEGACY_PACKAGE_WAIT_SECONDS_CONFIG" ] && \
		OLD_PACKAGE="$(head -n 1 "$LEGACY_PACKAGE_WAIT_SECONDS_CONFIG" 2>/dev/null | tr -d '\r ')"

	case "$OLD_TARGET" in ''|*[!0-9]*) OLD_TARGET=0 ;; esac
	case "$OLD_PACKAGE" in ''|*[!0-9]*) OLD_PACKAGE=0 ;; esac

	if [ "$OLD_TARGET" -gt 0 ] || [ "$OLD_PACKAGE" -gt 0 ]; then
		MAX_WAIT="$OLD_TARGET"
		[ "$OLD_PACKAGE" -gt "$MAX_WAIT" ] && MAX_WAIT="$OLD_PACKAGE"
		printf '%s\n' "$MAX_WAIT" > "$WAIT_SECONDS_CONFIG" 2>/dev/null || true
		log_i "merged legacy wait files (target=$OLD_TARGET package=$OLD_PACKAGE) -> wait_seconds=$MAX_WAIT"
	fi

	rm -f "$LEGACY_TARGET_WAIT_SECONDS_CONFIG" \
		"$LEGACY_PACKAGE_WAIT_SECONDS_CONFIG" 2>/dev/null || true
}

seed_config_file() {
	DEST="$1"
	SRC="$2"
	DEFAULT_VALUE="$3"

	if [ -f "$DEST" ]; then
		return
	fi

	if [ -f "$SRC" ]; then
		cp "$SRC" "$DEST" 2>/dev/null && return
	fi

	printf '%s\n' "$DEFAULT_VALUE" > "$DEST"
}

migrate_legacy_config() {
	[ -d "$PERSIST_DIR" ] && return
	[ -d "$LEGACY_PERSIST_DIR" ] || return

	if mkdir -p "$PERSIST_DIR" 2>/dev/null; then
		for NAME in target_path.conf hide_dirents.conf scope_mode.conf deny_uids.conf deny_packages.conf wait_seconds.conf target_wait_seconds.conf package_wait_seconds.conf; do
			if [ -f "$LEGACY_PERSIST_DIR/$NAME" ]; then
				cp "$LEGACY_PERSIST_DIR/$NAME" "$PERSIST_DIR/$NAME" 2>/dev/null || true
			fi
		done
		log_i "migrated legacy config from $LEGACY_PERSIST_DIR"
	fi
}

init_persistent_config() {
	migrate_legacy_config

	if ! mkdir -p "$PERSIST_DIR" 2>/dev/null; then
		log_i "could not create $PERSIST_DIR, using module config"
		CONFIG_PATH="$MOD_CONFIG_PATH"
		HIDE_DIRENTS_CONFIG="$MOD_HIDE_DIRENTS_CONFIG"
		SCOPE_MODE_CONFIG="$MOD_SCOPE_MODE_CONFIG"
		DENY_UIDS_CONFIG="$MOD_DENY_UIDS_CONFIG"
		DENY_PACKAGES_CONFIG="$MOD_DENY_PACKAGES_CONFIG"
		WAIT_SECONDS_CONFIG="$MOD_WAIT_SECONDS_CONFIG"
		return
	fi

	chmod 0700 "$PERSIST_DIR" 2>/dev/null || true
	migrate_legacy_wait_seconds
	seed_config_file "$CONFIG_PATH" "$MOD_CONFIG_PATH" ""
	seed_config_file "$HIDE_DIRENTS_CONFIG" "$MOD_HIDE_DIRENTS_CONFIG" "1"
	seed_config_file "$SCOPE_MODE_CONFIG" "$MOD_SCOPE_MODE_CONFIG" "deny"
	seed_config_file "$DENY_UIDS_CONFIG" "$MOD_DENY_UIDS_CONFIG" ""
	seed_config_file "$DENY_PACKAGES_CONFIG" "$MOD_DENY_PACKAGES_CONFIG" ""
	seed_config_file "$WAIT_SECONDS_CONFIG" "$MOD_WAIT_SECONDS_CONFIG" "90"
}

add_target_path() {
	CANDIDATE_PATH="$1"

	if [ -z "$CANDIDATE_PATH" ]; then
		return
	fi

	if [ -z "$TARGET_PATHS" ]; then
		TARGET_PATHS="$CANDIDATE_PATH"
	else
		TARGET_PATHS="$TARGET_PATHS,$CANDIDATE_PATH"
	fi
}

add_deny_uid() {
	CANDIDATE_UID="$1"

	case "$CANDIDATE_UID" in
		''|*[!0-9]*)
			return
			;;
	esac

	case ",$DENY_UIDS," in
		*,"$CANDIDATE_UID",*)
			return
			;;
	esac

	if [ -z "$DENY_UIDS" ]; then
		DENY_UIDS="$CANDIDATE_UID"
	else
		DENY_UIDS="$DENY_UIDS,$CANDIDATE_UID"
	fi
}

package_to_uid_from_packages_list() {
	PACKAGE_NAME="$1"
	PACKAGES_LIST="/data/system/packages.list"

	[ -f "$PACKAGES_LIST" ] || return

	while IFS= read -r PACKAGE_LINE || [ -n "$PACKAGE_LINE" ]; do
		set -- $PACKAGE_LINE
		[ "$1" = "$PACKAGE_NAME" ] || continue

		case "$2" in
			''|*[!0-9]*)
				return
				;;
			*)
				printf '%s\n' "$2"
				return
				;;
		esac
	done < "$PACKAGES_LIST"
}

package_to_uid_from_data_dir() {
	PACKAGE_NAME="$1"

	for DATA_DIR in "/data/user/0/$PACKAGE_NAME" "/data/data/$PACKAGE_NAME"; do
		[ -d "$DATA_DIR" ] || continue

		DATA_UID="$(stat -c '%u' "$DATA_DIR" 2>/dev/null || true)"
		case "$DATA_UID" in
			''|*[!0-9]*)
				;;
			*)
				printf '%s\n' "$DATA_UID"
				return
				;;
		esac

		DATA_LINE="$(ls -ldn "$DATA_DIR" 2>/dev/null || true)"
		set -- $DATA_LINE
		case "$3" in
			''|*[!0-9]*)
				;;
			*)
				printf '%s\n' "$3"
				return
				;;
		esac
	done
}

package_to_uid_from_pm() {
	PACKAGE_NAME="$1"
	PACKAGE_LINES="$(
		cmd package list packages --user 0 -U "$PACKAGE_NAME" 2>/dev/null || true
		pm list packages --user 0 -U "$PACKAGE_NAME" 2>/dev/null || true
		cmd package list packages -U "$PACKAGE_NAME" 2>/dev/null || true
		pm list packages -U "$PACKAGE_NAME" 2>/dev/null || true
	)"

	printf '%s\n' "$PACKAGE_LINES" |
	while IFS= read -r PACKAGE_LINE; do
		case "$PACKAGE_LINE" in
			package:*" uid:"*)
				;;
			*)
				continue
				;;
		esac

		LINE_PKG="${PACKAGE_LINE#package:}"
		LINE_PKG="${LINE_PKG%% uid:*}"
		LINE_UID="${PACKAGE_LINE##* uid:}"
		LINE_UID="${LINE_UID%% *}"

		if [ "$LINE_PKG" = "$PACKAGE_NAME" ] &&
		   [ "$LINE_UID" != "$PACKAGE_LINE" ]; then
			printf '%s\n' "$LINE_UID"
			break
		fi
	done
}

package_to_uid() {
	RESOLVED_PACKAGE_UID="$(package_to_uid_from_packages_list "$1" | head -n 1)"
	if [ -n "$RESOLVED_PACKAGE_UID" ]; then
		printf '%s\n' "$RESOLVED_PACKAGE_UID"
		return
	fi

	RESOLVED_PACKAGE_UID="$(package_to_uid_from_pm "$1" | head -n 1)"
	if [ -n "$RESOLVED_PACKAGE_UID" ]; then
		printf '%s\n' "$RESOLVED_PACKAGE_UID"
		return
	fi

	package_to_uid_from_data_dir "$1" | head -n 1
}

read_deny_uid_config() {
	[ -f "$DENY_UIDS_CONFIG" ] || return

	while IFS= read -r CONFIG_LINE || [ -n "$CONFIG_LINE" ]; do
		CONFIG_LINE="$(printf '%s' "$CONFIG_LINE" | tr -d '\r')"
		case "$CONFIG_LINE" in
			''|\#*)
				continue
				;;
		esac
		OLD_IFS="$IFS"
		IFS=","
		for UID_ITEM in $CONFIG_LINE; do
			IFS="$OLD_IFS"
			UID_ITEM="$(printf '%s' "$UID_ITEM" | tr -d ' ')"
			add_deny_uid "$UID_ITEM"
			IFS=","
		done
		IFS="$OLD_IFS"
	done < "$DENY_UIDS_CONFIG"
}

read_deny_package_config() {
	QUIET="$1"
	UNRESOLVED_PACKAGES=0
	[ -f "$DENY_PACKAGES_CONFIG" ] || return

	while IFS= read -r CONFIG_LINE || [ -n "$CONFIG_LINE" ]; do
		CONFIG_LINE="$(printf '%s' "$CONFIG_LINE" | tr -d '\r ')"
		case "$CONFIG_LINE" in
			''|\#*)
				continue
				;;
		esac
		PACKAGE_UID="$(package_to_uid "$CONFIG_LINE" | head -n 1)"
		if [ -n "$PACKAGE_UID" ]; then
			add_deny_uid "$PACKAGE_UID"
			[ "$QUIET" = "1" ] || log_i "resolved $CONFIG_LINE uid=$PACKAGE_UID"
		else
			UNRESOLVED_PACKAGES=$((UNRESOLVED_PACKAGES + 1))
			[ "$QUIET" = "1" ] || log_i "could not resolve package UID: $CONFIG_LINE"
		fi
	done < "$DENY_PACKAGES_CONFIG"
}

any_target_exists() {
	OLD_IFS="$IFS"
	IFS=","
	for TARGET_ITEM in $TARGET_PATHS; do
		IFS="$OLD_IFS"
		if [ -e "$TARGET_ITEM" ]; then
			return 0
		fi
		IFS=","
	done
	IFS="$OLD_IFS"
	return 1
}

all_targets_exist() {
	OLD_IFS="$IFS"
	IFS=","
	for TARGET_ITEM in $TARGET_PATHS; do
		IFS="$OLD_IFS"
		if [ ! -e "$TARGET_ITEM" ]; then
			return 1
		fi
		IFS=","
	done
	IFS="$OLD_IFS"
	return 0
}

log_missing_targets() {
	OLD_IFS="$IFS"
	IFS=","
	for TARGET_ITEM in $TARGET_PATHS; do
		IFS="$OLD_IFS"
		if [ ! -e "$TARGET_ITEM" ]; then
			log_i "target still missing, kernel will skip: $TARGET_ITEM"
		fi
		IFS=","
	done
	IFS="$OLD_IFS"
}

wait_for_targets() {
	ELAPSED=0
	NOW="$(date +%s 2>/dev/null || echo 0)"
	DEADLINE=$((NOW + WAIT_SECONDS))
	write_boot_state "waiting-targets" "$TARGET_PATHS" "$DEADLINE"

	while [ "$ELAPSED" -lt "$WAIT_SECONDS" ]; do
		if all_targets_exist; then
			return 0
		fi
		sleep 1
		ELAPSED=$((ELAPSED + 1))
	done

	log_missing_targets
	any_target_exists
}

wait_for_deny_packages() {
	ELAPSED=0
	NOW="$(date +%s 2>/dev/null || echo 0)"
	DEADLINE=$((NOW + WAIT_SECONDS))
	write_boot_state "waiting-packages" "" "$DEADLINE"

	while [ "$ELAPSED" -lt "$WAIT_SECONDS" ]; do
		DENY_UIDS=""
		read_deny_uid_config
		read_deny_package_config 1
		if [ "$UNRESOLVED_PACKAGES" -eq 0 ]; then
			read_deny_package_config 0
			return 0
		fi
		sleep 1
		ELAPSED=$((ELAPSED + 1))
	done

	DENY_UIDS=""
	read_deny_uid_config
	read_deny_package_config 0
}

init_persistent_config
write_boot_state "init" "" ""

if [ -n "${PATHMASK_LOAD_FAIL_LIMIT:-}" ]; then
	LOAD_FAIL_LIMIT="$PATHMASK_LOAD_FAIL_LIMIT"
fi

case "$LOAD_FAIL_LIMIT" in
	''|*[!0-9]*|0)
		LOAD_FAIL_LIMIT=3
		;;
esac

if [ "${PATHMASK_RESET_FAIL_GUARD:-0}" = "1" ]; then
	reset_load_failure_guard
	log_i "reset load failure guard"
fi

if should_skip_after_load_failures; then
	write_boot_state "skipped-fail-guard" "consecutive insmod failures" ""
	exit 0
fi

if [ -f "$CONFIG_PATH" ]; then
	while IFS= read -r CONFIG_LINE || [ -n "$CONFIG_LINE" ]; do
		CONFIG_LINE="$(printf '%s' "$CONFIG_LINE" | tr -d '\r')"
		case "$CONFIG_LINE" in
			''|\#*)
				continue
				;;
		esac
		add_target_path "$CONFIG_LINE"
	done < "$CONFIG_PATH"
fi

if [ -f "$HIDE_DIRENTS_CONFIG" ]; then
	HIDE_DIRENTS="$(head -n 1 "$HIDE_DIRENTS_CONFIG" | tr -d '\r')"
fi

if [ -f "$SCOPE_MODE_CONFIG" ]; then
	SCOPE_MODE="$(head -n 1 "$SCOPE_MODE_CONFIG" | tr -d '\r ')"
fi

if [ -f "$WAIT_SECONDS_CONFIG" ]; then
	WAIT_SECONDS="$(head -n 1 "$WAIT_SECONDS_CONFIG" | tr -d '\r ')"
fi

if [ -n "${PATHMASK_WAIT_SECONDS:-}" ]; then
	WAIT_SECONDS="$PATHMASK_WAIT_SECONDS"
fi

case "$WAIT_SECONDS" in
	''|*[!0-9]*)
		WAIT_SECONDS=90
		;;
esac

case "$SCOPE_MODE" in
	deny|global)
		;;
	*)
		log_i "unsupported scope_mode=$SCOPE_MODE, fallback to global"
		SCOPE_MODE=global
		;;
esac

case "$HIDE_DIRENTS" in
	0|false|False|no|No)
		HIDE_DIRENTS=0
		;;
	*)
		HIDE_DIRENTS=1
		;;
esac

if [ -z "$TARGET_PATHS" ]; then
	log_e "empty target path list"
	write_boot_state "skipped-empty-targets" "no path configured" ""
	exit 1
fi

if [ ! -f "$KO_PATH" ]; then
	log_e "missing module: $KO_PATH"
	record_load_failure "missing module: $KO_PATH"
	write_boot_state "failed-missing-ko" "$KO_PATH" ""
	exit 1
fi

sleep 10

if ! wait_for_targets; then
	log_i "no configured targets exist, skip loading"
	write_boot_state "skipped-targets-missing" "$TARGET_PATHS" ""
	exit 0
fi

if [ "$SCOPE_MODE" = "deny" ]; then
	wait_for_deny_packages
	if [ -z "$DENY_UIDS" ]; then
		log_i "scope_mode=deny but no deny UIDs resolved, skip loading"
		write_boot_state "skipped-no-uids" "deny mode without resolved UIDs" ""
		exit 0
	fi
else
	read_deny_uid_config
	read_deny_package_config 0
fi

if grep -q '^pathmask ' /proc/modules 2>/dev/null; then
	reset_load_failure_guard
	log_i "pathmask is already loaded"
	write_boot_state "already-loaded" "" ""
	exit 0
fi

if grep -q '^nohello ' /proc/modules 2>/dev/null; then
	log_i "legacy nohello module is loaded; unload it before loading pathmask"
	write_boot_state "skipped-legacy-loaded" "legacy nohello in /proc/modules" ""
	exit 0
fi

if insmod "$KO_PATH" target_paths="$TARGET_PATHS" hide_dirents="$HIDE_DIRENTS" scope_mode="$SCOPE_MODE" deny_uids="$DENY_UIDS"; then
	reset_load_failure_guard
	log_i "loaded $KO_PATH target_paths=$TARGET_PATHS hide_dirents=$HIDE_DIRENTS scope_mode=$SCOPE_MODE deny_uids=$DENY_UIDS"
	write_boot_state "loaded" "$TARGET_PATHS" ""
else
	log_e "failed to load $KO_PATH"
	record_load_failure "insmod failed: $KO_PATH"
	write_boot_state "failed-insmod" "$KO_PATH" ""
	exit 1
fi
