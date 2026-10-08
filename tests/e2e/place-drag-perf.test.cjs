// Roadmap 39 P2/P3 perf proof: dragging a CACHED 200k-triangle pack item with the default
// preview budget (50k) keeps the frame time within 10 % of idle — over the budget the ghost is
// the box, and the budget is checked before anything is built. Run alone:
//
//   e2e-slot --exclusive -- env APP_URL=https://theprototype.app:5390/ node tests/e2e/place-drag-perf.test.cjs
const h = require('./helpers.cjs');

const SAMPLE_MS = 4000;

/** frame intervals over `ms`, plus the long tasks seen meanwhile (in the page) */
const sampleFrames = (page, ms) =>
	page.evaluate(
		(ms) =>
			new Promise((resolve) => {
				const gaps = [];
				let longTasks = 0;
				let longest = 0;
				let obs = null;
				try {
					obs = new PerformanceObserver((list) => {
						for (const e of list.getEntries()) {
							longTasks++;
							longest = Math.max(longest, e.duration);
						}
					});
					obs.observe({ entryTypes: ['longtask'] });
				} catch {}
				let last = performance.now();
				const end = last + ms;
				const tick = (t) => {
					gaps.push(t - last);
					last = t;
					if (t < end) requestAnimationFrame(tick);
					else {
						obs?.disconnect();
						gaps.shift();
						gaps.sort((a, b) => a - b);
						const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
						resolve({ frames: gaps.length, mean, p95: gaps[Math.floor(gaps.length * 0.95)], longTasks, longest });
					}
				};
				requestAnimationFrame(tick);
			}),
		ms
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// a ~200k-triangle model, built in the page and served as a pack item at a CDN url
	const glb = await A.page.evaluate(async () => {
		const s = window.__stores;
		const geo = new s.THREE.SphereGeometry(1, 318, 316);
		const mesh = new s.THREE.Mesh(geo, new s.THREE.MeshStandardMaterial());
		mesh.position.y = 1;
		const out = await new Promise((res, rej) => new s.GLTFExporterModule.GLTFExporter().parse(mesh, res, rej, { binary: true }));
		return { bytes: Array.from(new Uint8Array(out)), tris: geo.index.count / 3 };
	});
	h.check(glb.tris >= 200000, 'premise: the heavy item is ' + glb.tris + ' triangles');
	const body = Buffer.from(glb.bytes);
	await A.ctx.route(/cdn\.jsdelivr\.net\/gh\/theprototype-app\/packs@[^/]+\/(.*)$/, (route) => {
		const rel = new URL(route.request().url()).pathname.replace(/^.*packs@[^/]+\//, '');
		if (rel === 'index.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ name: 'perf', title: 'Perf', value: 'perf/default.json', attribution: 'perf/a.html', copyright: '', license: '', source: 'https://x' }]) });
		if (rel === 'perf/default.json')
			return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ name: 'Heavy', label: 'Heavy sphere', variants: { 'glTF-Binary': 'heavy.glb' }, size: [2, 2, 2], box: [-1, 0, -1, 1, 2, 1], tris: glb.tris, bytes: body.length }]) });
		if (rel === 'perf/Heavy/glTF-Binary/heavy.glb') return route.fulfill({ contentType: 'model/gltf-binary', body });
		return route.fulfill({ status: 404, body: '' });
	});
	await A.page.evaluate(async () => {
		await window.__stores.packs.loadPacks();
		window.__stores.placementPrefs.placementPreview.set('budget');
		window.__stores.placementPrefs.placementTriBudget.set(50000);
		window.__stores.explorerClose.set(false);
	});
	await A.page.waitForTimeout(500);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set('pack:perf'));
	const card = A.page.locator('.explorer-card', { hasText: /Heavy/ }).first();
	await card.waitFor({ timeout: 15000 });
	const spot = await A.page.evaluate(() => {
		let renderer;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const r = renderer.domElement.getBoundingClientRect();
		for (const [fx, fy] of [[0.5, 0.62], [0.42, 0.55], [0.6, 0.5], [0.35, 0.7]]) {
			const x = Math.round(r.left + r.width * fx);
			const y = Math.round(r.top + r.height * fy);
			if (document.elementFromPoint(x, y) === renderer.domElement) return { x, y };
		}
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	const box = await card.boundingBox();
	const pick = async () => {
		await A.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await A.page.mouse.down();
		await A.page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 6 });
		await A.page.mouse.move(spot.x, spot.y, { steps: 12 });
	};

	// warm: one drag downloads + parses the file (the "cached" state the proof is about)
	await pick();
	await h.eventually(
		() => A.page.evaluate(() => [...(() => { let i; window.__stores.packCache.packCacheIndex.subscribe((v) => (i = v))(); return i; })().keys()].some((u) => /heavy\.glb$/.test(u))),
		(x) => x,
		'premise: the heavy item is downloaded into the pack cache',
		30000
	);
	await h.eventually(() => A.page.evaluate(() => window.__stores.packRefs.peekPackTemplate([...(() => { let i; window.__stores.packCache.packCacheIndex.subscribe((v) => (i = v))(); return i; })().keys()].find((u) => /heavy\.glb$/.test(u))) !== null), (x) => x, 'premise: and decoded in memory', 30000);
	await A.page.keyboard.press('Escape');
	await A.page.mouse.up();
	await A.page.waitForTimeout(1500);

	// idle: the pointer resting over the viewport
	await A.page.mouse.move(spot.x, spot.y);
	await A.page.waitForTimeout(500);
	const idle = await sampleFrames(A.page, SAMPLE_MS);

	// dragging: the ghost follows the pointer every frame
	await pick();
	await A.page.waitForTimeout(500);
	const tier = await A.page.evaluate(() => window.__stores.placeDrag.ghostInfo().items[0]?.tier);
	h.check(tier === 'box', 'over the 50k budget the ghost is the BOX (got ' + tier + ')');
	let moving = true;
	const mover = (async () => {
		let a = 0;
		while (moving) {
			a += 0.12;
			await A.page.mouse.move(spot.x + Math.cos(a) * 80, spot.y + Math.sin(a) * 40);
			await new Promise((r) => setTimeout(r, 16));
		}
	})();
	const drag = await sampleFrames(A.page, SAMPLE_MS);
	moving = false;
	await mover;
	const placements = await A.page.evaluate(() => window.__stores.placeDrag.state()?.placements?.length ?? 0);
	h.check(placements === 1, 'premise: the drag was live over the viewport the whole time');
	await A.page.keyboard.press('Escape');
	await A.page.mouse.up();

	console.log('  idle: ' + JSON.stringify(idle));
	console.log('  drag: ' + JSON.stringify(drag));
	h.check(drag.mean <= idle.mean * 1.1, `frame time while dragging is within 10% of idle (mean ${drag.mean.toFixed(2)} vs ${idle.mean.toFixed(2)} ms)`);
	h.check(drag.longTasks === 0 || drag.longest < 50, 'no long task while dragging (' + drag.longTasks + ', longest ' + drag.longest.toFixed(0) + ' ms)');
	require('fs').mkdirSync('/home/deck/.code/lanes-30/after-39/39-place', { recursive: true });
	require('fs').writeFileSync('/home/deck/.code/lanes-30/after-39/39-place/perf-drag.json', JSON.stringify({ tris: glb.tris, budget: 50000, tier, idle, drag, at: new Date().toISOString() }, null, 1));

	await h.finish(browser);
});
