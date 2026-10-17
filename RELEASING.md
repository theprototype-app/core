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
2. the **error reports spike**: `npm run error-spike -- --release=X.Y.Z` (cloud) exits 3 — run it
   ~1 h after the deploy and again before the lane closes. It compares reports per hour since the
   release against the previous release's last week (rate > 3x and +6/h, a NEW error with 15+
   reports, or crash/OOM/WebGL losses tripling). Too few reports yet = `wait`, not a pass.

Then, in this order: `npm run rollback -- --yes --reason="…"`, confirm the verify line, write
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
