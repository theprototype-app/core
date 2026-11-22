// 92-correct row 4 — WALK SPEED IS PER SECOND: holding W for 5 s covers the same distance at the
// page's own frame rate and under a throttled tab (CPU throttled 6x: a handful of frames a second),
// in fly mode (no controller: the scroll-wheel speed 0.1) and in walk mode (a Character Controller).
// An old scene keeps its feel: 0.1 per 60 Hz frame = 6 units a second.
//
// Red on v1.74.0: fly moved 0.1 per FRAME (at 3 fps headless that is 1.5 units in 5 s, not 30) and
// walk counted at most 0.1 s per frame, so a throttled tab fell short.
//
// Run: APP_URL=https://localhost:5927/ npm run e2e -- walk-per-second
const h = require('./helpers.cjs');

const E = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);

/** the rig's world xz @param {any} p */
const camXZ = (p) =>
	E(p, () => {
		/** @type {any} */
		let cam;
		/** @type {any} */ (window).__tp.test.v1.playerCam.subscribe((/** @type {any} */ c) => (cam = c))();
		const w = cam.getWorldPosition(new (/** @type {any} */ (window).__tp.test.v1.THREE.Vector3)());
		return [w.x, w.z];
	});
/** level the rig at the origin, looking down -Z @param {any} p */
const home = (p) =>
	E(p, () => {
		/** @type {any} */
		let cam;
		/** @type {any} */ (window).__tp.test.v1.playerCam.subscribe((/** @type {any} */ c) => (cam = c))();
		cam.rotation.set(0, 0, 0);
		const v = new (/** @type {any} */ (window).__tp.test.v1.THREE.Vector3)(0, 1.7, 0);
		if (cam.parent) cam.parent.worldToLocal(v);
		cam.position.copy(v);
		cam.updateMatrixWorld(true);
	});
/** hold W for `ms` (page time), return the distance, the frames and the wall time it took
 * @param {any} p @param {number} ms */
async function hold(p, ms) {
	await home(p);
	await p.page.waitForTimeout(300);
	const a = await camXZ(p);
	await E(p, () => {
		const s = (/** @type {any} */ (window).__holdSampler = { n: 0, on: true, t0: performance.now() });
		const tick = () => {
			s.n++;
			if (s.on) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await p.page.keyboard.down('KeyW');
	await p.page.waitForTimeout(ms);
	await p.page.keyboard.up('KeyW');
	const frames = await E(p, () => {
		const s = /** @type {any} */ (window).__holdSampler;
		s.on = false;
		const held = (performance.now() - s.t0) / 1000;
		return { n: s.n, held };
	});
	await p.page.waitForTimeout(300);
	const b = await camXZ(p);
	return { d: Math.hypot(b[0] - a[0], b[1] - a[1]), fps: frames.n / frames.held, held: frames.held };
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.isLocked.set(true));
	await A.page.waitForTimeout(800);
	const cdp = await A.page.context().newCDPSession(A.page);

	for (const mode of ['fly', 'walk']) {
		if (mode === 'walk')
			await E(A, () => {
				const s = /** @type {any} */ (window).__tp.test.v1;
				s.setActiveGraph(s.SCENE_GRAPH);
				s.flowNodes.set([{ id: 'cc', type: 'charcontroller', position: { x: 0, y: 0 }, data: { type: 'charcontroller', mode: 'walk', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7, gravity: true } }]);
				s.flowEdges.set([]);
			});
		await A.page.waitForTimeout(1200);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		const normal = await hold(A, 5000);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
		const slow = await hold(A, 5000);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		const want = 6 * normal.held; // 0.1 per 60 Hz frame = 6 units a second
		console.log(`  ${mode}: ${normal.d.toFixed(2)} m at ${normal.fps.toFixed(1)} fps, ${slow.d.toFixed(2)} m at ${slow.fps.toFixed(1)} fps (want ~${want.toFixed(1)})`);
		h.check(normal.d > want * 0.8 && normal.d < want * 1.15, `${mode}: 5 s of W covers ~6 units a second at the page's rate (${normal.d.toFixed(2)} of ${want.toFixed(1)}; red on v1.74.0 for fly: frames x 0.1)`);
		h.check(Math.abs(slow.d - normal.d) / normal.d < 0.2, `${mode}: the same distance under a throttled tab (${slow.d.toFixed(2)} vs ${normal.d.toFixed(2)} at ${slow.fps.toFixed(1)} fps)`);
	}

	await browser.close();
});
