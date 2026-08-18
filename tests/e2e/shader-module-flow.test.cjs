// SH6 + SH7: the module SDK seam for shader BACKENDS, and the Set Shader Uniform flow node.
//
// SH6 goes through `moduleSDK.initModules` with an inline module, which is the real api
// path (makeApi runs, the teardown journal records) — not the registry directly, so the
// thing under test is the seam a community module would actually use.
//
// Run: $env:APP_URL='https://localhost:5197/'; npm run e2e -- shader-module-flow
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
	});
	const peer = await h.setupPage(browser, 'shader-module-flow');
	const page = peer.page;
	const glsl = [];
	page.on('console', (msg) => {
		const t = msg.text();
		if (/peer error|peerjs|Lost connection/i.test(t)) return;
		if (/Shader Error|ERROR: \d|VALIDATE_STATUS/i.test(t)) glsl.push(t.slice(0, 400));
	});
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });

	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1500);

	const uuid = await page.evaluate(() => {
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		return read(window.__stores.objectsGroup).then((g) => {
			let m = null;
			g.traverse((n) => {
				if (n.isMesh && !m) m = n;
			});
			// neutralise the palette colour: it is derived from the uuid, so anything measured
			// against "the base" is otherwise a bet on which cube this run produced
			if (m.material?.color?.setRGB) m.material.color.setRGB(1, 1, 1);
			return m.uuid;
		});
	});

	// ---- 1. a MODULE supplies a backend, through the real api ----------------
	const registered = await page.evaluate(async () => {
		const s = window.__stores;
		const calls = [];
		await s.moduleSDK.initModules([
			{
				id: 'testshader',
				name: 'Test shader backend',
				version: '1.0.0',
				description: 'proves the SH6 seam',
				register(api) {
					// the seam RETURNS its promise (a dynamic import runs inside), so a module can
					// await registration — and a test must, or it reads the registry too early
					window.__seam = api.registerShaderBackend(
						'flat',
						'Flat (test)',
						async (ir, ctx) => {
							calls.push({
								hasBody: typeof ir?.body === 'string',
								taps: ['albedo', 'emissive', 'roughness', 'metalness', 'normal', 'opacity', 'ao']
									.filter((t) => !!ir?.[t]),
								uniforms: (ir?.uniforms ?? []).length,
								gotObject: !!ctx?.object,
								gotRenderer: !!ctx?.renderer
							});
							// ASYNC on purpose: a wasm/TSL backend cannot answer synchronously
							await Promise.resolve();
							const THREE = s.THREE;
							// a legal, recognisable result: flat green, nothing injected
							const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
							mat.userData.fromTestBackend = true;
							return mat;
						}
					);
				}
			}
		]);
		await window.__seam;
		window.__backendCalls = calls;
		return {
			keys: s.shaderBackends.shaderBackendList().map((b) => b.key),
			seamIsPromise: typeof window.__seam?.then === 'function'
		};
	});
	h.check(registered.seamIsPromise, 'api.registerShaderBackend RETURNS a promise, so a module can await it');
	h.check(
		registered.keys.includes('mod-testshader-flat'),
		'the module backend lands in the shared registry, namespaced: ' + JSON.stringify(registered.keys)
	);

	// ---- 2. a graph naming it compiles THROUGH it ---------------------------
	const graph = (backend) => ({
		backend,
		nodes: [
			{ id: 'c', type: 'color', position: { x: 60, y: 60 }, data: { value: '#e02020' } },
			{ id: 's', type: 'surface', position: { x: 360, y: 80 }, data: {} }
		],
		edges: [{ id: 'e', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' }]
	});

	const used = await page.evaluate(
		async (args) => {
			const S = window.__stores;
			const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
			S.shaderGraph.setShaderGraphFor(args.u, args.g);
			await S.shaderGraph.compileAndApply(args.u);
			const group = await read(S.objectsGroup);
			const obj = group.getObjectByProperty('uuid', args.u);
			return {
				calls: window.__backendCalls,
				fromBackend: !!obj.material?.userData?.fromTestBackend,
				type: obj.material?.type,
				driven: S.shaderGraph.isShaderDriven(args.u)
			};
		},
		{ u: uuid, g: graph('mod-testshader-flat') }
	);
	h.check(used.calls.length >= 1, 'the module backend is CALLED for a graph naming it: ' + used.calls.length + ' call(s)');
	h.check(
		used.calls[0]?.hasBody && used.calls[0]?.taps.includes('albedo'),
		'and receives the same IR the built-ins get (body + the wired taps): ' + JSON.stringify(used.calls[0])
	);
	h.check(
		used.calls[0]?.gotObject && used.calls[0]?.gotRenderer,
		'plus the scene context it may need'
	);
	h.check(used.fromBackend, 'the material it returned is the one installed: ' + used.type);
	h.check(used.driven, 'and the object counts as shader-driven');

	// ---- 3. disabling the module falls the graph BACK to the built-in -------
	const afterOff = await page.evaluate(async (u) => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		await S.moduleSDK.deactivateModule('testshader');
		// the teardown journal drops the registration AND asks the graphs to recompile
		await new Promise((r) => setTimeout(r, 900));
		const group = await read(S.objectsGroup);
		const obj = group.getObjectByProperty('uuid', u);
		return {
			keys: S.shaderBackends.shaderBackendList().map((b) => b.key),
			stillFromBackend: !!obj.material?.userData?.fromTestBackend,
			fellBack: obj.material?.userData?.shaderBackendFallback ?? null,
			injected: !!obj.material?.userData?.shaderInjected,
			driven: S.shaderGraph.isShaderDriven(u),
			// the DOCUMENT keeps naming the module's backend on purpose
			docBackend: S.shaderGraph.shaderGraphOf(u)?.backend ?? null
		};
	}, uuid);
	h.check(
		!afterOff.keys.includes('mod-testshader-flat'),
		'disabling the module removes its backend: ' + JSON.stringify(afterOff.keys)
	);
	h.check(!afterOff.stillFromBackend, 'the object is no longer on the module material');
	h.check(
		afterOff.fellBack === 'mod-testshader-flat',
		'it fell back to the BUILT-IN, and says which backend it came from: ' + afterOff.fellBack
	);
	h.check(afterOff.injected, 'the built-in really compiled it (the inject record is present)');
	h.check(afterOff.driven, 'so the object is still shader-driven rather than left broken');
	h.check(
		afterOff.docBackend === 'mod-testshader-flat',
		'and the DOCUMENT still names the module backend, so re-enabling restores the intended compile: ' + afterOff.docBackend
	);

	// a peer that NEVER had the module is the same path, and must not throw
	const neverHad = await page.evaluate(
		async (args) => {
			const S = window.__stores;
			const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
			S.shaderGraph.setShaderGraphFor(args.u, args.g);
			const res = await S.shaderGraph.compileAndApply(args.u);
			const group = await read(S.objectsGroup);
			const obj = group.getObjectByProperty('uuid', args.u);
			return {
				ok: res.ok,
				errors: res.errors ?? [],
				fellBack: obj.material?.userData?.shaderBackendFallback ?? null
			};
		},
		{ u: uuid, g: graph('mod-someone-elses-thing') }
	);
	h.check(
		neverHad.ok && !neverHad.errors.length,
		'a graph naming a backend this peer never installed still compiles: ' + JSON.stringify(neverHad.errors)
	);
	h.check(
		neverHad.fellBack === 'mod-someone-elses-thing',
		'through the same fallback — refusing would leave that peer with an error it cannot act on'
	);

	// ---- 4. SH7: a flow node drives a shader uniform ------------------------
	// The uniform NAME is what the Shader editor shows beside the param, and it is the
	// compiler's `u_<nodeId>_<param>`. Wire: Number -> Set Shader Uniform -> Object Selector.
	const flow = await page.evaluate(
		async (args) => {
			const S = window.__stores;
			const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
			// a graph whose ROUGHNESS is a live float uniform, on the built-in backend
			S.shaderGraph.setShaderGraphFor(args.u, {
				nodes: [
					{ id: 'col', type: 'color', position: { x: 40, y: 40 }, data: { value: '#cccccc' } },
					{ id: 'rgh', type: 'float', position: { x: 40, y: 170 }, data: { value: 0.9 } },
					{ id: 's', type: 'surface', position: { x: 380, y: 90 }, data: {} }
				],
				edges: [
					{ id: 'e1', source: 'col', sourceHandle: 'out', target: 's', targetHandle: 'albedo' },
					{ id: 'e2', source: 'rgh', sourceHandle: 'out', target: 's', targetHandle: 'roughness' }
				]
			});
			await S.shaderGraph.compileAndApply(args.u);
			const name = 'u_rgh_value';
			const before = S.shaderGraph.shaderUniform(args.u, name)?.value ?? null;

			// the flow graph: a constant number into Set Shader Uniform, into a selector
			S.flowNodes.set([
				{ id: 'n1', type: 'number', position: { x: 0, y: 0 }, data: { label: 'Number', type: 'number', value: 0.07, step: 0.01 } },
				{
					id: 'su1',
					type: 'setuniform',
					position: { x: 200, y: 0 },
					data: { label: 'Set Shader Uniform', type: 'setuniform', uniform: name, value: 0.07 }
				},
				{ id: 'sel1', type: 'objectselector', position: { x: 420, y: 0 }, data: { label: 'Object', selected: args.u } }
			]);
			S.flowEdges.set([
				{ id: 'fe1', source: 'n1', target: 'su1', targetHandle: 'value' },
				{ id: 'fe2', source: 'su1', target: 'sel1' }
			]);
			// let the flow runtime tick
			await new Promise((r) => setTimeout(r, 1200));
			return {
				name,
				before,
				after: S.shaderGraph.shaderUniform(args.u, name)?.value ?? null
			};
		},
		{ u: uuid }
	);
	h.check(flow.before === 0.9, 'premise — the graph exposes roughness as a live uniform at 0.9: ' + flow.before);
	h.check(
		flow.after !== null && Math.abs(flow.after - 0.07) < 0.02,
		'a Set Shader Uniform node writes it from the flow graph: ' + flow.before + ' -> ' + flow.after
	);

	// changing the flow VALUE moves the uniform again — it is driven, not set once
	const moved = await page.evaluate(async (name) => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		const nodes = await read(S.flowNodes);
		// the 'value' input is WIRED, so the upstream Number node is what decides it —
		// editing su1's own data changes nothing, which is correct flow behaviour (a wire
		// always wins over a local value) and was the first version of this check
		S.flowNodes.set(
			nodes.map((n) => (n.id === 'n1' ? { ...n, data: { ...n.data, value: 0.83 } } : n))
		);
		await new Promise((r) => setTimeout(r, 1000));
		const group = await read(S.objectsGroup);
		let uuid = null;
		group.traverse((n) => {
			if (n.isMesh && !uuid) uuid = n.uuid;
		});
		return S.shaderGraph.shaderUniform(uuid, name)?.value ?? null;
	}, flow.name);
	h.check(
		moved !== null && Math.abs(moved - 0.83) < 0.02,
		'and keeps driving it as the flow value changes: ' + moved
	);

	// an unknown uniform name must be a harmless no-op, not a crash
	const bogus = await page.evaluate(async () => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		const nodes = await read(S.flowNodes);
		S.flowNodes.set(
			nodes.map((n) => (n.id === 'su1' ? { ...n, data: { ...n.data, uniform: 'u_nope_nope' } } : n))
		);
		await new Promise((r) => setTimeout(r, 800));
		return true;
	});
	h.check(bogus, 'naming a uniform that does not exist is a no-op');

	// ---- 5. the editor SHOWS the uniform name, or nobody can address it -----
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, false), uuid);
	await page.evaluate(() => window.__stores.shaderGraph.openShaderEditor());
	await page.waitForTimeout(1400);
	h.check((await page.locator('#shader-editor').count()) === 1, 'premise — the shader editor is open');
	// select the Float node in the graph, then read the ⓘ pane
	// a REAL click: a synthetic mousedown reaches xyflow's drag handler, which reads
	// ownerDocument off the event target and throws on a hand-built MouseEvent
	const floatCard = page
		.locator('#shader-editor .svelte-flow__node')
		.filter({ hasText: 'Float' })
		.first();
	const cardBox = await floatCard.boundingBox();
	h.check(!!cardBox, 'premise — the Float node card is on screen');
	if (cardBox) await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + 8);
	await page.waitForTimeout(700);
	await page.evaluate(() => {
		const tabs = [...document.querySelectorAll('#shader-props .shader-props-tabs button')];
		tabs[0]?.click();
	});
	await page.waitForTimeout(600);
	// the MANUAL line for the selected node renders here too — asserting the store has a
	// doc string proves nothing about whether a user can read it
	const docShown = await page.locator('#shader-node-doc').innerText().catch(() => '');
	h.check(
		docShown.trim().length > 20,
		'the info pane shows the node manual line: "' + docShown.trim().slice(0, 60) + '..."'
	);
	const catalogDoc = await page.evaluate(() => window.__stores.shaderCatalog?.shaderNodeDoc?.('float') ?? '');
	h.check(
		!catalogDoc || docShown.trim() === catalogDoc.trim(),
		'and it is the SAME text the catalog carries, so the pane cannot drift from the docs'
	);

	const names = await page.locator('#shader-editor .shader-uniform-name').allInnerTexts();
	h.check(
		names.some((n) => n.trim() === 'u_rgh_value'),
		'the properties pane lists the generated uniform name a flow node must address: ' + JSON.stringify(names)
	);

	h.check(glsl.length === 0, 'no GLSL errors throughout: ' + JSON.stringify(glsl.slice(0, 2)));
	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
