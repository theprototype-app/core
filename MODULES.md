# Writing modules

<!-- After editing this guide, run `npm run sync-llms` to refresh
     static/llms-full.txt (the AI-readable copy served at /llms-full.txt). -->

Modules are self-contained folders under `src/modules/<name>/` that plug into the
scene, the flow node editor and the peer mesh. Music instruments, playable game
prototypes, generators, custom controls — anything a user should be able to drop
into a session and every connected peer can see and interact with.

## The one rule that matters

**A module runs on every peer.** There is no server. Whatever your module does
must end up identical on all clients, one of three ways:

1. **Deterministic from shared inputs** — effects driven by node `data` (already
   replicated) and the synced clock. No extra work needed. Prefer this.
2. **Broadcast events** — a discrete thing happened ("button pressed",
   "generate with seed 42"). Send a small message with `api.send`, apply the same
   change in the sender and in `api.onMessage`. Never re-broadcast from a
   receiver.
3. **State sync for late joiners** — someone connects mid-session and needs your
   current state (score, generated layout, toggles). Provide
   `registerStateSync`; the handshake delivers it automatically.

Randomness must be seeded (send the seed, not the result — see the dungeon
module). `Math.random()` in anything replicated is a desync.

## Layout and registration

```
src/modules/
  index.js            <- list your module here (all peers need the same list)
  mymodule/
    module.js         <- export default { id, name, version, register(api) }
    SomethingNode.svelte  (optional custom node UI)
```

```js
// src/modules/mymodule/module.js
export default {
	id: 'mymodule',        // stable, unique; used to route your messages
	name: 'My Module',
	version: '1.0.0',      // peers toast when versions differ
	register(api) {
		// wire everything here
	}
};
```

Peers exchange `{id, version}` lists when they connect and warn when a module is
missing or a different version on the other side. That's advisory — the session
still works, but replicated behavior of that module may differ.

## API reference (v1)

### Flow nodes

```js
api.registerNodeGroup(
	{
		group: 'Modules', // palette/context-menu group header
		items: [
			{
				type: 'wave',                 // globally unique node type
				label: 'Wave (hello)',
				defaults: { amplitude: 0.4 }, // seeds node.data, replicated with the node
				params: [                     // optional: auto-generated controls
					{ key: 'amplitude', kind: 'range', min: 0, max: 1.5, step: 0.05 }
					// kind: 'range' (min/max/step), 'select' (options: [...]), 'toggle',
					// or 'text' (placeholder?, maxLength?) — a text param writes on COMMIT
					// (change/blur), never per keystroke: a node edit replicates the whole node
				]
			}
		]
	},
	{ wave: MyWaveNode } // optional: custom Svelte components per type
);
```

Items with `params` render with the built-in generic node UI (sliders/selects
that write through `setNodeData`, which replicates). Custom components should
follow the same pattern: render from `data`, write with
`setNodeData(id, {...})` from `$lib/nodesHandler`, never `bind:` to data.

### Per-frame effects (node → Object Selector)

```js
api.registerEffect('wave', (object, base, data, time) => {
	// base = the object's logical transform: {pos, rot, scale, visible}
	// The runtime restores base before each frame — apply offsets FROM base.
	object.rotation.z = base.rot[2] + Math.sin(time * (data.speed ?? 2)) * (data.amplitude ?? 0.4);
});
```

Effects run when an edge connects your node to an Object Selector node. `time`
is wall-clock synced across peers (when "Sync animations" is on), so pure
functions of `(data, time)` stay identical everywhere. Don't accumulate
(`rotation.z += ...` breaks determinism) — always compute from `base` and `time`.

An effect takes an optional **5th argument** `{id, graphId}` — its own node id and
the graph it sits in, so one module can host many instances of the same node type.
It is additive: a four-parameter effect is unchanged.

```js
api.registerEffect(
	'wave',
	(object, base, data, time, ctx) => {
		// ctx.id = this node's id, ctx.graphId = 'scene' or the owning object's uuid
	},
	{ inputs: { who: 'object' } } // optional: typed named inputs, see below
);
```

### Value nodes: your state into core nodes

A node that **outputs a value**, so module state can drive core nodes — a score into
a HUD Text, a level into Map Range, a flag into a Gate.

```js
api.registerValueNode(
	'score',
	(data, time, ctx) => Number(data.base ?? 0) * Number(data.mult ?? 1),
	{
		vtype: 'number',        // output socket type; also boolean/vector3/color/object/event
		inputs: { mult: 'number' } // typed named inputs, resolved BEFORE fn runs
	}
);
```

**The evaluator MUST be a pure function of its arguments** — the same rule Script
nodes follow, and the one way to break a session silently. Values are never sent:
every peer evaluates the node itself from the replicated node data and the shared
clock. Read unreplicated local state here (a mouse position, a plain module `Map`,
`Math.random()`) and every downstream consumer diverges per peer with no error
anywhere. Keep mutable state in a replicated place — `registerStateSync` /
`api.send` — and read *that*, or let the value ride the node's own `data`.

`inputs` matters more than it looks. Without a declaration every handle types as
`number`, which **refuses** an Object Selector wire (`object -> number` is not a
coercion) and renders no target socket on the card at all. `data.<handle>` is the
wired value when wired and the node's own param when not. `registerEffect` accepts
the same `{inputs}` option.

### Firing your own events

```js
// pulse every instance of the type...
api.fireNodeTrigger('levelcleared');
// ...or just the ones you mean
api.fireNodeTrigger('goal', (data, id) => data.team === 'blue');
```

Register the node with `{vtype: 'event'}` so it can be wired to a Counter or an
Object Selector. **This REPLICATES**, exactly like `fireObjectClick`: the pulse rides
the existing `nodetrigger` message from one peer's stamp, and every peer then computes
the identical pulse. So call it on the peer where the event happened and **not on all
of them**, or a Counter counts it once per peer. `api.peerIds()` and
`api.physics.isInitiator()` are the usual ways to pick that peer.

### Primitives

```js
api.registerPrimitive(
	'Flag',                                    // capitalized: /create Flag 2 1
	(w, h) => new THREE.PlaneGeometry(+w || 2, +h || 1),
	{ label: 'Flag', command: '/create Flag 2 1' } // spawn button on your manager card
);
```

The builder runs on every peer from the same `/create` command, so it must be
deterministic in its arguments.

### Interaction

```js
api.registerClickHandler((object) => {
	if (object.userData.myButton) {
		press(object);                    // apply locally
		api.send({ op: 'press', uuid: object.uuid }); // tell peers
		return true;                      // consume the click (no selection)
	}
	return false;
});
```

Handlers see desktop clicks and VR trigger presses (the exact mesh hit, not the
top-level group). Return `false` to let normal selection continue.

```js
api.registerFrameTask((time) => { /* runs every frame, synced time */ });

// click handlers only see the replicated objects root by default; if your
// module adds its own group at the scene root, register it for clicks:
api.registerInteractiveGroup('pong-module');
```

### Toolboxes: a real UI surface (A5)

```js
const id = api.registerToolbox({
	id: 'settings',              // namespaced to mod-<moduleId>-settings
	title: 'Dungeon Kit',
	width: 240,
	shortcut: 'Ctrl+Shift+D',    // optional; also lists in Settings > Shortcuts
	playMode: false,             // default: hidden in Play mode
	mount(el) {
		const label = document.createElement('div');
		label.className = 'tbx-label';        // the shell styles this for you
		label.textContent = 'Rooms';
		const go = document.createElement('button');
		go.className = 'tbx-primary';
		go.textContent = 'Generate';
		go.onclick = () => regenerate();
		el.append(label, go);
		return () => { /* your cleanup */ };
	}
});
```

Write plain DOM into the node `mount` receives and you inherit the app's own
tool-palette treatment: header drag with position persistence, the width grip, z-band
focus, the bottom SHEET at <=640px, and the whole `.tbx-*` CSS contract (`.tbx-label`,
`.tbx-row`, `.tbx-btn`, `.tbx-seg`, `.tbx-primary`, `.tbx-check`, `.tbx-danger`) with
no CSS of your own. That is the point — before this seam, module controls could only
live behind `registerMenu`, two clicks deep inside the Modules *modal*, which then had
to be closed before the module's own overlay was usable.

The user opens it from the **sidebar's Modules section** and the **viewport menu**
(both from one builder, so they cannot drift), plus your `shortcut` if you name one. It
starts CLOSED: a palette that appears uninvited is the thing `registerMenu` was
avoiding. `onOpen`/`onClose` fire on each transition; the header ✕ closes it.

`mount` returns its cleanup and a re-registration re-runs it, so dev-mode live reload
rebuilds the contents in place. Disabling or removing the module force-closes and
unregisters the toolbox — it never leaves a window behind a dead mount fn.

A toolbox is **LOCAL**: it is this viewer's window, and nothing about it replicates or
is saved with the scene. What it *changes* must still go through the replicated paths
(`api.send`, `api.create`, `api.physics.set`).

### Messages and state

```js
api.onMessage((data) => {          // {type:'module', moduleId, ...payload}
	if (data.op === 'press') press(findByUuid(data.uuid));
});
api.send({ op: 'press', uuid });   // broadcast to all peers

api.registerStateSync({
	getState: () => ({ pressed: [...pressedUuids] }),   // sent to late joiners
	applyState: (state) => state.pressed.forEach(markPressed)
});
```

### Input (K-C)

```js
// declare bindings so they LIST in Settings ▸ Shortcuts (display-only —
// you read the keys yourself via input()/onInput)
api.registerBindings([{ label: 'Drive forward', keys: 'W' }]);

api.registerFrameTask(() => {
	const { codes, axes } = api.input();  // codes: Set<'KeyW'...> (event.code),
	if (codes.has('KeyW')) drive(1);      // axes: {lx,ly,rx,ry} = VR stick axes
});
api.onInput((kind, code) => {});        // 'down'/'up' events; returns unsubscribe

// pause the HOST's use of an input scope while your module drives:
//   'keys'       — WASD camera fly + play-mode movement
//   'locomotion' — VR left-stick locomotion
api.claimInput('keys');                 // ALWAYS release when your mode ends
api.releaseInput('keys');
```

### Pointer ray (190)

```js
// where the user is POINTING, as a THREE.Raycaster in WORLD space: the desktop
// mouse over the viewport, or the VR pointer hand's ray. Fresh instance per
// call; null before the first pointer event. The drag recipe: click to pick,
// follow pointerRay() in a frame task, click to drop (works desktop + VR).
api.registerFrameTask(() => {
	const ray = api.pointerRay();
	if (!ray || !carried) return;
	const hit = ray.ray.intersectPlane(dragPlane, tempVec);
	if (hit) carried.position.copy(hit);
});
```

### Physics (P-A)

All mutations are INITIATOR-ONLY — the peer that started the simulation steps
the world (golden rule: authoritative, never mixed with deterministic). The
blessed recipe for driven physics (pong's paddle pattern): every peer forwards
its INPUT via `api.send({op:'drive', ...})` at ~20Hz, and only the peer where
`api.physics.isInitiator()` is true applies it.

```js
api.physics.isInitiator();              // true while THIS peer runs the sim
api.physics.applyImpulse(uuid, [0, 5, 0]); // push a dynamic body (initiator-only)
api.physics.applyTorqueImpulse(uuid, [0, 2, 0]); // spin a dynamic body (world axes)
api.physics.setJointMotor(jointId, vel, maxForce); // drive a revolute joint
api.physics.joints();                   // Promise<the replicated joint defs>
```

The **car module** (now in the [modules repo](https://github.com/theprototype-app/modules), `modules/car/`) is the worked example: replicated
primitives + motorized revolute joints, click-to-claim (pong's paddle
pattern), driver forwards `{op:'drive', throttle, steer}` at ~20Hz and only
the initiator applies wheel motors. Driving + the chase camera engage only
in Play mode with a running simulation (the module claims `'keys'` and uses
possess's `startFollowCam` while engaged; the claim itself works anytime).

### Building in the shared scene (17-A)

```js
// the replicated /create, handing back what appeared
const [uuid] = await api.create('/create Box 1 1 1');
await api.create('/create Box 0.6 0.6 0.6', { at: [x, y, z] });
api.moveObject(uuid, { pos, rot, scale });        // the editor's replicated move
api.physics.set(uuid, { mode: 'dynamic', mass: 30 });
api.physics.createJoint('revolute', a, b, 'x', { vel: 0, maxForce: 120 });
api.physics.running();   // a sim runs somewhere in the session
api.isPlaying();         // Play mode active
api.peerIds();           // roster - free a departed peer's state
// LOCAL only (a peer's module must never yank your viewpoint):
api.flyTo([x, y, z], [lx, ly, lz]);
api.playSound('pluck', [x, y, z]);
api.followCam(uuid); api.stopFollowCam();
```

### Possess (K-D)

```js
// drive any object with WASD/arrows or the VR left stick (tank controls),
// chase camera by default; Esc releases. Possessing SELECTS the object
// (selection = lock), suspends its flow effects, and records ONE undo entry
// on release. Movement replicates as plain throttled moves.
api.possess(api.selectedUuid(), { camera: 'chase' }); // 'chase'|'orbit'|'none'|'first'
api.releasePossess();
api.possessModes; // this build's camera modes — feature-detect 'first' here
                  // (an unknown camera value degrades silently on old builds)

// 17-A1 first person: eye at the object + eyeHeight; mouseLook = pointer lock
// (X turns the OBJECT so movement follows the look, Y pitches the camera;
// leaving the lock — Esc — releases the possession)
api.possess(uuid, { camera: 'first', eyeHeight: 1.7, mouseLook: true });
```

### Misc

```js
api.registerMenu('Generate dungeon', () => generate()); // sidebar "Modules" section
api.registerVRMenuEntry({                               // sector in the VR radial menu
	id: 'spawn', group: 'root', label: 'Dungeon',         // group 'root' = base ring;
	action: () => generate(), closes: true                // other names make a sub-ring
});                                                     // (id gets prefixed moduleId:)
api.sceneAssets();  // Promise<[{group, name, kind, hash}]> — what the shared
                    // scene uses right now (audio/config/textures manifest)
api.scene();        // THREE.Scene
api.objectsGroup(); // the replicated objects root (add scene content here)
api.peerId();       // our peer id (undefined before the mesh is up)
api.toast('hi');    // toast in the corner
api.haptic(0.6, 60);          // buzz the VR controllers (no-op on desktop);
api.haptic(0.6, 60, 'right'); // optional hand targets one controller (17-A1)
api.isVR();                   // true inside a VR session
api.vrHand('left');           // one hand's WORLD pose + buttons, or null:
                              // {position, quaternion, trigger, gripped, connected}
api.fireObjectClick(uuid);    // pulse On Click flow nodes targeting the object
                              // (replicated) — user graphs react to module events
api.now();          // the runtime clock in seconds — stamp replicated
                    // timestamps with this, never Date.now() directly
```

Objects your module adds to `objectsGroup()` are part of the shared scene:
they get GLTF-synced to late joiners, appear in the object list, and can be
moved/deleted by anyone. Objects that are *derived* state (e.g. a generated
dungeon) are better added outside `objectsGroup()` and rebuilt from your
module state — then they can't drift.

## Walkthrough: the hello module

`src/modules/hello/module.js` is the smallest complete module: one node group
+ one effect, zero messages (fully deterministic). Open the flow editor, drag
in **Wave (hello)** and an **Object Selector**, pick an object, connect them —
the object rocks on every peer.

## Walkthrough: build a door (button module)

The button module (`src/modules/button/`) shows the interactive pattern:

1. Add a **Button** from the sidebar Modules group (or use any object).
2. Add a **Wall/Cube** where the door should be.
3. Open the flow editor: drag in **Button trigger** and an **Object Selector**.
4. In the Button trigger node pick the button object; in the Object Selector
   pick the door object; connect trigger → selector.
5. Click the button in the viewport (or pull the VR trigger on it): the door
   slides up by `height` on every peer. Toggle mode keeps it open, push mode
   springs back after 1.5 s.

How it replicates: the click writes `{pressed, at: api.now()}` into the node's
data (replicated like any node edit); the slide is a pure function of
`(data, time)` running on each peer — no motion messages at all. The
`registerClickHandler` consumes the click so pressing doesn't select the button.

## Manager, dev mode & gallery (17-A2/A3)

User modules install, update, disable and remove **live** — `deactivateModule`
runs the per-module teardown journal (every `api.register*` records an undo
thunk), so nothing needs a page reload. Core modules keep reload-to-disable
(they may wire core registries outside the api surface, e.g. vrsleeve).

Every user-module card carries a **Dev URL** row: **Reload** fetches fresh code
(cache-busted), evaluates it FIRST, then tears down + re-registers — a broken
body keeps the old instance running. **Auto** polls (~2s) and reloads on
change. Peers toast the `{id,version}` mismatch while you iterate (correct —
the dev peer differs). The **Browse** tab lists the community repo
(`theprototype-app/modules`, `index.json` via jsDelivr — `moduleGallery.js`);
installs go through `installUrl` with the entry's source folder, so Update and
the dev reload keep working on gallery installs.

## Checklist before you ship one

- [ ] Everything a user can do through your module looks the same on a second
      connected browser (test with two windows).
- [ ] A peer who connects *after* your module did something catches up
      (state sync or derivable-from-scene).
- [ ] No `Math.random()` without a broadcast seed; no accumulation in effects.
- [ ] Receiving a message never re-broadcasts it.
- [ ] `id` unique, node `type`s unique, version bumped on behavior changes.
