// 16-P4: camera bookmarks are an unlimited NAMED list that stores the lens
// (FOV + clip planes) and restores it on recall, managed in Configure Scene ▸
// Camera (rename / re-shoot / reorder / delete). Legacy 5-slot payloads
// (`{position,target,ts}`, no name, no lens) normalize on read. Shift+1..5 keep
// recalling the first five entries.
const h = require('./helpers.cjs');

const list = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.cameraBookmarks.bookmarks.subscribe((v) =>
					r(v.map((b) => ({ id: b.id, name: b.name, hasLens: !!b.lens, fov: b.lens?.fov ?? null })))
				)()
			)
	);

const camState = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalCamera.subscribe((c) =>
					r({ fov: Math.round(c.fov), pos: c.position.toArray().map((n) => Math.round(n * 10) / 10) })
				)()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- legacy payloads normalize ----------
	await A.page.evaluate(() =>
		localStorage.setItem(
			'cameraBookmarks',
			JSON.stringify([{ position: [5, 5, 5], target: [0, 0, 0], ts: 1700000000000 }])
		)
	);
	await h.freshReload(A);
	await A.page.waitForTimeout(800);
	let entries = await list(A.page);
	h.check(
		entries.length === 1 && entries[0].name === 'View 1' && entries[0].hasLens === false,
		`a legacy entry loads with a default name and no lens (${JSON.stringify(entries)})`
	);

	// ---------- save captures the lens ----------
	await A.page.evaluate(() => {
		window.__stores.cameraBookmarks.clearBookmarks();
		let cam = null;
		window.__stores.globalCamera.subscribe((c) => (cam = c))();
		cam.fov = 70;
		cam.updateProjectionMatrix();
		cam.position.set(12, 6, 12);
		window.__stores.cameraBookmarks.saveBookmark('Wide shot');
	});
	await A.page.waitForTimeout(300);
	entries = await list(A.page);
	h.check(entries.length === 1 && entries[0].name === 'Wide shot', `a save is named (${entries[0]?.name})`);
	h.check(entries[0].hasLens && Math.round(entries[0].fov) === 70, `it stored the lens (${entries[0].fov}°)`);

	// no 5-entry cap any more: a sixth save keeps all six
	await A.page.evaluate(() => {
		for (let i = 0; i < 5; i++) window.__stores.cameraBookmarks.saveBookmark();
	});
	await A.page.waitForTimeout(300);
	entries = await list(A.page);
	h.check(entries.length === 6, `the 5-slot cap is gone (${entries.length} entries)`);

	// ---------- recall restores position AND lens ----------
	await A.page.evaluate(() => {
		let cam = null;
		window.__stores.globalCamera.subscribe((c) => (cam = c))();
		cam.fov = 25;
		cam.updateProjectionMatrix();
		cam.position.set(-3, 2, -3);
	});
	await A.page.evaluate(() => window.__stores.cameraBookmarks.recallBookmark(0));
	await A.page.waitForTimeout(900); // flyTo tween is 400ms
	const after = await camState(A.page);
	h.check(after.fov === 70, `recall restored the FOV (${after.fov}°)`);
	h.check(
		Math.abs(after.pos[0] - 12) < 0.6 && Math.abs(after.pos[2] - 12) < 0.6,
		`recall flew to the saved position (${after.pos})`
	);

	// ---------- management: rename / overwrite / reorder / delete ----------
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(600);
	const rows = await A.page.evaluate(() => document.querySelectorAll('#bookmark-list .bookmark-row').length);
	h.check(rows === 6, `Configure Scene lists every view (${rows} rows)`);

	const ids = (await list(A.page)).map((b) => b.id);
	// rename through the UI input
	const nameInput = A.page.locator('#bookmark-list .bookmark-row input').nth(1);
	await nameInput.fill('Top down');
	await nameInput.dispatchEvent('change');
	await A.page.waitForTimeout(250);
	entries = await list(A.page);
	h.check(entries[1].name === 'Top down', `renaming through the panel works (${entries[1].name})`);

	// overwrite re-shoots the entry from the current view, keeping the name
	await A.page.evaluate(() => {
		let cam = null;
		window.__stores.globalCamera.subscribe((c) => (cam = c))();
		cam.fov = 33;
		cam.updateProjectionMatrix();
		cam.position.set(1, 9, 1);
	});
	await A.page.evaluate((id) => window.__stores.cameraBookmarks.overwriteBookmark(id), ids[1]);
	await A.page.waitForTimeout(250);
	entries = await list(A.page);
	h.check(
		entries[1].name === 'Top down' && Math.round(entries[1].fov) === 33,
		`overwrite keeps the name and takes the new lens (${entries[1].fov}°)`
	);

	// reorder: moving up changes which Shift+N reaches it
	await A.page.evaluate((id) => window.__stores.cameraBookmarks.moveBookmark(id, -1), ids[1]);
	await A.page.waitForTimeout(250);
	entries = await list(A.page);
	h.check(entries[0].id === ids[1], 'moveBookmark reorders the list');

	// delete
	await A.page.evaluate((id) => window.__stores.cameraBookmarks.deleteBookmark(id), ids[1]);
	await A.page.waitForTimeout(250);
	entries = await list(A.page);
	h.check(entries.length === 5 && !entries.some((b) => b.id === ids[1]), `delete removes one (${entries.length} left)`);

	// ---------- Shift+2 recalls the second entry ----------
	const secondFov = entries[1].fov;
	await A.page.evaluate(() => {
		let cam = null;
		window.__stores.globalCamera.subscribe((c) => (cam = c))();
		cam.fov = 55;
		cam.updateProjectionMatrix();
	});
	await A.page.click('canvas', { position: { x: 400, y: 300 } }).catch(() => {});
	await A.page.keyboard.press('Shift+Digit2');
	await A.page.waitForTimeout(900);
	const viaShortcut = await camState(A.page);
	h.check(
		secondFov === null || viaShortcut.fov === Math.round(secondFov),
		`Shift+2 recalls the second view (${viaShortcut.fov}° vs ${secondFov}°)`
	);

	// ---------- orbit prefs ----------
	await A.page.evaluate(() => window.__stores.cameraClip.setOrbitPrefs({ rotateSpeed: 1.8, invertY: true }));
	await A.page.waitForTimeout(200);
	const orbit = await A.page.evaluate(
		() => new Promise((r) => window.__stores.orbitControls.subscribe((o) => r({ rotate: o?.rotateSpeed, zoom: o?.zoomSpeed }))())
	);
	h.check(
		Math.abs(orbit.rotate + 1.8) < 0.001,
		`orbit prefs reach the live controls, invert flips the sign (${orbit.rotate})`
	);
	await A.page.evaluate(() => window.__stores.cameraClip.resetOrbitPrefs());
	await A.page.waitForTimeout(200);
	const reset = await A.page.evaluate(
		() => new Promise((r) => window.__stores.orbitControls.subscribe((o) => r(o?.rotateSpeed))())
	);
	h.check(reset === 1, `reset restores the default feel (${reset})`);

	await h.finish(browser);
});
