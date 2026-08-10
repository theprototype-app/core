// Roadmap #17 batch D3 — BVH-accelerated viewport picking.
//
// `Mesh.prototype.raycast` is globally replaced by three-mesh-bvh's accelerated
// version, which uses a per-geometry bounds tree WHEN ONE EXISTS and otherwise
// runs three's original code. So the only thing that can go wrong is a tree that
// disagrees with the brute-force walk, or a STALE tree after the geometry
// changed. Both are what this suite pins down:
//
//  * PARITY: the same rays, with and without a tree, must return the same
//    object, hit POINT and distance (what selection consumes), and the same
//    faceIndex for rays landing inside a triangle — the mesh tools'
//    Face/Triangle/Shell granularity is keyed off faceIndex.
//    Measured caveat, deliberately not asserted: a ray that lands exactly on a
//    shared vertex/edge (a UV sphere's seam, an axis-aligned ray at the equator)
//    can be attributed to either of the touching triangles. Both paths return
//    the IDENTICAL point and distance there, they just name a different face.
//    That is why the fan below is jittered off the symmetry axes, and why the
//    seam ray gets its own point-only check.
//  * STALENESS: an in-place vertex edit (a sculpt stroke bumps the position
//    attribute's version) must invalidate the tree, and the object of a live
//    edit session must not carry one at all.
const h = require('./helpers.cjs');

/** cast a fan of rays at the target and report what each one hit */
const castFan = (page, uuid) =>
	page.evaluate((uuid) => {
		const THREE = window.__stores.THREE;
		const group = window.__bvh.group;
		const object = group.getObjectByProperty('uuid', uuid);
		const raycaster = new THREE.Raycaster();
		const out = [];
		for (let i = 0; i < 24; i++) {
			// jittered by irrational-ish steps so no ray lands on the sphere's
			// seam/pole or an axis — those hit a SHARED vertex, where either
			// touching triangle is a legitimate answer (see the header note)
			const angle = (i + 0.37) * 0.2617993877;
			const origin = new THREE.Vector3(
				Math.cos(angle) * 6.137,
				0.41 * Math.sin(i * 0.7 + 0.23),
				Math.sin(angle) * 5.911
			);
			const target = new THREE.Vector3(0.013, 0.021, -0.017).add(object.position);
			const direction = new THREE.Vector3().subVectors(target, origin).normalize();
			raycaster.set(origin, direction);
			const hit = raycaster.intersectObject(object, true)[0];
			out.push(
				hit
					? {
							face: hit.faceIndex,
							d: Number(hit.distance.toFixed(6)),
							p: hit.point.toArray().map((n) => Number(n.toFixed(6))),
							uuid: hit.object.uuid
						}
					: null
			);
		}
		return out;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.bvhPicking, { timeout: 20000 });

	// a HIGH-poly mesh (past the build threshold) and a low-poly one
	const built = await A.page.evaluate(async () => {
		const w = window.__stores;
		const THREE = w.THREE;
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		window.__bvh = { group };
		const dense = new THREE.Mesh(
			new THREE.SphereGeometry(1, 64, 64), // ~8k triangles
			new THREE.MeshStandardMaterial({ color: 0x3366ff })
		);
		dense.name = 'DenseSphere';
		dense.position.set(0, 0, 0);
		group.add(dense);
		const simple = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		simple.name = 'SimpleBox';
		simple.position.set(5, 0, 0);
		group.add(simple);
		w.objectsGroup.update((v) => v);
		window.__bvh.dense = dense.uuid;
		window.__bvh.simple = simple.uuid;
		return {
			denseTris: dense.geometry.index.count / 3,
			simpleTris: simple.geometry.attributes.position.count / 3
		};
	});
	h.check(built.denseTris > 1000, `a dense mesh is in the scene (${built.denseTris} triangles)`);

	// ---------- baseline: no trees yet, so this IS three's own raycast ----------
	const before = await castFan(A.page, await A.page.evaluate(() => window.__bvh.dense));
	const hitCount = before.filter(Boolean).length;
	h.check(hitCount > 8, `the ray fan hits the mesh (${hitCount}/24 rays)`);

	// ---------- build trees ----------
	const trees = await A.page.evaluate(() => {
		const w = window.__stores;
		w.bvhPicking.ensureBoundsTrees(window.__bvh.group, []);
		const dense = window.__bvh.group.getObjectByProperty('uuid', window.__bvh.dense);
		const simple = window.__bvh.group.getObjectByProperty('uuid', window.__bvh.simple);
		return {
			dense: !!dense.geometry.boundsTree,
			simple: !!simple.geometry.boundsTree,
			debug: w.bvhPicking.bvhDebug()
		};
	});
	// PREMISE: without a tree the parity check below would compare stock-vs-stock
	h.check(trees.dense, 'the dense mesh got a bounds tree');
	h.check(trees.debug.built >= 1, `the module reports the build (${trees.debug.built})`);
	h.check(!trees.simple, 'a 12-triangle box is left alone (below the threshold)');

	// ---------- PARITY: same rays, same answers ----------
	const after = await castFan(A.page, await A.page.evaluate(() => window.__bvh.dense));
	let mismatches = 0;
	let pointMismatches = 0;
	let firstMismatch = '';
	for (let i = 0; i < before.length; i++) {
		const a = before[i];
		const b = after[i];
		const sameHit =
			(a === null && b === null) ||
			(a &&
				b &&
				a.uuid === b.uuid &&
				Math.abs(a.d - b.d) < 1e-6 &&
				a.p.every((n, axis) => Math.abs(n - b.p[axis]) < 1e-6));
		if (!sameHit) pointMismatches++;
		const sameFace = (a === null && b === null) || (a && b && a.face === b.face);
		if (!sameHit || !sameFace) {
			mismatches++;
			if (!firstMismatch) firstMismatch = `ray ${i}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
		}
	}
	h.check(pointMismatches === 0, `BVH returns the same object + point + distance on all 24 rays (${pointMismatches} off)`);
	h.check(mismatches === 0, `and the same faceIndex, which the mesh tools key off (${firstMismatch})`);

	// the degenerate case the header documents: a ray straight down an axis into
	// the sphere's seam vertex. faceIndex may differ; the POINT must not.
	const seam = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const dense = window.__bvh.group.getObjectByProperty('uuid', window.__bvh.dense);
		const raycaster = new THREE.Raycaster();
		const read = () => {
			raycaster.set(new THREE.Vector3(6, 0, 0), new THREE.Vector3(-1, 0, 0));
			const hit = raycaster.intersectObject(dense, true)[0];
			return hit ? { face: hit.faceIndex, p: hit.point.toArray().map((n) => +n.toFixed(6)) } : null;
		};
		const withTree = read();
		dense.geometry.disposeBoundsTree();
		const stock = read();
		window.__stores.bvhPicking.ensureBoundsTrees(window.__bvh.group, []); // put it back
		return { withTree, stock };
	});
	h.check(
		!!seam.withTree &&
			!!seam.stock &&
			seam.withTree.p.every((n, axis) => Math.abs(n - seam.stock.p[axis]) < 1e-6),
		`a seam-vertex ray lands on the same POINT either way (${JSON.stringify(seam.withTree?.p)} vs ${JSON.stringify(seam.stock?.p)})`
	);

	// ---------- an in-place edit invalidates the tree ----------
	const stale = await A.page.evaluate(() => {
		const w = window.__stores;
		const dense = window.__bvh.group.getObjectByProperty('uuid', window.__bvh.dense);
		const position = dense.geometry.attributes.position;
		// what a sculpt stroke / vertex drag does: move verts, flag the attribute
		for (let i = 0; i < position.count; i++) position.setY(i, position.getY(i) + 2);
		position.needsUpdate = true;
		dense.geometry.computeBoundingSphere();
		const rebuiltBefore = w.bvhPicking.bvhDebug().rebuilt;
		w.bvhPicking.ensureBoundsTrees(window.__bvh.group, []);
		return { rebuiltBefore, rebuiltAfter: w.bvhPicking.bvhDebug().rebuilt };
	});
	h.check(
		stale.rebuiltAfter === stale.rebuiltBefore + 1,
		`an in-place vertex edit rebuilds the tree (${stale.rebuiltBefore} -> ${stale.rebuiltAfter})`
	);
	// and the picks still agree with the stock walk on the MOVED geometry
	const movedWith = await castFan(A.page, await A.page.evaluate(() => window.__bvh.dense));
	const movedWithout = await A.page.evaluate(async () => {
		const dense = window.__bvh.group.getObjectByProperty('uuid', window.__bvh.dense);
		dense.geometry.disposeBoundsTree();
		return true;
	});
	h.check(movedWithout === true, 'tree disposed for the second half of the A/B');
	const movedStock = await castFan(A.page, await A.page.evaluate(() => window.__bvh.dense));
	let movedMismatch = 0;
	for (let i = 0; i < movedStock.length; i++) {
		const a = movedStock[i];
		const b = movedWith[i];
		const same =
			(a === null && b === null) || (a && b && a.face === b.face && Math.abs(a.d - b.d) < 1e-6);
		if (!same) movedMismatch++;
	}
	h.check(movedMismatch === 0, `the rebuilt tree still matches the stock walk (${movedMismatch} off)`);

	// ---------- a live edit session carries no tree ----------
	const session = await A.page.evaluate(() => {
		const w = window.__stores;
		w.bvhPicking.ensureBoundsTrees(window.__bvh.group, []);
		const dense = window.__bvh.group.getObjectByProperty('uuid', window.__bvh.dense);
		const hadTree = !!dense.geometry.boundsTree;
		// the same call the viewport makes while a mesh is being edited
		w.bvhPicking.ensureBoundsTrees(window.__bvh.group, [window.__bvh.dense]);
		return { hadTree, keptTree: !!dense.geometry.boundsTree };
	});
	h.check(session.hadTree, 'the mesh had a tree before the session started');
	h.check(!session.keptTree, 'entering an edit session drops it (its geometry changes per frame)');

	// ---------- the real click path still selects the mesh ----------
	await A.page.evaluate(() => {
		const w = window.__stores;
		const dense = window.__bvh.group.getObjectByProperty('uuid', window.__bvh.dense);
		dense.position.set(0, 0, 0);
		w.objectActions.deselectObject();
		w.bvhPicking.ensureBoundsTrees(window.__bvh.group, []);
	});
	await A.page.waitForTimeout(400);
	const screen = await h.projectPoint(A.page, [0, 1, 0]); // the sphere's top
	const errors = [];
	A.page.on('pageerror', (e) => errors.push(String(e)));
	await A.page.mouse.click(screen.x, screen.y);
	await A.page.waitForTimeout(500);
	const picked = await A.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObject.subscribe((v) => r(v?.uuid))())
	);
	const denseUuid = await A.page.evaluate(() => window.__bvh.dense);
	h.check(picked === denseUuid, 'a real viewport click selects the BVH-accelerated mesh');
	h.check(errors.length === 0, `no page errors during the click (${errors[0] ?? 'none'})`);

	await h.finish(browser);
});
