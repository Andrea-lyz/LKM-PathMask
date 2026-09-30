#!/bin/sh
# Deploy the SDK and deps.lst Git dependencies at full pinned commits.
# Existing dirty or mismatched dependency checkouts are preserved and rejected.
set -eu

cd "$(dirname "$0")/.."

fail() {
	echo "fetch-deps: $*" >&2
	exit 1
}

require_commit() {
	[ "${#1}" -eq 40 ] || fail "$2 must use a full 40-character commit SHA"
	case $1 in
	*[!0-9a-f]*) fail "$2 must use a hexadecimal commit SHA" ;;
	esac
}

require_clean_repo() {
	[ -e "$1/.git" ] || fail "$1 exists but is not a Git checkout; left untouched"
	repo_state=$(git -C "$1" status --porcelain --untracked-files=normal) ||
		fail "cannot inspect $1"
	[ -z "$repo_state" ] || fail "$1 has local changes; left untouched"
}

SDKREV=$(cat .sdk-version)
require_commit "$SDKREV" ".sdk-version"

if [ -e .sdk ]; then
	require_clean_repo .sdk
else
	git clone https://github.com/Dere3046/KMSDK.git .sdk
fi

if [ "$(git -C .sdk rev-parse HEAD)" != "$SDKREV" ]; then
	if ! git -C .sdk cat-file -e "$SDKREV^{commit}" 2>/dev/null; then
		git -C .sdk fetch origin "$SDKREV"
	fi
	git -C .sdk checkout --detach "$SDKREV"
fi

# KMSDK skips existing dependency directories. Check both before installation
# (preserve local work) and afterwards (verify newly installed checkouts).
verify_deps() {
	while read -r dep_name dep_rev dep_extra || [ -n "$dep_name" ]; do
		case $dep_name in ''|\#*) continue ;; esac
		case $dep_name in
		*[!a-zA-Z0-9_-]*) fail "invalid dependency name: $dep_name" ;;
		esac
		case $dep_extra in
		''|\#*) ;;
		*) fail "unexpected fields in deps.lst for $dep_name" ;;
		esac
		require_commit "$dep_rev" "deps.lst ($dep_name)"
		dep_dir="deps/$dep_name"
		if [ ! -e "$dep_dir" ]; then
			[ "$1" = allow-missing ] && continue
			fail "$dep_dir was not installed"
		fi
		require_clean_repo "$dep_dir"
		dep_head=$(git -C "$dep_dir" rev-parse HEAD)
		[ "$dep_head" = "$dep_rev" ] ||
			fail "$dep_dir is at $dep_head, expected $dep_rev; left untouched"
	done < deps.lst
}

verify_deps allow-missing
sh .sdk/scripts/sdk install
verify_deps require-all
echo "fetch-deps: all declared dependencies match their pinned commits"
