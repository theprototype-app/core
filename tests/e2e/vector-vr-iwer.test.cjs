// Roadmap 64 D1 — vector shapes in VR, on IWER (the app's own XR path, a Quest 3 emulated):
//  1 Add ▸ Shapes ▸ Star (the radial's registry entry) puts a star 2 m ahead, upright, facing you
//  2 Selected ▸ Extrude steps the depth (flat -> 10 cm): a solid with side walls, one undo entry, a peer sees it
//  3 the grip holds the extruded star like any object: aim, squeeze, carry, release — it moves, the
//    move is one undo entry, and the desktop peer sees it land
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const info = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					if (!o) return resolve(null);
					o.updateMatrixWorld(true);
					o.geometry.computeBoundingBox();
					const b = o.geometry.boundingBox;
					resolve({
						depth: o.userData.geometryParams?.params?.depth ?? 0,
						zExtent: b.max.z - b.min.z,
						pos: o.getWorldPosition(o.position.clone()).toArray(),
						verts: o.geometry.attributes.position.count
					});
				})();
			}),
		uuid
	);
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	h.check(await iwer.installed(A.page), 'IWER owns navigator.xr');
	await iwer.enter(A.page);
	h.check((await iwer.state(A.page)).presenting, 'the session presents');

	// ---- 1 Add ▸ Shapes ▸ Star ------------------------------------------------
	const entries = await A.page.evaluate(() => ({
		add: window.__stores.vrRadialMenu.ringEntries('add').map((e) => e.id),
		shapes: window.__stores.vrRadialMenu.ringEntries('vecshapes').map((e) => e.id)
	}));
	h.check(entries.add.includes('nav:vecshapes') && entries.shapes.length === 4, 'the Add ring has Shapes ▸ with four shapes');
	let depth = await undoDepth(A.page);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('vec:add:star'));
	await iwer.frames(A.page, 4);
	const star = await A.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.userData?.geometryParams?.gtype === 'Vector' ? o.uuid : null))())
	);
	h.check(!!star, 'Shapes ▸ Star placed (and selected) a vector star');
	h.check((await undoDepth(A.page)) === depth + 1, 'placing it is one undo entry');
	const placed = await info(A.page, star);
	const head = (await iwer.controllerWorld(A.page)).head.pos;
	h.check(placed && Math.abs(Math.hypot(placed.pos[0] - head[0], placed.pos[2] - head[2]) - 2) < 0.3, `it stands about 2 m ahead (${placed?.pos.map((v) => v.toFixed(2))})`);
	await h.eventually(() => info(B.page, star), (s) => !!s, 'B sees the star');

	// ---- 2 Selected ▸ Extrude ------------------------------------------------------
	const ring = await A.page.evaluate(() => window.__stores.vrRadialMenu.ringEntries('object').map((e) => e.id));
	h.check(ring.includes('vec:extrude'), 'the Selected ring offers Extrude for a vector shape');
	depth = await undoDepth(A.page);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('vec:extrude'));
	await iwer.frames(A.page, 3);
	const solid = await info(A.page, star);
	h.check(Math.abs(solid.depth - 0.1) < 1e-9 && solid.zExtent > 0.099 && solid.verts > placed.verts, `Extrude makes a 10 cm solid with side walls (z extent ${solid.zExtent.toFixed(3)})`);
	h.check((await undoDepth(A.page)) === depth + 1, 'the extrude is one undo entry');
	await h.eventually(() => info(B.page, star), (s) => Math.abs((s?.depth ?? 0) - 0.1) < 1e-9 && s.zExtent > 0.099, 'B sees the extruded solid');

	// ---- 3 grab it ---------------------------------------------------------------
	// aim the right controller from 0.6 m short of the star straight at it
	const from = [placed.pos[0], placed.pos[1], placed.pos[2]];
	const dir = [from[0] - head[0], from[2] - head[2]];
	const len = Math.hypot(dir[0], dir[1]);
	const hand = [from[0] - (dir[0] / len) * 0.6, from[1], from[2] - (dir[1] / len) * 0.6];
	const yaw = Math.atan2(-dir[0], -dir[1]);
	await iwer.pose(A.page, 'right', hand, { yaw, pitch: 0 });
	await iwer.frames(A.page, 4);
	depth = await undoDepth(A.page);
	await iwer.button(A.page, 'right', 'squeeze', 1);
	await iwer.frames(A.page, 4);
	const held = await A.page.evaluate(() => window.__stores.vrControls.vrGrabbedUuids());
	h.check(held.includes(star), 'the grip holds the extruded star');
	await iwer.pose(A.page, 'right', [hand[0] + 0.5, hand[1] + 0.2, hand[2]], { yaw, pitch: 0 });
	await iwer.frames(A.page, 8);
	await iwer.button(A.page, 'right', 'squeeze', 0);
	await iwer.frames(A.page, 4);
	const moved = await info(A.page, star);
	h.check(near(moved.pos, [placed.pos[0] + 0.5, placed.pos[1] + 0.2, placed.pos[2]], 0.12), `carrying the hand carries the star (+0.5 x, +0.2 y: ${moved.pos.map((v) => v.toFixed(2))})`);
	h.check((await undoDepth(A.page)) === depth + 1, 'the carry is one undo entry');
	await h.eventually(() => info(B.page, star), (s) => !!s && near(s.pos, moved.pos, 0.02), 'B sees the star where the hand left it');

	await h.finish(browser);
});
