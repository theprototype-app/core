#!/usr/bin/env bash
# pc-ci-runner — THE DISPATCHER. Runs on the machine that holds the GitHub credential (never on the runner host).
#
#   dispatch.sh check    list queued jobs for the runner label with the guard's verdict; mints nothing
#   dispatch.sh once     serve the queued jobs one at a time, then exit
#   dispatch.sh watch    `once` every TPCI_POLL seconds (default 30)
#
# Config: TPCI_CONF (default ~/.config/tpci-runner.conf) — TPCI_HOST (ssh alias of the runner host), TPCI_REPO,
# TPCI_ACTORS, TPCI_WORKFLOWS, TPCI_LABEL, TPCI_MIN_FREE_GB, TPCI_REMOTE_DIR (where pc-job.sh lives there).
#
# Per job: the guard below is checked against EVERY queued job carrying the label (a just-in-time runner takes
# whichever matching job GitHub hands it, so one bad job queued beside a good one means serve nothing) -> the host's
# free memory is checked -> a single-use JIT config is minted HERE (POST .../actions/runners/generate-jitconfig) and
# piped over ssh stdin to pc-job.sh run, which imports a fresh distro, runs the job and unregisters it -> the runner
# registration is deleted if GitHub has not already removed it. No registration token or PAT ever reaches the host.
set -euo pipefail
. "${TPCI_CONF:-$HOME/.config/tpci-runner.conf}"
: "${TPCI_HOST:?}" "${TPCI_REPO:?}" "${TPCI_ACTORS:?}" "${TPCI_WORKFLOWS:?}" "${TPCI_LABEL:?}"
MIN_FREE=${TPCI_MIN_FREE_GB:-14}
REMOTE_DIR=${TPCI_REMOTE_DIR:-tpci-runner}
STATE=${TPCI_STATE:-$HOME/.local/state/tpci}
mkdir -p "$STATE"
log() { printf '[dispatch %s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$STATE/dispatch.log" >&2; }
inlist() { local x; IFS=',' read -ra xs <<< "$2"; for x in "${xs[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

# queued jobs carrying the label: "<run_id> <job_id> <verdict> <why>"
queued() {
	local runs id
	runs=$(gh api "repos/$TPCI_REPO/actions/runs?status=queued&per_page=50" --jq '.workflow_runs[] | [.id, .event, .actor.login, (.triggering_actor.login // .actor.login), (.head_repository.full_name // ""), .path] | @tsv')
	[ -n "$runs" ] || return 0
	while IFS=$'\t' read -r id ev actor tactor head path; do
		gh api "repos/$TPCI_REPO/actions/runs/$id/jobs?filter=latest&per_page=100" \
			--jq ".jobs[] | select(.status == \"queued\" and (.labels | index(\"$TPCI_LABEL\"))) | .id" | while read -r job; do
			why=ok
			case "$ev" in workflow_dispatch | push | pull_request) ;; *) why="event $ev" ;; esac
			inlist "$actor" "$TPCI_ACTORS" || why="actor $actor"
			inlist "$tactor" "$TPCI_ACTORS" || why="triggering actor $tactor"
			[ "$head" = "$TPCI_REPO" ] || why="head repository $head"
			inlist "${path#.github/workflows/}" "$TPCI_WORKFLOWS" || why="workflow $path"
			[ "$why" = ok ] && echo "$id $job ok -" || echo "$id $job refuse $why"
		done
	done <<< "$runs"
}

serve_one() {
	local name jit rid out rc t0
	free=$(ssh "$TPCI_HOST" "awk '/MemAvailable/{print int(\$2/1048576)}' /proc/meminfo")
	if [ "${free:-0}" -lt "$MIN_FREE" ]; then log "host has ${free} GB available (< $MIN_FREE): waiting"; return 1; fi
	name="tpci-job-$(date +%Y%m%d-%H%M%S)"
	out=$(gh api -X POST "repos/$TPCI_REPO/actions/runners/generate-jitconfig" -f name="$name" -F runner_group_id=1 \
		-f 'labels[]=self-hosted' -f 'labels[]=linux' -f 'labels[]=x64' -f "labels[]=$TPCI_LABEL" -f work_folder=_work)
	rid=$(jq -r '.runner.id' <<< "$out")
	jit=$(jq -r '.encoded_jit_config' <<< "$out")
	out=
	log "minted JIT runner $name (id $rid); handing over"
	t0=$(date +%s)
	set +e
	printf '%s\n' "$jit" | ssh "$TPCI_HOST" "set -a; . ~/tpci-runner.conf; set +a; bash ~/$REMOTE_DIR/pc-job.sh run $name" 2>&1 | tee -a "$STATE/$name.log" | grep -E 'TIMING|rc=|guard|Job .* completed|Running job' >&2
	rc=${PIPESTATUS[1]}
	set -e
	jit=
	gh api -X DELETE "repos/$TPCI_REPO/actions/runners/$rid" > /dev/null 2>&1 && log "runner $rid deleted" || log "runner $rid already gone"
	log "$name done rc=$rc in $(($(date +%s) - t0)) s ($(grep -o 'TIMING.*' "$STATE/$name.log" | tail -1))"
	return 0
}

exec 9> "$STATE/dispatch.lock"
flock -n 9 || { log "another dispatcher holds the lock"; exit 0; }

case "${1:-check}" in
	check) queued | sed 's/^/queued: /' ;;
	once | watch)
		while :; do
			list=$(queued)
			if [ -n "$list" ]; then
				if grep -q ' refuse ' <<< "$list"; then
					log "REFUSING to serve: $(grep ' refuse ' <<< "$list" | head -3 | tr '\n' ';')"
				else
					serve_one && continue
				fi
			fi
			[ "${1}" = once ] && break
			sleep "${TPCI_POLL:-30}"
		done
		;;
	*) echo "usage: dispatch.sh check|once|watch" >&2; exit 2 ;;
esac
