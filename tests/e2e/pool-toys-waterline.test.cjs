// 49 P3: the Pool party toys float at a sensible WATERLINE. Inflatables and foam ride high;
// the buoyancy default (500 kg/m³) floats a body half under, which sank the beach ball and the
// rings to their middles. The template stamps foam density (150) on every toy, and this probe
// measures it: each toy's SUBMERGED FRACTION — how much of its height sits under the local
// water surface — averaged over a second of bobbing, after the scene has run. Afloat (bottom at the waterline)
// and riding high (< 35 %) for every toy. Red on the served scene before the stamp (~50 %).
// The scene file: POOL_TPSCENE, else the sibling scenes checkouts.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const FILE = [
	process.env.POOL_TPSCENE,
	...['scenes-lane-49-physics', 'scenes'].map((d) => path.resolve(__dirname, '../../..', d, 'examples/pool-party/scene.tpscene'))
].find((p) => p && fs.existsSync(p));

h.run(async () => {
	if (!FILE) {
		console.log('SKIP pool-toys-waterline (no pool-party scene file)');
		return;
	}
	console.log('scene', FILE);
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));
	const bytes = Array.from(fs.readFileSync(FILE));
	await A.page.evaluate(async (arr) => {
		const s = window.__tp?.test.v1;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	// the scene starts its own simulation on load (Start simulation on load)
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__tp.test.v1.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'premise: the Pool party simulates on load',
		15000
	);
	await A.page.waitForTimeout(8000);

	const sample = () =>
		A.page.evaluate(() => {
			const s = window.__tp?.test.v1;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const vol = s.sim.waterVolumes.list()[0];
			const box = new s.THREE.Box3();
			return g.children
				.filter((o) => o.userData?.physics?.mode === 'dynamic')
				.map((o) => {
					box.setFromObject(o);
					const c = o.getWorldPosition(new s.THREE.Vector3());
					const surface = vol ? s.sim.waterVolumes.surfaceY(vol, c.x, c.z, { flat: true }) : null;
					const height = box.max.y - box.min.y;
					const under = surface == null ? 0 : Math.min(Math.max((surface - box.min.y) / height, 0), 1);
					return { name: o.name, under, gap: surface == null ? 99 : box.min.y - surface, density: o.userData.physics.floats?.density ?? null };
				});
		});
	/** @type {Record<string, {sum: number, n: number, density: any}>} */
	const acc = {};
	for (let i = 0; i < 5; i++) {
		for (const t of await sample()) {
			acc[t.name] ??= { sum: 0, gap: 0, n: 0, density: t.density };
			acc[t.name].sum += t.under;
			acc[t.name].gap += t.gap;
			acc[t.name].n++;
		}
		await A.page.waitForTimeout(250);
	}
	const toys = Object.entries(acc).map(([name, a]) => ({ name, under: a.sum / a.n, gap: a.gap / a.n, density: a.density }));
	console.log('waterline', JSON.stringify(toys.map((t) => [t.name, +t.under.toFixed(3), t.density])));
	h.check(toys.length === 5, `premise: five floating toys (${toys.map((t) => t.name).join(', ')})`);
	for (const t of toys) {
		// afloat = its bottom at the waterline (waves are 2 cm), not resting on the deck or the pool floor
		h.check(t.under > 0 || t.gap < 0.05, `${t.name} is afloat, its bottom at the water (${(t.under * 100).toFixed(1)} % under, gap ${t.gap.toFixed(3)} m)`);
		h.check(t.under < 0.35, `${t.name} rides high like a foam toy (${(t.under * 100).toFixed(0)} % under, density ${t.density})`);
	}
	await h.finish(browser);
});
