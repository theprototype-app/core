// 36-sim demos, loaded from the REAL authored .tpscene files: the Jelly room (Jiggle), the
// Fluid tank toy (two tanks, floating ducks) and 36-water's Pool party (toys float through
// I1 buoyancy). Each is skipped when its file is not found. Shots to SIM_SHOTS.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.SIM_SHOTS || '';
const find = (/** @type {string} */ rel, /** @type {string | undefined} */ env) =>
	[env, ...['scenes-lane-36-sim', 'scenes-lane-36-water', 'scenes'].map((d) => path.resolve(__dirname, '../../..', d, rel))].find(
		(p) => p && fs.existsSync(p)
	);
const JELLY = find('examples/jelly-room/scene.tpscene', process.env.JELLY_TPSCENE);
const TANK = find('examples/fluid-tank-toy/scene.tpscene', process.env.TANK_TPSCENE);
const POOL = find('examples/pool-party/scene.tpscene', process.env.POOL_TPSCENE);

/** @param {any} page @param {string} file */
async function load(page, file) {
	const bytes = Array.from(fs.readFileSync(file));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		if (s.physics.simulating && (await new Promise((r) => s.physics.simulating.subscribe(r)()))) s.physics.stopSimulation();
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2500);
}
/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__stores.editorCam.subscribe((v) => (cam = v))();
			window.__stores.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			orbit?.target?.set(t[0], t[1], t[2]);
			orbit?.update?.();
			cam.lookAt(t[0], t[1], t[2]);
			window.__stores.objectActions.selectObject(null);
		},
		[pos, target]
	);
}
/** @param {any} page @param {string} name */
const yOf = (page, name) =>
	page.evaluate((n) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.find((o) => o.name === n)?.position.y ?? null;
	}, name);
const sim = (page) => page.evaluate(() => window.__stores.physics.toggleSimulation());

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	await A.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));

	if (JELLY) {
		await load(A.page, JELLY);
		await h.eventually(() => A.page.evaluate(() => window.__stores.sim.jiggleDebug().length), (n) => n === 5, 'Jelly room: five jellies jiggle', 8000);
		await look(A.page, [0, 3.4, 7.5], [0, 1, 0]);
		await sim(A.page);
		await A.page.waitForTimeout(1200);
		const wob = await A.page.evaluate(() => Math.max(...window.__stores.sim.jiggleDebug().map((d) => Math.abs(d.wobble))));
		h.check(wob > 0.01, `the jellies wobble after landing (${wob.toFixed(3)})`);
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '09-demo-jelly-room.png') });
		await sim(A.page);
	} else console.log('SKIP jelly-room (no file)');

	if (TANK) {
		await load(A.page, TANK);
		await look(A.page, [0, 2.3, 3.6], [0, 0.9, 0]);
		await h.eventually(() => A.page.evaluate(() => window.__stores.sim.fluidDebug()), (t) => t.length === 2 && t.every((x) => x.count > 500 && x.steps > 20), 'Fluid tank toy: both tanks run', 20000);
		await sim(A.page);
		await A.page.waitForTimeout(5000);
		const duck = await yOf(A.page, 'Duck 1');
		// the water tank's floor is at 1.05 - 0.45 = 0.6; fill 0.4 of 0.87 -> surface near 0.95
		h.check(duck !== null && duck > 0.75 && duck < 1.6, `a duck floats on the poured water (y ${duck?.toFixed(2)})`);
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '10-demo-fluid-tank-toy.png') });
		await sim(A.page);
	} else console.log('SKIP fluid-tank-toy (no file)');

	if (POOL) {
		await load(A.page, POOL);
		const toys = await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const pool = g.children.find((o) => o.userData?.water);
			const vols = window.__stores.sim.waterVolumes.list();
			return {
				pool: pool?.name ?? null,
				surface: vols[0] ? window.__stores.sim.waterVolumes.surfaceY(vols[0], pool.position.x, pool.position.z, { flat: true }) : null,
				toys: g.children.filter((o) => o.userData?.physics?.mode === 'dynamic').map((o) => o.name)
			};
		});
		h.check(!!toys.pool && toys.surface !== null, `Pool party: a W1 water volume (${toys.pool}, surface ${toys.surface?.toFixed(2)})`);
		const pos = await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const pool = g.children.find((o) => o.userData?.water);
			return pool.position.toArray();
		});
		await look(A.page, [pos[0] + 6, pos[1] + 5, pos[2] + 8], pos);
		await sim(A.page);
		await A.page.waitForTimeout(8000);
		const ys = await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return Object.fromEntries(g.children.filter((o) => o.userData?.physics?.mode === 'dynamic').map((o) => [o.name, o.position.y]));
		});
		const afloat = Object.entries(ys).filter(([, y]) => Math.abs(y - toys.surface) < 0.6);
		h.check(afloat.length >= Math.ceil(toys.toys.length / 2), `pool toys float at the surface (${afloat.map(([n]) => n).join(', ')} of ${toys.toys.length})`);
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '11-demo-pool-party-toys.png') });
		console.log('pool toy heights', JSON.stringify(ys), 'surface', toys.surface);
		await sim(A.page);
	} else console.log('SKIP pool-party (no file)');

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A).slice(0, 2))})`);
	await browser.close();
});
