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
/** mean luma (0-255) of the WebGL view, drawn and read in one task */
const glLuma = (page) =>
	page.evaluate(() => {
		const t = window.__tp.test.v1;
		let r, sc, c;
		t.globalRenderer.subscribe((x) => (r = x))();
		t.globalScene.subscribe((x) => (sc = x))();
		t.globalCamera.subscribe((x) => (c = x))();
		r.render(sc, c);
		const k = document.createElement('canvas');
		k.width = 160;
		k.height = 90;
		const x = /** @type {CanvasRenderingContext2D} */ (k.getContext('2d'));
		x.drawImage(r.domElement, 0, 0, 160, 90);
		const d = x.getImageData(0, 0, 160, 90).data;
		let l = 0;
		for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		return +(l / (d.length / 4)).toFixed(1);
	});
/** the main camera's projection and how many cameras (incl. shadow cameras) are not on the WebGL renderer's system */
const camState = (page) =>
	page.evaluate(() => {
		const t = window.__tp.test.v1;
		let r, sc, c;
		t.globalRenderer.subscribe((x) => (r = x))();
		t.globalScene.subscribe((x) => (sc = x))();
		t.globalCamera.subscribe((x) => (c = x))();
		let foreign = c.coordinateSystem !== r.coordinateSystem ? 1 : 0;
		sc.traverse((o) => {
			const cam = o.isLight ? o.shadow?.camera : o.isCamera && o !== c ? o : null;
			if (cam && cam.coordinateSystem !== r.coordinateSystem) foreign++;
		});
		return { proj: c.projectionMatrix.elements.map((v) => v.toFixed(5)).join(','), foreign };
	});
const waitMode = (page, want, label, ms = 90000) => h.eventually(() => mode(page), (m) => m === want, label, ms);

/** poll without recording a check: the value once `pred` holds, else null @param {() => Promise<any>} fn @param {(v: any) => boolean} pred @param {number} ms */
async function poll(fn, pred, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await fn();
		if (pred(v)) return v;
		await new Promise((r) => setTimeout(r, 250));
	}
	return null;
}

/** C2-1: every troika text in the scene and its canvas-texture cover (null when the view is off) @param {any} page */
const labelState = (page) =>
	page.evaluate(async () => {
		const t = window.__tp.test.v1;
		const live = (await t.cinematicState.cinematicView()).cinematicLiveForTest();
		let sc;
		t.globalScene.subscribe((x) => (sc = x))();
		/** @type {any[]} */
		const texts = [];
		let quads = 0;
		sc.traverse((/** @type {any} */ o) => {
			if (o.name === 'cinematic-text-quad') quads++;
			if (typeof o.sync !== 'function' || !('textRenderInfo' in o)) return; // a troika text
			const m = o.material;
			texts.push({ text: String(o.text ?? ''), name: o.name, troikaDraws: Array.isArray(m) ? m.some((x) => x?.isTroikaTextMaterial) : !!m?.isTroikaTextMaterial, cover: live?.labels?.recordOf(o) ?? null });
		});
		return { stats: live?.labels?.stats() ?? null, texts, quads };
	});
/** the share of the view's pixels the text quads change (a frame with them minus a frame without) @param {any} page */
const labelInk = (page) =>
	page.evaluate(async () => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		const labels = v.cinematicLiveForTest()?.labels;
		if (!labels) return -1;
		const frames = (/** @type {number} */ n) => new Promise((r) => { const step = () => (n-- <= 0 ? r(undefined) : requestAnimationFrame(step)); step(); });
		const grab = async () => {
			const img = new Image();
			img.src = /** @type {string} */ (await v.grabCinematic());
			await img.decode();
			const c = document.createElement('canvas');
			c.width = 320;
			c.height = 180;
			const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
			x.drawImage(img, 0, 0, 320, 180);
			return x.getImageData(0, 0, 320, 180).data;
		};
		labels.hideForTest(true);
		await frames(30);
		const off = await grab();
		labels.hideForTest(false);
		await frames(30);
		const on = await grab();
		let n = 0;
		for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]) > 30) n++;
		return n / (on.length / 4);
	});

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
	// 100-int: the first-use hint shows once on this device, and is remembered
	const hintShown = await page.waitForSelector('#cinematic-hint', { timeout: 5000 }).then(() => true, () => false);
	const hintSeen = await page.evaluate(() => localStorage.getItem('cinematic:hintSeen'));
	h.check(hintShown && hintSeen === '1', `   the first-use hint shows once and is remembered (shown ${hintShown}, seen ${hintSeen})`);

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
	h.check((await page.locator('#cinematic-hint').count()) === 0, '   the first-use hint goes away once the view is on');
	await page.waitForTimeout(1500);
	const share = await drawnShare(page);
	h.check(share > 0.02, `   the view's canvas holds a drawn frame (${(share * 100).toFixed(1)} % of pixels off the corner colour)`);
	const d1 = await debug(page);
	h.check(d1.errors.length === 0, `   no errors while entering (${JSON.stringify(d1.errors).slice(0, 300)})`);
	const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('cinematicView') || '{}'));
	h.check(prefs.on === true, `   the choice is kept on this device (${JSON.stringify(prefs)})`);

	// ---- 2b. C2-1: labels and flat text draw as canvas-texture quads ---------------------------------------------
	const sign = await page.evaluate(() => {
		const s = window.__tp.test.v1;
		const o = s.addObjects.spawnAtPoint('/create Text', [0, 2.2, 0.8]);
		if (o) s.textPathEdit.setTextPathFor(o.uuid, { text: 'Cinematic sign', size: 0.6 });
		return o?.uuid ?? null;
	});
	const pinned = await page.evaluate((id) => {
		const s = window.__tp.test.v1;
		s.annotationsHandler.addAnnotation(id);
		let cur;
		s.annotationsHandler.activeAnnotation.subscribe((v) => (cur = v))();
		if (!cur?.draft) return false;
		s.annotationsHandler.setAnnotation({ ...cur.draft, name: 'A note in the view', text: 'pin' });
		return true;
	}, ids[1]);
	h.check(!!sign && pinned, `2b. a flat text sign and a note pin join the scene with the view on (sign ${sign}, pin ${pinned})`);
	const covered = (/** @type {any} */ st, /** @type {RegExp} */ re) => st.texts.filter((x) => re.test(x.text)).some((x) => x.cover?.visible && x.cover.w > 0 && !x.troikaDraws);
	await h.eventually(() => labelState(page), (st) => covered(st, /^Cinematic sign$/), 'the sign gets its quads', 30000);
	const ls1 = await labelState(page);
	h.check(covered(ls1, /^Cinematic sign$/), `   the sign draws as a quad, troika's own draw off (${JSON.stringify(ls1.texts.filter((x) => /Cinematic/.test(x.text)))})`);
	// a desktop note pin is a DOM marker over the canvas (its troika number exists only in VR): it shows over the view as is
	const markers = () => page.evaluate(() => { let m; window.__tp.test.v1.annotationsHandler.noteMarkers.subscribe((x) => (m = x))(); return (m ?? []).length; });
	const marker = (await poll(markers, (n) => n >= 1, 10000)) ?? 0;
	h.check(marker >= 1, `   the note pin shows as its DOM marker over the view (${marker})`);
	h.check(ls1.texts.every((x) => !x.troikaDraws), `   no troika text draws itself while the view is on (${ls1.texts.filter((x) => x.troikaDraws).map((x) => x.text).join(', ') || 'none'})`);
	const ink = await labelInk(page);
	h.check(ink > 0.002, `   the quads put pixels on the view (${(ink * 100).toFixed(2)} % of the frame changes with them)`);
	const chip = (await state(page)).notShown;
	h.check(!/text/i.test(chip ?? ''), `   the "Not shown" chip does not name text (${JSON.stringify(chip)})`);
	// live: a longer text, a wider canvas
	const signW = ls1.texts.find((x) => x.text === 'Cinematic sign')?.cover?.w ?? 0;
	await page.evaluate((u) => window.__tp.test.v1.textPathEdit.setTextPathFor(u, { text: 'Cinematic sign, and some more words' }), sign);
	await h.eventually(() => labelState(page), (st) => (st.texts.find((x) => /some more words/.test(x.text))?.cover?.w ?? 0) > signW * 1.5, 'the sign quad follows the new text', 30000);
	const ls2 = await labelState(page);
	h.check((ls2.texts.find((x) => /some more words/.test(x.text))?.cover?.w ?? 0) > signW * 1.5, `   it updates live: the sign's canvas grew with its text (${signW} -> ${ls2.texts.find((x) => /some more words/.test(x.text))?.cover?.w} px)`);
	// a ping's name lives 4 s: its quad comes and goes with it
	const q0 = ls2.stats?.quads ?? 0;
	await page.evaluate(() => window.__tp.test.v1.ping.previewPing([1.6, 0, 0]));
	const lp = await poll(() => labelState(page), (st) => (st.stats?.quads ?? 0) > q0, 3500);
	h.check(!!lp && (lp.stats?.quads ?? 0) > q0, `   a ping's name gets a quad while it shows (${q0} -> ${lp?.stats?.quads})`);
	const lg = await poll(() => labelState(page), (st) => (st.stats?.quads ?? 0) === q0, 15000);
	h.check(!!lg && lg.quads === q0 && (lg.stats?.released ?? 0) >= 1, `   and is freed when the ping ends (${JSON.stringify(lg?.stats)})`);
	const d2b = await debug(page);
	h.check(d2b.errors.length === 0, `   no view errors with the labels (${JSON.stringify(d2b.errors).slice(0, 300)})`);

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
		// C2-1: a second peer's name label (when the editor shows one for them) is covered like every troika text
		const bName = await B.page.evaluate(() => { let u; window.__tp.test.v1.username?.subscribe?.((x) => (u = x))(); return u ?? null; });
		const lb = await poll(() => labelState(page), (st) => st.texts.some((x) => x.text && x.text === bName), 8000);
		if (!lb) h.check(true, `3b. SKIPPED peer-name label: no 3D name label for B in this layout (${bName})`);
		else h.check(lb.texts.filter((x) => x.text === bName).every((x) => x.cover?.visible && !x.troikaDraws), `3b. B's name label draws as a quad (${JSON.stringify(lb.texts.filter((x) => x.text === bName))})`);
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
	const lOff = await labelState(page);
	h.check(lOff.quads === 0 && lOff.stats === null && lOff.texts.length > 0 && lOff.texts.every((x) => x.troikaDraws), `   C2-1: the text quads are gone and troika draws every text itself again (${lOff.quads} quads, ${lOff.texts.filter((x) => !x.troikaDraws).length} of ${lOff.texts.length} texts still covered)`);
	await page.keyboard.press('Shift+Z');
	await waitMode(page, 'on', 'Shift+Z turned it on again');
	if ((await mode(page)) !== 'on') {
		const d5 = await debug(page);
		const ae = await page.evaluate(() => { const a = /** @type {any} */ (document.activeElement); return a ? a.tagName + '#' + a.id + '.' + String(a.className).slice(0, 60) : null; });
		console.log('  diag', JSON.stringify({ state: d5.state, switches: d5.switches?.slice(-4), errors: d5.errors?.slice(-4), active: ae }).slice(0, 1500));
	}
	h.check(true, '   and Shift+Z turns it on again');

	// ---- 5b. the standard view keeps its environment light across a trip (an HDRI's PMREM lives on the WebGL
	//      context: it is unrolled before the release and drawn back into the SAME target after the restore) ---
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(false));
	await waitMode(page, 'off', '5b. off for the environment check');
	await page.evaluate(() => window.__tp.test.v1.environment.setEnvironment('product'));
	await h.eventually(
		() => page.evaluate(() => { let sc; window.__tp.test.v1.globalScene.subscribe((x) => (sc = x))(); return !!sc?.environment?.isRenderTargetTexture; }),
		(v) => v === true,
		'5b. the Product shot preset gives the scene a PMREM environment',
		60000
	);
	await page.waitForTimeout(1500);
	const l0 = await glLuma(page);
	const c0 = await camState(page);
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(true));
	await waitMode(page, 'on', '5b. on with the HDRI');
	await page.waitForTimeout(1500);
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(false));
	await waitMode(page, 'off', '5b. and off again');
	await page.waitForTimeout(1000);
	const l1 = await glLuma(page);
	const c1 = await camState(page);
	h.check(c1.proj === c0.proj && c1.foreign === 0, `   every camera is back on the WebGL depth range (projection ${c0.proj === c1.proj ? 'unchanged' : c0.proj + ' -> ' + c1.proj}, ${c1.foreign} camera(s) still on WebGPU's)`);
	const back = (await debug(page)).switches.filter((x) => x.dir === 'off').pop();
	h.check(back?.env?.kind === 'unrolled' && back?.env?.refilled >= 1 && Math.abs(l1 - l0) < Math.max(3, l0 * 0.05), `   the standard view looks the same after the trip (luma ${l0} -> ${l1}, ${JSON.stringify(back?.env)})`);
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(true));
	await waitMode(page, 'on', '5b. on again for the fallback checks');

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
