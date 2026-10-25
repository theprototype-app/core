// 65 gradient — THE GRADIENT LAB (a ShaderGradient port inside the M2 background layer).
//
// The packs set is served from the lane's packs checkout (BACKGROUNDS_DIR, else the sibling
// packs-lane-65-gradient / packs folder) by a route on PACKS_BASE/backgrounds/, so the suite proves the
// app's own loader against the files the packs PR ships.
//   1. every Gradient preset: listed under its family, applied through the loader, the lazy lab chunk
//      draws its picture (high tier, animating); with the CLOCK HELD the picture is identical twice
//      (control), and a later held time gives a different one (it is animated by the shared clock)
//   2. the panel (Configure Scene ▸ Background ▸ Gradient lab): shape (with its framing), a colour,
//      a slider drag = ONE undo step, Randomize + undo, Copy as preset round-trips through the loader;
//      axe over the panel; dark + light screenshots
//   3. reduced motion: the picture holds still (t = 0) and is redrawn only when a param changes;
//      counterfactual: with motion on it keeps redrawing
//   4. TWO PEERS: B receives the document and draws it; on one held clock A's and B's pictures are the
//      same; an edit on A changes B's picture to A's new one
//   5. the OPPO Find N6 folded (390 x 896) and unfolded (770 x 850): the phone tier (low: coarser mesh,
//      smaller target, every second frame), the panel fits the screen
//   6. the QUEST budget probe (IWER, a Quest 3 emulated): in the headset the sphere draws a STILL
//      picture at the low tier, redrawn never while nothing changes; scene calls/triangles + the lab's
//      one-off mesh stay inside 150 calls / 300k triangles; frame time is a row (gated only with
//      GRADIENT_FPS_GATE=1 under `e2e-slot --exclusive`); leaving the headset animates again
// Run: APP_URL=https://localhost:5670/ node tests/e2e/gradient-lab.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.env.HOME, '.code/lanes-30/after-65/65-gradient');
const GRADIENTS = ['ember-ribbon', 'violet-orb', 'mint-tide', 'glass-orbit', 'night-swell', 'indigo-bloom', 'deep-space', 'tangerine-sea'];
const BUDGET = { calls: 150, tris: 300000, ms: 13.9 };

function backgroundsDir() {
	return [
		process.env.BACKGROUNDS_DIR,
		path.join(__dirname, '../../../packs-lane-65-gradient/backgrounds'),
		path.join(__dirname, '../../../packs/backgrounds')
	]
		.filter(Boolean)
		.find((d) => fs.existsSync(path.join(d, 'index.json')) && fs.existsSync(path.join(d, 'ember-ribbon.json')));
}

/** a silent poll (h.eventually records a check; these are waits, the checks follow) */
async function until(fn, pred, _label, timeout = 10000) {
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end) {
		last = await fn();
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 300));
	}
	return last;
}

const bg = (page) => page.evaluate(() => window.__stores.backgroundLayer.backgroundLayerDebug());
const pic = (page) => page.evaluate(() => window.__stores.backgroundLayer.readGradientForTest());
const labData = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.shaderGraph.shaderGraphs.subscribe((v) => (g = v))();
		return g.background?.nodes?.find((n) => n.type === 'gradientLab')?.data ?? null;
	});
const holdClock = (page, t) => page.evaluate((t) => window.__stores.backgroundLayer.setBackgroundClockForTest(t), t);
const frames = (page, n = 4) =>
	page.evaluate((n) => new Promise((ok) => {
		let i = 0;
		const f = () => (++i >= n ? ok() : requestAnimationFrame(f));
		requestAnimationFrame(f);
	}), n);

async function serve(page, dir) {
	await page.route(/\/backgrounds\/[A-Za-z0-9._-]+\.json(\?.*)?$/, (route) => {
		const name = new URL(route.request().url()).pathname.split('/').pop();
		const file = path.join(dir, name);
		if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
		return route.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(file, 'utf8') });
	});
}

async function apply(page, key) {
	const r = await page.evaluate((k) => window.__stores.backgroundPresets.applyBackgroundPreset(k), key);
	await until(() => bg(page), (s) => s.preset === key && s.compiled && s.usesGradient && (s.gradient?.renders ?? 0) > 0, key + ' drawn', 15000).catch(() => {});
	return r;
}

/** the Background section's box (for screenshots and the fit check) */
const sectionBox = (page) =>
	page.evaluate(() => {
		const el = document.getElementById('gradient-lab');
		const sec = el?.closest('section') ?? el?.parentElement;
		const b = (sec ?? el)?.getBoundingClientRect();
		const p = el?.getBoundingClientRect();
		return b && p ? { x: b.x, y: b.y, width: b.width, height: b.height, panel: { x: p.x, y: p.y, w: p.width, h: p.height, right: p.right } } : null;
	});

async function openSection(page) {
	await page.evaluate(() => window.__stores.openSceneSection?.('Background'));
	await page.waitForTimeout(900);
	await page.locator('#gradient-lab').first().scrollIntoViewIfNeeded().catch(() => {});
}

async function measure(page, ms = 3000) {
	return page.evaluate(async (ms) => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const session = r.xr.isPresenting ? r.xr.getSession() : null;
		const raf = (cb) => (session ? session.requestAnimationFrame(cb) : requestAnimationFrame(cb));
		await new Promise((ok) => setTimeout(ok, 800));
		const times = [];
		let last = 0, calls = 0, tris = 0, n = 0;
		await new Promise((done) => {
			const end = performance.now() + ms;
			const tick = (t) => {
				if (last) times.push(t - last);
				last = t;
				calls += r.info.render.calls;
				tris += r.info.render.triangles;
				n++;
				if (performance.now() < end) raf(tick);
				else done();
			};
			raf(tick);
		});
		times.sort((a, b) => a - b);
		const q = (p) => +times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(2);
		return { frames: times.length, p50: q(0.5), p95: q(0.95), calls: Math.round(calls / n), tris: Math.round(tris / n) };
	}, ms);
}

h.run(async () => {
	const dir = backgroundsDir();
	if (!dir) throw new Error('no backgrounds/ checkout with the Gradient family — set BACKGROUNDS_DIR');
	fs.mkdirSync(EVIDENCE, { recursive: true });
	const rows = {};
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});
	await page.evaluate(() => window.__stores.qualityGovernor.setAutoQuality(false));
	await serve(page, dir);
	await page.evaluate(() => window.__stores.objectActions?.deselectObject?.());

	console.log('\n=== 1. every Gradient preset draws, and the shared clock moves it ===');
	const list = await page.evaluate(async () => {
		const s = await window.__stores.backgroundPresets.loadBackgroundPresets({ force: true });
		return s.presets.map((p) => ({ key: p.key, family: p.family ?? '' }));
	});
	const listed = list.filter((p) => p.family === 'Gradient').map((p) => p.key);
	h.check(GRADIENTS.every((k) => listed.includes(k)), '1.0 the loader lists the eight Gradient presets under their family: ' + listed.join(', '));
	let d = await bg(page);
	h.check(!d.usesGradient && d.gradient === null, '1.1 before any lab graph the chunk is not drawing (' + JSON.stringify({ usesGradient: d.usesGradient }) + ')');
	for (const key of GRADIENTS) {
		const r = await apply(page, key);
		d = await bg(page);
		h.check(r.ok && d.draw === 'screen' && d.usesGradient && d.gradient?.mode === 'high' && d.gradient.renders > 0, '1.' + key + ' applied and drawn at the high tier: ' + JSON.stringify({ ok: r.ok, draw: d.draw, mode: d.gradient?.mode, size: d.gradient?.size, shape: d.gradient?.shape, tris: d.gradient?.tris }));
		await holdClock(page, 100);
		await frames(page, 4);
		const p1 = await pic(page);
		await frames(page, 3);
		const p2 = await pic(page);
		await holdClock(page, 104);
		await frames(page, 4);
		const p3 = await pic(page);
		const lit = p1 ? p1.mean[0] + p1.mean[1] + p1.mean[2] : 0;
		h.check(!!p1 && lit > 20, '   ' + key + ': the picture is not empty (mean ' + (p1?.mean ?? []).map((v) => v.toFixed(0)).join('/') + ')');
		h.check(!!p1 && p1.hash === p2?.hash, '   ' + key + ': same held time, same picture (control)');
		h.check(!!p1 && p1.hash !== p3?.hash, '   ' + key + ': 4 s later on the clock, a different picture (animated)');
		fs.writeFileSync(path.join(EVIDENCE, '01-' + key + '.png'), await h.grabFrame(A));
		await holdClock(page, null);
	}

	console.log('\n=== 2. the panel ===');
	await apply(page, 'ember-ribbon');
	await openSection(page);
	h.check((await page.locator('#gradient-lab').count()) > 0, '2.0 Configure Scene ▸ Background shows the Gradient lab panel');
	await page.locator('#gradient-lab-shape-sphere').click();
	await until(() => labData(page), (x) => x?.shape === 'sphere', 'shape sphere', 4000).catch(() => {});
	let data = await labData(page);
	h.check(data?.shape === 'sphere' && data?.distance === 14 && data?.zoom === 12.5, '2.1 Shape ▸ Sphere writes the shape AND its framing: ' + JSON.stringify({ shape: data?.shape, distance: data?.distance, zoom: data?.zoom }));
	await until(() => bg(page), (s) => s.gradient?.shape === 'sphere', 'drawn sphere', 4000).catch(() => {});
	h.check((await bg(page)).gradient?.shape === 'sphere', '2.2 ...and the lab draws the sphere');
	await page.evaluate(() => {
		const el = document.getElementById('gradient-lab-color1');
		el.value = '#12ab34';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.value = '#22bb44';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
	});
	data = await labData(page);
	h.check(data?.color1 === '#22bb44', '2.3 colour 1 writes the document: ' + data?.color1);
	await page.evaluate(() => window.__stores.history.undo());
	data = await labData(page);
	h.check(data?.color1 === '#ff5005', '2.4 ONE undo takes the whole colour pick back (two inputs + change): ' + data?.color1);
	const speedBefore = (await labData(page))?.speed;
	const range = page.locator('#gradient-lab input[type="range"][aria-label="Speed"]').first();
	if (await range.count()) {
		const box = await range.boundingBox();
		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
		await page.mouse.down();
		for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.1), box.y + box.height / 2);
		await page.mouse.up();
	}
	data = await labData(page);
	h.check(data?.speed !== speedBefore && data?.speed > speedBefore, '2.5 dragging Speed writes it (' + speedBefore + ' -> ' + data?.speed + ')');
	await page.evaluate(() => window.__stores.history.undo());
	data = await labData(page);
	h.check(data?.speed === speedBefore, '2.6 ONE undo takes the whole drag back (' + data?.speed + ')');
	const beforeRandom = await labData(page);
	await page.locator('#gradient-lab-randomize').click();
	data = await labData(page);
	h.check(!!data && (data.color1 !== beforeRandom.color1 || data.color2 !== beforeRandom.color2) && data.grain === beforeRandom.grain, '2.7 Randomize writes a new look (grain kept): ' + JSON.stringify({ c1: data?.color1, shape: data?.shape }));
	await page.evaluate(() => window.__stores.history.undo());
	data = await labData(page);
	h.check(JSON.stringify(data) === JSON.stringify(beforeRandom), '2.8 ...and one undo brings the old look back');
	await page.evaluate(() => {
		window.__copied = null;
		navigator.clipboard.writeText = async (t) => {
			window.__copied = t;
		};
	});
	await page.locator('#gradient-lab-copy').click();
	await page.waitForTimeout(300);
	const copied = await page.evaluate(async () => {
		const text = window.__copied;
		if (!text) return null;
		const raw = JSON.parse(text);
		const core = await import('/src/lib/backgroundPresetsCore.js').catch(() => null);
		let g;
		window.__stores.shaderGraph.shaderGraphs.subscribe((v) => (g = v))();
		const n = core ? core.normalizePresetDoc(raw, raw.preset) : { ok: raw.domain === 'background', doc: raw };
		const lab = n.ok ? n.doc.nodes.find((x) => x.type === 'gradientLab') : null;
		const mine = g.background.nodes.find((x) => x.type === 'gradientLab');
		return { ok: n.ok, format: raw.format, preset: raw.preset, same: JSON.stringify(lab?.data) === JSON.stringify(mine?.data), mode: raw.layer?.mode };
	});
	h.check(!!copied && copied.ok && copied.format === 1 && copied.same && copied.mode === undefined, '2.9 Copy as preset puts a packs preset file on the clipboard that the loader reads back with the same params: ' + JSON.stringify(copied));
	try {
		const { AxeBuilder } = require('@axe-core/playwright');
		const res = await new AxeBuilder({ page }).include('#gradient-lab').analyze();
		const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
		h.check(bad.length === 0, '2.10 axe over the panel: no serious/critical violations (' + (bad.map((v) => v.id + 'x' + v.nodes.length).join(', ') || 'none') + '; ' + res.passes.length + ' rules pass)');
	} catch (err) {
		h.check(false, '2.10 axe ran over the panel: ' + String(err?.message ?? err).slice(0, 160));
	}
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
		await page.waitForTimeout(400);
		const box = await sectionBox(page);
		if (box) fs.writeFileSync(path.join(EVIDENCE, '02-panel-' + theme + '.png'), await page.screenshot({ clip: { x: box.x, y: Math.max(0, box.y), width: Math.max(1, box.width), height: Math.min(Math.max(1, box.height), 760) } }));
		h.check(!!box, '2.11 ' + theme + ' screenshot of the section taken');
	}
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));

	console.log('\n=== 3. reduced motion holds it still ===');
	await page.evaluate(() => window.__stores.motion.motionPref.set('full'));
	await frames(page, 3);
	let g0 = (await bg(page)).gradient;
	await page.waitForTimeout(800);
	let g1 = (await bg(page)).gradient;
	h.check(g1.mode === 'high' && g1.renders > g0.renders + 5, '3.0 control, motion on: it keeps redrawing (' + g0.renders + ' -> ' + g1.renders + ')');
	await page.evaluate(() => window.__stores.motion.motionPref.set('reduce'));
	await frames(page, 4);
	g0 = (await bg(page)).gradient;
	await page.waitForTimeout(800);
	g1 = (await bg(page)).gradient;
	h.check(g1.mode === 'still' && g1.clock === 0 && g1.renders <= g0.renders + 1, '3.1 reduced motion: a still frame at t = 0, not redrawn (' + g0.renders + ' -> ' + g1.renders + ', clock ' + g1.clock + ')');
	h.check((await page.locator('#gradient-lab-still').count()) > 0, '3.2 the panel says it is holding still');
	await page.evaluate(() => window.__stores.shaderGraph.setShaderParam('background', 'lab', 'color2', '#3366ff'));
	await until(() => bg(page), (s) => s.gradient.renders > g1.renders, 'redraw on edit', 4000).catch(() => {});
	const g2 = (await bg(page)).gradient;
	await page.waitForTimeout(600);
	const g3 = (await bg(page)).gradient;
	h.check(g2.renders === g1.renders + 1 && g3.renders === g2.renders, '3.3 an edit redraws it exactly once (' + g1.renders + ' -> ' + g2.renders + ' -> ' + g3.renders + ')');
	await page.evaluate(() => window.__stores.motion.motionPref.set('system'));

	console.log('\n=== 4. two peers ===');
	const opts = { context: { viewport: { width: 1100, height: 720 } } };
	const B = await h.setupPageQuiet(browser, 'B', [A], opts);
	await h.answerRestore(B).catch(() => {});
	await B.page.evaluate(() => window.__stores.qualityGovernor.setAutoQuality(false));
	await h.connect(B, A);
	await apply(page, 'night-swell');
	await until(() => bg(B.page), (s) => s.preset === 'night-swell' && s.usesGradient && (s.gradient?.renders ?? 0) > 0, 'B draws', 20000).catch(() => {});
	let b = await bg(B.page);
	h.check(b.preset === 'night-swell' && b.usesGradient && b.gradient?.renders > 0, '4.1 B receives the document and its lab draws it: ' + JSON.stringify({ preset: b.preset, mode: b.gradient?.mode }));
	// the same picture needs the same target size: B's viewport differs, so compare on B's own size by
	// resizing A to B's (the picture is a function of params + clock + size)
	await page.setViewportSize({ width: 1100, height: 720 });
	await page.waitForTimeout(500);
	for (const p of [page, B.page]) await holdClock(p, 222);
	await frames(page, 4);
	await frames(B.page, 4);
	const pa = await pic(page);
	const pb = await pic(B.page);
	h.check(!!pa && !!pb && pa.width === pb.width && pa.hash === pb.hash, '4.2 on one held clock A and B draw the same picture (' + JSON.stringify({ a: pa && [pa.width, pa.height, pa.hash], b: pb && [pb.width, pb.height, pb.hash] }) + ')');
	await page.evaluate(() => window.__stores.shaderGraph.setShaderParam('background', 'lab', 'color1', '#ff00aa'));
	await until(() => labData(B.page), (x) => x?.color1 === '#ff00aa', 'B edit', 10000).catch(() => {});
	await frames(page, 4);
	await frames(B.page, 4);
	const pa2 = await pic(page);
	const pb2 = await pic(B.page);
	h.check(!!pb2 && pb2.hash !== pb.hash && pb2.hash === pa2?.hash, '4.3 A edits colour 1: B\'s picture changes to A\'s new one');
	for (const p of [page, B.page]) await holdClock(p, null);
	await page.evaluate(() => window.__stores.backgroundLayer.removeBackground());
	await until(() => bg(B.page), (s) => s.draw === 'none' && !s.usesGradient, 'B removed', 10000).catch(() => {});
	b = await bg(B.page);
	h.check(b.draw === 'none' && b.gradient === null, '4.4 A removes it: B stops drawing and frees the lab');
	await B.ctx.close().catch(() => {});
	await page.setViewportSize({ width: 1280, height: 800 });

	console.log('\n=== 5. the OPPO Find N6, folded and unfolded ===');
	for (const [name, viewport] of [['folded', { width: 390, height: 896 }], ['unfolded', { width: 770, height: 850 }]]) {
		const P = await h.setupPage(browser, 'n6-' + name, { context: { viewport, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true } });
		await h.answerRestore(P).catch(() => {});
		await serve(P.page, dir);
		await apply(P.page, 'mint-tide');
		const s = await bg(P.page);
		h.check(s.tier === 'low' && s.gradient?.mode === 'low' && Math.max(...s.gradient.size) <= 640, '5.' + name + ' the phone tier: low, every second frame, target ' + JSON.stringify(s.gradient?.size) + ' (cap 640), mesh ' + s.gradient?.geometry);
		await openSection(P.page);
		const box = await sectionBox(P.page);
		const docW = await P.page.evaluate(() => document.documentElement.scrollWidth);
		h.check(!!box && box.panel.right <= viewport.width + 1 && box.panel.x >= -1 && docW <= viewport.width + 1, '   ' + name + ': the panel fits the screen (' + JSON.stringify(box?.panel) + ', doc ' + docW + ')');
		fs.writeFileSync(path.join(EVIDENCE, '05-n6-' + name + '.png'), await P.page.screenshot());
		h.check(h.pageErrors(P).length === 0, '   ' + name + ': no page errors (' + JSON.stringify(h.pageErrors(P)).slice(0, 160) + ')');
		await P.ctx.close().catch(() => {});
	}

	console.log('\n=== 6. the Quest budget probe (IWER) ===');
	const Q = await h.setupPage(browser, 'quest', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	await h.answerRestore(Q).catch(() => {});
	await Q.page.evaluate(() => {
		window.__stores.qualityGovernor.setAutoQuality(false);
		window.__stores.qualityGovernor.governorForTest?.reset?.();
	});
	await serve(Q.page, dir);
	for (const key of ['violet-orb', 'mint-tide']) {
		await apply(Q.page, key);
		await iwer.enter(Q.page);
		await iwer.pose(Q.page, 'head', [0, 1.6, 0], { yaw: 0 });
		await iwer.frames(Q.page, 8);
		const s0 = await bg(Q.page);
		const m = await measure(Q.page, 2500);
		const s1 = await bg(Q.page);
		const lab = s1.gradient;
		h.check(s1.draw === 'sphere' && s1.tier === 'low' && lab?.mode === 'still', '6.' + key + ' in the headset: the sphere, low tier, a still picture: ' + JSON.stringify({ draw: s1.draw, tier: s1.tier, mode: lab?.mode, size: lab?.size, geometry: lab?.geometry }));
		h.check(lab.renders === s0.gradient.renders, '   ' + key + ': not redrawn across ' + m.frames + ' headset frames (' + s0.gradient.renders + ' -> ' + lab.renders + ')');
		h.check(m.calls <= BUDGET.calls && m.tris + lab.tris <= BUDGET.tris, '   ' + key + ': scene ' + m.calls + ' calls / ' + m.tris + ' tris, + the lab mesh ' + lab.tris + ' tris once = inside ' + BUDGET.calls + ' / ' + BUDGET.tris);
		const fpsOk = m.p95 <= BUDGET.ms;
		if (process.env.GRADIENT_FPS_GATE === '1') h.check(fpsOk, '   ' + key + ': p95 frame ' + m.p95 + ' ms <= ' + BUDGET.ms + ' (Deck GPU proxy)');
		else console.log('ROW ' + key + ' xr p50 ' + m.p50 + ' ms, p95 ' + m.p95 + ' ms (not gated without GRADIENT_FPS_GATE=1)');
		rows[key] = { ...m, labTris: lab.tris, labSize: lab.size, mode: lab.mode };
		fs.writeFileSync(path.join(EVIDENCE, '06-xr-' + key + '.png'), await Q.page.screenshot());
		await iwer.exit(Q.page);
		await Q.page.waitForTimeout(600);
		const s2 = await bg(Q.page);
		h.check(s2.draw === 'screen' && s2.gradient?.mode === 'high', '   ' + key + ': leaving the headset animates again at the high tier (' + s2.gradient?.mode + ')');
	}
	fs.writeFileSync(path.join(EVIDENCE, 'quest-rows.json'), JSON.stringify(rows, null, 2));
	h.check(h.pageErrors(A).length === 0, '7. no page errors on A (' + JSON.stringify(h.pageErrors(A)).slice(0, 200) + ')');
	await h.finish(browser);
});
