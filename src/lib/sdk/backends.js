// Module SDK — UV-unwrap, shader and audio-device backends.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).


/** @param {import('./context.js').SdkContext} ctx */
export function sdkBackends(ctx) {
	const { moduleId, moduleName, onDispose } = ctx;
	return {
		/**
		 * P12 seam: add a UV UNWRAP backend, which then appears in the UV editor's Unwrap menu
		 * beside the built-in projections.
		 *
		 * This is how a heavier unwrapper (xatlas and friends) can ship WITHOUT weighing down
		 * the core bundle: the module owns the library, core keeps the projections that always
		 * work. `run(faces, options)` is the same contract the built-ins implement, and it may
		 * be ASYNC — which is what makes a wasm backend possible. A module can carry the .wasm
		 * INSIDE its own zip and reach it through `api.assetUrl`, so it needs no network and
		 * trips no CSP.
		 * @param {string} key @param {string} label
		 * @param {(faces: any[], options: any) => any} run
		 */
		registerUnwrapBackend: (key, label, run) =>
			// dynamic, like the other late imports here: uvUnwrap stays out of the SDK's static
			// graph (the cycle guard)
			import('../uvUnwrap').then((m) =>
				m.registerUnwrapBackend(`mod-${moduleId}-${key}`, label, run)
			),

		/**
		 * SH6: supply a shader-graph COMPILE BACKEND. `compile(ir, ctx)` receives the same IR
		 * the built-ins get — `{uniforms, prelude, body, defines, albedo?, emissive?,
		 * roughness?, metalness?, normal?, opacity?, ao?, vertex?}` — plus `{object, scene,
		 * camera, renderer, baseMaterial}`, and returns a three Material (async allowed).
		 * That is how a module ships a different lighting model, a TSL path or a wasm
		 * compiler without core carrying any of it.
		 *
		 * A graph names its backend in its own document, so one authored against a module's
		 * backend keeps working for peers that have the module, and a peer without it falls
		 * back to the built-in with the reason surfaced per graph.
		 *
		 * RETURNS THE PROMISE, like registerUnwrapBackend — await it rather than sleeping on
		 * it (the documented uv-unwrap-module lesson).
		 * @param {string} key @param {string} label
		 * @param {(ir: any, ctx: any) => any} compile
		 * @returns {Promise<void>}
		 */
		registerShaderBackend: (key, label, compile) => {
			const full = `mod-${moduleId}-${key}`;
			// dynamic for the same cycle reason as every other late import here
			const job = import('../shaderBackends').then((m) => {
				const off = m.registerShaderBackend(full, label, compile);
				// same-module import promises resolve in .then order, so the disposer is
				// recorded even when teardown fires immediately after registration
				onDispose(() => off());
			});
			// a graph still naming this backend must not be left compiling against nothing:
			// once the registration is gone, re-compile those graphs so they fall back to the
			// built-in rather than silently keeping a stale material
			onDispose(() => import('../shaderGraph').then((m) => m.fallBackFromBackend(full, label)));
			return job;
		},

		/**
		 * 23-A5: supply an AUDIO DEVICE kind — an instrument, an effect, a speaker — the
		 * audioDevices spec `{kind, label, icon, group, ports, params, build(ctx, node,
		 * params), onParam, onNote, mesh, toolbox}` (see audioDevices.js). The kind is
		 * NAMESPACED `mod-<moduleId>-<kind>`; it appears in the viewport Add menu under
		 * Devices, and objects carrying it build the moment it registers. A peer without
		 * your module (or a scene opened after it is disabled) holds those objects as inert
		 * placeholders with their document intact — the fallback belongs to the registry.
		 *
		 * The disposer is recorded SYNCHRONOUSLY and a late registration undoes itself if
		 * teardown already ran (the registerPostEffect lesson); a NEW registration is never
		 * removed by an OLD teardown (the registry guards by identity).
		 *
		 * RESOLVES TO THE NAMESPACED KIND — await it, then `api.audio.addDevice(kind)`.
		 * @param {any} spec
		 * @returns {Promise<string>}
		 */
		registerAudioDevice: (spec) => {
			if (!spec || typeof spec.kind !== 'string' || !spec.kind) throw new Error('registerAudioDevice: a spec needs a kind');
			const full = `mod-${moduleId}-${spec.kind}`;
			let off = /** @type {(() => void)|null} */ (null);
			let disposed = false;
			onDispose(() => {
				disposed = true;
				if (off) off();
			});
			const install = (/** @type {any} */ m) => {
				// moduleId rides the installed spec (23-D3): moduleRequirements resolves a
				// device KIND back to the module a scene needs through it
				const disposer = m.registerAudioDevice({ ...spec, kind: full, group: spec.group ?? moduleName, moduleId });
				off = disposer;
				if (disposed) disposer();
				return full;
			};
			// ALWAYS through the import, never a synchronous install when the ref happens to be
			// primed: the guard above is only load-bearing on the async path, and one code path
			// is one thing to prove (the registerPostEffect shape, whose suite proved it)
			return import('../audioDevices').then(install);
		}
	};
}
