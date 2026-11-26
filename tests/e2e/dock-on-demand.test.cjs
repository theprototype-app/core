// 102-boot-diet-3 — THE BOTTOM-DOCK EDITORS LOAD ON FIRST OPEN. Animation, UV editor, Shader editor, HUD editor and
// Timeline (~120 KB gz together) left the editor's boot: App mounts each through LazyDockWindow, which loads the body
// the first time the window opens and then keeps it mounted ($lib/lazyPanels.js has the rules). The mesh toolbox
// (MeshEditPopup) rides the same registry, loaded at idle or by the first edit session.
//
// What this suite holds:
//   0. (BUILT) each body is its own chunk, in NEITHER page's static boot closure (play.html, index.html);
//   1. (BUILT) a player never fetches them: `/play` boots, renders, idles, and no editor chunk is requested;
//   2. (BUILT) the editor does NOT prefetch them (it idles 8 s and fetches none), and a first open on a 3G-throttled
//      link shows the window inside 1.5 s (Chrome's "Fast 3G": 562 ms RTT, ~1.4 Mbit/s down) -- the times are printed;
//   3. every way in opens a CLOSED, NEVER-LOADED window and the body mounts: a click (the dock's "+" menu), its key
//      (Alt+A/U/S/H/T), Ctrl+K, and the agent's `show` (Timeline: the one of the five `show` knows). A fresh page per
//      window per route, with the test hook's preload switched off (`debugLazyPanels` = 'cold');
//   4. a window open in the saved layout (auto-restore) comes back after a reload, its placeholder holding the place
//      until the body lands: no frame with NEITHER (the "no empty flash" rule), the frames the placeholder showed
//      printed; and the active-sequence rule holds before the Timeline ever opened.
// Counterfactual (v1.82.0): the five bodies sit in the editor's boot chunks -- 0 and 2's "fetched none" go red.
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

/** a fresh context WITHOUT the debug hooks; every request's path + time */
async function plainPage(browser, query) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
	await ctx.addInitScript(() => {
		try {
			performance.setResourceTimingBufferSize?.(200000);
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
		} catch {
			/* no storage */
		}
	});
	const page = await ctx.newPage();
	/** @type {{path: string, at: number}[]} */
	const requests = [];
	const t0 = Date.now();
	page.on('request', (r) =>
		requests.push({ path: new globalThis.URL(r.url()).pathname, at: Date.now() - t0 })
	);
	const res = await page.goto(h.URL + query, { waitUntil: 'domcontentloaded', timeout: 90000 });
	return { ctx, page, requests, status: res?.status() ?? 0 };
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

		// ---- 2. no prefetch; a 3G first open inside 1.5 s ------------------------------------------------------------
		const E = await plainPage(browser, '');
		check(E.status === 200, `2a the editor answers 200 (${E.status})`);
		await E.page.waitForFunction(() => !!document.querySelector('canvas'), null, {
			timeout: 90000
		});
		await E.page.waitForTimeout(8000);
		const early = E.requests.filter((r) => WINDOWS.some((w) => chunkOf[w.key] === r.path));
		check(
			early.length === 0,
			`2b an idle editor fetches none of the five (${early.map((r) => r.path).join(', ') || 'none'})`
		);
		const cdp = await E.ctx.newCDPSession(E.page);
		await cdp.send('Network.enable');
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 562.5,
			downloadThroughput: 180000,
			uploadThroughput: 84375
		});
		for (const w of WINDOWS) {
			await focusViewport(E.page);
			const t0 = Date.now();
			await E.page.keyboard.press(w.combo);
			let ms = null;
			try {
				await E.page.waitForFunction((s) => s.some((q) => !!document.querySelector(q)), w.body, {
					timeout: 20000,
					polling: 16
				});
				ms = Date.now() - t0;
			} catch {
				/* never appeared: reported below */
			}
			const fetched = E.requests.some((r) => r.path === chunkOf[w.key]);
			console.log(
				`3G first open ${w.key}: ${ms == null ? 'never' : ms + ' ms'} (chunk fetched: ${fetched})`
			);
			check(fetched, `2c ${w.key}: the first open fetched its chunk`);
			check(
				ms != null && ms < 1500,
				`2d ${w.key}: on 3G the window shows inside 1.5 s (${ms == null ? 'never' : ms + ' ms'})`
			);
			await focusViewport(E.page);
			await E.page.keyboard.press(w.combo); // close it again (the body stays mounted)
			await E.page.waitForTimeout(300);
		}
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1
		});
		await E.ctx.close();
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
