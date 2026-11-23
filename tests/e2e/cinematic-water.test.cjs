// 100 C2-3 — WATER IN THE CINEMATIC VIEW, end to end, on the four template scenes that have water.
//
// Per scene (a fresh page each, bounded): load it, wait for the water's programs, hold time (flows paused, the water
// clock frozen, module frame tasks parked) and photograph the standard view and the Cinematic view from the scene's
// own camera, each with the water shown and hidden. The water's FOOTPRINT (what changes when it is hidden) must agree
// between the two views, and inside it the colour must be as close to the standard view as the rest of the image is
// (the view lights the scene itself: GI, AO, bloom). Then: no errors, every surface drawn through TSL, "Water" gone
// from the "Not shown" chip, and leaving the view puts every water material and placeholder back (zero change).
// On the first scene (aquarium): the camera under the surface in both views, and the frame cost with the water drawn
// vs the C2-2 view (debugCinematicNoWater: the plain stand-in) at Standard quality.
//
// GPU: real WebGPU wants the Deck (desk "local") or the PC through a remote slot; SwiftShader passes with
// debugCinematicSoftware=1 (slow, same code). Evidence: test-results/100-cover-water/<scene>/ (sheets + numbers).
//
//   APP_URL=https://theprototype.app:7042/ E2E_PC= e2e-slot --local --dev $PWD 7042 -- env E2E_GPU=1 node tests/e2e/cinematic-water.test.cjs
//   PC real Chrome: cd ~/.code/lanes-30/100-light/lab && TREE=<tree with build/> PORT=7044 node run-pc.mjs --name water-pc \
//     --driver tests/e2e/cinematic-water.test.cjs --minutes 40
//   WATER_SCENES=aquarium  (a subset)   WATER_QUALITY=basic|standard|high (default standard)
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const ARGS = [...(process.env.E2E_GPU === '1' ? h.GPU_ARGS : []), '--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const STORAGE = { debugCinematicSoftware: '1' };
const OUT = process.env.WATER_OUT || process.env.OUT || path.join(__dirname, '..', '..', 'test-results', '100-cover-water');
// CDP=<port>: drive an already running Chrome (the device lab's real Chrome on the PC, run-pc.mjs --driver this file):
// the remote slots compile WebGPU shaders with FXC (no DXC in Playwright's Windows build), where the GI does not compile
const CDP = process.env.CDP || '';
const SCENES = (process.env.WATER_SCENES || 'aquarium,pool-party,island-ocean,water-works').split(',').filter(Boolean);
// no template asks for the planar mirror (every preset reflects the sky / env), so on this scene the suite turns it on
// in the page — the flag the runtime sets from a look with Reflection: Planar — after the shots that compare the views
const PLANAR_ON = process.env.WATER_PLANAR_SCENE || 'pool-party';
const QUALITY = process.env.WATER_QUALITY || 'standard';
const SCENE_MS = Number(process.env.WATER_SCENE_MS || 420000);
const W = 480;
const H = 270;

/** @param {any} page */
const state = (page) => page.evaluate(() => { let s; window.__tp.test.v1.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s; });
/** @param {any} page */
const debug = (page, reset = false) => page.evaluate(async (r) => (await window.__tp.test.v1.cinematicState.cinematicView()).cinematicDebug(r), reset);
/** @param {any} page @param {string} want @param {string} label */
const waitMode = (page, want, label, ms = 120000) => h.eventually(async () => (await state(page)).mode, (m) => m === want, label, ms);

/** in-page: capture (GL or view) into window.__wShots[name] (W x H RGBA) and return a PNG @param {any} page @param {string} name @param {boolean} view */
// WATER_KNOBS=1 (diagnosis, off by default): sample a few pixels under the surface in one view with water terms switched
// off one at a time (the same uniform objects drive both views), to say which term the two views disagree on
async function underKnobs(page, view) {
	return page.evaluate(async (view) => {
		const s = window.__tp.test.v1;
		const st = s.waterRuntime.waterViewState(null);
		const U = st.entries[0].uniforms;
		const keys = ['uReflectivity', 'uFogDistance', 'uEnvOn', 'uOpacity', 'uClarity', 'uFresnel', 'uRefraction'];
		const saved = Object.fromEntries(keys.map((k) => [k, U[k]?.value]));
		const info = { ...saved, colours: ['uSkyTop', 'uSkyHorizon', 'uSkyBottom', 'uFogColor', 'uDeep', 'uShallow'].map((k) => U[k]?.value?.toArray?.().map((v) => +v.toFixed(3))) };
		const ss = [];
		const pts = [[1300, 120], [200, 150], [870, 230], [720, 60], [1100, 450]];
		const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
		const sample = async () => {
			await frames();
			let url;
			if (view) url = await (await s.cinematicState.cinematicView()).grabCinematic();
			else {
				let r, sc, cam;
				s.globalRenderer.subscribe((v) => (r = v))();
				s.globalScene.subscribe((v) => (sc = v))();
				s.globalCamera.subscribe((v) => (cam = v))();
				r.render(sc, cam);
				url = r.domElement.toDataURL('image/png');
				ss.push(U.uSSActive?.value);
			}
			const img = new Image();
			img.src = url;
			await img.decode();
			const c = document.createElement('canvas');
			c.width = 1440;
			c.height = 900;
			const x = c.getContext('2d');
			x.drawImage(img, 0, 0, 1440, 900);
			return pts.map(([a, b]) => Array.from(x.getImageData(a, b, 1, 1).data.slice(0, 3)));
		};
		const out = { info, base: await sample() };
		U.uReflectivity.value = 0;
		out.noRefl = await sample();
		U.uReflectivity.value = saved.uReflectivity;
		U.uFogDistance.value = 1000;
		out.noFog = await sample();
		U.uFogDistance.value = saved.uFogDistance;
		out.after = await sample();
		let sc;
		s.globalScene.subscribe((v) => (sc = v))();
		const f = sc.fog;
		out.ssActive = ss;
		out.sceneFog = f ? { near: f.near, far: f.far, density: f.density, color: f.color?.getHexString?.() } : null;
		if (view) {
			// the twins with three's fog off (the standard view skips fog on its water under the surface)
			const tw = [];
			sc.traverse((o) => o.name === 'cinematic-water' && tw.push(o.material));
			out.twinFog = tw.map((m) => m.fog);
			for (const m of tw) { m.fog = false; m.needsUpdate = true; }
			out.noTwinFog = await sample();
			for (const m of tw) { m.fog = true; m.needsUpdate = true; }
			// each term drawn as the colour (through the output transform: read them as an ordering, not values)
			const T = (await s.cinematicState.cinematicView()).cinematicLiveForTest().T;
			out.sides = tw.map((m) => m.side);
			out.terms = {};
			for (const k of ['F', 'NdV', 'front', 'tir', 'refl', 'refr', 'trans', 'N', 'V']) {
				const saved = tw.map((m) => m.colorNode);
				for (const m of tw) {
					const n = m.userData.terms?.[k];
					if (!n) continue;
					m.colorNode = ['F', 'NdV', 'front', 'tir'].includes(k) ? T.vec3(n, n, n) : n;
					m.needsUpdate = true;
				}
				out.terms[k] = await sample();
				tw.forEach((m, i) => { m.colorNode = saved[i]; m.needsUpdate = true; });
			}
		}
		return out;
	}, view);
}

// WATER_KNOBS: the LINEAR scene colour the water refracts at those points (view: the scene pass; standard: the
// pre-pass, rendered the same way: no water, no hooks, into a float target)
async function sceneBehind(page, view) {
	return page.evaluate(async (view) => {
		const s = window.__tp.test.v1;
		const THREE = s.THREE;
		const pts = [[1300, 120], [200, 150], [870, 230], [720, 60], [1100, 450]];
		const rd = (a) => Array.from(a.slice(0, 3)).map((v) => +(a instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat(v) : v).toFixed(3));
		if (view) {
			const lv = (await s.cinematicState.cinematicView()).cinematicLiveForTest();
			const rt = lv.built.nodes.scenePass.renderTarget;
			const out = [];
			for (const [a, b] of pts) out.push(rd(await lv.r.readRenderTargetPixelsAsync(rt, Math.floor((a * rt.width) / 1440), Math.floor((b * rt.height) / 900), 1, 1, 0)));
			return { size: [rt.width, rt.height], px: out };
		}
		let r, sc, cam;
		s.globalRenderer.subscribe((v) => (r = v))();
		s.globalScene.subscribe((v) => (sc = v))();
		s.globalCamera.subscribe((v) => (cam = v))();
		const sz = r.getDrawingBufferSize(new THREE.Vector2());
		const rt = new THREE.WebGLRenderTarget(sz.x, sz.y, { type: THREE.FloatType });
		const hid = [];
		sc.traverse((o) => (o.userData?.water || o.userData?.__waterVisual) && o.visible && hid.push(o));
		for (const o of hid) o.visible = false;
		const hooks = [sc.onBeforeRender, sc.onAfterRender];
		sc.onBeforeRender = sc.onAfterRender = () => {};
		const prev = r.getRenderTarget();
		r.setRenderTarget(rt);
		r.render(sc, cam);
		const out = [];
		for (const [a, b] of pts) {
			const buf = new Float32Array(4);
			r.readRenderTargetPixels(rt, Math.floor((a * sz.x) / 1440), sz.y - 1 - Math.floor((b * sz.y) / 900), 1, 1, buf);
			out.push(rd(buf));
		}
		r.setRenderTarget(prev);
		[sc.onBeforeRender, sc.onAfterRender] = hooks;
		for (const o of hid) o.visible = true;
		rt.dispose();
		return { size: [sz.x, sz.y], fog: !!sc.fog, bg: sc.background?.isColor ? sc.background.getHexString() : typeof sc.background, px: out };
	}, view);
}

const grab = (page, name, view) =>
	page.evaluate(
		async ({ name, view, W, H }) => {
			const s = window.__tp.test.v1;
			const c = document.createElement('canvas');
			c.width = W;
			c.height = H;
			const x = c.getContext('2d');
			if (view) {
				const v = await s.cinematicState.cinematicView();
				for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r));
				const url = await v.grabCinematic();
				const img = new Image();
				img.src = url;
				await img.decode();
				x.drawImage(img, 0, 0, W, H);
			} else {
				let r, sc, cam;
				s.globalRenderer.subscribe((v) => (r = v))();
				s.globalScene.subscribe((v) => (sc = v))();
				s.globalCamera.subscribe((v) => (cam = v))();
				r.render(sc, cam);
				r.render(sc, cam);
				x.drawImage(r.domElement, 0, 0, W, H);
			}
			window.__wShots = window.__wShots || {};
			window.__wShots[name] = x.getImageData(0, 0, W, H).data;
			return c.toDataURL('image/png');
		},
		{ name, view, W, H }
	);

/** in-page: show / hide every water object (the runtime hides its surfaces with them) @param {any} page @param {boolean} on */
const showWater = (page, on) =>
	page.evaluate(async (on) => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		let n = 0;
		g.traverse((o) => {
			if (o.userData?.water) {
				o.visible = on;
				n++;
			}
		});
		// the runtime follows visibility on its next tick
		for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
		return n;
	}, on);

/** in-page: the water's footprint in both views and the colour inside it @param {any} page */
const compare = (page) =>
	page.evaluate(
		({ W, H }) => {
			const S = window.__wShots;
			const diff = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
			const mask = (a, b) => {
				const m = new Uint8Array(W * H);
				for (let i = 0, j = 0; i < a.length; i += 4, j++) m[j] = diff(a, b, i) > 36 ? 1 : 0;
				return m;
			};
			const g = mask(S['gl:all'], S['gl:-water']);
			const v = mask(S['view:all'], S['view:-water']);
			// the noise floor of each view (two shots of one held moment) is nobody's footprint
			const ng = mask(S['gl:all'], S['gl:again']);
			const nv = mask(S['view:all'], S['view:again']);
			let noiseG = 0, noiseV = 0;
			for (let j = 0; j < W * H; j++) {
				noiseG += ng[j];
				noiseV += nv[j];
				if (ng[j]) g[j] = 0;
				if (nv[j]) v[j] = 0;
			}
			// an opening (3x3 erode, then dilate), the same for both views: hiding the water moves the view's TRAA and
			// GI by a pixel along every edge in the frame, which would read as "water" on a scene with little of it
			const open = (m) => {
				const e = new Uint8Array(W * H);
				for (let y = 1; y < H - 1; y++)
					for (let x = 1; x < W - 1; x++) {
						let all = 1;
						for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!m[(y + dy) * W + x + dx]) { all = 0; break; }
						e[y * W + x] = all;
					}
				const o = new Uint8Array(W * H);
				for (let y = 1; y < H - 1; y++)
					for (let x = 1; x < W - 1; x++) {
						let any = 0;
						for (let dy = -1; dy <= 1 && !any; dy++) for (let dx = -1; dx <= 1; dx++) if (e[(y + dy) * W + x + dx]) { any = 1; break; }
						o[y * W + x] = any;
					}
				return o;
			};
			g.set(open(g));
			v.set(open(v));
			let ga = 0, va = 0, both = 0, gx = 0, gy = 0, vx = 0, vy = 0;
			// mean |gl - view| per channel inside the shared footprint, and on the pixels neither view counts as water
			let inSum = 0, inN = 0, outSum = 0, outN = 0, lumG = 0, lumV = 0;
			const A = S['gl:all'], B = S['view:all'];
			const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
			for (let j = 0, i = 0; j < W * H; j++, i += 4) {
				if (g[j]) { ga++; gx += j % W; gy += (j / W) | 0; }
				if (v[j]) { va++; vx += j % W; vy += (j / W) | 0; }
				if (g[j] && v[j]) {
					both++;
					inSum += diff(A, B, i) / 3;
					inN++;
					lumG += lum(A, i);
					lumV += lum(B, i);
				} else if (!g[j] && !v[j]) {
					outSum += diff(A, B, i) / 3;
					outN++;
				}
			}
			// threshold-free: hiding the water should change both views by the same amount (signed, per channel), over
			// the union of the two footprints — what decides faint, shallow water whose pixels sit near the mask threshold
			const GA = S['gl:all'], GD = S['gl:-water'], VA = S['view:all'], VD = S['view:-water'];
			let agreeSum = 0, glChange = 0, un = 0;
			for (let j = 0, i = 0; j < W * H; j++, i += 4) {
				if (!g[j] && !v[j]) continue;
				un++;
				for (let k = 0; k < 3; k++) {
					const dg = GA[i + k] - GD[i + k];
					const dv = VA[i + k] - VD[i + k];
					agreeSum += Math.abs(dg - dv) / 3;
					glChange += Math.abs(dg) / 3;
				}
			}
			const mc = document.createElement('canvas');
			mc.width = W;
			mc.height = H;
			const x = mc.getContext('2d');
			const img = x.createImageData(W, H);
			for (let j = 0; j < W * H; j++) {
				img.data[j * 4] = g[j] * 255;
				img.data[j * 4 + 1] = v[j] * 255;
				img.data[j * 4 + 2] = ng[j] || nv[j] ? 160 : 0;
				img.data[j * 4 + 3] = 255;
			}
			x.putImageData(img, 0, 0);
			const c = (sx, sy, n) => (n ? [Math.round(sx / n), Math.round(sy / n)] : null);
			return {
				maskUrl: mc.toDataURL('image/png'),
				gl: ga,
				view: va,
				overlapOfGl: ga ? +(both / ga).toFixed(2) : 0,
				overlapOfView: va ? +(both / va).toFixed(2) : 0,
				glCentre: c(gx, gy, ga),
				viewCentre: c(vx, vy, va),
				waterDelta: inN ? +(inSum / inN).toFixed(1) : null,
				restDelta: outN ? +(outSum / outN).toFixed(1) : null,
				waterLuma: inN ? [+(lumG / inN).toFixed(1), +(lumV / inN).toFixed(1)] : null,
				changeGap: un ? +(agreeSum / un).toFixed(1) : null,
				changeGl: un ? +(glChange / un).toFixed(1) : null,
				noise: [noiseG, noiseV]
			};
		},
		{ W, H }
	);

/** GPU-bound frame cost of the view (30 frames back to back, timed to the queue), rAF numbers beside it @param {any} page */
const cost = async (page) => {
	await debug(page, true);
	await page.waitForTimeout(3000);
	const d = await debug(page);
	const bound = await page.evaluate(async () => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		const g = v.cinematicLiveForTest();
		const q = g.r.backend.device.queue;
		const once = async () => {
			const t0 = performance.now();
			for (let i = 0; i < 30; i++) {
				g.water?.scan();
				g.water?.beforeRender();
				g.built.render();
				g.water?.afterRender();
			}
			await q.onSubmittedWorkDone();
			return (performance.now() - t0) / 30;
		};
		await once();
		const runs = [await once(), await once(), await once()].sort((a, b) => a - b);
		return runs[1];
	});
	return { n: d.frames.n, median: +d.frames.median.toFixed(2), p95: +d.frames.p95.toFixed(2), bound: +bound.toFixed(2), scanMs: +(d.water?.scanMs ?? 0).toFixed(3), quality: d.quality };
};

/** @type {any[]} */
const entries = [];
/** turn the view on / off; ON is timed (a slow first compile — FXC on a Windows host — shows as a number, not a hang)
 * @param {any} page @param {string} want */
const toggle = async (page, want) => {
	const t0 = Date.now();
	await page.click('#cinematic-toggle');
	if (want !== 'on') return waitMode(page, want, `the view went ${want}`);
	let mode = '';
	let started = false;
	const seen = [];
	while (Date.now() - t0 < 600000) {
		mode = (await state(page)).mode;
		if (seen[seen.length - 1] !== mode) seen.push(mode);
		if (mode !== 'off') started = true;
		if (mode === 'on' || mode === 'unavailable' || (started && mode === 'off') || (!started && Date.now() - t0 > 10000)) break;
		await page.waitForTimeout(500);
	}
	const s = Math.round((Date.now() - t0) / 1000);
	const d = await debug(page).catch(() => null);
	const last = d?.switches?.filter((/** @type {any} */ x) => x.dir === 'on').pop();
	entries.push({ s, mode, ms: last?.ms });
	h.check(mode === 'on' && s <= 120, `the view went on in ${s} s (${seen.join(' -> ')}; steps ${JSON.stringify(last?.ms ?? null)}${mode === 'on' ? '' : '; errors ' + JSON.stringify(d?.errors ?? null).slice(0, 400)})`);
};

const png = (url) => Buffer.from(url.split(',')[1], 'base64');

/** two PNGs side by side @param {any} page @param {string[]} urls */
const sideBySide = (page, urls) =>
	page.evaluate(
		async ({ urls, W, H }) => {
			const c = document.createElement('canvas');
			c.width = W * urls.length + 8 * (urls.length - 1);
			c.height = H;
			const x = c.getContext('2d');
			x.fillStyle = '#111';
			x.fillRect(0, 0, c.width, c.height);
			for (const [i, url] of urls.entries()) {
				const img = new Image();
				img.src = url;
				await img.decode();
				x.drawImage(img, i * (W + 8), 0, W, H);
			}
			return c.toDataURL('image/png');
		},
		{ urls, W, H }
	);

/** @type {Record<string, any>} */
const summary = {};

/** @param {any} browser @param {string} slug @param {boolean} first */
async function oneScene(browser, slug, first) {
	const out = path.join(OUT, slug);
	fs.mkdirSync(out, { recursive: true });
	const row = (summary[slug] = { slug });
	const P = await h.setupPage(browser, slug, { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
	const page = P.page;
	try {
		if (!(await page.evaluate(() => !!navigator.gpu))) return h.check(true, `${slug}: SKIPPED, this browser has no WebGPU`);
		if (!(await page.evaluate(() => window.__tp.test.v1.cinematicState.probeCinematic()))) return h.check(true, `${slug}: SKIPPED, the view is not offered here (${(await state(page)).why})`);
		await page.evaluate((q) => window.__tp.test.v1.cinematicState.setCinematicQuality(q), QUALITY);

		// ---- 0. the scene, its water ready ------------------------------------------------------------------------
		const loaded = await page.evaluate(async (slug) => {
			const st = window.__tp.test.v1;
			st.sceneSwitch?.modulesOnOpen?.set('keep');
			await st.sceneTemplates.loadTemplatesIndex(true);
			const list = [];
			for (const k of ['templates', 'examples', 'games']) st.sceneTemplates[k]?.subscribe((v) => list.push(...(v || [])))();
			const entry = list.find((x) => x.slug === slug);
			if (!entry) return false;
			return !!(await st.sceneTemplates.loadRemoteScene(entry));
		}, slug);
		h.check(loaded, `${slug}: 0. the template loaded`);
		if (!loaded) return;
		/** @type {any} */
		let wd = null;
		await h.eventually(
			() => page.evaluate(() => window.__tp.test.v1.waterRuntime.waterDebug()).then((d) => (wd = d)),
			(d) => d.volumes > 0 && d.entries.every((e) => e.ready),
			`${slug}: the water's programs are ready`,
			90000
		);
		row.volumes = wd.volumes;
		row.shapes = wd.entries.map((e) => e.shape);
		row.tier = wd.tier;
		await page.waitForTimeout(4000);
		const held = await page.evaluate(() => {
			const s = window.__tp.test.v1;
			window.__parkedTasks = s.moduleSDK.moduleFrameTasks.splice(0);
			s.flowPaused.set({ paused: true, reason: 'cinematic-water: time held' });
			// a running sim keeps motors turning (water-works' scoop wheel): paused too
			s.physics?.simPaused?.set(true);
			s.waterRuntime.freezeWaterClock(s.waterRuntime.waterClock());
			// fluid tanks are a stand-in in the view by design (roadmap 100: "fluid tanks stay a stand-in"), and their
			// particles fill water-works' mill pond: out of both views, so the comparison is water against water
			let sc;
			s.globalScene.subscribe((x) => (sc = x))();
			let fluid = 0;
			sc.traverse((o) => {
				const ud = o.userData || {};
				if ((ud.fluid && typeof ud.fluid === 'object') || ud.fluidEmitter || o.name === 'Fluid (visual)') {
					o.visible = false;
					fluid++;
				}
			});
			return { drawn: s.waterRuntime.waterDebug().entries.filter((e) => e.visible).length, fluid };
		});
		row.fluidHidden = held.fluid;
		h.check(held.drawn > 0, `   ${slug}: time held, ${held.drawn} of ${wd.volumes} water volume(s) drawn (${row.shapes.join(', ')}; tier ${wd.tier}${held.fluid ? `; ${held.fluid} fluid object(s) hidden in both views` : ''})`);

		// ---- 1. the standard view ---------------------------------------------------------------------------------
		const sheet = { gl: await grab(page, 'gl:all', false) };
		await page.waitForTimeout(500);
		await grab(page, 'gl:again', false);
		await showWater(page, false);
		sheet.glDry = await grab(page, 'gl:-water', false);
		await showWater(page, true);

		// ---- 2. the Cinematic view --------------------------------------------------------------------------------
		await toggle(page, 'on');
		const d0 = await debug(page);
		row.quality = d0.quality;
		row.water = d0.water;
		const live = await page.evaluate(() => window.__tp.test.v1.waterRuntime.waterDebug().entries);
		const surfaces = live.filter((/** @type {any} */ e) => e.visible).length;
		const bodies = live.filter((/** @type {any} */ e) => e.visible && e.body).length;
		h.check(d0.errors.length === 0, `${slug}: 2. the view is on (${d0.quality}), no errors (${JSON.stringify(d0.errors).slice(0, 400)})`);
		h.check(!!d0.water && d0.water.surfaces === surfaces && d0.water.bodies === bodies && !d0.water.errors.length, `   ${slug}: every surface and tank body drawn through TSL (${JSON.stringify(d0.water)}; want ${surfaces} surfaces, ${bodies} bodies)`);
		h.check(d0.water?.planar === 0, `   ${slug}: no planar mirror asked, none drawn (${d0.water?.planar})`);
		const chip = (await state(page)).notShown;
		row.chip = chip;
		h.check(!/Water/.test(chip), `   ${slug}: "Water" is not in the "Not shown" chip ("${chip}")`);
		sheet.view = await grab(page, 'view:all', true);
		await grab(page, 'view:again', true);
		await showWater(page, false);
		sheet.viewDry = await grab(page, 'view:-water', true);
		await showWater(page, true);
		await grab(page, 'view:all', true);

		// ---- 3. the water agrees ----------------------------------------------------------------------------------
		const r = await compare(page);
		fs.writeFileSync(path.join(out, 'mask-water.png'), png(r.maskUrl));
		delete r.maskUrl;
		row.compare = r;
		const near = r.glCentre && r.viewCentre ? Math.hypot(r.glCentre[0] - r.viewCentre[0], r.glCentre[1] - r.viewCentre[1]) : 999;
		// The view draws water wherever the standard view does (>= 0.7 of the standard footprint) and no stray sheet of
		// it elsewhere (its footprint <= 2x): the view relights the scene with the water hidden too (GI, SSR, bloom), so
		// its own footprint runs larger, and "shared of view" is reported, not judged. FAINT water (hiding it changes
		// the standard view by < 20 per channel: a shallow clear pond) sits at the mask threshold in both views: its
		// footprint is reported and the colour check below decides.
		void near;
		const faint = (r.changeGl ?? 0) < 20;
		const placed = r.overlapOfGl >= 0.7 && r.view <= r.gl * 2;
		h.check(r.gl > 200 && (placed || faint), `${slug}: 3. the view draws the water where the standard view does (px ${r.gl} / ${r.view}, shared ${r.overlapOfGl} of gl / ${r.overlapOfView} of view, centres ${JSON.stringify(r.glCentre)} vs ${JSON.stringify(r.viewCentre)}; the water changes the standard view by ${r.changeGl} per channel${faint ? ': FAINT, judged by colour' : ''})`);
		// The view lights the scene itself (GI, AO, bloom, its own tone path), so its pixels differ from the standard
		// view everywhere; the water must not differ by more than that plus WATER_TOL (mean |delta| per channel, 0-255)
		const tol = Number(process.env.WATER_TOL || 18);
		h.check(r.waterDelta != null && r.waterDelta <= (r.restDelta ?? 0) + tol, `   ${slug}: the water's colour matches as well as the rest of the image (mean |delta| water ${r.waterDelta}, rest ${r.restDelta}, tolerance rest + ${tol}; water luma ${JSON.stringify(r.waterLuma)} standard / Cinematic)`);

		// ---- 3b. the planar mirror (Reflection: Planar) -----------------------------------------------------------
		if (slug === PLANAR_ON) {
			const set = (on) =>
				page.evaluate((on) => {
					const s = window.__tp.test.v1;
					let cam;
					s.globalCamera.subscribe((x) => (cam = x))();
					const es = s.waterRuntime.waterViewState(cam).entries;
					for (const e of es) e.wantsPlanar = on;
					return es.length;
				}, on);
			await set(true);
			await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
			const dp = await debug(page);
			sheet.viewPlanar = await grab(page, 'view:planar', true);
			const moved = await page.evaluate(({ W, H }) => {
				const a = window.__wShots['view:all'], b = window.__wShots['view:planar'], g = window.__wShots['view:-water'];
				let n = 0, inW = 0;
				for (let i = 0; i < a.length; i += 4) {
					const w = Math.abs(a[i] - g[i]) + Math.abs(a[i + 1] - g[i + 1]) + Math.abs(a[i + 2] - g[i + 2]) > 36;
					if (!w) continue;
					inW++;
					if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
				}
				return { changed: n, water: inW };
			}, { W, H });
			await set(false);
			await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
			const dq = await debug(page);
			row.planar = { on: dp.water, off: dq.water, moved };
			h.check(dp.water?.planar === 1 && dp.errors.length === 0 && moved.changed > 0 && dq.water?.planar === 0, `${slug}: 3b. Reflection: Planar draws one mirror (TSL reflector) and changes the water (${moved.changed} of ${moved.water} water px), off again after (${JSON.stringify({ on: dp.water?.planar, off: dq.water?.planar, errors: dp.errors.length })})`);
			fs.writeFileSync(path.join(out, '07-sheet-planar.png'), png(await sideBySide(page, [sheet.view, sheet.viewPlanar])));
		}

		// ---- 4. under the surface (first scene) -------------------------------------------------------------------
		if (first) {
			const placed = await page.evaluate(() => {
				const s = window.__tp.test.v1;
				let g, cam;
				s.objectsGroup.subscribe((x) => (g = x))();
				s.globalCamera.subscribe((x) => (cam = x))();
				let w = null;
				g.traverse((o) => {
					if (!w && o.userData?.water && o.isMesh) w = o;
				});
				if (!w) return null;
				w.updateMatrixWorld(true);
				w.geometry.computeBoundingBox();
				const b = w.geometry.boundingBox.clone().applyMatrix4(w.matrixWorld);
				const c = b.getCenter(cam.position.clone());
				window.__camSaved = { p: cam.position.clone(), q: cam.quaternion.clone() };
				// inside, a third of the way up, looking along the tank's long side
				const lx = b.max.x - b.min.x, lz = b.max.z - b.min.z;
				cam.position.set(c.x - (lx >= lz ? lx * 0.3 : 0), b.min.y + (b.max.y - b.min.y) * 0.35, c.z - (lz > lx ? lz * 0.3 : 0));
				cam.lookAt(c.x + (lx >= lz ? lx : 0), b.min.y + (b.max.y - b.min.y) * 0.35, c.z + (lz > lx ? lz : 0));
				cam.updateMatrixWorld();
				window.__camUnder = { p: cam.position.clone(), q: cam.quaternion.clone() };
				return [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(2));
			});
			for (let i = 0; i < 10; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
			const du = await debug(page);
			sheet.viewUnder = await grab(page, 'view:under', true);
			if (process.env.WATER_KNOBS) console.log('KNOBS view ' + JSON.stringify(await underKnobs(page, true)) + '\nBEHIND view ' + JSON.stringify(await sceneBehind(page, true)));
			fs.writeFileSync(path.join(out, '05-cinematic-under-full.png'), png(await page.evaluate(async () => (await window.__tp.test.v1.cinematicState.cinematicView()).grabCinematic())));
			h.check(!!placed && du.water?.underwater === true && du.errors.length === 0, `${slug}: 4. camera under the surface at ${JSON.stringify(placed)}: the view knows (${JSON.stringify(du.water)})`);
			row.underwater = { at: placed, view: du.water };
		}

		// ---- 5. frame cost: the water drawn vs the C2-2 view (the plain stand-in) -------------------------------
		if (first) {
			await page.evaluate(() => {
				const s = window.__tp.test.v1;
				let cam;
				s.globalCamera.subscribe((x) => (cam = x))();
				if (window.__camSaved) {
					cam.position.copy(window.__camSaved.p);
					cam.quaternion.copy(window.__camSaved.q);
					cam.updateMatrixWorld();
				}
			});
			const withWater = await cost(page);
			await showWater(page, false);
			const dry = await cost(page);
			await showWater(page, true);
			await toggle(page, 'off');
			await page.evaluate(() => localStorage.setItem('debugCinematicNoWater', '1'));
			await toggle(page, 'on');
			const ds = await debug(page);
			const standIn = await cost(page);
			const chipS = (await state(page)).notShown;
			await toggle(page, 'off');
			await page.evaluate(() => localStorage.removeItem('debugCinematicNoWater'));
			await toggle(page, 'on');
			const factor = standIn.bound > 0 ? +(withWater.bound / standIn.bound).toFixed(2) : null;
			const adapter = d0.adapter ? `${d0.adapter.vendor} ${d0.adapter.architecture} ${d0.adapter.description}`.trim() : 'unknown';
			row.cost = { adapter, withWater, dry, standIn, factor };
			h.check(withWater.n > 20 && withWater.bound > 0 && !ds.water && /Water/.test(chipS), `${slug}: 5. frame cost (${adapter}, ${withWater.quality}): GPU-bound ${withWater.bound} ms with the water drawn, ${standIn.bound} ms in the C2-2 view (stand-in, chip "${chipS}"), ${dry.bound} ms with no water; factor ${factor}; rAF median ${withWater.median} / ${standIn.median} ms; water scan ${withWater.scanMs} ms`);
			if (factor != null && factor > 1.5) h.check(true, `   ${slug}: NOTE the factor is over 1.5x (report it)`);
		}

		// ---- 6. out of the view: every water material and placeholder as it was ----------------------------------
		await toggle(page, 'off');
		const back = await page.evaluate(() => {
			const s = window.__tp.test.v1;
			let g, sc;
			s.objectsGroup.subscribe((x) => (g = x))();
			s.globalScene.subscribe((x) => (sc = x))();
			let twins = 0, hiddenWater = 0, placeholders = 0, hiddenPlaceholders = 0;
			sc.traverse((o) => {
				if (o.name === 'cinematic-water') twins++;
				if (/^water-(surface|body|underwater)$/.test(o.material?.name ?? '') && o.material.visible === false) hiddenWater++;
			});
			g.traverse((o) => {
				if (o.userData?.water && o.isMesh) {
					placeholders++;
					if (o.material?.name === 'cinematic-water-hidden' || o.material?.isNodeMaterial) hiddenPlaceholders++;
				}
			});
			return { twins, hiddenWater, placeholders, hiddenPlaceholders };
		});
		h.check(back.twins === 0 && back.hiddenWater === 0 && back.hiddenPlaceholders === 0, `${slug}: 6. off again: no twins, every water material visible, every placeholder its own (${JSON.stringify(back)})`);
		await page.waitForTimeout(600);
		sheet.after = await grab(page, 'gl:after', false);
		const zero = await page.evaluate(({ W, H }) => {
			const a = window.__wShots['gl:all'], b = window.__wShots['gl:after'];
			let n = 0;
			for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) n++;
			return n;
		}, { W, H });
		const noise = row.compare?.noise?.[0] ?? 0;
		// a view left behind (a twin, a hidden material, a swapped placeholder) changes most of the water's footprint;
		// what moves on its own between the two shots (a wandering fish: the PC builds keep it swimming) is a few px
		const limit = Math.max(60, noise * 3, Math.round((row.compare?.gl ?? 0) * 0.1));
		row.zeroChange = { changed: zero, noise, limit };
		h.check(zero <= limit, `   ${slug}: the standard view after the trip is the standard view before it (${zero} px changed; limit ${limit} = max(noise floor ${noise} x 3, 10 % of the water's ${row.compare?.gl ?? 0} px))`);
		// the standard view from the same spot under the surface, for the sheet and the mean colour
		if (first && sheet.viewUnder) {
			const glUnder = await page.evaluate(() => {
				const s = window.__tp.test.v1;
				let cam;
				s.globalCamera.subscribe((x) => (cam = x))();
				cam.position.copy(window.__camUnder.p);
				cam.quaternion.copy(window.__camUnder.q);
				cam.updateMatrixWorld();
				return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(s.waterRuntime.waterDebug().underwater))));
			});
			sheet.glUnder = await grab(page, 'gl:under', false);
			if (process.env.WATER_KNOBS) console.log('KNOBS gl ' + JSON.stringify(await underKnobs(page, false)) + '\nBEHIND gl ' + JSON.stringify(await sceneBehind(page, false)));
			fs.writeFileSync(
				path.join(out, '05-standard-under-full.png'),
				png(await page.evaluate(() => {
					const s = window.__tp.test.v1;
					let r, sc, cam;
					s.globalRenderer.subscribe((v) => (r = v))();
					s.globalScene.subscribe((v) => (sc = v))();
					s.globalCamera.subscribe((v) => (cam = v))();
					r.render(sc, cam);
					return r.domElement.toDataURL('image/png');
				}))
			);
			const tone = await page.evaluate(({ W, H }) => {
				// medians, not means: the fish swim between the two shots, and a median ignores what covers < half the frame
				const median = (d) =>
					[0, 1, 2].map((k) => {
						const h = new Uint32Array(256);
						for (let i = k; i < d.length; i += 4) h[d[i]]++;
						let n = 0;
						for (let c = 0; c < 256; c++) if ((n += h[c]) >= (W * H) / 2) return c;
						return 255;
					});
				return { gl: median(window.__wShots['gl:under']), view: median(window.__wShots['view:under']) };
			}, { W, H });
			const dm = Math.max(...tone.gl.map((v, k) => Math.abs(v - tone.view[k])));
			row.underwater = { ...row.underwater, gl: glUnder, tone };
			h.check(!!glUnder && dm <= Number(process.env.WATER_UNDER_TOL || 40), `   ${slug}: under the surface both views are tinted alike (median RGB standard ${JSON.stringify(tone.gl)}, Cinematic ${JSON.stringify(tone.view)}; largest channel gap ${dm.toFixed(1)})`);
			fs.writeFileSync(path.join(out, '06-sheet-under.png'), png(await sideBySide(page, [sheet.glUnder, sheet.viewUnder])));
		}

		// ---- evidence ---------------------------------------------------------------------------------------------
		fs.writeFileSync(path.join(out, '01-standard.png'), png(sheet.gl));
		fs.writeFileSync(path.join(out, '02-cinematic.png'), png(sheet.view));
		fs.writeFileSync(path.join(out, '03-standard-after.png'), png(sheet.after));
		fs.writeFileSync(path.join(out, '00-sheet.png'), png(await sideBySide(page, [sheet.gl, sheet.view])));
		fs.writeFileSync(path.join(out, '04-sheet-no-water.png'), png(await sideBySide(page, [sheet.glDry, sheet.viewDry])));
		if (sheet.viewUnder) fs.writeFileSync(path.join(out, '05-cinematic-under.png'), png(sheet.viewUnder));
		fs.writeFileSync(path.join(out, 'numbers.json'), JSON.stringify(row, null, 2));
	} finally {
		await page.context().close().catch(() => {});
	}
}

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = CDP ? await require('playwright').chromium.connectOverCDP(`http://127.0.0.1:${CDP}`) : await h.launch({ args: ARGS });
	for (const [i, slug] of SCENES.entries()) {
		const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), SCENE_MS));
		const res = await Promise.race([oneScene(browser, slug, i === 0).then(() => 'done'), timer]);
		if (res === 'timeout') h.check(false, `${slug}: did not finish within ${SCENE_MS / 1000} s`);
	}
	fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ ...summary, entries }, null, 2));
	console.log('  evidence: ' + OUT);
	await h.finish(browser);
});
