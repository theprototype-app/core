// 60 Q1: PLAY HERE IN A HEADSET (IWER — the app's own WebXR path end to end). The radial's
// Tools ▸ Play here switches to Interact (the headset's Play) with the FEET on the surface under the
// head, facing where the head looks — not on the scene's spawn — and Tools ▸ Back to edit (or the mode
// button) puts the viewer, and any world grab they had, back exactly where they were.
//
// IWER's offset reference spaces never reach the XR camera it reports (vr-comfort-iwer's note), so
// the rows read WHAT THE APP APPLIED: every XRRigidTransform the rig moves by is recorded — the
// horizontal move, the lift and the turn of a spawn — and the restore is read as the reference
// space OBJECT itself (Back to edit hands back the very space Edit had).
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const near = (a, b, eps = 0.06) => Math.abs(a - b) < eps;
const mode = (page) => page.evaluate(() => { let v; window.__stores.editorMode.subscribe((x) => (v = x))(); return v; });
const SPY = () => {
	if (window.__rigSpy) return;
	const Orig = window.XRRigidTransform;
	window.__rigSpy = [];
	window.XRRigidTransform = class extends Orig {
		constructor(p, o) {
			super(p, o);
			window.__rigSpy.push({ p: p ? [p.x || 0, p.y || 0, p.z || 0] : [0, 0, 0], yaw: o ? 2 * Math.atan2(o.y || 0, o.w ?? 1) : 0 });
		}
	};
};
/** the offsets applied since the last call: {move (m, horizontal), lift (m), turns: [yaw…]} */
const applied = (page) =>
	page.evaluate(() => {
		const list = window.__rigSpy.splice(0);
		let x = 0, y = 0, z = 0;
		const turns = [];
		for (const r of list) {
			if (Math.abs(r.yaw) > 1e-4) turns.push(+r.yaw.toFixed(3));
			else {
				x += r.p[0];
				y += r.p[1];
				z += r.p[2];
			}
		}
		return { move: +Math.hypot(x, z).toFixed(3), lift: +(-y).toFixed(3), turns, n: list.length };
	});
/** remember the live reference space as `name`, or ask whether it is still that one */
const space = (page, name, op) =>
	page.evaluate(({ name, op }) => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const now = r.xr.getReferenceSpace();
		if (op === 'keep') return !!(window['__space_' + name] = now);
		return now === window['__space_' + name];
	}, { name, op });
const rigPose = (page) =>
	page.evaluate(() => { let r; window.__stores.worldRig.subscribe((x) => (r = x))(); return { p: r.position.toArray(), s: r.scale.x }; });

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript() });
	const P = A.page;
	h.check(await iwer.installed(P), 'premise: IWER owns navigator.xr');

	// a box at (8, _, −6) whose top is 1 m up (below the 1.6 m head)
	await P.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await P.waitForTimeout(500);
	const top = await P.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const b = g.children.at(-1);
		b.scale.set(4, 1, 4);
		b.position.set(8, 0.5, -6);
		b.updateMatrixWorld(true);
		return new s.THREE.Box3().setFromObject(b).max.y;
	});
	// a plain scene: the session starts in Edit; the spawn (which makes it a game) comes after
	await iwer.enter(P);
	await iwer.frames(P, 4);
	h.check((await mode(P)) === 'edit', 'premise: the headset is in Edit');
	await P.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ play: { spawn: { position: [-10, 0, 10], yaw: 0 } } }));
	await P.evaluate(SPY);

	// ---- 1. stand over the box looking half-left, Tools ▸ Play here ---------------------------------
	await iwer.pose(P, 'head', [8, 1.6, -6], { yaw: 0.5 });
	await iwer.frames(P, 4);
	await space(P, 'edit', 'keep');
	await applied(P);
	const entry = await P.evaluate(() => window.__stores.vrRadialMenu.ringEntries('tools').map((e) => e.id));
	h.check(entry.includes('playhere'), `the radial's Tools ring offers Play here (${JSON.stringify(entry)})`);
	await P.evaluate(() => window.__stores.vrControls.executeVRMenuAction('playhere'));
	await iwer.frames(P, 8);
	h.check((await mode(P)) === 'interact', 'Play here switches to Interact');
	const dbg = await P.evaluate(() => window.__stores.playHere.playHereDebug());
	h.check(
		dbg.playing === true && dbg.override && near(dbg.override.position[0], 8) && near(dbg.override.position[2], -6) && near(dbg.override.position[1], top) && near(dbg.override.yaw, 0.5, 0.02),
		`the round's spawn: under the head, on the box top, facing the head (${JSON.stringify(dbg.override)})`
	);
	let a = await applied(P);
	h.check(a.move < 0.05, `...so the player is NOT moved across the world to the spawn (moved ${a.move} m)`);
	h.check(near(a.lift, top, 0.05), `...the feet are lifted onto the box top (lift ${a.lift} m vs ${top.toFixed(2)})`);
	h.check(a.turns.every((t) => Math.abs(t) < 0.02), `...and the view keeps its facing (turns ${JSON.stringify(a.turns)})`);
	h.check(!(await space(P, 'edit', 'same')), 'Interact plays in a moved reference space');

	// ---- 2. Back to edit: the very reference space Edit had --------------------------------------
	h.check(!!(await P.evaluate(() => window.__stores.vrRadialMenu.ringEntries('tools').find((e) => e.id === 'playhere'))), 'the entry stays while the round runs');
	await P.evaluate(() => window.__stores.vrControls.executeVRMenuAction('playhere'));
	await iwer.frames(P, 6);
	h.check((await mode(P)) === 'edit', 'Back to edit: Edit');
	h.check(await space(P, 'edit', 'same'), '...in the reference space Edit had (the view is where it was)');
	const after = await P.evaluate(() => window.__stores.playHere.playHereDebug());
	h.check(after.override === null && after.playing === false, 'the override is gone');

	// ---- 3. a world grab (miniature) is put back too; Interact played it at 1:1 -------------------
	await P.evaluate(() => {
		let r;
		window.__stores.worldRig.subscribe((x) => (r = x))();
		r.scale.setScalar(0.5);
		r.position.set(4, 0, -3);
		r.updateMatrixWorld(true);
	});
	await iwer.frames(P, 3);
	await applied(P);
	await P.evaluate(() => window.__stores.vrControls.executeVRMenuAction('playhere'));
	await iwer.frames(P, 8);
	let rig = await rigPose(P);
	h.check((await mode(P)) === 'interact' && rig.s === 1 && rig.p.every((x) => x === 0), `Play here plays at 1:1 (${JSON.stringify(rig)})`);
	// the content point under the head: (8 − 4) / 0.5 = 8, (−6 + 3) / 0.5 = −6 → over the box again
	const o3 = (await P.evaluate(() => window.__stores.playHere.playHereDebug())).override;
	h.check(o3 && near(o3.position[0], 8, 0.1) && near(o3.position[2], -6, 0.1) && near(o3.position[1], top), `...from the content point under the head (${JSON.stringify(o3)})`);
	// the mode button (left Y) is the other way back
	await iwer.tap(P, 'left', 5);
	await iwer.frames(P, 6);
	rig = await rigPose(P);
	h.check((await mode(P)) === 'edit', 'left Y: back to Edit');
	h.check(rig.s === 0.5 && near(rig.p[0], 4) && near(rig.p[2], -3), `...and the world grab is back (${JSON.stringify(rig)})`);
	h.check(await space(P, 'edit', 'same'), '...in the reference space Edit had');

	// ---- 4. an ordinary Interact afterwards uses the scene's spawn (the override did not leak) -----
	await applied(P);
	await iwer.tap(P, 'left', 5);
	await iwer.frames(P, 8);
	h.check((await mode(P)) === 'interact', 'left Y: an ordinary Interact');
	a = await applied(P);
	const toSpawn = Math.hypot(-10 - 8, 10 + 6);
	h.check(near(a.move, toSpawn, 0.15), `...moves the player to the scene's spawn (${a.move} m vs ${toSpawn.toFixed(2)})`);
	h.check(a.turns.some((t) => Math.abs(Math.abs(t) - 0.5) < 0.03), `...and turns them to its facing (turns ${JSON.stringify(a.turns)})`);

	await iwer.exit(P);
	await h.finish(browser);
});
