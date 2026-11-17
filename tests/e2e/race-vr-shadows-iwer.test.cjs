// 48 G2 — RACE VR SHADOWS ON AN EMULATED HEADSET (IWER, iwer.cjs). race-vr-shadows (46 R1) proved the rule
// by calling the governor's `startXRQuality(null, 72)` itself and faking the session; here the person's
// Play press opens a real (emulated) immersive-vr session and everything after it is the app's own wiring:
//   1. Race loaded -> the race module claims a budgeted shadow
//   2. Play -> IWER session: the governor's OWN sessionstart hook enters at FULL quality (level 0, shadows
//      on), and the shadow budget's sessionstart hook fits ONE directional caster (the Sun, rig sun stood
//      down) to 45 m around the HEADSET
//   3. the shadow pass really runs inside XR frames (onBeforeShadow while renderer.xr.isPresenting)
//   4. the session ends -> the fit stops, the rig sun casts again
//   5. counterfactual in-page: without the Race marker the claim goes, and the NEXT session enters at the
//      headset floor (level 1, shadows off)
// MANUAL on a Quest: the frame time with shadows on (headless frames say nothing about a Quest GPU).
// Run: RACE_TPSCENE=<scenes>/games/race/scene.tpscene APP_URL=https://localhost:5486/ node tests/e2e/race-vr-shadows-iwer.test.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const { settleScene } = require('../../scripts/perfProbe.cjs');

function raceScene() {
	if (process.env.RACE_TPSCENE && fs.existsSync(process.env.RACE_TPSCENE)) return fs.readFileSync(process.env.RACE_TPSCENE);
	const repo = path.resolve(__dirname, '../../../scenes');
	const ref = process.env.PERF_SCENES_REF || JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../perf/budgets.json'), 'utf8')).scenes.ref;
	try {
		return execFileSync('git', ['-C', repo, 'show', ref + ':games/race/scene.tpscene'], { maxBuffer: 1 << 28 });
	} catch {
		return null;
	}
}

/** the shadow state as the renderer sees it (race-vr-shadows' reading) */
const shadowState = (page) =>
	page.evaluate(() => {
		const s = window.__tp?.test.v1;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const casters = [];
		scene.traverse((o) => o.isDirectionalLight && o.castShadow && o.visible && casters.push(o.name));
		const sun = scene.getObjectByName('Sun');
		const rig = scene.getObjectByName('env-rig-sun');
		const cam = sun?.shadow?.camera;
		return {
			casters,
			rigCasts: rig ? rig.castShadow : null,
			liveSpan: cam ? Math.round(2 / cam.projectionMatrix.elements[0]) : null,
			budget: s.shadowBudget?.shadowBudgetDebug?.() ?? { active: false },
			kept: !!s.shadowClaims?.shadowsKeptInXR?.()
		};
	});

/** record what the governor decided the moment a session started (before any frame can step it) */
const armEntryProbe = (page) =>
	page.evaluate(() => {
		const s = window.__tp?.test.v1;
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		const w = /** @type {any} */ (window);
		w.__xrEntry = null;
		const on = () =>
			setTimeout(() => {
				let o;
				s.qualityGovernor.qualityOverrides.subscribe((x) => (o = x))();
				const q = s.qualityGovernor.xrQualityDebug();
				w.__xrEntry = { level: q.level, floor: q.floor, shadowsOff: o.shadowsOff, shadowMap: r.shadowMap.enabled };
				r.xr.removeEventListener('sessionstart', on);
			}, 0);
		r.xr.addEventListener('sessionstart', on);
	});

h.run(async () => {
	const bytes = raceScene();
	if (!bytes) {
		console.log('SKIP: no Race scene (set RACE_TPSCENE or check out the scenes repo beside core)');
		process.exit(0);
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await page.evaluate(async (arr) => {
		const s = window.__tp?.test.v1;
		const payload = await s.sessions.importSessionZip(new Uint8Array(arr).buffer);
		if (payload) await s.sessions.requestLoadSession(payload.id);
	}, Array.from(bytes));
	await settleScene(page);
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.viewMode.set('shaded');
		s.lightParams.shadowQuality.set('high');
		s.qualityGovernor.governorForTest.reset();
		s.qualityGovernor.setAutoQuality(true);
	});

	// 1. the claim
	await h.eventually(() => shadowState(page), (v) => v.kept, 'loading Race makes the race module claim a budgeted shadow', 20000);
	const edit = await shadowState(page);
	h.check(!edit.budget.active && edit.casters.length === 2, `premise: in the editor nothing is fitted, two suns cast (${edit.casters.join(', ')})`);

	// 2. Play = an IWER session; the app's own sessionstart hooks decide
	await armEntryProbe(page);
	const st = await iwer.enter(page, { timeout: 30000 });
	h.check(st.presenting && st.mode === 'immersive-vr' && st.same, `Play opens an immersive-vr session on the emulated Quest (${st.mode})`);
	const entry = await page.evaluate(() => /** @type {any} */ (window).__xrEntry);
	h.check(!!entry && entry.level === 0 && entry.floor === 0 && entry.shadowsOff === false, `the governor's sessionstart enters Race at FULL quality, shadows on (${JSON.stringify(entry)})`);
	// hold the level for the measurement (a busy runner must not step it down mid-check)
	await page.evaluate(() => window.__tp.test.v1.qualityGovernor.setAutoQuality(false));
	const xr = await h.eventually(() => shadowState(page), (v) => v.budget.active && v.casters.length === 1, 'in the session ONE directional light casts (the rig sun stands down)', 10000).then(() => shadowState(page));
	h.check(xr.casters[0] === 'Sun' && xr.rigCasts === false, `…the scene's own Sun keeps its shadow (${xr.casters}, rig ${xr.rigCasts})`);
	h.check(xr.liveSpan === 90, `…its live frustum is the fitted 90 m square around the headset (${xr.liveSpan})`);

	// 3. the shadow pass runs in XR frames
	const pass = await page.evaluate(async () => {
		const s = window.__tp?.test.v1;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		const lights = new Set();
		let xrCalls = 0;
		const frames = new Set();
		const hooks = [];
		scene.traverse((o) => {
			if (!o.isMesh || !o.castShadow) return;
			const prev = o.onBeforeShadow;
			hooks.push([o, prev]);
			o.onBeforeShadow = function (rr, obj, cam, shadowCam, ...rest) {
				prev.call(this, rr, obj, cam, shadowCam, ...rest);
				if (rr.xr.isPresenting) {
					xrCalls++;
					lights.add(shadowCam.uuid);
					frames.add(rr.info.render.frame);
				}
			};
		});
		await new Promise((res) => setTimeout(res, 1500));
		for (const [o, p] of hooks) o.onBeforeShadow = p;
		return { lights: lights.size, frames: frames.size, perFrame: Math.round(xrCalls / Math.max(1, frames.size)), shadowMap: r.shadowMap.enabled };
	});
	h.check(pass.shadowMap && pass.frames > 0 && pass.lights === 1, `the shadow pass renders inside XR frames, for ONE light (${JSON.stringify(pass)})`);
	h.check(pass.perFrame > 0 && pass.perFrame <= 80, `…the cars and the near dressing, not the valley (${pass.perFrame} shadow calls / XR frame)`);

	// 4. leaving
	await iwer.exit(page);
	await h.eventually(() => shadowState(page), (v) => !v.budget.active && v.rigCasts === true, 'the session ends: the fit stops and the rig sun casts again', 10000);

	// 5. counterfactual: no Race marker -> no claim -> the next session enters at the headset floor
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const marker = g.getObjectByName('Race game');
		marker?.parent?.remove(marker);
		s.pokeScene();
		s.qualityGovernor.governorForTest.reset();
		s.qualityGovernor.setAutoQuality(true);
	});
	await h.eventually(() => shadowState(page), (v) => !v.kept, 'without the Race marker the claim is released', 10000);
	await armEntryProbe(page);
	await iwer.enter(page, { timeout: 30000 });
	const floor = await page.evaluate(() => /** @type {any} */ (window).__xrEntry);
	h.check(!!floor && floor.level === 1 && floor.shadowsOff === true, `…and the next session enters at the headset floor, shadows off (${JSON.stringify(floor)})`);
	await iwer.exit(page);
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ').slice(0, 200)})`);
	await h.finish(browser);
});
