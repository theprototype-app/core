// 102-boot-diet-3 — THE BOTTOM-DOCK EDITORS LOAD ON FIRST OPEN. Animation, UV editor, Shader editor, HUD editor and
// Timeline (~120 KB gz together) left the editor's boot: App mounts each through LazyDockWindow, which loads the body
// the first time the window opens and then keeps it mounted ($lib/lazyPanels.js has the rules). The mesh toolbox
// (MeshEditPopup) rides the same registry, loaded at idle or by the first edit session.
//
// What this suite holds:
//   0. (BUILT) each body is its own chunk, in NEITHER page's static boot closure (play.html, index.html);
//   1. (BUILT) a player never fetches them: `/play` boots, renders, idles, and no editor chunk is requested;
//   2. (BUILT) the IDLE PREFETCH (claude:9's Q3 = b, $lib/panelPrefetch.js): it fetches the five after the page's load
//      event and first paint and mounts nothing (2b); prefetched, a first open on 3G (Chrome's "Fast 3G": 562 ms RTT,
//      ~1.4 Mbit/s) fetches nothing and its load + mount (the loader's performance marks) is under 1.5 s (2c, 2d);
//      COLD (prefetch off) the open's times are printed, not gated (2e); Save-Data / 2g / slow-2g skip it (2f); blocked
//      chunks make the prefetch fail SILENTLY and every editor's first open still loads (2g);
//   3. every way in opens a CLOSED, NEVER-LOADED window and the body mounts: a click (the dock's "+" menu), its key
//      (Alt+A/U/S/H/T), Ctrl+K, and the agent's `show` (Timeline: the one of the five `show` knows). A fresh page per
//      window per route, with the test hook's preload switched off (`debugLazyPanels` = 'cold');
//   4. a window open in the saved layout (auto-restore) comes back after a reload, its placeholder holding the place
//      until the body lands: no frame with NEITHER (the "no empty flash" rule), the frames the placeholder showed
//      printed; and the active-sequence rule holds before the Timeline ever opened.
// Counterfactual (v1.82.0): the five bodies sit in the editor's boot chunks -- 0, 2b and 2e go red.
// Dev server: 0-2 SKIP (a dev server serves modules, not chunks); 3-4 run.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const { check } = h;
const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = path.join(ROOT, '.svelte-kit/output/client/.vite/manifest.json');

const WINDOWS = [
	{
		key: 'animation',
		src: 'src/components/editors/AnimationWindow.svelte',
		title: 'Animation',
		combo: 'Alt+A',
		close: 'animationClose',
		body: ['#animation-dock', '#animation-window']
	},
	{
		key: 'uv',
		src: 'src/components/editors/UvEditor.svelte',
		title: 'UV editor',
		combo: 'Alt+U',
		close: 'uvEditorClose',
		body: ['#uv-dock', '#uv-window']
	},
	{
		key: 'shader',
		src: 'src/components/editors/ShaderEditor.svelte',
		title: 'Shader editor',
		combo: 'Alt+S',
		close: 'shaderEditorClose',
		body: ['#shader-editor', '#shader-window']
	},
	{
		key: 'hud',
		src: 'src/components/editors/HudEditor.svelte',
		title: 'HUD editor',
		combo: 'Alt+H',
		close: 'hudEditorClose',
		body: ['#hud-dock', '#hud-window']
	},
	{
		key: 'timeline',
		src: 'src/components/editors/TimelineEditor.svelte',
		title: 'Timeline',
		combo: 'Alt+T',
		close: 'timelineClose',
		body: ['#timeline-dock', '#timeline-window'],
		show: 'Timeline'
	}
];
const TOOLBOX_SRC = 'src/components/menu/MeshEditPopup.svelte';
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

/**
 * a fresh context WITHOUT the debug hooks; every request's path + time.
 * opts.storage: localStorage entries before the first script; opts.connection: a `navigator.connection` to report;
 * opts.block: paths whose requests are aborted (until `unblock()`)
 * @param {any} browser @param {string} query @param {{storage?: Record<string, string>, connection?: any, block?: string[]}} [opts]
 */
async function plainPage(browser, query, opts = {}) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
	await ctx.addInitScript(
		([storage, connection]) => {
			try {
				performance.setResourceTimingBufferSize?.(200000);
				localStorage.setItem('hasSeenDisclaimer', 'true');
				localStorage.setItem('hasSeenWelcome', 'true');
				for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
			} catch {
				/* no storage */
			}
			if (connection)
				Object.defineProperty(Navigator.prototype, 'connection', {
					configurable: true,
					get: () => connection
				});
		},
		[opts.storage ?? {}, opts.connection ?? null]
	);
	/** @type {string[]} */
	const aborted = [];
	let blocking = !!opts.block?.length;
	if (blocking)
		await ctx.route('**/*.js', (route) => {
			const p = new globalThis.URL(route.request().url()).pathname;
			if (blocking && opts.block?.includes(p)) {
				aborted.push(p);
				return route.abort('failed');
			}
			return route.continue();
		});
	const unblock = () => (blocking = false);
	const page = await ctx.newPage();
	/** @type {{path: string, at: number}[]} */
	const requests = [];
	const t0 = Date.now();
	page.on('request', (r) =>
		requests.push({ path: new globalThis.URL(r.url()).pathname, at: Date.now() - t0 })
	);
	const res = await page.goto(h.URL + query, { waitUntil: 'domcontentloaded', timeout: 90000 });
	return { ctx, page, requests, aborted, unblock, status: res?.status() ?? 0 };
}

/** is any of the body selectors in the DOM? (docked behind another tab still counts: it is mounted) */
const bodyMounted = (page, sels) =>
	page.evaluate((s) => s.some((q) => !!document.querySelector(q)), sels);

/** focus the viewport (keys and Ctrl+K are global, a text field would swallow them) */
async function focusViewport(page) {
	const c = await page.evaluate(() => {
		const el = document.querySelector('canvas:not([style*="display: none"])');
		const r = el?.getBoundingClientRect();
		return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
	});
	if (c) await page.mouse.click(c.x, c.y);
}

h.run(async () => {
	const html = await new Promise((resolve) => {
		const mod = h.URL.startsWith('https:') ? require('https') : require('http');
		mod
			.get(h.URL, { rejectUnauthorized: false }, (res) => {
				let body = '';
				res.on('data', (c) => (body += c));
				res.on('end', () => resolve(body));
			})
			.on('error', () => resolve(''));
	});
	const built =
		/_app\/immutable\//.test(html) && !/@vite\/client/.test(html) && fs.existsSync(MANIFEST);
	const browser = await h.launch();

	if (!built)
		console.log(
			'SKIP 0-2: not a built app (npm run build, then serve it with scripts/serve-build.cjs)'
		);
	else {
		// ---- 0. the build -------------------------------------------------------------------------------------
		const bs = require('../../scripts/boot-size.cjs');
		const m = bs.loadManifest();
		const pages = Object.fromEntries(
			[
				['play', 'play.html'],
				['editor', 'index.html']
			].map(([n, f]) => [n, bs.measurePage(f, m)])
		);
		/** @type {Record<string, string>} key -> '/' + chunk file */
		const chunkOf = {};
		for (const w of [...WINDOWS, { key: 'meshToolbox', src: TOOLBOX_SRC }]) {
			const file = m.m[w.src]?.file;
			check(
				!!file && fs.existsSync(path.join(ROOT, 'build', file)),
				`0a ${w.key}: its body is a chunk of its own in build/ (${file})`
			);
			for (const [name, r] of Object.entries(pages))
				check(
					!!file && !(file in r.chunks),
					`0b ${w.key}: the ${name} page's boot does not carry it (${Object.keys(r.chunks).length} chunks, ${(r.jsGz / 1024).toFixed(1)} KB gz)`
				);
			if (file) chunkOf[w.key] = '/' + file;
		}

		// ---- 1. a player never fetches them ------------------------------------------------------------------------
		const P = await plainPage(browser, 'play');
		check(P.status === 200, `1a /play answers 200 (${P.status})`);
		await P.page.waitForFunction(() => !!window.tpPlay, null, { timeout: 90000 });
		const ready = await P.page.evaluate(() =>
			Promise.race([
				window.tpPlay.ready.then(() => true),
				new Promise((r) => setTimeout(() => r(false), 90000))
			])
		);
		check(ready, '1b /play renders a first frame');
		await P.page.waitForTimeout(8000); // past any idle callback
		const editorChunks = new Set(Object.values(chunkOf));
		const playHits = P.requests.filter((r) => editorChunks.has(r.path));
		check(
			playHits.length === 0,
			`1c /play never fetched an editor panel (${playHits.map((r) => r.path).join(', ') || 'none'} in ${P.requests.length} requests)`
		);
		await P.ctx.close();

		// ---- 2. the idle prefetch (Q3 = b) and the 3G first open -----------------------------------------------------
		const FAST_3G = {
			offline: false,
			latency: 562.5,
			downloadThroughput: 180000,
			uploadThroughput: 84375
		};
		const five = WINDOWS.map((w) => chunkOf[w.key]);
		const prefetchDone = (page, ms = 90000) =>
			page
				.waitForFunction(
					() => performance.getEntriesByName('lazy-panel:prefetch:done').length > 0,
					null,
					{ timeout: ms }
				)
				.then(
					() => true,
					() => false
				);
		const readMarks = (page, key) =>
			page.evaluate((k) => {
				const at = (/** @type {string} */ w) =>
					performance.getEntriesByName(`lazy-panel:${k}:${w}`)[0]?.startTime ?? null;
				return { start: at('start'), loaded: at('loaded'), mounted: at('mounted') };
			}, key);
		/** open each window on a 3G link, report key -> window and the loader's start -> mounted @returns {Promise<Record<string, {ms: number|null, lazyMs: number|null, fetched: boolean}>>} */
		const openAll3g = async (P) => {
			const cdp = await P.ctx.newCDPSession(P.page);
			await cdp.send('Network.enable');
			await cdp.send('Network.emulateNetworkConditions', FAST_3G);
			/** @type {Record<string, any>} */
			const out = {};
			for (const w of WINDOWS) {
				const before = P.requests.length;
				await focusViewport(P.page);
				const t0 = Date.now();
				await P.page.keyboard.press(w.combo);
				const ms = await P.page
					.waitForFunction((s) => s.some((q) => !!document.querySelector(q)), w.body, {
						timeout: 20000,
						polling: 16
					})
					.then(
						() => Date.now() - t0,
						() => null
					);
				const m = await readMarks(P.page, w.key);
				const lazyMs =
					m.start != null && m.mounted != null ? Math.round(m.mounted - m.start) : null;
				out[w.key] = {
					ms,
					lazyMs,
					fetched: P.requests.slice(before).some((r) => r.path === chunkOf[w.key])
				};
				await focusViewport(P.page);
				await P.page.keyboard.press(w.combo); // close it again (the body stays mounted)
				await P.page.waitForTimeout(300);
			}
			await cdp.send('Network.emulateNetworkConditions', {
				offline: false,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1
			});
			return out;
		};

		// 2a-2d: the prefetch starts after the page's load event, fetches the five, mounts nothing; then a 3G open is warm
		const W = await plainPage(browser, '');
		check(W.status === 200, `2a the editor answers 200 (${W.status})`);
		check(await prefetchDone(W.page), '2b the idle prefetch ran to its end');
		const pf = await W.page.evaluate((paths) => {
			const nav = /** @type {any} */ (performance.getEntriesByType('navigation')[0]);
			const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
			const res = performance
				.getEntriesByType('resource')
				.filter((e) => paths.includes(new URL(e.name).pathname));
			return {
				loadEnd: nav?.loadEventEnd ?? null,
				fcp,
				starts: res.map((e) => Math.round(e.startTime)),
				count: res.length
			};
		}, five);
		check(pf.count === five.length, `2b ...and fetched all five chunks (${pf.count})`);
		check(
			pf.loadEnd != null &&
				pf.fcp != null &&
				pf.starts.every((t) => t >= pf.loadEnd && t >= pf.fcp),
			`2b ...every one after the load event and the first paint (load ${Math.round(pf.loadEnd ?? -1)} ms, fcp ${Math.round(pf.fcp ?? -1)} ms, fetches at ${pf.starts.join(', ')} ms)`
		);
		const mountedEarly = [];
		for (const w of WINDOWS) if (await bodyMounted(W.page, w.body)) mountedEarly.push(w.key);
		check(
			mountedEarly.length === 0,
			`2b ...and mounted nothing (${mountedEarly.join(', ') || 'none mounted'})`
		);
		const warm = await openAll3g(W);
		for (const w of WINDOWS) {
			const r = warm[w.key];
			console.log(
				`3G WARM first open ${w.key} (prefetched): key -> window ${r.ms ?? 'never'} ms; load start -> body mounted ${r.lazyMs ?? '?'} ms; chunk fetched again: ${r.fetched}`
			);
			check(
				r.ms != null && !r.fetched,
				`2c ${w.key}: a prefetched editor opens on 3G without a fetch (${r.ms ?? 'never'} ms from the key)`
			);
			check(
				r.lazyMs != null && r.lazyMs < 1500,
				`2d ${w.key}: prefetched, the first open's load + mount is under 1.5 s on 3G (${r.lazyMs ?? '?'} ms)`
			);
		}
		check(
			!(await W.page.evaluate(() => /A new version is ready/.test(document.body.innerText))),
			'2d no reload notice'
		);
		await W.ctx.close();

		// 2e: COLD -- opened before any prefetch (switched off for the measurement): numbers, not a gate
		const C = await plainPage(browser, '', { storage: { debugPanelPrefetch: 'off' } });
		await C.page.waitForFunction(() => !!document.querySelector('canvas'), null, {
			timeout: 90000
		});
		await C.page.waitForTimeout(8000);
		const early = C.requests.filter((r) => five.includes(r.path));
		check(
			early.length === 0,
			`2e with the prefetch off an idle editor fetches none of the five (${early.map((r) => r.path).join(', ') || 'none'})`
		);
		const cold = await openAll3g(C);
		for (const w of WINDOWS) {
			const r = cold[w.key];
			console.log(
				`3G COLD first open ${w.key} (no prefetch): key -> window ${r.ms ?? 'never'} ms; load start -> body mounted ${r.lazyMs ?? '?'} ms (chunk fetched: ${r.fetched})`
			);
			check(
				r.ms != null && r.fetched,
				`2e ${w.key}: cold, the first open fetches its chunk and shows (${r.ms ?? 'never'} ms; a number, not a gate)`
			);
		}
		await C.ctx.close();

		// 2f: not on Save-Data, not on a 2G-class link
		for (const [label, connection] of [
			['Save-Data', { saveData: true, effectiveType: '4g' }],
			['2g', { saveData: false, effectiveType: '2g' }],
			['slow-2g', { effectiveType: 'slow-2g' }]
		]) {
			const S = await plainPage(browser, '', { connection });
			await S.page.waitForFunction(() => !!document.querySelector('canvas'), null, {
				timeout: 90000
			});
			await S.page.waitForFunction(() => document.readyState === 'complete', null, {
				timeout: 90000
			});
			await S.page.waitForTimeout(14000); // past the idle callbacks and their 10 s timeout
			const hits = S.requests.filter((r) => five.includes(r.path));
			check(
				hits.length === 0,
				`2f ${label}: no prefetch (${hits.map((r) => r.path).join(', ') || 'none fetched'})`
			);
			await S.ctx.close();
		}

		// 2g: a prefetch whose chunks fail is SILENT, and every editor's first open still loads it
		const X = await plainPage(browser, '', { block: five });
		check(await prefetchDone(X.page), '2g the prefetch ends even when every chunk fails');
		const tried = five.filter((p) => X.aborted.includes(p));
		check(tried.length === five.length, `2g ...it tried all five (${tried.length})`);
		check(
			!(await X.page.evaluate(() => /A new version is ready/.test(document.body.innerText))),
			'2g ...and said nothing (no "A new version is ready" notice)'
		);
		X.unblock();
		for (const w of WINDOWS) {
			await focusViewport(X.page);
			await X.page.keyboard.press(w.combo);
			const ok = await X.page
				.waitForFunction((s) => s.some((q) => !!document.querySelector(q)), w.body, {
					timeout: 20000
				})
				.then(
					() => true,
					() => false
				);
			check(ok, `2g ${w.key}: after the failed prefetch, the first open loads and shows it`);
			await focusViewport(X.page);
			await X.page.keyboard.press(w.combo);
			await X.page.waitForTimeout(300);
		}
		check(
			!(await X.page.evaluate(() => /A new version is ready/.test(document.body.innerText))),
			'2g ...and the opens raised no notice either'
		);
		await X.ctx.close();
	}

	// ---- 3. every way in, on a closed never-loaded window --------------------------------------------------------
	const A = await h.setupPage(browser, 'A', { storage: { debugLazyPanels: 'cold' } });
	const loadedNow = (key) =>
		A.page.evaluate(
			`(${read})(window.__tp.test.v1.lazyPanels.lazyPanels)[${JSON.stringify(key)}] != null`
		);
	const isOpen = (w) => A.page.evaluate(`(${read})(window.__tp.test.v1.${w.close}) === false`);
	check(
		!(await loadedNow('animation')) && !(await loadedNow('timeline')),
		'3a premise: the cold test page has loaded none of them'
	);
	await A.page.evaluate(() =>
		window.__tp.test.v1.safeStorage.setItem('show:allow:panel', 'always')
	);
	const ROUTES = {
		key: async (w) => {
			await focusViewport(A.page);
			await A.page.keyboard.press(w.combo);
		},
		click: async (w) => {
			// the dock's "+" lists every view: open the node editor so the strip is there, then pick the window
			await A.page.evaluate(() => window.__tp.test.v1.flowGraphClose.set(false));
			await A.page.waitForSelector('#dock-add-view', { timeout: 15000 });
			await A.page.evaluate(() => document.querySelector('#dock-add-view')?.click());
			await A.page.waitForTimeout(400);
			const hit = await A.page.evaluate((title) => {
				const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((el) =>
					(el.textContent ?? '').trim().startsWith(title)
				);
				item?.click();
				return !!item;
			}, w.title);
			if (!hit) console.log(`(the "+" menu has no row for ${w.title})`);
		},
		palette: async (w) => {
			await focusViewport(A.page);
			await A.page.keyboard.press('Control+K');
			await A.page.waitForSelector('#command-palette-input', { timeout: 10000 });
			await A.page.keyboard.type(w.title);
			await A.page.waitForTimeout(300);
			const hit = await A.page.evaluate((key) => {
				const item = document.querySelector(`#command-palette [data-command="window:${key}"]`);
				if (item) /** @type {HTMLElement} */ (item).click();
				return !!item;
			}, w.key);
			if (!hit) console.log(`(Ctrl+K lists no window:${w.key} row for "${w.title}")`);
		},
		show: async (w) => {
			await A.page.evaluate(
				(name) => window.__tp.test.v1.showTool.showTool({ action: 'panel', name, state: 'open' }),
				w.show
			);
		}
	};
	for (const w of WINDOWS) {
		for (const route of Object.keys(ROUTES)) {
			if (route === 'show' && !w.show) continue;
			await h.freshReload(A);
			await A.page.waitForTimeout(500);
			if (await loadedNow(w.key)) {
				check(
					false,
					`3b ${w.key} by ${route}: premise failed, the body was already loaded before the open`
				);
				continue;
			}
			await ROUTES[route](w);
			let mounted = false;
			try {
				await A.page.waitForFunction((s) => s.some((q) => !!document.querySelector(q)), w.body, {
					timeout: 20000
				});
				mounted = true;
			} catch {
				/* reported */
			}
			const open = await isOpen(w);
			check(
				open && mounted && (await loadedNow(w.key)),
				`3b ${w.key} by ${route}: opens and its body mounts (open ${open}, mounted ${mounted})`
			);
			await A.page.evaluate((c) => window.__tp.test.v1[c].set(true), w.close);
			await A.page.waitForTimeout(250);
			check(
				(await bodyMounted(A.page, w.body)) || (await loadedNow(w.key)),
				`3c ${w.key} by ${route}: closed again, the body stays loaded`
			);
		}
	}
	check(
		!A.page.__errors?.length,
		`3d no page errors (${(A.page.__errors ?? []).slice(0, 2).join(' | ')})`
	);
	await h.closePeer(A);

	// ---- 4. reload with them open (auto-restore), and the active-sequence rule before any open -------------------
	const sampler = () => {
		// every frame: which of placeholder / body each panel shows (body ids, the placeholder's data attribute)
		const BODY = {
			animation: ['#animation-dock', '#animation-window'],
			uv: ['#uv-dock', '#uv-window'],
			shader: ['#shader-editor', '#shader-window'],
			hud: ['#hud-dock', '#hud-window'],
			timeline: ['#timeline-dock', '#timeline-window']
		};
		/** @type {Record<string, {holder: number, gap: number, seen: boolean, body: boolean}>} */
		const s = {};
		for (const k of Object.keys(BODY)) s[k] = { holder: 0, gap: 0, seen: false, body: false };
		window.__dockFrames = s;
		const tick = () => {
			for (const [k, sels] of Object.entries(BODY)) {
				const r = s[k];
				if (r.body) continue;
				const body = sels.some((q) => !!document.querySelector(q));
				const holder = !!document.querySelector(`[data-lazy-panel="${k}"]`);
				if (body) r.body = true;
				else if (holder) {
					r.seen = true;
					r.holder++;
				} else if (r.seen) r.gap++;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	};
	const B = await h.setupPage(browser, 'B', {
		storage: { debugLazyPanels: 'cold' },
		init: sampler
	});
	await B.page.evaluate(async (wins) => {
		const w = window.__tp.test.v1;
		w.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		// a floating window for each except the Timeline, which stays docked (the dock's placeholder is the case to see)
		for (const x of wins)
			w.safeStorage.setItem(x.key + 'Docked', x.key === 'timeline' ? 'true' : 'false');
		for (const x of wins) w[x.close].set(false);
		await new Promise((r) => setTimeout(r, 1500));
		await w.autosave.saveNow();
		w.autosave.autoRestoreEnabled.set(true);
	}, WINDOWS);
	await B.page.waitForTimeout(600);
	await h.freshReload(B);
	const back = await B.page
		.waitForFunction(
			(wins) => wins.every((x) => x.body.some((q) => !!document.querySelector(q))),
			WINDOWS,
			{ timeout: 30000 }
		)
		.then(
			() => true,
			() => false
		);
	check(back, '4a after a reload with auto-restore, all five windows are back with their bodies');
	const frames = await B.page.evaluate(() => window.__dockFrames);
	for (const w of WINDOWS) {
		const f = frames?.[w.key];
		console.log(
			`restore ${w.key}: placeholder ${f?.holder ?? '?'} frame(s) before the body, gap ${f?.gap ?? '?'}`
		);
		check(
			!!f && f.gap === 0,
			`4b ${w.key}: no frame with neither the placeholder nor the body once it was shown (gap ${f?.gap})`
		);
	}
	// the active-sequence rule (it lived in the Timeline; now sequences.keepActiveSequence): a fresh cold page
	await B.page.evaluate((wins) => {
		for (const x of wins) window.__tp.test.v1[x.close].set(true);
		window.__tp.test.v1.autosave.autoRestoreEnabled.set(false);
	}, WINDOWS);
	await h.freshReload(B);
	const seq = await B.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const r = (s) => {
			let v;
			s.subscribe((x) => (v = x))();
			return v;
		};
		const sq = w.sequences;
		if (!sq?.createSequence) return { skip: true };
		const before = r(w.lazyPanels.lazyPanels).timeline != null;
		const id = sq.createSequence('Shot A');
		sq.activeSequence.set('gone-id');
		await new Promise((res) => setTimeout(res, 100));
		return { before, id, active: r(sq.activeSequence) };
	});
	if (seq.skip) console.log('SKIP 4c: no sequences hook on this page');
	else
		check(
			!seq.before && seq.active === seq.id,
			`4c before the Timeline ever loaded, a vanished active sequence falls back to the first (${JSON.stringify(seq)})`
		);
	check(
		!B.page.__errors?.length,
		`4d no page errors (${(B.page.__errors ?? []).slice(0, 2).join(' | ')})`
	);
	await h.closePeer(B);
	await h.finish(browser);
});
