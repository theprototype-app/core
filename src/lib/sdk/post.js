// Module SDK — post-effect kinds and post backends.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).


/** @param {import('./context.js').SdkContext} ctx */
export function sdkPost(ctx) {
	const { moduleId, onDispose } = ctx;
	return {
		/**
		 * #20 P6 (post plan P3): supply a whole POST EFFECT — an entry a user can add to
		 * the scene look, with its own params. `def` is the scenePost shape:
		 * `{label, group, isPass, params, make(params, ctx)}`, where `make` returns a
		 * postprocessing Effect (or a Pass with `isPass: true`).
		 *
		 * The kind is NAMESPACED `mod-<moduleId>-<kind>`, so two modules cannot collide and
		 * a document naming it stays readable when the module is gone: the post stack
		 * already PRESERVES-and-SKIPS an entry whose kind is unregistered, and registering
		 * pokes the stack so the chain rebuilds. That is deliberately the same story a peer
		 * who never had the module gets — the fallback belongs to the registry, not to the
		 * disable path.
		 *
		 * RETURNS THE PROMISE — await it rather than sleeping on it.
		 * @param {string} kind @param {any} def
		 * @returns {Promise<void>}
		 */
		registerPostEffect: (kind, def) => {
			const full = `mod-${moduleId}-${kind}`;
			// The disposer is recorded SYNCHRONOUSLY, and the late registration undoes
			// itself if teardown already ran. Recording it inside the `.then` instead
			// leaks the registration whenever a disable lands before the dynamic import
			// resolves — measured in post-backends: the kind was still in the registry
			// after `deactivateModule`, because the journal had already been replayed by
			// the time `onDispose` was handed the disposer.
			let off = /** @type {(() => void)|null} */ (null);
			let disposed = false;
			onDispose(() => {
				disposed = true;
				if (off) off();
			});
			return import('../scenePost').then((m) => {
				off = m.registerPostEffect(full, def);
				if (disposed) off();
			});
		},

		/**
		 * #20 P6: supply a post COMPILER — a backend turning a post shader description into
		 * an Effect. Separate from `registerShaderBackend` because the output is an Effect
		 * and not a Material (see postBackends.js for why that separation is load-bearing).
		 *
		 * An unknown key falls back to the built-in INSIDE the registry, so nothing here has
		 * to undo anything on teardown beyond removing itself.
		 * @param {string} key @param {string} label
		 * @param {(spec: any, ctx: any) => any} compile
		 * @returns {Promise<void>}
		 */
		registerPostBackend: (key, label, compile) => {
			const full = `mod-${moduleId}-${key}`;
			// same synchronous-disposer shape as registerPostEffect above — see the note
			// there for the race it closes
			let off = /** @type {(() => void)|null} */ (null);
			let disposed = false;
			onDispose(() => {
				disposed = true;
				if (off) off();
			});
			return import('../postBackends').then((m) => {
				off = m.registerPostBackend(full, label, compile);
				if (disposed) off();
			});
		}
	};
}
