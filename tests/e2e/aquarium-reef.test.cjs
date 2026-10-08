// 40 F14-F16 — THE AQUARIUM REEF: real Meshy fish through FALLBACK LOD groups, swimming with the
// general-purpose motion nodes, wearing the fish-scale thin film at this device's look tier.
//   1 motion: Follow Path keeps the tangs on their loop, half a lap apart, nose along the travel,
//     banked in the bends; Wander keeps the clownfish inside the water volume; Orient to Velocity
//     points them where they go; every fish carries a Body Wave (shader patched, phase running)
//   2 fallback LOD: with the pack reachable every fish/plant/coral draws its pack model (a tree
//     substitute) and the stand-in is hidden for the render; the SAVE carries only the stand-ins;
//     the Body Wave reaches the substitute's meshes too
//   3 the counterfactual: pack unreachable → the stand-ins stay on screen (LOD0), nothing breaks
//   4 the look tier: the fish's film draws on a desktop, drops at `low`, comes back at `high`, and
//     the authored numbers ride beside the material; the Fish scales preset applies the full look
//     and a phone tier (`mid`) drops only its transmission
// Needs the scene (SCENES_DIR, a scenes checkout with the 40 Aquarium) and the aquarium-kit pack
// reachable at the dev server's VITE_PACKS_BASE (packs worktree: tools/town-kit/serve-pack.mjs).
// Run: VITE_PACKS_BASE=https://theprototype.app:5397 e2e-slot --dev <core> 5396 --
//      APP_URL=https://theprototype.app:5396/ SCENES_DIR=../scenes-lane-40-aquarium npm run e2e -- aquarium-reef
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SCENES_DIR = process.env.SCENES_DIR || '/home/deck/.code/theprototype-app/scenes';
const AQUARIUM = path.join(SCENES_DIR, 'examples/aquarium/scene.tpscene');
const SHOTS = process.env.SHOTS_DIR || '';

/** @param {any} page @param {string} file */
async function loadScene(page, file) {
	const b64 = fs.readFileSync(file).toString('base64');
	await page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const s = window.__stores.sessions;
		const payload = await s.readSessionZip(bytes.buffer);
		await s.applySession(payload, { backup: false, quiet: true });
	}, b64);
	await h.eventually(
		() => page.evaluate(() => { let v; window.__stores.sceneLoader.sceneLoad.subscribe((x) => (v = x))(); return v; }),
		(v) => v === null,
		'the scene finished loading',
		30000
	);
}

/** in-page helpers, installed once per page */
async function install(page) {
	await page.evaluate(() => {
		const s = window.__stores;
		const read = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const T = s.THREE;
		window.__aq = {
			read,
			byName: (n) => read(s.objectsGroup).getObjectByName(n),
			world: (n) => { const o = window.__aq.byName(n); o.updateWorldMatrix(true, false); return new T.Vector3().setFromMatrixPosition(o.matrixWorld).toArray(); },
			nose: (n, axis = [0, 0, 1]) => { const o = window.__aq.byName(n); const q = o.getWorldQuaternion(new T.Quaternion()); return new T.Vector3(...axis).applyQuaternion(q).toArray(); },
			waterBox: () => { const b = new T.Box3().setFromObject(window.__aq.byName('Aquarium water')); return [b.min.toArray(), b.max.toArray()]; },
			fallbackRoots: () => { const out = []; read(s.objectsGroup).traverse((o) => o.userData?.lod?.fallback && out.push(o)); return out; },
			// render one frame from the editor camera (the LOD pass picks levels inside renders)
			render: () => { const r = read(s.globalRenderer); r.render(read(s.globalScene), read(s.globalCamera)); }
		};
	});
}

/** sample a function of the page over time @param {any} page @param {() => any} fn @param {number} n @param {number} ms */
async function sample(page, fn, n, ms) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push(await page.evaluate(fn));
		await page.waitForTimeout(ms);
	}
	return out;
}

h.run(async () => {
	if (!fs.existsSync(AQUARIUM)) {
		console.log('SKIP: no ' + AQUARIUM);
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await loadScene(page, AQUARIUM);
	await install(page);

	// ---- premise: the 40 scene ------------------------------------------------------------------
	const roots = await page.evaluate(() => window.__aq.fallbackRoots().map((o) => ({ name: o.name, levels: o.userData.lod.levels.length, refs: o.userData.lod.levels.slice(1).map((l) => l.ref) })));
	const fishNames = ['Clownfish 1', 'Clownfish 2', 'Blue tang 1', 'Blue tang 2', 'Angelfish 1', 'Angelfish 2'];
	h.check(fishNames.every((n) => roots.some((r) => r.name === n)), '0.1 the six reef fish are FALLBACK LOD groups (' + roots.map((r) => r.name).join(', ') + ')');
	h.check(roots.length >= 12 && roots.every((r) => r.refs.every((ref) => ref.startsWith('aquarium-kit/'))), '0.2 fish, coral and plants (' + roots.length + ') name aquarium-kit levels');
	const graphs = await page.evaluate(() => {
		const all = window.__stores.allNodes();
		return ['followpath', 'wander', 'orientvelocity', 'bodywave'].map((t) => all.filter((n) => n.type === t).length);
	});
	h.check(graphs[0] === 4 && graphs[1] === 2 && graphs[2] === 2 && graphs[3] === 6, '0.3 the fish graphs: Follow Path ×4, Wander ×2, Orient to Velocity ×2, Body Wave ×6 (' + graphs.join('/') + ')');

	// ---- 1 motion -------------------------------------------------------------------------------
	const tang = await sample(page, () => ({ a: window.__aq.world('Blue tang 1'), b: window.__aq.world('Blue tang 2'), nose: window.__aq.nose('Blue tang 1'), up: window.__aq.nose('Blue tang 1', [0, 1, 0]) }), 12, 250);
	const moved = Math.hypot(tang[11].a[0] - tang[0].a[0], tang[11].a[1] - tang[0].a[1], tang[11].a[2] - tang[0].a[2]);
	h.check(moved > 0.3, '1.1 Follow Path moves the tang (' + moved.toFixed(2) + ' m in ~3 s at 0.42 m/s)');
	const apart = tang.map((t) => Math.hypot(t.a[0] - t.b[0], t.a[2] - t.b[2]));
	h.check(Math.min(...apart) > 1.2, '1.2 the two tangs ride HALF A LAP apart (offset 0.5): ' + Math.min(...apart).toFixed(2) + ' m at the closest');
	let along = 0;
	for (let i = 1; i < tang.length; i++) {
		const d = [tang[i].a[0] - tang[i - 1].a[0], tang[i].a[1] - tang[i - 1].a[1], tang[i].a[2] - tang[i - 1].a[2]];
		const l = Math.hypot(...d) || 1;
		const n = tang[i].nose;
		along += (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / l;
	}
	h.check(along / (tang.length - 1) > 0.85, '1.3 its nose points along the travel (mean cos ' + (along / (tang.length - 1)).toFixed(2) + ')');
	const maxRoll = Math.max(...tang.map((t) => Math.abs(t.up[0] * t.nose[2] - t.up[2] * t.nose[0]) + Math.abs(Math.hypot(t.up[0], t.up[2]))));
	h.check(maxRoll > 0.05, '1.4 it BANKS in the bends (top tilts off vertical by up to ' + maxRoll.toFixed(2) + ')');
	const box = await page.evaluate(() => window.__aq.waterBox());
	const clown = await sample(page, () => ({ p: window.__aq.world('Clownfish 1'), nose: window.__aq.nose('Clownfish 1') }), 16, 250);
	const inside = clown.every((c) => c.p.every((v, i) => v >= box[0][i] - 1e-3 && v <= box[1][i] + 1e-3));
	h.check(inside, '1.5 Wander keeps the clownfish INSIDE the water volume (16 samples over 4 s)');
	const cMoved = Math.hypot(clown[15].p[0] - clown[0].p[0], clown[15].p[1] - clown[0].p[1], clown[15].p[2] - clown[0].p[2]);
	h.check(cMoved > 0.05, '1.6 …and it does wander (' + cMoved.toFixed(2) + ' m)');
	let cAlong = 0;
	let cn = 0;
	for (let i = 2; i < clown.length; i++) {
		const d = [clown[i].p[0] - clown[i - 2].p[0], clown[i].p[1] - clown[i - 2].p[1], clown[i].p[2] - clown[i - 2].p[2]];
		const l = Math.hypot(...d);
		if (l < 0.03) continue;
		cAlong += (d[0] * clown[i].nose[0] + d[1] * clown[i].nose[1] + d[2] * clown[i].nose[2]) / l;
		cn++;
	}
	h.check(cn === 0 || cAlong / cn > 0.5, '1.7 Orient to Velocity points it where it goes (mean cos ' + (cn ? (cAlong / cn).toFixed(2) : 'n/a') + ' over ' + cn + ' moving samples)');
	const waves = await page.evaluate(() => window.__stores.motionNodes.motionNodesDebug().waves);
	h.check(waves.length === 6 && waves.every((w) => w.cloned && w.meshes > 0), '1.8 a Body Wave runs on every fish, each mesh on its own material copy (' + waves.map((w) => w.meshes).join(',') + ' meshes)');
	const wave = await page.evaluate(() => {
		const o = window.__aq.byName('Blue tang 1');
		let key = null;
		o.traverse((m) => { if (m.isMesh && !key) key = m.material.customProgramCacheKey(); });
		return { key };
	});
	h.check(/bodywave/.test(wave.key ?? ''), '1.9 the stand-in\'s material is patched by the wave (' + wave.key + ')');

	// ---- 2 fallback LOD with the pack reachable -------------------------------------------------
	await page.evaluate(() => window.__aq.render());
	await h.eventually(
		() => page.evaluate(() => window.__aq.fallbackRoots().map((o) => window.__stores.lodTrees.lodTreesOf(o).length)),
		(n) => n.every((c) => c >= 1),
		'2.1 every fallback group built its PACK model (a tree substitute)',
		45000
	);
	const drawn = await page.evaluate(() => {
		window.__aq.render();
		return window.__aq.fallbackRoots().map((o) => ({ name: o.name, current: window.__stores.lodGroup.lodGroupInfo(o.uuid)?.current }));
	});
	h.check(drawn.every((d) => d.current >= 1), '2.2 every group DRAWS a pack level, not its stand-in (' + drawn.map((d) => d.name.split(' ')[0] + ':' + d.current).join(' ') + ')');
	const tri = await page.evaluate(() => {
		const tree = window.__stores.lodTrees.lodTreesOf(window.__aq.byName('Clownfish 1'))[0];
		let n = 0;
		tree.traverse((m) => m.isMesh && (n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3));
		let irid = 0;
		tree.traverse((m) => m.isMesh && (irid = Math.max(irid, m.material.iridescence ?? 0)));
		let key = '';
		tree.traverse((m) => m.isMesh && (key = m.material.customProgramCacheKey?.() ?? ''));
		return { n, irid, key };
	});
	h.check(tri.n > 1000, '2.3 the clownfish substitute is the Meshy model (' + tri.n + ' triangles)');
	h.check(/bodywave/.test(tri.key), '2.4 the Body Wave bends the SUBSTITUTE too (' + tri.key + ')');
	const saved = await page.evaluate(() => {
		const payload = window.__stores.sessions.buildSessionPayload('probe');
		const json = JSON.stringify(payload.objects ?? payload);
		const fish = (payload.objects ?? []).find((o) => o.object?.name === 'Clownfish 1');
		return { bytes: json.length, holders: json.includes('lod-group-holders'), kids: fish?.object?.children?.length ?? -1, lod: !!fish?.object?.userData?.lod?.fallback };
	});
	h.check(!saved.holders && saved.kids >= 5 && saved.kids <= 9 && saved.lod, '2.5 a SAVE carries only the stand-in (' + saved.kids + ' parts) and its fallback block — no model in the file');
	const zipped = await page.evaluate(async () => {
		const s = window.__stores.sessions;
		const bytes = await s.exportSessionZip(s.buildSessionPayload('probe'), { assets: false, packs: false, flow: true });
		return bytes.byteLength ?? bytes.length ?? bytes.size;
	});
	h.check(zipped < 600_000, '2.6 the saved .tpscene stays small with the models drawn (' + Math.round(zipped / 1024) + ' KB zipped; the models are references)');
	const film = await page.evaluate(() => window.__stores.materialTiers.materialTiersDebug());
	h.check(film.tier === 'high' && tri.irid > 0.3, '2.7 a desktop draws the fish\'s thin film (tier ' + film.tier + ', iridescence ' + tri.irid + ')');
	if (SHOTS) await page.screenshot({ path: SHOTS + '-desktop.png' });

	// ---- 4 the look tier ------------------------------------------------------------------------
	const lowered = await page.evaluate(() => {
		const s = window.__stores;
		s.materialTiers.pinMaterialTier('low');
		const tree = s.lodTrees.lodTreesOf(window.__aq.byName('Clownfish 1'))[0];
		let m0 = null;
		tree.traverse((m) => m.isMesh && !m0 && (m0 = m.material));
		return { irid: m0.iridescence, authored: m0.userData.lookTierAuthored ?? null };
	});
	h.check(lowered.irid === 0 && lowered.authored?.iridescence > 0.3, '4.1 at the HEADSET tier the film is not drawn, the authored value rides beside it (' + JSON.stringify(lowered.authored) + ')');
	const back = await page.evaluate(() => {
		const s = window.__stores;
		s.materialTiers.pinMaterialTier('high');
		const tree = s.lodTrees.lodTreesOf(window.__aq.byName('Clownfish 1'))[0];
		let m0 = null;
		tree.traverse((m) => m.isMesh && !m0 && (m0 = m.material));
		return m0.iridescence;
	});
	h.check(back > 0.3, '4.2 back at the desktop tier the film returns (' + back + ')');
	const preset = await page.evaluate(async () => {
		const s = window.__stores;
		const group = window.__aq.read(s.objectsGroup);
		const box = group.getObjectByName('Rock big');
		const starter = s.materialPresets.starterPresets().find((p) => p.id === 'fishscale').preset;
		const ok = s.materialPresets.applyMaterialPreset(box.uuid, starter);
		const m = box.material;
		const high = { ok, type: m.type, irid: m.iridescence, trans: m.transmission, normal: !!m.normalMap, range: m.iridescenceThicknessRange };
		s.materialTiers.pinMaterialTier('mid');
		const mid = { irid: box.material.iridescence, trans: box.material.transmission };
		s.materialTiers.pinMaterialTier(null);
		return { high, mid };
	});
	h.check(preset.high.ok && preset.high.type === 'MeshPhysicalMaterial' && preset.high.irid > 0.5 && preset.high.normal && preset.high.trans > 0, '4.3 the Fish scales preset applies the full look: film, scale relief, transmission (' + JSON.stringify(preset.high) + ')');
	h.check(preset.mid.trans === 0 && preset.mid.irid > 0.5, '4.4 a PHONE tier drops only the transmission pass (' + JSON.stringify(preset.mid) + ')');

	// ---- 3 the counterfactual: the pack cannot be reached ---------------------------------------
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1440, height: 900 } } });
	await B.page.route(/aquarium-kit\/.*\.glb/, (route) => route.abort());
	await loadScene(B.page, AQUARIUM);
	await install(B.page);
	await B.page.evaluate(() => window.__aq.render());
	await B.page.waitForTimeout(3000);
	const offline = await B.page.evaluate(() => {
		window.__aq.render();
		return window.__aq.fallbackRoots().map((o) => ({
			name: o.name,
			current: window.__stores.lodGroup.lodGroupInfo(o.uuid)?.current,
			trees: window.__stores.lodTrees.lodTreesOf(o).length,
			failed: (window.__stores.lodGroup.lodGroupInfo(o.uuid)?.levels ?? []).filter((l) => l.status === 'failed').length
		}));
	});
	h.check(offline.every((d) => d.current === 0 && d.trees === 0), '3.1 pack unreachable: every group draws its STAND-IN (LOD0) — the scene still has its fish, coral and plants');
	h.check(offline.some((d) => d.failed > 0), '3.2 …and says why on the level (failed levels reported, not thrown)');
	const offMove = await sample(B.page, () => window.__aq.world('Blue tang 1'), 4, 300);
	h.check(Math.hypot(offMove[3][0] - offMove[0][0], offMove[3][2] - offMove[0][2]) > 0.1, '3.3 …and the stand-ins still swim');
	if (SHOTS) await B.page.screenshot({ path: SHOTS + '-offline.png' });

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, '9.1 no page errors (' + [...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 2).join(' | ') + ')');
	await h.finish(browser);
});
