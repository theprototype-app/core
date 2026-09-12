// 24-E3: the Inspector honours an object's origin, and a selection has a pivot-point
// mode. The gizmo already rotated ONE object with `userData.origin` about it; the
// Inspector's numeric rows wrote absolute values and turned a group about its local
// zero — the world centre for a group made by /group or drag-to-group (reported:
// "adjusting origin of group and then rotating objects should rotate them along
// origin not world centre"). Now a single object with an origin goes through the same
// pivot delta the gizmo uses, and a set picks Median / Active / Parent origin /
// Individual origins (the group's origin is also one right-click away).
const h = require('./helpers.cjs');

const worldOf = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		if (!o) return null;
		o.updateMatrixWorld(true);
		const p = o.getWorldPosition(new window.__stores.THREE.Vector3());
		return { pos: p.toArray().map((n) => Math.round(n * 1000) / 1000), rotY: Math.round(o.rotation.y * 1000) / 1000, quat: o.quaternion.toArray() };
	}, uuid);
const near = (a, b, eps = 0.02) => a && b && a.every((n, i) => Math.abs(n - b[i]) < eps);
const fmt = (v) => '[' + v.map((n) => n.toFixed(2)).join(', ') + ']';
const HALF_PI = Math.round((Math.PI / 2) * 1000) / 1000;

h.run(async () => {
	const browser = await h.launch();
	// the Transform section is collapsed by default (the object-origin suite's seed)
	const A = await h.setupPage(browser, 'A', { storage: { 'inspector:sec:Transform': 'open' } });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// a /group at the world origin, two cubes dragged into it
	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const group = s.addObjects.spawnAtPoint('/group', null);
		const a = s.addObjects.spawnAtPoint('/create Box 1 1 1', [3, 0, 0]);
		const b = s.addObjects.spawnAtPoint('/create Box 1 1 1', [5, 0, 0]);
		s.objectActions.moveObjectToGroup(a.uuid, group.uuid);
		s.objectActions.moveObjectToGroup(b.uuid, group.uuid);
		s.objectActions.deselectObject();
		return { group: group.uuid, a: a.uuid, b: b.uuid };
	});
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(600);
	const g0 = await worldOf(A.page, ids.group);
	h.check(g0 && near(g0.pos, [0, 0, 0]), `premise: the group sits at the world origin (${fmt(g0.pos)})`);
	await h.eventually(() => worldOf(B.page, ids.b), (w) => !!w && near(w.pos, [5, 0, 0]), 'B has the cubes in the group', 15000);

	// ---- 1. Origin ▸ Centre of children, then a TYPED rotation turns about it --------
	const menu = await A.page.evaluate((u) => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(u);
		const origin = items.find((i) => i.label === 'Origin');
		return origin ? origin.children.map((c) => c.label) : null;
	}, ids.group);
	h.check(!!menu && menu.includes('Centre of children') && menu.includes('World zero'), `the group's context menu has Origin ▸ (${JSON.stringify(menu)})`);
	await A.page.evaluate((u) => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(u);
		items.find((i) => i.label === 'Origin').children.find((c) => c.label === 'Centre of children').action();
		window.__stores.objectActions.selectObject(u, true);
	}, ids.group);
	await A.page.waitForSelector('#inspector-rotation .dn-input', { timeout: 15000 });
	await A.page.waitForTimeout(300);
	const originAt = await A.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return window.__stores.objectOrigin.originWorld(g.getObjectByProperty('uuid', u)).toArray(); }, ids.group);
	h.check(near(originAt, [4, 0, 0]), `the origin is at the centre of the children (${fmt(originAt)})`);
	const seated = await A.page.evaluate(() => { let c; window.__stores.TControls.subscribe((x) => (c = x))(); return c?.object?.userData?.isMultiPivot ? c.object.position.toArray() : null; });
	h.check(!!seated && near(seated, [4, 0, 0]), `selecting the group seats the pivot on that origin (${seated ? fmt(seated) : 'none'})`);
	// type Y = 90 into the Inspector's rotation row (the angle field takes degrees)
	const yRow = A.page.locator('#inspector-rotation .dn-input').nth(1);
	await yRow.click();
	await yRow.fill('90');
	await A.page.waitForTimeout(800); // the gesture seals after 500ms
	let a = await worldOf(A.page, ids.a);
	let b = await worldOf(A.page, ids.b);
	let g = await worldOf(A.page, ids.group);
	h.check(Math.abs(g.rotY - HALF_PI) < 0.01, `the group's own rotation reads 90° (${g.rotY})`);
	h.check(near(a.pos, [4, 0, 1]) && near(b.pos, [4, 0, -1]), `the cubes turned about x=4, not the world centre: ${fmt(a.pos)} / ${fmt(b.pos)}`);
	h.check(near(g.pos, [0, 0, 0]) === false, `...so the group's position moved with the orbit (${fmt(g.pos)})`);
	await h.eventually(() => Promise.all([worldOf(B.page, ids.a), worldOf(B.page, ids.b)]), ([x, y]) => !!x && !!y && near(x.pos, [4, 0, 1]) && near(y.pos, [4, 0, -1]), 'peer B agrees', 15000);
	// one undo step puts the pose back
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	a = await worldOf(A.page, ids.a);
	g = await worldOf(A.page, ids.group);
	h.check(near(a.pos, [3, 0, 0]) && Math.abs(g.rotY) < 0.01 && near(g.pos, [0, 0, 0]), `undo restores the pose in one step (${fmt(a.pos)}, rot ${g.rotY})`);

	// ---- 2. two cubes, Pivot = Parent origin: the set turns about the group's origin ---
	await A.page.evaluate(({ a, b }) => {
		const s = window.__stores;
		s.objectActions.selectObject(a, true);
		s.objectActions.selectObject(b, false, true);
		s.multiTransform.pivotMode.set('parent');
	}, ids);
	await A.page.waitForTimeout(400);
	const available = await A.page.evaluate(() => window.__stores.multiTransform.pivotParentAvailable());
	h.check(available, 'Parent origin is available (the cubes share the group)');
	const pivotAt = await A.page.evaluate(() => { let c; window.__stores.TControls.subscribe((x) => (c = x))(); return c?.object?.userData?.isMultiPivot ? c.object.position.toArray() : null; });
	h.check(!!pivotAt && near(pivotAt, [4, 0, 0]), `the pivot sits on the parent's origin (${pivotAt ? fmt(pivotAt) : 'none'})`);
	h.check(await A.page.evaluate(() => !!document.querySelector('#pivot-mode')), 'the Inspector shows the Pivot dropdown for a set');
	const pivotMenu = await A.page.evaluate((u) => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(u);
		const p = items.find((i) => i.label === 'Pivot point');
		return p ? p.children.map((c) => c.label + (c.checked ? '✓' : '') + (c.disabled ? '✗' : '')) : null;
	}, ids.a);
	h.check(!!pivotMenu && pivotMenu.includes('Parent origin✓'), `the selection menu has Pivot point ▸ (${JSON.stringify(pivotMenu)})`);
	// the gizmo path: a 90° turn of the pivot
	await A.page.evaluate(() => window.__stores.multiTransform.applyPivotTransform((p) => { p.rotation.y = Math.PI / 2; }));
	await A.page.waitForTimeout(400);
	a = await worldOf(A.page, ids.a);
	b = await worldOf(A.page, ids.b);
	g = await worldOf(A.page, ids.group);
	h.check(near(a.pos, [4, 0, 1]) && near(b.pos, [4, 0, -1]) && Math.abs(g.rotY) < 0.01, `Parent origin: the cubes orbit x=4 inside an unrotated group: ${fmt(a.pos)} / ${fmt(b.pos)}, group rot ${g.rotY}`);
	await h.eventually(() => worldOf(B.page, ids.a), (w) => !!w && near(w.pos, [4, 0, 1]), 'peer B sees the orbited cubes', 15000);

	// ---- 3. Pivot = Individual origins: each cube turns in place -----------------------
	await A.page.evaluate(() => window.__stores.multiTransform.pivotMode.set('individual'));
	await A.page.waitForTimeout(300);
	const beforeA = await worldOf(A.page, ids.a);
	const beforeB = await worldOf(A.page, ids.b);
	await A.page.evaluate(() => window.__stores.multiTransform.applyPivotTransform((p) => { p.rotation.y = Math.PI / 2; }));
	await A.page.waitForTimeout(400);
	a = await worldOf(A.page, ids.a);
	b = await worldOf(A.page, ids.b);
	h.check(near(a.pos, beforeA.pos) && near(b.pos, beforeB.pos), `Individual origins: positions unchanged (${fmt(a.pos)} / ${fmt(b.pos)})`);
	// the ANGLE between the poses (an Euler Y read wraps: a 180° yaw decomposes as X=π, Y=0, Z=π)
	const turned = await A.page.evaluate(({ qa0, qa1, qb0, qb1 }) => {
		const T = window.__stores.THREE;
		const angle = (p, q) => new T.Quaternion().fromArray(p).angleTo(new T.Quaternion().fromArray(q));
		return [angle(qa0, qa1), angle(qb0, qb1)];
	}, { qa0: beforeA.quat, qa1: a.quat, qb0: beforeB.quat, qb1: b.quat });
	h.check(turned.every((t) => Math.abs(t - Math.PI / 2) < 0.02), `...and each cube turned 90° about itself (${turned.map((t) => t.toFixed(3)).join(', ')} rad)`);

	// ---- 4. Median is the default again for a fresh selection elsewhere ----------------
	await A.page.evaluate(() => window.__stores.multiTransform.pivotMode.set('median'));
	await A.page.waitForTimeout(300);
	const median = await A.page.evaluate(() => { let c; window.__stores.TControls.subscribe((x) => (c = x))(); return c?.object?.position?.toArray() ?? null; });
	h.check(!!median && near(median, [4, 0, 0], 0.05), `Median re-seats at the centroid (${median ? fmt(median) : 'none'})`);

	await h.finish(browser);
});
