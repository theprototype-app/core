// 26-F phase 3 — ONE STORY: the oversized import offers Reduce / Load anyway / Cancel.
//
// The reduction is a quality judgement made on the user's behalf, so it is asserted from
// the user's side of the glass — the dialog and the toast are clicked, never bypassed:
//  1. the Reduce choice lives in the SAME dialog as Load anyway / Cancel, and its label
//     names what it aims at (the triangle count from the same planner that then does it);
//  2. choosing it places a model that now fits, and the report says what was reduced and
//     by how much, with Restore original IN the report — clicking it brings the original
//     back, and Ctrl+Z returns the reduced one;
//  3. the way back outlasts the toast: the object's menu carries "Restore original
//     model" while the original is held, and a peer-side (not held) stamp shows it
//     DISABLED with the reason rather than a button that cannot work;
//  4. the choice is offered only where it can act: a texture-only ask offers texture
//     reduction and leaves the geometry alone, a draw-call ask offers no Reduce at all,
//     and an animated model says in the dialog why it cannot be reduced.
const h = require('./helpers.cjs');

const install = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		window.__glbOf = async (/** @type {any} */ object, /** @type {string} */ name, /** @type {any} */ opts = {}) => {
			const glb = await new Promise((resolve, reject) =>
				new s.GLTFExporterModule.GLTFExporter().parse(object, resolve, reject, { binary: true, ...opts })
			);
			return new File([/** @type {any} */ (glb)], name + '.glb', { type: 'model/gltf-binary' });
		};
		window.__sphere = (/** @type {number} */ tris) => {
			const hSeg = Math.max(4, Math.round(Math.sqrt(tris / 2)));
			const wSeg = Math.max(4, Math.round(tris / (2 * (hSeg - 1))));
			return new THREE.Mesh(new THREE.SphereGeometry(1, wSeg, hSeg), new THREE.MeshStandardMaterial({ color: 0x8899aa }));
		};
		window.__group = () => {
			let g;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return g;
		};
		/** zero-cost scene load (see import-budget): counted by the walk, rasterises nothing */
		window.__loadScene = (/** @type {number} */ tris, /** @type {string} */ name) => {
			const count = Math.round(tris / 12);
			const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), count);
			const zero = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
			for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zero);
			mesh.name = name;
			window.__group().add(mesh);
		};
		window.__removeNamed = (/** @type {string} */ name) => {
			for (const o of [...window.__group().children]) if (o.name === name) window.__group().remove(o);
		};
		window.__probe = (/** @type {string} */ uuid) => {
			const o = window.__group().getObjectByProperty('uuid', uuid);
			if (!o) return null;
			const cost = s.importBudget.modelCost(o);
			return { triangles: cost.triangles, maxTexture: cost.maxTextureSize, reduced: o.userData?.reduced ?? null };
		};
		window.__dialog = () => {
			let d = null;
			s.confirmDialog.confirmDialog.subscribe((/** @type {any} */ v) => (d = v))();
			return d ? { title: d.title, message: d.message, choices: (d.choices ?? []).map((/** @type {any} */ c) => c.value), labels: (d.choices ?? []).map((/** @type {any} */ c) => c.label) } : null;
		};
		window.__toastTexts = () => {
			let list = [];
			s.toastStore.subscribe((/** @type {any} */ v) => (list = v))();
			return list.map((/** @type {any} */ t) => (typeof t === 'string' ? t : t?.text ?? ''));
		};
		window.__import = (/** @type {Promise<File>} */ filePromise, /** @type {string} */ name, /** @type {number[]} */ at) => {
			window.__pending = filePromise.then((file) => s.fileHandler.importFile(file, name, 'glb', at));
		};
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await install(A.page);
	const dialogOpen = (label) => h.eventually(() => A.page.evaluate(() => window.__dialog()), (d) => !!d, label, 15000);

	// ---- 1 + 2. the crossing import: Reduce, the report, Restore, Ctrl+Z ----------
	await A.page.evaluate(() => window.__loadScene(3990000, 'load-fixture'));
	await A.page.evaluate(() => window.__import(window.__glbOf(window.__sphere(20000), 'crossing'), 'crossing', [3, 1, 0]));
	await dialogOpen('the crossing import asks');
	const asked = await A.page.evaluate(() => window.__dialog());
	h.check(asked.choices.join() === 'reduce,load', `ONE dialog, three ways out: ${asked.labels.join(' / ')} / Cancel`);
	const m = asked.labels[0].match(/~([\d.,]+)(k?) triangles/) ?? [];
	const planned = Number(String(m[1] ?? '').replace(/,/g, '')) * (m[2] ? 1000 : 1);
	h.check(planned > 0 && planned < 20000, `the Reduce label names what it aims at: "${asked.labels[0]}"`);
	await A.page.locator('#confirm-dialog-reduce').click();
	const uuid = await A.page.evaluate(() => window.__pending);
	const reduced = await A.page.evaluate((u) => window.__probe(u), uuid);
	h.check(!!uuid && reduced.triangles <= planned * 1.02 && reduced.triangles >= planned * 0.9, `the placed model is what the label promised (${reduced.triangles} for ~${planned})`);
	const after = await A.page.evaluate(() => {
		let v = null;
		window.__stores.fileHandler.lastReduction.subscribe((/** @type {any} */ x) => (v = x))();
		return v;
	});
	h.check(after.stillOver === false, 'the reduced model FITS: re-judged after the reduction, it no longer asks');
	const texts = await A.page.evaluate(() => window.__toastTexts());
	const report = texts.find((t) => t.startsWith('Reduced "crossing"')) ?? '';
	h.check(/20k → [\d.,]+k? triangles \(−\d+%\)/.test(report) && /no point moved more than/.test(report), 'the report says what was reduced and by how much: ' + report);
	h.check(!texts.some((t) => /Reducing "crossing"/.test(t)), 'the "Reducing…" progress card is gone once it is done');
	const restoreButton = A.page.locator('.tp-toast-action', { hasText: 'Restore original' });
	h.check((await restoreButton.count()) === 1, 'Restore original is offered IN the report');
	await restoreButton.click();
	await h.eventually(() => A.page.evaluate((u) => window.__probe(u), uuid), (p) => p?.triangles > 19000, 'clicking it brings the full model back', 15000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	const undone = await A.page.evaluate((u) => window.__probe(u), uuid);
	h.check(undone?.triangles === reduced.triangles, `Ctrl+Z returns the reduced one (${undone?.triangles})`);

	// ---- 3. the way back outlasts the toast -----------------------------------
	const menu = await A.page.evaluate((u) => {
		const s = window.__stores;
		const THREE = s.THREE;
		const find = (/** @type {any[]} */ items) => items.find((i) => i?.label === 'Restore original model');
		const mine = find(s.objectMenu.buildObjectMenuItems(u, { selection: [u] }));
		// a peer's copy: the stamp arrived, the file did not
		const other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		other.userData.reduced = { trianglesBefore: 999, trianglesAfter: 12 };
		window.__group().add(other);
		const peers = find(s.objectMenu.buildObjectMenuItems(other.uuid, { selection: [other.uuid] }));
		const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		window.__group().add(plain);
		const none = find(s.objectMenu.buildObjectMenuItems(plain.uuid, { selection: [plain.uuid] }));
		window.__group().remove(other, plain);
		window.__menuRestore = mine?.action;
		return { mine: mine ? { disabled: !!mine.disabled, tooltip: mine.tooltip } : null, peers: peers ? { disabled: !!peers.disabled, tooltip: peers.tooltip } : null, none: !!none };
	}, uuid);
	h.check(menu.mine && !menu.mine.disabled, `the object menu offers "Restore original model" (${menu.mine?.tooltip})`);
	h.check(menu.peers?.disabled === true && /only by whoever imported it/.test(menu.peers.tooltip), 'a copy whose original is not held shows it DISABLED, with the reason');
	h.check(menu.none === false, 'an object that was never reduced has no such entry');
	await A.page.evaluate(() => window.__menuRestore());
	await h.eventually(() => A.page.evaluate((u) => window.__probe(u), uuid), (p) => p?.triangles > 19000, 'the menu entry restores it too', 15000);

	// ---- 4. offered only where it can act -------------------------------------
	await A.page.evaluate(() => {
		window.__removeNamed('load-fixture');
		window.__removeNamed('crossing');
	});
	await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const canvas = document.createElement('canvas');
		canvas.width = 5000;
		canvas.height = 8;
		canvas.getContext('2d').fillRect(0, 0, 5000, 8);
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(canvas) }));
		window.__import(window.__glbOf(mesh, 'banner'), 'banner', [0, 1, 3]);
	});
	await dialogOpen('the wide-texture import asks');
	const tex = await A.page.evaluate(() => window.__dialog());
	h.check(tex.labels[0] === 'Reduce to 4096px textures', `a texture-only ask offers TEXTURE reduction: "${tex.labels[0]}"`);
	await A.page.locator('#confirm-dialog-reduce').click();
	const banner = await A.page.evaluate(async () => window.__probe(await window.__pending));
	h.check(banner?.maxTexture === 4096 && banner.triangles === 2, `the texture is drawn down (${banner?.maxTexture}px) and the geometry left alone (${banner?.triangles} triangles)`);

	await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const fixture = new THREE.Group();
		fixture.name = 'calls-fixture';
		const geo = new THREE.BoxGeometry();
		const mat = new THREE.MeshBasicMaterial();
		for (let i = 0; i < 2240; i++) {
			const m = new THREE.Mesh(geo, mat);
			m.scale.setScalar(0.0001);
			fixture.add(m);
		}
		window.__group().add(fixture);
		const model = new THREE.Group();
		for (let i = 0; i < 20; i++) model.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
		window.__import(window.__glbOf(model, 'parts'), 'parts', [0, 1, -3]);
	});
	await dialogOpen('twenty more meshes on top of 2,240 asks on draw calls');
	const calls = await A.page.evaluate(() => window.__dialog());
	h.check(calls.choices.join() === 'load' && /draw calls/.test(calls.message), `a draw-call ask offers NO Reduce (${calls.labels.join(', ')}) — decimation keeps every mesh`);
	await A.page.locator('#confirm-dialog-cancel').click();
	await A.page.evaluate(() => window.__removeNamed('calls-fixture'));

	await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const canvas = document.createElement('canvas');
		canvas.width = 5000;
		canvas.height = 8;
		canvas.getContext('2d').fillRect(0, 0, 5000, 8);
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(canvas) }));
		mesh.name = 'spinner';
		const clip = new THREE.AnimationClip('spin', 1, [new THREE.NumberKeyframeTrack('spinner.position[y]', [0, 1], [0, 1])]);
		window.__import(window.__glbOf(mesh, 'spinner', { animations: [clip] }), 'spinner', [2, 1, 2]);
	});
	await dialogOpen('the animated heavy import asks');
	const anim = await A.page.evaluate(() => window.__dialog());
	h.check(anim.choices.join() === 'load' && /animated, so it cannot be reduced/.test(anim.message), 'an animated model is offered no Reduce, and the dialog says WHY: ' + anim.message.slice(-110));
	await A.page.locator('#confirm-dialog-cancel').click();

	h.check(h.pageErrors(A).length === 0, 'no page errors: ' + h.pageErrors(A).slice(0, 2).join(' | '));
	await h.finish(browser);
});
