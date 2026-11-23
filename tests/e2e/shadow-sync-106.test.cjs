// 106 S1 — SHADOW QUALITY IS SCENE DATA: it syncs like the rest of the scene look, saves, survives a reload,
// and an old scene / an old release read it as Basic.
//   1. two peers: A sets Far / Soft / Off / Basic, B follows each (stored level, drawn level, what is drawn)
//   2. Far draws the rig sun's two cascades; Soft the wide kernel; Basic after both is today's Basic again
//      (radius 1, the same map size and shadow class as before anything was asked)
//   3. a save carries the level (only when it is not Basic), a reload of the joiner rejoins at the same level
//   4. an old scene (a payload with no level) loads as Basic on both peers
//   5. view-off: a scene that never asks loads no Soft / Far code and runs no contact pass
//   6. with BASE_URL (the release before 106): a file saved here, at Far, opens there with no error and the
//      same sky (the old release reads it as Basic)
//
//   APP_URL=https://theprototype.app:7201/ e2e-slot --dev $PWD 7201 -- node tests/e2e/shadow-sync-106.test.cjs
const h = require('./helpers.cjs');

const BASE_URL = process.env.BASE_URL || '';

/** what a page holds and draws for the shadow level */
const state = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const read = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const env = read(s.environment);
		const scene = read(s.globalScene);
		const r = read(s.globalRenderer);
		const sun = scene.getObjectByName('env-rig-sun');
		const sh = sun?.shadow;
		return {
			stored: env.shadowLevel ?? null,
			drawn: s.environment.drawnSceneShadowLevel(),
			loaded: s.environment.shadowLevelsLoadedForTest(),
			contact: read(s.lightParams.contactShadowsWanted),
			mapOn: r.shadowMap.enabled,
			sun: sun
				? { cascaded: !!sun.isSunLight, cls: sh?.constructor?.name, radius: sh?.radius, map: [sh?.mapSize?.x, sh?.mapSize?.y], far: sh?.camera?.far }
				: null,
			preset: env.preset
		};
	});
const setLevel = (page, level) => page.evaluate((l) => window.__stores.environment.setSceneShadowLevel(l), level);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	// 5 (first, while nothing has asked): view-off = zero change
	const fresh = await state(A.page);
	h.check(fresh.stored === null && fresh.drawn === 'basic', `5. a fresh scene is Basic (stored ${fresh.stored}, drawn ${fresh.drawn})`);
	h.check(fresh.loaded === false, '5. the Soft / Far chunk is not loaded by a scene that never asks');
	h.check(fresh.contact === false, '5. no contact pass');
	const basicSun = fresh.sun;
	h.check(!!basicSun && basicSun.radius === 1 && !basicSun.cascaded, `5. today's rig sun: ${JSON.stringify(basicSun)}`);

	await h.connect(B, A);

	// 1 + 2: Far
	await setLevel(A.page, 'far');
	await h.eventually(() => state(B.page), (s) => s.stored === 'far' && s.drawn === 'far' && s.sun?.cascaded, '1. B follows Far (stored, drawn, the sun cascaded)', 15000);
	const farA = await state(A.page);
	h.check(farA.sun?.cascaded && farA.sun.cls === 'SunLightShadow', `2. Far: the rig sun draws SunLightShadow cascades (${JSON.stringify(farA.sun)})`);
	h.check(farA.contact === true, '2. Far: the contact pass is on (pc tier)');

	// 3: the save carries it; a reload rejoins at the same level
	const payload = await B.page.evaluate(() => window.__stores.sessions.buildSessionPayload('shadow-sync-106'));
	h.check(payload?.environment?.shadowLevel === 'far', `3. a save carries shadowLevel far (${JSON.stringify(payload?.environment?.shadowLevel)})`);
	await h.freshReload(B);
	await h.eventually(() => state(B.page), (s) => s.stored === 'far' && s.drawn === 'far', '3. B reloaded and rejoined at Far', 60000);

	// Soft
	await setLevel(A.page, 'soft');
	await h.eventually(() => state(B.page), (s) => s.stored === 'soft' && s.sun && !s.sun.cascaded && s.sun.radius === 3, '1. B follows Soft (radius 3, no cascades)', 15000);

	// Off
	await setLevel(A.page, 'off');
	await h.eventually(() => state(B.page), (s) => s.stored === 'off' && s.mapOn === false, '1. B follows Off (shadow map off)', 15000);

	// Basic again: today's Basic, byte for byte where it is measurable
	await setLevel(A.page, 'basic');
	for (const [P, name] of [
		[A, 'A'],
		[B, 'B']
	]) {
		await h.eventually(() => state(P.page), (s) => s.stored === null && s.drawn === 'basic' && s.mapOn === true && s.contact === false, `1. ${name} back to Basic (nothing stored, map on, no contact)`, 15000);
		const s = await state(P.page);
		h.check(
			s.sun && !s.sun.cascaded && s.sun.cls === basicSun.cls && s.sun.radius === 1 && s.sun.map[0] === basicSun.map[0] && s.sun.map[1] === basicSun.map[1],
			`2. ${name}: Basic after Far / Soft is today's Basic (${JSON.stringify(s.sun)} vs ${JSON.stringify(basicSun)})`
		);
	}

	// 4: an old scene (no level in the file) loads as Basic
	await setLevel(A.page, 'far');
	await h.eventually(() => state(B.page), (s) => s.stored === 'far', '4. (setup) both at Far', 15000);
	const old = JSON.parse(JSON.stringify(payload));
	if (old.environment) delete old.environment.shadowLevel;
	await A.page.evaluate((p) => window.__stores.sessions.applySession(p), old);
	for (const [P, name] of [
		[A, 'A'],
		[B, 'B']
	])
		await h.eventually(() => state(P.page), (s) => s.stored === null && s.drawn === 'basic', `4. an old scene loads as Basic on ${name}`, 20000);

	// 6: the newest release opens a file saved here
	if (BASE_URL) {
		const C = await h.setupPage(browser, 'C');
		await C.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
		await C.page.waitForFunction(() => !!window.__stores?.sessions?.applySession, null, { timeout: 240000 });
		const res = await C.page.evaluate(async (p) => {
			const s = window.__stores;
			let err = null;
			try {
				await s.sessions.applySession(p);
			} catch (e) {
				err = String(e && e.message);
			}
			let env;
			s.environment.environment.subscribe((v) => (env = v))();
			return { err, preset: env.preset, level: env.shadowLevel ?? null };
		}, payload);
		h.check(res.err === null, `6. the release before 106 opens a file saved at Far (${res.err ?? 'no error'})`);
		h.check(res.preset === payload.environment.preset, `6. with the same sky (${res.preset})`);
		h.check(h.pageErrors(C).length === 0, `6. no page errors there (${JSON.stringify(h.pageErrors(C)).slice(0, 200)})`);
	} else h.check(true, 'SKIPPED 6: BASE_URL is not set');

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)]).slice(0, 300)})`);
	await h.finish(browser);
});
