// P4 — THE POST DOMAIN: a shader graph that is a post-processing effect.
//
// Layer 1 of the look (the plan's three-layer table) has had a stack, a registry and
// twelve built-in kinds since L1-L5; what it has not had is a way to AUTHOR a new kind
// without writing a module. This module is that: a post graph document compiles to a
// fragment function over SCREEN buffers and enters the ordinary scene stack as one more
// entry, so it replicates, saves, undoes, reorders and MERGES with its neighbours with
// nothing new on the wire and no new history kind.
//
// THE DOMAIN SPLIT IS NOT COSMETIC (the parent plan states it as a rule): a post pass
// only has screen buffers, so it can never know an object's material inputs, its UVs or
// its light response; a surface graph only has its own fragment, so it can never see a
// neighbouring pixel. Anything needing both is TWO graphs, deliberately. That is why the
// two domains share the catalog and the editor but have their own terminal node, their
// own compile pass (`compilePostGraphToIR`) and their own backend registry
// (`postBackends`, whose output contract is an `Effect`, not a `Material`).
//
// WHERE THE DOCUMENT LIVES: `shaderGraphs`, keyed `'post:<id>'` — the prefix SH1 reserved
// for exactly this. So replication (`shadergraph`), the `'shadergraph'` history kind, the
// four save paths and the editor's document handling are all inherited rather than
// rebuilt; nothing in shaderSync, sessions or autosave needed a line for this batch.
//
// THE ONE THING THAT IS NEW is the bridge: a post effect KIND named `graph` whose
// `params.graph` names the document. `scenePost` stays a pure leaf (it never learns what
// a shader graph is) and this module never touches the composer — Outline reads
// `tpNeedsNormals` off the compiled effect and adds a NormalPass when one asks for it.

import { get, writable } from 'svelte/store';
import {
	shaderGraphs,
	shaderErrors,
	shaderGraphOf,
	setShaderGraphFor,
	shaderClockNow,
	openShaderEditor,
	registerPostDomain
} from './shaderGraph.js';
import { compilePostGraphToIR } from './shaderCompile.js';
import { postBackend, ensurePostBackends, DEFAULT_POST_BACKEND } from './postBackends.js';
import {
	registerPostEffect,
	addPostEffect,
	setPostEffectParams,
	postStacks,
	POST_SCENE_KEY
} from './scenePost.js';
import { POST_PRESETS, postPreset, emptyPostGraph } from './postGraphPresets.js';

/** The reserved key prefix (SH1 declared it; this is its first consumer). */
export const POST_GRAPH_PREFIX = 'post:';

/** @param {string} key @returns {boolean} */
export function isPostGraphKey(key) {
	return typeof key === 'string' && key.startsWith(POST_GRAPH_PREFIX);
}

/** Every post graph document, newest last. @returns {{key: string, name: string}[]} */
export function postGraphKeys() {
	return Object.keys(get(shaderGraphs))
		.filter(isPostGraphKey)
		.map((key) => ({ key, name: postGraphName(key) }));
}

/** The display name: the document's own, else the id after the prefix. @param {string} key */
export function postGraphName(key) {
	const doc = /** @type {any} */ (shaderGraphOf(key));
	return doc?.name || key.slice(POST_GRAPH_PREFIX.length);
}

// ---- the editor's view of the domain ------------------------------------------------
// Which half of the editor you are looking at is a LOCAL pref, like every other editor
// setting — but it lives HERE rather than inside the component because the entry points
// that need to write it (a stack row's Edit button, the add menu's "new preset") are not
// the component. `activePostGraph` is the scope in the post half: the surface half takes
// its scope from the SELECTION and has nothing to choose, while a post graph belongs to
// no object at all, so the post half needs one.

const LS = typeof localStorage !== 'undefined' ? localStorage : null;

/** 'surface' | 'post' — which domain the shader editor is showing.
 * @type {import('svelte/store').Writable<string>} */
export const shaderDomain = writable(LS?.getItem('shaderDomain') === 'post' ? 'post' : 'surface');
shaderDomain.subscribe((value) => {
	try {
		LS?.setItem('shaderDomain', value);
	} catch {
		/* private mode: the pref is a convenience, never a requirement */
	}
});

/** Which post graph the editor is scoped to (null = the first one that exists).
 * @type {import('svelte/store').Writable<string|null>} */
export const activePostGraph = writable(null);

/** Open a post graph in the shader editor — the `openShaderEditor` deep-link shape, with
 * the two things that make the link LAND: the domain and the scope. @param {string} key */
export async function openPostGraph(key) {
	activePostGraph.set(key);
	shaderDomain.set('post');
	await openShaderEditor();
}

let idCounter = 0;
function newKey() {
	return POST_GRAPH_PREFIX + Date.now().toString(36) + (idCounter++).toString(36);
}

/**
 * Create a post graph, optionally from a shipped preset, and hand back its key.
 * @param {{preset?: string, name?: string}} [opts]
 */
export function createPostGraph(opts = {}) {
	const preset = opts.preset ? postPreset(opts.preset) : null;
	const doc = preset ? preset.doc() : emptyPostGraph();
	const key = newKey();
	setShaderGraphFor(key, { ...doc, name: opts.name || preset?.label || 'Post effect' });
	return key;
}

/** Delete the document. Any stack entry naming it keeps its row and renders nothing —
 * the same shape as an unknown kind, and recoverable by pointing the row at another
 * graph. @param {string} key */
export function deletePostGraph(key) {
	if (!isPostGraphKey(key)) return false;
	setShaderGraphFor(key, null);
	return true;
}

/**
 * Create a graph AND put it in a look, which is what every entry point actually wants.
 * @param {{preset?: string, name?: string, docKey?: string}} [opts]
 */
export function addPostGraphToLook(opts = {}) {
	const key = createPostGraph(opts);
	const id = addPostEffect('graph', undefined, opts.docKey || POST_SCENE_KEY);
	setPostGraphEntry(id, key, opts.docKey || POST_SCENE_KEY);
	return { key, id };
}

/** Point an existing stack entry at a graph — through scenePost's own mutator, so the
 * edit records one undo entry and replicates like any other param write.
 * @param {string} id @param {string} key */
export function setPostGraphEntry(id, key, docKey = POST_SCENE_KEY) {
	setPostEffectParams(id, { graph: key }, docKey);
}

// ---- errors ---------------------------------------------------------------------
// Written into `shaderErrors` under the graph's own key, so the editor surfaces a post
// graph's compile errors in exactly the place it surfaces a surface graph's.

/** @param {string} key @param {string[]} errors */
function setErrors(key, errors) {
	shaderErrors.update((map) => {
		const had = map[key] ?? [];
		if (had.length === errors.length && had.every((e, i) => e === errors[i])) return map;
		return { ...map, [key]: errors };
	});
}

// ---- the compiled effects ---------------------------------------------------------

/** graphKey -> the live Effect the composer currently holds. @type {Map<string, any>} */
const live = new Map();

/** graphKey -> an Effect a slow (async) backend produced after `make` had to return.
 * @type {Map<string, any>} */
const resolved = new Map();

/** graphKey -> the fragment text the live effect was built from. @type {Map<string, string>} */
const builtFrom = new Map();

/**
 * The structural signature of a graph: its compiled FRAGMENT.
 *
 * This is what `scenePost.postStackSignature` folds in, and the choice matters. Folding
 * the document's `changedAt` would rebuild the whole composer chain on every scrub of
 * every param; folding the fragment rebuilds only when the SHADER SOURCE changes, and a
 * uniform-backed param (every number in a preset) changes values without changing a
 * character of it — those are written straight into the live effect below instead.
 * @param {Record<string, any>} params
 */
function signature(params) {
	const key = params?.graph;
	if (!isPostGraphKey(key)) return '';
	const doc = shaderGraphOf(key);
	if (!doc) return 'missing';
	const result = compilePostGraphToIR(doc);
	return result.ok ? /** @type {any} */ (result.ir).fragment : 'error';
}

/**
 * Build the Effect for one stack entry. SYNCHRONOUS, because `compilePostStack` is —
 * the built-in `inject` backend compiles synchronously, and a module backend that does
 * not gets one frame of nothing plus a poke (below), which is the same contract
 * `shaderTextures` gives a texture that has not arrived.
 * @param {Record<string, any>} params @param {any} ctx
 */
function make(params, ctx) {
	ensurePostBackends();
	const key = params?.graph;
	if (!isPostGraphKey(key)) return null;
	const doc = /** @type {any} */ (shaderGraphOf(key));
	if (!doc) return null;
	const result = compilePostGraphToIR(doc);
	if (!result.ok) {
		setErrors(key, result.errors ?? ['This post graph does not compile.']);
		return null;
	}
	setErrors(key, []);
	const ir = /** @type {any} */ (result.ir);
	/** @type {Record<string, any>} */
	const uniforms = {};
	for (const uniform of ir.uniforms) uniforms[uniform.name] = { value: uniform.value };
	// the normal buffer is OURS to declare but the composer's to fill: Outline owns the
	// single NormalPass and assigns its texture to every effect that asked for one
	if (ir.readsNormals) uniforms.normalBuffer = { value: null };
	const spec = {
		name: 'PostGraph_' + key.replace(/[^A-Za-z0-9_]/g, '_'),
		fragment: ir.fragment,
		uniforms,
		readsDepth: ir.readsDepth,
		// SET, not NORMAL: a post graph writes the finished pixel (its own Scene colour
		// node is how it keeps any of the frame), so blending it over the input again
		// would halve every effect and make "replace the picture" unauthorable
		blend: 'SET'
	};
	const backendKey = doc.backend && postBackend(doc.backend) ? doc.backend : DEFAULT_POST_BACKEND;
	const waiting = resolved.get(key);
	if (waiting && builtFrom.get(key) === ir.fragment) {
		// an async backend finished after the previous rebuild asked for it
		resolved.delete(key);
		return adopt(key, waiting, ir);
	}
	let out = null;
	try {
		out = /** @type {any} */ (postBackend(backendKey))?.compile(spec, ctx) ?? null;
	} catch (error) {
		setErrors(key, [String(/** @type {any} */ (error)?.message ?? error)]);
		return null;
	}
	if (out && typeof out.then === 'function') {
		builtFrom.set(key, ir.fragment);
		out.then((/** @type {any} */ effect) => {
			resolved.set(key, effect);
			// a stamp-free poke, so the chain rebuilds and picks it up without reading as
			// an edit (the registerPostEffect precedent one module over)
			postStacks.update((map) => ({ ...map }));
		}).catch(() => {});
		return null;
	}
	return adopt(key, out, ir);
}

/** @param {string} key @param {any} effect @param {any} ir */
function adopt(key, effect, ir) {
	if (!effect) return null;
	effect.tpGraphKey = key;
	effect.tpNeedsNormals = !!ir.readsNormals;
	effect.tpUsesClock = !!ir.usesClock;
	live.set(key, effect);
	builtFrom.set(key, ir.fragment);
	return effect;
}

/** Per-frame: the SHARED clock, so an animated post effect is at the same point on every
 * peer with no message at all (the Time node's whole contract). @param {any} effect */
function tick(effect) {
	if (!effect?.tpUsesClock) return;
	const slot = effect.uniforms?.get?.('uShaderTime');
	if (slot) slot.value = shaderClockNow();
}

/** @param {any} effect */
function dispose(effect) {
	if (effect?.tpGraphKey && live.get(effect.tpGraphKey) === effect) {
		live.delete(effect.tpGraphKey);
		builtFrom.delete(effect.tpGraphKey);
	}
	effect?.dispose?.();
}

/** Every live effect that wants the normal buffer, for Outline's single NormalPass. */
export function effectsNeedingNormals() {
	return [...live.values()].filter((effect) => effect.tpNeedsNormals);
}

// ---- live param writes -------------------------------------------------------------

/**
 * A graph edit that did NOT change the shader source is a value change: write it into the
 * live effect and leave the composer alone. Without this, every scrub of every number in
 * a post graph would tear down and rebuild the whole chain — and WITH it, a structural
 * edit still rebuilds, because the signature above is the fragment text.
 * @param {string} key
 */
function refreshUniforms(key) {
	const effect = live.get(key);
	if (!effect) return false;
	const doc = shaderGraphOf(key);
	if (!doc) return false;
	const result = compilePostGraphToIR(doc);
	if (!result.ok) return false;
	const ir = /** @type {any} */ (result.ir);
	if (ir.fragment !== builtFrom.get(key)) return false; // structural: let the rebuild run
	for (const uniform of ir.uniforms) {
		const slot = effect.uniforms?.get?.(uniform.name);
		if (slot && uniform.value !== undefined && !uniform.clock) slot.value = uniform.value;
	}
	return true;
}

// ---- wiring -------------------------------------------------------------------------

let started = false;

/** Idempotent; called at module load and safe to call again from a test. */
export function startPostGraphs() {
	if (started) return;
	started = true;
	ensurePostBackends();
	registerPostEffect('graph', {
		label: 'Shader graph',
		group: 'graph',
		params: [
			{
				key: 'graph',
				label: 'Graph',
				// a TYPE of its own: the choices are the post graphs that exist right now, and
				// the row needs a way into the editor beside them, which no generic param
				// renderer can offer
				type: 'graph',
				default: '',
				hint: 'Which post graph this entry runs.'
			}
		],
		make,
		signature,
		tick,
		dispose
	});
	// THE COMPILE BRANCH. shaderGraph's own compile path is about MATERIALS, and a post
	// document has no Surface node — left alone it would set "The graph has no Surface
	// output node" on every post graph and try to install a material on a target that
	// does not exist. The seam is a registration rather than an import so shaderGraph
	// keeps no edge into this module.
	registerPostDomain((key) => {
		const doc = shaderGraphOf(key);
		if (!doc) {
			setErrors(key, []);
			live.delete(key);
			builtFrom.delete(key);
			postStacks.update((map) => ({ ...map }));
			return { ok: true };
		}
		const result = compilePostGraphToIR(doc);
		setErrors(key, result.ok ? [] : (result.errors ?? []));
		// a value-only edit writes the uniforms and stops; a structural one pokes the
		// stack so Outline's signature compare notices and rebuilds the chain
		if (!refreshUniforms(key)) postStacks.update((map) => ({ ...map }));
		return { ok: result.ok, errors: result.errors };
	});
}

startPostGraphs();

/** The shipped presets, for a menu. */
export function postPresets() {
	return POST_PRESETS.map((preset) => ({ key: preset.key, label: preset.label, hint: preset.hint }));
}

/** test/debug view */
export function postGraphsDebug() {
	return {
		graphs: postGraphKeys(),
		live: [...live.keys()],
		needsNormals: effectsNeedingNormals().length,
		errors: get(shaderErrors)
	};
}
