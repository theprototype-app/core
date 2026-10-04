// 36 L2 — "HOLD CAMERA UNTIL LOADED" (Configure Scene ▸ Camera), and that it can never trap anyone.
//
// Market Square with the scene setting on, plus pieces served by the FAULT server so the load's
// timing is ours to decide:
//   1. input is IGNORED while held (a real orbit drag and the fly keys: every frame stays on the
//      start view), the hint + "Take control" (after 1.5 s), VR locomotion suppressed, and the
//      hold ends when the last piece ARRIVES (`loaded`); then the user's drag moves it
//   2. a STALLED piece (headers, then nothing) ends the hold at the stuck threshold (10 s) while
//      the piece is still hanging — it never extends the hold
//   3. a piece that keeps trickling bytes (never stuck) ends it at the cap (the threshold's
//      setting, 4 s here) — `cap`
//   4. a piece failing and retrying (amber) ends it as soon as the build is done — `stalled`
//   5. Esc ends it; 6. the "Take control" button ends it
//   7. TWO PEERS: the setting replicates (both ways) and is saved with the scene; the loader is
//      held, the other peer's camera is never touched
// Screenshots: the hint and the setting, dark + light.
//
//   APP_URL=https://theprototype.app:5345/ node tests/e2e/start-view-hold.test.cjs
const h = require('./helpers.cjs');
const S = require('./startViewShared.cjs');
const { startFaultServer } = require('./faultServer.cjs');

const SLUG = 'market-square';
const BOX = [-0.6, 0, -0.5, 0.6, 1.2, 0.5];

/**
 * Open Market Square with the hold on and extra pieces at `urls` (fault-server stubs). Not
 * awaited: the suite works while it loads. @param {any} peer @param {string[]} urls
 */
function openHeld(peer, urls, hold = true) {
	return peer.page.evaluate(
		async ({ sceneUrl, urls, box, hold }) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(await (await fetch(sceneUrl)).arrayBuffer());
			if (hold) payload.physics = { ...(payload.physics ?? {}), holdCamera: true };
			urls.forEach((url, i) => {
				const g = new s.THREE.Group();
				g.name = 'Fault piece ' + i;
				g.position.set(-3 + i * 1.5, 0, 2);
				g.userData = { packRef: { pack: 'test', item: 'Duck', path: url, box }, packStub: true };
				payload.objects.push(g.toJSON());
			});
			payload.count = payload.objects.length;
			void s.sessions.applySession(payload, { backup: false });
		},
		{ sceneUrl: peer.sceneUrl, urls, box: BOX, hold }
	);
}

/** ms since the hold began, and its state, in one read */
const holdState = (page) =>
	page.evaluate(() => {
		const d = window.__stores.startView.startViewDebug();
		return { ...d, job: !!window.__stores.sceneLoader.currentJob() };
	});

const orbitEnabled = (page) =>
	page.evaluate(() => {
		let c;
		window.__stores.orbitControls.subscribe((v) => (c = v))();
		return c?.enabled !== false;
	});

/** release a `hold` piece only once its request has ARRIVED (a release before it is a no-op,
 * and the request would then hang) @param {any} srv @param {string} p */
async function releaseWhenAsked(srv, p) {
	const start = Date.now();
	while (!(srv.counts[p] > 0) && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 100));
	srv.release(p);
}

const setStuck = (page, seconds) => page.evaluate((v) => window.__stores.loadStates.placeholderStuckSeconds.set(v), seconds);

/** the largest distance from the saved view over the frames in [from, to] */
function maxOffView(rec, saved, from, to = Infinity) {
	let m = 0;
	for (const s of rec.samples) if (s.t >= from && s.t <= to) m = Math.max(m, S.dist(s.p, saved.position));
	return m;
}

h.run(async () => {
	const index = S.readIndex();
	if (!index || !S.entryOf(index, SLUG)) {
		console.log('SKIP: no ' + SLUG + ' in the scenes feed at ' + S.SCENES_DIR);
		process.exit(0);
	}
	const fsrv = await startFaultServer();
	const trickle = await startFaultServer({ chunk: 600, tick: 300 });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await S.preparePeer(browser, 'held', index, SLUG, { storage: { placeholderStuckSeconds: '20' } });

	// ---- 1. held, then released when everything is in ---------------------------------------
	console.log('-- 1. held until loaded');
	{
		await A.page.evaluate(S.ARM);
		await openHeld(A, [fsrv.url('hold', 'Held1')]);
		await S.until(() => holdState(A.page), (s) => s.holding, '1: the hold begins');
		h.check(!(await orbitEnabled(A.page)), '1: the orbit controls stand down');
		h.check(await A.page.locator('#start-view-hint').isVisible(), '1: "Loading… camera is held" is on screen');
		h.check(!(await A.page.locator('#start-view-take-control').isVisible()), '1: "Take control" waits (< 1.5 s)');
		h.check(await A.page.evaluate(() => window.__stores.vrControls.vrNavigationSuppressed()), '1: VR locomotion (sticks, teleport) stands down');
		await S.orbitDrag(A.page);
		await A.page.keyboard.down('w');
		await A.page.waitForTimeout(600);
		await A.page.keyboard.up('w');
		await A.page.waitForTimeout(200);
		const mid = await S.disarm(A.page);
		h.check(mid.down > 0 && mid.up > mid.down, '1: premise — a real drag was delivered');
		const off = maxOffView(mid, A.saved, mid.samples.find((s) => S.dist(s.p, A.saved.position) < 0.02)?.t ?? 0);
		h.check(off < 0.02, `1: every frame of the drag and the fly keys stays on the start view (max ${off.toFixed(4)} m off)`);
		await S.until(() => holdState(A.page), (s) => s.hint?.takeControl === true, '1: "Take control" appears after 1.5 s');
		h.check(await A.page.locator('#start-view-take-control').isVisible(), '1: …on screen');
		await S.shot(A.page, '01-camera-held-dark.png');
		await A.page.evaluate(() => window.__stores.themes.theme.set('light'));
		await A.page.waitForTimeout(300);
		await S.shot(A.page, '02-camera-held-light.png');
		await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));
		const before = await holdState(A.page);
		h.check(before.holding && before.job, '1: still held while a piece is on its way');
		await A.page.evaluate(S.ARM);
		await releaseWhenAsked(fsrv, '/hold/Held1.glb');
		await S.loadEnded(A.page, '1: the last piece arrives and the load ends', 30000);
		await A.page.waitForTimeout(300);
		const after = await holdState(A.page);
		h.check(!after.holding && after.releasedBy === 'loaded', `1: the hold ended because everything loaded (${after.releasedBy})`);
		h.check(await orbitEnabled(A.page), '1: the orbit controls are back');
		h.check(!(await A.page.locator('#start-view-hint').isVisible()), '1: the hint is gone');
		h.check(after.hint === null, '1: no "Back to start view" — the user could not move');
		h.check(!(await A.page.evaluate(() => window.__stores.vrControls.vrNavigationSuppressed())), '1: VR locomotion is back');
		await S.orbitDrag(A.page);
		await A.page.waitForTimeout(800);
		const free = await S.camPose(A.page);
		h.check(S.dist(free.position, A.saved.position) > 1, `1: after the hold, a drag moves the camera (${S.dist(free.position, A.saved.position).toFixed(2)} m)`);
		await S.disarm(A.page);
	}

	// ---- 2. a stalled piece: the hold ends at the stuck threshold, the piece still hanging ---
	console.log('-- 2. stalled piece, 10 s');
	{
		await setStuck(A.page, 10);
		await A.page.evaluate(S.ARM);
		await openHeld(A, [fsrv.url('hold', 'Held2')]);
		await S.until(() => holdState(A.page), (s) => s.holding, '2: the hold begins');
		const done = await S.until(() => holdState(A.page), (s) => !s.holding, '2: the hold ends on its own', 16000);
		h.check(done.heldFor >= 9500 && done.heldFor <= 11500, `2: …at the 10 s stuck threshold (${Math.round(done.heldFor)} ms)`);
		h.check(['stalled', 'cap'].includes(done.releasedBy), `2: …because the piece stalled / the cap (${done.releasedBy})`);
		h.check(done.job, '2: the stalled piece is still hanging — it did not extend the hold');
		await S.orbitDrag(A.page);
		await A.page.waitForTimeout(800);
		h.check(S.dist((await S.camPose(A.page)).position, A.saved.position) > 1, '2: the camera is free');
		await S.disarm(A.page);
		await releaseWhenAsked(fsrv, '/hold/Held2.glb');
		await A.page.evaluate(S.ARM);
		await S.loadEnded(A.page, '2: the piece arrives in the end', 30000);
		await S.disarm(A.page);
	}

	// ---- 3. a piece still trickling in: the cap alone ends it --------------------------------
	console.log('-- 3. trickling piece, the cap');
	{
		await setStuck(A.page, 4);
		await openHeld(A, [trickle.url('slow', 'Trickle')]);
		await S.until(() => holdState(A.page), (s) => s.holding, '3: the hold begins');
		const done = await S.until(() => holdState(A.page), (s) => !s.holding, '3: the hold ends on its own', 10000);
		h.check(done.releasedBy === 'cap', `3: the cap ended it (${done.releasedBy}, ${Math.round(done.heldFor)} ms)`);
		h.check(done.heldFor >= 3800 && done.heldFor <= 5500, `3: …at the threshold's setting, 4 s (${Math.round(done.heldFor)} ms)`);
		const load = await A.page.evaluate(() => window.__stores.loadStates.allLoads().find((l) => /Trickle/.test(l.url)) ?? null);
		h.check(!!load && load.phase === 'fetching' && load.loaded > 0, `3: premise — the piece was still arriving, not stuck (${load?.phase}, ${load?.loaded} bytes)`);
	}

	// ---- 4. a failing piece (amber, retrying): ends as soon as the build is done -------------
	console.log('-- 4. failing piece, stalled');
	{
		await setStuck(A.page, 20);
		await openHeld(A, [fsrv.url('fail3', 'Flaky')]);
		await S.until(() => holdState(A.page), (s) => s.holding, '4: the hold begins');
		const done = await S.until(() => holdState(A.page), (s) => !s.holding, '4: the hold ends on its own', 15000);
		h.check(done.releasedBy === 'stalled', `4: every remaining piece is amber/red, so the hold ended (${done.releasedBy})`);
		h.check(done.heldFor < 9000, `4: …long before the 20 s cap (${Math.round(done.heldFor)} ms)`);
	}

	// ---- 5. Esc / 6. Take control ------------------------------------------------------------
	for (const how of ['Esc', 'Take control']) {
		console.log('-- ' + how);
		const piece = how === 'Esc' ? 'Held5' : 'Held6';
		await openHeld(A, [fsrv.url('hold', piece)]);
		await S.until(() => holdState(A.page), (s) => s.holding, `${how}: the hold begins`);
		if (how === 'Esc') {
			await A.page.waitForTimeout(800);
			await A.page.keyboard.press('Escape');
		} else {
			await A.page.locator('#start-view-take-control').waitFor({ state: 'visible', timeout: 5000 });
			await A.page.locator('#start-view-take-control').click();
		}
		const done = await S.until(() => holdState(A.page), (s) => !s.holding, `${how}: ends the hold`, 3000);
		h.check(done.releasedBy === 'user' && done.job, `${how}: …by the user, mid-load (${done.releasedBy})`);
		await A.page.evaluate(S.ARM);
		await S.orbitDrag(A.page);
		await A.page.waitForTimeout(800);
		h.check(S.dist((await S.camPose(A.page)).position, A.saved.position) > 1, `${how}: the camera is free at once`);
		await releaseWhenAsked(fsrv, '/hold/' + piece + '.glb');
		await S.loadEnded(A.page, `${how}: the load still finishes`, 30000);
		await A.page.waitForTimeout(400);
		h.check(S.dist((await S.camPose(A.page)).position, A.saved.position) > 1, `${how}: …and the end of the load does not take the camera back`);
		await S.disarm(A.page);
	}
	await A.ctx.close();

	// ---- 7. two peers ------------------------------------------------------------------------
	console.log('-- 7. two peers');
	{
		const P = await S.preparePeer(browser, 'P', index, SLUG, { storage: { placeholderStuckSeconds: '20' } });
		const Q = await S.preparePeer(browser, 'Q', index, SLUG);
		await h.connect(P, Q);
		await P.page.evaluate(() => window.__stores.openSceneSection('Camera:Start view'));
		await P.page.locator('#hold-camera-until-loaded').waitFor({ state: 'visible', timeout: 10000 });
		h.check((await P.page.locator('[data-tour="hold-camera-until-loaded"]').count()) === 1, '7: the setting carries its data-tour id');
		h.check(!(await P.page.locator('#hold-camera-until-loaded').isChecked()), '7: off by default');
		await P.page.locator('#hold-camera-until-loaded').click();
		await P.page.waitForTimeout(300);
		await S.shot(P.page, '05-hold-setting-dark.png');
		await P.page.evaluate(() => window.__stores.themes.theme.set('light'));
		await P.page.waitForTimeout(300);
		await S.shot(P.page, '06-hold-setting-light.png');
		await P.page.evaluate(() => window.__stores.themes.theme.set('dark'));
		h.check(await P.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug().holdCamera === true), '7: ticking it sets the scene setting');
		h.check(await P.page.evaluate(() => window.__stores.sessions.buildSessionPayload('x').physics?.holdCamera === true), '7: …and it is saved with the scene');
		await h.eventually(() => Q.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug().holdCamera === true), (v) => v, '7: the other peer has it');
		await Q.page.evaluate(() => window.__stores.openSceneSection('Camera:Start view'));
		await Q.page.locator('#hold-camera-until-loaded').waitFor({ state: 'visible', timeout: 10000 });
		h.check(await Q.page.locator('#hold-camera-until-loaded').isChecked(), "7: …and its own toggle shows it");
		// the loader holds; the other peer's camera is the other peer's
		const qBefore = await S.camPose(Q.page);
		await Q.page.evaluate(S.ARM);
		await P.page.evaluate(S.ARM);
		// a scene load replaces the scene settings: a file WITHOUT the setting does not hold (and
		// turns it off for the room — the file says the author was at the default)
		await openHeld(P, [fsrv.url('hold', 'HeldP')], false);
		const pState = await S.until(() => holdState(P.page), (s) => s.job, '7: the loader is loading');
		h.check(!pState.holding, '7: premise — a file without the setting does not hold');
		await releaseWhenAsked(fsrv, '/hold/HeldP.glb');
		await S.loadEnded(P.page, '7: that load ends', 30000);
		// now a scene saved WITH the setting, loaded on P with Q in the room
		await openHeld(P, [fsrv.url('hold', 'HeldP2')]);
		await S.until(() => holdState(P.page), (s) => s.holding, '7: a scene saved with the setting holds the loader');
		await Q.page.waitForTimeout(1500);
		const qState = await holdState(Q.page);
		h.check(!qState.holding, '7: the other peer is never held by somebody else’s load');
		await S.orbitDrag(Q.page);
		await Q.page.waitForTimeout(600);
		h.check(S.dist((await S.camPose(Q.page)).position, qBefore.position) > 1, '7: …and moves its own camera freely meanwhile');
		await releaseWhenAsked(fsrv, '/hold/HeldP2.glb');
		await S.loadEnded(P.page, '7: the load ends', 30000);
		h.check(!(await holdState(P.page)).holding, '7: the loader is free');
		await h.eventually(() => Q.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug().holdCamera === true), (v) => v, '7: the loaded scene brings its setting to the room');
		// and back off, from the other side
		await Q.page.locator('#hold-camera-until-loaded').click();
		await h.eventually(() => P.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug().holdCamera !== true), (v) => v, '7: unticking on the other peer turns it off for both');
		h.check(await P.page.evaluate(() => !('holdCamera' in window.__stores.scenePhysics.scenePhysicsDebug())), '7: off writes no key (a default scene stays byte-identical)');
	}
	fsrv.close?.();
	trickle.close?.();
	await h.finish(browser);
});
