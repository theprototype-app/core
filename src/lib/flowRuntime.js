import * as THREE from 'three';
import { get } from 'svelte/store';
import { flowGraphs, mutedFlowObjects, syncedAnimations, flowValues, flowTriggers, SCENE_GRAPH, startGraphMirror, allNodes, allEdges } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { animationTypes } from './nodeCatalog';
import { moduleEffects, moduleFrameTasks } from './moduleSDK';
import { runScript } from './scriptRuntime';
import { findNodeDef } from './customNodes';
import { updateSounds } from './soundRuntime';
import { startObjectFlowWatcher } from './objectFlow';

// Runs the node graph: applies colorpicker->objectselector colors on graph changes
// and drives animation/effect nodes with a requestAnimationFrame loop.
// Lives outside the Flow drawer so animations keep running when it is closed.

let started = false;

/** @type {any[]} */ let nodes = [];
/** @type {any[]} */ let edges = [];
/** @type {any} */ let sceneObjects = null;
/** @type {string[]} */ let muted = [];
let synced = true;
let lastValuesAt = 0;

// objectUuid -> captured base transform, restored when its animations are removed
const baseState = new Map();
// animated objects whose animation is paused while the user drags them
const suspended = new Set();

/** @param {any} object */
function captureBase(object) {
	return {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray(),
		visible: object.visible
	};
}

/** @param {any} object @param {any} base */
function restoreBase(object, base) {
	object.position.fromArray(base.pos);
	object.rotation.set(base.rot[0], base.rot[1], base.rot[2]);
	object.scale.fromArray(base.scale);
	object.visible = base.visible;
	// serializers (toJSON/GLTFExporter) read object.matrix directly — without
	// this they'd bake the matrix the last RENDER composed, not the base (88)
	object.updateMatrix();
}

// Resolve which scene object a node graph edge targets:
// animation/color source -> objectselector node with a selected scene object
/** @param {any} edge */
function targetUuidOf(edge) {
	const target = nodes.find((n) => n.id === edge.target);
	if (target?.type !== 'objectselector') return null;
	const selected = target.data?.selected;
	if (!selected || selected === '-None-') return null;
	// per-object mute from the object list context menu
	if (muted.includes(selected)) return null;
	return selected;
}

// H1: inside an OBJECT graph, an effect/source node that is NOT wired into any
// objectselector implicitly targets the graph's owner object. Explicit selector
// wiring always wins (lets an object graph drive other objects too).
/** @param {any} node @returns {string | null} the owner uuid or null */
function implicitOwnerOf(node) {
	const graph = node.__graph;
	if (!graph || graph === SCENE_GRAPH) return null;
	if (muted.includes(graph)) return null;
	const wired = edges.some(
		(e) => e.source === node.id && nodes.find((n) => n.id === e.target)?.type === 'objectselector'
	);
	return wired ? null : graph;
}

function applyColors() {
	if (!sceneObjects) return;
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (!source) return;
		const uuid = targetUuidOf(edge);
		if (!uuid) return;
		const object = sceneObjects.getObjectByProperty('uuid', uuid);
		if (!object) return;

		if (source.type === 'colorpicker' && source.data?.color) {
			if (object.material?.color) object.material.color.set(source.data.color);
		} else if (source.type === 'slider') {
			// slider scales its target (20 = neutral 1.0); animated targets scale via their base
			const factor = Math.min(Math.max((source.data?.value ?? 20) / 20, 0.05), 5);
			const base = baseState.get(uuid);
			if (base) base.scale = [factor, factor, factor];
			else object.scale.set(factor, factor, factor);
		} else if (source.type === 'switcher' && object.geometry) {
			// 4.4: items[index] drives the swap; legacy saved graphs fall back to shape
			const items = Array.isArray(source.data?.items) && source.data.items.length ? source.data.items : ['cube', 'pyramid'];
			const rawIdx = source.data?.index ?? Math.max(items.indexOf(source.data?.shape ?? 'cube'), 0);
			const shape = items[Math.min(Math.max(num(rawIdx), 0), items.length - 1)] ?? 'cube';
			if (object.userData.switcherShape !== shape) {
				object.userData.switcherShape = shape;
				object.geometry.dispose();
				object.geometry =
					shape === 'pyramid' ? new THREE.ConeGeometry(1.4, 2, 4) : new THREE.BoxGeometry(2, 2, 2);
			}
		}
	});
}

/** Do the edges currently animate this object? @param {string} uuid */
export function isAnimatedTarget(uuid) {
	return baseState.has(uuid);
}

/**
 * Pause the animation of an object while the user drags it: the object is
 * put back at its logical base so the gizmo edits the base transform.
 * @param {string} uuid
 */
export function suspendAnimation(uuid) {
	if (!baseState.has(uuid) || suspended.has(uuid)) return;
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object) restoreBase(object, baseState.get(uuid));
	suspended.add(uuid);
}

/** Resume after a drag: the object's current transform becomes the new base @param {string} uuid */
export function resumeAnimation(uuid) {
	if (!suspended.has(uuid)) return;
	suspended.delete(uuid);
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object && baseState.has(uuid)) baseState.set(uuid, captureBase(object));
}

/**
 * Park every animated object at its base pose while a serializer reads the
 * scene (peer full sync, GLTF save, autosave, session snapshot) — otherwise
 * the receiver/save bakes a mid-swing pose as its animation base and absolute
 * poses differ between peers by a constant offset (phase 88).
 * Returns an idempotent restore function; objects a gizmo drag already
 * suspended are left alone.
 */
export function parkAnimatedAtBase() {
	const parked = [...baseState.keys()].filter((uuid) => !suspended.has(uuid));
	parked.forEach(suspendAnimation);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		parked.forEach(resumeAnimation);
	};
}

/**
 * An external move (remote peer, undo, align-to-ground) just wrote the intended
 * transform directly to the object — adopt it as the new animation base instead
 * of overwriting it on the next tick.
 * @param {string} uuid
 */
export function notifyExternalMove(uuid) {
	if (!baseState.has(uuid) || suspended.has(uuid)) return;
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object) baseState.set(uuid, captureBase(object));
}

// --- Phase 133: value + logic nodes ------------------------------------------

// node types that produce an OUTPUT value (not a scene effect)
export const valueTypes = [
	'number', 'vector3', 'toggle', 'random', 'time', 'math', 'compare', 'gate',
	'loop', 'timer', 'distance', 'proximity', 'onclick', 'counter', // 134
	'maprange', 'select', // 4.6
	'flowinput', 'flowoutput', 'objectflow' // H5: object-flow composition
];

// --- H5: object flows embedded in the scene graph -----------------------------
// The SCENE graph feeds values INTO an object flow through its declared Flow
// Input nodes (per-tick injection, same tick) and reads its Flow Output values
// back (computed at the END of a tick, consumed by the scene on the NEXT tick —
// one frame of latency, documented in the plan).
/** @type {Record<string, Record<string, any>>} graphId -> {inputName: value} */
let graphInputs = {};
/** @type {Record<string, Record<string, any>>} graphId -> {outputName: value} */
let graphOutputs = {};

/** Unwrap a multi-output node's handle map by the edge's sourceHandle.
 * @param {any} value @param {any} edge */
function unwrapHandle(value, edge) {
	if (value && typeof value === 'object' && value.__handles)
		return edge?.sourceHandle ? value.__handles[edge.sourceHandle] : undefined;
	return value;
}

/** Typed zero for a Flow Input with nothing injected. @param {string} vtype */
function typedFallback(vtype) {
	if (vtype === 'boolean') return false;
	if (vtype === 'vector3') return [0, 0, 0];
	if (vtype === 'color') return '#ffffff';
	return 0;
}
// existing input sources that also expose a value on their output handle
// (4.4: switcher outputs its selected index)
const sourceValueTypes = ['slider', 'colorpicker', 'objectselector', 'switcher'];

/** djb2 hash of a string -> uint32 (Random seed) @param {string} str */
function hashString(str) {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
	return hash >>> 0;
}
/** seeded PRNG (mulberry32) -> [0,1) @param {number} seed */
function mulberry32(seed) {
	let t = (seed + 0x6d2b79f5) >>> 0;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** @param {any} v -> number */
function num(v) {
	if (Array.isArray(v)) return Number(v[0]) || 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
/** @param {any} v -> boolean */
function bool(v) {
	if (Array.isArray(v)) return v.length > 0;
	return typeof v === 'number' ? v !== 0 : !!v;
}
/** 4.1: a wired "point" — an object uuid (looked up) OR a vector3 literal array.
 * @param {any} v @param {any} ctx @returns {any} THREE.Vector3 | null */
function pointOf(v, ctx) {
	if (Array.isArray(v) && v.length >= 3) return new THREE.Vector3(num(v[0]), num(v[1]), num(v[2]));
	if (ctx && typeof v === 'string') return ctx.pos(v);
	return null;
}

/**
 * Evaluate a node's OUTPUT value as a PURE function of the graph + synced time.
 * Deterministic across peers: Random is seeded by node id, Time reads the
 * shared clock. Cycle-guarded via `seen`.
 * `ctx` (optional) gives scene-reading nodes (Distance/Proximity) + event nodes
 * (OnClick/Counter) their world state: { pos(uuid), triggers }.
 * @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time @param {Set<string>} seen @param {any} ctx
 * @returns {number | boolean | number[] | string | undefined}
 */
export function evalNode(node, allNodes, allEdges, time, seen = new Set(), ctx = null) {
	// 4.1: PATH-based cycle guard. The old global `seen` meant a source feeding
	// TWO inputs of one node evaluated once — the second input read undefined and
	// fell back (math a+b wired from one number returned a + fallback). Deleting
	// on exit lets siblings re-evaluate; true cycles are still cut on the path.
	if (!node || seen.has(node.id)) return undefined;
	seen.add(node.id);
	const value = evalNodeBody(node, allNodes, allEdges, time, seen, ctx);
	seen.delete(node.id);
	return value;
}

/** @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time @param {Set<any>} seen @param {any} ctx */
function evalNodeBody(node, allNodes, allEdges, time, seen, ctx) {
	const d = node.data || {};
	/** a named input handle's value, falling back to a manual param @param {string} handle @param {any} fallback */
	const input = (handle, fallback) => {
		const edge = allEdges.find((e) => e.target === node.id && e.targetHandle === handle);
		if (edge) {
			const value = unwrapHandle(
				evalNode(allNodes.find((n) => n.id === edge.source), allNodes, allEdges, time, seen, ctx),
				edge
			);
			if (value !== undefined) return value;
		}
		return fallback;
	};
	switch (node.type) {
		case 'number':
			return num(d.value ?? 0);
		case 'slider': {
			// 4.4: adjustable min/max (data-seeded) — clamp so stale values can't escape
			const lo = num(d.min ?? 0);
			const hi = num(d.max ?? 40);
			return Math.min(Math.max(num(d.value ?? 20), Math.min(lo, hi)), Math.max(lo, hi));
		}
		case 'switcher':
			// 4.4: a real value source — the selected item INDEX (pairs with select/compare)
			return num(d.index ?? Math.max((Array.isArray(d.items) ? d.items : ['cube', 'pyramid']).indexOf(d.shape ?? 'cube'), 0));
		case 'maprange': {
			// 4.6: remap a from [inMin..inMax] to [outMin..outMax] (optional clamp)
			const a = num(input('a', d.a ?? 0));
			const inMin = num(d.inMin ?? 0);
			const inMax = num(d.inMax ?? 1);
			const outMin = num(d.outMin ?? 0);
			const outMax = num(d.outMax ?? 1);
			const span = inMax - inMin;
			let t = span === 0 ? 0 : (a - inMin) / span;
			if (d.clamp ?? true) t = Math.min(Math.max(t, 0), 1);
			return outMin + t * (outMax - outMin);
		}
		case 'select':
			// 4.6: pick a or b by a wired index/boolean (switcher/compare pair-up)
			return num(input('index', d.index ?? 0)) < 0.5 ? input('a', d.a ?? 0) : input('b', d.b ?? 0);
		case 'toggle':
			return !!d.on;
		case 'vector3':
			return [num(d.x ?? 0), num(d.y ?? 0), num(d.z ?? 0)];
		case 'colorpicker':
			return d.color ?? '#ffffff';
		case 'time': {
			const t = time * num(d.rate ?? 1);
			if (d.mode === 'sin') return Math.sin(t);
			if (d.mode === 'saw') return ((t % 1) + 1) % 1;
			if (d.mode === 'pingpong') {
				const p = ((t % 2) + 2) % 2;
				return p > 1 ? 2 - p : p;
			}
			return time;
		}
		case 'random': {
			const lo = num(d.min ?? 0);
			const hi = num(d.max ?? 1);
			const interval = num(d.interval ?? 0);
			const roll = interval > 0 ? Math.floor(time / interval) : 0;
			return lo + mulberry32(hashString(node.id) + roll) * (hi - lo);
		}
		case 'math': {
			const a = num(input('a', d.a ?? 0));
			const b = num(input('b', d.b ?? 0));
			switch (d.op ?? 'add') {
				case 'sub': return a - b;
				case 'mul': return a * b;
				case 'div': return b !== 0 ? a / b : 0;
				case 'min': return Math.min(a, b);
				case 'max': return Math.max(a, b);
				case 'mod': return b !== 0 ? ((a % b) + b) % b : 0;
				default: return a + b;
			}
		}
		case 'compare': {
			const a = num(input('a', d.a ?? 0));
			const b = num(input('b', d.b ?? 0));
			switch (d.op ?? 'gt') {
				case 'lt': return a < b;
				case 'eq': return a === b;
				case 'gte': return a >= b;
				case 'lte': return a <= b;
				case 'neq': return a !== b;
				default: return a > b;
			}
		}
		case 'gate': {
			const a = bool(input('a', d.a ?? false));
			const b = bool(input('b', d.b ?? false));
			switch (d.op ?? 'and') {
				case 'or': return a || b;
				case 'not': return !a;
				case 'xor': return a !== b;
				default: return a && b;
			}
		}
		// --- 134: object reference, loops, timers, events ---
		case 'objectselector':
			return d.selected && d.selected !== '-None-' ? d.selected : undefined;
		case 'loop': {
			const from = num(d.from ?? 0);
			const to = num(d.to ?? 1);
			const span = to - from;
			const phase = time * num(d.rate ?? 1);
			if (d.mode === 'pingpong') {
				const p = ((phase % 2) + 2) % 2;
				return from + (p > 1 ? 2 - p : p) * span;
			}
			if (d.mode === 'once') return from + Math.min(Math.max(phase, 0), 1) * span;
			return from + (((phase % 1) + 1) % 1) * span; // wrap
		}
		case 'timer': {
			// delay line: re-evaluate the wired input at a clock-shifted time
			const delay = num(d.delay ?? 1);
			const edge = allEdges.find((e) => e.target === node.id && e.targetHandle === 'a');
			if (edge) {
				const v = evalNode(
					allNodes.find((n) => n.id === edge.source),
					allNodes,
					allEdges,
					time - delay,
					new Set([node.id]),
					ctx
				);
				return v !== undefined ? v : num(d.a ?? 0);
			}
			return num(d.a ?? 0);
		}
		case 'distance': {
			// 4.1: also accept a wired Vector3 LITERAL as a world point (the coercion
			// matrix allows vector3->object and lookat already honors it)
			const pa = pointOf(input('a', d.a), ctx);
			const pb = pointOf(input('b', d.b), ctx);
			return pa && pb ? pa.distanceTo(pb) : 0;
		}
		case 'proximity': {
			const pa = pointOf(input('a', d.a), ctx);
			const pb = pointOf(input('b', d.b), ctx);
			return pa && pb ? pa.distanceTo(pb) <= num(d.radius ?? 3) : false;
		}
		case 'onclick': {
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'counter':
			return ctx && ctx.triggers && ctx.triggers[node.id] ? ctx.triggers[node.id].count : 0;
		// --- H5: object-flow composition ---
		case 'flowinput': {
			// value injected by the scene graph's embedded Object Flow node this
			// tick; falls back to the node's own default param
			const injected = graphInputs[node.__graph]?.[d.name ?? 'value'];
			return injected !== undefined ? injected : d.fallback ?? typedFallback(d.vtype);
		}
		case 'flowoutput':
			// a Flow Output IS its wired input (lets the tick + readouts reuse eval)
			return input('value', d.fallback ?? 0);
		case 'objectflow':
			// the embedded node exposes the target flow's outputs as named handles,
			// computed at the END of the previous tick (one-frame latency)
			return { __handles: graphOutputs[d.flowUuid] ?? {} };
		default:
			return undefined;
	}
}

/**
 * A consumer node's effective data: its own params, with any value/logic node
 * wired to a named INPUT handle overriding that key (133). Unconnected handles
 * keep the node's own param.
 * @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time @param {any} ctx
 */
export function resolveInputs(node, allNodes, allEdges, time, ctx = null) {
	const data = { ...(node.data || {}) };
	allEdges.forEach((edge) => {
		if (edge.target !== node.id || !edge.targetHandle) return;
		const source = allNodes.find((n) => n.id === edge.source);
		if (!source) return;
		if (!valueTypes.includes(source.type) && !sourceValueTypes.includes(source.type)) return;
		const value = unwrapHandle(evalNode(source, allNodes, allEdges, time, new Set(), ctx), edge);
		if (value !== undefined) data[edge.targetHandle] = value;
	});
	return data;
}

/** Scene/event context handed to evalNode each tick (134). @returns {any} */
function runtimeCtx() {
	return {
		pos: (/** @type {string} */ uuid) => {
			const object = sceneObjects?.getObjectByProperty('uuid', uuid);
			return object ? object.getWorldPosition(new THREE.Vector3()) : null;
		},
		triggers: get(flowTriggers)
	};
}

/** Synced seconds — same formula as the tick clock. */
function syncedNow() {
	return synced ? (Date.now() % 86400000) / 1000 : performance.now() / 1000;
}

/**
 * Apply an event trigger (134): stamp the source node's pulse time and bump any
 * Counter wired from it, all keyed by the SHARED synced time so peers agree.
 * @param {string} nodeId @param {number} t @param {boolean} replicate
 */
export function applyNodeTrigger(nodeId, t, replicate = true) {
	flowTriggers.update((map) => {
		const next = { ...map };
		next[nodeId] = { count: next[nodeId]?.count ?? 0, lastT: t };
		edges.forEach((edge) => {
			if (edge.source !== nodeId) return;
			const counter = nodes.find((n) => n.id === edge.target && n.type === 'counter');
			if (!counter) return;
			const prev = next[counter.id]?.count ?? 0;
			const step = counter.data?.step ?? 1;
			const op = counter.data?.op ?? 'up';
			next[counter.id] = {
				count: op === 'reset' ? 0 : op === 'down' ? prev - step : prev + step,
				lastT: t
			};
		});
		return next;
	});
	if (replicate) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'nodetrigger', id: nodeId, t });
	}
}

/** A user clicked an object — pulse any OnClick node targeting it (134). @param {string} uuid */
export function fireObjectClick(uuid) {
	nodes.forEach((node) => {
		if (node.type !== 'onclick') return;
		const hit = edges.some((edge) => {
			if (edge.source !== node.id) return false;
			const target = nodes.find((n) => n.id === edge.target);
			return target?.type === 'objectselector' && target.data?.selected === uuid;
		});
		// H1: an unwired OnClick inside the clicked object's own graph also fires
		if (hit || implicitOwnerOf(node) === uuid) applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/** @param {any} object @param {any} base @param {any} anim @param {number} time @param {any} ctx */
function applyAnimation(object, base, anim, time, ctx) {
	const data = resolveInputs(anim, nodes, edges, time, ctx);
	if (anim.type === 'script') {
		runScript(anim.id, data.code ?? '', object, base, data, time);
		return;
	}
	if (anim.type === 'customnode') {
		const def = findNodeDef(data.defId);
		if (def) runScript(anim.id, def.code ?? '', object, base, data, time);
		return;
	}
	if (moduleEffects[anim.type]) {
		try {
			moduleEffects[anim.type](object, base, data, time);
		} catch (error) {
			console.log('module effect ' + anim.type + ' failed', error);
		}
		return;
	}
	if (anim.type === 'shake') {
		const intensity = data.intensity ?? 0.2;
		const speed = data.speed ?? 10;
		// deterministic jitter from overlapping sine waves
		object.position.x += Math.sin(time * speed * 7.1) * intensity * 0.3;
		object.position.y += Math.sin(time * speed * 8.9 + 1.3) * intensity * 0.3;
		object.position.z += Math.sin(time * speed * 6.3 + 2.7) * intensity * 0.3;
	} else if (anim.type === 'spin') {
		const axis = data.axis ?? 'y';
		const speed = data.speed ?? 1;
		object.rotation[axis] += time * speed;
	} else if (anim.type === 'bounce') {
		const amplitude = data.amplitude ?? 0.5;
		const speed = data.speed ?? 2;
		object.position.y += Math.abs(Math.sin(time * speed)) * amplitude;
	} else if (anim.type === 'orbit') {
		const radius = data.radius ?? 1;
		const speed = data.speed ?? 1;
		object.position.x += Math.cos(time * speed) * radius;
		object.position.z += Math.sin(time * speed) * radius;
	} else if (anim.type === 'pulse') {
		const amount = data.amount ?? 0.2;
		const speed = data.speed ?? 2;
		const factor = 1 + Math.sin(time * speed) * amount;
		object.scale.set(base.scale[0] * factor, base.scale[1] * factor, base.scale[2] * factor);
	} else if (anim.type === 'blink') {
		const speed = data.speed ?? 2;
		object.visible = Math.sin(time * speed * Math.PI) > 0;
	} else if (anim.type === 'pathpatrol') {
		applyPathPatrol(object, data, time);
	} else if (anim.type === 'lookat') {
		// face a target object (uuid) or point ([x,y,z]) — 134
		let target = null;
		if (Array.isArray(data.target)) target = new THREE.Vector3(data.target[0], data.target[1], data.target[2]);
		else if (typeof data.target === 'string') {
			const other = sceneObjects?.getObjectByProperty('uuid', data.target);
			if (other) target = other.getWorldPosition(new THREE.Vector3());
		}
		if (target) object.lookAt(target);
	} else if (anim.type === 'setcolor') {
		// drive the material color from a color input, LOCAL per peer (no spam) — 134
		if (object.material?.color && typeof data.color === 'string') object.material.color.set(data.color);
	} else if (anim.type === 'visibility') {
		object.visible = !!data.on; // boolean input shows/hides, base-managed
	}
}

/**
 * Walk the waypoint polyline at constant speed (arc-length parameterized),
 * looping or ping-ponging, facing along the path. Waypoints are absolute
 * world points, so the object's base position is ignored while patrolling.
 * @param {any} object @param {any} data @param {number} time
 */
function applyPathPatrol(object, data, time) {
	const points = data.points ?? [];
	if (points.length < 2) return;
	const speed = data.speed ?? 1;
	const loop = (data.mode ?? 'loop') === 'loop';

	// segment lengths (loop closes the polyline)
	const segments = [];
	let total = 0;
	const count = loop ? points.length : points.length - 1;
	for (let i = 0; i < count; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
		segments.push({ a, b, length });
		total += length;
	}
	if (total <= 0) return;

	let distance;
	let reverse = false;
	if (loop) {
		distance = (time * speed) % total;
	} else {
		const cycle = (time * speed) % (2 * total);
		reverse = cycle > total;
		distance = reverse ? 2 * total - cycle : cycle;
	}
	for (const segment of segments) {
		if (distance > segment.length) {
			distance -= segment.length;
			continue;
		}
		const t = segment.length > 0 ? distance / segment.length : 0;
		const { a, b } = segment;
		object.position.set(
			a[0] + (b[0] - a[0]) * t,
			a[1] + (b[1] - a[1]) * t,
			a[2] + (b[2] - a[2]) * t
		);
		object.rotation.y = reverse
			? Math.atan2(a[0] - b[0], a[2] - b[2])
			: Math.atan2(b[0] - a[0], b[2] - a[2]);
		return;
	}
}

/** @param {number} now */
function tick(now) {
	// wall clock (wrapped daily to keep float noise low) -> same phase on every peer
	const time = synced ? (Date.now() % 86400000) / 1000 : now / 1000;
	const ctx = runtimeCtx(); // 134: scene + trigger state for the evaluators

	// collect active animations per scene object
	// H5: inject the scene graph's wired values into each embedded object flow
	// BEFORE effects run, so Flow Inputs read this tick's scene values
	/** @type {Record<string, Record<string, any>>} */
	const nextInputs = {};
	nodes.forEach((embed) => {
		if (embed.type !== 'objectflow') return;
		const target = embed.data?.flowUuid;
		if (!target) return;
		const bucket = nextInputs[target] ?? (nextInputs[target] = {});
		edges.forEach((e) => {
			if (e.target !== embed.id || !e.targetHandle) return;
			const src = nodes.find((n) => n.id === e.source);
			if (!src) return;
			const v = unwrapHandle(evalNode(src, nodes, edges, time, new Set(), ctx), e);
			if (v !== undefined) bucket[e.targetHandle] = v;
		});
	});
	graphInputs = nextInputs;

	const active = new Map(); // uuid -> anim nodes
	/** @param {any} node */
	const isEffectNode = (node) =>
		animationTypes.includes(node.type) ||
		!!moduleEffects[node.type] ||
		node.type === 'script' ||
		node.type === 'customnode';
	if (sceneObjects) {
		edges.forEach((edge) => {
			const source = nodes.find((n) => n.id === edge.source);
			if (!source || !isEffectNode(source)) return;
			const uuid = targetUuidOf(edge);
			if (!uuid) return;
			if (!active.has(uuid)) active.set(uuid, []);
			active.get(uuid).push(source);
		});
		// H1: object-graph effects with no explicit selector target their owner
		nodes.forEach((node) => {
			if (!isEffectNode(node)) return;
			const uuid = implicitOwnerOf(node);
			if (!uuid) return;
			if (!active.has(uuid)) active.set(uuid, []);
			if (!active.get(uuid).includes(node)) active.get(uuid).push(node);
		});
	}

	// restore objects whose animations were disconnected/deleted
	baseState.forEach((base, uuid) => {
		if (!active.has(uuid)) {
			const object = sceneObjects?.getObjectByProperty('uuid', uuid);
			if (object) restoreBase(object, base);
			baseState.delete(uuid);
		}
	});

	active.forEach((anims, uuid) => {
		if (suspended.has(uuid)) return; // user is dragging it — leave it alone
		const object = sceneObjects.getObjectByProperty('uuid', uuid);
		if (!object) {
			baseState.delete(uuid);
			return;
		}
		if (!baseState.has(uuid)) baseState.set(uuid, captureBase(object));
		const base = baseState.get(uuid);
		// reset to base, then let each animation add its offset
		restoreBase(object, base);
		anims.forEach((anim) => applyAnimation(object, base, anim, time, ctx));
	});

	// sound nodes keep their own audio chains (97) — hand over the live pairs
	/** @type {{node: any, uuid: string}[]} */
	const soundPairs = [];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (source?.type !== 'sound') return;
		const uuid = targetUuidOf(edge);
		// resolve input-driven volume/radius (133) without touching soundRuntime
		if (uuid) soundPairs.push({ node: { ...source, data: resolveInputs(source, nodes, edges, time, ctx) }, uuid });
	});
	// H1: sound nodes in object graphs attach to their owner when unwired
	nodes.forEach((node) => {
		if (node.type !== 'sound') return;
		const uuid = implicitOwnerOf(node);
		if (uuid) soundPairs.push({ node: { ...node, data: resolveInputs(node, nodes, edges, time, ctx) }, uuid });
	});
	updateSounds(soundPairs, sceneObjects, time);

	// live value/logic readouts (133): recompute ~6/s and publish for the cards
	if (now - lastValuesAt > 150) {
		lastValuesAt = now;
		/** @type {Record<string, any>} */
		const values = {};
		for (const node of nodes) {
			// H5: objectflow returns a handle MAP, not a scalar — no card readout
			if (valueTypes.includes(node.type) && node.type !== 'objectflow')
				values[node.id] = evalNode(node, nodes, edges, time, new Set(), ctx);
		}
		flowValues.set(values);
	}

	// H5: harvest every object flow's declared outputs for the NEXT tick's
	// embedded Object Flow reads (one-frame latency by design)
	/** @type {Record<string, Record<string, any>>} */
	const nextOutputs = {};
	nodes.forEach((node) => {
		if (node.type !== 'flowoutput' || !node.__graph || node.__graph === SCENE_GRAPH) return;
		const name = node.data?.name ?? 'out';
		(nextOutputs[node.__graph] ??= {})[name] = evalNode(node, nodes, edges, time, new Set(), ctx);
	});
	graphOutputs = nextOutputs;

	moduleFrameTasks.forEach((task) => {
		try {
			task(time);
		} catch (error) {
			console.log('module frame task failed', error);
		}
	});

	// P-A: physics steps AFTER the animation pass in the SAME frame, so the
	// order is deterministic: flow poses objects -> physics reads kinematic
	// targets -> world.step() -> physics writes dynamic results. One slot (a
	// dedicated hook, not a moduleFrameTask: those have no removal or ordering
	// guarantee); physics sets it on sim start and clears it on stop.
	if (postTick) {
		try {
			postTick(now);
		} catch (error) {
			console.log('post-tick hook failed', error);
		}
	}

	requestAnimationFrame(tick);
}

/** @type {((now: number) => void) | null} */
let postTick = null;

/** Install/clear the single post-tick hook (physics). @param {((now: number) => void) | null} fn */
export function setPostTick(fn) {
	postTick = fn;
}

export function startFlowRuntime() {
	if (started || typeof window === 'undefined') return;
	started = true;

	// H1: the runtime sees EVERY graph (scene + per-object documents) as one
	// combined node/edge set; nodes carry a runtime-only __graph tag used for
	// implicit-owner targeting. The mirror keeps the editor view in sync.
	startGraphMirror();
	startObjectFlowWatcher(); // H5: embed-socket pruning on interface changes
	flowGraphs.subscribe(() => {
		nodes = allNodes();
		edges = allEdges();
		applyColors();
	});
	objectsGroup.subscribe((value) => {
		sceneObjects = value;
	});
	mutedFlowObjects.subscribe((value) => {
		muted = value;
		applyColors();
	});
	syncedAnimations.subscribe((value) => {
		synced = value;
		if (typeof localStorage !== 'undefined') localStorage.setItem('syncedAnimations', String(value));
	});

	requestAnimationFrame(tick);
}
