// 105-noise (roadmap 105 T4a) — NOISE IN THE IMAGE EDITOR, AND "FILL WITH NOISE" ON A MATERIAL SLOT'S MAP ROW.
//
//   §1  the Roughness row's Fill with noise… on a box with no roughness map: the size dialog (1024 default), ONE undo
//       step, a 1024 map on BOTH peers, the editor opened on the new library image with the Noise panel open
//   §2  the library image tiles: its edge pixels match within one level (the worker-pool path, in a real browser)
//   §3  the panel: a kind change shows the live preview badge; Apply = one step of the EDITOR's undo (the scene's is
//       untouched); Save writes the image AND the roughness row, on both peers
//   §4  scene undo puts the previous roughness map back on both peers; undo again takes the map away
//   §5  the colour row: Fill with noise… at 512 makes a texture LINKED to its library image (mapSource), both peers
//   §6  B reloads and rejoins: it sees the same colour texture as A (an ordinary texture, nothing new on the wire)
//   §7  long tasks: a 2048 fill (the generator) and the editor's Apply at 2048 never block the page > 100 ms
//   §8  the agent: set_material {maps: {normal: {noise: {...}}}} writes a normal map and says what it wrote
//   §9  view-off: nothing pressed = no worker, no noise chunk loaded, nothing changed (feature unused = zero change)
//
// Run: APP_URL='https://localhost:7208/' npm run e2e -- image-noise
const h = require('./helpers.cjs');

/** a resource that is the noise feature's code: the module names, never the folder (a lane tree is "105-noise") */
const NOISE_CODE = /(noiseCore|noiseRun|noiseFill|noise\.worker|ImageNoisePanel)[^/]*$/;

/** wait until `fn` resolves truthy (or the time runs out) — the checks after it decide */
async function until(fn, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}
const S = (p, fn, arg) => p.page.evaluate(fn, arg);

/**
 * A texture on a box's material slot 0, summarised in the page: its size and a checksum of a 32x32 draw (the same
 * bytes decode the same on two pages of one browser). null = no texture there (yet).
 */
const texSum = (p, uuid, key) =>
	S(
		p,
		async ({ id, key }) => {
			const s = window.__tp?.test.v1;
			const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
			const m = g.getObjectByProperty('uuid', id)?.material;
			const tex = m?.[key];
			const img = tex?.image;
			if (!img) return null;
			const w = img.naturalWidth || img.width;
			const hh = img.naturalHeight || img.height;
			if (!w || !hh) return null;
			const c = document.createElement('canvas');
			c.width = 32;
			c.height = 32;
			const ctx = c.getContext('2d', { willReadFrequently: true });
			ctx.drawImage(img, 0, 0, 32, 32);
			const d = ctx.getImageData(0, 0, 32, 32).data;
			let sum = 0;
			let hash = 7;
			for (let i = 0; i < d.length; i++) (sum += d[i]), (hash = (hash * 31 + d[i]) >>> 0);
			/** every other pixel's RGB: enough to compare two encodes of one picture */
			const px = [];
			for (let y = 0; y < 32; y += 2) for (let x = 0; x < 32; x += 2) for (let ch = 0; ch < 3; ch++) px.push(d[(y * 32 + x) * 4 + ch]);
			return { w, h: hh, sum, hash, px, flipY: tex.flipY !== false, source: key === 'map' ? (m.userData?.mapSource ?? null) : null };
		},
		{ id: uuid, key }
	);

/**
 * The picture a texture shows on the model, as 64x64 box-averaged luma (rows flipped back for a flipY-off texture,
 * the glTF convention): what two encodes of one picture share and two different noises do not.
 */
const texLuma = (p, uuid, key) =>
	S(
		p,
		async ({ id, key }) => {
			const s = window.__tp?.test.v1;
			const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
			const tex = g.getObjectByProperty('uuid', id)?.material?.[key];
			const img = tex?.image;
			const W = img?.naturalWidth || img?.width;
			const H = img?.naturalHeight || img?.height;
			if (!W || !H) return null;
			const c = document.createElement('canvas');
			c.width = W;
			c.height = H;
			const ctx = c.getContext('2d', { willReadFrequently: true });
			ctx.drawImage(img, 0, 0);
			const d = ctx.getImageData(0, 0, W, H).data;
			const N = 64;
			const out = new Array(N * N).fill(0);
			for (let y = 0; y < H; y++) {
				const by = Math.min(N - 1, Math.floor((y * N) / H));
				const row = tex.flipY === false ? N - 1 - by : by;
				for (let x = 0; x < W; x++) {
					const i = (y * W + x) * 4;
					out[row * N + Math.min(N - 1, Math.floor((x * N) / W))] += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
				}
			}
			const per = (W * H) / (N * N);
			return out.map((v) => v / per);
		},
		{ id: uuid, key }
	);
/** Pearson correlation of two luma grids @param {number[]} a @param {number[]} b */
function corr(a, b) {
	if (!a || !b || a.length !== b.length) return 0;
	const n = a.length;
	const ma = a.reduce((t, v) => t + v, 0) / n;
	const mb = b.reduce((t, v) => t + v, 0) / n;
	let sab = 0, saa = 0, sbb = 0;
	for (let i = 0; i < n; i++) (sab += (a[i] - ma) * (b[i] - mb)), (saa += (a[i] - ma) ** 2), (sbb += (b[i] - mb) ** 2);
	return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** the mean per-channel difference of two texSum samples (a re-encode moves a few levels, another picture ~40+) */
const meanDiff = (a, b) => {
	if (!a || !b || a.px.length !== b.px.length) return 999;
	// a texture that came through the glTF full-state sync stores its image upside down with flipY off (the glTF
	// convention): the same picture on the model, rows reversed in the image
	const rows = 16;
	const row = a.px.length / rows;
	const at = (i) => (a.flipY === b.flipY ? b.px[i] : b.px[(rows - 1 - Math.floor(i / row)) * row + (i % row)]);
	return a.px.reduce((t, v, i) => t + Math.abs(v - at(i)), 0) / a.px.length;
};

const undoLen = (p) => S(p, () => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((v) => r(v.length))()));

/** the biggest 8-bit step across a library image's wrap, and the biggest step inside it */
const seamOf = (p, itemId) =>
	S(
		p,
		async (i) => {
			const blob = await window.__tp.test.v1.explorer.itemBlob(i);
			const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
			const c = document.createElement('canvas');
			c.width = bmp.width;
			c.height = bmp.height;
			const ctx = c.getContext('2d', { willReadFrequently: true });
			ctx.drawImage(bmp, 0, 0);
			const W = bmp.width;
			const H = bmp.height;
			const d = ctx.getImageData(0, 0, W, H).data;
			const at = (x, y, ch) => d[(y * W + x) * 4 + ch];
			let wrap = 0;
			let inner = 0;
			for (let y = 0; y < H; y += 3)
				for (let ch = 0; ch < 3; ch++) {
					wrap = Math.max(wrap, Math.abs(at(W - 1, y, ch) - at(0, y, ch)));
					for (let x = 1; x < W; x++) inner = Math.max(inner, Math.abs(at(x, y, ch) - at(x - 1, y, ch)));
				}
			for (let x = 0; x < W; x += 3)
				for (let ch = 0; ch < 3; ch++) wrap = Math.max(wrap, Math.abs(at(x, H - 1, ch) - at(x, 0, ch)));
			return { W, H, wrap, inner };
		},
		itemId
	);

/** start collecting long tasks in the page (PerformanceObserver), and read the longest since the start */
const longStart = (p) =>
	S(p, () => {
		window.__noiseLong = [];
		window.__noiseObs?.disconnect();
		window.__noiseObs = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) window.__noiseLong.push(Math.round(e.duration));
		});
		window.__noiseObs.observe({ type: 'longtask', buffered: false });
	});
const longRead = (p) => S(p, () => [...(window.__noiseLong ?? [])].sort((a, b) => b - a));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await S(A, () => window.__tp.test.v1.explorer.loadExplorer());
	// the dev server serves thousands of modules: past the default 250 entries the resource timeline drops new ones,
	// which made the first view-off check blind (run2). Make room, so what loads FROM HERE ON is all seen; what boot
	// loads is proven on the production build instead (boot-size: no noise chunk in the initial list).
	await S(A, () => performance.setResourceTimingBufferSize(200000));
	await S(B, () => performance.setResourceTimingBufferSize(200000));

	// ---- §9 (first, before anything is pressed): the feature unused = zero change ----------------
	const resources = () => S(A, () => performance.getEntriesByType('resource').map((e) => e.name));
	const loadedBefore = (await resources()).filter((n) => NOISE_CODE.test(n.split('?')[0]));
	h.check(loadedBefore.length === 0, `view-off: nothing noise-related is loaded by a page that has not used it (${loadedBefore.length ? loadedBefore.join(', ') : 'none'})`);

	await h.connect(B, A);
	await A.page.waitForTimeout(1200);
	await S(A, () => window.__tp.test.v1.commandsHandler.sceneCommand('/create Box 1 1 1'));
	await A.page.waitForTimeout(900);
	const box = await S(A, async () => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await until(() => S(B, async (id) => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		return !!g.getObjectByProperty('uuid', id);
	}, box), 10000);
	const roughBefore = await texSum(A, box, 'roughnessMap');
	h.check(roughBefore === null, 'PREMISE: the box has no roughness map');
	const loadedIdle = (await resources()).filter((n) => NOISE_CODE.test(n.split('?')[0]));
	h.check(loadedIdle.length === 0, `view-off: after a session with objects, still no noise chunk or worker (${loadedIdle.length})`);

	// ---- §1 the Roughness row ------------------------------------------------------------------
	await S(A, (id) => window.__tp.test.v1.objectActions.selectObject(id, true), box);
	await A.page.waitForTimeout(700);
	const undo0 = await undoLen(A);
	await A.page.locator('#map-noise-roughnessMap').scrollIntoViewIfNeeded();
	await A.page.locator('#map-noise-roughnessMap').click();
	await A.page.locator('#confirm-dialog-1024').waitFor({ timeout: 8000 });
	const dialogText = (await A.page.locator('#confirm-dialog-1024').textContent()) ?? '';
	h.check(/1024 px \(default\)/.test(dialogText), `the size dialog offers 1024 as the default ("${dialogText.trim()}")`);
	h.check((await A.page.locator('#confirm-dialog-512').count()) === 1 && (await A.page.locator('#confirm-dialog-2048').count()) === 1, 'and 512 / 2048');
	await A.page.locator('#confirm-dialog-1024').click();
	await until(async () => !!(await texSum(A, box, 'roughnessMap')), 20000);
	const r1 = await texSum(A, box, 'roughnessMap');
	h.check(!!r1 && r1.w === 1024 && r1.h === 1024, `A's box has a 1024 roughness map (${r1 ? r1.w + '×' + r1.h : 'none'})`);
	h.check((await undoLen(A)) === undo0 + 1, `the fill is ONE undo step (${undo0} → ${await undoLen(A)})`);
	await until(async () => (await texSum(B, box, 'roughnessMap'))?.hash === r1?.hash, 15000);
	const rb1 = await texSum(B, box, 'roughnessMap');
	h.check(!!rb1 && rb1.hash === r1?.hash, `the peer sees the same roughness map (${rb1?.hash} / ${r1?.hash})`);
	await A.page.locator('#image-editor-noise').waitFor({ timeout: 15000 }).catch(() => {});
	h.check((await A.page.locator('#image-editor-noise').count()) === 1, 'the Image editor opened with the Noise panel');
	const made = await S(A, () => {
		const it = window.__tp.test.v1.explorer.allItems().find((i) => / Roughness noise\.png$/.test(i.name));
		return it && { id: it.id, name: it.name, hash: it.hash };
	});
	h.check(!!made, `the noise is a library image (${made?.name})`);
	const loadedNow = (await resources()).filter((n) => NOISE_CODE.test(n.split('?')[0]));
	h.check(loadedNow.length >= 2, `COUNTERFACTUAL for view-off: once used, the noise code does load (${loadedNow.length} files)`);

	// ---- §2 the library image tiles ---------------------------------------------------------
	if (made) {
		const seam = await seamOf(A, made.id);
		h.check(seam.W === 1024 && seam.wrap <= seam.inner + 1, `tileable: the edge pixels match within one level (wrap step ${seam.wrap}, inner max ${seam.inner})`);
	}

	// ---- §3 the panel: preview, Apply (editor undo), Save (the row) ---------------------------
	const undoScene = await undoLen(A);
	await A.page.locator('#image-noise-kind').getByRole('radio', { name: 'Cells' }).click().catch(async () => {
		await A.page.locator('#image-noise-kind button', { hasText: 'Cells' }).click();
	});
	await until(async () => (await A.page.locator('#image-editor-noise-badge').count()) === 1, 8000);
	h.check((await A.page.locator('#image-editor-noise-badge').count()) === 1, 'the canvas shows the live preview');
	h.check(await A.page.locator('#image-editor-undo').isDisabled(), 'a preview is not an edit (editor undo still empty)');
	await A.page.locator('#image-noise-apply').click();
	await until(async () => !(await A.page.locator('#image-editor-undo').isDisabled()), 15000);
	h.check(!(await A.page.locator('#image-editor-undo').isDisabled()), 'Apply is a step of the editor\'s own undo');
	h.check((await A.page.locator('#image-editor-noise').count()) === 0, 'and closes the panel');
	h.check((await undoLen(A)) === undoScene, 'the scene\'s undo is untouched until Save');
	await A.page.locator('#image-editor-save').click();
	await until(async () => (await texSum(A, box, 'roughnessMap'))?.hash !== r1?.hash, 20000);
	const r2 = await texSum(A, box, 'roughnessMap');
	h.check(!!r2 && r2.hash !== r1?.hash, 'Save wrote the new noise to the Roughness row');
	await until(async () => (await texSum(B, box, 'roughnessMap'))?.hash === r2?.hash, 15000);
	h.check((await texSum(B, box, 'roughnessMap'))?.hash === r2?.hash, 'and the peer follows');

	// ---- §4 scene undo -------------------------------------------------------------------------
	await S(A, () => window.__tp.test.v1.imageEditor.closeImageEditor());
	await A.page.waitForTimeout(300);
	await S(A, () => window.__tp.test.v1.history.undo());
	await until(async () => (await texSum(A, box, 'roughnessMap'))?.hash === r1?.hash, 10000);
	h.check((await texSum(A, box, 'roughnessMap'))?.hash === r1?.hash, 'undo puts the first noise back');
	await until(async () => (await texSum(B, box, 'roughnessMap'))?.hash === r1?.hash, 15000);
	h.check((await texSum(B, box, 'roughnessMap'))?.hash === r1?.hash, 'on the peer too');
	await S(A, () => window.__tp.test.v1.history.undo());
	await until(async () => (await texSum(A, box, 'roughnessMap')) === null, 10000);
	h.check((await texSum(A, box, 'roughnessMap')) === null, 'undo again: the box has no roughness map, as before');
	await until(async () => (await texSum(B, box, 'roughnessMap')) === null, 15000);
	h.check((await texSum(B, box, 'roughnessMap')) === null, 'nor on the peer');

	// ---- §5 the colour row ----------------------------------------------------------------------
	await S(A, (id) => window.__tp.test.v1.objectActions.selectObject(id, true), box);
	await A.page.waitForTimeout(500);
	await A.page.locator('#texture-noise').scrollIntoViewIfNeeded();
	await A.page.locator('#texture-noise').click();
	await A.page.locator('#confirm-dialog-512').click({ timeout: 8000 });
	await until(async () => !!(await texSum(A, box, 'map')), 20000);
	const c1 = await texSum(A, box, 'map');
	const colourItem = await S(A, () => {
		const it = window.__tp.test.v1.explorer.allItems().find((i) => / Colour noise\.png$/.test(i.name));
		return it && { id: it.id, hash: it.hash };
	});
	h.check(!!c1 && c1.w === 512, `the colour texture is 512 (${c1?.w})`);
	h.check(!!colourItem && c1?.source === colourItem.hash, 'and LINKED to its library image (Save in the editor re-textures it)');
	await until(async () => (await texSum(B, box, 'map'))?.hash === c1?.hash, 15000);
	const cb1 = await texSum(B, box, 'map');
	h.check(cb1?.hash === c1?.hash && cb1?.source === c1?.source, 'the peer has the same texture and link');

	// ---- §6 B reloads and rejoins -----------------------------------------------------------------
	await h.freshReload(B);
	// a joiner's reload REJOINS the session by itself (the text-object finding); dial only when it did not
	const rejoined = await B.page
		.waitForFunction(() => { let p; window.__tp.test.v1.peers.subscribe((v) => (p = v))(); return (p?.openedPeers?.length ?? p?.openedPeers?.size ?? 0) > 0; }, null, { timeout: 30000, polling: 250 })
		.then(() => true)
		.catch(() => false);
	console.log('  B rejoined after its reload by itself: ' + rejoined);
	if (!rejoined) {
		await h.answerRestore(B, 'dismiss').catch(() => {});
		await h.connect(B, A);
	}
	// a rejoin gets the object through the full-state sync, which re-encodes the texture (and stores it flipY-off, the
	// glTF way): the same PICTURE, not the same bytes — so compare what the model shows, by correlation
	const lumaA = await texLuma(A, box, 'map');
	await until(async () => corr(await texLuma(B, box, 'map'), lumaA) > 0.9, 20000);
	const lumaB = await texLuma(B, box, 'map');
	const cb2 = await texSum(B, box, 'map');
	const same = corr(lumaB, lumaA);
	h.check(same > 0.9 && cb2?.w === c1?.w, `after a reload the peer sees the same texture (${cb2?.w} px, correlation ${same.toFixed(3)})`);
	h.check(cb2?.source === c1?.source, 'and still knows which library image it is');
	// the counterfactual: another noise of the same row defaults (seed 2) does not correlate
	const otherLuma = await S(A, async () => {
		const s = window.__tp.test.v1;
		const r = await s.noiseRun.renderNoise({ ...s.noiseCore.NOISE_ROW_DEFAULTS.map, seed: 2 }, { width: 512, height: 512 });
		const N = 64;
		const out = new Array(N * N).fill(0);
		for (let y = 0; y < 512; y++)
			for (let x = 0; x < 512; x++) {
				const i = (y * 512 + x) * 4;
				out[(y >> 3) * N + (x >> 3)] += (0.2126 * r.data[i] + 0.7152 * r.data[i + 1] + 0.0722 * r.data[i + 2]) / 64;
			}
		return out;
	});
	const far = corr(otherLuma, lumaA);
	h.check(Math.abs(far) < 0.5, `COUNTERFACTUAL: another seed's noise does not pass for it (correlation ${far.toFixed(3)})`);

	// ---- §7 long tasks at 2048 ----------------------------------------------------------------------
	await S(A, () => window.__tp.test.v1.imageEditor.closeImageEditor());
	await A.page.waitForTimeout(600);
	await longStart(A);
	const gen = await S(A, async () => {
		const run = window.__tp.test.v1.noiseRun;
		const t = performance.now();
		const r = await run.renderNoise({ kind: 'simplex', octaves: 6 }, { width: 2048, height: 2048 });
		return { ms: Math.round(performance.now() - t), w: r.width, bands: run.lastNoiseRun.bands, workerMs: Math.round(run.lastNoiseRun.workerMs) };
	});
	await A.page.waitForTimeout(300);
	const genLong = await longRead(A);
	console.log(`  2048 simplex x6: ${gen.ms} ms in ${gen.bands} bands (slowest band ${gen.workerMs} ms); long tasks ${JSON.stringify(genLong.slice(0, 5))}`);
	h.check(gen.w === 2048 && (genLong[0] ?? 0) <= 100, `a 2048 fill never blocks the page > 100 ms (longest ${genLong[0] ?? 0} ms)`);
	// the editor's Apply over a 2048 image (the noise, the commit and the redraw)
	const big = await S(A, async () => {
		const s = window.__tp.test.v1;
		const r = await s.noiseRun.renderNoise({ kind: 'value' }, { width: 2048, height: 2048 });
		const blob = await s.imageEditor.encodeImage(r, { type: 'image/png' });
		const rec = await s.explorer.addItemFromBytes(await blob.arrayBuffer(), 'big2048.png', null, { type: 'image/png' });
		s.imageEditor.openImageEditor(rec.id, { panel: 'noise', noise: { kind: 'perlin', blend: 'overlay', opacity: 0.6 } });
		return rec.id;
	});
	await A.page.locator('#image-noise-apply').waitFor({ timeout: 15000 });
	await until(async () => /2048 × 2048/.test((await A.page.locator('#image-editor-size').textContent()) ?? ''), 15000);
	await until(async () => (await A.page.locator('#image-editor-noise-badge').count()) === 1, 15000);
	await A.page.waitForTimeout(500);
	await longStart(A);
	await A.page.locator('#image-noise-apply').click();
	await until(async () => !(await A.page.locator('#image-editor-undo').isDisabled()), 30000);
	await A.page.waitForTimeout(500);
	const applyLong = await longRead(A);
	console.log(`  editor Apply at 2048: long tasks ${JSON.stringify(applyLong.slice(0, 5))}`);
	h.check(!(await A.page.locator('#image-editor-undo').isDisabled()), 'the 2048 Apply landed');
	h.check((applyLong[0] ?? 0) <= 100, `the editor's 2048 Apply never blocks the page > 100 ms (longest ${applyLong[0] ?? 0} ms)`);
	void big;
	await S(A, () => window.__tp.test.v1.imageEditor.closeImageEditor());
	await A.page.locator('#confirm-dialog-close').click({ timeout: 4000 }).catch(() => {});

	// ---- §8 the agent ------------------------------------------------------------------------------------
	const ag = await S(A, (id) => window.__tp.test.v1.aiTools.executeAiTool('set_material', { objects: [id], maps: { normal: { noise: { kind: 'worley', scale: 5, seed: 3, size: 256 } } } }), box);
	h.check(!ag?.error && Array.isArray(ag?.noise) && ag.noise.length === 1, 'set_material maps.normal.noise works: ' + JSON.stringify(ag).slice(0, 300));
	const w = ag?.noise?.[0] ?? {};
	h.check(w.map === 'normal' && w.kind === 'worley' && w.output === 'normal' && w.seed === 3 && w.size === 256 && !!w.hash, 'and says what it wrote (map, kind, output, seed, size, hash)');
	await until(async () => !!(await texSum(A, box, 'normalMap')), 10000);
	h.check((await texSum(A, box, 'normalMap'))?.w === 256, 'the box has the 256 normal map');
	await until(async () => !!(await texSum(B, box, 'normalMap')), 15000);
	h.check((await texSum(B, box, 'normalMap'))?.hash === (await texSum(A, box, 'normalMap'))?.hash, 'so does the peer');
	const bad = await S(A, (id) => window.__tp.test.v1.aiTools.executeAiTool('set_material', { objects: [id], noise: { kind: 'fractal' } }), box);
	h.check(/perlin, simplex, worley, value/.test(String(bad?.error ?? '')), 'a wrong kind is refused, naming the kinds: ' + String(bad?.error).slice(0, 120));

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 3))})`);
	await h.finish(browser);
});
