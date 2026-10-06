// Roadmap 33 (lane 33-editor-ui) — the toolbar and the perf counter, from the user's
// 2026-10-01 feedback on the 1.18 preview:
//   E1 "By default Interact mode button should be after move/rotate/scale buttons, then play
//      button, then object list, node selector, explorer and animation" — the DEFAULT order;
//      a stored record that is still a shipped default migrates, a custom bar wins as saved
//   E2 "Interact mode button when clicked shows red border" — the only <button> cell took
//      focus on click and wore classActive's focus ring; it must look like every other cell
//   E3 "When I hover on interact mode button and it is near Play I see near play button not
//      highlighted area (two small corners)" — the well's hover paint only listened to a
//      <p> neighbour. Measured on real PIXELS at the corners the FAB circle leaves uncovered
//   Q1 "Show amount of fps and draw calls within quest as an option in settings (150 is limit
//      for quest)" — Settings ▸ Interface ▸ Viewport, the desktop corner counter in ANY mode,
//      the VR strip (driven with a synthetic head, the vr-game-panel way), calls amber > 120
//      and red > 150, and the XR frame source feeding the draw-call sampler
const h = require('./helpers.cjs');

const barTitles = (page) =>
	page.evaluate(() =>
		[...(document.querySelector('#controls-pill')?.firstElementChild?.children ?? [])].map(
			(el) => el.getAttribute('title') ?? '—'
		)
	);
const read = (page, path) =>
	page.evaluate((path) => {
		let o = window.__stores;
		for (const k of path.split('.')) o = o[k];
		let v;
		o.subscribe((x) => (v = x))();
		return v;
	}, path);

/** one composited pixel, decoded in the page (only four numbers cross the bridge) */
async function pixelAt(page, x, y) {
	const buf = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
	return page.evaluate(async (b64) => {
		const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
		const img = await createImageBitmap(blob);
		const c = new OffscreenCanvas(1, 1);
		const g = c.getContext('2d');
		g.drawImage(img, 0, 0);
		return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
	}, buf.toString('base64'));
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await page.waitForTimeout(800);

	// ================================================================ E1 the default order
	// 37 R1: the Pivot cell sits with the transforms
	const DEFAULT = ['Move (1)', 'Rotate (2)', 'Scale (3)', 'Pivot: Median point (click to change)', 'Interact mode (I)', '—', 'Object list (O)', 'Node editor (N)', 'Explorer', 'Animation'];
	let titles = await barTitles(page);
	h.check(titles.join(' | ') === DEFAULT.join(' | '), 'E1.1 a fresh profile: transforms, Interact, Play, list, nodes, Explorer, Animation (' + titles.join(' | ') + ')');
	h.check((await page.evaluate(() => localStorage.getItem('controlsLayout'))) === null, 'E1.2 and writes nothing');

	// a record that is still the 1.17/1.18 default (nobody customized it) migrates, keeping
	// where the bar sits and whether it is collapsed
	await page.evaluate(() =>
		localStorage.setItem('controlsLayout', JSON.stringify({ order: ['move', 'rotate', 'scale', 'objects', 'flow', 'explorer', 'mode'], hidden: [], spacerIndex: 3, collapsed: false, posX: 0.3 }))
	);
	await h.freshReload(A);
	await page.waitForTimeout(700);
	titles = await barTitles(page);
	h.check(titles.join(' | ') === DEFAULT.join(' | '), 'E1.3 a stored OLD DEFAULT migrates to the new order (' + titles.join(' | ') + ')');
	const pos = await page.evaluate(() => {
		const nav = document.getElementById('controls-pill');
		const r = nav.getBoundingClientRect();
		return { centre: r.x + r.width / 2, vw: innerWidth };
	});
	h.check(pos.centre < pos.vw / 2 - 20, 'E1.4 ...and keeps where the bar was parked (posX 0.3, centre ' + Math.round(pos.centre) + ' of ' + pos.vw + ')');
	// the pre-30 default (no Interact at all) migrates too
	await page.evaluate(() => localStorage.setItem('controlsLayout', JSON.stringify({ order: ['move', 'rotate', 'scale', 'objects', 'flow', 'explorer'], hidden: [], spacerIndex: 3, collapsed: false })));
	await h.freshReload(A);
	await page.waitForTimeout(700);
	h.check((await barTitles(page)).join(' | ') === DEFAULT.join(' | '), 'E1.5 the pre-30 default migrates as well');
	// a CUSTOM bar wins as saved: Rotate hidden, the well moved — and Animation (opt-in
	// before) is NOT forced onto a bar that never chose it
	await page.evaluate(() =>
		localStorage.setItem('controlsLayout', JSON.stringify({ order: ['move', 'rotate', 'scale', 'objects', 'flow', 'explorer', 'mode'], hidden: ['rotate'], spacerIndex: 2, collapsed: false, posX: null }))
	);
	await h.freshReload(A);
	await page.waitForTimeout(700);
	titles = await barTitles(page);
	h.check(
		titles.join(' | ') === ['Move (1)', 'Scale (3)', '—', 'Object list (O)', 'Node editor (N)', 'Explorer', 'Interact mode (I)', 'Pivot: Median point (click to change)'].join(' | '), // 37 R1: a button NEW to the app is appended
		'E1.6 a CUSTOM bar keeps its own order, and gains no Animation (' + titles.join(' | ') + ')'
	);
	await page.evaluate(() => localStorage.removeItem('controlsLayout'));
	await h.freshReload(A);
	await page.waitForTimeout(700);
	h.check((await barTitles(page)).join(' | ') === DEFAULT.join(' | '), 'premise: back on the default bar');
	// Animation is a working default button: it opens the Animation dock tab
	await page.locator('#controls-pill [title="Animation"]').click();
	await h.eventually(() => read(page, 'bottomDock.bottomDockActive'), (k) => k === 'animation', 'E1.7 the default Animation button opens the Animation tab');
	await page.locator('#controls-pill [title="Animation"]').click();
	await page.waitForTimeout(300);

	// ================================================================ E2 no red ring on click
	const cell = page.locator('#editor-mode-toggle');
	const box = await cell.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y - 120);
	await page.waitForTimeout(200);
	// a pixel just OUTSIDE the cell's left edge, mid-height: the focus ring is an OUTER
	// box-shadow, so it paints over the neighbour (Scale), not inside the cell
	const edge = { x: box.x - 2, y: box.y + box.height / 2 };
	const edgeBefore = await pixelAt(page, edge.x, edge.y);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await page.waitForTimeout(200);
	h.check((await read(page, 'editorMode')) === 'interact', 'premise: the click switched to Interact');
	h.check(await page.evaluate(() => document.activeElement?.id === 'editor-mode-toggle'), 'premise: the <button> holds focus after the click (the state that drew the ring)');
	await page.mouse.move(box.x + box.width / 2, box.y - 120);
	await page.waitForTimeout(250);
	const shadow = await page.evaluate(() => getComputedStyle(document.getElementById('editor-mode-toggle')).boxShadow);
	// a ring is a box-shadow layer with a visible colour and a non-zero spread or blur
	const ringLayers = shadow === 'none' ? [] : shadow.split(/,(?![^(]*\))/).filter((layer) => {
		const color = layer.match(/rgba?\([^)]*\)/)?.[0] ?? '';
		const alpha = /rgba/.test(color) ? Number(color.split(',')[3]) : 1;
		const nums = layer.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
		return alpha > 0.05 && nums.slice(2).some((n) => n !== 0);
	});
	h.check(ringLayers.length === 0, 'E2.1 a clicked Interact carries no focus ring (box-shadow ' + shadow + ')');
	const edgeAfter = await pixelAt(page, edge.x, edge.y);
	h.check(near(edgeBefore, edgeAfter, 4), 'E2.2 and its edge pixel is unchanged by the click (' + edgeBefore + ' -> ' + edgeAfter + ')');
	h.check((await page.evaluate(() => getComputedStyle(document.getElementById('editor-mode-toggle')).outlineStyle)) === 'none', 'E2.3 no outline either');
	h.check((await cell.getAttribute('aria-pressed')) === 'true', 'E2.4 it still says it is pressed (aria-pressed)');
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await page.waitForTimeout(200);
	h.check((await read(page, 'editorMode')) === 'edit', 'premise: back to Edit');
	await page.evaluate(() => document.activeElement?.blur?.());

	// ================================================================ E3 the corners by Play
	const geo = await page.evaluate(() => {
		const fab = document.getElementById('play-button');
		const well = fab.parentElement;
		const w = well.getBoundingClientRect();
		const left = well.previousElementSibling.getBoundingClientRect();
		const right = well.nextElementSibling.getBoundingClientRect();
		return { w: { x: w.x, y: w.y, width: w.width, height: w.height }, leftTitle: well.previousElementSibling.getAttribute('title'), rightTitle: well.nextElementSibling.getAttribute('title'), left: { x: left.x, y: left.y, width: left.width, height: left.height }, right: { x: right.x, y: right.y, width: right.width, height: right.height } };
	});
	h.check(geo.leftTitle === 'Interact mode (I)', 'premise: Interact is the well\'s left neighbour (' + geo.leftTitle + ')');
	// the corners of the well the 50 px FAB circle leaves uncovered: the integer pixel nearest
	// each corner whose centre is >= 1 px outside the circle AND resolves to that half (not
	// the FAB, not its anti-aliased edge)
	const corners = await page.evaluate(() => {
		const fab = document.getElementById('play-button');
		const well = fab.parentElement;
		const f = fab.getBoundingClientRect();
		const w = well.getBoundingClientRect();
		const cx = f.x + f.width / 2;
		const cy = f.y + f.height / 2;
		const r = f.width / 2;
		const find = (half, xs, ys) => {
			for (const y of ys)
				for (const x of xs) {
					if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r + 1) continue;
					if (document.elementFromPoint(x + 0.5, y + 0.5) === half) return { x, y };
				}
			return null;
		};
		const x0 = Math.ceil(w.x);
		const x1 = Math.floor(w.x + w.width) - 1;
		const y0 = Math.ceil(w.y);
		const y1 = Math.floor(w.y + w.height) - 1;
		const L = well.children[0];
		const R = well.children[1];
		return {
			tl: find(L, [x0, x0 + 1, x0 + 2], [y0, y0 + 1, y0 + 2]),
			bl: find(L, [x0, x0 + 1, x0 + 2], [y1, y1 - 1, y1 - 2]),
			tr: find(R, [x1, x1 - 1, x1 - 2], [y0, y0 + 1, y0 + 2])
		};
	});
	h.check(!!(corners.tl && corners.bl && corners.tr), 'premise: corner pixels outside the FAB exist in both halves (' + JSON.stringify(corners) + ')');
	const cornerTL = corners.tl ?? { x: geo.w.x, y: geo.w.y };
	const cornerBL = corners.bl ?? { x: geo.w.x, y: geo.w.y + geo.w.height - 1 };
	// nothing hovered: the mouse leaves the bar first (the E2 click left it over Interact)
	await page.mouse.move(640, 200);
	await page.waitForTimeout(250);
	const pillBg = await pixelAt(page, cornerTL.x, cornerTL.y);
	const pillBgBL = await pixelAt(page, cornerBL.x, cornerBL.y);
	await page.mouse.move(geo.left.x + geo.left.width / 2, geo.left.y + geo.left.height / 2);
	await page.waitForTimeout(250);
	const hoverBg = await pixelAt(page, geo.left.x + 3, geo.left.y + geo.left.height / 2);
	h.check(!near(hoverBg, pillBg, 10), 'premise: hovering Interact paints it (' + pillBg + ' -> ' + hoverBg + ')');
	const tl = await pixelAt(page, cornerTL.x, cornerTL.y);
	const bl = await pixelAt(page, cornerBL.x, cornerBL.y);
	h.check(near(tl, hoverBg, 8), 'E3.1 the top corner beside Play takes the hover colour (' + tl + ' vs ' + hoverBg + ')');
	h.check(near(bl, hoverBg, 8) && !near(pillBgBL, hoverBg, 10), 'E3.2 and the bottom corner (' + pillBgBL + ' -> ' + bl + ' vs ' + hoverBg + ')');
	// the right half answers the right neighbour, the same rule (a <p> there)
	await page.mouse.move(geo.right.x + geo.right.width / 2, geo.right.y + geo.right.height / 2);
	await page.waitForTimeout(250);
	const hoverR = await pixelAt(page, geo.right.x + geo.right.width - 3, geo.right.y + geo.right.height / 2);
	const tr = await pixelAt(page, (corners.tr ?? cornerTL).x, (corners.tr ?? cornerTL).y);
	h.check(near(tr, hoverR, 8), 'E3.3 the right-hand corner follows Object list as before (' + tr + ' vs ' + hoverR + ')');
	const tlNow = await pixelAt(page, cornerTL.x, cornerTL.y);
	h.check(near(tlNow, pillBg, 8), 'E3.4 and the left corner is NOT painted by the right neighbour (' + tlNow + ')');
	await page.mouse.move(640, 200);

	// ================================================================ Q1 FPS + draw calls
	h.check(!(await page.locator('#game-fps-counter').isVisible()), 'Q1.1 off by default');
	await page.evaluate(() => {
		window.__stores.settingsSection.set('interface');
		window.__stores.settingsOpen.set(true);
	});
	const toggle = page.locator('#show-perf-stats');
	await toggle.waitFor({ state: 'attached', timeout: 5000 });
	// the Toggle's <input> is visually hidden inside its label: press it the way a click on
	// the row's switch does (an element click), not by viewport coordinates
	await toggle.evaluate((el) => el.click());
	await page.waitForTimeout(400);
	h.check((await read(page, 'gameKit.fpsMeter.perfStatsShown')) === true, 'Q1.2 the Settings toggle turns it on');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(1300);
	h.check((await read(page, 'editorMode')) === 'edit' && (await read(page, 'isLocked')) !== true, 'premise: in the EDITOR, not playing');
	h.check(await page.locator('#game-fps-counter').isVisible(), 'Q1.3 the counter shows in the editor (app-wide, not only in a game)');
	const text = ((await page.locator('#game-fps-counter').textContent()) ?? '').replace(/\s+/g, ' ').trim();
	h.check(/\d+ fps/.test(text) && /ms/.test(text) && /calls/.test(text) && /tris/.test(text), 'Q1.4 fps, frame ms, draw calls and triangles (' + text + ')');
	h.check(/ms · \d+ calls · \d+k? tris/.test(text), 'Q1.4b the parts are separated by " · " (' + text + ')');
	// the budget colours, through the real reading store
	// set and read in ONE page task: the live meter republishes its own reading every 500 ms
	// (calls ~14 here), and a gap between a synthetic set and the read loses that race
	const tierAt = (calls) =>
		page.evaluate(async (calls) => {
			window.__stores.gameKit.fpsMeter.fpsReading.set({ fps: 72, ms: 13.9, calls, tris: 120000, source: 'desktop' });
			// MICROTASKS only: svelte flushes the DOM in a microtask queued by the set, while the
			// live meter republishes from a rAF / timer callback, which cannot run in between
			for (let i = 0; i < 4; i++) await Promise.resolve();
			const el = document.getElementById('fps-calls');
			return { tier: el?.dataset.tier, color: el ? getComputedStyle(el).color : null, text: el?.textContent };
		}, calls);
	const ok = await tierAt(98);
	const warn = await tierAt(131);
	const over = await tierAt(163);
	h.check(ok.tier === 'ok' && warn.tier === 'warn' && over.tier === 'over', 'Q1.5 98 / 131 / 163 calls read ok / warn / over (' + [ok, warn, over].map((t) => t.text + '=' + t.tier).join(', ') + ')');
	h.check(warn.color === 'rgb(251, 191, 36)', 'Q1.6 past 120 the calls are AMBER (' + warn.color + ')');
	h.check(over.color === 'rgb(248, 113, 113)', 'Q1.7 past 150 they are RED (' + over.color + ')');
	h.check(ok.color !== warn.color && ok.color !== over.color, 'Q1.8 and in budget they are neither (' + ok.color + ')');
	// it persists (LOCAL)
	await h.freshReload(A);
	await page.waitForTimeout(1300);
	h.check(await page.locator('#game-fps-counter').isVisible(), 'Q1.9 the preference survives a reload');

	// ---- the headset: the strip, every mode, through the same reading
	const strip = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const k = s.gameKit;
		k.fpsMeter.fpsReading.set({ fps: 72, ms: 13.9, calls: 163, tris: 248000, source: 'xr' });
		const head = { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() };
		k.vrPerfStrip.vrPerfStripFrame(head);
		const on = k.vrPerfStrip.vrPerfStripDebug();
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const mesh = scene.getObjectByName('vr-perf-strip');
		const p = mesh ? mesh.position.toArray().map((n) => Math.round(n * 100) / 100) : null;
		k.fpsMeter.fpsReading.set({ fps: 72, ms: 13.9, calls: 98, tris: 248000, source: 'xr' });
		k.vrPerfStrip.vrPerfStripFrame(head);
		const inBudget = k.vrPerfStrip.vrPerfStripDebug().segments;
		k.fpsMeter.perfStatsShown.set(false);
		k.vrPerfStrip.vrPerfStripFrame(head);
		const off = k.vrPerfStrip.vrPerfStripDebug().visible;
		k.fpsMeter.perfStatsShown.set(true);
		k.vrPerfStrip.vrPerfStripFrame(null);
		const notPresenting = k.vrPerfStrip.vrPerfStripDebug().visible;
		return { on, p, inBudget, off, notPresenting, mode: (() => { let m; s.editorMode.subscribe((v) => (m = v))(); return m; })() };
	});
	h.check(strip.on.visible && strip.on.parent === 'Scene', 'Q1.10 in a headset the strip shows — in EDIT too (' + strip.mode + ')');
	h.check(strip.p && strip.p[1] > 1.9 && strip.p[2] < -1, 'Q1.11 ...head-locked, ahead and above the gaze (' + strip.p + ')');
	const callSeg = strip.on.segments.find((x) => /calls/.test(x.text));
	h.check(strip.on.segments.map((x) => x.text).join(' · ') === '72 fps · 13.9 ms · 163 calls · 248k tris', 'Q1.12 the strip reads fps, ms, calls, tris (' + strip.on.segments.map((x) => x.text).join(' · ') + ')');
	h.check(callSeg?.color === '#f87171', 'Q1.13 163 calls are drawn RED on the strip (' + callSeg?.color + ')');
	h.check(strip.inBudget.find((x) => /calls/.test(x.text))?.color === '#d1d5db', 'Q1.14 98 calls are drawn plain');
	h.check(strip.off === false, 'Q1.15 the Settings toggle takes it down in the headset too');
	h.check(strip.notPresenting === false, 'Q1.16 and nothing shows outside a session');

	// ---- the XR frame source feeds the draw-call sampler (the window rAF stops in a headset)
	const xr = await page.evaluate(async () => {
		const s = window.__stores;
		let m0;
		s.sceneBudget.sceneMetrics.subscribe((v) => (m0 = v))();
		const before = m0.at;
		// XR frames timestamped well past the window loop's last tick = a stalled window loop
		const t0 = performance.now() + 60000;
		for (let i = 0; i < 50; i++) s.gameKit.fpsMeter.noteXrFrame(t0 + i * (1000 / 72));
		let m1;
		s.sceneBudget.sceneMetrics.subscribe((v) => (m1 = v))();
		return { sampled: m1.at > before, calls: m1.calls };
	});
	h.check(xr.sampled, 'Q1.17 XR frames alone drive a fresh draw-call sample (calls ' + xr.calls + ')');
	await page.evaluate(() => window.__stores.gameKit.fpsMeter.perfStatsShown.set(false));

	await h.finish(browser);
});
