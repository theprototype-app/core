// 36 U1 — THE PROFILER IS READABLE IN EVERY THEME. The Profiler tab (all four detail tabs, the
// recordings list, the timeline readout) and the Live profiler overlay, walked through every
// built-in theme: every visible piece of text must reach WCAG AA (4.5:1) against what is actually
// painted behind it. Screenshots per theme land in the evidence folder.
//
// The user's report (2026-10-04): "Profiler numbers are invisible (black) on the dark theme;
// element colours wrong on the other themes". BEFORE=1 records the same walk without asserting
// (the before-evidence run).
//
// Run: APP_URL=https://theprototype.app:5321/ npm run e2e -- profiler-themes
const h = require('./helpers.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { contrastRows } = require('./contrast.cjs');

const SHOTS = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-36/36-ui-polish';
const PHASE = process.env.BEFORE ? 'before' : 'after';
const AA = 4.5;

h.run(async () => {
	fs.mkdirSync(SHOTS, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	// ---- a small planted scene so the tree has rows
	await page.evaluate(async () => {
		const s = window.__stores;
		for (const name of ['Crate', 'Barrel', 'Lamp']) {
			s.commandsHandler.sceneCommand('/create box');
			let o;
			s.selectedObject.subscribe((x) => (o = x))();
			o.name = name;
		}
		s.selectedObjects?.set?.([]);
		await s.profilerView.openProfiler();
	});
	await page.waitForSelector('#profiler-record', { timeout: 15000 });

	// ---- one detailed recording through the real buttons
	await page.click('#profiler-mode-detailed');
	await page.selectOption('select[aria-label="Detailed recording length"]', '5');
	await page.click('#profiler-record');
	await page.waitForSelector('#profiler-recording', { timeout: 5000 });
	await page.waitForSelector('#profiler-recording', { state: 'detached', timeout: 30000 });
	await page.waitForSelector('#profiler-recordings li[data-id]', { timeout: 10000 });
	await page.waitForTimeout(800);

	// ---- the live overlay with a fake watched peer (frames + a capture) so every element draws
	await page.evaluate(async () => {
		const s = window.__stores;
		const sink = s.perfLiveSink;
		const wire = s.perfLiveWire;
		const id = 'quest-fake';
		sink.perfLive.update((st) => ({
			...st,
			recording: { [id]: { mode: 'detailed' } },
			sessions: {
				[id]: {
					peerId: id, name: 'Quest 3', mode: 'detailed', watching: true, xr: true, device: 'Quest 3',
					rec: { mode: 'detailed' }, frames: 0, events: 0, captures: 0, dropped: 2, lastAt: Date.now(),
					bytesPerSec: 30000, latest: null, lastCapture: null, cpu: null, ended: false, waiting: false
				}
			}
		}));
		const frames = [];
		for (let i = 0; i < 300; i++)
			frames.push({ t: i * 13.9, ms: 12 + (i % 40 === 0 ? 14 : Math.random() * 3), calls: 120 + (i % 50), tris: 180000, quality: 1, cpu: { input: 0.2, physics: 1.1, modules: 0.8, flow: 0.4, render: 6, other: 0.5 } });
		sink.sinkMessage(id, { op: 'frames', base: Date.now() - 4200, ...wire.packFrames(frames, true) });
		sink.sinkMessage(id, {
			op: 'capture', base: Date.now() - 4200, t: 4000,
			cap: { objects: [{ name: 'Tavern table', path: 'Tavern/Tavern table', calls: 22, tris: 41000 }, { name: 'Birch 2', path: 'Forest/Birch 2', calls: 9, tris: 12000 }] }
		});
		sink.profilerLiveOpen.set(true);
	});
	await page.waitForSelector('#profiler-live .live-session', { timeout: 5000 });

	const themes = await page.evaluate(() => window.__stores.themes.THEMES.map((t) => t.id));
	console.log('themes: ' + themes.join(', '));
	h.check(themes.length >= 5, `the theme list has the five built-ins (${themes.length})`);

	/** @type {{theme: string, where: string, text: string, ratio: number, fg: string, bg: string, path: string}[]} */
	const failures = [];
	const summary = [];
	let n = 0;
	/** a cheap fingerprint of the timeline canvas: it must change with the theme (a stale canvas
	 *  keeps the previous theme's ink — what the light shots showed before the redraw fix) */
	const canvasPrint = () =>
		page.evaluate(() => {
			const c = /** @type {HTMLCanvasElement | null} */ (document.querySelector('#profiler-timeline canvas'));
			if (!c) return '';
			const d = c.getContext('2d')?.getImageData(0, 0, Math.min(120, c.width), Math.min(60, c.height)).data;
			let h = 0;
			if (d) for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
			return String(h);
		});
	let lastPrint = await canvasPrint();
	for (const id of themes) {
		await page.evaluate((t) => window.__stores.themes.theme.set(t), id);
		await page.waitForTimeout(500);
		const print = await canvasPrint();
		if (id !== 'dark') h.check(print !== lastPrint, `${id}: the timeline canvas repainted in the new theme's ink`);
		lastPrint = print;
		let worst = Infinity;
		let count = 0;
		// the overlay floats over the dock's corner: shoot each surface on its own
		await page.evaluate(() => window.__stores.perfLiveSink.profilerLiveOpen.set(false));
		for (const tab of ['tree', 'ranked', 'cpu', 'events']) {
			await page.click(`#profiler-tab-${tab}`);
			await page.waitForTimeout(250);
			const rows = await contrastRows(page, '#profiler-dock');
			count += rows.length;
			for (const r of rows) {
				worst = Math.min(worst, r.ratio);
				if (r.ratio < AA) failures.push({ theme: id, where: 'dock/' + tab, ...r });
			}
			if (tab === 'tree') await page.locator('#profiler-dock').screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${PHASE}-profiler-${id}.png`) }).catch(() => {});
		}
		await page.evaluate(() => window.__stores.perfLiveSink.profilerLiveOpen.set(true));
		await page.waitForSelector('#profiler-live .live-session', { timeout: 5000 });
		await page.waitForTimeout(300);
		const live = await contrastRows(page, '#profiler-live');
		count += live.length;
		for (const r of live) {
			worst = Math.min(worst, r.ratio);
			if (r.ratio < AA) failures.push({ theme: id, where: 'live', ...r });
		}
		await page.locator('#profiler-live').screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${PHASE}-live-${id}.png`) }).catch(() => {});
		summary.push(`${id}: ${count} text runs, worst ${worst.toFixed(2)}:1`);
	}
	console.log('\n' + summary.join('\n'));
	const dedupe = new Map();
	for (const f of failures) {
		const k = `${f.theme}|${f.path}|${f.fg}`;
		if (!dedupe.has(k)) dedupe.set(k, f);
	}
	const lines = [...dedupe.values()].map((f) => `  [${f.theme}] ${f.where} ${f.ratio}:1 "${f.text}" fg=${f.fg} bg=${f.bg} @ ${f.path}`);
	fs.writeFileSync(path.join(SHOTS, `contrast-${PHASE}.txt`), summary.join('\n') + '\n\nunder 4.5:1 (' + dedupe.size + ' distinct):\n' + lines.join('\n') + '\n');
	console.log(`under ${AA}:1 — ${dedupe.size} distinct (${failures.length} incl. repeats)`);
	console.log(lines.slice(0, 80).join('\n'));
	if (!process.env.BEFORE) {
		for (const id of themes) {
			const bad = [...dedupe.values()].filter((f) => f.theme === id);
			h.check(bad.length === 0, `${id}: every profiler text reaches ${AA}:1 (${bad.length} below${bad[0] ? ', e.g. "' + bad[0].text + '" ' + bad[0].ratio + ':1' : ''})`);
		}
	}
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await h.finish(browser);
});
