// 106 proof — WHAT EACH LEVEL DRAWS, measured in pixels on a fixed synthetic scene (an 800 m ground, a cube at
// 1 / 20 / 200 m sized to its distance, a long bar crossing the cascade split), the environment rig sun low and
// behind so every shadow falls toward the camera:
//   1. per level (Basic / Soft / Far): at each distance, a point in the cube's shadow vs a lit point beside it
//      (shadow ratio), a point just off the cube's base on the shadow side (PETER-PANNING: a shadow pushed off its
//      caster leaves that point lit) and a 7x7 patch of open lit ground (ACNE: the share of its samples drawn
//      darker than 85 % of the patch median);
//   2. Far only — CASCADE SEAMS: the bar's shadow sampled every 5 m from 10 m to 185 m: dark all the way, and no
//      jump between neighbours (a seam or a gap at the split shows as a jump);
//   3. Far — A MOVING SUN: three sun positions, the 20 m cube's shadow follows each and the frame never goes black;
//   4. the levels differ on screen (Basic vs Soft vs Far), and Basic after Far is Basic again (pixel floor).
// Rendered with renderer.render (shadow passes + scene, no post) and read back in the same task, so the numbers
// are the shadow maps' own. Screenshots of the full app canvas (post and contact included) go to OUT for review.
//
//   APP_URL=https://theprototype.app:7201/ e2e-slot --dev $PWD 7201 -- node tests/e2e/shadow-levels-106.test.cjs
// env: OUT (screenshot dir, default test-results/106-shadows/levels), E2E_GPU=1 for a GPU slot.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'test-results', '106-shadows', 'levels');
const VIEW = { width: 960, height: 600 };
const DISTANCES = [1, 20, 200];
const SUN = [6, 8, -10];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** page side: the synthetic scene + helpers on window.__t106 */
const SETUP = () => {
	const s = window.__stores;
	const T = s.THREE;
	const read = (st) => {
		let v;
		st.subscribe((x) => (v = x))();
		return v;
	};
	s.qualityGovernor?.keepFullQuality?.();
	const g = read(s.objectsGroup);
	const add = (mesh, name) => {
		mesh.name = name;
		g.add(mesh);
		return mesh;
	};
	const mat = (c) => new T.MeshStandardMaterial({ color: c, roughness: 1, metalness: 0 });
	const ground = add(new T.Mesh(new T.PlaneGeometry(800, 800), mat(0x9a9a9a)), 't106-ground');
	ground.rotation.x = -Math.PI / 2;
	ground.receiveShadow = true;
	const cubes = {};
	for (const d of [1, 20, 200]) {
		const size = d * 0.12;
		const c = add(new T.Mesh(new T.BoxGeometry(size, size, size), mat(0x6c7a89)), 't106-cube-' + d);
		c.position.set(0, size / 2, -d);
		c.castShadow = c.receiveShadow = true;
		cubes[d] = { size, z: -d };
	}
	// a 2 x 1 m bar 3 m up, 60 m to the left (clear of the cubes' shadows and lit patches), from z -5 to -190:
	// its shadow strip crosses the cascade split
	const bar = add(new T.Mesh(new T.BoxGeometry(2, 1, 185), mat(0x6c7a89)), 't106-bar');
	bar.position.set(-60, 3, -97.5);
	bar.castShadow = true;
	g.updateMatrixWorld(true);

	const scene = read(s.globalScene);
	const cam = read(s.globalCamera);
	const r = read(s.globalRenderer);
	const sunDir = () => {
		const sun = scene.getObjectByName('env-rig-sun');
		const p = new T.Vector3();
		const t = new T.Vector3();
		sun.getWorldPosition(p);
		if (sun.target) sun.target.getWorldPosition(t);
		return p.sub(t).normalize();
	};
	const pose = (from, at) => {
		cam.position.set(...from);
		cam.lookAt(new T.Vector3(...at));
		cam.updateMatrixWorld(true);
	};
	/** render now (lines hidden: grid and helpers are not shadows) and read every requested world point (5x5 mean) */
	const sample = (points) => {
		const hidden = [];
		scene.traverse((o) => {
			if ((o.isLine || o.isLineSegments || o.isSprite || o.isPoints) && o.visible) {
				o.visible = false;
				hidden.push(o);
			}
		});
		r.setRenderTarget(null);
		r.render(scene, cam);
		r.render(scene, cam);
		const W = r.domElement.width;
		const H = r.domElement.height;
		const k = document.createElement('canvas');
		k.width = W;
		k.height = H;
		const x = k.getContext('2d', { willReadFrequently: true });
		x.drawImage(r.domElement, 0, 0);
		for (const o of hidden) o.visible = true;
		const img = x.getImageData(0, 0, W, H).data;
		const lum = (px, py) => {
			let sum = 0;
			let n = 0;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++) {
					const X = Math.round(px + dx);
					const Y = Math.round(py + dy);
					if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
					const i = (Y * W + X) * 4;
					sum += 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
					n++;
				}
			return n ? sum / n / 255 : null;
		};
		let mean = 0;
		for (let i = 0; i < img.length; i += 4 * 97) mean += img[i] + img[i + 1] + img[i + 2];
		mean /= (img.length / (4 * 97)) * 765;
		const out = points.map((w) => {
			const v = new T.Vector3(...w).project(cam);
			if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
			return lum(((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H);
		});
		return { lum: out, mean };
	};
	window.__t106 = { cubes, sunDir, pose, sample, T };
	return true;
};

/** page side: measure one level at the three distances (+ seams, + the frame) */
const MEASURE = ({ distances, seams }) => {
	const { cubes, sunDir, pose, sample } = window.__t106;
	const L = sunDir();
	// horizontal direction the shadows run, and the side perpendicular to it
	const dir = [-L.x, -L.z];
	const dl = Math.hypot(...dir);
	dir[0] /= dl;
	dir[1] /= dl;
	const perp = [dir[1], -dir[0]];
	const along = (dl / L.y) * 1; // shadow length per metre of height
	const res = { sun: [L.x, L.y, L.z].map((v) => +v.toFixed(3)), at: {} };
	for (const d of distances) {
		const { size, z } = cubes[d];
		// the camera d metres from the cube, a little above, looking at its base
		pose([0, 0.45 * d, z + 0.9 * d], [0, 0, z]);
		const shadowLen = size * along;
		const off = (k) => [dir[0] * k, 0, z + dir[1] * k];
		const pts = [
			off(Math.min(size * 0.58 + shadowLen * 0.45, size * 0.58 + shadowLen - size * 0.1)), // in the shadow
			off(size * 0.75), // just off the base edge, shadow side (peter-panning); far enough that the 5x5 read
			// cannot reach the cube's own (unlit) face
			[perp[0] * size * 1.3, 0, z + perp[1] * size * 1.3] // lit, beside the cube
		];
		// open lit ground for acne: a 7x7 grid on the lit side
		const grid = [];
		for (let i = 0; i < 7; i++)
			for (let j = 0; j < 7; j++) grid.push([perp[0] * size * (1.2 + i * 0.25) - dir[0] * size * (j * 0.2), 0, z + perp[1] * size * (1.2 + i * 0.25) - dir[1] * size * (j * 0.2)]);
		const s = sample([...pts, ...grid]);
		const [inShadow, base, lit] = s.lum;
		const g = s.lum.slice(3).filter((v) => v !== null);
		const med = [...g].sort((a, b) => a - b)[Math.floor(g.length / 2)] ?? 0;
		res.at[d] = {
			shadowRatio: lit ? +(inShadow / lit).toFixed(3) : null,
			baseRatio: lit ? +(base / lit).toFixed(3) : null,
			acne: g.length ? +(g.filter((v) => v < med * 0.85).length / g.length).toFixed(3) : null,
			lit: lit === null ? null : +lit.toFixed(3),
			mean: +s.mean.toFixed(3)
		};
	}
	if (seams) {
		pose([-52, 25, 10], [-60, 0, -100]);
		// the bar's shadow strip: the bar's centre line moved along the shadow direction by 3 m of height
		const sx = -60 + dir[0] * 3 * along;
		const dz = dir[1] * 3 * along;
		const zs = [];
		for (let zz = -10; zz >= -185; zz -= 5) zs.push(zz);
		const strip = zs.map((zz) => [sx, 0, zz + dz]);
		const lit = zs.map((zz) => [-60 + 4 * Math.sign(-dir[0] || 1), 0, zz]);
		const s = sample([...strip, ...lit]);
		const n = zs.length;
		const ratios = zs.map((_, i) => (s.lum[i] !== null && s.lum[n + i] ? +(s.lum[i] / s.lum[n + i]).toFixed(3) : null));
		res.seams = { z: zs, ratios };
	}
	return res;
};

/** both page sides: the renderer's canvas as a PNG of the whole app frame (post included) */
async function shot(page, name) {
	fs.mkdirSync(OUT, { recursive: true });
	const canvas = page.locator('canvas').first();
	await canvas.screenshot({ path: path.join(OUT, name + '.png') }).catch(() => {});
}

h.run(async () => {
	const browser = await h.launch({ args: process.env.E2E_GPU === '1' ? h.GPU_ARGS : [] });
	const A = await h.setupPage(browser, 'A', { context: { viewport: VIEW } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.THREE && !!window.__stores?.environment?.editRigComponent, null, { timeout: 120000 });
	await page.evaluate(SETUP);
	await page.evaluate((sun) => window.__stores.environment.editRigComponent('sun', { position: sun }), SUN);
	await sleep(1500);

	const frame = () =>
		page.evaluate(() => {
			const { pose, sample } = window.__t106;
			pose([0, 9, 18], [0, 0, -20]);
			const pts = [];
			for (let i = 0; i < 24; i++) for (let j = 0; j < 16; j++) pts.push([-30 + i * 2.6, 0, -2 - j * 2.4]);
			return sample(pts).lum;
		});
	const basic0 = await frame();
	const setLevel = async (level) => {
		await page.evaluate((l) => window.__stores.environment.setSceneShadowLevel(l), level);
		await sleep(2500); // the lazy chunk + programs
	};
	/** @type {Record<string, any>} */
	const by = {};
	for (const level of ['basic', 'soft', 'far']) {
		await setLevel(level);
		by[level] = await page.evaluate(MEASURE, { distances: DISTANCES, seams: level === 'far' });
		console.log(`LEVEL ${level} ${JSON.stringify(by[level])}`);
		await page.evaluate(() => window.__t106.pose([0, 9, 18], [0, 0, -20]));
		await sleep(600);
		await shot(page, 'level-' + level);
	}

	// 1. shadows, peter-panning, acne per level
	// Basic is today's look (identity is shadow-identity-106's job): printed for the record, not gated
	for (const d of DISTANCES) console.log(`  basic ${d} m (today, not gated): ${JSON.stringify(by.basic.at[d])}`);
	for (const d of DISTANCES) h.check(by.basic.at[d].mean > 0.03, `basic ${d} m: the frame is drawn (mean ${by.basic.at[d].mean})`);
	for (const level of ['soft', 'far']) {
		for (const d of DISTANCES) {
			const m = by[level].at[d];
			h.check(m.mean > 0.03, `${level} ${d} m: the frame is drawn (mean ${m.mean})`);
			h.check(m.acne !== null && m.acne <= 0.05, `${level} ${d} m: no acne on open lit ground (${(m.acne * 100).toFixed(1)} % of samples dark)`);
			// Basic and Soft share the scene-fitted map: a 12 cm cube at 1 m is below its texel, so its shadow is not
			// asked of them (that is what Far is for); 20 m and 200 m are
			if (level === 'far' || d > 1) {
				h.check(m.shadowRatio !== null && m.shadowRatio < 0.75, `${level} ${d} m: the cube casts a shadow (shadow / lit ${m.shadowRatio})`);
				h.check(m.baseRatio !== null && m.baseRatio < 0.8, `${level} ${d} m: the shadow starts at the cube's base, no peter-panning (base / lit ${m.baseRatio})`);
			}
		}
	}
	// 2. seams
	const seam = by.far.seams;
	const okR = seam.ratios.filter((v) => v !== null);
	const jumps = okR.slice(1).map((v, i) => Math.abs(v - okR[i]));
	h.check(okR.length >= seam.z.length - 2 && okR.every((v) => v < 0.75), `far: the bar's shadow is unbroken from 10 m to 185 m across the cascade split (max ratio ${Math.max(...okR)})`);
	h.check(jumps.length > 0 && Math.max(...jumps) < 0.25, `far: no seam along the strip (largest step between 5 m neighbours ${Math.max(...jumps).toFixed(3)})`);

	// 3. a moving sun (Far)
	for (const [i, sun] of [[10, 8, -4], [-2, 8, -11], [6, 12, -6]].entries()) {
		await page.evaluate((p) => window.__stores.environment.editRigComponent('sun', { position: p }), sun);
		await sleep(900);
		const m = await page.evaluate(MEASURE, { distances: [20], seams: false });
		console.log(`SUN ${JSON.stringify(sun)} ${JSON.stringify(m)}`);
		h.check(m.at[20].mean > 0.03 && m.at[20].shadowRatio < 0.75 && m.at[20].baseRatio < 0.8, `far, sun ${i + 1}: the 20 m shadow follows the sun (shadow / lit ${m.at[20].shadowRatio}, base ${m.at[20].baseRatio})`);
	}
	await page.evaluate((sun) => window.__stores.environment.editRigComponent('sun', { position: sun }), SUN);
	await sleep(900);

	// 4. the levels differ on screen; Basic after Far is Basic
	const diff = (a, b) => a.filter((v, i) => v !== null && b[i] !== null && Math.abs(v - b[i]) > 0.02).length / a.length;
	const farFrame = await frame();
	await setLevel('soft');
	const softFrame = await frame();
	await setLevel('basic');
	const basic1 = await frame();
	const basic2 = await frame();
	const floor = diff(basic1, basic2);
	h.check(diff(basic1, softFrame) > floor + 0.01, `Soft draws differently from Basic (${(diff(basic1, softFrame) * 100).toFixed(1)} % of samples, floor ${(floor * 100).toFixed(1)} %)`);
	h.check(diff(basic1, farFrame) > floor + 0.01, `Far draws differently from Basic (${(diff(basic1, farFrame) * 100).toFixed(1)} %)`);
	h.check(diff(basic0, basic1) <= floor + 0.005, `Basic after Soft and Far draws today's Basic again (${(diff(basic0, basic1) * 100).toFixed(1)} % of samples, floor ${(floor * 100).toFixed(1)} %)`);
	const back = await page.evaluate(() => window.__stores.environment.drawnSceneShadowLevel());
	h.check(back === 'basic', 'back to Basic');

	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(path.join(OUT, 'levels.json'), JSON.stringify(by, null, 1));
	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A)).slice(0, 300)})`);
	await h.finish(browser);
});
