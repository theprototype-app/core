#!/usr/bin/env bash
# Rebuild static/basis/basis_transcoder.{js,wasm} WITHOUT eval / new Function.
#
# three.js ships basis_universal's prebuilt transcoder as-is. Its embind glue builds its
# invokers with `new Function(...)`, which our CSP (script-src without 'unsafe-eval')
# blocks, so KTX2 textures never transcode. This script rebuilds the same source with the
# same flags plus -sDYNAMIC_EXECUTION=0 -sEMBIND_AOT=1 (basis_universal's own opt-in
# NO_DYNAMIC_EXECUTION build, commit b15211474d). See static/basis/README.md.
#
# Usage: bash scripts/build-basis-transcoder.sh [--reference] [--out DIR]
#   --reference  build with the stock flags (eval glue) to check the toolchain reproduces
#                three's copy (written to $BASIS_BUILD_DIR/reference unless --out says otherwise).
#   --out DIR    write the two files to DIR (default: static/basis of this checkout).
# Env: EMSDK_DIR (default ~/.local/emsdk), BASIS_BUILD_DIR (default ~/.cache/basis-build).
# Needs git + python3; emsdk is cloned/installed into EMSDK_DIR when missing. No cmake/make:
# the commands below are the ones webgl/transcoder/CMakeLists.txt generates.
set -euo pipefail

# Pinned inputs. Changing either one changes the output: re-run the guard + KTX2 e2e.
EMSCRIPTEN_VERSION="${EMSCRIPTEN_VERSION:-3.1.64}"
BASISU_TAG="${BASISU_TAG:-v1_50_0}"
BASISU_COMMIT="${BASISU_COMMIT:-051ad6d8a64bb95a79e8601c317055fd1782ad3e}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK_DIR="${EMSDK_DIR:-$HOME/.local/emsdk}"
WORK="${BASIS_BUILD_DIR:-$HOME/.cache/basis-build}"
OUT=""
REFERENCE=0
while [ $# -gt 0 ]; do
	case "$1" in
		--reference) REFERENCE=1 ;;
		--out) OUT="$2"; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done
if [ -z "$OUT" ]; then
	if [ "$REFERENCE" = 1 ]; then OUT="$WORK/reference"; else OUT="$ROOT/static/basis"; fi
fi

now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }

# 1. Toolchain
t0=$(now)
if [ ! -d "$EMSDK_DIR" ]; then
	git clone -q https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
if ! "$EMSDK_DIR/emsdk" list 2>/dev/null | grep -E "^\s+\*?\s*$EMSCRIPTEN_VERSION\s.*INSTALLED" -q; then
	"$EMSDK_DIR/emsdk" install "$EMSCRIPTEN_VERSION"
fi
"$EMSDK_DIR/emsdk" activate "$EMSCRIPTEN_VERSION" >/dev/null
# shellcheck disable=SC1091
EMSDK_QUIET=1 source "$EMSDK_DIR/emsdk_env.sh"
echo "toolchain: emcc $(emcc -dumpversion) ready in $(since "$t0") s"

# 2. Source, pinned to the commit three's copy was built from
SRC="$WORK/src-$BASISU_TAG"
if [ ! -d "$SRC/.git" ]; then
	git clone -q --depth 1 --branch "$BASISU_TAG" https://github.com/BinomialLLC/basis_universal.git "$SRC"
fi
got="$(git -C "$SRC" rev-parse HEAD)"
[ "$got" = "$BASISU_COMMIT" ] || { echo "basis_universal $BASISU_TAG is $got, expected $BASISU_COMMIT" >&2; exit 1; }

# 3. Compile + link: the exact commands `emcmake cmake -G Ninja` generates from
# webgl/transcoder/CMakeLists.txt at that commit (CMAKE_CXX_STANDARD 11 -> -std=gnu++11; the
# C file gets no -std). Checked: --reference reproduces three's two files byte for byte.
t1=$(now)
OBJ="$WORK/obj-$EMSCRIPTEN_VERSION"
rm -rf "${OBJ:?}" && mkdir -p "$OBJ"
DEFS=(-DNDEBUG -DBASISD_SUPPORT_UASTC_HDR=1 -DBASISD_SUPPORT_UASTC=1 -DBASISD_SUPPORT_BC7=1
	-DBASISD_SUPPORT_ATC=0 -DBASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=0 -DBASISD_SUPPORT_PVRTC2=0
	-DBASISD_SUPPORT_FXT1=0 -DBASISD_SUPPORT_ETC2_EAC_RG11=0 -DBASISU_SUPPORT_ENCODING=0
	-DBASISD_ENABLE_DEBUG_FLAGS=1 -DBASISD_SUPPORT_KTX2=1 -DBASISD_SUPPORT_KTX2_ZSTD=1)
OPTS=(-O3 -fno-strict-aliasing -I"$SRC/transcoder")
em++ "${DEFS[@]}" "${OPTS[@]}" -std=gnu++11 -c "$SRC/transcoder/basisu_transcoder.cpp" -o "$OBJ/basisu_transcoder.o" &
em++ "${DEFS[@]}" "${OPTS[@]}" -std=gnu++11 -c "$SRC/webgl/transcoder/basis_wrappers.cpp" -o "$OBJ/basis_wrappers.o" &
emcc "${DEFS[@]}" "${OPTS[@]}" -c "$SRC/zstd/zstddeclib.c" -o "$OBJ/zstddeclib.o" &
wait
LINK=(--bind -s ALLOW_MEMORY_GROWTH=1 -O3 -s ASSERTIONS=0 -s MALLOC=emmalloc -s MODULARIZE=1 -s EXPORT_NAME=BASIS)
if [ "$REFERENCE" = 0 ]; then
	LINK+=(-s DYNAMIC_EXECUTION=0 -s EMBIND_AOT=1)
fi
# CMake's link line: flags first, then the objects in SRC_LIST order (the order decides the
# wasm export order, so a glob or a different order does not reproduce three's copy)
em++ "${LINK[@]}" "$OBJ/basisu_transcoder.o" "$OBJ/basis_wrappers.o" "$OBJ/zstddeclib.o" -o "$OBJ/basis_transcoder.js"
echo "compile + link: $(since "$t1") s"

# 4. Check + install
if [ "$REFERENCE" = 0 ] && ! node "$ROOT/scripts/no-eval-scan.cjs" "$OBJ/basis_transcoder.js" >&2; then
	echo "the no-eval build still evaluates strings (above); not installed" >&2
	exit 1
fi
mkdir -p "$OUT"
cp "$OBJ/basis_transcoder.js" "$OBJ/basis_transcoder.wasm" "$OUT/"
(cd "$OUT" && wc -c basis_transcoder.js basis_transcoder.wasm && sha256sum basis_transcoder.js basis_transcoder.wasm)
