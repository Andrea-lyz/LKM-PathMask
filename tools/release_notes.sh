#!/bin/sh
# Print one version's bilingual changelog section for GitHub Releases.
# usage: release_notes.sh [version] [version|rolling]
set -eu
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${1:-$(sed -n 's/^version=//p' "$REPO_ROOT/ksu-module/module.prop" | tr -d '\r')}
MODE=${2:-version}
case "$MODE" in
	version) ;;
	rolling)
		printf '滚动预发布：随 main 或版本标签更新。正式版本请使用 [v%s](https://github.com/Andrea-lyz/LKM-PathMask/releases/tag/v%s)。\n\n' "$VERSION" "$VERSION"
		printf 'Rolling prerelease rebuilt from main or version tags. Stable release: [v%s](https://github.com/Andrea-lyz/LKM-PathMask/releases/tag/v%s).\n\n' "$VERSION" "$VERSION"
		;;
	*) echo "Unknown release notes mode: $MODE" >&2; exit 1 ;;
esac
awk -v title="# PathMask $VERSION" '
	$0 == title { emitting = 1; found = 1 }
	emitting && /^# PathMask / && $0 != title { exit }
	emitting { print }
	END { if (!found) exit 1 }
' "$REPO_ROOT/update/changelog.md"
