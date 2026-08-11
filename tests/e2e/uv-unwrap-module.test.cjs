// P12 groundwork: can a MODULE supply an unwrap backend, and can that backend be WASM?
//
// The plan left this as an open question — "how does a self-contained community module load
// wasm" — and it was blocking a heavier unwrapper (xatlas) that has no business in the core
// bundle. This suite answers it with evidence rather than reasoning:
//
//  1. `api.registerUnwrapBackend` puts a module's backend in the same registry the built-in
//     projections use, so the UV editor lists and runs it with no special case.
//  2. The backend may be ASYNC, which is what a wasm backend needs (core awaits it).
//  3. WebAssembly instantiates fine from a MODULE ASSET — the module carries the .wasm inside
//     its own zip and gets a blob URL from `api.assetUrl`. No CDN, no network, no CSP surface.
//     The proof uses a hand-built 41-byte wasm module rather than a real library.
const h = require('./helpers.cjs');

/** the smallest honest wasm module: one exported function, (i32, i32) -> i32, that adds */
const WASM_ADD_BASE64 =
	'AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- the seam exists on the module api ----------------------------------
	const seam = await A.page.evaluate(() => {
		const sdk = window.__stores.moduleSDK;
		return {
			hasRegistry: typeof window.__stores.uvUnwrap?.registerUnwrapBackend === 'function',
			builtIns: window.__stores.uvUnwrap?.unwrapBackends?.().map((b) => b.key) ?? []
		};
	});
	h.check(seam.hasRegistry, 'the unwrap registry is reachable (premise)');
	h.check(
		seam.builtIns.includes('box') && seam.builtIns.includes('planar'),
		`the built-in projections are registered (${seam.builtIns.join(', ')})`
	);

	// --- a module registers one, and the editor runs it ----------------------
	// The module is registered through the SDK exactly as a packaged one would be, so this
	// exercises the api surface rather than the registry directly.
	const registered = await A.page.evaluate(async () => {
		const s = window.__stores;
		const calls = [];
		await s.moduleSDK.initModules([
			{
				id: 'testunwrap',
				name: 'Test unwrap',
				version: '1.0.0',
				description: 'a fake backend, to prove the seam',
				register(api) {
					// ASYNC on purpose: a wasm backend cannot answer synchronously
					// the seam RETURNS its promise (it resolves a dynamic import inside), so a module
					// can await registration — and a test must, or it reads the registry too early
					window.__seam = api.registerUnwrapBackend('flat', 'Flat (test)', async (faces, options) => {
						calls.push({ faces: faces.length, options });
						await Promise.resolve();
						// a legal result: every corner of every face at the same spot is a
						// degenerate but VALID unwrap, and easy to recognise afterwards
						return {
							uvs: faces.map(() => [
								[0.25, 0.75],
								[0.25, 0.75],
								[0.25, 0.75]
							]),
							islands: [faces.map((_, i) => i)]
						};
					});
				}
			}
		]);
		window.__unwrapCalls = calls;
		await window.__seam; // registration is async: this is the contract, not a sleep
		return s.uvUnwrap.unwrapBackends().map((b) => ({ key: b.key, label: b.label }));
	});
	const moduleBackend = registered.find((b) => b.key.includes('testunwrap'));
	h.check(
		!!moduleBackend,
		`the module's backend joined the registry (${registered.map((b) => b.key).join(', ')})`
	);
	h.check(
		moduleBackend?.key === 'mod-testunwrap-flat',
		`...namespaced by module id, so two modules cannot collide (${moduleBackend?.key})`
	);
	h.check(
		moduleBackend?.label === 'Flat (test)',
		'...with the label the UV editor will show in its Unwrap menu'
	);

	// --- the editor drives it, awaits it, and commits the result -------------
	const ran = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		const ok = await s.uvEditor.unwrapObject(box.uuid, 'mod-testunwrap-flat', { margin: 0.02 });
		const uv = box.geometry.attributes.uv;
		let atMark = 0;
		if (uv)
			for (let i = 0; i < uv.count; i++)
				if (Math.abs(uv.getX(i) - 0.25) < 1e-6 && Math.abs(uv.getY(i) - 0.75) < 1e-6) atMark++;
		return { ok, calls: window.__unwrapCalls.length, faces: window.__unwrapCalls[0]?.faces ?? 0, atMark, total: uv?.count ?? 0 };
	});
	h.check(ran.ok, 'the editor ran the module backend and committed');
	h.check(ran.calls === 1 && ran.faces === 12, `the backend saw the mesh's faces (${ran.faces})`);
	h.check(
		ran.atMark === ran.total && ran.total > 0,
		`every uv is the value the ASYNC backend returned (${ran.atMark}/${ran.total}) — core awaited it instead of committing a Promise`
	);

	// --- WASM from a MODULE ASSET, which is the actual open question ---------
	const wasm = await A.page.evaluate(async (base64) => {
		// exactly what userModules does with a packaged file: bytes -> Blob -> blob URL, which
		// is what `api.assetUrl` hands a module
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const url = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
		try {
			// the streaming path first (what a real library uses), then the buffer fallback
			let instance;
			let usedStreaming = false;
			try {
				const result = await WebAssembly.instantiateStreaming(fetch(url));
				instance = result.instance;
				usedStreaming = true;
			} catch (streamingError) {
				const response = await fetch(url);
				const buffer = await response.arrayBuffer();
				const result = await WebAssembly.instantiate(buffer);
				instance = result.instance;
			}
			const add = instance.exports.add;
			return { ok: true, usedStreaming, sum: add(19, 23), size: bytes.length };
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error) };
		} finally {
			URL.revokeObjectURL(url);
		}
	}, WASM_ADD_BASE64);
	h.check(wasm.ok, `WebAssembly instantiated from a blob URL${wasm.ok ? '' : ': ' + wasm.error}`);
	h.check(wasm.sum === 42, `...and the exported function runs (19 + 23 = ${wasm.sum})`);
	h.check(
		typeof wasm.usedStreaming === 'boolean',
		`...via ${wasm.usedStreaming ? 'instantiateStreaming' : 'the arrayBuffer fallback'} (a real backend should try both, since streaming needs the right MIME type)`
	);

	// --- and the built-ins still work, unchanged ----------------------------
	const builtIn = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		const ok = await s.uvEditor.unwrapObject(box.uuid, 'box', { margin: 0.02 });
		const uv = box.geometry.attributes.uv;
		let spread = 0;
		if (uv) {
			let min = 1;
			let max = 0;
			for (let i = 0; i < uv.count; i++) {
				min = Math.min(min, uv.getX(i));
				max = Math.max(max, uv.getX(i));
			}
			spread = max - min;
		}
		return { ok, spread };
	});
	h.check(builtIn.ok && builtIn.spread > 0.5, `the built-in box projection still unwraps (u spread ${builtIn.spread.toFixed(2)})`);

	await h.finish(browser);
});
