# Writing modules

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
					// kind: 'range' (min/max/step) or 'select' (options: [...])
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

### Primitives

```js
api.registerPrimitive(
	'Flag',                                    // capitalized: /create Flag 2 1
	(w, h) => new THREE.PlaneGeometry(+w || 2, +h || 1),
	{ label: 'Flag', command: '/create Flag 2 1' } // sidebar entry (group: 'Modules')
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
api.registerInteractiveGroup('piano-module');
```

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

### Misc

```js
api.registerMenu('Generate dungeon', () => generate()); // sidebar "Modules" section
api.scene();        // THREE.Scene
api.objectsGroup(); // the replicated objects root (add scene content here)
api.peerId();       // our peer id (undefined before the mesh is up)
api.toast('hi');    // toast in the corner
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

## Checklist before you ship one

- [ ] Everything a user can do through your module looks the same on a second
      connected browser (test with two windows).
- [ ] A peer who connects *after* your module did something catches up
      (state sync or derivable-from-scene).
- [ ] No `Math.random()` without a broadcast seed; no accumulation in effects.
- [ ] Receiving a message never re-broadcasts it.
- [ ] `id` unique, node `type`s unique, version bumped on behavior changes.
