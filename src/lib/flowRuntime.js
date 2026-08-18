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
import { updateParticles } from './particleRuntime';
import { startObjectFlowWatcher } from './objectFlow';
import { parkEditOverlays } from './editOverlays';

// H3: inputRuntime is reached via a PRIMED dynamic import (the moduleSDK
// pattern) — a static edge would close the TDZ cycle history -> flowRuntime ->
// inputRuntime -> shortcuts -> history (inputRuntime pulls shortcuts for
// registerShortcut, and shortcuts' subtree reaches peerHandler -> flowGraphs,
// whose module body registers a history kind while history is mid-init).
/** @type {any} */ let inputRuntimeRef = null;

// 17-E A5: same treatment for animationPreview (the Play Animation node drives
// authored clips) — it registers the 'anim' history kind in its own module body,
// so a static edge here would close history -> flowRuntime -> animationPreview ->
// history and TDZ-crash the SSR prerender.
/** @type {any} */ let animRef = null;
/** @type {any} */ let shaderRef = null;
/** @type {any} */ let animImportsRef = null;

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

// 17-D: the per-object transform ORIGIN, read straight off userData. Importing
// objectOrigin here would close flowRuntime -> objectOrigin -> history ->
// flowRuntime and TDZ-crash the SSR prerender (the documented cycle family around
// history.js), and the data is a plain 3-array anyway.
const AXIS_VECTORS = {
	x: new THREE.Vector3(1, 0, 0),
	y: new THREE.Vector3(0, 1, 0),
	z: new THREE.Vector3(0, 0, 1)
};
const pivotVec = new THREE.Vector3();
const offsetVec = new THREE.Vector3();
const scaleVec = new THREE.Vector3();
const eulerTmp = new THREE.Euler();
const spinQuat = new THREE.Quaternion();

/** @param {any} object @returns {number[]|null} */
function originOffsetOf(object) {
	const origin = object?.userData?.origin;
	if (!Array.isArray(origin) || origin.length !== 3) return null;
	return origin.some((n) => n !== 0) ? origin : null;
}

/** The origin in the PARENT frame, derived from the BASE pose so the result stays
 * a pure function of base + time. Exported for headless coverage (the
 * computeMoveOffset pattern). @param {any} object @param {any} base */
export function originPivotOf(object, base) {
	const local = originOffsetOf(object) ?? [0, 0, 0];
	offsetVec
		.fromArray(local)
		.multiply(scaleVec.fromArray(base.scale))
		.applyEuler(eulerTmp.set(base.rot[0], base.rot[1], base.rot[2]));
	return pivotVec.fromArray(base.pos).add(offsetVec);
}

/** Where the body lands when it turns `angle` about `pivot` from its base pose —
 * the spin-about-origin math, exported so a test asserts THIS and not THREE.
 * @param {number[]} basePos @param {any} pivot @param {'x'|'y'|'z'} axis @param {number} angle
 * @returns {number[]} */
export function spinPositionAbout(basePos, pivot, axis, angle) {
	spinQuat.setFromAxisAngle(AXIS_VECTORS[axis] ?? AXIS_VECTORS.y, angle);
	return new THREE.Vector3()
		.fromArray(basePos)
		.sub(pivot)
		.applyQuaternion(spinQuat)
		.add(pivot)
		.toArray();
}

// 17-E A5: rising-edge memory for Play Animation, keyed by node id — the trigger
// pulse stays high for ~0.3s and must act ONCE, not every frame it is high.
/** @type {Map<string, boolean>} */
const playAnimEdge = new Map();

/**
 * Start/stop an authored clip (or an imported one) from a flow event.
 *
 * The node applies the action LOCALLY and does NOT broadcast: the trigger stamp
 * that woke it already replicated (`nodetrigger`), so every peer runs this same
 * branch from the same shared timestamp and derives the same playback. Sending
 * here as well would fire the transport twice and let the two copies disagree
 * about who started it.
 * @param {{node: any, uuid: string}[]} pairs @param {any} ctx
 */
function updatePlayAnim(pairs, ctx) {
	const seen = new Set();
	for (const { node, uuid } of pairs) {
		seen.add(node.id);
		const data = node.data ?? {};
		const high = !!data.trigger;
		const was = playAnimEdge.get(node.id) ?? false;
		playAnimEdge.set(node.id, high);
		if (!high || was) continue; // act on the rising edge only
		const clip = typeof data.clip === 'string' ? data.clip.trim() : '';
		const action = data.action ?? 'toggle';
		const speed = Number(data.speed) || 1;
		// Stamp playback with the TRIGGER's shared timestamp, not this peer's
		// arrival time: the nodetrigger message reaches each peer at a different
		// moment, so reading the clock here would leave every door a message
		// latency out of phase.
		const at = triggerStampFor(node.id, ctx) ?? syncedNow();

		// an imported clip NAME funnels to the mixer path, which is already
		// replicated — one node drives both animation systems
		const imported = animImportsRef?.clipInfo?.(uuid) ?? [];
		if (clip && imported.some((/** @type {any} */ c) => c.name === clip)) {
			const state = animImportsRef.animationState?.(uuid);
			const playing = !!state?.playing && state?.clip === clip;
			const next = action === 'stop' ? false : action === 'toggle' ? !playing : true;
			animImportsRef.setAnimationState(uuid, { clip, playing: next, speed });
			continue;
		}
		if (!animRef) continue;
		const clipId = clip ? animRef.clipIdByName?.(uuid, clip) : undefined;
		/** @type {any} */
		const t = animRef.transportOf?.(uuid) ?? { playing: false, reverse: false, duration: 0, position: 0 };
		const opts = { speed, at, replicate: false };
		if (action === 'stop') {
			animRef.stop(uuid, { replicate: false });
		} else if (action === 'restart') {
			animRef.play(uuid, clipId, { ...opts, from: 0, reverse: false });
		} else if (action === 'toggle') {
			// A door PLAYS BACKWARDS to shut instead of needing a second clip. Mid
			// swing, toggling reverses from where it stands; fully open, it closes;
			// otherwise it opens.
			const atEnd = t.duration > 0 && t.position >= t.duration - 1e-3;
			const reverse = t.playing ? !t.reverse : atEnd;
			const from = reverse ? Math.max(t.duration - t.position, 0) : atEnd ? 0 : t.position;
			animRef.play(uuid, clipId, { ...opts, from, reverse });
		} else {
			const atEnd = t.duration > 0 && t.position >= t.duration - 1e-3;
			animRef.play(uuid, clipId, { ...opts, from: atEnd ? 0 : t.position, reverse: false });
		}
	}
	// forget nodes that no longer exist, so a rebuilt node starts fresh
	for (const id of [...playAnimEdge.keys()]) if (!seen.has(id)) playAnimEdge.delete(id);
}

/** The shared timestamp of whatever event is wired into this node's `trigger`
 * (the newest, with several sources fanned in). @param {string} nodeId @param {any} ctx */
function triggerStampFor(nodeId, ctx) {
	if (!ctx?.triggers) return null;
	let newest = null;
	for (const edge of edges) {
		if (edge.target !== nodeId) continue;
		if (edge.targetHandle && edge.targetHandle !== 'trigger') continue;
		const stamp = ctx.triggers[edge.source]?.lastT;
		if (typeof stamp === 'number' && (newest === null || stamp > newest)) newest = stamp;
	}
	return newest;
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
	// 17-E: AUTHORED clips are a second animation runtime with its own base poses,
	// and since a scrub now survives switching objects a previewed pose can sit in
	// the scene for minutes. Park those too, through the primed ref, so every
	// serializer that already calls in here keeps saving base poses.
	const unpark = animRef?.parkAuthoredAtBase?.() ?? null;
	// ...and the mesh-edit WIREFRAME, which is a CHILD of the edited object and so
	// sits inside the tree every one of these serializers reads. A save taken with
	// a session open wrote it into the file as a permanent, un-updatable wireframe
	// (see editOverlays.js). Same reasoning as the two parks above: one ritual, and
	// every serializer that already calls in here is covered.
	const unpark2 = parkEditOverlays(sceneObjects);
	// ...and any SHADER-DRIVEN material, which no save path can carry: GLTF drops a
	// custom shader outright and toJSON would write our injected material as if it
	// were the object's own. Same one-ritual reasoning as the parks above.
	const unpark3 = shaderRef?.parkShaderMaterials?.() ?? null;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		parked.forEach(resumeAnimation);
		unpark?.();
		unpark2();
		unpark3?.();
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
	'animfinished',
	'number', 'vector3', 'toggle', 'random', 'time', 'math', 'compare', 'gate',
	'loop', 'timer', 'distance', 'proximity', 'onclick', 'counter', // 134
	'maprange', 'select', // 4.6
	'flowinput', 'flowoutput', 'objectflow', // H5: object-flow composition
	'keypress', // H3: keyboard trigger
	'onimpact', // PFX-C: physics impact trigger
	'onenter', 'onexit', // CL-C: sensor overlap triggers
	'velocity', // CL-C: live speed readout (m/s)
	'animstate', // 17-E F3: the readable half of animfinished
	'animmarker' // 17-E F5: the playhead crossed a named point in a clip
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
		case 'animfinished': // 17-E: fired locally when a clip reaches its end
		case 'animmarker': // 17-E F5: fired locally when the playhead crosses one
		case 'onclick': {
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'keypress': {
			// H3: same pulse semantics as onclick — LOCAL keys arrive as replicated
			// trigger stamps (held keys re-pulse, so this stays 1 while held)
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'onimpact': {
			// PFX-C: physics impacts arrive as replicated trigger stamps too
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'onenter':
		case 'onexit': {
			// CL-C: sensor overlap edges arrive as replicated trigger stamps
			// (initiator-detected in physics, same as onimpact)
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'velocity': {
			// CL-C: live speed (m/s) of the wired object (or the graph owner).
			// APPROXIMATE on non-initiators: fed by ~10Hz move-message deltas,
			// exact-ish on the stepping peer (per-step write-back deltas).
			const target = input('target', null) || implicitOwnerOf(node);
			return typeof target === 'string' && ctx && ctx.speed ? ctx.speed(target) : 0;
		}
		case 'animstate': {
			// 17-E F3: the readable half of animfinished. ONE number output whose
			// meaning the `read` param picks, rather than a multi-output handle map:
			// a boolean rides a number socket already (the COERCE table), and this
			// keeps the node in the same shape as math/select.
			//
			// LOCAL like velocity, and for a stronger reason — the transport itself
			// replicates (animplay, a synced-clock stamp), so every peer computes the
			// same reading from the same data with no message of its own.
			const target = input('target', null) || implicitOwnerOf(node);
			if (typeof target !== 'string' || !animRef?.transportOf) return 0;
			const t = animRef.transportOf(target);
			// an empty clip name means "whatever is loaded"; a named one reports 0
			// unless THAT clip is the one on the transport
			if (d.clip) {
				const wanted = animRef.clipIdByName?.(target, d.clip);
				if (!wanted || wanted !== t.clipId) return 0;
			}
			const span = t.rangeOut - t.rangeIn;
			switch (d.read ?? 'progress') {
				case 'playing':
					return t.playing ? 1 : 0;
				case 'position':
					return t.position;
				case 'duration':
					return t.duration;
				case 'remaining':
					return Math.max(0, t.rangeOut - t.position);
				default:
					// progress through the A/B window, which is what the transport
					// actually loops over — clamped, because a parked playhead can sit
					// outside a window set after it was parked
					return span > 1e-6 ? Math.min(1, Math.max(0, (t.position - t.rangeIn) / span)) : 0;
			}
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
		triggers: get(flowTriggers),
		speed: (/** @type {string} */ uuid) => speedOf(uuid)
	};
}

// --- CL-C C3: LOCAL per-object speed feed (velocity node) --------------------
// NOT replicated: the initiator feeds exact per-step write-back poses, peers
// feed the ~10Hz incoming move stream — so the value is approximate off the
// stepping peer (documented on the node card). Stale entries read as 0.
/** @type {Map<string, {x: number, y: number, z: number, t: number, speed: number}>} */
const objectSpeeds = new Map();

/** Feed one observed pose (physics write-back / incoming move applier).
 * @param {string} uuid @param {number} x @param {number} y @param {number} z */
export function noteObjectPose(uuid, x, y, z) {
	const now = performance.now();
	const prev = objectSpeeds.get(uuid);
	if (!prev) {
		objectSpeeds.set(uuid, { x, y, z, t: now, speed: 0 });
		return;
	}
	const dt = (now - prev.t) / 1000;
	if (dt < 0.005) return; // sub-step duplicate
	prev.speed = Math.hypot(x - prev.x, y - prev.y, z - prev.z) / dt;
	prev.x = x;
	prev.y = y;
	prev.z = z;
	prev.t = now;
}

/** Current speed estimate (m/s), 0 when nothing moves / no feed. @param {string} uuid */
export function speedOf(uuid) {
	const entry = objectSpeeds.get(uuid);
	if (!entry) return 0;
	if (performance.now() - entry.t > 400) return 0; // feed went quiet = at rest
	return entry.speed;
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

/** Does a downstream Object Selector targeting `uuid` sit anywhere past `startId`?
 * Follows outgoing edges through intermediate nodes (e.g. On Click -> Particles ->
 * Object Selector), so a trigger wired THROUGH an effect node still fires on the
 * click of the object that effect targets. @param {string} startId @param {string} uuid */
function reachesObjectSelector(startId, uuid) {
	const seen = new Set([startId]);
	const stack = [startId];
	while (stack.length) {
		const cur = stack.pop();
		for (const edge of edges) {
			if (edge.source !== cur || seen.has(edge.target)) continue;
			const target = nodes.find((n) => n.id === edge.target);
			// an Object Selector is a sink — check its target, don't traverse past it
			if (target?.type === 'objectselector') {
				if (target.data?.selected === uuid) return true;
				continue;
			}
			seen.add(edge.target);
			stack.push(edge.target);
		}
	}
	return false;
}

/** A user clicked an object — pulse any OnClick node targeting it (134). @param {string} uuid */
/**
 * A clip on `uuid` just finished — pulse every Animation Finished node aimed at it.
 * LOCAL on purpose: every peer's runtime ends the same once-clip at the same elapsed
 * time, so each fires its own pulse and no message is needed (the same reasoning as
 * the once-clip end itself). animationPreview calls this from its tick.
 * @param {string} uuid
 */
export function fireAnimFinished(/** @type {string} */ uuid) {
	nodes.forEach((node) => {
		if (node.type !== 'animfinished') return;
		if (!reachesObjectSelector(node.id, uuid) && implicitOwnerOf(node) !== uuid) return;
		applyNodeTrigger(node.id, syncedNow(), false);
	});
}

/**
 * F5: the playhead on `uuid` just CROSSED the marker called `name` — pulse every
 * Animation Marker node aimed at it. A node with an empty `name` takes any marker,
 * so one node can drive "something happens at each beat".
 *
 * LOCAL for the same reason as animfinished: every peer's runtime travels the same
 * clip interval from the same synced stamp, so each detects the crossing itself.
 * @param {string} uuid @param {string} name
 */
export function fireAnimMarker(uuid, name) {
	nodes.forEach((node) => {
		if (node.type !== 'animmarker') return;
		const wanted = String(node.data?.name ?? '').trim();
		if (wanted && wanted.toLowerCase() !== String(name).trim().toLowerCase()) return;
		if (!reachesObjectSelector(node.id, uuid) && implicitOwnerOf(node) !== uuid) return;
		applyNodeTrigger(node.id, syncedNow(), false);
	});
}

export function fireObjectClick(uuid) {
	nodes.forEach((node) => {
		if (node.type !== 'onclick') return;
		// H1: an unwired OnClick inside the clicked object's own graph also fires
		if (reachesObjectSelector(node.id, uuid) || implicitOwnerOf(node) === uuid)
			applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/**
 * PFX-C: the physics INITIATOR detected a ground/object impact — pulse any On
 * Impact node targeting the object whose min-strength gate passes. The trigger
 * stamp replicates (nodetrigger), so every peer computes the identical pulse.
 * @param {string} uuid @param {number} strength downward speed at contact (m/s)
 */
export function fireObjectImpact(uuid, strength) {
	const ctx = runtimeCtx();
	nodes.forEach((node) => {
		if (node.type !== 'onimpact') return;
		const data = resolveInputs(node, nodes, edges, syncedNow(), ctx);
		if (strength < num(data.minStrength ?? 0)) return;
		if (reachesObjectSelector(node.id, uuid) || implicitOwnerOf(node) === uuid)
			applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/**
 * A3/A2: a HUD button was pressed on THIS peer — pulse the `hudbutton` node bound to
 * that element id. REPLICATED, like fireObjectClick: a press is a real event on one
 * peer, not a derivation, so the stamp travels on the existing `nodetrigger` message
 * and every peer then computes the identical pulse. The pulse formula is the one
 * onclick/keypress use, so event->number coercion, Counter fan-in and triggerStampFor
 * all work on it unchanged — and this batch adds NO new runtime message type.
 * @param {string} elementId @returns {number} how many nodes were pulsed
 */
export function fireHudButton(elementId) {
	let fired = 0;
	nodes.forEach((node) => {
		if (node.type !== 'hudbutton') return;
		if (String(node.data?.element ?? '') !== String(elementId)) return;
		applyNodeTrigger(node.id, syncedNow(), true);
		fired++;
	});
	return fired;
}

/**
 * CL-A A3: the physics INITIATOR saw a sensor pair start/stop intersecting —
 * pulse the matching On Enter / On Exit nodes targeting `uuid`. Physics fires
 * this once per DIRECTION of the pair (uuid/otherUuid swapped), so matching
 * only on `uuid` covers both sides without double-pulsing. Same replicated-
 * stamp semantics as onimpact; no-op while no such nodes exist (CL-C adds
 * the node types). @param {string} type @param {string} uuid @param {string} otherUuid
 */
function fireSensorEdge(type, uuid, otherUuid) {
	nodes.forEach((node) => {
		if (node.type !== type) return;
		if (reachesObjectSelector(node.id, uuid) || implicitOwnerOf(node) === uuid)
			applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/** Something entered a sensor (or a sensor entered something). @param {string} uuid @param {string} otherUuid */
export function fireObjectEnter(uuid, otherUuid) {
	fireSensorEdge('onenter', uuid, otherUuid);
}

/** A sensor overlap ended. @param {string} uuid @param {string} otherUuid */
export function fireObjectExit(uuid, otherUuid) {
	fireSensorEdge('onexit', uuid, otherUuid);
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
	// 17-D: spin and orbit turn about the object's ORIGIN when it carries one, so a
	// hinged door swings on its hinge and a wheel turns on its axle. Still a pure
	// function of (base pose, time) — determinism IS the netcode for these.
	if ((anim.type === 'spin' || anim.type === 'orbit') && originOffsetOf(object)) {
		const speed = data.speed ?? 1;
		originPivotOf(object, base);
		if (anim.type === 'spin') {
			const axis = data.axis ?? 'y';
			const angle = time * speed;
			object.rotation[axis] += angle;
			object.position.fromArray(spinPositionAbout(base.pos, pivotVec, axis, angle));
		} else {
			// the orbit circle is centred ON the origin instead of the base pose
			const radius = data.radius ?? 1;
			object.position.set(
				pivotVec.x + Math.cos(time * speed) * radius,
				object.position.y,
				pivotVec.z + Math.sin(time * speed) * radius
			);
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
	} else if (anim.type === 'setuniform') {
		// SH7: drive a shader-graph uniform from a behaviour graph. LOCAL per peer, exactly
		// like setcolor above: the VALUE arrives through the flow graph, which is already
		// deterministic and replicated, so this needs no message of its own. Writing a
		// uniform also needs no recompile — that is what the live uniform record is for.
		const name = typeof data.uniform === 'string' ? data.uniform.trim() : '';
		if (name && shaderRef?.shaderUniform) {
			const slot = shaderRef.shaderUniform(object.uuid, name);
			// NUMBERS only in v1: a flow number socket is what drives this, and a vecN would
			// need an array that socket cannot carry
			const value = Number(data.value);
			if (slot && Number.isFinite(value)) slot.value = value;
		}
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

// PFX-C follow-up: the loop body, split from its scheduler. window.rAF is
// SUSPENDED during an immersive WebXR session (the browser only services
// session.requestAnimationFrame), which froze every flow animation AND physics
// (the postTick) the moment a headset went on. Scene.svelte pumps this from
// threlte's task loop (setAnimationLoop — XR-aware) while presenting; the
// timestamp guard makes a double delivery (both loops in one frame) a no-op.
let lastRunAt = -1000;
/** @param {number} now */
function runTick(now) {
	if (now - lastRunAt < 3) return;
	lastRunAt = now;
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
		anims.forEach((/** @type {any} */ anim) => applyAnimation(object, base, anim, time, ctx));
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

	// PFX-A: particle emitters — same keyed-runtime lifecycle as sound. Node
	// pairs (the `particle` node ships in PFX-B) plus the runtime's own sweep
	// of userData.particles emitters happen in updateParticles.
	/** @type {{node: any, uuid: string}[]} */
	const particlePairs = [];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (source?.type !== 'particle') return;
		const uuid = targetUuidOf(edge);
		if (uuid) particlePairs.push({ node: { ...source, data: resolveInputs(source, nodes, edges, time, ctx) }, uuid });
	});
	nodes.forEach((node) => {
		if (node.type !== 'particle') return;
		const uuid = implicitOwnerOf(node);
		if (uuid) particlePairs.push({ node: { ...node, data: resolveInputs(node, nodes, edges, time, ctx) }, uuid });
	});
	updateParticles(particlePairs, sceneObjects, time);

	// 17-E A5: Play Animation. Same pair collection as sound/particles, then a
	// RISING-EDGE read of the wired event (the pulse is high ~0.3s; act once).
	/** @type {{node: any, uuid: string}[]} */
	const animPairs = [];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (source?.type !== 'playanim') return;
		const uuid = targetUuidOf(edge);
		if (uuid) animPairs.push({ node: { ...source, data: resolveInputs(source, nodes, edges, time, ctx) }, uuid });
	});
	nodes.forEach((node) => {
		if (node.type !== 'playanim') return;
		const uuid = implicitOwnerOf(node);
		if (uuid) animPairs.push({ node: { ...node, data: resolveInputs(node, nodes, edges, time, ctx) }, uuid });
	});
	updatePlayAnim(animPairs, ctx);

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

	// H3: while a Key Press node's key is HELD locally, re-stamp its trigger
	// before the pulse expires so the output stays 1 (bounded re-broadcast,
	// ~3/s per held node)
	{
		const held = inputRuntimeRef ? inputRuntimeRef.getInput().codes : new Set();
		if (held.size) {
			const trigs = get(flowTriggers);
			nodes.forEach((node) => {
				if (node.type !== 'keypress' || !held.has(node.data?.code)) return;
				const pulse = node.data?.pulse ?? 0.3;
				const last = trigs[node.id]?.lastT ?? -Infinity;
				if (time - last > pulse * 0.66) applyNodeTrigger(node.id, syncedNow(), true);
			});
		}
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
}

/** the desktop scheduler (suspended by the browser while in immersive XR) */
/** @param {number} now */
function tick(now) {
	runTick(now);
	requestAnimationFrame(tick);
}

/** XR-side pump: Scene.svelte calls this from threlte's task loop while
 * presenting, so flow + physics keep running in the headset. @param {number} now */
export function pumpFlowTick(now) {
	runTick(now);
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
	// H3: LOCAL key presses pulse matching Key Press nodes — applyNodeTrigger
	// REPLICATES the stamp (button-module pattern), so every peer computes the
	// same pulse from the shared timestamp. Text fields are already filtered by
	// inputRuntime; held keys re-pulse from the tick below.
	import('./inputRuntime').then((m) => {
		inputRuntimeRef = m;
		m.onInput((/** @type {any} */ event) => {
			if (event.type !== 'down') return;
			nodes.forEach((node) => {
				if (node.type === 'keypress' && node.data?.code === event.code)
					applyNodeTrigger(node.id, syncedNow(), true);
			});
		});
	});
	// primed for the Play Animation node (see the TDZ note at the top)
	import('./animationPreview').then((m) => (animRef = m));
	// SH4: a compiled shader material must never reach a serializer — primed, like
	// animationPreview, so flowRuntime keeps no static edge into it
	import('./shaderGraph').then((m) => (shaderRef = m));
	import('./animatedImports').then((m) => (animImportsRef = m));
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
