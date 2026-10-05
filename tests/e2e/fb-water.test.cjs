// 36-fb-water (1.25, F12-F18): water + sim fixes from real use, on the REAL authored example
// scenes. Sections run by ONLY=f12,f13,... (default: all). Evidence shots go to FBW_SHOTS.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.FBW_SHOTS || '';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (/** @type {string} */ id) => !ONLY.length || ONLY.includes(id);
const find = (/** @type {string} */ slug) =>
	[process.env.FBW_SCENES, ...['scenes-lane-36-fb-water', 'scenes'].map((d) => path.resolve(__dirname, '../../..', d, 'examples'))]
		.filter(Boolean)
		.map((dir) => path.join(/** @type {string} */ (dir), slug, 'scene.tpscene'))
		.find((p) => fs.existsSync(p));

/** @param {any} page @param {string} slug */
async function load(page, slug) {
	const file = find(slug);
	if (!file) throw new Error('scene not found: ' + slug);
	const bytes = Array.from(fs.readFileSync(file));
	await page.evaluate(async (/** @type {number[]} */ arr) => {
		const s = window.__stores;
		if (await new Promise((r) => s.physics.simulating.subscribe(r)())) s.physics.stopSimulation();
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
			window.__stores.objectActions.deselectObject?.();
		},
		[pos, target]
	);
}
/** @param {any} page @param {string} theme */
const setTheme = (page, theme) => page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
/** both themes, `NN-name-dark.png` / `-light.png` @param {any} page @param {string} name */
async function shots(page, name) {
	if (!SHOTS) return;
	for (const t of ['dark', 'light']) {
		await setTheme(page, t);
		await page.waitForTimeout(400);
		await page.screenshot({ path: path.join(SHOTS, `${name}-${t}.png`) });
	}
	await setTheme(page, 'dark');
}
/** @param {any} page @param {string[]} names */
const ys = (page, names) =>
	page.evaluate((ns) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return Object.fromEntries(ns.map((n) => [n, g.getObjectByName(n)?.position.y ?? null]));
	}, names);
const simulating = (page) => page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)()));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	await A.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));

	// ── F12: a body placed UNDER the water rises by density (Pool party) ────────────────────
	if (want('f12')) {
		await load(A.page, 'pool-party');
		await A.page.evaluate(() => {
			const cmd = window.__stores.commandsHandler.sceneCommand;
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const last = () => g.children[g.children.length - 1];
			const mk = (/** @type {string} */ name, /** @type {number} */ x, /** @type {any} */ floats, /** @type {string} */ color) => {
				cmd('/create Box 0.5 0.5 0.5');
				const o = last();
				o.name = name;
				o.position.set(x, -1.2, 0.4);
				o.material.color.set(color);
				// a new primitive is DYNAMIC by default (the user's case); only the density varies
				if (floats) o.userData.physics = { ...(o.userData.physics || { mode: 'dynamic', mass: 1 }), floats };
				o.updateMatrixWorld(true);
				return o.userData.physics?.mode;
			};
			window.__f12 = [mk('Probe default', -2, null, '#f2c14e'), mk('Probe foam', 0, { density: 150 }, '#f25f5c'), mk('Probe stone', 2, { density: 2500 }, '#555b6e')];
		});
		h.check((await A.page.evaluate(() => window.__f12)).every((m) => m === 'dynamic'), 'the three probes are dynamic (as Add ▸ Box makes them)');
		await look(A.page, [0, 0.35, 6.2], [0, -0.7, 0]);
		await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
		await h.eventually(() => simulating(A.page), (v) => v === true, 'simulation started');
		const dbg = await A.page.evaluate(() => window.__stores.physics.physicsWorldDebug());
		h.check(dbg.groundSlabs > 1, `the scene ground is cut around the sunk pool (${dbg.groundSlabs} slabs, holes ${dbg.groundHoles})`);
		let peakFoam = -Infinity;
		for (let i = 0; i < 30; i++) {
			await A.page.waitForTimeout(100);
			const y = (await ys(A.page, ['Probe foam']))['Probe foam'];
			peakFoam = Math.max(peakFoam, y);
		}
		await A.page.waitForTimeout(3500);
		const r = await ys(A.page, ['Probe default', 'Probe foam', 'Probe stone', 'Beach ball', 'Rubber duck']);
		h.check(r['Probe default'] > -0.12 && r['Probe default'] < 0.12, `a default body placed under water rises and floats at its draft (y ${r['Probe default'].toFixed(2)}; it stuck at -0.45 under the ground slab before)`);
		h.check(r['Probe foam'] > 0.08, `a foam body floats high (y ${r['Probe foam'].toFixed(2)})`);
		h.check(peakFoam > r['Probe foam'] + 0.02, `the foam body shot up past its rest height and bobbed (peak ${peakFoam.toFixed(2)})`);
		// added mass: it pops out, it does not leave like a rocket (2.9 m without it)
		h.check(peakFoam < 1, `...but only pops a little clear of the water (peak ${peakFoam.toFixed(2)} < 1 m)`);
		h.check(r['Probe stone'] < -1.2, `a stone sinks to the pool floor (y ${r['Probe stone'].toFixed(2)})`);
		h.check(r['Beach ball'] > -0.1 && r['Rubber duck'] > -0.1, `the authored toys still float (ball ${r['Beach ball'].toFixed(2)}, duck ${r['Rubber duck'].toFixed(2)})`);
		await shots(A.page, '10-after-F12-pool-submerged');
		await A.page.evaluate(() => window.__stores.physics.stopSimulation());
		// the new Flow & physics rows (Flow up, Bob damping) in the Water section
		await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			localStorage.setItem('inspector:sec:Water', 'open');
			window.__stores.objectActions.selectObject(g.getObjectByName('Pool water').uuid, true);
		});
		const bob = await A.page.waitForSelector('text=Bob damping', { timeout: 8000 }).then(() => true).catch(() => false);
		h.check(bob, 'Water ▸ Flow & physics shows Flow up + Bob damping');
		if (bob) {
			await A.page.evaluate(() => [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === 'Bob damping')?.scrollIntoView({ block: 'center' }));
			await A.page.waitForTimeout(300);
			await shots(A.page, '11-after-F12-flow-physics-params');
		}
		await A.page.evaluate(() => window.__stores.objectActions.deselectObject?.());
	}

	h.check((await h.pageErrors(A)).length === 0, 'no page errors');
	await h.finish(browser);
});
