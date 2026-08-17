// Shader BACKEND registry (plan SH0/SH6, cloud plans-core/pending/shader-graph-editor.md).
//
// A backend turns a shader GRAPH into a three material. This is the uvUnwrap
// `registerUnwrapBackend` shape on purpose: the registry is a plain map, backends
// may be ASYNC, and the CALLER installs the result — so a hot-loadable module can
// add a heavier compiler (or replace a built-in) without core carrying its wasm.
//
// Nothing here reaches the scene, the wire or history: a backend compiles, and the
// layer above decides what to do with the material. That is what keeps the whole
// module a leaf (it imports NOTHING of ours) and testable on its own.
//
// The built-in `shaderfrog` backend loads @shaderfrog/core + @shaderfrog/glsl-parser
// through a DYNAMIC import, so ~1 MB of GLSL compiler stays out of the boot path and
// lands in its own chunk. Never import them statically from here.

/**
 * @typedef {object} ShaderCompileCtx
 * @property {any} object   the mesh the material is destined for (its geometry and
 *   the light set in `scene` shape the generated shader — see the note below)
 * @property {any} scene
 * @property {any} camera
 * @property {any} renderer
 * @property {any} [baseMaterial] the object's ORIGINAL material, when the caller holds
 *   it (the inject backend derives from it; absent = take `object.material`)
 */

/**
 * @typedef {object} ShaderBackend
 * @property {string} key
 * @property {string} label
 * @property {(graph:any, ctx:ShaderCompileCtx) => Promise<any>} compile
 */

/** @type {Map<string, ShaderBackend>} */
const backends = new Map();

/**
 * Register a compile backend. Returns a disposer so a module's teardown JOURNAL can
 * remove it again (the makeApi contract: every register* records its disposal).
 * @param {string} key
 * @param {string} label
 * @param {(graph:any, ctx:ShaderCompileCtx) => Promise<any>} compile
 * @returns {() => void}
 */
export function registerShaderBackend(key, label, compile) {
	backends.set(key, { key, label, compile });
	return () => {
		if (backends.get(key)?.compile === compile) backends.delete(key);
	};
}

/** Every registered backend, for a picker. @returns {ShaderBackend[]} */
export function shaderBackendList() {
	return [...backends.values()].map((entry) => ({ ...entry }));
}

/** @param {string} key @returns {ShaderBackend|undefined} */
export function shaderBackend(key) {
	return backends.get(key);
}

/** The default backend key. */
export const DEFAULT_SHADER_BACKEND = 'shaderfrog';

/**
 * Compile `graph` through one backend. AWAIT this — a backend is allowed to be
 * async (the uvUnwrap lesson: a sync caller commits a Promise as if it were a
 * result, and the failure looks like a corrupt material).
 * @param {any} graph
 * @param {ShaderCompileCtx} ctx
 * @param {string} [key]
 * @returns {Promise<any>}
 */
export async function compileShaderGraph(graph, ctx, key = DEFAULT_SHADER_BACKEND) {
	if (key === 'shaderfrog') await ensureShaderfrogBackend();
	if (key === INJECT_SHADER_BACKEND) ensureInjectBackend();
	let backend = backends.get(key);
	/** @type {string|null} */
	let fellBackFrom = null;
	if (!backend) {
		// SH6: an unknown backend FALLS BACK to the built-in rather than throwing. This is
		// not only the module-disabled case — a peer that never installed the module at all
		// receives a graph naming it, and refusing to compile would leave that peer looking
		// at a plain material with an error it cannot act on. The document keeps the original
		// key, so the intended compile returns when the module does.
		ensureInjectBackend();
		backend = backends.get(INJECT_SHADER_BACKEND);
		if (!backend) throw new Error('No shader backend registered for "' + key + '"');
		fellBackFrom = key;
	}
	const material = await backend.compile(graph, ctx);
	// stamp it so the editor (and a test) can tell a fallback from an intended compile
	if (material && fellBackFrom) {
		material.userData = material.userData ?? {};
		material.userData.shaderBackendFallback = fellBackFrom;
	}
	return material;
}

// ---- the built-in INJECT backend (SH0.5) ---------------------------------------
//
// The other route: instead of regenerating three's shader through a GLSL parser, patch
// three's OWN shader in place via `onBeforeCompile`. Everything three emits — the
// lighting model, the shadow chunks, transmission, fog, morph/skin — is left exactly as
// three wrote it, so the whole class of re-emission bugs (SH0's dropped array dimension)
// cannot occur, and a change to the scene's LIGHT SET is three's problem, not ours.
//
// The trade is expressiveness: a graph can only inject at the taps we expose, whereas
// ShaderFrog can rewrite the whole program.
//
// Takes a small IR rather than a ShaderFrog graph — deliberately the seed of SH1's own
// node model, and already the "one GLSL node" case:
//   { uniforms: [{name, value}], prelude?: '<glsl fns>', albedo?: '<vec3 expr>',
//     emissive?, roughness?, metalness? }
// Uniform values may be plain numbers/arrays: three's uniform setters accept an array
// for a vecN, so this module needs no THREE import and stays a leaf.

/** The inject backend's key. */
export const INJECT_SHADER_BACKEND = 'inject';

/** Register the inject backend (idempotent, synchronous — nothing to load). */
export function ensureInjectBackend() {
	if (!backends.has(INJECT_SHADER_BACKEND))
		registerShaderBackend(INJECT_SHADER_BACKEND, 'Built-in (three)', compileInject);
}

/**
 * The FRAGMENT taps we expose, as [IR field, the write, the anchor it lands after].
 *
 * Each anchor is chosen so the variable being written is already in scope AND has not yet
 * been consumed by three:
 * - `map_fragment` is where a texture would multiply albedo, so injecting there gives the
 *   same semantics ShaderFrog's `diffuseColor *= sampledDiffuseColor` has.
 * - `alphamap_fragment` still precedes `<alphatest_fragment>`, so an authored opacity is
 *   subject to three's own alpha test rather than bypassing it.
 * - `normal_fragment_maps` is AFTER `<normal_fragment_begin>` declared `normal`, which is
 *   the only point where overwriting it affects the lighting that follows.
 * - `aomap_fragment` runs after `<lights_fragment_end>`, so `reflectedLight` exists and
 *   its indirect terms can still be modulated before they are summed.
 *
 * ORDER MATTERS: the body is emitted at the FIRST anchor in this list that the shader
 * actually contains, and every later tap references its temps. `map_fragment` is the
 * earliest of these in three's meshphysical fragment shader.
 */
const TAPS = [
	['albedo', 'diffuseColor.rgb *= ', '#include <map_fragment>'],
	['opacity', 'diffuseColor.a = ', '#include <alphamap_fragment>'],
	['roughness', 'roughnessFactor = ', '#include <roughnessmap_fragment>'],
	['metalness', 'metalnessFactor = ', '#include <metalnessmap_fragment>'],
	['normal', 'normal = normalize', '#include <normal_fragment_maps>'],
	['emissive', 'totalEmissiveRadiance += ', '#include <emissivemap_fragment>'],
	['ao', 'reflectedLight.indirectDiffuse *= ', '#include <aomap_fragment>']
];

/**
 * The VERTEX tap. `<begin_vertex>` is `vec3 transformed = vec3( position );`, so adding to
 * `transformed` is the displacement three's own displacementMap does at the same place.
 *
 * Two honest limitations, both shared with three's displacementMap: NORMALS are not
 * recomputed (they were derived at `<beginnormal_vertex>`, before this), and the SHADOW
 * pass uses a different depth material that this injection does not reach — so a
 * displaced object casts its undisplaced silhouette.
 */
const VERTEX_TAPS = [['position', 'transformed += ', '#include <begin_vertex>']];

/**
 * @param {any} ir
 * @param {ShaderCompileCtx} ctx
 * @returns {Promise<any>}
 */
async function compileInject(ir, ctx) {
	const object = ctx?.object;
	const base = ctx?.baseMaterial ?? object?.material;
	if (!base || Array.isArray(base))
		throw new Error('inject backend needs a single-material object');
	const material = base.clone();
	const decls = (ir?.uniforms ?? [])
		.map((/** @type {any} */ u) => 'uniform ' + glslTypeOf(u) + ' ' + u.name + ';')
		.join('\n');
	// one live uniform record, so a param change is a value write and NEVER a recompile
	/** @type {Record<string, {value:any}>} */
	const uniforms = {};
	for (const u of ir?.uniforms ?? []) uniforms[u.name] = { value: u.value };
	material.userData.shaderUniforms = uniforms;
	const prelude = [decls, ir?.prelude ?? ''].filter(Boolean).join('\n');
	// SH1: the compiler hoists reused sub-expressions into temps, so a graph arrives as
	// `body` (statements) plus one EXPRESSION per tap. The body is emitted ONCE, at the
	// earliest anchor we use, and the taps reference its temps — which is also why the
	// compiler's Normal node reads the varying rather than three's shaded `normal`.
	/** @type {Map<string, string[]>} */
	const perAnchor = new Map();
	const push = (/** @type {string} */ anchor, /** @type {string} */ line) => {
		const list = perAnchor.get(anchor) ?? [];
		list.push(line);
		perAnchor.set(anchor, list);
	};
	const BODY_ANCHOR = TAPS[0][2];
	if (ir?.body) push(BODY_ANCHOR, ir.body);
	for (const [field, write, anchor] of TAPS) {
		const expr = ir?.[field];
		if (expr) push(anchor, write + '(' + expr + ');');
	}
	/** @type {[string,string][]} */
	const edits = [...perAnchor.entries()].map(([anchor, lines]) => [
		anchor,
		anchor + '\n\t' + lines.join('\n\t')
	]);

	// the VERTEX stage, when the graph displaces anything. Its own body and its own temps
	// (a fragment temp is out of scope here), but the SAME uniform records — one object,
	// one set of values, so a param drag moves both stages together.
	/** @type {[string,string][]} */
	let vertexEdits = [];
	if (ir?.vertex) {
		// grouped per anchor exactly like the fragment path: two taps sharing one anchor
		// must become ONE replacement, or the second `replace` re-injects the first
		/** @type {Map<string, string[]>} */
		const perVertexAnchor = new Map();
		const pushV = (/** @type {string} */ anchor, /** @type {string} */ line) => {
			const list = perVertexAnchor.get(anchor) ?? [];
			list.push(line);
			perVertexAnchor.set(anchor, list);
		};
		if (ir.vertex.body) pushV(VERTEX_TAPS[0][2], ir.vertex.body);
		for (const [field, write, anchor] of VERTEX_TAPS) {
			const expr = ir.vertex[field];
			if (expr) pushV(anchor, write + '(' + expr + ');');
		}
		vertexEdits = [...perVertexAnchor.entries()].map(([anchor, lines]) => [
			anchor,
			anchor + '\n\t' + lines.join('\n\t')
		]);
	}

	// a graph reading UV needs three to declare vUv, which it only does behind its own
	// define — without this an untextured material fails to compile on `vUv`
	if (ir?.defines) {
		material.defines = { ...(material.defines ?? {}), ...ir.defines };
	}
	// An authored opacity only shows if the material BLENDS. This is a render-program
	// change (and moves the object into the transparent pass), which is exactly why the
	// backend works on a CLONE: the object's own material is left alone, so Detach and
	// every serializer still see an opaque base.
	if (ir?.opacity) material.transparent = true;
	material.onBeforeCompile = (/** @type {any} */ shader) => {
		Object.assign(shader.uniforms, uniforms);
		/** @type {string[]} */
		const applied = [];
		/** @type {string[]} */
		const missed = [];
		if (prelude)
			shader.fragmentShader = shader.fragmentShader.replace(
				'#include <common>',
				'#include <common>\n' + prelude
			);
		for (const [anchor, replacement] of edits) {
			// `replace` silently no-ops on a missing anchor, which would leave the object
			// looking untouched with nothing to explain it — record what landed so the
			// editor can say "this tap does not apply to this material".
			if (shader.fragmentShader.includes(anchor)) {
				shader.fragmentShader = shader.fragmentShader.replace(anchor, replacement);
				applied.push(anchor);
			} else missed.push(anchor);
		}
		if (vertexEdits.length) {
			// uniforms + prelude have to be declared in the VERTEX shader too, or its body
			// references identifiers that only exist in the fragment one
			if (prelude)
				shader.vertexShader = shader.vertexShader.replace(
					'#include <common>',
					'#include <common>\n' + prelude
				);
			for (const [anchor, replacement] of vertexEdits) {
				if (shader.vertexShader.includes(anchor)) {
					shader.vertexShader = shader.vertexShader.replace(anchor, replacement);
					applied.push('vertex:' + anchor);
				} else missed.push('vertex:' + anchor);
			}
		}
		material.userData.shaderInjected = { applied, missed };
	};
	// three caches PROGRAMS across materials, and two differently-injected materials would
	// otherwise be handed the same one. Hash what we inject — BOTH stages, or a graph that
	// differs only in its displacement would be handed the other one's program.
	const key = hashString(
		prelude + '|' + edits.map((e) => e[1]).join('|') + '|' + vertexEdits.map((e) => e[1]).join('|')
	);
	material.customProgramCacheKey = () => 'inject:' + key;
	material.needsUpdate = true;
	return material;
}

/** @param {any} u @returns {string} */
function glslTypeOf(u) {
	if (u.type) return u.type;
	const v = u.value;
	if (typeof v === 'number') return 'float';
	const n = Array.isArray(v) ? v.length : v?.isVector3 ? 3 : v?.isVector2 ? 2 : v?.isColor ? 3 : 0;
	return n === 2 ? 'vec2' : n === 4 ? 'vec4' : 'vec3';
}

/** @param {string} text @returns {string} */
function hashString(text) {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

// ---- the built-in ShaderFrog backend ------------------------------------------

/** @type {Promise<void>|null} */
let shaderfrogLoad = null;

/**
 * Load @shaderfrog/core once and register the built-in backend. Idempotent and
 * safe to call per compile; the module-level promise is the single flight.
 * @returns {Promise<void>}
 */
export function ensureShaderfrogBackend() {
	if (backends.has(DEFAULT_SHADER_BACKEND)) return Promise.resolve();
	if (!shaderfrogLoad)
		shaderfrogLoad = Promise.all([
			import('@shaderfrog/core'),
			// threngine.js DIRECTLY, not the plugin's index: the index re-exports only
			// createMaterial + engine, and going through it adds an extensionless
			// relative hop for no gain.
			import('@shaderfrog/core/plugins/three/threngine.js')
		]).then(([core, three]) => {
			registerShaderBackend(
				DEFAULT_SHADER_BACKEND,
				'ShaderFrog',
				makeShaderfrogCompile(core, three)
			);
		});
	return shaderfrogLoad;
}

// One EngineContext per mesh, kept alive between compiles. ShaderFrog caches the
// "megashader" (three's own physical shader, read back out of the GL context) in
// `runtime.cache`, and its cache key includes the scene's LIGHT SET, background and
// environment — so reusing the context is what makes a param recompile cheap, while
// a light change still correctly invalidates. WeakMap: no leak when a mesh dies.
/** @type {WeakMap<object, any>} */
const contexts = new WeakMap();

/**
 * @param {any} core
 * @param {any} threePlugin
 * @returns {(graph:any, ctx:ShaderCompileCtx) => Promise<any>}
 */
function makeShaderfrogCompile(core, threePlugin) {
	return async function compile(graph, ctx) {
		const { object, scene, camera, renderer } = ctx;
		if (!object || !scene || !camera || !renderer)
			throw new Error('shaderfrog backend needs object + scene + camera + renderer');
		let engineContext = contexts.get(object);
		if (!engineContext) {
			engineContext = {
				engine: 'three',
				nodes: {},
				runtime: {
					scene,
					camera,
					renderer,
					// ShaderFrog swaps a probe material onto this mesh and calls
					// renderer.compile() to harvest three's generated GLSL, so it has to
					// be a REAL mesh in the REAL scene — that is precisely why the
					// compiled shader knows about our lights.
					sceneData: { mesh: object, lights: [], helpers: [] },
					index: 0,
					cache: { data: {}, nodes: {} }
				},
				debuggingNonsense: {}
			};
			contexts.set(object, engineContext);
		} else {
			// the mesh survives but the scene graph may have been rebuilt around it
			engineContext.runtime.scene = scene;
			engineContext.runtime.camera = camera;
			engineContext.runtime.renderer = renderer;
		}
		const result = await core.compileSource(graph, threePlugin.threngine, engineContext);
		// compileSource resolves with NodeErrors instead of throwing when a node's
		// GLSL is bad — surface it as an error rather than handing back junk.
		if (!result || result.type === 'errors' || result.errors)
			throw new Error(shaderfrogErrorText(result));
		return threePlugin.createMaterial(result, engineContext);
	};
}

/** @param {any} result @returns {string} */
function shaderfrogErrorText(result) {
	const list = result?.errors;
	if (Array.isArray(list) && list.length) return 'Shader compile failed: ' + list.join('; ');
	return 'Shader compile failed';
}

/** Drop a mesh's cached compile context (detach / dispose). @param {any} object */
export function forgetShaderContext(object) {
	if (object) contexts.delete(object);
}
