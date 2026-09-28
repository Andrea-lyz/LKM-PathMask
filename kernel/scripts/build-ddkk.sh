#!/bin/sh
# local DDK build
# usage: build-ddkk.sh <target>
# targets: android12-5.10 android13-5.10 android13-5.15 android14-5.15
#          android14-6.1 android15-6.6 android16-6.12
# VER carries the target into ODIR, ko lands in out/<target>/
set -e

TARGET=${1:-android16-6.12}
IMAGE=docker.cnb.cool/ylarod/ddk/ddk-min:${TARGET}
SRCDIR=$(cd "$(dirname "$0")/.." && pwd)

docker run --rm \
	-e KDIR=/opt/ddk/kdir/${TARGET} \
	-v "$SRCDIR":/src \
	-w /src \
	"$IMAGE" \
	sh -c 'make clean 2>/dev/null; make VER="$1"' sh "$TARGET"

echo "-> ${SRCDIR}/out/${TARGET}"
find "$SRCDIR/out/${TARGET}" -name "*.ko"
