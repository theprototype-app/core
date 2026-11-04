// 68 V3 + V7 — Film's AR WALK under IWER (the AR pose shim row) and what a PEER sees of a filming phone.
// Rows:
//   P. presence: B films through a camera → A's copy of that marker follows B's live camera (posed locally,
//      never saved), A is told "… is filming"; B stops → A's marker is back where it stands
//   W. walk: "Track my movement" asks for immersive-ar with #film-root as the dom-overlay; the phone walking
//      1 m forward moves the camera 1 m along its own heading; walk scale 5 → 5 m; turning the phone turns
//      the camera; the preview camera's mount maps the room onto the scene (the XR view is drawn from Film's pose)
//   R. a take while walking commits a shot whose keys cover the walked distance
//   X. Stop walking: the session ends, the mount is 1:1 again, Film carries on
// What stays MANUAL on the N6: ARCore tracking quality, the 90 s drift row, the iPhone permission prompt.
// Run: APP_URL=https://theprototype.app:5561/ node tests/e2e/film-walk-iwer.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const OUT = process.env.FILM_SHOTS || path.resolve(__dirname, '../../test-results/68-vcam');
fs.mkdirSync(OUT, { recursive: true });

const N6 = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };

/** IWER (a Quest 3 profile that also lists dom-overlay) + sessions that report the overlay they were given */
function initScript() {
	const base = iwer
		.initScript()
		.content.replace('new I.XRDevice(I["metaQuest3"])', 'new I.XRDevice({ ...I["metaQuest3"], supportedFeatures: [...I["metaQuest3"].supportedFeatures, "dom-overlay"] })');
	if (base === iwer.initScript().content) throw new Error('could not patch the IWER device config');
	return {
		content:
			base +
			`;(() => {
	const xr = navigator.xr;
	const request = xr.requestSession.bind(xr);
	xr.requestSession = (mode, init) => request(mode, init).then((s) => {
		if (init && init.domOverlay && init.domOverlay.root) Object.defineProperty(s, 'domOverlayState', { value: { type: 'screen' }, configurable: true });
		return s;
	});
})();`
	};
}

/** @param {number[]} q */
function forward(q) {
	const [x, y, z, w] = q;
	return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}
const yawDeg = (q) => {
	const f = forward(q);
	return (Math.atan2(-f[0], -f[2]) * 180) / Math.PI;
};
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (v) => Math.hypot(...v);
const flat = (v) => [v[0], 0, v[2]];

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const B = await h.setupPage(browser, 'B', { context: N6, init: initScript() });
	await h.connect(A, B);

	const page = B.page;
	const pose = () => page.evaluate(() => window.__stores.filmMode.filmPose());
	const markerOn = (peer, uuid) =>
		peer.page.evaluate((u) => {
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g?.getObjectByProperty('uuid', u);
			return o ? o.position.toArray() : null;
		}, uuid);

	// a camera both peers hold
	const uuid = await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 400));
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(() => markerOn(A, uuid), (p) => !!p, 'the camera reached peer A', 15000);
	const baseOnA = await markerOn(A, uuid);

	// ---- P. presence ----
	await page.evaluate((u) => window.__stores.filmState.openFilm(u), uuid);
	await page.waitForSelector('#film-exit', { timeout: 15000 });
	await page.evaluate(() => window.__stores.filmMode.placeCamera([3, 2, -4]));
	await h.eventually(() => markerOn(A, uuid), (p) => p && Math.abs(p[0] - 3) < 0.05 && Math.abs(p[1] - 2) < 0.05 && Math.abs(p[2] + 4) < 0.05, "A sees B's filming camera where B films from (the gizmo)", 10000);
	const filming = await A.page.evaluate(() => {
		let v = null;
		window.__stores.filmPresence?.filmingPeers?.subscribe((x) => (v = x))();
		return v;
	});
	h.check(!filming || Object.keys(filming).length === 1, `A knows one peer is filming (${JSON.stringify(filming)})`);
	const toast = A.page.locator('.tp-toast', { hasText: 'is filming through' });
	h.check((await toast.count()) >= 1, 'A is told the peer is filming, with Watch the shot');
	const savedOnA = await A.page.evaluate((u) => {
		// what a save would write: parked at the base, never the presence pose
		const pp = window.__stores.propPlayback?.propPlaybackDebug?.() ?? [];
		return pp.filter((e) => e.uuid === u).map((e) => ({ owner: e.owner, base: e.base }));
	}, uuid);
	h.check(savedOnA.every((e) => e.owner.startsWith('filmpeer:')), `the pose on A is presence (owner filmpeer:…), base kept (${JSON.stringify(savedOnA).slice(0, 160)})`);

	// ---- W. walk ----
	const entry = await page.evaluate(() => {
		let v = null;
		window.__stores.filmWalk.walkEntry.subscribe((x) => (v = x))();
		return v;
	});
	h.check(entry === 'ready', `IWER offers immersive-ar, so Track my movement is offered (${entry})`);
	await page.locator('#film-settings-btn').click();
	const n0 = await page.evaluate(() => window.__iwer.sessions.length);
	await page.locator('#film-walk').click();
	await h.eventually(() => iwer.state(page), (s) => s.presenting, 'three presents the AR walk session', 15000);
	const req = await page.evaluate((n0) => {
		const s = window.__iwer.sessions[n0];
		return s ? { mode: s.mode, root: s.init?.domOverlay?.root?.id ?? null } : null;
	}, n0);
	h.check(req && req.mode === 'immersive-ar' && req.root === 'film-root', `the walk asks for immersive-ar with Film as the overlay (${JSON.stringify(req)})`);
	await h.eventually(() => page.evaluate(() => window.__stores.filmWalk.filmWalkDebug()), (d) => d.on && d.tracking, 'the phone is tracked', 10000);
	await iwer.frames(page, 6);
	const p0 = await pose();
	const fwd = flat(forward(p0.qBase));
	await iwer.pose(page, 'head', [0, 1.6, -1]);
	await iwer.frames(page, 8);
	let p1 = await pose();
	let d = sub(p1.pos, p0.pos);
	const along = (d[0] * fwd[0] + d[2] * fwd[2]) / (len(fwd) || 1);
	h.check(Math.abs(len(d) - 1) < 0.05 && along > 0.95, `1 m walked forward = 1 m along the camera's heading (moved ${len(d).toFixed(3)} m, along ${along.toFixed(3)})`);
	await page.evaluate(() => window.__stores.filmWalk.setWalkScale(5));
	await iwer.frames(page, 4);
	const p2 = await pose();
	h.check(len(sub(p2.pos, p1.pos)) < 0.05, 'changing the walk scale re-anchors where you stand (no jump)');
	await iwer.pose(page, 'head', [0, 1.6, -2]);
	await iwer.frames(page, 8);
	const p3 = await pose();
	h.check(Math.abs(len(sub(p3.pos, p2.pos)) - 5) < 0.15, `walk scale 5: 1 m walked = 5 m in the scene (${len(sub(p3.pos, p2.pos)).toFixed(2)} m)`);
	const mountScale = await page.evaluate(() => {
		let m = null;
		window.__stores.filmState.filmCameraMount.subscribe((v) => (m = v))();
		return m ? m.scale.x : null;
	});
	h.check(mountScale === 5, `the AR view is drawn at walk scale 5 (the camera mount's scale ${mountScale})`);
	await iwer.pose(page, 'head', [0, 1.6, -2], { yaw: Math.PI / 2 });
	await iwer.frames(page, 8);
	const p4 = await pose();
	let turned = yawDeg(p4.qBase) - yawDeg(p3.qBase);
	turned = ((turned + 540) % 360) - 180;
	h.check(Math.abs(turned - 90) < 3, `turning the phone 90° left turns the camera 90° left (${turned.toFixed(1)}°)`);
	// the XR view is drawn from Film's pose: the EYE cameras' midpoint, taken through the inverse rig, is the film pose
	// (not the combined XR camera — three pulls that back to fit both frustums, and the walk scale multiplies the pull)
	const drawnAt = await page.evaluate(() => {
		const w = window.__stores;
		let renderer = null;
		let rig = null;
		w.globalRenderer.subscribe((v) => (renderer = v))();
		w.worldRig?.subscribe?.((v) => (rig = v))();
		// matrixWorld as three left it (the eye cameras have no parent: getWorldPosition would recompute it without the mount)
		const eyes = renderer.xr.getCamera().cameras;
		const p = eyes[0].position.clone().set(0, 0, 0);
		for (const e of eyes) p.add(e.position.clone().setFromMatrixPosition(e.matrixWorld).divideScalar(eyes.length));
		if (rig) p.applyMatrix4(rig.matrixWorld.clone().invert());
		return p.toArray();
	});
	h.check(len(sub(drawnAt, p4.pos)) < 0.05, `the AR view is drawn from where Film says the camera is (${drawnAt.map((v) => v.toFixed(2))} vs ${p4.pos.map((v) => v.toFixed(2))})`);
	await page.screenshot({ path: path.join(OUT, 'film-walk-iwer.png') });
	// the peer follows the walking camera too
	await h.eventually(() => markerOn(A, uuid), (p) => p && len(sub(p, p4.pos)) < 0.5, "A sees the walking camera move", 8000);

	// ---- R. a take while walking ----
	const seqId = await page.evaluate(() => {
		const w = window.__stores;
		const id = w.sequences.createSequence('Walk');
		w.sequences.setSequence(id, { duration: 30, tracks: [] });
		w.sequences.activeSequence.set(id);
		return id;
	});
	await page.locator('#film-record').click();
	await h.eventually(() => page.evaluate(() => { let u = null; window.__stores.filmRecorder.take.subscribe((v) => (u = v))(); return u.state; }), (s) => s === 'recording', 'recording while walking', 8000);
	for (let i = 1; i <= 6; i++) {
		await iwer.pose(page, 'head', [-i * 0.25, 1.6, -2], { yaw: Math.PI / 2 });
		await iwer.frames(page, 4);
	}
	await page.locator('#film-record').click();
	await h.eventually(() => page.evaluate(() => { let u = null; window.__stores.filmRecorder.take.subscribe((v) => (u = v))(); return u.state === 'paused' && !u.saving; }), (v) => v, 'the walking take committed', 15000);
	const span = await page.evaluate(({ id, u }) => {
		let all = null;
		window.__stores.sequences.sequences.subscribe((v) => (all = v))();
		const tr = all[id].tracks.find((t) => t.kind === 'prop' && t.target === u && t.path === 'position');
		if (!tr) return null;
		const a = tr.keys[0].v;
		const b = tr.keys[tr.keys.length - 1].v;
		return { keys: tr.keys.length, dist: Math.hypot(b[0] - a[0], b[2] - a[2]) };
	}, { id: seqId, u: uuid });
	h.check(span && span.dist > 5 && span.dist < 9, `the take's keys cover the walk (1.5 m × 5 = 7.5 m; got ${JSON.stringify(span)})`);
	await page.evaluate(() => window.__stores.filmRecorder.finishTake());

	// ---- X. stop walking ----
	await page.locator('#film-walk-chip').click();
	await h.eventually(() => iwer.state(page), (s) => !s.presenting, 'Stop walking ends the session', 10000);
	const mount = await page.evaluate(() => {
		let m = null;
		window.__stores.filmState.filmCameraMount.subscribe((v) => (m = v))();
		return m ? { p: m.position.toArray(), s: m.scale.x, q: m.quaternion.toArray() } : null;
	});
	h.check(!!mount && len(mount.p) < 1e-9 && mount.s === 1 && Math.abs(mount.q[3]) === 1, `the preview camera's mount is 1:1 again (${JSON.stringify(mount)})`);
	h.check(await page.evaluate(() => document.documentElement.classList.contains('film-mode')), 'Film carries on after the walk');

	// ---- P (end). B leaves Film → A's marker is back ----
	await page.locator('#film-exit').click();
	await h.eventually(() => markerOn(A, uuid), (p) => p && len(sub(p, baseOnA)) < 1e-6, "A's marker is back where it stands when B stops filming", 8000);

	await h.closePeer(B);
	await h.closePeer(A);
	await h.finish(browser);
});
