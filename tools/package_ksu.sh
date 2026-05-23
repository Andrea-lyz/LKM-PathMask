#!/usr/bin/env sh
set -eu

KO_PATH="${1:-kernel/pathmask.ko}"
OUTPUT="${2:-out/pathmask-ksu.zip}"
TARGET_PATHS="${TARGET_PATHS:-${TARGET_PATH:-/dev/cpuset/scene-daemon,/dev/scene,/system_ext/app/SoterService}}"
HIDE_DIRENTS="${HIDE_DIRENTS:-1}"
ENABLE_SYSCALL_HOOKS="${ENABLE_SYSCALL_HOOKS:-0}"
SCOPE_MODE="${SCOPE_MODE:-deny}"
DENY_PACKAGES="${DENY_PACKAGES:-com.chunqiunativecheck,com.eltavine.duckdetector,luna.safe.luna}"
DENY_UIDS="${DENY_UIDS:-}"
WAIT_SECONDS="${WAIT_SECONDS:-60}"
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
printf '%s' "$TARGET_PATHS" | tr ',' '\n' > "$STAGE_DIR/target_path.conf"
printf '%s' "$HIDE_DIRENTS" > "$STAGE_DIR/hide_dirents.conf"
printf '%s' "$ENABLE_SYSCALL_HOOKS" > "$STAGE_DIR/enable_syscall_hooks.conf"
printf '%s' "$SCOPE_MODE" > "$STAGE_DIR/scope_mode.conf"
printf '%s' "$DENY_PACKAGES" | tr ',' '\n' > "$STAGE_DIR/deny_packages.conf"
printf '%s' "$DENY_UIDS" | tr ',' '\n' > "$STAGE_DIR/deny_uids.conf"
printf '%s' "$WAIT_SECONDS" > "$STAGE_DIR/wait_seconds.conf"
rm -f "$STAGE_DIR/target_wait_seconds.conf" "$STAGE_DIR/package_wait_seconds.conf" 2>/dev/null || true
chmod 0755 "$STAGE_DIR/service.sh" "$STAGE_DIR/uninstall.sh"

rm -f "$OUTPUT"
if command -v zip >/dev/null 2>&1; then
	(cd "$STAGE_DIR" && zip -q -r "$OUTPUT" .)
else
	(cd "$STAGE_DIR" && python3 -m zipfile -c "$OUTPUT" .)
fi

echo "Created KernelSU package: $OUTPUT"
echo "Target paths: $TARGET_PATHS"
echo "Hide dirents: $HIDE_DIRENTS"
echo "Enable syscall hooks: $ENABLE_SYSCALL_HOOKS"
echo "Scope mode: $SCOPE_MODE"
echo "Deny packages: $DENY_PACKAGES"
echo "Deny UIDs: $DENY_UIDS"
echo "Wait seconds: $WAIT_SECONDS"
if [ -n "$UPDATE_JSON_URL" ]; then
	echo "Update JSON: $UPDATE_JSON_URL"
fi
