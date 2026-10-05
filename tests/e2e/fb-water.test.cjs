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

/** mean colour of a small square of the frame around a world point (in-page decode)
 * @param {any} peer @param {number[]} world @param {number} [size] */
async function meanRGB(peer, world, size = 16) {
	const p = await h.projectPoint(peer.page, world);
	const png = await peer.page.screenshot({ clip: { x: Math.round(p.x - size / 2), y: Math.round(p.y - size / 2), width: size, height: size } });
	return peer.page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
		const c = new OffscreenCanvas(bmp.width, bmp.height);
		const g = c.getContext('2d');
		g.drawImage(bmp, 0, 0);
		const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
		const m = [0, 0, 0];
		for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += d[i + k];
		return m.map((v) => Math.round(v / (d.length / 4)));
	}, png.toString('base64'));
}
/** world centre of a named object @param {any} page @param {string} name */
const centreOf = (page, name) =>
	page.evaluate((n) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByName(n);
		const b = new window.__stores.THREE.Box3().setFromObject(o);
		return b.getCenter(new window.__stores.THREE.Vector3()).toArray();
	}, name);

/** centroid + count of the outline (pure green) and of the object (pure magenta) in a clip
 * @param {any} peer @param {any} clip */
async function outlineVsObject(peer, clip) {
	const png = await peer.page.screenshot({ clip });
	return peer.page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
		const c = new OffscreenCanvas(bmp.width, bmp.height);
		const g = c.getContext('2d');
		g.drawImage(bmp, 0, 0);
		const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
		const acc = { gx: 0, gy: 0, gn: 0, mx: 0, my: 0, mn: 0 };
		for (let y = 0; y < bmp.height; y++)
			for (let x = 0; x < bmp.width; x++) {
				const i = (y * bmp.width + x) * 4;
				const r = d[i], gg = d[i + 1], b = d[i + 2];
				// RELATIVE hue tests: underwater the fog and the tint pull both colours toward the water's
				if (gg - Math.max(r, b) > 50) { acc.gx += x; acc.gy += y; acc.gn++; }
				else if ((r + b) / 2 - gg > 30 && r > gg + 15 && b > gg + 15) { acc.mx += x; acc.my += y; acc.mn++; }
			}
		const out = { outline: acc.gn, object: acc.mn, offset: null };
		if (acc.gn && acc.mn) out.offset = Math.hypot(acc.gx / acc.gn - acc.mx / acc.mn, acc.gy / acc.gn - acc.my / acc.mn);
		return out;
	}, png.toString('base64'));
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	await A.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));

	// ── F12: a body placed UNDER the water rises by density (Pool party) ────────────────────
	if (want('f12')) {
		await load(A.page, 'pool-party');
		// the re-authored Pool party starts simulating on load: probes join a FRESH run
		await A.page.evaluate(() => window.__stores.physics.resetSimulation());
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


	// ── F13b: a selected object under water sits exactly under its outline ─────────────────
	if (want('f13b')) {
		await load(A.page, 'aquarium');
		const fish = await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const T = window.__stores.THREE;
			// a STATIC object under the water (the fish swim away between aiming and measuring)
			const f = g.getObjectByName('Rock small');
			const b = new T.Box3().setFromObject(g.getObjectByName('Aquarium water'));
			window.__f13bMat = f.material;
			return { uuid: f.uuid, pos: f.position.toArray(), front: b.max.z };
		});
		const frontView = [fish.pos[0] + 0.3, fish.pos[1] + 0.2, fish.front + 1.4];
		await look(A.page, frontView, fish.pos);
		await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), fish.uuid);
		await A.page.waitForTimeout(1200);
		await shots(A.page, '12-after-F13b-aquarium-selected');
		// measurement colours: the outline pure green, the fish flat magenta
		await A.page.evaluate((u) => {
			const s = window.__stores;
			s.viewPrefs.setViewPrefs({ outlineColor: '#00ff00' });
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			g.getObjectByProperty('uuid', u).material = new s.THREE.MeshBasicMaterial({ color: 0xff00ff });
		}, fish.uuid);
		await A.page.waitForTimeout(800);
		const clip = await h.centeredClip(A, fish.pos, 360);
		const on = await outlineVsObject(A, clip);
		await A.page.evaluate(() => window.__stores.waterRuntime.setSelectionUnrefract(false));
		await A.page.waitForTimeout(800);
		const off = await outlineVsObject(A, clip);
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '13-F13b-counterfactual-mask-off.png') });
		await A.page.evaluate(() => window.__stores.waterRuntime.setSelectionUnrefract(true));
		await A.page.waitForTimeout(600);
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '14-F13b-measure-mask-on.png') });
		h.check(on.outline > 50 && on.object > 200, `the measurement sees the outline and the object (${on.outline} / ${on.object} px)`);
		// the REFERENCE: the Quest tier has no screen-space refraction, so the object is exactly
		// under its outline there; the metric's floor (an occluded corner shifts the visible blob's
		// centroid) is whatever it reads in that view
		await A.page.evaluate(() => window.__stores.waterPrefs.waterQuality.set('low'));
		await A.page.waitForTimeout(1200);
		const quest = await outlineVsObject(A, clip);
		await A.page.evaluate(() => window.__stores.waterPrefs.waterQuality.set('high'));
		await A.page.waitForTimeout(800);
		h.check(quest.offset !== null, `reference (Quest tier, no refraction): ${quest.offset?.toFixed(1)} px`);
		h.check(on.offset !== null && Math.abs(on.offset - quest.offset) < 1.5, `desktop: the object sits under its outline as exactly as with no refraction at all (${on.offset?.toFixed(1)} vs ${quest.offset?.toFixed(1)} px)`);
		h.check(off.offset !== null && off.offset > quest.offset + 3, `COUNTERFACTUAL: without the mask the refracted object drifts off its outline (${off.offset?.toFixed(1)} px)`);
		// underwater: the camera inside the tank, above the rock
		await look(A.page, [fish.pos[0] + 0.3, fish.pos[1] + 0.45, fish.pos[2] + 0.55], fish.pos);
		await A.page.waitForTimeout(1200);
		const underClip = await h.centeredClip(A, fish.pos, 360);
		const under = await outlineVsObject(A, underClip);
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, 'diag-f13b-underwater.png') });
		await A.page.evaluate(() => window.__stores.waterPrefs.waterQuality.set('low'));
		await A.page.waitForTimeout(1000);
		const underRef = await outlineVsObject(A, underClip);
		await A.page.evaluate(() => window.__stores.waterPrefs.waterQuality.set('high'));
		h.check(under.offset !== null && underRef.offset !== null && Math.abs(under.offset - underRef.offset) < 1.5, `underwater: aligned (${under.offset?.toFixed(1)} vs ${underRef.offset?.toFixed(1)} px)`);
		await A.page.evaluate((u) => {
			const s = window.__stores;
			s.viewPrefs.setViewPrefs({ outlineColor: '#353535' });
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			g.getObjectByProperty('uuid', u).material = window.__f13bMat;
			s.objectActions.deselectObject?.();
		}, fish.uuid);
		// the fluid tank toy: a duck in the particle fluid (no refraction there — measured aligned)
		await load(A.page, 'fluid-tank-toy');
		if (!(await simulating(A.page))) await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
		await A.page.waitForTimeout(6000);
		await A.page.evaluate(() => window.__stores.physics.pauseSimulation(true)); // hold the duck still for the measurement
		const duck = await A.page.evaluate(() => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const d = g.getObjectByName('Duck 1');
			s.objectActions.selectObject(d.uuid);
			s.viewPrefs.setViewPrefs({ outlineColor: '#00ff00' });
			window.__f13bDuck = d.material;
			d.material = new s.THREE.MeshBasicMaterial({ color: 0xff00ff });
			return d.position.toArray();
		});
		await look(A.page, [duck[0] + 0.2, duck[1] + 1.1, duck[2] + 0.7], duck); // from above: the duck's top is out of the fluid
		await A.page.waitForTimeout(1000);
		const dk = await outlineVsObject(A, await h.centeredClip(A, duck, 320));
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, 'diag-f13b-duck.png') });
		h.check(dk.offset !== null && dk.offset < 4, `Fluid tank toy: a duck in the fluid sits under its outline (${dk.offset?.toFixed(1)} px; the fluid does not refract)`);
		await A.page.evaluate(() => {
			const s = window.__stores;
			s.viewPrefs.setViewPrefs({ outlineColor: '#353535' });
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			g.getObjectByName('Duck 1').material = window.__f13bDuck;
			s.objectActions.deselectObject?.();
			s.physics.stopSimulation();
		});
	}

	// ── F14: Jelly room renders its jellies (not black) + Start simulation on load ──────────
	if (want('f14')) {
		await load(A.page, 'jelly-room');
		// the re-authored room starts on load: back to the authored layout for the colour reads
		await A.page.evaluate(() => window.__stores.physics.resetSimulation());
		await A.page.waitForTimeout(1500);
		const att = await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByName('Jelly lime').material.attenuationDistance;
		});
		h.check(att === Infinity, `a loaded transmissive jelly keeps attenuationDistance = Infinity (${att}; the file says null)`);
		const lime = await meanRGB(A, await centreOf(A.page, 'Jelly lime'));
		h.check(lime[1] > 90 && lime[1] > lime[2] + 20, `Jelly lime renders green, not black (rgb ${lime})`);
		const lemon = await meanRGB(A, await centreOf(A.page, 'Jelly lemon'));
		h.check(lemon[0] > 120 && lemon[1] > 100, `Jelly lemon renders yellow (rgb ${lemon})`);
		await shots(A.page, '20-after-F14-jelly-room');
		// the setting: Configure Scene ▸ Camera ▸ Start view
		await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ simOnLoad: false }));
		await A.page.evaluate(() => window.__stores.openSceneSection('Camera:Start view'));
		const box = await A.page.waitForSelector('#sim-on-load', { timeout: 8000 }).catch(() => null);
		h.check(!!box, 'Configure Scene shows "Start simulation on load" beside "Hold camera until loaded"');
		if (box) {
			await box.scrollIntoViewIfNeeded();
			await box.click();
			await A.page.waitForTimeout(300);
			await shots(A.page, '21-after-F14-sim-on-load-setting');
		}
		const on = await A.page.evaluate(() => {
			let s;
			window.__stores.scenePhysics.scenePhysicsState_.subscribe((v) => (s = v))();
			return s.simOnLoad;
		});
		h.check(on === true, 'ticking it sets scenePhysics.simOnLoad (scene data)');
		// saved into the scene, and a load of that file starts the run by itself
		const bytes = await A.page.evaluate(async () => {
			const s = window.__stores.sessions;
			const zip = await s.exportSessionZip(s.buildSessionPayload('Jelly sim'));
			const buf = new Uint8Array(zip instanceof Blob ? await zip.arrayBuffer() : zip);
			return Array.from(buf);
		});
		await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ simOnLoad: false }));
		await A.page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			window.__f14saved = payload.physics;
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		h.check((await A.page.evaluate(() => window.__f14saved?.simOnLoad)) === true, 'the saved scene carries simOnLoad');
		await h.eventually(() => simulating(A.page), (v) => v === true, 'opening that scene starts the simulation by itself', 10000);
		await A.page.waitForTimeout(1500);
		const wob = await A.page.evaluate(() => Math.max(...window.__stores.sim.jiggleDebug().map((d) => Math.abs(d.wobble))));
		h.check(wob > 0.01, `...the jellies drop and wobble with nobody pressing P (${wob.toFixed(3)})`);
		await A.page.evaluate(() => window.__stores.physics.stopSimulation());
		// counterfactual: the same scene WITHOUT the flag opens still
		await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ simOnLoad: false }));
		await load(A.page, 'pool-party');
		await A.page.waitForTimeout(1500);
		const scenesHaveFlag = await A.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsSnapshot()?.simOnLoad === true);
		if (!scenesHaveFlag) h.check((await simulating(A.page)) === false, 'a scene without the flag does not start by itself');
		else h.check((await simulating(A.page)) === true, 'the re-authored Pool party starts by itself');
		await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	}

	// ── F15: Island ocean — the boat floats (rides the swell, stays upright, keeps its mast) ─
	if (want('f15')) {
		await load(A.page, 'island-ocean');
		const authored = await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const hull = g.getObjectByName('Boat hull');
			const was = hull.userData.physics?.mode ?? null;
			if (was !== 'dynamic') {
				// today's scene file (1.22 authoring): give it the def's new shape in-page
				for (const n of ['Boat stripe', 'Boat mast']) hull.attach(g.getObjectByName(n));
				hull.scale.set(1.8 / 1.3, 0.6 / 0.55, 4.2 / 3.4); // the def's rowing-boat hull
				hull.updateMatrixWorld(true);
				hull.userData.physics = { mode: 'dynamic', mass: 160, collider: 'hull', friction: 0.6, floats: { density: 320 } };
			}
			return was;
		});
		console.log('boat as authored:', authored);
		await look(A.page, [16, 3.2, 15], [10.5, 0, 9.5]);
		if (!(await simulating(A.page))) await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
		await h.eventually(() => simulating(A.page), (v) => v === true, 'simulation running');
		const pose = () =>
			A.page.evaluate(() => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const T = window.__stores.THREE;
				const hull = g.getObjectByName('Boat hull');
				const mast = g.getObjectByName('Boat mast');
				hull.updateMatrixWorld(true);
				const up = new T.Vector3(0, 1, 0).applyQuaternion(hull.getWorldQuaternion(new T.Quaternion()));
				const m = mast.getWorldPosition(new T.Vector3()).sub(hull.getWorldPosition(new T.Vector3()));
				const vols = window.__stores.waterVolumes.waterVolumes.list();
				const sy = window.__stores.waterVolumes.waterVolumes.surfaceY(vols[0], hull.position.x, hull.position.z);
				return { y: hull.position.y, x: hull.position.x, up: up.y, mastOff: m.length(), surface: sy };
			});
		const p0 = await pose();
		await A.page.waitForTimeout(4000);
		const samples = [];
		for (let i = 0; i < 40; i++) {
			samples.push(await pose());
			await A.page.waitForTimeout(150);
		}
		const ys = samples.map((p) => p.y);
		const gaps = samples.map((p) => p.y - p.surface);
		const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
		const last = samples[samples.length - 1];
		h.check(mean > -0.05 && mean < 0.35, `the boat floats on the ocean (mean height over the surface ${mean.toFixed(2)} m)`);
		h.check(Math.min(...gaps) > -0.45, `...is never swamped (lowest ${Math.min(...gaps).toFixed(2)})`);
		h.check(Math.max(...ys) - Math.min(...ys) > 0.04, `...rides the swell (bob ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} m)`);
		h.check(Math.min(...samples.map((p) => p.up)) > 0.85, `...upright (min up ${Math.min(...samples.map((p) => p.up)).toFixed(2)})`);
		h.check(Math.abs(last.mastOff - p0.mastOff) < 0.01, `the mast rides the hull (offset ${p0.mastOff.toFixed(2)} -> ${last.mastOff.toFixed(2)})`);
		await shots(A.page, '30-after-F15-island-boat');
		await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	}

	// ── F16: tipping a fluid tank spills it (drops fall, splash, settle) — within its limits ─
	if (want('f16')) {
		await load(A.page, 'fluid-tank-toy');
		await h.eventually(() => A.page.evaluate(() => window.__stores.sim.fluidDebug()), (t) => t.length === 2 && t.every((x) => x.count > 500 && x.steps > 20), 'both tanks run', 20000);
		const tank = await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const t = g.getObjectByName('Honey tank');
			window.__stores.sim.setFluidFor(t.uuid, { spill: { maxDrops: 300, lifetime: 6 } });
			return { uuid: t.uuid, pos: t.position.toArray() };
		});
		await look(A.page, [tank.pos[0] + 2.6, tank.pos[1] + 1.2, 3.4], [tank.pos[0] + 0.8, 0.6, 0]);
		const before = await A.page.evaluate(() => window.__stores.sim.fluidDebug().find((t) => t.uuid));
		// tip it over sideways, as a gizmo rotate would (the runtime reads the pose every frame)
		for (let i = 1; i <= 20; i++) {
			await A.page.evaluate(([u, a]) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const t = g.getObjectByProperty('uuid', u);
				t.rotation.z = -a;
				t.updateMatrixWorld(true);
			}, [tank.uuid, (i / 20) * 1.9]);
			await A.page.waitForTimeout(60);
			if (i === 14) await shots(A.page, '50-after-F16-tank-spill'); // mid-pour: drops in the air
		}
		let maxCount = 0;
		for (let i = 0; i < 25; i++) {
			await A.page.waitForTimeout(200);
			const n = await A.page.evaluate(() => window.__stores.sim.totalDropCount());
			maxCount = Math.max(maxCount, n);
		}
		const after = await A.page.evaluate((u) => ({ tank: window.__stores.sim.fluidDebug().find((t) => t.uuid === u), drops: window.__stores.sim.pourDebug().find((d) => d.key === 'spill:' + u) }), tank.uuid);
		h.check((after.tank?.spilled ?? 0) > 50, `the tipped tank spilled over its rim (${after.tank?.spilled} particles left the tank)`);
		h.check(after.tank.count < (before?.count ?? 3000), `...so the tank holds less (${after.tank.count})`);
		h.check((after.drops?.settled ?? 0) + (after.drops?.splashes ?? 0) > 20, `the spilled drops landed (settled ${after.drops?.settled}, splashed ${after.drops?.splashes})`);
		h.check(maxCount <= 300 + 10, `...and never exceeded the spill cap (${maxCount} <= 300 drops alive)`);
		await shots(A.page, '51-after-F16-spilled-and-settled');
		// spill off: tipped further, nothing more leaves
		await A.page.evaluate((u) => window.__stores.sim.setFluidFor(u, { spill: { on: false } }), tank.uuid);
		await A.page.waitForTimeout(800);
		const s1 = await A.page.evaluate((u) => window.__stores.sim.fluidDebug().find((t) => t.uuid === u).spilled, tank.uuid);
		await A.page.waitForTimeout(2000);
		const s2 = await A.page.evaluate((u) => window.__stores.sim.fluidDebug().find((t) => t.uuid === u).spilled, tank.uuid);
		h.check(s2 - s1 <= 5, `Spill when tipped OFF keeps the fluid in (${s2 - s1} more after switching it off)`);
	}

	// ── F17: a pour emitter from Add ▸ Water ▸ Pour and on a plain Water tank ───────────────
	if (want('f17')) {
		await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
		await A.page.waitForTimeout(500);
		const ids = await A.page.evaluate(() => {
			const st = window.__stores;
			// Add ▸ Water ▸ Water tank, then Add ▸ Water ▸ Pour — the menu's own actions
			const water = st.addObjects.buildAddChildren(() => [0, 0, 0]).find((g) => g.label === 'Water');
			water.children.find((c) => c.label === 'Water tank').action();
			let g;
			st.objectsGroup.subscribe((v) => (g = v))();
			const tank = g.children[g.children.length - 1];
			tank.position.set(0, 0.6, 0);
			tank.updateMatrixWorld(true);
			const pourItem = st.addObjects.buildAddChildren(() => [-2.5, 0, 0]).find((x) => x.label === 'Water').children.find((c) => c.label === 'Pour');
			pourItem.action();
			const spout = g.children[g.children.length - 1];
			return { tank: tank.uuid, spout: spout.uuid, spoutName: spout.name, hasPour: !!spout.userData.pour };
		});
		h.check(ids.hasPour && ids.spoutName === 'Pour', 'Add ▸ Water ▸ Pour places a spout carrying userData.pour');
		// the Water section's button on the Water tank
		await A.page.evaluate((u) => {
			localStorage.setItem('inspector:sec:Water', 'open');
			window.__stores.objectActions.selectObject(u, true);
		}, ids.tank);
		const btn = await A.page.waitForSelector('#pour-add', { timeout: 8000 }).catch(() => null);
		h.check(!!btn, 'a Water tank offers "Add pour emitter"');
		if (btn) {
			await btn.scrollIntoViewIfNeeded();
			await btn.click();
			await A.page.waitForTimeout(300);
			const pourRows = await A.page.waitForSelector('#pour-remove', { timeout: 4000 }).then(() => true).catch(() => false);
			h.check(pourRows, 'the panel shows the pour rows right after the click');
			if (SHOTS) {
				await A.page.evaluate(() => document.querySelector('#pour-remove')?.scrollIntoView({ block: 'end' }));
				await shots(A.page, '61-after-F17-pour-panel');
			}
		}
		await A.page.evaluate(() => window.__stores.objectActions.deselectObject?.());
		await look(A.page, [0.5, 2.2, 5.2], [0, 0.4, 0]);
		await A.page.waitForTimeout(3000);
		const d = await A.page.evaluate(() => window.__stores.sim.pourDebug());
		const tankPour = d.find((x) => x.key === 'pour:' + ids.tank);
		const spoutPour = d.find((x) => x.key === 'pour:' + ids.spout);
		h.check((tankPour?.count ?? 0) > 20, `the Water tank pours (${tankPour?.count} drops alive)`);
		h.check((spoutPour?.count ?? 0) > 20 && (spoutPour?.settled ?? 0) > 5, `the spout pours and its drops settle on the ground (${spoutPour?.count} alive, ${spoutPour?.settled} settled)`);
		await shots(A.page, '60-after-F17-pour-emitters');
		// limits from the panel's model: max drops caps it
		await A.page.evaluate((u) => window.__stores.waterActions.updateObjectPour(u, { maxParticles: 25, rate: 200 }, { immediate: true }), ids.spout);
		await A.page.waitForTimeout(1500);
		const capped = await A.page.evaluate((u) => window.__stores.sim.pourDebug().find((x) => x.key === 'pour:' + u)?.count, ids.spout);
		h.check(capped <= 25, `Max drops caps a spout (${capped} <= 25 at rate 200)`);
	}

	// ── S9: one transport for the whole simulation (bodies + fluid tanks + drops) ───────────
	if (want('s9')) try {
		await load(A.page, 'fluid-tank-toy');
		console.log('S9 scene:', JSON.stringify(await A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			let l;
			window.__stores.sceneLoader?.sceneLoad?.subscribe?.((v) => (l = v))();
			return { names: g.children.map((o) => o.name), load: l ?? null, fluid: window.__stores.sim.fluidDebug().length };
		})));
		await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ simOnLoad: true }));
		const pill = await A.page.waitForSelector('#sim-controls', { timeout: 5000 }).catch(() => null);
		h.check(!!pill, 'a simulation scene shows the simulation transport without the Settings toggle');
		if (!(await simulating(A.page))) await A.page.$eval('#sim-play', (el) => /** @type {any} */ (el).click());
		await h.eventually(() => simulating(A.page), (v) => v === true, 'running');
		await h.eventually(() => A.page.evaluate(() => window.__stores.sim.fluidDebug()), (t) => t.length === 2 && t.every((x) => x.steps > 20), 'tanks running', 20000);
		const duck0 = (await ys(A.page, ['Duck 1']))['Duck 1'];
		// the pill is clicked by dispatch: an open Configure Scene drawer can sit over it
		const press = (/** @type {string} */ sel) => A.page.$eval(sel, (el) => /** @type {any} */ (el).click());
		await press('#sim-pause');
		await A.page.waitForTimeout(500);
		const a = await A.page.evaluate(() => ({ steps: window.__stores.sim.fluidDebug().map((t) => t.steps), y: null }));
		const yA = (await ys(A.page, ['Duck 1']))['Duck 1'];
		await A.page.waitForTimeout(1500);
		const b = await A.page.evaluate(() => window.__stores.sim.fluidDebug().map((t) => t.steps));
		const yB = (await ys(A.page, ['Duck 1']))['Duck 1'];
		h.check(b.every((n, i) => n - a.steps[i] <= 1), `Pause holds the fluid tanks still (steps ${a.steps} -> ${b})`);
		h.check(Math.abs(yB - yA) < 1e-4, `...and the bodies (duck y ${yA.toFixed(3)} -> ${yB.toFixed(3)})`);
		await press('#sim-pause'); // resume
		await A.page.waitForTimeout(1500);
		const c = await A.page.evaluate(() => window.__stores.sim.fluidDebug().map((t) => t.steps));
		h.check(c.every((n, i) => n > b[i] + 5), `Resume carries on (steps ${b} -> ${c})`);
		const cNow = await A.page.evaluate(() => window.__stores.sim.fluidDebug().map((t) => t.steps));
		await press('#sim-reset');
		await h.eventually(() => A.page.evaluate(() => window.__stores.sim.fluidDebug().map((t) => t.steps)), (d) => d.length === 2 && d.every((n, i) => n < cNow[i]), `Reset refills every tank (steps ${cNow} -> fewer)`, 8000);
		await h.eventually(() => simulating(A.page), (v) => v === true, '...and plays it again from the start', 8000);
		console.log('duck start', duck0);
		await A.page.evaluate(() => window.__stores.physics.stopSimulation());
		await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ simOnLoad: false }));
	} catch (error) {
		h.check(false, 'S9 section stopped: ' + (error?.message ?? error));
		if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, 'diag-s9-failure.png') }).catch(() => {});
	}

	// ── F18: "Add bubble emitter" makes bubbles you can SEE (under water and in the air) ────
	if (want('f18')) {
		await load(A.page, 'pool-party');
		const ids = await A.page.evaluate(() => {
			const cmd = window.__stores.commandsHandler.sceneCommand;
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const last = () => g.children[g.children.length - 1];
			cmd('/create Box 0.5 0.5 0.5');
			const wet = last();
			wet.name = 'Bubbler wet';
			wet.position.set(-1.5, -1.3, 1.2);
			delete wet.userData.physics;
			cmd('/create Box 0.5 0.5 0.5');
			const dry = last();
			dry.name = 'Bubbler dry';
			dry.position.set(1.5, 0.25, 4.4);
			delete dry.userData.physics;
			for (const o of [wet, dry]) o.updateMatrixWorld(true);
			return { wet: wet.uuid, dry: dry.uuid };
		});
		// the real button, on each object
		for (const uuid of [ids.wet, ids.dry]) {
			await A.page.evaluate((u) => {
				localStorage.setItem('inspector:sec:Water', 'open');
				window.__stores.objectActions.selectObject(u, true);
			}, uuid);
			const btn = await A.page.waitForSelector('#bubbles-add', { timeout: 8000 }).catch(() => null);
			h.check(!!btn, 'the Water section offers "Add bubble emitter" on a plain object');
			if (btn) {
				await btn.scrollIntoViewIfNeeded();
				await btn.click();
			}
			await A.page.waitForTimeout(300);
			// the panel shows the emitter's rows at once (it used to keep the old state)
			const rows = await A.page.waitForSelector('#water-bubbles-on', { timeout: 3000 }).then(() => true).catch(() => false);
			h.check(rows, 'the Water section switches to the emitter rows right after the click');
		}
		h.check(
			(await A.page.evaluate((i) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				return [i.wet, i.dry].every((u) => g.getObjectByProperty('uuid', u)?.userData?.bubbles?.enabled === true);
			}, ids)),
			'both objects carry an enabled bubble emitter (userData.bubbles)'
		);
		await A.page.evaluate(() => window.__stores.objectActions.deselectObject?.());
		await look(A.page, [0, 1.6, 7.2], [0, -0.2, 2]);
		await A.page.waitForTimeout(1500);
		/** pixels the bubbles change around an emitter: on vs off, same frame otherwise */
		const delta = async (/** @type {string} */ uuid, /** @type {number[]} */ at) => {
			const clip = await h.centeredClip(A, at, 220);
			const on = await A.page.screenshot({ clip });
			await A.page.evaluate((u) => window.__stores.waterActions.updateObjectBubbles(u, { enabled: false }, { immediate: true }), uuid);
			await A.page.waitForTimeout(500);
			const off = await A.page.screenshot({ clip });
			await A.page.evaluate((u) => window.__stores.waterActions.updateObjectBubbles(u, { enabled: true }, { immediate: true }), uuid);
			await A.page.waitForTimeout(500);
			return h.frameDelta(A.page, on, off, 24);
		};
		const wet = await delta(ids.wet, [-1.5, -0.5, 1.2]);
		h.check(wet.changed > 250, `bubbles under the water are visible through the surface (${wet.changed} px changed)`);
		const dry = await delta(ids.dry, [1.5, 1.2, 4.4]);
		h.check(dry.changed > 250, `bubbles from an object in the air are visible against the sky (${dry.changed} px changed)`);
		await shots(A.page, '40-after-F18-bubble-emitters');
	}

	h.check((await h.pageErrors(A)).length === 0, 'no page errors');
	await h.finish(browser);
});
