// Per-object (and scene-default) shader graph documents (plan SH1 + SH6b).
//
// KEYING follows flowGraphs' `'scene' | objectUuid` precedent, extended for the look
// plan's post domain: `'scene'` = the scene DEFAULT material (layer 2), an objectUuid =
// that object's own material (layer 3), `'post:<id>'` = a post-domain graph (layer 1).
// Resolution for an object is own graph -> scene default -> its real material, and it
// lives behind ONE accessor (`graphKeyFor`) so layer 2 is an assignment change later
// rather than a rewrite.
//
// 105-slot-shaders: `<objectUuid>/<slotId>` = ONE material slot of that object (the slot's
// stable id, 105-slots' `slotIdsOf`). The plain `<objectUuid>` keeps meaning the whole
// object = every slot without its own key. Per slot: slot key -> object key -> scene
// default -> its own material (`graphKeyForSlot`). `shaderKeyParts` is the ONE place that
// reads a key. The wire, undo and save shapes are unchanged (a key is still a string).
//
// THE STATE behind a key is per TARGET: a single-material object is one target (slot
// null, today's path verbatim: `object.material` IS the compiled material); an object
// with a material ARRAY is one target per slot, and the compiled material is SEATED in
// that slot through 105-slots' draw layer (`setSlotProduct`), so the slot's own material
// stays the truth for every serializer and an off slot draws the default, shader or not.
//
// This module owns the DATA and the compile orchestration. It deliberately does NOT own
// the wire or history: `setShaderGraphFor` is the single write path and calls the seams
// SH2 fills in. Compiling goes through `shaderBackends`, so the ShaderFrog/inject choice
// stays a one-word change (SH0.5 measured inject as the default: ~1000x faster and it
// tracks the scene's light set, which ShaderFrog silently does not).

import { writable, get } from 'svelte/store';
import { sessionNow } from './sessionClock'; // 25-E: stamps another peer compares
import { objectsGroup, globalScene, globalCamera, globalRenderer, pokeScene } from '../stores/sceneStore.js';
import { compileShaderGraphToIR } from './shaderCompile.js';
import { compileShaderGraph, INJECT_SHADER_BACKEND, forgetShaderContext } from './shaderBackends.js';
import {
	resolveShaderTexture,
	shaderTextureFor,
	shaderPlaceholderTexture,
	registerShaderTextureListener,
	startShaderTextures
} from './shaderTextures.js';
// P5: the LOCAL right to switch this layer off. `viewportOverrides` is a leaf (stores
// only), and its `shaders` key has been DECLARED since B precisely so this phase adds a
// renderer rather than a new concept — see that module for the rule it encodes.
import { viewportOverrides, renderLayer } from './viewportOverrides.js';
// 73 AI3: your own GLSL. `shaderCode` is pure; the guard owns what this device will run.
import { checkShaderCode, shaderCodeHash, usesShaderCode, scanShaderUniforms, normalizeShaderCode } from './shaderCode.js';
import {
	startShaderCodeGuard,
	shaderCodeRefusal,
	probeShaderCode,
	makeCodeMaterial,
	watchFirstFrame,
	forgetCodeMaterial,
	retryShaderCode,
	codeUniformValue
} from './shaderCodeGuard.js';
import { showToast } from '../stores/appStore.js';
import { deviceRefusal, reachRefusal, customShadersOnQuest, shaderCodeHeld, holdShaderCode, releaseHeldShaderCode } from './shaderCodeReach.js'; // 73 AI9
import { exportMode } from './export/exportBoot.js';
import { cleanFlowNode, cleanFlowEdge } from './flowClean.js';
import { slotIdOf, slotIdsOf, ownOf, ownMaterialsOf, loadSlotDrawLayer, wholeShaderBase } from './slotDraw.js';

/** The reserved key for the scene default material (layer 2). */
export const SCENE_GRAPH_KEY = 'scene';

/**
 * @typedef {object} ShaderGraphDoc
 * @property {any[]} nodes
 * @property {any[]} edges
 * @property {'surface'|'post'} domain
 * @property {string} backend
 * @property {number} changedAt
 * @property {any} [code] 73 AI3: your own GLSL, see shaderCode.js
 */

/** All graph documents, keyed as described above. @type {import('svelte/store').Writable<Record<string, ShaderGraphDoc>>} */
export const shaderGraphs = writable({});

/** Per-key compile errors, for the editor to surface. @type {import('svelte/store').Writable<Record<string, string[]>>} */
export const shaderErrors = writable({});

/** Which graph the editor is scoped to. @type {import('svelte/store').Writable<string|null>} */
export const activeShaderGraph = writable(null);

/**
 * Targets whose material we replaced: state key -> the ORIGINAL material. A state key is
 * the object's uuid (a single-material object) or `<uuid>/<slotId>` (one slot of a list).
 * @type {Map<string, any>}
 */
const baseMaterials = new Map();

/** state key -> the last material we successfully compiled and installed. @type {Map<string, any>} */
const installed = new Map();

/**
 * What one compile drives: a whole single-material object (`slot` null) or one slot of a
 * material list (`slot` = its id, `index` = where it sits now).
 * @typedef {{object: any, slot: string | null, index?: number}} ShaderTarget
 */

/** 105-slot-shaders: state key -> its SLOT target (slot states only) @type {Map<string, ShaderTarget>} */
const slotStates = new Map();

/** the draw layer, once loaded (slot targets need it) @type {any} */
let slotLayer = null;

// ---- 105-slot-shaders: the key ---------------------------------------------------

/**
 * THE one place that reads a shader key: `{ uuid, slot }`. `'scene'` and `'post:<id>'`
 * name no object (both null); `<uuid>` is the whole object; `<uuid>/<slotId>` one slot.
 * @param {string} key @returns {{uuid: string | null, slot: string | null}}
 */
export function shaderKeyParts(key) {
	if (typeof key !== 'string' || !key || key === SCENE_GRAPH_KEY || key.startsWith('post:'))
		return { uuid: null, slot: null };
	const cut = key.indexOf('/');
	if (cut < 0) return { uuid: key, slot: null };
	return { uuid: key.slice(0, cut), slot: key.slice(cut + 1) || null };
}

/** The key for one slot (no slot = the whole object's key). @param {string} uuid @param {string | null} [slotId] */
export function slotShaderKey(uuid, slotId) {
	return slotId ? uuid + '/' + slotId : uuid;
}

/** @param {ShaderTarget} t */
const stateKeyOf = (t) => slotShaderKey(t.object.uuid, t.slot);

/** A single-material object's one slot id (seen through a whole-object shader). @param {any} object */
function singleSlotIdOf(object) {
	return slotIdOf(baseMaterials.get(object.uuid) ?? ownOf(object.material));
}

/** @param {any} object @returns {string[]} the object's slot ids, in order */
export function slotIdsOfObject(object) {
	if (Array.isArray(object?.material)) return slotIdsOf(object.material.map(ownOf));
	return object?.material ? [singleSlotIdOf(object)] : [];
}

/**
 * Which document drives ONE slot: its own key -> the object's -> the scene default ->
 * null (its own material). `slotId` absent = the object as a whole (`graphKeyFor`).
 * @param {string} uuid @param {string | null} [slotId] @returns {string|null}
 */
export function graphKeyForSlot(uuid, slotId) {
	if (uuid && slotId && get(shaderGraphs)[uuid + '/' + slotId]) return uuid + '/' + slotId;
	return graphKeyFor(uuid);
}

/**
 * Does `key` cover slot `slotId` of `uuid`, whether or not its document exists right now
 * (a delete must reach exactly what the document drove)?
 * @param {Record<string, any>} all @param {string} key @param {string} uuid @param {string} slotId
 */
function keyCovers(all, key, uuid, slotId) {
	const parts = shaderKeyParts(key);
	if (parts.slot) return parts.uuid === uuid && parts.slot === slotId;
	if (all[uuid + '/' + slotId]) return false; // the slot's own key wins
	if (parts.uuid) return parts.uuid === uuid;
	return key === SCENE_GRAPH_KEY && !all[uuid];
}

/**
 * Every TARGET a key drives: a single-material object whole (today's path), or each
 * covered slot of a material list.
 * @param {string} key @returns {ShaderTarget[]}
 */
function slotTargetsFor(key) {
	const all = get(shaderGraphs);
	const parts = shaderKeyParts(key);
	/** @type {ShaderTarget[]} */
	const out = [];
	for (const object of targetsFor(key)) {
		if (!object) continue;
		if (!object.material || !Array.isArray(object.material)) {
			// a slot key reaches a single-material object only when it names its one slot (a
			// list that lost every other slot keeps the survivor's shader); with no slot key
			// for this object anywhere this is exactly the pre-slot target list
			const slotted = !!object.material && (!!parts.slot || Object.keys(all).some((k) => k.startsWith(object.uuid + '/')));
			if (!slotted || keyCovers(all, key, object.uuid, singleSlotIdOf(object))) out.push({ object, slot: null });
			continue;
		}
		slotIdsOf(object.material.map(ownOf)).forEach((id, index) => {
			if (keyCovers(all, key, object.uuid, id)) out.push({ object, slot: id, index });
		});
	}
	return out;
}

/**
 * ONE normalize at every store boundary (wire, autosave restore, session load, undo), so
 * an older save and a newer peer's record both load with defaults and neither is dropped.
 * Spreads the input so fields a NEWER peer added survive our edit.
 * @param {any} doc @returns {ShaderGraphDoc}
 */
export function normalizeShaderGraph(doc) {
	return {
		...(doc ?? {}),
		// Every node needs a POSITION and a `data` object. xyflow dereferences
		// `node.position` while adopting nodes, so a document without one — created
		// programmatically, arriving from a peer, or from a save written by a tool that
		// did not care about layout — takes the whole editor down on mount. Laid out on a
		// deterministic grid, never randomly, so two peers normalizing the same document
		// still agree byte for byte.
		nodes: (Array.isArray(doc?.nodes) ? doc.nodes : []).map((/** @type {any} */ node, /** @type {number} */ i) => ({
			...cleanFlowNode(node),
			position:
				node?.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
					? node.position
					: { x: 60 + (i % 4) * 170, y: 40 + Math.floor(i / 4) * 130 },
			data: node?.data ?? {}
		})),
		edges: Array.isArray(doc?.edges) ? doc.edges.map(cleanFlowEdge) : [],
		domain: doc?.domain === 'post' ? 'post' : 'surface',
		backend: typeof doc?.backend === 'string' ? doc.backend : INJECT_SHADER_BACKEND,
		changedAt: Number(doc?.changedAt) || 0,
		...(doc?.code ? { code: normalizeShaderCode(doc.code) } : {})
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
 * 105-slot-shaders: a material LIST takes a shader per slot (or one for all its slots), so
 * the only refusal left is an object with no material at all.
 * @param {any} object @returns {boolean}
 */
export function shaderTargetSupported(object) {
	return !!object && !!object.material;
}

/** @param {any} object @returns {string} */
export function shaderRefusalReason(object) {
	if (!object?.material) return 'That object has no material.';
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
				changedAt: opts.stamp ?? Math.max(sessionNow(), (all[key]?.changedAt ?? 0) + 1)
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

/** keys whose target object has not arrived -> retries made @type {Map<string, number>} */
const missingTries = new Map();
/** 0.25 s doubling to 4 s, ~20 s in all; then the objectsGroup reconcile alone @param {string} key */
function retryMissingTarget(key) {
	const tries = (missingTries.get(key) ?? 0) + 1;
	if (tries > 8) {
		missingTries.delete(key);
		return;
	}
	missingTries.set(key, tries);
	scheduleCompile(key, Math.min(4000, 250 * 2 ** (tries - 1)));
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

/** P4: the POST domain's own compile path, registered by `postGraphs` (never imported —
 * this module must keep no edge into the composer side). @type {((key: string) => any)|null} */
let postDomainHook = null;

/**
 * Install the post domain's compiler.
 *
 * A post document has no Surface node and drives no object, so shaderGraph's material
 * path is simply the wrong question for it: left to run it would stamp "The graph has no
 * Surface output node" on every post graph. A REGISTRATION rather than an import for the
 * usual reason — `postGraphs` reaches `scenePost` and `postBackends`, and an edge from
 * here into that is one this module does not need.
 * @param {(key: string) => any} fn
 */
export function registerPostDomain(fn) {
	postDomainHook = typeof fn === 'function' ? fn : null;
	return () => {
		if (postDomainHook === fn) postDomainHook = null;
	};
}

/** Is this key a post-domain document (by its own `domain`, so the prefix is a
 * convention and not the truth)? @param {string} key */
export function isPostDomain(key) {
	return shaderGraphOf(key)?.domain === 'post';
}

/**
 * Compile a key's graph and install the material on every object it drives.
 * On FAILURE the object keeps its last good material — a broken graph mid-edit must not
 * blank the scene — and the errors land in `shaderErrors` for the editor.
 * @param {string} key @returns {Promise<{ok: boolean, errors?: string[]}>}
 */
export async function compileAndApply(key) {
	const doc = shaderGraphOf(key);
	// P4: a POST document is an EFFECT, not a material — hand it to the domain that owns
	// it. A deleted document still reaches the hook (doc is null), which is how a post
	// graph's own teardown runs.
	if ((doc?.domain === 'post' || (!doc && postDomainHook && key.startsWith('post:'))) && postDomainHook)
		return postDomainHook(key) ?? { ok: true };
	if (!doc) {
		// deleted: put every target back to its own material (a slot the key drove falls
		// back to the next key in its resolution, through the reconcile)
		for (const target of slotTargetsFor(key)) detachTarget(target);
		setErrors(key, []);
		if (slotStates.size || shaderKeyParts(key).slot) reconcileShaderGraphs();
		return { ok: true };
	}
	if (usesShaderCode(doc)) return compileCodeAndApply(key, doc);
	const result = compileShaderGraphToIR(doc);
	if (!result.ok) {
		setErrors(key, result.errors ?? ['Shader compile failed.']);
		return { ok: false, errors: result.errors };
	}
	const targets = slotTargetsFor(key);
	if (targets.some((t) => t.slot)) slotLayer ??= await loadSlotDrawLayer();
	// test-health-1: a graph for an OBJECT that has not arrived yet (a late joiner's graph reply is
	// far smaller than the GLTF that carries the object) compiles nothing — and the reconcile below
	// waits on an objectsGroup poke the object's arrival does not always make (shader-sync: the
	// joiner held both graph and cube, never compiled; a manual reconcile compiled it at once).
	// Retry on its own, briefly; the reconcile still covers anything later.
	if (!targets.length && key !== SCENE_GRAPH_KEY) retryMissingTarget(key);
	else missingTries.delete(key);
	/** @type {string[]} */
	const errors = [];
	for (const target of targets) {
		const { object } = target;
		if (!shaderTargetSupported(object)) {
			errors.push(shaderRefusalReason(object));
			continue;
		}
		const base = baseFor(target);
		if (!base) continue; // the slot went away since the list was read
		try {
			// the inject backend needs none of these; ShaderFrog needs all three (it
			// harvests three's own GLSL by compiling a probe material in the real scene)
			const material = await compileShaderGraph(result.ir, {
				object,
				slot: target.slot,
				scene: get(globalScene),
				camera: get(globalCamera),
				renderer: get(globalRenderer),
				baseMaterial: base
			}, doc.backend || INJECT_SHADER_BACKEND);
			// a slot's resolution can move while a compile awaits (its own key arrived, the
			// slot was removed): never seat a product for a key that no longer drives it
			if (target.slot && !stillDrives(key, target)) continue;
			// stash the sampler REFERENCES so the retry path can re-fill without the IR. A
			// backend need not know about content hashes at all, and this is the one place
			// holding both the compiled material and the IR that named them.
			material.userData.shaderTextureRefs = (result.ir.uniforms ?? [])
				.filter((/** @type {any} */ u) => u.hash !== undefined)
				.map((/** @type {any} */ u) => ({ name: u.name, hash: u.hash }));
			applyMaterial(target, material);
			fillTextureUniforms(material);
		} catch (err) {
			errors.push(String(err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err));
		}
	}
	setErrors(key, errors);
	return { ok: errors.length === 0, errors };
}

// ---- 73 AI3: your own GLSL --------------------------------------------------------

/** Each refusal is said once, however many objects and recompiles it covers. @type {Set<string>} */
const saidRefusals = new Set();

/**
 * This device will not run this code: take it off what it drives, and say why. The document
 * stays exactly as it is, because the peer who wrote it may run it perfectly well.
 * @param {string} key @param {string} hash @param {string} reason
 * @returns {{ok: boolean, errors: string[]}}
 */
function standDownCode(key, hash, reason) {
	for (const target of slotTargetsFor(key)) if (installed.get(stateKeyOf(target))?.userData?.shaderCodeHash) detachTarget(target);
	setErrors(key, [reason]);
	if (!saidRefusals.has(hash)) {
		saidRefusals.add(hash);
		showToast('A custom shader was turned off on this device. ' + reason);
	}
	return { ok: false, errors: [reason] };
}

/**
 * The code half of compileAndApply: static gate -> this device's refusals -> the worker probe
 * -> install + the first-frame box. A failure of the first and third keeps the last good
 * material, the mid-edit rule the graph path keeps.
 * @param {string} key @param {any} doc @returns {Promise<{ok: boolean, errors?: string[]}>}
 */
async function compileCodeAndApply(key, doc) {
	startCodeGuard();
	const problems = checkShaderCode(doc.code);
	if (problems.length) {
		setErrors(key, problems);
		return { ok: false, errors: problems };
	}
	const hash = shaderCodeHash(doc.code);
	const refused = shaderCodeRefusal(hash);
	if (refused) return standDownCode(key, hash, refused);
	// 73 AI9: Quest keeps custom GLSL off until asked; not even the worker test runs (it is a GPU draw too)
	const offHere = deviceRefusal();
	if (offHere) {
		holdShaderCode(hash, offHere);
		return standDownCode(key, hash, offHere.reason);
	}
	const verdict = await probeShaderCode(doc.code);
	// a newer edit overtook the probe, and scheduled its own compile
	const now = shaderGraphOf(key);
	if (!usesShaderCode(now) || shaderCodeHash(now?.code) !== hash) return { ok: true };
	// and the context can go while the probe runs: asked before the wait, the answer is stale
	const lateRefusal = shaderCodeRefusal(hash);
	if (lateRefusal) return standDownCode(key, hash, lateRefusal);
	if (!verdict.ok) {
		// a driver's compile log is a mistake to fix; anything else is this device's verdict
		if (verdict.status !== 'error') return standDownCode(key, hash, verdict.errors[0]);
		setErrors(key, verdict.errors);
		return { ok: false, errors: verdict.errors };
	}
	// 73 AI9: someone else's code runs only on a PASSED worker test; yours (and an exported game's) also
	// on an untestable one, the first-frame box still holding
	const notYours = reachRefusal(hash, verdict.status, exportMode);
	if (notYours) {
		holdShaderCode(hash, notYours);
		return standDownCode(key, hash, notYours.reason);
	}
	releaseHeldShaderCode(hash);
	/** @type {string[]} */
	const errors = [];
	const fields = scanShaderUniforms(now?.code?.vertex, now?.code?.fragment).uniforms;
	const targets = slotTargetsFor(key);
	if (targets.some((t) => t.slot)) slotLayer ??= await loadSlotDrawLayer();
	if (!targets.length && key !== SCENE_GRAPH_KEY) retryMissingTarget(key);
	else missingTries.delete(key);
	for (const target of targets) {
		const { object } = target;
		if (!shaderTargetSupported(object)) {
			errors.push(shaderRefusalReason(object));
			continue;
		}
		const current = installed.get(stateKeyOf(target));
		if (current?.userData?.shaderCodeHash === hash) {
			// the same program: a field moved, which is a value write and never a recompile
			for (const { name, type } of fields)
				if (current.userData.shaderUniforms[name]) current.userData.shaderUniforms[name].value = codeUniformValue(now?.code?.uniforms?.[name], type);
			continue;
		}
		const base = baseFor(target);
		if (!base) continue;
		const material = makeCodeMaterial(now?.code, hash);
		material.side = base.side;
		applyMaterial(target, material);
		watchFirstFrame(material, hash, (reason) => standDownCode(key, hash, reason));
	}
	setErrors(key, errors);
	return { ok: errors.length === 0, errors };
}

let reachWatched = false;
function startCodeGuard() {
	startShaderCodeGuard(() => {
		for (const [key, doc] of Object.entries(get(shaderGraphs))) if (usesShaderCode(doc)) scheduleCompile(key, 0);
	});
	if (reachWatched) return;
	reachWatched = true;
	// 73 AI9: "Turn on custom shaders" on Quest re-runs what it held (the first value is the current one)
	let first = true;
	customShadersOnQuest.subscribe((on) => {
		if (first) return void (first = false);
		if (on) recompileHeld('quest');
	});
}

/** Everything held for `kind` gets another go (the switch, or Run it anyway). @param {'quest'|'foreign'} kind @param {string} [onlyHash] */
function recompileHeld(kind, onlyHash) {
	const held = get(shaderCodeHeld);
	for (const [key, doc] of Object.entries(get(shaderGraphs))) {
		if (!usesShaderCode(doc)) continue;
		const hash = shaderCodeHash(/** @type {any} */ (doc).code);
		if (held[hash]?.kind !== kind || (onlyHash && hash !== onlyHash)) continue;
		releaseHeldShaderCode(hash);
		saidRefusals.delete(hash);
		setErrors(key, []);
		scheduleCompile(key, 0);
	}
	reconcileShaderGraphs();
}

/** 73 AI9: the pane's "Run it anyway" on someone else's shader this device could not test. @param {string} key */
export async function runForeignShaderCodeFor(key) {
	const hash = shaderCodeHash(shaderGraphOf(key)?.code);
	const { markShaderCodeMine } = await import('./shaderCodeReach.js');
	markShaderCodeMine(hash);
	recompileHeld('foreign', hash);
}

/** The panel's Try again. @param {string} key */
export function retryShaderCodeFor(key) {
	const doc = shaderGraphOf(key);
	const hash = shaderCodeHash(doc?.code);
	saidRefusals.delete(hash);
	retryShaderCode(hash);
	setErrors(key, []);
	scheduleCompile(key, 0);
	reconcileShaderGraphs();
}

/**
 * Is this document's GLSL running on this device, for the panel's status line.
 * @param {string} key @returns {'off'|'running'|'waiting'}
 */
export function shaderCodeRunState(key) {
	const doc = shaderGraphOf(key);
	if (!usesShaderCode(doc)) return 'off';
	const hash = shaderCodeHash(doc?.code);
	return slotTargetsFor(key).some((t) => installed.get(stateKeyOf(t))?.userData?.shaderCodeHash === hash) ? 'running' : 'waiting';
}

/** A code material left an object. Its hash stays answerable while another object still runs it. @param {any} material */
function releaseCodeMaterial(material) {
	const hash = material?.userData?.shaderCodeHash;
	if (!hash) return;
	const stillUsed = [...installed.values()].some((m) => m !== material && m?.userData?.shaderCodeHash === hash);
	forgetCodeMaterial(material, stillUsed);
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
		const { uuid } = shaderKeyParts(key);
		const object = uuid ? group.getObjectByProperty('uuid', uuid) : null;
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

/**
 * P5 — THE LOCAL RENDER GATE.
 *
 * THE RULE THIS KEEPS (viewportOverrides states it, and the look plan makes it the
 * answer all three layers must share): an authored layer is SCENE DATA and renders for
 * everyone by DEFAULT. Nobody opts in to seeing the scene. What is local is the right to
 * switch it off HERE — for performance, for comfort, or to see what an object really
 * looks like underneath.
 *
 * Off is a SWAP, never a detach: the documents, the compiled materials and the base
 * materials all stay exactly as they were, so switching back costs no compile and a peer
 * sees nothing at all. Deliberately NOT `scene.overrideMaterial` (which wireframe and the
 * UV checker use): that replaces EVERY material in the scene, and this layer is only the
 * ones a graph drives.
 */
let shadersOn = true;

/** Swap every shader-driven object to (or back from) its own material. @param {boolean} on */
function applyShaderLayer(on) {
	if (on === shadersOn) return;
	shadersOn = on;
	const group = get(objectsGroup);
	if (!group) return;
	group.traverse((/** @type {any} */ node) => {
		const mine = installed.get(node.uuid);
		if (!mine) return;
		const base = baseMaterials.get(node.uuid);
		if (on) node.material = mine;
		else if (base && node.material === mine) node.material = base;
	});
	// 105-slot-shaders: a slot's product is seated / taken off through the draw layer
	for (const [key, target] of slotStates) slotLayer?.setSlotProduct(target.object, target.slot, on ? installed.get(key) : null);
	// THREE trees are not reactive: without the poke the Inspector's material derived and
	// the shader-driven notice both keep showing the state before the switch (26-B: one
	// coalesced poke, which is what every call site in the tree uses now)
	pokeScene();
}

/** Is this viewer rendering shader-driven materials right now? (test/debug seam) */
export function shaderLayerOn() {
	return shadersOn;
}

/** Install the default wiring. Idempotent; call once at boot. */
export function startShaderGraphs() {
	if (!targetsHook) registerShaderTargets(defaultTargetsFor);
	startCodeGuard();
	// subscribed HERE rather than at module level: the callback reads `shadersOn` and
	// `installed`, and a module-level subscribe runs synchronously at eval, where a `let`
	// declared below would TDZ-crash the SSR prerender (the meshEdit lesson)
	viewportOverrides.subscribe(() => applyShaderLayer(renderLayer('shaders')));
	startShaderClock();
	startReconcile();
	// the retry half of golden rule 9: bytes pulled from a peer land as an Explorer item
	// long after the compile that asked for them, and until something re-fills the uniform
	// the object renders untextured with nothing to explain it
	startShaderTextures();
	if (!textureStop) textureStop = registerShaderTextureListener(refillShaderTextures);
}

/** @type {(()=>void)|null} */
let textureStop = null;

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
	pruneSlotStates();
	const all = get(shaderGraphs);
	for (const key of Object.keys(all)) {
		const targets = slotTargetsFor(key);
		if (targets.some((t) => t.object && !targetDriven(t))) scheduleCompile(key, 0);
	}
}

/**
 * Is this target drawing what we compiled for it? A whole object: today's test (a state
 * exists). A slot: the state exists, was compiled from the slot's CURRENT own material (a
 * peer's list message, an undo or a type switch replaces it) and is seated on this very
 * object (a delete + undo brings back a new instance).
 * @param {ShaderTarget} t
 */
function targetDriven(t) {
	const key = stateKeyOf(t);
	if (!t.slot) return installed.has(key);
	const mine = installed.get(key);
	if (!mine || slotStates.get(key)?.object !== t.object) return false;
	if (baseMaterials.get(key) !== ownAt(t.object, t.slot)) return false;
	return !shadersOn || slotLayer?.slotProductOf(t.object, t.slot) === mine;
}

/** @param {string} key @param {ShaderTarget} t */
function stillDrives(key, t) {
	return inScene(t.object) && graphKeyForSlot(t.object.uuid, t.slot) === key && !!ownAt(t.object, /** @type {string} */ (t.slot));
}

/** The slot's own material now (null when the slot is gone). @param {any} object @param {string} slotId */
function ownAt(object, slotId) {
	if (!Array.isArray(object?.material)) return null;
	const i = slotIdsOf(object.material.map(ownOf)).indexOf(slotId);
	return i < 0 ? null : ownOf(object.material[i]);
}

/** Is this node still inside the scene's object tree? @param {any} node */
function inScene(node) {
	const group = get(objectsGroup);
	for (let n = node; n; n = n.parent) if (n === group) return true;
	return false;
}

/**
 * Forget states whose target is gone: a slot removed, the object deleted or turned back
 * into a single material; a whole-object state whose object became a LIST (Add material
 * slot on a shader-driven box) is dropped without writing its old material over the list.
 * The DOCUMENTS stay (undo of a remove finds its shader); only the drawn products go.
 */
function pruneSlotStates() {
	for (const t of [...slotStates.values()]) {
		if (!inScene(t.object) || !ownAt(t.object, /** @type {string} */ (t.slot))) detachTarget(t);
	}
	const group = get(objectsGroup);
	for (const key of [...installed.keys()]) {
		if (key.includes('/')) continue;
		const object = group?.getObjectByProperty?.('uuid', key);
		if (object && Array.isArray(object.material) && !object.material.includes(installed.get(key)))
			detachTarget({ object, slot: null });
	}
}

/**
 * SH6: a module that supplied a backend has been disabled. Every graph naming it now has
 * to compile through something that exists — so recompile them, which falls back to the
 * built-in, and say so ONCE rather than per graph.
 *
 * The document keeps naming the module's backend on purpose: re-enabling the module (or
 * opening the scene on a peer that has it) restores the intended compile without the
 * graph having been rewritten behind the user's back.
 * @param {string} key the full backend key (`mod-<id>-<key>`)
 * @param {string} [label]
 * @returns {Promise<number>} how many graphs fell back
 */
export async function fallBackFromBackend(key, label) {
	const all = get(shaderGraphs);
	const affected = Object.entries(all).filter(([, doc]) => doc?.backend === key);
	if (!affected.length) return 0;
	for (const [graphKey] of affected) scheduleCompile(graphKey, 0);
	const { showToast } = await import('../stores/appStore.js');
	showToast(
		affected.length +
			(affected.length === 1 ? ' shader graph uses' : ' shader graphs use') +
			' the "' + (label || key) + '" backend, which is no longer loaded — using the built-in compiler instead.'
	);
	return affected.length;
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
	return (sessionNow() % 86400000) / 1000;
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

/**
 * @param {string} uuid @param {string | null} [slotId] 105-slot-shaders: one slot's own material
 * @returns {any}
 */
export function baseMaterialOf(uuid, slotId) {
	return baseMaterials.get(slotShaderKey(uuid, slotId)) ?? null;
}

/**
 * The material a target compiles FROM: a whole object's captured original (today), or the
 * slot's own material as it is NOW (the draw layer keeps the own material the truth, so
 * there is nothing to capture; a later replacement of it recompiles through the reconcile).
 * @param {ShaderTarget} t @returns {any}
 */
function baseFor(t) {
	if (!t.slot) return captureBase(t.object);
	const own = ownAt(t.object, t.slot);
	if (own) baseMaterials.set(stateKeyOf(t), own);
	return own;
}

/** @param {ShaderTarget} target @param {any} material */
function applyMaterial(target, material) {
	if (target.slot) return applySlotMaterial(target, material);
	const object = target.object;
	const previous = installed.get(object.uuid);
	installed.set(object.uuid, material);
	// a slot-list commit on this object reads its own material through this (slotDraw.listOwnOf)
	const base = baseMaterials.get(object.uuid);
	if (base) wholeShaderBase.set(material, base);
	if (previous?.userData?.shaderCodeHash && previous !== material) {
		releaseCodeMaterial(previous);
		previous.dispose?.();
	}
	// P5: with the layer switched off on THIS device the compile still runs and the
	// result is still remembered — only the assignment waits. So switching back on is a
	// swap rather than a recompile, and a peer's authored material is never lost here.
	if (!shadersOn) return;
	object.material = material;
	// THREE trees are NOT reactive, so nothing observing the scene can see this: the
	// Inspector's `material` derived and its shader-driven notice both read through
	// `objectsGroup`, and without the poke they keep showing the pre-shader state. Safe
	// from the reconcile's own subscriber because a compile always runs off a timer.
	pokeScene();
}

/** 105-slot-shaders: seat a compiled material in ONE slot (the draw layer). @param {ShaderTarget} target @param {any} material */
function applySlotMaterial(target, material) {
	const key = stateKeyOf(target);
	const previous = installed.get(key);
	const before = slotStates.get(key);
	// the same uuid on a NEW object instance (delete + undo): the old one's product goes first
	if (before && before.object !== target.object) slotLayer?.setSlotProduct(before.object, before.slot, null);
	installed.set(key, material);
	slotStates.set(key, { object: target.object, slot: target.slot });
	if (previous && previous !== material) {
		if (previous.userData?.shaderCodeHash) releaseCodeMaterial(previous);
		previous.dispose?.();
	}
	if (!shadersOn) return;
	slotLayer?.setSlotProduct(target.object, target.slot, material);
	pokeScene();
}

// ---- texture uniforms ------------------------------------------------------------
//
// A sampler's uniform value starts NULL and is filled in once the bytes resolve: three
// cannot upload a content hash, and a graph may legitimately name an image this peer has
// never seen (a late joiner, a restored save). null is safe — three substitutes its own
// empty texture — so the object renders untextured for exactly as long as the pull takes.

/**
 * Fill every sampler uniform of an installed material from its hash. Synchronous when the
 * texture is already resolved (the common case), otherwise it lands in the `.then`, and
 * `registerShaderTextureListener` covers the bytes arriving from a peer much later.
 * @param {any} material
 */
function fillTextureUniforms(material) {
	const refs = material?.userData?.shaderTextureRefs ?? [];
	for (const ref of refs) {
		const slot =
			material?.userData?.shaderUniforms?.[ref.name] ?? material?.uniforms?.[ref.name] ?? null;
		if (!slot) continue;
		if (!ref.hash) {
			slot.value = null;
			continue;
		}
		const hit = shaderTextureFor(ref.hash);
		if (hit) {
			slot.value = hit;
			continue;
		}
		// not resolved yet: hold a neutral WHITE placeholder rather than null, or the object
		// renders black for the whole duration of the assetShare pull (see the function)
		slot.value = shaderPlaceholderTexture();
		// writing the slot late is safe even if a recompile replaced this material while we
		// waited: the slot belongs to that material's own uniform record, so an orphaned
		// one is simply never read again
		void resolveShaderTexture(ref.hash).then((texture) => {
			if (texture) slot.value = texture;
		});
	}
}

/** Re-fill every installed material — the retry when a pulled texture finally lands. */
export function refillShaderTextures() {
	for (const material of installed.values()) fillTextureUniforms(material);
}

/**
 * Put an object back on its own material and forget our state for it. Undo of an attach
 * and an explicit Detach both land here. 105-slot-shaders: `slotId` = that one slot only;
 * absent = the whole object and every slot of it.
 * @param {any} object @param {string | null} [slotId]
 */
export function detachFrom(object, slotId) {
	if (!object) return;
	if (slotId) return detachTarget({ object, slot: slotId });
	for (const [key, t] of [...slotStates]) if (t.object === object || key.startsWith(object.uuid + '/')) detachTarget(t);
	if (!installed.has(object.uuid) && Array.isArray(object.material)) return;
	detachTarget({ object, slot: null });
}

/** @param {ShaderTarget} target */
function detachTarget(target) {
	const object = target.object;
	if (!object) return;
	if (target.slot) {
		const key = stateKeyOf(target);
		const mine = installed.get(key);
		const holder = slotStates.get(key)?.object ?? object;
		baseMaterials.delete(key);
		installed.delete(key);
		slotStates.delete(key);
		slotLayer?.setSlotProduct(holder, target.slot, null);
		releaseCodeMaterial(mine);
		forgetShaderContext(holder, target.slot);
		if (mine && typeof mine.dispose === 'function') mine.dispose();
		pokeScene();
		return;
	}
	const base = baseMaterials.get(object.uuid);
	const mine = installed.get(object.uuid);
	// never over a material LIST that replaced the object's one material (Add slot)
	if (base && !Array.isArray(object.material)) object.material = base;
	baseMaterials.delete(object.uuid);
	installed.delete(object.uuid);
	releaseCodeMaterial(mine);
	forgetShaderContext(object);
	// dispose only what WE made, never the base (the onionSkin rule)
	if (mine && mine !== base && typeof mine.dispose === 'function') mine.dispose();
	// and poke, for the same reason the install does — otherwise the Inspector keeps
	// offering Detach for an object that is no longer shader-driven
	pokeScene();
}

/**
 * Is this object currently shader-driven? 105-slot-shaders: `slotId` asks about one slot
 * (a single-material object's one slot = the object); absent = any part of the object.
 * @param {string} uuid @param {string | null} [slotId]
 */
export function isShaderDriven(uuid, slotId) {
	if (installed.has(uuid)) return true;
	if (slotId) return installed.has(uuid + '/' + slotId);
	if (!slotStates.size) return false;
	for (const key of slotStates.keys()) if (key.startsWith(uuid + '/')) return true;
	return false;
}

/** 105-slot-shaders: how many of an object's slots are driven right now. @param {string} uuid */
export function drivenSlotCount(uuid) {
	let n = 0;
	for (const key of slotStates.keys()) if (key.startsWith(uuid + '/')) n++;
	return n;
}

/**
 * #20 P1 (duplicate parity): give `to` its OWN copy of `from`'s shader graph.
 *
 * Without this a duplicate keeps `detachMaterials`' clone of the COMPILED
 * ShaderMaterial and no document — so the copy renders frozen (nothing ticks its
 * uniforms) and the Inspector offers it no graph to edit. The same gap the clips
 * and the flow graph had, found after the shader lane merged.
 *
 * Writes through the ONE path with `silent` (no history — the object's own create
 * entry owns the copy's lifecycle, exactly as `copyAnimationsTo` argues) and then
 * broadcasts by hand, because `silent` suppresses both. `scheduleCompile` runs
 * either way, which is what installs the material on the clone.
 * @param {string} fromUuid @param {string} toUuid
 * @returns {boolean} true when a graph was copied
 */
export function copyShaderGraphTo(fromUuid, toUuid) {
	if (!fromUuid || fromUuid === toUuid) return false;
	const all = get(shaderGraphs);
	// only an OWN graph is copied: an object inheriting the scene default already
	// inherits it as the clone too, and copying would pin a private snapshot of it.
	// 105-slot-shaders: and its slot documents (a duplicate keeps its slot ids)
	return copyShaderGraphsOf(all, fromUuid, toUuid) > 0;
}

/**
 * Every document an object OWNS in `map` (its object key and each slot key), copied onto
 * `toUuid` under the same slot ids — duplicate, merge import and prefab all re-key this
 * way, and all three keep a slot's id (it rides the material).
 * @param {Record<string, any> | null | undefined} map @param {string} fromUuid @param {string} toUuid
 * @returns {number} documents installed
 */
export function copyShaderGraphsOf(map, fromUuid, toUuid) {
	if (!map || !fromUuid || !toUuid) return 0;
	let n = 0;
	for (const [key, doc] of Object.entries(map)) {
		const { uuid, slot } = shaderKeyParts(key);
		if (uuid === fromUuid && copyShaderGraphFrom(doc, slotShaderKey(toUuid, slot))) n++;
	}
	return n;
}

/**
 * A6.3: the same install, from a DOCUMENT rather than from the live store — what a
 * MERGE import needs, because `importObjects` re-uuids every object it parses and
 * the payload's shader graphs are keyed by the OLD uuids, so an imported object
 * arrived on its plain material with the graph stranded in the file.
 * @param {any} doc a shader-graph document @param {string} toUuid
 * @returns {boolean} true when a graph was installed
 */
export function copyShaderGraphFrom(doc, toUuid) {
	if (!doc || !toUuid || toUuid === SCENE_GRAPH_KEY) return false;
	if (get(shaderGraphs)[toUuid]) return false; // never clobber an existing one
	const copy = structuredClone(normalizeShaderGraph(doc));
	const after = setShaderGraphFor(toUuid, copy, { silent: true });
	if (after && broadcastHook) broadcastHook(toUuid, /** @type {any} */ (after));
	return !!after;
}

/**
 * Does this object have (or inherit) a graph AT ALL? `isShaderDriven` answers "is a
 * compiled material installed right now", which is false for a graph whose compile has
 * not run yet — so the Inspector needs this one to decide what to OFFER.
 * 105-slot-shaders: `slotId` = that slot's resolution (its own key -> the object's -> the scene's).
 * @param {string} uuid @param {string | null} [slotId] @returns {boolean}
 */
export function hasShaderGraph(uuid, slotId) {
	return !!(slotId ? graphKeyForSlot(uuid, slotId) : graphKeyFor(uuid));
}

/**
 * 105-slot-shaders: move a document between an object's two keys ("Only this slot" / "All
 * slots") as ONE undo step (shaderSync registers the move; without it, two plain writes).
 * @param {string} fromKey @param {string} toKey @returns {boolean}
 */
export function moveShaderGraph(fromKey, toKey) {
	const doc = shaderGraphOf(fromKey);
	if (!doc || fromKey === toKey || get(shaderGraphs)[toKey]) return false;
	if (moveHook) return moveHook(fromKey, toKey, doc);
	setShaderGraphFor(toKey, structuredClone(doc));
	setShaderGraphFor(fromKey, null);
	return true;
}

/** @type {((fromKey: string, toKey: string, doc: any) => boolean) | null} */
let moveHook = null;
/** shaderSync installs the one-undo-step move. @param {(fromKey: string, toKey: string, doc: any) => boolean} fn */
export function registerShaderMove(fn) {
	moveHook = fn;
	return () => {
		if (moveHook === fn) moveHook = null;
	};
}

/**
 * Show the Shader editor (and bring its dock tab to the front). The seam the Inspector's
 * "Open in Shader editor" button and the object context menu both go through, so there is
 * one definition of what that means.
 *
 * Both imports are DYNAMIC: this module is reached from the compile/persist path, and a
 * static edge into appStore/bottomDock from here would put UI chrome inside the graph
 * store's import subtree for no gain.
 * @returns {Promise<void>}
 */
export async function openShaderEditor() {
	const [appStore, dock] = await Promise.all([
		import('../stores/appStore.js'),
		import('./bottomDock.js')
	]);
	appStore.shaderEditorClose.set(false);
	dock.activateDock('shader');
}

/**
 * The live uniform record for a graph's param — how the editor writes a value with NO
 * recompile (SH0.5 measured 0 ms). Returns null when the graph is not installed.
 * 105-slot-shaders: `slotId` = that slot's; absent = the whole object's, else the first
 * driven slot that has it.
 * @param {string} uuid @param {string} uniformName @param {string | null} [slotId]
 */
export function shaderUniform(uuid, uniformName, slotId) {
	if (slotId) return uniformOf(installed.get(uuid + '/' + slotId), uniformName) ?? uniformOf(installed.get(uuid), uniformName);
	const whole = uniformOf(installed.get(uuid), uniformName);
	if (whole || !slotStates.size) return whole;
	return shaderUniformsOf(uuid, uniformName)[0] ?? null;
}

/** @param {any} material @param {string} name */
function uniformOf(material, name) {
	return material?.userData?.shaderUniforms?.[name] ?? material?.uniforms?.[name] ?? null;
}

/**
 * 105-slot-shaders: the live uniform record of EVERY driven part of an object that has
 * the uniform (the whole object, or each slot) — the `setuniform` node with no slot.
 * @param {string} uuid @param {string} uniformName @returns {any[]}
 */
export function shaderUniformsOf(uuid, uniformName) {
	/** @type {any[]} */
	const out = [];
	const whole = uniformOf(installed.get(uuid), uniformName);
	if (whole) out.push(whole);
	for (const key of slotStates.keys()) {
		if (!key.startsWith(uuid + '/')) continue;
		const record = uniformOf(installed.get(key), uniformName);
		if (record) out.push(record);
	}
	return out;
}

/**
 * 105-slot-shaders: a slot reference (index, id or name) -> its id on this object, or null.
 * @param {any} object @param {number | string | null | undefined} ref
 */
export function slotIdFor(object, ref) {
	if (ref === null || ref === undefined || ref === '') return null;
	const ids = slotIdsOfObject(object);
	if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return ids[Number(ref)] ?? null;
	const text = String(ref);
	if (ids.includes(text)) return text;
	const byName = ownMaterialsOf(object).findIndex((m) => m?.name === text);
	return byName >= 0 ? (ids[byName] ?? null) : null;
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

// ---- persistence (plan SH4) -----------------------------------------------------
//
// A compiled material survives NONE of the four save paths, and each loses it
// differently: the wire and autosave go through GLTF (which cannot carry a custom
// shader at all), sessions/.tpscene go through toJSON (which would serialize our
// injected material as if it were the object's own), and undo snapshots the tree. So
// every serializer must read the BASE material, and the GRAPH rides beside the
// snapshot — the `animated` / `multiMaterial` shape, keyed by uuid.
//
// P6 — THE SAVE-PATH AUDIT, done once across the three layers now that they meet.
// Every one of them is a KEYED DOCUMENT plus a runtime product, and the rule that
// falls out is the same each time: SAVE THE DOCUMENT, never the product.
//
//   layer 3 / 2  shaderGraphs[uuid | 'scene']  product: a compiled Material
//   layer 1      shaderGraphs['post:<id>']     product: a compiled Effect
//   layer 1      postStacks['scene' | camUuid] product: composer passes
//
// Carriers, checked for each: the WIRE (`shadergraph` / `scenepost`, both
// latest-wins on a stamp), AUTOSAVE and SESSIONS/.tpscene (`shaderGraphsSnapshot` +
// `scenePostSnapshot`, both beside the objects rather than inside them), and UNDO
// (the `'shadergraph'` and `'look'` history kinds). The PRODUCTS are carried by
// nobody, deliberately — they are rebuilt from the document on the other side.
//
// The ritual `parkShaderMaterials` performs is only needed where a product is ATTACHED
// TO THE SCENE TREE, which is layers 2 and 3 alone: a post Effect lives in the
// composer, which no serializer walks, so P4 needed no fourth park. The one thing a
// reader should not expect to find is a park for post graphs; this paragraph is why.
//
// KNOWN AND ACCEPTED: `shaderGraphsSnapshot()` writes `{}` into every save even when
// nothing uses it (SH4's shape), where the post stack writes `null`. Harmless and
// pre-existing; changing it is a save-format decision, not a rendering one.

/** parks nest (a serializer inside a serializer), so this is a DEPTH, not a flag */
let materialParkDepth = 0;

/** Is a serializer currently reading the scene without our materials? */
export function shaderMaterialsParked() {
	return materialParkDepth > 0;
}

/**
 * Swap every shader-driven object back to its OWN material for the duration of a
 * serialize, and return an idempotent restore. Hooked into `parkAnimatedAtBase`, the
 * ritual every serializer already performs (the editOverlays precedent) — so the wire,
 * autosave, sessions, .tpscene and the GLTF export are all covered by one call.
 * Never disposes: the same material goes back on the same mesh afterwards.
 * @returns {() => void}
 */
export function parkShaderMaterials() {
	/** @type {{object: any, mine: any}[]} */
	const parked = [];
	const group = get(objectsGroup);
	if (group)
		group.traverse((/** @type {any} */ node) => {
			const mine = installed.get(node.uuid);
			if (mine && node.material === mine) {
				const base = baseMaterials.get(node.uuid);
				if (base) {
					node.material = base;
					parked.push({ object: node, mine });
				}
			}
		});
	materialParkDepth++;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		materialParkDepth = Math.max(0, materialParkDepth - 1);
		for (const entry of parked) entry.object.material = entry.mine;
	};
}

/**
 * Every graph document, for a save. Orphans (the owner object is gone) are pruned from
 * the OUTPUT only — the live store keeps them, so undoing an object delete finds its
 * shader intact (the `serializeGraphs` reasoning).
 * @param {{pruneMissing?: (uuid: string) => boolean}} [opts]
 * @returns {Record<string, any>}
 */
export function shaderGraphsSnapshot(opts = {}) {
	const all = get(shaderGraphs);
	/** @type {Record<string, any>} */
	const out = {};
	for (const [key, doc] of Object.entries(all)) {
		// 105-slot-shaders: a slot key is an orphan when its object OR its slot is gone
		const { uuid, slot } = shaderKeyParts(key);
		if (key !== SCENE_GRAPH_KEY && opts.pruneMissing?.(slot ? /** @type {string} */ (uuid) : key)) continue;
		if (slot && slotGone(/** @type {string} */ (uuid), slot)) continue;
		out[key] = normalizeShaderGraph(doc);
	}
	return out;
}

/**
 * Reinstate saved documents. Compiling is left to the normal debounce + the
 * objectsGroup reconcile, which is what makes the ORDER not matter: a restore that adds
 * objects after the graphs still lands (SH2's late-joiner fix, reused).
 * @param {Record<string, any>} map @param {boolean} [replace] wipe first (a scene LOAD
 *   replaces the world; an autosave restore merges into it)
 */
export function shaderGraphsRestore(map, replace = false) {
	if (replace) {
		shaderGraphs.set({});
		shaderErrors.set({});
	}
	if (!map || typeof map !== 'object') return;
	for (const [key, doc] of Object.entries(map)) {
		if (!doc) continue;
		// silent: a restore is not an undo step and must not re-broadcast
		setShaderGraphFor(key, normalizeShaderGraph(doc), { silent: true, stamp: sessionNow() });
	}
	reconcileShaderGraphs();
}

/** An object we cannot find is the caller's prune to decide. @param {string} uuid @param {string} slot */
function slotGone(uuid, slot) {
	const object = get(objectsGroup)?.getObjectByProperty?.('uuid', uuid);
	return !!object && !slotIdsOfObject(object).includes(slot);
}

/** How many objects (105-slot-shaders: and slots) are shader-driven right now (the GLTF export warning). */
export function shaderDrivenCount() {
	return installed.size;
}

/** 105-slot-shaders: how many of those are material SLOTS (the export note says so). */
export function shaderDrivenSlotCount() {
	return slotStates.size;
}

/** Test/serializer seam: drop everything (a scene load replaces all documents). */
export function clearShaderGraphs() {
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	shaderGraphs.set({});
	shaderErrors.set({});
	for (const t of slotStates.values()) slotLayer?.setSlotProduct(t.object, t.slot, null);
	slotStates.clear();
	baseMaterials.clear();
	installed.clear();
}
