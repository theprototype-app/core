#!/usr/bin/env bash
# pc-ci-runner — ONE JOB in a throwaway distro (runs as ROOT; the runner and the job never do).
#
#   wsl.exe -d <job distro> -u root -- /opt/tpci/start-job.sh < <single-use JIT config, one line>
#   wsl.exe -d <job distro> -u root -- /opt/tpci/start-job.sh --selftest   # isolation checks, no runner
#
# WHY A NETWORK NAMESPACE OF ITS OWN. Every WSL2 distro shares ONE network namespace ("Linux distributions running
# via WSL 2 will share the same network namespace", learn.microsoft.com/windows/wsl/about): a job started plainly
# would see every localhost port of the other distros and any nftables rule it set would land in THEIR namespace.
# So the job gets `tpci`, a namespace with its own loopback, reached out of through pasta (user-mode networking:
# nothing is added to the shared namespace — no veth, no forwarding, no NAT rules). Port forwarding is off both
# ways (-t/-u/-T/-U none) and the gateway is not mapped to the host's loopback (--no-map-gw), so the other
# distros' localhost ports are unreachable; nftables INSIDE `tpci` drops every private/special IPv4 range and all
# IPv6, so the LAN and the WSL host are unreachable too. Public egress (GitHub, npm, CDNs) is left open.
#
# Also unmounted in this distro's mount namespace before the job: /mnt/wsl (a tmpfs shared by every distro) and
# WSLg (/mnt/wslg, /tmp/.X11-unix: the shared GUI server). The GPU (/dev/dxg, /usr/lib/wsl/lib) stays.
# Root inside a WSL distro is root of the shared VM kernel, so all of this is DEPTH, not a boundary: the job runs as
# an unprivileged user with no_new_privs and no capabilities, which is what keeps it from undoing any of it.
set -euo pipefail
NS=tpci
RUSER=${RUNNER_USER:-ghrunner}
log() { printf '[start-job %s] %s\n' "$(date +%T)" "$*" >&2; }

BLOCKED4='0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4'

# name resolution the job sees: public resolvers (the WSL host's resolver is a private address the job cannot
# reach) and a minimal hosts file — WSL's generateHosts copies the WINDOWS hosts file in, which is the host's
# business, not the job's, and would point hostnames at a loopback that is not the host's here
write_names() {
	rm -f /etc/resolv.conf
	printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n' > /etc/resolv.conf
	printf '127.0.0.1\tlocalhost\n127.0.1.1\tci-job\n::1\tlocalhost ip6-localhost ip6-loopback\n' > /etc/hosts
	chmod 644 /etc/resolv.conf /etc/hosts
}

isolate_mounts() {
	for m in /tmp/.X11-unix /mnt/wslg /mnt/wsl; do
		if mountpoint -q "$m" 2> /dev/null || grep -q " $m" /proc/self/mounts; then umount -R -l "$m" 2> /dev/null || true; fi
	done
	rm -rf /tmp/.X11-unix 2> /dev/null || true
}

make_netns() {
	ip netns del "$NS" 2> /dev/null || true
	ip netns add "$NS"
	ip -n "$NS" link set lo up
	# the job namespace's own firewall: loaded BEFORE pasta gives it a way out
	ip netns exec "$NS" nft -f - << EOF
table inet tpci {
	set blocked4 { type ipv4_addr; flags interval; elements = { $BLOCKED4 } }
	chain output {
		type filter hook output priority 0; policy drop;
		oifname "lo" accept
		meta nfproto ipv6 drop
		ip daddr @blocked4 drop
		accept
	}
	chain input {
		type filter hook input priority 0; policy accept;
		iifname "lo" accept
		meta nfproto ipv6 drop
		tcp flags & (syn | ack) == syn drop
	}
}
EOF
	# --runas 0: pasta as nobody cannot join a root-owned namespace ("Couldn't switch to pasta namespaces"); it still
	# sandboxes itself (no_new_privs, seccomp, a reduced capability set) — measured, see the STATUS of this lane
	pasta --quiet --netns-only --runas 0 --config-net --ipv4-only --netns "/run/netns/$NS" --ns-ifname eth0 \
		-t none -u none -T none -U none --no-map-gw 2>&1 | grep -v -e 'syslog' -e "nameserver address" >&2 || true
	for _ in $(seq 1 50); do ip -n "$NS" -4 route show default | grep -q . && break; sleep 0.1; done
	ip -n "$NS" -4 route show default | grep -q . || { log "pasta gave the namespace no route"; exit 1; }
}

as_runner() {
	# no capabilities, no setuid escalation, a clean environment, no vsock (no-vsock.py: the netns does not cover it)
	ip netns exec "$NS" setpriv --reuid "$RUSER" --regid "$RUSER" --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
		env -i HOME="/home/$RUSER" USER="$RUSER" LOGNAME="$RUSER" SHELL=/bin/bash LANG=C.UTF-8 \
		PATH=/usr/local/bin:/usr/bin:/bin GALLIUM_DRIVER=d3d12 LD_LIBRARY_PATH=/usr/lib/wsl/lib \
		PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright /usr/bin/python3 -I /opt/tpci/no-vsock.py "$@"
}

[ "$(id -u)" = 0 ] || { log "must run as root"; exit 1; }
write_names
isolate_mounts
make_netns
log "job namespace up: $(ip -n "$NS" -4 -br addr show eth0 | awk '{print $3}')"

if [ "${1:-}" = --selftest ]; then
	as_runner bash /opt/tpci/selftest.sh
	exit $?
fi

if [ "${1:-}" = --gpu ]; then
	# optional one screenshot: /etc/tpci/shot.env may set TPCI_SHOT_URL / TPCI_SHOT_INIT / TPCI_SHOT_WAIT
	shot=()
	if [ -r /etc/tpci/shot.env ]; then
		while IFS= read -r kv; do [ -n "$kv" ] && shot+=("$kv"); done < /etc/tpci/shot.env
		shot+=(TPCI_SHOT_OUT=/tmp/tpci-shot.png)
	fi
	as_runner env "${shot[@]}" node /opt/tpci/gpu-check.cjs
	exit $?
fi

IFS= read -r JIT || true
[ -n "${JIT:-}" ] || { log "no JIT config on stdin"; exit 1; }
log "runner: one job"
set +e
as_runner bash -c 'cd /opt/actions-runner && exec ./run.sh --jitconfig "$1"' _ "$JIT"
rc=$?
set -e
unset JIT
log "runner exited rc=$rc"
exit "$rc"
