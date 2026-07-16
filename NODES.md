# Flow nodes — audit (roadmap #9, stage 1)

All 33 built-in node types + the `customnode` meta-type. Types/coercions:
`src/lib/flowSockets.js` (number, vector3, boolean, color, object, event, effect);
runtime: `src/lib/flowRuntime.js` (evalNode + baseState rebase; effects apply only
through an Object Selector sink). Widgets write via `setNodeData` (replicated).
Verdicts: OK · FIX(ed this batch) · DOC(umented quirk).

| Type | Group | Out | Inputs | Verdict / notes |
|---|---|---|---|---|
| slider | Input | number | — | FIX: adjustable min/max (data-seeded, runtime-clamped; editors in the ⓘ tab). Legacy `/20` scale when wired straight to an Object Selector — DOC. |
| colorpicker | Input | color | — | OK |
| switcher | Input | number (was effect) | — | FIX: adjustable items list (ⓘ) + becomes a real value source (selected INDEX). The cube/pyramid geometry swap keeps working (keyed on items[index]). |
| number | Input | number | — | FIX: `step` gets an editor (ⓘ); it was stored + used as the input's step attr but uneditable. |
| vector3 | Input | vector3 | — | OK |
| toggle | Input | boolean | — | OK |
| random | Input | number | — | OK (min/max/interval on card; deterministic per interval) |
| time | Input | number | — | OK (sin/cos/linear × rate) |
| objectselector | Scene | — (sink) | effect | OK — THE effect sink; anything not ending here is silently inert (DOC). |
| script | Logic | number | a b c | OK (side panel editor; deterministic pure fn) |
| math | Logic | number | a b | OK (BinaryNode) |
| compare | Logic | boolean | a b | OK |
| gate | Logic | boolean | a b | DOC: op NOT ignores `b` (vestigial handle; harmless). |
| loop | Logic | number | — | OK (wrap/pingpong) |
| timer | Logic | number | a | OK (delayed passthrough) |
| distance | Logic | number | a b (object) | FIX: now also accepts a wired **vector3 literal** as a world point (coercion allowed it; runtime returned 0). |
| proximity | Logic | boolean | a b (object) | FIX: same vector3-literal acceptance. |
| lookat | Logic | effect | target | OK (already accepted uuid OR vector3) |
| setcolor | Logic | effect | color | OK |
| visibility | Logic | effect | on | OK |
| onclick | Triggers | event | — | OK (pulse window) |
| counter | Triggers | number | pulse | OK |
| shake/spin/bounce/orbit | Animation | effect | per-param | OK (generic AnimationNode; params get ⓘ editors where sensible) |
| pathpatrol | Animation | effect | — | OK (points captured by scene clicks) |
| mass/bounciness/friction | Physics | effect | value | DOC: consumed by physics.js collectParams when the sim starts — NOT flowRuntime. Working, different runtime; invisible to per-frame eval. |
| pulse/blink | Effects | effect | per-param | OK |
| sound | Effects | effect | volume | OK (`playing` IS read by soundRuntime — earlier suspicion disproven). |
| customnode | (meta) | number | per-def param | FIX (4.5): def params get INPUT sockets (they were unwirable — the runtime already resolved them); def edits prune dangling edges deterministically. |
| maprange | Logic | number | a | NEW (4.6): remap [inMin..inMax] → [outMin..outMax], optional clamp — the glue between free-range sources and bounded params. |
| select | Logic | number | index a b | NEW (4.6): outputs a when index < 0.5 else b — pairs with switcher-as-number / compare. |

## Correctness fixes shipped in 4.1
- **Edge-id collision (divergence bug)**: ids were `e-<src>-<tgt>` WITHOUT handles, so
  one source wired into both `a`+`b` of a node collided; the peer-side dedupe dropped
  edge #2 → permanent graph divergence + a 30s nodesync loop that could never converge.
  Ids now include the handles.
- distance/proximity accept vector3 literals (see table).
- **Cycle guard was global-visited, not path-based**: a source wired into TWO inputs of
  one node evaluated once — the second input read `undefined` and silently used its
  fallback (math a+b from one number = a + fallback). The guard now removes a node from
  `seen` on exit (true cycles still cut while on the recursion path).

## New-node recommendations (audit deliverable; loop-closers → 4.6)
Implemented in 4.6 (close real gaps):
- **clamp / map-range** (number in → min/max or in-range→out-range) — the missing glue
  between free-range sources (time, distance, counter) and 0..1-ish effect params.
- **select** (index + a/b inputs → a or b) — pairs with switcher-as-number; the only
  way to CHOOSE between two wired values today is a script node.
Recommended, not implemented (needs your call):
- **vector3 split/join** (x/y/z ↔ vector3) — unlocks per-axis logic; medium value.
- **delay/debounce** (event conditioning) — needs runtime state; do with care
  (deterministic via synced clock).
- **text/label** (annotation-only card) — zero-runtime, nice for big graphs.
- **keypress trigger** (desktop-only input) — replication semantics need a decision
  (whose keypress?).
