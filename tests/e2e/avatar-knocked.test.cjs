// 37-avatar-fix R22 — the "knocked off" idle, between REAL peers (A, B, then a late joiner C).
//  1. Both idle past the threshold (Settings ▸ Avatars, 10 s here): each sees the OTHER knocked off
//     — stars + star eyes shown, the head swaying. The only thing on the wire is `knocked: 1` on the
//     camera stream (no new message type).
//  2. B presses a key: A sees B wake (the effect blends out) while B still sees A knocked off.
//  3. A draws peers as classic floating heads: B's classic head gets the stars too.
//  4. A late joiner C sees B knocked off straight away.
//  5. B sets the idle to Off: B never gets knocked off.
// The figure-8 shape, the blend, the star placement per head type and the idle watch's thresholds
// are the headless vitest `avatarRig`; this suite proves the flag, the replication and the look.
const h = require('./helpers.cjs');

const SHOTS = process.env.AVATAR_SHOTS || '';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);
	await A.page.evaluate(() => {
		window.__types = {};
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		Object.values(p.connections).forEach((conn) =>
			conn.on('data', (d) => {
				if (d && d.type) window.__types[d.type] = (window.__types[d.type] ?? 0) + 1;
			})
		);
	});

	const stateOn = (page, id) => page.evaluate((id) => window.__stores.avatars.avatarsDebug()[id] ?? null, id);
	const setIdle = (page, s) => page.evaluate((s) => window.__stores.avatars.knockedAfterSeconds.set(s), s);
	const camTo = (page, pos, target) => page.evaluate(({ pos, target }) => window.__stores.objectActions.flyTo(pos, target, 0), { pos, target });
	/** the classic head's star mesh under a peer's root group on `page` */
	const classicStars = (page, id) =>
		page.evaluate((id) => {
			let scene;
			window.__stores.globalScene.subscribe((x) => (scene = x))();
			const root = scene.getObjectByName(id);
			const m = root?.children.find((c) => c.name === 'avatar-dizzy-stars');
			return m ? { visible: m.visible, count: m.count } : null;
		}, id);

	// stand them facing each other, 3 m apart, and let the poses land
	await camTo(A.page, [0, 1.6, 3], [0, 1.6, 0]);
	await camTo(B.page, [0, 1.6, 0], [0, 1.6, 3]);
	await h.eventually(() => stateOn(A.page, B.id), (s) => s && s.ready && s.visible, '0.1 (premise) A draws B', 20000);
	await h.eventually(() => stateOn(B.page, A.id), (s) => s && s.ready && s.visible, '0.2 (premise) B draws A', 20000);
	h.check((await stateOn(A.page, B.id)).dizzy === 0, '0.3 awake: no stars on B (the default threshold is 20 s)');

	// ---- 1. both idle past 10 s ----------------------------------------------------------------
	await setIdle(A.page, 10);
	await setIdle(B.page, 10);
	await h.eventually(() => stateOn(A.page, B.id), (s) => s && s.dizzy > 0.9, "1.1 A sees B knocked off after B's 10 s with no input", 25000);
	await h.eventually(() => stateOn(B.page, A.id), (s) => s && s.dizzy > 0.9, "1.2 ...and B sees A knocked off (each peer animates the other)", 15000);
	const kOnA = await A.page.evaluate((id) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		return scene.getObjectByName(id)?.userData.knocked;
	}, B.id);
	h.check(kOnA === true, '1.3 it arrived as the camera stream flag');
	// the picture is taken from B (moving A's own camera would wake A, which section 2 still needs)
	if (SHOTS) {
		// A stands at z 3 looking toward -Z: B looks at A's FACE from 2 m, a little to the side
		await camTo(B.page, [0.7, 1.8, 1.1], [0, 1.45, 3]);
		await B.page.waitForTimeout(700);
		await B.page.screenshot({ path: SHOTS + '/03-knocked-off.png' });
	}

	// ---- 2. B wakes ----------------------------------------------------------------------------
	await B.page.keyboard.press('ShiftLeft');
	await h.eventually(() => stateOn(A.page, B.id), (s) => s && s.dizzy === 0, '2.1 B presses a key: A sees B blend back awake', 8000);
	h.check((await stateOn(B.page, A.id)).dizzy > 0.9, '2.2 ...while B still sees A knocked off (A has not moved)');

	// ---- 3. classic floating heads -------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.avatars.peersAsClassic.set(true));
	await h.eventually(() => classicStars(A.page, B.id), (m) => m && m.visible && m.count === 7, "3.1 B's classic head gets the stars + star eyes when B idles again", 25000);
	if (SHOTS) {
		// frame B's classic head where A actually draws it, from 2.2 m in front of its face
		const bp = await A.page.evaluate((id) => {
			let scene;
			window.__stores.globalScene.subscribe((x) => (scene = x))();
			const g = scene.getObjectByName(id);
			const f = new window.__stores.THREE.Vector3(0, 0, -1).applyQuaternion(g.quaternion);
			f.y = 0;
			f.normalize();
			return { p: g.position.toArray(), f: f.toArray() };
		}, B.id);
		const eye = [bp.p[0] + bp.f[0] * 2.2 + 0.4, bp.p[1] + 0.3, bp.p[2] + bp.f[2] * 2.2];
		await camTo(A.page, eye, bp.p);
		await A.page.waitForTimeout(700);
		await A.page.screenshot({ path: SHOTS + '/04-knocked-off-classic-head.png' });
	}
	await A.page.evaluate(() => window.__stores.avatars.peersAsClassic.set(false));

	// ---- 4. a late joiner ----------------------------------------------------------------------
	const C = await h.setupPage(browser, 'C', { context: { viewport: { width: 960, height: 600 } } });
	await h.connect(C, A);
	await camTo(C.page, [2, 1.6, 2], [0, 1.6, 0]);
	await h.eventually(() => stateOn(C.page, B.id), (s) => s && s.ready && s.dizzy > 0.9, '4.1 a late joiner sees B knocked off', 25000);

	// ---- 5. Off ---------------------------------------------------------------------------------
	await setIdle(B.page, 0);
	await B.page.keyboard.press('ShiftLeft');
	await h.eventually(() => stateOn(A.page, B.id), (s) => s && s.dizzy === 0, '5.1 B turns the idle Off: B is awake', 8000);
	await B.page.waitForTimeout(12000);
	h.check((await stateOn(A.page, B.id)).dizzy === 0, '5.2 ...and stays awake past the old threshold');

	const seen = await A.page.evaluate(() => window.__types);
	h.check(Object.keys(seen).every((t) => !/knock|dizzy|idle/i.test(t)), `6.1 no new message type (${Object.keys(seen).join(', ')})`);
	await h.finish(browser);
});
