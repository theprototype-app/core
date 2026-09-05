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
the svelte-check baseline (the error/warning counts live in the workflow — update
them when the baseline moves), zips `build/`, and publishes a GitHub Release with
generated notes.

MAJOR = a breaking file-format or wire-protocol change (`SESSION_FORMAT` /
`MODULE_FORMAT` bumps, incompatible peer messages).

## After tagging

- Update `CHANGELOG.md` (the in-app What's new window renders it).
- Deploy the cloud site FROM THE TAG (cloud repo):
  `npm run deploy -- --target=cloud --env=production --core-ref=vX.Y.Z`, or bump
  `CORE_REF=vX.Y.Z` in its `.env.deploy` (the pin its prompt defaults to) and run
  `npm run deploy`. The deployment is stamped with the version, so the Cloudflare
  Pages Deployments page reads `vX.Y.Z (cloud <sha>)` and About shows the tagged
  core; the script asks before shipping anything not exactly on a tag to production.
  Then add the two-line entry to the cloud repo's `CHANGELOG.md`.
- The peers warn (never block) on version mismatches, and `.tpscene`/`.tpmodule`
  files confirm before loading a NEWER format int — older files always load
  silently. Bump `SESSION_FORMAT`/`MODULE_FORMAT` only when the shape actually
  changes incompatibly.
