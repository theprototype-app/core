// SH5: the Inspector's shader-driven state and its guards, plus the context-menu entry.
//
// The point of this suite is that a shader-driven material must not be editable through
// the ordinary material rows: they would write to the CLONE the compile installed, which
// the next recompile throws away — an edit that silently vanishes — and a material-type
// switch would replace the material outright and tear the shader off.
//
// Run: $env:APP_URL='https://localhost:5197/'; npm run e2e -- shader-inspector
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'shader-inspector');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });

	// two boxes, so the multi-selection / partial-selection cases are reachable
	await page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(1800);

	const uuids = await page.evaluate(() => {
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		return read(window.__stores.objectsGroup).then((g) => {
			const out = [];
			g.traverse((n) => {
				if (n.isMesh) out.push(n.uuid);
			});
			return out;
		});
	});
	h.check(uuids.length >= 2, 'premise — two meshes in the scene: ' + uuids.length);

	const graph = (hex) => ({
		nodes: [
			{ id: 'c', type: 'color', position: { x: 60, y: 60 }, data: { value: hex } },
			{ id: 's', type: 'surface', position: { x: 360, y: 80 }, data: {} }
		],
		edges: [{ id: 'e', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' }]
	});

	// ---- 1. the material rows are OFFERED on a plain object -------------------
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuids[0]);
	await page.waitForTimeout(1200);
	// the Material section renders collapsed unless it has been opened before
	await page.evaluate(() => {
		const heads = [...document.querySelectorAll('button.ui-section-label')];
		const mat = heads.find((b) => b.textContent.trim().startsWith('Material'));
		if (mat && !document.querySelector('#select-material')) mat.click();
	});
	await page.waitForTimeout(700);
	h.check(
		(await page.locator('#select-material').count()) === 1,
		'premise — a plain object shows the material-type control'
	);
	h.check(
		(await page.locator('#material-shader-note').count()) === 0,
		'and no shader notice'
	);

	// ---- 2. attaching a graph replaces them with the notice -------------------
	await page.evaluate(
		async (args) => {
			const S = window.__stores.shaderGraph;
			S.setShaderGraphFor(args.u, args.g);
			await S.compileAndApply(args.u);
		},
		{ u: uuids[0], g: graph('#e02020') }
	);
	await page.waitForTimeout(900);

	h.check(
		(await page.locator('#material-shader-note').count()) === 1,
		'a shader-driven object shows the shader notice in its Material section'
	);
	const noteText = await page.locator('#material-shader-note').innerText();
	h.check(/shader graph drives/i.test(noteText), 'which says what owns the material: "' + noteText.split('\n')[0] + '"');
	h.check(
		(await page.locator('#select-material').count()) === 0,
		'and the material-TYPE control is gone — switching type would tear the shader off'
	);
	h.check(
		(await page.locator('#material-open-shader').count()) === 1 &&
			(await page.locator('#material-detach-shader').count()) === 1,
		'the two actions that DO make sense here are offered: Open in Shader editor + Detach'
	);
	// cast/receive are OBJECT flags, not material properties — they must survive
	const shadowLabel = await page.evaluate(() =>
		[...document.querySelectorAll('.ui-section-label')].some((p) => p.textContent.trim() === 'Shadow')
	);
	h.check(shadowLabel, 'the Shadow flags stay editable — they are object flags, not material ones');

	// ---- 3. Open in Shader editor really opens it ----------------------------
	await page.evaluate(() => window.__stores.shaderEditorClose.set(true));
	await page.waitForTimeout(400);
	h.check((await page.locator('#shader-editor').count()) === 0, 'premise — the shader tab is closed');
	await page.locator('#material-open-shader').click();
	await page.waitForTimeout(1400);
	h.check((await page.locator('#shader-editor').count()) === 1, 'the button opens the Shader editor tab');
	const scope = await page.locator('#shader-scope').innerText().catch(() => '');
	h.check(/own material/i.test(scope), 'scoped to the object it was pressed for: "' + scope + '"');

	// ---- 4. the fan-out SKIPS shader-driven members, and says how many -------
	// select BOTH: one driven, one not. A material write must land on the free one only.
	await page.evaluate((list) => window.__stores.objectActions.applySelectionSet(list, true), uuids.slice(0, 2));
	await page.waitForTimeout(1000);
	const partial = await page.locator('#material-shader-note').innerText().catch(() => '');
	h.check(
		/1 of 2/.test(partial),
		'a PARTLY driven selection says how many are affected: "' + partial.split('\n')[0] + '"'
	);
	h.check(
		(await page.locator('#select-material').count()) === 1,
		'and keeps the editors, because some members can still take the edit'
	);

	const fanned = await page.evaluate(
		async (args) => {
			const S = window.__stores;
			const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
			const group = await read(S.objectsGroup);
			const driven = group.getObjectByProperty('uuid', args.driven);
			const free = group.getObjectByProperty('uuid', args.free);
			// what the shader installed, and the plain object's own colour, BEFORE the write
			const before = {
				drivenMat: driven.material.uuid,
				drivenColor: driven.material.color.getHexString(),
				freeColor: free.material.color.getHexString()
			};
			S.materialsHandler.setObjectColor(args.free, '#1133ee');
			await new Promise((r) => setTimeout(r, 300));
			return {
				before,
				after: {
					drivenMat: driven.material.uuid,
					drivenColor: driven.material.color.getHexString(),
					freeColor: free.material.color.getHexString()
				},
				stillDriven: S.shaderGraph.isShaderDriven(args.driven)
			};
		},
		{ driven: uuids[0], free: uuids[1] }
	);
	h.check(
		fanned.after.freeColor !== fanned.before.freeColor,
		'the un-driven member still takes a colour edit: ' + fanned.before.freeColor + ' -> ' + fanned.after.freeColor
	);
	h.check(
		fanned.after.drivenColor === fanned.before.drivenColor,
		'while the driven one is untouched: ' + fanned.before.drivenColor + ' -> ' + fanned.after.drivenColor
	);
	h.check(fanned.stillDriven, 'and it is still shader-driven afterwards');

	// ---- 5. Detach puts it back ---------------------------------------------
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuids[0]);
	await page.waitForTimeout(900);
	const detached = await page.evaluate(async (u) => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		const group = await read(S.objectsGroup);
		const obj = group.getObjectByProperty('uuid', u);
		const wasDriven = S.shaderGraph.isShaderDriven(u);
		const base = S.shaderGraph.baseMaterialOf(u);
		document.querySelector('#material-detach-shader')?.click();
		await new Promise((r) => setTimeout(r, 500));
		return {
			wasDriven,
			nowDriven: S.shaderGraph.isShaderDriven(u),
			backOnBase: base ? obj.material === base : false
		};
	}, uuids[0]);
	h.check(detached.wasDriven && !detached.nowDriven, 'Detach clears the shader-driven state');
	h.check(detached.backOnBase, 'and the object is back on the material it had before the graph');
	await page.waitForTimeout(600);
	h.check(
		(await page.locator('#select-material').count()) === 1,
		'so the ordinary material rows come back'
	);
	h.check(
		(await page.locator('#material-shader-note').count()) === 0,
		'and the notice is gone'
	);

	// ---- 6. the object context menu offers Edit shader ----------------------
	const menuItems = await page.evaluate((u) => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(u, { selection: [u] });
		const flat = [];
		const walk = (list) => {
			for (const it of list ?? []) {
				if (it?.label) flat.push({ label: it.label, disabled: !!it.disabled });
				if (it?.children) walk(it.children);
			}
		};
		walk(items);
		return flat;
	}, uuids[0]);
	const editShader = menuItems.find((i) => i.label === 'Edit shader');
	h.check(!!editShader, 'the object menu carries an "Edit shader" entry');
	h.check(editShader && !editShader.disabled, 'enabled for a single-material object');

	// a MULTI selection must not offer it: the editor would scope to the scene graph
	// `multi` is derived from opts.SELECTION, not an opts.multi flag — passing the flag is
	// silently ignored, which made the first version of this check pass vacuously
	const multiItems = await page.evaluate((pair) => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(pair[0], { selection: pair });
		const flat = [];
		const walk = (list) => {
			for (const it of list ?? []) {
				if (it?.label) flat.push(it.label);
				if (it?.children) walk(it.children);
			}
		};
		walk(items);
		return flat;
	}, uuids.slice(0, 2));
	h.check(
		!multiItems.includes('Edit shader'),
		'and NOT for a multi-selection, where the editor would scope to the scene-wide graph instead'
	);

	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
