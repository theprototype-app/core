// 100 C1 — THE MEMORY GATE: 10 round trips through the Cinematic view keep the JS heap and the GPU memory
// within 5 % (roadmap 100 C1 §1). Measured with the view OFF at both ends, after four warm-up trips (the lazy
// chunk, the pipeline's shader cache, V8's JIT warm-up and the generation-0 sweep are one-time costs, not growth).
// 100-int (orchestrator + claude:9, 2026-11-20): the run is 25 trips. The 5 % gate is judged on the steady state,
// the last ten trips (trip 15 -> trip 25), and the TAIL SLOPE (least-squares heap slope over trips 16-25) must stay
// small (SLOPE_KB, off by default, see below): a real per-trip leak keeps its slope, warm-up growth flattens out. Trips 1-10
// after the warm-up and the whole run are printed too (not gates; the PC Product shot reads ~5 % on trips 1-10
// from the JIT warm-up). With TRIPS < 20 the gate falls back to the whole run and no slope is judged.
// One run's 10-point slope is noisy: unchanged code read 24-107 KB/trip on the PC Product shot over five runs (100-int
// QUESTIONS 2), so the slope is REPORTED here and judged across runs by cinematic-memory-ab.cjs: union vs base, both
// series interleaved (B U B U ...). SLOPE_KB=<n> turns a single-run line back on.
//
//   PC (real Chrome through the device lab, by day):
//     cd ~/.code/lanes-30/100-light/lab && TREE=<tree> PORT=7035 GPU_MEM=pc SCENE=tavern-interior \
//       node run-pc.mjs --name mem-pc --driver tests/e2e/cinematic-memory-100.cjs --minutes 30
//   Deck (its own Chromium, AMD fdinfo for GPU memory; alone in an --exclusive slot, never beside a battery):
//     APP_URL=https://theprototype.app:7034/ e2e-slot --local --exclusive --wait 9000 --dev $PWD 7034 -- \
//       env GPU_MEM=deck SCENE=tavern-interior node tests/e2e/cinematic-memory-100.cjs
//
// env: SCENE (tavern-interior), TRIPS (25), SLOPE_KB (0 = report only), DWELL_MS (1500), GATE_PCT (5), OUT (test-results/100-view/memory),
//      WARM (4 warm-up trips), NOPRUNE=1 (the control: listeners left where three put them), SNAP=1 (heap snapshots A/B for heapdiff),
//      LABELS (1: a flat text sign and a note pin join the scene, so the C2-1 text quads are made and freed on every trip;
//      each trip records how many quads the view drew, `labels` in the row; 0 = the scene as loaded)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.APP_URL || 'https://theprototype.app:7034/';
const CDP = process.env.CDP || '';
const SCENE = process.env.SCENE || 'tavern-interior';
const TRIPS = Number(process.env.TRIPS || 25);
const WARM = Number(process.env.WARM || 4);
const SLOPE_KB = Number(process.env.SLOPE_KB || 0); // 0 = report only (judged by cinematic-memory-ab.cjs)
const GATE_TRIPS = 10;
const DWELL = Number(process.env.DWELL_MS || 1500);
const LABELS = process.env.LABELS !== '0';
const GATE = Number(process.env.GATE_PCT || 5);
const GPU_MEM = process.env.GPU_MEM || (CDP ? 'pc' : 'deck');
const DEVICE = process.env.DEVICE || GPU_MEM;
const OUT = process.env.OUT || path.join(process.cwd(), 'test-results/100-view/memory');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[mem]', ...a);
const result = { noPrune: process.env.NOPRUNE === '1', device: DEVICE, scene: SCENE, trips: TRIPS, warm: WARM, gatePct: GATE, slopeGateKB: SLOPE_KB, at: new Date().toISOString(), trip: [], verdict: null };
const save = () => fs.writeFileSync(path.join(OUT, `memory-${DEVICE}-${SCENE}${process.env.NOPRUNE === '1' ? '-control' : ''}-t${TRIPS}.json`), JSON.stringify(result, null, 1));

/** SNAP=1: a heap snapshot after the warm-up and after the trips (diff them with heapdiff-100.cjs) */
async function snapshot(cdp, file) {
	const ws = fs.createWriteStream(file);
	const on = (/** @type {any} */ m) => ws.write(m.chunk);
	cdp.on('HeapProfiler.addHeapSnapshotChunk', on);
	await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
	cdp.off('HeapProfiler.addHeapSnapshotChunk', on);
	await new Promise((r) => ws.end(r));
	return path.basename(file);
}

async function gc(cdp) {
	for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
	await new Promise((r) => setTimeout(r, 500));
	await cdp.send('HeapProfiler.collectGarbage');
}
async function heap(cdp) {
	await gc(cdp);
	const u = await cdp.send('Runtime.getHeapUsage');
	return u.usedSize;
}

/** the browser's GPU process id (CDP SystemInfo) */
async function gpuPid(browser) {
	try {
		const b = await browser.newBrowserCDPSession();
		const info = await b.send('SystemInfo.getProcessInfo');
		await b.detach().catch(() => {});
		return info.processInfo.find((p) => p.type === 'GPU' || p.type === 'gpu')?.id ?? null;
	} catch (e) {
		log('no process info', String(e.message).slice(0, 120));
		return null;
	}
}

/** GPU memory of that process in bytes: Windows' per-process GPU counters, or amdgpu's fdinfo on the Deck */
async function gpuBytes(pid) {
	if (!pid) return null;
	if (GPU_MEM === 'pc') {
		const lab = process.env.LAB || '/home/deck/.code/lanes-30/100-light/lab/lib/pc.mjs';
		const { ps } = await import(lab);
		const out = ps(
			`$c = Get-Counter -Counter '\\GPU Process Memory(pid_${pid}_*)\\Dedicated Usage','\\GPU Process Memory(pid_${pid}_*)\\Shared Usage' -ErrorAction SilentlyContinue; ` +
				`if ($c) { [int64](($c.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum) } else { 'none' }`,
			60
		).trim();
		return /^\d+$/.test(out) ? Number(out) : null;
	}
	// amdgpu: one fdinfo per open DRM file; count each client id once
	let total = 0;
	const seen = new Set();
	const dir = `/proc/${pid}/fdinfo`;
	for (const f of fs.readdirSync(dir)) {
		let s;
		try {
			s = fs.readFileSync(path.join(dir, f), 'utf8');
		} catch {
			continue;
		}
		const id = /drm-client-id:\s*(\d+)/.exec(s)?.[1];
		if (!id || seen.has(id)) continue;
		seen.add(id);
		for (const k of ['drm-memory-vram', 'drm-memory-gtt']) {
			const m = new RegExp(k + ':\\s*(\\d+)\\s*(KiB|MiB)?').exec(s);
			if (m) total += Number(m[1]) * (m[2] === 'MiB' ? 1048576 : 1024);
		}
	}
	return seen.size ? total : null;
}

const view = (page, on) =>
	page.evaluate(async (on) => {
		const m = window.__stores.cinematicState;
		const r = await m.setCinematic(on);
		return { ok: !!r, mode: (() => { let s; m.cinematicState.subscribe((v) => (s = v))(); return s.mode; })() };
	}, on);

/** @returns {Promise<number | null>} the text quads the view drew on this trip (C2-1; null on a build without them) */
async function trip(page) {
	const a = await view(page, true);
	if (!a.ok || a.mode !== 'on') throw new Error('the view did not come on: ' + JSON.stringify(a));
	await page.waitForTimeout(DWELL);
	const labels = await page.evaluate(async () => (await window.__stores.cinematicState.cinematicView()).cinematicDebug?.()?.labels?.quads ?? null).catch(() => null);
	const b = await view(page, false);
	if (b.mode !== 'off') throw new Error('the view did not go off: ' + JSON.stringify(b));
	await page.waitForTimeout(DWELL);
	return labels;
}

(async () => {
	let browser, context;
	if (CDP) {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
		context = await browser.newContext({ viewport: null });
	} else {
		browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
		context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
	}
	await context.addInitScript((noPrune) => {
		try {
			if (noPrune) localStorage.setItem('debugNoGenPrune', '1');
			for (const [k, v] of [['debugStores', 'true'], ['hasSeenDisclaimer', 'true'], ['hasSeenWelcome', 'true'], ['perfReports:offered', 'no'], ['errorReports:send', 'false']]) localStorage.setItem(k, v);
		} catch {
			/* storage blocked */
		}
	}, process.env.NOPRUNE === '1');
	const page = await context.newPage();
	await page.bringToFront().catch(() => {});
	let rc = 0;
	try {
		await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
		await page.waitForFunction(() => !!window.__stores?.cinematicState && !!window.__stores?.sceneTemplates, null, { timeout: 180000 });
		await page.waitForTimeout(3000);
		const offered = await page.evaluate(() => window.__stores.cinematicState.probeCinematic());
		result.offered = offered;
		if (!offered) throw new Error('the view is not offered here: ' + (await page.evaluate(() => { let s; window.__stores.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s.why; })));
		const ok = await page.evaluate(async (slug) => {
			const st = window.__stores;
			st.sceneSwitch?.modulesOnOpen?.set('keep');
			await st.sceneTemplates.loadTemplatesIndex(true);
			let list;
			st.sceneTemplates.templates.subscribe((v) => (list = v))();
			return st.sceneTemplates.loadRemoteScene(list.find((x) => x.slug === slug));
		}, SCENE);
		log('load', SCENE, ok);
		await page.waitForTimeout(12000);
		if (LABELS) {
			// C2-1: troika text in the scene (a flat sign + a note pin's number), so every trip makes and frees quads
			const made = await page.evaluate(async () => {
				const st = window.__stores;
				let g;
				st.objectsGroup.subscribe((v) => (g = v))();
				const before = new Set(g.children.map((o) => o.uuid));
				st.commandsHandler.sceneCommand('/create Text');
				await new Promise((r) => setTimeout(r, 500));
				const text = g.children.find((o) => !before.has(o.uuid) && o.userData?.textPath);
				if (text) st.textPathEdit.setTextPathFor(text.uuid, { text: 'Cinematic sign', size: 0.5 });
				const host = g.children.find((o) => o.isMesh) ?? g.children[0];
				if (host) {
					st.annotationsHandler.addAnnotation(host.uuid);
					let cur;
					st.annotationsHandler.activeAnnotation.subscribe((v) => (cur = v))();
					if (cur?.draft) st.annotationsHandler.setAnnotation({ ...cur.draft, name: 'Memory note', text: 'pin' });
				}
				return { text: !!text, pin: !!host };
			});
			result.labelsAdded = made;
			log('labels added', JSON.stringify(made));
			await page.waitForTimeout(3000);
		}
		const cdp = await context.newCDPSession(page);
		await cdp.send('HeapProfiler.enable');
		const pid = await gpuPid(browser);
		result.gpuPid = pid;
		for (let i = 0; i < WARM; i++) result.warmLabels = await trip(page);
		await page.waitForTimeout(3000);
		const h0 = await heap(cdp);
		const g0 = await gpuBytes(pid);
		result.before = { heap: h0, gpu: g0 };
		if (process.env.SNAP === '1') result.snapA = await snapshot(cdp, path.join(OUT, `A-${DEVICE}-${SCENE}.heapsnapshot`));
		log('before: heap MB', (h0 / 1e6).toFixed(1), 'gpu MB', g0 == null ? 'n/a' : (g0 / 1e6).toFixed(1));
		for (let i = 0; i < TRIPS; i++) {
			const t0 = Date.now();
			const labels = await trip(page);
			const row = { i, ms: Date.now() - t0, heap: await heap(cdp), gpu: await gpuBytes(pid), labels };
			result.trip.push(row);
			log('trip', i + 1, 'heap MB', (row.heap / 1e6).toFixed(1), 'gpu MB', row.gpu == null ? 'n/a' : (row.gpu / 1e6).toFixed(1), 'text quads', labels ?? 'n/a');
			save();
		}
		await page.waitForTimeout(3000);
		const h1 = await heap(cdp);
		const g1 = await gpuBytes(pid);
		result.after = { heap: h1, gpu: g1 };
		if (process.env.SNAP === '1') {
			await gc(cdp);
			result.snapB = await snapshot(cdp, path.join(OUT, `B-${DEVICE}-${SCENE}.heapsnapshot`));
		}
		result.debug = await page.evaluate(async () => (await window.__stores.cinematicState.cinematicView()).cinematicDebug?.() ?? null).catch(() => null);
		const pct = (a, b) => (a == null || b == null || !a ? null : +(((b - a) / a) * 100).toFixed(2));
		const rows = result.trip;
		// the 5 % gate: the last ten trips when TRIPS >= 20 (rows[n-11] -> rows[n-1]), else the whole run
		const steady = rows.length >= 20;
		const gA = steady ? rows[rows.length - 1 - GATE_TRIPS] : { heap: h0, gpu: g0 };
		const gB = steady ? rows[rows.length - 1] : { heap: h1, gpu: g1 };
		result.gateWindow = steady ? `trips ${rows.length - GATE_TRIPS}-${rows.length}` : 'whole run';
		result.heapPct = pct(gA.heap, gB.heap);
		result.gpuPct = pct(gA.gpu, gB.gpu);
		const first = rows[Math.min(GATE_TRIPS, rows.length) - 1];
		result.heapPctFirst10 = pct(h0, first.heap);
		result.gpuPctFirst10 = pct(g0, first.gpu);
		result.heapPctRun = pct(h0, h1);
		result.gpuPctRun = pct(g0, g1);
		result.heapPerTripKB = Math.round((h1 - h0) / TRIPS / 1024);
		result.gpuPerTripKB = g0 == null || g1 == null ? null : Math.round((g1 - g0) / TRIPS / 1024);
		// the tail slope: least squares over the last ten trips (16-25 by default; none when TRIPS < 20)
		const tail = steady ? rows.slice(-GATE_TRIPS) : [];
		if (tail.length >= 5) {
			const n = tail.length;
			const mx = tail.reduce((a, r) => a + r.i, 0) / n;
			const my = tail.reduce((a, r) => a + r.heap, 0) / n;
			const sxy = tail.reduce((a, r) => a + (r.i - mx) * (r.heap - my), 0);
			const sxx = tail.reduce((a, r) => a + (r.i - mx) ** 2, 0);
			result.tailSlopeKB = Math.round(sxy / sxx / 1024);
		} else result.tailSlopeKB = null;
		const heapOk = result.heapPct != null && result.heapPct <= GATE;
		const gpuOk = result.gpuPct == null ? null : result.gpuPct <= GATE;
		const slopeOk = result.tailSlopeKB == null || !SLOPE_KB ? null : result.tailSlopeKB < SLOPE_KB;
		result.verdict =
			heapOk && gpuOk !== false && slopeOk !== false
				? `PASS${gpuOk === null ? ' (heap only: no GPU counter)' : ''}${slopeOk === null ? (SLOPE_KB ? ' (no tail slope: < 20 trips)' : ' (tail slope reported, judged across runs)') : ''}`
				: 'FAIL';
		log(result.gateWindow + ': heap', result.heapPct, '% gpu', result.gpuPct, '% | tail slope', result.tailSlopeKB, SLOPE_KB ? `KB/trip (< ${SLOPE_KB})` : 'KB/trip', '| trips 1-10 heap', result.heapPctFirst10, '% gpu', result.gpuPctFirst10, '% | whole run heap', result.heapPctRun, '% (', result.heapPerTripKB, 'KB/trip) gpu', result.gpuPctRun, '% ->', result.verdict);
		log('generations', JSON.stringify(result.debug?.generations ?? null));
		if (result.verdict === 'FAIL') rc = 1;
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
