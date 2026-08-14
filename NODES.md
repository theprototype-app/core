# Flow nodes — audit (roadmap #9, stage 1)

All 35 built-in node types + the `customnode` meta-type. Types/coercions:
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
| script | Logic | effect (drives a Selector; value readable) | a b c | OK (side panel editor; deterministic pure fn) |
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
| onclick | Triggers | event | — | FIX: event→effect is now a legal drag (the typed sockets rejected wiring On Click into the Object Selector its own feature requires). Pulse window OK. |
| counter | Triggers | number | pulse | OK |
| onimpact | Triggers | event | minStrength | NEW (PFX-C): pulses when the physics INITIATOR lands the object on the ground/another object (rapier contact-start + pre-step downward velocity ≥ 1.2 m/s + 300ms per-body cooldown). Targeting walks THROUGH intermediate nodes to the Object Selector (the fireObjectClick BFS) and honors the implicit-owner rule. Replicated via nodetrigger stamps; `minStrength` gates on impact speed (wirable). |
| shake/spin/bounce/orbit | Animation | effect | per-param | OK (generic AnimationNode; params get ⓘ editors where sensible) |
| pathpatrol | Animation | effect | — | OK (points captured by scene clicks) |
| mass/bounciness/friction | Physics | effect | value | DOC: consumed by physics.js collectParams when the sim starts — NOT flowRuntime. Working, different runtime; invisible to per-frame eval. |
| angularvelocity | Physics | effect | per-param | NEW (13-C2): constant spin under physics — setAngvel on the dynamic body at sim start; wiring it alone implies dynamic mass 1 (an explicit Mass node wins). Param edits re-apply LIVE mid-sim on the stepping peer. Authoritative sync (motion rides the move broadcasts). |
| motor | Physics | effect | per-param | NEW (13-C2): drives EVERY revolute joint touching the selected object (select a car body → all wheel motors) via configureMotorVelocity; wins over a joint def's own motor. Param edits re-apply LIVE mid-sim. Authoritative sync. |
| pulse/blink | Effects | effect | per-param | OK |
| sound | Effects | effect | volume | OK (`playing` IS read by soundRuntime — earlier suspicion disproven). |
| particle | Effects | effect | count color trigger | NEW (PFX-B): flow-driven particle emitter — targets the connected object (or the graph owner, H1 implicit rule) and renders through `particleRuntime` (deterministic analytic sim, keyed by node id). `count`/`color` are wired overrides; `trigger` fires a burst-mode emitter on its rising edge. Config seeded from a preset on the card. Not in `animationTypes` — a keyed runtime subsystem like `sound`. |
| customnode | (meta) | effect (drives a Selector) | per-def param | FIX (4.5): def params get INPUT sockets (they were unwirable — the runtime already resolved them); def edits prune dangling edges deterministically. |
| maprange | Logic | number | a | NEW (4.6): remap [inMin..inMax] → [outMin..outMax], optional clamp — the glue between free-range sources and bounded params. |
| select | Logic | number | index a b | NEW (4.6): outputs a when index < 0.5 else b — pairs with switcher-as-number / compare. |
| collider | Physics | effect | source scale | NEW (CL-C): overrides the Inspector collider pick at sim start AND live (mid-sim rebuild — no restart). `shape` box/sphere/capsule/cylinder/hull/custom/object; `object` hulls the geometry of the Object Selector wired into `source`; `scale` multiplies the shape; `sensor` makes every piece a trigger volume. Consumed by physics.js collectParams (not per-frame eval), like mass. |
| onenter / onexit | Triggers | event | — | NEW (CL-C): pulse when a SENSOR pair starts/stops overlapping (initiator-detected in the substep drain, both directions of the pair, per-frame dedupe; sensors bypass the impact downward-velocity filter). Same replicated nodetrigger stamps + BFS/implicit-owner targeting as onimpact. Recipe: sensor box + On Enter -> Particles = checkpoint confetti; On Enter -> Counter = lap counter. |
| playanim | Animation | effect | trigger speed | NEW (17-E A5): starts/stops an AUTHORED keyframe clip (animationPreview) on its rising edge — `action` toggle/play/stop/restart, `clip` names one of the object's clips (empty = its default). A name the model was IMPORTED with is handed to the mixer instead (`setAnimationState`), so one node drives both animation systems. Targets the wired Object Selector or, unwired in an object graph, its OWNER. Applies LOCALLY and does not broadcast: the `nodetrigger` stamp that woke it already replicated, so every peer derives the same playback from the same timestamp (sending again would fire the transport twice). Not in `animationTypes` — an event consumer, not a per-frame offset. Recipe: a clickable button object + On Click -> Play Animation on a door whose ORIGIN sits on its hinge edge. |
| animfinished | Animation | event | — | NEW (17-E): pulses when an AUTHORED clip on the target reaches its end (once-clips; a loop never ends). Fired LOCALLY from the runtime's own end-of-clip detection on every peer — the same deterministic moment each one computes for itself — so unlike onclick it needs no `nodetrigger` message. Targets the wired Object Selector or, unwired in an object graph, its OWNER. This is the handoff: door opens -> Animation Finished -> a latch sound, a Counter, or the next door's Play Animation. |
| animstate | Animation | number | target | NEW (17-E F3): the READABLE half of Animation Finished - a value node reading the target's transport, so a clip can drive something CONTINUOUSLY instead of only handing off at its end. ONE number socket whose meaning `read` picks: progress (0..1 through the A/B window, which is what the transport actually loops over, so a trimmed range still reads 0..1) / playing (1 or 0 - a boolean rides a number socket via the COERCE table) / position / duration / remaining, the last three in clip seconds. `clip` optionally names WHICH clip must be on the transport, and reports 0 when another one is. Targets the wired Object Selector or, unwired in an object graph, its OWNER. Never replicated and never needs to be: the transport itself replicates as a synced-clock stamp, so every peer reads the same number from the same data - the same reasoning as animfinished. Recipe: progress -> Map Range -> a light that brightens as a door swings, or playing -> Gate. |
| animmarker | Animation | event | - | NEW (17-E F5): pulses as the playhead CROSSES a named marker in the clip, so a footstep sound or a puff of dust can sit at an exact frame of a movement instead of only at its end. Markers live on the CLIP (Clip.markers, carried by normalizeClip like fps/step), so they replicate, save and undo with everything else and need no channel of their own. `name` empty = ANY marker on the clip, which is one node for "every beat". Fired LOCALLY on every peer like animfinished: each runtime travels the same clip interval from the same synced stamp, so no message is needed. The crossing is an INTERVAL test between the previous tick position and this one - a marker is a point and the playhead never lands exactly on it - with the destination end inclusive so a marker under a resting playhead cannot re-fire every frame. A LOOP wrapping past the window end fires the two real pieces (prev..end and start..now), never the empty gap between them; pingpong needs none of that, its reflection is continuous. Recipe: Animation Marker -> Sound on a walk cycle.
| velocity | Scene | number | target | NEW (CL-C): live speed (m/s) of the wired object (or the graph owner unwired in an object graph). LOCAL feed — exact-ish on the sim initiator (per-step write-back deltas), an ~10Hz move-delta APPROXIMATION on other peers (broadcast-gated; documented on the card); 0 at rest / feed quiet >400ms. Never replicated: peers derive their own estimate. |

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
