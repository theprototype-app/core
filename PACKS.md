# Object packs

A **pack** is a shareable bundle of 3D assets (models, and optionally textures /
audio / materials) that shows up in the Explorer's **Packs** section. Packs are
**local** to your app — loading one never syncs it to peers; only an object you
*place* from a pack replicates, like any import.

There are two kinds of pack:

- **Default packs** ship with the app, listed in `static/library/libraryList.json`.
- **Remote / imported packs** are self-describing repos or `.zip` files using the
  `manifest.json` format below. Point the app at a remote pack repo via the
  `PACKS_BASE` constant in `src/lib/packs.js` (e.g. a jsDelivr CDN URL over a
  GitHub repo), or drag a `.zip` in with **＋ Import pack**.

## Repo / .zip structure

```
<pack>/
  manifest.json          # the pack + item metadata (schema below)
  cover.webp   (or .png) # pack cover image, ~512²   ← .webp preferred, .png fallback
  assets/
    <item-id>/
      model.glb          # the model (or a .png/.jpg texture, .mp3/.ogg audio, …)
      thumb.webp         # ~512² preview   ← .webp preferred, thumb.png fallback
      item.json          # OPTIONAL per-item license/author/source overrides
  LICENSE                # SPDX full license text (per-item if the pack is mixed)
  CREDITS.md             # human-readable attribution (authors, sources, links)
  README.md
```

A separate small **index** (its own repo or a static `index.json`) can list many
packs so new ones appear without redeploying the app:

```json
[{ "id": "khronos", "name": "Khronos Samples", "repo": "packs-khronos",
   "tag": "v1.0.0", "cover": "cover.webp", "itemCount": 12, "sizeMB": 40,
   "license": "CC-BY-4.0", "description": "…" }]
```

## `manifest.json`

```jsonc
{
  "id": "khronos",
  "name": "Khronos Samples",
  "version": "1.0.0",
  "description": "…",
  "author": "Khronos Group",
  "homepage": "https://github.com/KhronosGroup/glTF-Sample-Assets",
  "license": "CC-BY-4.0",              // SPDX id; a per-item value overrides it
  "cover": "cover.webp",               // resolver tries .webp then .png
  "items": [
    {
      "id": "duck",
      "kind": "object",                // object | texture | audio | material
                                       // (inferred from the file extension if omitted)
      "file": "assets/duck/model.glb",
      "thumb": "assets/duck/thumb.webp",
      "name": "Duck",
      "size": 123456,
      "tris": 4212,
      "license": "SPDX-or-inherit",
      "author": "…",
      "source": "https://…",
      "tags": ["prop"]
    }
  ]
}
```

## Conventions

- **Licenses are [SPDX](https://spdx.org/licenses/) ids** (`CC-BY-4.0`, `CC0-1.0`,
  `MIT`, `Apache-2.0`, …). The app maps them to human labels in a pack's
  **Properties → Attribution**. A per-item `license` overrides the pack license,
  so mixed-license packs (e.g. Khronos) are fine.
- **Thumbnails**: ship a pre-rendered `thumb.webp` (or `.png`) per item — it loads
  from the CDN before the model itself, so the grid fills in instantly. If neither
  is present the app renders one offscreen the first time the model loads. Keep
  them ~512² for crisp-but-small.
- **Screenshots vs thumbnails**: default packs (libraryList) may instead ship a
  `screenshot` path per item (the app tries `thumb.webp` → `thumb.png` →
  `screenshot`). New packs should prefer `thumb.webp`.
- Generate thumbnails deterministically with a headless three.js script
  (`scripts/gen-pack-thumbs.mjs`, when added) so CI/pack authors reproduce them.

Aligns with the Khronos glTF-Sample-Assets `model-index.json` layout and the
Poly Haven / ambientCG per-asset-folder convention.
