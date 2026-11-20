// 100 C1 — THE FRAME COST TABLE (roadmap 100 C1 §7): Tavern / Castle courtyard / Product shot, the standard (WebGL)
// view against the Cinematic view at each quality step, plus a screenshot of each for the side-by-side sheets.
// Not a suite: a measurement driver for the device lab (PC) and a Deck slot. Frame ms = the interval between drawn
// frames, so run it with vsync off or every number reads as the display's refresh.
//
//   PC (real Chrome through the device lab, by day):
//     cd ~/.code/lanes-30/100-light/lab && TREE=<tree> PORT=7035 node run-pc.mjs --name frames-pc \
//       --driver tests/e2e/cinematic-frames-100.cjs --args "--disable-gpu-vsync --disable-frame-rate-limit" --minutes 40
//   Deck (its own Chromium, uncapped; alone in an --exclusive slot):
//     APP_URL=https://theprototype.app:7034/ e2e-slot --local --exclusive --wait 9000 --dev $PWD 7034 -- \
//       env DEVICE=deck node tests/e2e/cinematic-frames-100.cjs
//
// env: SCENES (tavern-interior,castle-courtyard,product-shot), QUALITIES (basic,standard,high), SAMPLE_MS (6000),
//      OUT (test-results/100-view/frames), DEVICE (pc with CDP, else deck), W x H (1920 x 1080 on a local launch)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.APP_URL || 'https://theprototype.app:7034/';
const CDP = process.env.CDP || '';
const DEVICE = process.env.DEVICE || (CDP ? 'pc' : 'deck');
const SCENES = (process.env.SCENES || 'tavern-interior,castle-courtyard,product-shot').split(',').filter(Boolean);
const QUALITIES = (process.env.QUALITIES || 'basic,standard,high').split(',').filter(Boolean);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 6000);
const W = Number(process.env.W || 1920), H = Number(process.env.H || 1080);
const OUT = process.env.OUT || path.join(process.cwd(), 'test-results/100-view/frames');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[frames]', ...a);
const result = { device: DEVICE, at: new Date().toISOString(), sampleMs: SAMPLE_MS, scenes: {} };
const save = () => fs.writeFileSync(path.join(OUT, `frames-${DEVICE}.json`), JSON.stringify(result, null, 1));

const q = (arr, p) => {
	if (!arr.length) return null;
	const s = [...arr].sort((a, b) => a - b);
	return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
};

/** WebGL: rAF-to-rAF intervals in the page for SAMPLE_MS (the app draws on every frame) */
const sampleWebGL = (page) =>
	page.evaluate(async (ms) => {
		const f = [];
		let last = 0;
		const end = performance.now() + ms;
		await new Promise((resolve) => {
			const tick = (t) => {
				if (last) f.push(t - last);
				last = t;
				if (t < end) requestAnimationFrame(tick);
				else resolve(null);
			};
			requestAnimationFrame(tick);
		});
		return f;
	}, SAMPLE_MS);

const st = (page) => page.evaluate(() => { let s; window.__stores.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s; });
const dbg = (page, reset) => page.evaluate(async (reset) => (await window.__stores.cinematicState.cinematicView()).cinematicDebug(reset), reset);

async function settle(page, ms = 4000) {
	let last = -1;
	for (let i = 0; i < 60; i++) {
		const n = await page.evaluate(() => {
			let g, c = 0;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			g?.traverse(() => c++);
			return c;
		});
		if (n === last && n > 0) break;
		last = n;
		await page.waitForTimeout(1500);
	}
	await page.waitForTimeout(ms);
	return last;
}

async function load(page, slug) {
	const one = () =>
		page.evaluate(async (slug) => {
			const s = window.__stores;
			s.sceneSwitch?.modulesOnOpen?.set('keep');
			await s.sceneTemplates.loadTemplatesIndex(true);
			let list;
			s.sceneTemplates.templates.subscribe((v) => (list = v))();
			const e = list.find((x) => x.slug === slug);
			if (!e) return 'no template ' + slug;
			const ok = await s.sceneTemplates.loadRemoteScene(e);
			return ok === true ? true : 'ret=' + String(ok);
		}, slug);
	let ok = await one();
	for (let i = 0; i < 2 && ok !== true; i++) {
		await page.keyboard.press('Escape').catch(() => {});
		await page.waitForTimeout(5000);
		ok = await one();
	}
	return { ok, objects: await settle(page) };
}

/** the camera the template set, pinned before every sample so each image is the same view */
const camPose = (page) => page.evaluate(() => { let c; window.__stores.globalCamera.subscribe((v) => (c = v))(); return { p: c.position.toArray(), q: c.quaternion.toArray() }; });
const pin = (page, pose) =>
	page.evaluate((pose) => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		c.position.fromArray(pose.p);
		c.quaternion.fromArray(pose.q);
		c.updateMatrixWorld(true);
	}, pose);

async function shot(page, name) {
	const file = path.join(OUT, `${DEVICE}-${name}.png`);
	await page.screenshot({ path: file });
	return path.basename(file);
}

async function runScene(page, slug) {
	const S = { load: await load(page, slug), rows: {} };
	result.scenes[slug] = S;
	log('load', slug, JSON.stringify(S.load));
	const pose = await camPose(page);
	await pin(page, pose);
	await page.waitForTimeout(1500);
	const wf = await sampleWebGL(page);
	S.rows.webgl = { n: wf.length, median: q(wf, 0.5), p95: q(wf, 0.95), luma: await glLuma(page), shot: await shot(page, `${slug}-webgl`) };
	log(slug, 'webgl', JSON.stringify(S.rows.webgl));
	save();
	for (const quality of QUALITIES) {
		const key = S.rows[quality] ? quality + '-' + Object.keys(S.rows).filter((k) => k.startsWith(quality)).length : quality;
		await page.evaluate((qq) => window.__stores.cinematicState.setCinematicQuality(qq), quality);
		await pin(page, pose);
		const on = await page.evaluate(() => window.__stores.cinematicState.setCinematic(true));
		const s0 = await st(page);
		if (s0.mode !== 'on') {
			S.rows[key] = { error: 'did not come on: ' + JSON.stringify({ on, mode: s0.mode, why: s0.why, error: s0.error }) };
			log(slug, key, S.rows[key].error);
			break;
		}
		await page.waitForTimeout(3000);
		await dbg(page, true);
		await page.waitForTimeout(SAMPLE_MS);
		const d = await dbg(page, false);
		const s1 = await st(page);
		const row = {
			n: d.frames.n,
			median: d.frames.median == null ? null : +d.frames.median.toFixed(2),
			p95: d.frames.p95 == null ? null : +d.frames.p95.toFixed(2),
			quality: s1.quality,
			dropped: s1.dropped,
			errors: d.errors.length,
			x: null,
			shot: await shot(page, `${slug}-${key}`)
		};
		row.x = row.median && S.rows.webgl.median ? +(row.median / S.rows.webgl.median).toFixed(2) : null;
		S.rows[key] = row;
		log(slug, key, JSON.stringify(row));
		await page.evaluate(() => window.__stores.cinematicState.setCinematic(false));
		await page.waitForTimeout(1500);
		// the standard view after the trip: the same image as before it (the environment came back)
		S.rows[key].after = { luma: await glLuma(page), shot: await shot(page, `${slug}-${key}-webgl-after`), switches: (await dbg(page, false)).switches.slice(-2) };
		log(slug, key, 'webgl after', JSON.stringify(S.rows[key].after).slice(0, 600));
		save();
	}
}

/** mean luma (0-255) of the WebGL view, drawn and read in one task */
const glLuma = (page) =>
	page.evaluate(() => {
		let r, sc, c;
		window.__stores.globalRenderer.subscribe((x) => (r = x))();
		window.__stores.globalScene.subscribe((x) => (sc = x))();
		window.__stores.globalCamera.subscribe((x) => (c = x))();
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

(async () => {
	let browser, context;
	if (CDP) {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
		context = await browser.newContext({ viewport: null });
	} else {
		browser = await chromium.launch({
			args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit']
		});
		context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H } });
	}
	await context.addInitScript(() => {
		try {
			for (const [k, v] of [['debugStores', 'true'], ['hasSeenDisclaimer', 'true'], ['hasSeenWelcome', 'true'], ['perfReports:offered', 'no'], ['errorReports:send', 'false']]) localStorage.setItem(k, v);
		} catch {
			/* storage blocked */
		}
	});
	const page = await context.newPage();
	await page.bringToFront().catch(() => {});
	let rc = 0;
	try {
		await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
		await page.waitForFunction(() => !!window.__stores?.cinematicState && !!window.__stores?.sceneTemplates, null, { timeout: 180000 });
		await page.waitForTimeout(3000);
		result.offered = await page.evaluate(() => window.__stores.cinematicState.probeCinematic());
		result.viewport = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
		if (!result.offered) throw new Error('the view is not offered here: ' + (await st(page)).why);
		for (const slug of SCENES) await runScene(page, slug);
		// the table
		for (const [slug, S] of Object.entries(result.scenes)) {
			for (const [k, r] of Object.entries(S.rows)) log('TABLE', DEVICE, slug, k, r.median ?? r.error, 'p95', r.p95 ?? '', r.x != null ? 'x' + r.x : '', r.quality && !k.startsWith(r.quality) ? '(now ' + r.quality + ')' : '');
		}
	} catch (e) {
		rc = 1;
		result.fatal = String(e?.stack || e).slice(0, 1500);
		log('FATAL', result.fatal);
	}
	save();
	await context.close().catch(() => {});
	if (!CDP) await browser.close().catch(() => {});
	process.exit(rc);
})();
