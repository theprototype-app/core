// 37-slipped (plan 21-C, "Race touch + VR"): Race on a PHONE and in a HEADSET, on its REAL
// authored .tpscene (RACE_TPSCENE, else a scenes checkout; skip-never-fail when none is found).
//
// What is proved, against the cars' and the rig's own poses (never a store the code under test
// writes for itself):
//   1. a phone driver gets PEDALS: the 'drive' touch preset (the stick, no look drag, Gas + Brake
//      + Reset), Gas sitting bottom-right under the right thumb
//   2. REAL touches drive: holding Gas moves the car straight; the stick pushed right while Gas is
//      held TURNS it (the counterfactual is the straight run before it)
//   3. leaving the car takes the pedals away
//   4. a headset driver sits IN the car: entering VR mid-race swaps the chase camera for the seat,
//      the head lands on the seat facing the car's way, the left stick drives, the head rides
//      with the car (car-local place unchanged), the sticks no longer walk the player
//   5. VR with no pointer lock (a headset's game runs in Interact) still drives — the 37 fix
//   6. leaving the race stands the player up beside the car
// Screenshots land in $RACE_SHOTS (default the lane's evidence folder).
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.RACE_TPSCENE,
	path.resolve(__dirname, '../../../scenes/games/race/scene.tpscene'),
	path.resolve(__dirname, '../../../scenes-lane-36-int-125/games/race/scene.tpscene'),
	'/home/deck/.code/lanes-30/after-36/36-backlog-21c/scenes/games/race/scene.tpscene'
].filter(Boolean);
const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = process.env.RACE_SHOTS ?? '/home/deck/.code/lanes-30/after-37/37-slipped';
const shoot = async (page, name) => {
	if (!SHOTS) return;
	try {
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.waitForTimeout(300);
		await page.screenshot({ path: path.join(SHOTS, name) });
	} catch (e) {
		console.log('screenshot failed', name, e.message);
	}
};

// OPPO Find N6 folded (the touch suite's researched CSS viewport)
const N6_FOLDED = { hasTouch: true, isMobile: true, deviceScaleFactor: 3, viewport: { width: 380, height: 792 } };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadScene(page, file) {
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, Array.from(fs.readFileSync(file)));
	await page.waitForTimeout(2000);
}
/** a car's world pose: position + yaw (forward -Z) */
const carPose = (page, name) =>
	page.evaluate((name) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByName(name);
		if (!o) return null;
		const T = window.__stores.THREE;
		const p = o.getWorldPosition(new T.Vector3());
		const f = new T.Vector3(0, 0, -1).applyQuaternion(o.getWorldQuaternion(new T.Quaternion()));
		return { pos: [p.x, p.y, p.z], yaw: Math.atan2(-f.x, -f.z), uuid: o.uuid };
	}, name);
const phaseOf = (page) => page.evaluate(() => window.__race?.phase() ?? null);
const viewOf = (page) => page.evaluate(() => window.__race?.view?.() ?? null);
const specOf = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.touchSpec.touchSpec.subscribe((x) => (v = x))();
		return { stick: v.stick, look: v.look, preset: v.preset, ids: v.actions.map((a) => a.id) };
	});
const rectOf = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
	}, sel);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
/** the head in the car's own frame @param {{x,y,z}} head @param {{pos: number[], yaw: number}} car */
const carLocal = (head, car) => {
	const dx = head.x - car.pos[0];
	const dz = head.z - car.pos[2];
	const s = Math.sin(-car.yaw);
	const c = Math.cos(-car.yaw);
	return [dx * c + dz * s, head.y - car.pos[1], -dx * s + dz * c];
};
/** claim car 1, press Start, wait for the race to run */
async function startRace(page) {
	await page.evaluate(() => window.__race.claim('Race car 1'));
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	await h.eventually(() => phaseOf(page), (p) => p === 'playing', 'the race runs (countdown over)', 15000);
}

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no authored games/race/scene.tpscene (set RACE_TPSCENE)');
		return;
	}
	console.log('scene:', TPSCENE);
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}

	// ---- 1. a phone: pedals --------------------------------------------------------------------
	console.log('\n=== 1. a phone driver gets pedals ===');
	const P = await h.setupPage(browser, 'P', { context: N6_FOLDED });
	const page = P.page;
	const cdp = await page.context().newCDPSession(page);
	await loadScene(page, TPSCENE);
	await page.locator('#play-button').click();
	await h.eventually(() => page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return !!v; }), (v) => v, 'Play starts the simulation (simOnPlay)', 15000);
	let spec = await specOf(page);
	h.check(!spec.ids.includes('gas'), `premise: on foot there are no pedals (${JSON.stringify(spec)})`);
	await startRace(page);
	await h.eventually(() => viewOf(page), (v) => v?.engaged && v.view === 'chase' && v.pedals, 'in the car: the chase camera and the pedals', 6000);
	spec = await specOf(page);
	h.check(spec.preset === 'drive' && spec.stick && !spec.look, `the 'drive' preset: the stick steers, no look drag (${JSON.stringify(spec)})`);
	h.check(spec.ids.join() === 'gas,brake,reset', `Gas, Brake, Reset (${spec.ids})`);
	const gas = await rectOf(page, '#touch-btn-gas');
	const brake = await rectOf(page, '#touch-btn-brake');
	const stickEl = await rectOf(page, '.touch-stick-rest');
	h.check(!!stickEl && stickEl.x < 380 * 0.35, `the steering stick rests bottom-left (${stickEl && [Math.round(stickEl.x), Math.round(stickEl.y)]})`);
	h.check(!!gas && gas.x > 380 * 0.65 && gas.y > 792 * 0.7, `Gas sits bottom-right under the right thumb (${gas && [Math.round(gas.x), Math.round(gas.y)]})`);
	h.check(!!brake && gas && brake.x < gas.x && gas.w > brake.w, `Brake sits beside it, smaller (${brake && [Math.round(brake.x), Math.round(brake.y)]})`);
	await shoot(page, '01-race-phone-pedals.png');

	// ---- 2. real touches drive -----------------------------------------------------------------
	console.log('\n=== 2. real touches drive ===');
	const holdGas = async (ms, steerPx) => {
		const L = stickEl ? stickEl.x : 90;
		const Y = stickEl ? stickEl.y : 792 - 140;
		const before = await carPose(page, 'Race car 1');
		const pts = [];
		if (steerPx) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L, y: Y, id: 1 }] });
			await nap(30);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: L + steerPx / 2, y: Y, id: 1 }] });
			await nap(30);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: L + steerPx, y: Y, id: 1 }] });
			await nap(60);
			pts.push({ x: L + steerPx, y: Y, id: 1 });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...pts, { x: gas.x, y: gas.y, id: 2 }] });
		await nap(200);
		const held = await page.evaluate(() => ({ held: window.__stores.touchActions.touchActionsDebug().held, move: window.__stores.touchControls.touchControlsDebug().move }));
		await nap(ms - 200);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await nap(600);
		const after = await carPose(page, 'Race car 1');
		return { held, moved: flat(before.pos, after.pos), turned: Math.abs(wrap(after.yaw - before.yaw)) };
	};
	const straight = await holdGas(1800, 0);
	h.check(straight.held.held.includes('gas'), `holding the Gas button holds the action (${straight.held.held})`);
	h.check(straight.moved > 3, `Gas alone drives the car forward (${straight.moved.toFixed(1)} m)`);
	h.check(straight.turned < 0.2, `...in a straight line (turned ${straight.turned.toFixed(2)} rad)`);
	const steered = await holdGas(1800, 70);
	h.check(steered.held.move.x > 0.5 && steered.held.held.includes('gas'), `two fingers: the stick pushed right (${steered.held.move.x.toFixed(2)}) AND Gas held`);
	h.check(steered.moved > 2 && steered.turned > straight.turned + 0.4, `the stick STEERS: the car turns ${steered.turned.toFixed(2)} rad (straight run: ${straight.turned.toFixed(2)})`);
	await shoot(page, '02-race-phone-steering.png');

	// ---- 3. out of the car: no pedals ------------------------------------------------------------
	console.log('\n=== 3. leaving the car takes the pedals away ===');
	await h.leavePlay(P);
	await h.eventually(() => viewOf(page), (v) => v && !v.engaged && !v.pedals, 'out of Play: no chase camera, no pedals', 6000);
	spec = await specOf(page);
	h.check(!spec.ids.includes('gas'), `the overlay no longer offers Gas (${spec.ids})`);
	await P.ctx.close();

	// ---- 4. a headset: the seat ------------------------------------------------------------------
	console.log('\n=== 4. a headset driver sits in the car ===');
	const V = await h.setupPage(browser, 'V', { context: { viewport: { width: 1280, height: 720 } } });
	const vp = V.page;
	await loadScene(vp, TPSCENE);
	await vp.locator('#play-button').click();
	await h.eventually(() => vp.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return !!v; }), (v) => v, 'Play starts the simulation', 15000);
	await startRace(vp);
	await h.eventually(() => viewOf(vp), (v) => v?.view === 'chase', 'desktop: the chase camera', 6000);
	// the headset arrives mid-race (a real session start: fake XR + the VR mode the session sets)
	await xr.install(vp);
	await xr.installSpace(vp, { head: [0, 1.6, 0], yaw: 0 });
	await vp.evaluate(() => window.__stores.isVRMode.set(true));
	await vp.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await h.eventually(() => viewOf(vp), (v) => v?.view === 'seat', 'entering VR mid-race swaps the chase camera for the SEAT', 6000);
	const seated = await vp.evaluate(() => window.__stores.vrControls.seatDebug());
	let car = await carPose(vp, 'Race car 1');
	h.check(seated?.uuid === car.uuid, 'the seat is MY car');
	await vp.waitForTimeout(400);
	let head = await xr.head(vp);
	let local = carLocal(head, car);
	h.check(Math.abs(local[0]) < 0.08 && Math.abs(local[1] - 0.82) < 0.08 && Math.abs(local[2] - 0.32) < 0.15, `the head lands on the seat (car-local ${local.map((n) => n.toFixed(2))}; seat 0, 0.82, 0.32)`);
	h.check(Math.abs(wrap(head.yaw - car.yaw)) < 0.05, `...facing the car's way (head ${head.yaw.toFixed(2)}, car ${car.yaw.toFixed(2)})`);
	const claimsOf = await vp.evaluate(() => {
		let v;
		window.__stores.inputRuntime.inputClaims.subscribe((x) => (v = x))();
		return v;
	});
	h.check(claimsOf.includes('sticks') && claimsOf.includes('keys'), `seated: the sticks are claimed (no walking or turning) (${claimsOf})`);

	console.log('\n=== 4b. the left stick drives, the head rides along ===');
	const before = await carPose(vp, 'Race car 1');
	const local0 = carLocal(await xr.head(vp), before);
	await xr.stick(vp, 'left', 0.6, -1);
	await vp.waitForTimeout(2200);
	await xr.stick(vp, 'left', 0, 0);
	await vp.waitForTimeout(500);
	car = await carPose(vp, 'Race car 1');
	head = await xr.head(vp);
	const moved = flat(before.pos, car.pos);
	const turned = Math.abs(wrap(car.yaw - before.yaw));
	h.check(moved > 3, `the left stick drives the car (${moved.toFixed(1)} m)`);
	h.check(turned > 0.3, `...and steers it (${turned.toFixed(2)} rad)`);
	local = carLocal(head, car);
	const drift = Math.hypot(local[0] - local0[0], local[1] - local0[1], local[2] - local0[2]);
	h.check(drift < 0.15, `the head RODE with the car: same car-local place after ${moved.toFixed(1)} m (drift ${drift.toFixed(3)} m)`);
	h.check(Math.abs(wrap(head.yaw - car.yaw)) < 0.08, `...and turned with it (head-vs-car ${wrap(head.yaw - car.yaw).toFixed(3)} rad)`);
	await shoot(vp, '03-race-vr-seat.png');

	console.log('\n=== 5. a headset game runs in Interact: no pointer lock, still driving ===');
	await vp.evaluate(() => window.__stores.isLocked.set(null));
	await vp.waitForTimeout(500);
	const v5 = await viewOf(vp);
	h.check(v5?.engaged && v5.view === 'seat', `VR Interact with no pointer lock keeps the driver in the seat (${JSON.stringify(v5)})`);
	const b5 = await carPose(vp, 'Race car 1');
	await xr.stick(vp, 'left', 0, -1);
	await vp.waitForTimeout(1500);
	await xr.stick(vp, 'left', 0, 0);
	const a5 = await carPose(vp, 'Race car 1');
	h.check(flat(b5.pos, a5.pos) > 2, `...and the stick still drives (${flat(b5.pos, a5.pos).toFixed(1)} m) — before 37 a headset never engaged at all`);

	console.log('\n=== 6. leaving the race stands you up beside the car ===');
	await vp.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await h.eventually(() => viewOf(vp), (v) => v && !v.engaged && v.view === '', 'Edit: out of the car', 6000);
	await vp.waitForTimeout(300);
	car = await carPose(vp, 'Race car 1');
	head = await xr.head(vp);
	const side = carLocal(head, car);
	h.check(side[0] < -1.5 && Math.abs(side[2]) < 1, `stepped out on the driver's side (car-local ${side.map((n) => n.toFixed(2))})`);
	const claims6 = await vp.evaluate(() => {
		let v;
		window.__stores.inputRuntime.inputClaims.subscribe((x) => (v = x))();
		return v;
	});
	h.check(!claims6.includes('sticks'), `the sticks are free again (${claims6})`);
	h.check((await vp.evaluate(() => window.__stores.vrControls.seatDebug())) === null, 'no seat left behind');
	await xr.uninstall(vp);
	await V.ctx.close();
	await browser.close();
});
