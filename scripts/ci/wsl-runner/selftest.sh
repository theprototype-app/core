#!/usr/bin/env bash
# pc-ci-runner — ISOLATION SELF-TEST, run AS THE JOB USER inside the job namespace (start-job.sh --selftest).
# Prints one line per check: "OK  <what>" when the job is held where it should be, "BAD <what>" when not.
# Exit 0 only when every check is OK.
#
# Host-specific targets are NOT in this file: /etc/tpci/probe.conf (written per run by whoever runs the test) may set
#   DENY_TCP="host:port host:port ..."   addresses that must be unreachable (the LAN, other machines, the WSL host)
#   LOCAL_TCP="port port ..."            ports other distros listen on at localhost (must not be reachable)
#   PROBE_EXE=/path                      a Windows .exe copied in, which must NOT run (interop off)
# Public egress that must work is fixed: GitHub, npm, the jsDelivr CDN.
set -u
bad=0
ok() { echo "OK  $*"; }
no() { echo "BAD $*"; bad=1; }
[ -r /etc/tpci/probe.conf ] && . /etc/tpci/probe.conf
: "${DENY_TCP:=}" "${LOCAL_TCP:=}" "${PROBE_EXE:=}"

tcp() { timeout "${2:-4}" bash -c "exec 3<>/dev/tcp/${1%:*}/${1##*:}" 2> /dev/null; }

# who we are
[ "$(id -u)" != 0 ] && ok "not root (uid $(id -u))" || no "running as root"
grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && ok "no_new_privs set" || no "no_new_privs not set"
grep -q '^CapEff:[[:space:]]*0000000000000000' /proc/self/status && ok "no effective capabilities" || no "has capabilities"
command -v sudo > /dev/null && sudo -n true 2> /dev/null && no "sudo works" || ok "no sudo"

# Windows reach
awk '$2 ~ "^/mnt/"' /proc/self/mounts | grep -q . && no "mounts under /mnt: $(awk '$2 ~ "^/mnt/" {print $2}' /proc/self/mounts | tr '\n' ' ')" || ok "nothing mounted under /mnt (no Windows drives)"
grep -qE ' /mnt/wsl | /mnt/wslg ' /proc/self/mounts && no "/mnt/wsl or /mnt/wslg mounted" || ok "/mnt/wsl + WSLg not mounted"
[ -S /tmp/.X11-unix/X0 ] && no "WSLg X socket present" || ok "no WSLg X socket"
echo "$PATH" | grep -qi '/mnt/c' && no "Windows PATH appended" || ok "no Windows PATH"
if [ -n "$PROBE_EXE" ] && [ -f "$PROBE_EXE" ]; then
	out=$(timeout 10 "$PROBE_EXE" 2>&1); rc=$?
	[ $rc -ne 0 ] && ok "Windows .exe refused (rc $rc: $(echo "$out" | head -1 | cut -c1-60))" || no "Windows .exe RAN: $(echo "$out" | head -1)"
fi

# vsock to the Windows host (not covered by the network namespace): WSL's own service ports must be refused
v=$(python3 -c '
import socket, errno
out = []
for p in (50000, 50001, 50002, 50003, 50004, 50005):
    try:
        s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); s.settimeout(1.5); s.connect((2, p)); out.append("%d:CONNECTED" % p)
    except OSError as e:
        out.append("%d:%s" % (p, errno.errorcode.get(e.errno, "timeout") if e.errno else "timeout"))
print(" ".join(out))' 2>&1)
echo "$v" | grep -q CONNECTED && no "vsock to the host: $v" || ok "no vsock to the host ($v)"

# the shared VM: other distros' disks, processes
for d in /dev/sd?; do [ -e "$d" ] || continue; head -c1 "$d" > /dev/null 2>&1 && no "can read block device $d" || ok "cannot read $d"; done
[ -r /dev/dxg ] && [ -w /dev/dxg ] && ok "GPU /dev/dxg usable" || no "no GPU access (/dev/dxg)"
n=$(ps -e --no-headers | wc -l); ok "sees $n processes (own PID namespace)"; [ "$n" -lt 60 ] || no "sees $n processes"

# egress that must work
getent hosts github.com > /dev/null && ok "DNS resolves github.com" || no "DNS does not resolve"
for u in https://github.com https://api.github.com https://registry.npmjs.org/ https://cdn.jsdelivr.net/ https://nodejs.org/dist/; do
	code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$u"); [ "${code:-000}" != 000 ] && ok "reaches $u ($code)" || no "cannot reach $u"
done

# what must be unreachable
for t in $DENY_TCP; do tcp "$t" && no "REACHES $t" || ok "cannot reach $t"; done
for p in $LOCAL_TCP; do tcp "127.0.0.1:$p" 2 && no "REACHES localhost:$p" || ok "localhost:$p is not the other distros'"; done
ip -6 route 2> /dev/null | grep -q default && no "has an IPv6 route" || ok "no IPv6 route"
exit $bad
