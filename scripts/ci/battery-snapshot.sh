#!/usr/bin/env bash
# battery-snapshot.sh <tag> <dir> — a tree of a release tag to run the desk battery's baseline on.
#
# `git archive <tag>` alone is NOT enough, and the difference is silent: MEASURED (pipeline-1, 2026-10-24) a v1.42.0
# archive without the gitignored `.env` booted on the public PeerJS cloud instead of the self-hosted signaling box,
# and every two-peer suite failed at "connect: could not fill the peer id" on the PC slot while the pages would not
# boot at all on the Deck -- 67 of 228 suites red for a reason no integrator's union shares. So the snapshot takes
# this checkout's `.env` and `certs/localhost.*` too (the dev server's TLS), and the desk tool from THIS tree
# (a tag older than it has no scripts/ci/battery-desk.cjs). node_modules: a pc slot installs it by lockfile; for a
# local run, `npm ci` in <dir> (or hard-link a checkout's whose package-lock.json is identical).
set -euo pipefail
tag="${1:?usage: battery-snapshot.sh <tag> <dir>}"; dir="${2:?usage: battery-snapshot.sh <tag> <dir>}"
here="$(cd "$(dirname "$0")/../.." && pwd)"
[ ! -e "$dir" ] || [ -z "$(ls -A "$dir")" ] || { echo "battery-snapshot: $dir is not empty" >&2; exit 2; }
mkdir -p "$dir"
git -C "$here" archive "$tag" | tar -x -C "$dir"
for f in .env certs/localhost.crt certs/localhost.key; do
  if [ -f "$here/$f" ]; then mkdir -p "$dir/$(dirname "$f")"; cp "$here/$f" "$dir/$f"; else echo "battery-snapshot: no $f in $here (the run may differ from a lane's)" >&2; fi
done
mkdir -p "$dir/scripts/ci" "$dir/tests/e2e"
cp "$here/scripts/ci/battery-desk.cjs" "$here/scripts/ci/battery.cjs" "$dir/scripts/ci/"
cp "$here/tests/e2e/battery.json" "$dir/tests/e2e/"
if git -C "$here" diff --quiet "$tag" HEAD -- package-lock.json; then lock=same; else lock=differs; fi
echo "$tag $(git -C "$here" rev-parse --short "$tag^{commit}") (package-lock vs this tree: $lock)" > "$dir/.snap"
echo "battery-snapshot: $dir = $tag + .env + certs + the desk tool; run it with BATTERY_COMMIT=$tag"
