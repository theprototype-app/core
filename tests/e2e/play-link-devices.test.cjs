// fix-play-link — THE PLAY LINK ON REAL-DEVICE SHAPES (device lab 2026-11-05: Quest 3, folded N6, HONOR).
// `/play` is what a `/p/<id>` play link frames. What this suite holds, each against the bug it found:
//   A. phone FOLDED (384 px, touch): the page is styled (no serif, kit tokens resolve) and so is the
//      "This scene uses modules" ask; a module the official repo does not list is still asked about,
//      and "Load anyway" is remembered for that module + version (the next visit does not ask);
//   B. a module the OFFICIAL repo lists installs without the ask, and the next visit restores it from
//      this device at boot (the gallery is unreachable on visit 2 — the module still loads, no ask);
//   C. a HEADSET (IWER Quest 3): the play=1 autoplay (cloudApi.startPlay) does NOT go flat; the start
//      card stays with Enter VR FIRST, and Enter VR opens a real XR session (the play page now mounts the
//      hidden XR buttons — before, Enter VR on a play link fell through to flat play); leaving VR brings
//      the card back. A flat desktop still autoplays;
//   D. tpPlay.state leaves 'loading' when the page is let into a session (a joiner's own load is refused);
//   E. a joining camera steps clear of another player's avatar standing on the spawn;
//   F. a centred HUD menu wider than the folded phone shrinks to fit; unfolded it keeps its size.
//
// Counterfactual (base v1.62.0): A styled/remember, B no-ask/restore, C no-flat/VR-first/session, D, E, F are
// red there (see the handover for the run).
//
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout's games/.
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const fs = require('fs');
const path = require('path');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');

const { check } = h;
const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const sceneOf = (/** @type {string} */ slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, slug, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const SLUG = process.env.PLAY_SLUG || 'sky-run';
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

const FOLDED = { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const UNFOLDED = { viewport: { width: 820, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

// a real module the mocked gallery serves (manifest at the zip root, the template-modules precedent)
const MOD = { id: 'gizmomod', version: '2.1.0' };
const MODULE_JS = [
	'export default {',
	`  id: '${MOD.id}', name: 'Gizmo Module', version: '${MOD.version}', description: 'mocked gallery module',`,
	"  register(api) { api.registerNodeGroup({ group: 'Gizmo', items: [{ type: 'gizmoknob', label: 'Gizmo knob', params: [] }] }); api.registerEffect('gizmoknob', () => {}); }",
	'};'
].join('\n');
const MANIFEST = JSON.stringify({ id: MOD.id, name: 'Gizmo Module', version: MOD.version, format: 1, entry: 'module.js', files: ['module.js'] });

/** the scene file with `modules` naming the mocked module @param {string} file */
function withModule(file) {
	const files = unzipSync(fs.readFileSync(file));
	const session = JSON.parse(strFromU8(files['session.json']));
	session.modules = [{ id: MOD.id, version: MOD.version }];
	files['session.json'] = strToU8(JSON.stringify(session));
	return Buffer.from(zipSync(files));
}

/**
 * A /play page. `gallery`: 'official' lists the module, 'empty' lists nothing, 'down' fails every request.
 * Records whether the modules ask ever appeared (`window.__askSeen`), from the first frame.
 */
async function playPage(browser, name, opts = {}) {
	const ctx = opts.ctx ?? (await browser.newContext({ ignoreHTTPSErrors: true, ...(opts.context ?? {}) }));
	if (!opts.ctx) {
		await ctx.addInitScript(() => {
			try {
				localStorage.setItem('debugStores', 'true');
				localStorage.setItem('hasSeenDisclaimer', 'true');
				localStorage.setItem('hasSeenWelcome', 'true');
			} catch {
				/* no storage */
			}
			window.__askSeen = false;
			new MutationObserver(() => {
				if (!window.__askSeen && document.body && /This scene uses modules/.test(document.body.innerText || '')) window.__askSeen = true;
			}).observe(document, { childList: true, subtree: true });
		});
		if (opts.init) await ctx.addInitScript(opts.init);
		const plain = sceneOf(SLUG);
		const modded = withModule(plain);
		await ctx.route('**/e2e-scenes/*.tpscene', (route) =>
			route.fulfill({ status: 200, contentType: 'application/octet-stream', body: route.request().url().includes('-mod.tpscene') ? modded : fs.readFileSync(plain) })
		);
		ctx.__gallery = opts.gallery ?? 'empty';
		await ctx.route('**/cdn.jsdelivr.net/**', (route) => {
			const url = route.request().url();
			if (!url.includes('/theprototype-app/modules@')) return route.continue();
			if (ctx.__gallery === 'down') return route.abort('failed');
			if (url.endsWith('/index.json'))
				return route.fulfill({ json: ctx.__gallery === 'official' ? [{ id: MOD.id, name: 'Gizmo Module', version: MOD.version, author: 'theprototype-app', source: `modules/${MOD.id}`, zip: `${MOD.id}.zip` }] : [] });
			if (url.endsWith(`/modules/${MOD.id}/manifest.json`)) return route.fulfill({ body: MANIFEST, contentType: 'application/json' });
			if (url.endsWith(`/modules/${MOD.id}/module.js`)) return route.fulfill({ body: MODULE_JS, contentType: 'text/javascript' });
			return route.continue();
		});
	}
	const page = await ctx.newPage();
	page.__errors = [];
	page.on('pageerror', (e) => {
		page.__errors.push(e.message);
		console.log(`[${name} pageerror] ${e.message}`);
	});
	if (opts.query != null) await page.goto(h.URL + opts.query, { waitUntil: 'domcontentloaded', timeout: 90000 });
	return { ctx, page };
}
const loadedOf = (page, ms = 120000) => page.evaluate((ms) => Promise.race([window.tpPlay.loaded, new Promise((r) => setTimeout(() => r('timeout'), ms))]), ms);
const waitApi = (page) => page.waitForFunction(() => !!window.tpPlay && !!window.__stores?.moduleSDK, null, { timeout: 90000 });
const locked = (page) => page.evaluate((r) => eval(r)(window.__stores.isLocked), read);

h.run(async () => {
	const browser = await h.launch();
	if (!sceneOf(SLUG)) {
		console.log(`SKIP: no ${SLUG} scene (SHELL_SCENES_DIR or a sibling scenes checkout)`);
		check(false, `the ${SLUG} scene is available to the suite`);
		return h.finish(browser);
	}
	const plainQ = `play?scene=${encodeURIComponent(`/e2e-scenes/${SLUG}.tpscene`)}`;
	const modQ = `play?scene=${encodeURIComponent(`/e2e-scenes/${SLUG}-mod.tpscene`)}`;

	// ------------------------------------------------------------- A. folded phone: styled + remembered
	const A = await playPage(browser, 'A', { context: FOLDED, gallery: 'empty', query: modQ });
	await waitApi(A.page);
	const ask = A.page.locator('#confirm-dialog-anyway');
	await ask.waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
	const styled = await A.page.evaluate(() => {
		const font = (el) => (el ? getComputedStyle(el).fontFamily : '');
		const dialog = document.querySelector('#confirm-dialog-anyway')?.closest('.md, [role="dialog"]');
		const btn = document.querySelector('#confirm-dialog-anyway');
		return {
			body: font(document.body),
			dialog: font(dialog),
			dialogBg: dialog ? getComputedStyle(dialog).backgroundColor : '',
			btnBorder: btn ? getComputedStyle(btn).borderTopStyle + ' ' + getComputedStyle(btn).borderRadius : '',
			token: getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim(),
			card: !!document.querySelector('#embed-start')
		};
	});
	console.log('A styles', JSON.stringify(styled));
	const serif = (f) => /^\s*("?Times|serif|Georgia)/i.test(f) || f === '';
	check(await ask.isVisible(), 'A: a module the official repo does not list is asked about (Load anyway visible)');
	check(!serif(styled.body) && !serif(styled.dialog), `A: page + ask are not the default serif (body "${styled.body.slice(0, 40)}", dialog "${styled.dialog.slice(0, 40)}")`);
	check(!!styled.token && styled.dialogBg !== 'rgba(0, 0, 0, 0)' && styled.dialogBg !== '', `A: kit tokens resolve and the ask has a surface (--surface-1 "${styled.token}", bg ${styled.dialogBg})`);
	await ask.click().catch(() => {});
	check((await loadedOf(A.page)) === true, 'A: Load anyway loads the scene');
	const v2 = await playPage(browser, 'A2', { ctx: A.ctx, query: modQ });
	await waitApi(v2.page);
	const v2loaded = await loadedOf(v2.page);
	const v2ask = await v2.page.evaluate(() => window.__askSeen);
	check(v2loaded === true && v2ask === false, `A: the next visit does not ask again for the same version (loaded ${v2loaded}, asked ${v2ask})`);
	await v2.page.close();

	// ------------------------------------------------------------- F. folded: a centred menu fits
	const fitOf = async (page) => {
		await page.evaluate(() => {
			window.__stores.hudDocs.setHudDocFor('scene', {
				active: 'fit',
				screens: [{ id: 'fit', name: 'Fit', elements: [{ id: 'fit-panel', kind: 'panel', anchor: 'center', x: 0, y: 20, w: 640, h: 520, z: 0, style: {} }, { id: 'fit-text', kind: 'text', label: 'Carry pieces from the racks to the glowing zone and build up to the gold ring.', wrap: true, anchor: 'center', x: 0, y: -154, w: 580, h: 44, z: 1, style: { size: 13 } }] }]
			});
			window.__stores.playMode.requestPlay({ flat: true });
		});
		await h.eventually(() => locked(page), (v) => v === true, 'F: in play', 20000);
		await page.waitForTimeout(1500); // the fit is measured twice a second
		return page.evaluate(() => {
			const r = document.querySelector('[data-hud-id="fit-panel"]')?.getBoundingClientRect();
			return r ? { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), vw: innerWidth } : null;
		});
	};
	const foldFit = await fitOf(A.page);
	console.log('F folded', JSON.stringify(foldFit));
	check(!!foldFit && foldFit.left >= 0 && foldFit.right <= foldFit.vw, `F: folded (${foldFit?.vw} px): the 640 px menu fits (${foldFit?.left}..${foldFit?.right})`);
	check(A.page.__errors.length === 0, `A: no page errors (${A.page.__errors.slice(0, 2).join(' | ')})`);
	await A.ctx.close();
	const U = await playPage(browser, 'U', { context: UNFOLDED, query: plainQ });
	await waitApi(U.page);
	await loadedOf(U.page);
	const unfoldFit = await fitOf(U.page);
	console.log('F unfolded', JSON.stringify(unfoldFit));
	check(!!unfoldFit && unfoldFit.width === 640, `F: unfolded (${unfoldFit?.vw} px): the menu keeps its authored 640 px (${unfoldFit?.width})`);
	const startFont = await U.page.evaluate(() => {
		window.__stores.playMode.exitPlay();
		return new Promise((r) => setTimeout(() => r(getComputedStyle(document.querySelector('#embed-hint, .embed-access') ?? document.body).fontFamily), 800));
	});
	check(!serif(startFont), `F: the start card text is not serif on the unfolded phone ("${String(startFont).slice(0, 40)}")`);
	await U.ctx.close();

	// ------------------------------------------------------------- B. official module: no ask, restored
	const B = await playPage(browser, 'B', { gallery: 'official', query: modQ });
	await waitApi(B.page);
	const bLoaded = await loadedOf(B.page);
	const bState = await B.page.evaluate(() => ({ asked: window.__askSeen, mods: window.__stores.moduleSDK.loadedModules.map((m) => m.id) }));
	check(bLoaded === true && !bState.asked && bState.mods.includes(MOD.id), `B: an official module installs without the ask (asked ${bState.asked}, loaded ${bState.mods.includes(MOD.id)})`);
	B.ctx.__gallery = 'down';
	const B2 = await playPage(browser, 'B2', { ctx: B.ctx, query: modQ });
	await waitApi(B2.page);
	const b2Loaded = await loadedOf(B2.page);
	const b2 = await B2.page.evaluate(() => ({ asked: window.__askSeen, mods: window.__stores.moduleSDK.loadedModules.map((m) => m.id) }));
	check(b2Loaded === true && !b2.asked && b2.mods.includes(MOD.id), `B: the next visit restores it from this device with the gallery down (asked ${b2.asked}, loaded ${b2.mods.includes(MOD.id)})`);
	await B.ctx.close();

	// ------------------------------------------------------------- C. headset: no flat autoplay, Enter VR first
	const C = await playPage(browser, 'C', { init: iwer.initScript(), query: plainQ });
	await waitApi(C.page);
	check(await iwer.installed(C.page), 'C: IWER owns navigator.xr (Quest 3)');
	await loadedOf(C.page);
	// the plugin's play=1 calls cloudApi.startPlay, which is playMode.autoPlay (the seam is primed only
	// when a plugin loads — a dev server has none), so the suite drives autoPlay itself
	const cAuto = await C.page.evaluate(() => (window.__stores.playMode.autoPlay ?? (() => (window.__stores.playMode.requestPlay({ flat: true }), 'base: requestPlay flat')))());
	console.log('C autoPlay returned', cAuto);
	await C.page.waitForTimeout(3500);
	const cv = await C.page.evaluate((r) => ({
		locked: eval(r)(window.__stores.isLocked),
		card: !!document.querySelector('#embed-start'),
		first: document.querySelector('.embed-actions button')?.id ?? null,
		vrButton: !!document.querySelector('#vrButtonVr button')
	}), read);
	console.log('C after autoplay', JSON.stringify(cv));
	check(cv.locked !== true && cv.card, `C: the play=1 autoplay does not go flat on a headset; the start card stays (locked ${cv.locked})`);
	check(cv.first === 'embed-vr', `C: Enter VR is the first button on the card (${cv.first})`);
	check(cv.vrButton, 'C: the play page mounts the hidden XR button Enter VR presses');
	await C.page.click('#embed-vr', { timeout: 5000 }).catch(() => console.log('C: no #embed-vr to press'));
	let st = await iwer.state(C.page);
	for (let i = 0; i < 100 && !st.presenting; i++) {
		await C.page.waitForTimeout(150);
		st = await iwer.state(C.page);
	}
	check(st.presenting && st.mode === 'immersive-vr' && st.same, `C: Enter VR opens a real immersive-vr session (${JSON.stringify({ presenting: st.presenting, mode: st.mode })})`);
	await iwer.exit(C.page);
	await h.eventually(() => C.page.evaluate(() => !!document.querySelector('#embed-vr')), (v) => v === true, 'C: leaving VR brings the start card back (Enter VR)', 15000);
	check(C.page.__errors.length === 0, `C: no page errors (${C.page.__errors.slice(0, 2).join(' | ')})`);
	await C.ctx.close();

	// flat desktop: the autoplay still plays
	const Dk = await playPage(browser, 'Dk', { query: plainQ });
	await waitApi(Dk.page);
	await loadedOf(Dk.page);
	const flatXr = await Dk.page.evaluate(async (r) => ({
		xr: !!navigator.xr,
		probe: navigator.xr ? await navigator.xr.isSessionSupported('immersive-vr').catch((e) => 'err ' + e) : null,
		store: eval(r)(window.__stores.playMode.vrSupported),
		locked: eval(r)(window.__stores.isLocked)
	}), read);
	console.log('C flat desktop', JSON.stringify(flatXr));
	const dAuto = await Dk.page.evaluate(() => (window.__stores.playMode.autoPlay ?? (() => (window.__stores.playMode.requestPlay({ flat: true }), 'base: requestPlay flat')))());
	console.log('flat autoPlay returned', dAuto);
	await h.eventually(() => locked(Dk.page), (v) => v === true, 'C: on a flat screen the play=1 autoplay still enters play', 15000);
	// E measures where play starts: make sure it started, whatever the autoplay did
	if ((await locked(Dk.page)) !== true) await Dk.page.evaluate(() => window.__stores.playMode.requestPlay({ flat: true }));
	await h.eventually(() => locked(Dk.page), (v) => v === true, 'E: in play (first start)', 15000);

	// ------------------------------------------------------------- E. a joining camera clears an avatar
	const camAt = () =>
		Dk.page.evaluate((r) => {
			const cam = eval(r)(window.__stores.playerCam);
			const v = cam.getWorldPosition(new cam.position.constructor());
			return [v.x, v.y, v.z];
		}, read);
	await Dk.page.waitForTimeout(800);
	const p1 = await camAt();
	await Dk.page.evaluate(() => window.__stores.playMode.exitPlay());
	await h.eventually(() => locked(Dk.page), (v) => v !== true, 'E: out of play', 10000);
	await Dk.page.waitForTimeout(600);
	// another player joins: a roster row mounts their AvatarRig (a group named by peer id), and their
	// pose puts it exactly where play starts (where the first player stands)
	await Dk.page.evaluate(() => window.__stores.userdata.update((u) => [...u, ['peer-e2e-other', 'Other']]));
	await Dk.page.waitForTimeout(1500);
	const placed = await Dk.page.evaluate(([x, y, z]) => {
		const rd = (s) => {
			let v;
			s.subscribe((x) => (v = x))();
			return v;
		};
		const scene = rd(window.__stores.globalScene);
		let rigs = scene.getObjectsByProperty('name', 'peer-e2e-other');
		if (!rigs.length) {
			// no AvatarRig on this page: a bare Object3D stands in for it
			let proto = Object.getPrototypeOf(rd(window.__stores.playerCam));
			while (Object.getPrototypeOf(Object.getPrototypeOf(proto)) !== Object.prototype) proto = Object.getPrototypeOf(proto);
			const g = new proto.constructor();
			g.name = 'peer-e2e-other';
			scene.add(g);
			rigs = [g];
		}
		for (const g of rigs) {
			const w = g.parent ? g.parent.worldToLocal(new g.position.constructor(x, y, z)) : null;
			if (w) g.position.copy(w);
			else g.position.set(x, y, z);
			g.updateMatrixWorld(true);
		}
		return rigs.length;
	}, p1);
	console.log('E avatar rigs placed', placed);
	await Dk.page.evaluate(() => window.__stores.playMode.requestPlay({ flat: true }));
	await h.eventually(() => locked(Dk.page), (v) => v === true, 'E: in play again', 15000);
	await Dk.page.waitForTimeout(800);
	const p2 = await camAt();
	const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
	console.log('E', JSON.stringify({ p1, p2, d }));
	check(d >= 1.0 - 1e-6, `E: with a player standing where play starts, the camera starts ${d.toFixed(2)} m from them (>= 1 m)`);
	await Dk.ctx.close();

	// ------------------------------------------------------------- D. a joiner's state leaves 'loading'
	const J = await playPage(browser, 'J', { query: 'play?s=zzzz9999' });
	await waitApi(J.page);
	await J.page.waitForTimeout(3000);
	const before = await J.page.evaluate(() => window.tpPlay.state);
	await J.page.evaluate(() => window.__stores.connectionState.sessionHost.set('host-e2e'));
	await h.eventually(() => J.page.evaluate(() => window.tpPlay.state), (v) => v === 'ready', `D: let into a session, tpPlay.state leaves '${before}' for 'ready'`, 10000);
	await J.ctx.close();

	await h.finish(browser);
});
