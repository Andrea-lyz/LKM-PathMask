#!/usr/bin/env sh
# Package the KernelSU module zip.
#
# By default this script preserves the conf files shipped in
# ksu-module/ verbatim -- treat that directory as the canonical
# source of truth for the bundled defaults. Each conf is only
# overwritten when its corresponding environment variable is
# explicitly set, so CI and ad-hoc invocations don't accidentally
# silently override the in-repo defaults with stale baked-in
# strings (which is exactly what happened in v2.2.8 -- the
# script's hardcoded TARGET_PATHS clobbered the new
# any:scene:/dev/???/scene_mode_category default that lived in
# ksu-module/target_path.conf, shipping users an out-of-date
# 3-line config).
#
# Recognised override variables (each takes precedence over the
# template file when set, even to an empty string):
#   TARGET_PATHS    comma-separated list of target lines (or
#                   legacy TARGET_PATH for the same effect)
#   HIDE_DIRENTS    "0" or "1"
#   ENABLE_SYSCALL_HOOKS   "0" or "1" (master toggle for the 7
#                          __arm64_sys_* fallback hooks)
#   SYSCALL_HOOKS    comma-separated subset of __arm64_sys_* probes
#                    to register, e.g. "newfstatat,statx,openat".
#                    Or "all" / "none". Empty falls back to the
#                    template default (faccessat omitted).
#   SCOPE_MODE      "global", "deny", or "allow"
#   DENY_PACKAGES   comma-separated blacklist package names
#   DENY_UIDS       comma-separated blacklist UIDs
#   ALLOW_PACKAGES  comma-separated allowlist package names
#   ALLOW_UIDS      comma-separated allowlist UIDs
#   ALLOW_SYSTEM_UIDS comma-separated allow-mode system UID presets
#   WAIT_SECONDS    integer seconds
#   UPDATE_JSON_URL absolute https URL appended to module.prop
set -eu

KO_PATH="${1:-kernel/pathmask.ko}"
OUTPUT="${2:-out/pathmask-ksu.zip}"
UPDATE_JSON_URL="${UPDATE_JSON_URL:-}"

# If the caller didn't set UPDATE_JSON_URL, derive one from the ko
# filename's KMI prefix so the resulting zip always advertises an
# update channel. KSU manager skips update detection entirely when
# `updateJson=` is missing from module.prop, which silently breaks
# in-app updates for ad-hoc local builds. To opt out, set
# UPDATE_JSON_URL='' (already the default fallback path); to skip
# entirely, set NO_UPDATE_JSON=1.
if [ -z "$UPDATE_JSON_URL" ] && [ -z "${NO_UPDATE_JSON:-}" ]; then
	KO_BASE=$(basename "$KO_PATH" .ko)
	case "$KO_BASE" in
		android*_pathmask)
			KMI_TAG="${KO_BASE%_pathmask}"
			case "$KMI_TAG" in
				android*-[0-9]*.[0-9]*)
					UPDATE_JSON_URL="https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/${KMI_TAG}.json"
					;;
			esac
			;;
	esac
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEMPLATE_DIR="$REPO_ROOT/ksu-module"
STAGE_DIR="$REPO_ROOT/out/ksu-stage"

case "$KO_PATH" in
/*) ;;
*) KO_PATH="$REPO_ROOT/$KO_PATH" ;;
esac

case "$OUTPUT" in
/*) ;;
*) OUTPUT="$REPO_ROOT/$OUTPUT" ;;
esac

if [ ! -f "$KO_PATH" ]; then
	echo "Missing kernel module: $KO_PATH" >&2
	exit 1
fi

if [ ! -d "$TEMPLATE_DIR" ]; then
	echo "Missing KernelSU template: $TEMPLATE_DIR" >&2
	exit 1
fi

if ! command -v zip >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
	echo "Missing dependency: zip or python3" >&2
	exit 1
fi

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$(dirname -- "$OUTPUT")"

cp -R "$TEMPLATE_DIR"/. "$STAGE_DIR"/
cp "$KO_PATH" "$STAGE_DIR/pathmask.ko"

# Optional procguard companion ko (isolated-process gid-3009 strip).
# Explicit PROCGUARD_KO wins; otherwise auto-detect a sibling of the
# pathmask ko ("<base>_procguard.ko" or plain "procguard.ko"). Skipped
# silently when absent -- service.sh tolerates a missing procguard.ko
# and the WebUI Protection tab then reports it as unavailable.
if [ -z "${PROCGUARD_KO:-}" ]; then
	KO_DIR=$(dirname -- "$KO_PATH")
	KO_BASE=$(basename "$KO_PATH" .ko)
	case "$KO_BASE" in
		*_pathmask)
			CANDIDATE="$KO_DIR/${KO_BASE%_pathmask}_procguard.ko"
			;;
		*)
			CANDIDATE="$KO_DIR/procguard.ko"
			;;
	esac
	if [ -f "$CANDIDATE" ]; then
		PROCGUARD_KO="$CANDIDATE"
	fi
fi
if [ -n "${PROCGUARD_KO:-}" ]; then
	case "$PROCGUARD_KO" in
	/*) ;;
	*) PROCGUARD_KO="$REPO_ROOT/$PROCGUARD_KO" ;;
	esac
	if [ ! -f "$PROCGUARD_KO" ]; then
		echo "Missing procguard kernel module: $PROCGUARD_KO" >&2
		exit 1
	fi
	cp "$PROCGUARD_KO" "$STAGE_DIR/procguard.ko"
fi

if [ -n "$UPDATE_JSON_URL" ]; then
	grep -v '^updateJson=' "$STAGE_DIR/module.prop" > "$STAGE_DIR/module.prop.tmp" || true
	mv "$STAGE_DIR/module.prop.tmp" "$STAGE_DIR/module.prop"
	printf 'updateJson=%s\n' "$UPDATE_JSON_URL" >> "$STAGE_DIR/module.prop"
fi

# `printenv NAME` exits non-zero when NAME is not set, which is the
# only POSIX-safe way to distinguish "explicitly empty" from "unset"
# without `${X+set}` (we can't rely on bash-isms in busybox sh
# environments). The wrapper below prints "Y" when set (any value,
# including empty), "N" otherwise, and is used to gate every conf
# overwrite below.
is_set() {
	if printenv "$1" >/dev/null 2>&1; then return 0; fi
	return 1
}

# Legacy alias: TARGET_PATH (singular) used to be the only knob. If
# it's set and TARGET_PATHS isn't, treat them as equivalent. After
# this normalisation, only TARGET_PATHS is consulted.
if ! is_set TARGET_PATHS && is_set TARGET_PATH; then
	TARGET_PATHS="$TARGET_PATH"
	export TARGET_PATHS
fi

if is_set TARGET_PATHS; then
	printf '%s' "$TARGET_PATHS" | tr ',' '\n' > "$STAGE_DIR/target_path.conf"
fi
if is_set HIDE_DIRENTS; then
	printf '%s' "$HIDE_DIRENTS" > "$STAGE_DIR/hide_dirents.conf"
fi
if is_set ENABLE_SYSCALL_HOOKS; then
	printf '%s' "$ENABLE_SYSCALL_HOOKS" > "$STAGE_DIR/enable_syscall_hooks.conf"
fi
if is_set SYSCALL_HOOKS; then
	printf '%s' "$SYSCALL_HOOKS" > "$STAGE_DIR/syscall_hooks.conf"
fi
if is_set SCOPE_MODE; then
	printf '%s' "$SCOPE_MODE" > "$STAGE_DIR/scope_mode.conf"
fi
if is_set DENY_PACKAGES; then
	printf '%s' "$DENY_PACKAGES" | tr ',' '\n' > "$STAGE_DIR/deny_packages.conf"
fi
if is_set DENY_UIDS; then
	printf '%s' "$DENY_UIDS" | tr ',' '\n' > "$STAGE_DIR/deny_uids.conf"
fi
if is_set ALLOW_PACKAGES; then
	printf '%s' "$ALLOW_PACKAGES" | tr ',' '\n' > "$STAGE_DIR/allow_packages.conf"
fi
if is_set ALLOW_UIDS; then
	printf '%s' "$ALLOW_UIDS" | tr ',' '\n' > "$STAGE_DIR/allow_uids.conf"
fi
if is_set ALLOW_SYSTEM_UIDS; then
	printf '%s' "$ALLOW_SYSTEM_UIDS" | tr ',' '\n' > "$STAGE_DIR/allow_system_uids.conf"
fi
if is_set WAIT_SECONDS; then
	printf '%s' "$WAIT_SECONDS" > "$STAGE_DIR/wait_seconds.conf"
fi

# Drop legacy wait conf files that an old template directory might
# have on disk. They are unused since v2.2.3 (merged into
# wait_seconds.conf) and would only confuse a fresh install.
rm -f "$STAGE_DIR/target_wait_seconds.conf" \
      "$STAGE_DIR/package_wait_seconds.conf" 2>/dev/null || true

chmod 0755 "$STAGE_DIR/service.sh" "$STAGE_DIR/scene-debugfs-watch.sh" "$STAGE_DIR/uninstall.sh"

rm -f "$OUTPUT"
if command -v zip >/dev/null 2>&1; then
	(cd "$STAGE_DIR" && zip -q -r "$OUTPUT" .)
else
	(cd "$STAGE_DIR" && python3 -m zipfile -c "$OUTPUT" .)
fi

echo "Created KernelSU package: $OUTPUT"
echo "Target paths file:        $STAGE_DIR/target_path.conf"
echo "Hide dirents file:        $STAGE_DIR/hide_dirents.conf"
echo "Enable syscall hooks file:$STAGE_DIR/enable_syscall_hooks.conf"
echo "Syscall hooks subset:     $STAGE_DIR/syscall_hooks.conf"
echo "Auto Scene debugfs:       $STAGE_DIR/auto_scene_debugfs.conf"
echo "Scope mode file:          $STAGE_DIR/scope_mode.conf"
echo "Deny packages file:       $STAGE_DIR/deny_packages.conf"
echo "Deny UIDs file:           $STAGE_DIR/deny_uids.conf"
echo "Allow packages file:      $STAGE_DIR/allow_packages.conf"
echo "Allow UIDs file:          $STAGE_DIR/allow_uids.conf"
echo "Allow system UIDs file:   $STAGE_DIR/allow_system_uids.conf"
echo "Wait seconds file:        $STAGE_DIR/wait_seconds.conf"
if [ -n "$UPDATE_JSON_URL" ]; then
	echo "Update JSON: $UPDATE_JSON_URL"
fi
