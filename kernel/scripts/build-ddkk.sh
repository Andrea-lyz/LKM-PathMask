#!/bin/sh
# local DDK build
# usage: build-ddkk.sh <target>
# targets: android12-5.10 android13-5.10 android13-5.15 android14-5.15
#          android14-6.1 android15-6.6 android16-6.12 android17-6.18
# VER carries the target into ODIR, ko lands in out/<target>/
set -e

TARGET=${1:-android16-6.12}
DDK_RELEASE=${DDK_RELEASE:-20260828}
IMAGE=ghcr.io/ylarod/ddk-min:${TARGET}-${DDK_RELEASE}
SRCDIR=$(cd "$(dirname "$0")/.." && pwd)

docker run --rm \
	-e KDIR=/opt/ddk/kdir/${TARGET} \
	-e CONFIG_KSU=m \
	-e CC=clang \
	-v "$SRCDIR":/src \
	-w /src \
	"$IMAGE" \
	sh -ec 'sh scripts/fetch-deps.sh; make clean VER="$1"; make VER="$1"' sh "$TARGET"

echo "-> ${SRCDIR}/out/${TARGET}"
find "$SRCDIR/out/${TARGET}" -name "*.ko"
