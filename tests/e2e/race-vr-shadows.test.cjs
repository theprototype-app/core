// 46-media R1 — Race in VR WITH shadows, inside the VR budget. The REAL Race scene, the real
// race module, a fake XR session (the real per-frame path), the real governor:
//   1. loading Race makes the module claim a BUDGETED shadow (api.quality.keepShadowsInVR)
//   2. a headset then ENTERS at full quality (shadows on) instead of the "shadows off" floor —
//      and loses it again the moment the claim goes (the counterfactual, in-page)
//   3. in Play: ONE directional caster (the environment rig's sun stands down), its frustum fitted
//      to the 45 m around the player while the AUTHORED frustum (scene data) stays untouched; the
//      frame counts are inside the Quest budget (<= 150 calls, <= 300k tris) with shadows on
//   4. leaving Play gives everything back (rig sun casts, authored projection), and removing the
//      game from the scene releases the claim
// Counterfactual: on the 1.35.0 base there is no claim, the headset enters at level 1 (shadows
// off), and Race with shadows on measures 142 calls / 306k tris (over the 300k budget).
// Run: APP_URL=https://theprototype.app:5463/ npm run e2e -- race-vr-shadows
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const h = require('./helpers.cjs');
const fx = require('./fakeXR.cjs');
const { startRecorder, readScene, settleScene } = require('../../scripts/perfProbe.cjs');

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

/** poll until `predicate(value)`; PASS/FAIL, and RETURN the last value */
async function until(fn, predicate, label, timeout = 15000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last)?.slice(0, 300));
	h.check(false, label);
	return last;
}

/** the shadow state as the renderer sees it: casters, the Sun's authored and live frusta */
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
			authored: cam ? [cam.left, cam.right, cam.top, cam.bottom].map((v) => Math.round(v * 10) / 10) : null,
			// the live projection's x scale: 2 / (right - left) of whatever three used last frame
			liveSpan: cam ? Math.round(2 / cam.projectionMatrix.elements[0]) : null,
			budget: s.shadowBudget?.shadowBudgetDebug?.() ?? { active: false },
			kept: !!s.shadowClaims?.shadowsKeptInXR?.(),
			claims: (() => {
				let c;
				s.shadowClaims?.shadowClaims.subscribe((v) => (c = v))();
				return (c ?? []).map((x) => ({ owner: x.owner, radius: x.radius }));
			})()
		};
	});

h.run(async () => {
	const bytes = raceScene();
	if (!bytes) {
		console.log('SKIP: no Race scene (set RACE_TPSCENE or check out the scenes repo beside core)');
		process.exit(0);
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await page.evaluate(async (arr) => {
		const s = window.__tp?.test.v1;
		const payload = await s.sessions.importSessionZip(new Uint8Array(arr).buffer);
		if (payload) await s.sessions.requestLoadSession(payload.id);
	}, Array.from(bytes));
	await settleScene(page);

	// 1. the module claims a budgeted shadow while Race is the scene
	const first = await until(() => shadowState(page), (v) => v.kept, 'loading Race makes the race module claim a budgeted shadow');
	h.check(first.claims.some((c) => c.owner === 'race' && c.radius === 45), `the claim is the race module's, 45 m (${JSON.stringify(first.claims)})`);

	// 2. the headset's entry floor follows the claim
	const gov = await page.evaluate(() => {
		const q = window.__tp.test.v1.qualityGovernor;
		const c = window.__tp.test.v1.shadowClaims;
		const read = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		q.governorForTest.reset();
		q.setAutoQuality(true);
		q.startXRQuality(null, 72);
		const kept = { level: q.xrQualityDebug().level, floor: q.xrQualityDebug().floor, shadowsOff: read(q.qualityOverrides).shadowsOff };
		// COUNTERFACTUAL in-page: take the claim away mid-session — the old floor comes back
		const held = c ? read(c.shadowClaims) : [];
		c?.shadowClaims.set([]);
		const without = { level: q.xrQualityDebug().level, floor: q.xrQualityDebug().floor, shadowsOff: read(q.qualityOverrides).shadowsOff, reason: read(q.qualityState).reason };
		c?.shadowClaims.set(held);
		const back = { level: q.xrQualityDebug().level, shadowsOff: read(q.qualityOverrides).shadowsOff, reason: read(q.qualityState).reason };
		q.endXRQuality();
		q.setAutoQuality(false); // the measurement below must not be stepped by a busy runner
		return { kept, without, back };
	});
	h.check(gov.kept.level === 0 && gov.kept.floor === 0 && gov.kept.shadowsOff === false, `a headset enters Race at FULL quality, shadows on (${JSON.stringify(gov.kept)})`);
	h.check(gov.without.level === 1 && gov.without.shadowsOff === true, `without the claim the headset floor is shadows off again (${JSON.stringify(gov.without)})`);
	h.check(gov.back.level === 0 && gov.back.shadowsOff === false, `the claim returning mid-session gives the shadows back (${gov.back.reason})`);

	// 3. Play in the headset analogue, shadows on
	await fx.install(page);
	await fx.installSpace(page, { head: [0, 1.6, 0] });
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.viewMode.set('shaded');
		s.viewportOverrides.setRenderLayer('post', false);
		s.lightParams.shadowQuality.set('high');
	});
	const edit = await shadowState(page);
	h.check(edit.budget.active === false && edit.casters.length === 2, `in Edit nothing is fitted yet: two suns cast (${edit.casters.join(', ')})`);
	await page.locator('#play-button').click({ timeout: 10000 }).catch(() => page.evaluate(() => window.__tp.test.v1.isLocked.set(true)));
	const play = await until(() => shadowState(page), (v) => v.budget.active && v.casters.length === 1, 'in Play ONE directional light casts (the rig sun stands down)');
	h.check(play.casters[0] === 'Sun' && play.rigCasts === false, `…the scene's own Sun keeps its shadow (${play.casters}, rig ${play.rigCasts})`);
	h.check(JSON.stringify(play.authored) === JSON.stringify(edit.authored), `the authored frustum (scene data) is untouched (${play.authored})`);
	h.check(play.liveSpan === 90, `the live shadow frustum is the fitted 90 m square, not the authored ${Math.round(edit.authored[1] - edit.authored[0])} m (${play.liveSpan})`);
	// the shadow pass, attributed per light over 20 frames
	const pass = await page.evaluate(async () => {
		let scene;
		window.__tp.test.v1.globalScene.subscribe((v) => (scene = v))();
		const per = new Map();
		const frames = new Set();
		const hooks = [];
		scene.traverse((o) => {
			if (!o.isMesh || !o.castShadow) return;
			const prev = o.onBeforeShadow;
			hooks.push([o, prev]);
			o.onBeforeShadow = function (r, obj, cam, shadowCam, ...rest) {
				prev.call(this, r, obj, cam, shadowCam, ...rest);
				frames.add(r.info.render.frame);
				per.set(shadowCam.uuid, (per.get(shadowCam.uuid) ?? 0) + 1);
			};
		});
		await new Promise((r) => setTimeout(r, 1500));
		for (const [o, p] of hooks) o.onBeforeShadow = p;
		const n = Math.max(1, frames.size);
		return { lights: per.size, callsPerFrame: Math.round([...per.values()].reduce((a, b) => a + b, 0) / n) };
	});
	h.check(pass.lights === 1, `the shadow pass renders ONE light (${pass.lights})`);
	h.check(pass.callsPerFrame > 0 && pass.callsPerFrame <= 80, `the shadow pass is the cars and the near dressing, not the valley (${pass.callsPerFrame} calls/frame; base 105)`);
	await page.evaluate(startRecorder);
	await page.waitForTimeout(3000);
	const m = await page.evaluate(readScene);
	h.check(m.shadowLights === 1, `one shadow-casting light in the frame (${m.shadowLights})`);
	h.check(m.medianCalls <= 150 && m.medianTriangles <= 300000, `Race with shadows is inside the Quest budget: ${m.medianCalls} calls, ${m.medianTriangles} tris (<= 150 / 300k; base 142 / 306k)`);

	// 4. leaving Play gives it all back
	await h.leavePlay(A);
	const after = await until(() => shadowState(page), (v) => !v.budget.active && v.rigCasts === true, 'leaving Play: the fit stops and the rig sun casts again');
	h.check(Math.abs(after.liveSpan - (edit.authored[1] - edit.authored[0])) <= 1, `…and the Sun is back on its authored projection (${after.liveSpan} m)`);
	// the game leaves the scene: the claim goes with it
	await page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const marker = g.getObjectByName('Race game');
		marker?.parent?.remove(marker);
		window.__tp.test.v1.pokeScene();
	});
	await until(() => shadowState(page), (v) => !v.kept, 'without the Race marker the claim is released (a headset is back to shadows off)');
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ').slice(0, 200)})`);
	await h.finish(browser);
});
