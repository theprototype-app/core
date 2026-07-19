// T-2: terrain sculpting — a brush stroke raises welded columns (no tearing),
// commits ONE undoable meshgeo snapshot that replicates byte-identically, undo
// flattens on both peers, locks refuse a second sculptor, and terrain normals
// come out smooth (welded) rather than faceted.
const h = require('./helpers.cjs');

const heightsOf = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					if (!o) return resolve(null);
					const p = o.geometry.attributes.position;
					let maxY = -Infinity;
					let sum = 0;
					for (let i = 0; i < p.count; i++) {
						maxY = Math.max(maxY, p.getY(i));
						sum += Math.abs(p.getY(i));
					}
					resolve({ maxY: +maxY.toFixed(4), sum: +sum.toFixed(3), count: p.count });
				})();
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create Terrain 24 48');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return group.children[group.children.length - 1].uuid;
	});
	await B.page.waitForTimeout(1500);

	// enter sculpt: selects (= locks); peers see the lock and are refused
	const entered = await A.page.evaluate((uuid) => window.__stores.terrainSculpt.enterSculpt(uuid), uuid);
	h.check(entered === true, 'A enters sculpt mode');
	await h.eventually(
		() => B.page.evaluate((uuid) => new Promise((r) => window.__stores.lockedObjects.subscribe((l) => r(l.some((e) => e[1] === uuid)))()), uuid),
		(v) => v === true,
		'B sees the terrain locked while A sculpts'
	);
	const bEnter = await B.page.evaluate((uuid) => window.__stores.terrainSculpt.enterSculpt(uuid), uuid);
	h.check(bEnter === false, "B's sculpt attempt is refused (locked)");

	// one stroke: raise at the center, several brush applications, then commit
	await A.page.evaluate((uuid) => {
		const ts = window.__stores.terrainSculpt;
		ts.beginStroke(uuid);
		for (let i = 0; i < 30; i++) ts.applyBrushAt(uuid, 0, 0, 'raise', 4, 1, 0.033);
		ts.endStroke();
	}, uuid);

	const a = await heightsOf(A.page, uuid);
	h.check(a.maxY > 0.3, `the brush raised a hill (maxY = ${a.maxY})`);

	// welded columns never tear: every (x,z) column shares ONE height
	const torn = await A.page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const p = g.getObjectByProperty('uuid', uuid).geometry.attributes.position;
					const cols = new Map();
					for (let i = 0; i < p.count; i++) {
						const key = Math.round(p.getX(i) * 1e4) + '|' + Math.round(p.getZ(i) * 1e4);
						const y = p.getY(i);
						if (cols.has(key) && Math.abs(cols.get(key) - y) > 1e-6) return resolve(true);
						cols.set(key, y);
					}
					resolve(false);
				})();
			}),
		uuid
	);
	h.check(torn === false, 'welded columns share one height (no tearing)');

	// the committed snapshot replicated byte-identically to B
	await h.eventually(
		() => heightsOf(B.page, uuid),
		(b) => b && Math.abs(b.maxY - a.maxY) < 1e-4 && Math.abs(b.sum - a.sum) < 0.01,
		`stroke replicated to B (maxY ${a.maxY})`,
		15000
	);

	// terrain normals are SMOOTH: welded copies share the averaged normal
	const smooth = await B.page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const geo = g.getObjectByProperty('uuid', uuid).geometry;
					const p = geo.attributes.position;
					const n = geo.attributes.normal;
					const seen = new Map();
					for (let i = 0; i < p.count; i++) {
						const key = Math.round(p.getX(i) * 1e4) + '|' + Math.round(p.getY(i) * 1e4) + '|' + Math.round(p.getZ(i) * 1e4);
						const norm = [n.getX(i), n.getY(i), n.getZ(i)];
						if (seen.has(key)) {
							const prev = seen.get(key);
							if (Math.hypot(prev[0] - norm[0], prev[1] - norm[1], prev[2] - norm[2]) > 1e-4) return resolve(false);
						} else seen.set(key, norm);
					}
					resolve(true);
				})();
			}),
		uuid
	);
	h.check(smooth === true, 'terrain normals are welded-smooth on the receiver');

	// ONE undo flattens everything again, on both peers
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => heightsOf(A.page, uuid), (s) => s && s.maxY < 1e-4, 'one undo flattens the terrain on A');
	await h.eventually(() => heightsOf(B.page, uuid), (s) => s && s.maxY < 1e-4, 'undo replicated to B', 10000);

	// exit releases the sculpt session
	await A.page.evaluate(() => window.__stores.terrainSculpt.exitSculpt());
	const active = await A.page.evaluate(() => new Promise((r) => window.__stores.terrainSculpt.sculptObject.subscribe(r)()));
	h.check(active === null, 'exit clears the sculpt session');

	await h.finish(browser);
});
