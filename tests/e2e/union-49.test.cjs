// 49-int union: the two fluid lanes met in fluidRuntime + the GPU worker. 49-water (W1) lands a
// tank's pour on a W1 surface inside FluidSolver.step (landOnSurfaces, before x = p); 49-fluid
// (W2) runs the PBF step on the GPU and commits through its own mirror, so the landing has to
// ride the GPU stepper's `beforeCommit` hook and the GPU worker has to forward `splashes`.
//   U1  a tank on the GPU solver pours onto a pool crossing its glass: the pour LANDS (leaves the
//       tank) and the pool ripples where it lands — the same as on the CPU worker
//       (red without the hook: landed 0, ripples 0)
//   U2  a tank on the GPU solver standing in the pool keeps the fluid it holds
//   U3  the CPU worker (GPU fluid Off) still lands the same pour (W1 untouched by the switch)
const h = require('./helpers.cjs');

const WEBGPU_ARGS = [...h.GPU_ARGS, '--enable-unsafe-webgpu'];

/** @param {any} page @param {string} uuid */
const tankOf = (page, uuid) => page.evaluate((u) => window.__tp.test.v1.sim.fluidDebug().find((t) => t.uuid === u) ?? null, uuid);

/** the scene: a pool, a pouring tank and a resting tank standing in it @param {any} page */
const build = (page) =>
	page.evaluate(() => {
		const st = window.__tp?.test.v1;
		let g;
		st.objectsGroup.subscribe((v) => (g = v))();
		const last = () => g.children[g.children.length - 1];
		const pool = st.waterActions.makeWater(st.addObjects.spawnAtPoint('/create Box 3 0.8 3', [0, 0.4, -5]), 'pool');
		st.commandsHandler.sceneCommand('/create FluidTank 1.2 1.2 0.8');
		const pour = last();
		pour.position.set(-0.75, 0.6, -5);
		pour.updateMatrixWorld(true);
		st.sim.setFluidFor(pour.uuid, { fill: 0.12, count: 2000, emitter: { on: true, rate: 700, speed: 2 }, drain: { on: true, rate: 900, radius: 0.2 } });
		st.commandsHandler.sceneCommand('/create FluidTank 1.2 1.2 0.8');
		const rest = last();
		rest.position.set(0.8, 0.6, -5);
		rest.updateMatrixWorld(true);
		st.sim.setFluidFor(rest.uuid, { fill: 0.25, count: 1500 });
		let cam, orbit;
		st.editorCam.subscribe((v) => (cam = v))();
		st.orbitControls.subscribe((v) => (orbit = v))();
		cam.position.set(-0.2, 2.2, -1.6);
		orbit?.target?.set(-0.2, 0.5, -5);
		orbit?.update?.();
		cam.lookAt(-0.2, 0.5, -5);
		cam.updateMatrixWorld(true);
		return { pool: pool.uuid, pour: pour.uuid, rest: rest.uuid };
	});

h.run(async () => {
	const browser = await h.launch({ args: WEBGPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1100, height: 700 } } });

	// Auto with this device's verdict = GPU (a seeded calibration: the suite proves the union, not
	// the bench — fluid-gpu measures that). Off -> Auto re-reads the remembered verdict.
	const verdict = await A.page.evaluate(async () => {
		const fg = window.__tp.test.v1.fluidGpu;
		localStorage.setItem('fluid:gpuBench', JSON.stringify({ key: '1|' + navigator.userAgent, gpuMs: 1, cpuMs: 10, adapter: null, reason: '', at: Date.now() }));
		fg.gpuFluidPref.set('off');
		fg.gpuFluidPref.set('auto');
		return fg.gpuFluidDebug();
	});
	h.check(verdict.webgpu && verdict.verdict.state === 'gpu', `GPU fluid Auto picks the GPU on this device (${JSON.stringify(verdict.verdict)})`);

	const ids = await build(A.page);
	await h.eventually(() => tankOf(A.page, ids.pour), (t) => !!t && t.steps > 60, 'the pouring tank runs', 30000);
	await A.page.waitForTimeout(5000);
	const p1 = await tankOf(A.page, ids.pour);
	h.check(p1.solver === 'gpu', `U1 the pouring tank runs on the GPU solver (solver ${p1.solver})`);
	h.check(p1.surfaces === 1, `U1 ...and is sent the pool's surface (${p1.surfaces})`);
	h.check(p1.landed > 100, `U1 the GPU tank's pour LANDS on the pool and leaves the tank (${p1.landed} landed)`);
	h.check(p1.ripples >= 10, `U1 ...rippling it as it lands (${p1.ripples} ripples)`);
	const rest = await tankOf(A.page, ids.rest);
	h.check(rest.solver === 'gpu' && rest.count === 1500 && rest.landed === 0, `U2 the GPU tank standing in the pool keeps its fluid (${rest.solver}, ${rest.count}/1500, ${rest.landed} landed)`);
	const g = await A.page.evaluate(() => window.__tp.test.v1.fluidGpu.gpuFluidDebug());
	h.check(!g.failed, `U1 the GPU worker never failed (${g.failed || 'ok'})`);

	// U3: Off -> the CPU worker re-inits the tanks and lands the same pour
	await A.page.evaluate(() => window.__tp.test.v1.fluidGpu.gpuFluidPref.set('off'));
	await h.eventually(() => tankOf(A.page, ids.pour), (t) => !!t && t.solver === 'cpu' && t.landed > 100 && t.ripples >= 10, 'U3 the CPU tank lands the pour after Off', 30000);
	const p3 = await tankOf(A.page, ids.pour);
	h.check(p3.solver === 'cpu' && p3.landed > 100 && p3.ripples >= 10, `U3 GPU fluid Off: the CPU worker lands the pour too (${p3.solver}, ${p3.landed} landed, ${p3.ripples} ripples)`);

	await h.finish(browser);
});
