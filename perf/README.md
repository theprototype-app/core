# perf/ — the Quest budget, as a gate

`budgets.json` holds every Games-tab game and every General-tab level to the Quest budget:

| metric | default | what it is |
|---|---:|---|
| `calls` | 150 | draw calls in the median display frame (every `render()` of the frame summed) |
| `triangles` | 300 000 | triangles in that frame |
| `lights` | 2 | visible real-time lights (ambient / hemisphere not counted) |
| `textureMB` | 64 | uncompressed estimate of the visible textures, one per image source, mips included |

`node scripts/perf-games.cjs --check` is the gate (exit 0 green, 1 red, 2 could not run). CI runs it on
every PR (`.github/workflows/perf-budget.yml`) and before every release (`release.yml` needs it).

## Only counts

Counts come from three's own bookkeeping (`renderer.info`, the scene graph), so a GPU-less CI runner
(SwiftShader) reads the same numbers as a desk — as long as the scene is in the same state, seen from the
same place. The check pins that:

- **headset analogue**: 1280×720, post stack off, Shaded, shadows off (a headset enters at the governor's
  XR floor, "shadows off"), a fake XR session standing at the spawn (games) or at each named viewpoint
  of `scripts/level-views.cjs` (levels);
- the **adaptive governor off** (`autoQuality=false`), so a slow runner cannot step quality down;
- every kit piece refilled and the loader idle before counting;
- the **median** frame that rendered over 3 s, not a mean over rAF ticks.

Frame time is **not** gated: no runner reproduces it. Measure ms on the device (the beacon) or with the
Performance protocol (`perf-games.cjs` without `--check`, under `e2e-slot --exclusive`).

## Running it locally

```sh
# the scenes + module zips the budget is about (refs in budgets.json)
APP_URL=https://theprototype.app:5173/ PERF_SCENES_DIR=<scenes checkout at budgets.scenes.ref> \
PERF_MODULES_DIR=<modules checkout with packed zips> \
  e2e-slot --dev . 5173 -- node scripts/perf-games.cjs --check [--only waves,tavern-interior] [--games-only|--levels-only]
```

The table lands in `perf/out/budget-check.md` (and the CI job's artifact + step summary).
`SWIFTSHADER=1` drops the GPU flags, to see what a runner sees.

## The allow-list

A game or level over budget **today** ships with an entry in `allow`:

```json
{ "target": "game:jam-room", "metric": "calls", "max": 960, "measured": 910,
  "since": "2026-10-03", "review": "2026-12-01", "owner": "…", "note": "why, and what would fix it" }
```

- `max` is the ceiling — anything above it is red like any other regression. Keep it close to `measured`
  (≈ +5 %): the allow-list records a known debt, it is not headroom.
- `view` (levels only) narrows an entry to one viewpoint; without it the entry covers every view.
- An entry whose scene came back under budget, or whose `review` date passed, prints a **warning** (not a
  failure — a date must not turn an unrelated PR red). Remove or re-date it in the PR that sees it.
- Every field is required; `perfBudget.cjs` rejects the file otherwise (and the unit test checks it).

## When the scenes move

`scenes.ref` / `modules.ref` name what is measured. A release that ships new game scenes bumps
`scenes.ref` (e.g. `preview-1-20`) in the same PR, re-runs the check, and adjusts the allow-list.
A new General-tab level is measured once it has viewpoints in `scripts/level-views.cjs`.
