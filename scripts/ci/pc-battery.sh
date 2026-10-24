#!/usr/bin/env bash
# deps-auto — THE GPU HALF OF THE DEPENDENCY GATE, PULLED FROM A DESKTOP.
#
# GitHub's runners have no GPU, so deps.yml's battery cannot see a shader that compiles differently or a
# frame that got slower. This script runs on a machine that has one. Nothing on GitHub can reach it and no
# runner of ours is registered (this repo is public: a self-hosted runner would run a stranger's PR), so it
# PULLS: a timer on that machine runs `--poll`, which picks the open PRs into `deps` whose `deps-gate` is
# green and which carry no `pc-battery` status yet, and runs each one:
#
#   1 /kit in every theme, base vs head                   (tests/e2e/tools/kit-diff.cjs)
#   2 the app surfaces, desktop + two phone shapes, base twice (tests/e2e/tools/ab-shots.cjs shoot/diff)
#   3 the level shots, base twice (the noise floor) + head (scripts/perf-levels.cjs SHOTS=1)
#   4 fps on the heaviest games, base/head alternating x2  (scripts/perf-games.cjs)
#
# and posts the commit status `pc-battery` (success | failure, the summary as a secret gist for its link).
# The games and levels are battery.json's `pc` block.
#
# WHO IT RUNS FOR: the PR's head must be a branch of THIS repository (never a fork) and its author
# dependabot[bot] or the account `gh` is logged in as (plus PC_BATTERY_AUTHORS). Anything else is
# refused before a byte of it is checked out — it would be running someone else's code on your desktop.
#
#   scripts/ci/pc-battery.sh <pr-number> [--dry-run]   one PR (--dry-run: say what would happen, post nothing)
#   scripts/ci/pc-battery.sh --poll [--dry-run]        every eligible open PR into deps, oldest first
#
# Environment (all optional; machine-specific values belong in the timer's unit, never in this file):
#   PC_BATTERY_REPO     owner/name                    (default: theprototype-app/core)
#   PC_BATTERY_DIR      work dir: clones, worktrees, evidence (default: ~/.cache/pc-battery)
#   PC_BATTERY_PORT     first of two dev-server ports (default: 5610; head = +1)
#   PC_BATTERY_AUTHORS  extra allowed authors, space-separated
#   PC_BATTERY_WRAP     a command prefix that serialises GPU use with other jobs on the machine, e.g. an
#                       exclusive e2e slot; the measuring part runs inside it (default: none)
#   PC_BATTERY_FPS_MAX  allowed head/base p50 frame-time ratio (default: 1.15)
#   PC_BATTERY_STALE    seconds after which a `pending` status of ours counts as abandoned (default: 10800)
# Needs git, gh (logged in: repo status + gist), node/npm at the repo's .nvmrc, curl, flock.
set -uo pipefail

REPO=${PC_BATTERY_REPO:-theprototype-app/core}
DIR=${PC_BATTERY_DIR:-$HOME/.cache/pc-battery}
PORT=${PC_BATTERY_PORT:-5610}
FPS_MAX=${PC_BATTERY_FPS_MAX:-1.15}
DRY=0
MODE=one
PR=
for a in "$@"; do
	case "$a" in
		--dry-run) DRY=1 ;;
		--poll) MODE=poll ;;
		[0-9]*) PR=$a ;;
		*) echo "usage: pc-battery.sh <pr> [--dry-run] | --poll [--dry-run]" >&2; exit 2 ;;
	esac
done
[ "$MODE" = poll ] || [ -n "$PR" ] || { echo "usage: pc-battery.sh <pr> [--dry-run] | --poll [--dry-run]" >&2; exit 2; }
mkdir -p "$DIR"
log() { echo "[pc-battery $(date +%H:%M:%S)] $*"; }

ME=$(gh api user -q .login) || { echo "gh is not logged in" >&2; exit 1; }
ALLOWED=" dependabot[bot] app/dependabot $ME ${PC_BATTERY_AUTHORS:-} "

# --- the filter: decided from GitHub's metadata, before anything is checked out
# eligible <pr> -> prints "ok <head-sha> <base-ref>" or "no <reason>"
eligible() {
	local row
	row=$(gh pr view "$1" -R "$REPO" --json state,isCrossRepository,headRepository,headRepositoryOwner,author,headRefOid,baseRefName \
		-q '[.state, .isCrossRepository, .headRepositoryOwner.login + "/" + .headRepository.name, .author.login, .headRefOid, .baseRefName] | @tsv') || { echo "no unreadable"; return; }
	local state cross head author sha base
	IFS=$'\t' read -r state cross head author sha base <<<"$row"
	[ "$state" = OPEN ] || { echo "no not open ($state)"; return; }
	[ "$cross" = false ] && [ "$head" = "$REPO" ] || { echo "no head is not a branch of $REPO ($head)"; return; }
	case "$ALLOWED" in *" $author "*) ;; *) echo "no author $author is not allowed"; return ;; esac
	echo "ok $sha $base"
}

# gate_green <sha>: deps.yml's deps-gate concluded success on this commit
gate_green() {
	[ "$(gh api "repos/$REPO/commits/$1/check-runs?check_name=deps-gate" -q '[.check_runs[] | select(.conclusion == "success")] | length')" -gt 0 ]
}
# settled <sha>: a final pc-battery status, or a pending one younger than PC_BATTERY_STALE seconds. An older
# pending one is a run this machine never finished (it slept or rebooted mid-run): run it again.
settled() {
	local row; row=$(gh api "repos/$REPO/commits/$1/statuses" -q '[.[] | select(.context == "pc-battery")][0] | [.state, .updated_at] | @tsv')
	local st at; IFS=$'\t' read -r st at <<<"$row"
	# no status at all reads as an empty row (a lone tab), not as no output
	[ -n "$st" ] || return 1
	[ "$st" != pending ] && return 0
	[ $(($(date +%s) - $(date -d "$at" +%s))) -lt "${PC_BATTERY_STALE:-10800}" ]
}
status() { # <sha> <state> <description> [url]
	[ "$DRY" = 1 ] && { log "would post pc-battery=$2 ($3)"; return; }
	gh api "repos/$REPO/statuses/$1" -f state="$2" -f context=pc-battery -f description="${3:0:139}" ${4:+-f target_url="$4"} > /dev/null
}

# --- the run
run_pr() {
	local pr=$1 sha=$2 base=$3
	local W="$DIR/runs/$pr-${sha:0:7}" C="$DIR/core"
	log "PR #$pr head ${sha:0:7} base $base"
	[ "$DRY" = 1 ] && { log "would run the GPU battery on #$pr"; return 0; }
	status "$sha" pending "Running on the desktop GPU"
	rm -rf "$W"; mkdir -p "$W"
	[ -d "$C/.git" ] || git clone -q "https://github.com/$REPO.git" "$C"
	git -C "$C" fetch -q origin "+refs/heads/$base:refs/remotes/origin/$base" "+refs/pull/$pr/head:refs/pc-battery/$pr" || return 1
	[ "$(git -C "$C" rev-parse "refs/pc-battery/$pr")" = "$sha" ] || { log "head moved since the check: next poll"; return 1; }
	local mb; mb=$(git -C "$C" merge-base "origin/$base" "$sha")
	for side in base head; do
		git -C "$C" worktree remove --force "$DIR/$side" 2>/dev/null; rm -rf "${DIR:?}/$side"
	done
	git -C "$C" worktree add -q --detach "$DIR/base" "$mb" && git -C "$C" worktree add -q --detach "$DIR/head" "$sha" || return 1
	for side in base head; do
		(cd "$DIR/$side" && npm ci --no-audit --no-fund > "$W/npm-$side.log" 2>&1 && npm run certs > /dev/null 2>&1) || { log "npm ci failed on $side"; return 1; }
	done
	(cd "$DIR/head" && npx playwright install chromium > "$W/playwright.log" 2>&1)
	# the sibling content at the refs the head's battery pins
	local B="$DIR/head/tests/e2e/battery.json"
	for sib in scenes modules; do
		local repo ref; repo=$(node -p "require('$B').refs.$sib.repo"); ref=$(node -p "require('$B').refs.$sib.ref")
		[ -d "$DIR/$sib/.git" ] || git clone -q "https://github.com/$repo.git" "$DIR/$sib"
		git -C "$DIR/$sib" fetch -q origin && git -C "$DIR/$sib" checkout -q --detach "$ref" || return 1
	done
	(cd "$DIR/modules" && npm ci --no-audit --no-fund > "$W/npm-modules.log" 2>&1 && node scripts/pack.cjs --all --force > "$W/pack.log" 2>&1) || { log "module pack failed"; return 1; }
	local games levels; games=$(node -p "require('$B').pc.games.join(',')"); levels=$(node -p "require('$B').pc.levels.join(',')")

	# servers: base on PORT, head on PORT+1, started one after the other (a cold boot is the slow part)
	local pids=()
	# exec'd, so $! IS the server (a session leader: one kill takes vite with it), and without fd 9 — a server
	# holding the lock's descriptor would keep every later poll out
	serve() { (cd "$1" && exec setsid npm run dev -- --port "$2" --strictPort --host localhost > "$W/dev-$2.log" 2>&1 9>&-) &
		pids+=("$!")
		for _ in $(seq 1 120); do curl -sk --max-time 300 -o /dev/null "https://localhost:$2/" && break; sleep 2; done
		curl -sk --max-time 300 -o /dev/null "https://localhost:$2/"; curl -sk --max-time 300 -o /dev/null "https://localhost:$2/kit"; }
	stop_servers() { for p in "${pids[@]}"; do kill -- -"$p" 2>/dev/null; done; }
	trap stop_servers RETURN
	serve "$DIR/base" "$PORT"; serve "$DIR/head" $((PORT + 1))
	local UB="https://localhost:$PORT/" UH="https://localhost:$((PORT + 1))/"

	# every probe runs from the HEAD tree against both URLs, so only the app differs
	cat > "$W/measure.sh" <<EOF
cd "$DIR/head"
export PERF_SCENES_DIR="$DIR/scenes" PERF_MODULES_DIR="$DIR/modules" E2E_NO_PERF_OFFER=1
node tests/e2e/tools/kit-diff.cjs shoot $UB "$W/kit/base" && node tests/e2e/tools/kit-diff.cjs shoot $UH "$W/kit/head"
node tests/e2e/tools/kit-diff.cjs diff "$W/kit/base" "$W/kit/head" "$W/kit/diff"; echo "kit rc=\$?" >> "$W/rc.txt"
node tests/e2e/tools/ab-shots.cjs shoot $UB "$W/surf/base" && node tests/e2e/tools/ab-shots.cjs shoot $UH "$W/surf/head" && node tests/e2e/tools/ab-shots.cjs shoot $UB "$W/surf/base2"
node tests/e2e/tools/ab-shots.cjs diff "$W/surf/base" "$W/surf/head" "$W/surf/diff" --noise "$W/surf/base2"; echo "surfaces rc=\$?" >> "$W/rc.txt"
for t in base1:$UB head:$UH base2:$UB; do
  SHOTS=1 APP_URL=\${t#*:} node scripts/perf-levels.cjs --dir "$DIR/scenes" --only $levels --label ab --out "$W/lvl/\${t%%:*}" > "$W/lvl-\${t%%:*}.log" 2>&1
done
# a 3D frame of an animated level: identical apps measured up to 0.9 % apart (castle courtyard VR, flags and
# speckle); a shader or colour change moves far more of the frame, so 2 % is the least that means anything
AB_MAX=0.02 node tests/e2e/tools/ab-shots.cjs diff "$W/lvl/base1" "$W/lvl/head" "$W/lvl/diff" --noise "$W/lvl/base2"; echo "levels rc=\$?" >> "$W/rc.txt"
for i in 1 2; do for t in head:$UH base:$UB; do
  APP_URL=\${t#*:} node scripts/perf-games.cjs --only $games --label \${t%%:*}-\$i --out "$W/fps" > "$W/fps-\${t%%:*}-\$i.log" 2>&1
done; done
EOF
	: > "$W/rc.txt"
	${PC_BATTERY_WRAP:-} bash "$W/measure.sh" > "$W/measure.log" 2>&1
	stop_servers; trap - RETURN

	# fps: same scene (calls / triangles within 2 %) and no slower than FPS_MAX x the slower base run
	node - "$W/fps" "$FPS_MAX" > "$W/fps.md" <<'EOF'
const fs = require('fs'); const [dir, max] = [process.argv[2], Number(process.argv[3])];
const read = (l) => { try { return JSON.parse(fs.readFileSync(`${dir}/perf-${l}.json`, 'utf8')).rows; } catch { return []; } };
const runs = { base: [read('base-1'), read('base-2')], head: [read('head-1'), read('head-2')] };
const by = (rows, slug) => rows.find((r) => r.slug === slug);
const slugs = [...new Set([...runs.base[0], ...runs.head[0]].map((r) => r.slug))];
let bad = 0; const out = ['| game | calls base→head | tris base→head | p50 ms base (max) → head (min) | verdict |', '|---|---:|---:|---:|---|'];
for (const s of slugs) {
  const b = runs.base.map((r) => by(r, s)).filter(Boolean); const h = runs.head.map((r) => by(r, s)).filter(Boolean);
  if (!b.length || !h.length) { bad++; out.push(`| ${s} | – | – | – | **missing run** |`); continue; }
  // the head inside the base runs' own range, widened: calls 2 % (or 2), triangles 5 % (animated meshes move)
  const within = (key, f) => { const v = b.map((r) => r[key]); const lo = Math.min(...v), hi = Math.max(...v), tol = Math.max(2, f * hi);
    return h.some((r) => r[key] >= lo - tol && r[key] <= hi + tol); };
  const bp = Math.max(...b.map((r) => r.p50)), hp = Math.min(...h.map((r) => r.p50));
  const scene = within('medianCalls', 0.02) && within('medianTriangles', 0.05);
  const ok = scene && hp <= bp * max; if (!ok) bad++;
  out.push(`| ${s} | ${b[0].medianCalls}→${h[0].medianCalls} | ${b[0].medianTriangles}→${h[0].medianTriangles} | ${bp.toFixed(1)} → ${hp.toFixed(1)} | ${ok ? 'ok' : scene ? '**slower**' : '**scene changed**'} |`);
}
console.log(out.join('\n')); fs.writeFileSync(`${dir}/verdict`, bad ? 'fail' : 'ok');
EOF
	local fps; fps=$(cat "$W/fps/verdict" 2>/dev/null || echo fail); echo "fps rc=$([ "$fps" = ok ] && echo 0 || echo 1)" >> "$W/rc.txt"

	# the summary: numbers only (no host, path or user names; it is public through the status link)
	local fails; fails=$(grep -c 'rc=[1-9]' "$W/rc.txt"); local rcs; rcs=$(tr '\n' ' ' < "$W/rc.txt")
	{
		echo "# pc-battery — PR #$pr at ${sha:0:7} vs ${mb:0:7} ($base)"
		echo; echo "Desktop GPU. $rcs"; echo
		echo "## /kit"; cat "$W/kit/diff/report.md" 2>/dev/null || echo "(no report)"; echo
		echo "## App surfaces"; cat "$W/surf/diff/report.md" 2>/dev/null || echo "(no report)"; echo
		echo "## Level shots (base twice = the noise floor)"; cat "$W/lvl/diff/report.md" 2>/dev/null || echo "(no report)"; echo
		echo "## Frame time (perf-games, base/head alternating x2)"; cat "$W/fps.md"
	} > "$W/summary.md"
	local url; url=$(gh gist create -d "pc-battery $REPO#$pr ${sha:0:7}" "$W/summary.md" 2>/dev/null | tail -1)
	if [ "$fails" = 0 ]; then
		status "$sha" success "Desktop GPU: kit, surfaces, levels and fps match the base" "$url"
	else
		status "$sha" failure "Desktop GPU: $rcs" "$url"
	fi
	log "PR #$pr: $rcs -> ${url:-no gist}"
	return 0
}

exec 9> "$DIR/lock"
flock -n 9 || { log "another pc-battery run holds $DIR/lock"; exit 0; }

if [ "$MODE" = one ]; then
	read -r verdict sha base <<<"$(eligible "$PR")"
	[ "$verdict" = ok ] || { log "PR #$PR refused: $sha $base"; exit 3; }
	run_pr "$PR" "$sha" "$base"
	exit $?
fi

# --poll: open PRs into deps, oldest first, green gate, no pc-battery status yet
for pr in $(gh pr list -R "$REPO" --base deps --state open --json number -q 'sort_by(.number) | .[].number'); do
	read -r verdict sha base <<<"$(eligible "$pr")"
	if [ "$verdict" != ok ]; then log "#$pr skipped: $sha $base"; continue; fi
	settled "$sha" && continue
	gate_green "$sha" || { log "#$pr: deps-gate not green on ${sha:0:7} (yet)"; continue; }
	run_pr "$pr" "$sha" "$base"
done
