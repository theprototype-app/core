// Post BACKEND registry (#20 P6; post plan P3 + the layer-1 seam it still needed).
//
// A backend turns a post SHADER DESCRIPTION into a postprocessing `Effect`. That output
// contract is the whole reason this is NOT `shaderBackends.js`: a shader backend returns
// a MATERIAL, which is a different object with a different lifecycle, a different
// disposal story and a different place in the frame. Collapsing the two would make the
// difference invisible at the one place it matters — the compile call — so they stay
// separate registries with the same SHAPE (a plain map, async-tolerant, the caller
// installs the result), which is what makes both hot-loadable from a module.
//
// This module imports NOTHING of ours and only `postprocessing` for its built-in, so it
// stays a leaf: reachable from the SDK without dragging the scene, the wire or history
// behind it.
//
// THE FALLBACK LIVES HERE, NOT IN THE DISABLE PATH. This is the lesson the shader lane
// paid for and it transfers verbatim: a module being disabled is not the only way to
// reach an unknown backend key. A peer who never installed the module at all receives a
// document naming it, and so does a scene loaded from a file next year. Refusing to
// compile there leaves that peer looking at a broken chain it cannot act on, so an
// unknown key falls back to the built-in and the DOCUMENT keeps the original key — the
// intended compile returns the moment the module does.

import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

/**
 * @typedef {object} PostShaderSpec
 * @property {string} [name] for the generated Effect (and any compile error)
 * @property {string} fragment the body of `mainImage`, or a full mainImage function —
 *   GLSL, with `inputColor`, `uv` and `outputColor` in scope
 * @property {Record<string, any>} [uniforms] name -> initial value
 * @property {boolean} [readsDepth] declares EffectAttribute.DEPTH, which is what makes
 *   `depth` available and tells the composer this effect needs the depth buffer
 * @property {string} [blend] a BlendFunction name, default NORMAL
 */

/**
 * @typedef {object} PostCompileCtx
 * @property {any} scene
 * @property {any} camera
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [dpr]
 */

/**
 * @typedef {object} PostBackend
 * @property {string} key
 * @property {string} label
 * @property {(spec: PostShaderSpec, ctx: PostCompileCtx) => Promise<any>|any} compile
 */

/** @type {Map<string, PostBackend>} */
const backends = new Map();

/** The built-in, and the fallback every unknown key resolves to. */
export const DEFAULT_POST_BACKEND = 'inject';

/**
 * Register a compile backend. Returns a disposer so a module's teardown JOURNAL can
 * remove it again — the makeApi contract: every register* records its disposal in the
 * same edit, which is what makes install / update / disable / dev-reload live.
 * @param {string} key
 * @param {string} label
 * @param {(spec: PostShaderSpec, ctx: PostCompileCtx) => Promise<any>|any} compile
 * @returns {() => void}
 */
export function registerPostBackend(key, label, compile) {
	backends.set(key, { key, label, compile });
	return () => {
		if (backends.get(key)?.compile === compile) backends.delete(key);
	};
}

/** Every registered backend, for a picker. @returns {PostBackend[]} */
export function postBackendList() {
	return [...backends.values()].map((entry) => ({ ...entry }));
}

/** @param {string} key */
export function postBackend(key) {
	return backends.get(key);
}

/** Wrap a bare mainImage BODY in the function postprocessing expects, and leave a
 * fragment that already declares it alone. @param {string} fragment */
function asMainImage(fragment) {
	const src = String(fragment ?? '').trim();
	if (!src) return 'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = inputColor; }';
	if (/\bmainImage\s*\(/.test(src)) return src;
	return (
		'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {\n' +
		src +
		'\n}'
	);
}

/** postprocessing wants a Map of THREE.Uniform-alikes; a plain object is friendlier to
 * author with, so convert. @param {Record<string, any>} uniforms */
function asUniformMap(uniforms) {
	const map = new Map();
	for (const [name, value] of Object.entries(uniforms ?? {})) {
		// a bare value is wrapped; something already uniform-shaped is passed through
		map.set(name, value && typeof value === 'object' && 'value' in value ? value : { value });
	}
	return map;
}

let injectRegistered = false;

/** The built-in backend: a GLSL fragment straight into a postprocessing Effect. It is
 * deliberately thin — it is the FLOOR, so it must never be the thing that fails. */
function ensureInjectBackend() {
	if (injectRegistered) return;
	injectRegistered = true;
	registerPostBackend('inject', 'GLSL (built-in)', (spec) => {
		const blendName = typeof spec?.blend === 'string' ? spec.blend : 'NORMAL';
		/** @type {any} */
		const blendTable = BlendFunction;
		return new Effect(spec?.name || 'CustomPostEffect', asMainImage(spec?.fragment), {
			blendFunction: blendTable[blendName] ?? BlendFunction.NORMAL,
			uniforms: asUniformMap(spec?.uniforms ?? {}),
			// declaring DEPTH is what makes the depth buffer reach the shader; getting it
			// wrong is SILENT (the sampler is simply never filled), which is the shader
			// lane's "a stage-specific value that exists in the other stage fails
			// silently" trap in its post-domain form
			attributes: spec?.readsDepth ? EffectAttribute.DEPTH : EffectAttribute.NONE
		});
	});
}

/**
 * Compile one post shader through a backend. AWAIT this — a backend may be async, and
 * the uvUnwrap lesson is that a sync caller commits the Promise as if it were the
 * result, which surfaces as a corrupt effect rather than as an error.
 *
 * Returns `{ effect, backend, fellBackFrom }`: `fellBackFrom` names the key that was
 * asked for when the fallback ran, so the caller can SAY so (a silent substitution is
 * how a user ends up debugging the wrong thing) without the document being rewritten.
 * @param {PostShaderSpec} spec
 * @param {PostCompileCtx} ctx
 * @param {string} [key]
 * @returns {Promise<{effect: any, backend: string, fellBackFrom: string|null}>}
 */
export async function compilePostShader(spec, ctx, key = DEFAULT_POST_BACKEND) {
	ensureInjectBackend();
	let backend = backends.get(key);
	/** @type {string|null} */
	let fellBackFrom = null;
	if (!backend) {
		backend = backends.get(DEFAULT_POST_BACKEND);
		if (!backend) throw new Error('No post backend registered for "' + key + '"');
		fellBackFrom = key;
	}
	const effect = await backend.compile(spec, ctx);
	return { effect, backend: backend.key, fellBackFrom };
}

/** Make the built-in available without compiling anything (a picker at boot). */
export function ensurePostBackends() {
	ensureInjectBackend();
	return postBackendList();
}
