// 35 TARGET TOSS ACCEPTANCE — the Target Toss game template, loaded from the authored .tpscene
// (TARGET_TOSS_TPSCENE=<path>, else the lane staging dir, else the sibling scenes checkout) and
// driven through the real surfaces: the booth arrived, Play starts the sim and the stage select,
// a stage button deals the cans and the balls, a real throw knocks cans, a scripted sweep WINS
// stage 1 (results screen, stars, stage 2 unlocked), and a VR-emulated start (fake XR session)
// plays the same stage in Interact. Skip-never-fail when no scene is found.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.TARGET_TOSS_TPSCENE,
	'/home/deck/.code/theprototype-app/cloud-lane-30-staging/35-target-toss/games/target-toss/scene.tpscene',
	path.resolve(__dirname, '../../../scenes/games/target-toss/scene.tpscene'),
	path.resolve(__dirname, '../../../theprototype.app-scenes/games/target-toss/scene.tpscene')
].filter(Boolean);
const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = process.env.SHOTS_DIR || '';

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no target-toss scene.tpscene (set TARGET_TOSS_TPSCENE)');
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
				dynamic: group.children.filter((c) => c.userData?.physics?.mode === 'dynamic' && !c.userData?.transient).map((c) => ({ name: c.name, y: c.position.y })),
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';
	const tt = (fn, arg) => page.evaluate(([f, a]) => window.__targetToss[f](...(a ?? [])), [fn, arg]);

	// 1 — the booth
	let st = await snap();
	const need = ['Target Toss game', 'Counter', 'Ball shelf', 'Table left', 'Table right', 'Swing target 1', 'Popup target 6', 'Cart', 'Cart target', 'Ball template', 'Can template'];
	h.check(need.every((n) => st.names.includes(n)), `the booth: shelf, tables, targets, templates (${need.filter((n) => !st.names.includes(n)).join(', ') || 'all present'})`);
	h.check(st.dynamic.length === 2 && st.dynamic.every((d) => d.y < -5), `only the two TEMPLATES are dynamic, parked under the floor (${JSON.stringify(st.dynamic)})`);
	h.check(st.play?.simOnPlay === true && st.play?.interaction === 'grab', `play block: grab + simOnPlay (${JSON.stringify(st.play)})`);
	h.check(st.state === 'menu', `starts on the stage select (${st.state}/${st.screen})`);
	h.check(await page.evaluate(() => !!window.__targetToss), 'the core targettoss module is awake');

	// 2 — Play: the sim, the stage select
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim', 10000);
	await h.eventually(hud, (t) => /TARGET TOSS/.test(t) && /1 · Tin cans/.test(t) && /5 · The cart/.test(t), 'the stage select renders: five stages', 6000);
	await h.eventually(() => page.evaluate(() => { let m; window.__stores.gameKit.gameMusic.gameMusicState.subscribe((v) => (m = v))(); return m?.preset ?? null; }), (m) => m === 'arcade', 'the fairground music plays', 6000);
	const eye = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		const p = cam.getWorldPosition(new s.THREE.Vector3());
		return [p.x, p.y, p.z].map((n) => +n.toFixed(2));
	});
	h.check(Math.abs(eye[0]) < 0.05 && Math.abs(eye[1] - 1.7) < 0.15 && Math.abs(eye[2] - 3.25) < 0.1, `desktop Play puts the eye behind the counter (the module's desktop spawn; VR keeps the scene's 2.65, in arm's reach) (${eye})`);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'menu.png') });

	// 3 — stage 1 from its button: six cans on the left table, six balls on the shelf
	await page.locator('#hud-layer button', { hasText: '1 · Tin cans' }).first().click();
	await h.eventually(() => snap().then((v) => v.state + '/' + v.screen), (v) => v === 'playing/hud', 'the stage button starts stage 1 on the in-game HUD', 8000);
	await h.eventually(() => tt('cans').then((c) => c.length), (n) => n === 6, 'stage 1 deals a six-can pyramid', 8000);
	await h.eventually(() => tt('balls').then((b) => b.length), (n) => n === 6, 'six balls on the shelf', 8000);
	await page.waitForTimeout(2600); // the intro countdown
	await h.eventually(hud, (t) => /Stage 1 · Tin cans/.test(t) && /Cans 0\/6/.test(t) && /Hold to charge/.test(t), 'the HUD names the stage, counts the cans, says how to throw', 6000);
	const cansStanding = await tt('cans');
	h.check(cansStanding.every((c) => c.pos[1] > 0.9), `the pyramid stands on the table (${cansStanding.map((c) => c.pos[1].toFixed(2)).join(',')})`);

	// 3b — the desktop throw with the REAL mouse: hold to charge, release to throw
	const shelfBefore = await tt('balls');
	const box = await page.evaluate(() => { let r; window.__stores.globalRenderer.subscribe((v) => (r = v))(); const b = r.domElement.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
	await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35);
	await page.mouse.down();
	await page.waitForTimeout(500);
	const charge = await tt('info', [{ read: 'charge' }]);
	await page.mouse.up();
	await page.waitForTimeout(300);
	const shelfAfter = await tt('balls');
	const moved = shelfAfter.filter((b) => { const was = shelfBefore.find((x) => x.uuid === b.uuid); return was && Math.hypot(b.pos[0] - was.pos[0], b.pos[1] - was.pos[1], b.pos[2] - was.pos[2]) > 0.5; });
	h.check(charge > 0.3 && charge < 1, `holding the mouse charges the throw (${(+charge).toFixed(2)})`);
	h.check(moved.length === 1, `releasing throws ONE ball from the shelf along the view (${moved.length})`);
	await page.waitForTimeout(1800);

	// 4 — a real throw: a ball leaves the shelf and knocks cans (retry a few, a throw can miss)
	let knocked = 0;
	for (let i = 0; i < 4 && knocked === 0; i++) {
		await tt('throwAt', [[-0.6, 1.5, 1.4], [-1.2, 1.3 + i * 0.05, -2.8], 13]);
		await page.waitForTimeout(1800);
		knocked = 6 - Number((await tt('vars')).ttCans);
	}
	h.check(knocked > 0, `a thrown ball knocks cans off the table (${knocked} down)`);
	h.check(Number((await tt('vars')).ttScore) >= 100, `knocked cans score (${(await tt('vars')).ttScore})`);
	await h.eventually(() => tt('balls').then((b) => b.length), (n) => n === 6, 'the thrown ball comes back: six on the shelf again', 8000);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'play.png') });

	// 5 — the scripted win of stage 1: sweep the rest off, the judge clears the stage
	await tt('sweepCans');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'over', 'every can down -> the stage is cleared', 8000);
	const vars = await tt('vars');
	h.check(Number(vars.ttStatus) === 2 && Number(vars.ttStars) >= 1, `won with stars (${JSON.stringify(vars)})`);
	await h.eventually(hud, (t) => /Stage cleared!/.test(t) && /★/.test(t) && /Next stage/.test(t), 'the results screen: cleared, stars, Next stage', 6000);
	const table = await page.evaluate(() => window.__stores.gameKit ? null : null);
	void table;
	await page.locator('#hud-layer button', { hasText: 'Next stage' }).first().click();
	await h.eventually(() => tt('vars').then((v) => Number(v.ttStage)), (n) => n === 2, 'Next stage opens stage 2 (unlocked by the win)', 8000);
	await h.eventually(() => tt('cans').then((c) => c.length), (n) => n === 12, 'stage 2 deals two pyramids (12 cans)', 8000);

	// 5a — the clock running out LOSES the stage: results say so, no stars
	await page.waitForTimeout(2600);
	await tt('shortenClock', [1]);
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'over', 'the clock runs out -> the stage ends', 8000);
	await h.eventually(() => tt('vars').then((v) => Number(v.ttStatus)), (n) => n === 3, 'recorded as lost', 4000);
	await h.eventually(hud, (t) => /Time is up/.test(t) && /☆☆☆/.test(t) && /left standing/.test(t), 'the results: Time is up, no stars, what was left standing', 6000);

	// 5b — the moving targets: stage 3 swingers, stage 4 pop-ups, stage 5 the cart, each hit by a
	// ball thrown from just in front of it (the judge, the points, the target dropping away)
	const posOf = (name) => page.evaluate((n) => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByName(n);
		o.updateMatrixWorld(true);
		const p = new window.__stores.THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
		return [p.x, p.y, p.z];
	}, name);
	const hitFromFront = async (name) => {
		const p = await posOf(name);
		await tt('throwAt', [[p[0], p[1], p[2] + 0.55], p, 9]);
		await page.waitForTimeout(400);
	};
	await tt('startStage', [3, true]);
	await h.eventually(() => tt('vars').then((v) => Number(v.ttStage) + '/' + v.ttStatus), (v) => v === '3/1', 'stage 3 (forced) starts', 8000);
	await page.waitForTimeout(2600);
	const sw1 = await posOf('Swing target 1');
	await page.waitForTimeout(400);
	const sw2 = await posOf('Swing target 1');
	h.check(sw1[1] > 1.5 && Math.abs(sw1[0] - sw2[0]) > 0.01, `stage 3: the targets hang in view and SWING (${sw1.map((n) => n.toFixed(2))} -> ${sw2[0].toFixed(2)})`);
	for (let i = 0; i < 3 && (Number((await tt('vars')).ttSwing) & 1) === 0; i++) await hitFromFront('Swing target 1');
	h.check((Number((await tt('vars')).ttSwing) & 1) === 1, `a ball hits swinging target 1 (mask ${(await tt('vars')).ttSwing})`);
	h.check(/Swingers 1\/3/.test(await hud()), 'the HUD counts it: Swingers 1/3');
	await tt('startStage', [4, true]);
	await h.eventually(() => tt('vars').then((v) => Number(v.ttStage) + '/' + v.ttStatus), (v) => v === '4/1', 'stage 4 (forced) starts', 8000);
	await page.waitForTimeout(2600);
	let up = [];
	for (let i = 0; i < 20 && !up.length; i++) {
		up = [];
		for (let k = 1; k <= 6; k++) if ((await posOf('Popup target ' + k))[1] > 1.2) up.push(k);
		if (!up.length) await page.waitForTimeout(250);
	}
	h.check(up.length >= 1 && up.length <= 2, `stage 4: pop-ups rise above the wall (${up})`);
	if (up.length) await hitFromFront('Popup target ' + up[0]);
	await h.eventually(() => tt('vars').then((v) => Number(v.ttPops)), (n) => n >= 1, 'a ball hits a pop-up', 3000);
	await tt('startStage', [5, true]);
	await h.eventually(() => tt('vars').then((v) => Number(v.ttStage) + '/' + v.ttStatus), (v) => v === '5/1', 'stage 5 (forced) starts', 8000);
	await h.eventually(() => tt('cans').then((c) => c.length), (n) => n === 10, 'stage 5 deals the big pyramid (10 cans)', 8000);
	await page.waitForTimeout(2600);
	const c1 = await posOf('Cart target');
	await page.waitForTimeout(300);
	const c2 = await posOf('Cart target');
	h.check(c1[1] > 0.6 && Math.abs(c1[0] - c2[0]) > 0.02, `stage 5: the cart rolls (${c1[0].toFixed(2)} -> ${c2[0].toFixed(2)})`);
	for (let i = 0; i < 3 && Number((await tt('vars')).ttCart) === 0; i++) await hitFromFront('Cart target');
	h.check(Number((await tt('vars')).ttCart) >= 1, `a ball hits the moving cart (${(await tt('vars')).ttCart})`);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'stage5.png') });

	// 6 — no editor helper in Play
	const helpers = await page.evaluate(() => {
		let sc; window.__stores.globalScene.subscribe((v) => (sc = v))();
		const seen = [];
		sc.traverse((o) => { if (o.visible && /helper|grid/i.test(o.name ?? '') && o.parent === sc) seen.push(o.name); });
		return seen;
	});
	h.check(!helpers.includes('editor-grid'), `no editor grid in Play (${helpers.join(', ') || 'none'})`);
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(800);

	// 7 — VR-emulated: a fake XR session, VR mode -> the game runs in Interact, a stage plays
	await xr.install(page);
	await page.evaluate(() => window.__stores.isVRMode.set(true));
	await page.waitForTimeout(600);
	await page.evaluate(() => window.__stores.editorMode?.set?.('interact'));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'VR Interact: the simulation runs', 10000);
	await tt('startStage', [1]);
	await h.eventually(() => tt('vars').then((v) => Number(v.ttStage)), (n) => n === 1, 'VR: stage 1 starts (Retry from the results)', 8000);
	await h.eventually(() => tt('balls').then((b) => b.length), (n) => n === 6, 'VR: six balls on the shelf to grab', 8000);
	await h.eventually(() => tt('cans').then((c) => c.length), (n) => n === 6, 'VR: the pyramid is dealt again', 8000);
	await page.waitForTimeout(2600);
	knocked = 0;
	for (let i = 0; i < 4 && knocked === 0; i++) {
		await tt('throwAt', [[-0.6, 1.5, 1.4], [-1.2, 1.3 + i * 0.05, -2.8], 13]);
		await page.waitForTimeout(1800);
		knocked = 6 - Number((await tt('vars')).ttCans);
	}
	h.check(knocked > 0, `VR: a throw knocks cans (${knocked} down)`);
	h.check((await tt('info', [{ read: 'hint' }])) === 'Grip a ball · throw it', 'VR: the hint line says grip and throw (not hold the mouse)');
	await page.evaluate(() => window.__stores.isVRMode.set(false));
	await xr.uninstall(page);

	await h.finish(browser);
});
