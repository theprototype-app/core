// 37-slipped (roadmap 36 B4 remainder, modules DEVX #29 / #31 / #11): the module seams.
//   1. api.registerPointerHandler: in Interact a REAL mouse press-drag-release reaches
//      down/move/up, the hit names the box under the press, and a claimed drag does NOT orbit
//      the camera — the counterfactual (the same drag, handler not claiming) DOES orbit
//   2. in Play the press reaches the handler with mode 'play' (no carry, no tap)
//   3. api.onClickMiss: an Edit click on empty space reaches it
//   4. api.onPlayMode fires true entering Play and false leaving; api.inGame agrees
//   5. api.camera() is the camera the user looks through
//   6. unloading the module removes all of it: the drag orbits again, a miss counts nothing
// The REAL api path: moduleSDK.initModules with an inline module (the sdk-game-seams precedent).
const h = require('./helpers.cjs');

const camPos = (page) =>
	page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		return c.position.toArray();
	});
const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** a canvas pixel whose ray hits NOTHING in the scene (the camera moves during the suite, so
 * look for it at the moment it is needed) @returns {Promise<{x: number, y: number} | null>} */
const emptyPixel = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let cam, group, renderer;
		s.globalCamera.subscribe((v) => (cam = v))();
		s.objectsGroup.subscribe((v) => (group = v))();
		s.globalRenderer.subscribe((v) => (renderer = v))();
		const rect = renderer.domElement.getBoundingClientRect();
		const ray = new s.THREE.Raycaster();
		for (const ny of [0.8, 0.6, 0.4, -0.8, -0.6]) {
			for (const nx of [-0.6, -0.3, 0, 0.3, 0.6]) {
				ray.setFromCamera(new s.THREE.Vector2(nx, ny), cam);
				if (ray.intersectObject(group, true).some((h) => h.object.visible)) continue;
				const x = rect.left + ((nx + 1) / 2) * rect.width;
				const y = rect.top + ((1 - ny) / 2) * rect.height;
				if (document.elementFromPoint(x, y) !== renderer.domElement) continue;
				return { x, y };
			}
		}
		return null;
	});
const seam = (page) => page.evaluate(() => ({ ...window.__ptr, api: undefined }));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	// a box at the origin to press on
	const boxUuid = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.userData.physics = { mode: 'static' };
		box.position.set(0, 0.5, 0);
		s.objectActions.deselectObject();
		return box.uuid;
	});
	await page.evaluate(async () => {
		window.__ptr = { downs: [], moves: 0, ups: 0, claim: true, misses: 0, play: [] };
		await window.__stores.moduleSDK.initModules([
			{
				id: 'ptrseam',
				name: 'Pointer seam test',
				version: '1.0.0',
				description: 'proves the 37 seams',
				register(api) {
					window.__ptr.api = api;
					api.registerPointerHandler(
						{
							down: (hit, ctx) => {
								window.__ptr.downs.push({ uuid: hit?.uuid ?? null, mode: ctx.mode, ray: !!ctx.ray?.ray });
								return window.__ptr.claim;
							},
							move: () => window.__ptr.moves++,
							up: () => window.__ptr.ups++
						},
						{ modes: ['interact', 'play'] }
					);
					api.onClickMiss(() => window.__ptr.misses++);
					api.onPlayMode((p) => window.__ptr.play.push(p));
				}
			}
		]);
	});
	await page.waitForTimeout(400);
	let st = await seam(page);
	h.check(st.play.length === 1 && st.play[0] === false, `onPlayMode answers at once: not playing (${st.play})`);

	console.log('\n=== 1. Interact: a claimed press-drag-release ===');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await page.waitForTimeout(300);
	const onBox = await h.projectPoint(page, [0, 0.5, 0]);
	const at = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [onBox.x, onBox.y]);
	h.check(at === 'CANVAS', `premise: the box's pixel is the canvas (${at})`);
	const drag = async (x, y) => {
		const before = await camPos(page);
		await page.mouse.move(x, y);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 25, y + i * 6);
		await page.mouse.up();
		await page.waitForTimeout(400);
		return moved(before, await camPos(page));
	};
	const claimedOrbit = await drag(onBox.x, onBox.y);
	st = await seam(page);
	h.check(st.downs.length === 1 && st.downs[0].mode === 'interact' && st.downs[0].ray, `down reached the handler in Interact with a ray (${JSON.stringify(st.downs[0])})`);
	h.check(st.downs[0].uuid === boxUuid, `the hit names the box under the press (${st.downs[0].uuid === boxUuid})`);
	h.check(st.moves >= 6 && st.ups === 1, `the drag and the release came to it (moves ${st.moves}, ups ${st.ups})`);
	h.check(claimedOrbit < 0.01, `a CLAIMED drag does not orbit the camera (moved ${claimedOrbit.toFixed(3)})`);
	await page.evaluate(() => (window.__ptr.claim = false));
	const movesBefore = st.moves;
	const freeOrbit = await drag(onBox.x - 200, onBox.y - 100);
	st = await seam(page);
	h.check(freeOrbit > 0.2, `COUNTERFACTUAL: the same drag unclaimed orbits the camera (moved ${freeOrbit.toFixed(2)})`);
	h.check(st.moves === movesBefore && st.ups === 1, `...and an unclaimed gesture sends no move/up (moves ${movesBefore} -> ${st.moves}, ups ${st.ups})`);

	console.log('\n=== 3. onClickMiss: an Edit click on nothing ===');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await page.waitForTimeout(300);
	const sky = await emptyPixel(page);
	h.check(!!sky, `premise: a canvas pixel that hits nothing (${JSON.stringify(sky)})`);
	const misses0 = (await seam(page)).misses;
	await page.mouse.click(sky.x, sky.y);
	await page.waitForTimeout(400);
	h.check((await seam(page)).misses === misses0 + 1, `a click on empty space reached onClickMiss (${misses0} -> ${(await seam(page)).misses})`);

	console.log('\n=== 5. camera() ===');
	h.check(await page.evaluate(() => { let c; window.__stores.globalCamera.subscribe((v) => (c = v))(); return window.__ptr.api.camera() === c; }), 'api.camera() is the camera the user looks through');

	console.log('\n=== 2 + 4. Play: onPlayMode, inGame, and the press ===');
	await page.evaluate(() => (window.__ptr.claim = true));
	await page.locator('#play-button').click();
	await h.eventually(() => seam(page).then((s) => s.play), (p) => p[p.length - 1] === true, 'entering Play: onPlayMode(true)', 6000);
	h.check(await page.evaluate(() => window.__ptr.api.inGame()), 'api.inGame() reads true in Play');
	const downs0 = (await seam(page)).downs.length;
	await page.evaluate(() => {
		const c = document.querySelector('canvas');
		const r = c.getBoundingClientRect();
		const o = { bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse', pointerId: 7 };
		c.dispatchEvent(new PointerEvent('pointerdown', o));
		window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + 20 }));
		window.dispatchEvent(new PointerEvent('pointerup', o));
	});
	await page.waitForTimeout(300);
	st = await seam(page);
	h.check(st.downs.length === downs0 + 1 && st.downs[st.downs.length - 1].mode === 'play', `a Play press reaches the handler with mode 'play' (${JSON.stringify(st.downs[st.downs.length - 1])})`);
	h.check(await page.evaluate(() => window.__stores.playInteract.playInteractDebug?.().lastUp ?? 'module') === 'module', 'the claimed Play release is the module\'s (no tap, no carry)');
	await h.leavePlay(A);
	await h.eventually(() => seam(page).then((s) => s.play), (p) => p[p.length - 1] === false, 'leaving Play: onPlayMode(false)', 6000);

	console.log('\n=== 6. unloading the module takes it all down ===');
	await page.evaluate(() => window.__stores.moduleSDK.deactivateModule('ptrseam'));
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await page.waitForTimeout(300);
	const d0 = (await seam(page)).downs.length;
	const after = await drag(onBox.x, onBox.y);
	h.check((await seam(page)).downs.length === d0 && after > 0.2, `no handler hears the press and the drag orbits again (moved ${after.toFixed(2)})`);
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	const m0 = (await seam(page)).misses;
	const sky2 = (await emptyPixel(page)) ?? sky;
	await page.mouse.click(sky2.x, sky2.y);
	await page.waitForTimeout(300);
	h.check((await seam(page)).misses === m0, 'onClickMiss is gone');
	const seamDbg = await page.evaluate(() => window.__stores.modulePointer?.modulePointerDebug?.() ?? null);
	if (seamDbg) h.check(seamDbg.handlers === 0, `the pointer registry is empty (${JSON.stringify(seamDbg)})`);
	await browser.close();
});
