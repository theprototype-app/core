// 33-scenes — KIT INSTANCING (src/lib/kitInstancing.js): every pristine copy of one pack piece
// drawn as ONE instanced call, and nothing else about the scene changes.
//   1. a row of 6 kit walls + 6 floor tiles (stubs refilled from the pack) draws in FEWER
//      calls with instancing on, and the frame is the SAME picture as with it off;
//   2. the members stay the scene: a click on a wall still picks the wall, the tree holds no
//      instanced mesh, a save writes the same stubs;
//   3. a SELECTED, a RECOLOURED, a HIDDEN and a MOVED piece are each drawn right — the
//      selected and recoloured leave their batch, the hidden one is not drawn, the moved one
//      is drawn where it went.
// Needs the architecture kit served by the build (VITE_PACKS_BASE); SKIPS otherwise.
//
//   APP_URL=https://theprototype.app:5282/ node tests/e2e/kit-instancing.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	// the DEFAULT backend, deliberately: on this machine's ANGLE/Vulkan (h.GPU_ARGS) a Playwright
	// screenshot misses textured kit meshes that the composed canvas holds (measured: the
	// canvas read inside the final render call shows the walls, the screenshot does not), so
	// every frame comparison here would compare two empty views
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'kit-instancing', { context: { viewport: { width: 1280, height: 720 } } });
	const page = peer.page;

	const served = await page.evaluate(async () => {
		const base = String(window.__stores.packs.PACKS_BASE).replace(/\/+$/, '');
		const res = await fetch(base + '/architecture-kit/default.json').catch(() => null);
		return !!res?.ok;
	});
	if (!served) {
		console.log('SKIP the architecture kit is not served by this build (set VITE_PACKS_BASE)');
		await h.finish(browser);
		return;
	}

	// ---- the fixture: kit stubs, refilled from the pack ------------------------------------
	await page.evaluate(async () => {
		const s = window.__stores;
		const T = s.THREE;
		s.commandsHandler.sceneCommand('/clear all');
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const stub = (item, file, name, pos, yaw = 0) => {
			const o = new T.Group();
			o.name = name;
			o.userData.packRef = { pack: 'architecture-kit', item, path: 'architecture-kit/' + item + '/glTF-Binary/' + file, kids: [] };
			o.userData.packStub = true;
			o.position.fromArray(pos);
			o.rotation.y = yaw;
			g.add(o);
			return o;
		};
		const res = await fetch(String(s.packs.PACKS_BASE).replace(/\/+$/, '') + '/architecture-kit/default.json');
		const rows = await res.json();
		const fileOf = (n) => rows.find((r) => r.name === n).variants['glTF-Binary'];
		for (let i = 0; i < 6; i++) stub('WallStone', fileOf('WallStone'), 'Wall ' + (i + 1), [-5 + i * 2, 0, -4]);
		for (let i = 0; i < 6; i++) stub('FloorWood', fileOf('FloorWood'), 'Floor ' + (i + 1), [-5 + i * 2, 0, -2]);
		s.objectsGroup.update((v) => v);
		await new Promise((r) => setTimeout(r, 300));
		await s.packRefs.packRefsSettled();
		s.lightParams.shadowQuality.set('off'); // one pass per frame: the counts are exact
		s.objectActions.flyTo([0, 2.2, 6], [0, 1, -3], 0);
	});
	/** the viewport may be HELD on its last frame while programs link (sceneLoader.holdFrames,
	 * bounded at 2 s): wait it out, or a screenshot shows the frame from before the pieces */
	const settle = async () => {
		await page.waitForTimeout(300);
		await page.waitForFunction(() => !window.__stores.sceneLoader.framesHeld(), null, { timeout: 10000 }).catch(() => {});
		await page.waitForTimeout(500);
	};
	await settle();
	await page.evaluate(() => window.__stores.kitInstancing.scanForKitInstancing());
	await settle();
	// the premise: the pieces are ON SCREEN (a frame comparison over an empty view proves nothing)
	const showAll = (on) =>
		page.evaluate((on) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			for (const o of g.children) o.visible = on;
		}, on);
	await showAll(false);
	await settle();
	const empty = await h.grabFrame(peer);
	await showAll(true);
	await settle();
	const full = await h.grabFrame(peer);
	const present = await h.frameDelta(page, empty, full, 20);
	h.check(present.fraction > 0.08, `premise: the 12 pieces are on screen (${(present.fraction * 100).toFixed(1)} % of the frame is them)`);

	/** draw calls of ONE render (the shadow pass is off) */
	const calls = () =>
		page.evaluate(
			() =>
				new Promise((resolve) => {
					const s = window.__stores;
					let r;
					s.globalRenderer.subscribe((v) => (r = v))();
					const inner = r.render;
					let worst = 0;
					let n = 0;
					r.render = function (...a) {
						const out = inner.apply(this, a);
						worst = Math.max(worst, this.info.render.calls);
						n++;
						return out;
					};
					setTimeout(() => {
						r.render = inner;
						resolve({ worst, renders: n, stats: s.kitInstancing.kitInstancingStats() });
					}, 600);
				})
		);
	const setOn = async (on) => {
		await page.evaluate((on) => window.__stores.kitInstancing.kitInstancingEnabled.set(on), on);
		await settle();
	};

	// ---- 1. fewer calls, the same picture --------------------------------------------------
	const meshes = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let n = 0;
		g.traverse((o) => o.isMesh && n++);
		return n;
	});
	h.check(meshes >= 12, `the fixture refilled: ${meshes} kit meshes in the tree`);
	const on = await calls();
	const frameOn = await h.grabFrame(peer);
	await setOn(false);
	const off = await calls();
	const frameOff = await h.grabFrame(peer);
	if (process.env.SHOTS) {
		require('fs').writeFileSync(process.env.SHOTS + '/ki-on.png', frameOn);
		require('fs').writeFileSync(process.env.SHOTS + '/ki-off.png', frameOff);
	}
	await setOn(true);
	h.check(on.stats.candidates >= 12, `every refilled kit mesh is a candidate (${on.stats.candidates})`);
	h.check(off.worst - on.worst >= 10, `instancing draws the 12 pieces in fewer calls: ${off.worst} -> ${on.worst} (batches ${on.stats.batches}, members ${on.stats.members})`);
	const same = await h.frameDelta(page, frameOff, frameOn, 10);
	h.check(!same.error && same.fraction < 0.003, `the instanced frame is the same picture (${same.changed} of ${same.total} pixels differ by > 10)`);

	// ---- 2. the members are still the scene --------------------------------------------------
	const tree = await page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		let instanced = 0;
		g.traverse((o) => o.isInstancedMesh && instanced++);
		const payload = s.sessions.buildSessionPayload('kit');
		const stubs = payload.objects.filter((e) => JSON.stringify(e).includes('"packStub":true')).length;
		return { instanced, stubs, children: g.children.length };
	});
	h.check(tree.instanced === 0, 'no instanced mesh ever enters objectsGroup (the holders live at the scene root)');
	h.check(tree.stubs === 12, `a save still writes the 12 pieces as stubs (${tree.stubs})`);
	const wall3 = await h.projectPoint(page, [-1, 1.5, -3.85]);
	const picked = await page.evaluate(
		({ x, y }) => {
			const s = window.__stores;
			let cam, g;
			s.globalCamera.subscribe((v) => (cam = v))();
			s.objectsGroup.subscribe((v) => (g = v))();
			const ray = new s.THREE.Raycaster();
			ray.setFromCamera(new s.THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), cam);
			const hit = ray.intersectObject(g, true)[0];
			let root = hit?.object;
			while (root && root.parent !== g) root = root.parent;
			return root?.name ?? null;
		},
		wall3
	);
	h.check(picked === 'Wall 3', `a ray at a wall still hits that wall's own mesh (${picked})`);

	// ---- 3. selected / recoloured / hidden / moved -----------------------------------------
	const base = await calls();
	await page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const w = g.children.find((o) => o.name === 'Wall 2');
		s.selectedObjects.set([w.uuid]);
	});
	await page.waitForTimeout(400);
	const sel = await calls();
	h.check(sel.stats.members === base.stats.members - 1, `a SELECTED piece leaves its batch (members ${base.stats.members} -> ${sel.stats.members})`);
	await page.evaluate(() => window.__stores.selectedObjects.set([]));

	// recolour Wall 4 red: it must DRAW red (the template's material would draw it grey)
	const redAt = await h.centeredClip(peer, [1, 1.5, -3.85], 60);
	await page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const w = g.children.find((o) => o.name === 'Wall 4');
		w.traverse((n) => n.isMesh && n.material.color.setHex(0xff0000));
		s.kitInstancing.scanForKitInstancing();
	});
	await page.waitForTimeout(400);
	const red = await h.grabFrame(peer, redAt);
	const redStats = await page.evaluate(async (b64) => {
		const img = new Image();
		img.src = 'data:image/png;base64,' + b64;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const x = c.getContext('2d');
		x.drawImage(img, 0, 0);
		const d = x.getImageData(0, 0, c.width, c.height).data;
		let r = 0, gg = 0, b = 0;
		for (let i = 0; i < d.length; i += 4) {
			r += d[i];
			gg += d[i + 1];
			b += d[i + 2];
		}
		const n = d.length / 4;
		return { r: r / n, g: gg / n, b: b / n };
	}, red.toString('base64'));
	h.check(redStats.r > redStats.g * 1.6 && redStats.r > redStats.b * 1.6, `a RECOLOURED piece draws in its own colour, not its batch's (r ${redStats.r.toFixed(0)} g ${redStats.g.toFixed(0)} b ${redStats.b.toFixed(0)})`);
	const recol = await page.evaluate(() => window.__stores.kitInstancing.kitInstancingStats());
	h.check(recol.candidates === on.stats.candidates - 1, `the recoloured piece is no longer a candidate (${on.stats.candidates} -> ${recol.candidates})`);

	// hidden: Wall 5 hidden in the tree must not draw (its batch would otherwise still show it)
	const hideClip = await h.centeredClip(peer, [3, 1.5, -3.85], 60);
	const beforeHide = await h.grabFrame(peer, hideClip);
	await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		g.children.find((o) => o.name === 'Wall 5').visible = false;
	});
	await page.waitForTimeout(300);
	const afterHide = await h.grabFrame(peer, hideClip);
	const hid = await h.frameDelta(page, beforeHide, afterHide, 20);
	h.check(hid.fraction > 0.5, `a HIDDEN piece is not drawn by its batch (${(hid.fraction * 100).toFixed(0)} % of its patch changed)`);

	// moved: Wall 6 lifted 3 m — the old spot shows what is behind, the new one the wall
	const movedClip = await h.centeredClip(peer, [5, 1.5, -3.85], 60);
	const beforeMove = await h.grabFrame(peer, movedClip);
	await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		g.children.find((o) => o.name === 'Wall 6').position.y = 3.2;
	});
	await page.waitForTimeout(300);
	const afterMove = await h.grabFrame(peer, movedClip);
	const moved = await h.frameDelta(page, beforeMove, afterMove, 20);
	h.check(moved.fraction > 0.3, `a MOVED piece is drawn where it went (${(moved.fraction * 100).toFixed(0)} % of its old patch changed)`);

	// a cleared scene leaves no holder behind
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await page.waitForTimeout(800);
	const cleared = await page.evaluate(() => {
		const s = window.__stores;
		s.kitInstancing.scanForKitInstancing();
		let sc;
		s.globalScene.subscribe((v) => (sc = v))();
		return sc.getObjectByName('kit-instancing-root')?.children.length ?? 0;
	});
	h.check(cleared === 0, `a cleared scene drops every holder (${cleared} left)`);

	await h.finish(browser);
});
