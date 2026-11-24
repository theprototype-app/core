#!/usr/bin/env bash
# pc-ci-runner — BUILD THE CLEAN IMAGE of the throwaway WSL runner (runs as ROOT inside a freshly imported build distro).
#
#   build-image.sh imports a stock Ubuntu 24.04 WSL image as a build distro, copies this folder to /opt/tpci and runs:
#     env NODE_VERSION=.. NODE_SHA256=.. RUNNER_VERSION=.. RUNNER_SHA256=.. PLAYWRIGHT_VERSION=.. \
#         TPCI_REPO=<owner/repo> TPCI_ACTORS=<login[,login]> TPCI_WORKFLOWS=<file.yml[,..]> bash /opt/tpci/provision-image.sh
#   then exports the result as the golden image. Every job imports a COPY of it and the copy is unregistered after.
#
# What the image holds: Node (checksum-verified tarball), the Playwright browsers + their OS libraries at the
# lockfile's version, the GitHub Actions runner (checksum-verified), passt (the job's user-mode network), nftables,
# a non-root runner user with no sudo, the job-start guard hook, and a wsl.conf with Windows interop and drive
# mounts OFF. Nothing secret: the runner gets a single-use just-in-time config per job, on stdin, at job start.
set -euo pipefail

: "${NODE_VERSION:?}" "${NODE_SHA256:?}" "${RUNNER_VERSION:?}" "${RUNNER_SHA256:?}" "${PLAYWRIGHT_VERSION:?}"
: "${TPCI_REPO:?owner/repo the runner may serve}" "${TPCI_ACTORS:?comma-separated GitHub logins whose runs it may serve}"
: "${TPCI_WORKFLOWS:?comma-separated workflow file names it may run}"
RUNNER_USER=${RUNNER_USER:-ghrunner}
RUNNER_UID=${RUNNER_UID:-4242}
HERE=/opt/tpci

export DEBIAN_FRONTEND=noninteractive
log() { printf '[provision %s] %s\n' "$(date +%T)" "$*"; }

log "apt: base packages"
apt-get update -qq
apt-get -y -qq upgrade > /dev/null
apt-get install -y -qq --no-install-recommends ca-certificates curl git git-lfs jq xz-utils unzip zip openssl \
	nftables iproute2 passt python3-seccomp procps psmisc util-linux mesa-utils libegl1 libgles2 libgl1-mesa-dri > /dev/null

log "node $NODE_VERSION"
tmp=$(mktemp -d)
curl -sSfL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c -
tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1 --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/CHANGELOG.md'
node --version

log "runner user $RUNNER_USER (uid $RUNNER_UID, no sudo, no password)"
id "$RUNNER_USER" > /dev/null 2>&1 || useradd -m -u "$RUNNER_UID" -s /bin/bash "$RUNNER_USER"
passwd -l "$RUNNER_USER" > /dev/null
gpasswd -d "$RUNNER_USER" sudo > /dev/null 2>&1 || true
# the stock image's first-run user setup must not offer a sudo user either
rm -f /etc/sudoers.d/*"$RUNNER_USER"* 2>/dev/null || true

log "playwright $PLAYWRIGHT_VERSION browsers + OS libraries"
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
(cd "$tmp" && npx -y "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium > "$tmp/pw.log" 2>&1) || { tail -40 "$tmp/pw.log"; exit 1; }
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

# the GPU probe (gpu-check.cjs) needs only playwright-core, at the same version as the browsers
mkdir -p "$HERE/gpu-probe" && (cd "$HERE/gpu-probe" && npm init -y > /dev/null && npm i --no-audit --no-fund "playwright-core@$PLAYWRIGHT_VERSION" > /dev/null)

log "actions runner $RUNNER_VERSION"
curl -sSfL "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz" -o "$tmp/runner.tgz"
echo "$RUNNER_SHA256  $tmp/runner.tgz" | sha256sum -c -
rm -rf /opt/actions-runner && mkdir -p /opt/actions-runner
tar -xzf "$tmp/runner.tgz" -C /opt/actions-runner
/opt/actions-runner/bin/installdependencies.sh > /dev/null
# the runner reads .env at start: the job-start guard runs before ANY step of a job (exit != 0 = the job fails unrun)
cat > /opt/actions-runner/.env <<EOF
ACTIONS_RUNNER_HOOK_JOB_STARTED=$HERE/job-started-hook.sh
PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH
GALLIUM_DRIVER=d3d12
LD_LIBRARY_PATH=/usr/lib/wsl/lib
LANG=C.UTF-8
EOF
chown -R "$RUNNER_USER:$RUNNER_USER" /opt/actions-runner
# the hook and the guard config belong to root: the runner user can read, not change them
chown root:root /opt/actions-runner/.env && chmod 644 /opt/actions-runner/.env

log "guard config"
mkdir -p /etc/tpci
printf 'TPCI_REPO=%s\nTPCI_ACTORS=%s\nTPCI_WORKFLOWS=%s\n' "$TPCI_REPO" "$TPCI_ACTORS" "$TPCI_WORKFLOWS" > /etc/tpci/allow.conf
chmod 644 /etc/tpci/allow.conf
chown -R root:root "$HERE" && chmod -R a+rX "$HERE" && chmod 755 "$HERE"/*.sh

log "wsl.conf: no Windows interop, no drive mounts, no systemd, non-root default user"
cat > /etc/wsl.conf <<EOF
# pc-ci-runner throwaway job distro. Windows interop and drive mounts are OFF (root inside could undo
# interop: this is depth, not a boundary; the job never runs as root).
[boot]
systemd=false
[interop]
enabled=false
appendWindowsPath=false
[automount]
enabled=false
mountFsTab=false
[network]
generateHosts=false
generateResolvConf=false
hostname=ci-job
[user]
default=$RUNNER_USER
EOF
# public resolvers: the job's network reaches no private address, the WSL host's resolver included
rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n' > /etc/resolv.conf

# the stock image's first-run (OOBE) and Start-menu hooks: an imported job distro must never prompt
rm -f /etc/wsl-distribution.conf

log "clean up"
apt-get clean
rm -rf /var/lib/apt/lists/* "$tmp" /root/.npm /root/.cache /home/"$RUNNER_USER"/.npm /tmp/* 2>/dev/null || true
log "done: $(du -sh /opt/ms-playwright | cut -f1) browsers, $(du -sh /opt/actions-runner | cut -f1) runner"
