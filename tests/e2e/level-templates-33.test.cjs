// 33-scenes — the General-tab levels of roadmap 33 (defs in scripts/level-templates.cjs): the
// updated architecture shell (Tavern Interior: working doors, the Interiors kit, a street front)
// and the two new scenes (Wizard's Tower, Market Town Square). For each one:
//   1. it loads from the Templates modal (the real card click), every kit piece refills from its
//      pack, every FUNCTIONAL piece (a door, a chest, a lever) registers its behavior, and the
//      file stays small (kit pieces AND animated pack pieces ride as references);
//   2. NOTHING MOVES on load or in Edit — every door rests shut, every ambient loop holds still
//      (contract P2: no clip plays on placement, on load, in Edit);
//   3. in INTERACT a real mouse click on a door opens it — its leaf swings — and a second click
//      shuts it; an ambient piece (the tower's banner) runs in Interact;
//   4. in PLAY: the spawn, sim-on-play, a readable frame (no black quarter), and the walker is
//      STOPPED by a shut door and walks THROUGH it once it is open (the leaf's collider follows
//      the clip) — plus each scene's own walks (stairs, gates);
//   5. the Quest budget: the draw calls per frame from every named viewpoint
//      (scripts/level-views.cjs), headset analogue (post off, shadows off — the XR entry floor),
//      stay at or under 150.
// Frames are read from the CANVAS inside the final render call, never a page screenshot: on
// this machine's ANGLE/Vulkan a screenshot misses textured kit meshes (kit-instancing's note).
//
// The staged scenes are served to the Templates modal by page.route from LEVELS_DIR (default:
// this lane's staging folder); the kits come from the build's own PACKS_BASE (VITE_PACKS_BASE),
// else PACKS_DIR when the build reads the CDN. SKIPS (never fails) when LEVELS_DIR has no index.
//
//   APP_URL=https://theprototype.app:5282/ node tests/e2e/level-templates-33.test.cjs
//   LEVELS=wizards-tower  (a subset) · SHOTS=<dir> (default after-33/33-scenes) · LIVE=1
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const VIEWS = require('../../scripts/level-views.cjs');

const LEVELS_DIR = process.env.LEVELS_DIR || '/home/deck/.code/theprototype-app/cloud-lane-30-staging/33-scenes';
const PACKS_DIR = process.env.PACKS_DIR || '';
const SHOTS = process.env.SHOTS || '/home/deck/.code/lanes-30/after-33/33-scenes';
const ONLY = (process.env.LEVELS || '').split(',').filter(Boolean);
const PI = Math.PI;
const BUDGET = 150;

// per level: the object only it has (the load waits for it), how many functional pieces it
// holds, the door the Interact click opens and where to look at it from, and the walks
const LEVELS = {
	'tavern-interior': {
		marker: 'Balcony stairs',
		behaviors: 5,
		click: { door: 'Front door', eye: [-3, 1.6, 7.5] },
		doorWalks: [
			{ door: 'Front door', label: 'the FRONT DOOR from the street', at: [-3, 6.2], y: 0.35, yaw: 0, ms: 2600, shut: (e) => e.z > 4.15, open: (e) => e.z < 2.6 },
			{ door: 'Kitchen door', label: 'the KITCHEN DOOR from the hall', at: [0.9, 1], yaw: -PI / 2, ms: 2400, shut: (e) => e.x < 1.9, open: (e) => e.x > 2.8 }
		],
		walks: [
			{ label: 'the walker cannot walk through the front wall', at: [0, 3], yaw: PI, ms: 2000, pass: (e) => e.z < 3.9, moved: (b, e) => e.z - b.z > 0.3 },
			{ label: 'the walker climbs the oak STAIRS to the balcony', at: [-5, 1.3], yaw: 0, ms: 4500, pass: (e) => e.feet > 2.7 && e.z < -3.2, moved: (b, e) => b.z - e.z > 3.5 }
		]
	},
	'wizards-tower': {
		marker: 'Stairs to the roof',
		behaviors: 9,
		click: { door: 'Tower door', eye: [1, 1.6, 7.5] },
		ambient: 'Tower banner',
		doorWalks: [
			{ door: 'Garden gate', label: 'the GARDEN GATE on the path', at: [1, 12.4], yaw: 0, ms: 2400, shut: (e) => e.z > 10.6, open: (e) => e.z < 9.5 },
			{ door: 'Tower door', label: 'the TOWER DOOR', at: [1, 6.4], yaw: 0, ms: 2600, shut: (e) => e.z > 4.15, open: (e) => e.z < 2.8 }
		],
		walks: [
			{ label: 'the walker cannot walk through the tower wall', at: [-1, 6], yaw: 0, ms: 2200, pass: (e) => e.z > 4.1, moved: (b, e) => b.z - e.z > 0.4 },
			{ label: 'the walker climbs to the STUDY', at: [-3, 2.6], yaw: 0, ms: 4500, pass: (e) => e.feet > 2.7 && e.z < -2.3, moved: (b, e) => b.z - e.z > 3.5 },
			{ label: 'the walker climbs from the study to the BEDCHAMBER', at: [3, -2.6], y: 3.1, yaw: PI, ms: 4500, pass: (e) => e.feet > 5.7 && e.z > 2.3, moved: (b, e) => e.z - b.z > 3.5 },
			{ label: 'the walker climbs to the ROOF TERRACE', at: [-3, 2.6], y: 6.1, yaw: 0, ms: 4500, pass: (e) => e.feet > 8.7 && e.z < -2.3, moved: (b, e) => b.z - e.z > 3.5 },
			{ label: 'the battlements hold the walker on the roof', at: [1, 2.5], y: 9.1, yaw: PI, ms: 2200, pass: (e) => e.z < 3.95 && e.feet > 8.7, moved: () => true }
		]
	},
	'market-square': {
		marker: 'Fountain',
		behaviors: 3,
		click: { door: 'Bakery door', eye: [-5, 1.6, -4.5] },
		doorWalks: [{ door: 'Bakery door', label: 'the BAKERY DOOR from the square', at: [-5, -5.2], y: 0.35, yaw: 0, ms: 2600, shut: (e) => e.z > -7.9, open: (e) => e.z < -9.3 }],
		walks: [
			{ label: 'the walker cannot walk through the fountain', at: [0, 4.5], y: 0.35, yaw: 0, ms: 2500, pass: (e) => e.z > 1.4, moved: (b, e) => b.z - e.z > 0.5 },
			{ label: 'the walker cannot walk into the clock tower', at: [10.5, -10], y: 0, yaw: PI / 2, ms: 2500, pass: (e) => e.x > 8.1, moved: (b, e) => b.x - e.x > 0.3 }
		]
	}
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

/** the composed frame, read from the canvas inside the final render call (a JPEG data URL) */
const grab = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = window.__stores;
				/** @type {any} */ let r;
				s.globalRenderer.subscribe((v) => (r = v))();
				const inner = r.render;
				r.render = function (/** @type {any} */ sc, /** @type {any} */ cam) {
					const out = inner.call(this, sc, cam);
					if (!this.getRenderTarget()) {
						r.render = inner;
						resolve(this.domElement.toDataURL('image/jpeg', 0.9));
					}
					return out;
				};
			})
	);

/** centre luminance + the darkest quadrant of a frame */
const frameLight = (page, url) =>
	page.evaluate(async (url) => {
		const bmp = await createImageBitmap(await (await fetch(url)).blob());
		const c = document.createElement('canvas');
		c.width = bmp.width;
		c.height = bmp.height;
		const x = c.getContext('2d');
		x.drawImage(bmp, 0, 0);
		const lum = (x0, y0, w, hgt) => {
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
	}, url);

const save = (url, file) => fs.writeFileSync(path.join(SHOTS, file), Buffer.from(url.split(',')[1], 'base64'));

/** every functional piece's pose: the summed rotation of its moving nodes + the banner's morph */
const poses = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		/** @type {Record<string, {name: string, sig: number, on: boolean}>} */
		const out = {};
		for (const uuid of s.animatedImports.behaviorUuids()) {
			const root = g.getObjectByProperty('uuid', uuid);
			if (!root) continue;
			let sig = 0;
			root.traverse((/** @type {any} */ n) => {
				if (n === root) return;
				sig += Math.abs(n.quaternion.x) + Math.abs(n.quaternion.y) + Math.abs(n.quaternion.z) + Math.abs(n.position.x) + Math.abs(n.position.y) + Math.abs(n.position.z);
				for (const v of n.morphTargetInfluences ?? []) sig += v;
			});
			out[uuid] = { name: root.name, sig, on: !!s.packBehavior.behaviorState(uuid)?.on };
		}
		return out;
	});

/** the uuid of the animated root called `name` */
const uuidOf = (page, name) =>
	page.evaluate((name) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.find((/** @type {any} */ c) => c.name === name)?.uuid ?? null;
	}, name);

/** the angle (degrees) a door's moving parts have turned or slid from `before` */
const leafAngle = (page, uuid) =>
	page.evaluate((uuid) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const root = g.getObjectByProperty('uuid', uuid);
		let best = 0;
		root?.traverse((/** @type {any} */ n) => {
			if (n === root || !n.isObject3D) return;
			const w = Math.min(1, Math.abs(n.quaternion.w));
			best = Math.max(best, (2 * Math.acos(w) * 180) / Math.PI);
		});
		return best;
	}, uuid);

h.run(async () => {
	const indexFile = path.join(LEVELS_DIR, 'index.json');
	if (!fs.existsSync(indexFile)) {
		console.log('SKIP no staged levels at ' + LEVELS_DIR + ' (author them: see the handover)');
		console.log('ALL PASS');
		return;
	}
	fs.mkdirSync(SHOTS, { recursive: true });
	const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
	const levels = (index.templates ?? []).filter((t) => LEVELS[t.slug] && (!ONLY.length || ONLY.includes(t.slug)));
	h.check(levels.length > 0, `the staged index lists the levels (${levels.map((l) => l.slug).join(', ')})`);

	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	if (!process.env.LIVE)
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
			if (packs && PACKS_DIR && fs.existsSync(PACKS_DIR)) {
				const file = path.join(PACKS_DIR, decodeURIComponent(packs[1]));
				if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
			}
			return route.continue();
		});

	for (const level of levels) {
		const L = LEVELS[level.slug];
		console.log('\n--- ' + level.slug);
		const size = fs.statSync(path.join(LEVELS_DIR, level.scene)).size;
		h.check(size < 150_000, `${level.title}: the .tpscene is ${Math.round(size / 1024)} KB (kit pieces and doors ride as pack references)`);

		// 1. load it from the Templates modal ------------------------------------------------
		await page.evaluate(() => {
			const s = window.__stores;
			s.isLocked.set(null);
			s.objectActions.setEditorMode('edit');
		});
		await page.locator('#logo-menu').click();
		await page.waitForTimeout(300);
		await page.locator('#open-templates').click();
		await page.waitForTimeout(500);
		await page.locator('#templates-tab-general').click();
		const card = page.locator(`[data-scene-slug="${level.slug}"]`);
		h.check(await card.isVisible().catch(() => false), `${level.title}: the card is on the General tab`);
		await card.click();
		await h.eventually(
			() =>
				page.evaluate((marker) => {
					const s = window.__stores;
					/** @type {any} */ let g;
					s.objectsGroup.subscribe((v) => (g = v))();
					let refs = 0;
					let hollow = 0;
					g.traverse((/** @type {any} */ n) => {
						if (n.userData?.packRef) refs++;
						if (n.userData?.packStub) hollow++;
					});
					/** @type {any} */ let pending;
					s.packRefs.packRefsPending.subscribe((v) => (pending = v))();
					return { refs, hollow, pending, marker: !!g.getObjectByName(marker), behaviors: s.animatedImports.behaviorUuids().length };
				}, L.marker),
			(r) => r.marker && r.refs > 80 && r.hollow === 0 && r.pending === 0 && r.behaviors === L.behaviors,
			`${level.title}: the level loads, every kit piece refills and its ${L.behaviors} functional pieces register`,
			60000
		);
		await page.evaluate(() => window.__stores.selectedObjects.set([]));
		await page.waitForTimeout(1200);

		// 2. nothing moves in Edit ---------------------------------------------------------
		const rest0 = await poses(page);
		await page.waitForTimeout(1500);
		const rest1 = await poses(page);
		const moved = Object.keys(rest0).filter((u) => Math.abs(rest0[u].sig - (rest1[u]?.sig ?? 0)) > 1e-4 || rest1[u]?.on);
		h.check(Object.keys(rest0).length === L.behaviors && moved.length === 0, `${level.title}: nothing moves in Edit — ${Object.keys(rest0).length} pieces at rest${moved.length ? ' (moved: ' + moved.map((u) => rest0[u].name).join(', ') + ')' : ''}`);

		// 3. Interact: a real click opens the door, a second shuts it ---------------------
		await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
		const door = await uuidOf(page, L.click.door);
		const target = await page.evaluate((uuid) => {
			const s = window.__stores;
			/** @type {any} */ let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const root = g.getObjectByProperty('uuid', uuid);
			const box = new s.THREE.Box3().setFromObject(root);
			return [...box.getCenter(new s.THREE.Vector3()).toArray(), box.max.y];
		}, door);
		await page.evaluate(({ eye, target }) => window.__stores.objectActions.flyTo(eye, target, 0), { eye: L.click.eye, target });
		await page.waitForTimeout(900);
		const px = await h.projectPoint(page, [target[0], target[1] - 0.2, target[2]]);
		const onCanvas = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, px);
		h.check(onCanvas === 'CANVAS', `${level.title}: premise — the door is under the pointer on the canvas (${onCanvas})`);
		const shutAngle = await leafAngle(page, door);
		await page.mouse.click(px.x, px.y);
		await page.waitForTimeout(1600);
		const opened = await page.evaluate((uuid) => window.__stores.packBehavior.behaviorState(uuid), door);
		const openAngle = await leafAngle(page, door);
		h.check(!!opened?.on, `${level.title}: a click in Interact OPENS "${L.click.door}" (state ${JSON.stringify(opened)})`);
		h.check(Math.abs(openAngle - shutAngle) > 45, `${level.title}: its leaf swings (${shutAngle.toFixed(0)}° -> ${openAngle.toFixed(0)}°)`);
		save(await grab(page), `interact-door-open-${level.slug}.jpg`);
		// the second click aims at the LEAF where it has swung to (a user clicks the open door)
		// look at the open leaf from whichever side sees it unobstructed (a ray from the eye must
		// reach the door first), then click its middle
		const view = await page.evaluate((uuid) => {
			const s = window.__stores;
			const T = s.THREE;
			/** @type {any} */ let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const root = g.getObjectByProperty('uuid', uuid);
			/** @type {any} */ let leaf = null;
			let best = -1;
			root.traverse((/** @type {any} */ n) => {
				if (n === root) return;
				const a = 2 * Math.acos(Math.min(1, Math.abs(n.quaternion.w)));
				if (a > best) {
					best = a;
					leaf = n;
				}
			});
			const c = new T.Box3().setFromObject(leaf).getCenter(new T.Vector3());
			const normal = leaf.getWorldDirection(new T.Vector3()).setY(0).normalize();
			for (const side of [1, -1]) {
				const eye = c.clone().addScaledVector(normal, 2.2 * side);
				eye.y = c.y + 0.3;
				const ray = new T.Raycaster(eye, c.clone().sub(eye).normalize());
				const hit = ray.intersectObject(g, true).find((x) => x.object.visible);
				let up = hit?.object;
				while (up && up !== root && up.parent) up = up.parent;
				if (up === root) return { eye: eye.toArray(), c: c.toArray() };
			}
			return { eye: null, c: c.toArray() };
		}, door);
		h.check(!!view.eye, `${level.title}: premise — the open leaf can be seen from one side`);
		if (view.eye) await page.evaluate(({ eye, c }) => window.__stores.objectActions.flyTo(eye, c, 0), view);
		await page.waitForTimeout(900);
		const leafPx = await h.projectPoint(page, view.c);
		await page.mouse.click(leafPx.x, leafPx.y);
		await page.waitForTimeout(1600);
		const shut = await page.evaluate((uuid) => window.__stores.packBehavior.behaviorState(uuid), door);
		const why = await page.evaluate(() => window.__stores.packBehavior.packBehaviorDebug?.().lastClick ?? null);
		const shutNow = await leafAngle(page, door);
		h.check(!shut?.on && Math.abs(shutNow - shutAngle) < 5, `${level.title}: a second click SHUTS it (state ${JSON.stringify(shut)}, leaf ${shutNow.toFixed(0)}°, last click ${JSON.stringify(why)})`);
		if (L.ambient) {
			const amb = await uuidOf(page, L.ambient);
			const a0 = (await poses(page))[amb]?.sig;
			await page.waitForTimeout(700);
			const a1 = (await poses(page))[amb]?.sig;
			h.check(a0 != null && Math.abs(a0 - a1) > 1e-4, `${level.title}: the ambient "${L.ambient}" moves on its own in Interact (and held still in Edit)`);
		}
		await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));

		// 4. Play: spawn, sim, a readable frame, doors stop and pass the walker -------------
		await page.evaluate(() => window.__stores.isLocked.set(true));
		await h.eventually(
			() => page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return v; }),
			(v) => v === true,
			`${level.title}: Play starts the simulation (sim-on-play)`,
			15000
		);
		await page.waitForTimeout(1500);
		const spawn = await page.evaluate(() => { let p; window.__stores.scenePhysics.scenePlay.subscribe((v) => (p = v))(); return p?.spawn?.position ?? null; });
		const at = await rig(page);
		h.check(!!spawn && at && Math.hypot(at.x - spawn[0], at.z - spawn[2]) < 0.6, `${level.title}: Play starts at the spawn point (${at && [at.x, at.feet, at.z].map((v) => v.toFixed(2))})`);
		const walker = await page.evaluate(() => { let v; window.__stores.charController.walkerState.subscribe((x) => (v = x))(); return v; });
		h.check(walker?.source === 'rapier' && walker.grounded, `${level.title}: the walker stands on the level (${walker?.source}, grounded ${walker?.grounded})`);
		await page.waitForTimeout(600);
		const frame = await grab(page);
		save(frame, `play-${level.slug}.jpg`);
		const light = await frameLight(page, frame);
		// two of the three are an evening and a dusk (30c's 0.25 bar was for daylight levels)
		h.check(light.centre >= 0.12, `${level.title}: the play frame reads — centre luminance ${light.centre.toFixed(3)}`);
		h.check(light.darkest >= 0.06, `${level.title}: no black quarter (darkest ${light.darkest.toFixed(3)}; ${light.quads.map((q) => q.toFixed(2))})`);

		/** walk with W for `ms` from (x, y, z) facing yaw; resolves {before, end} */
		const walk = async (w) => {
			await placeRig(page, w.at[0], w.y ?? 0.3, w.at[1], w.yaw);
			await page.waitForTimeout(700);
			const before = await rig(page);
			await page.keyboard.down('KeyW');
			await page.waitForTimeout(w.ms);
			await page.keyboard.up('KeyW');
			await page.waitForTimeout(300);
			return { before, end: await rig(page) };
		};
		const fmt = (p) => p && [p.x, p.feet, p.z].map((v) => v.toFixed(2)).join(',');
		for (const dw of L.doorWalks) {
			const uuid = await uuidOf(page, dw.door);
			await page.evaluate((u) => window.__stores.packBehavior.triggerBehavior(u, false), uuid);
			await page.waitForTimeout(1300);
			const a = await walk(dw);
			h.check(!!a.end && dw.shut(a.end), `${level.title}: ${dw.label} STOPS the walker while shut (to ${fmt(a.end)})`);
			await page.evaluate((u) => window.__stores.packBehavior.triggerBehavior(u, true), uuid);
			await page.waitForTimeout(1500);
			const b = await walk(dw);
			h.check(!!b.end && dw.open(b.end), `${level.title}: … and the walker goes THROUGH it once it is open (to ${fmt(b.end)})`);
		}
		for (const w of L.walks) {
			const r = await walk(w);
			h.check(!!(r.before && r.end && w.moved(r.before, r.end) && w.pass(r.end)), `${level.title}: ${w.label} (from ${fmt(r.before)} to ${fmt(r.end)})`);
		}

		// 5. the Quest budget: calls per frame from every named view (headset analogue) -------
		await page.evaluate(() => {
			const s = window.__stores;
			s.viewportOverrides.setRenderLayer('post', false);
			s.viewMode.set('shaded');
			s.lightParams.shadowQuality.set('off');
		});
		/** @type {string[]} */
		const lines = [];
		let worst = 0;
		for (const [label, feet, yaw] of VIEWS[level.slug] ?? []) {
			await placeRig(page, feet[0], feet[1], feet[2], yaw);
			await page.waitForTimeout(700);
			const calls = await page.evaluate(
				() =>
					new Promise((resolve) => {
						const s = window.__stores;
						/** @type {any} */ let r;
						s.globalRenderer.subscribe((v) => (r = v))();
						const inner = r.render;
						let sum = 0;
						let frames = 0;
						let cur = 0;
						r.render = function (/** @type {any[]} */ ...a) {
							const out = inner.apply(this, a);
							cur += this.info.render.calls;
							return out;
						};
						const tick = () => {
							sum = Math.max(sum, cur);
							cur = 0;
							if (++frames < 30) requestAnimationFrame(tick);
							else {
								r.render = inner;
								resolve(sum);
							}
						};
						requestAnimationFrame(tick);
					})
			);
			worst = Math.max(worst, /** @type {number} */ (calls));
			lines.push(`${label} ${calls}`);
			save(await grab(page), `view-${level.slug}-${label.replace(/\W+/g, '-')}.jpg`);
		}
		h.check(worst > 0 && worst <= BUDGET, `${level.title}: at most ${BUDGET} draw calls a frame in a headset from every view — worst ${worst} (${lines.join(' · ')})`);
		await page.evaluate(() => {
			const s = window.__stores;
			s.viewportOverrides.setRenderLayer('post', true);
			s.lightParams.shadowQuality.set('high');
			s.isLocked.set(false);
		});
		await page.waitForTimeout(2500);
	}
	await h.finish(browser);
});
