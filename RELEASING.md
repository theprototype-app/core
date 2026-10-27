# Releasing theprototype.app

The core repo is the version anchor (it owns the wire protocol and file formats).
SemVer + git tags; the `npm version` bump is the SINGLE source of truth — the About
panel, the peer handshake and `.tpscene`/`.tpmodule` provenance all derive from
`package.json` through the vite `define` (`__APP_VERSION__` / `__COMMIT_SHA__`).

## The ritual

First release:

```sh
npm version 1.0.0          # bumps package.json, commits, tags v1.0.0
git push origin main --follow-tags
```

After that: `npm version minor` (features) or `npm version patch` (fixes), then the
same push. The tag triggers `.github/workflows/release.yml`, which builds, gates on
the svelte-check baseline (27-I moved the error/warning counts OUT of the workflow
and into `check-baseline.json` at the repo root, read only by
`scripts/check-ratchet.cjs`, which `release.yml` and `ci.yml` both call — ratchet it
DOWN with `node scripts/check-ratchet.cjs --update` whenever a change legitimately
removes errors, and never hardcode the number anywhere again), zips `build/`, and
publishes a GitHub Release with generated notes.

MAJOR = a breaking file-format or wire-protocol change (`SESSION_FORMAT` /
`MODULE_FORMAT` bumps, incompatible peer messages).

## Supply chain: the SBOM and the vulnerability gate

Every GitHub Release carries `theprototype-vX.Y.Z.spdx.json` beside the zip: an SPDX
SBOM written by syft from both lockfiles (`package-lock.json` + `tools/agent/package-lock.json`,
dev dependencies included, config `.syft.yaml`). The same SBOM is scanned by grype in
`release.yml` and in ci.yml's `supply-chain` job on every PR: a **critical or high**
finding fails the run; medium and lower print only.

When grype goes red: fix it first — `npm update <pkg>` inside the declared range, or an
npm `overrides` entry when a parent pins the old range (never `--legacy-peer-deps`).
Only when no fixed version exists, or the finding cannot reach this project, add a rule
to `.grype.yaml` — one per advisory, pinned to the package version, with a `reason` and
a recheck date (the file's header shows the shape). Re-read that list at every release
and delete rules whose package has moved on (a version-pinned rule stops matching anyway).

The toolchain is pinned too: `.nvmrc` / `.mise.toml` (Node) and `packageManager` /
`devEngines` in package.json (npm). Bump them together — ci.yml's "toolchain pins agree"
step fails when they disagree.

## Dependency updates: the `deps` branch

Dependabot's version updates never open against `main`. They open against the long-lived **`deps`**
branch (`.github/dependabot.yml`, `target-branch: deps`; monthly, npm at the root and in `tools/agent`,
plus GitHub Actions), and `.github/workflows/deps.yml` decides what happens to each one:

1. **The gate.** ci.yml (with `battery: true`: its two browser jobs stand down, the battery covers them) and
   perf-budget.yml (in three parallel parts, `perf-games.cjs --check --part k/3`) run as reusable workflows, then
   the e2e battery on GitHub-hosted runners (SwiftShader, no GPU) through `.github/workflows/battery.yml`:
   - the **required** set (`tests/e2e/battery.json` minus `skip` and `optional`) in shards sized by recorded
     runner seconds (`shards.target_minutes`; 15-17 shards + the 3 perf parts = the free plan's 20-job cap);
   - **confirm**: every required red, and whatever a shard's deadline left unrun, gets two more tries on a fresh
     runner; green there = `flaky` (reported), red there = a red. SwiftShader fails any one suite now and then,
     and twice on the same loaded runner too, so a same-shard retry proves nothing;
   - the **optional** set (red or flaky on SwiftShader with unchanged code, each with its reason on its line)
     runs only on a run started by hand (Actions → deps → Run workflow, e.g. before refreshing `battery.json`),
     AFTER the rest, and is only reported (`optional-report`); nothing waits for it.
   The perf budget and the battery run only for a PR that moves the root app's npm packages and is not a major;
   an Actions bump, an agent (`tools/agent`) bump and a major get ci.yml alone. One battery is about 30 jobs
   and 600 runner-minutes against the account's cap of 20 concurrent jobs, and Dependabot opens its monthly
   round all at once (9 PRs in the first one, 2026-10-25), so everything else on the account queues behind it.
   One check sums it all up: **`deps-gate`**. Measured on unchanged code (2026-10-24): about an hour from push
   to `deps-gate` on an idle account. The shard runner is `scripts/ci/battery.cjs`.
2. **The GPU half.** `pc-battery` is a commit status posted from a desktop with a real GPU
   (`scripts/ci/pc-battery.sh`): /kit, the app surfaces (base shot twice for the noise floor), the level shots
   (head against the closer of two base runs; under 2 % of the pixels is animation) and frame time on the
   heaviest games (base/head alternating twice; head within the base runs' range), summary in a secret gist
   linked from the status. Nothing on GitHub can reach that machine and the repo registers no self-hosted
   runner (it is public): a user timer there runs `scripts/ci/pc-battery.sh --poll` every 15 minutes from a
   checkout of `deps`, which picks up open PRs into `deps` whose `deps-gate` is green, from a branch of this
   repo, by Dependabot or the maintainer, and with no `pc-battery` status yet (a `pending` one older than 3 h
   counts as abandoned: the desktop slept). For a PR that changes nothing the app ships, deps.yml posts
   `pc-battery` itself as "not needed". By hand: `scripts/ci/pc-battery.sh <pr>` (`--dry-run` says what it
   would do).
3. **The policy** (`scripts/ci/deps-policy.cjs`, unit-tested in `tests/unit/depsCi.test.js`):

   | update | once green |
   |---|---|
   | patch, a development-only package, any GitHub Action | GitHub auto-merge into `deps` |
   | a minor of something that ships (a `dependency`, or svelte / vite / kit / tailwind / flowbite) | label `deps-ready`; the monthly deps lane merges it after the release notes + a visual review |
   | any Playwright bump | `deps-ready`: the e2e hosts outside GitHub must serve the same browser first |
   | a major | `needs-migration` + a comment; `deps-gate` red on purpose (not tested here); a planned migration, never automation |

   The ruleset on `deps` requires `deps-gate` and `pc-battery`, so an auto-merge of a runtime patch waits
   for the desktop. The ruleset also forbids deleting `deps`: it is never cleaned up with merged branches.

**Integrators:** at union time, `git merge origin/deps` into `feat/<n>` before the battery, so the bumps
ship with a tested union and `main` never takes a dependency change on its own. After the release, bring
`deps` up to the released `main` (`git push origin main:deps` when it fast-forwards, else merge `main`
into `deps`).

**Security updates** are GitHub's exception: they always target `main`, whatever `target-branch` says.
deps.yml runs the same battery and labels on them there; nothing auto-merges into `main`, a person does.

**When the battery list moves** (an integrator's battery added or dropped suites), refresh it from that
run: `node scripts/ci/battery.cjs refresh --list <battery list>... --summary <battery summary>...`
(names come from the lists, seconds from the summaries). `--results <dir>` (repeatable) takes seconds measured on the
runners instead, the median across the runs given (deps.yml's `battery-durations` artifact; one suite's time
moves by half between runs, so balance on several). A suite goes into `optional` (runs, reported,
does not gate) only when it is red or flaky on the unchanged base too, with that reason on its line —
`--red <run dir>... --reason "…"` does it from downloaded `battery-*` artifacts of runs on unchanged code;
`skip` is for what a public runner cannot do at all (the self-hosted signaling box, a hosts-mapped origin,
a built app). A required suite that keeps surviving confirm as red on unchanged code belongs in `optional`
too: the gate must be green on `deps` itself. The shard count follows the recorded seconds
(`shards.target_minutes`, at most `shards.max`); keep required shards + 3 under the 20-job cap.

## Recreate `release/next` after the tag push

The repo has `delete_branch_on_merge: true`, so merging the release PR DELETES
`release/next` on origin — and GitHub then silently retargets every open PR that was
based on it to `main`, which would let an ungated batch land straight on main. This
bit the 1.11.0 release (PR #206 was retargeted). After pushing the tag:

```sh
git push origin main:release/next     # recreate it at the released commit
gh pr list --base main                # anything retargeted goes back to release/next
```

Recreating it from main also keeps `release/next:package.json` in step with the
released version instead of drifting (it carried a stale 1.8.0 before 1.11.0).

## After tagging

- Update `CHANGELOG.md` (the in-app What's new window renders it).
- Deploy the cloud site FROM THE TAG (cloud repo):
  `npm run deploy -- --target=cloud --env=production --core-ref=vX.Y.Z`, or bump
  `CORE_REF=vX.Y.Z` in its `.env.deploy` (the pin its prompt defaults to) and run
  `npm run deploy`. The deployment is stamped with the version, so the Cloudflare
  Pages Deployments page reads `vX.Y.Z (cloud <sha>)` and About shows the tagged
  core; the script asks before shipping anything not exactly on a tag to production.
  Then add the two-line entry to the cloud repo's `CHANGELOG.md`.
- Tell the owner (cloud repo, since 1.42): `npm run notify-release -- --version=X.Y.Z
  --title="<roadmap title>"` — one Telegram message with the preview and device-checklist
  links; it refuses a version production does not serve yet. `--dry-run` prints it. What
  else alerts and how to mute it: the cloud repo's `docs/alerts.md`.
- Content refs (jsDelivr, read off-bundle — `src/lib/contentBase.js`): scenes
  `format-2`, packs `format-1` and, since 1.27, modules `format-1`. Each is a MOVING tag
  (never semver-looking — jsDelivr resolves a version once and a retag of it is a no-op
  forever). Whenever that repo's `main` changes for a release, retag it and purge:
  ```sh
  git -C ../modules fetch origin && git -C ../modules tag -f format-1 origin/main
  git -C ../modules push -f origin format-1
  curl -s https://purge.jsdelivr.net/gh/theprototype-app/modules@format-1/index.json
  ```
  (plus every changed module file; the same three lines with `scenes`/`format-2` and
  `packs`/`format-1`). A modules merge alone no longer reaches production's gallery.
- **Record the release's known reds** (the desk battery's baseline, pipeline-1): right after the tag, run the
  battery once ON THE TAG — two halves, each on a pc slot where the e2e-slot setup has them — and save it:
  ```sh
  bash scripts/ci/battery-snapshot.sh vX.Y.Z <dir>     # git archive + .env + certs + the desk tool (NOT archive alone)
  cd <dir> && BATTERY_COMMIT=vX.Y.Z node scripts/ci/battery-desk.cjs run --half A --out test-results/bl --name blA   # and --half B
  node scripts/ci/battery-desk.cjs baseline save vX.Y.Z <dir>
  ```
  The next integrator runs the same halves on its union and calls `battery-desk.cjs diff --baseline vX.Y.Z <dir>`:
  a red whose every twice-red check is red on the tag too is PRE-EXISTING (no A/B run), a red that went green on
  the end-of-half retry is FLAKY (logged; `battery-desk.cjs flakes` prints the rates), and only NEW reds need a look.
  No pc slot for the tag run? Save the releasing union's OWN last battery as the tag's baseline instead (it is the
  released code, run the way the next integrator will run it): `battery-desk.cjs import <u1A.txt> --logs <dir>
  [--retry <rerun.txt>]` per half, then `baseline save vX.Y.Z <dirs>`. Measured on 1.43 (51-int) against 50-int's 1.42
  battery imported that way: 50 reds -> 33 pre-existing, 11 NEW after the retry.
  A new `tests/e2e/*.test.cjs` goes into `tests/e2e/battery.json` (suites, or `exclude` with a reason) —
  `tests/unit/batteryDesk.test.js` fails on a file in neither.
- **Tier 1 → release → tier 2** (battery-tiers, owner decision 2026-10-26). The battery splits by COVERAGE, not by
  suite names: `tests/e2e/coverage-map.json` says which app files each suite executes beyond the boot floor, and
  ```sh
  node scripts/ci/battery-desk.cjs tiers --base vPREV [--also <focused union suites>] [--verbose]
  node scripts/ci/battery-desk.cjs tiers --base vPREV --save <tree>/tiers.json     # a snapshot / pc slot has no .git
  node scripts/ci/battery-desk.cjs run --tier 1 --selection tiers.json --half A …  # and B: gates the release
  node scripts/ci/battery-desk.cjs run --tier 2 --selection tiers.json --half A …  # on the NEW tag, detached (mux-done)
  node scripts/ci/battery-desk.cjs record --version X.Y.Z --base vPREV --tier1 <dirA>,<dirB>   # later: --tier2 …
  node scripts/ci/battery-desk.cjs record --version X.Y.Z --escape <suite>:yes|no:serious|minor|none:<check>
  node scripts/ci/battery-desk.cjs record --check      # before the next union merge: tier 2 recorded + classified?
  ```
  Tier 1 = suites covering a changed `src/` file (or a package the lockfile moved), suites added or changed (and those
  requiring a changed tests/e2e support file), `tier1_always` (smoke, the two-peer core, join/save/edit/play) + `--also`,
  every suite the map does not know yet. A SHARED file (`tier1_always_files`, or run past the boot floor by more than
  `tier1_shared_suites` = 16 suites) brings its HEAVY users (the map names the ~8 that run most of it) and the rest only
  while tier 1 stays under `tier1_cap` (30 %) of the suite-minutes. Replayed on 1.35-1.44: tier 1 = 26-52 % of the
  suites, and it holds 3 of the 4 old-suite catches (the miss: a one-line change to a boot-only file, githubStars.js,
  that every suite runs the same way — `tiers` lists such files as boot-only). Tier 2 must be
  classified before the next release's union merge: a real tier-2 bug that is serious (data loss, security, broken
  join/save/edit/play) is a patch release 1.x.1 from the tag, anything else is fixed in the next release. Regenerate
  the map every few releases (or when `tiers` says many suites are unmapped): both halves with `E2E_COVERAGE=1` on pc
  slots (MOD: flights carry no core coverage — drop them), then `battery-desk.cjs map build <out-A> <out-B>`.
- The peers warn (never block) on version mismatches, and `.tpscene`/`.tpmodule`
  files confirm before loading a NEWER format int — older files always load
  silently. Bump `SESSION_FORMAT`/`MODULE_FORMAT` only when the shape actually
  changes incompatibly.

## Rollback (48 O2): one step back, and when the integrator takes it

**The command** (cloud repo, the deploy token in `.env.deploy`):

```sh
npm run rollback                     # the plan: what is live, what it would go back to
npm run rollback -- --yes            # app (Pages production) AND the community Worker, then verify
npm run rollback -- --yes --to=v1.38.0 --reason="1.39.0 proof red: J12"
```

The app goes back by RE-POINTING Cloudflare Pages production at the previous successful production
deployment (no rebuild — the exact files that shipped then, live in seconds); the Worker goes back
with `wrangler rollback` to its previous version. The script then reads
`theprototype.pages.dev/version.json` and exits 4 unless the live app reports the target's version.
`--pages-only` / `--worker-only` split it; `--to=<deployment id>` picks an exact build.
Proven on a throwaway project and Worker (lane 48-ops evidence), never on production.

**The integrator rule — automatic, then tell.** After a production deploy the integrator rolls back BY
ITSELF, without asking, when either:

1. the **production proof is red** on something the preview proof had green (A/B it against the
   previous release first — a red that is red there too is not this release's), or
2. the **error reports spike**: `npm run error-spike -- --release=X.Y.Z --alert` (cloud) exits 3 — run it
   ~1 h after the deploy and again before the lane closes. It compares reports per hour since the
   release against the previous release's last week (rate > 3x and +6/h, a NEW error with 15+
   reports, or crash/OOM/WebGL losses tripling). Too few reports yet = `wait`, not a pass.
   `--alert` sends a SPIKE to the owner's Telegram once per release; a scheduled Action in the
   cloud repo also checks 2 h / 6 h / 24 h after the release and daily, sharing that "once".

Then, in this order: `npm run rollback -- --yes --reason="…"` (it tells the owner on Telegram:
from → to, the reason, the verify line — so write the reason for a human), confirm the verify line, write
what happened at the top of the integrator's QUESTIONS file ("ROLLED BACK vX.Y.Z → vX.Y.(Z-1):
why, the failing check or the spike table, the fix PR"), keep the tag (a rollback never deletes a
tag or a GitHub Release — the next release supersedes it), and open the fix as a normal lane PR.
Staff ▸ Errors shows the same numbers per release.

**Migrations must stay readable by the previous release.** A rollback moves the app and the Worker,
never PocketBase — so every `pb_migrations` / `pb_hooks` change shipped with release N must leave
data that release N-1 still reads and writes correctly: add fields and collections (with defaults),
never rename, retype or drop one in the same release that starts using the replacement; a removal
waits for the release AFTER the one that stopped using it. Scene and project files follow the
existing format-int rule (an older app confirms before opening a newer format), so a rollback
never silently mangles a file saved by the newer release. A migration that cannot meet this rule
says so in its PR, and the integrator writes "NO AUTO-ROLLBACK: <migration>" at the top of its
QUESTIONS file before releasing — rolling that release back is then a manual decision.
