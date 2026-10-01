// 33 L1 — SCENES LOAD WITHOUT FREEZING THE WINDOW, WITH VISIBLE PROGRESS.
//
// The report (a phone): "after reloading with Castle Courtyard open, pressing Restore hangs
// the whole window; opening other scenes also freezes". Measured (P0, CPU x6, phone
// viewport): Restore was ONE 80 s task (every child re-serialized with its textures as PNG
// data URLs for the wire, solo or not) and the template open had 569 ms tasks with the
// window frozen for 2 s. This suite drives the same two paths on the same throttled phone:
//
//   1. OPEN Castle Courtyard (the Templates path): the bar shows "Loading … n / 182 objects"
//      and counts up, no long task exceeds 200 ms, every kit piece refills from its pack.
//   2. The UI answers mid-load: the logo menu opens while the castle is still arriving.
//   3. Opening ANOTHER scene mid-load supersedes the first cleanly (no castle piece in the
//      forest, the bar ends).
//   4. Cancel stops the load and takes back what it had added.
//   5. AUTOSAVE writes pristine kit pieces as STUBS — the snapshot is a fraction of the 51 MB
//      it was — and a frame drawn right after the save still shows every piece; an EDITED
//      piece is written in full.
//   6. RESTORE (the real button in the restore toast) after a reload: "Restoring …" with
//      progress, no long task > 200 ms, the castle is whole again (and the edited piece kept
//      its edit).
//
// Feed + kits are served from local folders (the level-templates idiom):
//   SCENES_DIR (default: the scenes checkout, any branch carrying templates/castle-courtyard)
//   PACKS_DIR  (default: /home/deck/.code/lanes-30/levels-packs)
// SKIPS (never fails) when the castle .tpscene is not there.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SCENES_DIR = process.env.SCENES_DIR || '/home/deck/.code/theprototype-app/scenes';
const PACKS_DIR = process.env.PACKS_DIR || '/home/deck/.code/lanes-30/levels-packs';
const CPU = Number(process.env.CPU || 6);
const LONG_MS = 200;
const MOBILE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 };

const CASTLE = 'templates/castle-courtyard/scene.tpscene';
const FOREST = 'templates/forest-clearing/scene.tpscene';

/** long tasks + the longest rAF gap, armed per measurement */
const PROBE = () => {
	const w = /** @type {any} */ (window);
	if (w.__loadProbe) return;
	const p = { longtasks: /** @type {number[]} */ ([]), maxGap: 0, last: 0, on: false };
	w.__loadProbe = p;
	new PerformanceObserver((list) => {
		if (p.on) for (const e of list.getEntries()) p.longtasks.push(Math.round(e.duration));
	}).observe({ type: 'longtask', buffered: false });
	const tick = (/** @type {number} */ t) => {
		if (p.on && p.last) p.maxGap = Math.max(p.maxGap, t - p.last);
		p.last = t;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
};
const arm = (page) =>
	page.evaluate(() => {
		const p = /** @type {any} */ (window).__loadProbe;
		Object.assign(p, { longtasks: [], maxGap: 0, last: 0, on: true });
	});
const disarm = (page) =>
	page.evaluate(() => {
		const p = /** @type {any} */ (window).__loadProbe;
		p.on = false;
		return { longtasks: p.longtasks.slice(), max: Math.max(0, ...p.longtasks), maxGap: Math.round(p.maxGap) };
	});

const sceneState = (page, marker) =>
	page.evaluate((marker) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		/** @type {any} */ let pending;
		s.packRefs.packRefsPending.subscribe((v) => (pending = v))();
		/** @type {any} */ let job;
		s.sceneLoader.sceneLoad.subscribe((v) => (job = v))();
		let hollow = 0;
		let meshes = 0;
		let refs = 0;
		g?.traverse((/** @type {any} */ n) => {
			if (n.userData?.packStub) hollow++;
			if (n.userData?.packRef) refs++;
			if (n.isMesh) meshes++;
		});
		return { top: g?.children.length ?? 0, hollow, meshes, refs, pending, job, marker: !!marker && !!(g?.getObjectByName(marker) || g?.getObjectByName(marker.replace(/ /g, '_'))), castle: !!(g?.getObjectByName('Castle gate') || g?.getObjectByName('Castle_gate')), forest: !!g?.getObjectByName('Footbridge') };
	}, marker);

const whole = (s) => s.marker && s.hollow === 0 && s.pending === 0 && !s.job && s.meshes > 0;

h.run(async () => {
	if (!fs.existsSync(path.join(SCENES_DIR, CASTLE))) {
		console.log('SKIP no castle-courtyard scene at ' + SCENES_DIR);
		console.log('ALL PASS');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: MOBILE });
	const page = A.page;
	await page.route('**/cdn.jsdelivr.net/**', (route) => {
		const url = route.request().url();
		const scenes = url.match(/\/theprototype-app\/scenes@[^/]+\/(.*)$/);
		if (scenes) {
			const file = path.join(SCENES_DIR, decodeURIComponent(scenes[1]));
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
			return route.fulfill({ status: 404 });
		}
		const packs = url.match(/\/theprototype-app\/packs@[^/]+\/(.*)$/);
		if (packs) {
			const file = path.join(PACKS_DIR, decodeURIComponent(packs[1]));
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
		}
		return route.continue();
	});
	await page.evaluate(PROBE);
	const cdp = await page.context().newCDPSession(page);
	const throttle = (rate) => cdp.send('Emulation.setCPUThrottlingRate', { rate });
	const urlOf = (rel) => page.evaluate((p) => window.__stores.sceneTemplates.resolveUrl(p, window.__stores.sceneTemplates.SCENES_BASE), rel);
	const open = (url) => page.evaluate((url) => void window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url }), url);
	const castleUrl = await urlOf(CASTLE);
	const forestUrl = await urlOf(FOREST);

	// warm the pack files once (a phone that opened the castle before has them in its HTTP
	// cache too) — and the fetch itself is not what this suite measures
	await open(castleUrl);
	await h.eventually(() => sceneState(page, 'Castle gate'), whole, '0.0 (premise) the castle loads and every kit piece refills', 120000);
	const pieces = (await sceneState(page, 'Castle gate')).top;
	h.check(pieces > 150, '0.1 (premise) the castle is a big scene (' + pieces + ' top-level objects)');

	// ---- 1. OPEN on the throttled phone -------------------------------------------------
	await arm(page);
	await throttle(CPU);
	await open(castleUrl);
	/** @type {any[]} */
	const seen = [];
	await h.eventually(
		async () => {
			const s = await sceneState(page, 'Castle gate');
			const bar = await page.evaluate(() => {
				const el = document.querySelector('#scene-load-bar');
				return el ? { done: Number(el.getAttribute('data-done')), total: Number(el.getAttribute('data-total')), text: el.textContent?.replace(/\s+/g, ' ').trim() } : null;
			});
			if (bar) seen.push(bar);
			return s;
		},
		whole,
		'1.0 the castle opens on a CPU x' + CPU + ' phone and every piece refills',
		180000
	);
	await page.waitForTimeout(1500); // trailing frames: the first draw of the new pieces
	await throttle(1);
	let probe = await disarm(page);
	h.check(seen.length > 0 && seen.some((b) => /Loading .*\d+ \/ \d+ objects/.test(b.text ?? '')), '1.1 the load bar says what loads and how far it is (' + (seen[0]?.text ?? 'never shown') + ')');
	const dones = seen.map((b) => b.done);
	h.check(seen.length > 0 && seen[0].total === pieces && new Set(dones).size >= 3 && dones.every((d, i) => i === 0 || d >= dones[i - 1]), '1.2 it counts up over the ' + pieces + ' objects (' + [...new Set(dones)].slice(0, 8).join(', ') + ' …)');
	h.check(probe.max <= LONG_MS, `1.3 no long task over ${LONG_MS} ms while it loads (max ${probe.max} ms of ${probe.longtasks.length}; longest frame gap ${probe.maxGap} ms)`);
	console.log('   open long tasks: ' + JSON.stringify(probe.longtasks.slice().sort((a, b) => b - a).slice(0, 10)));

	// ---- 2. the UI answers mid-load -----------------------------------------------------
	await throttle(CPU);
	await open(castleUrl);
	await h.eventually(() => page.evaluate(() => !!document.querySelector('#scene-load-bar')), (v) => v, '2.0 (premise) a load is under way (the bar is up)', 20000);
	const t0 = Date.now();
	await page.locator('#logo-menu').click({ timeout: 5000 });
	const menuUp = await page
		.waitForFunction(() => { const m = document.querySelector('#open-templates'); return !!m && m.getBoundingClientRect().height > 0; }, null, { timeout: 5000 })
		.then(() => Date.now() - t0)
		.catch(() => -1);
	const stillLoading = !!(await sceneState(page, null)).job;
	h.check(menuUp >= 0 && menuUp < 2000 && stillLoading, `2.1 the logo menu opens in ${menuUp} ms while the scene is still loading (${stillLoading ? 'still loading' : 'load had ENDED — inconclusive'})`);
	await page.keyboard.press('Escape');
	await page.locator('#logo-menu').click().catch(() => {});
	await throttle(1);
	await h.eventually(() => sceneState(page, 'Castle gate'), whole, '2.2 that load still completes', 180000);

	// ---- 3. another scene SUPERSEDES the running one --------------------------------------
	await throttle(CPU);
	await open(castleUrl);
	await h.eventually(() => sceneState(page, null), (s) => s.job && s.job.done > 5 && s.job.done < s.job.total - 20, '3.0 (premise) the castle is half-way in', 30000);
	await open(forestUrl);
	await throttle(1);
	await h.eventually(() => sceneState(page, 'Footbridge'), whole, '3.1 the forest opens and finishes', 180000);
	await page.waitForTimeout(1500);
	const after3 = await sceneState(page, 'Footbridge');
	h.check(after3.forest && !after3.castle, '3.2 no castle piece survived into the forest (castle gate ' + (after3.castle ? 'PRESENT' : 'absent') + ')');
	h.check(!after3.job && !(await page.locator('#scene-load-bar').count()), '3.3 the bar is gone once the forest is whole');

	// ---- 4. Cancel ------------------------------------------------------------------------
	await throttle(CPU);
	await open(castleUrl);
	await h.eventually(() => page.evaluate(() => !!document.querySelector('#scene-load-cancel')), (v) => v, '4.0 (premise) the bar offers Cancel while objects are being built', 20000);
	await page.locator('#scene-load-cancel').click();
	await throttle(1);
	await h.eventually(() => sceneState(page, null), (s) => !s.job && s.top === 0, '4.1 Cancel stops the load and takes back what it had added', 20000);
	await page.waitForTimeout(2500);
	const after4 = await sceneState(page, null);
	h.check(after4.top === 0, '4.2 nothing trickles in after the cancel (' + after4.top + ' objects 2.5 s later)');
	const toast = await page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.textContent ?? '').join(' | '));
	h.check(/Stopped loading/.test(toast), '4.3 a toast says the load was stopped');

	// ---- 5. AUTOSAVE writes pristine pieces as stubs --------------------------------------
	await open(castleUrl);
	await h.eventually(() => sceneState(page, 'Castle gate'), whole, '5.0 (premise) the castle is back', 180000);
	// one EDITED piece: a pristine fingerprint no longer matches, so it must be written full
	const edited = await page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const piece = g.children.find((/** @type {any} */ c) => c.userData?.packRef && c.children.length && c.getObjectByProperty('isMesh', true));
		const mesh = piece.getObjectByProperty('isMesh', true);
		mesh.material.color.setHex(0x12ab34);
		return { uuid: piece.uuid, mesh: mesh.uuid };
	});
	const meshesBefore = (await sceneState(page, 'Castle gate')).meshes;
	await page.evaluate(() => window.__stores.autosave.saveNow());
	const meshesAfter = (await sceneState(page, 'Castle gate')).meshes;
	h.check(meshesAfter === meshesBefore, `5.1 every piece is back in the scene right after the save (${meshesBefore} -> ${meshesAfter} meshes)`);
	const snap = await page.evaluate(async () => {
		const s = await window.__stores.idb.idbGet('latest');
		let stubs = 0;
		for (const n of s?.scene?.nodes ?? []) if (n.extras?.packStub) stubs++;
		return { bytes: JSON.stringify(s?.scene ?? '').length, stubs, objects: s?.objects };
	});
	h.check(snap.stubs > 100 && snap.bytes < 8_000_000, `5.2 the autosave is ${(snap.bytes / 1e6).toFixed(2)} MB with ${snap.stubs} stub pieces (it was 51 MB of full geometry)`);

	// ---- 6. RESTORE after a reload, through the real button -------------------------------
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 60000 });
	await page.evaluate(PROBE);
	const restoreBtn = page.locator('.tp-toast-action', { hasText: 'Restore' });
	await h.eventually(() => restoreBtn.count(), (n) => n > 0, '6.0 (premise) the restore prompt is up after the reload', 30000);
	const cdp2 = await page.context().newCDPSession(page);
	await arm(page);
	await cdp2.send('Emulation.setCPUThrottlingRate', { rate: CPU });
	await restoreBtn.first().click();
	/** @type {string[]} */
	const texts = [];
	await h.eventually(
		async () => {
			const t = await page.evaluate(() => document.querySelector('#scene-load-bar')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
			if (t) texts.push(t);
			return sceneState(page, 'Castle gate');
		},
		whole,
		'6.1 Restore brings the whole castle back on the throttled phone',
		180000
	);
	await page.waitForTimeout(1500);
	await cdp2.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	probe = await disarm(page);
	h.check(texts.some((t) => /^Restoring your last session/.test(t)), '6.2 the bar says it is restoring (' + (texts[texts.length - 1] ?? 'never shown') + ')');
	h.check(probe.max <= LONG_MS, `6.3 no long task over ${LONG_MS} ms while it restores (max ${probe.max} ms of ${probe.longtasks.length}; longest frame gap ${probe.maxGap} ms)`);
	console.log('   restore long tasks: ' + JSON.stringify(probe.longtasks.slice().sort((a, b) => b - a).slice(0, 10)));
	const kept = await page.evaluate((e) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const mesh = g.getObjectByProperty('uuid', e.mesh);
		return mesh ? mesh.material.color.getHex() : null;
	}, edited);
	h.check(kept === 0x12ab34, '6.4 the EDITED piece came back with its edit (colour ' + (kept == null ? 'missing' : '#' + kept.toString(16)) + ')');
	const final = await sceneState(page, 'Castle gate');
	h.check(final.top === pieces, `6.5 every object is back (${final.top} / ${pieces})`);

	await h.finish(browser);
});
