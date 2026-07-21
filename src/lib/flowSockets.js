// Phase 165: socket types for the flow graph. Each node's output + named input
// handles carry a type; a connection is allowed only between compatible types
// (same type, or a sane coercion). Value nodes feed typed consumer inputs; the
// effect/anim/action nodes carry the special 'effect' type into an Object
// Selector. Existing saved edges are NOT re-validated — only new drags.

import { graphOf } from '../stores/flowStore';

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
	onclick: 'event'
};

/** typed named inputs; `_default` covers an unnamed target handle @type {Record<string,Record<string,string>>} */
const INPUT = {
	objectselector: { _default: 'effect' },
	math: { a: 'number', b: 'number' },
	compare: { a: 'number', b: 'number' },
	gate: { a: 'boolean', b: 'boolean' },
	sound: { volume: 'number' },
	timer: { a: 'number' },
	maprange: { a: 'number' },
	select: { index: 'number', a: 'number', b: 'number' },
	script: { a: 'number', b: 'number', c: 'number' },
	distance: { a: 'object', b: 'object' },
	proximity: { a: 'object', b: 'object' },
	lookat: { target: 'object' },
	setcolor: { color: 'color' },
	visibility: { on: 'boolean' },
	counter: { pulse: 'event' }
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
	// anim / effect / action / script / sound / module nodes drive an Object
	// Selector, so their output is the special 'effect' channel
	return OUTPUT[nodeType] ?? 'effect';
}

/** @param {string} nodeType @param {string|null|undefined} handleId */
export function inputType(nodeType, handleId) {
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
		return inputType(target.type, connection.targetHandle) !== 'effect';
	}
	if (target.type === 'flowoutput') return from !== 'effect'; // outputs accept any value
	if (target.type === 'objectflow') {
		const graph = graphOf(target.data?.flowUuid ?? '');
		const decl = graph?.nodes.find(
			(/** @type {any} */ n) =>
				n.type === 'flowinput' && (n.data?.name ?? 'value') === connection.targetHandle
		);
		return canConnect(from, decl?.data?.vtype ?? 'number');
	}
	return canConnect(from, inputType(target.type, connection.targetHandle));
}
