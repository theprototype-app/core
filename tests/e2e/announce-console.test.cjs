// 78 F14 — ANNOUNCE IN EDIT GOES TO A DEBUG CONSOLE. An Announce node is a game's banner
// ("Ring 2 reached"); while the author was still building, every pulse flashed it FULL-SCREEN
// over the floating windows (owner UX report). Now:
//   1. In Edit an Announce pulse draws NO banner; it lands in the debug console — the
//      Debugger panel's Console list, with its time and the node that announced — and in the
//      page log the AI assistant / agents read (logs, status).
//   2. The console row names its source node; pressing it focuses that node in the Debugger.
//   3. In Play the same pulse draws the full-screen banner (and is still written down).
//   4. A module's api.announce in Edit takes the same route (console, no banner), named as a
//      module line.
//
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/announce-console.test.cjs
const h = require('./helpers.cjs');

const NOW = () => (Date.now() % 86400000) / 1000;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([{ id: 'ann78', name: 'Announce test', version: '1.0.0', description: 'api.announce in Edit', register(api) { window.__api = api; } }]);
		const N = (id, type, data) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...data } });
		const nodes = [
			N('aKey', 'keypress', { code: 'KeyJ', edge: 'down', pulse: 0.3 }),
			N('aCount', 'counter', { op: 'up', step: 1 }),
			{ id: 'aAnn', type: 'announce', position: { x: 300, y: 0 }, data: { label: 'Ring banner', text: 'Ring {v} reached', sub: 'keep going', seconds: 2 } }
		];
		const edges = [
			{ id: 'e1', source: 'aKey', target: 'aCount', targetHandle: 'pulse' },
			{ id: 'e2', source: 'aKey', target: 'aAnn', targetHandle: 'trigger' },
			{ id: 'e3', source: 'aCount', target: 'aAnn', targetHandle: 'value' }
		];
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
		await new Promise((r) => setTimeout(r, 900)); // past the nodes' first-seen
	});

	const pulse = async () => {
		await page.evaluate((t) => window.__stores.flowRuntime.applyNodeTrigger('aKey', t, false), NOW());
		await page.waitForTimeout(400);
	};
	const state = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const ga = s.gameKit.gameAnnounce;
			let log = [];
			ga.announceLog?.subscribe((v) => (log = v))();
			const diag = s.diagnostics.entries().filter((e) => e.scope === 'announce');
			const rows = [...document.querySelectorAll('#debug-console [data-announce]')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
			return {
				banner: document.querySelector('#game-announce')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
				log: log.map((e) => ({ text: e.text, sub: e.sub, nodeId: e.source?.nodeId ?? null, label: e.source?.label ?? null, kind: e.source?.kind ?? null, shown: e.shown, at: e.at })),
				diag: diag.map((e) => e.message + (e.data ? ' ' + e.data : '')),
				rows
			};
		});

	console.log('\n=== 1. Edit: no banner, a console line ===');
	await pulse();
	const e1 = await state();
	console.log(JSON.stringify(e1));
	h.check(e1.banner === null, `in Edit an Announce pulse draws NO full-screen banner (${JSON.stringify(e1.banner)})`);
	const first = e1.log[e1.log.length - 1];
	h.check(!!first && first.text === 'Ring 1 reached' && first.sub === 'keep going', `it lands in the debug console with its text ({v} filled) (${JSON.stringify(first)})`);
	h.check(!!first && first.nodeId === 'aAnn' && first.label === 'Ring banner', `... naming its source node (${first?.nodeId} / ${first?.label})`);
	h.check(!!first && Math.abs(first.at - Date.now()) < 60000 && first.shown === 'console', `... with its time, shown in the console, not as a banner (${first?.shown})`);
	h.check(e1.diag.some((l) => /Ring 1 reached/.test(l) && /Ring banner/.test(l)), `the page log the AI assistant reads has the line and the node (${JSON.stringify(e1.diag)})`);

	console.log('\n=== 2. the Debugger panel shows it ===');
	await page.evaluate(() => window.__stores.flowDebug.setDebugOpen(true));
	// the panel is a lazy import: on a cold dev server its first mount takes seconds
	await page.waitForSelector('#debug-console', { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(300);
	const e2 = await state();
	h.check(e2.rows.some((r) => /Ring 1 reached/.test(r) && /Ring banner/.test(r) && /\d\d:\d\d:\d\d/.test(r)), `the Debugger's Console lists it with the time and the node (${JSON.stringify(e2.rows)})`);
	await page.evaluate(() => document.querySelector('#debug-console [data-announce] .debug-node')?.click());
	await page.waitForTimeout(300);
	const focus = await page.evaluate(() => {
		let f;
		window.__stores.flowDebug.debugFocus.subscribe((v) => (f = v))();
		return f;
	});
	h.check(focus === 'aAnn', `pressing the row focuses the node that announced (${focus})`);

	console.log('\n=== 3. Play: the banner ===');
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(600);
	await pulse();
	const p3 = await state();
	h.check(/Ring 2 reached/.test(p3.banner ?? ''), `in Play the pulse draws the full-screen banner (${JSON.stringify(p3.banner)})`);
	const last = p3.log[p3.log.length - 1];
	h.check(last?.text === 'Ring 2 reached' && last?.shown === 'banner', `... and is written down as shown on screen (${JSON.stringify(last)})`);
	await h.leavePlay(A);
	await page.waitForTimeout(2500);

	console.log('\n=== 4. a module announce in Edit ===');
	await page.evaluate(() => window.__api.announce('Wave 2', { sub: 'from a module' }));
	await page.waitForTimeout(300);
	const m4 = await state();
	const mod = m4.log[m4.log.length - 1];
	h.check(m4.banner === null, `a module's announce in Edit draws no banner either (${JSON.stringify(m4.banner)})`);
	h.check(mod?.text === 'Wave 2' && mod?.kind === 'module' && mod?.shown === 'console', `... and is a console line from a module (${JSON.stringify(mod)})`);

	h.check(h.pageErrors(A).length === 0, 'no page error');
	await h.finish(browser);
});
