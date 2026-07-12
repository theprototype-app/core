import * as THREE from 'three';
import { flowNodes, flowEdges, mutedFlowObjects, syncedAnimations, flowValues } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { animationTypes } from './nodeCatalog';
import { moduleEffects, moduleFrameTasks } from './moduleSDK';
import { runScript } from './scriptRuntime';
import { findNodeDef } from './customNodes';
import { updateSounds } from './soundRuntime';

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
			const shape = source.data?.shape ?? 'cube';
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
export const valueTypes = ['number', 'vector3', 'toggle', 'random', 'time', 'math', 'compare', 'gate'];
// existing input sources that also expose a value on their output handle
const sourceValueTypes = ['slider', 'colorpicker'];

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

/**
 * Evaluate a node's OUTPUT value as a PURE function of the graph + synced time.
 * Deterministic across peers: Random is seeded by node id, Time reads the
 * shared clock. Cycle-guarded via `seen`.
 * @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time @param {Set<string>} seen
 * @returns {number | boolean | number[] | string | undefined}
 */
export function evalNode(node, allNodes, allEdges, time, seen = new Set()) {
	if (!node || seen.has(node.id)) return undefined;
	seen.add(node.id);
	const d = node.data || {};
	/** a named input handle's value, falling back to a manual param @param {string} handle @param {any} fallback */
	const input = (handle, fallback) => {
		const edge = allEdges.find((e) => e.target === node.id && e.targetHandle === handle);
		if (edge) {
			const value = evalNode(
				allNodes.find((n) => n.id === edge.source),
				allNodes,
				allEdges,
				time,
				seen
			);
			if (value !== undefined) return value;
		}
		return fallback;
	};
	switch (node.type) {
		case 'number':
			return num(d.value ?? 0);
		case 'slider':
			return num(d.value ?? 20);
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
		default:
			return undefined;
	}
}

/**
 * A consumer node's effective data: its own params, with any value/logic node
 * wired to a named INPUT handle overriding that key (133). Unconnected handles
 * keep the node's own param.
 * @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time
 */
export function resolveInputs(node, allNodes, allEdges, time) {
	const data = { ...(node.data || {}) };
	allEdges.forEach((edge) => {
		if (edge.target !== node.id || !edge.targetHandle) return;
		const source = allNodes.find((n) => n.id === edge.source);
		if (!source) return;
		if (!valueTypes.includes(source.type) && !sourceValueTypes.includes(source.type)) return;
		const value = evalNode(source, allNodes, allEdges, time, new Set());
		if (value !== undefined) data[edge.targetHandle] = value;
	});
	return data;
}

/** @param {any} object @param {any} base @param {any} anim @param {number} time */
function applyAnimation(object, base, anim, time) {
	const data = resolveInputs(anim, nodes, edges, time);
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

	// collect active animations per scene object
	const active = new Map(); // uuid -> anim nodes
	if (sceneObjects) {
		edges.forEach((edge) => {
			const source = nodes.find((n) => n.id === edge.source);
			if (
				!source ||
				(!animationTypes.includes(source.type) &&
					!moduleEffects[source.type] &&
					source.type !== 'script' &&
					source.type !== 'customnode')
			)
				return;
			const uuid = targetUuidOf(edge);
			if (!uuid) return;
			if (!active.has(uuid)) active.set(uuid, []);
			active.get(uuid).push(source);
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
		anims.forEach((anim) => applyAnimation(object, base, anim, time));
	});

	// sound nodes keep their own audio chains (97) — hand over the live pairs
	/** @type {{node: any, uuid: string}[]} */
	const soundPairs = [];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (source?.type !== 'sound') return;
		const uuid = targetUuidOf(edge);
		// resolve input-driven volume/radius (133) without touching soundRuntime
		if (uuid) soundPairs.push({ node: { ...source, data: resolveInputs(source, nodes, edges, time) }, uuid });
	});
	updateSounds(soundPairs, sceneObjects, time);

	// live value/logic readouts (133): recompute ~6/s and publish for the cards
	if (now - lastValuesAt > 150) {
		lastValuesAt = now;
		/** @type {Record<string, any>} */
		const values = {};
		for (const node of nodes) {
			if (valueTypes.includes(node.type)) values[node.id] = evalNode(node, nodes, edges, time, new Set());
		}
		flowValues.set(values);
	}

	moduleFrameTasks.forEach((task) => {
		try {
			task(time);
		} catch (error) {
			console.log('module frame task failed', error);
		}
	});

	requestAnimationFrame(tick);
}

export function startFlowRuntime() {
	if (started || typeof window === 'undefined') return;
	started = true;

	flowNodes.subscribe((value) => {
		nodes = value;
		applyColors();
	});
	flowEdges.subscribe((value) => {
		edges = value;
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
