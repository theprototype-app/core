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
the svelte-check baseline (476 errors / 62 warnings — update the numbers in the
workflow when the baseline moves), zips `build/`, and publishes a GitHub Release
with generated notes.

MAJOR = a breaking file-format or wire-protocol change (`SESSION_FORMAT` /
`MODULE_FORMAT` bumps, incompatible peer messages).

## After tagging

- Update `CHANGELOG.md` (the in-app What's new window renders it).
- Cloud deploys pin the tag: set `CORE_REF=vX.Y.Z` in the cloud repo's
  `.env.deploy` so the deployed site's About shows the tagged core version.
- The peers warn (never block) on version mismatches, and `.tpscene`/`.tpmodule`
  files confirm before loading a NEWER format int — older files always load
  silently. Bump `SESSION_FORMAT`/`MODULE_FORMAT` only when the shape actually
  changes incompatibly.
