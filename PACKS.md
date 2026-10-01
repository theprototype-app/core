# Object packs

A **pack** is a shareable bundle of 3D assets (models, and optionally textures /
audio / materials) that shows up in the Explorer's **Packs** section. Packs are
**local** to your app — loading one never syncs it to peers; only an object you
*place* from a pack replicates, like any import.

There are two kinds of pack:

- **Default packs** come from the pack repo's `index.json`, fetched from
  `PACKS_BASE` (`src/lib/packs.js`) — the jsDelivr CDN over
  [theprototype-app/packs](https://github.com/theprototype-app/packs), pinned to a
  ref (`@format-1` — never a semver-looking name: jsDelivr resolves a version once
  and a retag of it is a no-op, core #230). If the CDN is unreachable, the app falls
  back to the MINIMAL starter bundled at `static/library/libraryList.json` (offline /
  fresh clones are never empty).
- **Remote / imported packs** are self-describing repos or `.zip` files using the
  `manifest.json` format below — drag a `.zip` in with **＋ Import pack**.

### The pack-repo `index.json` (RP)

Each row: `{name, title, value | zip, attribution, copyright, license, source}`.
`value` / `attribution` / `zip` may be repo-relative (resolved against
`PACKS_BASE`), app-origin (`/library/...`, bundled fallback) or absolute URLs.
`source` renders as a **Source** button in the pack Properties panel and an
"↗ Open source" row action (imported packs reuse `manifest.homepage`).

**Upstream-fetch pattern**: an item list may carry ABSOLUTE `glTF-Binary` /
`screenshot` URLs — the khronos pack ships only an index whose entries resolve to
`raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets`, so the model bytes
never live in our repo. Relative variants resolve against
`<base>/<item>/glTF-Binary/<file>` as before.

### Default-list `.zip` packs (audio / SFX / mixed) — M-2

The default model packs use the model-list format (one item folder per glTF).
A default-list entry can instead point at a self-describing **`.zip`** with a
`zip` field — used for **audio / SFX packs** (or any mixed-kind pack), because the
`.zip` import path is kind-agnostic (`kindOf` stores audio as `audio`, textures as
`texture`, …). Such an entry shows an **⬇ Install pack** action in the Explorer
Packs list (right-click the pack) that fetches the `.zip` and imports it locally:

```jsonc
// static/library/libraryList.json
{ "name": "starter-audio", "title": "Starter Music & SFX", "zip": "/library/starter-audio/pack.zip",
  "license": "CC0-1.0" }
```

Drop the `.zip` at `static/library/starter-audio/pack.zip` (a normal pack `.zip`:
`manifest.json` + `assets/…mp3|ogg|wav`). Prefer **CC0** loops/one-shots (freesound
CC0, OpenGameArt CC0). Keep each file under the 5 MB share cap so it round-trips to
peers. Installed audio items appear in the Explorer library and can be assigned to
a **Sound** node (spatial) or the **Scene music** channel (global).

### Animated, functional items — `behavior` (roadmap 33, P2)

An item row in a default pack's item list (`default.json`) MAY carry a `behavior`: a
door you click open, a chest lid, a lever, a fan. The GLB holds the clips; the row says
how they are used:

```jsonc
{
  "name": "WoodDoor", "label": "Wooden door", "screenshot": "screenshot/screenshot.webp",
  "variants": { "glTF-Binary": "WoodDoor.glb" },
  "behavior": {
    "type": "door",          // door | toggle | oneshot | loop
    "clip": "open",          // the clip a trigger plays (its time 0 is the REST pose)
    "closeClip": "close",    // optional (door/toggle): played to close; absent = `clip` backwards
    "trigger": "click",      // click | proximity | knock
    "autoplay": false,       // honoured ONLY for type "loop" (ambient: a fan, a flag, a flame)
    "sound": "door",         // optional: a game-sound name (door gate slide lever lid click …)
    "collider": "follow"     // optional; the default for a door
  }
}
```

**The rule.** Nothing plays on placement, on load, or in Edit, and nothing loops unless
it is a `loop` with `autoplay: true`. A peer in Edit always sees the rest pose. A trigger
works in Interact or Play: `door`/`toggle` alternate open ⇄ closed, `oneshot` plays once
per trigger, and a `loop` without autoplay starts and stops. The Animation panel previews
a clip in Edit, locally: nothing is sent or saved, and the item goes back to rest.

- **Triggers.** `click` is the desktop click, the Play tap, and the VR laser, trigger and
  poke. `proximity` opens when the player comes within 1.5 m and closes when they leave
  (a click still works). `knock` is a VR hand moving into the part at ≥ 0.6 m/s (on a
  desktop, a click).
- **Shared state.** One `behavior` message per trigger, stamped with the session clock.
  Every peer derives the pose from the stamp, so a door swings in step everywhere, and a
  late joiner receives the state with the door. The state is runtime only: a scene saved
  with a door open reopens shut.
- **Frame and moving parts.** A door ALWAYS ships with its frame. The nodes the
  behavior's clips animate are the MOVING parts (put the hinge pivot on the node's origin);
  everything else is the static frame. With `collider: "follow"` the frame becomes slab
  colliders with the opening cut out, and each moving part gets a box that follows it, so
  you can walk through an open door and are stopped by a shut one (while a simulation
  runs; that is when the walker collides at all).
- **Authoring the GLB.** Use LINEAR TRS tracks on the moving nodes, with `clip` at time 0
  being the closed pose. A static `idle` clip FIRST is harmless and keeps older app
  builds (which autoplayed the first clip) still. `lods` files must keep the same node
  names, hierarchy and clips. The same `behavior` object may also sit in the GLB's scene
  extras (`scene.extras.behavior`); the pack row wins over it.
- The Explorer marks such items with a small ▶ "animated" badge that says what they do
  and what sets them off.

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
