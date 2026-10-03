// 35-mini-golf ACCEPTANCE — the Mini Golf game template, loaded from a REAL authored .tpscene
// (MINIGOLF_TPSCENE=<path>, else the lane's staging tree, else the sibling scenes checkout) and
// driven through the real surfaces: the start menu, Play, a REAL MOUSE putt (press on the ball,
// drag back, let go), a scripted round of hole 1 to the cup and on to hole 2, out of bounds, the
// scorecard, a VR-emulated start (a fake XR session lands a game in Interact; a hand knock is a
// stroke), and the draw-call budget. Skip-never-fail when no authored scene is found.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.MINIGOLF_TPSCENE,
	path.resolve(__dirname, '../../../cloud-lane-30-staging/35-mini-golf/games/mini-golf/scene.tpscene'),
	path.resolve(__dirname, '../../../theprototype.app-scenes/games/mini-golf/scene.tpscene'),
	path.resolve(__dirname, '../../../scenes/games/mini-golf/scene.tpscene')
].filter(Boolean);
const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = process.env.MINIGOLF_SHOTS || '';
/** poll without counting a check @param {() => Promise<any>} fn @param {(v: any) => boolean} pred @param {number} ms */
async function waitFor(fn, pred, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred(await fn())) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no authored games/mini-golf/scene.tpscene (set MINIGOLF_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2000);

	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			const group = g(s.objectsGroup);
			return {
				names: group.children.map((c) => c.name),
				dynamic: group.children.filter((c) => c.userData?.physics?.mode === 'dynamic').map((c) => c.name),
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null,
				vars: window.__minigolf?.vars?.() ?? null,
				ball: window.__minigolf?.ball?.()?.pos ?? null
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';

	// 1 — the course arrived
	let st = await snap();
	h.check(st.names.includes('Mini golf game'), 'the marker that wakes the minigolf module is in the scene');
	const need = [1, 2, 3, 4, 5, 6].flatMap((n) => ['Green ' + n, 'Cup ' + n, 'Putter ' + n]).concat(['High green', 'Ramp', 'Windmill blade A', 'Bank wall', 'Sand trap', 'Hump up', 'Golf ball']);
	const missing = need.filter((n) => !st.names.includes(n));
	h.check(missing.length === 0, `six holes: greens, cups, putters, ramp, windmill, wall, sand, hump, the ball (${missing.join(', ') || 'all present'})`);
	h.check(st.dynamic.includes('Golf ball') && st.dynamic.filter((n) => /^Putter/.test(n)).length === 6, `the ball and six putters are dynamic (${st.dynamic.join(', ')})`);
	h.check(st.play?.simOnPlay === true && st.play?.cursor === 'free', `play block: simOnPlay, a FREE cursor (${JSON.stringify(st.play)})`);
	h.check(st.state === 'menu' && st.screen === 'menu', `starts on the start menu (${st.state}/${st.screen})`);
	h.check(!!(await page.evaluate(() => window.__minigolf)), 'the core minigolf module is awake');

	// 2 — Play: the sim, the menu, Tee off
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering Play starts the simulation', 10000);
	await h.eventually(hud, (t) => /MINI GOLF/.test(t) && /Tee off/.test(t), 'the start menu renders in Play', 6000);
	h.check(/drag BACK/.test(await hud()) && /putter/.test(await hud()), 'the menu says how to putt on a desktop and in VR');
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'menu.png') });
	await page.locator('#hud-layer button', { hasText: 'Tee off' }).click();
	await h.eventually(() => snap(), (v) => v.state === 'playing' && v.vars?.mgHole === 1, 'Tee off starts the round on hole 1', 6000);
	await h.eventually(hud, (t) => /Hole 1 of 6/.test(t) && /Par 2/.test(t) && /Strokes 0/.test(t), 'the HUD: hole, par, strokes', 6000);
	await h.eventually(() => snap().then((v) => v.ball), (b) => b && Math.abs(b[0] + 12.5) < 0.05 && Math.abs(b[2] - 4.4) < 0.1, 'the ball sits on hole 1 tee', 4000);
	const eye = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		const p = cam.getWorldPosition(new s.THREE.Vector3());
		return [p.x, p.y, p.z].map((n) => +n.toFixed(2));
	});
	h.check(Math.abs(eye[0] + 12.5) < 0.3 && Math.abs(eye[2] - 6.4) < 0.4, `the player stands behind the tee (${eye})`);
	await page.waitForTimeout(800);

	// 3 — a REAL MOUSE putt: press on the ball, drag back toward the camera, let go
	const ballScreen = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.globalCamera.subscribe((v) => (cam = v))();
		let r; s.globalRenderer.subscribe((v) => (r = v))();
		const b = window.__minigolf.ball().pos;
		const v = new s.THREE.Vector3(...b).project(cam);
		const rect = r.domElement.getBoundingClientRect();
		return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
	});
	const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, ballScreen);
	h.check(under === 'CANVAS', `premise: the ball's pixel is the canvas (${under} at ${Math.round(ballScreen.x)},${Math.round(ballScreen.y)})`);
	await page.mouse.move(ballScreen.x, ballScreen.y);
	await page.mouse.down();
	await page.mouse.move(ballScreen.x, ballScreen.y + 40, { steps: 4 });
	await page.mouse.move(ballScreen.x, ballScreen.y + 90, { steps: 4 });
	const arrow = await page.evaluate(() => {
		const s = window.__stores;
		let sc; s.globalScene.subscribe((v) => (sc = v))();
		const a = sc.getObjectByName('golf-aim');
		return a ? { visible: a.visible, len: a.children[0].scale.z } : null;
	});
	h.check(arrow?.visible && arrow.len > 0.2, `dragging back shows the aim arrow (${JSON.stringify(arrow)})`);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'aim.png') });
	await page.mouse.up();
	await h.eventually(() => snap().then((v) => v.vars?.mgStrokes), (n) => n === 1, 'letting go putts: one stroke', 4000);
	await page.waitForTimeout(300);
	const rolled = await snap();
	h.check(rolled.ball[2] < 4.3, `the ball rolled AWAY from the drag, up the lane (z ${rolled.ball[2].toFixed(2)})`);

	// 4 — finish hole 1: scripted putts at the cup until it drops
	for (let i = 0; i < 8; i++) {
		await waitFor(() => snap().then((v) => v.vars?.mgPhase), (p) => p !== 1, 12000);
		const now = await snap();
		if (now.vars.mgPhase === 2 || now.vars.mgHole !== 1) break;
		const d = Math.hypot(now.ball[0] + 12.5, now.ball[2] + 4.5);
		await page.evaluate((sp) => window.__minigolf.puttAtCup(sp), Math.min(6.5, 1.2 + d * 0.75));
		await page.waitForTimeout(500);
	}
	await h.eventually(() => snap().then((v) => v.vars), (v) => v.mgS1 > 0, 'hole 1 is sunk and scored', 12000);
	const s1 = (await snap()).vars.mgS1;
	await h.eventually(() => snap().then((v) => v.vars?.mgHole), (n) => n === 2, `after the cup, hole 2 (hole 1 took ${s1})`, 8000);
	await h.eventually(() => snap().then((v) => v.ball), (b) => b && Math.abs(b[0] + 7.5) < 0.05 && b[2] > 3.5, 'the ball is on hole 2 tee', 4000);
	await h.eventually(hud, (t) => /Hole 2 of 6/.test(t) && new RegExp('Total ' + s1).test(t), 'the HUD moved on and carries the total', 4000);
	const eye2 = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		return cam.getWorldPosition(new s.THREE.Vector3()).x;
	});
	h.check(Math.abs(eye2 + 7.5) < 0.4, `the player was teleported to hole 2 tee (x ${eye2.toFixed(2)})`);

	// 5 — out of bounds: a stroke and back to the last spot
	await page.waitForTimeout(500);
	const beforeOob = (await snap()).vars;
	await page.evaluate(() => window.__minigolf.lob([6, 6, 0]));
	await h.eventually(() => snap().then((v) => v.vars), (v) => v.mgOob === beforeOob.mgOob + 1, 'a ball over the rail is out of bounds', 8000);
	const afterOob = await snap();
	h.check(afterOob.vars.mgStrokes === beforeOob.mgStrokes + 2 && Math.abs(afterOob.ball[0] + 7.5) < 0.2, `+1 penalty and the ball is back on its lane (strokes ${afterOob.vars.mgStrokes}, x ${afterOob.ball[0].toFixed(2)})`);

	// 6 — the draw-call budget in Play (<= 150)
	const calls = await page.evaluate(async () => {
		let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
		// every render() pass of a display frame summed (shadow + composer), the perf-games rule
		const frame = () => new Promise((res) => requestAnimationFrame(res));
		let max = 0;
		r.info.autoReset = false;
		for (let i = 0; i < 6; i++) {
			await frame();
			r.info.reset();
			await frame();
			max = Math.max(max, r.info.render.calls);
		}
		r.info.autoReset = true;
		return max;
	});
	h.check(calls > 0 && calls <= 150, `draw calls in Play <= 150 (${calls})`);
	const helpers = await page.evaluate(() => {
		let sc; window.__stores.globalScene.subscribe((v) => (sc = v))();
		const grid = sc.getObjectByName('editor-grid');
		return grid ? grid.visible : false;
	});
	h.check(!helpers, 'no editor grid in Play');

	// 7 — the scorecard: the rest of the course scripted through the authority
	await page.evaluate(() => {
		const m = window.__minigolf;
		for (let i = 3; i <= 6; i++) window.__stores.gameState.setGameVar('mgS' + i, 3);
		window.__stores.gameState.setGameVar('mgS2', 3);
		m.setupHole(6);
	});
	await page.waitForTimeout(400);
	for (let i = 0; i < 10; i++) {
		const now = await snap();
		if (now.state === 'over') break;
		if (now.vars.mgPhase === 0) {
			const d = Math.hypot(now.ball[0] - 12.5, now.ball[2] + 5.2);
			await page.evaluate((sp) => window.__minigolf.puttAtCup(sp), Math.min(6.5, 1.5 + d * 0.8));
		}
		await page.waitForTimeout(2500);
	}
	await h.eventually(() => snap().then((v) => v.state), (s) => s === 'over', 'after hole 6 the round is over', 30000);
	await h.eventually(hud, (t) => /Course complete/.test(t) && /1\. Straight/.test(t) && /6\. The hump/.test(t) && /Play again/.test(t), 'the scorecard lists all six holes', 6000);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'scorecard.png') });
	const best = await page.evaluate(() => window.__minigolf.info({ read: 'best' }));
	h.check(/Best on this device: \d+/.test(best), `the round is saved as this device's best (${best})`);
	await page.locator('#hud-layer button', { hasText: 'Menu' }).click();
	await h.eventually(() => snap().then((v) => v.state), (s) => s === 'menu', 'Menu goes back to the start menu', 6000);

	// 7b — the shell's Levels page lists every hole and starts a round on the one picked
	const lv = await page.evaluate(() => window.__stores.gameKit.gameShell.gameShellDebug().levels);
	h.check(lv?.list?.length === 6 && /Windmill/.test(lv.list[2].label), `the Levels page lists the six holes (${lv?.list?.map((l) => l.label).join(' | ')})`);
	await page.evaluate(() => window.__stores.gameKit.gameShell.pickGameLevel('4'));
	await h.eventually(() => snap(), (v) => v.state === 'playing' && v.vars?.mgHole === 4, 'picking hole 4 starts a round there', 6000);
	await h.eventually(() => snap().then((v) => v.ball), (b) => b && Math.abs(b[0] - 2.5) < 0.05 && b[2] > 3.5, 'the ball waits on hole 4 tee', 4000);

	// 8 — VR: a fake session lands the game in Interact; start; a hand knock is a stroke
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(600);
	await page.evaluate(() => window.__stores.isVRMode.set(true));
	await xr.install(page);
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });
	await page.evaluate(() => window.__stores.vrControls.onVRSessionStart());
	await page.waitForTimeout(400);
	const mode = await page.evaluate(() => { let m; window.__stores.editorMode.subscribe((v) => (m = v))(); return m; });
	h.check(mode === 'interact', `a VR session on Mini Golf lands in Interact (${mode})`);
	await page.evaluate(() => window.__minigolf.startRound());
	await h.eventually(() => snap(), (v) => v.state === 'playing' && v.vars?.mgHole === 1 && v.sim, 'VR: the round starts on hole 1 with the simulation running', 10000);
	await page.waitForTimeout(800);
	const vrBall = (await snap()).ball;
	// grip the putter lying beside the tee (aim the right controller straight down at it)
	const worldPose = (pos, pitch) =>
		page.evaluate(({ pos, pitch }) => {
			const s = window.__stores;
			const c = window.__fakeXR.renderer.xr.getController(1);
			const q = new s.THREE.Quaternion().setFromEuler(new s.THREE.Euler(pitch, 0, 0, 'YXZ'));
			const world = new s.THREE.Matrix4().compose(new s.THREE.Vector3(...pos), q, new s.THREE.Vector3(1, 1, 1));
			c.parent.updateMatrixWorld(true);
			c.matrix.copy(c.parent.matrixWorld.clone().invert().multiply(world));
			c.updateMatrixWorld(true);
		}, { pos, pitch });
	const putter = await page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const p = g.getObjectByName('Putter 1');
		return { uuid: p.uuid, pos: p.getWorldPosition(new window.__stores.THREE.Vector3()).toArray() };
	});
	await worldPose([putter.pos[0], 0.9, putter.pos[2]], -Math.PI / 2);
	await page.waitForTimeout(200);
	await xr.button(page, 'right', 1, true);
	await page.waitForTimeout(300);
	const held = await page.evaluate(() => window.__stores.vrControls.vrGripDebug());
	h.check(held.grab === putter.uuid, `VR: the grip holds the putter (${held.grab})`);
	// swing: move the hand so the club head passes through the ball toward the cup (-z)
	const offset = await page.evaluate(() => {
		const s = window.__stores;
		let g; s.objectsGroup.subscribe((v) => (g = v))();
		const p = g.getObjectByName('Putter 1');
		const head = p.localToWorld(new s.THREE.Vector3(0, -0.42, 0));
		const c = window.__fakeXR.renderer.xr.getController(1);
		const hand = c.getWorldPosition(new s.THREE.Vector3());
		return [head.x - hand.x, head.y - hand.y, head.z - hand.z];
	});
	for (let k = 0; k <= 16; k++) {
		const z = vrBall[2] + 0.4 - k * 0.05;
		await worldPose([vrBall[0] - offset[0], vrBall[1] - offset[1], z - offset[2]], -Math.PI / 2);
		await page.waitForTimeout(20);
	}
	await h.eventually(() => snap().then((v) => v.vars?.mgStrokes), (n) => n >= 1, 'VR: swinging the held putter through the ball is a stroke', 5000);
	await xr.button(page, 'right', 1, false);
	await page.waitForTimeout(800);
	const vrAfter = (await snap()).ball;
	h.check(vrAfter[2] < vrBall[2] - 0.2, `VR: the ball went up the lane (z ${vrBall[2].toFixed(2)} -> ${vrAfter[2].toFixed(2)})`);
	await xr.setOn(page, false);
	await page.evaluate(() => window.__stores.isVRMode.set(false));

	await h.finish(browser);
});
