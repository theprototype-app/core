#!/usr/bin/env node
// @ts-nocheck — a Playwright driver; the page-side code runs in the app, not under checkJs
// 102b-flows — THE MANY-TARGET SELECTOR'S COST GATE: "a 200-object set adds at most 1 ms per tick".
//
// 200 boxes, three scenarios over the SAME scene, the flow tick pumped synchronously
// (flowRuntime.pumpFlowTick, the XR pump) on a monotonic synthetic clock:
//   none   — no flow at all (the floor)
//   single — 200 Spin -> Object Selector (one object each) chains: how a scene does it today
//   tag    — ONE Spin -> ONE Object Selector picking "every object tagged bench" (all 200)
// A click is applied every 15 ticks on a 4th scenario's trigger so the sensor path is measured too
// (tag+click: an On Click wired to the set, a Fired Object reading it).
//
//   LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' APP_URL=https://theprototype.app:7092/ \
//     e2e-slot --exclusive --dev <dir> 7092 -- node scripts/selector-cost-bench.cjs [--out file.json]
//
// Gate: median(tag) - median(none) <= 1 ms/tick (and tag+click likewise). Rounds alternate scenarios;
// medians are reported. Measure a PROD build (dev-mode module wrappers inflate a tick several fold).
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.APP_URL || 'https://localhost:5491/';
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i !== -1 ? process.argv[i + 1] : fallback;
};
const OUT = arg('--out', null);
const COUNT = Number(arg('--objects', '200'));
const TICKS = Number(arg('--ticks', '600'));
const ROUNDS = Number(arg('--rounds', '7'));
const GATE_MS = 1;

(async () => {
	const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=default'] });
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	const page = await ctx.newPage();
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
	await page.waitForFunction(() => window.__stores && !!window.__stores.flowRuntime && !!window.__stores.moduleSDK, null, { timeout: 120000 });
	await page.waitForTimeout(3000);
	const boxes = await page.evaluate(async (count) => {
		const s = window.__stores;
		for (let i = 0; i < count; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 3000));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const out = [];
		for (const c of group.children) if (c.isMesh) (c.userData.tags = ['bench']), out.push(c.uuid);
		return out;
	}, COUNT);
	console.log(`scene: ${boxes.length} boxes tagged "bench"`);

	const scenarios = ['none', 'single', 'tag', 'tag+click'];
	/** @type {Record<string, number[]>} */
	const samples = Object.fromEntries(scenarios.map((s) => [s, []]));
	for (let round = 0; round < ROUNDS; round++) {
		for (const scenario of scenarios) {
			const ms = await page.evaluate(
				async ({ scenario, ticks, boxes }) => {
					const s = window.__stores;
					const fr = s.flowRuntime;
					const nodes = [];
					const edges = [];
					const N = (id, type, data = {}) => nodes.push({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });
					const E = (source, target, targetHandle) =>
						edges.push({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
					if (scenario === 'single')
						boxes.forEach((u, i) => {
							N('s' + i, 'spin', { axis: 'y', speed: 1 });
							N('o' + i, 'objectselector', { selected: u });
							E('s' + i, 'o' + i);
						});
					if (scenario === 'tag' || scenario === 'tag+click') {
						N('s', 'spin', { axis: 'y', speed: 1 });
						N('o', 'objectselector', { pick: 'tag', match: 'bench' });
						E('s', 'o');
					}
					if (scenario === 'tag+click') {
						N('c', 'onclick');
						N('f', 'firedobject');
						E('c', 'o');
						E('c', 'f', 'trigger');
					}
					s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
					s.flowNodes.set(nodes);
					s.flowEdges.set(edges);
					// the resolver chunk loads on the first set selector (async); let it land before timing
					await new Promise((r) => setTimeout(r, 400));
					let now = Math.max(performance.now(), window.__benchNow ?? 0);
					for (let i = 0; i < 60; i++) fr.pumpFlowTick((now += 16.7));
					const t0 = performance.now();
					for (let i = 0; i < ticks; i++) {
						now += 16.7;
						if (scenario === 'tag+click' && i % 15 === 0) fr.fireObjectClick(boxes[i % boxes.length]);
						fr.pumpFlowTick(now);
					}
					const per = (performance.now() - t0) / ticks;
					window.__benchNow = now;
					return per;
				},
				{ scenario, ticks: TICKS, boxes }
			);
			samples[scenario].push(ms);
			await page.waitForTimeout(300);
		}
	}
	const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
	const result = { url: URL, objects: boxes.length, ticks: TICKS, rounds: ROUNDS, gateMs: GATE_MS };
	for (const scenario of scenarios) {
		result[scenario] = { medianMs: Number(median(samples[scenario]).toFixed(4)), samples: samples[scenario].map((x) => Number(x.toFixed(4))) };
		console.log(`${scenario.padEnd(10)} median ${result[scenario].medianMs} ms/tick  (${result[scenario].samples.join(', ')})`);
	}
	const spun = await page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return u.filter((x) => Math.abs(g.getObjectByProperty('uuid', x)?.rotation?.y ?? 0) > 1e-6).length;
	}, boxes);
	result.spunByLastScenario = spun;
	result.tagOverNone = Number((result.tag.medianMs - result.none.medianMs).toFixed(4));
	result.tagClickOverNone = Number((result['tag+click'].medianMs - result.none.medianMs).toFixed(4));
	result.pass = result.tagOverNone <= GATE_MS && result.tagClickOverNone <= GATE_MS;
	console.log(`tag - none = ${result.tagOverNone} ms, tag+click - none = ${result.tagClickOverNone} ms (gate ${GATE_MS} ms): ${result.pass ? 'PASS' : 'FAIL'}; ${spun}/${boxes.length} boxes turned`);
	if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
	await browser.close();
	process.exit(result.pass ? 0 : 1);
})().catch((error) => {
	console.error(error);
	process.exit(2);
});
