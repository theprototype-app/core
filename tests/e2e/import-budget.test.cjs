// 26-F phase 1 — THE IMPORT BUDGET (roadmap 26 section 4, Stage 2's import bullet).
//
// A model file went from the file dialog straight into the scene. The wire gate asks
// before a 4,000-object scene lands; ONE model is one object, so a 2.4M-triangle scan
// passed every gate that existed. What a model costs is triangles, draw calls and
// texture bytes, all knowable the moment the loader returns — before a frame has drawn
// it, a peer has been sent it or an undo entry exists.
//
// What is asserted, in the order it matters:
//  1. the verdict, which is PURE and decides everything downstream — incl. the rule
//     that an already-heavy scene does not ask about every small thing dropped into it;
//  2. the prediction is in the METER's unit: a real 200k-triangle import moves the
//     measured per-frame triangle count by what the verdict said it would (26-E's
//     "a 200k GLB is 400k triangles a frame" is the case the budget is designed on);
//  3. the gate through the REAL import path: a model that crosses the budget asks in
//     the app's one confirm dialog, Cancel leaves the scene byte-identical (no object,
//     no undo entry), Load anyway places it, and a model within budget never asks.
const h = require('./helpers.cjs');

/** Count objectsGroup nodes. */
const objectCount = (page) =>
	page.evaluate(() => {
		let n = 0;
		let group;
		window.__stores.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
		group?.traverse?.((/** @type {any} */ o) => {
			if (o !== group) n++;
		});
		return n;
	});

/** Install the in-page fixture builders once. */
const installFixtures = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		/** a GLB File from a THREE object — the exact bytes a user would drop */
		window.__glbOf = async (/** @type {any} */ object, /** @type {string} */ name) => {
			const glb = await new Promise((resolve, reject) =>
				new s.GLTFExporterModule.GLTFExporter().parse(object, resolve, reject, { binary: true })
			);
			return new File([/** @type {any} */ (glb)], name + '.glb', { type: 'model/gltf-binary' });
		};
		/** a UV sphere of about `tris` triangles */
		window.__sphere = (/** @type {number} */ tris) => {
			const hSeg = Math.max(4, Math.round(Math.sqrt(tris / 2)));
			const wSeg = Math.max(4, Math.round(tris / (2 * (hSeg - 1))));
			return new THREE.Mesh(new THREE.SphereGeometry(1, wSeg, hSeg), new THREE.MeshStandardMaterial({ color: 0x8899aa }));
		};
		/**
		 * `tris` triangles of scene LOAD with no rendering cost: an InstancedMesh of boxes
		 * whose instance matrices are all ZERO, so every vertex lands on the origin and the
		 * GPU rasterises nothing. The budget walk counts it exactly like real content,
		 * which is what lets a suite put a scene at the edge of red without a GPU that can
		 * actually draw 8M triangles. Added straight to objectsGroup — this is a local
		 * fixture, not a replicated create.
		 */
		window.__loadScene = (/** @type {number} */ tris, /** @type {string} */ name) => {
			const geo = new THREE.BoxGeometry(1, 1, 1);
			const count = Math.round(tris / 12);
			const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), count);
			const zero = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
			for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zero);
			mesh.castShadow = false;
			mesh.name = name;
			let group;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
			group.add(mesh);
			return mesh.uuid;
		};
		window.__removeNamed = (/** @type {string} */ name) => {
			let group;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
			for (const o of [...group.children]) if (o.name === name) group.remove(o);
		};
		window.__undoDepth = () => {
			let stack = [];
			s.history.undoStack.subscribe((/** @type {any} */ v) => (stack = v))();
			return stack.length;
		};
		window.__dialog = () => {
			let d = null;
			s.confirmDialog.confirmDialog.subscribe((/** @type {any} */ v) => (d = v))();
			return d ? { title: d.title, message: d.message, choices: (d.choices ?? []).map((/** @type {any} */ c) => c.value) } : null;
		};
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await installFixtures(A.page);

	// ---- 1. the verdict ------------------------------------------------------
	const v = await A.page.evaluate(() => {
		const { importVerdict, emptyCost, RENDER_PASSES } = window.__stores.importBudget;
		/** @param {any} over */
		const c = (over) => ({ ...emptyCost(), ...over });
		// 26-E's measured case: a 200k-triangle sphere GLB, 100,806 vertices, one mesh
		const model200k = c({ meshes: 1, triangles: 199710, vertices: 100806, draws: 1, maxMeshVertices: 100806, maxMeshTriangles: 199710 });
		const scan = c({ meshes: 1, triangles: 2400000, vertices: 1200000, draws: 1, maxMeshVertices: 1200000, maxMeshTriangles: 2400000 });
		const cube = c({ meshes: 1, triangles: 12, vertices: 24, draws: 1, maxMeshVertices: 24, maxMeshTriangles: 12 });
		const mid = c({ meshes: 1, triangles: 150000, vertices: 76000, draws: 1, maxMeshVertices: 76000, maxMeshTriangles: 150000 });
		const heavyScene = c({ meshes: 40, triangles: 3900000, draws: 40 }); // 7.8M a frame: amber
		const redScene = c({ meshes: 40, triangles: 4200000, draws: 40 }); // 8.4M a frame: red
		const texture = c({ meshes: 1, triangles: 12, draws: 1, textures: 1, maxTextureSize: 8192, textureBytes: 8192 * 8192 * 4 * (4 / 3) });
		const manyMeshes = c({ meshes: 2400, triangles: 28800, draws: 2400, maxMeshVertices: 24 });
		const empty = emptyCost();
		const pick = (/** @type {any} */ r) => ({ gate: r.gate, reducible: r.reducible, asking: r.asking.map((/** @type {any} */ a) => a.key), tri: r.rows.find((/** @type {any} */ x) => x.key === 'triangles') });
		return {
			passes: RENDER_PASSES,
			desk200k: pick(importVerdict(empty, model200k, 'desktop')),
			vr200k: pick(importVerdict(empty, model200k, 'vr')),
			scan: pick(importVerdict(empty, scan, 'desktop')),
			crossing: pick(importVerdict(heavyScene, mid, 'desktop')),
			cubeIntoAmber: pick(importVerdict(heavyScene, cube, 'desktop')),
			cubeIntoRed: pick(importVerdict(redScene, cube, 'desktop')),
			midIntoRed: pick(importVerdict(redScene, mid, 'desktop')),
			scanIntoRed: pick(importVerdict(redScene, scan, 'desktop')),
			texture: pick(importVerdict(empty, texture, 'desktop')),
			calls: pick(importVerdict(empty, manyMeshes, 'desktop')),
			nonsense: pick(importVerdict(/** @type {any} */ (null), /** @type {any} */ ({ triangles: NaN }), 'desktop'))
		};
	});
	h.check(v.passes === 2, 'a mesh is predicted at TWO draws a frame (26-E: the shadow pass draws it again)');
	h.check(v.desk200k.tri.incoming === 399420, `a 200k-triangle model predicts ${v.desk200k.tri.incoming} triangles a frame — 26-E measured 400k`);
	h.check(v.desk200k.gate === false, 'on a desktop one 200k-triangle model is green and does not ask (26-E: 60fps at 30x that)');
	h.check(
		v.vr200k.gate === true && v.vr200k.asking.join() === 'meshVertices' && v.vr200k.tri.tier === 'amber',
		`the SAME model asks on a headset (${v.vr200k.asking.join(', ')}): 400k a frame is already amber there and its 100,806-vertex mesh is past the 100k one mesh should hold`
	);
	h.check(v.scan.gate === true && v.scan.reducible === true && v.scan.asking.includes('meshVertices'), `a 2.4M-triangle scan asks on a desktop (${v.scan.asking.join(', ')}) and a reduction can help`);
	h.check(
		v.crossing.gate === true && v.crossing.asking.join() === 'triangles',
		`what is ALREADY here counts: a 150k model is green alone but takes a 7.8M-a-frame scene past 8M, so it asks (${v.crossing.asking.join(', ')})`
	);
	h.check(v.cubeIntoAmber.gate === false, 'a cube into an amber scene does not ask — amber warns, red asks');
	h.check(v.cubeIntoRed.gate === false && v.midIntoRed.gate === false, 'an ALREADY-red scene does not ask about every smaller-than-green model dropped into it');
	h.check(v.scanIntoRed.gate === true, '…but a model that is heavy ON ITS OWN still asks however full the scene is');
	h.check(v.texture.gate === true && v.texture.asking.join() === 'textureSize', `an 8192px texture asks on its own (${v.texture.asking.join(', ')})`);
	h.check(v.calls.gate === true && v.calls.reducible === false, '2,400 meshes ask on draw calls, and decimation is honestly NOT offered for that (it keeps every mesh)');
	h.check(v.nonsense.gate === false && Number.isFinite(v.nonsense.tri.total), 'nonsense input answers finite and quiet, never NaN');

	// ---- 1b. the cost walk on a real tree --------------------------------------
	const walk = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const { modelCost } = s.importBudget;
		const canvas = document.createElement('canvas');
		canvas.width = 256;
		canvas.height = 64;
		const shared = new THREE.CanvasTexture(canvas);
		const sibling = shared.clone(); // a DIFFERENT Texture over the SAME source image
		const root = new THREE.Group();
		const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: shared }));
		const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: sibling, roughnessMap: shared }));
		const geo = new THREE.BoxGeometry();
		geo.clearGroups();
		geo.addGroup(0, 18, 0);
		geo.addGroup(18, 18, 1);
		const multi = new THREE.Mesh(geo, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
		const soup = new THREE.Mesh(new THREE.BoxGeometry().toNonIndexed(), new THREE.MeshStandardMaterial());
		root.add(a, b, multi, soup);
		return modelCost(root);
	});
	h.check(walk.meshes === 4 && walk.triangles === 48, `four boxes (indexed and soup alike) walk to 48 triangles (${walk.triangles})`);
	h.check(walk.draws === 5, `an array material draws once per GROUP: 1+1+2+1 = ${walk.draws}`);
	h.check(walk.textures === 1 && walk.maxTextureSize === 256, `a texture shared by source is charged ONCE (${walk.textures}, ${walk.maxTextureSize}px)`);

	// ---- 2. the prediction is in the meter's unit ------------------------------
	const measureTris = () =>
		A.page.evaluate(async () => {
			const b = window.__stores.sceneBudget;
			await new Promise((r) => setTimeout(r, 1300));
			b.sampleSceneMetrics();
			await new Promise((r) => setTimeout(r, 700));
			return b.sampleSceneMetrics().triangles;
		});
	const before = await measureTris();
	const placed = await A.page.evaluate(async () => {
		const s = window.__stores;
		const file = await window.__glbOf(window.__sphere(200000), 'dense');
		const uuid = await s.fileHandler.importFile(file, 'dense', 'glb', [0, 1, 0]);
		s.selectedObjects.set([]);
		let verdict = null;
		s.importGate.lastImportVerdict.subscribe((/** @type {any} */ x) => (verdict = x))();
		return { uuid, predicted: verdict?.rows.find((/** @type {any} */ r) => r.key === 'triangles')?.incoming, gate: verdict?.gate, dialog: window.__dialog() };
	});
	const after = await measureTris();
	const measured = after - before;
	h.check(!!placed.uuid && placed.gate === false && !placed.dialog, 'a 200k-triangle GLB on a desktop imports without a word');
	h.check(
		before != null && Math.abs(measured - placed.predicted) / placed.predicted < 0.1,
		`the renderer AGREES with the prediction: predicted ${placed.predicted} a frame, measured +${measured} (${before} -> ${after})`
	);

	// ---- 3. the gate through the real import path ----------------------------
	// Take the scene to 7.98M triangles a frame (amber) with a zero-cost fixture, so a
	// 20k model is what crosses into red — the "what is already here counts" case. Small
	// on purpose: history refuses to snapshot an object over 5MB, and the undo checks
	// below would pass vacuously on a model too big to be recorded at all.
	await A.page.evaluate(() => {
		window.__removeNamed('dense');
		window.__loadScene(3990000, 'load-fixture');
	});
	const objectsBefore = await objectCount(A.page);
	const undoBefore = await A.page.evaluate(() => window.__undoDepth());
	await A.page.evaluate(async () => {
		window.__pending = window.__glbOf(window.__sphere(20000), 'crossing').then((file) =>
			window.__stores.fileHandler.importFile(file, 'crossing', 'glb', [3, 1, 0])
		);
	});
	await h.eventually(() => A.page.evaluate(() => window.__dialog()), (d) => !!d, 'the crossing import opens the dialog', 15000);
	const asked = await A.page.evaluate(() => window.__dialog());
	h.check(asked.title === 'This model is heavy', `the ask is the app's ONE confirm dialog ("${asked.title}")`);
	h.check(/"crossing" is 20k triangles/.test(asked.message) && /above the 8M recommended/.test(asked.message), 'it says what the model costs and which ceiling it crosses: ' + asked.message.slice(0, 160));
	h.check(asked.choices.includes('load'), `Load anyway is offered (${asked.choices.join(', ')})`);
	h.check((await objectCount(A.page)) === objectsBefore, 'while the question is open NOTHING is in the scene yet');
	await A.page.locator('#confirm-dialog-cancel').click();
	const cancelled = await A.page.evaluate(() => window.__pending);
	await A.page.waitForTimeout(300);
	h.check(cancelled === null, 'Cancel resolves the import with nothing placed');
	h.check((await objectCount(A.page)) === objectsBefore, 'Cancel leaves the scene with exactly the objects it had');
	h.check((await A.page.evaluate(() => window.__undoDepth())) === undoBefore, 'Cancel records no undo entry');

	await A.page.evaluate(async () => {
		window.__pending = window.__glbOf(window.__sphere(20000), 'crossing').then((file) =>
			window.__stores.fileHandler.importFile(file, 'crossing', 'glb', [3, 1, 0])
		);
	});
	await h.eventually(() => A.page.evaluate(() => window.__dialog()), (d) => !!d, 'the second crossing import asks again', 15000);
	await A.page.locator('#confirm-dialog-load').click();
	const loaded = await A.page.evaluate(() => window.__pending);
	await A.page.waitForTimeout(300);
	h.check(typeof loaded === 'string' && (await objectCount(A.page)) > objectsBefore, 'Load anyway places the model as it is');
	const undoAfter = await A.page.evaluate(() => window.__undoDepth());
	h.check(undoAfter === undoBefore + 1, `and records the ordinary ONE create entry (${undoBefore} -> ${undoAfter})`);

	// a cube into the same (now red) scene: no ask — the already-heavy rule, end to end
	const cube = await A.page.evaluate(async () => {
		const THREE = window.__stores.THREE;
		const file = await window.__glbOf(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'cube');
		const uuid = await window.__stores.fileHandler.importFile(file, 'cube', 'glb', [5, 1, 0]);
		return { uuid, dialog: window.__dialog() };
	});
	h.check(!!cube.uuid && !cube.dialog, 'a cube dropped into an already-red scene is placed without asking');

	// a texture past the single-texture ceiling asks on an otherwise empty budget
	await A.page.evaluate(() => {
		window.__removeNamed('load-fixture');
		window.__removeNamed('crossing');
	});
	await A.page.evaluate(async () => {
		const THREE = window.__stores.THREE;
		const canvas = document.createElement('canvas');
		canvas.width = 5000;
		canvas.height = 8;
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#c05030';
		ctx.fillRect(0, 0, 5000, 8);
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(canvas) }));
		const file = await window.__glbOf(mesh, 'banner');
		window.__pending = window.__stores.fileHandler.importFile(file, 'banner', 'glb', [0, 1, 3]);
	});
	await h.eventually(() => A.page.evaluate(() => window.__dialog()), (d) => !!d, 'the wide-texture import asks', 15000);
	const tex = await A.page.evaluate(() => window.__dialog());
	h.check(/5000px texture, above the 4096px/.test(tex.message), 'the texture ceiling is named in its own words: ' + tex.message.slice(0, 140));
	await A.page.locator('#confirm-dialog-cancel').click();
	h.check((await A.page.evaluate(() => window.__pending)) === null, 'and Cancel refuses it too');

	h.check(h.pageErrors(A).length === 0, 'no page errors: ' + h.pageErrors(A).slice(0, 2).join(' | '));
	await h.finish(browser);
});
