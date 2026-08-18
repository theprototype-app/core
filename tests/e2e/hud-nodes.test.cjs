// A3 — the core HUD flow-node group.
//
// The most valuable claim in the plan is that THE SCORE DISPLAY IS `counter -> hudtext`
// AND NEEDS NO NEW CODE, so section 1 proves exactly that with nothing but shipped nodes.
// The rest: a button pulses a Counter on two peers from ONE stamp, a timer reads the same
// remaining value on both, and the runtime store writes at most ~10Hz and only on change.
//
// Run: $env:APP_URL='https://localhost:5201/'; PEER_CONFIG=...; npm run e2e -- hud-nodes
const h = require('./helpers.cjs');

const HUD = () => {
	window.__stores.hudDocs.setHudDocFor('scene', {
		screens: [
			{
				id: 'main',
				name: 'Main',
				elements: [
					{ id: 'score', kind: 'text', label: '', anchor: 'top-right', x: 20, y: 20, w: 180, h: 26 },
					{ id: 'health', kind: 'bar', label: '', anchor: 'bottom-center', x: 0, y: 40, w: 220, h: 16 },
					{ id: 'clock', kind: 'timer', label: '', anchor: 'top-center', x: 0, y: 20, w: 120, h: 26 },
					{ id: 'board', kind: 'list', label: '', anchor: 'middle-left', x: 20, y: 0, w: 180, h: 120 },
					{ id: 'go', kind: 'button', label: 'Go', anchor: 'center', x: 0, y: 80, w: 120, h: 34 }
				]
			},
			{ id: 'menu', name: 'Menu', elements: [{ id: 'title', kind: 'text', label: 'PAUSED', anchor: 'center' }] }
		],
		active: 'main'
	});
};

// Setting flowNodes/flowEdges directly does NOT broadcast — only the nodesHandler
// entry points do. Without this push the peer eventually catches up through nodesync's
// periodic hash compare, which is slow and racy: the first version of this suite pulsed
// a Counter before B had the graph and read 2 where A read 3.
const pushGraph = async (from, to, expectIds) => {
	await from.page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), to.id);
	for (let i = 0; i < 40; i++) {
		const have = await to.page.evaluate(() => {
			let nodes, edges;
			window.__stores.flowNodes.subscribe((v) => (nodes = v))();
			window.__stores.flowEdges.subscribe((v) => (edges = v))();
			return { ids: nodes.map((n) => n.id), edges: edges.length };
		});
		if (expectIds.every((id) => have.ids.includes(id))) return have;
		await to.page.waitForTimeout(250);
	}
	return null;
};

const elText = (peer, id) =>
	peer.page.evaluate(
		(elId) => document.querySelector(`[data-hud-id="${elId}"] .hud-el`)?.textContent?.trim() ?? null,
		id
	);

h.run(async () => {
	// GPU args, like the pixel suites: a software-rendered headless page runs at ~2.5fps
	// (measured), and a ~10Hz throttle cannot engage below that — it would read as
	// "throttled" while doing nothing at all.
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });
	await h.connect(A, B);
	await A.page.evaluate(HUD);
	await A.page.waitForTimeout(1400);

	// ---- 1. THE SCORE: counter -> hudtext, with no new code -----------------
	// On Click pulses a Counter (both shipped); the Counter's number feeds hudtext's
	// `value` through resolveInputs (shipped); hudtext's `format` renders it. The only new
	// thing in that chain is the hudtext node itself.
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'gems', type: 'counter', position: { x: 220, y: 0 }, data: { type: 'counter', step: 1, op: 'up' } },
			{ id: 'txt', type: 'hudtext', position: { x: 440, y: 0 }, data: { type: 'hudtext', element: 'score', format: 'Gems: {v}', decimals: 0 } }
		]);
		s.flowEdges.set([
			{ id: 'e1', source: 'click', target: 'gems', targetHandle: 'pulse' },
			{ id: 'e2', source: 'gems', target: 'txt', targetHandle: 'value' }
		]);
	});
	await A.page.waitForTimeout(1200);
	const synced1 = await pushGraph(A, B, ['click', 'gems', 'txt']);
	h.check(!!synced1, `premise: the peer holds the graph before anything is pulsed (${JSON.stringify(synced1)})`);
	const zero = await elText(A, 'score');
	h.check(zero === 'Gems: 0', `the score renders through the format string (${JSON.stringify(zero)})`);

	// pulse the counter three times, the way a game does
	await A.page.evaluate(async () => {
		for (let i = 0; i < 3; i++) {
			window.__stores.flowRuntime.applyNodeTrigger('click', (Date.now() % 86400000) / 1000, true);
			await new Promise((r) => setTimeout(r, 200));
		}
	});
	await A.page.waitForTimeout(900);
	const three = await elText(A, 'score');
	h.check(three === 'Gems: 3', `and counts up with NO node written for it (${JSON.stringify(three)})`);

	// decimals + a format with no {v} placeholder still behave
	const formats = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.nodesHandler.setNodeData('txt', { format: '{v} gems', decimals: 2 });
		await new Promise((r) => setTimeout(r, 700));
		const withDecimals = document.querySelector('[data-hud-id="score"] .hud-el')?.textContent?.trim();
		s.nodesHandler.setNodeData('txt', { format: 'STATIC', decimals: 0 });
		await new Promise((r) => setTimeout(r, 700));
		const noPlaceholder = document.querySelector('[data-hud-id="score"] .hud-el')?.textContent?.trim();
		s.nodesHandler.setNodeData('txt', { format: 'Gems: {v}', decimals: 0 });
		await new Promise((r) => setTimeout(r, 700));
		return { withDecimals, noPlaceholder };
	});
	h.check(formats.withDecimals === '3.00 gems', `decimals apply (${JSON.stringify(formats.withDecimals)})`);
	h.check(
		formats.noPlaceholder === 'STATIC',
		`a format with no {v} is used as-is (${JSON.stringify(formats.noPlaceholder)})`
	);

	// the peer derives the same string with no HUD message of its own
	await A.page.waitForTimeout(900);
	const onPeer = await elText(B, 'score');
	h.check(
		onPeer === 'Gems: 3',
		`the PEER computes the same text from the replicated graph — no runtime message (${JSON.stringify(onPeer)})`
	);

	// ---- 2. a BAR reads min/max/value ---------------------------------------
	const bar = await A.page.evaluate(async () => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'hp', type: 'number', position: { x: 0, y: 200 }, data: { type: 'number', value: 30 } },
			{ id: 'bar', type: 'hudbar', position: { x: 220, y: 200 }, data: { type: 'hudbar', element: 'health', min: 0, max: 60 } }
		]);
		s.flowEdges.set([...edges, { id: 'e3', source: 'hp', target: 'bar', targetHandle: 'value' }]);
		await new Promise((r) => setTimeout(r, 1000));
		const fill = document.querySelector('[data-hud-id="health"] .hud-bar-fill');
		const track = document.querySelector('[data-hud-id="health"] .hud-el');
		return {
			pct: fill && track ? Math.round((fill.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100) : -1
		};
	});
	h.check(bar.pct >= 48 && bar.pct <= 52, `a bar fills to (value-min)/(max-min) — 30 of 0..60 (${bar.pct}%)`);

	// ---- 3. a BUTTON pulses a Counter on BOTH peers from ONE stamp ----------
	await A.page.evaluate(async () => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'btn', type: 'hudbutton', position: { x: 0, y: 340 }, data: { type: 'hudbutton', element: 'go' } },
			{ id: 'presses', type: 'counter', position: { x: 220, y: 340 }, data: { type: 'counter', step: 1, op: 'up' } }
		]);
		s.flowEdges.set([...edges, { id: 'e4', source: 'btn', target: 'presses', targetHandle: 'pulse' }]);
	});
	await A.page.waitForTimeout(900);
	const synced3 = await pushGraph(A, B, ['btn', 'presses']);
	h.check(!!synced3, `premise: the peer holds the button graph (${JSON.stringify(synced3)})`);

	const presses = (peer) =>
		peer.page.evaluate(() => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			return { count: t?.presses?.count ?? 0, stamp: t?.btn?.lastT ?? null };
		});
	const before = await Promise.all([presses(A), presses(B)]);
	// a REAL click on the rendered button
	const spot = await A.page.evaluate(() => {
		const btn = document.querySelector('[data-hud-id="go"] button');
		const r = btn.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	const under = await A.page.evaluate(
		(pt) => document.elementFromPoint(pt.x, pt.y)?.tagName,
		spot
	);
	h.check(under === 'BUTTON', `premise: the click lands on the HUD button (${under})`);
	await A.page.mouse.click(spot.x, spot.y);
	await A.page.waitForTimeout(1400);
	const after = await Promise.all([presses(A), presses(B)]);
	h.check(
		after[0].count === before[0].count + 1,
		`a real press pulses the Counter on the presser (${before[0].count} -> ${after[0].count})`
	);
	h.check(
		after[1].count === before[1].count + 1,
		`and on the PEER — the press rides the existing nodetrigger path (${before[1].count} -> ${after[1].count})`
	);
	h.check(
		after[0].stamp !== null && after[0].stamp === after[1].stamp,
		`from ONE shared stamp (${after[0].stamp} / ${after[1].stamp})`
	);

	// ---- 4. a TIMER reads the same remaining value on both peers ------------
	await A.page.evaluate(async () => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'tstart', type: 'onclick', position: { x: 0, y: 480 }, data: { type: 'onclick', pulse: 0.3 } },
			{
				id: 'timer',
				type: 'hudtimer',
				position: { x: 220, y: 480 },
				data: { type: 'hudtimer', element: 'clock', duration: 30, format: '{v}s', decimals: 0, autostart: false }
			}
		]);
		s.flowEdges.set([...edges, { id: 'e5', source: 'tstart', target: 'timer', targetHandle: 'start' }]);
		await new Promise((r) => setTimeout(r, 600));
	});
	const synced4 = await pushGraph(A, B, ['tstart', 'timer']);
	h.check(!!synced4, `premise: the peer holds the timer graph (${JSON.stringify(synced4)})`);
	// start it from ONE peer with a real SYNCED stamp, the way the runtime does — the
	// timer then derives its remaining seconds from that shared number on every peer
	await A.page.evaluate(() =>
		window.__stores.flowRuntime.applyNodeTrigger('tstart', (Date.now() % 86400000) / 1000, true)
	);
	await A.page.waitForTimeout(1600);
	const timers = await Promise.all([elText(A, 'clock'), elText(B, 'clock')]);
	const nums = timers.map((t) => Number(String(t ?? '').replace(/[^0-9.]/g, '')));
	h.check(
		timers[0] !== null && /s$/.test(String(timers[0])),
		`the timer renders through its format (${JSON.stringify(timers[0])})`
	);
	h.check(
		nums[0] > 0 && nums[0] <= 30,
		`counting DOWN from the duration (${nums[0]} of 30)`
	);
	h.check(
		Math.abs(nums[0] - nums[1]) <= 1,
		`and both peers read the same remaining time from the shared stamp (${nums[0]} / ${nums[1]})`
	);

	// ---- 5. a LIST is written into by id, never flowed ----------------------
	const list = await A.page.evaluate(async () => {
		const s = window.__stores;
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'lb', type: 'hudlist', position: { x: 440, y: 200 }, data: { type: 'hudlist', element: 'board', title: 'Scores', rows: 3 } }
		]);
		await new Promise((r) => setTimeout(r, 900));
		// a module pushes rows; there is no array socket to flow them through
		s.flowRuntime.setHudRows('board', ['alice 12', 'bob 9', 'carol 7', 'dave 2']);
		await new Promise((r) => setTimeout(r, 900));
		const el = document.querySelector('[data-hud-id="board"]');
		return {
			title: el?.querySelector('.hud-list-title')?.textContent?.trim(),
			rows: [...(el?.querySelectorAll('.hud-list-row') ?? [])].map((r) => r.textContent?.trim())
		};
	});
	h.check(list.title === 'Scores', `the list renders its title (${JSON.stringify(list.title)})`);
	h.check(
		list.rows.length === 3 && list.rows[0] === 'alice 12',
		`and the pushed rows, capped at the node's row count (${JSON.stringify(list.rows)})`
	);

	// ---- 6. a SCREEN node shows/hides/toggles, LOCALLY per peer -------------
	const screen = await A.page.evaluate(async () => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'pausekey', type: 'onclick', position: { x: 0, y: 620 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'scr', type: 'hudscreen', position: { x: 220, y: 620 }, data: { type: 'hudscreen', screen: 'menu', action: 'toggle' } }
		]);
		s.flowEdges.set([...edges, { id: 'e6', source: 'pausekey', target: 'scr', targetHandle: 'trigger' }]);
		await new Promise((r) => setTimeout(r, 900));
		const beforeIds = [...document.querySelectorAll('#hud-layer .hud-slot')].map((e) => e.getAttribute('data-hud-id'));
		s.flowRuntime.applyNodeTrigger('pausekey', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 1000));
		const afterIds = [...document.querySelectorAll('#hud-layer .hud-slot')].map((e) => e.getAttribute('data-hud-id'));
		return { beforeIds, afterIds };
	});
	h.check(
		screen.beforeIds.includes('score') && !screen.beforeIds.includes('title'),
		`premise: the main screen is up (${JSON.stringify(screen.beforeIds)})`
	);
	h.check(
		screen.afterIds.includes('title') && !screen.afterIds.includes('score'),
		`a HUD Screen node toggles to the menu (${JSON.stringify(screen.afterIds)})`
	);
	// a toggle must not flicker: the pulse stays alive for ~0.3s, and re-acting every
	// frame would flip the screen 60 times a second
	await A.page.waitForTimeout(700);
	const stable = await A.page.evaluate(() =>
		[...document.querySelectorAll('#hud-layer .hud-slot')].map((e) => e.getAttribute('data-hud-id'))
	);
	h.check(
		stable.includes('title'),
		`and STAYS toggled while the pulse is alive — it acts on the stamp EDGE, not per frame (${JSON.stringify(stable)})`
	);

	// ---- 7. the runtime store is THROTTLED and writes ON CHANGE ONLY -------
	// A per-frame store write re-renders the whole layer 60 times a second, and the layer
	// is real DOM. flowValues throttles to 150ms for exactly this reason.
	// Driven by a `time` node, which changes EVERY FRAME on its own. `setNodeData` was the
	// first attempt and measured the wrong thing: it is not throttled, but the write chain
	// behind it (mirror -> flowGraphs -> autosave) is heavy enough that only ~5 of 50 calls
	// landed in 2s, so the reading was setNodeData's cost, not this throttle.
	const writes = await A.page.evaluate(async () => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowNodes.set([
			...nodes.filter((n) => n.id !== 'hp'),
			{ id: 'tick', type: 'time', position: { x: 0, y: 760 }, data: { type: 'time', mode: 'saw', rate: 1 } }
		]);
		s.flowEdges.set([
			...edges.filter((e) => e.id !== 'e3'),
			{ id: 'e7', source: 'tick', target: 'bar', targetHandle: 'value' }
		]);
		await new Promise((r) => setTimeout(r, 1200));
		let n = 0;
		let frames = 0;
		let raf = 0;
		const countFrame = () => {
			frames++;
			raf = requestAnimationFrame(countFrame);
		};
		raf = requestAnimationFrame(countFrame);
		const off = s.hudDocs.hudRuntime.subscribe(() => n++);
		await new Promise((r) => setTimeout(r, 2000));
		cancelAnimationFrame(raf);
		const changing = n - 1; // the subscribe itself fires once
		off();
		// Now hold everything still. The TIMER has to go too: a running countdown
		// legitimately changes every tick, so leaving it in makes "writes nothing when
		// nothing changes" impossible to state — the first version of this check read 5
		// writes for exactly that reason, and it was right to.
		let n2, e2;
		s.flowNodes.subscribe((v) => (n2 = v))();
		s.flowEdges.subscribe((v) => (e2 = v))();
		s.flowNodes.set(n2.filter((n) => n.id !== 'timer' && n.id !== 'tick'));
		s.flowEdges.set(e2.filter((e) => e.id !== 'e7' && e.id !== 'e5'));
		await new Promise((r) => setTimeout(r, 1600));
		let m = 0;
		const off2 = s.hudDocs.hudRuntime.subscribe(() => m++);
		await new Promise((r) => setTimeout(r, 2000));
		const still = m - 1;
		off2();
		return { changing, still, frames };
	});
	h.check(
		writes.changing <= 26,
		`a per-frame-changing HUD is THROTTLED to ~10Hz, not 60 (${writes.changing} writes in 2s)`
	);
	// The claim is RELATIVE to the frame rate, not an absolute Hz: a headless page does
	// not run at 60fps, so an absolute floor would be asserting the host's rAF cadence
	// rather than this throttle. `frames` is counted over the SAME window.
	h.check(
		writes.changing > 0 && writes.changing < writes.frames / 2,
		`and is genuinely BELOW the frame rate, which is what throttling means (${writes.changing} writes vs ${writes.frames} frames in 2s)`
	);
	h.check(
		writes.still === 0,
		`a HUD that is not changing writes NOTHING — on-change only (${writes.still} writes in 2s)`
	);

	await h.finish(browser);
});
