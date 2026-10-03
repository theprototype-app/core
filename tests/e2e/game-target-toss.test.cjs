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
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'menu.png') });

	// 3 — stage 1 from its button: six cans on the left table, six balls on the shelf
	await page.locator('#hud-layer button', { hasText: '1 · Tin cans' }).first().click();
	await h.eventually(() => snap().then((v) => v.state + '/' + v.screen), (v) => v === 'playing/hud', 'the stage button starts stage 1 on the in-game HUD', 8000);
	await h.eventually(() => tt('cans').then((c) => c.length), (n) => n === 6, 'stage 1 deals a six-can pyramid', 8000);
	await h.eventually(() => tt('balls').then((b) => b.length), (n) => n === 6, 'six balls on the shelf', 8000);
	await page.waitForTimeout(2600); // the intro countdown
	await h.eventually(hud, (t) => /Stage 1 · Tin cans/.test(t) && /Cans 0\/6/.test(t), 'the HUD names the stage and counts the cans', 6000);
	const cansStanding = await tt('cans');
	h.check(cansStanding.every((c) => c.pos[1] > 0.9), `the pyramid stands on the table (${cansStanding.map((c) => c.pos[1].toFixed(2)).join(',')})`);

	// 4 — a real throw: a ball leaves the shelf and knocks cans (retry a few, a throw can miss)
	let knocked = 0;
	for (let i = 0; i < 4 && knocked === 0; i++) {
		await tt('throwAt', [[-0.6, 1.5, 1.4], [-1.3, 1.25 + i * 0.05, -3.2], 13]);
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
		await tt('throwAt', [[-0.6, 1.5, 1.4], [-1.3, 1.25 + i * 0.05, -3.2], 13]);
		await page.waitForTimeout(1800);
		knocked = 6 - Number((await tt('vars')).ttCans);
	}
	h.check(knocked > 0, `VR: a throw knocks cans (${knocked} down)`);
	await page.evaluate(() => window.__stores.isVRMode.set(false));
	await xr.uninstall(page);

	await h.finish(browser);
});
