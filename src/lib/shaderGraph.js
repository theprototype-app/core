// Per-object (and scene-default) shader graph documents (plan SH1 + SH6b).
//
// KEYING follows flowGraphs' `'scene' | objectUuid` precedent, extended for the look
// plan's post domain: `'scene'` = the scene DEFAULT material (layer 2), an objectUuid =
// that object's own material (layer 3), `'post:<id>'` = a post-domain graph (layer 1).
// Resolution for an object is own graph -> scene default -> its real material, and it
// lives behind ONE accessor (`graphKeyFor`) so layer 2 is an assignment change later
// rather than a rewrite.
//
// This module owns the DATA and the compile orchestration. It deliberately does NOT own
// the wire or history: `setShaderGraphFor` is the single write path and calls the seams
// SH2 fills in. Compiling goes through `shaderBackends`, so the ShaderFrog/inject choice
// stays a one-word change (SH0.5 measured inject as the default: ~1000x faster and it
// tracks the scene's light set, which ShaderFrog silently does not).

import { writable, get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera, globalRenderer } from '../stores/sceneStore.js';
import { compileShaderGraphToIR } from './shaderCompile.js';
import { compileShaderGraph, INJECT_SHADER_BACKEND, forgetShaderContext } from './shaderBackends.js';

/** The reserved key for the scene default material (layer 2). */
export const SCENE_GRAPH_KEY = 'scene';

/**
 * @typedef {object} ShaderGraphDoc
 * @property {any[]} nodes
 * @property {any[]} edges
 * @property {'surface'|'post'} domain
 * @property {string} backend
 * @property {number} changedAt
 */

/** All graph documents, keyed as described above. @type {import('svelte/store').Writable<Record<string, ShaderGraphDoc>>} */
export const shaderGraphs = writable({});

/** Per-key compile errors, for the editor to surface. @type {import('svelte/store').Writable<Record<string, string[]>>} */
export const shaderErrors = writable({});

/** Which graph the editor is scoped to. @type {import('svelte/store').Writable<string|null>} */
export const activeShaderGraph = writable(null);

/** Objects whose material we replaced: uuid -> the ORIGINAL material. @type {Map<string, any>} */
const baseMaterials = new Map();

/** uuid -> the last material we successfully compiled and installed. @type {Map<string, any>} */
const installed = new Map();

/**
 * ONE normalize at every store boundary (wire, autosave restore, session load, undo), so
 * an older save and a newer peer's record both load with defaults and neither is dropped.
 * Spreads the input so fields a NEWER peer added survive our edit.
 * @param {any} doc @returns {ShaderGraphDoc}
 */
export function normalizeShaderGraph(doc) {
	return {
		...(doc ?? {}),
		nodes: Array.isArray(doc?.nodes) ? doc.nodes : [],
		edges: Array.isArray(doc?.edges) ? doc.edges : [],
		domain: doc?.domain === 'post' ? 'post' : 'surface',
		backend: typeof doc?.backend === 'string' ? doc.backend : INJECT_SHADER_BACKEND,
		changedAt: Number(doc?.changedAt) || 0
	};
}

/** @param {string} key @returns {ShaderGraphDoc|null} */
export function shaderGraphOf(key) {
	const doc = get(shaderGraphs)[key];
	return doc ? normalizeShaderGraph(doc) : null;
}

/**
 * THE resolution accessor (SH6b): which graph drives this object, own before the scene
 * default. Returns null when neither exists, meaning "leave its real material alone".
 * @param {string} uuid @returns {string|null}
 */
export function graphKeyFor(uuid) {
	const all = get(shaderGraphs);
	if (uuid && all[uuid]) return uuid;
	if (all[SCENE_GRAPH_KEY]) return SCENE_GRAPH_KEY;
	return null;
}

/**
 * Multi-slot objects are REFUSED in v1 rather than half-supported: a material ARRAY needs
 * the slot-aware plumbing UV4 built, and `switchMaterialType` sets the precedent of
 * declining instead of collapsing the array.
 * @param {any} object @returns {boolean}
 */
export function shaderTargetSupported(object) {
	return !!object && !!object.material && !Array.isArray(object.material);
}

/** @param {any} object @returns {string} */
export function shaderRefusalReason(object) {
	if (!object?.material) return 'That object has no material.';
	if (Array.isArray(object.material))
		return 'That object has ' + object.material.length + ' material slots. Shader graphs support single-material objects for now.';
	return '';
}

// ---- the single write path -----------------------------------------------------

/** Seams SH2 fills: broadcast + history. Registered so this module keeps no cycles. */
/** @type {((key:string, doc:ShaderGraphDoc)=>void)|null} */
let broadcastHook = null;
/** @type {((key:string, before:any, after:any)=>void)|null} */
let historyHook = null;

/** @param {(key:string, doc:ShaderGraphDoc)=>void} fn */
export function registerShaderBroadcast(fn) {
	broadcastHook = fn;
	return () => {
		if (broadcastHook === fn) broadcastHook = null;
	};
}

/** @param {(key:string, before:any, after:any)=>void} fn */
export function registerShaderHistory(fn) {
	historyHook = fn;
	return () => {
		if (historyHook === fn) historyHook = null;
	};
}

/**
 * The ONE way a graph changes — the `setPhysicsFor` precedent: write the store, record
 * history, broadcast, then recompile. Every caller (editor, applier, undo) goes through
 * here so those four never drift apart.
 * @param {string} key
 * @param {any} patch partial doc; `null` deletes
 * @param {{silent?: boolean, stamp?: number}} [opts] `silent` skips history+broadcast
 *   (the applier path: a receiver must never re-broadcast — golden rule 1)
 */
export function setShaderGraphFor(key, patch, opts = {}) {
	const before = shaderGraphOf(key);
	/** @type {ShaderGraphDoc|null} */
	let after = null;
	shaderGraphs.update((all) => {
		const next = { ...all };
		if (patch === null) delete next[key];
		else {
			after = normalizeShaderGraph({
				...(all[key] ?? {}),
				...patch,
				// MONOTONIC per key. A fast gesture writes several times inside one
				// millisecond, and with a bare Date.now() those edits share a stamp — the
				// receiver's latest-wins guard then drops every one after the first, so a
				// drag (and the undo that follows it) silently failed to replicate.
				changedAt: opts.stamp ?? Math.max(Date.now(), (all[key]?.changedAt ?? 0) + 1)
			});
			next[key] = after;
		}
		return next;
	});
	if (!opts.silent) {
		if (historyHook) historyHook(key, before, after);
		if (broadcastHook) broadcastHook(key, /** @type {any} */ (after));
	}
	scheduleCompile(key);
	return after;
}

// ---- compile orchestration ------------------------------------------------------

/** @type {Map<string, any>} */
const timers = new Map();

/** Objects to (re)apply per key. Provided by the caller that knows the scene. */
/** @type {((key:string)=>any[])|null} */
let targetsHook = null;

/**
 * Tell this module how to find the objects a graph key drives — the scene lookup lives
 * outside so this module imports no scene stores and stays free of the history cycle.
 * @param {(key:string)=>any[]} fn
 */
export function registerShaderTargets(fn) {
	targetsHook = fn;
	return () => {
		if (targetsHook === fn) targetsHook = null;
	};
}

/**
 * Debounced: an editor drag writes many times a second, and a compile per keystroke is
 * wasted work even at inject's 0.4 ms.
 * @param {string} key @param {number} [delay]
 */
export function scheduleCompile(key, delay = 60) {
	clearTimeout(timers.get(key));
	timers.set(
		key,
		setTimeout(() => {
			timers.delete(key);
			void compileAndApply(key);
		}, delay)
	);
}

/**
 * Compile a key's graph and install the material on every object it drives.
 * On FAILURE the object keeps its last good material — a broken graph mid-edit must not
 * blank the scene — and the errors land in `shaderErrors` for the editor.
 * @param {string} key @returns {Promise<{ok: boolean, errors?: string[]}>}
 */
export async function compileAndApply(key) {
	const doc = shaderGraphOf(key);
	if (!doc) {
		// deleted: put every target back to its own material
		for (const object of targetsFor(key)) detachFrom(object);
		setErrors(key, []);
		return { ok: true };
	}
	const result = compileShaderGraphToIR(doc);
	if (!result.ok) {
		setErrors(key, result.errors ?? ['Shader compile failed.']);
		return { ok: false, errors: result.errors };
	}
	const targets = targetsFor(key);
	/** @type {string[]} */
	const errors = [];
	for (const object of targets) {
		if (!shaderTargetSupported(object)) {
			errors.push(shaderRefusalReason(object));
			continue;
		}
		const base = captureBase(object);
		try {
			// the inject backend needs none of these; ShaderFrog needs all three (it
			// harvests three's own GLSL by compiling a probe material in the real scene)
			const material = await compileShaderGraph(result.ir, {
				object,
				scene: get(globalScene),
				camera: get(globalCamera),
				renderer: get(globalRenderer),
				baseMaterial: base
			}, doc.backend || INJECT_SHADER_BACKEND);
			applyMaterial(object, material);
		} catch (err) {
			errors.push(String(err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err));
		}
	}
	setErrors(key, errors);
	return { ok: errors.length === 0, errors };
}

/**
 * The DEFAULT targets resolution, so the module works without anyone wiring it: an
 * objectUuid key drives that one object; the scene key drives every mesh that has no
 * graph of its own (layer 2's inheritance rule, own-before-scene).
 * @param {string} key @returns {any[]}
 */
export function defaultTargetsFor(key) {
	const group = get(objectsGroup);
	if (!group) return [];
	if (key !== SCENE_GRAPH_KEY) {
		const object = group.getObjectByProperty('uuid', key);
		return object ? [object] : [];
	}
	const all = get(shaderGraphs);
	/** @type {any[]} */
	const out = [];
	group.traverse((/** @type {any} */ node) => {
		if (node.isMesh && !all[node.uuid]) out.push(node);
	});
	return out;
}

/** Install the default wiring. Idempotent; call once at boot. */
export function startShaderGraphs() {
	if (!targetsHook) registerShaderTargets(defaultTargetsFor);
	startShaderClock();
	startReconcile();
}

/** @type {(()=>void)|null} */
let reconcileStop = null;
/** @type {any} */
let reconcileTimer = null;

/**
 * A graph can arrive BEFORE the object it targets — a late joiner's handshake requests
 * objects and graphs together, and the graph reply is far smaller than a GLTF payload. The
 * compile then finds no target and, without this, nothing ever retried: the joiner sat
 * with the document and the plain material forever. Also covers undoing an object delete.
 */
function startReconcile() {
	if (reconcileStop) return;
	// objectsGroup pokes on every scene mutation, so debounce
	reconcileStop = objectsGroup.subscribe(() => {
		clearTimeout(reconcileTimer);
		reconcileTimer = setTimeout(reconcileShaderGraphs, 120);
	});
}

/** Compile any graph whose targets exist but are not driven yet. */
export function reconcileShaderGraphs() {
	const all = get(shaderGraphs);
	for (const key of Object.keys(all)) {
		const targets = targetsFor(key);
		if (targets.some((/** @type {any} */ o) => o && !installed.has(o.uuid))) scheduleCompile(key, 0);
	}
}

/** Test seam. */
export function stopReconcile() {
	if (reconcileStop) reconcileStop();
	reconcileStop = null;
	clearTimeout(reconcileTimer);
}

// ---- the shared clock -----------------------------------------------------------
//
// A Time node's value comes from the SAME wall-clock formula flowRuntime/soundRuntime/
// animationPreview use, so every peer evaluates the same t and an animated shader agrees
// across the mesh without a single message (determinism IS the netcode). Because the
// value is derived from that shared clock rather than accumulated locally, it does not
// matter that each peer reads it at a slightly different moment — which is why a plain
// rAF is fine here, unlike a DOM overlay that must agree with a threlte frame.

/** Wall clock wrapped daily to keep float precision. @returns {number} */
export function shaderClockNow() {
	return (Date.now() % 86400000) / 1000;
}

/** @type {number|null} */
let clockFrame = null;

/** Advance every installed material's `uShaderTime`. Safe to call by hand in a test. */
export function tickShaderClock() {
	const t = shaderClockNow();
	for (const material of installed.values()) {
		const slot = material?.userData?.shaderUniforms?.uShaderTime ?? material?.uniforms?.uShaderTime;
		if (slot) slot.value = t;
	}
}

function startShaderClock() {
	if (clockFrame !== null || typeof requestAnimationFrame !== 'function') return;
	const loop = () => {
		tickShaderClock();
		clockFrame = requestAnimationFrame(loop);
	};
	clockFrame = requestAnimationFrame(loop);
}

/** Test seam. */
export function stopShaderClock() {
	if (clockFrame !== null) cancelAnimationFrame(clockFrame);
	clockFrame = null;
}

/** @param {string} key @returns {any[]} */
function targetsFor(key) {
	return (targetsHook ?? defaultTargetsFor)(key) ?? [];
}

/** @param {string} key @param {string[]} errors */
function setErrors(key, errors) {
	shaderErrors.update((all) => {
		const next = { ...all };
		if (errors.length) next[key] = errors;
		else delete next[key];
		return next;
	});
}

// ---- attach / detach ------------------------------------------------------------

/**
 * Stash an object's REAL material the first time we replace it. Every serializer must see
 * this one, never a compiled material — the four persistence paths cannot carry a shader
 * (SH4), so the graph rides beside the snapshot and the base is what gets written.
 * @param {any} object @returns {any}
 */
export function captureBase(object) {
	const existing = baseMaterials.get(object.uuid);
	if (existing) return existing;
	baseMaterials.set(object.uuid, object.material);
	return object.material;
}

/** @param {string} uuid @returns {any} */
export function baseMaterialOf(uuid) {
	return baseMaterials.get(uuid) ?? null;
}

/** @param {any} object @param {any} material */
function applyMaterial(object, material) {
	object.material = material;
	installed.set(object.uuid, material);
}

/**
 * Put an object back on its own material and forget our state for it. Undo of an attach
 * and an explicit Detach both land here.
 * @param {any} object
 */
export function detachFrom(object) {
	if (!object) return;
	const base = baseMaterials.get(object.uuid);
	const mine = installed.get(object.uuid);
	if (base) object.material = base;
	baseMaterials.delete(object.uuid);
	installed.delete(object.uuid);
	forgetShaderContext(object);
	// dispose only what WE made, never the base (the onionSkin rule)
	if (mine && mine !== base && typeof mine.dispose === 'function') mine.dispose();
}

/** Is this object currently shader-driven? @param {string} uuid */
export function isShaderDriven(uuid) {
	return installed.has(uuid);
}

/**
 * The live uniform record for a graph's param — how the editor writes a value with NO
 * recompile (SH0.5 measured 0 ms). Returns null when the graph is not installed.
 * @param {string} uuid @param {string} uniformName
 */
export function shaderUniform(uuid, uniformName) {
	const material = installed.get(uuid);
	return material?.userData?.shaderUniforms?.[uniformName] ?? material?.uniforms?.[uniformName] ?? null;
}

/**
 * Write a param's value live. Falls back to a recompile only when the uniform is absent
 * (a structural param such as the GLSL node's expression, which changes the source).
 * @param {string} key @param {string} nodeId @param {string} param @param {any} value
 */
export function setShaderParam(key, nodeId, param, value) {
	const doc = shaderGraphOf(key);
	if (!doc) return false;
	const nodes = doc.nodes.map((/** @type {any} */ n) =>
		n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), [param]: value } } : n
	);
	setShaderGraphFor(key, { nodes: nodes });
	return true;
}

/** Test/serializer seam: drop everything (a scene load replaces all documents). */
export function clearShaderGraphs() {
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	shaderGraphs.set({});
	shaderErrors.set({});
	baseMaterials.clear();
	installed.clear();
}
