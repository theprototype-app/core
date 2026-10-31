// fix-batch-1 (docs-1 Q1): inputs the runtime reads but the card drew no socket for — Set Game State
// (trigger), Set Variable (trigger, value), HUD Rows (trigger, text), HUD Set Input (trigger, value,
// options), and HUD Timer, whose `start` socket was drawn but its pulse ignored. Each is WIRED BY HAND
// here (a real mouse drag from the source dot to the target dot in the node editor), then the source
// fires and the input must take effect. Device Param (value) and Note Trigger (trigger, note,
// velocity) are the same class found by the audit guard: their dots must be drawn.
// COUNTERFACTUAL (257e8f6a): no target dot to drop on, so no edge; the timer never starts.
// Run: APP_URL=https://theprototype.app:5591/ node tests/e2e/flow-sockets-wire.test.cjs
const h = require('./helpers.cjs');

const source = (node) =>
	`.svelteFlow .svelte-flow__handle.source[data-nodeid="${node}"]:not([data-handleid])`;
const N = (id, type, x, y, data = {}) => ({
	id,
	type,
	position: { x, y },
	data: { type, label: id, ...data },
	class: 'w-[150px]'
});

/** drag from one handle to another with the mouse — the gesture a person makes */
async function wire(page, fromSel, toSel) {
	const a = await page.locator(fromSel).first().boundingBox();
	const b = await page.locator(toSel).first().boundingBox();
	if (!a || !b) return false;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(400);
	return true;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1440, height: 900 } }
	});
	const p = A.page;
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1500);

	/** a fresh scene graph: an event source, an optional Number (7), and the node under test. The
	 * source gets a NEW id per round: the trigger log keeps an old source's stamp, and a timer wired
	 * to a source that already fired starts from that stamp (right, but not what round 5 measures) */
	let round = 0;
	let SRC = 'src0';
	const load = async (target, data, withValue) => {
		SRC = 'src' + ++round;
		const nodes = [N(SRC, 'onclick', 0, 0), N('dut', target, 360, 0, data)];
		if (withValue) nodes.push(N('num', 'number', 0, 160, { value: 7, step: 1 }));
		await p.evaluate((doc) => window.__stores.restoreGraphs(doc), { scene: { nodes, edges: [] } });
		await p.waitForTimeout(900);
	};
	const edgeInto = (h2) =>
		p.evaluate(
			(th) =>
				window.__stores.allEdges().some((e) => e.target === 'dut' && (e.targetHandle ?? '') === th),
			h2
		);
	const drawn = (id) =>
		p.locator(`.svelteFlow .svelte-flow__handle[data-nodeid="dut"][data-handleid="${id}"]`).count();
	const fire = () =>
		p.evaluate(
			(id) =>
				window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, true),
			SRC
		);
	/** wire `from` into the node's `id` socket by hand and say whether the edge landed there */
	const byHand = async (from, id) => {
		const n = await drawn(id);
		if (n)
			await wire(
				p,
				from,
				`.svelteFlow .svelte-flow__handle[data-nodeid="dut"][data-handleid="${id}"]`
			);
		return { drawn: n > 0, edge: await edgeInto(id) };
	};

	// ---- 1. Set Game State: trigger
	await p.evaluate(() => window.__stores.gameState.setGameState('menu'));
	await load('setgamestate', { state: 'over', outcome: '' }, false);
	const g1 = await byHand(source(SRC), 'trigger');
	h.check(
		g1.drawn && g1.edge,
		`Set Game State: the trigger socket is drawn and takes a wire by hand (${JSON.stringify(g1)})`
	);
	await fire();
	await p.waitForTimeout(600);
	const st = await p.evaluate(
		() => new Promise((r) => window.__stores.gameState.gameState.subscribe((v) => r(v.state))())
	);
	h.check(st === 'over', `…and the pulse sets the game state (${st})`);
	await p.evaluate(() => window.__stores.gameState.setGameState('menu'));

	// ---- 2. Set Variable: trigger + value
	await load('setvariable', { name: 'fb1', op: 'set', value: 0, scope: 'shared' }, true);
	const v1 = await byHand(source(SRC), 'trigger');
	const v2 = await byHand(source('num'), 'value');
	h.check(
		v1.drawn && v1.edge && v2.drawn && v2.edge,
		`Set Variable: trigger and value sockets take wires by hand (${JSON.stringify([v1, v2])})`
	);
	await fire();
	await p.waitForTimeout(600);
	const fb1 = await p.evaluate(
		() => new Promise((r) => window.__stores.gameState.gameState.subscribe((v) => r(v.vars?.fb1))())
	);
	h.check(fb1 === 7, `…and the pulse writes the WIRED value, 7 (${fb1})`);

	// ---- 3. HUD Rows: trigger + text
	await load('hudrows', { element: 'fb1list', op: 'append', text: '' }, true);
	const r1 = await byHand(source(SRC), 'trigger');
	const r2 = await byHand(source('num'), 'text');
	h.check(
		r1.drawn && r1.edge && r2.drawn && r2.edge,
		`HUD Rows: trigger and text sockets take wires by hand (${JSON.stringify([r1, r2])})`
	);
	await fire();
	await p.waitForTimeout(600);
	const rows = await p.evaluate(() => window.__stores.flowRuntime.hudRowsOf('fb1list'));
	h.check(
		Array.isArray(rows) && rows.map(String).includes('7'),
		`…and the pulse appends the wired row (${JSON.stringify(rows)})`
	);

	// ---- 4. HUD Set Input: trigger + value (+ options drawn)
	await load('hudset', { element: 'fb1slider', value: 0 }, true);
	const s1 = await byHand(source(SRC), 'trigger');
	const s2 = await byHand(source('num'), 'value');
	const sOpt = (await drawn('options')) > 0;
	h.check(
		s1.drawn && s1.edge && s2.drawn && s2.edge && sOpt,
		`HUD Set Input: trigger, value (and options) sockets are drawn, wired by hand (${JSON.stringify([s1, s2, sOpt])})`
	);
	await fire();
	await p.waitForTimeout(600);
	const sv = await p.evaluate(() => window.__stores.hudDocs.hudValueOf('fb1slider'));
	h.check(Number(sv) === 7, `…and the pulse moves the control to the wired value (${sv})`);

	// ---- 5. HUD Timer: the drawn `start` socket now starts it
	await load(
		'hudtimer',
		{ element: 'fb1timer', duration: 60, format: '{v}', decimals: 0, autostart: false },
		false
	);
	const t1 = await byHand(source(SRC), 'start');
	const before = await p.evaluate(
		() =>
			new Promise((r) => window.__stores.hudDocs.hudRuntime.subscribe((v) => r(v.fb1timer?.text))())
	);
	await fire();
	await p.waitForTimeout(2600);
	const after = await p.evaluate(
		() =>
			new Promise((r) => window.__stores.hudDocs.hudRuntime.subscribe((v) => r(v.fb1timer?.text))())
	);
	h.check(
		t1.drawn && t1.edge && before === '60',
		`HUD Timer: start wired by hand, the timer waits at 60 (${JSON.stringify(t1)}, ${before})`
	);
	h.check(
		Number(after) < 60 && Number(after) >= 55,
		`…and a pulse into start counts it down (${before} -> ${after})`
	);

	// ---- 6. the audit's two: their sockets are drawn
	await load('notetrigger', { note: 60, velocity: 0.9 }, false);
	const nt = await Promise.all(['trigger', 'note', 'velocity'].map(drawn));
	h.check(
		nt.every((n) => n > 0),
		`Note Trigger draws trigger, note and velocity sockets (${nt})`
	);
	await load('deviceparam', { key: 'level', value: 0 }, false);
	const dp = await drawn('value');
	h.check(dp > 0, `Device Param draws its value socket (${dp})`);

	h.check(
		h.pageErrors(A).length === 0,
		`no page errors (${JSON.stringify(h.pageErrors(A)).slice(0, 200)})`
	);
	await h.finish(browser);
});
