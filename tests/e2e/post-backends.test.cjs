// #20 P6 — the post backend registry and the two SDK seams.
//
// The claim worth testing is not "a map stores a function". It is the FALLBACK
// PLACEMENT: an unknown key resolves inside the REGISTRY, not on the module-disable
// path, because a module being disabled is not the only way to reach one. A peer who
// never installed the module receives a document naming it, and so does a scene loaded
// from a file next year. This is the lesson the shader lane paid for, and the reason
// there is a check here for a key no module ever registered.
//
// The module seams are driven through `moduleSDK.initModules` with an INLINE module —
// the real api path, no zip needed (the shader-module-flow precedent) — because a
// register* that does not record its disposal in the teardown journal is invisible until
// somebody disables the module.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the registry, and where the fallback lives -------------------------
	const registry = await A.page.evaluate(async () => {
		const pb = window.__stores.postBackends;
		const before = pb.ensurePostBackends().map((b) => b.key);

		// a key NOBODY registered — the peer-without-the-module case
		const unknown = await pb.compilePostShader(
			{ name: 'T', fragment: 'outputColor = vec4(1.0, 0.0, 0.0, 1.0);' },
			{ scene: null, camera: null },
			'mod-never-installed-fancy'
		);

		// the built-in, asked for by name
		const builtIn = await pb.compilePostShader(
			{ name: 'T2', fragment: 'outputColor = inputColor;' },
			{ scene: null, camera: null }
		);

		return {
			before,
			unknownBackend: unknown.backend,
			unknownFellBackFrom: unknown.fellBackFrom,
			unknownMadeAnEffect: !!unknown.effect && typeof unknown.effect.getFragmentShader === 'function',
			builtInBackend: builtIn.backend,
			builtInFellBack: builtIn.fellBackFrom
		};
	});
	h.check(
		registry.before.includes('inject'),
		`the built-in backend registers itself (${JSON.stringify(registry.before)})`
	);
	h.check(
		registry.unknownBackend === 'inject' && registry.unknownMadeAnEffect,
		`an unknown key still COMPILES, via the built-in (got ${registry.unknownBackend})`
	);
	h.check(
		registry.unknownFellBackFrom === 'mod-never-installed-fancy',
		`...and reports which key it fell back from, so the caller can say so (got ${registry.unknownFellBackFrom})`
	);
	h.check(
		registry.builtInBackend === 'inject' && registry.builtInFellBack === null,
		`a known key does not report a fallback (got ${registry.builtInFellBack})`
	);

	// ---- 2. the compiled Effect really carries the authored GLSL ---------------
	// A registry that returned a default Effect would pass section 1.
	const compiled = await A.page.evaluate(async () => {
		const pb = window.__stores.postBackends;
		const { effect } = await pb.compilePostShader(
			{
				name: 'Tint',
				fragment: 'outputColor = vec4(inputColor.rgb * uTint, inputColor.a);',
				uniforms: { uTint: [0.2, 0.9, 0.4] }
			},
			{ scene: null, camera: null }
		);
		const src = effect.getFragmentShader();
		return {
			hasBody: src.includes('uInputColorTint') || src.includes('uTint'),
			wrapped: /void\s+mainImage\s*\(/.test(src),
			uniform: effect.uniforms?.has?.('uTint') ?? false
		};
	});
	h.check(compiled.wrapped, 'a bare mainImage BODY is wrapped in the function postprocessing expects');
	h.check(compiled.hasBody, 'the authored GLSL is in the compiled shader');
	h.check(compiled.uniform, 'a plain-object uniform became a real uniform on the effect');

	// ---- 3. depth is DECLARED, not assumed ------------------------------------
	// Getting the attribute wrong is SILENT — the sampler is simply never filled — which
	// is the shader lane's "a stage-specific value fails silently" trap in post form.
	const depth = await A.page.evaluate(async () => {
		const pb = window.__stores.postBackends;
		const plain = await pb.compilePostShader({ fragment: 'outputColor = inputColor;' }, { scene: null, camera: null });
		const reads = await pb.compilePostShader(
			{ fragment: 'outputColor = inputColor;', readsDepth: true },
			{ scene: null, camera: null }
		);
		return { plain: plain.effect.getAttributes(), reads: reads.effect.getAttributes() };
	});
	h.check(
		depth.reads !== depth.plain && depth.reads > 0,
		`readsDepth declares the DEPTH attribute (plain ${depth.plain}, reads ${depth.reads})`
	);

	// ---- 4. a MODULE can supply both, and both are torn down ------------------
	const mod = await A.page.evaluate(async () => {
		const sdk = window.__stores.moduleSDK;
		const scenePost = window.__stores.scenePost;
		const pb = window.__stores.postBackends;

		const testModule = {
			id: 'posttest',
			name: 'Post test',
			version: '1.0.0',
			description: 'registers a post effect and a post backend',
			register(api) {
				return Promise.all([
					api.registerPostEffect('tint', {
						label: 'Test tint',
						group: 'colour',
						params: [{ name: 'amount', type: 'number', default: 0.5 }],
						// a REAL Effect: postprocessing only discovers a fake one inside the
						// EffectPass constructor, and an object literal here took the whole
						// viewport down before that construction was guarded
						make: () =>
							new window.__stores.postprocessing.Effect(
								'TestTint',
								'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = inputColor; }'
							)
					}),
					api.registerPostBackend('fancy', 'Fancy', (spec) => ({
						name: 'FancyEffect',
						spec,
						getFragmentShader: () => 'fancy',
						getAttributes: () => 0
					}))
				]);
			}
		};

		await sdk.initModules([testModule]);
		// WAIT ON THE THING, not on a sleep. Both seams reach their registry through a
		// dynamic import, so the registration lands a tick or two after initModules
		// resolves — a fixed sleep here read an empty registry and made a working seam
		// look broken (and then masked the teardown race the fix below closes).
		const ready = await (async () => {
			for (let i = 0; i < 60; i++) {
				const hasKind = scenePost.postEffectKinds().some((k) => k.kind === 'mod-posttest-tint');
				const hasBackend = pb.postBackendList().some((b) => b.key === 'mod-posttest-fancy');
				if (hasKind && hasBackend) return true;
				await new Promise((r) => setTimeout(r, 100));
			}
			return false;
		})();

		const kinds = scenePost.postEffectKinds().map((k) => k.kind);
		const backendKeys = pb.postBackendList().map((b) => b.key);
		const viaModule = await pb.compilePostShader({ fragment: 'x' }, { scene: null, camera: null }, 'mod-posttest-fancy');

		await sdk.deactivateModule('posttest');
		await new Promise((r) => setTimeout(r, 300));

		const kindsAfter = scenePost.postEffectKinds().map((k) => k.kind);
		const backendsAfter = pb.postBackendList().map((b) => b.key);
		// and the SAME key now takes the registry fallback, with no extra plumbing
		const afterDisable = await pb.compilePostShader({ fragment: 'x' }, { scene: null, camera: null }, 'mod-posttest-fancy');

		return {
			ready,
			kinds,
			backendKeys,
			viaModuleBackend: viaModule.backend,
			kindsAfter,
			backendsAfter,
			afterDisableBackend: afterDisable.backend,
			afterDisableFellBack: afterDisable.fellBackFrom
		};
	});
	h.check(mod.ready, 'both module registrations landed (premise)');
	h.check(
		mod.kinds.includes('mod-posttest-tint'),
		`a module's post effect registers, namespaced (${JSON.stringify(mod.kinds.filter((k) => k.startsWith('mod-')))})`
	);
	h.check(
		mod.backendKeys.includes('mod-posttest-fancy'),
		`so does its backend (${JSON.stringify(mod.backendKeys)})`
	);
	h.check(
		mod.viaModuleBackend === 'mod-posttest-fancy',
		`and the module's backend is what compiles for its own key (got ${mod.viaModuleBackend})`
	);
	h.check(
		!mod.kindsAfter.includes('mod-posttest-tint'),
		`disabling the module removes the effect kind (${JSON.stringify(mod.kindsAfter.filter((k) => k.startsWith('mod-')))})`
	);
	h.check(
		!mod.backendsAfter.includes('mod-posttest-fancy'),
		`...and its backend (${JSON.stringify(mod.backendsAfter)})`
	);
	h.check(
		mod.afterDisableBackend === 'inject' && mod.afterDisableFellBack === 'mod-posttest-fancy',
		`a document still naming the gone backend falls back in the REGISTRY (got ${mod.afterDisableBackend} from ${mod.afterDisableFellBack})`
	);

	// ---- 5. an authored effect kind SURVIVES the module going away -------------
	// The post stack preserves-and-skips an unregistered kind rather than deleting the
	// entry, which is what lets the effect come back when the module does — and is the
	// same state a peer who never had the module is in.
	const preserved = await A.page.evaluate(async () => {
		const scenePost = window.__stores.scenePost;
		const sdk = window.__stores.moduleSDK;
		// author an entry naming a kind nothing has registered
		scenePost.scenePostRestore(
			{ enabled: true, effects: [{ id: 'e1', kind: 'mod-posttest-tint', enabled: true, params: {} }], changedAt: 1 },
			false
		);
		await new Promise((r) => setTimeout(r, 250));
		let state;
		scenePost.scenePost.subscribe((v) => (state = v))();
		const stillThere = state.effects.some((e) => e.kind === 'mod-posttest-tint');
		const plan = scenePost.planPostStack(state.effects);
		return {
			stillThere,
			skipped: plan.skipped.map((e) => e.kind),
			groups: plan.groups.length
		};
	});
	h.check(
		preserved.stillThere,
		'an entry naming an unregistered kind is PRESERVED in the stack, not dropped'
	);
	h.check(
		preserved.skipped.includes('mod-posttest-tint'),
		`...and reported as skipped rather than silently ignored (${JSON.stringify(preserved.skipped)})`
	);

	// ---- 6. one MALFORMED effect must not take the viewport down ---------------
	// Found by this suite's own first fixture: `make` can return successfully and still
	// return something that is not an Effect, and postprocessing only finds out inside
	// the EffectPass constructor — where the throw escaped into Outline's $effect.
	const malformed = await A.page.evaluate(async () => {
		const scenePost = window.__stores.scenePost;
		const off = scenePost.registerPostEffect('badtest', {
			label: 'Bad',
			group: 'other',
			params: [],
			make: () => ({ notAnEffect: true })
		});
		const real = scenePost.registerPostEffect('goodtest', {
			label: 'Good',
			group: 'other',
			params: [],
			make: () =>
				new window.__stores.postprocessing.Effect(
					'GoodTest',
					'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = inputColor; }'
				)
		});
		const entries = [
			{ id: 'bad', kind: 'badtest', enabled: true, params: {} },
			{ id: 'good', kind: 'goodtest', enabled: true, params: {} }
		];
		let threw = null;
		let out = null;
		try {
			out = window.__stores.postEffects.compilePostStack(entries, {
				scene: null,
				camera: new window.__stores.THREE.PerspectiveCamera(),
				width: 400,
				height: 300,
				dpr: 1
			});
		} catch (e) {
			threw = String(e);
		}
		off();
		real();
		return {
			threw,
			passes: out ? out.passes.length : -1,
			skipped: out ? out.skipped.map((e) => e.kind) : [],
			instances: out ? out.instances.map((i) => i.kind) : []
		};
	});
	h.check(malformed.threw === null, `a malformed effect does not throw out of the compile (${malformed.threw})`);
	h.check(
		malformed.skipped.includes('badtest'),
		`it is reported as skipped (${JSON.stringify(malformed.skipped)})`
	);
	h.check(
		!malformed.instances.includes('badtest'),
		`and leaves no instance behind for dispose to free (${JSON.stringify(malformed.instances)})`
	);

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});
