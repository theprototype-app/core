// 26-F phase 2 — THE DECIMATION WORKER, and a reduction you can take back.
//
// A reduction is a quality judgement made on the user's behalf, so three things have to
// be true of it and are asserted here, in the order it matters:
//  1. it runs OFF the main thread — a frozen tab is what roadmap 26 exists to prevent.
//     The Worker's own clock is compared with the longest task the PAGE saw meanwhile,
//     and frames keep coming while it works;
//  2. what it produces is still the model: the triangle target is met, the vertex
//     buffer shrinks with it, the shape stays inside the reported error, uvs and normals
//     survive, a soup is welded first, a skinned mesh is left alone, and a texture above
//     the ceiling is drawn down on the SAME Texture (its sampler state untouched);
//  3. it is REVERSIBLE within the session, and it reaches peers and a saved file as what
//     it is: peers get the reduced geometry and the `reduced` stamp, Restore original
//     brings the full model back at the same uuid on both peers as ONE undo step, undo
//     returns the reduced one, and a .tpscene round trip keeps the reduced geometry.
const h = require('./helpers.cjs');

/** Poll until `predicate` holds and hand back the last reading (h.eventually only checks).
 * @param {() => Promise<any>} fn @param {(v: any) => boolean} predicate @param {string} label */
async function waitFor(fn, predicate, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last));
	h.check(false, label);
	return last;
}

/** In-page helpers, installed on every page. */
const install = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		window.__glbOf = async (/** @type {any} */ object, /** @type {string} */ name) => {
			const glb = await new Promise((resolve, reject) =>
				new s.GLTFExporterModule.GLTFExporter().parse(object, resolve, reject, { binary: true })
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
		/** triangles + the reduced stamp of one object, or null when absent */
		window.__probe = (/** @type {string} */ uuid) => {
			const o = window.__group().getObjectByProperty('uuid', uuid);
			if (!o) return null;
			let count = 0;
			o.traverse((/** @type {any} */ x) => {
				if (x.uuid === uuid) count++;
			});
			const cost = s.importBudget.modelCost(o);
			return { triangles: cost.triangles, vertices: cost.vertices, reduced: o.userData?.reduced ?? null, sameUuid: count, name: o.name };
		};
		window.__undoDepth = () => {
			let stack = [];
			s.history.undoStack.subscribe((/** @type {any} */ v) => (stack = v))();
			return stack.length;
		};
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await install(A.page);

	// ---- 1. off the main thread ----------------------------------------------
	const off = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		// 1.2M triangles: the scan-sized case. Built BEFORE the clock starts — building it
		// is the fixture's cost, not the reduction's.
		const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 775, 775), new THREE.MeshStandardMaterial());
		const root = new THREE.Group();
		root.add(mesh);
		await new Promise((r) => setTimeout(r, 300));
		/** @type {number[]} */
		const tasks = [];
		const observer = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) tasks.push(e.duration);
		});
		observer.observe({ entryTypes: ['longtask'] });
		let frames = 0;
		let running = true;
		let lastAt = 0;
		let maxGap = 0;
		const tick = (/** @type {number} */ at) => {
			frames++;
			if (lastAt) maxGap = Math.max(maxGap, at - lastAt);
			lastAt = at;
			if (running) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		const started = performance.now();
		const report = await s.decimate.reduceModel(root, { room: 120000 });
		const wall = performance.now() - started;
		// one more frame before stopping, so a stall that ENDS with the reduction is
		// measured (the frame after it is the one that says how long the page was stuck)
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		running = false;
		await new Promise((r) => setTimeout(r, 100));
		// entries are delivered asynchronously: take what is queued before disconnecting,
		// or a long task that just ended is never seen (the first version read 0ms even
		// with the simplifier run on the main thread)
		for (const e of observer.takeRecords()) tasks.push(e.duration);
		observer.disconnect();
		return { report, wall, frames, maxGap, longest: tasks.reduce((m, t) => Math.max(m, t), 0) };
	});
	h.check(off.report.trianglesBefore > 1100000 && off.report.trianglesAfter <= 120000, `a ${off.report.trianglesBefore}-triangle model reduced to ${off.report.trianglesAfter} (target 120000)`);
	h.check(off.report.workerMs > 150, `the simplification ran for ${off.report.workerMs}ms — in the Worker`);
	h.check(
		off.maxGap < 150 && off.longest < 150,
		`…while the page never stalled: longest gap between frames ${Math.round(off.maxGap)}ms, longest task ${Math.round(off.longest)}ms (main-thread work ${off.report.mainMs}ms: copying arrays out and building geometry back)`
	);
	h.check(off.frames >= Math.floor(off.wall / 50), `frames kept coming: ${off.frames} in ${Math.round(off.wall)}ms`);

	// ---- 2. what comes back is still the model ------------------------------
	const shape = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const mesh = window.__sphere(200000);
		mesh.geometry.userData.__topo = { counts: [1], tris: [0] };
		const root = new THREE.Group();
		root.add(mesh);
		const uuid = mesh.uuid;
		const geoBefore = mesh.geometry;
		const report = await s.decimate.reduceModel(root, { room: 50000 });
		const g = mesh.geometry;
		let worst = 0;
		const p = g.attributes.position;
		for (let i = 0; i < p.count; i++) worst = Math.max(worst, Math.abs(1 - Math.hypot(p.getX(i), p.getY(i), p.getZ(i))));
		g.computeBoundingBox();
		const size = new THREE.Vector3();
		g.boundingBox.getSize(size);
		return {
			report,
			sameMesh: mesh.uuid === uuid,
			newGeometry: g !== geoBefore,
			attrs: Object.keys(g.attributes).sort().join(','),
			indexed: !!g.index,
			worst,
			size: [size.x, size.y, size.z],
			topo: g.userData.__topo ?? null
		};
	});
	h.check(shape.report.trianglesAfter <= 50000 && shape.report.trianglesAfter > 45000, `200k -> ${shape.report.trianglesAfter} triangles (target 50000)`);
	h.check(shape.report.verticesAfter < shape.report.verticesBefore / 3, `the vertex buffer shrank with it (${shape.report.verticesBefore} -> ${shape.report.verticesAfter})`);
	h.check(shape.sameMesh && shape.newGeometry, 'the SAME mesh (uuid kept) carries a new geometry');
	h.check(shape.attrs === 'normal,position,uv' && shape.indexed, `normals and uvs survive (${shape.attrs})`);
	h.check(shape.worst < 1e-4 && shape.size.every((d) => Math.abs(d - 2) < 0.02), `the shape holds: every vertex on the sphere (worst ${shape.worst.toExponential(1)}), bounds ${shape.size.map((d) => d.toFixed(3)).join('x')}`);
	h.check(shape.report.error > 0 && shape.report.error <= 0.05, `the error it introduced is REPORTED (${(shape.report.error * 100).toFixed(3)}% of the size)`);
	h.check(shape.topo === null, 'the stored face partition is dropped — it indexed triangles that no longer exist');

	const soup = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const g = new THREE.SphereGeometry(1, 120, 60).toNonIndexed();
		g.deleteAttribute('uv');
		const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
		const root = new THREE.Group();
		root.add(mesh);
		const report = await s.decimate.reduceModel(root, { room: 3000 });
		return { report, normals: !!mesh.geometry.attributes.normal };
	});
	h.check(soup.report.trianglesAfter <= 3000 && soup.normals, `a triangle SOUP is welded first and reduces (${soup.report.trianglesBefore} -> ${soup.report.trianglesAfter}), normals rebuilt`);

	const skinned = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const geo = new THREE.SphereGeometry(1, 80, 40);
		const n = geo.attributes.position.count;
		geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
		geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).fill(0.25), 4));
		const bone = new THREE.Bone();
		const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
		mesh.add(bone);
		mesh.bind(new THREE.Skeleton([bone]));
		const root = new THREE.Group();
		root.add(mesh);
		const report = await s.decimate.reduceModel(root, { room: 100 });
		return { report, untouched: mesh.geometry === geo };
	});
	h.check(skinned.untouched && skinned.report.skipped.length === 1 && /skinned/.test(skinned.report.skipped[0].why), `a skinned mesh is left alone and SAYS so ("${skinned.report.skipped[0]?.why}")`);

	const texture = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const canvas = document.createElement('canvas');
		canvas.width = 5000;
		canvas.height = 8;
		canvas.getContext('2d').fillRect(0, 0, 5000, 8);
		const map = new THREE.CanvasTexture(canvas);
		map.flipY = false;
		map.wrapS = THREE.RepeatWrapping;
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map }));
		const root = new THREE.Group();
		root.add(mesh);
		const report = await s.decimate.reduceModel(root, { textureCap: 4096 });
		return { report, same: mesh.material.map === map, width: map.image.width, flipY: map.flipY, wrap: map.wrapS === THREE.RepeatWrapping };
	});
	h.check(texture.width === 4096 && texture.report.texturesScaled === 1, `a 5000px texture is drawn down to ${texture.width}px`);
	h.check(texture.same && texture.flipY === false && texture.wrap, 'on the SAME Texture object — flipY and wrap untouched');

	// ---- 3. reversible, replicated, persisted ---------------------------------
	const B = await h.setupPage(browser, 'B');
	await install(B.page);
	await h.connect(A, B);

	const placed = await A.page.evaluate(async () => {
		const s = window.__stores;
		const file = await window.__glbOf(window.__sphere(30000), 'scan');
		const before = window.__undoDepth();
		const uuid = await s.fileHandler.importFile(file, 'scan', 'glb', [0, 1, 0], undefined, { reduce: { room: 6000 } });
		s.selectedObjects.set([]);
		let last = null;
		s.fileHandler.lastReduction.subscribe((/** @type {any} */ v) => (last = v))();
		return { uuid, probe: window.__probe(uuid), undo: window.__undoDepth() - before, held: s.decimate.hasOriginal(uuid), last };
	});
	h.check(!!placed.uuid && placed.probe.triangles <= 6000, `the reduced import is placed (${placed.probe?.triangles} triangles, from ${placed.probe?.reduced?.trianglesBefore})`);
	h.check(placed.probe.reduced?.trianglesAfter === placed.probe.triangles && placed.probe.reduced.error >= 0, 'the root carries a `reduced` stamp saying what was done');
	h.check(placed.undo === 1 && placed.held, 'one ordinary create entry, and the original file is RETAINED for Restore');
	h.check(placed.last?.uuid === placed.uuid && placed.last.stillOver === false, 'the report says the reduced model now fits');

	const onB = await waitFor(() => B.page.evaluate((u) => window.__probe(u), placed.uuid), (p) => !!p && p.triangles > 0, 'the reduced model reaches B', 20000);
	h.check(onB?.triangles === placed.probe.triangles, `B receives the REDUCED geometry (${onB?.triangles} triangles)`);
	h.check(onB?.reduced?.trianglesBefore === placed.probe.reduced.trianglesBefore, 'and the stamp rides the ordinary sync (GLTF extras)');

	// a .tpscene round trip on A keeps the reduced geometry (sessions use toJSON)
	const saved = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('reduced-roundtrip');
		await s.sessions.applySession(payload, { backup: false, replicate: false });
		await new Promise((r) => setTimeout(r, 800));
		return window.__probe(uuid);
	}, placed.uuid);
	h.check(saved?.triangles === placed.probe.triangles && !!saved?.reduced, `a saved scene reopens with the reduced geometry and its stamp (${saved?.triangles})`);

	const restored = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		const before = window.__undoDepth();
		const ok = await s.fileHandler.restoreOriginalImport(uuid);
		s.selectedObjects.set([]);
		return { ok, probe: window.__probe(uuid), undo: window.__undoDepth() - before };
	}, placed.uuid);
	h.check(restored.ok && restored.probe.triangles === placed.probe.reduced.trianglesBefore, `Restore original brings back all ${restored.probe?.triangles} triangles`);
	h.check(restored.probe.sameUuid === 1 && restored.probe.reduced === null && restored.probe.name === 'scan', 'at the SAME uuid, exactly once, with no `reduced` stamp and the same name');
	h.check(restored.undo === 1, 'as ONE undo step');
	const bRestored = await waitFor(
		() => B.page.evaluate((u) => window.__probe(u), placed.uuid),
		(p) => p?.triangles === restored.probe.triangles,
		'B follows the restore',
		20000
	);
	h.check(bRestored?.sameUuid === 1, `B holds the original, once (${bRestored?.triangles} triangles)`);

	const undone = await A.page.evaluate(async (uuid) => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 500));
		return window.__probe(uuid);
	}, placed.uuid);
	h.check(undone?.triangles === placed.probe.triangles && undone.sameUuid === 1, `Ctrl+Z puts the reduced model back (${undone?.triangles})`);
	const bUndone = await waitFor(
		() => B.page.evaluate((u) => window.__probe(u), placed.uuid),
		(p) => p?.triangles === placed.probe.triangles,
		'B follows the undo',
		20000
	);
	h.check(bUndone?.sameUuid === 1, 'and so does B, with one object at that uuid');
	if (bUndone?.sameUuid !== 1)
		console.log('  B holds: ' + JSON.stringify(await B.page.evaluate(() => window.__group().children.map((/** @type {any} */ c) => [c.name, c.uuid.slice(0, 8), c.type]))));

	const again = await A.page.evaluate(async (uuid) => {
		const ok = await window.__stores.fileHandler.restoreOriginalImport(uuid);
		return { ok, probe: window.__probe(uuid) };
	}, placed.uuid);
	h.check(again.ok && again.probe.triangles === restored.probe.triangles, 'after an undo, Restore works again (the original is still held)');

	// a model past history's 5MB SNAPSHOT ceiling: the create/delete kinds could not hold
	// it, the importswap kind holds the live objects, so the restore is undoable anyway
	const big = await A.page.evaluate(async () => {
		const s = window.__stores;
		const file = await window.__glbOf(window.__sphere(80000), 'huge');
		const uuid = await s.fileHandler.importFile(file, 'huge', 'glb', [4, 1, 0], undefined, { reduce: { room: 60000 } });
		s.selectedObjects.set([]);
		const tooBig = !s.history.captureObjectSnapshot(window.__group().getObjectByProperty('uuid', uuid), true);
		const before = window.__undoDepth();
		const ok = await s.fileHandler.restoreOriginalImport(uuid);
		const restored = window.__probe(uuid);
		s.history.undo();
		await new Promise((r) => setTimeout(r, 300));
		return { tooBig, ok, undo: window.__undoDepth() - before, restored, back: window.__probe(uuid) };
	});
	h.check(big.tooBig, 'premise: the reduced model is past the create/delete snapshot ceiling');
	h.check(big.ok && big.restored.triangles > big.back.triangles && big.back.sameUuid === 1, `…and its restore is STILL one undoable step (${big.back.triangles} -> ${big.restored.triangles} -> ${big.back.triangles})`);

	const missing = await A.page.evaluate(() => window.__stores.fileHandler.restoreOriginalImport('no-such-uuid'));
	h.check(missing === false, 'a restore with no retained original refuses, and says so');

	// the retention ceiling: the newest is kept, the oldest go
	const lru = await A.page.evaluate(() => {
		const f = window.__stores.decimate;
		const big = 100 * 1024 * 1024;
		f.retainOriginal('lru-1', { file: null, extension: 'glb', name: '1', bytes: big });
		f.retainOriginal('lru-2', { file: null, extension: 'glb', name: '2', bytes: big });
		f.retainOriginal('lru-3', { file: null, extension: 'glb', name: '3', bytes: big });
		return [f.hasOriginal('lru-1'), f.hasOriginal('lru-2'), f.hasOriginal('lru-3')];
	});
	h.check(lru[0] === false && lru[1] && lru[2], `retained originals stay under 256MB, oldest first (${lru.join(',')})`);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors: ' + [...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 2).join(' | '));
	await h.finish(browser);
});
