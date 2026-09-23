// 30c level design — the three GENERAL-tab levels built from the kits (Castle Courtyard,
// Forest Clearing, Tavern Interior; defs in scripts/level-templates.cjs). For each one:
//   1. it loads from the Templates modal (the real card click) and every kit piece refills
//      from its pack (packRefs.js), with the file a fraction of what the pieces weigh;
//   2. Play puts you on the level's SPAWN (scenePhysics play.spawn) with the sim running;
//   3. the play frame is readable — centre luminance >= 0.25, round 1's bar (fork 11) —
//      and no quarter of the frame is black (no void, no black corner);
//   4. the walker CANNOT pass a wall, and CAN pass the openings built for it (an archway
//      and a staircase to a rampart, a doorway into a hut and a footbridge, a staircase to
//      a balcony) — the custom colliders are the reason both halves hold.
//
// The staged scenes are served to the Templates modal by page.route (the templates-modal
// suite's idiom) from LEVELS_DIR (default: the lane's staging folder), and the kits — until
// the pack PRs are merged and format-1 is retagged — from PACKS_DIR when the build's own
// PACKS_BASE is the CDN. SKIPS (never fails) when LEVELS_DIR has no index.
//
//   APP_URL=https://theprototype.app:5255/ node tests/e2e/level-templates.test.cjs
//   LEVELS=castle-courtyard  (a subset)
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const LEVELS_DIR = process.env.LEVELS_DIR || '/home/deck/.code/theprototype-app/cloud-lane-30-staging/30c-levels';
const PACKS_DIR = process.env.PACKS_DIR || '/home/deck/.code/lanes-30/levels-packs';
const ONLY = (process.env.LEVELS || '').split(',').filter(Boolean);

// what each level is walked through: [label, start {x, z, yaw}, key, ms, predicate(end), detail]
// yaw: 0 looks -Z, +PI/2 looks -X, PI looks +Z, -PI/2 looks +X (the spawn convention)
const PI = Math.PI;
// an object only that level has — what the load waits for, so a check never reads the
// PREVIOUS level while the new one is still arriving
const MARKER = { 'castle-courtyard': 'Castle gate', 'forest-clearing': 'Footbridge', 'tavern-interior': 'Balcony stairs' };
const WALKS = {
	'castle-courtyard': [
		{ label: 'the walker cannot walk through the south wall by the gate', at: [0, 3], yaw: PI, ms: 2500, pass: (e) => e.z < 5.8, moved: (b, e) => e.z - b.z > 1.2 },
		{ label: 'the walker cannot walk through the west curtain wall', at: [-4.8, 1.5], yaw: PI / 2, ms: 2500, pass: (e) => e.x > -7.9, moved: (b, e) => b.x - e.x > 1.5 },
		{ label: 'the walker passes the ARCHWAY and climbs the stairs onto the rampart', at: [-5, -4.6], yaw: 0, ms: 4500, pass: (e) => e.feet > 2.6 && e.z < -11.2, moved: (b, e) => b.z - e.z > 5 },
		{ label: 'on the rampart the battlements hold the walker in', at: [0, -12.8], y: 3, yaw: 0, ms: 2000, pass: (e) => e.z > -13.95 && e.feet > 2.6, moved: () => true }
	],
	'forest-clearing': [
		{ label: 'the walker cannot walk through the hut wall', at: [16, -7], yaw: PI / 2, ms: 2500, pass: (e) => e.x > 14.1, moved: (b, e) => b.x - e.x > 1 },
		{ label: 'the walker crosses the FOOTBRIDGE over the pond neck', at: [0, -6], yaw: -PI / 2, ms: 3000, pass: (e) => e.x > 5.3, moved: (b, e) => e.x - b.x > 5 },
		{ label: 'the walker enters the hut through its DOORWAY', at: [8, -6], yaw: -PI / 2, ms: 2200, pass: (e) => e.x > 10.6, moved: (b, e) => e.x - b.x > 2.5 }
	],
	'tavern-interior': [
		{ label: 'the walker cannot walk through the front wall', at: [0, 3], yaw: PI, ms: 2000, pass: (e) => e.z < 3.9, moved: (b, e) => e.z - b.z > 0.3 },
		{ label: 'the walker cannot walk through the east wall of the kitchen', at: [3.4, -2.6], yaw: -PI / 2, ms: 2500, pass: (e) => e.x < 5.9, moved: (b, e) => e.x - b.x > 1 },
		{ label: 'the walker climbs the oak STAIRS to the balcony', at: [-5, 1.3], yaw: 0, ms: 4500, pass: (e) => e.feet > 2.7 && e.z < -3.2, moved: (b, e) => b.z - e.z > 3.5 },
		{ label: 'the walker goes through the kitchen DOORWAY', at: [1.1, 1], yaw: -PI / 2, ms: 2200, pass: (e) => e.x > 2.6, moved: (b, e) => e.x - b.x > 1.5 }
	]
};

/** the rig's world position (feet = eye - 1.7) */
const rig = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let cam;
		s.playerCam.subscribe((c) => (cam = c))();
		if (!cam) return null;
		const w = cam.getWorldPosition(new s.THREE.Vector3());
		return { x: w.x, y: w.y, z: w.z, feet: w.y - 1.7 };
	});

/** put the rig's FEET at (x, y, z), level, facing `yaw` */
const placeRig = (page, x, y, z, yaw) =>
	page.evaluate(
		({ x, y, z, yaw }) => {
			const s = window.__stores;
			/** @type {any} */ let cam;
			s.playerCam.subscribe((c) => (cam = c))();
			const v = new s.THREE.Vector3(x, y + 1.7, z);
			cam.parent?.worldToLocal(v);
			cam.position.copy(v);
			cam.quaternion.setFromEuler(new s.THREE.Euler(0, yaw, 0, 'YXZ'));
			cam.updateMatrixWorld(true);
			return true;
		},
		{ x, y, z, yaw }
	);

/** centre-clip luminance + the darkest quadrant of a real screenshot */
async function frameLight(page) {
	return page.evaluate(async (b64) => {
		const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
		const c = document.createElement('canvas');
		c.width = bmp.width;
		c.height = bmp.height;
		const x = c.getContext('2d');
		x.drawImage(bmp, 0, 0);
		const lum = (/** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ w, /** @type {number} */ hgt) => {
			const d = x.getImageData(x0, y0, w, hgt).data;
			let sum = 0;
			for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
			return sum / (d.length / 4) / 255;
		};
		const W = bmp.width;
		const Hh = bmp.height;
		const centre = lum(Math.round(W / 2 - 180), Math.round(Hh / 2 - 180), 360, 360);
		const quads = [lum(0, 0, W / 2, Hh / 2), lum(W / 2, 0, W / 2, Hh / 2), lum(0, Hh / 2, W / 2, Hh / 2), lum(W / 2, Hh / 2, W / 2, Hh / 2)];
		return { centre, darkest: Math.min(...quads), quads };
	}, (await page.screenshot()).toString('base64'));
}

h.run(async () => {
	const indexFile = path.join(LEVELS_DIR, 'index.json');
	if (!fs.existsSync(indexFile)) {
		console.log('SKIP no staged levels at ' + LEVELS_DIR + ' (author them: see the handover)');
		console.log('ALL PASS');
		return;
	}
	const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
	const levels = (index.templates ?? []).filter((t) => WALKS[t.slug] && (!ONLY.length || ONLY.includes(t.slug)));
	h.check(levels.length > 0, `the staged index lists the levels (${levels.map((l) => l.slug).join(', ')})`);

	const browser = await h.launch({ args: h.GPU_ARGS });
	// warm the lazy rapier import (the physics-suite ritual): Play must have a world at once
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1540, height: 774 } } });
	const page = A.page;
	// the Templates modal's feed -> the staged folder; the kits -> PACKS_DIR when this build
	// reads them from the CDN (a relative pack path resolves against PACKS_BASE)
	await page.route('**/cdn.jsdelivr.net/**', (route) => {
		const url = route.request().url();
		const scenes = url.match(/\/theprototype-app\/scenes@[^/]+\/(.*)$/);
		if (scenes) {
			const file = path.join(LEVELS_DIR, decodeURIComponent(scenes[1]));
			if (scenes[1] === 'index.json') return route.fulfill({ json: index });
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
			return route.fulfill({ status: 404 });
		}
		const packs = url.match(/\/theprototype-app\/packs@[^/]+\/(.*)$/);
		if (packs && fs.existsSync(PACKS_DIR)) {
			const file = path.join(PACKS_DIR, decodeURIComponent(packs[1]));
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
		}
		return route.continue();
	});

	for (const level of levels) {
		console.log('\n--- ' + level.slug);
		const size = fs.statSync(path.join(LEVELS_DIR, level.scene)).size;
		h.check(size < 400_000, `${level.title}: the .tpscene is ${Math.round(size / 1024)} KB (kit pieces ride as references)`);

		// 1. load it from the Templates modal ---------------------------------------
		await page.evaluate(() => window.__stores.isLocked.set(null));
		await page.locator('#logo-menu').click();
		await page.waitForTimeout(300);
		await page.locator('#open-templates').click();
		await page.waitForTimeout(500);
		await page.locator('#templates-tab-general').click();
		const card = page.locator(`[data-scene-slug="${level.slug}"]`);
		h.check(await card.isVisible().catch(() => false), `${level.title}: the card is on the General tab`);
		await card.click();
		// a replace of a non-empty scene answers nothing here (no peers); a large-scene ask
		// would be a finding, so it is NOT auto-answered
		await h.eventually(
			() =>
				page.evaluate(async (marker) => {
					const s = window.__stores;
					/** @type {any} */ let g;
					s.objectsGroup.subscribe((v) => (g = v))();
					let refs = 0;
					let hollow = 0;
					let meshes = 0;
					g.traverse((/** @type {any} */ n) => {
						if (n.userData?.packRef) refs++;
						if (n.userData?.packStub) hollow++;
						if (n.isMesh) meshes++;
					});
					/** @type {any} */ let pending;
					s.packRefs.packRefsPending.subscribe((v) => (pending = v))();
					return { refs, hollow, meshes, pending, marker: !!g.getObjectByName(marker) };
				}, MARKER[level.slug]),
			(r) => r.marker && r.refs > 50 && r.hollow === 0 && r.pending === 0,
			`${level.title}: the level loads and every kit piece refills from its pack`,
			60000
		);
		const facts = await page.evaluate(() => {
			const s = window.__stores;
			/** @type {any} */ let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			let refs = 0;
			let meshes = 0;
			const maps = new Set();
			g.traverse((/** @type {any} */ n) => {
				if (n.userData?.packRef) refs++;
				if (n.isMesh) {
					meshes++;
					if (n.material?.map) maps.add(n.material.map);
				}
			});
			/** @type {any} */ let play;
			s.scenePhysics.scenePlay.subscribe((v) => (play = v))();
			return { refs, meshes, maps: maps.size, spawn: play?.spawn ?? null, simOnPlay: play?.simOnPlay };
		});
		h.check(facts.maps < facts.refs / 2, `${level.title}: ${facts.refs} kit pieces share ${facts.maps} base textures`);
		h.check(!!facts.spawn && facts.simOnPlay === true, `${level.title}: a spawn point and sim-on-play are scene data (${JSON.stringify(facts.spawn)})`);

		// COUNTERFACTUALS (CF=arch | CF=spawn): break one guard in the page and watch its
		// check go red — the archway loses its custom collider (the box of the whole arch
		// then blocks the opening), or the scene loses its spawn (Play starts at the fixed
		// (0, 2, 3))
		if (process.env.CF)
			await page.evaluate((cf) => {
				const s = window.__stores;
				/** @type {any} */ let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				if (cf === 'arch') delete g.getObjectByName('Stair archway')?.userData?.physics;
				if (cf === 'spawn') s.scenePhysics.setScenePhysics({ play: { spawn: null } });
			}, process.env.CF);

		// 2. Play: the spawn, the sim --------------------------------------------------
		await page.evaluate(() => window.__stores.isLocked.set(true));
		await h.eventually(
			() => page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return v; }),
			(v) => v === true,
			`${level.title}: Play starts the simulation (sim-on-play)`,
			15000
		);
		await page.waitForTimeout(1200);
		const at = await rig(page);
		h.check(
			at && Math.hypot(at.x - facts.spawn.pos[0], at.z - facts.spawn.pos[2]) < 0.6 && Math.abs(at.feet - facts.spawn.pos[1]) < 0.6,
			`${level.title}: Play starts at the spawn point (${at && [at.x, at.feet, at.z].map((v) => v.toFixed(2))})`
		);
		const walker = await page.evaluate(() => { let v; window.__stores.charController.walkerState.subscribe((x) => (v = x))(); return v; });
		h.check(walker.source === 'rapier' && walker.grounded, `${level.title}: the walker stands on the level through the physics world (${walker.source}, grounded ${walker.grounded})`);

		// 3. the frame reads, and no quarter is a void ----------------------------------
		await page.waitForTimeout(800);
		const light = await frameLight(page);
		await page.screenshot({ path: `/home/deck/.code/lanes-30/after-30c/30c-level-design/play-${level.slug}.png` });
		h.check(light.centre >= 0.25, `${level.title}: the play frame reads — centre luminance ${light.centre.toFixed(3)} >= 0.25`);
		h.check(light.darkest >= 0.08, `${level.title}: no black quarter (darkest quadrant ${light.darkest.toFixed(3)}; ${light.quads.map((q) => q.toFixed(2))})`);

		// 4. walls hold, openings pass ----------------------------------------------------
		for (const walk of WALKS[level.slug]) {
			await placeRig(page, walk.at[0], walk.y ?? 0.3, walk.at[1], walk.yaw);
			await page.waitForTimeout(700);
			const before = await rig(page);
			await page.keyboard.down('KeyW');
			await page.waitForTimeout(walk.ms);
			await page.keyboard.up('KeyW');
			await page.waitForTimeout(300);
			const end = await rig(page);
			const ok = before && end && walk.moved(before, end) && walk.pass(end);
			h.check(!!ok, `${level.title}: ${walk.label} (from ${before && [before.x, before.feet, before.z].map((v) => v.toFixed(2))} to ${end && [end.x, end.feet, end.z].map((v) => v.toFixed(2))})`);
		}
		await page.evaluate(() => window.__stores.isLocked.set(false));
		await page.waitForTimeout(2500);
	}
	await h.finish(browser);
});
