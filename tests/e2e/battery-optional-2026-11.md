# Battery suites moved to optional, 2026-11-23 (deps-2026-11, core #628)

Moved by `battery.cjs refresh --red` from two runs on unchanged code: deps.yml dispatched on `deps` 26b995ec (v1.72.0, run 45088358423) and #519, a CI-script-only change on the same base (run 45071918356). **82 of the 85 are green in the integrators desk battery at the v1.72.0 tag** (`battery-t172-full`, 61-int, 652 suites), so their reds belong to the runner, not the app. The three red on the desk too are agent-mcp (env), connector-join (flaky on the desk, green on the tag rerun) and session-volume-limits (real).

Bringing a suite back to required: fix the cause, see it green in a deps.yml run, then delete its `optional` line in battery.json and its row here. Classes: env (the runner lacks something), timing (a wait or frame-rate check on a slow runner), real (the app is wrong).

## real: red on the desk battery at the v1.72.0 tag as well, a product question (own card) (1)

| suite | runner runs red | why | first red line |
|---|---|---|---|
| `session-volume-limits` | 2/2 | red on the desk battery at v1.71 and v1.72 too: "narrowing to None ends the running send" (2 FAIL); own card | SCRIPT FAILED: page.evaluate: Error: idb put timed out after 10000ms |

## timing, unproven: green on the desk at v1.72.0, the same check red in both runner runs, no cause found yet; check these first (8)

| suite | runner runs red | why | first red line |
|---|---|---|---|
| `character-download` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL ...and still lets you download (warn, never block) |
| `peers-polish-78` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL Network is folded behind one row (hidden false) |
| `player-access` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL 3.4 ↑ fires it — the Game Sound downstream captions (6 → 8) |
| `roster-sender` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL the approved id links to the guest |
| `save-project-libraries` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL alone with one library, Ctrl+S saves the scene into my own Library (a new version) |
| `save-project-libraries-viewer` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL the dialog for the viewer |
| `sequence-card` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL premise: a step is lit after the pulse (step1 / step2 / step3 / step4) |
| `test-players` | 2/2 | UNPROVEN: green on the desk at v1.72.0, red in both runner runs on the same check, no cause found; check first (a race only a slow runner shows would be real) | FAIL the strip counts what a bot TRIED, not its join burst (57 refused: ["lock","modules","environment","music","scenephysics","transport","patch","en |

## env (content pins): the suite reads modules/scenes/packs content the runner checks out at the battery.json refs (2026-10-13/22); recheck after the pin bump (9)

| suite | runner runs red | why | first red line |
|---|---|---|---|
| `character-avatars-source` | 2/2 | the CC0 avatar list and its placement come from the packs pin (2026-10-13) | FAIL Avatars: the two CC0 avatars list by default (the CC-BY one does not) |
| `character-clip-assets` | 2/2 | the knight clip assets (Kick) come from the packs/modules pins; thigh moves 0.0000 in both runs | FAIL A: the knight plays Kick |
| `character-vrm` | 2/2 | VRM files from the packs pin; the humanoid map check reads the file | FAIL the humanoid map comes from the file ({"via":"names","rig":"mixamo","ok":true,"hips":"mixamorigHips","upperChest":"mixamorigSpine2"}) |
| `gem-arena-nodes` | 2/2 | the arena world comes from the scenes pin (2026-10-22); Play on A runs nothing in both runs | FAIL Play on A runs the all-static arena's world (F11) |
| `kit-late-pickups` | 2/2 | the kit gems come from the modules pin; 3.2 red in both runs | FAIL 3.2 …and its gems are HIDDEN (the value nodes read the landed document) |
| `tpanim-clips` | 2/2 | clip assets from the packs pin (+ idb timeouts under load) | FAIL M1: the clip is bound and playing on A |
| `tpanim-motion` | 2/2 | clip assets from the packs pin (+ idb timeouts, a 600 s timeout) | FAIL three clip assets bound on A |
| `tpanim-states` | 2/2 | clip assets from the packs pin (+ idb timeouts under load) | FAIL four clips bound on A |
| `two-levels-template` | 2/2 | the courtyard template scene comes from the scenes pin | FAIL 2.1 the walker stands on the courtyard floor (rapier tier) |

## env (GPU): needs what SwiftShader on a 2-core runner does not give (path tracer, frame-cost budgets, WebGL2 probes, encoders) (6)

| suite | runner runs red | why | first red line |
|---|---|---|---|
| `bake-light` | 2/2 | lightmap tracing on SwiftShader runs past the 480 s watchdog | FAIL 2.1 premise: cancelled while tracing (Unwrapping lightmap UVs) |
| `load-check` | 2/2 | texture round-trip of an exported glTF on SwiftShader (found:false in both runs) | FAIL an exported glTF arrives with its texture ({"found":false}) |
| `moment-share` | 2/2 | a frame-cost budget (1 ms) measured on SwiftShader: 282 ms | FAIL the buffer's mean main-thread cost per frame is within the 1 ms desktop budget (282.489 ms) |
| `photo-mode` | 2/2 | the path tracer does not start on SwiftShader ("The renderer did not start in time") | FAIL 2c premise: the photo linked a path-tracer program ({"ok":false,"error":"The renderer did not start in time.","links":[{"inCompile":true,"toneMap |
| `shader-own-glsl-sync` | 2/2 | the GLSL probe worker needs its own WebGL2 context; SwiftShader on a 2-core runner | FAIL P runs it |
| `video-export` | 2/2 | WebCodecs encode on a GitHub runner; the export UI never appears in both runs | SCRIPT FAILED: page.waitForSelector: Timeout 10000ms exceeded. |

## env (network/hosts): needs a host the runner does not reach (1)

| suite | runner runs red | why | first red line |
|---|---|---|---|
| `agent-mcp` | 2/2 | also red on the desk at 1.72 ("signaling came from the link": needs peerjs.theprototype.app); click timeout on the runner | SCRIPT FAILED: locator.click: Timeout 90000ms exceeded. |

## timing: green on the desk at v1.72.0; on the runner a wait/click timeout or a frame-rate/heartbeat check, or red in one run only (60)

| suite | runner runs red | why | first red line |
|---|---|---|---|
| `agent-chat-window` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: connect: could not press Connect on 736a2 |
| `agent-proof` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: locator.click: Timeout 5000ms exceeded. |
| `ai-connection` | 2/2 | a frame-rate/heartbeat dependent check (physics, walking, peer timeouts) on a ~4 fps SwiftShader runner | FAIL §6 ... within the stage timeout (18198 ms) |
| `ai-vision` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForSelector: Timeout 5000ms exceeded. |
| `asset-ask-scope` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL None: a file the scene references still travels, read from the scene itself |
| `character-apply` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForSelector: Timeout 15000ms exceeded. |
| `character-skeleton` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForSelector: Timeout 15000ms exceeded. |
| `characters-proof` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: locator.click: Timeout 10000ms exceeded. |
| `chat-media` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: page.waitForFunction: Timeout 15000ms exceeded. |
| `cinematic-view` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL the first-use hint shows once and is remembered (shown false, seen 1) |
| `click-once` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: connect: could not press Connect on 803fd |
| `code-files` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL the new script opens in a Code tab |
| `connector-join` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL B connected to Claude |
| `connector-relay` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL the tab is connected |
| `drafts-leak` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: connect: could not press Connect on 18de3 |
| `explorer-views` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL the purge freed the record and the blob |
| `film-mode` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL the live take committed |
| `film-walk-iwer` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: page.waitForSelector: Timeout 15000ms exceeded. |
| `fix-live` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForFunction: Timeout 90000ms exceeded. |
| `flow-clock-origin` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL premise: after the 3 s ramp the wheel turns near 60 rpm (2.02 of 6.28 rad/s) |
| `flow-code-view` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForSelector: Timeout 10000ms exceeded. |
| `hover-toggle-nodes` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL toggle from ajar closes it ({"ry":0,"isOpen":true,"pose":1,"state":"ajar"}) |
| `image-to-3d` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForSelector: Timeout 8000ms exceeded. |
| `import-file` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL A files it in the nested folder too |
| `invite-link-live` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: locator.click: Timeout 30000ms exceeded. |
| `invite-links` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: locator.click: Timeout 5000ms exceeded. |
| `levels-progress` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.evaluate: Error: idb get timed out after 10000ms |
| `lock-sender` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL F has the boxes |
| `material-map-slots` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: page.waitForFunction: Timeout 90000ms exceeded. |
| `mesh-gen-window` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: page.click: Timeout 30000ms exceeded. |
| `modal-layering` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: page.waitForSelector: Timeout 5000ms exceeded. |
| `model-replace` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForEvent: Timeout 15000ms exceeded while waiting for event "filechooser" |
| `net-drop` | 2/2 | a frame-rate/heartbeat dependent check (physics, walking, peer timeouts) on a ~4 fps SwiftShader runner | FAIL QUIET 5s drop: each peer kept the other in its roster, and B's lock stood, throughout (A lost B at 33800ms, A dropped B's lock at 36431ms) |
| `network-disconnect` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL A removes B from the peer list once the reconnect window exhausts (avatar gone) |
| `onboarding` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: locator.waitFor: Timeout 30000ms exceeded. |
| `peer-moderation` | 2/2 | a wait/click timeout in both runs on a loaded runner | FAIL premise: the mesh filled (B <-> C) |
| `physics-pace` | 2/2 | a frame-rate/heartbeat dependent check (physics, walking, peer timeouts) on a ~4 fps SwiftShader runner | FAIL 1.1 the world moves to B within ~15 s (A stops stepping, B steps) |
| `player-sensors` | 2/2 | a frame-rate/heartbeat dependent check (physics, walking, peer timeouts) on a ~4 fps SwiftShader runner | FAIL e050a: walks past the sensor |
| `possess` | 2/2 | a frame-rate/heartbeat dependent check (physics, walking, peer timeouts) on a ~4 fps SwiftShader runner | FAIL the hop lands |
| `preview-pin-edit` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | [battery] TIMEOUT after 780s |
| `profile-notify` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForSelector: Timeout 5000ms exceeded. |
| `reload-rejoin` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: locator.click: Timeout 10000ms exceeded. |
| `roles-wait` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL the plugin arrives: the host's world lands, nothing was lost |
| `roster-guest-admit` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: locator.fill: Timeout 30000ms exceeded. |
| `roster-merge` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: connect: could not press Connect on 2ded2 |
| `save-open-fixes` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | SCRIPT FAILED: page.waitForEvent: Timeout 60000ms exceeded while waiting for event "download" |
| `scatter-surface` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | [battery] TIMEOUT after 714s |
| `session-volume-phone` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL premise: the volume arrived |
| `shader-own-glsl` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: locator.click: Timeout 10000ms exceeded. |
| `text-object` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForFunction: Timeout 30000ms exceeded. |
| `toggle-peers` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: connect: could not press Connect on b64d5 |
| `uir-chat` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.waitForFunction: Timeout 30000ms exceeded. |
| `union-48` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL U2.3 Step starts the cutscene |
| `union-51` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: locator.click: Timeout 30000ms exceeded. |
| `vr-logic-iwer` | 2/2 | a wait/click timeout in both runs on a loaded runner | FAIL a wire drag is refused and says why () |
| `vr-measure-iwer` | 2/2 | a wait/click timeout in both runs on a loaded runner | SCRIPT FAILED: page.click: Timeout 30000ms exceeded. |
| `vr-panels-v3` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL cursor row has all row actions () |
| `vr-settings-36` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL in the headset the RIGHT stick now walks (z -0.22) |
| `vr-universal-world-grab` | 2/2 | a frame-rate/heartbeat dependent check (physics, walking, peer timeouts) on a ~4 fps SwiftShader runner | FAIL 7.7 the vignette closes in while the world scales (peak 0.05) |
| `walker-step-off` | 1/2 | red in one of the two runs only (flaky on a loaded runner) | FAIL 1.1 the walker stands on the 0.4 m platform (rapier tier, grounded) |

