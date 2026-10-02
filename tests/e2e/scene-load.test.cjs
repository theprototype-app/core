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
//   7. 1000 ORDINARY meshes (960 vertices each) (no kit references) build with no long task > 200 ms — the case where
//      the time-sliced build loop itself is what keeps the window alive.
// Counterfactuals measured (one guard removed each): autosave stubs off -> 5.2 + 6.3 red (51 MB,
// a 1 212 ms restore task); object-list chunking off -> 1.4 + 6.3 red (307 / 328 ms).
//
// EVERY measured load starts from a FRESH page: packRefs keeps parsed pack files in memory, so a
// re-open in the same page finishes before anything can be observed (the first version of this
// suite measured exactly that and saw no bar at all). Pack files are served with a staggered
// 0.6-2.7 s delay — a phone on a real link — so a load lasts long enough to watch and cancel.
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
	/** a stable per-file delay, so the models arrive one pack file at a time */
	const delayOf = (url) => {
		let x = 0;
		for (const ch of url) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
		return 600 + (x % 8) * 300;
	};
	await page.route('**/cdn.jsdelivr.net/**', async (route) => {
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
			if (fs.existsSync(file)) {
				if (/\.glb$/i.test(file)) await new Promise((r) => setTimeout(r, delayOf(url)));
				return route.fulfill({ body: fs.readFileSync(file) }).catch(() => {});
			}
		}
		return route.continue();
	});
	/** @type {any} */
	let cdp = null;
	const throttle = (rate) => cdp.send('Emulation.setCPUThrottlingRate', { rate });
	/** a fresh page (empty pack-template cache), the probe armed-able, a CDP session */
	const fresh = async ({ keepRestore = false } = {}) => {
		if (cdp) await throttle(1).catch(() => {});
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 60000 });
		await page.waitForTimeout(1500);
		await page.evaluate(PROBE);
		if (!keepRestore) await page.evaluate(() => window.__stores.autosave.dismissRestore());
		cdp = await page.context().newCDPSession(page);
	};
	await fresh();
	const urlOf = (rel) => page.evaluate((p) => window.__stores.sceneTemplates.resolveUrl(p, window.__stores.sceneTemplates.SCENES_BASE), rel);
	const open = (url) => page.evaluate((url) => void window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url }), url);
	const castleUrl = await urlOf(CASTLE);
	const forestUrl = await urlOf(FOREST);
	/** sample the load job (store) and the bar (DOM) until `until` holds */
	const watch = async (until, label, timeout = 180000) => {
		/** @type {any[]} */
		const jobs = [];
		/** @type {string[]} */
		const bars = [];
		let last = null;
		const t0 = Date.now();
		while (Date.now() - t0 < timeout) {
			const r = await page.evaluate(() => {
				/** @type {any} */ let job;
				window.__stores.sceneLoader.sceneLoad.subscribe((v) => (job = v))();
				const el = document.querySelector('#scene-load-bar');
				return { job, bar: el ? el.textContent?.replace(/\s+/g, ' ').trim() : '' };
			});
			if (r.job) jobs.push(r.job);
			if (r.bar) bars.push(r.bar);
			last = await sceneState(page, until.marker);
			if (until.done(last)) break;
			await page.waitForTimeout(120);
		}
		h.check(!!last && until.done(last), label);
		if (!(last && until.done(last))) console.log('  last: ' + JSON.stringify(last));
		return { jobs, bars, last };
	};

	// ---- 1. OPEN on the throttled phone -------------------------------------------------
	await arm(page);
	await throttle(CPU);
	await open(castleUrl);
	const one = await watch({ marker: 'Castle gate', done: whole }, '1.0 the castle opens on a CPU x' + CPU + ' phone and every kit piece refills');
	await page.waitForTimeout(1500); // trailing frames: the first draw of the new pieces
	await throttle(1);
	let probe = await disarm(page);
	const pieces = one.last?.top ?? 0;
	h.check(pieces > 150, '1.1 (premise) the castle is a big scene (' + pieces + ' top-level objects)');
	h.check(one.bars.some((t) => /^Loading .+— \d+ \/ \d+ objects/.test(t)), '1.2 the load bar says what loads and how far it is ("' + (one.bars.find((t) => /objects/.test(t)) ?? one.bars[0] ?? 'never shown') + '")');
	const dones = [...new Set(one.jobs.map((j) => j.done))];
	h.check(one.jobs.length > 0 && one.jobs[0].total === pieces && dones.length >= 3 && dones.every((d, i) => i === 0 || d >= dones[i - 1]), '1.3 it counts up over the ' + pieces + ' objects (' + dones.slice(0, 10).join(', ') + ' …)');
	h.check(probe.max <= LONG_MS, `1.4 no long task over ${LONG_MS} ms while it loads (max ${probe.max} ms of ${probe.longtasks.length}; longest frame gap ${probe.maxGap} ms)`);
	console.log('   open long tasks: ' + JSON.stringify(probe.longtasks.slice().sort((a, b) => b - a).slice(0, 10)));

	// ---- 2. the UI answers mid-load -----------------------------------------------------
	// the reference: the same menu on the same throttled phone with NOTHING loading (a CPU x6
	// page is slow at everything — the question is whether a load makes it slower)
	await fresh();
	await throttle(CPU);
	// timed INSIDE the page, click to the first frame that shows the menu: Playwright's own round
	// trips to a CPU x6 page cost seconds and would measure the harness
	const menuTime = async () => {
		const ms = await page.evaluate(
			() =>
				new Promise((resolve) => {
					const t0 = performance.now();
					/** @type {HTMLElement} */ (document.querySelector('#logo-menu')).click();
					const poll = () => {
						const m = document.querySelector('#open-templates');
						if (m && m.getBoundingClientRect().height > 0) return resolve(Math.round(performance.now() - t0));
						if (performance.now() - t0 > 8000) return resolve(-1);
						requestAnimationFrame(poll);
					};
					requestAnimationFrame(poll);
				})
		);
		await page.keyboard.press('Escape').catch(() => {});
		await page.locator('#logo-menu').click().catch(() => {});
		await page.waitForTimeout(800);
		return ms;
	};
	await menuTime(); // first open mounts the menu once
	const idleMenu = await menuTime();
	await open(castleUrl);
	await h.eventually(() => page.evaluate(() => !!document.querySelector('#scene-load-bar')), (v) => v, '2.0 (premise) a load is under way (the bar is up)', 30000);
	const menuUp = await menuTime();
	const stillLoading = !!(await sceneState(page, null)).job;
	h.check(menuUp >= 0 && menuUp < Math.max(400, idleMenu * 2) && stillLoading, `2.1 the logo menu opens in ${menuUp} ms while the scene is still loading (${idleMenu} ms with nothing loading; ${stillLoading ? 'still loading' : 'load had ENDED - inconclusive'})`);
	await throttle(1);
	await watch({ marker: 'Castle gate', done: whole }, '2.2 that load still completes');

	// ---- 3. another scene SUPERSEDES the running one --------------------------------------
	await fresh();
	await throttle(CPU);
	await open(castleUrl);
	await h.eventually(() => sceneState(page, null), (s) => !!s.job && s.top > 20 && s.hollow > 20, '3.0 (premise) the castle is half-way in (objects built, models still arriving)', 30000);
	await open(forestUrl);
	await throttle(1);
	await watch({ marker: 'Footbridge', done: whole }, '3.1 the forest opens and finishes');
	await page.waitForTimeout(3500); // the castle's pack files are still landing: none may attach
	const after3 = await sceneState(page, 'Footbridge');
	h.check(after3.forest && !after3.castle, '3.2 no castle piece survived into the forest (castle gate ' + (after3.castle ? 'PRESENT' : 'absent') + ', ' + after3.top + ' objects)');
	h.check(!after3.job && !(await page.locator('#scene-load-bar').count()), '3.3 the bar is gone once the forest is whole');

	// ---- 4. Cancel ------------------------------------------------------------------------
	await fresh();
	await throttle(CPU);
	await open(castleUrl);
	await h.eventually(() => page.evaluate(() => !!document.querySelector('#scene-load-cancel')), (v) => v, '4.0 (premise) the bar offers Cancel while the scene loads', 30000);
	const hit = await page.evaluate(() => {
		const b = /** @type {HTMLElement} */ (document.querySelector('#scene-load-cancel'));
		const r = b.getBoundingClientRect();
		const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return at === b || b.contains(at) ? 'ok' : (at?.id || at?.className || String(at));
	});
	h.check(hit === 'ok', '4.1 Cancel is on top where it is drawn (elementFromPoint: ' + hit + ')');
	await page.locator('#scene-load-cancel').click({ timeout: 5000 });
	await throttle(1);
	await h.eventually(() => sceneState(page, null), (s) => !s.job && s.top === 0, '4.2 Cancel stops the load and takes back what it had added', 20000);
	await page.waitForTimeout(3500);
	const after4 = await sceneState(page, null);
	h.check(after4.top === 0, '4.3 nothing trickles in after the cancel (' + after4.top + ' objects 3.5 s later)');
	const toast = await page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.textContent ?? '').join(' | '));
	h.check(/Stopped loading/.test(toast), '4.4 a toast says the load was stopped');

	// ---- 5. AUTOSAVE writes pristine pieces as stubs --------------------------------------
	await open(castleUrl);
	await watch({ marker: 'Castle gate', done: whole }, '5.0 (premise) the castle is back');
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
	await fresh({ keepRestore: true });
	// EXACTLY 'Restore': on a phone 33-games' quality toast also offers 'Restore full quality'
	const restoreBtn = page.locator('.tp-toast-action', { hasText: /^\s*Restore\s*$/ });
	await h.eventually(() => restoreBtn.count(), (n) => n > 0, '6.0 (premise) the restore prompt is up after the reload', 30000);
	await arm(page);
	await throttle(CPU);
	await restoreBtn.first().click();
	const six = await watch({ marker: 'Castle gate', done: whole }, '6.1 Restore brings the whole castle back on the throttled phone');
	await page.waitForTimeout(1500);
	await throttle(1);
	probe = await disarm(page);
	h.check(six.bars.some((t) => /^Restoring your last session/.test(t)), '6.2 the bar says it is restoring ("' + (six.bars[six.bars.length - 1] ?? 'never shown') + '")');
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
	h.check(six.last?.top === pieces, `6.5 every object is back (${six.last?.top} / ${pieces})`);

	// ---- 7. a scene of ORDINARY objects: the build loop itself is time-sliced --------------
	// The kit levels are references (cheap stubs) — this is the scene they are not: 1000 plain
	// meshes with real vertex data, each parsed, added and announced on its own. Unsliced, that
	// loop is one task (300 and 1200 bare boxes were measured too cheap to tell, 166 ms unsliced).
	await fresh();
	const many = await page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		for (let i = 0; i < 1000; i++) {
			// real vertex data per object (an icosphere: 960 vertices) — parsing is the per-object cost
			const m = new s.THREE.Mesh(new s.THREE.IcosahedronGeometry(0.3, 2), new s.THREE.MeshStandardMaterial({ color: (i * 2654435761) & 0xffffff }));
			m.name = 'box-' + i;
			m.position.set((i % 40) - 20, 0.2, Math.floor(i / 40) - 15);
			g.add(m);
		}
		s.pokeScene();
		const payload = s.sessions.buildSessionPayload('Many boxes');
		window.__manyPayload = payload;
		return payload.objects.length;
	});
	await page.evaluate(() => window.__stores.sceneLoader.cancelLoad());
	await arm(page);
	await throttle(CPU);
	await page.evaluate(() => void window.__stores.sessions.applySession(window.__manyPayload, { backup: false }));
	await h.eventually(() => sceneState(page, null), (s) => s.top === many && !s.job, '7.0 a scene of ' + many + ' ordinary meshes loads', 120000);
	await page.waitForTimeout(1500);
	await throttle(1);
	probe = await disarm(page);
	h.check(probe.max <= LONG_MS, `7.1 no long task over ${LONG_MS} ms while ${many} ordinary objects are built (max ${probe.max} ms of ${probe.longtasks.length})`);
	console.log('   ordinary long tasks: ' + JSON.stringify(probe.longtasks.slice().sort((a, b) => b - a).slice(0, 10)));

	await h.finish(browser);
});
