// 2.0 N1 — the Character family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.

import { PLAY_VIEWS, PLAY_VIEW_DEFAULTS } from '../../playViewSettings.js'; // 92-input GC4 (a leaf)
/** the rows every non-first view shows */
const TSZ = { camera: ['third', 'side', 'top'] };

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Character',
	nodes: [
		// ONE card for the movement model. Deliberately a DECLARATION rather than an
		// action: it is not triggered, it is simply PRESENT, and the newest one in
		// the scene wins (with a toast when there is more than one — the
		// playSettings.playPublishers precedent).
		{
			type: 'charcontroller',
			label: 'Character Controller',
			defaults: { mode: 'fly', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7, gravity: true, camera: 'first' },
			// `inputs: []` is not an oversight: an EMPTY list still opts this card into
			// the B6 labelled-row socket layout, so each range param owns the handle in
			// its own row. With `inputs` absent the sockets are placed by pixel offset
			// instead, which drifts away from its labels the moment a select or a
			// toggle sits between two ranges — and this card has both.
			inputs: [],
			params: [
				{ key: 'mode', kind: 'select', options: ['fly', 'walk'] },
				// per-FRAME units: this IS PointerLockControls' own moveSpeed, the number
				// the scroll wheel has always adjusted, and 0.1 is what parity pins it to
				{ key: 'speed', kind: 'range', min: 0.01, max: 1, step: 0.01 },
				// metres — jump and eye height describe the WORLD, not the input
				{ key: 'jumpHeight', kind: 'range', min: 0, max: 5, step: 0.1 },
				{ key: 'eyeHeight', kind: 'range', min: 0.2, max: 3, step: 0.05 },
				{ key: 'gravity', kind: 'toggle' },
				// 92-input GC4a + GC4: how Play LOOKS (playViewSeam.js). first = through the eyes (absent = first,
				// so every saved node is unchanged); third / side / top draw from behind / beside / above the
				// player, who stays exactly where it was for every game rule. Each view's rows show only for it,
				// and an unset row reads its view's own default (`defaultsBy`).
				{ key: 'camera', kind: 'select', options: [...PLAY_VIEWS], doc: 'first = your eyes; third = behind you; side = side-scroller; top = top-down' },
				{ key: 'distance', kind: 'range', min: 0.5, max: 60, step: 0.5, showIf: TSZ },
				{ key: 'height', kind: 'range', min: -2, max: 10, step: 0.1, showIf: { camera: ['third', 'side'] } },
				{ key: 'lookAhead', kind: 'range', min: 0, max: 10, step: 0.1, showIf: { camera: ['side'] } },
				{ key: 'angle', kind: 'range', min: 15, max: 90, step: 1, showIf: { camera: ['top'] } },
				{ key: 'minZoom', kind: 'range', min: 0.5, max: 60, step: 0.5, showIf: TSZ },
				{ key: 'maxZoom', kind: 'range', min: 0.5, max: 120, step: 0.5, showIf: TSZ },
				{ key: 'collide', kind: 'toggle', showIf: { camera: ['third'] } }
			],
			// 92-input GC4: the number an unset view row shows IS the one in force (playViewSettings)
			defaultsBy: { camera: PLAY_VIEW_DEFAULTS },
			// 21-E6 the character controller. `target` is the alternative to wiring the node
			// into an Object Selector (velocity's precedent), and every range param keeps the
			// numeric fallback, so only the EVENT and OBJECT handles need declaring here — an
			// undeclared handle types as 'number', which would refuse an Object Selector.
			sockets: { out: 'effect', in: { speed: 'number' } },
			// 21-E6: the character controller. All spec-driven except Move Input, which is
			// the only one with several OUTPUTS and so needs its own labelled rows.
			card: 'AnimationNode'
		},
		// the player's own WASD as a VALUE, so it can drive anything a number can.
		// LOCAL by nature: every peer reads ITS OWN keys, which is why it has no card
		// params at all — there is nothing to author.
		{
			type: 'moveinput', label: 'Move Input', defaults: {},
			sockets: { out: 'number' },
			card: 'MoveInputNode',
			eval(node, _x, rt) {
				// LOCAL, and that is the design rather than a limitation: every peer reads its
				// OWN keys, so a peer pressing nothing reads 0 and always will. Streaming a
				// movement axis would be a 60Hz message AND wrong — two players are meant to
				// move independently. Two number handles, the Sequence handle-map shape.
				const input = rt.inputRuntimeRef ? rt.inputRuntimeRef.getInput() : null;
				const codes = input?.codes ?? new Set();
				// 92-input GC3: the pad's left stick feeds the same two axes (forward is NEGATIVE on the
				// standard mapping), so a graph wired to Move Input works with a controller in hand
				const pad = input?.pad ?? null;
				const clamp1 = (/** @type {number} */ v) => Math.max(-1, Math.min(1, v));
				const x = clamp1((codes.has('KeyD') ? 1 : 0) - (codes.has('KeyA') ? 1 : 0) + Number(pad?.lx ?? 0));
				const y = clamp1((codes.has('KeyW') ? 1 : 0) - (codes.has('KeyS') ? 1 : 0) - Number(pad?.ly ?? 0));
				return { __handles: { x, y } };
			}
		},
		// possess.js as a node pair on one card. `release` is its own event input
		// rather than a second node, because a release with no matching possession is
		// harmless and one card keeps the pairing visible.
		{
			type: 'possessnode',
			label: 'Possess Object',
			defaults: { camera: 'chase', speed: 4, turnSpeed: 2.5, eyeHeight: 1.7, mouseLook: false, jumpHeight: 1.2 },
			inputs: ['trigger', 'release', 'target'],
			inputLabels: {
				trigger: 'trigger - take control',
				release: 'release - hand it back',
				target: 'target object'
			},
			params: [
				{ key: 'camera', kind: 'select', options: ['chase', 'orbit', 'first', 'none'] },
				{ key: 'speed', kind: 'range', min: 0.1, max: 30, step: 0.1 },
				{ key: 'turnSpeed', kind: 'range', min: 0.1, max: 10, step: 0.1 },
				{ key: 'eyeHeight', kind: 'range', min: 0.2, max: 3, step: 0.05 },
				{ key: 'mouseLook', kind: 'toggle' },
				// 54i k: Space / gamepad A hops the object this high (0 = no jump)
				{ key: 'jumpHeight', kind: 'range', min: 0, max: 5, step: 0.1 }
			],
			sockets: { out: 'effect', in: { trigger: 'event', release: 'event', target: 'object' } },
			card: 'AnimationNode'
		},
		// the camera half of possess WITHOUT the movement half — something else owns
		// the object's transform (the sim, a clip, a peer) and we only fly behind it.
		// No framing knobs: the chase offset is possess's SHARED one, so a distance
		// slider here would silently re-frame the car module's camera too.
		{
			type: 'camerafollow',
			label: 'Camera Follow',
			defaults: {},
			inputs: ['trigger', 'stop', 'target'],
			inputLabels: {
				trigger: 'trigger - start following',
				stop: 'stop - let go',
				target: 'target object'
			},
			sockets: { out: 'effect', in: { trigger: 'event', stop: 'event', target: 'object' } },
			card: 'AnimationNode'
		},
		// read AND write the movement speed, which is what closes the user's named
		// ask: keypress -> movespeed(set) is "buttons adjust flying speed", and the
		// scroll wheel writes the same store while a controller is active.
		{
			type: 'movespeed',
			label: 'Move Speed',
			defaults: { value: 0.1 },
			inputs: ['set'],
			inputLabels: { set: 'set - write the speed' },
			params: [{ key: 'value', kind: 'range', min: 0.01, max: 1, step: 0.01 }],
			// 21-E6 the character controller. Only two of these produce a value: Move Speed
			// reads the live speed and Move Input reads this peer's own WASD. Both of Move
			// Input's handles are numbers, so ONE per-NODE entry covers them (the sequence
			// rule). The other three are DECLARATIONS/ACTIONS and keep the effect channel the
			// fallback would have handed them anyway — listed so the table says so out loud.
			sockets: { out: 'number', in: { set: 'event', value: 'number' } },
			card: 'AnimationNode',
			eval(node, { d }, rt) {
				// the speed that is ACTUALLY in force, by the same precedence
				// PointerLockControls uses: the live override, else the Character Controller's
				// own param, else the built-in default. A readout that used a different order
				// would show a number that does not move you.
				// DOC: with no Character Controller node, the scroll wheel adjusts
				// PointerLockControls' own local variable, which nothing exposes — so the
				// readout stays at the default until something writes the store. `set` works
				// either way, because PointerLockControls prefers the store when it is set.
				return rt.get(rt.playMoveSpeed) ?? rt.get(rt.charControl)?.speed ?? rt.num(d.value ?? rt.DEFAULT_FLY_SPEED);
			}
		}
	]
};
