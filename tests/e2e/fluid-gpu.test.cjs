// 49-fluid W2 — the WebGPU fluid solver behind Settings ▸ Performance ▸ "GPU fluid" (Auto / Off).
// What it proves, in the real app on the real GPU (Linux Chromium needs --enable-unsafe-webgpu and
// Vulkan for that; without them the adapter is SwiftShader):
//   1. PARITY: the GPU step and the CPU step, same tank and start, 200 tipped-then-settling steps:
//      same count, nobody outside the glass, the same mean position (the "same visual result").
//   2. AUTO: a fresh device measures itself once, picks the GPU only when it is clearly faster,
//      and a tank runs on the solver it picked (fluidDebug().solver); the verdict is remembered.
//   3. OFF: the tank goes back to the CPU worker and refills with the same particle count.
//   4. FALLBACK: a LOST DEVICE (device.destroy() in the GPU worker, the real device.lost path)
//      puts the tank back on the CPU and it keeps stepping; a browser WITHOUT WebGPU never tries.
//   5. The Settings row says which solver Auto chose and why.
// Peers need no proof here: the solver is LOCAL and only userData.fluid replicates (sim-fluid).
const h = require('./helpers.cjs');

const WEBGPU_ARGS = [...h.GPU_ARGS, '--enable-unsafe-webgpu'];

/** @param {any} page */
const fluid = (page) => page.evaluate(() => window.__tp.test.v1.sim.fluidDebug()[0] ?? null);
/** @param {any} page */
const gpuState = (page) => page.evaluate(() => window.__tp.test.v1.fluidGpu.gpuFluidDebug());

/** @param {any} page @param {number} count */
async function makeTank(page, count) {
	return page.evaluate((n) => {
		window.__tp.test.v1.commandsHandler.sceneCommand('/create FluidTank 1.6 1 1');
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const tank = g.children[g.children.length - 1];
		tank.userData.fluid = { ...tank.userData.fluid, count: n };
		tank.position.set(0, 0.6, 0);
		tank.updateMatrixWorld(true);
		return tank.uuid;
	}, count);
}

/** @param {any} page */
async function look(page) {
	await page.evaluate(() => {
		let cam, orbit;
		window.__tp.test.v1.editorCam.subscribe((v) => (cam = v))();
		window.__tp.test.v1.orbitControls.subscribe((v) => (orbit = v))();
		cam.position.set(0, 2.2, 3.4);
		if (orbit?.target) {
			orbit.target.set(0, 0.5, 0);
			orbit.update?.();
		}
		cam.lookAt(0, 0.5, 0);
		cam.updateMatrixWorld(true);
	});
}

h.run(async () => {
	const browser = await h.launch({ args: WEBGPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });

	// ---------- 1. parity, solver against solver ----------
	const parity = await A.page.evaluate(async () => {
		const core = await import('/src/lib/sim/fluidCore.js');
		const gc = await import('/src/lib/sim/fluidGpuCore.js');
		const { device, info } = await gc.requestFluidDevice();
		const min = [-0.6, -0.4, -0.3], max = [0.6, 0.4, 0.3];
		const sp = core.spacingFor([1.2, 0.8, 0.6], 6000, 0.4);
		const mk = () => {
			const s = new core.FluidSolver({ min, max, capacity: 6000, spacing: sp });
			s.fillBlock(0.4, 6000);
			return s;
		};
		const a = mk(), g = mk();
		const st = new gc.GpuFluidStepper(device, g);
		const stats = (s) => {
			let x = 0, y = 0, out = 0;
			for (let i = 0; i < s.count; i++) {
				x += s.x[i * 3];
				y += s.x[i * 3 + 1];
				for (let k = 0; k < 3; k++) if (s.x[i * 3 + k] < min[k] - 0.01 || s.x[i * 3 + k] > max[k] + 0.01) out++;
			}
			return { n: s.count, mx: x / s.count, my: y / s.count, out };
		};
		const box = { kind: 'box', center: [0.2, -0.2, 0], half: [0.08, 0.15, 0.08], quat: [0, 0.38268, 0, 0.92388], dynamic: true, id: 'crate' };
		let worst = 0;
		for (let k = 0; k < 200; k++) {
			const m = { gravity: [k < 80 ? 4 : 0, -9.81, 0], viscosity: 0.1, surfaceTension: 0.5, colliders: [box] };
			a.step(1 / 60, m);
			await st.step(1 / 60, m);
			if (k % 20 === 19) {
				const c = stats(a), q = stats(g);
				worst = Math.max(worst, Math.abs(c.mx - q.mx), Math.abs(c.my - q.my));
			}
		}
		st.destroy();
		return { cpu: stats(a), gpu: stats(g), worst, adapter: info, impC: a.impulses.crate, impG: g.impulses.crate };
	});
	console.log('parity', JSON.stringify(parity));
	h.check(!parity.adapter.fallback && parity.adapter.vendor !== 'google', `the real GPU answers, not SwiftShader (${JSON.stringify(parity.adapter)})`);
	h.check(parity.gpu.n === parity.cpu.n && parity.gpu.n === 6000, `same particle count on both solvers (${parity.cpu.n} / ${parity.gpu.n})`);
	h.check(parity.gpu.out === 0 && parity.cpu.out === 0, `nobody leaves the glass (cpu ${parity.cpu.out}, gpu ${parity.gpu.out} outside)`);
	h.check(parity.worst < 0.02, `the GPU tank sloshes like the CPU one: mean position within 2 cm all the way (worst ${parity.worst.toFixed(4)} m)`);
	h.check(!!parity.impG && parity.impG[1] > 0 && Math.abs(parity.impG[1] - parity.impC[1]) < Math.max(0.3, Math.abs(parity.impC[1])), `a dynamic crate in the fluid is pushed up on both (cpu ${JSON.stringify(parity.impC)}, gpu ${JSON.stringify(parity.impG)})`);

	// ---------- 2. Auto measures this device once and picks ----------
	const s0 = await gpuState(A.page);
	h.check(s0.pref === 'auto' && s0.webgpu, `default is Auto and this browser has WebGPU (${JSON.stringify(s0)})`);
	await makeTank(A.page, 8000);
	await look(A.page);
	await h.eventually(() => gpuState(A.page), (s) => s.verdict.state === 'gpu' || s.verdict.state === 'cpu', 'Auto finishes measuring', 30000);
	const s1 = await gpuState(A.page);
	console.log('verdict', JSON.stringify(s1.verdict));
	h.check(typeof s1.verdict.cpuMs === 'number' && typeof s1.verdict.gpuMs === 'number', `the measurement has both numbers (cpu ${s1.verdict.cpuMs?.toFixed(1)} ms, gpu ${s1.verdict.gpuMs?.toFixed(1)} ms)`);
	h.check(s1.verdict.state === (s1.verdict.gpuMs <= s1.verdict.cpuMs * 0.75 ? 'gpu' : 'cpu'), `the verdict follows the rule (gpu <= 75 % of cpu -> gpu): ${s1.verdict.state}`);
	h.check(s1.verdict.state === 'gpu', `on this machine the GPU is clearly faster, so Auto runs it (${s1.verdict.gpuMs?.toFixed(1)} vs ${s1.verdict.cpuMs?.toFixed(1)} ms)`);
	await h.eventually(() => fluid(A.page), (f) => !!f && f.solver === 'gpu' && f.count >= 7000 && f.steps > 30, 'the tank fills and steps on the GPU', 30000);
	const fg = await fluid(A.page);
	console.log('gpu tank', JSON.stringify(fg));
	h.check(fg.solver === 'gpu' && fg.mode === 'ssf', `the tank runs on the GPU and still draws screen-space fluid (${fg.solver}, ${fg.mode})`);
	const remembered = await A.page.evaluate(() => JSON.parse(window.__tp.test.v1.safeStorage?.getItem?.('fluid:gpuBench') ?? localStorage.getItem('fluid:gpuBench') ?? 'null'));
	h.check(!!remembered && remembered.gpuMs === s1.verdict.gpuMs, 'the verdict is remembered for this device (no second measurement next load)');

	// ---------- 5. the Settings row says so ----------
	await A.page.evaluate(() => {
		window.__tp.test.v1.settingsSection.set('scene');
		window.__tp.test.v1.settingsOpen.set(true);
	});
	await A.page.waitForSelector('#row-gpu-fluid', { timeout: 10000 });
	const rowText = await A.page.locator('#row-gpu-fluid').innerText();
	h.check(/GPU fluid/.test(rowText) && /On here/.test(rowText) && /8000 particles/.test(rowText), `the row names the choice and the numbers ("${rowText.replace(/\s+/g, ' ').slice(0, 160)}")`);

	// ---------- 3. Off: back to the CPU worker, same count ----------
	await A.page.locator('#gpu-fluid').getByText('Off', { exact: true }).click();
	await A.page.evaluate(() => window.__tp.test.v1.settingsOpen.set(false));
	await h.eventually(() => fluid(A.page), (f) => !!f && f.solver === 'cpu' && f.count >= 7000 && f.steps > 5, 'Off puts the tank on the CPU', 30000);
	const fc = await fluid(A.page);
	h.check(fc.count === fg.count, `the CPU tank holds the same particle count (${fc.count} / ${fg.count})`);
	h.check((await gpuState(A.page)).verdict.state === 'off', 'the verdict reads Off');
	await A.page.evaluate(() => window.__tp.test.v1.fluidGpu.gpuFluidPref.set('auto'));
	await h.eventually(() => fluid(A.page), (f) => !!f && f.solver === 'gpu' && f.steps > 5, 'back to Auto: the remembered verdict, straight onto the GPU', 30000);
	h.check((await gpuState(A.page)).verdict.at === s1.verdict.at, 'Auto again did not measure again (same verdict stamp)');

	// ---------- 4a. a lost device falls back to the CPU and keeps pouring ----------
	await A.page.evaluate(() => window.__tp.test.v1.fluidGpu.loseGpuDeviceForTest());
	await h.eventually(() => gpuState(A.page), (s) => s.verdict.state === 'failed', 'the lost device is noticed', 15000);
	const s4 = await gpuState(A.page);
	h.check(/lost/.test(s4.failed), `the reason is the lost device (${s4.failed})`);
	await h.eventually(() => fluid(A.page), (f) => !!f && f.solver === 'cpu' && f.steps > 10 && f.count >= 7000, 'the tank re-inits on the CPU and steps', 30000);
	h.check(true, 'after a lost device the tank pours on the CPU');

	// ---------- 4b. a browser without WebGPU never tries ----------
	const B = await h.setupPage(browser, 'B', {
		context: { viewport: { width: 1280, height: 720 } },
		init: () => {
			try {
				Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
			} catch {}
		}
	});
	const sb = await gpuState(B.page);
	h.check(!sb.webgpu && sb.verdict.state === 'unavailable', `no WebGPU: Auto says unavailable (${JSON.stringify(sb.verdict)})`);
	await makeTank(B.page, 3000);
	await h.eventually(() => fluid(B.page), (f) => !!f && f.solver === 'cpu' && f.steps > 10, 'without WebGPU the tank runs on the CPU at once', 30000);

	await h.finish(browser);
});
