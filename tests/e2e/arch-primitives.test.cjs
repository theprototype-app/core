// 37 R3 — PARAMETRIC ARCHITECTURE across peers. The shapes themselves are covered in vitest
// (tests/unit/archGeometry.test.js, incl. the rapier doorway + stair proofs); this suite is the
// replicated half: a wall/door/window/stair made on one peer is the same object on the other,
// a param edit travels as params and rebuilds on both, a door's leaf is BUILT on every peer and
// never doubled by a duplicate or a re-sync, the door OPENS on both peers from one click, a late
// joiner sees it open, the Inspector hides rows that do not apply, undo walks a param edit back,
// and the Add menu lands architecture on the 1 m grid.
const h = require('./helpers.cjs');

/** a short read of one arch object (and its parts) on a page @param {any} page @param {string} uuid */
const archInfo = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const o = group?.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		const parts = o.children.filter((c) => c.userData?.archPart);
		const leaf = parts[0];
		const q = leaf ? leaf.quaternion : null;
		return {
			gtype: o.userData.geometryParams?.gtype ?? null,
			params: o.userData.geometryParams?.params ?? null,
			verts: o.geometry.attributes.position.count,
			hint: o.userData.colliderHint ?? null,
			physics: o.userData.physics ?? null,
			parts: parts.map((p) => p.name),
			partBodies: parts.map((p) => p.children.length),
			leafAngle: q ? (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI : null,
			pos: o.position.toArray(),
			behavior: s.packBehavior.behaviorState(uuid),
			registered: s.arch.archPartsDebug().registered.some((r) => r.uuid === uuid)
		};
	}, uuid);

/** run a /create on a page and return the new object's uuid @param {any} page @param {string} cmd */
const create = (page, cmd) =>
	page.evaluate(async (cmd) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(cmd);
		await new Promise((r) => setTimeout(r, 300));
		let sel;
		s.selectedObject.subscribe((v) => (sel = v))();
		return sel?.uuid ?? null;
	}, cmd);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ============================================================ 1. a wall with a door
	const wall = await create(A.page, '/create Wall 4 2.8 0.2 1');
	h.check(!!wall, 'A: /create Wall made an object');
	await A.page.waitForTimeout(1200);
	const wa = await archInfo(A.page, wall);
	const wb = await archInfo(B.page, wall);
	h.check(wa?.gtype === 'Wall' && wa.params.doors === 1, `A: it is a Wall with one door (${JSON.stringify(wa?.params)})`);
	h.check(wa?.hint === 'trimesh', 'A: a wall takes the exact (trimesh) collider hint');
	h.check(!!wb && wb.gtype === 'Wall' && wb.verts === wa.verts, `B: the same wall, same vertex count (${wb?.verts} vs ${wa?.verts})`);
	h.check(!wa.physics, 'a wall is static scenery (no dynamic physics stamp)');

	// ============================================================ 2. a param edit replicates as params
	await A.page.evaluate((uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { length: 6, windows: 2, doors: 999 }), wall);
	await A.page.waitForTimeout(1200);
	const wa2 = await archInfo(A.page, wall);
	const wb2 = await archInfo(B.page, wall);
	h.check(wa2.params.length === 6 && wa2.params.windows === 2, 'A: the wall is 6 m with two windows');
	h.check(wa2.params.doors === 6, `an out-of-range value is STORED clamped (doors 999 -> ${wa2.params.doors})`);
	h.check(wb2.params.length === 6 && wb2.verts === wa2.verts, `B: rebuilt from the params to the same geometry (${wb2.verts} vs ${wa2.verts})`);

	// ============================================================ 3. undo walks the edit back on both
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(1200);
	const wa3 = await archInfo(A.page, wall);
	const wb3 = await archInfo(B.page, wall);
	h.check(wa3.params.length === 4 && wa3.params.windows === 0, `A: undo restores the 4 m wall (${wa3.params.length})`);
	h.check(wb3.params.length === 4 && wb3.verts === wa3.verts, 'B: and so does the peer');

	// ============================================================ 4. the Inspector hides what does not apply
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.objectActions.selectObject(uuid, true);
	}, wall);
	await A.page.waitForTimeout(800);
	const rows = async () =>
		A.page.evaluate(() => document.querySelector('#inspector-geometry')?.textContent ?? '');
	const withDoor = await rows();
	h.check(withDoor.includes('Door width') && !withDoor.includes('Win width'), 'Inspector: a wall with a door shows Door width, hides the window rows');
	await A.page.evaluate((uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { doors: 0, windows: 1 }), wall);
	await A.page.waitForTimeout(800);
	const withWindow = await A.page.evaluate(() => document.querySelector('#inspector-geometry')?.textContent ?? '');
	h.check(!withWindow.includes('Door width') && withWindow.includes('Win width'), 'Inspector: with no door the door rows go and the window rows come');

	// ============================================================ 5. a door: leaf built on every peer
	const door = await A.page.evaluate(async () => {
		const s = window.__stores;
		const object = s.addObjects.spawnAtPoint('/create Door 1 2.1 0', [0.4, 0, -2.6]);
		return object?.uuid ?? null;
	});
	await A.page.waitForTimeout(1500);
	const da = await archInfo(A.page, door);
	const db = await archInfo(B.page, door);
	h.check(JSON.stringify(da?.pos) === JSON.stringify([0, 0, -3]), `Add menu: the door lands on the 1 m grid ([0.4,0,-2.6] -> ${JSON.stringify(da?.pos)})`);
	h.check(JSON.stringify(db?.pos) === JSON.stringify([0, 0, -3]), 'B: at the same grid point');
	h.check(da?.parts.length === 1 && da.parts[0] === 'DoorLeafL', `A: one leaf on a hinge pivot (${da?.parts})`);
	h.check(db?.parts.length === 1, `B: the peer BUILT its own leaf (${db?.parts})`);
	h.check(da.registered && db.registered, 'both peers registered the door with the behaviour runtime');
	h.check(da.physics?.collider === 'custom' && da.physics.__behaviorFrame, 'the frame collider is the 33 slab collider with the doorway cut out');

	// ============================================================ 6. reconcile is idempotent; a duplicate does not double the leaf
	await A.page.evaluate(() => {
		for (let i = 0; i < 5; i++) window.__stores.pokeScene();
	});
	await A.page.waitForTimeout(400);
	h.check((await archInfo(A.page, door)).parts.length === 1, 'five scene pokes later there is still exactly one leaf');
	const dup = await A.page.evaluate((uuid) => window.__stores.objectActions.duplicateObject(uuid)?.uuid ?? null, door);
	await A.page.waitForTimeout(1500);
	const dupA = dup ? await archInfo(A.page, dup) : null;
	const dupB = dup ? await archInfo(B.page, dup) : null;
	h.check(!!dupA && dupA.parts.length === 1 && dupA.registered, `A: the duplicate carries ONE rebuilt leaf, registered (${dupA?.parts})`);
	h.check(!!dupB && dupB.parts.length === 1 && dupB.registered, `B: the arriving duplicate too (${dupB?.parts})`);

	// ============================================================ 7. one click opens it on both peers
	h.check((await archInfo(A.page, door)).leafAngle < 1, 'Edit: the leaf rests shut');
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await B.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.evaluate(() => window.__stores.selectedObjects.set([]));
	await A.page.waitForTimeout(500);
	const pt = await h.projectPoint(A.page, [0.1, 1.2, -3]);
	await A.page.mouse.click(pt.x, pt.y);
	await A.page.waitForTimeout(2000);
	const oa = await archInfo(A.page, door);
	const ob = await archInfo(B.page, door);
	h.check(oa.behavior?.on === true, `A: the click opened the door (${JSON.stringify(oa.behavior)}, last click ${JSON.stringify(await A.page.evaluate(() => window.__stores.packBehavior.packBehaviorDebug().lastClick))})`);
	h.check(ob.behavior?.on === true, 'B: the peer heard it (one behavior message)');
	h.check(Math.abs(oa.leafAngle - 95) < 3 && Math.abs(ob.leafAngle - 95) < 3, `both leaves swung to 95° (${oa.leafAngle?.toFixed(1)} / ${ob.leafAngle?.toFixed(1)})`);

	// ============================================================ 8. a late joiner sees it open
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await C.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await h.eventually(() => archInfo(C.page, door), (v) => v?.behavior?.on === true && Math.abs((v.leafAngle ?? 0) - 95) < 3, 'C: the late joiner holds the door OPEN', 15000);
	const oc = await archInfo(C.page, door);
	h.check(oc?.parts?.length === 1, `C: with exactly one leaf after the full sync (${oc?.parts})`);

	// ============================================================ 9. a param edit rebuilds the parts and keeps the runtime
	await A.page.evaluate((uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { leaves: 'double', width: 2 }), door);
	await A.page.waitForTimeout(1500);
	const d2a = await archInfo(A.page, door);
	const d2b = await archInfo(B.page, door);
	h.check(d2a.parts.join() === 'DoorLeafL,DoorLeafR' && d2b.parts.join() === 'DoorLeafL,DoorLeafR', `a double door has two leaves on both peers (${d2a.parts} / ${d2b.parts})`);
	h.check(d2a.registered && d2b.registered && d2a.behavior?.on === true, 'still registered, and still open (the state survives the rebuild)');

	// ============================================================ 10. Edit is the rest pose
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await A.page.waitForTimeout(600);
	h.check((await archInfo(A.page, door)).leafAngle < 1, 'back in Edit the leaf shows its rest pose (the 33 rule)');

	// ============================================================ 11. stairs + windows on both peers
	const stair = await create(A.page, '/create Staircase 3 1 16 0.18');
	const win = await create(A.page, '/create Window 1.2 1.2 0.9 1');
	await A.page.waitForTimeout(1500);
	const sa = await archInfo(A.page, stair);
	const sb = await archInfo(B.page, stair);
	h.check(sa?.params.shape === 'spiral' && sb?.params.shape === 'spiral' && sa.verts === sb.verts, 'a spiral staircase, identical on both peers');
	h.check(sa.hint === 'trimesh', 'stairs take the exact collider (the walker climbs it, see vitest)');
	const wia = await archInfo(A.page, win);
	const wib = await archInfo(B.page, win);
	h.check(wia?.parts[0] === 'WindowSash' && wia.registered && wib?.registered, 'a casement window: a sash on both peers, registered to open');
	await A.page.evaluate((uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { opening: 'fixed' }), win);
	await A.page.waitForTimeout(1200);
	const wfa = await archInfo(A.page, win);
	h.check(!wfa.registered && wfa.parts.length === 1 && !wfa.physics?.__behaviorFrame, 'made fixed: the sash stays, the runtime and its frame collider go');

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${h.pageErrors(A).concat(h.pageErrors(B)).slice(0, 2)})`);
	await h.finish(browser);
});
