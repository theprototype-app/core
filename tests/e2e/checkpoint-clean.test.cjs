// 50-window (C2): CHECKPOINT THUMBNAILS SHOW THE SCENE, AND LARGE SCENES SKIP AUTO ROWS.
//   1 A/B pixels: a checkpoint cut with the box SELECTED (gizmo), the grid on and a light helper
//     showing is the SAME picture as one cut with none of that (premise: a raw frame of the editor
//     state differs, so the equality is not vacuous); the picture still holds the scene
//   2 large scene (over the budget meter's desktop heavy line — lowered through the meter's own
//     TARGETS for the suite): the automatic row is skipped, ONCE-only notice, a named checkpoint
//     still saves; Settings ▸ Scene "Auto checkpoints on large scenes" turns them back on
//   3 a normal scene still cuts automatic rows (the skip is not a blanket off)
const h = require('./helpers.cjs');

const SHOTS = process.env.CC_SHOTS || '';
const S = (page, fn, arg) => page.evaluate(fn, arg);
const rows = (page) => S(page, () => new Promise((r) => window.__stores.checkpoints.checkpoints.subscribe((v) => r(JSON.parse(JSON.stringify(v))))()));
const storeVal = (page, path) =>
	S(page, (path) => new Promise((r) => {
		let o = window.__stores;
		for (const p of path.split('.')) o = o[p];
		o.subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))();
	}), path);

/** decode two dataURLs in the page and count pixels that differ by more than `tol` in any channel */
const diffPixels = (page, a, b, tol = 24) =>
	S(page, async ({ a, b, tol }) => {
		const load = (src) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = src; });
		const [ia, ib] = await Promise.all([load(a), load(b)]);
		const w = Math.min(ia.width, ib.width), hh = Math.min(ia.height, ib.height);
		const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, hh); return x.getImageData(0, 0, w, hh).data; };
		const da = px(ia), db = px(ib);
		let n = 0;
		for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > tol || Math.abs(da[i + 1] - db[i + 1]) > tol || Math.abs(da[i + 2] - db[i + 2]) > tol) n++;
		return { n, total: w * hh, sameSize: ia.width === ib.width && ia.height === ib.height };
	}, { a, b, tol });

/** a RAW frame of what the editor shows now (no clean view) — the premise for section 1 */
const rawFrame = (page) =>
	S(page, () => new Promise((r) => {
		const s = window.__stores;
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const renderer = get(s.globalRenderer), scene = get(s.globalScene), camera = get(s.globalCamera);
		renderer.render(scene, camera);
		const src = renderer.domElement, scale = Math.min(1, 256 / src.width);
		const c = document.createElement('canvas');
		c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
		c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
		r(c.toDataURL('image/webp', 0.7));
	}));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await S(page, () => window.__stores.checkpoints.autoCheckpoints.set(true));
	// optional: a base without C2 still reaches the pixel A/B below (the counterfactual)
	await S(page, () => window.__stores.checkpoints.autoCheckpointsLarge?.set(false));

	// ---------------------------------------------------------------- 1 clean thumbnails (A/B)
	await S(page, async () => {
		window.__stores.commandsHandler.sceneCommand('/create pointlight');
		await new Promise((r) => setTimeout(r, 400));
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
	});
	await page.waitForTimeout(1500); // let the camera settle (damping) and the light helper appear
	const editorState = await S(page, () => {
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const scene = get(window.__stores.globalScene);
		const tc = get(window.__stores.TControls);
		return { selected: get(window.__stores.selectedObjects)?.length ?? 0, gizmo: !!(tc && tc.object), grid: !!scene.getObjectByName('editor-grid')?.visible };
	});
	h.check(editorState.selected === 1 && editorState.gizmo && editorState.grid, 'premise: the box is selected with the gizmo on it, the grid shows (' + JSON.stringify(editorState) + ')');
	const dirty = await S(page, async () => (await window.__stores.checkpoints.saveCheckpoint({ name: 'With gizmo', quiet: true }))?.thumbnail ?? null);
	const rawDirty = await rawFrame(page);
	// the reference: nothing selected, no gizmo, grid and helpers switched off by hand
	await S(page, () => {
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		window.__stores.objectActions.deselectObject();
		get(window.__stores.TControls)?.detach?.();
	});
	await page.waitForTimeout(500);
	const restore = await S(page, () => {
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const scene = get(window.__stores.globalScene);
		const cam = get(window.__stores.globalCamera);
		const grid = scene.getObjectByName('editor-grid');
		const was = { grid: grid?.visible, layer: cam.layers.isEnabled(30) };
		if (grid) grid.visible = false;
		cam.layers.disable(30);
		window.__cleanRestore = () => { if (grid) grid.visible = was.grid; if (was.layer) cam.layers.enable(30); };
		return was;
	});
	const rawClean = await rawFrame(page);
	await S(page, () => window.__cleanRestore());
	// a SECOND checkpoint needs different content (an identical scene is the same row)… the reference
	// picture is the thumbnail path itself, called directly in the clean state
	const ref = await S(page, () => window.__stores.sessions.viewportThumbnail(256));
	const premise = await diffPixels(page, rawDirty, rawClean);
	h.check(premise.n > 30, 'premise: a raw frame of the editor state differs from the clean one (' + premise.n + ' px — gizmo, grid, helper)');
	h.check(!!dirty && !!ref, 'both pictures exist');
	const ab = await diffPixels(page, dirty, ref);
	h.check(ab.sameSize && ab.n <= Math.max(8, ab.total * 0.002), 'A/B: the checkpoint cut WITH the gizmo, grid and light helper equals the clean picture (' + ab.n + ' of ' + ab.total + ' px differ)');
	const vsRawClean = await diffPixels(page, dirty, rawClean);
	h.check(vsRawClean.n <= Math.max(8, vsRawClean.total * 0.002), 'and equals a raw frame with them switched off by hand (' + vsRawClean.n + ' px)');
	// the picture still shows the scene: hiding the box changes it
	const noBox = await S(page, () => {
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const g = get(window.__stores.objectsGroup);
		const box = g.children.find((c) => c.isMesh);
		box.visible = false;
		const url = window.__stores.sessions.viewportThumbnail(256);
		box.visible = true;
		return url;
	});
	const sceneShown = await diffPixels(page, ref, noBox);
	h.check(sceneShown.n > 100, 'the clean picture still holds the scene (hiding the box changes ' + sceneShown.n + ' px)');
	const after = await S(page, () => {
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const scene = get(window.__stores.globalScene);
		const cam = get(window.__stores.globalCamera);
		return { grid: scene.getObjectByName('editor-grid')?.visible, layer: cam.layers.isEnabled(30) };
	});
	h.check(after.grid === restore.grid && after.layer === restore.layer, 'the editor view is exactly as it was after a clean render (grid, helper layer)');
	if (SHOTS) {
		const fs = require('fs');
		for (const [name, url] of [['01-thumb-with-gizmo.webp', dirty], ['02-thumb-clean-ref.webp', ref], ['03-raw-editor-frame.webp', rawDirty]])
			fs.writeFileSync(SHOTS + '/' + name, Buffer.from(url.split(',')[1], 'base64'));
	}

	// ---------------------------------------------------------------- 2 large scene: skip + notice
	await S(page, () => {
		const t = window.__stores.budgetMeter.TARGETS.desktop;
		window.__realDesktop = { triangles: t.triangles, textureMB: t.textureMB };
		t.triangles = 2; // the suite's scene is "very large" against this line
	});
	const notices = () => S(page, () => new Promise((r) => window.__stores.notifications.subscribe((l) => r(l.filter((n) => String(n.text ?? n.message ?? n).includes('Automatic checkpoints are paused')).length))()));
	const before = (await rows(page)).length;
	await S(page, async () => {
		window.__stores.objectsGroup.subscribe((g) => g.children.find((c) => c.isMesh).position.x += 1)();
		window.__stores.checkpoints.checkpointsDebug.resetLargeNotice();
		window.__stores.checkpoints.checkpointsDebug.resetAutoClock(0);
		await window.__stores.checkpoints.checkpointsDebug.maybeAuto();
	});
	h.check((await rows(page)).length === before, 'a very large scene cuts NO automatic checkpoint');
	const verdict = await storeVal(page, 'checkpoints.largeSceneSkip');
	h.check(verdict?.metric === 'triangles' && verdict.limit === 2, 'the verdict names the metric over the budget meter line (' + JSON.stringify(verdict) + ')');
	await h.eventually(() => page.locator('text=Automatic checkpoints are paused').count(), (n) => n >= 1, 'a notice says automatic checkpoints are paused', 5000);
	h.check(await page.locator('.tp-toast', { hasText: 'Automatic checkpoints are paused' }).locator('button', { hasText: 'Settings' }).first().isVisible(), 'with a way to the setting');
	if (SHOTS) await page.screenshot({ path: SHOTS + '/04-large-scene-notice.png' });
	// the setting, through the notice's own button
	await page.locator('.tp-toast', { hasText: 'Automatic checkpoints are paused' }).locator('button', { hasText: 'Settings' }).first().click();
	const toggle = page.locator('#checkpoints-auto-large');
	await toggle.waitFor({ timeout: 10000 });
	h.check(await toggle.isVisible(), 'the notice opens Settings on the "Auto checkpoints on large scenes" row');
	h.check((await toggle.getAttribute('aria-pressed')) === 'false', 'it is OFF by default');
	await toggle.click();
	h.check((await storeVal(page, 'checkpoints.autoCheckpointsLarge')) === true, 'switching it on writes the setting');
	h.check((await S(page, () => localStorage.getItem('checkpoints:autoLarge'))) === 'true', 'and persists it (this device)');
	if (SHOTS) await page.locator('#row-checkpoints-large').screenshot({ path: SHOTS + '/05-settings-row.png' });
	await S(page, () => window.__stores.settingsOpen.set(false));
	// the notice is one-time, and a named checkpoint is never skipped (setting back OFF for these)
	await S(page, () => window.__stores.checkpoints.autoCheckpointsLarge.set(false));
	await S(page, async () => {
		window.__stores.checkpoints.checkpointsDebug.resetAutoClock(0);
		await window.__stores.checkpoints.checkpointsDebug.maybeAuto();
	});
	h.check((await notices()) === 1, 'the notice is one-time (a second skip says nothing)');
	const named = await S(page, async () => (await window.__stores.checkpoints.saveCheckpoint({ name: 'Big but named', quiet: true }))?.name ?? null);
	h.check(named === 'Big but named', 'a NAMED checkpoint of the large scene still saves');

	await S(page, () => window.__stores.checkpoints.autoCheckpointsLarge.set(true));
	const n0 = (await rows(page)).length;
	await S(page, async () => {
		window.__stores.objectsGroup.subscribe((g) => g.children.find((c) => c.isMesh).position.x += 1)();
		window.__stores.checkpoints.checkpointsDebug.resetAutoClock(0);
		await window.__stores.checkpoints.checkpointsDebug.maybeAuto();
	});
	const withSetting = await rows(page);
	h.check(withSetting.length === n0 + 1 && withSetting[0].auto, 'with the setting ON the large scene cuts its automatic row');

	// ---------------------------------------------------------------- 3 a normal scene is unaffected
	await S(page, () => {
		Object.assign(window.__stores.budgetMeter.TARGETS.desktop, window.__realDesktop);
		window.__stores.checkpoints.autoCheckpointsLarge.set(false);
	});
	const n1 = (await rows(page)).length;
	await S(page, async () => {
		window.__stores.objectsGroup.subscribe((g) => g.children.find((c) => c.isMesh).position.x += 1)();
		window.__stores.checkpoints.checkpointsDebug.resetAutoClock(0);
		await window.__stores.checkpoints.checkpointsDebug.maybeAuto();
	});
	const normal = await rows(page);
	h.check(normal.length === n1 + 1 && normal[0].auto, 'a scene inside the line still cuts automatic rows with the setting OFF');
	h.check((await storeVal(page, 'checkpoints.largeSceneSkip')) === null, 'and reads as not large');

	await h.finish(browser);
});
