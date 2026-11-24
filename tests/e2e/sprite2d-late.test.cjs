// 64-2d — a LATE JOINER gets the 2D scene through the full-state sync (the GLTF object walk):
// the host opens Templates ▸ 2D scene alone (it applies at once), then a second page joins.
// Its own file and two pages only: a third headless page beside sprite2d.test.cjs's two was
// killed by the renderer on a loaded machine.
// Run: APP_URL=https://theprototype.app:5419/ npm run e2e -- sprite2d-late
const h = require('./helpers.cjs');

/** layers, the player sprite and the 2D camera, as one page sees them */
const scene2d = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const layers = g.children.filter((c) => c.userData?.layer2d).map((c) => ({ name: c.name, ...c.userData.layer2d }));
		const player = g.getObjectByName('Player');
		player?.geometry?.computeBoundingBox?.();
		const box = player?.geometry?.boundingBox;
		return {
			layers,
			player: player
				? { status: s.sprite2d.spriteStatus(player), image: !!player.material?.map?.image?.width, nearest: player.material?.map?.magFilter === 1003, size: box ? +(box.max.x - box.min.x).toFixed(3) : null, sheet: player.userData.sprite?.sheet ?? null }
				: null,
			follow: g.children.some((c) => c.userData?.camera?.kind === 'orthographic')
		};
	});

const tree = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const out = [];
		g.traverse((o) => o !== g && out.push(o.type + ':' + o.name + (o.material?.map ? '[map ' + (o.material.map.image?.width ?? '?') + ']' : '')));
		return out;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const consoleA = [];
	A.page.on('console', (m) => {
		const t = m.text();
		if (m.type() === 'error' || /gltf|export|Sending \d+ objects/i.test(t)) consoleA.push(m.type() + ': ' + t.slice(0, 200));
	});
	// alone, the template applies at once (and opens the 2D view here)
	const applied = await A.page.evaluate(async () => (await import('/src/lib/sprite2d/template2d.js')).open2dTemplate());
	h.check(applied === true, '1.0 (premise) alone, the 2D template applies at once');
	await h.eventually(() => scene2d(A.page), (r) => !!r.player?.image && r.layers.length === 4, '1.1 the host has the template: four layers, an imaged player', 60000);
	const host = await scene2d(A.page);

	const C = await h.setupPageQuiet(browser, 'C', [A]);
	await h.connect(C, A);
	const lateOk = (r) => !!r.player?.image && r.layers.length === 4;
	await h.eventually(() => scene2d(C.page), lateOk, '2.1 the late joiner receives the template: four layers and an imaged player', 90000);
	const late = await scene2d(C.page);
	if (!lateOk(late)) {
		console.log('  diag: A tree ' + JSON.stringify(await tree(A.page)));
		console.log('  diag: C tree ' + JSON.stringify(await tree(C.page)));
		console.log('  diag: A console ' + JSON.stringify(consoleA.slice(-15)));
	}
	const pars = (r) => JSON.stringify(r.layers.map((l) => l.parallax).sort());
	h.check(pars(late) === pars(host) && pars(late) === JSON.stringify([0, 0.3, 0.6, 1]), '2.2 the layers\' parallax rode the object sync (' + JSON.stringify(late.layers) + ')');
	h.check(!!late.player?.nearest && late.player.size === 1 && late.player.status.clip === 'walk' && late.player.status.playing, '2.3 the player arrives as a crisp 1 m walking sheet (the joiner re-derives sampler, plane and frame) (' + JSON.stringify(late.player) + ')');
	h.check(JSON.stringify(late.player?.sheet) === JSON.stringify(host.player.sheet), '2.4 the sprite document matches the host\'s');
	h.check(late.follow, '2.5 the 2D camera arrived too');

	await h.finish(browser);
});
