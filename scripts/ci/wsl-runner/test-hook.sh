#!/usr/bin/env bash
# pc-ci-runner — tests for job-started-hook.sh (needs bash + jq; no runner, no network): bash test-hook.sh
set -u
H=$(cd "$(dirname "$0")" && pwd)/job-started-hook.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
conf() { printf 'TPCI_REPO=o/core\nTPCI_ACTORS=%s\nTPCI_WORKFLOWS=battery-gpu.yml\n' "$1" > "$T/allow.conf"; }
pr() { printf '{"pull_request":{"head":{"repo":{"full_name":"%s","fork":%s}},"user":{"login":"%s"}}}' "$1" "$2" "$3" > "$T/ev.json"; }
fails=0
t() {
	local want=$1 got out
	shift
	out=$(env -i PATH="$PATH" TPCI_ALLOW_CONF="$T/allow.conf" GITHUB_EVENT_PATH="$T/ev.json" GITHUB_REPOSITORY=o/core \
		GITHUB_EVENT_NAME=workflow_dispatch GITHUB_ACTOR=alice GITHUB_TRIGGERING_ACTOR=alice \
		GITHUB_WORKFLOW_REF=o/core/.github/workflows/battery-gpu.yml@refs/heads/main "$@" bash "$H" 2> /dev/null)
	[ $? = 0 ] && got=pass || got=refuse
	if [ "$got" = "$want" ]; then echo "ok   $want  $*"; else echo "FAIL want $want got $got  $* -> $(tail -1 <<< "$out")"; fails=$((fails + 1)); fi
}
conf alice,bob
pr o/core false alice
t pass
t pass GITHUB_EVENT_NAME=push
t pass GITHUB_EVENT_NAME=pull_request
t refuse GITHUB_EVENT_NAME=pull_request_target
t refuse GITHUB_EVENT_NAME=issue_comment
t refuse GITHUB_EVENT_NAME=schedule
t refuse GITHUB_ACTOR=mallory
t refuse GITHUB_TRIGGERING_ACTOR=mallory
t refuse GITHUB_ACTOR=
t refuse GITHUB_REPOSITORY=mallory/core
t refuse GITHUB_WORKFLOW_REF=o/core/.github/workflows/evil.yml@refs/pull/1/merge
t refuse GITHUB_WORKFLOW_REF=mallory/core/.github/workflows/battery-gpu.yml@refs/heads/main
t refuse GITHUB_WORKFLOW_REF=o/core/.github/workflows/battery-gpu.yml.evil@x
pr mallory/core true alice && t refuse GITHUB_EVENT_NAME=pull_request
pr o/core true alice && t refuse GITHUB_EVENT_NAME=pull_request
pr o/core null alice && t refuse GITHUB_EVENT_NAME=pull_request
pr o/core false mallory && t refuse GITHUB_EVENT_NAME=pull_request
rm -f "$T/ev.json" && t refuse GITHUB_EVENT_NAME=pull_request
pr o/core false alice
t refuse TPCI_ALLOW_CONF=/nonexistent
conf '' && t refuse
conf 'alice,,bob' && t refuse GITHUB_ACTOR= GITHUB_TRIGGERING_ACTOR=
[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
