// 33 L1 P0 — WHERE A SCENE LOAD SPENDS ITS MAIN THREAD, on a throttled "phone".
//
// For each scene: a fresh context with a mobile viewport (isMobile + touch, 412x915 @2.6),
// CPU throttled (CPU=6 by default), then two loads measured the same way:
//   open     the Templates path (fetch .tpscene -> importSessionZip -> requestLoadSession)
//   restore  autosave -> reload -> the Restore button's call (autosave.restoreSnapshot)
// Each one reports: wall time until every kit piece refilled, the long tasks (> 50 ms,
// PerformanceObserver 'longtask'), the LONGEST gap between two animation frames (what a user
// calls "the window froze"), and the CPU profile's top self-time functions INSIDE long tasks.
//
//   APP_URL=https://theprototype.app:5275/ node scripts/scene-load-trace.cjs
//   SCENES_DIR=<scenes checkout>  PACKS_DIR=<packs mirror>  SLUGS=castle-courtyard,...  CPU=6
//   OUT=<dir for the json + md>   PHASES=open,restore   PACK_DELAY=1 (slow pack downloads)
const fs = require('fs');
const path = require('path');
const h = require('../tests/e2e/helpers.cjs');

const SCENES_DIR = process.env.SCENES_DIR || '/home/deck/.code/theprototype-app/scenes';
const PACKS_DIR = process.env.PACKS_DIR || '/home/deck/.code/lanes-30/levels-packs';
const SLUGS = (process.env.SLUGS || 'castle-courtyard,forest-clearing,tavern-interior').split(',').filter(Boolean);
const CPU = Number(process.env.CPU || 6);
const OUT = process.env.OUT || '';
const PHASES = (process.env.PHASES || 'open,restore').split(',');

const MOBILE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 };

/** the in-page probe: long tasks + rAF gaps, reset per phase */
const PROBE = () => {
	const w = /** @type {any} */ (window);
	if (w.__loadProbe) return;
	const p = { longtasks: /** @type {any[]} */ ([]), maxGap: 0, frames: 0, last: 0, on: false };
	w.__loadProbe = p;
	try {
		new PerformanceObserver((list) => {
			if (!p.on) return;
			for (const e of list.getEntries()) p.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
		}).observe({ type: 'longtask', buffered: false });
	} catch {}
	const tick = (/** @type {number} */ t) => {
		if (p.on) {
			if (p.last) p.maxGap = Math.max(p.maxGap, t - p.last);
			p.frames++;
		}
		p.last = t;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
};

const settled = (page, marker) =>
	page.evaluate((marker) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		/** @type {any} */ let pending;
		s.packRefs.packRefsPending.subscribe((v) => (pending = v))();
		let hollow = 0;
		let meshes = 0;
		g?.traverse((/** @type {any} */ n) => {
			if (n.userData?.packStub) hollow++;
			if (n.isMesh) meshes++;
		});
		return { ok: !!g && g.children.length > 0 && hollow === 0 && pending === 0 && (!marker || !!g.getObjectByName(marker) || !!g.getObjectByName(marker.replace(/ /g, '_'))), top: g?.children.length ?? 0, meshes, hollow, pending };
	}, marker);

async function measure(page, cdp, label, start, marker) {
	await page.evaluate(() => {
		const p = /** @type {any} */ (window).__loadProbe;
		p.longtasks = [];
		p.maxGap = 0;
		p.frames = 0;
		p.last = 0;
		p.on = true;
	});
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
	const perfAtStart = await page.evaluate(() => performance.now());
	await cdp.send('Profiler.start');
	const t0 = Date.now();
	await start();
	let state = null;
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline) {
		state = await settled(page, marker).catch(() => null);
		if (state?.ok) break;
		await page.waitForTimeout(250);
	}
	const wall = Date.now() - t0;
	// a beat for trailing work (scan, fingerprints, shader compiles on the next frames)
	await page.waitForTimeout(2500);
	const { profile } = await cdp.send('Profiler.stop');
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	const probe = await page.evaluate(() => {
		const p = /** @type {any} */ (window).__loadProbe;
		p.on = false;
		return { longtasks: p.longtasks, maxGap: Math.round(p.maxGap), frames: p.frames, origin: performance.timeOrigin };
	});
	// attribute profile samples to functions (self time over the whole load)
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const self = new Map();
	for (let i = 0; i < profile.samples.length; i++) {
		const cf = nodes.get(profile.samples[i]).callFrame;
		if (cf.functionName === '(idle)' || cf.functionName === '(program)') continue;
		const key = (cf.functionName || '(anon)') + ' ' + (cf.url.split('/').slice(-1)[0].split('?')[0] || '') + ':' + (cf.lineNumber + 1);
		self.set(key, (self.get(key) || 0) + profile.timeDeltas[i] / 1000);
	}
	const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => ({ fn: k, ms: Math.round(ms) }));
	// the caller chain of the heaviest frames: walk parents for the top 8
	const parentOf = new Map();
	for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
	const chains = new Map();
	for (let i = 0; i < profile.samples.length; i++) {
		const id = profile.samples[i];
		const node = nodes.get(id);
		const cf = node.callFrame;
		if (cf.functionName === '(idle)' || cf.functionName === '(program)' || cf.functionName === '(garbage collector)') continue;
		const frames = [];
		let cur = id;
		while (cur && frames.length < 40) {
			const n = nodes.get(cur);
			const f = n.callFrame;
			const file = f.url.split('/').slice(-1)[0].split('?')[0];
			if (/src\/(lib|components|stores)|\.svelte/.test(f.url)) frames.push((f.functionName || '(anon)') + '@' + file + ':' + (f.lineNumber + 1));
			cur = parentOf.get(cur);
		}
		const key = frames.slice(0, 3).join(' < ') || '(no app frame)';
		chains.set(key, (chains.get(key) || 0) + profile.timeDeltas[i] / 1000);
	}
	// the three longest tasks, each broken down by app call chain (profile clock -> performance.now
	// via the moment the profiler started; a few ms of slack either side)
	const longest = probe.longtasks.slice().sort((a, b) => b.dur - a.dur).slice(0, 3);
	const perTask = longest.map((task) => {
		const by = new Map();
		let at = 0;
		for (let i = 0; i < profile.samples.length; i++) {
			at += profile.timeDeltas[i];
			const when = perfAtStart + at / 1000;
			if (when < task.start - 5 || when > task.start + task.dur + 5) continue;
			const id = profile.samples[i];
			const frames = [];
			let cur = id;
			while (cur && frames.length < 60) {
				const f = nodes.get(cur).callFrame;
				const file = f.url.split('/').slice(-1)[0].split('?')[0];
				if (f.functionName || file) frames.push((f.functionName || '(anon)') + '@' + file + ':' + (f.lineNumber + 1));
				cur = parentOf.get(cur);
			}
			const key = frames.slice(0, 6).join(' < ');
			by.set(key, (by.get(key) || 0) + profile.timeDeltas[i] / 1000);
		}
		return { dur: task.dur, start: task.start, top: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, ms]) => ({ ms: Math.round(ms), chain: k })) };
	});
	const appChains = [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, ms]) => ({ chain: k, ms: Math.round(ms) }));
	const long = probe.longtasks.slice().sort((a, b) => b.dur - a.dur);
	const total = probe.longtasks.reduce((s, e) => s + e.dur, 0);
	const result = {
		label,
		cpu: CPU,
		wallMs: wall,
		settled: state,
		longtasks: probe.longtasks.length,
		longtaskTotalMs: total,
		maxLongtaskMs: long[0]?.dur ?? 0,
		top5Longtasks: long.slice(0, 5).map((e) => e.dur),
		maxFrameGapMs: probe.maxGap,
		frames: probe.frames,
		topSelf: top,
		appChains,
		perTask
	};
	console.log(JSON.stringify({ label, wall, longtasks: result.longtasks, max: result.maxLongtaskMs, total, maxGap: probe.maxGap, frames: probe.frames, settled: state }));
	return result;
}

const MARKERS = { 'castle-courtyard': 'Castle gate', 'forest-clearing': 'Footbridge', 'tavern-interior': 'Balcony stairs' };

h.run(async () => {
	const index = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, 'index.json'), 'utf8'));
	const browser = await h.launch({ args: h.GPU_ARGS });
	const results = [];
	for (const slug of SLUGS) {
		const entry = [...(index.templates ?? []), ...(index.examples ?? []), ...(index.games ?? [])].find((t) => t.slug === slug);
		if (!entry) {
			console.log('no entry for ' + slug);
			continue;
		}
		const A = await h.setupPage(browser, slug, { context: MOBILE });
		const page = A.page;
		await page.route('**/cdn.jsdelivr.net/**', async (route) => {
			const url = route.request().url();
			const scenes = url.match(/\/theprototype-app\/scenes@[^/]+\/(.*)$/);
			if (scenes) {
				const file = path.join(SCENES_DIR, decodeURIComponent(scenes[1]));
				if (scenes[1] === 'index.json') return route.fulfill({ json: index });
				if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
				return route.fulfill({ status: 404 });
			}
			const packs = url.match(/\/theprototype-app\/packs@[^/]+\/(.*)$/);
			if (packs) {
				const file = path.join(PACKS_DIR, decodeURIComponent(packs[1]));
				if (fs.existsSync(file)) {
					// PACK_DELAY=1: a phone on a real link — each pack file lands 0.6-2.7 s later (the
					// scene-load suite's staggered delay), so pieces arrive one file at a time
					if (process.env.PACK_DELAY && /\.glb$/i.test(file)) {
						let x = 0;
						for (const ch of url) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
						await new Promise((r) => setTimeout(r, 600 + (x % 8) * 300));
					}
					return route.fulfill({ body: fs.readFileSync(file) }).catch(() => {});
				}
			}
			return route.continue();
		});
		await page.evaluate(PROBE);
		const cdp = await page.context().newCDPSession(page);
		const sceneUrl = await page.evaluate((p) => window.__stores.sceneTemplates.resolveUrl(p, window.__stores.sceneTemplates.SCENES_BASE), entry.scene);
		const marker = MARKERS[slug];
		if (PHASES.includes('open'))
			results.push({
				slug,
				...(await measure(page, cdp, slug + ' open', () =>
					page.evaluate((url) => {
						// not awaited: the probe measures the page while it works
						void window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url });
					}, sceneUrl), marker))
			});
		if (PHASES.includes('restore')) {
			if (!PHASES.includes('open')) {
				await page.evaluate((url) => window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url }), sceneUrl);
				await h.eventually(() => settled(page, marker), (r) => r?.ok, slug + ' loaded for the restore', 120000);
			}
			await page.waitForTimeout(1500);
			await page.evaluate(() => window.__stores.autosave.saveNow());
			const snap = await page.evaluate(async () => {
				const s = await window.__stores.idb.idbGet('latest');
				return { bytes: s?.scene?.byteLength ?? (s?.scene ? JSON.stringify(s.scene).length : 0), objects: s?.objects };
			});
			console.log('autosave snapshot', JSON.stringify(snap));
			await page.reload({ waitUntil: 'domcontentloaded' });
			await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 60000 });
			await page.evaluate(PROBE);
			await h.eventually(
				() => page.evaluate(() => { let v; window.__stores.autosave.restoreAvailable.subscribe((x) => (v = x))(); return !!v; }),
				(v) => v,
				slug + ' the Restore offer is up after the reload',
				30000
			);
			const cdp2 = await page.context().newCDPSession(page);
			results.push({
				slug,
				snapshot: snap,
				...(await measure(page, cdp2, slug + ' restore', () => page.evaluate(() => void window.__stores.autosave.restoreSnapshot()), marker))
			});
		}
		await A.ctx.close();
	}
	if (OUT) {
		fs.mkdirSync(OUT, { recursive: true });
		const stamp = process.env.TAG || 'run';
		fs.writeFileSync(path.join(OUT, 'scene-load-' + stamp + '.json'), JSON.stringify(results, null, 1));
		const md = [
			'| load | wall ms | long tasks | total long ms | max long ms | max frame gap ms | top 5 |',
			'|---|---:|---:|---:|---:|---:|---|',
			...results.map((r) => `| ${r.label} | ${r.wallMs} | ${r.longtasks} | ${r.longtaskTotalMs} | ${r.maxLongtaskMs} | ${r.maxFrameGapMs} | ${r.top5Longtasks.join(', ')} |`)
		];
		fs.writeFileSync(path.join(OUT, 'scene-load-' + stamp + '.md'), md.join('\n') + '\n');
		console.log(md.join('\n'));
	}
	await browser.close();
});
