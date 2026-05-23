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
MOD_ENABLE_SYSCALL_HOOKS_CONFIG="$MODDIR/enable_syscall_hooks.conf"

CONFIG_PATH="$PERSIST_DIR/target_path.conf"
HIDE_DIRENTS_CONFIG="$PERSIST_DIR/hide_dirents.conf"
SCOPE_MODE_CONFIG="$PERSIST_DIR/scope_mode.conf"
DENY_UIDS_CONFIG="$PERSIST_DIR/deny_uids.conf"
DENY_PACKAGES_CONFIG="$PERSIST_DIR/deny_packages.conf"
WAIT_SECONDS_CONFIG="$PERSIST_DIR/wait_seconds.conf"
ENABLE_SYSCALL_HOOKS_CONFIG="$PERSIST_DIR/enable_syscall_hooks.conf"
LEGACY_TARGET_WAIT_SECONDS_CONFIG="$PERSIST_DIR/target_wait_seconds.conf"
LEGACY_PACKAGE_WAIT_SECONDS_CONFIG="$PERSIST_DIR/package_wait_seconds.conf"
BOOT_STATE_PATH="$PERSIST_DIR/boot_state"

TARGET_PATHS=""
HIDE_DIRENTS=1
SCOPE_MODE=deny
DENY_UIDS=""
WAIT_SECONDS=60
ENABLE_SYSCALL_HOOKS=0
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
		ENABLE_SYSCALL_HOOKS_CONFIG="$MOD_ENABLE_SYSCALL_HOOKS_CONFIG"
		return
	fi

	chmod 0700 "$PERSIST_DIR" 2>/dev/null || true
	migrate_legacy_wait_seconds
	seed_config_file "$CONFIG_PATH" "$MOD_CONFIG_PATH" ""
	seed_config_file "$HIDE_DIRENTS_CONFIG" "$MOD_HIDE_DIRENTS_CONFIG" "1"
	seed_config_file "$SCOPE_MODE_CONFIG" "$MOD_SCOPE_MODE_CONFIG" "deny"
	seed_config_file "$DENY_UIDS_CONFIG" "$MOD_DENY_UIDS_CONFIG" ""
	seed_config_file "$DENY_PACKAGES_CONFIG" "$MOD_DENY_PACKAGES_CONFIG" ""
	seed_config_file "$WAIT_SECONDS_CONFIG" "$MOD_WAIT_SECONDS_CONFIG" "60"
	seed_config_file "$ENABLE_SYSCALL_HOOKS_CONFIG" "$MOD_ENABLE_SYSCALL_HOOKS_CONFIG" "0"
}

add_target_path() {
	CANDIDATE_PATH="$1"

	if [ -z "$CANDIDATE_PATH" ]; then
		return
	fi

	# Dedup: skip if this exact literal path is already in the list. Two
	# different glob patterns can resolve to the same parent dir (e.g.
	# `dir:/dev/???/marker-a` and `dir:/dev/???/marker-b` both yielding
	# `/dev/<hash>`), and the kernel's MAX_HIDE_TARGETS is finite, so we
	# don't want to burn slots on duplicates.
	case ",$TARGET_PATHS," in
		*,"$CANDIDATE_PATH",*)
			return
			;;
	esac

	if [ -z "$TARGET_PATHS" ]; then
		TARGET_PATHS="$CANDIDATE_PATH"
	else
		TARGET_PATHS="$TARGET_PATHS,$CANDIDATE_PATH"
	fi
}

# Configured raw lines (one per line of target_path.conf, unexpanded).
# Wait/insmod logic re-expands these on every loop so newly-appeared
# Scene-style /dev/<hash>/... paths get picked up between boot phases.
TARGET_RAW_LINES=""

add_target_raw_line() {
	RAW_LINE="$1"

	[ -z "$RAW_LINE" ] && return

	if [ -z "$TARGET_RAW_LINES" ]; then
		TARGET_RAW_LINES="$RAW_LINE"
	else
		TARGET_RAW_LINES="$TARGET_RAW_LINES
$RAW_LINE"
	fi
}

# Strip an optional `any:<group>:` prefix from a raw config line.
# Sets the global GROUP_ID to the group name (or empty for ungrouped
# lines) and prints the remainder. Used by is_glob_line(),
# expand_target_line(), and the wait/probe helpers so the rest of
# the code never has to think about the prefix.
#
# Group semantics: every ungrouped line must resolve on its own; a
# group is satisfied if *any* line bearing the same `any:<group>:`
# prefix resolves. The boot wait completes the moment all ungrouped
# lines exist AND every group has at least one member resolving.
# This lets the bundled defaults ship with two Scene targets
# (8.x literal /dev/scene + 9.3+ glob dir:/dev/???/scene_mode_category)
# joined into one OR group, so a device running either Scene version
# (or neither) doesn't burn the wait timeout on the missing one.
strip_group_prefix() {
	IN="$1"
	GROUP_ID=""
	case "$IN" in
		any:*:*)
			REST="${IN#any:}"
			GROUP_ID="${REST%%:*}"
			REST="${REST#*:}"
			printf '%s' "$REST"
			return
			;;
	esac
	printf '%s' "$IN"
}

# Returns 0 if the raw config line is a glob (contains the `???` marker
# or any of the standard shell glob metachars `?` `*` `[`), 1 otherwise.
# We accept `???` as a user-friendly synonym for `*` (matches any single
# path segment) because shell `*` in path context still doesn't cross
# `/`, and a literal `*` in a config file looks alarming. See
# expand_target_line() for the substitution.
is_glob_line() {
	LINE="$1"
	# Strip optional `any:<group>:` first, then `dir:`, before
	# detecting glob metachars.
	LINE="$(strip_group_prefix "$LINE")"
	case "$LINE" in
		dir:*) LINE="${LINE#dir:}" ;;
	esac
	case "$LINE" in
		*'???'*|*'*'*|*'?'*|*'['*) return 0 ;;
	esac
	return 1
}

# Expand a single raw config line into one or more literal paths and
# add each to TARGET_PATHS. Recognises:
#   - `dir:` prefix → emit the parent directory of each match
#   - `???`         → replaced with `*` (any non-`/` characters)
#   - shell `?`/`*`/`[abc]` → forwarded to shell glob unchanged
# A line without any glob markers is treated as a literal path. Glob
# lines that match nothing are silently skipped (this is normal: the
# bundled Scene 9.3.0 default doesn't match on devices without Scene).
expand_target_line() {
	RAW="$1"
	USE_PARENT=0

	# Strip optional `any:<group>:` first; the group prefix exists
	# only for the boot-time wait grouping and is invisible to the
	# kernel (the kernel hides paths regardless of which OR group
	# they belonged to in the conf).
	RAW="$(strip_group_prefix "$RAW")"

	case "$RAW" in
		dir:*)
			USE_PARENT=1
			RAW="${RAW#dir:}"
			;;
	esac

	[ -z "$RAW" ] && return

	# Translate the friendly `???` marker into the shell-glob `*`. We do
	# this via parameter substitution rather than `sed` so it works in
	# the early boot environment where /system/bin/sed is not yet
	# guaranteed to be on PATH (depends on init order / SELinux phase).
	PATTERN="$RAW"
	while :; do
		case "$PATTERN" in
			*'???'*) PATTERN="${PATTERN%%'???'*}*${PATTERN#*'???'}" ;;
			*) break ;;
		esac
	done

	if is_glob_line "$RAW"; then
		# Use shell pathname expansion. set -- relies on the script not
		# having `set -f` enabled (we don't), and the splitting respects
		# the default IFS for whitespace-free path components.
		# `printf '%s\n'` collapses multiple matches into one-per-line so
		# we can iterate even when paths contain glob chars themselves.
		# shellcheck disable=SC2086
		set -- $PATTERN
		for MATCH in "$@"; do
			# Glob with no matches yields the literal pattern back. Skip
			# anything that still looks like a pattern.
			case "$MATCH" in
				*'*'*|*'?'*|*'['*) continue ;;
			esac
			# Existence guard: glob match doesn't imply readable file
			# (e.g. dangling).
			[ -e "$MATCH" ] || continue
			if [ "$USE_PARENT" = "1" ]; then
				PARENT="${MATCH%/*}"
				[ -z "$PARENT" ] && PARENT="/"
				add_target_path "$PARENT"
			else
				add_target_path "$MATCH"
			fi
		done
	else
		# Literal path. The `dir:` prefix is unusual on a literal path
		# (the user is asking us to hide its parent rather than itself),
		# but we honour it for orthogonality.
		if [ "$USE_PARENT" = "1" ]; then
			PARENT="${PATTERN%/*}"
			[ -z "$PARENT" ] && PARENT="/"
			add_target_path "$PARENT"
		else
			add_target_path "$PATTERN"
		fi
	fi
}

# Re-expand every raw line into TARGET_PATHS from scratch. Called once
# at startup and again on every wait loop so newly-mounted dynamic
# paths (Scene 9.3.0 mounts a randomised /dev/<hash>/debug late in
# boot) get picked up without restarting the boot script.
rebuild_target_paths() {
	TARGET_PATHS=""
	OLD_IFS="$IFS"
	IFS="
"
	for RAW in $TARGET_RAW_LINES; do
		IFS="$OLD_IFS"
		expand_target_line "$RAW"
		IFS="
"
	done
	IFS="$OLD_IFS"
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

# Probe a single raw config line: returns 0 if it currently resolves
# to at least one existing path, 1 otherwise. Handles all three
# layers in order: any:<group>: prefix stripping, dir: prefix
# stripping, and ??? -> * + shell glob expansion. For glob lines
# we count "at least one match exists" as resolved; for literal
# lines a plain `[ -e ]` is enough.
raw_line_resolves() {
	IN="$1"
	IN="$(strip_group_prefix "$IN")"
	case "$IN" in
		dir:*) IN="${IN#dir:}" ;;
	esac

	# Translate ??? -> * via parameter substitution (no sed
	# dependency at boot, same as expand_target_line).
	PROBE="$IN"
	while :; do
		case "$PROBE" in
			*'???'*) PROBE="${PROBE%%'???'*}*${PROBE#*'???'}" ;;
			*) break ;;
		esac
	done

	case "$PROBE" in
		*'*'*|*'?'*|*'['*)
			# Glob form: probe resolves iff the first iteration
			# of the for-loop sees an existing path. Without
			# nullglob we have to short-circuit manually because
			# an empty match returns the literal pattern.
			# shellcheck disable=SC2086
			set -- $PROBE
			for M in "$@"; do
				case "$M" in
					*'*'*|*'?'*|*'['*) continue ;;
				esac
				[ -e "$M" ] && return 0
			done
			return 1
			;;
		*)
			[ -e "$PROBE" ] && return 0
			return 1
			;;
	esac
}

# all_literal_targets_exist: every ungrouped raw line must resolve,
# AND every distinct any:<group>: must have at least one member that
# resolves. Glob lines that match nothing are skipped only if they
# are *grouped* (a glob line outside a group still must match -- the
# user explicitly asked for it, no fallback).
#
# Loop runs entirely against TARGET_RAW_LINES so we re-check every
# wait iteration; this catches Scene mounting its randomised
# /dev/<hash>/debug late in boot without us having to keep state.
all_literal_targets_exist() {
	# A group is "satisfied" when at least one member resolves.
	# We track this in a comma-separated allowlist: SATISFIED_GROUPS.
	# Two passes: first collect the set of unsatisfied groups (any
	# group with zero resolving members), then verify every
	# ungrouped line. This avoids backtracking and keeps the cost
	# linear in the conf size.
	SATISFIED_GROUPS=","
	SEEN_GROUPS=","
	OLD_IFS="$IFS"
	IFS="
"

	# Pass 1: scan grouped lines, mark groups satisfied as soon as
	# any member resolves.
	for RAW in $TARGET_RAW_LINES; do
		IFS="$OLD_IFS"
		case "$RAW" in
			any:*:*)
				REST="${RAW#any:}"
				GID="${REST%%:*}"
				case ",$SEEN_GROUPS" in
					*",$GID,"*) ;;
					*) SEEN_GROUPS="$SEEN_GROUPS$GID," ;;
				esac
				case ",$SATISFIED_GROUPS" in
					*",$GID,"*)
						# This group already has a member that
						# resolved; skip the rest of its members.
						;;
					*)
						if raw_line_resolves "$RAW"; then
							SATISFIED_GROUPS="$SATISFIED_GROUPS$GID,"
						fi
						;;
				esac
				;;
		esac
		IFS="
"
	done

	# Any group seen but never satisfied means the wait must
	# continue.
	IFS=","
	for GID in ${SEEN_GROUPS#,}; do
		IFS="$OLD_IFS"
		[ -z "$GID" ] && continue
		case ",$SATISFIED_GROUPS" in
			*",$GID,"*) ;;
			*)
				IFS="$OLD_IFS"
				return 1
				;;
		esac
		IFS=","
	done
	IFS="
"

	# Pass 2: every ungrouped raw line must resolve.
	for RAW in $TARGET_RAW_LINES; do
		IFS="$OLD_IFS"
		case "$RAW" in
			any:*:*)
				IFS="
"
				continue
				;;
		esac
		# Glob lines outside a group: still must match (user-asked,
		# no fallback). This preserves the v2.2.8 behaviour for
		# top-level glob lines like a manually added
		# /dev/proc-???/something line.
		if is_glob_line "$RAW"; then
			IFS="
"
			continue
		fi
		if ! raw_line_resolves "$RAW"; then
			IFS="$OLD_IFS"
			return 1
		fi
		IFS="
"
	done
	IFS="$OLD_IFS"
	return 0
}

log_missing_targets() {
	# Walk every raw line. For grouped lines we report once per
	# group ("group <gid> currently has no satisfying member") only
	# if the group has zero resolving members. Ungrouped glob lines
	# log "glob line currently has no matches"; ungrouped literal
	# lines log "literal target still missing".
	GROUP_DONE=","
	OLD_IFS="$IFS"
	IFS="
"
	for RAW in $TARGET_RAW_LINES; do
		IFS="$OLD_IFS"
		case "$RAW" in
			any:*:*)
				REST="${RAW#any:}"
				GID="${REST%%:*}"
				case ",$GROUP_DONE" in
					*",$GID,"*)
						# Already reported for this group, skip.
						IFS="
"
						continue
						;;
				esac
				# Re-scan all members of this group; if at least one
				# resolves, the group is satisfied (no log). Else log
				# once with a brief description of the group's lines.
				ANY_OK=0
				IFS="
"
				for INNER in $TARGET_RAW_LINES; do
					IFS="$OLD_IFS"
					case "$INNER" in
						any:"$GID":*)
							if raw_line_resolves "$INNER"; then
								ANY_OK=1
								break
							fi
							;;
					esac
					IFS="
"
				done
				IFS="$OLD_IFS"
				if [ "$ANY_OK" = "0" ]; then
					log_i "group '$GID' currently has no resolving member, kernel will not see this group's targets until one appears"
				fi
				GROUP_DONE="$GROUP_DONE$GID,"
				;;
			*)
				if is_glob_line "$RAW"; then
					if ! raw_line_resolves "$RAW"; then
						log_i "glob line currently has no matches: $RAW"
					fi
				else
					PROBE="$RAW"
					case "$PROBE" in
						dir:*) PROBE="${PROBE#dir:}" ;;
					esac
					if [ ! -e "$PROBE" ]; then
						log_i "literal target still missing, kernel will skip: $PROBE"
					fi
				fi
				;;
		esac
		IFS="
"
	done
	IFS="$OLD_IFS"
}

wait_for_targets() {
	END="$1"

	write_boot_state "waiting-targets" "$TARGET_RAW_LINES" "$END"

	while :; do
		# Re-expand every iteration so a Scene boot that mounts the
		# randomised /dev/<hash>/debug late in boot is picked up as
		# soon as it appears, without having to wait for the literal
		# /dev/scene fallback to also resolve.
		rebuild_target_paths
		if all_literal_targets_exist; then
			return 0
		fi
		NOW="$(date +%s 2>/dev/null || echo 0)"
		[ "$NOW" -ge "$END" ] && break
		sleep 1
	done

	# Final expansion before deciding what to load.
	rebuild_target_paths
	log_missing_targets
	# The kernel is happy to load with a partial target set; only bail
	# if literally nothing exists at all.
	any_target_exists
}

wait_for_deny_packages() {
	END="$1"

	write_boot_state "waiting-packages" "" "$END"

	while :; do
		DENY_UIDS=""
		read_deny_uid_config
		read_deny_package_config 1
		if [ "$UNRESOLVED_PACKAGES" -eq 0 ]; then
			read_deny_package_config 0
			return 0
		fi
		NOW="$(date +%s 2>/dev/null || echo 0)"
		[ "$NOW" -ge "$END" ] && break
		sleep 1
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
		add_target_raw_line "$CONFIG_LINE"
	done < "$CONFIG_PATH"
	# Initial expansion. wait_for_targets() will rebuild on every loop
	# iteration so glob lines stay current.
	rebuild_target_paths
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

if [ -f "$ENABLE_SYSCALL_HOOKS_CONFIG" ]; then
	ENABLE_SYSCALL_HOOKS="$(head -n 1 "$ENABLE_SYSCALL_HOOKS_CONFIG" | tr -d '\r ')"
fi

if [ -n "${PATHMASK_WAIT_SECONDS:-}" ]; then
	WAIT_SECONDS="$PATHMASK_WAIT_SECONDS"
fi

case "$WAIT_SECONDS" in
	''|*[!0-9]*)
		WAIT_SECONDS=60
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

case "$ENABLE_SYSCALL_HOOKS" in
	1|true|True|yes|Yes|on|On)
		ENABLE_SYSCALL_HOOKS=1
		;;
	*)
		ENABLE_SYSCALL_HOOKS=0
		;;
esac

if [ -z "$TARGET_RAW_LINES" ]; then
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

WAIT_DEADLINE=$(( $(date +%s 2>/dev/null || echo 0) + WAIT_SECONDS ))

if ! wait_for_targets "$WAIT_DEADLINE"; then
	log_i "no configured targets exist, skip loading"
	write_boot_state "skipped-targets-missing" "$TARGET_PATHS" ""
	exit 0
fi

if [ "$SCOPE_MODE" = "deny" ]; then
	wait_for_deny_packages "$WAIT_DEADLINE"
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

if insmod "$KO_PATH" target_paths="$TARGET_PATHS" hide_dirents="$HIDE_DIRENTS" scope_mode="$SCOPE_MODE" deny_uids="$DENY_UIDS" enable_syscall_hooks="$ENABLE_SYSCALL_HOOKS"; then
	reset_load_failure_guard
	log_i "loaded $KO_PATH target_paths=$TARGET_PATHS hide_dirents=$HIDE_DIRENTS scope_mode=$SCOPE_MODE deny_uids=$DENY_UIDS enable_syscall_hooks=$ENABLE_SYSCALL_HOOKS"
	write_boot_state "loaded" "$TARGET_PATHS" ""
else
	log_e "failed to load $KO_PATH"
	record_load_failure "insmod failed: $KO_PATH"
	write_boot_state "failed-insmod" "$KO_PATH" ""
	exit 1
fi
