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
	if (key === DEFAULT_SHADER_BACKEND) await ensureShaderfrogBackend();
	const backend = backends.get(key);
	if (!backend) throw new Error('No shader backend registered for "' + key + '"');
	return backend.compile(graph, ctx);
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
