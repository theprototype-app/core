// 100 C1 — THE CINEMATIC VIEW SWITCH, end to end: the "Preview" pill turns the WebGPU view on and off, the
// editor keeps working while it draws (selection + outline, undo, flows, physics, Play, autosave, a second
// peer), Shift+Z toggles it, photo and frame capture go through it, and a graphics failure (a compile error,
// a lost device) falls back by itself with a toast, the switch then off for the session.
//
// GPU: real WebGPU wants a GPU slot (E2E_GPU=1, desk case "gpu"). On software GL the page gets a SwiftShader
// adapter, which the offer refuses; `debugCinematicSoftware=1` lets the suite through on it (slow, but the same
// code). If the browser has no WebGPU at all the suite SKIPs with the reason.
//
//   APP_URL=https://theprototype.app:7034/ e2e-slot --dev $PWD 7034 -- node tests/e2e/cinematic-view.test.cjs
const h = require('./helpers.cjs');

const ARGS = [...(process.env.E2E_GPU === '1' ? h.GPU_ARGS : []), '--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const STORAGE = { debugCinematicSoftware: '1' };

/** @param {any} page */
const state = (page) => page.evaluate(() => { let s; window.__tp.test.v1.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s; });
/** @param {any} page */
const debug = (page) => page.evaluate(async () => (await window.__tp.test.v1.cinematicState.cinematicView()).cinematicDebug());
/** @param {any} page */
const mode = async (page) => (await state(page)).mode;
/** @param {any} page */
const objectCount = (page) => page.evaluate(() => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); return g.children.length; });
/** @param {any} page */
const toasts = (page) => page.evaluate(() => { let t; window.__tp.test.v1.toastStore.subscribe((x) => (t = x))(); return (t ?? []).map((/** @type {any} */ x) => (typeof x === 'string' ? x : String(x?.text ?? ''))); });

/** how much of the view's own canvas is not one flat colour (a drawn frame, not a blank one) @param {any} page */
const drawnShare = (page) =>
	page.evaluate(async () => {
		const url = await (await window.__tp.test.v1.cinematicState.cinematicView()).grabCinematic();
		if (!url) return -1;
		const img = new Image();
		img.src = url;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = 160;
		c.height = 90;
		const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		x.drawImage(img, 0, 0, 160, 90);
		const d = x.getImageData(0, 0, 160, 90).data;
		const [r0, g0, b0] = [d[0], d[1], d[2]];
		let off = 0;
		for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 24) off++;
		return off / (d.length / 4);
	});

/** @param {any} page @param {string} want @param {string} label @param {number} [ms] */
const waitMode = (page, want, label, ms = 90000) => h.eventually(() => mode(page), (m) => m === want, label, ms);

h.run(async () => {
	const browser = await h.launch({ args: ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
	const page = A.page;

	const hasGpu = await page.evaluate(() => !!navigator.gpu);
	if (!hasGpu) {
		h.check(true, 'SKIPPED: this browser has no WebGPU (navigator.gpu missing)');
		return h.finish(browser);
	}

	// ---- 1. offered, and the pill appears (mounted by the probe, not by App) ---------------------------------
	const offered = await page.evaluate(() => window.__tp.test.v1.cinematicState.probeCinematic());
	const why = (await state(page)).why;
	if (!offered) {
		h.check(true, `SKIPPED: the view is not offered in this browser (${why})`);
		return h.finish(browser);
	}
	await page.waitForSelector('#cinematic-toggle', { timeout: 30000 });
	h.check(true, '1. offered here, and the "Preview" pill is on screen');
	h.check((await page.getAttribute('#cinematic-toggle', 'aria-pressed')) === 'false', '   it starts off');

	// a small scene: two boxes and a sphere on a floor
	const ids = await page.evaluate(() => {
		const s = window.__tp.test.v1;
		const a = s.addObjects.spawnAtPoint('/create Box 1 1 1', [0, 0.5, 0]);
		const b = s.addObjects.spawnAtPoint('/create Box 1 1 1', [1.6, 0.5, 0]);
		const c = s.addObjects.spawnAtPoint('/create Sphere 0.5', [-1.6, 3, 0]);
		return [a?.uuid, b?.uuid, c?.uuid];
	});
	h.check(ids.every(Boolean), `three objects to draw (${ids.length})`);

	// ---- 2. the pill turns it on; the WebGPU canvas draws a real frame ----------------------------------------
	await page.click('#cinematic-toggle');
	await waitMode(page, 'on', 'the view came on after the press');
	h.check((await page.getAttribute('#cinematic-toggle', 'aria-pressed')) === 'true', '2. the pill reads pressed');
	await page.waitForTimeout(1500);
	const share = await drawnShare(page);
	h.check(share > 0.02, `   the view's canvas holds a drawn frame (${(share * 100).toFixed(1)} % of pixels off the corner colour)`);
	const d1 = await debug(page);
	h.check(d1.errors.length === 0, `   no errors while entering (${JSON.stringify(d1.errors).slice(0, 300)})`);
	const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('cinematicView') || '{}'));
	h.check(prefs.on === true, `   the choice is kept on this device (${JSON.stringify(prefs)})`);

	// ---- 3. editing keeps working while the view draws ----------------------------------------------------------
	await page.evaluate((id) => window.__tp.test.v1.objectActions.selectObject(id), ids[0]);
	const sel = await page.evaluate(async () => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		return v.cinematicDebug().state.mode;
	});
	h.check(sel === 'on', '3. selecting an object leaves the view on');
	const n0 = await objectCount(page);
	await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
	await h.eventually(() => objectCount(page), (n) => n === n0 + 1, 'a box created while the view is on');
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => objectCount(page), (n) => n === n0, 'undo takes it away again');
	h.check(true, '   create and undo work with the view on');

	// physics: the sphere falls
	await page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
	const y0 = await page.evaluate((id) => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty('uuid', id)?.position.y; }, ids[2]);
	await page.waitForTimeout(2500);
	const world = await page.evaluate(() => window.__tp.test.v1.physics.physicsWorldDebug?.());
	const y1 = await page.evaluate((id) => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty('uuid', id)?.position.y; }, ids[2]);
	if (!world?.running) h.check(true, '   SKIPPED physics: the wasm world did not start in this browser');
	else h.check(y1 < y0 - 0.5, `   physics runs: the sphere fell (${y0?.toFixed?.(2)} -> ${y1?.toFixed?.(2)})`);
	await page.evaluate(() => window.__tp.test.v1.physics.stopSimulation());
	h.check((await mode(page)) === 'on', '   the view stayed on through the simulation');

	// Play: the pill hides, the view keeps drawing
	await page.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	await page.waitForTimeout(800);
	h.check((await page.$('#cinematic-switch')) === null, '   in Play the switch hides');
	h.check((await mode(page)) === 'on' && (await drawnShare(page)) > 0.02, '   and the view keeps drawing');
	await page.evaluate(() => window.__tp.test.v1.isLocked.set(false));
	await page.waitForSelector('#cinematic-toggle', { timeout: 10000 });

	// autosave writes a snapshot while the WebGL context is released
	const w0 = await page.evaluate(() => { let s; window.__tp.test.v1.autosave.autosaveStatus.subscribe((v) => (s = v))(); return s.writes; });
	await page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	const st = await page.evaluate(() => { let s; window.__tp.test.v1.autosave.autosaveStatus.subscribe((v) => (s = v))(); return s; });
	h.check(st.writes > w0 && !st.lastError, `   autosave writes with the view on (writes ${w0} -> ${st.writes}, error ${st.lastError})`);

	// ---- 3b. a second peer edits; the change shows while the view is on -----------------------------------------
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1200, height: 800 } } });
	try {
		// B joins A: an empty joiner adopts the host's world (A joining B would put A's unnamed work behind the connect decision)
		await h.connect(B, A);
		const nA = await objectCount(page);
		await B.page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create sphere'));
		await h.eventually(() => objectCount(page), (n) => n === nA + 1, "the peer's sphere reached A", 30000);
		h.check((await mode(page)) === 'on', "3b. a peer's edit arrives and the view stays on");
		const d6 = await debug(page);
		h.check(d6.errors.length === 0, `   no view errors after the peer edit (${JSON.stringify(d6.errors).slice(0, 200)})`);
	} finally {
		await h.closePeer(B);
	}

	// ---- 4. photo and frame capture go through the view ---------------------------------------------------------
	const still = await page.evaluate(async () => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		const b = await v.viewStill({ width: 640, height: 360 });
		if (!b) return null;
		const bmp = await createImageBitmap(b);
		return { size: b.size, w: bmp.width, h: bmp.height };
	});
	h.check(!!still && still.w === 640 && still.h === 360 && still.size > 2000, `4. a photo still through the view at the asked size (${JSON.stringify(still)})`);
	h.check((await mode(page)) === 'on' && (await drawnShare(page)) > 0.02, '   the view draws on after the still');

	// a short video take: the recorder copies the view's frame right after it is drawn
	const take = await page.evaluate(async () => {
		const t = window.__tp.test.v1;
		const ok = await t.recording.startRecording({ mode: 'turntable', duration: 1.5, resolution: '720p' });
		if (!ok) {
			let s;
			t.recordingStores.recordingState.subscribe((v) => (s = v))();
			return { ok, error: s.error };
		}
		const s = await new Promise((resolve) => {
			const stop = t.recordingStores.recordingState.subscribe((v) => {
				if (v.status === 'done' || v.status === 'error') queueMicrotask(() => (stop(), resolve(v)));
			});
		});
		if (!s.result?.blob) return { ok, status: s.status, error: s.error };
		const v = document.createElement('video');
		v.muted = true;
		v.src = URL.createObjectURL(s.result.blob);
		await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
		v.currentTime = Math.min(0.8, (s.result.durationMs ?? 1500) / 2000);
		await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
		const c = document.createElement('canvas');
		c.width = 160;
		c.height = 90;
		const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		x.drawImage(v, 0, 0, 160, 90);
		const d = x.getImageData(0, 0, 160, 90).data;
		let off = 0;
		for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 24) off++;
		return { ok, status: s.status, frames: s.frames, bytes: s.result.bytes ?? s.result.blob.size, share: off / (d.length / 4) };
	});
	h.check(take.status === 'done' && take.frames > 5 && take.share > 0.02, `   a video take through the view holds drawn frames (${JSON.stringify(take)})`);
	await page.evaluate(() => window.__tp.test.v1.recording.resetRecording?.());
	h.check((await mode(page)) === 'on', '   the view is still on after the take');

	// ---- 5. Shift+Z turns it off; the WebGL view is back --------------------------------------------------------
	await page.mouse.move(720, 450);
	await page.keyboard.press('Shift+Z');
	await waitMode(page, 'off', 'Shift+Z turned the view off');
	const gl = await page.evaluate(() => { let r; window.__tp.test.v1.globalRenderer.subscribe((x) => (r = x))(); const c = r.getContext(); return { lost: c.isContextLost(), opacity: r.domElement.style.opacity }; });
	h.check(!gl.lost && gl.opacity === '', `5. Shift+Z: off, the WebGL context is back and visible (${JSON.stringify(gl)})`);
	await page.keyboard.press('Shift+Z');
	await waitMode(page, 'on', 'Shift+Z turned it on again');
	if ((await mode(page)) !== 'on') {
		const d5 = await debug(page);
		const ae = await page.evaluate(() => { const a = /** @type {any} */ (document.activeElement); return a ? a.tagName + '#' + a.id + '.' + String(a.className).slice(0, 60) : null; });
		console.log('  diag', JSON.stringify({ state: d5.state, switches: d5.switches?.slice(-4), errors: d5.errors?.slice(-4), active: ae }).slice(0, 1500));
	}
	h.check(true, '   and Shift+Z turns it on again');

	// ---- 7. fallback: a compile failure turns it off with a toast; the switch stays off for the session -----------
	const f = await page.evaluate(async () => (await window.__tp.test.v1.cinematicState.cinematicView()).failCompileForTest());
	await waitMode(page, 'off', 'the view fell back after the compile failure');
	const s7 = await state(page);
	h.check(s7.offered === false && /compile/.test(s7.why), `7. a compile failure: off, not offered again this session (${s7.why})`);
	const t7 = await toasts(page);
	h.check(t7.some((m) => /Cinematic view/i.test(m)), `   a toast says so (${JSON.stringify(t7).slice(0, 200)})`);
	const p7 = await page.evaluate(() => JSON.parse(localStorage.getItem('cinematicView') || '{}'));
	h.check(p7.on === false, '   and "on" is cleared, so a reload does not walk into it again');
	const gl7 = await page.evaluate(() => { let r; window.__tp.test.v1.globalRenderer.subscribe((x) => (r = x))(); return !r.getContext().isContextLost(); });
	h.check(gl7 && !f?.error, '   the WebGL view draws again');
	await page.waitForTimeout(500);
	h.check((await page.$('#cinematic-switch')) === null, '   the pill is gone');

	// ---- 8. fallback: a lost device, on a fresh page ------------------------------------------------------------
	const C = await h.setupPageQuiet(browser, 'C', [A], { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
	try {
		const okC = await C.page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(true));
		await waitMode(C.page, 'on', 'C: the view came on');
		const lost = await C.page.evaluate(async () => (await window.__tp.test.v1.cinematicState.cinematicView()).loseDeviceForTest());
		await waitMode(C.page, 'off', 'C: the view fell back after the device loss');
		const s8 = await state(C.page);
		h.check(!!okC && !lost?.error && s8.offered === false, `8. a lost device: off and not offered again this session (${s8.why})`);
		const gl8 = await C.page.evaluate(() => { let r; window.__tp.test.v1.globalRenderer.subscribe((x) => (r = x))(); return !r.getContext().isContextLost(); });
		h.check(gl8, '   the WebGL view draws again');
	} finally {
		await h.closePeer(C);
	}

	h.check(h.pageErrors(A).length === 0, `no page errors on A (${JSON.stringify(h.pageErrors(A)).slice(0, 300)})`);
	await h.finish(browser);
});
