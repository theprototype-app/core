// 37-avatar-fix R24 — FLYING IS OPT-IN. A game flies only when it says so; Configure Scene ▸
// Physics ▸ Play mode ▸ Flying (Off / Allowed / Removed) is the scene's word; the editor still flies.
//  1. A plain scene in Play: Q / E do nothing (the eye stays at 1.7 m), no Up/Down touch buttons.
//  2. Flying ▸ Allowed (the real control): Q / E fly, the touch overlay offers Up/Down.
//  3. Flying ▸ Removed beats a Character Controller node in fly mode: still no flying.
//  4. Back to Off: hidden again. The editor's own fly navigation is unaffected throughout.
// Every shipped game's play block is checked against the rule in the vitest `flyOptIn` (only the
// games designed to fly do).
const h = require('./helpers.cjs');

const SHOTS = process.env.AVATAR_SHOTS || '';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;

	const eyeY = () =>
		page.evaluate(() => {
			let cam;
			window.__stores.playerCam.subscribe((c) => (cam = c))();
			return cam ? cam.getWorldPosition(new window.__stores.THREE.Vector3()).y : null;
		});
	const touch = () =>
		page.evaluate(() => {
			let spec;
			window.__stores.touchSpec.touchSpec.subscribe((v) => (spec = v))();
			return { preset: spec.preset, ids: spec.actions.map((a) => a.id) };
		});
	const fly = () => page.evaluate(() => window.__stores.playSettings.resolvePlaySettings(null).fly);
	/** enter Play, hold a key, leave: how far the eye rose */
	const holdIn = async (code, ms = 900) => {
		await page.evaluate(() => window.__stores.isLocked.set(true));
		await page.waitForTimeout(500);
		const y0 = await eyeY();
		await page.keyboard.down(code);
		await page.waitForTimeout(ms);
		await page.keyboard.up(code);
		const y1 = await eyeY();
		await h.leavePlay(A);
		return { y0, y1, dy: y1 - y0 };
	};
	const pick = async (label) => {
		await page.evaluate(() => window.__stores.openSceneSection('Physics'));
		const opt = page.locator('#physics-play-flying [role="radio"]', { hasText: label });
		await opt.waitFor({ state: 'visible', timeout: 10000 });
		await opt.scrollIntoViewIfNeeded();
		await opt.click();
	};

	// ---- 1. the default: no flying ---------------------------------------------------------------
	h.check((await fly()) === 'off', '1.1 a plain scene does not fly (the rule reads "off")');
	const up1 = await holdIn('KeyE');
	h.check(Math.abs(up1.y1 - 1.7) < 0.02 && Math.abs(up1.dy) < 0.02, `1.2 E in Play does not rise (eye ${up1.y1?.toFixed(3)} m)`);
	const dn1 = await holdIn('KeyQ');
	h.check(Math.abs(dn1.dy) < 0.02, `1.3 Q in Play does not sink (${dn1.dy.toFixed(3)} m)`);
	const t1 = await touch();
	h.check(!t1.ids.includes('up') && !t1.ids.includes('down') && t1.preset !== 'fly', `1.4 no Up/Down touch buttons (${t1.preset}: ${t1.ids.join(',') || 'none'})`);

	// ---- 2. Allowed --------------------------------------------------------------------------------
	await pick('Allowed');
	const checked = await page.locator('#physics-play-flying [role="radio"][aria-checked="true"]').innerText();
	h.check(checked.trim() === 'Allowed', '2.1 the Flying control reads Allowed');
	if (SHOTS) await page.screenshot({ path: SHOTS + '/05-flying-setting.png' });
	const playBlock = await page.evaluate(() => {
		let p;
		window.__stores.scenePhysics.scenePlay.subscribe((v) => (p = v))();
		return p;
	});
	h.check(playBlock?.locomotion?.fly === true && !playBlock.locomotion.noFly, '2.2 the scene play block carries locomotion.fly (shared scene data)');
	h.check((await fly()) === 'allowed', '2.3 the rule now reads "allowed"');
	const up2 = await holdIn('KeyE');
	h.check(Math.abs(up2.dy) > 0.2, `2.4 E in Play flies (${up2.dy.toFixed(2)} m)`);
	const t2 = await touch();
	h.check(t2.ids.includes('up') && t2.ids.includes('down'), `2.5 the touch overlay offers Up/Down (${t2.ids.join(',')})`);

	// ---- 3. Removed beats a fly-mode Character Controller ------------------------------------------
	await pick('Removed');
	// a REAL fly-mode Character Controller node (the runtime re-declares charControl from the graph)
	const ccNode = (mode) =>
		page.evaluate((mode) => {
			window.__stores.setActiveGraph(window.__stores.SCENE_GRAPH);
			window.__stores.flowNodes.set(
				mode ? [{ id: 'cc', type: 'charcontroller', position: { x: 0, y: 0 }, data: { type: 'charcontroller', mode, speed: 0.1, jumpHeight: 1, eyeHeight: 1.7, gravity: true }, class: 'w-[150px]' }] : []
			);
			window.__stores.flowEdges.set([]);
		}, mode);
	await ccNode('fly');
	await h.eventually(() => page.evaluate(() => { let c; window.__stores.charController.charControl.subscribe((v) => (c = v))(); return c?.mode; }), (m) => m === 'fly', '3.0 (premise) a fly-mode Character Controller is declared', 6000);
	h.check((await fly()) === 'removed', '3.1 Removed wins over a Character Controller in fly mode');
	const up3 = await holdIn('KeyE');
	h.check(Math.abs(up3.dy) < 0.02, `3.2 E in Play does not rise (${up3.dy.toFixed(3)} m)`);
	const t3 = await touch();
	h.check(!t3.ids.includes('up'), '3.3 no Up/Down touch buttons');
	// ...and without Removed that node is a game designed to fly
	await pick('Off');
	h.check((await fly()) === 'allowed', '3.4 Off + a fly-mode Character Controller: the game flies');
	const t4 = await touch();
	h.check(t4.ids.includes('up'), '3.5 ...and the touch overlay offers Up/Down');
	await ccNode(null);

	// ---- 4. Off again; the editor still flies ------------------------------------------------------
	await h.eventually(() => fly(), (f) => f === 'off', '4.1 Off and no controller: flying hidden again', 6000);
	const camY0 = await page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((x) => (c = x))();
		return c.position.y;
	});
	// give the VIEWPORT the keyboard (the last click was in the Configure Scene panel)
	await page.evaluate(() => window.__stores.sceneInspectorOpen?.set?.(false));
	await page.keyboard.press('Escape');
	await page.mouse.click(640, 420);
	await page.waitForTimeout(300);
	await page.keyboard.down('KeyE');
	await page.waitForTimeout(600);
	await page.keyboard.up('KeyE');
	const camY1 = await page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((x) => (c = x))();
		return c.position.y;
	});
	h.check(Math.abs(camY1 - camY0) > 0.05, `4.2 the EDITOR's own E still flies the view (${(camY1 - camY0).toFixed(2)} m)`);
	await h.finish(browser);
});
