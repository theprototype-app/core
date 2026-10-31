// fix-agenttest items 7 + 8 — A BEHAVIOUR'S on.load SEES THE JOINER'S SCENE, AND A RE-RUN
// RELEASES WHAT THE LAST ONE REGISTERED.
// 7: a joiner reconciled its behaviours as soon as the graphs arrived, before the host's object
//    batch, so `this.findAll('Gem_*')` found [] and walk-over pickups worked only for the host
//    ("gem_touch: registered 0 gems"). on.load now waits for the scene to land.
// 8: re-running on.load (a source edit) left the previous run's kit.pickups.register entries in
//    place (their `off` was never called; only the journal entries were dropped).
// Counterfactual on v1.47.0: 1.2b (the guest's on.load ran on an empty scene), 2.2 (the stale
// Gem_2 stays registered) and 2.3 (the journal grows per edit) are red.
const h = require('./helpers.cjs');

const SRC = (pattern, tag) => `export default behaviour({
  name: 'gem_touch',
  on: {
    load() {
      const gems = this.findAll('${pattern}');
      for (const g of gems) kit.pickups.register({ id: g.uuid, radius: 1.2 });
      this.log('gem_touch ${tag}: registered ' + gems.length + ' gems');
    }
  }
});`;

const ids = (p) => p.page.evaluate(() => window.__stores.kit.kit.impls.pickups.extra.ids().slice().sort());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- the host builds: two gems + a behaviour that registers them in on.load ----------------
	const built = await A.page.evaluate((code) => {
		const S = window.__stores;
		const g = (() => { let v; S.objectsGroup.subscribe((x) => (v = x))(); return v; })();
		const gems = [];
		for (const [i, x] of [[1, 3], [2, -3]]) {
			S.commandsHandler.sceneCommand('/create Box 0.4 0.4 0.4');
			const gem = g.children[g.children.length - 1];
			gem.name = 'Gem_' + i;
			gem.position.set(x, 0.3, -2);
			gem.updateMatrixWorld(true);
			gems.push(gem.uuid);
		}
		S.nodesHandler.createFlowNode({ id: 'bhv-gems', type: 'behaviour', position: { x: 40, y: 40 }, data: { name: 'gem_touch', code } });
		return gems;
	}, SRC('Gem_*', 'v1'));
	await h.eventually(() => ids(A), (v) => v.length === 2, '1.0 the host registers its two gems in on.load', 40000);

	// ---- 7: a guest joins ------------------------------------------------------------------------
	// a dev page loads hundreds of modules, past the default 250-entry resource buffer the hold
	// below reads the GLTFLoader URL from
	const B = await h.setupPage(browser, 'B', { init: () => performance.setResourceTimingBufferSize(20000) });
	// every on.load run on the guest, as the behaviour logs it
	const guestRuns = [];
	B.page.on('console', (m) => {
		const hit = /gem_touch v1: registered (\d+) gems/.exec(m.text());
		if (hit) guestRuns.push(Number(hit[1]));
	});
	// THE RACE, made deterministic: the guest's GLTF parse of the host's objects is held 4 s (what a
	// heavy scene or a slow phone does), so the graphs — answered at once — land FIRST. Two bare
	// boxes otherwise parse within a frame and the guest's on.load happens to see them.
	const held = await B.page.evaluate(async () => {
		const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('three_addons_loaders_GLTFLoader__js.js'));
		if (!url) return false;
		const { GLTFLoader } = await import(/* @vite-ignore */ url);
		const parse = GLTFLoader.prototype.parse;
		GLTFLoader.prototype.parse = function (...args) {
			setTimeout(() => parse.apply(this, args), 4000);
		};
		return true;
	});
	h.check(held, "premise: the guest's GLTF parse is held (the dev server's GLTFLoader module was found)");
	await h.connect(B, A);
	const gemsOn = (p) =>
		p.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const found = [];
			g.traverse((o) => /^Gem_/.test(o.name) && found.push(o.name + '@' + (o.parent === g ? 'top' : o.parent?.name || o.parent?.type)));
			return found.sort();
		});
	await h.eventually(() => gemsOn(B), (v) => v.length === 2, '1.1 premise: the guest has the two gems', 30000);
	console.log('  guest gems: ' + JSON.stringify(await gemsOn(B)));
	await h.eventually(() => ids(B), (v) => JSON.stringify(v) === JSON.stringify([...built].sort()), '1.2 the GUEST registers both gems (on.load ran on the scene it joined)', 40000);
	h.check(guestRuns.length > 0 && guestRuns.every((n) => n === 2), `1.2b no on.load run on the guest saw an empty scene (runs found ${JSON.stringify(guestRuns)} gems)`);

	// the guest walks over Gem_1: play-ish (Interact) with its eye right above it
	await B.page.evaluate((uuid) => {
		const S = window.__stores;
		let g; S.objectsGroup.subscribe((v) => (g = v))();
		let cam; S.globalCamera.subscribe((v) => (cam = v))();
		const gem = g.getObjectByProperty('uuid', uuid);
		const p = gem.getWorldPosition(new gem.position.constructor());
		cam.position.set(p.x, p.y + 1.2, p.z);
		cam.updateMatrixWorld(true);
		S.editorMode.set('interact');
		window.__walkHold = setInterval(() => { cam.position.set(p.x, p.y + 1.2, p.z); cam.updateMatrixWorld(true); }, 50);
	}, built[0]);
	await h.eventually(
		() => A.page.evaluate((u) => !window.__stores.kit.kit.impls.pickups.available(u), built[0]),
		(taken) => taken === true,
		'1.3 the guest walking over a gem COLLECTS it (seen on the host)',
		20000
	);
	await B.page.evaluate(() => { clearInterval(window.__walkHold); window.__stores.editorMode.set('edit'); });

	// ---- 8: edit the behaviour so it registers only Gem_1 — the stale Gem_2 entry must go ----------
	const journal = (p) => p.page.evaluate(() => window.__stores.behaviours.behavioursDebug().registrations('bhv-gems').kit ?? 0);
	const before = { [A.id]: await journal(A), [B.id]: await journal(B) };
	for (const tag of ['v2', 'v3', 'v4']) {
		await A.page.evaluate((code) => window.__stores.nodesHandler.setNodeData('bhv-gems', { code }, 'scene'), SRC('Gem_1', tag));
		await h.eventually(
			() => Promise.all([A, B].map((p) => p.page.evaluate(() => window.__stores.findNodeAnyGraph((n) => n.id === 'bhv-gems')?.node?.data?.code ?? ''))),
			(codes) => codes.every((c) => c.includes(tag)),
			`2.0 edit ${tag} reached both peers`,
			20000
		);
		await A.page.waitForTimeout(1500);
	}
	for (const p of [A, B]) {
		await h.eventually(() => ids(p), (v) => JSON.stringify(v) === JSON.stringify([built[0]]), `2.2 ${p.id}: after the edits only Gem_1 is registered (the stale Gem_2 released)`, 20000);
		const now = await journal(p);
		h.check(now <= before[p.id], `2.3 ${p.id}: three edits do not grow the behaviour's journal (${before[p.id]} -> ${now})`);
	}

	const errs = [...(h.pageErrors ? h.pageErrors(A) : []), ...(h.pageErrors ? h.pageErrors(B) : [])];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
