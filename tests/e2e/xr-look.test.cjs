// 72 LK3 — THE LOOK REACHES THE HEADSET, with no extra pass (IWER: the app's own XR path, real session):
//   1. a scene with no look: the environment's plain curve, no hook, no quad, nothing changes
//   2. a look (desaturate + contrast) enters a session: every material grades itself; pixels in the eye
//      are grey where the desktop's are grey (the desktop's frame through the composer is the reference)
//   3. no extra render target: textures and draw calls in one session with the look on match the look off
//      (+1 quad draw per eye for the vignette)
//   4. a look edited during the session lands (the shader text changes under the same curve constant)
//   5. Bloom is listed as desktop-only and the panel says so; leaving the session restores the plain curve
//   6. two peers: the peer in the headset grades from the replicated look
// MANUAL on a Quest: the frame time with the look on (headless frames say nothing about a Quest GPU).
// Run: APP_URL=https://theprototype.app:5612/ npm run e2e -- xr-look
const sharp = require('sharp');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const eyes = require('./vrEyes.cjs');

const GET = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;
const look = (page) =>
	page.evaluate(`(() => {
		const get = ${GET};
		const r = get(window.__stores.globalRenderer);
		const d = window.__stores.xrLook.xrLookDebug;
		const p = d.plan();
		return { tone: r.toneMapping, presenting: r.xr.isPresenting, plan: p ? { glsl: p.glsl, curve: p.curve, baked: p.baked, skipped: p.skipped, v: !!p.vignette } : null, token: d.token(), vignette: d.vignette(), textures: r.info.memory.textures, calls: r.info.render.calls };
	})()`);
const addFx = (page, kind, params) =>
	page.evaluate(([k, p]) => {
		const sp = window.__stores.scenePost;
		const id = sp.addPostEffect(k, undefined);
		const state = sp.scenePostState();
		const entry = state.effects[state.effects.length - 1];
		sp.setPostEffectParams(id ?? entry.id, p);
		return id ?? entry.id;
	}, [kind, params]);
const setFx = (page, id, params) => page.evaluate(([i, p]) => window.__stores.scenePost.setPostEffectParams(i, p), [id, params]);

/** a saturated red box filling the middle of the view */
async function stage(page) {
	await page.evaluate(`(() => {
		const get = ${GET};
		const st = window.__stores;
		st.commandsHandler.sceneCommand('/create box');
		const g = get(st.objectsGroup);
		const box = g.children[g.children.length - 1];
		box.material.color.set('#c02020');
		box.scale.set(6, 6, 0.2);
		box.position.set(0, 1.6, -3);
		const camera = get(st.globalCamera);
		const orbit = get(st.orbitControls);
		camera.position.set(0, 1.6, 0);
		orbit?.target?.set(0, 1.6, -3);
		camera.lookAt(0, 1.6, -3);
		orbit?.update?.();
		st.objectActions.applySelectionSet([], false); // no selection outline or VR shell over the colour being measured
	})()`);
}
/** mean RGB of the centre of the page */
async function centre(page) {
	await page.waitForTimeout(800);
	const png = await page.screenshot({ clip: { x: 540, y: 260, width: 200, height: 200 } });
	const s = await sharp(png).removeAlpha().stats();
	return s.channels.map((c) => Math.round(c.mean));
}
const spread = (c) => Math.max(...c) - Math.min(...c);
const mean = (c) => (c[0] + c[1] + c[2]) / 3;
/** the middle of one eye, rendered the way a headset does (vrEyes: an XR-flagged target, the tone mapping in
 * the materials), from a head looking at the box. While a session presents, renderer.render swaps in the XR
 * camera with the eye buffer's own viewports whatever it is handed, so xr.enabled stands down for the shot.
 * (sharp's stats() reads the INPUT and ignores extract, so the crop goes through a buffer first.) */
async function eye(page, label) {
	// a ray resting on an object tints it (the VR hover's emissive), so the hands point at the floor
	await iwer.pose(page, 'left', [-0.3, 1, 0], { pitch: -1.4 });
	await iwer.pose(page, 'right', [0.3, 1, 0], { pitch: -1.4 });
	await iwer.frames(page, 10);
	const tint = await page.evaluate(`(() => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return g.children[g.children.length - 1].material.emissive.getHex(); })()`);
	h.check(tint === 0, `no hover tint on the box while sampling (${tint.toString(16)})`);
	const standDown = (on) =>
		page.evaluate(`(() => { let r; window.__stores.globalRenderer.subscribe((x) => (r = x))(); r.xr.enabled = ${!on}; })()`);
	await standDown(true);
	let shot;
	try {
		shot = await eyes.shoot(page, { size: 256, head: { position: [0, 1.6, -1.6], yaw: 0, pitch: 0 } });
	} finally {
		await standDown(false);
	}
	if (process.env.XR_LOOK_SHOTS) require('fs').writeFileSync(`${process.env.XR_LOOK_SHOTS}/${label}.png`, shot.left);
	const crop = await sharp(shot.left).extract({ left: 108, top: 108, width: 40, height: 40 }).removeAlpha().png().toBuffer();
	const s = await sharp(crop).stats();
	return s.channels.map((c) => Math.round(c.mean));
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const opts = { context: { viewport: { width: 1280, height: 720 } }, init: iwer.initScript() };
	const A = await h.setupPage(browser, 'A', opts);
	await stage(A.page);

	// ---- 1. no look ------------------------------------------------------------------------
	const colourDesk = await centre(A.page);
	h.check(spread(colourDesk) > 40, `the box is red on the desktop (${colourDesk})`);
	await iwer.enter(A.page);
	await iwer.frames(A.page, 10);
	await A.page.waitForFunction(() => window.__stores.xrLook.xrLookDebug.plan, null, { timeout: 15000 });
	const plain = await look(A.page);
	h.check(plain.presenting && plain.plan === null && plain.token === 0 && !plain.vignette, `no look: no plan, no hook (${JSON.stringify(plain.plan)})`);
	h.check(plain.tone === 4, `the environment's plain curve (${plain.tone})`);
	await iwer.exit(A.page);

	// ---- 2. a look --------------------------------------------------------------------------
	const sat = await addFx(A.page, 'huesaturation', { saturation: -1 });
	await A.page.waitForTimeout(1500);
	const greyDesk = await centre(A.page);
	h.check(spread(greyDesk) < 12, `the look greys the box on the desktop (${greyDesk})`);
	await iwer.enter(A.page);
	await iwer.frames(A.page, 10);
	await h.eventually(() => look(A.page), (v) => v.plan?.glsl?.length > 0, 'in the headset the look is planned into the shader', 10000);
	const graded = await look(A.page);
	h.check(graded.tone === 5 /* CustomToneMapping */, `the curve is the hook (${graded.tone})`);
	h.check(graded.plan.baked.includes('huesaturation') && graded.token > 0, `baked: ${graded.plan.baked}`);
	const greyEye = await eye(A.page, 'look-on');
	h.check(spread(greyEye) < 12, `grey in the eye too (${greyEye})`);
	h.check(Math.abs(mean(greyEye) - mean(greyDesk)) < 12, `as bright as the desktop's grey (${greyEye} vs ${greyDesk})`);

	// ---- 3. no extra pass: the same session with the look off is the baseline ----------------------
	await iwer.frames(A.page, 20);
	const on = await look(A.page);
	await A.page.evaluate((i) => window.__stores.scenePost.setPostEffectEnabled(i, false), sat);
	await h.eventually(() => look(A.page), (v) => v.plan === null, 'the look off in the session: no plan', 8000);
	await iwer.frames(A.page, 20);
	const off = await look(A.page);
	const redEye = await eye(A.page, 'look-off');
	h.check(spread(redEye) > 40, `counterfactual: with the look off the same sample is red (${redEye})`);
	h.check(on.textures <= off.textures, `no render target for the look (${off.textures} off, ${on.textures} on)`);
	h.check(on.calls <= off.calls, `no fullscreen pass (${off.calls} draw calls off, ${on.calls} on)`);
	await A.page.evaluate((i) => window.__stores.scenePost.setPostEffectEnabled(i, true), sat);
	await h.eventually(() => look(A.page), (v) => v.plan?.glsl?.length > 0, 'the look back on', 8000);
	await iwer.frames(A.page, 10);
	const after = await look(A.page);

	// ---- 4. edited during the session ---------------------------------------------------------
	const tokenBefore = after.token;
	await setFx(A.page, sat, { saturation: 0, hue: 1.2 });
	await h.eventually(() => look(A.page), (v) => v.token > tokenBefore && /mat3/.test(v.plan?.glsl ?? ''), 'a look edit during the session lands in the shader', 10000);
	await iwer.frames(A.page, 5);
	await h.eventually(() => look(A.page), (v) => v.tone === 5, 'and the curve is back on the hook after the one-frame flip', 5000);

	// ---- 5. what stays behind ------------------------------------------------------------------
	await addFx(A.page, 'bloom', {});
	await addFx(A.page, 'vignette', { offset: 0.4, darkness: 0.8 });
	await h.eventually(() => look(A.page), (v) => v.plan?.skipped?.includes('bloom') && v.plan?.v && v.vignette, 'Bloom is listed as desktop-only, the vignette is on', 10000);
	await iwer.frames(A.page, 5);
	const withQuad = await look(A.page);
	h.check(withQuad.calls <= after.calls + 2, `the vignette is one quad per eye (${after.calls} -> ${withQuad.calls})`);
	h.check(withQuad.textures <= after.textures, `and no texture (${after.textures} -> ${withQuad.textures})`);
	await iwer.exit(A.page);
	await h.eventually(() => look(A.page), (v) => !v.presenting && v.plan === null && !v.vignette && v.token === 0, 'out of the headset: no plan, no quad', 8000);
	const back = await centre(A.page);
	h.check(Math.abs(spread(back) - spread(greyDesk)) < 200, `the desktop renders on (${back})`);
	h.check(h.pageErrors(A).length === 0, `no page error (${h.pageErrors(A).join(' | ')})`);
	await A.page.close();

	// ---- 6. two peers --------------------------------------------------------------------------
	const P = await h.setupPage(browser, 'P', opts);
	const Q = await h.setupPage(browser, 'Q', opts);
	await h.connect(P, Q);
	await iwer.enter(Q.page);
	await iwer.frames(Q.page, 5);
	await addFx(P.page, 'brightnesscontrast', { contrast: 0.4 });
	await h.eventually(() => look(Q.page), (v) => v.plan?.baked?.includes('brightnesscontrast'), "the headset peer grades from the desktop peer's look", 15000);
	await iwer.exit(Q.page);
	await h.finish(browser);
});
