// Roadmap 64 D5 (lane 64-vector-edit) row 5 — THE PEN BY VR LASER, on IWER (a Quest 3 emulated; the real
// Quest row is the int's preview check):
//  1 Add ▸ Shapes ▸ Pen arms the laser pen: a work plane 1.5 m ahead, upright, facing you
//  2 the trigger aimed at the plane places points there (one haptic tick each, the right hand); held and
//    pulled it drags out a smooth point's handle; the trigger on the first point closes the path ->
//    ONE create entry, a desktop peer sees the closed shape
//  3 the grip carries the plane: the next path is drawn where the hand put the plane
//  4 Finish path (radial) ends an open path; Pen off removes the plane; with the pen off the trigger is
//    the ordinary trigger again (no point, no shape)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const laser = (page) => page.evaluate(() => window.__stores.vectorVR.laserPenDebug());
const vectors = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const out = {};
					g.traverse((o) => {
						if (o.userData?.geometryParams?.gtype !== 'Vector') return;
						o.updateMatrixWorld(true);
						out[o.uuid] = { params: JSON.parse(JSON.stringify(o.userData.geometryParams.params)), pos: o.getWorldPosition(o.position.clone()).toArray() };
					});
					r(out);
				})()
			)
	);
/** rotate v by quaternion q = [x, y, z, w] */
const rot = (q, v) => {
	const [x, y, z, w] = q;
	const ix = w * v[0] + y * v[2] - z * v[1];
	const iy = w * v[1] + z * v[0] - x * v[2];
	const iz = w * v[2] + x * v[1] - y * v[0];
	const iw = -x * v[0] - y * v[1] - z * v[2];
	return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
/** a plane point (x, y) -> world */
const onPlane = (st, x, y) => {
	const r = rot(st.quat, [x, y, 0]);
	return [st.origin[0] + r[0], st.origin[1] + r[1], st.origin[2] + r[2]];
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await iwer.enter(A.page);
	h.check((await iwer.state(A.page)).presenting, 'the session presents');
	const hand = [0.25, 1.2, -0.1];
	/** aim the right controller from `hand` at a world point */
	const aimAt = async (p) => {
		const d = [p[0] - hand[0], p[1] - hand[1], p[2] - hand[2]];
		await iwer.pose(A.page, 'right', hand, { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) });
		await iwer.frames(A.page, 3);
	};

	// ---- 1 arm ---------------------------------------------------------------------------------------
	const ring = await A.page.evaluate(() => window.__stores.vrRadialMenu.ringEntries('vecshapes').map((e) => e.id));
	h.check(ring.includes('vec:pen'), 'Add ▸ Shapes offers Pen');
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('vec:pen'));
	for (let i = 0; i < 40 && !(await laser(A.page).catch(() => ({}))).active; i++) await iwer.frames(A.page, 2);
	let st = await laser(A.page);
	h.check(st.active, 'the laser pen is armed');
	const head = (await iwer.controllerWorld(A.page)).head.pos;
	const n = rot(st.quat, [0, 0, 1]);
	h.check(Math.abs(Math.hypot(st.origin[0] - head[0], st.origin[2] - head[2]) - 1.5) < 0.2 && Math.abs(n[1]) < 1e-6, `a work plane 1.5 m ahead, upright (${st.origin.map((v) => v.toFixed(2))})`);
	h.check(n[0] * (head[0] - st.origin[0]) + n[2] * (head[2] - st.origin[2]) > 0, '...facing you');
	const root = await A.page.evaluate(() => window.__stores.vrRadialMenu.ringEntries('root').map((e) => e.id));
	h.check(['vec:pen-finish', 'vec:pen-undo', 'vec:pen-off'].every((id) => root.includes(id)), 'the radial offers Finish path / Undo point / Pen off while armed');

	// ---- 2 three points (the second a pulled handle), then close on the first -------------------------
	const pts = [[-0.4, -0.2], [0, 0.3], [0.4, -0.2]];
	const ticks0 = (await A.page.evaluate(() => window.__stores.vrControls.hapticDebug())).pulses.length;
	await aimAt(onPlane(st, ...pts[0]));
	await iwer.tap(A.page, 'right', 'trigger');
	await aimAt(onPlane(st, ...pts[1]));
	await iwer.button(A.page, 'right', 'trigger', 1);
	await iwer.frames(A.page, 3);
	await aimAt(onPlane(st, pts[1][0] + 0.15, pts[1][1]));
	await iwer.frames(A.page, 3);
	await iwer.button(A.page, 'right', 'trigger', 0);
	await iwer.frames(A.page, 3);
	await aimAt(onPlane(st, ...pts[2]));
	await iwer.tap(A.page, 'right', 'trigger');
	st = await laser(A.page);
	h.check(st.points === 3, `three trigger presses place three points (${st.points})`);
	h.check(st.nodes.every((p, i) => Math.hypot(p.x - pts[i][0], p.y - pts[i][1]) < 0.03), 'each point lies where the laser met the plane');
	h.check(st.nodes[1].smooth && Math.abs(st.nodes[1].ox - 0.15) < 0.04, `holding the trigger and pulling drags out a smooth handle (${st.nodes[1].ox.toFixed(2)} m)`);
	h.check(st.ticks === 3, `one tick per point (${st.ticks})`);
	const pulses = (await A.page.evaluate(() => window.__stores.vrControls.hapticDebug())).pulses.slice(ticks0);
	h.check(pulses.length === 3 && pulses.every((p) => p.hand === 'right'), `...felt on the drawing hand (${pulses.map((p) => p.hand).join(',')})`);
	const before = Object.keys(await vectors(A.page));
	const depth = await undoDepth(A.page);
	await aimAt(onPlane(st, pts[0][0] + 0.01, pts[0][1]));
	await iwer.tap(A.page, 'right', 'trigger');
	const now = await vectors(A.page);
	const made = Object.keys(now).find((u) => !before.includes(u));
	h.check(!!made && now[made].params.paths[0].closed && now[made].params.paths[0].nodes.length === 3, 'the trigger on the first point closes the path into a shape');
	h.check((await undoDepth(A.page)) === depth + 1, 'the laser-drawn shape is ONE create entry');
	h.check(!(await A.page.evaluate(() => new Promise((r) => window.__stores.selectedObjects.subscribe((s) => r(s.length))()))), 'the presses selected nothing behind the plane');
	await h.eventually(() => vectors(B.page), (m) => m[made]?.params.paths[0].closed === true, 'B sees the laser-drawn shape');

	// ---- 3 the grip carries the plane -----------------------------------------------------------------
	st = await laser(A.page);
	const o0 = st.origin;
	await iwer.pose(A.page, 'right', hand, { yaw: 0, pitch: 0 });
	await iwer.frames(A.page, 2);
	await iwer.button(A.page, 'right', 'squeeze', 1);
	await iwer.frames(A.page, 3);
	await iwer.pose(A.page, 'right', [hand[0] + 0.5, hand[1] + 0.3, hand[2]], { yaw: 0, pitch: 0 });
	await iwer.frames(A.page, 4);
	await iwer.button(A.page, 'right', 'squeeze', 0);
	await iwer.frames(A.page, 3);
	st = await laser(A.page);
	h.check(Math.abs(st.origin[0] - o0[0] - 0.5) < 0.03 && Math.abs(st.origin[1] - o0[1] - 0.3) < 0.03, `the grip carries the plane with the hand (+${(st.origin[0] - o0[0]).toFixed(2)} x, +${(st.origin[1] - o0[1]).toFixed(2)} y)`);
	h.check(!(await A.page.evaluate(() => window.__stores.vrControls.vrGrabbedUuids())).length, '...and grabbed no object');

	// ---- 4 an open path by Finish, then Pen off -------------------------------------------------------
	await aimAt(onPlane(st, -0.3, 0));
	await iwer.tap(A.page, 'right', 'trigger');
	await aimAt(onPlane(st, 0.3, 0.1));
	await iwer.tap(A.page, 'right', 'trigger');
	const two = await laser(A.page);
	h.check(two.points === 2, `two presses on the carried plane place two points (${two.points})`);
	if (two.points !== 2) console.log('  laser diag: ' + JSON.stringify({ st, two, menu: await A.page.evaluate(() => new Promise((r) => window.__stores.vrMenuOpen?.subscribe?.((v) => r(v))?.() ?? r('n/a'))) }));
	const before2 = Object.keys(await vectors(A.page));
	const ran = await A.page.evaluate(() => {
		try {
			window.__stores.vrControls.executeVRMenuAction('vec:pen-finish');
			return 'ok';
		} catch (e) {
			return String(e);
		}
	});
	for (let i = 0; i < 20 && Object.keys(await vectors(A.page)).length === before2.length; i++) await iwer.frames(A.page, 2);
	if (ran !== 'ok') console.log('  finish threw: ' + ran);
	const open = Object.entries(await vectors(A.page)).find(([u]) => !before2.includes(u));
	h.check(!!open && open[1].params.paths[0].closed === false && open[1].params.paths[0].nodes.length === 2, 'Finish path ends an open two-point path');
	h.check(!!open && Math.abs(open[1].pos[0] - st.origin[0]) < 0.35 && Math.abs(open[1].pos[1] - st.origin[1]) < 0.2, '...drawn on the carried plane');
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('vec:pen-off'));
	for (let i = 0; i < 20 && (await laser(A.page)).active; i++) await iwer.frames(A.page, 2);
	h.check(!(await laser(A.page)).active, 'Pen off disarms');
	h.check(!(await A.page.evaluate(() => new Promise((r) => window.__stores.globalScene.subscribe((s) => r(!!s.getObjectByName('vector-work-plane')))()))), '...and the plane is gone');
	const count = Object.keys(await vectors(A.page)).length;
	await aimAt(onPlane(st, 0, 0));
	await iwer.tap(A.page, 'right', 'trigger');
	h.check(Object.keys(await vectors(A.page)).length === count, 'with the pen off the trigger draws nothing');
	h.check(h.pageErrors(A).length === 0, `no page error (${h.pageErrors(A).join(' | ') || 'none'})`);

	await h.finish(browser);
});
