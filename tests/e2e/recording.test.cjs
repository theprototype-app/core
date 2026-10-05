// 36-share (B13) — TOOLS ▸ RECORDING: a turntable / flythrough of the viewport as a webm.
//
//   1. the viewport menu's Tools ▸ Recording… opens the dialog; a flythrough with < 2 saved views
//      is refused with the reason, and Start is disabled
//   2. a 2-s TURNTABLE at 720p is recorded through the real UI: the progress bar shows and
//      advances, the camera ORBITS during the take (its azimuth sweeps) and comes back to where it
//      was afterwards, the editor helpers are hidden while it runs and back after
//   3. the file PLAYS: the result card's <video> loads it, reports a finite duration within
//      ±0.35 s of 2 s and a 1280×720 picture, and its clock advances when played
//   4. the webm carries its Duration (the EBML patch), it is in the Explorer's Recordings folder
//      as a `video` item, and Download hands over a .webm whose bytes match
//   5. Cancel mid-take saves nothing and restores the camera
//   6. a 2-s FLYTHROUGH through two saved views starts at the first view and ends at the second
// Evidence: RECORDING_SHOTS=<dir> writes screenshots there.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.RECORDING_SHOTS || '';
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
}

/** camera position + azimuth about the controls' target @param {any} page */
const camState = (page) =>
	page.evaluate(() => {
		let cam = /** @type {any} */ (null);
		let ctl = /** @type {any} */ (null);
		window.__stores.globalCamera.subscribe((/** @type {any} */ c) => (cam = c))();
		window.__stores.orbitControls.subscribe((/** @type {any} */ c) => (ctl = c))();
		return { pos: cam.position.toArray(), target: ctl.target.toArray(), fov: cam.fov };
	});

const state = (/** @type {any} */ page) =>
	page.evaluate(() => {
		let s = /** @type {any} */ (null);
		window.__stores.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
		return { status: s.status, progress: s.progress, error: s.error, result: s.result ? { name: s.result.name, bytes: s.result.bytes, durationMs: s.result.durationMs, w: s.result.width, h: s.result.height, itemId: s.result.itemId, mime: s.result.mime } : null };
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 }, acceptDownloads: true } });
	const { page } = A;

	// a small scene to film
	await page.evaluate(() => {
		const s = window.__stores;
		s.cameraBookmarks.clearBookmarks();
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(1200);

	// ---------- 1. the menu entry + the flythrough refusal ----------
	// the viewport's right-click menu (opened the way its own suites do)
	await page.evaluate(() => window.__stores.viewportMenu.set({ x: 200, y: 160, point: { x: 0, y: 0, z: 0 } }));
	await page.locator('[role="menuitem"]', { hasText: /^\s*Tools/ }).first().hover();
	await page.locator('[role="menuitem"]', { hasText: /^\s*Recording…\s*$/ }).first().click();
	await page.waitForSelector('#recording-dialog', { timeout: 10000 });
	h.check(true, 'Tools ▸ Recording… opens the Recording dialog');
	await page.click('#recording-mode-flythrough');
	await page.waitForTimeout(200);
	const refused = await page.evaluate(() => ({
		blocked: document.querySelector('#recording-blocked')?.textContent ?? '',
		disabled: /** @type {HTMLButtonElement} */ (document.querySelector('#recording-start'))?.disabled
	}));
	h.check(/two saved camera views/.test(refused.blocked) && refused.disabled === true, `a flythrough with no saved views is refused with the reason (${refused.blocked.slice(0, 60)}…)`);
	await shot(page, '01-dialog-flythrough-refused.png');

	// ---------- 2. a 2-s turntable at 720p through the real UI ----------
	await page.click('#recording-mode-turntable');
	await page.selectOption('#recording-resolution', '720p');
	await page.selectOption('#recording-fps', '30');
	await page.fill('#recording-duration', '2');
	await page.locator('#recording-duration').dispatchEvent('change');
	await page.selectOption('#recording-target', 'scene');
	await page.waitForTimeout(200);
	await shot(page, '02-dialog-turntable.png');
	const before = await camState(page);
	const gridBefore = await page.evaluate(() => !!window.__stores.globalScene && (() => { let g = null; window.__stores.globalScene.subscribe((/** @type {any} */ s) => (g = s.getObjectByName('editor-grid')))(); return !!g; })());
	await page.click('#recording-start');
	await page.waitForSelector('#recording-bar', { timeout: 5000 });
	h.check(true, 'starting shows the progress bar (the dialog steps aside)');
	const dialogHidden = await page
		.waitForSelector('#recording-dialog', { state: 'detached', timeout: 3000 })
		.then(() => true)
		.catch(() => false);
	h.check(dialogHidden, 'the dialog is out of the way while recording');

	// sample the camera during the take: it must ORBIT (azimuth sweeps), at a constant distance
	/** @type {number[]} */
	const azimuths = [];
	/** @type {number[]} */
	const dists = [];
	let helpersHiddenDuring = false;
	let sawProgress = 0;
	for (let i = 0; i < 12; i++) {
		await page.waitForTimeout(150);
		// read the state and the camera in one go, and keep only samples taken DURING the take
		// (before it, the camera is still being posed; after it, it is being restored)
		const st = await state(page);
		const c = await camState(page);
		sawProgress = Math.max(sawProgress, st.progress);
		if (st.status !== 'recording' || (await state(page)).status !== 'recording') continue;
		const dx = c.pos[0] - c.target[0];
		const dz = c.pos[2] - c.target[2];
		azimuths.push(Math.atan2(dx, dz));
		dists.push(Math.hypot(dx, c.pos[1] - c.target[1], dz));
		if (!helpersHiddenDuring)
			helpersHiddenDuring = await page.evaluate(() => {
				let clean = false;
				window.__stores.helperLayer.recordingClean.subscribe((/** @type {boolean} */ v) => (clean = v))();
				let g = null;
				window.__stores.globalScene.subscribe((/** @type {any} */ s) => (g = s.getObjectByName('editor-grid')))();
				return clean && !g;
			});
		if (i === 5) await shot(page, '03-recording-bar.png');
	}
	// unwrap the angle so a sweep through ±π reads as continuous
	let swept = 0;
	for (let i = 1; i < azimuths.length; i++) {
		let d = azimuths[i] - azimuths[i - 1];
		if (d > Math.PI) d -= 2 * Math.PI;
		if (d < -Math.PI) d += 2 * Math.PI;
		swept += Math.abs(d);
	}
	const distSpread = Math.max(...dists) - Math.min(...dists);
	h.check(azimuths.length >= 5, `enough samples inside the take (${azimuths.length})`);
	h.check(swept > 2.0, `the camera orbits during the take (swept ${(swept * 57.3).toFixed(0)}° of the samples)`);
	h.check(distSpread < 0.05, `at a constant distance (spread ${distSpread.toFixed(4)})`);
	h.check(sawProgress > 0.2, `the progress advances (${Math.round(sawProgress * 100)}%)`);
	h.check(helpersHiddenDuring, 'the helpers are hidden while recording (recordingClean on, the editor grid unmounted)');

	await page.waitForSelector('#recording-result', { timeout: 20000 });
	const done = await state(page);
	h.check(done.status === 'done' && !!done.result, `the recording finishes (${done.status} ${done.error})`);
	const after = await camState(page);
	const back = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1], after.pos[2] - before.pos[2]);
	h.check(back < 1e-3, `the camera is back where it was (${back.toFixed(5)})`);
	const gridAfter = await page.evaluate(() => { let g = null; window.__stores.globalScene.subscribe((/** @type {any} */ s) => (g = s.getObjectByName('editor-grid')))(); return !!g; });
	h.check(gridAfter === gridBefore, 'the editor grid is back afterwards');

	// ---------- 3. the file plays, duration right ----------
	const meta = await page.evaluate(async () => {
		const v = /** @type {HTMLVideoElement} */ (document.querySelector('#recording-video'));
		if (!v) return null;
		if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
		const duration = v.duration;
		const t0 = v.currentTime;
		v.muted = true;
		await v.play().catch(() => {});
		await new Promise((r) => setTimeout(r, 700));
		const advanced = v.currentTime - t0;
		v.pause();
		return { duration, w: v.videoWidth, h: v.videoHeight, advanced, error: v.error?.code ?? 0 };
	});
	h.check(!!meta && meta.error === 0, `the result <video> loads the file (${JSON.stringify(meta)})`);
	h.check(!!meta && Number.isFinite(meta.duration) && Math.abs(meta.duration - 2) <= 0.35, `its duration is finite and ≈ 2 s (${meta?.duration})`);
	h.check(!!meta && meta.w === 1280 && meta.h === 720, `the picture is 1280×720 (${meta?.w}×${meta?.h})`);
	h.check(!!meta && meta.advanced > 0.2, `it PLAYS: the clock advances (${meta?.advanced?.toFixed(2)} s in 0.7 s)`);
	await shot(page, '04-result.png');

	// ---------- 4. Duration in the bytes, the Explorer item, the download ----------
	const fileFacts = await page.evaluate(async () => {
		let s = /** @type {any} */ (null);
		window.__stores.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
		const bytes = new Uint8Array(await s.result.blob.arrayBuffer());
		return { declared: window.__stores.webmDuration.readWebmDuration(bytes), size: bytes.length, head: [...bytes.slice(0, 4)] };
	});
	h.check(fileFacts.head.join(',') === '26,69,223,163', 'the file is EBML (webm)');
	h.check(fileFacts.declared !== null && Math.abs(fileFacts.declared - 2000) <= 350, `the webm declares its Duration (${fileFacts.declared} ms)`);
	const item = await page.evaluate(async (id) => {
		const ex = window.__stores.explorer;
		let folders = /** @type {any[]} */ ([]);
		ex.explorerFolders.subscribe((/** @type {any} */ v) => (folders = v))();
		const rec = ex.itemById(id);
		const folder = folders.find((f) => f.id === rec?.folderId);
		return rec ? { kind: rec.kind, name: rec.name, size: rec.size, folder: folder?.name ?? null, thumb: !!rec.thumbnail } : null;
	}, done.result?.itemId);
	h.check(!!item && item.kind === 'video' && item.folder === 'Recordings', `saved to Explorer ▸ Recordings as a video item (${JSON.stringify(item)})`);
	h.check(!!item && item.size === fileFacts.size, 'the Explorer copy is the same file');
	h.check(!!item && item.thumb, 'the Explorer card has a thumbnail from the take');
	const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#recording-download')]);
	const dlPath = await download.path();
	const dlSize = dlPath ? fs.statSync(dlPath).size : -1;
	h.check(/\.webm$/.test(download.suggestedFilename()) && dlSize === fileFacts.size, `Download hands over ${download.suggestedFilename()} (${dlSize} bytes)`);

	// ---------- 5. Cancel saves nothing and restores the camera ----------
	await page.click('#recording-again');
	await page.fill('#recording-duration', '6');
	await page.locator('#recording-duration').dispatchEvent('change');
	const countBefore = await page.evaluate(async () => {
		const ex = window.__stores.explorer;
		let items = /** @type {any[]} */ ([]);
		ex.explorerItems.subscribe((/** @type {any} */ v) => (items = v))();
		return items.filter((i) => i.kind === 'video').length;
	});
	const beforeCancel = await camState(page);
	await page.click('#recording-start');
	await page.waitForSelector('#recording-cancel', { timeout: 5000 });
	await page.waitForTimeout(900);
	await page.click('#recording-cancel');
	await page.waitForTimeout(800);
	const cancelled = await state(page);
	const afterCancel = await camState(page);
	const countAfter = await page.evaluate(async () => {
		const ex = window.__stores.explorer;
		let items = /** @type {any[]} */ ([]);
		ex.explorerItems.subscribe((/** @type {any} */ v) => (items = v))();
		return items.filter((i) => i.kind === 'video').length;
	});
	const moved = Math.hypot(afterCancel.pos[0] - beforeCancel.pos[0], afterCancel.pos[1] - beforeCancel.pos[1], afterCancel.pos[2] - beforeCancel.pos[2]);
	h.check(cancelled.status === 'idle' && !cancelled.result, `Cancel ends the take with no file (${cancelled.status})`);
	h.check(countAfter === countBefore, `nothing new in the Explorer (${countBefore} → ${countAfter})`);
	h.check(moved < 1e-3 && !(await page.$('#recording-bar')), `the camera is restored and the bar gone (${moved.toFixed(5)})`);

	// ---------- 6. a flythrough through two saved views ----------
	await page.evaluate(() => {
		let cam = /** @type {any} */ (null);
		let ctl = /** @type {any} */ (null);
		window.__stores.globalCamera.subscribe((/** @type {any} */ c) => (cam = c))();
		window.__stores.orbitControls.subscribe((/** @type {any} */ c) => (ctl = c))();
		cam.position.set(8, 4, 8);
		ctl.target.set(0, 0, 0);
		ctl.update();
		window.__stores.cameraBookmarks.saveBookmark('From');
		cam.position.set(-6, 3, 2);
		ctl.update();
		window.__stores.cameraBookmarks.saveBookmark('To');
	});
	await page.waitForTimeout(300);
	const views = await page.evaluate(() => {
		let b = /** @type {any[]} */ ([]);
		window.__stores.cameraBookmarks.bookmarks.subscribe((/** @type {any} */ v) => (b = v))();
		return b.map((x) => x.position);
	});
	await page.evaluate(() => window.__stores.recordingStores.recordingOpen.set(true));
	await page.waitForSelector('#recording-dialog', { timeout: 5000 });
	await page.click('#recording-mode-flythrough');
	await page.fill('#recording-duration', '2');
	await page.locator('#recording-duration').dispatchEvent('change');
	await page.waitForTimeout(200);
	const viewsNote = await page.evaluate(() => document.querySelector('#recording-views')?.getAttribute('data-count'));
	h.check(viewsNote === '2', `the flythrough lists the two saved views (${viewsNote})`);
	await page.click('#recording-start');
	await page.waitForSelector('#recording-bar', { timeout: 5000 });
	// the first frames sit on the first view
	await page.waitForTimeout(60);
	const early = await camState(page);
	/** @type {number[][]} */
	const path2 = [];
	let last = early;
	for (let i = 0; i < 14; i++) {
		const st = await state(page);
		if (st.status === 'done') break;
		last = await camState(page);
		path2.push(last.pos);
		await page.waitForTimeout(120);
	}
	await page.waitForSelector('#recording-result', { timeout: 20000 });
	const d0 = Math.hypot(...early.pos.map((v, k) => v - views[0][k]));
	h.check(d0 < 1.0, `the flythrough starts at the first view (${d0.toFixed(3)} away)`);
	const ends = path2.map((p) => Math.hypot(...p.map((v, k) => v - views[1][k])));
	const closest = Math.min(...ends);
	h.check(closest < 1.0, `and arrives at the second (closest ${closest.toFixed(3)})`);
	const fly = await state(page);
	h.check(fly.status === 'done' && !!fly.result && Math.abs(fly.result.durationMs - 2000) <= 350, `the flythrough file is ≈ 2 s (${fly.result?.durationMs} ms)`);
	await shot(page, '05-flythrough-result.png');

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
