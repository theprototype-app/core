// 2.0 N1 — the Game family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.
import { GAME_STATES } from '../../gameState';
import { GAME_SOUNDS as GAME_SOUND_NAMES } from '../../gameSfx';
import { HAPTIC_PATTERN_NAMES } from '../../hapticPatterns';
import { MUSIC_PRESET_IDS } from '../../gameMusicPresets';
import { V_MARK } from '../catalogShared.js';
import * as shared from '../evalShared.js';
import { GAME_VALUE_FORMATS, formatGameValue, asNumber } from '../../gameValueFormat.js';

/** 102b-hud: the Game Value node's sources (the select's order) */
export const GAME_VALUE_READS = [
	'score',
	'myScore',
	'best',
	'clock',
	'timeLeft',
	'countdown',
	'round',
	'level',
	'levelName',
	'stars',
	'totalStars',
	'lives',
	'variable',
	'playerVariable',
	'stored',
	'published',
	'wired'
];

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Game',
	nodes: [
		// the action a Start button wires to. Acts on the trigger's STAMP EDGE.
		{
			type: 'setgamestate',
			label: 'Set Game State',
			defaults: { state: 'playing', outcome: '' },
			// fix-batch-1 (docs-1 Q1): the runtime always read a `trigger` wire (flowSockets
			// types it, hudActions wires it) but the card drew no socket, so it could not be
			// wired by hand and a built binding's wire had nowhere to land
			inputs: ['trigger'],
			params: [
				{ key: 'state', kind: 'select', options: [...GAME_STATES] },
				{ key: 'outcome', kind: 'text', placeholder: 'won / lost', maxLength: 40 },
				// 21-F3: the FULL reset (back to the menu AND the round clock zeroed) —
				// the same `resetGame()` the Users popover's admin entry calls, so the
				// button and the node cannot drift. Absent by default, so every node
				// authored before this behaves exactly as it did.
				{ key: 'reset', kind: 'toggle', label: 'full reset' }
			],
			// 21-D6: every game ACTION is driven by an event, and takes its value wired or typed
			sockets: { out: 'effect', in: { trigger: 'event' } },
			// 21-D6: the game shell. AnimationNode renders them from their catalog params;
			// setcamera/gamestart/setlook get their own card for the camera picker.
			card: 'AnimationNode'
		},
		// the event half: pulses when the game ENTERS (or leaves) a state, so screens and
		// logic can react without polling
		{
			type: 'ongamestate',
			label: 'On Game State',
			defaults: { state: 'playing', edge: 'enter', pulse: 0.3 },
			params: [
				{ key: 'state', kind: 'select', options: [...GAME_STATES] },
				{ key: 'edge', kind: 'select', options: ['enter', 'exit'] }
			],
			// 21-D6 game shell: the event half and the two readable ones
			sockets: { out: 'event' },
			card: 'AnimationNode',
			// into a module input or a Math read undefined before (silent)
			eval: shared.evalPulseWindow
		},
		// LOCAL on every peer, from a replicated trigger — the house rule. A peer's node
		// must never move another peer's camera, so each one decides for itself and the
		// views converge because the TRIGGER replicated, not the camera.
		// 21-E1.8: `restore` was declared here and READ NOWHERE — the runtime only ever
		// looks at `camera`. A default nothing consumes is a promise the node cannot keep,
		// and `gamestart` already covers "put every peer back on the game camera".
		{
			type: 'setcamera', label: 'Set Active Camera', defaults: { camera: '' },
			sockets: { out: 'effect', in: { trigger: 'event', camera: 'object' } },
			card: 'GameCameraNode'
		},
		// 37 (R8): a camera OBJECT follows and/or looks at a target — wire it into an Object
		// Selector that picks the camera (or drop it in the camera's own graph). LOCAL per peer
		// like every effect: it moves the marker, never the editor camera or a peer's view.
		{
			type: 'camerarig',
			label: 'Camera Rig',
			defaults: { mode: 'both', space: 'world', ox: 0, oy: 2, oz: 5, damping: 0.25, aim: 0 },
			inputs: ['target', 'offset'],
			inputLabels: { target: 'target — what to follow / look at', offset: 'offset — wire a Vector 3 (else ox/oy/oz)' },
			params: [
				{ key: 'mode', kind: 'select', options: ['both', 'follow', 'lookat'] },
				{ key: 'space', kind: 'select', options: ['world', 'target'] },
				{ key: 'ox', kind: 'range', min: -20, max: 20, step: 0.1 },
				{ key: 'oy', kind: 'range', min: -20, max: 20, step: 0.1 },
				{ key: 'oz', kind: 'range', min: -20, max: 20, step: 0.1 },
				{ key: 'damping', kind: 'range', min: 0, max: 3, step: 0.05 },
				{ key: 'aim', kind: 'range', min: -5, max: 5, step: 0.05 }
			],
			// 37 (R8)
			sockets: { out: 'effect', in: { target: 'object', offset: 'vector3' } },
			// 37 (R8)
			card: 'AnimationNode'
		},
		// L-C: switch a LOOK on or off. The camera input picks WHOSE look (empty = the
		// scene's); the switch is a per-peer runtime override, not an edit to the
		// authored document, so it needs no message of its own — the trigger already
		// replicated, the hudScreenOverride rule.
		// `activate` defaults TRUE because that is what the name promises and what the
		// first user wired it expecting: R -> that camera, with its grade. A camera look
		// only composes while you are LOOKING THROUGH that camera, so a node that sets
		// the look without moving the view is silent — measured, and reported.
		{
			type: 'setlook', label: 'Set Look', defaults: { camera: '', on: true, activate: true },
			sockets: { out: 'effect', in: { trigger: 'event', camera: 'object', on: 'boolean' } },
			card: 'GameCameraNode'
		},
		// "which camera does the game start from" — placed in the SCENE graph. Every peer
		// acts on it when the state enters `playing`, including a late joiner, which is
		// what makes it the answer rather than a one-shot button action.
		// 78 F13: labelled "Start camera" — "Game Start" read like an event and is not one (it
		// never pulses). The type id stays `gamestart`: it is in saved graphs and on the wire.
		{
			type: 'gamestart', label: 'Start camera', defaults: { camera: '', state: 'playing' },
			sockets: { out: 'effect', in: { camera: 'object' } },
			card: 'GameCameraNode'
		},
		// 78 F13: the events "Game Start" was mistaken for. `who`: session = the first player
		// presses Play / the last one leaves (every peer pulses, derived from the replicated play
		// presence); me = THIS peer presses Play / leaves (this peer only). Never sent.
		{
			type: 'onplaystart',
			label: 'On Play start',
			defaults: { who: 'session', pulse: 0.3 },
			params: [{ key: 'who', kind: 'select', options: ['session', 'me'], doc: 'session = when the first player presses Play (every peer); me = when you press Play' }],
			// 78 F13
			sockets: { out: 'event' },
			// 78 F13
			card: 'AnimationNode',
			// 78 F13: local pulses, derived on every peer (updatePlayEdgeNodes)
			eval: shared.evalPulseWindow
		},
		{
			type: 'onplaystop',
			label: 'On Play stop',
			defaults: { who: 'session', pulse: 0.3 },
			params: [{ key: 'who', kind: 'select', options: ['session', 'me'], doc: 'session = when the last player leaves Play (every peer); me = when you leave Play' }],
			sockets: { out: 'event' },
			card: 'AnimationNode',
			eval: shared.evalPulseWindow
		},
		// 21-F4: SCENE TRAVEL. Acts on the trigger's STAMP EDGE like Set Game State;
		// every peer loads the scene ITSELF (a peer missing the bytes pulls them
		// first), the game state CARRIES across the hop, and the scene is picked by
		// Explorer content HASH — its own card (TravelNode) lists every .tpscene in
		// the library (21-G1: discovery is by KIND, never by which folder it sits in).
		// The DATA keys stay `level`/`levelName`: they are on the wire and in saved
		// graphs, and renaming them would be a migration for a word.
		{
			type: 'travel', label: 'Travel to scene', defaults: { level: '', levelName: '' },
			// 21-F4: travel fires on its trigger edge; allplayers takes each player's own
			// boolean answer (a Latch, a Gate, a Compare — anything true/false)
			sockets: { out: 'effect', in: { trigger: 'event' } },
			// 21-F4: travel gets its own card for the level picker; allplayers is spec-driven
			card: 'TravelNode'
		},
		// 21-F4: the group-travel gate. Wire a condition each PLAYER answers for
		// themselves ("I am at the portal"); the node fires once EVERY peer in play
		// answers yes. Editor peers are spectators and do not count.
		{
			type: 'allplayers',
			label: 'All Players',
			defaults: { pulse: 0.3 },
			inputs: ['condition'],
			inputLabels: { condition: 'condition - each player answers for themselves' },
			// 21-F4: the group-travel gate pulses when every player answers yes — an event,
			// so it wires into a Travel trigger (or anything else a pulse drives)
			sockets: { out: 'event', in: { condition: 'boolean' } },
			card: 'AnimationNode',
			// no pulled value: consumers read this node's trigger log (a stamp-edge source)
			eval: null
		},
		// variables: the shared numbers a game keeps (score, lives, difficulty). They
		// ride the same singleton, so there is one latest-wins rule for all game state.
		// 21-G4: ...and `scope` says WHOSE number. 'shared' is the game singleton this
		// node has always written; 'player' writes THIS peer's own row, which no other
		// peer can write — the immunity to the documented `add` read-modify-write race.
		// An absent scope reads as 'shared', so every node saved before this is
		// unchanged in meaning.
		{
			type: 'setvariable',
			label: 'Set Variable',
			defaults: { name: 'score', value: 0, op: 'set', scope: 'shared' },
			// fix-batch-1 (docs-1 Q1): sockets for what the runtime reads (the setgamestate note)
			inputs: ['trigger', 'value'],
			inputLabels: { value: 'value — wire a number or, for op text, words (else the value below)' },
			// 102b-hud (row 14): `toggle` flips a flag (0 / 1), `text` holds words (shared scope only)
			params: [
				{ key: 'name', kind: 'text', placeholder: 'score', maxLength: 40 },
				{ key: 'op', kind: 'select', options: ['set', 'add', 'subtract', 'toggle', 'text'] },
				{ key: 'text', kind: 'text', placeholder: 'words for op text', maxLength: 200 },
				{ key: 'scope', kind: 'select', options: ['shared', 'player'] }
			],
			sockets: { out: 'effect', in: { trigger: 'event', value: 'any' } },
			card: 'AnimationNode'
		},
		{
			type: 'getvariable',
			label: 'Get Variable',
			defaults: { name: 'score', fallback: 0 },
			// 102b-hud: `output: text` reads a variable that holds words (Set Variable op text); absent = number, as before
			params: [
				{ key: 'name', kind: 'text', placeholder: 'score', maxLength: 40 },
				{ key: 'output', kind: 'select', options: ['number', 'text'] }
			],
			sockets: { out: 'number' },
			card: 'AnimationNode',
			eval(node, { d }, rt) {
				// LOCAL read of REPLICATED state, so every peer computes the same number and
				// nothing about the read goes on the wire (48 D1: through the paused view's sandbox)
				const held = rt.viewGameVar(String(d.name ?? ''), d.fallback ?? 0);
				if (d.output === 'text') return held === undefined || held === null ? '' : String(held);
				return rt.num(held);
			}
		},
		// 30 P4 (roadmap 30 fork 7): what a game remembers ON THIS DEVICE — a best score,
		// a level reached. Keyed `tp:scene:<scene name>:<key>` so a best belongs to its
		// game. LOCAL by design: Store Value writes this peer's browser and sends
		// nothing, so a REPLICATED trigger (an ordinary On Click) makes every peer save
		// its own copy, while a per-player trigger saves only for the one who earned it.
		{
			type: 'storevalue',
			label: 'Store Value',
			defaults: { key: 'best', mode: 'max', value: 0 },
			inputs: ['trigger', 'value'],
			inputLabels: { value: 'value — wire a Counter, a variable, a score' },
			params: [
				{ key: 'key', kind: 'text', placeholder: 'best', maxLength: 60 },
				{ key: 'mode', kind: 'select', options: ['set', 'max', 'min', 'add'] }
			],
			note: 'Saved on this device only — never sent to other players, never in the scene file.',
			// 30 P4
			sockets: { out: 'effect', in: { trigger: 'event', value: 'number' } },
			// 30 P4: the device-local pair (the second registry — the catalog is the first)
			card: 'AnimationNode'
		},
		{
			type: 'storedvalue',
			label: 'Stored Value',
			defaults: { key: 'best', output: 'number', fallback: 0 },
			params: [
				{ key: 'key', kind: 'text', placeholder: 'best', maxLength: 60 },
				{ key: 'output', kind: 'select', options: ['number', 'text'] }
			],
			note: 'Reads what THIS device saved — each player sees their own.',
			// 30 P4: the readable half of Store Value (a number socket; `output: text` carries a
			// string down the same channel, the hudtext precedent)
			sockets: { out: 'number' },
			card: 'AnimationNode',
			eval(node, { d }, rt) {
				const key = String(d.key ?? '').trim();
				const held = key ? rt.readStored(rt.storedKey(key), undefined) : undefined;
				if (d.output === 'text') {
					if (held === undefined) return String(d.fallback ?? '');
					return typeof held === 'string' ? held : JSON.stringify(held);
				}
				return held === undefined ? rt.num(d.fallback ?? 0) : rt.num(held);
			}
		},
		// 102b-hud (row 4): GAME VALUE — one node that reads any game value and writes it as words,
		// so a HUD needs no `info` node of its own: the score, the round clock, the best, the level,
		// its stars, lives, a variable, a stored value, or what a module PUBLISHED (api.values).
		// Every read is a LOCAL read of state that is already replicated or already per-peer by
		// design (the getvariable / storedvalue rule), so nothing about it goes on the wire.
		// The default output is the TEXT (HUD Text shows it as it is); `value` is the raw number
		// (HUD Bar), `max` the max it was formatted against.
		{
			type: 'gamevalue',
			label: 'Game Value',
			defaults: { read: 'score', name: '', format: 'number', decimals: 0, max: 0, prefix: '', suffix: '', empty: '' },
			inputs: ['value', 'max'],
			inputLabels: { value: 'value - shown when read is "wired"', max: 'max - for fraction, percent, stars' },
			params: [
				{ key: 'read', kind: 'select', options: GAME_VALUE_READS },
				{ key: 'name', kind: 'text', placeholder: 'variable, key, level or value name', maxLength: 64 },
				{ key: 'format', kind: 'select', options: GAME_VALUE_FORMATS },
				{ key: 'decimals', kind: 'range', min: 0, max: 4, step: 1 },
				{ key: 'max', kind: 'number', min: 0, max: 100000, step: 1 },
				{ key: 'prefix', kind: 'text', placeholder: 'Coins ', maxLength: 40 },
				{ key: 'suffix', kind: 'text', placeholder: ' pts', maxLength: 40 },
				{ key: 'empty', kind: 'text', label: 'when empty', placeholder: 'not cleared yet', maxLength: 60 },
				// 92-correct row 3: PER-PLAYER output. `me` takes this player's entry out of a value keyed by
				// peer id (a behaviour's `team: {<peer>: 'Red'}`, a variable holding such a map), so one shared,
				// synced map shows each person their own team or score. Absent = everyone (byte-unchanged).
				{ key: 'who', kind: 'select', options: ['everyone', 'me'], label: 'for', doc: 'everyone = the value as it is; me = your own entry of a per-player value (a map keyed by player)' }
			],
			note: 'Reads a game value and writes it as text for HUD Text; the value output feeds HUD Bar. For: me shows each player their own entry of a per-player value.',
			sockets: { out: 'any', in: { value: 'any', max: 'number' }, outHandles: { value: 'number', max: 'number' } },
			card: 'AnimationNode',
			eval(node, { d, input }, rt) {
				const read = readGameValue(String(d.read ?? 'score'), String(d.name ?? '').trim(), input, rt);
				if (d.who === 'me') read.value = entryFor(read.value, rt.myPeerId?.() ?? '');
				const wiredMax = input('max', undefined);
				const max = wiredMax !== undefined && wiredMax !== null && wiredMax !== '' ? rt.num(wiredMax) : read.max ?? rt.num(d.max ?? 0);
				const text = formatGameValue(read.value, { format: d.format, decimals: d.decimals, max, prefix: d.prefix, suffix: d.suffix, empty: d.empty });
				const n = asNumber(read.value);
				// a HUD Text treats '' as "nothing wired"; a space keeps an empty line empty (the info nodes' rule)
				return { __default: text === '' ? ' ' : text, __handles: { value: n ?? 0, max } };
			}
		},
		// 102b-hud (row 19): GAME FEEL presentation — LOCAL to this device's view (never the scene or
		// the simulation). `who: me` = only the player whose press / hit made the pulse; `everyone` =
		// every peer. Reduced motion turns shake and flash down. Shake: the Play camera only, never VR.
		{
			type: 'camerashake',
			label: 'Camera Shake',
			defaults: { strength: 0.15, seconds: 0.35, frequency: 18, who: 'me' },
			inputs: ['trigger'],
			params: [
				{ key: 'strength', kind: 'range', min: 0, max: 1, step: 0.01 },
				{ key: 'seconds', kind: 'range', min: 0.05, max: 3, step: 0.05 },
				{ key: 'frequency', kind: 'range', min: 2, max: 40, step: 1 },
				{ key: 'who', kind: 'select', options: ['me', 'everyone'] }
			],
			note: 'Shakes the Play camera on this device (never in VR). me = the player who made the pulse.',
			sockets: { out: 'effect', in: { trigger: 'event' } },
			card: 'AnimationNode'
		},
		{
			type: 'screenflash',
			label: 'Screen Flash',
			defaults: { color: '#ffffff', strength: 0.6, seconds: 0.25, who: 'me' },
			inputs: ['trigger'],
			params: [
				{ key: 'color', kind: 'color' },
				{ key: 'strength', kind: 'range', min: 0, max: 1, step: 0.05 },
				{ key: 'seconds', kind: 'range', min: 0.05, max: 3, step: 0.05 },
				{ key: 'who', kind: 'select', options: ['me', 'everyone'] }
			],
			note: 'A colour over the screen that fades out, on this device. Reduced motion keeps it faint.',
			sockets: { out: 'effect', in: { trigger: 'event' } },
			card: 'AnimationNode'
		},
		{
			type: 'hitpause',
			label: 'Hit Pause',
			defaults: { ms: 80, who: 'me' },
			inputs: ['trigger'],
			params: [
				{ key: 'ms', kind: 'range', min: 20, max: 500, step: 10 },
				{ key: 'who', kind: 'select', options: ['me', 'everyone'] }
			],
			note: 'Holds this device\'s picture for a moment. The game and physics keep running.',
			sockets: { out: 'effect', in: { trigger: 'event' } },
			card: 'AnimationNode'
		},
		// 30b (core-games): GAME FEEL — the flow half of 30b-vr-play's module kit, so a
		// graph-authored game (Towers, Stars Room, Jam Room) can say "Ring 2 reached",
		// sparkle, chime, buzz and score itself. All LOCAL on every peer from the
		// replicated trigger stamp (the storevalue / setcamera rule): no message of their
		// own. Haptics and music keep the core's Interact/Play gate — silent in Edit.
		{
			type: 'announce',
			label: 'Announce',
			defaults: { text: 'Level ' + V_MARK, sub: '', seconds: 1.8, color: '#ffd76a', decimals: 0 },
			inputs: ['trigger', 'value', 'sub'],
			inputLabels: { value: 'value - fills ' + V_MARK + ' in the text', sub: 'sub - the second line (wired text)' },
			params: [
				{ key: 'text', kind: 'text', placeholder: 'Ring ' + V_MARK + ' reached', maxLength: 80 },
				{ key: 'sub', kind: 'text', placeholder: 'a smaller second line', maxLength: 120 },
				{ key: 'seconds', kind: 'range', min: 0.3, max: 15, step: 0.1 },
				{ key: 'color', kind: 'text', placeholder: '#ffd76a', maxLength: 20 }
			],
			note: 'A big banner on every screen (and in VR) in Play — each player sees it from the same pulse. In Edit it goes to the Debugger console instead.',
			// 30b (core-games): the Game Feel family — an event, a wired number for {v}, a PLACE
			// (an object: an undeclared handle types as 'number' and would refuse an Object
			// Selector), and Game Music's on/off
			// 36 (U10): `sub` — the second line, wired as text (a behaviour's bannerSub)
			sockets: { out: 'effect', in: { trigger: 'event', value: 'number', sub: 'any' } },
			// 30b (core-games): Game Feel — spec-driven like the rest of the game shell
			card: 'AnimationNode'
		},
		{
			type: 'gamesound',
			label: 'Game Sound',
			defaults: { sound: 'coin' },
			inputs: ['trigger', 'at'],
			inputLabels: { at: 'at - an object (unwired = not placed)' },
			params: [
				{ key: 'sound', kind: 'select', options: [...GAME_SOUND_NAMES] },
				// 53 (A6): blank = "[sound name]" for players with Captions on; '-' = no caption
				{ key: 'caption', kind: 'text', placeholder: 'caption (blank = [name], - = none)', maxLength: 120 }
			],
			note: 'Built-in sounds, no files — played on each device, at the wired object when there is one.',
			sockets: { out: 'effect', in: { trigger: 'event', at: 'object' } },
			card: 'AnimationNode'
		},
		{
			type: 'effectburst',
			label: 'Effect Burst',
			defaults: { kind: 'sparkle', color: '', count: 48, lift: 0 },
			inputs: ['trigger', 'at'],
			inputLabels: { at: 'at - an object (unwired = in front of the player)' },
			params: [
				{ key: 'kind', kind: 'select', options: ['sparkle', 'confetti', 'smoke', 'sparks'] },
				{ key: 'count', kind: 'range', min: 4, max: 96, step: 1 },
				{ key: 'lift', kind: 'range', min: -2, max: 4, step: 0.1 },
				{ key: 'color', kind: 'text', placeholder: 'the kind\'s own colours', maxLength: 20 }
			],
			note: 'A short particle burst, pooled — any number of these costs nothing between pulses.',
			sockets: { out: 'effect', in: { trigger: 'event', at: 'object' } },
			card: 'AnimationNode'
		},
		{
			type: 'hapticpulse',
			label: 'Controller Buzz',
			defaults: { pattern: 'success', hand: 'both' },
			inputs: ['trigger'],
			params: [
				{ key: 'pattern', kind: 'select', options: [...HAPTIC_PATTERN_NAMES] },
				{ key: 'hand', kind: 'select', options: ['both', 'left', 'right'] }
			],
			note: 'VR controllers only, and only in Interact or Play — the editor stays still.',
			sockets: { out: 'effect', in: { trigger: 'event' } },
			card: 'AnimationNode'
		},
		{
			type: 'gamemusic',
			label: 'Game Music',
			defaults: { preset: 'arcade', volume: 0.7, while: 'always' },
			inputs: ['on'],
			inputLabels: { on: 'on - unwired = always' },
			params: [
				{ key: 'preset', kind: 'select', options: [...MUSIC_PRESET_IDS] },
				{ key: 'volume', kind: 'range', min: 0, max: 1, step: 0.05 },
				{ key: 'while', kind: 'select', options: ['always', 'round'] }
			],
			note: 'Plays while you are in Interact or Play (never in the editor); each device hears its own.',
			sockets: { out: 'effect', in: { on: 'boolean' } },
			card: 'AnimationNode'
		},
		// 31 (Stars Room): three pieces a game made of settings and gestures is built from.
		// GAME SETTING declares one row in the game's settings (desktop + the VR menu, the
		// 31-game-shell panel) and outputs THIS player's value — per device, never sent, so
		// "Point to move stars: off" is my choice and not everyone's.
		{
			type: 'gamesetting',
			label: 'Game Setting',
			defaults: { setting: 'my-setting', title: 'My setting', kind: 'toggle', value: true },
			params: [
				{ key: 'setting', kind: 'text', placeholder: 'id (unique to this game)', maxLength: 40, label: 'id' },
				{ key: 'title', kind: 'text', placeholder: 'the row\'s label', maxLength: 60, label: 'label' },
				{ key: 'kind', kind: 'select', options: ['toggle', 'range', 'choice'] },
				{ key: 'value', kind: 'toggle', label: 'default (toggle)' },
				{ key: 'min', kind: 'range', min: -100, max: 100, step: 1, label: 'min (range)' },
				{ key: 'max', kind: 'range', min: -100, max: 100, step: 1, label: 'max (range)' },
				{ key: 'options', kind: 'text', placeholder: 'a, b, c (choice)', maxLength: 120 }
			],
			note: 'One row in the game\'s Settings, saved on this device for this game. Wire it into anything that takes true/false or a number.',
			// 31: a player's setting. Typed by its commonest kind (a toggle: true/false); a range's
			// number or a choice's text rides the same socket — resolveInputs never coerces a value
			sockets: { out: 'boolean' },
			// 31 (Stars Room): a player's setting row, the pointing switch (both spec-driven) and
			// the clap, whose `point`/`byMe` outputs need labelled rows (the On Hit card's shape)
			card: 'AnimationNode',
			eval(node, { d }, rt) {
				// 31: this DEVICE's value of the row the node declares (a toggle reads true/false,
				// a range a number, a choice its option) — per player by design, never sent
				const id = rt.settingIdOf(d);
				const v = id ? rt.gameSettingValue(id) : undefined;
				return v === undefined ? d.value ?? true : v;
			}
		},
		// POINT GRAB: while `enabled` reads false, players cannot pick things up by POINTING
		// at them (the VR grip ray, the desktop carry) — only a hand that touches moves them.
		// 85 I1: GRABBABLE — the object can be picked up in Play with NO simulation (a kinematic
		// carry, streamed like a physics carry) and on release stays where it was put or glides
		// back to where it was taken from. A declaration (no per-frame effect): playInteract asks
		// flowRuntime.kinematicGrab(uuid). grabReturn.js
		{
			type: 'grabbable',
			label: 'Grabbable',
			defaults: { release: 'stay', returnAfter: 1, returnTime: 0.6 },
			params: [
				{ key: 'release', kind: 'select', options: ['stay', 'return'] },
				{ key: 'returnAfter', kind: 'range', min: 0, max: 30, step: 0.5, doc: 'seconds before it glides home' },
				{ key: 'returnTime', kind: 'range', min: 0.1, max: 5, step: 0.1, doc: 'seconds the glide takes' }
			],
			note: 'Works without the simulation. A dynamic body during a run is carried by physics as before.',
			sockets: { out: 'effect' },
			// 85 I1
			card: 'AnimationNode'
		},
		// 85 I3: SIT SPOT — a click on the object sits YOU down on top of it, facing its front; a
		// move key, jump or a stick push stands you up. Local per player (your avatar shows it to
		// the others). A declaration like Grabbable: sitSpot.js asks flowRuntime.sitSpotFor(uuid).
		{
			type: 'sitspot',
			label: 'Sit Spot',
			defaults: { facing: '+z', eyeHeight: 0.7, forward: 0 },
			params: [
				{ key: 'facing', kind: 'select', options: ['+z', '-z', '+x', '-x'], doc: 'the seat\'s front, in its own frame' },
				{ key: 'eyeHeight', kind: 'range', min: 0.2, max: 1.5, step: 0.05, doc: 'eyes above the seat top, in metres' },
				{ key: 'forward', kind: 'range', min: -1, max: 1, step: 0.05, doc: 'shift the spot toward the front (a sofa\'s cushion edge)' }
			],
			note: 'Desktop: in Play. VR: in Interact. A seat with someone on it says so.',
			sockets: { out: 'effect' },
			// 85 I3
			card: 'AnimationNode'
		},
		{
			type: 'pointgrab',
			label: 'Point Grab',
			defaults: {},
			inputs: ['enabled'],
			inputLabels: { enabled: 'enabled - unwired = on (pointing picks things up)' },
			note: 'Off = objects move only when a hand touches them. Each player\'s own switch; the editor is never affected.',
			// 31: a DECLARATION (the gamemusic shape) — it drives nothing
			// 31
			sockets: { out: 'effect', in: { enabled: 'boolean' } },
			card: 'AnimationNode'
		},
		// ON CLAP: this player brought both VR hands together and held them there. The pulse
		// replicates with the POINT where the hands met, so a Spawn wired to it makes one
		// thing there for everyone; `who: me` keeps it on this device (a buzz in your hands).
		{
			type: 'onclap',
			label: 'On Clap',
			defaults: { pulse: 0.3, who: 'anyone', distance: 0.1, hold: 0.25, cooldown: 1 },
			inputs: ['enabled'],
			params: [
				{ key: 'who', kind: 'select', options: ['anyone', 'me'] },
				{ key: 'distance', kind: 'range', min: 0.03, max: 0.3, step: 0.01, label: 'hands closer than (m)' },
				{ key: 'hold', kind: 'range', min: 0, max: 1, step: 0.05, label: 'held for (s)' },
				{ key: 'cooldown', kind: 'range', min: 0.2, max: 5, step: 0.1, label: 'at most one per (s)' }
			],
			note: 'VR, in Interact or Play. `point` is where the hands met — wire it into a Spawn\'s place or an Effect Burst.',
			// 31: the clap — the pulse unnamed, `point` (vector3) and `byMe` named (OUTPUT_HANDLES)
			// 31
			sockets: { out: 'event', in: { enabled: 'boolean' }, outHandles: { point: 'vector3', byMe: 'boolean' } },
			card: 'OnClapNode',
			eval(node, { ctx, time, d }, rt) {
				// 31: the clap's trigger. The stamp is the ordinary trigger log; `point` (where
				// the hands met, in the objects group's frame) rode the same nodetrigger message,
				// so every peer holds the same point with no message of its own.
				const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
				const dt = trig ? time - trig.lastT : Infinity;
				const info = rt.triggerPoints.get(node.id);
				return {
					__default: dt >= 0 && dt < rt.num(d.pulse ?? 0.3) ? 1 : 0,
					__handles: { point: info ? [...info.at] : [0, 0, 0], byMe: info && info.byMe ? 1 : 0 }
				};
			}
		},
		// the round clock, derived from the shared startedAt stamp — no clock of its own
		{
			type: 'gametime',
			label: 'Game Time',
			defaults: { read: 'elapsed', length: 60 },
			params: [
				{ key: 'read', kind: 'select', options: ['elapsed', 'remaining', 'round', 'playing'] },
				{ key: 'length', kind: 'range', min: 1, max: 3600, step: 1 }
			],
			sockets: { out: 'number' },
			card: 'AnimationNode',
			eval(node, { d }, rt) {
				// derived from the shared `startedAt` stamp — no clock of its own, so two peers
				// mid-round agree, and a late joiner converges the moment the state arrives
				const g = rt.viewGame();
				const elapsed = rt.gameElapsed();
				switch (d.read ?? 'elapsed') {
					case 'remaining':
						return Math.max(0, rt.num(d.length ?? 60) - elapsed);
					case 'round':
						return g.round;
					case 'playing':
						return g.state === 'playing' ? 1 : 0;
					default:
						return elapsed;
				}
			}
		},
		// 21-G4: the PER-PLAYER read. `mine` is my own number — the one reading in this
		// whole group that is ALLOWED to differ per peer, which is the point of it —
		// `sum` is the team total, `max` is who is winning, and `peer` names one row.
		{
			type: 'peervariable',
			label: 'Player Variable',
			defaults: { name: 'laps', read: 'mine', peer: '', fallback: 0 },
			params: [
				{ key: 'name', kind: 'text', placeholder: 'laps', maxLength: 40 },
				{ key: 'read', kind: 'select', options: ['mine', 'sum', 'max', 'peer'] },
				{ key: 'peer', kind: 'text', placeholder: 'peer id (read: peer)', maxLength: 64 }
			],
			// 21-F3's `collectcount` MOVED to the collectible module (R3a); a module value
			// node's socket type comes from its registerValueNode `vtype`, so no entry here.
			// 21-G4: one player's own number (mine / a named peer / the sum / the max)
			sockets: { out: 'number' },
			// 21-F3's `collectcount` card MOVED to the collectible module (R3a) — an old
			// scene's node renders as UnknownNode until the module is installed, honestly
			// 21-G4: the per-player read, same shape
			card: 'AnimationNode',
			eval(node, { d }, rt) {
				// Also a LOCAL read of REPLICATED state — every peer holds every peer's row —
				// so the only difference from Get Variable is WHICH replicated map it reads.
				// `mine` is the reading that differs per peer BY DESIGN: it is the one number a
				// player's own HUD wants, and it is the only value node in this file whose
				// answer is legitimately allowed to disagree across peers.
				const name = String(d.name ?? '').trim();
				const fallback = rt.num(d.fallback ?? 0);
				switch (d.read ?? 'mine') {
					case 'sum':
						return rt.peerVarSum(name);
					case 'max':
						return rt.peerVarMax(name);
					case 'peer':
						return rt.num(rt.peerVarOf(String(d.peer ?? ''), name, fallback));
					default:
						return rt.num(rt.myPeerVar(name, fallback));
				}
			}
		}
		// 21-F3's `collectcount` ("Collectibles") MOVED to the collectible module in
		// R3a — it was the palette's one card that knew the recipe's chain shape, and
		// the module's own count node replaces it (install it from Modules ▸ Browse).
	]
};



/**
 * 92-correct row 3: this player's entry of a per-player value — an object keyed by peer id (a JSON
 * text of one too: a wire or a variable may carry it as text). Anything else is shown as it is.
 * @param {any} value @param {string} me
 */
export function entryFor(value, me) {
	let v = value;
	if (typeof v === 'string' && v.startsWith('{')) {
		try {
			v = JSON.parse(v);
		} catch {
			return value;
		}
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return value;
	const mine = me ? v[me] : undefined;
	return mine === undefined || mine === null ? '' : mine;
}

/**
 * One Game Value read: `{value, max}` (max null = the node's own setting).
 * @param {string} read @param {string} name @param {(h: string, f: any) => any} input @param {any} rt
 * @returns {{ value: any, max: number | null }}
 */
function readGameValue(read, name, input, rt) {
	const kit = (/** @type {string} */ type, /** @type {any} */ data = {}) => {
		try {
			return rt.kitValue(type, data);
		} catch {
			return undefined; // a kit piece the game never set up reads as nothing
		}
	};
	switch (read) {
		case 'myScore':
			return { value: kit('kit-score-mine') ?? 0, max: null };
		case 'best':
			return { value: kit('kit-score-best') ?? 0, max: null };
		case 'clock': {
			// the kit round's play time when the game runs one, else the game shell's round clock
			const k = rt.num(kit('kit-round-elapsed') ?? 0);
			return { value: k > 0 ? k : rt.gameElapsed(), max: null };
		}
		case 'timeLeft':
			return { value: rt.num(kit('kit-round-remaining') ?? 0), max: null };
		case 'countdown':
			return { value: rt.num(kit('kit-round-countdown') ?? 0), max: null };
		case 'round': {
			const k = rt.num(kit('kit-round-number') ?? 0);
			return { value: k > 0 ? k : rt.viewGame().round, max: null };
		}
		case 'level':
			return { value: rt.num(kit('kit-levels-index') ?? 0), max: null };
		case 'levelName':
			return { value: String(kit('kit-levels-currentLabel') ?? ''), max: null };
		case 'stars': {
			// a named level's best stars, else the current level's
			const level = name || String(kit('kit-levels-current') ?? '');
			return { value: level ? rt.num(kit('kit-levels-starsOf', { level }) ?? 0) : 0, max: 3 };
		}
		case 'totalStars':
			return { value: rt.num(kit('kit-levels-totalStars') ?? 0), max: null };
		case 'lives':
			return { value: rt.num(rt.myPeerVar(name || 'lives', 0)), max: null };
		case 'variable':
			return { value: rt.viewGameVar(name || 'score', 0), max: null };
		case 'playerVariable':
			return { value: rt.myPeerVar(name || 'score', 0), max: null };
		case 'stored': {
			const held = name ? rt.readStored(rt.storedKey(name), undefined) : undefined;
			return { value: held === undefined ? 0 : held, max: null };
		}
		case 'published':
			return { value: rt.gameValueOf(name, 0), max: rt.gameValueMax(name) };
		case 'wired':
			return { value: input('value', 0), max: null };
		default: {
			// 'score': the kit's shared score when the game keeps one, else the `score` variable
			const k = kit('kit-score-total');
			return { value: k !== undefined && rt.num(k) !== 0 ? k : rt.viewGameVar('score', 0), max: null };
		}
	}
}

