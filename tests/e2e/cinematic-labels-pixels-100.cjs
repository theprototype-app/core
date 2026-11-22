// 100 C2-1 — THE TEXT PIXEL CHECK: troika text drawn by the standard view vs its canvas-texture quad in the Cinematic
// view, compared where the letters are. Each view's INK is the difference between a frame with the texts and one
// without (standard: the troika texts hidden; Cinematic: the quads stood down), so the lighting around them (GI on
// the scene, none on the unlit quads) cancels out. Per scenario: the ink masks' overlap (IoU), their centroid offset
// and their area ratio, plus the ink's mean colour in each view; side-by-side crops go to OUT.
//
// Scenarios: `templates/text-sign` (the one template with 3D text: flat + extruded) and an editor session with a note
// pin and a flat text sign (a second peer's name and the measure labels are checked by cinematic-view.test.cjs: the
// desktop measure labels are DOM, drawn over either view).
//
//   APP_URL=https://theprototype.app:7038/ E2E_GPU=1 E2E_PC= e2e-slot --local --wait 3600 --dev $PWD 7038 -- \
//     node tests/e2e/cinematic-labels-pixels-100.cjs
// env: OUT (test-results/100-cover-labels/pixels), IOU (0.5), SHIFT_PX (3: the ink box's edges, at 640 px wide), QUALITY (basic)
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const ARGS = [...(process.env.E2E_GPU === '1' ? h.GPU_ARGS : []), '--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const STORAGE = { debugCinematicSoftware: '1' };
const OUT = process.env.OUT || path.join(process.cwd(), 'test-results/100-cover-labels/pixels');
const IOU = Number(process.env.IOU || 0.5);
const SHIFT = Number(process.env.SHIFT_PX || 3);
const QUALITY = process.env.QUALITY || 'basic';
const W = 640;
const H = 360;
fs.mkdirSync(OUT, { recursive: true });

/** @param {any} page */
const mode = (page) => page.evaluate(() => { let s; window.__tp.test.v1.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s.mode; });

/** the ink of the standard view: a frame with the troika texts minus one without, both W x H RGBA @param {any} page */
const glInk = (page) =>
	page.evaluate(async ([w, hh]) => {
		const t = window.__tp.test.v1;
		let r, sc, c;
		t.globalRenderer.subscribe((x) => (r = x))();
		t.globalScene.subscribe((x) => (sc = x))();
		t.globalCamera.subscribe((x) => (c = x))();
		/** @type {any[]} */
		const texts = [];
		sc.traverse((/** @type {any} */ o) => typeof o.sync === 'function' && 'textRenderInfo' in o && o.visible && texts.push(o));
		const grab = () => {
			r.render(sc, c);
			const k = document.createElement('canvas');
			k.width = w;
			k.height = hh;
			const x = /** @type {CanvasRenderingContext2D} */ (k.getContext('2d'));
			x.drawImage(r.domElement, 0, 0, w, hh);
			return { data: Array.from(x.getImageData(0, 0, w, hh).data), url: k.toDataURL('image/png') };
		};
		// troika syncs in onBeforeRender: a few frames so every text is typeset
		for (let i = 0; i < 4; i++) {
			grab();
			await new Promise((res) => setTimeout(res, 150));
		}
		const on = grab();
		for (const o of texts) o.visible = false;
		const off = grab();
		for (const o of texts) o.visible = true;
		return { on, off, texts: texts.length };
	}, [W, H]);

/** the ink of the Cinematic view: a frame with the quads minus one without @param {any} page */
const gpuInk = (page) =>
	page.evaluate(async ([w, hh]) => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		const labels = v.cinematicLiveForTest()?.labels;
		const frames = (/** @type {number} */ n) => new Promise((res) => { const step = () => (n-- <= 0 ? res(undefined) : requestAnimationFrame(step)); step(); });
		const grab = async () => {
			const img = new Image();
			img.src = /** @type {string} */ (await v.grabCinematic());
			await img.decode();
			const k = document.createElement('canvas');
			k.width = w;
			k.height = hh;
			const x = /** @type {CanvasRenderingContext2D} */ (k.getContext('2d'));
			x.drawImage(img, 0, 0, w, hh);
			return { data: Array.from(x.getImageData(0, 0, w, hh).data), url: k.toDataURL('image/png') };
		};
		await frames(60);
		const on = await grab();
		labels.hideForTest(true);
		await frames(60);
		const off = await grab();
		labels.hideForTest(false);
		await frames(10);
		return { on, off, stats: labels.stats() };
	}, [W, H]);

/** the letters' CORE: a strong change only (the view's bloom halo and TRAA-softened edges stay out) @param {number[]} on @param {number[]} off */
function inkMask(on, off, thr = 150) {
	const m = new Uint8Array(W * H);
	for (let p = 0, i = 0; p < m.length; p++, i += 4) m[p] = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]) > thr ? 1 : 0;
	return m;
}
/** @param {Uint8Array} m @param {number[]} on */
function maskFacts(m, on) {
	let n = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0;
	for (let p = 0; p < m.length; p++) {
		if (!m[p]) continue;
		n++;
		sx += p % W;
		sy += Math.floor(p / W);
		r += on[p * 4];
		g += on[p * 4 + 1];
		b += on[p * 4 + 2];
	}
	let x0 = W, y0 = H, x1 = 0, y1 = 0;
	for (let p = 0; p < m.length; p++) if (m[p]) { const x = p % W, y = Math.floor(p / W); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
	return n ? { n, cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), rgb: [r / n, g / n, b / n].map(Math.round), box: [x0, y0, x1, y1] } : { n: 0, cx: 0, cy: 0, rgb: [0, 0, 0], box: null };
}
/** a mask grown by `d` px (TRAA and the SDF edge put the outline a pixel or so apart) @param {Uint8Array} m @param {number} d */
function dilate(m, d) {
	const out = new Uint8Array(m.length);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			if (!m[y * W + x]) continue;
			for (let yy = Math.max(0, y - d); yy <= Math.min(H - 1, y + d); yy++) for (let xx = Math.max(0, x - d); xx <= Math.min(W - 1, x + d); xx++) out[yy * W + xx] = 1;
		}
	return out;
}

/** compare the two views on the current scene @param {any} page @param {string} name */
async function compare(page, name) {
	// nothing selected: the gizmo and the outline would overlap the letters differently in each view
	await page.evaluate(() => window.__tp.test.v1.objectActions.selectObject(null));
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(false));
	await h.eventually(() => mode(page), (m) => m === 'off', name + ': standard view', 90000);
	await page.waitForTimeout(1500);
	const gl = await glInk(page);
	await page.evaluate(async (q) => {
		const s = window.__tp.test.v1.cinematicState;
		await s.setCinematicQuality(q);
		return s.setCinematic(true);
	}, QUALITY);
	await h.eventually(() => mode(page), (m) => m === 'on', name + ': Cinematic view', 90000);
	await page.waitForTimeout(2500);
	const gpu = await gpuInk(page);
	const a = inkMask(gl.on.data, gl.off.data);
	const b = inkMask(gpu.on.data, gpu.off.data);
	const fa = maskFacts(a, gl.on.data);
	const fb = maskFacts(b, gpu.on.data);
	const da = dilate(a, 2);
	const db = dilate(b, 2);
	let inter = 0, uni = 0;
	for (let p = 0; p < a.length; p++) {
		const x = da[p] && b[p] ? 1 : 0;
		const y = db[p] && a[p] ? 1 : 0;
		inter += x + y;
		uni += (a[p] || b[p]) ? 2 : 0;
	}
	const iou = uni ? inter / uni : 0;
	const shift = Math.hypot(fa.cx - fb.cx, fa.cy - fb.cy);
	const area = fa.n ? fb.n / fa.n : 0;
	const rgbDelta = Math.max(...fa.rgb.map((v, i) => Math.abs(v - fb.rgb[i])));
	for (const [k, v] of [['gl-on', gl.on.url], ['gpu-on', gpu.on.url]]) fs.writeFileSync(path.join(OUT, `${name}-${k}.png`), Buffer.from(String(v).split(',')[1], 'base64'));
	const facts = { name, texts: gl.texts, quads: gpu.stats?.quads, standard: fa, cinematic: fb, iou: +iou.toFixed(3), shiftPx: +shift.toFixed(2), boxEdgePx: fa.box && fb.box ? Math.max(...fa.box.map((v, i) => Math.abs(v - fb.box[i]))) : null, areaRatio: +area.toFixed(2), rgbDelta };
	fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(facts, null, 1));
	h.check(fa.n > 50 && fb.n > 50, `${name}: both views draw text ink (standard ${fa.n} px, Cinematic ${fb.n} px; ${gl.texts} texts, ${gpu.stats?.quads} quads)`);
	h.check(iou >= IOU, `   the letters land in the same place (overlap ${iou.toFixed(3)} >= ${IOU}, 2 px tolerance)`);
	// position and size = the ink's box (each edge within SHIFT px); the centroid and the area are reported: the canvas
	// letters come out a little heavier than troika's SDF edge, which moves the weighted centre without moving the text
	const edge = fa.box && fb.box ? Math.max(...fa.box.map((v, i) => Math.abs(v - fb.box[i]))) : Infinity;
	h.check(edge <= SHIFT && area > 0.6 && area < 1.6, `   same position and size (ink box ${JSON.stringify(fa.box)} vs ${JSON.stringify(fb.box)}: edges within ${edge} px <= ${SHIFT}; centroid ${shift.toFixed(2)} px apart, area x${area.toFixed(2)})`);
	h.check(rgbDelta <= 60, `   same colour (ink mean ${JSON.stringify(fa.rgb)} vs ${JSON.stringify(fb.rgb)}, max channel delta ${rgbDelta}; unlit quads, GI around them)`);
	return facts;
}

h.run(async () => {
	const browser = await h.launch({ args: ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } }, storage: STORAGE });
	const page = A.page;
	if (!(await page.evaluate(() => !!navigator.gpu)) || !(await page.evaluate(() => window.__tp.test.v1.cinematicState.probeCinematic()))) {
		h.check(true, 'SKIPPED: the Cinematic view is not offered in this browser');
		return h.finish(browser);
	}
	/** @type {any[]} */
	const all = [];

	// 1. templates/text-sign
	const loaded = await page.evaluate(async () => {
		const st = window.__tp.test.v1;
		await st.sceneTemplates.loadTemplatesIndex(true);
		let list;
		st.sceneTemplates.templates.subscribe((v) => (list = v))();
		const e = list.find((x) => x.slug === 'text-sign');
		return e ? !!(await st.sceneTemplates.loadRemoteScene(e)) : null;
	});
	if (loaded === null) h.check(true, 'SKIPPED text-sign: not in this deployment\'s templates index');
	else {
		await page.waitForTimeout(8000);
		all.push(await compare(page, 'text-sign'));
	}

	// 2. an editor session: a note pin and a flat text sign on two boxes
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematic(false));
	await h.eventually(() => mode(page), (m) => m === 'off', 'off for the editor scene', 90000);
	await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/clear all'));
	await page.waitForTimeout(1000);
	const made = await page.evaluate(() => {
		const s = window.__tp.test.v1;
		const a = s.addObjects.spawnAtPoint('/create Box 1 1 1', [0, 0.5, 0]);
		s.addObjects.spawnAtPoint('/create Box 1 1 1', [1.6, 0.5, 0]);
		const t = s.addObjects.spawnAtPoint('/create Text', [-0.5, 1.8, 0.8]);
		if (t) s.textPathEdit.setTextPathFor(t.uuid, { text: 'Note: check this', size: 0.4, color: '#ffcc66' });
		if (a) {
			s.annotationsHandler.addAnnotation(a.uuid);
			let cur;
			s.annotationsHandler.activeAnnotation.subscribe((v) => (cur = v))();
			if (cur?.draft) s.annotationsHandler.setAnnotation({ ...cur.draft, name: 'Pixel note', text: 'pin' });
		}
		return !!a && !!t;
	});
	await page.waitForTimeout(3000);
	// an editor label as PingMarkers / AvatarRig make one (white, dark outline, centred), from troika's own class
	const labelled = await page.evaluate(() => {
		let sc;
		window.__tp.test.v1.globalScene.subscribe((x) => (sc = x))();
		let Troika = null;
		sc.traverse((/** @type {any} */ o) => {
			if (!Troika && typeof o.sync === 'function' && 'textRenderInfo' in o) Troika = o.constructor;
		});
		if (!Troika) return false;
		const label = new Troika();
		label.name = 'pixel-check label';
		label.text = 'Alex (peer)';
		label.color = 'white';
		label.outlineColor = '#0b0e14';
		label.outlineWidth = 0.02;
		label.fontSize = 0.26;
		label.anchorX = 'center';
		label.anchorY = 'middle';
		label.position.set(1.6, 1.6, 0);
		sc.add(label);
		label.sync();
		return true;
	});
	h.check(made && labelled, `the editor scene: two boxes, a note pin (DOM on desktop), a text sign and an outlined editor label (${made}, ${labelled})`);
	await page.waitForTimeout(3000);
	all.push(await compare(page, 'editor-session'));

	fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(all, null, 1));
	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A)).slice(0, 300)})`);
	await h.finish(browser);
});
