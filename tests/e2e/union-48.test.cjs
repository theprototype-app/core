// 48-int — where two roadmap-48 lanes meet on the union (neither lane's suite can see these):
//
//  D1 x S2  the node graph debugger and the Timeline share flowRuntime. A sequence's EVENT item
//           pulses On Sequence Event through applyNodeTrigger like any local event, so:
//   U1.1-6  a breakpoint downstream of On Sequence Event pauses Play at it, the live log still
//           takes the event (the session never stopped), Step runs it in the paused view, Resume
//           does not count it twice, and without the breakpoint the same event does not pause.
//   U2.1-5  a breakpoint ON Play Sequence holds the cutscene back while paused (the graph runs over
//           the paused view), Step starts it, Resume does not start it a second time, and its
//           event fires once.
//  F1 x G1  the budget chip became an Edit-positions cluster (48-fixes) while 48-tests fixed the
//           700 ms click-eater a mouse drag arms (J12):
//   U3.1-2  drag the chip's grip and press ✓ 100 ms after the drop (a person's quick ✓): the ✓
//           lands (Edit positions closes) and the chip is placed.
//
// Run: APP_URL='https://localhost:5480/' npm run e2e -- union-48
const h = require('./helpers.cjs');

const node = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { type, ...(data ?? {}) }, class: 'w-[150px]' });
const edge = (source, target, targetHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {})
});
const setGraph = (page, nodes, edges) =>
	page.evaluate(
		([nodes, edges]) => {
			const s = window.__tp?.test.v1;
			s.flowGraphs.update((graphs) => ({ ...graphs, scene: { nodes, edges } }));
			s.flowNodes.set(nodes);
			s.flowEdges.set(edges);
		},
		[nodes, edges]
	);
const dbgRt = (page) => page.evaluate(() => window.__tp.test.v1.flowRuntime.flowDebugRuntime());
const liveCount = (page, id) =>
	page.evaluate((nid) => {
		let v;
		window.__tp.test.v1.flowTriggers.subscribe((x) => (v = x))();
		return v?.[nid]?.count ?? 0;
	}, id);
const viewCount = async (page, id) => (await dbgRt(page)).viewTriggers?.[id]?.count ?? 0;
const pulse = (page, id) =>
	page.evaluate((nid) => window.__tp.test.v1.flowRuntime.applyNodeTrigger(nid, (Date.now() % 86400000) / 1000, true), id);
const runs = (page) => page.evaluate(() => window.__tp.test.v1.sequencePlayer.sequencePlayerDebug().runs);
const debug = (page, what) => page.evaluate((w) => window.__tp.test.v1.flowDebug.requestDebug(w), what);
const bp = (page, id, on) => page.evaluate(([i, o]) => window.__tp.test.v1.flowDebug.toggleBreakpoint(i, o), [id, on]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor":true,"editor-touch":true}' } });
	const P = A.page;
	await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
	await P.waitForFunction(() => !!window.__tp?.test.v1?.flowDebug && !!window.__tp?.test.v1?.sequencePlayer && !!window.__tp?.test.v1?.sequences, null, { timeout: 30000 });

	// ---------- the scene: a 3 s sequence with an event "hit" at 0.4 s ----------
	const seq = await P.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.clearGraphs();
		s.flowTriggers.set({});
		s.isLocked.set(null);
		const id = s.sequences.createSequence('Union cut', { duration: 3 });
		const tr = s.sequences.addTrack(id, 'event');
		s.sequences.addItem(id, tr, { t: 0.4, name: 'hit' });
		return { id, events: s.sequences.sequenceOf(id)?.tracks?.[0]?.items?.length ?? 0 };
	});
	h.check(!!seq.id && seq.events === 1, `premise: a sequence with one event item (${seq.id}, ${seq.events})`);
	await setGraph(
		P,
		[
			node('u-click', 'onclick', {}, 0, 0),
			node('u-play', 'playseq', { sequence: seq.id, action: 'play' }, 240, 0),
			node('u-ev', 'onseqevent', { sequence: '', event: 'hit' }, 0, 160),
			node('u-count', 'counter', { step: 1, op: 'up' }, 240, 160)
		],
		[edge('u-click', 'u-play', 'trigger'), edge('u-ev', 'u-count', 'trigger')]
	);
	await P.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	await P.waitForTimeout(1200);

	// ---------- U1: a breakpoint behind On Sequence Event ----------
	console.log('\n=== U1 a sequence event reaches a breakpoint ===');
	await bp(P, 'u-count', true);
	await P.waitForTimeout(300);
	await pulse(P, 'u-click');
	await h.eventually(() => dbgRt(P), (r) => r.paused === true, 'U1.1 the sequence event pauses Play at the breakpoint', 6000);
	const r1 = await dbgRt(P);
	h.check(r1.at?.bp === 'u-count' && r1.queued.some((e) => e.walkId === 'u-ev'), `U1.2 paused AT the Counter with the sequence event waiting (bp=${r1.at?.bp}, queued=${r1.queued.map((e) => e.walkId).join(',')})`);
	h.check((await liveCount(P, 'u-count')) === 1 && (await viewCount(P, 'u-count')) === 0, 'U1.3 the live log took the event, the paused view has not counted it');
	await debug(P, 'step');
	await h.eventually(() => viewCount(P, 'u-count'), (c) => c === 1, 'U1.4 Step runs the sequence event in the paused view', 5000);
	await debug(P, 'resume');
	await h.eventually(() => dbgRt(P), (r) => r.paused === false, 'U1.5a Resume rejoins the live game', 5000);
	await h.eventually(() => runs(P), (r) => r.length === 0, 'U1.5b the cutscene runs to its end', 8000); // ("end" is no "hit")
	h.check((await liveCount(P, 'u-count')) === 1, `U1.5 the event is counted once after Resume (${await liveCount(P, 'u-count')})`);
	await bp(P, 'u-count', false);
	await P.waitForTimeout(300);
	await pulse(P, 'u-click');
	await h.eventually(() => liveCount(P, 'u-count'), (c) => c === 2, 'U1.6 counterfactual: without the breakpoint the next run counts its event', 6000);
	h.check((await dbgRt(P)).paused === false, 'U1.6b …and does not pause');
	await h.eventually(() => runs(P), (r) => r.length === 0, 'U1.6c (the run ends)', 8000);

	// ---------- U2: a breakpoint ON Play Sequence ----------
	console.log('\n=== U2 a breakpoint on Play Sequence ===');
	h.check((await runs(P)).length === 0, 'premise: no sequence is running');
	await bp(P, 'u-play', true);
	await P.waitForTimeout(300);
	await pulse(P, 'u-click');
	await h.eventually(() => dbgRt(P), (r) => r.paused === true && r.at?.bp === 'u-play', 'U2.1 the click pauses Play AT Play Sequence', 6000);
	await P.waitForTimeout(800);
	h.check((await runs(P)).length === 0, 'U2.2 while paused the cutscene has not started (the graph runs over the paused view)');
	await debug(P, 'step');
	await h.eventually(() => runs(P), (r) => r.length === 1, 'U2.3 Step starts the cutscene', 5000);
	const at = (await runs(P))[0]?.at;
	await debug(P, 'resume');
	await h.eventually(() => dbgRt(P), (r) => r.paused === false, 'U2.4a Resume rejoins the live game', 5000);
	await P.waitForTimeout(250);
	const after = await runs(P);
	h.check(after.length <= 1 && (after.length === 0 || after[0].at === at), `U2.4 Resume does not start it a second time (runs ${after.length}, at ${after[0]?.at} vs ${at})`);
	await h.eventually(() => liveCount(P, 'u-count'), (c) => c === 3, 'U2.5 its event fires once', 6000);
	await h.eventually(() => runs(P), (r) => r.length === 0, 'U2.5a (the run ends)', 8000);
	h.check((await liveCount(P, 'u-count')) === 3, `U2.5b …and only once (${await liveCount(P, 'u-count')})`);
	await bp(P, 'u-play', false);
	await P.evaluate(() => window.__tp.test.v1.isLocked.set(null));
	await P.waitForTimeout(2600); // isLocked false -> null cooldown

	// ---------- U3: the budget chip's drag + a quick ✓ ----------
	console.log('\n=== U3 budget chip drag + quick ✓ ===');
	await h.eventually(() => P.evaluate(() => !!document.getElementById('budget-chip-wrap')), (v) => v, 'premise: the budget chip is drawn');
	await P.locator('#controls-pill [title="Explorer"]').first().click({ button: 'right' });
	await P.waitForTimeout(350);
	await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
	await P.waitForTimeout(900);
	const g = await P.locator('#cluster-grip-budget').boundingBox();
	h.check(!!g, 'premise: Edit positions gives the chip a grip');
	const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
	await P.mouse.move(from.x, from.y);
	await P.mouse.down();
	await P.mouse.move(from.x - 150, from.y - 200, { steps: 6 });
	await P.mouse.move(from.x - 300, from.y - 400, { steps: 6 });
	await P.waitForTimeout(150);
	await P.mouse.up();
	await P.waitForTimeout(100);
	await P.locator('#toolbar-edit-apply').click();
	await P.waitForTimeout(900);
	h.check((await P.locator('#toolbar-edit-apply').count()) === 0, 'U3.1 a ✓ pressed 100 ms after the chip drag lands (Edit positions closes)');
	const rec = await P.evaluate(() => JSON.parse(localStorage.getItem('controlsLayout') ?? 'null'));
	h.check(typeof rec?.clusters?.budget?.x === 'number', `U3.2 …and the chip is placed (${JSON.stringify(rec?.clusters?.budget)})`);
	// leave the toolbar as found
	await P.evaluate(() => localStorage.removeItem('controlsLayout'));

	await h.finish(browser);
});
