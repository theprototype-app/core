#!/usr/bin/env bash
# pc-ci-runner — IMPORT, RUN ONE THING, UNREGISTER. Runs on a Linux side of the Windows host that can call wsl.exe.
#
#   pc-job.sh run <name>        < JIT config     one runner job in a fresh copy of the golden image
#   pc-job.sh selftest <name>   [< probe.conf]   the isolation self-test instead of a job
#   pc-job.sh gpu <name>                         WebGL renderer string + a frame-rate probe (no runner)
#   pc-job.sh sweep                              unregister every leftover tpci-job-* distro
#
# Env: TPCI_WINROOT / TPCI_LINROOT (the CI folder as Windows and as Linux path). The distro is ALWAYS unregistered
# on the way out (trap), and its folder removed: nothing of a job survives it. Prints a TIMING line:
#   TIMING import=<s> run=<s> unregister=<s> total=<s>
set -euo pipefail
: "${TPCI_WINROOT:?}" "${TPCI_LINROOT:?}"
WSL=${WSL_EXE:-/mnt/c/Windows/System32/wsl.exe}
IMPORT_MODE=${TPCI_IMPORT_MODE:-vhd}   # vhd = wsl --import --vhd (copies the image) | inplace = cp + --import-in-place
# wsl.exe forwards stdin: management calls get /dev/null so they cannot swallow what a job is handed
w() { "$WSL" "$@" < /dev/null 2>&1 | tr -d '\0\r'; return "${PIPESTATUS[0]}"; }
log() { printf '[pc-job %s] %s\n' "$(date +%T)" "$*" >&2; }
# binfmt_misc is kernel-wide in the shared WSL VM: after a distro stops, the WSLInterop handler every other distro
# needs must still be there (a systemd distro's shutdown removes it; the job image has systemd off — this checks)
interop_ok() {
	[ -e /proc/sys/fs/binfmt_misc/WSLInterop ] && return 0
	log "WARNING: the WSLInterop binfmt handler is GONE"
	echo ':WSLInterop:M::MZ::/init:PF' | sudo -n tee /proc/sys/fs/binfmt_misc/register > /dev/null 2>&1 && log "WSLInterop registered again" || log "could not register WSLInterop again"
}
mode=${1:?run|selftest|gpu|sweep}
# wsl.exe translates the caller's cwd: start from a Windows-backed folder, not a distro path
cd "$TPCI_LINROOT"

drop() {
	local n=$1
	w --terminate "$n" > /dev/null 2>&1 || true
	w --unregister "$n" > /dev/null 2>&1 || true
	interop_ok
	rm -rf "${TPCI_LINROOT:?}/jobs/$n"
}

if [ "$mode" = sweep ]; then
	for n in $(w --list --quiet | grep -E '^tpci-job-' || true); do log "sweep $n"; drop "$n"; done
	exit 0
fi

name=${2:?distro name}
case "$name" in tpci-job-*) ;; *) log "job distro names start with tpci-job-"; exit 2 ;; esac
w --list --quiet | grep -qx "$name" && { log "$name already exists"; exit 2; }

t0=$(date +%s.%N)
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
trap 't2=${t2:-$(date +%s.%N)}; drop "$name"; t3=$(date +%s.%N); echo "TIMING import=$(el "$t0" "$t1") run=$(el "$t1" "$t2") unregister=$(el "$t2" "$t3") total=$(el "$t0" "$t3")" >&2' EXIT
t1=$t0
mkdir -p "$TPCI_LINROOT/jobs"
if [ "$IMPORT_MODE" = inplace ]; then
	mkdir -p "$TPCI_LINROOT/jobs/$name"
	cp --sparse=always "$TPCI_LINROOT/image/tpci-golden.vhdx" "$TPCI_LINROOT/jobs/$name/ext4.vhdx"
	w --import-in-place "$name" "$TPCI_WINROOT\\jobs\\$name\\ext4.vhdx" > /dev/null
else
	w --import "$name" "$TPCI_WINROOT\\jobs\\$name" "$TPCI_WINROOT\\image\\tpci-golden.vhdx" --vhd > /dev/null
fi
t1=$(date +%s.%N)
log "imported $name ($IMPORT_MODE)"

set +e
case "$mode" in
	run) "$WSL" -d "$name" -u root -- /opt/tpci/start-job.sh ;;
	selftest)
		# probe.conf on stdin (may be empty); a Windows exe for the interop check comes from TPCI_PROBE_EXE_FROM
		"$WSL" -d "$name" -u root -- sh -c 'cat > /etc/tpci/probe.conf; chmod 644 /etc/tpci/probe.conf'
		if [ -n "${TPCI_PROBE_EXE_FROM:-}" ]; then
			"$WSL" -d "$name" -u root -- sh -c 'cat > /opt/tpci/probe.exe; chmod 755 /opt/tpci/probe.exe; echo PROBE_EXE=/opt/tpci/probe.exe >> /etc/tpci/probe.conf' < "$TPCI_PROBE_EXE_FROM"
		fi
		"$WSL" -d "$name" -u root -- /opt/tpci/start-job.sh --selftest < /dev/null
		;;
	gpu)
		# shot.env on stdin (may be empty): KEY=VALUE lines for one screenshot on the GPU path
		"$WSL" -d "$name" -u root -- sh -c 'cat > /etc/tpci/shot.env'
		"$WSL" -d "$name" -u root -- /opt/tpci/start-job.sh --gpu < /dev/null
		"$WSL" -d "$name" -u root -- sh -c 'cat /tmp/tpci-shot.png 2>/dev/null' > "$TPCI_LINROOT/logs/$name-shot.png" || true
		[ -s "$TPCI_LINROOT/logs/$name-shot.png" ] && log "shot: $TPCI_LINROOT/logs/$name-shot.png" || rm -f "$TPCI_LINROOT/logs/$name-shot.png"
		;;
	*) log "unknown mode $mode"; false ;;
esac
rc=$?
t2=$(date +%s.%N)
set -e
log "$mode rc=$rc"
exit $rc
