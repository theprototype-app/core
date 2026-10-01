// 33 G1: A PHONE STARTS LIGHTER. The report: "Stars room is too heavy for mobile users, it
// lags". The quality governor never acted on a phone: it judged by the desktop budgets, where a
// 100-call game is LIGHT, and a light scene is never governed — so a phone drew every scene at
// its full pixel ratio through shadows, the authored AO, bloom and SMAA (32 passes a frame on
// the Stars Room, measured with scripts/perf-games.cjs --phone).
//
// A phone-profile page (412x915 @2.625, isMobile + hasTouch = a coarse pointer, no hover)
// against a desktop page: the phone boots at PHONE_START_LEVEL (shadows off, 72 % resolution,
// AO off), its drawing buffer shrinks with it, and slow frames on a LIGHT scene still step it
// further — which the desktop correctly refuses. Then the real Stars Room on the phone.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES = process.env.SHELL_SCENES_DIR || [path.resolve(__dirname, '../../../scenes/games')].find((p) => fs.existsSync(p));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const P = await h.setupPage(browser, 'phone', { context: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true } });
	const D = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1280, height: 720 } } });

	const read = (page) =>
		page.evaluate(() => {
			const s = window.__stores;
			const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
			const r = get(s.globalRenderer);
			return {
				phone: s.qualityGovernor.phoneQuality(),
				state: get(s.qualityGovernor.qualityState),
				overrides: get(s.qualityGovernor.qualityOverrides),
				dpr: window.devicePixelRatio,
				pixelRatio: r.getPixelRatio(),
				shadowMap: r.shadowMap.enabled,
				coarse: matchMedia('(pointer: coarse)').matches
			};
		});
	await P.page.waitForTimeout(1500);
	const p0 = await read(P.page);
	const d0 = await read(D.page);
	h.check(p0.coarse && p0.dpr > 2.5, `premise: the phone page has a coarse pointer at dpr ${p0.dpr}`);
	h.check(p0.phone === true && d0.phone === false, `the phone is judged a phone, the desktop is not (${p0.phone}/${d0.phone})`);
	h.check(p0.state.level === 4 && /phone/.test(p0.state.reason), `the phone boots at the phone start level (${p0.state.level}, "${p0.state.reason}")`);
	h.check(p0.overrides.shadowsOff && p0.overrides.aoOff && p0.overrides.dprScale === 0.72 && !p0.overrides.postOff, `phone start = shadows off, AO off, 72 % resolution, the look kept (${JSON.stringify(p0.overrides)})`);
	h.check(Math.abs(p0.pixelRatio - p0.dpr * 0.72) < 0.02, `the phone draws at 72 % of its pixel ratio (${p0.pixelRatio.toFixed(2)} of ${p0.dpr})`);
	h.check(d0.state.level === 0 && d0.pixelRatio === d0.dpr, `the desktop boots at full quality (${d0.state.level}, dpr ${d0.pixelRatio})`);

	// ---- slow frames on a LIGHT scene: the phone steps further, the desktop never does
	const slowLight = (page) =>
		page.evaluate(() => {
			const s = window.__stores;
			s.sceneBudget.stopSceneMetrics();
			s.sceneBudget.sceneMetrics.set({ at: Date.now(), profile: 'desktop', objects: 30, meshes: 30, triangles: 6000, calls: 100 });
			const q = s.qualityGovernor.governorForTest;
			let t = 1e7;
			// the start level is the level we have: let its hold pass, then 3 s of 50 ms frames
			for (let i = 0; i < 80; i++) q.frame(50, (t += 50));
			const out = s.qualityGovernor.decideNow(t);
			return { moved: out.moved, level: out.level };
		});
	const ps = await slowLight(P.page);
	h.check(ps.moved === 'up' && ps.level === 5, `a phone missing frames on a light scene steps further (${JSON.stringify(ps)})`);
	const ds = await slowLight(D.page);
	h.check(ds.moved !== 'up' && ds.level === 0, `the desktop never governs a light scene (${JSON.stringify(ds)})`);
	await D.ctx.close();

	// ---- the real Stars Room on the phone: AO is gone from the stack, shadows off
	const file = SCENES && path.join(SCENES, 'stars-room', 'scene.tpscene');
	if (file && fs.existsSync(file)) {
		await P.page.evaluate(() => {
			const s = window.__stores;
			s.qualityGovernor.governorForTest.setLevel(4);
		});
		await P.page.evaluate(async (arr) => {
			const s = window.__stores;
			s.templatesModalOpen.set(false);
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, Array.from(fs.readFileSync(file)));
		await P.page.waitForTimeout(3000);
		const stars = await P.page.evaluate(() => {
			const s = window.__stores;
			const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
			const r = get(s.globalRenderer);
			const post = window.__postDebug ? window.__postDebug() : null;
			return { kinds: post?.kinds ?? null, shadowMap: r.shadowMap.enabled, level: get(s.qualityGovernor.qualityState).level };
		});
		h.check(stars.level >= 4 && stars.shadowMap === false, `Stars Room on the phone: level ${stars.level}, shadows off (${stars.shadowMap})`);
		h.check(Array.isArray(stars.kinds) && !stars.kinds.includes('ao'), `Stars Room on the phone: the authored AO is off, the rest of the look stays (${JSON.stringify(stars.kinds)})`);
	} else console.log('SKIP the Stars Room section: no scene at ' + SCENES);
	await h.finish(browser);
});
