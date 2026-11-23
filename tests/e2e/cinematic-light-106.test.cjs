// 106 S3 — REFLECTIONS AND GLOBAL LIGHT, the Cinematic view's two device switches (Preview pill ▸ Cinematic view).
//
//   1. the rows: under the quality levels, Reflections and Global light, Auto / On / Off, disabled while the view is off
//   2. Auto follows the quality level (Basic = both off, Standard = both on); On / Off override it at any level
//   3. each switch changes the view's pixels and its frame work (render → GPU done), and the measured cost shows
//      in the menu once known ("about N ms")
//   4. the step-down: after the quality steps, a switch set to On goes off, and the chip + the menu say so
//   5. (runs after 6) this device only: a second peer receives nothing (A's sends spied, B's prefs untouched), and a reload
//      keeps the switches and the measured costs (localStorage)
//   6. no double light (roadmap 106, 23 Nov): with a Pro look bake, Global light on vs off leaves the BAKED
//      objects' pixels alone while the unbaked one changes; with the mask taken off (counterfactual) they change
//
// GPU: wants a GPU slot (E2E_GPU=1, real WebGPU). On software GL `debugCinematicSoftware=1` lets it run on SwiftShader
// (slow; the frame-work comparison is then reported, not asserted). No WebGPU at all = SKIP with the reason.
//
//   APP_URL=https://theprototype.app:7202/ E2E_PC= e2e-slot --local --dev $PWD 7202 -- env E2E_GPU=1 node tests/e2e/cinematic-light-106.test.cjs
const h = require('./helpers.cjs');

const GPU = process.env.E2E_GPU === '1';
const ARGS = [...(GPU ? h.GPU_ARGS : []), '--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const STORAGE = { debugCinematicSoftware: '1' };

setTimeout(() => {
	console.log('SCRIPT FAILED: cinematic-light-106 watchdog — the suite ran over 600 s');
	process.exit(1);
}, 600000).unref();

/** @param {any} page */
const state = (page) => page.evaluate(() => { let s; window.__tp.test.v1.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s; });
/** @param {any} page */
const prefs = (page) => page.evaluate(() => { let s; window.__tp.test.v1.cinematicState.cinematicPrefs.subscribe((v) => (s = v))(); return s; });
/** @param {any} page */
const debug = (page) => page.evaluate(async () => (await window.__tp.test.v1.cinematicState.cinematicView()).cinematicDebug());
/** @param {any} page @param {string} label @param {(d: any) => boolean} ok @param {number} [ms] */
const waitDebug = (page, label, ok, ms = 30000) => h.eventually(() => debug(page), ok, label, ms);

async function openMenu(page) {
	if (!(await page.locator('#preview-menu').count())) await page.locator('#preview-more').click();
	await page.waitForSelector('#preview-menu', { timeout: 5000 });
}
async function closeMenu(page) {
	if (await page.locator('#preview-menu').count()) await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
}
/** press a switch's option in the menu (the real control) @param {any} page @param {'reflections'|'globalLight'} k @param {'auto'|'on'|'off'} v */
async function pick(page, k, v) {
	await openMenu(page);
	await page.locator(`#preview-light-${k}-mode-${v}`).click();
	await page.waitForTimeout(300);
}
/** @param {any} page @param {'basic'|'standard'|'high'} q */
async function pickQuality(page, q) {
	await openMenu(page);
	await page.locator(`#preview-cine-${q}`).click();
}
/** wait for the pipeline the view runs to satisfy `pred` @param {any} page @param {string} label @param {(d: any) => boolean} pred */
const settled = (page, label, pred) => waitDebug(page, label, (d) => !!d.lighting && pred(d), 30000);

/**
 * The view's frame, downscaled, after `frames` settle frames (TRAA accumulates). @param {any} page @param {number} [frames]
 * @returns {Promise<number[]>} RGBA bytes 320x180
 */
const grab = (page, frames = 40) =>
	page.evaluate(async (n) => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		await new Promise((r) => { const step = () => (n-- <= 0 ? r(undefined) : requestAnimationFrame(step)); step(); });
		const img = new Image();
		img.src = /** @type {string} */ (await v.grabCinematic());
		await img.decode();
		const c = document.createElement('canvas');
		c.width = 320;
		c.height = 180;
		const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		x.drawImage(img, 0, 0, 320, 180);
		return Array.from(x.getImageData(0, 0, 320, 180).data);
	}, frames);
/** share of pixels that moved by more than 12 levels @param {number[]} a @param {number[]} b */
function changed(a, b) {
	let n = 0;
	for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++;
	return n / (a.length / 4);
}
/** mean abs difference in a 7x7 patch around each grab-space point @param {number[]} a @param {number[]} b @param {{x:number,y:number}[]} pts */
function patchDiff(a, b, pts) {
	return pts.map((p) => {
		let s = 0;
		let n = 0;
		for (let dy = -3; dy <= 3; dy++)
			for (let dx = -3; dx <= 3; dx++) {
				const x = Math.round(p.x) + dx;
				const y = Math.round(p.y) + dy;
				if (x < 0 || y < 0 || x >= 320 || y >= 180) continue;
				const i = (y * 320 + x) * 4;
				s += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
				n++;
			}
		return +(s / Math.max(1, n)).toFixed(2);
	});
}
/** the median work of one frame through the current pipeline: render() until the GPU is done @param {any} page */
const frameWork = (page) =>
	page.evaluate(async () => {
		const live = (await window.__tp.test.v1.cinematicState.cinematicView()).cinematicLiveForTest();
		const q = live.r.backend.device.queue;
		for (let i = 0; i < 10; i++) live.built.render();
		await q.onSubmittedWorkDone();
		const xs = [];
		for (let i = 0; i < 40; i++) {
			const t = performance.now();
			live.built.render();
			await q.onSubmittedWorkDone();
			xs.push(performance.now() - t);
		}
		xs.sort((a, b) => a - b);
		return +xs[20].toFixed(2);
	});
/** world points → grab-space points (only those on screen) @param {any} page @param {Record<string, number[]>} pts */
const project = (page, pts) =>
	page.evaluate((pts) => {
		let cam;
		window.__tp.test.v1.globalCamera.subscribe((c) => (cam = c))();
		/** @type {Record<string, {x:number,y:number}>} */
		const out = {};
		for (const [k, w] of Object.entries(pts)) {
			const v = cam.position.clone().set(w[0], w[1], w[2]).project(cam);
			if (Math.abs(v.x) < 0.92 && Math.abs(v.y) < 0.92 && v.z < 1) out[k] = { x: (v.x * 0.5 + 0.5) * 320, y: (-v.y * 0.5 + 0.5) * 180 };
		}
		return out;
	}, pts);

h.run(async () => {
	const browser = await h.launch({ args: ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
	const page = A.page;
	if (!(await page.evaluate(() => !!navigator.gpu))) {
		h.check(true, 'SKIPPED: this browser has no WebGPU (navigator.gpu missing)');
		return h.finish(browser);
	}
	const offered = await page.evaluate(() => window.__tp.test.v1.cinematicState.probeCinematic());
	if (!offered) {
		h.check(true, `SKIPPED: the view is not offered in this browser (${(await state(page)).why})`);
		return h.finish(browser);
	}

	// ---- the room (baked later in 6): a smooth floor that reflects, walls, coloured boxes, a sun, one moving ball --
	const made = await page.evaluate(async () => {
		const t = window.__tp.test.v1.aiTools;
		const box = (name, params, position) => ({ kind: 'primitive', primitive: 'Box', name, params, position });
		const r = await t.executeAiTool('create_objects', {
			objects: [
				box('Floor', [8, 0.2, 8], [0, -0.1, 0]),
				box('WallBack', [8, 3, 0.2], [0, 1.5, -4]),
				box('WallLeft', [0.2, 3, 8], [-4, 1.5, 0]),
				box('Crate', [1, 1, 1], [-1, 0.5, -1]),
				box('Pillar', [0.6, 2.4, 0.6], [1.5, 1.2, -2]),
				box('Ball', [0.8, 0.8, 0.8], [1.2, 0.4, 1.2]),
				{ kind: 'light', light: 'directional', name: 'Sun', position: [3, 6, 2] }
			]
		});
		return (r.created ?? []).map((c) => ({ name: c.name, uuid: c.uuid }));
	});
	const uuidOf = (/** @type {string} */ n) => made.find((m) => m.name === n)?.uuid;
	h.check(made.length === 7, `premise: the room is built (${made.map((m) => m.name).join(', ')})`);
	await page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const floor = g.getObjectByProperty('uuid', u.floor);
		floor.material.roughness = 0.05;
		floor.material.metalness = 0.6;
		const crate = g.getObjectByProperty('uuid', u.crate);
		crate.material.color.set(0xff2200);
		// the ball moves (physics): the bake leaves it out, so it is the unbaked control in 6
		g.getObjectByProperty('uuid', u.ball).userData.physics = { mode: 'dynamic' };
	}, { floor: uuidOf('Floor'), crate: uuidOf('Crate'), ball: uuidOf('Ball') });

	// ---- 1. the rows, off while the view is off ---------------------------------------------------------------
	await openMenu(page);
	const rows0 = await page.evaluate(() => ['reflections', 'globalLight'].map((k) => ({ k, there: !!document.getElementById('preview-light-' + k), disabled: !!document.querySelector(`#preview-light-${k}-mode-auto`)?.hasAttribute('disabled'), note: document.getElementById(`preview-light-${k}-note`)?.textContent ?? '' })));
	h.check(rows0.every((r) => r.there), `1. both rows are in the Cinematic view group (${JSON.stringify(rows0.map((r) => r.k))})`);
	h.check(rows0.every((r) => r.disabled && /Turn the Cinematic view on/.test(r.note)), `   disabled while the view is off, and they say why (${rows0.map((r) => r.note).join(' | ')})`);
	const order = await page.evaluate(() => {
		const all = [...document.querySelectorAll('#preview-menu [id]')].map((e) => e.id);
		return { cine: all.indexOf('preview-cinematic'), refl: all.indexOf('preview-light-reflections'), gi: all.indexOf('preview-light-globalLight'), draw: all.indexOf('preview-draw') };
	});
	h.check(order.cine < order.refl && order.refl < order.gi && order.gi < order.draw, `   under the quality levels, before Draw as (${JSON.stringify(order)})`);
	const p0 = await prefs(page);
	h.check(p0.reflections === 'auto' && p0.globalLight === 'auto', `   both start on Auto (${JSON.stringify(p0)})`);

	// the view on (Standard)
	await pickQuality(page, 'standard');
	const came = await h.eventually(() => state(page), (s) => s.mode === 'on' || (s.mode === 'off' && !!s.disabled), 'the view comes on', 90000);
	if (came?.mode !== 'on') {
		h.check(true, `SKIPPED 2-6: the view did not start here (${came?.disabled})`);
		return h.finish(browser);
	}
	await page.waitForTimeout(1500);

	// ---- 2. Auto follows the quality level ---------------------------------------------------------------------
	let d = await settled(page, '2. Standard: Auto = Global light + Reflections on', (x) => x.lighting.gi && x.lighting.ssr && x.lighting.scale === 0.5);
	await pickQuality(page, 'basic');
	d = await settled(page, '   Basic: Auto = both off (GTAO only, as before 106)', (x) => x.quality === 'basic' && !x.lighting.gi && !x.lighting.ssr);
	await pick(page, 'reflections', 'on');
	d = await settled(page, '   Basic + Reflections On: reflections at half resolution, no Global light', (x) => !x.lighting.gi && x.lighting.ssr && x.lighting.scale === 0.5);
	await pick(page, 'globalLight', 'on');
	d = await settled(page, '   Basic + both On: both drawn', (x) => x.lighting.gi && x.lighting.ssr);
	await pick(page, 'reflections', 'auto');
	await pick(page, 'globalLight', 'auto');
	await pickQuality(page, 'standard');
	d = await settled(page, '   back to Standard + Auto', (x) => x.quality === 'standard' && x.lighting.gi && x.lighting.ssr);
	await pick(page, 'reflections', 'off');
	d = await settled(page, '   Standard + Reflections Off: Global light only', (x) => x.lighting.gi && !x.lighting.ssr);
	h.check(d.errors.length === 0, `   no view errors across the switches (${JSON.stringify(d.errors).slice(0, 300)})`);
	await pick(page, 'reflections', 'auto');
	await settled(page, '   Standard + Auto again', (x) => x.lighting.gi && x.lighting.ssr);

	// ---- 3. pixels + frame work per switch; the cost appears ---------------------------------------------------
	await closeMenu(page);
	const both = await grab(page);
	const workBoth = await frameWork(page);
	await pick(page, 'reflections', 'off');
	await settled(page, '3. reflections off', (x) => !x.lighting.ssr);
	await closeMenu(page);
	const noRefl = await grab(page);
	const workNoRefl = await frameWork(page);
	await pick(page, 'globalLight', 'off');
	await settled(page, '   global light off too', (x) => !x.lighting.gi && !x.lighting.ssr);
	await closeMenu(page);
	const none = await grab(page);
	const workNone = await frameWork(page);
	const cRefl = changed(both, noRefl);
	const cGi = changed(noRefl, none);
	console.log(`WORK_MS both=${workBoth} noReflections=${workNoRefl} none=${workNone}`);
	h.check(cRefl > 0.003, `3. Reflections changes the view's pixels (${(cRefl * 100).toFixed(2)} % moved)`);
	h.check(cGi > 0.003, `   Global light changes the view's pixels (${(cGi * 100).toFixed(2)} % moved)`);
	if (GPU) {
		h.check(workBoth > workNoRefl, `   Reflections costs frame work (${workBoth} vs ${workNoRefl} ms)`);
		h.check(workNoRefl > workNone, `   Global light costs frame work (${workNoRefl} vs ${workNone} ms)`);
	} else h.check(true, `   (software GL: frame work reported only: ${workBoth} / ${workNoRefl} / ${workNone} ms)`);
	// the view's own meter: frames with and without each pass have been drawn, so both costs become known
	await pick(page, 'globalLight', 'auto');
	await pick(page, 'reflections', 'auto');
	await closeMenu(page);
	await page.waitForTimeout(4000);
	const costs = await h.eventually(() => page.evaluate(() => JSON.parse(localStorage.getItem('cinematicCosts') || '{}')), (c) => !!c.reflections && !!c.globalLight, '   both costs are measured on this device and kept', 30000);
	await openMenu(page);
	const notes = await page.evaluate(() => ['reflections', 'globalLight'].map((k) => document.getElementById(`preview-light-${k}-note`)?.textContent ?? ''));
	h.check(notes.every((n) => /costs (about \d+ ms|under 1 ms)/.test(n)), `   the menu shows each cost (${notes.join(' | ')}; stored ${JSON.stringify(costs)})`);

	// ---- 4. the step-down: steps first, then a switch set to On -------------------------------------------------
	await pick(page, 'reflections', 'on');
	await settled(page, '4. premise: Standard, Reflections On', (x) => x.lighting.ssr && x.drops === 0);
	const stepDown = () => page.evaluate(async () => (await window.__tp.test.v1.cinematicState.cinematicView()).stepDownForTest());
	await stepDown();
	let s = await h.eventually(() => state(page), (v) => v.dropped === 1, '   one step: Basic', 20000);
	h.check(s.quality === 'basic' && s.lighting.ssr && !s.lighting.gi, `   Basic keeps Reflections (On), Global light follows Auto off (${JSON.stringify(s.lighting)})`);
	h.check(/Lowered to Basic to keep it smooth/.test(s.stepped), `   the chip says the step (${s.stepped})`);
	await stepDown();
	s = await h.eventually(() => state(page), (v) => v.dropped === 2, '   the next step turns Reflections off', 20000);
	h.check(!s.lighting.ssr && s.off.includes('reflections'), `   ...Reflections is off (${JSON.stringify(s.off)})`);
	await closeMenu(page);
	const chip = await page.locator('#cinematic-dropped').textContent().catch(() => '');
	h.check(/Reflections off to keep it smooth/.test(chip ?? ''), `   the chip under the pill says so (${chip})`);
	await openMenu(page);
	const rnote = await page.locator('#preview-light-reflections-note').textContent();
	h.check(/Off for now to keep it smooth/.test(rnote ?? ''), `   and the menu row (${rnote})`);
	h.check((await stepDown()) === false, '   nothing below that');
	await pick(page, 'reflections', 'auto');
	s = await h.eventually(() => state(page), (v) => v.dropped === 0 && v.quality === 'standard', '   a switch change starts the drop over', 20000);

	// ---- 6. no double light: baked objects keep their pixels -----------------------------------------------------
	// leave the view to bake (the bake reads the WebGL scene), then come back
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(false));
	await h.eventually(() => state(page), (v) => v.mode === 'off', '6. premise: the view is off for the bake', 30000);
	await page.evaluate(() => window.__tp.test.v1.bakeRunner.setBakeTestLimits({ atlas: 256, rays: 8, ms: 45000 }));
	const bake = await page.evaluate(async () => {
		const r = await window.__tp.test.v1.bakeRunner.runBake({ quality: 'normal' });
		return { ok: r.ok, error: r.ok ? '' : r.error, objects: r.ok ? r.record.objects.map((o) => o.uuid) : [] };
	});
	h.check(bake.ok && bake.objects.length >= 4, `   the room is baked (${bake.error || bake.objects.length + ' objects'})`);
	h.check(!bake.objects.includes(uuidOf('Ball')), '   the moving ball is left out (the unbaked control)');
	await h.eventually(() => page.evaluate(() => window.__tp.test.v1.bakeApply.bakeApplyDebug().meshes.length), (n) => n >= bake.objects.length, '   the bake is on the materials', 20000);
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(true));
	await h.eventually(() => state(page), (v) => v.mode === 'on', '   the view is on again', 90000);
	await pick(page, 'reflections', 'off');
	await closeMenu(page);
	d = await settled(page, '   Standard, Global light on, Reflections off; the mask is in the pipeline', (x) => x.lighting.gi && !x.lighting.ssr && x.baked >= bake.objects.length && /\|b$/.test(x.planKey));
	const pts = await project(page, { crate: [-1, 1.0, -1], pillar: [1.5, 1.8, -1.7], wallBack: [-2.2, 2.2, -3.88], wallLeft: [-3.88, 2.2, 1.5], floor: [2.8, 0.01, 2.8], ball: [1.2, 0.8, 1.2] });
	const bakedPts = ['crate', 'pillar', 'wallBack', 'wallLeft', 'floor'].filter((k) => pts[k]).map((k) => pts[k]);
	h.check(bakedPts.length >= 3 && !!pts.ball, `   premise: baked objects and the ball are on screen (${Object.keys(pts).join(', ')})`);
	const giOn = await grab(page, 60);
	await pick(page, 'globalLight', 'off');
	await settled(page, '   Global light off', (x) => !x.lighting.gi);
	await closeMenu(page);
	const giOff = await grab(page, 60);
	const bakedDiff = patchDiff(giOn, giOff, bakedPts);
	const ballDiff = patchDiff(giOn, giOff, [pts.ball])[0];
	console.log(`BAKED_DIFF ${JSON.stringify(bakedDiff)} BALL_DIFF ${ballDiff}`);
	h.check(Math.max(...bakedDiff) < 3, `6. Global light on vs off: the baked objects keep their pixels (mean diff per patch ${bakedDiff.join(', ')})`);
	h.check(ballDiff > Math.max(...bakedDiff), `   the unbaked ball changes more (${ballDiff})`);
	// counterfactual: the mask taken off, the same switch changes the baked pixels (the bug this guards)
	await page.evaluate(async () => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		const mask = v.cinematicLiveForTest().mask;
		mask.offForTest = true;
		mask.undo();
	});
	await pick(page, 'globalLight', 'on');
	await settled(page, '   counterfactual: no mask, Global light on', (x) => x.lighting.gi && x.baked === 0 && !/\|b$/.test(x.planKey));
	await closeMenu(page);
	const cfOn = await grab(page, 60);
	await pick(page, 'globalLight', 'off');
	await settled(page, '   counterfactual: Global light off', (x) => !x.lighting.gi);
	await closeMenu(page);
	const cfOff = await grab(page, 60);
	const cfDiff = patchDiff(cfOn, cfOff, bakedPts);
	h.check(Math.max(...cfDiff) > Math.max(...bakedDiff) + 2, `   without the mask the baked objects DO change (${cfDiff.join(', ')}) — the counterfactual`);
	d = await debug(page);
	h.check(d.errors.length === 0, `   no view errors (${JSON.stringify(d.errors).slice(0, 300)})`);

	await pick(page, 'globalLight', 'auto');
	await pick(page, 'reflections', 'auto');
	// back out: the view off restores every material (no mrtNode left behind)
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(false));
	await h.eventually(() => state(page), (v) => v.mode === 'off', '   the view goes off', 30000);
	const left = await page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		let n = 0;
		g.traverse((o) => {
			for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) if ('mrtNode' in m) n++;
		});
		return n;
	});
	h.check(left === 0, `   no material keeps the view's mark (${left})`);
	// ---- 5. this device only ------------------------------------------------------------------------------------
	await pickQuality(page, 'standard');
	await h.eventually(() => state(page), (v) => v.mode === 'on', '5. premise: the view is on', 90000);
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1200, height: 800 } } });
	await h.connect(B, A);
	const bBefore = await B.page.evaluate(() => localStorage.getItem('cinematicView'));
	await page.evaluate(() => {
		window.__sent106 = [];
		const peer = window.__tp.test.v1.peers;
		/** @type {any} */ let pc;
		peer.subscribe((v) => (pc = v))();
		const wrap = (/** @type {any} */ o, /** @type {string} */ name) => {
			const f = o[name].bind(o);
			o[name] = (...a) => {
				try {
					window.__sent106.push(JSON.stringify(a[0]).slice(0, 400));
				} catch {}
				return f(...a);
			};
		};
		if (pc?.send) wrap(pc, 'send');
		if (pc?.broadcast) wrap(pc, 'broadcast');
	});
	await pick(page, 'globalLight', 'off');
	await pick(page, 'reflections', 'on');
	await pickQuality(page, 'high');
	await settled(page, '5. premise: A changed both switches and the level', (x) => !x.lighting.gi && x.lighting.ssr);
	await page.waitForTimeout(1500);
	const sent = await page.evaluate(() => window.__sent106);
	const leaked = sent.filter((m) => /reflections|globalLight|cinematic|"lighting"/i.test(m));
	h.check(leaked.length === 0, `5. nothing about the switches leaves A (${sent.length} messages sent meanwhile, ${leaked.length} name them${leaked.length ? ': ' + leaked[0] : ''})`);
	const bAfter = await B.page.evaluate(() => localStorage.getItem('cinematicView'));
	const bState = await state(B.page);
	h.check(bAfter === bBefore && bState.mode === 'off', `   B's own setting is untouched (${bBefore} -> ${bAfter}, B's view ${bState.mode})`);
	await h.closePeer(B);

	// persistence: a reload keeps both switches and the measured costs
	await closeMenu(page);
	const kept = await page.evaluate(() => ({ v: localStorage.getItem('cinematicView'), c: localStorage.getItem('cinematicCosts') }));
	await h.freshReload(A);
	await h.answerRestore(A);
	const p1 = await prefs(page);
	h.check(p1.globalLight === 'off' && p1.reflections === 'on' && p1.quality === 'high', `   a reload keeps them on this device (${JSON.stringify(p1)})`);
	const c1 = await page.evaluate(() => localStorage.getItem('cinematicCosts'));
	h.check(!!c1 && c1 === kept.c, `   and the measured costs (${c1})`);
	await h.eventually(() => state(page), (v) => v.mode === 'on', '   the view comes back on by itself (it was on)', 90000);
	await settled(page, '   with the kept switches', (x) => !x.lighting.gi && x.lighting.ssr);
	await openMenu(page);
	const marks = await page.evaluate(() => ['reflections', 'globalLight'].map((k) => document.querySelector(`#preview-light-${k}-mode [aria-checked="true"]`)?.id ?? ''));
	h.check(marks[0].endsWith('-on') && marks[1].endsWith('-off'), `   the menu shows them (${marks.join(', ')})`);
	await closeMenu(page);

	await h.finish(browser);
});
