// B8 ACCEPTANCE — the Towers game template (redesigned after the first playthrough:
// PRE-PLACED crates, no spawner, lit daylight, a pause/restart menu). Loaded from the
// REAL .tpscene in the sibling scenes checkout with the REAL collectible zip, driven
// through the real surfaces. Skip-never-fail when the scenes checkout or the zip is
// absent — authored content, not core code, must keep a bare checkout green.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [
	path.resolve(__dirname, '../../../theprototype.app-scenes'),
	path.resolve(__dirname, '../../../scenes')
].find((p) => fs.existsSync(p));
const TPSCENE = SCENES_REPO && path.join(SCENES_REPO, 'games/towers/scene.tpscene');

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no sibling scenes checkout with games/towers/scene.tpscene');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	if (!(await h.installModule(A, 'collectible'))) {
		console.log('SKIP: no collectible.zip in the sibling modules checkout (npm run pack -- collectible)');
		await h.finish(browser);
		return;
	}

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
			/** @param {any} st */
			const g = (st) => { let v; st.subscribe((/** @type {any} */ x) => (v = x))(); return v; };
			let group;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
			const kids = group.children.map((/** @type {any} */ c) => ({
				name: c.name, uuid: c.uuid,
				dynamic: c.userData?.physics?.mode === 'dynamic',
				y: +c.position.y.toFixed(2)
			}));
			return {
				kids,
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';
	const clickBtn = (text) => page.locator('#hud-layer button', { hasText: text }).click();

	// 1 — the world arrived whole and lit
	let st = await snap();
	h.check(st.kids.length === 24, `the 24 objects arrived (${st.kids.length})`);
	const crates = st.kids.filter((k) => k.dynamic);
	h.check(crates.length === 9, `9 pre-placed dynamic crates (${crates.length})`);
	h.check(st.play?.simOnPlay === true && st.play?.interaction === 'grab', 'play block: grab + simOnPlay');
	h.check(st.state === 'menu' && st.screen === 'menu', `starts on the menu screen (${st.state}/${st.screen})`);
	h.check(/TOWERS/.test(await hud()), 'the menu renders (TOWERS)');

	// 2 — entering play starts the sim (simOnPlay honoured from the file)
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim', 10000);

	// 3 — the Start button flips to playing and swaps the menu for the HUD
	await clickBtn('Start round');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'playing', 'Start flips to playing', 8000);
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'the in-game HUD screen shows', 6000);

	// 4 — crates rest stably (no cycling): population and dynamic count hold over 4s
	const before = (await snap()).kids.length;
	await page.waitForTimeout(4000);
	st = await snap();
	h.check(st.kids.length === before, `object count is stable, no spawn churn (${before} -> ${st.kids.length})`);
	h.check(st.kids.filter((k) => k.dynamic).length === 9, 'still exactly 9 crates (none recycled)');

	// 5 — a crate lifted through the rings latches the height HUD (grab stand-in:
	// an external write carries a crate up through the ring sensors)
	const crate = st.kids.find((k) => k.dynamic);
	await page.evaluate((uuid) => {
		const s = window.__stores;
		let group; s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
		const o = group.children.find((/** @type {any} */ c) => c.uuid === uuid);
		o.position.set(0, 3.5, 0); o.updateMatrix();
	}, crate.uuid);
	await h.eventually(async () => await hud(), (t) => /Best height: [1-3] m/.test(t), 'lifting a crate latches the height HUD', 12000);
	h.check(/Stars left: 3/.test(await hud()), 'the collectible module reports 3 stars left');
	h.check(/\d+s/.test(await hud()), 'the round clock renders');

	// 5b — GRAB: aim at a crate and pointerdown carries it (the user's "cannot take
	// objects with mouse click"). The ray is NDC (0,0), so put a crate in front of the
	// aiming camera; the sim is already running from Start.
	const grabCrate = (await snap()).kids.find((k) => k.dynamic).uuid;
	await page.evaluate((uuid) => {
		const THREE = window.__stores.THREE;
		let camera; window.__stores.globalCamera.subscribe((v) => (camera = v))();
		let group; window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const at = camera.getWorldPosition(new THREE.Vector3())
			.addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 3.5);
		const o = group.getObjectByProperty('uuid', uuid);
		o.position.copy(at); o.updateMatrixWorld(); window.__stores.objectsGroup.update((v) => v);
	}, grabCrate);
	await page.waitForTimeout(500);
	const aiming = await page.evaluate(() => {
		let s; window.__stores.playInteract.playInteractState.subscribe((v) => (s = v))(); return s;
	});
	h.check(aiming.mode === 'aiming', `the reticle finds a grabbable crate (${aiming.mode})`);
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })));
	await page.waitForTimeout(300);
	const carrying = await page.evaluate(() => {
		let d; window.__stores.playInteract.playInteractState.subscribe((v) => (d = v))();
		return window.__stores.playInteract.playInteractDebug().carrying;
	});
	h.check(carrying === grabCrate, `pointerdown grabs the crate (${carrying === grabCrate})`);
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })));
	await page.waitForTimeout(300);

	// 6 — PAUSE menu (P) offers Restart while playing
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'pause', 'P opens the pause menu', 6000);
	h.check(/PAUSED/.test(await hud()) && /Restart round/.test(await hud()), 'pause shows a Restart button');

	// 7 — Restart resets the round: height latches clear, back to the HUD
	await clickBtn('Restart round');
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'Restart returns to play', 8000);
	await h.eventually(async () => await hud(), (t) => /Best height: 0 m/.test(t), 'Restart cleared the height latches', 8000);

	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	await h.finish(browser);
});
