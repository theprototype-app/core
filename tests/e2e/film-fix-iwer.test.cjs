// fix-film — Film's AR walk on a phone, the owner's 1.58 report as regression rows, under IWER at both
// OPPO Find N6 sizes (folded 390x896, unfolded 770x850).
// Rows (each size):
//   C. positive control (folded only): a PLAIN VR session does start the VR welcome and does mount the
//      in-headset UI — so the "none" rows below can fail
//   T. Walk (from the motion picker the pill opens) shows no VR tour and mounts no VR UI object
//   S. the AR frame is cleared every frame: with the room behind the scene (passthrough On) a magenta box in
//      view, then the phone turned away, leaves no trail (a pixel count); autoClear is on while presenting
//   V. passthrough Off / On / Dimmed change only the live view (passthroughActive / skyOverRoom / the backdrop)
//   K. the walking-scale chip: ×0.5 / ×1 / ×2 / ×5, remembered on this device
//   L. tracking lost mid-take: the take pauses at a Mark, a short message says why, Film drops to the stick
//   D. (unfolded) AR refused at the start: the same fallback, nothing recorded
// Android's AR framebuffer KEEPS the previous frame when the app does not clear it; IWER draws into the page
// canvas, which the compositor clears unless preserveDrawingBuffer — so the suite forces that on (the probe
// that reproduced the owner's smear: 68-int ar-smear-probe).
// Run: APP_URL=https://localhost:5970/ node tests/e2e/film-fix-iwer.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const OUT = process.env.FILM_SHOTS || path.resolve(__dirname, '../../test-results/fix-film');
fs.mkdirSync(OUT, { recursive: true });

const SIZES = [
	{ key: 'folded', viewport: { width: 390, height: 896 } },
	{ key: 'unfolded', viewport: { width: 770, height: 850 } }
];

function initScript() {
	const base = iwer
		.initScript()
		.content.replace('new I.XRDevice(I["metaQuest3"])', 'new I.XRDevice({ ...I["metaQuest3"], supportedFeatures: [...I["metaQuest3"].supportedFeatures, "dom-overlay"] })');
	if (base === iwer.initScript().content) throw new Error('could not patch the IWER device config');
	return {
		content:
			`;(() => {
	const get = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, attrs) {
		if (type === 'webgl2' || type === 'webgl') attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
		return get.call(this, type, attrs);
	};
	try { localStorage.setItem('toursUnderTest', 'true'); } catch {}
})();` +
			base +
			`;(() => {
	const xr = navigator.xr;
	const request = xr.requestSession.bind(xr);
	xr.requestSession = (mode, init) => {
		if (mode === 'immersive-ar' && window.__denyAr) return Promise.reject(new DOMException('denied', 'NotAllowedError'));
		return request(mode, init).then((s) => {
			if (init && init.domOverlay && init.domOverlay.root) Object.defineProperty(s, 'domOverlayState', { value: { type: 'screen' }, configurable: true });
			// tracking loss on demand: while window.__xrLost, every frame reports no viewer pose (ARCore lost the room)
			const raf = s.requestAnimationFrame.bind(s);
			s.requestAnimationFrame = (cb) => raf((t, frame) => cb(t, new Proxy(frame, {
				get(target, key) {
					if (key === 'getViewerPose' && window.__xrLost) return () => null;
					const v = target[key];
					return typeof v === 'function' ? v.bind(target) : v;
				}
			})));
			return s;
		});
	};
})();`
	};
}

/** magenta pixels in the WebGL canvas (the probe box is magenta) @param {any} page */
const magenta = (page) =>
	page.evaluate(() => {
		let r = null;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const gl = r.domElement;
		const c = document.createElement('canvas');
		c.width = 96;
		c.height = Math.max(1, Math.round((96 * gl.height) / gl.width));
		const ctx = c.getContext('2d');
		ctx.drawImage(gl, 0, 0, c.width, c.height);
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] > 150) n++;
		return { n, total: d.length / 4 };
	});

/** visible in-headset UI objects in the scene (names the VR components give them) + the tour @param {any} page */
const vrUi = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let sc = null;
		s.globalScene.subscribe((v) => (sc = v))();
		const names = new Set();
		// DRAWN = it and every ancestor visible (a reticle's dot is visible inside a hidden reticle)
		sc?.traverseVisible((o) => {
			if (o.name && /^vr-|tour|wrist|radial|sleeve/i.test(o.name)) names.add(o.name);
		});
		let a = null;
		s.tours?.activeTour?.subscribe?.((v) => (a = v))();
		return { names: [...names].slice(0, 12), count: names.size, tour: a ? a.id ?? a.tourId ?? 'active' : null };
	});

const takeUi = (page) => page.evaluate(() => { let u = null; window.__stores.filmRecorder.take.subscribe((v) => (u = v))(); return u; });
const walkUi = (page) => page.evaluate(() => { let u = null; window.__stores.filmWalk.walk.subscribe((v) => (u = v))(); return u; });
const look = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let pt, sky, rl, sc;
		s.passthroughActive.subscribe((v) => (pt = v))();
		s.skyOverRoom.subscribe((v) => (sky = v))();
		s.roomLook.subscribe((v) => (rl = v))();
		s.globalScene.subscribe((v) => (sc = v))();
		const bg = sc?.background;
		return { passthrough: pt, skyOverRoom: sky, roomLook: rl, background: bg ? (bg.isDataTexture ? 'DataTexture' : bg.isCubeTexture ? 'CubeTexture' : bg.isTexture ? 'Texture' : bg.isColor ? 'Color' : 'other') : null }; // flags, not constructor.name (minified on built apps)
	});

/** @param {number[]} q */
function forward(q) {
	const [x, y, z, w] = q;
	return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const size of SIZES) {
		const P = await h.setupPage(browser, size.key, { context: { viewport: size.viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, init: initScript() });
		const page = P.page;
		const tag = (s) => `[${size.key}] ${s}`;

		// ---- C. positive control: a plain VR session DOES start the welcome + mount the VR UI ----
		if (size.key === 'folded') {
			await page.evaluate(async () => {
				let r = null;
				window.__stores.globalRenderer.subscribe((v) => (r = v))();
				const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
				await r.xr.setSession(s);
			});
			await h.eventually(() => iwer.state(page), (s) => s.presenting && s.isVRMode, tag('control: a plain VR session presents'), 15000);
			await page.waitForTimeout(2500);
			await iwer.frames(page, 6);
			const ctl = await vrUi(page);
			h.check(!!ctl.tour, tag(`control: a plain VR session starts the VR welcome (${ctl.tour})`));
			h.check(ctl.count > 0, tag(`control: and mounts in-headset UI (${ctl.names.join(',')})`));
			await page.evaluate(() => window.__stores.tours.tours.skip?.());
			await iwer.exit(page);
			await page.evaluate(() => {
				// the control's tour must not be what keeps the next rows quiet: let it auto-start again
				window.__stores.tours.tours.reset?.();
			});
		}

		// a camera + a magenta box
		const uuid = await page.evaluate(async () => {
			window.__stores.commandsHandler.sceneCommand('/create Camera');
			await new Promise((r) => setTimeout(r, 400));
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.children[g.children.length - 1].uuid;
		});
		const boxId = await page.evaluate(async () => {
			window.__stores.commandsHandler.sceneCommand('/create Box');
			await new Promise((r) => setTimeout(r, 400));
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const box = g.children[g.children.length - 1];
			box.traverse((o) => {
				if (o.material) {
					o.material.color?.set('#ff00ff');
					o.material.emissive?.set('#ff00ff');
					o.material.emissiveIntensity = 1;
					o.material.toneMapped = false;
				}
			});
			return box.uuid;
		});
		await page.evaluate((u) => window.__stores.filmState.openFilm(u), uuid);
		await page.waitForSelector('#film-exit', { timeout: 15000 });
		await page.locator('#film-help-never').click({ timeout: 5000 }).catch(() => {});
		await page.evaluate(() => window.__stores.filmMode.placeCamera([0, 2, 0]));
		await page.evaluate(() => window.__stores.toastStore.set([]));

		// ---- D. (unfolded) AR refused: the fallback, Film keeps going on the stick ----
		if (size.key === 'unfolded') {
			await page.evaluate(() => (window.__denyAr = true));
			await page.locator('#film-sensor').click();
			await page.locator('#film-walk').click();
			await h.eventually(() => page.locator('.tp-toast').allTextContents(), (t) => t.some((x) => /AR was not allowed|Walk could not start AR/.test(x)), tag('AR refused: a short message says why'), 8000);
			const w = await walkUi(page);
			h.check(!w.on && !w.starting, tag('and the walk is not running'));
			h.check(!/Walk/.test((await page.locator('#film-sensor').textContent()) || ''), tag(`the pill is back on a handheld mode (${(await page.locator('#film-sensor').textContent())?.trim()})`));
			h.check((await page.locator('#film-stick').isVisible()), tag('the thumbstick is there'));
			await page.evaluate(() => { window.__denyAr = false; window.__stores.toastStore.set([]); });
		}

		// ---- T. Walk from the picker: no tour, no VR UI ----
		await page.locator('#film-sensor').click();
		await page.waitForSelector('#film-motion-sheet', { timeout: 5000 });
		await page.screenshot({ path: path.join(OUT, `${size.key}-picker.png`) });
		await page.locator('#film-walk').click();
		await h.eventually(() => iwer.state(page), (s) => s.presenting && s.mode === 'immersive-ar', tag('the AR walk session presents'), 15000);
		await h.eventually(() => page.evaluate(() => window.__stores.filmWalk.filmWalkDebug()), (d) => d.on && d.tracking, tag('the phone is tracked'), 10000);
		h.check(/Walk/.test((await page.locator('#film-sensor').textContent()) || ''), tag(`the pill names Walk (${(await page.locator('#film-sensor').textContent())?.trim()})`));
		await page.waitForTimeout(2500); // past the welcome's start delay (1.2 s)
		await iwer.frames(page, 6);
		const ui = await vrUi(page);
		h.check(!ui.tour, tag(`no VR welcome tour in Film's walk (${ui.tour})`));
		h.check(ui.count === 0, tag(`no in-headset UI object is drawn (${ui.names.join(',') || 'none'})`));
		const st = await page.evaluate(() => {
			let r = null;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			return { autoClear: r.autoClear, blend: r.xr.getSession()?.environmentBlendMode };
		});
		h.check(st.autoClear === true, tag(`the renderer clears every XR frame (autoClear ${st.autoClear}, blend ${st.blend})`));

		// ---- V. passthrough: Off (default, the scene's sky) / On / Dimmed ----
		// the pill names the mode all through the walk (it used to give way to the iOS-style motion ask)
		const pillThere = !!(await page.waitForSelector('#film-sensor', { timeout: 8000 }).catch(() => null));
		h.check(pillThere && /Walk/.test((await page.locator('#film-sensor').textContent().catch(() => '')) || ''), tag('the motion pill still names Walk a few seconds into the walk'));
		if (!pillThere) {
			const dump = await page.evaluate(() => {
				const s = window.__stores;
				let f = null, w = null;
				s.filmMode?.film?.subscribe?.((v) => (f = v))();
				s.filmWalk?.walk?.subscribe?.((v) => (w = v))();
				return { url: location.href, root: !!document.getElementById('film-root'), cls: document.documentElement.className.slice(0, 120), motion: document.querySelector('#film-motion')?.textContent, film: f && { sensor: f.sensor, motion: f.motion, open: f.open }, walk: w, top: document.querySelector('.film-top')?.innerHTML.slice(0, 400) };
			});
			console.log('FILM STATE', JSON.stringify(dump));
			await page.screenshot({ path: path.join(OUT, `${size.key}-no-pill.png`) });
		}
		const v0 = await look(page);
		h.check(v0.roomLook === 'sky' && !v0.passthrough && v0.skyOverRoom && !!v0.background, tag(`Passthrough Off by default: the scene's sky stays (${JSON.stringify(v0)})`));
		await page.locator('#film-sensor').click();
		const note = (await page.locator('#film-motion-sheet').textContent()) || '';
		h.check(/never the recorded/i.test(note) || /not.*record/i.test(note), tag('the sheet says the passthrough choice changes only the live view'));
		await page.locator('.film-pass[data-pass="dim"]').click();
		await page.waitForTimeout(200);
		const vd = await look(page);
		h.check(vd.roomLook === 'dim' && vd.passthrough && vd.background === 'DataTexture', tag(`Dimmed: the room shows faint behind (${JSON.stringify(vd)})`));
		await page.locator('.film-pass[data-pass="on"]').click();
		await page.waitForTimeout(200);
		const von = await look(page);
		h.check(von.roomLook === 'room' && von.passthrough && !von.skyOverRoom && von.background === null, tag(`On: the scene over the room (${JSON.stringify(von)})`));
		h.check(await page.evaluate(() => localStorage.getItem('film:passthrough') === 'on'), tag('the passthrough choice is remembered'));

		// ---- K. walking scale chips in the sheet + the tappable chip ----
		const chips = await page.locator('#film-walk-scales .film-scale').evaluateAll((els) => els.map((e) => e.getAttribute('data-scale')));
		h.check(chips.join(',') === '0.5,1,2,5', tag(`the walking scale offers ×0.5 / ×1 / ×2 / ×5 (${chips.join(',')})`));
		await page.locator('#film-sensor').click(); // close the sheet
		await page.locator('#film-walk-chip').click();
		await page.waitForSelector('#film-walk-scale-pop', { timeout: 3000 });
		await page.locator('#film-walk-scale-pop .film-scale[data-scale="2"]').click();
		await page.waitForTimeout(200);
		h.check((await walkUi(page)).scale === 2 && /×2/.test((await page.locator('#film-walk-chip').textContent()) || ''), tag('tapping the walk chip picks ×2'));
		h.check(await page.evaluate(() => localStorage.getItem('film:walkScale') === '2' || /2/.test(localStorage.getItem('film:walkScale') || '')), tag('and the scale is remembered on this device'));
		await page.evaluate(() => window.__stores.filmWalk.setWalkScale(1));

		// ---- S. the smear: box in view with the room behind, turn away, no trail ----
		await page.evaluate(() => window.__stores.toastStore.set([]));
		const p0 = await page.evaluate(() => window.__stores.filmMode.filmPose());
		const f = forward(p0.q);
		await page.evaluate(({ id, at }) => {
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const box = g.getObjectByProperty('uuid', id);
			box.position.set(at[0], at[1], at[2]);
			box.scale.set(2, 1.5, 0.5);
			box.updateMatrixWorld(true);
		}, { id: boxId, at: [p0.pos[0] + f[0] * 4, p0.pos[1] + f[1] * 4, p0.pos[2] + f[2] * 4] });
		// COUNTERFACTUAL (FILM_FIX_COUNTERFACTUAL=1): pin autoClear off the way 1.58 left it — then no XR frame may be cleared (the clear row must be able to fail)
		const counter = process.env.FILM_FIX_COUNTERFACTUAL === '1';
		if (counter)
			await page.evaluate(() => {
				let r = null;
				window.__stores.globalRenderer.subscribe((v) => (r = v))();
				Object.defineProperty(r, 'autoClear', { get: () => false, set() {}, configurable: true });
			});
		await iwer.frames(page, 4);
		// THE CLEAR ITSELF: IWER (like the spec) clears the XR framebuffer each frame on its own, so pixels alone
		// cannot fail here — the N6's AR framebuffer keeps the last frame. Count the app's colour clears ON THE XR
		// FRAMEBUFFER per XR frame (a shadow map's clear is on its own target and does not count).
		await page.evaluate(() => {
			let r = null;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			// three's renderer.clear, not gl.clear: IWER clears its framebuffer through the same GL context (once
			// a frame, the counterfactual measured it), and that clear is the emulator's, not the app's
			const gl = r.getContext();
			const xrFb = () => r.xr.getSession()?.renderState?.baseLayer?.framebuffer ?? null;
			const orig = r.clear;
			window.__clearSpy = { n: 0, frames: 0, orig };
			r.clear = function (color = true, depth, stencil) {
				if (color !== false && gl.getParameter(gl.FRAMEBUFFER_BINDING) === xrFb()) window.__clearSpy.n++;
				return orig.call(this, color, depth, stencil);
			};
			const sess = r.xr.getSession();
			const tick = () => {
				if (!window.__clearSpy) return;
				window.__clearSpy.frames++;
				sess.requestAnimationFrame(tick);
			};
			sess.requestAnimationFrame(tick);
		});
		await iwer.frames(page, 10);
		const clears = await page.evaluate(() => {
			let r = null;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const spy = window.__clearSpy;
			r.clear = spy.orig;
			window.__clearSpy = null;
			return { clears: spy.n, frames: spy.frames };
		});
		const m0 = await magenta(page);
		await page.screenshot({ path: path.join(OUT, `${size.key}-walk-box.png`) });
		await iwer.pose(page, 'head', [0, 1.6, 0], { yaw: Math.PI });
		await iwer.frames(page, 12);
		const m1 = await magenta(page);
		await page.screenshot({ path: path.join(OUT, `${size.key}-walk-turned.png`) });
		h.check(m0.n > 40, tag(`premise: the magenta box is in view (${m0.n} px of ${m0.total})`));
		if (counter) {
			h.check(clears.clears === 0, tag(`COUNTERFACTUAL: with autoClear off no XR frame is cleared (${JSON.stringify(clears)})`));
			break;
		}
		h.check(clears.frames >= 8 && clears.clears >= clears.frames - 1, tag(`every XR frame is cleared before it is drawn (${clears.clears} colour clears in ${clears.frames} frames)`));
		h.check(m1.n < Math.max(4, m0.n * 0.05), tag(`turning away leaves no trail of the box (${m1.n} magenta px left of ${m0.n})`));
		await iwer.pose(page, 'head', [0, 1.6, 0]);
		await iwer.frames(page, 4);

		// ---- L. tracking lost mid-take ----
		await page.evaluate(() => {
			const w = window.__stores;
			const id = w.sequences.createSequence('Walk ' + Math.random().toString(36).slice(2, 6));
			w.sequences.setSequence(id, { duration: 30, tracks: [] });
			w.sequences.activeSequence.set(id);
		});
		await page.locator('#film-record').click();
		await h.eventually(() => takeUi(page), (u) => u.state === 'recording', tag('recording while walking'), 8000);
		await iwer.pose(page, 'head', [0, 1.6, -0.5]);
		await iwer.frames(page, 20);
		const marks0 = (await takeUi(page)).markers ?? 0;
		await page.evaluate(() => (window.__xrLost = true));
		await h.eventually(() => takeUi(page), (u) => u.state === 'paused', tag('tracking lost mid-take: the take pauses'), 10000);
		await page.evaluate(() => (window.__xrLost = false));
		const tk = await takeUi(page);
		h.check((tk.markers ?? 0) > marks0, tag(`at a Mark (${marks0} → ${tk.markers})`));
		const msgs = await page.locator('.tp-toast').allTextContents();
		h.check(msgs.some((t) => /Tracking was lost — the take paused at a mark/.test(t)), tag(`a short message says why (${msgs.join(' | ').slice(0, 140)})`));
		h.check(msgs.some((t) => /Recentre/.test(t)) || (await page.locator('.tp-toast button', { hasText: 'Recentre' }).count()) > 0, tag('the message offers Recentre'));
		await h.eventually(() => iwer.state(page), (s) => !s.presenting, tag('the AR session ends'), 10000);
		const wl = await walkUi(page);
		h.check(!wl.on, tag('Film is no longer walking'));
		h.check(!/Walk/.test((await page.locator('#film-sensor').textContent()) || '') && (await page.locator('#film-stick').isVisible()), tag(`Film drops to the thumbstick (${(await page.locator('#film-sensor').textContent())?.trim()})`));
		h.check(await page.evaluate(() => localStorage.getItem('film:motion') === 'walk'), tag('the fallback does not overwrite the remembered choice (Walk stays chosen)'));
		h.check(await page.evaluate(() => document.documentElement.classList.contains('film-mode')), tag('Film carries on'));
		await page.screenshot({ path: path.join(OUT, `${size.key}-lost.png`) });
		await page.locator('#film-exit').click().catch(() => {});
		await h.closePeer(P);
	}
	await h.finish(browser);
});
