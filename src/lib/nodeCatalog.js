// Catalog of all available node types, grouped for the palette and context menu.
// `defaults` seeds node.data on creation (and gets replicated to peers with the node).
// `params` describes the controls rendered by AnimationNode-style generic nodes.
// Modules contribute additional groups through moduleNodeGroups (moduleSDK).

import { get } from 'svelte/store';
import { moduleNodeGroups } from './moduleSDK';
import { particlePreset } from './particlePresets';

/**
 * A1: `kind: 'text'` is a free-text param. It writes on COMMIT (change/blur),
 * never per keystroke — a node edit replicates the whole node, so an input-time
 * write is one broadcast per character. `placeholder`/`maxLength` are hints for it.
 *
 * 21-B B6: `inputs` declares NAMED target sockets (trigger, force, target…) and
 * `inputLabels` gives one a friendlier label than its wire name. A spec with
 * `inputs` renders its sockets as labelled ROWS instead of by pixel offset.
 * @typedef {{ key: string, kind: 'range' | 'select' | 'toggle' | 'text', min?: number, max?: number, step?: number, options?: string[], placeholder?: string, maxLength?: number }} NodeParam
 * @typedef {{ type: string, label: string, defaults: Record<string, any>, params?: NodeParam[], inputs?: string[], inputLabels?: Record<string, string> }} NodeSpec
 */

/** @type {{ group: string, items: NodeSpec[] }[]} */
export const nodeCatalog = [
	{
		group: 'Input',
		items: [
			{ type: 'slider', label: 'Slider', defaults: { value: 20, min: 0, max: 40 } },
			{ type: 'colorpicker', label: 'Color Picker', defaults: { color: '#ff4000' } },
			{ type: 'switcher', label: 'Switcher', defaults: { items: ['cube', 'pyramid'], index: 0, shape: 'cube' } },
			// 133: value inputs — feed consumer node handles (deterministic)
			{ type: 'number', label: 'Number', defaults: { value: 1, step: 1 } },
			{ type: 'vector3', label: 'Vector3', defaults: { x: 0, y: 0, z: 0 } },
			{ type: 'toggle', label: 'Toggle', defaults: { on: false } },
			// B6: it was ALREADY deterministic across peers — mulberry32 over the node
			// id and the synced clock — so a wired seed is the whole change
			{
				type: 'random',
				label: 'Random',
				defaults: { min: 0, max: 1, interval: 0, seed: 0, integer: false },
				inputs: ['seed', 'reroll'],
				params: [{ key: 'integer', kind: 'toggle' }]
			},
			{ type: 'time', label: 'Time', defaults: { mode: 'sin', rate: 1 } }
		]
	},
	{
		group: 'Scene',
		items: [
			{ type: 'objectselector', label: 'Object Selector', defaults: { selected: '-None-' } },
			// CL-C C3: live speed (m/s) of the wired object — LOCAL feed, exact on
			// the sim initiator, ~10Hz move-delta approximation on other peers
			{ type: 'velocity', label: 'Velocity', defaults: {} },
			// B6: the numbers a rule graph asks for — how tall is this, where is its
			// top. From colliderSpecOf, the same spec physics builds the body from.
			{
				type: 'measure',
				label: 'Measure',
				defaults: { read: 'top' },
				inputs: ['target'],
				inputLabels: { target: 'target object' },
				params: [{ key: 'read', kind: 'select', options: ['top', 'bottom', 'height', 'y', 'speed'] }]
			}
		]
	},
	{
		// H5: object-flow composition — Flow Input/Output DECLARE an object flow's
		// public sockets; Object Flow embeds a flow into the scene graph with those
		// sockets. Interface nodes only mean something inside an object flow.
		group: 'Object Flow',
		items: [
			{ type: 'flowinput', label: 'Flow Input', defaults: { name: 'value', vtype: 'number', fallback: 0 } },
			{ type: 'flowoutput', label: 'Flow Output', defaults: { name: 'out', fallback: 0 } },
			{ type: 'objectflow', label: 'Object Flow', defaults: { flowUuid: '' } }
		]
	},
	{
		// 21-D6: THE GAME SHELL — the things a HUD action can target. Core had no notion
		// of a game running at all (play mode is per-viewer and unreplicated), so a Start
		// button had nothing to write to.
		group: 'Game',
		items: [
			// the action a Start button wires to. Acts on the trigger's STAMP EDGE.
			{
				type: 'setgamestate',
				label: 'Set Game State',
				defaults: { state: 'playing', outcome: '' },
				params: [
					{ key: 'state', kind: 'select', options: ['menu', 'playing', 'paused', 'over'] },
					{ key: 'outcome', kind: 'text', placeholder: 'won / lost', maxLength: 40 }
				]
			},
			// the event half: pulses when the game ENTERS (or leaves) a state, so screens and
			// logic can react without polling
			{
				type: 'ongamestate',
				label: 'On Game State',
				defaults: { state: 'playing', edge: 'enter', pulse: 0.3 },
				params: [
					{ key: 'state', kind: 'select', options: ['menu', 'playing', 'paused', 'over'] },
					{ key: 'edge', kind: 'select', options: ['enter', 'exit'] }
				]
			},
			// LOCAL on every peer, from a replicated trigger — the house rule. A peer's node
			// must never move another peer's camera, so each one decides for itself and the
			// views converge because the TRIGGER replicated, not the camera.
			{ type: 'setcamera', label: 'Set Active Camera', defaults: { camera: '', restore: false } },
			// L-C: switch a LOOK on or off. The camera input picks WHOSE look (empty = the
			// scene's); the switch is a per-peer runtime override, not an edit to the
			// authored document, so it needs no message of its own — the trigger already
			// replicated, the hudScreenOverride rule.
			// `activate` defaults TRUE because that is what the name promises and what the
			// first user wired it expecting: R -> that camera, with its grade. A camera look
			// only composes while you are LOOKING THROUGH that camera, so a node that sets
			// the look without moving the view is silent — measured, and reported.
			{ type: 'setlook', label: 'Set Look', defaults: { camera: '', on: true, activate: true } },
			// "which camera does the game start from" — placed in the SCENE graph. Every peer
			// acts on it when the state enters `playing`, including a late joiner, which is
			// what makes it the answer rather than a one-shot button action.
			{ type: 'gamestart', label: 'Game Start', defaults: { camera: '', state: 'playing' } },
			// variables: the shared numbers a game keeps (score, lives, difficulty). They
			// ride the same singleton, so there is one latest-wins rule for all game state.
			{
				type: 'setvariable',
				label: 'Set Variable',
				defaults: { name: 'score', value: 0, op: 'set' },
				params: [
					{ key: 'name', kind: 'text', placeholder: 'score', maxLength: 40 },
					{ key: 'op', kind: 'select', options: ['set', 'add', 'subtract'] }
				]
			},
			{
				type: 'getvariable',
				label: 'Get Variable',
				defaults: { name: 'score', fallback: 0 },
				params: [{ key: 'name', kind: 'text', placeholder: 'score', maxLength: 40 }]
			},
			// the round clock, derived from the shared startedAt stamp — no clock of its own
			{
				type: 'gametime',
				label: 'Game Time',
				defaults: { read: 'elapsed', length: 60 },
				params: [
					{ key: 'read', kind: 'select', options: ['elapsed', 'remaining', 'round', 'playing'] },
					{ key: 'length', kind: 'range', min: 1, max: 3600, step: 1 }
				]
			}
		]
	},
	{
		// A3: the core HUD group. Nodes supply DATA and receive EVENTS; the HUD
		// DOCUMENT owns WHERE things are, so every node here names an element by id
		// rather than carrying a position.
		//
		// The most useful thing to know about this group: THE SCORE DISPLAY IS
		// `counter -> hudtext` AND NEEDS NO NODE OF ITS OWN. Counter already counts
		// replicated pulses, and Math / Number / Map Range / Animation State already
		// feed a number socket through resolveInputs.
		group: 'HUD',
		items: [
			// show / hide / toggle a screen. LOCAL and per-peer BY DESIGN: one player can
			// sit on the start menu while another plays. Say so on the card, or it gets
			// reported as "my peer doesn't see the menu".
			{
				type: 'hudscreen',
				label: 'HUD Screen',
				defaults: { screen: '', action: 'show' },
				params: [
					{ key: 'screen', kind: 'text', placeholder: 'screen id', maxLength: 64 },
					{ key: 'action', kind: 'select', options: ['show', 'hide', 'toggle'] }
				]
			},
			// `format` is where the score actually gets rendered: '{v}' is the wired
			// number, so 'Gems: {v}' needs no string node and there is no string socket
			// type to invent.
			{
				type: 'hudtext',
				label: 'HUD Text',
				defaults: { element: '', format: '{v}', decimals: 0, value: 0 },
				params: [
					{ key: 'format', kind: 'text', placeholder: 'Gems: {v}', maxLength: 120 },
					{ key: 'decimals', kind: 'range', min: 0, max: 4, step: 1 }
				]
			},
			{
				type: 'hudbar',
				label: 'HUD Bar',
				defaults: { element: '', min: 0, max: 100, value: 0, format: '' },
				params: [
					{ key: 'min', kind: 'range', min: -1000, max: 1000, step: 1 },
					{ key: 'max', kind: 'range', min: -1000, max: 1000, step: 1 },
					{ key: 'format', kind: 'text', placeholder: 'optional label', maxLength: 80 }
				]
			},
			// EVENT out. A press goes through the existing replicated nodetrigger path
			// (fireHudButton), exactly like fireObjectClick — so event->number coercion,
			// Counter fan-in and triggerStampFor all work on it unchanged.
			{ type: 'hudbutton', label: 'HUD Button', defaults: { element: '' } },
			// counts DOWN from `duration` off the shared trigger stamp, so every peer
			// reads the same remaining time with no clock of its own
			{
				type: 'hudtimer',
				label: 'HUD Timer',
				defaults: { element: '', duration: 60, format: '{v}', decimals: 0, autostart: true },
				params: [
					{ key: 'duration', kind: 'range', min: 1, max: 600, step: 1 },
					{ key: 'format', kind: 'text', placeholder: '{v}s', maxLength: 80 },
					{ key: 'decimals', kind: 'range', min: 0, max: 2, step: 1 },
					{ key: 'autostart', kind: 'toggle' }
				]
			},
			// A LIST is an element WRITTEN INTO by id, never a value that flows: the
			// socket system has no arrays, and every game wants a leaderboard. A module
			// pushes rows through hudRows(); this node names the element and its title.
			{
				type: 'hudlist',
				label: 'HUD List',
				defaults: { element: '', title: '', rows: 5 },
				params: [
					{ key: 'title', kind: 'text', placeholder: 'optional title', maxLength: 80 },
					{ key: 'rows', kind: 'range', min: 1, max: 20, step: 1 }
				]
			},
			// 21-D4: the INPUT pair. Everything else in this group WRITES to the HUD;
			// these are the direction that did not exist - the HUD as a SOURCE.
			//
			// `read` is what a graph wants from one control: a slider gives a number, a
			// dropdown gives its index (for a Switcher) or its text, a toggle gives 1/0.
			// Deriving all of them from one field beats four node types.
			{
				type: 'hudinput',
				label: 'HUD Input',
				defaults: { element: '', read: 'value', fallback: 0 },
				params: [
					{ key: 'read', kind: 'select', options: ['value', 'index', 'text', 'on'] },
					{ key: 'fallback', kind: 'range', min: -1000, max: 1000, step: 1 }
				]
			},
			// the other direction: a graph MOVES a control (a Reset button putting the
			// volume back, a difficulty the host sets). Effect in, so it fires on a
			// trigger edge rather than every frame.
			{
				type: 'hudset',
				label: 'HUD Set Input',
				defaults: { element: '', value: 0 },
				params: [{ key: 'value', kind: 'range', min: -1000, max: 1000, step: 1 }]
			}
		]
	},
	{
		group: 'Logic',
		items: [
			{
				type: 'script',
				label: 'Script',
				defaults: {
					code:
						'// runs every frame on every peer (keep it deterministic)\n' +
						'// object: the connected THREE object; base: {pos, rot, scale, visible}\n' +
						'// data: this node\'s data (incl. wired a/b/c inputs); time: synced seconds\n' +
						'object.position.y = base.pos[1] + Math.sin(time * 2) * 0.5;\n'
				}
			},
			// 133: pure logic on wired inputs (deterministic, no streaming)
			{ type: 'math', label: 'Math', defaults: { op: 'add', a: 0, b: 0 } },
			{ type: 'compare', label: 'Compare', defaults: { op: 'gt', a: 0, b: 0 } },
			{ type: 'gate', label: 'Gate', defaults: { op: 'and', a: false, b: false } },
			// 4.6: loop-closers from the NODES.md audit
			{ type: 'maprange', label: 'Map Range', defaults: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: true, a: 0 } },
			// 4.6 -> 21-E4: Select grew N-WAY. a/b keep their handle ids, so every saved
			// 2-input graph is byte-identical (see the clamp note in evalNodeBody).
			{ type: 'select', label: 'Select', defaults: { index: 0, a: 0, b: 0 } },
			// --- 21-E4: the logic a game LOOP is made of. Every trigger in this app is a
			// ~0.3s pulse and, before these, NOTHING turned a pulse into persistent state:
			// `counter` was the only stateful node and its op was a param, not an input. That
			// one gap blocked hide-on-collect, hold-to-show, one-shot doors and cooldowns at
			// the same time.
			//
			// THE UNBLOCK: a pulse becomes a boolean that HOLDS. Deterministic with no new
			// message - `set`/`reset` compare the replicated trigger STAMPS every peer
			// already has (most recent wins), which is strictly better than counting for a
			// late joiner: it converges on the very next pulse of either kind. `toggle` is
			// the one half that cannot be pure (a stamp is not a count) and takes the
			// counter precedent instead - counted in applyNodeTrigger, which every peer runs
			// from the same replicated stamp.
			{
				type: 'latch',
				label: 'Latch',
				defaults: { initial: false },
				inputs: ['set', 'reset', 'toggle'],
				inputLabels: { set: 'set - turn on', reset: 'reset - turn off', toggle: 'toggle - flip' },
				params: [{ key: 'initial', kind: 'toggle' }]
			},
			// "3 seconds after the door opens, close it", and every cooldown. PURE: the
			// output fires at stamp + seconds, which each peer reaches on its own clock from
			// the one shared stamp, so nothing is scheduled and nothing is sent.
			{
				type: 'delay',
				label: 'Delay',
				defaults: { seconds: 1, pulse: 0.3 },
				inputs: ['trigger', 'cancel'],
				inputLabels: { trigger: 'trigger', cancel: 'cancel - drop a pending pulse' },
				params: [{ key: 'seconds', kind: 'range', min: 0, max: 60, step: 0.1 }]
			},
			// chained steps off ONE pulse. Four fixed outputs, each at its CUMULATIVE offset
			// from the input stamp - derived exactly like Delay, so a step is a pure
			// function of (stamp, params, synced time). Its own card: four source handles.
			{
				type: 'sequence',
				label: 'Sequence',
				defaults: { delay1: 0, delay2: 0.5, delay3: 0.5, delay4: 0.5, pulse: 0.3 },
				inputs: ['trigger']
			},
			// one-shot doors, first-visit triggers. The FIRST stamp is not derivable from a
			// trigger log that keeps only the LAST one, so this is the counter precedent:
			// applyNodeTrigger freezes the first stamp on the node's own entry and `rearm`
			// clears it.
			{
				type: 'once',
				label: 'Once',
				defaults: { pulse: 0.3 },
				inputs: ['trigger', 'rearm'],
				inputLabels: { trigger: 'trigger', rearm: 'rearm - allow it again' }
			},
			// 134: loops, timers, sensors + object actions (all deterministic)
			{ type: 'loop', label: 'Loop', defaults: { from: 0, to: 1, rate: 1, mode: 'wrap' } },
			{ type: 'timer', label: 'Timer', defaults: { delay: 1, a: 0 } },
			{ type: 'distance', label: 'Distance', defaults: {} },
			{ type: 'proximity', label: 'Proximity', defaults: { radius: 3 } },
			{ type: 'lookat', label: 'Look At', defaults: {} },
			{ type: 'setcolor', label: 'Set Color', defaults: { color: '#ff4000' } },
			{ type: 'visibility', label: 'Visibility', defaults: { on: true } },
			// SH7: write a shader-graph uniform. `uniform` is the generated name the Shader
			// editor shows beside a uniform-backed param; the value rides a number socket, so
			// no recompile and no message of its own (the flow value is already replicated).
			{ type: 'setuniform', label: 'Set Shader Uniform', defaults: { uniform: '', value: 0 } }
		]
	},
	{
		group: 'Triggers',
		items: [
			// 134: EVENT nodes — ride small replicated trigger messages, not state
			{ type: 'onclick', label: 'On Click', defaults: { pulse: 0.3 } },
			// H3: keyboard trigger — LOCAL key presses replicate as trigger pulses
			// (golden rule: never stream local state); held keys re-pulse so the
			// output stays high while held
			{ type: 'keypress', label: 'Key Press', defaults: { code: 'KeyR', pulse: 0.3 } },
			// PFX-C: fires when the physics sim lands this object on the ground /
			// another object (initiator-detected, replicated trigger stamp)
			{
				type: 'onimpact',
				label: 'On Impact',
				defaults: { pulse: 0.3, minStrength: 1 },
				params: [{ key: 'minStrength', kind: 'range', min: 0, max: 10, step: 0.1 }]
			},
			// CL-C C2: sensor overlap edges (initiator-detected, replicated stamps)
			{ type: 'onenter', label: 'On Enter', defaults: { pulse: 0.3 } },
			{ type: 'onexit', label: 'On Exit', defaults: { pulse: 0.3 } },
			// B6: fires once when a body settles, and re-arms when it moves again.
			// Initiator-detected, replicated stamp — the On Impact shape.
			{
				type: 'onrest',
				label: 'On Rest',
				defaults: { pulse: 0.3, seconds: 0.5 },
				params: [{ key: 'seconds', kind: 'range', min: 0.1, max: 5, step: 0.1 }]
			},
			{ type: 'counter', label: 'Counter', defaults: { op: 'up', step: 1 } }
		]
	},
	{
		group: 'Animation',
		items: [
			{
				type: 'shake',
				label: 'Shake',
				defaults: { intensity: 0.2, speed: 10 },
				params: [
					{ key: 'intensity', kind: 'range', min: 0, max: 1, step: 0.01 },
					{ key: 'speed', kind: 'range', min: 1, max: 30, step: 1 }
				]
			},
			{
				type: 'spin',
				label: 'Spin',
				defaults: { axis: 'y', speed: 1 },
				params: [
					{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
					{ key: 'speed', kind: 'range', min: -5, max: 5, step: 0.1 }
				]
			},
			{
				type: 'bounce',
				label: 'Bounce',
				defaults: { amplitude: 0.5, speed: 2 },
				params: [
					{ key: 'amplitude', kind: 'range', min: 0, max: 3, step: 0.05 },
					{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }
				]
			},
			{
				type: 'orbit',
				label: 'Orbit',
				defaults: { radius: 1, speed: 1 },
				params: [
					{ key: 'radius', kind: 'range', min: 0, max: 5, step: 0.05 },
					{ key: 'speed', kind: 'range', min: -5, max: 5, step: 0.1 }
				]
			},
			{
				type: 'pathpatrol',
				label: 'Path patrol',
				defaults: { points: [], speed: 1, mode: 'loop' }
			},
			{
				// 17-E: the other half of Play Animation — pulses when a clip FINISHES,
				// so a movement can hand off to whatever comes next (a door that has
				// finished opening plays a latch sound, or starts the next door). Fired
				// locally on every peer from the same deterministic end-of-clip the
				// runtime already computes, so it needs no message of its own.
				type: 'animfinished',
				label: 'Animation Finished',
				defaults: { clip: '', pulse: 0.3 }
			},
			{
				// 17-E F5: pulses as the playhead CROSSES a named point in the clip, so
				// a footstep sound or a puff of dust can sit at the exact frame of a
				// movement instead of only at its end. `name` empty = any marker on the
				// clip, which is one node for "every beat". Fired locally on every peer:
				// each travels the same clip interval from the same synced stamp.
				type: 'animmarker',
				label: 'Animation Marker',
				defaults: { name: '', pulse: 0.3 }
			},
			{
				// 17-E F3: the READABLE half of Animation Finished — a value node, so
				// the clip can drive something continuously instead of only handing
				// off at its end (progress into a Map Range that fades a light, or
				// `playing` into a Gate). One number socket whose meaning `read`
				// picks: a boolean rides a number socket already, and it keeps the
				// card in the same shape as Math / Select.
				type: 'animstate',
				label: 'Animation State',
				defaults: { clip: '', read: 'progress' },
				params: [
					{
						key: 'read',
						kind: 'select',
						options: ['progress', 'playing', 'position', 'duration', 'remaining']
					}
				]
			},
			{
				// 17-E A5: drives an AUTHORED clip (or a clip the model was imported
				// with) from a flow event — wire On Click to it and a door opens when
				// someone clicks it. Not in `animationTypes`: it is an event consumer
				// that starts a keyed clip, not a per-frame offset.
				type: 'playanim',
				label: 'Play Animation',
				defaults: { clip: '', action: 'toggle', speed: 1 },
				params: [
					{ key: 'action', kind: 'select', options: ['toggle', 'play', 'stop', 'restart'] },
					{ key: 'speed', kind: 'range', min: 0.1, max: 4, step: 0.1 }
				]
			}
		]
	},
	{
		group: 'Physics',
		items: [
			{
				type: 'mass',
				label: 'Mass',
				defaults: { kg: 1 },
				params: [{ key: 'kg', kind: 'range', min: 0.1, max: 100, step: 0.1 }]
			},
			{
				type: 'bounciness',
				label: 'Bounciness',
				defaults: { value: 0.3 },
				params: [{ key: 'value', kind: 'range', min: 0, max: 1, step: 0.05 }]
			},
			{
				type: 'friction',
				label: 'Friction',
				defaults: { value: 0.5 },
				params: [{ key: 'value', kind: 'range', min: 0, max: 1, step: 0.05 }]
			},
			// C2 (roadmap #13): constant rotation under physics. Both are consumed
			// by physics.js (sim start + live re-apply on node edits), like mass.
			{
				type: 'angularvelocity',
				label: 'Angular Velocity',
				defaults: { axis: 'y', speed: 2 },
				params: [
					{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
					{ key: 'speed', kind: 'range', min: -10, max: 10, step: 0.1 }
				]
			},
			// CL-C C1: collider shape override (wins over the Inspector pick, the
			// mass precedent); shape 'object' hulls the wired source object
			{
				type: 'collider',
				label: 'Collider',
				defaults: { shape: 'box', sensor: false, scale: 1 },
				params: [
					{ key: 'shape', kind: 'select', options: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'hull', 'custom', 'object'] },
					{ key: 'scale', kind: 'range', min: 0.25, max: 4, step: 0.05 },
					{ key: 'sensor', kind: 'toggle' }
				]
			},
			{
				type: 'motor',
				label: 'Motor',
				// B6: `side` — one motor node used to drive EVERY revolute joint on the
				// object identically, so differential steering could not be expressed
				defaults: { vel: 3, maxForce: 100, side: 'all' },
				params: [
					{ key: 'vel', kind: 'range', min: -20, max: 20, step: 0.1 },
					{ key: 'maxForce', kind: 'range', min: 0, max: 500, step: 5 },
					{ key: 'side', kind: 'select', options: ['all', '+x', '-x', '+z', '-z'] }
				]
			},
			// B6: THE single biggest hole in the catalog — nothing in a graph could
			// push anything. api.physics.applyImpulse existed with no node at all.
			// ONE card with a mode select (the animstate precedent), not two.
			{
				type: 'impulse',
				label: 'Impulse',
				defaults: { mode: 'impulse', space: 'world', x: 0, y: 5, z: 0 },
				inputs: ['trigger', 'force', 'target'],
				inputLabels: { force: 'force — wire a Vector 3', target: 'target object' },
				// no x/y/z dials: a vector belongs in a Vector 3 node, and carrying both
				// only raises the question of which one wins. `defaults` still holds
				// (0, 5, 0), so an unwired Impulse hops rather than doing nothing.
				params: [
					{ key: 'mode', kind: 'select', options: ['impulse', 'torque'] },
					{ key: 'space', kind: 'select', options: ['world', 'local'] }
				]
			},
			// B6: reset-to-grid, freeze, stop-a-topple. 'continuous' is a
			// kinematic-ish override rather than a force — it REPLACES the velocity
			// every frame the trigger is high.
			{
				type: 'setvelocity',
				label: 'Set Velocity',
				defaults: { mode: 'once', x: 0, y: 0, z: 0 },
				inputs: ['trigger', 'linear', 'angular', 'target'],
				inputLabels: {
					linear: 'linear — wire a Vector 3',
					angular: 'angular — wire a Vector 3',
					target: 'target object'
				},
				params: [{ key: 'mode', kind: 'select', options: ['once', 'continuous'] }]
			},
			// B6: joints were scene data with no node. Reuses joints.createJoint, so
			// the undo entry and the jointcreate message are the existing ones.
			{
				type: 'joint',
				label: 'Joint',
				defaults: { kind: 'revolute', axis: 'y', vel: 0, maxForce: 100 },
				inputs: ['trigger', 'a', 'b'],
				// the handle IDS stay a/b (the wire and the docs call them that); the CARD
				// says which end of the joint each one is
				inputLabels: { a: 'a — anchor', b: 'b — attached' },
				params: [
					{ key: 'kind', kind: 'select', options: ['revolute', 'weld'] },
					{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
					{ key: 'vel', kind: 'range', min: -20, max: 20, step: 0.1 },
					{ key: 'maxForce', kind: 'range', min: 0, max: 500, step: 5 }
				]
			}
		]
	},
	{
		group: 'Effects',
		items: [
			{
				type: 'pulse',
				label: 'Pulse',
				defaults: { amount: 0.2, speed: 2 },
				params: [
					{ key: 'amount', kind: 'range', min: 0, max: 1, step: 0.01 },
					{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }
				]
			},
			{
				type: 'blink',
				label: 'Blink',
				defaults: { speed: 2 },
				params: [{ key: 'speed', kind: 'range', min: 0.2, max: 10, step: 0.1 }]
			},
			{
				// spatial audio on the connected object; file from the Explorer (97)
				type: 'sound',
				label: 'Sound',
				defaults: { hash: null, file: '', volume: 0.8, radius: 5, rolloff: 1, loop: true, playing: false }
			},
			{
				// PFX-B: particle emitter driven by flow — targets the connected object
				// (or the graph owner). Wired inputs: count (number), color (color),
				// trigger (event, fires a burst-mode emitter). Config = node.data,
				// seeded from a preset; the particle RUNTIME renders it (particleRuntime).
				type: 'particle',
				label: 'Particles',
				defaults: particlePreset('sparkles'),
				params: [
					{ key: 'mode', kind: 'select', options: ['continuous', 'burst'] },
					{ key: 'count', kind: 'range', min: 1, max: 500, step: 1 },
					{ key: 'lifetime', kind: 'range', min: 0.1, max: 6, step: 0.1 },
					{ key: 'speed', kind: 'range', min: 0, max: 8, step: 0.1 },
					{ key: 'gravity', kind: 'range', min: -10, max: 10, step: 0.1 },
					{ key: 'turbulence', kind: 'range', min: 0, max: 1, step: 0.05 },
					{ key: 'sizeStart', kind: 'range', min: 0.01, max: 1, step: 0.01 },
					{ key: 'opacity', kind: 'range', min: 0, max: 1, step: 0.05 },
					{ key: 'sprite', kind: 'select', options: ['dot', 'streak', 'puff', 'star', 'square'] },
					{ key: 'blending', kind: 'select', options: ['additive', 'normal'] },
					{ key: 'space', kind: 'select', options: ['local', 'world'] }
				]
			}
		]
	}
];

// Node types the animation runtime evaluates every frame (134 adds the base-
// managed object actions: LookAt orients, Set Color paints, Visibility toggles)
export const animationTypes = [
	'shake', 'spin', 'bounce', 'orbit', 'pulse', 'blink', 'pathpatrol',
	'lookat', 'setcolor', 'visibility', 'setuniform'
];

/**
 * Palette group a node type belongs to — drives the category accent color
 * (built-in groups by name, module groups fall back to the module accent,
 * user-designed custom nodes return null).
 * @param {string} type
 */
export function groupOf(type) {
	for (const group of nodeCatalog)
		if (group.items.some((/** @type {any} */ i) => i.type === type)) return group.group;
	for (const group of get(moduleNodeGroups))
		if (group.items.some((/** @type {any} */ i) => i.type === type)) return group.group;
	return null;
}

/** @param {string} type */
export function findNodeSpec(type) {
	for (const group of nodeCatalog) {
		const item = group.items.find((i) => i.type === type);
		if (item) return item;
	}
	for (const group of get(moduleNodeGroups)) {
		const item = group.items.find((/** @type {any} */ i) => i.type === type);
		if (item) return item;
	}
	return null;
}
