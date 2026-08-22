// Phase 165: socket types for the flow graph. Each node's output + named input
// handles carry a type; a connection is allowed only between compatible types
// (same type, or a sane coercion). Value nodes feed typed consumer inputs; the
// effect/anim/action nodes carry the special 'effect' type into an Object
// Selector. Existing saved edges are NOT re-validated — only new drags.

import { graphOf } from '../stores/flowStore';
import { moduleValueTypes, moduleNodeInputs } from './moduleNodeIO';

/** output type of a node's source handle @type {Record<string,string>} */
const OUTPUT = {
	number: 'number', slider: 'number', time: 'number', loop: 'number', timer: 'number',
	random: 'number', math: 'number', distance: 'number', counter: 'number',
	switcher: 'number', // 4.4: a real value source (the selected index)
	maprange: 'number', select: 'number', // 4.6: loop-closers
	vector3: 'vector3',
	toggle: 'boolean', compare: 'boolean', gate: 'boolean', proximity: 'boolean',
	colorpicker: 'color',
	objectselector: 'object',
	onclick: 'event',
	keypress: 'event', // H3
	// 21-E5: a pad button is an EVENT (the keypress channel), a stick is a NUMBER. Both
	// therefore reach every existing consumer with no coercion of their own.
	gamepadbutton: 'event',
	gamepadaxis: 'number',
	onimpact: 'event', // PFX-C
	onenter: 'event', onexit: 'event', // CL-C: sensor overlap edges
	animfinished: 'event', // 17-E: a clip reached its end
	animmarker: 'event', // 17-E F5: the playhead crossed a named point in a clip
	animstate: 'number', // 17-E F3: progress / playing / position, one at a time
	velocity: 'number', // CL-C: live speed readout
	measure: 'number', // B6: top / bottom / height / y / speed
	onrest: 'event', // B6: a body settled
	impulse: 'effect', // B6: the physics ACTION nodes feed an Object Selector
	setvelocity: 'effect',
	joint: 'effect',
	// B7: a spawner's Object Selector names the TEMPLATE it copies, not a target it
	// writes to — but the channel is the same one, so no coercion table change
	spawn: 'effect',
	flowinput: 'number', // H5 fallback; the live check reads data.vtype
	// A3 HUD: only the button and the timer produce anything. hudtext/hudbar/
	// hudscreen/hudlist are SINKS — they write into an element, so their output stays
	// the effect channel.
	hudbutton: 'event',
	hudtimer: 'number',
	// 21-E7.1: HUD Rows is a SINK like hudtext/hudlist - it writes into an element - so its
	// output stays the effect channel. Listed rather than left to the fallback, so the table
	// says so out loud (the movespeed/charcontroller precedent).
	hudrows: 'effect',
	// 21-G4: the derived scoreboard is a SINK for the same reason — it writes rows INTO a
	// list element and produces nothing a wire could carry.
	leaderboard: 'effect',
	// 21-D4: the HUD as a SOURCE. `read` decides what the number MEANS (a slider's
	// value, a dropdown's index, a toggle as 1/0) but the socket is a number either
	// way, so one type covers all four input kinds.
	hudinput: 'number',
	// 21-D6 game shell: the event half and the two readable ones
	ongamestate: 'event',
	getvariable: 'number',
	gametime: 'number',
	// 21-F3's `collectcount` MOVED to the collectible module (R3a); a module value
	// node's socket type comes from its registerValueNode `vtype`, so no entry here.
	// 21-G4: one player's own number (mine / a named peer / the sum / the max)
	peervariable: 'number',
	// 21-E4: the logic a game loop is made of. Latch is the only STATE node here -
	// a boolean that holds after the pulse that set it has expired. The other three
	// are event RESHAPERS, so they carry the event channel onward and everything
	// already wired to an event (Object Selector, Counter, a trigger input) accepts
	// them with no coercion table change.
	latch: 'boolean',
	delay: 'event',
	sequence: 'event', // all four step handles; outputType is per-NODE, not per-handle
	once: 'event',
	// 21-F4: the group-travel gate pulses when every player answers yes — an event,
	// so it wires into a Travel trigger (or anything else a pulse drives)
	allplayers: 'event',
	// 21-E6 the character controller. Only two of these produce a value: Move Speed
	// reads the live speed and Move Input reads this peer's own WASD. Both of Move
	// Input's handles are numbers, so ONE per-NODE entry covers them (the sequence
	// rule). The other three are DECLARATIONS/ACTIONS and keep the effect channel the
	// fallback would have handed them anyway — listed so the table says so out loud.
	movespeed: 'number',
	moveinput: 'number',
	charcontroller: 'effect',
	possessnode: 'effect',
	camerafollow: 'effect'
};

/** typed named inputs; `_default` covers an unnamed target handle @type {Record<string,Record<string,string>>} */
const INPUT = {
	objectselector: { _default: 'effect' },
	// CL-C: collider takes an object source (shape 'object') + a scale number;
	// velocity reads the wired object's live speed
	collider: { source: 'object', scale: 'number' },
	velocity: { target: 'object' },
	// B6: the physics action nodes. `target` is an alternative to wiring the node
	// into an Object Selector, exactly like velocity's.
	measure: { target: 'object' },
	impulse: { trigger: 'event', force: 'vector3', target: 'object' },
	setvelocity: { trigger: 'event', linear: 'vector3', angular: 'vector3', target: 'object' },
	joint: { trigger: 'event', a: 'object', b: 'object' },
	// B7: `source` is the alternative to an Object Selector edge (impulse's `target`
	// precedent); `at` is an offset, so it takes the same vector3 a force does. Every
	// range param keeps the numeric fallback, so only these three need declaring — an
	// undeclared handle types as 'number', which would refuse an Object Selector.
	spawn: { trigger: 'event', at: 'vector3', source: 'object' },
	random: { seed: 'number', reroll: 'event' }, // B6
	animstate: { target: 'object' }, // 17-E F3: whose clip to read (or the graph owner)
	math: { a: 'number', b: 'number' },
	compare: { a: 'number', b: 'number' },
	gate: { a: 'boolean', b: 'boolean' },
	// 21-E4: `trigger` was the whole reason play-a-sound-on-press was not authorable
	// by ANY means - the node had `playing` (a continuous state) and nothing else.
	sound: { volume: 'number', trigger: 'event' },
	timer: { a: 'number' },
	maprange: { a: 'number' },
	// 21-E4: c/d are ADDITIVE - a/b keep their ids, so no saved edge moves
	select: { index: 'number', a: 'number', b: 'number', c: 'number', d: 'number' },
	script: { a: 'number', b: 'number', c: 'number' },
	distance: { a: 'object', b: 'object' },
	proximity: { a: 'object', b: 'object' },
	lookat: { target: 'object' },
	setcolor: { color: 'color' },
	visibility: { on: 'boolean' },
	setuniform: { value: 'number' },
	// 21-E4: `reset` joins `pulse` on the SAME path - the counting lives inside
	// applyNodeTrigger, so the reset is one more handle it reads there (the `op`
	// param stays for a counter nobody wires a reset into).
	counter: { pulse: 'event', reset: 'event' },
	// 21-E4 logic nodes. Every socket here is an EVENT except delay's wired seconds:
	// these turn pulses into state and into other pulses, they never take values.
	latch: { set: 'event', reset: 'event', toggle: 'event' },
	delay: { trigger: 'event', cancel: 'event', seconds: 'number' },
	sequence: { trigger: 'event' },
	once: { trigger: 'event', rearm: 'event' },
	// 17-E A5: the trigger that starts/stops an authored clip, plus a wired speed
	playanim: { trigger: 'event', speed: 'number' },
	// PFX-B: drive emission from flow — density, tint, spawn offset, motion, and
	// a burst fired from any event (On Click / Key Press / On Impact)
	particle: { count: 'number', color: 'color', offset: 'vector3', speed: 'number', gravity: 'number', size: 'number', trigger: 'event' },
	// A3 HUD. `value` is the whole point: counter -> hudtext is a live score with no
	// new code, because Counter already counts replicated pulses and every number
	// source already reaches a named input through resolveInputs.
	hudtext: { value: 'number' },
	hudbar: { value: 'number', min: 'number', max: 'number' },
	hudscreen: { trigger: 'event' },
	hudtimer: { start: 'event', duration: 'number' },
	hudlist: { trigger: 'event' },
	// 21-E7.1: `text` is the ROW. There is no string socket type in this system, so it is
	// declared numeric like every other value handle - which accepts a number, an event and
	// a boolean through the coercion table, and a module value node declaring 'number' that
	// happens to return a string (a peer name). resolveInputs does not coerce the value, so
	// the row is whatever the source produced.
	hudrows: { trigger: 'event', text: 'number' },
	hudinput: {},
	// 21-E7.2: `options` joins it - same reasoning as hudrows' `text` about the missing
	// string type, and additive, so no saved edge moves.
	hudset: { trigger: 'event', value: 'number', options: 'number' },
	// 21-D6: every game ACTION is driven by an event, and takes its value wired or typed
	setgamestate: { trigger: 'event' },
	setcamera: { trigger: 'event', camera: 'object' },
	setlook: { trigger: 'event', camera: 'object', on: 'boolean' },
	setvariable: { trigger: 'event', value: 'number' },
	gamestart: { camera: 'object' },
	// 21-F4: travel fires on its trigger edge; allplayers takes each player's own
	// boolean answer (a Latch, a Gate, a Compare — anything true/false)
	travel: { trigger: 'event' },
	allplayers: { condition: 'boolean' },
	// 21-E6 the character controller. `target` is the alternative to wiring the node
	// into an Object Selector (velocity's precedent), and every range param keeps the
	// numeric fallback, so only the EVENT and OBJECT handles need declaring here — an
	// undeclared handle types as 'number', which would refuse an Object Selector.
	charcontroller: { speed: 'number' },
	possessnode: { trigger: 'event', release: 'event', target: 'object' },
	camerafollow: { trigger: 'event', stop: 'event', target: 'object' },
	movespeed: { set: 'event', value: 'number' }
};

// what an OUTPUT type may feed into a differently-typed INPUT
/** @type {Record<string, string[]>} */
const COERCE = {
	number: ['boolean', 'vector3'],
	boolean: ['number'],
	event: ['number', 'boolean'],
	vector3: ['object'],
	object: ['vector3']
};

/** @param {string} nodeType */
export function outputType(nodeType) {
	// A1: a module VALUE node declares its own output type. Without this read the
	// fallback below answered 'effect' for every module type, and an effect output
	// may only reach an effect input — so a module value could not be wired to
	// ANYTHING. That refusal is why module state could not reach a HUD.
	if (moduleValueTypes[nodeType]) return moduleValueTypes[nodeType];
	// anim / effect / action / script / sound / module nodes drive an Object
	// Selector, so their output is the special 'effect' channel
	return OUTPUT[nodeType] ?? 'effect';
}

/** @param {string} nodeType @param {string|null|undefined} handleId */
export function inputType(nodeType, handleId) {
	// A1: a module may declare its node's typed inputs. Checked FIRST, because the
	// static table has no entry for a module type and the fallback is 'number' —
	// which refuses an Object Selector (object -> number is not a coercion).
	const modIn = moduleNodeInputs[nodeType];
	if (modIn) {
		if (handleId && modIn[handleId]) return modIn[handleId];
		if (modIn._default) return modIn._default;
	}
	const map = INPUT[nodeType];
	if (!map) return 'number'; // e.g. anim range params (spin.speed) are numeric
	return (handleId && map[handleId]) || map._default || 'number';
}

/** May an output of `from` connect to an input of `to`? @param {string} from @param {string} to */
export function canConnect(from, to) {
	if (from === to) return true;
	// 4.6 audit fix: EVENT sources (On Click) must reach the Object Selector's
	// effect input — that's the only way fireObjectClick can act on the scene.
	// The blanket effect-only rule rejected it, so the trigger was un-authorable.
	if (from === 'event' && to === 'effect') return true;
	if (from === 'effect' || to === 'effect') return false; // effect only to effect
	return (COERCE[from] || []).includes(to);
}

/** UI tint per socket type (165) @param {string} type */
export function typeColor(type) {
	return (
		{
			number: '#38bdf8', // blue
			vector3: '#a78bfa', // violet
			boolean: '#f472b6', // pink
			color: '#fbbf24', // amber
			object: '#4ade80', // green
			event: '#facc15', // yellow
			effect: '#fb923c' // orange
		}[type] || '#94a3b8'
	);
}

/**
 * Validate a proposed connection against the two nodes' socket types.
 * @param {any} connection xyflow {source, target, sourceHandle, targetHandle}
 * @param {any[]} nodes the current flow nodes
 * @returns {boolean}
 */
export function isValidFlowConnection(connection, nodes) {
	if (!connection || connection.source === connection.target) return false;
	const source = nodes.find((n) => n.id === connection.source);
	const target = nodes.find((n) => n.id === connection.target);
	if (!source || !target) return false;
	// H5: the object-flow interface types come from node DATA / the referenced
	// graph's declarations, not the static type table
	const from = source.type === 'flowinput' ? source.data?.vtype ?? 'number' : outputType(source.type);
	if (source.type === 'objectflow') {
		// embedded outputs carry whatever the flow's outputs compute — untyped v1,
		// anything except the effect channel may consume them
		return resolvedInputType(target, connection.targetHandle) !== 'effect';
	}
	const to = resolvedInputType(target, connection.targetHandle);
	if (to === 'any') return from !== 'effect'; // flow outputs accept any value
	return canConnect(from, to);
}

/**
 * A target node's ACTUAL input type for a handle — the static table plus the
 * H5 data-declared cases (flowoutput accepts any value; objectflow inputs take
 * the referenced flow's declared vtype).
 * @param {any} targetNode @param {string|null|undefined} handleId
 */
export function resolvedInputType(targetNode, handleId) {
	if (!targetNode) return 'number';
	if (targetNode.type === 'flowoutput') return 'any';
	if (targetNode.type === 'objectflow') {
		const graph = graphOf(targetNode.data?.flowUuid ?? '');
		const decl = graph?.nodes.find(
			(/** @type {any} */ n) => n.type === 'flowinput' && (n.data?.name ?? 'value') === handleId
		);
		return decl?.data?.vtype ?? 'number';
	}
	return inputType(targetNode.type, handleId);
}

/**
 * Single-connection inputs (Blender/UE semantics): a NAMED value input holds at
 * most one wire — connecting a new one REPLACES the old (the runtime only reads
 * the first edge anyway). Multi-fan-IN stays for the effect channel (many
 * animations into one Object Selector) and event inputs (many triggers into one
 * Counter); fan-OUT from one output to many inputs is always unlimited.
 * @param {any} connection the NEW connection being made
 * @param {any[]} nodes @param {any[]} edges
 * @returns {string[]} ids of existing edges the new wire replaces
 */
export function replaceableInputEdges(connection, nodes, edges) {
	if (!connection?.targetHandle) return []; // unnamed handles = the effect channel
	const target = nodes.find((n) => n.id === connection.target);
	const type = resolvedInputType(target, connection.targetHandle);
	if (type === 'effect' || type === 'event') return [];
	return edges
		.filter((e) => e.target === connection.target && e.targetHandle === connection.targetHandle)
		.map((e) => e.id);
}
