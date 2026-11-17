// 48-tests G2: IWER — Meta's Immersive Web Emulation Runtime (npm `iwer`, dev dependency) — as a
// headset in the e2e harness. fakeXR.cjs (30b) patches `renderer.xr.getSession` and writes the
// controller MATRICES by hand, so the renderer never presents: no XR frame loop, no XR camera,
// no session events. IWER replaces `navigator.xr` itself before the app boots, so the app's OWN
// path runs end to end — the probes say immersive-vr/-ar are supported, the Play FAB clicks the
// hidden threlte button, `requestSession` resolves, three's WebXRManager presents (XRWebGLLayer,
// the stereo XR camera, `sessionstart`), and every frame reads real XRInputSources whose poses and
// gamepads this helper moves through IWER's device API.
//
// Install BEFORE the first navigation (the app probes support at module evaluation):
//   const A = await h.setupPage(browser, 'A', { init: iwer.initScript() });
// then `await iwer.enter(A.page)` presses Play like a person would.
//
// What it cannot tell you: comfort, feel, frame rate on a Quest (headless renders through ANGLE
// on this box's GPU, not the headset's), real hand tracking, passthrough CAMERA pixels.
//
// IWER_DEVUI=1 also installs `@iwer/devui` (the overlay with draggable head + controllers) — for a
// person watching a HEADED run (`HEADED=1` in a suite that honours it); never needed headless.
const fs = require('fs');

const IWER_BUILD = require.resolve('iwer/build/iwer.min.js');
const DEVUI_BUILD = (() => {
	try {
		return require.resolve('@iwer/devui/build/iwer-devui.min.js');
	} catch {
		return '';
	}
})();

/**
 * The init script: IWER's UMD build (global `IWER`), then a Quest 3 (Touch Plus controllers) with the
 * head standing at 1.6 m, installed over `navigator.xr`. Passed as `{content}` so it runs on a deployed
 * build too — a CSP without 'unsafe-eval' never sees an eval.
 * @param {{device?: 'metaQuest3'|'metaQuest2'|'metaQuestPro', devui?: boolean, head?: number[]}} [opts]
 */
function initScript(opts = {}) {
	const device = opts.device ?? 'metaQuest3';
	const devui = opts.devui ?? process.env.IWER_DEVUI === '1';
	const head = opts.head ?? [0, 1.6, 0];
	const parts = [fs.readFileSync(IWER_BUILD, 'utf8')];
	if (devui && DEVUI_BUILD) parts.push(fs.readFileSync(DEVUI_BUILD, 'utf8'));
	parts.push(`;(() => {
	if (window.__iwer || !window.IWER) return;
	const I = window.IWER;
	const xrDevice = new I.XRDevice(I[${JSON.stringify(device)}]);
	// forceInstall: headless Chromium HAS a native navigator.xr (no device behind it), and IWER skips a
	// native runtime unless forced — the app then reads "VR unsupported" (48 G2 probe 1)
	xrDevice.installRuntime({ forceInstall: true });
	xrDevice.position.set(${head.map(Number).join(', ')});
	${devui ? 'if (window.IWER_DevUI) xrDevice.installDevUI(window.IWER_DevUI.DevUI);' : ''}
	window.__iwer = { device: xrDevice, version: xrDevice.version, sessions: [] };
	// every session the app asks for, in order (mode + the session object): the passthrough row reads which
	// KIND a press requested, the rest read that one is live
	const xr = navigator.xr;
	const request = xr.requestSession.bind(xr);
	xr.requestSession = (mode, init) => request(mode, init).then((s) => {
		window.__iwer.sessions.push({ mode, init, session: s, ended: false });
		s.addEventListener('end', () => { const e = window.__iwer.sessions.find((x) => x.session === s); if (e) e.ended = true; });
		return s;
	});
})();`);
	return { content: parts.join('\n') };
}

/** IWER is in the page and owns navigator.xr @param {any} page */
function installed(page) {
	return page.evaluate(() => !!window.__iwer && typeof navigator.xr?.requestSession === 'function');
}

/** the renderer + session state the rows read @param {any} page */
function state(page) {
	return page.evaluate(() => {
		const s = window.__tp?.test.v1;
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		let vr;
		s.isVRMode.subscribe((v) => (vr = v))();
		const last = window.__iwer.sessions.at(-1);
		const sess = r?.xr?.getSession?.();
		return {
			presenting: !!r?.xr?.isPresenting,
			isVRMode: vr === true,
			sessions: window.__iwer.sessions.length,
			mode: last?.mode ?? null,
			ended: last?.ended ?? null,
			blend: sess?.environmentBlendMode ?? null,
			// the session three presents IS the one IWER handed out (not a fake one)
			same: !!sess && sess === last?.session,
			inputs: sess ? Array.from(sess.inputSources).map((x) => x.handedness + ':' + (x.gamepad ? 'pad' : '-')) : []
		};
	});
}

/**
 * Press Play the way a person does (the FAB; `requestPlay` clicks the aimed hidden XR button inside the
 * same gesture) and wait until three presents the IWER session. Throws with the last state on a timeout.
 * @param {any} page @param {{timeout?: number}} [opts]
 */
async function enter(page, opts = {}) {
	const before = (await state(page)).sessions;
	await page.click('#play-button');
	const until = Date.now() + (opts.timeout ?? 20000);
	let st = await state(page);
	while (Date.now() < until && !(st.presenting && st.sessions > before && st.inputs.length >= 2)) {
		await page.waitForTimeout(150);
		st = await state(page);
	}
	if (!(st.presenting && st.sessions > before)) throw new Error('IWER session did not start: ' + JSON.stringify(st));
	// a few XR frames so input sources, the XR camera and the per-frame VR path have all run
	await frames(page, 6);
	return st;
}

/** end the live session the way the headset's system menu does (`session.end()`) @param {any} page */
async function exit(page) {
	await page.evaluate(async () => {
		const live = window.__iwer.sessions.filter((x) => !x.ended);
		for (const x of live) await x.session.end().catch(() => {});
	});
	const until = Date.now() + 10000;
	while (Date.now() < until && (await state(page)).presenting) await page.waitForTimeout(150);
}

/**
 * Wait N animation frames of the PRESENTING loop (the session's rAF; the window's when not presenting).
 * @param {any} page @param {number} [n]
 */
function frames(page, n = 3) {
	return page.evaluate(
		(n) =>
			new Promise((resolve) => {
				const sess = window.__iwer.sessions.filter((x) => !x.ended).at(-1)?.session;
				const raf = sess ? (cb) => sess.requestAnimationFrame(cb) : (cb) => requestAnimationFrame(cb);
				let left = n;
				const tick = () => (--left <= 0 ? resolve(true) : raf(tick));
				raf(tick);
				setTimeout(() => resolve(false), 5000 + n * 200);
			}),
		n
	);
}

/**
 * Pose the head or a controller: a position (metres, IWER's global space = the local-floor origin) and a
 * yaw/pitch aim in radians (yaw 0 looks/aims -Z, positive yaw turns left).
 * @param {any} page @param {'head'|'left'|'right'} who @param {number[]} pos @param {{yaw?: number, pitch?: number}} [aim]
 */
async function pose(page, who, pos, aim = {}) {
	await page.evaluate(
		({ who, pos, aim }) => {
			const d = window.__iwer.device;
			const t = who === 'head' ? d : d.controllers[who];
			t.position.set(pos[0], pos[1], pos[2]);
			// YXZ euler -> quaternion (yaw about Y, then pitch about X)
			const cy = Math.cos((aim.yaw ?? 0) / 2), sy = Math.sin((aim.yaw ?? 0) / 2);
			const cp = Math.cos((aim.pitch ?? 0) / 2), sp = Math.sin((aim.pitch ?? 0) / 2);
			t.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
		},
		{ who, pos, aim }
	);
}

/** IWER button ids on the Touch Plus layout, by the xr-standard index the app reads */
const BUTTONS = { left: ['trigger', 'squeeze', null, 'thumbstick', 'x-button', 'y-button'], right: ['trigger', 'squeeze', null, 'thumbstick', 'a-button', 'b-button'] };

/**
 * Press (value 1) or release (0) a controller button — by IWER id ('trigger', 'squeeze', 'thumbstick',
 * 'a-button' …) or by xr-standard index (0 trigger, 1 squeeze, 3 stick, 4 A/X, 5 B/Y; fakeXR's numbering).
 * Trigger / squeeze also fire the session's select / squeeze events, as on the headset.
 * @param {any} page @param {'left'|'right'} hand @param {string|number} id @param {boolean|number} down
 */
async function button(page, hand, id, down) {
	const name = typeof id === 'number' ? BUTTONS[hand][id] : id;
	if (!name) throw new Error(`no button ${id} on the ${hand} controller`);
	await page.evaluate(
		({ hand, name, value }) => window.__iwer.device.controllers[hand].updateButtonValue(name, value),
		{ hand, name, value: typeof down === 'number' ? down : down ? 1 : 0 }
	);
}

/** Thumbstick axes (stick UP is NEGATIVE y, as xr-standard). @param {any} page @param {'left'|'right'} hand @param {number} x @param {number} y */
async function stick(page, hand, x, y) {
	await page.evaluate(({ hand, x, y }) => window.__iwer.device.controllers[hand].updateAxes('thumbstick', x, y), { hand, x, y });
}

/** press + hold + release, with XR frames in between so the per-frame VR path sees both edges */
async function tap(page, hand, id, holdFrames = 4) {
	await button(page, hand, id, true);
	await frames(page, holdFrames);
	await button(page, hand, id, false);
	await frames(page, 3);
}

/** the app's controller groups, world space (what three placed from the XR input poses) @param {any} page */
function controllerWorld(page) {
	return page.evaluate(() => {
		let r;
		window.__tp.test.v1.globalRenderer.subscribe((v) => (r = v))();
		const out = {};
		for (const i of [0, 1]) {
			const c = r.xr.getController(i);
			c.updateMatrixWorld(true);
			const e = c.matrixWorld.elements;
			out[c.userData.handedness ?? i] = { pos: [e[12], e[13], e[14]], visible: c.visible };
		}
		const cam = r.xr.getCamera();
		const ce = cam.matrixWorld.elements;
		out.head = { pos: [ce[12], ce[13], ce[14]] };
		return out;
	});
}

module.exports = { initScript, installed, state, enter, exit, frames, pose, button, stick, tap, controllerWorld, IWER_BUILD };
