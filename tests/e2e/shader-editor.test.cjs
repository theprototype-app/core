// SH3: the Shader dock tab. Asserts what RENDERED, not only what the stores hold — a
// component that crashes on mount is invisible to store-reading checks (helpers also
// fails the run on a render crash).
// Run: $env:APP_URL='https://localhost:5197/'; npm run e2e -- shader-editor
const h = require('./helpers.cjs');

function stats(rgba) {
	let r = 0, g = 0, b = 0, sum = 0;
	const n = rgba.length / 4;
	for (let i = 0; i < rgba.length; i += 4) {
		r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
		sum += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
	}
	return { mean: sum / n, r: r / n, g: g / n, b: b / n };
}

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
	});
	const peer = await h.setupPage(browser, 'shader-editor');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });

	// a cube, selected, with a neutral base so a colour change is unambiguous
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1400);
	const uuid = await page.evaluate(async () => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		const group = await read(S.objectsGroup);
		const camera = await read(S.globalCamera);
		const renderer = await read(S.globalRenderer);
		const scene = await read(S.globalScene);
		const THREE = S.THREE;
		let mesh = null;
		group.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
		if (mesh.material?.color?.setRGB) mesh.material.color.setRGB(1, 1, 1);
		S.objectActions.flyTo(new THREE.Vector3(2.6, 2.0, 3.0), new THREE.Vector3(0, 0.5, 0), 400);
		S.objectActions.selectObject(mesh.uuid);
		const rt = new THREE.WebGLRenderTarget(renderer.domElement.width, renderer.domElement.height);
		window.__e = { mesh, scene, camera, renderer, rt, THREE };
		window.__e.sample = () => {
			const r = renderer, prev = r.getRenderTarget();
			r.setRenderTarget(rt);
			r.render(scene, window.__e.camera);
			r.render(scene, window.__e.camera);
			r.setRenderTarget(prev);
			const v = new THREE.Vector3();
			mesh.getWorldPosition(v); v.project(window.__e.camera);
			const W = rt.width, H = rt.height, s = 20;
			const x = Math.round((v.x * 0.5 + 0.5) * W - s / 2), y = Math.round((v.y * 0.5 + 0.5) * H - s / 2);
			if (x < 0 || y < 0 || x + s > W || y + s > H) return { px: [], onScreen: false };
			const buf = new Uint8Array(s * s * 4);
			r.readRenderTargetPixels(rt, x, y, s, s, buf);
			return { px: Array.from(buf), onScreen: true };
		};
		return mesh.uuid;
	});
	await page.waitForTimeout(1600);

	// ---- 1. the tab is REACHABLE from the UI, then renders --------------------
	// Opening it by setting the store (what this suite used to do) proves the panel
	// works and proves NOTHING about whether a user can get to it — the first build
	// shipped with no entry point at all and every check here still passed.
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1200);
	const addBtn = page.locator('.tab-note', { hasText: '＋' }).first();
	h.check(await addBtn.count() === 1, 'premise — the dock tab strip has its + button');
	await addBtn.click();
	await page.waitForTimeout(500);
	const shaderItem = page.getByRole('menuitem', { name: /Shader editor/ });
	h.check(await shaderItem.count() >= 1, 'the + menu OFFERS Shader editor (this is what was missing)');
	await shaderItem.first().click();
	await page.waitForTimeout(1200);
	await page.waitForTimeout(900);
	h.check(await page.locator('#shader-editor').count() === 1, 'the Shader tab renders in the dock');
	const scopeText = await page.locator('#shader-scope').innerText().catch(() => '');
	h.check(/own material/i.test(scopeText), 'scope follows the SELECTION: "' + scopeText + '"');
	h.check(await page.locator('#shader-empty-state').count() === 1, 'with no graph it shows ONE centred call to action');
	const occupant = await page.evaluate(
		() => new Promise((r) => window.__stores.bottomDock.dockOccupants.subscribe((o) => r(!!o.shader?.present))())
	);
	h.check(occupant, 'and it registers as a dock occupant, so it appears in the tab strip');

	// ---- 2. Create shader, through the BUTTON ---------------------------------
	const before = await page.evaluate(() => window.__e.sample().px);
	await page.locator('#shader-create-btn').click();
	await page.waitForTimeout(1200);
	h.check(await page.locator('#shader-empty-state').count() === 0, 'creating a graph replaces the empty state');
	const nodeCount = await page.locator('#shader-editor .svelte-flow__node').count();
	h.check(nodeCount === 2, 'the starter graph RENDERS its two nodes: ' + nodeCount);
	const edgeCount = await page.locator('#shader-editor .svelte-flow__edge').count();
	h.check(edgeCount === 1, 'and the edge between them: ' + edgeCount);
	const driven = await page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid);
	h.check(driven, 'the object became shader-driven from the UI alone');

	// ---- 3. a param edit in the node card reaches the PICTURE ----------------
	const colourInput = page.locator('#shader-editor input[type="color"]').first();
	h.check(await colourInput.count() === 1, 'the Colour node renders a colour input');
	await colourInput.evaluate((el) => {
		el.value = '#1030e0';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(900);
	const after = await page.evaluate(() => window.__e.sample().px);
	const sB = stats(before), sA = stats(after);
	h.check(
		sA.b > sA.r + 8 && sA.b > sB.b - 60,
		'editing the node card drives the OBJECT — r/b ' + sB.r.toFixed(1) + '/' + sB.b.toFixed(1) +
			' -> ' + sA.r.toFixed(1) + '/' + sA.b.toFixed(1) + ' (blue-dominant)'
	);

	// ---- 4. the LEFT PALETTE adds a node ------------------------------------
	h.check(await page.locator('#shader-palette').count() === 1, 'the palette sidebar renders');
	const groups = await page.locator('#shader-palette .shader-palette-group').count();
	h.check(groups >= 3, 'grouped by catalog group: ' + groups + ' groups');
	await page.locator('#shader-palette button', { hasText: 'Fresnel' }).first().click();
	await page.waitForTimeout(900);
	const afterAdd = await page.locator('#shader-editor .svelte-flow__node').count();
	h.check(afterAdd === 3, 'clicking a palette entry adds a node to the canvas: ' + afterAdd);

	// ---- 4b. RIGHT-CLICKING the pane opens the searchable add menu ----------
	const pane = await page.locator('#shader-editor .svelte-flow__pane').first().boundingBox();
	await page.mouse.click(pane.x + pane.width * 0.3, pane.y + pane.height * 0.75, { button: 'right' });
	await page.waitForTimeout(500);
	h.check((await page.locator('.ctx-filter-input').count()) >= 1, 'the pane menu carries the shared search filter');
	const rows = await page.getByRole('menuitem').count();
	h.check(rows >= 4, 'and the catalog GROUPS as submenu rows: ' + rows);
	await page.locator('.ctx-filter-input').first().fill('poster');
	await page.waitForTimeout(500);
	const matches = await page.locator('.ctx-match').count();
	h.check(matches >= 1, 'typing filters the flattened catalog: ' + matches + ' match(es) for poster');
	await page.locator('.ctx-match').first().click();
	await page.waitForTimeout(900);
	const afterMenuAdd = await page.locator('#shader-editor .svelte-flow__node').count();
	h.check(afterMenuAdd === 4, 'picking a match adds that node: ' + afterMenuAdd);

	// ---- 4c. a WIRE can be removed (right-click -> Disconnect) --------------
	const wiresBefore = await page.locator('#shader-editor .svelte-flow__edge').count();
	const wireBox = await page.locator('#shader-editor .svelte-flow__edge').first().boundingBox();
	await page.mouse.click(wireBox.x + wireBox.width / 2, wireBox.y + wireBox.height / 2, { button: 'right' });
	await page.waitForTimeout(500);
	const disconnect = page.getByRole('menuitem', { name: /Disconnect/ });
	h.check((await disconnect.count()) >= 1, 'right-clicking a wire offers Disconnect');
	await disconnect.first().click();
	await page.waitForTimeout(900);
	const wiresAfter = await page.locator('#shader-editor .svelte-flow__edge').count();
	h.check(wiresAfter === wiresBefore - 1, 'and the wire is gone: ' + wiresBefore + ' -> ' + wiresAfter);

	// ---- 5. a compile error is SHOWN, and the object keeps its material -----
	const kept = await page.evaluate((u) => {
		const S = window.__stores.shaderGraph;
		const good = window.__e.sample().px;
		S.setShaderGraphFor(u, {
			nodes: [{ id: 'm1', type: 'mix', data: {} }, { id: 's1', type: 'surface', data: {} }],
			edges: [{ id: 'e1', source: 'm1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
		});
		return good;
	}, uuid);
	await page.waitForTimeout(1000);
	h.check(await page.locator('#shader-errors').count() === 1, 'a broken graph shows an error strip in the tab');
	const errText = await page.locator('#shader-errors').innerText();
	h.check(/needs its "a" input/.test(errText), 'naming the actual problem: "' + errText.trim() + '"');
	const stillGood = stats(await page.evaluate(() => window.__e.sample().px));
	const wasGood = stats(kept);
	h.check(
		Math.abs(stillGood.mean - wasGood.mean) < 3,
		'and the object keeps its last good material while the error stands (' +
			wasGood.mean.toFixed(1) + ' -> ' + stillGood.mean.toFixed(1) + ')'
	);

	// ---- 6. Detach puts it back --------------------------------------------
	await page.locator('#shader-remove').click();
	await page.waitForTimeout(900);
	h.check(await page.locator('#shader-empty-state').count() === 1, 'Detach returns the tab to its empty state');
	const afterDetach = await page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid);
	h.check(!afterDetach, 'and the object is no longer shader-driven');

	// ---- 7. scope follows the SELECTION, with no scope control -------------
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(800);
	const sceneScope = await page.locator('#shader-scope').innerText();
	h.check(/scene default/i.test(sceneScope), 'deselecting switches to the scene shader: "' + sceneScope + '"');
	h.check(
		(await page.locator('#shader-scope-scene').count()) === 0 &&
			(await page.locator('#shader-scope-object').count()) === 0,
		'and there is NO scope control to get wrong — the selection is the control'
	);
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), uuid);
	await page.waitForTimeout(800);
	const backToObject = await page.locator('#shader-scope').innerText();
	h.check(/own material/i.test(backToObject), 'reselecting the object switches back: "' + backToObject + '"');

	// ---- 8. the properties sidebar ---------------------------------------
	h.check((await page.locator('#shader-props').count()) === 1, 'the properties sidebar renders');
	h.check(
		(await page.locator('#shader-props-graph').count()) === 1,
		'with NO node selected it shows the GRAPH settings (edges / background / grid / minimap)'
	);
	h.check(
		(await page.locator('#shader-props-graph select').count()) >= 2,
		'including the edge-style and background controls'
	);

	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors (a mount crash would be invisible to store checks): ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
