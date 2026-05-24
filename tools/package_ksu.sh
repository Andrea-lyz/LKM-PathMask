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
#   SCOPE_MODE      "global" or "deny"
#   DENY_PACKAGES   comma-separated package names
#   DENY_UIDS       comma-separated UIDs
#   WAIT_SECONDS    integer seconds
#   UPDATE_JSON_URL absolute https URL appended to module.prop
set -eu

KO_PATH="${1:-kernel/pathmask.ko}"
OUTPUT="${2:-out/pathmask-ksu.zip}"
UPDATE_JSON_URL="${UPDATE_JSON_URL:-}"

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
if is_set WAIT_SECONDS; then
	printf '%s' "$WAIT_SECONDS" > "$STAGE_DIR/wait_seconds.conf"
fi

# Drop legacy wait conf files that an old template directory might
# have on disk. They are unused since v2.2.3 (merged into
# wait_seconds.conf) and would only confuse a fresh install.
rm -f "$STAGE_DIR/target_wait_seconds.conf" \
      "$STAGE_DIR/package_wait_seconds.conf" 2>/dev/null || true

chmod 0755 "$STAGE_DIR/service.sh" "$STAGE_DIR/uninstall.sh"

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
echo "Scope mode file:          $STAGE_DIR/scope_mode.conf"
echo "Deny packages file:       $STAGE_DIR/deny_packages.conf"
echo "Deny UIDs file:           $STAGE_DIR/deny_uids.conf"
echo "Wait seconds file:        $STAGE_DIR/wait_seconds.conf"
if [ -n "$UPDATE_JSON_URL" ]; then
	echo "Update JSON: $UPDATE_JSON_URL"
fi
