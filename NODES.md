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
| random | Input | number | seed reroll | OK (min/max/interval on card; deterministic per interval). FIX (21-E4 follow-up): **`reroll` was a DEAD input** — shipped in B6, but the roll reads `ctx.triggers[<this node>]` and nothing ever wrote an entry for a random node (`applyNodeTrigger` stamps the SOURCE and, before 21-E4, only a Counter target), so the term was 0 for the node's whole life and pulsing `reroll` did nothing at all. The stateful-target chain now stamps it. The reroll term is **the stamp in ms, not a count of rerolls**: a count is local, so a late joiner's would run N behind for ever and its rolls would never re-converge (two peers picking a "random spawn point" in different places permanently); a stamp is replicated, so every peer holding the same last-reroll stamp computes the same number and a joiner converges exactly on the next reroll. Absent = 0, so every graph saved before the input worked is byte-identical. |
| time | Input | number | — | OK (sin/cos/linear × rate) |
| objectselector | Scene | — (sink) | effect | OK — THE effect sink; anything not ending here is silently inert (DOC). |
| script | Logic | effect (drives a Selector; value readable) | a b c | OK (side panel editor; deterministic pure fn) |
| math | Logic | number | a b | OK (BinaryNode) |
| compare | Logic | boolean | a b | OK |
| gate | Logic | boolean | a b | DOC: op NOT ignores `b` (vestigial handle; harmless). 21-E4 AUDIT: `not` was on the SPEC's wanted list and is in fact ALREADY SHIPPED — the runtime case, the BinaryNode option and the hidden `b` checkbox all predate it, so the "inverting a boolean takes a compare trick" premise is stale. The socket is deliberately still drawn for `not`: hiding a handle that a saved edge might target strands that edge, and the value is ignored either way. |
| loop | Logic | number | — | OK (wrap/pingpong) |
| timer | Logic | number | a | OK (delayed passthrough) |
| distance | Logic | number | a b (object) | FIX: now also accepts a wired **vector3 literal** as a world point (coercion allowed it; runtime returned 0). |
| proximity | Logic | boolean | a b (object) | FIX: same vector3-literal acceptance. |
| lookat | Logic | effect | target | OK (already accepted uuid OR vector3) |
| setcolor | Logic | effect | color | OK |
| visibility | Logic | effect | on | OK |
| onclick | Triggers | event | — | FIX: event→effect is now a legal drag (the typed sockets rejected wiring On Click into the Object Selector its own feature requires). Pulse window OK. |
| counter | Triggers | number | pulse reset | FIX (21-E4): a wired `reset` EVENT zeroes it, which is what a round-2 score needs — the counting lives inside `applyNodeTrigger`, so the reset rides that same path and is handle-aware there rather than being a second code path. The `op` param is unchanged and still governs a counter with nothing wired into reset. |
| onimpact | Triggers | event | minStrength | NEW (PFX-C): pulses when the physics INITIATOR lands the object on the ground/another object (rapier contact-start + pre-step downward velocity ≥ 1.2 m/s + 300ms per-body cooldown). Targeting walks THROUGH intermediate nodes to the Object Selector (the fireObjectClick BFS) and honors the implicit-owner rule. Replicated via nodetrigger stamps; `minStrength` gates on impact speed (wirable). |
| shake/spin/bounce/orbit | Animation | effect | per-param | OK (generic AnimationNode; params get ⓘ editors where sensible) |
| pathpatrol | Animation | effect | — | OK (points captured by scene clicks) |
| mass/bounciness/friction | Physics | effect | value | DOC: consumed by physics.js collectParams when the sim starts — NOT flowRuntime. Working, different runtime; invisible to per-frame eval. |
| angularvelocity | Physics | effect | per-param | NEW (13-C2): constant spin under physics — setAngvel on the dynamic body at sim start; wiring it alone implies dynamic mass 1 (an explicit Mass node wins). Param edits re-apply LIVE mid-sim on the stepping peer. Authoritative sync (motion rides the move broadcasts). |
| motor | Physics | effect | per-param | NEW (13-C2): drives EVERY revolute joint touching the selected object (select a car body → all wheel motors) via configureMotorVelocity; wins over a joint def's own motor. Param edits re-apply LIVE mid-sim. Authoritative sync. |
| pulse/blink | Effects | effect | per-param | OK |
| sound | Effects | effect | volume trigger | OK (`playing` IS read by soundRuntime — earlier suspicion disproven). FIX (21-E4): a `trigger` EVENT input plays the buffer ONCE — verified as the gap that made play-a-sound-on-press unauthorable by any means, the node having only `playing` (a continuous state). The one-shot is a separate fire-and-forget source, so a running loop and the `playing` key comparison are untouched, and it acts on the trigger's STAMP EDGE — a pulse is high ~0.3s, which at 60fps would be eighteen copies of the same sound. LOCAL playback from a replicated stamp: nothing new on the wire (`soundEntries()` exposes `fired`/`firedAt`, the only way to observe a fire-and-forget source). |
| particle | Effects | effect | count color trigger | NEW (PFX-B): flow-driven particle emitter — targets the connected object (or the graph owner, H1 implicit rule) and renders through `particleRuntime` (deterministic analytic sim, keyed by node id). `count`/`color` are wired overrides; `trigger` fires a burst-mode emitter on its rising edge. Config seeded from a preset on the card. Not in `animationTypes` — a keyed runtime subsystem like `sound`. |
| customnode | (meta) | effect (drives a Selector) | per-def param | FIX (4.5): def params get INPUT sockets (they were unwirable — the runtime already resolved them); def edits prune dangling edges deterministically. |
| maprange | Logic | number | a | NEW (4.6): remap [inMin..inMax] → [outMin..outMax], optional clamp — the glue between free-range sources and bounded params. |
| select | Logic | number | index a b c d | NEW (4.6): outputs a when index < 0.5 else b — pairs with switcher-as-number / compare. FIX (21-E4): grown N-WAY (a..d) for random-spawn-point / random-taunt. a/b keep their handle ids, and TWO rules keep every saved graph byte-identical: the index is ROUNDED (which reproduces the old `< 0.5` split exactly over 0/1) and CLAMPED to the highest slot the node actually uses — wired or explicitly set — so a 2-input Select handed an out-of-range index still lands on `b` the way it always did. |
| collider | Physics | effect | source scale | NEW (CL-C): overrides the Inspector collider pick at sim start AND live (mid-sim rebuild — no restart). `shape` box/sphere/capsule/cylinder/hull/custom/object; `object` hulls the geometry of the Object Selector wired into `source`; `scale` multiplies the shape; `sensor` makes every piece a trigger volume. Consumed by physics.js collectParams (not per-frame eval), like mass. |
| onenter / onexit | Triggers | event | — | NEW (CL-C): pulse when a SENSOR pair starts/stops overlapping (initiator-detected in the substep drain, both directions of the pair, per-frame dedupe; sensors bypass the impact downward-velocity filter). Same replicated nodetrigger stamps + BFS/implicit-owner targeting as onimpact. Recipe: sensor box + On Enter -> Particles = checkpoint confetti; On Enter -> Counter = lap counter. |
| playanim | Animation | effect | trigger speed | NEW (17-E A5): starts/stops an AUTHORED keyframe clip (animationPreview) on its rising edge — `action` toggle/play/stop/restart, `clip` names one of the object's clips (empty = its default). A name the model was IMPORTED with is handed to the mixer instead (`setAnimationState`), so one node drives both animation systems. Targets the wired Object Selector or, unwired in an object graph, its OWNER. Applies LOCALLY and does not broadcast: the `nodetrigger` stamp that woke it already replicated, so every peer derives the same playback from the same timestamp (sending again would fire the transport twice). Not in `animationTypes` — an event consumer, not a per-frame offset. Recipe: a clickable button object + On Click -> Play Animation on a door whose ORIGIN sits on its hinge edge. |
| animfinished | Animation | event | — | NEW (17-E): pulses when an AUTHORED clip on the target reaches its end (once-clips; a loop never ends). Fired LOCALLY from the runtime's own end-of-clip detection on every peer — the same deterministic moment each one computes for itself — so unlike onclick it needs no `nodetrigger` message. Targets the wired Object Selector or, unwired in an object graph, its OWNER. This is the handoff: door opens -> Animation Finished -> a latch sound, a Counter, or the next door's Play Animation. |
| animstate | Animation | number | target | NEW (17-E F3): the READABLE half of Animation Finished - a value node reading the target's transport, so a clip can drive something CONTINUOUSLY instead of only handing off at its end. ONE number socket whose meaning `read` picks: progress (0..1 through the A/B window, which is what the transport actually loops over, so a trimmed range still reads 0..1) / playing (1 or 0 - a boolean rides a number socket via the COERCE table) / position / duration / remaining, the last three in clip seconds. `clip` optionally names WHICH clip must be on the transport, and reports 0 when another one is. Targets the wired Object Selector or, unwired in an object graph, its OWNER. Never replicated and never needs to be: the transport itself replicates as a synced-clock stamp, so every peer reads the same number from the same data - the same reasoning as animfinished. Recipe: progress -> Map Range -> a light that brightens as a door swings, or playing -> Gate. |
| animmarker | Animation | event | - | NEW (17-E F5): pulses as the playhead CROSSES a named marker in the clip, so a footstep sound or a puff of dust can sit at an exact frame of a movement instead of only at its end. Markers live on the CLIP (Clip.markers, carried by normalizeClip like fps/step), so they replicate, save and undo with everything else and need no channel of their own. `name` empty = ANY marker on the clip, which is one node for "every beat". Fired LOCALLY on every peer like animfinished: each runtime travels the same clip interval from the same synced stamp, so no message is needed. The crossing is an INTERVAL test between the previous tick position and this one - a marker is a point and the playhead never lands exactly on it - with the destination end inclusive so a marker under a resting playhead cannot re-fire every frame. A LOOP wrapping past the window end fires the two real pieces (prev..end and start..now), never the empty gap between them; pingpong needs none of that, its reflection is continuous. Recipe: Animation Marker -> Sound on a walk cycle.
| latch | Logic | boolean | set reset toggle | NEW (21-E4): **THE UNBLOCK** — a pulse becomes state that HOLDS. Every trigger in this app is a ~0.3s pulse and, before this, nothing converted one into persistent state (`counter` was the only stateful node and its op was a param, not an input), which blocked hide-on-collect, hold-to-show, one-shot doors and cooldowns at once. DETERMINISM, in two halves: `set`/`reset` are a PURE most-recent-stamp-wins read of the replicated trigger log — no state at all — which is strictly better than counting for a late joiner, whose log starts EMPTY (it is not part of the handshake) and which therefore converges on the very next set or reset it sees. `toggle` is the half a stamp cannot express (a stamp is not a count), so its PARITY is counted in `applyNodeTrigger` — the counter precedent, every peer running the same replicated stamp — and any set/reset CLEARS that parity, which is what lets the two halves compose instead of fighting. A same-millisecond set/reset tie reads as SET. Recipe: **On Enter → latch(set) → Visibility = hide-on-collect** (add a Gate `not` to invert, or start `initial` on and reset instead) — no visibility node was needed, it stays the continuous boolean effect it already is. SHIPPED as a one-click recipe in 21-E8 (object menu ▸ Game ▸ Make collectible, `gameRecipes.makeCollectible`), which is that graph plus the `Once` the naive version is missing: the latch holds the object hidden, so a second click looks like a no-op while Set Variable banks the same pickup again (measured 1 → 2). Verdict: the pattern is right, the counting branch needs a one-shot. Spawn/destroy is deliberately NOT here: 21-B B7 owns transient objects. |
| delay | Logic | event | trigger cancel seconds | NEW (21-E4): "3 seconds after the door opens, close it", and every cooldown. FULLY PURE and stateless: the output moment is `input stamp + seconds`, which each peer reaches on its own clock from the ONE replicated stamp, so nothing is scheduled, nothing is stored and nothing is sent — two peers cannot drift and a late joiner needs no catch-up beyond the next pulse. `cancel` is a stamp comparison: a cancel AT or AFTER the trigger drops the pending pulse, one BEFORE it is history (so cancel-then-trigger still fires, which is what a cooldown wants). The derived stamp is withheld until its moment has actually PASSED — load-bearing, because every event consumer acts on a STAMP EDGE and not on a time, so publishing `stamp + seconds` early would make a Delay fire its consumer instantly and look delayed only on the card. Chains (Delay → Delay) work and are cycle-guarded, so a delay CYCLE never fires rather than oscillating. Half of an event's consumers PULL and half PUSH — a Counter's count, a Latch's toggle parity and a Once's freeze all happen inside `applyNodeTrigger` — so `updateDerivedPulses` feeds the derived moment into that path too, with `replicate: false` (every peer computes the same moment from the same input stamp, so broadcasting would count it once per peer). Without it `delay -> counter` would silently do nothing. |
| sequence | Logic | event (step1…step4) | trigger | NEW (21-E4): chained steps off ONE pulse — four ordered event outputs at CUMULATIVE offsets from the input stamp, so each `delayN` field reads as "wait this long, then step N" and step1's default 0 fires immediately. Derived exactly like Delay (pure, nothing scheduled, nothing sent). Its value is a HANDLE MAP (`{__handles}`, the objectflow shape) that `unwrapHandle` resolves per reading edge; `outputType` is per-NODE, so all four handles paint as the event channel. Its own card, being the only node in the group with several outputs. |
| once | Logic | event | trigger rearm | NEW (21-E4): one-shot doors, first-visit triggers. The counter precedent, and unavoidably so: the trigger log keeps only the LAST stamp per node, so a FIRST stamp is not derivable from it. `applyNodeTrigger` therefore writes this node's own entry on the first pulse and FREEZES it at count 1 — which is precisely what a downstream stamp-edge consumer needs in order to act exactly once, and `updateDerivedPulses` forwards that frozen moment ONCE into the PUSH consumers (a Counter, a Latch toggle). Without that forward `once -> counter` was a silent no-op, because `applyNodeTrigger` walks the edges of the node that FIRED and a Once firing is a side effect of its trigger's walk rather than a walk of its own — caught by the suite, not by review. `rearm` DELETES the entry rather than restamping it, because a live stamp on a disarmed Once reads as a fresh pulse to every consumer downstream (`triggerStampFor` sees `lastT` and knows nothing of `count`). DOC — the late-joiner cost, same as Counter's: a joiner's log starts empty, so a Once that already fired for everyone else is still armed for them and will fire on the next pulse they witness. Pair it with a `latch` (which DOES converge) when a late joiner must agree. |
| velocity | Scene | number | target | NEW (CL-C): live speed (m/s) of the wired object (or the graph owner unwired in an object graph). LOCAL feed — exact-ish on the sim initiator (per-step write-back deltas), an ~10Hz move-delta APPROXIMATION on other peers (broadcast-gated; documented on the card); 0 at rest / feed quiet >400ms. Never replicated: peers derive their own estimate. |
| charcontroller | Character | effect (a DECLARATION — wire it to nothing) | speed | NEW (21-E6): **THE MOVEMENT MODEL, as data.** Play mode shipped exactly one, hardcoded in `PointerLockControls`: fly, WASD, scroll for speed — so a game could not have a walker, could not jump, and could not read or write its own speed. This node is deliberately NOT an action: it has no trigger, it is simply PRESENT, read every tick and written to the `charControl` store only ON CHANGE (a per-tick write would be 60 notifications a second to a threlte task and a subscribed component). `mode` fly/walk, `speed`, `jumpHeight`, `eyeHeight`, `gravity`. **THE PARITY CONTRACT: with no charcontroller node in ANY graph, `charControl` is null and PointerLockControls runs the code it always ran** — so this node at its defaults IS the default, which the suite asserts as an A/B over a 1.2s scripted W: measured **7.300 units built-in vs 7.300 with the node, 0.0% apart**, and 7.300 again after DELETING it. The guard was proven able to fail by pinning the node's speed to 0.15 (52.1% apart). Nothing goes on the wire: the DOCUMENT already replicated, so every peer declares the same controller and then drives its OWN camera, which is per-peer by nature. Several controllers in one scene resolve DETERMINISTICALLY (sorted by graph id, last one wins — node order inside a document is the order the author created them, which is the order `nodecreate` replicated them) plus a toast, the `playSettings.playPublishers` precedent. UNITS are deliberately not uniform, and the reason is the parity contract: `speed` IS PointerLockControls' own `moveSpeed`, per-FRAME translate units and the number the scroll wheel has always adjusted (walk mode scales it by `dt * 60`, identical at 60fps and stable when frames drop), while `jumpHeight`/`eyeHeight`/gravity are metres and seconds because they describe the WORLD rather than the input. `eyeHeight` is the eye above the ground in WORLD metres (1.7 = a person) — note `playSettings.eyeHeight` means something else, a LOCAL offset for a camera living in a group at y = 0.9, so its 0.8 default is that same 1.7 world eye; the walker converts through the rig's parent. |
| moveinput | Character | number (x, y) | — | NEW (21-E6): the player's own WASD as a value, so movement input can drive anything a number can. **LOCAL BY NATURE, which is the design and not a limitation**: every peer reads its OWN keys, so a peer pressing nothing reads 0 and always will (asserted two-peer). Streaming a movement axis would be a 60Hz message AND wrong — two players are meant to move independently. Two handles (`x` = A/D, `y` = S/W) as a HANDLE MAP, the Sequence shape, resolved per reading edge by `unwrapHandle`; `outputType` is per-NODE, both being numbers. Its own card, being the only node in the group with several outputs, and the card SAYS it is local — otherwise that is discoverable only as a bug. E5 owns the gamepad/VR stick and feeds these same two axes when it lands, so a graph wired here keeps working with a controller in hand. |
| possessnode | Character | effect | trigger release target | NEW (21-E6): `possess.js` as a trigger-edge node — drive an object with the keys, with its chase/orbit/first/none camera, `speed`/`turnSpeed`/`eyeHeight`/`mouseLook`. Targets an explicit `target` input, else an Object Selector this node feeds, else the owner of an object graph (the physics-action precedence). `release` is a second event input on the SAME card rather than its own node, because a release with no ride is harmless and one card keeps the pairing visible; release is processed FIRST, so a graph pulsing both in one frame means "hand it back". Needs no netcode: the trigger already replicates as a shared stamp, and possess's own movement already broadcasts plain `move`s (the K-D contract), including the mid-sim external-hold path. Possessing = SELECTING, so peers see the usual lock highlight; possess locks `document.body` deliberately (not the canvas) and PointerLockControls' `held` guard already ignores a lock it does not own. |
| camerafollow | Character | effect | trigger stop target | NEW (21-E6): the CAMERA half of possess without the movement half — something else owns the object's transform (the sim, a clip, a peer) and we only fly behind it. No input claim, no selection, no history. **LOCAL, per the `setcamera` house rule**: a peer's graph must never move another peer's camera, so each peer reacts to the shared trigger itself and the views converge with no message. DOC — no framing knobs on purpose: the chase offset lives in possess's SHARED `chaseCamera`, so a distance/offset slider here would silently re-frame the car module's camera too. If per-node framing is wanted, `chaseCamera` has to take it as an argument first. |
| movespeed | Character | number | set value | NEW (21-E6): the movement speed, READABLE and WRITABLE from the graph — which is what closes the user's named ask. `keypress -> Move Speed(set)` is "buttons adjust flying speed", and while a controller is declared the scroll wheel writes the same store, so scroll keeps working AND the graph can see it. The value output reports what is ACTUALLY in force, by the same precedence PointerLockControls uses (live override → the Character Controller's own param → the built-in 0.1); a readout on a different order would show a number that does not move you. Editing a Character Controller's `speed` CLEARS the override, because the author has just said what they want — without that, one scroll would pin the speed for ever and the param would look broken. DOC: with NO Character Controller node the wheel adjusts PointerLockControls' own local variable, which nothing exposes, so the readout sits at the default until something writes the store — `set` works either way, because PointerLockControls prefers the store whenever it is set. LOCAL: speed is per-peer, and the trigger that wrote it already replicated. |

## 21-E6 — the character controller: what it does NOT do, and the parity template

**Ground resolution is TIERED, and the tiering is the honest part.** Full collision needs
a RUNNING SIMULATION, because the rapier world — and every collider in it — exists only
while one runs (`physics.js` creates the world in `startSimulation` and nulls it in
`stopSimulation`). `charController.js` therefore answers "what is under me" in three
tiers, and publishes which one answered on `walkerState.source`:

1. **`rapier`** — a sim is running: a `KinematicCharacterController` with a capsule
   (radius 0.3, half-height derived from `eyeHeight`), resolving the XZ+Y step in ONE
   `computeColliderMovement` call, so walls stop you, slopes and steps work, and you can
   stand on a box. The capsule is **never a scene collider**: it is created straight onto
   the world through the new `physics.physicsRuntime()` getter, so it holds no
   `colliderOwner` entry, is invisible to physics.js's own body list and write-back, and
   can never enter GLTF sync (the scene-root/local rule). Both the impact and sensor paths
   already look every handle up in `colliderOwner` and bail on an unknown one. World
   IDENTITY invalidates the capsule, not a flag someone has to clear — a new simulation is
   a new world object.
2. **`dungeon`** — no world, but a dungeon module published its raster: the EXISTING walk
   (`dungeonPlay.slideMove`), so the dungeon contract is unchanged.
3. **`plane`** — no world, no raster: the scene's ground plane height as a flat floor
   (y = 0 when the ground is switched off). A light scene still walks and still lands; it
   just cannot walk into things. A walker that can fall for ever is not a feature.

**Jump** is Space, edge-triggered inside `charController` because a browser REPEATS
keydown while a key is held: a held Space is exactly one jump, and landing with the key
still down produces none. A press in mid-air is DROPPED rather than queued — a queued one
fires on landing, which reads as an unrequested second jump. Initial velocity is
`sqrt(2 * g * jumpHeight)` with `g` from the scene's own gravity, so a low-gravity scene
jumps higher for free. Space is deliberately NOT `preventDefault`ed and the collision is
already arbitrated: `HudLayer`'s window-CAPTURE handler `stopImmediatePropagation()`s
Space while a HUD screen with focusables is up, so **a menu wins over a jump** — the right
precedence. Nothing in this path consumes Escape.

**Not here:** the gamepad/VR stick (E5 owns it, and feeds `moveinput`'s two axes when it
lands) and per-node chase framing (see `camerafollow` above).

### The parity template — today's default, recreated with nodes

This is both the regression fixture and the "recreate the current camera behaviour with
nodes" exercise. The Character Controller alone reproduces the default; the keypress pair
is the user's "adjust flying speed with buttons" on top of it. Drop it into the scene
graph:

```json
{
  "nodes": [
    { "id": "cc", "type": "charcontroller", "position": { "x": 0, "y": 0 },
      "data": { "type": "charcontroller", "mode": "fly", "speed": 0.1,
                "jumpHeight": 1.2, "eyeHeight": 1.7, "gravity": true } },
    { "id": "faster", "type": "keypress", "position": { "x": 0, "y": 240 },
      "data": { "type": "keypress", "code": "BracketRight", "pulse": 0.3 } },
    { "id": "boost", "type": "movespeed", "position": { "x": 220, "y": 240 },
      "data": { "type": "movespeed", "value": 0.3 } },
    { "id": "readout", "type": "movespeed", "position": { "x": 220, "y": 400 },
      "data": { "type": "movespeed", "value": 0.1 } }
  ],
  "edges": [
    { "id": "e-faster-boost.set", "source": "faster", "target": "boost",
      "targetHandle": "set" }
  ]
}
```

`boost` WRITES the speed when `]` is pressed; `readout` READS whatever is in force
(including a scroll change), which is why its own `value` param is ignored. Swap
`mode: "walk"` on `cc` for a grounded walker with gravity and a jump.

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
