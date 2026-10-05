#!/usr/bin/env node
// @ts-nocheck — a probe driver (page.evaluate callbacks run in the browser)
// 36-fb-water F19 — THE PERFORMANCE PROTOCOL for the water / sim scenes this lane changed
// (31 rules: per scene after 10 s, draw calls + triangles per display frame, geometries /
// textures / texture MB, lights + shadow casters, p50/p95 frame ms under CDP CPU x4; run under
// `e2e-slot --exclusive`). Shares the in-page probe with perf-games/perf-levels (perfProbe.cjs).
//
//   APP_URL=... node scripts/perf-water.cjs --dir <scenes repo>/examples [--only pool-party]
//        [--seconds 6] [--out <dir>] [--label after]
//
// Two tiers per scene, each on a FRESH page:
//   desktop — the scene's own look (post stack + AO), water quality High, the simulation running
//             (sims start on load where the scene says so; otherwise P is pressed here);
//   quest   — the headset analogue: post off, Shaded, shadows off, water quality Low (the
//             Quest tier: no pre-pass, points-tier fluid). The Quest budget applies to it:
//             <= 150 draw calls, <= 300k triangles.
// Extra scenes: `pour` (a Water tank with a pour emitter + a spout, both at their defaults) and
// `spill` (the Fluid tank toy with the Honey tank tipped over) — the F16/F17 costs.
const path = require('path');
const fs = require('fs');
const h = require('../tests/e2e/helpers.cjs');
const { startRecorder, readScene } = require('./perfProbe.cjs');

const argv = process.argv.slice(2);
const arg = (/** @type {string} */ name, /** @type {any} */ fallback) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const DIR = arg('dir', path.resolve(__dirname, '../../scenes-lane-36-fb-water/examples'));
const ONLY = String(arg('only', '')).split(',').filter(Boolean);
const SECONDS = Number(arg('seconds', '6'));
const SETTLE = Number(arg('settle', '10'));
const OUT = arg('out', '/home/deck/.code/lanes-30/after-36/36-fb-water/perf');
const LABEL = arg('label', 'run');
const SCENES = ['pool-party', 'aquarium', 'island-ocean', 'jelly-room', 'fluid-tank-toy', 'pour', 'spill'];
const BUDGET = { calls: 150, triangles: 300000 };

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	/** @type {any[]} */
	const rows = [];
	for (const slug of SCENES.filter((s) => !ONLY.length || ONLY.includes(s))) {
		for (const tier of ['desktop', 'quest']) {
			const P = await h.setupPage(browser, slug + '-' + tier, {
				context: { viewport: { width: 1280, height: 720 } },
				storage: { 'water:quality': tier === 'quest' ? 'low' : 'high' }
			});
			const page = P.page;
			await page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
			const file = path.join(DIR, slug === 'pour' ? 'pool-party' : slug === 'spill' ? 'fluid-tank-toy' : slug, 'scene.tpscene');
			const bytes = Array.from(fs.readFileSync(file));
			await page.evaluate(async (arr) => {
				const s = window.__stores;
				const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
				await s.sessions.applySession(payload, { backup: false });
				s.objectActions.deselectObject?.();
			}, bytes);
			await page.waitForTimeout(3000);
			if (slug === 'pour')
				await page.evaluate(() => {
					const st = window.__stores;
					const water = st.addObjects.buildAddChildren(() => [0, 0, 6]).find((g) => g.label === 'Water');
					water.children.find((c) => c.label === 'Water tank').action();
					let g;
					st.objectsGroup.subscribe((v) => (g = v))();
					const tank = g.children[g.children.length - 1];
					tank.position.set(0, 0.6, 6);
					st.waterActions.setObjectPour(tank.uuid, {});
					st.addObjects.buildAddChildren(() => [-3, 0, 6]).find((x) => x.label === 'Water').children.find((c) => c.label === 'Pour').action();
					st.objectActions.deselectObject?.();
				});
			if (tier === 'quest')
				await page.evaluate(() => {
					const s = window.__stores;
					s.viewportOverrides.setRenderLayer('post', false);
					s.viewMode.set('shaded');
					s.lightParams.shadowQuality.set('off');
				});
			const running = await page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)()));
			if (!running) await page.evaluate(() => window.__stores.physics.toggleSimulation());
			if (slug === 'spill')
				await page.evaluate(() => {
					let g;
					window.__stores.objectsGroup.subscribe((v) => (g = v))();
					const t = g.getObjectByName('Honey tank');
					t.rotation.z = -1.9;
					t.updateMatrixWorld(true);
				});
			const cdp = await page.context().newCDPSession(page);
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await page.waitForTimeout(SETTLE * 1000);
			await page.evaluate(startRecorder);
			await page.waitForTimeout(SECONDS * 1000);
			const r = await page.evaluate(readScene);
			const extra = await page.evaluate(() => ({
				drops: window.__stores.sim.totalDropCount?.() ?? null,
				fluid: window.__stores.sim.fluidDebug().map((t) => t.count),
				water: window.__stores.waterRuntime.waterDebug?.().drawCalls ?? null
			}));
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
			rows.push({ slug, tier, ...r, ...extra });
			console.log(`${slug.padEnd(15)} ${tier.padEnd(7)} calls ${String(r.medianCalls).padStart(4)} (max ${r.maxCalls})  tris ${r.medianTriangles}  p50 ${r.p50?.toFixed(1)} p95 ${r.p95?.toFixed(1)} ms  geo ${r.geometries} tex ${r.textures} (${r.textureMB} MB)  lights ${r.lights}/${r.castLights}  drops ${extra.drops}`);
			await P.ctx.close();
		}
	}
	const md = [
		`# Perf protocol — 36-fb-water (${LABEL}, ${new Date().toISOString().slice(0, 16)})`,
		'',
		`CPU x4, 1280x720, ${SETTLE} s settle + ${SECONDS} s recorded, simulation running. calls / triangles = median per display frame (every render pass summed). Quest budget ${BUDGET.calls} calls / ${BUDGET.triangles / 1000}k triangles applies to the quest rows.`,
		'',
		'| scene | tier | calls (max) | triangles | p50 / p95 ms | geometries | textures (MB) | lights / shadow | drops | fluid particles | budget |',
		'|---|---|---|---|---|---|---|---|---|---|---|',
		...rows.map(
			(r) =>
				`| ${r.slug} | ${r.tier} | ${r.medianCalls} (${r.maxCalls}) | ${r.medianTriangles} | ${r.p50?.toFixed(1)} / ${r.p95?.toFixed(1)} | ${r.geometries} | ${r.textures} (${r.textureMB}) | ${r.lights} / ${r.castLights} | ${r.drops ?? ''} | ${r.fluid.join(' + ') || ''} | ${r.tier === 'quest' ? (r.medianCalls <= BUDGET.calls && r.medianTriangles <= BUDGET.triangles ? 'OK' : '**OVER**') : ''} |`
		),
		''
	].join('\n');
	fs.writeFileSync(path.join(OUT, `perf-${LABEL}.md`), md);
	fs.writeFileSync(path.join(OUT, `perf-${LABEL}.json`), JSON.stringify(rows, null, 1));
	console.log(md);
	await h.finish(browser);
});
