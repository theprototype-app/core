#!/usr/bin/python3 -I
# pc-ci-runner — run a command with NO WAY TO THE WINDOWS HOST OVER VSOCK (start-job.sh wraps the runner in it).
#
# A network namespace does not cover AF_VSOCK: from inside the job namespace, as the unprivileged job user, connects
# to the host (CID 2) on WSL's own service ports succeeded (measured 24 Nov: 50000, 50001, 50003, 50005). Those are
# WSL's control channels to Windows, a path around "interop off". This seccomp filter, inherited by every child,
# refuses socket()/socketpair() for AF_VSOCK (EAFNOSUPPORT) and io_uring_setup (EPERM: io_uring can create sockets
# without the socket syscall; libuv and Chromium fall back). Syscalls of any other ABI (32-bit) are killed, which is
# libseccomp's default bad-arch action, so socketcall() cannot route around the rule. Needs no_new_privs (set by
# start-job.sh's setpriv before this runs).
import errno, os, sys
import seccomp

AF_VSOCK = 40
f = seccomp.SyscallFilter(seccomp.ALLOW)
for call in ('socket', 'socketpair'):
    f.add_rule(seccomp.ERRNO(errno.EAFNOSUPPORT), call, seccomp.Arg(0, seccomp.EQ, AF_VSOCK))
f.add_rule(seccomp.ERRNO(errno.EPERM), 'io_uring_setup')
f.load()
os.execvp(sys.argv[1], sys.argv[1:])
