#!/usr/bin/env bash
# pc-ci-runner — THE RUNNER-SIDE GUARD. The runner runs this before ANY step of a job (ACTIONS_RUNNER_HOOK_JOB_STARTED
# in the runner's .env); a non-zero exit fails the job unrun ("the job will not run and will be marked as failed",
# docs.github.com .../self-hosted-runners/run-scripts).
#
# WHY HERE AND NOT ONLY IN THE WORKFLOW: a pull_request run uses the workflow file of the PR's own merge ref, so a
# fork can rewrite any `if:` guard and any `runs-on:`. This script lives in the image, owned by root, outside
# anything a job can change. The workflow's `if:` stays as the first layer (it keeps the job off this runner
# without even queueing it); this is the one that holds when the first layer is edited away.
#
# The rules, all must hold:
#   - the repository is the one this runner serves (TPCI_REPO), and the workflow FILE is on the allow list
#     (TPCI_WORKFLOWS, file names under .github/workflows/)
#   - the event is workflow_dispatch, push or pull_request; never pull_request_target, never anything else
#   - the actor AND the triggering actor are on the allow list (TPCI_ACTORS)
#   - for pull_request: the head repository IS the base repository (no fork) and the PR author is allowed
set -uo pipefail
CONF=${TPCI_ALLOW_CONF:-/etc/tpci/allow.conf}
deny() { echo "::error title=pc-ci-runner guard::refused: $*"; echo "pc-ci-runner guard: REFUSED: $*" >&2; exit 1; }
[ -r "$CONF" ] || deny "no guard config"
# shellcheck disable=SC1090
. "$CONF"
: "${TPCI_REPO:=}" "${TPCI_ACTORS:=}" "${TPCI_WORKFLOWS:=}"
[ -n "$TPCI_REPO" ] && [ -n "$TPCI_ACTORS" ] && [ -n "$TPCI_WORKFLOWS" ] || deny "guard config incomplete"

inlist() { local needle=$1 list=$2 x; IFS=',' read -ra xs <<< "$list"; for x in "${xs[@]}"; do [ -n "$x" ] && [ "$x" = "$needle" ] && return 0; done; return 1; }

[ "${GITHUB_REPOSITORY:-}" = "$TPCI_REPO" ] || deny "repository '${GITHUB_REPOSITORY:-}'"
case "${GITHUB_EVENT_NAME:-}" in
	workflow_dispatch | push | pull_request) ;;
	*) deny "event '${GITHUB_EVENT_NAME:-}'" ;;
esac
inlist "${GITHUB_ACTOR:-}" "$TPCI_ACTORS" || deny "actor '${GITHUB_ACTOR:-}'"
inlist "${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-}}" "$TPCI_ACTORS" || deny "triggering actor '${GITHUB_TRIGGERING_ACTOR:-}'"

# GITHUB_WORKFLOW_REF = owner/repo/.github/workflows/<file>@<ref>
wref=${GITHUB_WORKFLOW_REF:-}
case "$wref" in "$TPCI_REPO/.github/workflows/"*@*) ;; *) deny "workflow ref '$wref'" ;; esac
wfile=${wref#"$TPCI_REPO/.github/workflows/"}
wfile=${wfile%%@*}
inlist "$wfile" "$TPCI_WORKFLOWS" || deny "workflow '$wfile'"

if [ "$GITHUB_EVENT_NAME" = pull_request ]; then
	ev=${GITHUB_EVENT_PATH:-}
	[ -r "$ev" ] || deny "no event payload"
	head=$(jq -r '.pull_request.head.repo.full_name // ""' "$ev")
	# not `.fork // true`: jq's // treats false as missing
	fork=$(jq -r 'if .pull_request.head.repo.fork == false then "false" else "true" end' "$ev")
	author=$(jq -r '.pull_request.user.login // ""' "$ev")
	[ "$head" = "$TPCI_REPO" ] || deny "pull request head '$head' is not this repository"
	[ "$fork" = false ] || deny "pull request head is a fork"
	inlist "$author" "$TPCI_ACTORS" || deny "pull request author '$author'"
fi
echo "pc-ci-runner guard: ok ($GITHUB_EVENT_NAME by $GITHUB_ACTOR, $wfile)"
