#!/bin/sh
# deploy deps through the LKM-SDK at the pinned rev
# .sdk-version pins the SDK, cloned once into .sdk/ (gitignored)
# a rev that is not a commit id falls back to the SDK default branch
set -e

cd "$(dirname "$0")/.."

SDKREV=$(cat .sdk-version)

if [ ! -d .sdk/.git ]; then
	rm -rf .sdk
	git clone git@github.com:Dere3046/KMSDK.git .sdk
fi

case $SDKREV in
[0-9a-f]*)
	git -C .sdk fetch origin 2>/dev/null || true
	git -C .sdk checkout "$SDKREV"
	;;
esac

exec .sdk/scripts/sdk install
