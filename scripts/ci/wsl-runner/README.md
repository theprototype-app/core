# Self-hosted GPU runner: a throwaway WSL2 distro per job

A GitHub Actions runner for core on a Windows machine with a GPU. Every job gets a fresh copy of a clean WSL2
image (`wsl --import`), runs exactly one job as a just-in-time runner, and the copy is deleted afterwards
(`wsl --unregister`). Only `.github/workflows/battery-gpu.yml` runs on it, only for allowed actors, never for a
fork. Nothing in this folder names a machine: hosts, paths and logins come from a local config file.

| file | where it runs | what it does |
| --- | --- | --- |
| `build-image.sh` | the Windows host's Linux side (any distro with interop) | builds the golden image from a stock Ubuntu 24.04 WSL image; `--refresh` re-copies these scripts into it |
| `provision-image.sh` | inside the build distro, as root | Node, Playwright browsers + OS libraries, the Actions runner (checksums verified), passt, nftables, the non-root runner user, the guard config, `wsl.conf` |
| `pc-job.sh` | the Windows host's Linux side | import a copy -> run one job (or `selftest` / `gpu`) -> unregister; prints `TIMING import= run= unregister= total=` |
| `start-job.sh` | inside the job distro, as root | unmounts the shared `/mnt/wsl` and WSLg, makes the job network namespace, starts the runner as the job user |
| `job-started-hook.sh` | the runner's pre-job hook | refuses the job before its first step unless repository, event, actor, triggering actor, PR head and workflow file are allowed |
| `selftest.sh` | inside the job namespace, as the job user | the isolation checks (prints OK/BAD per check) |
| `gpu-check.cjs` | inside the job namespace, as the job user | WebGL renderer string + frame rate, software vs GPU; optional screenshot |
| `pw-wsl-gpu.cjs` | the job (NODE_OPTIONS) | maps Playwright launches to the GPU path WSL actually has (ANGLE gl-egl over Mesa d3d12) |
| `dispatch.sh` | the machine with the GitHub credential | checks every queued job for the label, mints a JIT config, pipes it over ssh to `pc-job.sh run`, deletes the runner after |

## Why it is built this way

- **One kernel, one network namespace.** WSL2 distros share the VM's kernel, memory, network namespace and
  binfmt_misc table ("Linux distributions running via WSL 2 will share the same network namespace, device tree
  (other than /dev/pts), CPU/Kernel/Memory/Swap, /init binary", learn.microsoft.com/windows/wsl/about). A job
  started plainly would reach every other distro's localhost ports, and a firewall rule it set would apply to all
  of them. So the job runs in its own network namespace, reached out of through `pasta` (user-mode networking: no
  veth, no forwarding, no NAT rule in the shared namespace), with port forwarding off both ways, the gateway not
  mapped to the host loopback, and an nftables policy inside the namespace that drops every private and special
  IPv4 range and all IPv6. Public egress (GitHub, npm, CDNs) stays open.
- **No systemd, ever.** systemd-binfmt.service unregisters every binfmt_misc entry when it stops, and that table
  is shared: stopping a systemd distro takes Windows interop away from every other distro. The build distro gets
  `systemd=false` inside the base tarball before its first boot; the job image keeps it off. The scripts check
  the WSLInterop handler after every stop.
- **Interop and drives off** (`[interop] enabled=false, appendWindowsPath=false`, `[automount] enabled=false`).
  Root inside a distro can undo that, and is root of the shared kernel, so this is depth, not a boundary: the job
  never has root (its own user, no sudo, `no_new_privs`, no capabilities).
- **No standing credential on the runner host.** The dispatcher mints a single-use just-in-time config per job
  (`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`; such a runner "performs at most one job before
  being automatically removed") and hands it over on stdin. No registration token or PAT is ever stored there.
- **Fork code never runs.** See the header of `battery-gpu.yml` for the four layers.
- **Memory.** `.wslconfig` is global to every distro, so one job at a time (`concurrency: gpu-wsl`) and the
  dispatcher waits while the host has less than `TPCI_MIN_FREE_GB` available.
