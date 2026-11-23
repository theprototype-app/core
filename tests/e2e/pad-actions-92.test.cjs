// 92-input GC3 — a gamepad for every play action, the remap rows, and prompts with the right glyphs.
// `navigator.getGamepads` is stubbed with a fake pad (the gamepad-input suite's seam: the poll owns the
// device, so every consumer runs its real code). What is NOT testable here: feel, and a real pad's id.
//   1. A jumps the walker (red on v1.74.0: the walker's jump had no pad path)
//   2. a Gamepad Button node on A makes A the game's: no jump
//   3. Start leaves Play when the scene is no game (Escape's job on a pad)
//   4. the device: a pad press makes prompts pad prompts in the pad's family (a PlayStation pad: Cross,
//      Options), a key press makes them keys again; the banner and a HUD key hint follow
//   5. the pause menu's Controls: the built-in pad actions are rows; remapping Jump to B on the shared
//      capture FLAGS the conflict (Crouch moved) and then B jumps; Esc cancels a capture
//   6. Move Input reads the left stick
// Run: APP_URL=https://localhost:5922/ npm run e2e -- pad-actions-92
const h = require('./helpers.cjs');

const A_BTN = 0;
const B_BTN = 1;
const START = 9;

/** @param {any} page */
async function stubPad(page) {
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__pad = {
			id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
			index: 0,
			connected: true,
			mapping: 'standard',
			axes: [0, 0, 0, 0],
			buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }))
		};
		Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [w.__pad] });
		w.__padSet = (/** @type {number} */ i, /** @type {boolean} */ on) => {
			w.__pad.buttons[i].pressed = on;
			w.__pad.buttons[i].value = on ? 1 : 0;
		};
	});
}
/** press and release a pad button (held long enough for a few polls) @param {any} page @param {number} i */
async function tap(page, i, ms = 250) {
	await page.evaluate((i) => /** @type {any} */ (window).__padSet(i, true), i);
	await page.waitForTimeout(ms);
	await page.evaluate((i) => /** @type {any} */ (window).__padSet(i, false), i);
	await page.waitForTimeout(250);
}
const V = (/** @type {any} */ page, /** @type {Function} */ fn, /** @type {any} */ arg) => page.evaluate(fn, arg);
/** read a store off the facade @param {any} page @param {string} path */
const read = (page, path) =>
	page.evaluate((p) => {
		/** @type {any} */ let v;
		p.split('.').reduce((o, k) => o[k], /** @type {any} */ (window).__tp.test.v1).subscribe((/** @type {any} */ x) => (v = x))();
		return JSON.parse(JSON.stringify(v ?? null));
	}, path);
/** the walker's world y @param {any} page */
const eyeY = (page) =>
	V(page, () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		/** @type {any} */ let cam;
		s.playerCam.subscribe((/** @type {any} */ c) => (cam = c))();
		return cam.getWorldPosition(new s.THREE.Vector3()).y;
	});
/** the scene graph: a walking controller (+ extra nodes) @param {any} page @param {any[]} extra */
const graph = (page, extra = []) =>
	V(
		page,
		(extra) => {
			const s = /** @type {any} */ (window).__tp.test.v1;
			s.setActiveGraph(s.SCENE_GRAPH);
			s.flowNodes.set([{ id: 'cc', type: 'charcontroller', position: { x: 0, y: 0 }, data: { type: 'charcontroller', mode: 'walk', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7, gravity: true } }, ...extra]);
			s.flowEdges.set([]);
		},
		extra
	);
/** the highest the walker gets in `ms` after a press of button i @param {any} page @param {number} i */
async function jumpPeak(page, i) {
	await page.waitForTimeout(800); // standing
	const y0 = await eyeY(page);
	await V(page, () => {
		const w = /** @type {any} */ (window);
		w.__peak = -1e9;
		const s = w.__tp.test.v1;
		/** @type {any} */ let cam;
		s.playerCam.subscribe((/** @type {any} */ c) => (cam = c))();
		const v = new s.THREE.Vector3();
		w.__peakOn = true;
		const step = () => {
			w.__peak = Math.max(w.__peak, cam.getWorldPosition(v).y);
			if (w.__peakOn) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	await tap(page, i);
	await page.waitForTimeout(900);
	const peak = await V(page, () => {
		const w = /** @type {any} */ (window);
		w.__peakOn = false;
		return w.__peak;
	});
	return peak - y0;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await stubPad(page);
	await graph(page);
	await V(page, () => /** @type {any} */ (window).__tp.test.v1.isLocked.set(true));
	await h.eventually(() => V(page, () => /** @type {any} */ (window).__tp.test.v1.padActions.padActionsDebug()), (d) => d.started, '0. the pad bridge loads once a pad is seen', 15000);

	console.log('\n=== 1. A jumps the walker ===');
	const rise = await jumpPeak(page, A_BTN);
	const dbg1 = await V(page, () => /** @type {any} */ (window).__tp.test.v1.padActions.padActionsDebug());
	h.check(rise > 0.4, `1. A jumps the walker (rose ${rise.toFixed(2)} m; red on v1.74.0: no pad path to the jump) ${JSON.stringify(dbg1)}`);

	console.log('\n=== 2. a Gamepad Button node on A makes A the game\'s ===');
	await graph(page, [{ id: 'gb', type: 'gamepadbutton', position: { x: 0, y: 200 }, data: { type: 'gamepadbutton', button: 'GamepadA', pulse: 0.3 } }]);
	const rise2 = await jumpPeak(page, A_BTN);
	h.check(rise2 < 0.1, `2. with a Gamepad Button node on A, A does not jump (rose ${rise2.toFixed(2)} m)`);
	await graph(page);

	console.log('\n=== 4. the device prompts follow ===');
	let input = await read(page, 'activeDevice.activeInput');
	h.check(input.kind === 'pad' && input.family === 'playstation', '4.1 a pad press makes the pad the device, PlayStation family (' + JSON.stringify(input) + ')');
	await page.waitForTimeout(300);
	const banner = await page.locator('#play-banner .pb-hint [data-glyph]').first().getAttribute('data-glyph-text').catch(() => null);
	h.check(banner === 'Options', '4.2 the banner says to press Options for the menu (' + banner + ')');
	// a HUD key hint naming Space shows the pad's jump button
	await V(page, () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		s.hudDocs.setHudDocFor('scene', { screens: [{ id: 'sc', name: 'Play', elements: [{ id: 'kh', kind: 'keyhint', anchor: 'center', x: 0, y: 0, w: 160, h: 30, keyName: 'Space', label: 'Jump' }] }], active: 'sc' });
	});
	await h.eventually(() => page.locator('[data-hud-id="kh"] [data-glyph]').first().getAttribute('data-glyph').catch(() => null), (g) => g === 'cross', '4.3 a key hint for Space shows the Cross glyph on a PlayStation pad', 10000);
	await page.keyboard.press('KeyK');
	await h.eventually(() => page.locator('[data-hud-id="kh"] [data-glyph]').first().getAttribute('data-glyph').catch(() => null), (g) => g === 'key', '4.4 a key press makes it a key again', 10000);
	const keyText = (await page.locator('[data-hud-id="kh"] [data-glyph="key"]').first().textContent().catch(() => '')) ?? '';
	h.check(keyText.trim() === 'Space', '4.5 ...the key it shows is Space (' + keyText + ')');
	await V(page, () => /** @type {any} */ (window).__tp.test.v1.hudDocs.setHudDocFor('scene', null));

	console.log('\n=== 5. the Controls rows, the shared capture, the flagged conflict ===');
	await V(page, () => /** @type {any} */ (window).__tp.test.v1.gameKit.gameShell.openAccessCard());
	await page.waitForTimeout(400);
	const rows = await page.$$eval('[data-remap^="pad:"]', (els) => els.map((e) => e.getAttribute('data-remap')));
	h.check(['pad:GamepadA', 'pad:GamepadX', 'pad:GamepadB', 'pad:GamepadStart'].every((r) => rows.includes(r)), '5.1 the built-in pad actions are rows (' + rows.join(' ') + ')');
	const glyphA = await page.locator('[data-remap="pad:GamepadA"] [data-glyph]').first().getAttribute('data-glyph');
	h.check(glyphA === 'cross', '5.2 the Jump row draws its button as the Cross (' + glyphA + ')');
	// Esc cancels a capture
	await page.click('[data-remap="pad:GamepadA"] button');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	let remap = await read(page, 'gameKit.playerAccess.accessRemap');
	h.check(!Object.keys(remap.pad).length && (await page.locator('#game-access-page').isVisible()), '5.3 Esc cancels the capture and leaves the page open');
	// Jump -> B (Crouch's button): the swap is flagged
	await page.click('[data-remap="pad:GamepadA"] button');
	await page.waitForTimeout(150);
	await tap(page, B_BTN);
	remap = await read(page, 'gameKit.playerAccess.accessRemap');
	const note = ((await page.textContent('[data-remap-note]')) ?? '').trim();
	h.check(remap.pad.GamepadA === 'GamepadB' && remap.pad.GamepadB === 'GamepadA', '5.4 Jump moves to B and Crouch takes A (' + JSON.stringify(remap.pad) + ')');
	h.check(/Jump took Circle; Crouch moved to Cross/.test(note), '5.5 the conflict is flagged in the pad\'s own names: "' + note + '"');
	await V(page, () => /** @type {any} */ (window).__tp.test.v1.gameKit.gameShell.closeShellMenu());
	await page.waitForTimeout(300);
	const riseB = await jumpPeak(page, B_BTN);
	h.check(riseB > 0.4, `5.6 now B jumps (rose ${riseB.toFixed(2)} m)`);
	await V(page, () => /** @type {any} */ (window).__tp.test.v1.gameKit.playerAccess.resetRemap());

	console.log('\n=== 6. Move Input reads the left stick ===');
	await graph(page, [{ id: 'mi', type: 'moveinput', position: { x: 0, y: 200 }, data: { type: 'moveinput' } }]);
	await V(page, () => (/** @type {any} */ (window).__pad.axes = [0, -1, 0, 0]));
	await page.waitForTimeout(600);
	const mi = await V(page, () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		/** @type {any} */ let vals;
		s.flowValues.subscribe((/** @type {any} */ v) => (vals = v))();
		return vals?.mi ?? null;
	});
	await V(page, () => (/** @type {any} */ (window).__pad.axes = [0, 0, 0, 0]));
	h.check(!!mi && mi.__handles?.y > 0.9, '6. stick forward reads y = 1 on Move Input (' + JSON.stringify(mi) + ')');

	console.log('\n=== 3. Start leaves Play when the scene is no game ===');
	await graph(page);
	await page.waitForTimeout(300);
	await tap(page, START);
	await h.eventually(() => read(page, 'isLocked'), (v) => v !== true, '3. Start leaves Play (Escape\'s job)', 8000);

	await browser.close();
});
