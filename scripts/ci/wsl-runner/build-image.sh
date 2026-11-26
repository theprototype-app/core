#!/usr/bin/env bash
# pc-ci-runner — BUILD THE GOLDEN IMAGE. Runs on a Linux side of the Windows host that can call wsl.exe (any WSL
# distro with interop on); the image itself has interop OFF.
#
#   TPCI_WINROOT='X:\wsl-ci' TPCI_LINROOT=/mnt/x/wsl-ci TPCI_BASE=<base .wsl/.tar.gz under base\> \
#   TPCI_REPO=<owner/repo> TPCI_ACTORS=<login,..> TPCI_WORKFLOWS=<file.yml,..> \
#   NODE_VERSION=.. NODE_SHA256=.. RUNNER_VERSION=.. RUNNER_SHA256=.. PLAYWRIGHT_VERSION=.. \
#     bash build-image.sh             # full build from the stock base
#     bash build-image.sh --refresh   # golden image + this folder's current scripts
#
# Steps: import the stock base as a build distro -> copy this folder to /opt/tpci -> provision-image.sh as root ->
# export the distro as <root>\image\tpci-golden.vhdx (+ .tar fallback) -> unregister the build distro.
# Every machine-specific value comes from the environment: nothing about the host lives in this file.
set -euo pipefail
: "${TPCI_WINROOT:?Windows path of the CI root}" "${TPCI_LINROOT:?the same folder as seen from here}" "${TPCI_BASE:?base image file name}"
WSL=${WSL_EXE:-/mnt/c/Windows/System32/wsl.exe}
HERE=$(cd "$(dirname "$0")" && pwd)
BUILD=${TPCI_BUILD_NAME:-tpci-build}
# wsl.exe forwards stdin: management calls get /dev/null so they cannot swallow what a job is handed
w() { "$WSL" "$@" < /dev/null 2>&1 | tr -d '\0\r'; return "${PIPESTATUS[0]}"; }
log() { printf '[build-image %s] %s\n' "$(date +%T)" "$*"; }
# after every distro stop: the WSLInterop handler must still be registered (see THE BUILD DISTRO MUST NEVER BOOT
# SYSTEMD below); if it is gone, say so loudly and put it back when we may (sudo without a password)
interop_ok() {
	[ -e /proc/sys/fs/binfmt_misc/WSLInterop ] && return 0
	log "WARNING: the WSLInterop binfmt handler is GONE (other distros cannot start Windows programs)"
	echo ':WSLInterop:M::MZ::/init:PF' | sudo -n tee /proc/sys/fs/binfmt_misc/register > /dev/null 2>&1 && log "WSLInterop registered again" || log "could not register it: run as root: echo ':WSLInterop:M::MZ::/init:PF' > /proc/sys/fs/binfmt_misc/register"
}

cd "$TPCI_LINROOT"   # wsl.exe translates the caller's cwd: start from a Windows-backed folder
if w --list --quiet | grep -qx "$BUILD"; then log "stale $BUILD: unregistering"; w --unregister "$BUILD"; fi
t0=$(date +%s)
if [ "${1:-}" = --refresh ]; then
	# only this folder's scripts change: import the golden image, replace /opt/tpci/*.sh|*.cjs, export again (~1 min)
	log "refresh: import golden"
	w --import "$BUILD" "$TPCI_WINROOT\\build" "$TPCI_WINROOT\\image\\tpci-golden.vhdx" --vhd
	trap 'log "cleanup: unregister $BUILD"; w --unregister "$BUILD" > /dev/null || true; interop_ok' EXIT
	tar -C "$HERE" -cf - --exclude='*.md' . | "$WSL" -d "$BUILD" -u root -- sh -c 'tar -xf - -C /opt/tpci --no-same-owner && chown -R root:root /opt/tpci && chmod -R a+rX /opt/tpci && chmod 755 /opt/tpci/*.sh'
	# TPCI_REFRESH_APT="pkg ..": packages a script change needs, until the next full build carries them
	if [ -n "${TPCI_REFRESH_APT:-}" ]; then
		"$WSL" -d "$BUILD" -u root -- sh -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $TPCI_REFRESH_APT > /dev/null && apt-get clean && rm -rf /var/lib/apt/lists/*" < /dev/null
	fi
else
# THE BUILD DISTRO MUST NEVER BOOT SYSTEMD. binfmt_misc is one kernel-wide table in the shared WSL VM, and
# systemd-binfmt.service's ExecStop unregisters EVERY entry in it — stopping a systemd distro removes the
# WSLInterop handler of every other distro (measured 24 Nov: the other distros' wsl.exe/powershell.exe died with
# "Exec format error" until it was registered again). The stock image ships systemd=true, so its wsl.conf is
# replaced IN THE TARBALL, before the first boot. (Header-level rewrite: no root, owners and modes kept.)
nosd="${TPCI_BASE%.*}.nosystemd.tar"
if [ ! -s "$TPCI_LINROOT/base/$nosd" ]; then
	log "base without systemd: $nosd"
	python3 - "$TPCI_LINROOT/base/$TPCI_BASE" "$TPCI_LINROOT/base/$nosd.part" << 'PY'
import io, sys, tarfile
src, dst = sys.argv[1], sys.argv[2]
conf = b"[boot]\nsystemd=false\n[interop]\nenabled=false\nappendWindowsPath=false\n[automount]\nenabled=false\n"
with tarfile.open(src, "r:*") as tin, tarfile.open(dst, "w", format=tarfile.PAX_FORMAT) as tout:
    seen = False
    for m in tin:
        n = m.name.lstrip("./")
        if n == "etc/wsl-distribution.conf":
            continue
        if n == "etc/wsl.conf":
            m.size = len(conf); tout.addfile(m, io.BytesIO(conf)); seen = True
            continue
        tout.addfile(m, tin.extractfile(m) if m.isreg() else None)
    if not seen:
        t = tarfile.TarInfo("etc/wsl.conf"); t.size = len(conf); t.mode = 0o644; tout.addfile(t, io.BytesIO(conf))
PY
	mv "$TPCI_LINROOT/base/$nosd.part" "$TPCI_LINROOT/base/$nosd"
fi
log "import base $nosd"
w --import "$BUILD" "$TPCI_WINROOT\\build" "$TPCI_WINROOT\\base\\$nosd" --version 2
interop_ok
trap 'log "cleanup: unregister $BUILD"; w --unregister "$BUILD" > /dev/null || true; interop_ok' EXIT

log "copy scripts to /opt/tpci"
tar -C "$HERE" -cf - --exclude='*.md' . | "$WSL" -d "$BUILD" -u root -- sh -c 'rm -rf /opt/tpci && mkdir -p /opt/tpci && tar -xf - -C /opt/tpci'

log "provision"
"$WSL" -d "$BUILD" -u root -- env \
	NODE_VERSION="$NODE_VERSION" NODE_SHA256="$NODE_SHA256" RUNNER_VERSION="$RUNNER_VERSION" RUNNER_SHA256="$RUNNER_SHA256" \
	PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" TPCI_REPO="$TPCI_REPO" TPCI_ACTORS="$TPCI_ACTORS" TPCI_WORKFLOWS="$TPCI_WORKFLOWS" \
	bash /opt/tpci/provision-image.sh
fi

log "export"
# `wsl --export --format vhd` refuses with ERROR_SHARING_VIOLATION here even for a stopped distro, so the golden
# image is a Windows-side COPY of the stopped build distro's own disk (~3 s on NVMe; the same copy through the 9p
# drive mount takes a minute).
"$WSL" -d "$BUILD" -u root -- sync < /dev/null
w --terminate "$BUILD"
interop_ok
PS=${PS_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}
mkdir -p "$TPCI_LINROOT/image"
"$PS" -NoProfile -NonInteractive -Command "Copy-Item -Force '$TPCI_WINROOT\\build\\ext4.vhdx' '$TPCI_WINROOT\\image\\tpci-golden.new.vhdx'; Move-Item -Force '$TPCI_WINROOT\\image\\tpci-golden.new.vhdx' '$TPCI_WINROOT\\image\\tpci-golden.vhdx'; (Get-FileHash -Algorithm SHA256 '$TPCI_WINROOT\\image\\tpci-golden.vhdx').Hash.Substring(0,16)" < /dev/null | tr -d '\r' > "$TPCI_LINROOT/image/tpci-golden.id"
[ -s "$TPCI_LINROOT/image/tpci-golden.id" ] || { log "golden copy failed"; exit 1; }
log "golden image $(du -h "$TPCI_LINROOT/image/tpci-golden.vhdx" | cut -f1), id $(cat "$TPCI_LINROOT/image/tpci-golden.id"), $(($(date +%s) - t0)) s"
