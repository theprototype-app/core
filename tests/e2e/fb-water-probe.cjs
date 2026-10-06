// scratch probe (not committed): F13b outline vs refracted image
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const SC = path.resolve(__dirname, '../../../scenes-lane-36-fb-water/examples');
const OUT = '/home/deck/.code/lanes-30/after-36/36-fb-water/diag';
fs.mkdirSync(OUT, { recursive: true });
async function load(page, slug) {
	const bytes = Array.from(fs.readFileSync(path.join(SC, slug, 'scene.tpscene')));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(4000);
}
async function look(page, p, t) {
	await page.evaluate(([p, t]) => {
		let cam, orbit;
		window.__stores.editorCam.subscribe((v) => (cam = v))();
		window.__stores.orbitControls.subscribe((v) => (orbit = v))();
		cam.position.set(...p); orbit?.target?.set(...t); orbit?.update?.(); cam.lookAt(...t);
	}, [p, t]);
}
const sel = (page, name) => page.evaluate((n) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); const o = g.getObjectByName(n); window.__stores.objectActions.selectObject(o.uuid); return o.position.toArray(); }, name);
h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	await load(A.page, 'fluid-tank-toy');
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(7000);
	const d = await sel(A.page, 'Duck 1');
	console.log('duck', d);
	await look(A.page, [d[0] + 0.1, d[1] + 0.35, d[2] + 1.5], d);
	await A.page.waitForTimeout(1500);
	await A.page.screenshot({ path: path.join(OUT, 'f13b-tank-duck.png') });
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await load(A.page, 'aquarium');
	const wb = await A.page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); const T = window.__stores.THREE; const b = new T.Box3().setFromObject(g.getObjectByName('Aquarium water')); return [b.min.toArray(), b.max.toArray()]; });
	console.log('water box', JSON.stringify(wb));
	const f = await sel(A.page, 'Fish orange');
	console.log('fish', f);
	await look(A.page, [f[0] + 0.3, f[1] + 0.2, wb[1][2] + 1.4], f);
	await A.page.waitForTimeout(1500);
	await A.page.screenshot({ path: path.join(OUT, 'f13b-aquarium-fish.png') });
	await look(A.page, [f[0] + 1.2, wb[1][1] + 1.2, wb[1][2] + 0.6], f);
	await A.page.waitForTimeout(1500);
	await A.page.screenshot({ path: path.join(OUT, 'f13b-aquarium-fish-above.png') });
	await h.finish(browser);
});
