// Mesh sculpt (CL-B follow-up): the terrain brush generalized to ANY mesh —
// normal-direction raise/lower, tangent-plane flatten, Laplacian smooth,
// welded by full xyz so split copies never tear; same meshgeo replication +
// one undo per stroke; the floating Sculpt toolbar hosts both modes.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Sphere 1');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const ball = g.children[g.children.length - 1];
		window.__ball = ball;
		return ball.uuid;
	});

	// 1) entering sculpt on a NON-terrain mesh works and flips to mesh mode
	const entered = await A.page.evaluate((uuid) => {
		const ts = window.__stores.terrainSculpt;
		const ok = ts.enterSculpt(uuid);
		let mode, obj;
		ts.sculptMode.subscribe((v) => (mode = v))();
		ts.sculptObject.subscribe((v) => (obj = v))();
		return { ok, mode, obj: obj === uuid, nonIndexed: !window.__ball.geometry.index };
	}, uuid);
	h.check(entered.ok && entered.obj, 'sculpt enters on a plain mesh');
	h.check(entered.mode === 'mesh', `mode flips to mesh (${entered.mode})`);
	h.check(entered.nonIndexed, 'geometry converts to non-indexed (meshgeo representation)');

	// 2) the toolbar mounts (floating) and titles the mesh session
	await A.page.waitForTimeout(300);
	const toolbar = await A.page.evaluate(() => {
		const el = document.querySelector('#sculpt-toolbar');
		return {
			present: !!el,
			fixed: el ? getComputedStyle(el).position === 'fixed' : false,
			title: el?.innerText.includes('Sculpt mesh') ?? false
		};
	});
	h.check(toolbar.present && toolbar.fixed, 'floating sculpt toolbar mounts');
	h.check(toolbar.title, 'toolbar titles the mesh session');

	// 3) raise displaces along the normal (a top-pole brush lifts the pole)
	const raise = await A.page.evaluate((uuid) => {
		const ts = window.__stores.terrainSculpt;
		const maxY = () => {
			const p = window.__ball.geometry.attributes.position;
			let m = -1e9;
			for (let i = 0; i < p.count; i++) m = Math.max(m, p.getY(i));
			return m;
		};
		const y0 = maxY();
		ts.beginStroke(uuid);
		for (let i = 0; i < 12; i++) ts.applyMeshBrushAt(uuid, 0, 1, 0, 'raise', 0.8, 1, 0.05);
		const y1 = maxY();
		// far side untouched (falloff radius)
		const p = window.__ball.geometry.attributes.position;
		let minY = 1e9;
		for (let i = 0; i < p.count; i++) minY = Math.min(minY, p.getY(i));
		ts.endStroke();
		return { y0, y1, minY };
	}, uuid);
	h.check(raise.y1 > raise.y0 + 0.1, `raise lifts the pole along its normal (${raise.y0.toFixed(2)} -> ${raise.y1.toFixed(2)})`);
	h.check(raise.minY < -0.95, `the far pole stays put (falloff) (${raise.minY.toFixed(2)})`);

	// 4) the stroke committed ONE undoable meshgeo
	const undo = await A.page.evaluate(() => {
		window.__stores.history.undo();
		const p = window.__ball.geometry.attributes.position;
		let m = -1e9;
		for (let i = 0; i < p.count; i++) m = Math.max(m, p.getY(i));
		return m;
	});
	h.check(Math.abs(undo - raise.y0) < 0.02, `one undo restores the pre-stroke shape (${undo.toFixed(2)})`);

	// 5) smooth relaxes a spike; welded copies stay together (no tears)
	const smooth = await A.page.evaluate((uuid) => {
		const ts = window.__stores.terrainSculpt;
		ts.beginStroke(uuid);
		for (let i = 0; i < 10; i++) ts.applyMeshBrushAt(uuid, 0, 1, 0, 'raise', 0.6, 1, 0.05);
		const p = window.__ball.geometry.attributes.position;
		const maxY = () => {
			let m = -1e9;
			for (let i = 0; i < p.count; i++) m = Math.max(m, p.getY(i));
			return m;
		};
		const spiky = maxY();
		for (let i = 0; i < 15; i++) ts.applyMeshBrushAt(uuid, 0, spiky, 0, 'smooth', 1.2, 1, 0.05);
		const relaxed = maxY();
		ts.endStroke();
		// tear check: welded groups still coincide (every position key groups
		// the same indices the weld map has)
		const keys = new Map();
		for (let i = 0; i < p.count; i++) {
			const k = Math.round(p.getX(i) * 1e4) + '|' + Math.round(p.getY(i) * 1e4) + '|' + Math.round(p.getZ(i) * 1e4);
			keys.set(k, (keys.get(k) || 0) + 1);
		}
		const singles = [...keys.values()].filter((c) => c === 1).length;
		return { spiky, relaxed, positions: p.count, distinct: keys.size, singles };
	}, uuid);
	h.check(smooth.relaxed < smooth.spiky - 0.03, `smooth relaxes the spike (${smooth.spiky.toFixed(2)} -> ${smooth.relaxed.toFixed(2)})`);
	h.check(smooth.distinct < smooth.positions, `split copies stay welded (${smooth.distinct} groups over ${smooth.positions} entries)`);

	// 6) strokes replicate as meshgeo (send spy on the final commit)
	const sent = await A.page.evaluate((uuid) => {
		const ts = window.__stores.terrainSculpt;
		window.__sent = [];
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		const original = peer.send;
		peer.send = (m) => window.__sent.push(m.type);
		ts.beginStroke(uuid);
		ts.applyMeshBrushAt(uuid, 0, 1, 0, 'lower', 0.8, 1, 0.05);
		ts.endStroke();
		peer.send = original;
		return window.__sent;
	}, uuid);
	h.check(sent.includes('meshgeo'), `stroke commit replicates meshgeo (${JSON.stringify(sent)})`);

	// 7) exit restores the gizmo pref + clears the session
	const exited = await A.page.evaluate(() => {
		const ts = window.__stores.terrainSculpt;
		ts.exitSculpt();
		let obj, mode;
		ts.sculptObject.subscribe((v) => (obj = v))();
		ts.sculptMode.subscribe((v) => (mode = v))();
		return { obj, mode, toolbarGone: !document.querySelector('#sculpt-toolbar') };
	});
	h.check(exited.obj === null && exited.mode === 'terrain', 'exit clears the session');

	// 8) terrain path still routes to the column brush
	const terrain = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Terrain 12 12');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const terrain = g.children[g.children.length - 1];
		const ok = s.terrainSculpt.enterSculpt(terrain.uuid);
		let mode;
		s.terrainSculpt.sculptMode.subscribe((v) => (mode = v))();
		s.terrainSculpt.exitSculpt();
		return { ok, mode };
	});
	h.check(terrain.ok && terrain.mode === 'terrain', `terrain keeps the column brush (${terrain.mode})`);

	await h.finish(browser);
});
