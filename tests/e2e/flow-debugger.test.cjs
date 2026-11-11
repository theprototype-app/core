// 48 D1 — THE NODE GRAPH DEBUGGER: a breakpoint pauses Play at the node, Step runs one event, the
// wires show live values, the watch list shows a variable — and the other player keeps playing.
//
// Two peers in one session, both in Play. A sets a breakpoint on a Counter fed by an On Click
// that also drives a shared Set Variable (`score add 1`); a Spin effect turns a box beside it.
//
//   1  A's click pauses A AT the Counter: A's view has not counted it, A's box stands still, the
//      pointer is free for the panel — while B counted it, banked the score and its box turns.
//   2  Step runs that one event in A's view: the Counter reads 1, the click wire pulses, the wire
//      out of the Counter reads 1, and the watch list's `score` reads 1 — without A writing the
//      shared score a second time (B already did: every peer derives the same write).
//   3  Step with nothing queued waits; B's next click arrives and is stepped as it lands.
//   4  Resume rejoins the live game: counts converge, the score is not double-counted, the box
//      turns again. With the breakpoint removed, a click does not pause (the counterfactual).
//   5  Idle = unarmed: no breakpoint and the panel closed leaves the runtime's one test false.
//
// Run: APP_URL='https://localhost:5481/' npm run e2e -- flow-debugger
const h = require('./helpers.cjs');

const store = (peer, name) =>
	peer.page.evaluate((n) => {
		let v;
		window.__tp.test.v1[n].subscribe((x) => (v = x))();
		return v;
	}, name);
const liveCount = async (peer, id) => (await store(peer, 'flowTriggers'))[id]?.count ?? 0;
const dbgRt = (peer) => peer.page.evaluate(() => window.__tp.test.v1.flowRuntime.flowDebugRuntime());
const dbgState = (peer) => peer.page.evaluate(() => window.__tp.test.v1.flowDebug.flowDebugState());
const viewCount = async (peer, id) => (await dbgRt(peer)).viewTriggers?.[id]?.count ?? 0;
const varOf = (peer, name) => peer.page.evaluate((n) => window.__tp.test.v1.gameState.gameVar(n, 0), name);
const setPlay = (peer, state) => peer.page.evaluate((s) => window.__tp.test.v1.isLocked.set(s), state);
const pulse = (peer, id) =>
	peer.page.evaluate((nid) => window.__tp.test.v1.flowRuntime.applyNodeTrigger(nid, (Date.now() % 86400000) / 1000, true), id);
const spinOf = (peer, uuid) =>
	peer.page.evaluate((id) => {
		let group;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (group = v))();
		return group?.getObjectByProperty('uuid', id)?.rotation.y ?? null;
	}, uuid);
const node = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { type, ...(data ?? {}) }, class: 'w-[150px]' });
const edge = (source, target, targetHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {})
});
const addNodes = (peer, nodes, edges) =>
	peer.page.evaluate(
		([nodes, edges]) => {
			const s = window.__tp?.test.v1;
			let next = { nodes: [], edges: [] };
			s.flowGraphs.update((graphs) => {
				const g = graphs.scene ?? { nodes: [], edges: [] };
				next = { nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] };
				return { ...graphs, scene: next };
			});
			s.flowNodes.set(next.nodes);
			s.flowEdges.set(next.edges);
			let peer = null;
			s.peers.subscribe((p) => (peer = p))();
			nodes.forEach((n) => peer?.send({ type: 'nodecreate', node: n }));
			edges.forEach((e) => peer?.send({ type: 'edgecreate', edge: e }));
		},
		[nodes, edges]
	);
const text = (peer, sel) => peer.page.locator(sel).first().textContent({ timeout: 5000 }).catch(() => null);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(() => !!window.__tp?.test.v1?.flowDebug && !!window.__tp?.test.v1?.flowRuntime?.flowDebugRuntime, null, { timeout: 30000 });
	h.check(true, 'premise: both peers expose the debugger hooks');
	await h.connect(A, B);

	for (const p of [A, B])
		await p.page.evaluate(() => {
			window.__tp.test.v1.clearGraphs();
			window.__tp.test.v1.flowTriggers.set({});
			window.__tp.test.v1.gameState.clearGameState();
			window.__tp.test.v1.isLocked.set(null);
		});
	await A.page.waitForTimeout(900);
	const box = await A.page.evaluate(async () => {
		const s = window.__tp?.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const uuid = group.children[group.children.length - 1].uuid;
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return uuid;
	});
	await addNodes(
		A,
		[
			node('dbg-click', 'onclick', {}, 0, 0),
			node('dbg-count', 'counter', { step: 1, op: 'up' }, 240, 0),
			node('dbg-map', 'maprange', { inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: false }, 480, 0),
			node('dbg-score', 'setvariable', { name: 'score', op: 'add', value: 1, scope: 'shared' }, 240, 160),
			node('dbg-spin', 'spin', { axis: 'y', speed: 2 }, 0, 320),
			node('dbg-sel', 'objectselector', { selected: box }, 240, 320)
		],
		[edge('dbg-click', 'dbg-count', 'trigger'), edge('dbg-count', 'dbg-map', 'a'), edge('dbg-click', 'dbg-score', 'trigger'), edge('dbg-spin', 'dbg-sel')]
	);
	await A.page.evaluate(() => window.__tp.test.v1.gameState.setGameVar('score', 0));
	await A.page.waitForTimeout(1500);
	const idsB = await B.page.evaluate(() => {
		let g;
		window.__tp.test.v1.flowGraphs.subscribe((v) => (g = v))();
		return (g.scene?.nodes ?? []).map((n) => n.id);
	});
	h.check(idsB.includes('dbg-count') && idsB.includes('dbg-score'), `premise: B holds the graph (${idsB.length} nodes)`);
	await setPlay(A, true);
	await setPlay(B, true);
	await A.page.waitForTimeout(1200);

	// ---- 5 first: idle costs nothing --------------------------------------------------------
	console.log('\n=== idle: no breakpoint, panel closed ===');
	const idle = await dbgState(A);
	h.check(idle.playing === true && idle.armed === false, `idle in Play: the runtime's one test is false (armed=${idle.armed}, playing=${idle.playing})`);

	await A.page.evaluate(() => {
		const d = window.__tp.test.v1.flowDebug;
		d.toggleBreakpoint('dbg-count', true);
		d.addWatch({ kind: 'var', key: 'score' });
		d.setDebugOpen(true);
	});
	await A.page.waitForSelector('#flow-debugger', { timeout: 15000 });
	await h.eventually(() => text(A, '#debug-status'), (t) => /Running/.test(t ?? ''), 'the panel opens in Play and says Running');
	h.check((await dbgState(A)).armed === true, 'a breakpoint arms the debugger');

	// ---- 1. the breakpoint ------------------------------------------------------------------
	console.log('\n=== 1. a click reaches the breakpoint ===');
	await pulse(A, 'dbg-click');
	await A.page.waitForTimeout(900);
	const rt1 = await dbgRt(A);
	h.check(rt1.paused === true && rt1.at?.bp === 'dbg-count', `A paused AT the Counter (paused=${rt1.paused}, bp=${rt1.at?.bp})`);
	h.check(rt1.queued.length === 1 && rt1.queued[0].walkId === 'dbg-click', `the click is the one event waiting (${rt1.queued.length})`);
	h.check((await viewCount(A, 'dbg-count')) === 0, "A's paused view has not counted the click yet");
	h.check((await liveCount(A, 'dbg-count')) === 1, "A's LIVE log took it as always (the session never stopped)");
	h.check(rt1.sandboxed === true, 'another player is connected, so the shared writes are sandboxed');
	await h.eventually(() => liveCount(B, 'dbg-count'), (c) => c === 1, 'B counted the click (B keeps running)');
	await h.eventually(() => varOf(B, 'score'), (v) => v === 1, 'B banked the score itself');
	const a1 = await spinOf(A, box);
	const b1 = await spinOf(B, box);
	await A.page.waitForTimeout(600);
	const a2 = await spinOf(A, box);
	const b2 = await spinOf(B, box);
	h.check(a1 !== null && Math.abs(a2 - a1) < 1e-6, `A's box stands still in the paused view (${a1?.toFixed(3)} -> ${a2?.toFixed(3)})`);
	h.check(b1 !== null && Math.abs(b2 - b1) > 0.05, `B's box keeps turning (${b1?.toFixed(3)} -> ${b2?.toFixed(3)})`);
	h.check((await store(A, 'playPointerFree')) === true, 'the pause frees the pointer for the panel');
	h.check(!!(await store(B, 'playPointerFree')) === false, "B's pointer is untouched");
	await h.eventually(() => text(A, '#debug-at'), (t) => /Counter/.test(t ?? ''), 'the panel says where it stopped');
	h.check((await A.page.getAttribute('#debug-status', 'data-mode')) === 'paused', 'the status row reads paused');
	const w1 = await A.page.evaluate(() => window.__tp.test.v1.flowDebug.flowDebugState().values);
	const clickWire = w1.inputs.find((r) => r.nodeId === 'dbg-click');
	const outWire = w1.outputs.find((r) => r.nodeId === 'dbg-map');
	h.check(w1.focus?.id === 'dbg-count', `the wires shown are the Counter's (${w1.focus?.id})`);
	h.check(clickWire?.kind === 'event' && clickWire.text === 'never', `before the step, the click wire has not fired in the view (${clickWire?.text})`);
	h.check(outWire?.text === '0', `the wire out of the Counter reads 0 (${outWire?.text})`);
	const watch1 = w1.watches.find((r) => r.key === 'var:score');
	h.check(watch1?.text === '0', `the watch list holds the score as it stood at the pause (${watch1?.text})`);

	// ---- 2. Step ------------------------------------------------------------------------------
	console.log('\n=== 2. Step runs that one event ===');
	await A.page.click('#debug-step');
	await A.page.waitForTimeout(900);
	const rt2 = await dbgRt(A);
	h.check(rt2.paused === true && rt2.queued.length === 0 && rt2.steps === 1, `still paused, nothing waiting, one step (${rt2.queued.length}, ${rt2.steps})`);
	h.check((await viewCount(A, 'dbg-count')) === 1, "the Counter reads 1 in A's view");
	const w2 = await A.page.evaluate(() => window.__tp.test.v1.flowDebug.flowDebugState().values);
	const clickWire2 = w2.inputs.find((r) => r.nodeId === 'dbg-click');
	const outWire2 = w2.outputs.find((r) => r.nodeId === 'dbg-map');
	h.check(clickWire2?.high === true, `the click wire pulses (${clickWire2?.text})`);
	h.check(outWire2?.text === '1', `the wire out of the Counter reads 1 (${outWire2?.text})`);
	const watch2 = w2.watches.find((r) => r.key === 'var:score');
	h.check(watch2?.text === '1', `the watch list shows the stepped score (${watch2?.text})`);
	const domWire = await text(A, '#debug-wires-out .debug-value');
	h.check(domWire === '1', `the panel's wire row shows it (${domWire})`);
	// evidence: the paused panel in dark and light (LANE_SHOTS=0 skips)
	if (process.env.LANE_SHOTS !== '0') {
		const dir = '/home/deck/.code/lanes-30/after-48/48-debugger';
		const panel = A.page.locator('#flow-debugger');
		await panel.screenshot({ path: dir + '/01-debugger-paused-dark.png' }).catch(() => {});
		await A.page.evaluate(() => window.__tp.test.v1.themes.theme.set('light'));
		await A.page.waitForTimeout(400);
		await panel.screenshot({ path: dir + '/01-debugger-paused-light.png' }).catch(() => {});
		await A.page.evaluate(() => window.__tp.test.v1.themes.theme.set('dark'));
		await A.page.waitForTimeout(300);
	}
	await A.page.waitForTimeout(1200);
	h.check((await varOf(B, 'score')) === 1 && (await varOf(A, 'score')) === 1, 'the shared score was not written twice (A sandboxed its step)');
	const a3 = await spinOf(A, box);
	await A.page.waitForTimeout(400);
	h.check(Math.abs((await spinOf(A, box)) - a3) < 1e-6, "A's box still stands (the clock moved to the click, then froze)");

	// ---- 3. Step waits for the next event ------------------------------------------------------
	console.log('\n=== 3. Step with nothing queued waits ===');
	await A.page.click('#debug-step');
	await A.page.waitForTimeout(600);
	h.check((await dbgRt(A)).waiting === true, 'Step with nothing queued waits for the next event');
	await h.eventually(() => text(A, '#debug-queue'), (t) => /Waiting/.test(t ?? ''), 'the panel says it is waiting');
	await pulse(B, 'dbg-click');
	await h.eventually(() => viewCount(A, 'dbg-count'), (c) => c === 2, "B's click arrives and is stepped in A's view", 8000);
	h.check((await dbgRt(A)).paused === true, 'and A stays paused after it');
	await h.eventually(() => liveCount(B, 'dbg-count'), (c) => c === 2, 'B counted its own click');

	// ---- 4. Resume ------------------------------------------------------------------------------
	console.log('\n=== 4. Resume ===');
	await A.page.click('#debug-resume');
	await A.page.waitForTimeout(1500);
	h.check((await dbgRt(A)).paused === false, 'Resume rejoins the live game');
	h.check((await liveCount(A, 'dbg-count')) === 2, 'the counts agree after Resume');
	await A.page.waitForTimeout(1200);
	const sA = await varOf(A, 'score');
	const sB = await varOf(B, 'score');
	h.check(sA === 2 && sB === 2, `the score is 2 on both, not double-counted by the resume (A ${sA}, B ${sB})`);
	const a4 = await spinOf(A, box);
	await A.page.waitForTimeout(500);
	h.check(Math.abs((await spinOf(A, box)) - a4) > 0.05, "A's box turns again");
	h.check((await store(A, 'playPointerFree')) === false, 'the pointer goes back to the game');

	await A.page.evaluate(() => window.__tp.test.v1.flowDebug.toggleBreakpoint('dbg-count', false));
	await A.page.waitForTimeout(300);
	await pulse(A, 'dbg-click');
	await A.page.waitForTimeout(900);
	h.check((await dbgRt(A)).paused === false && (await liveCount(A, 'dbg-count')) === 3, 'counterfactual: without the breakpoint the same click does not pause');

	// ---- 4b. a manual pause + leaving Play resumes ---------------------------------------------
	await A.page.click('#debug-pause');
	await A.page.waitForTimeout(700);
	h.check((await dbgRt(A)).paused === true && (await dbgRt(A)).at?.why === 'pause', 'Pause holds the view with no breakpoint');
	await setPlay(A, null);
	await A.page.waitForTimeout(700);
	h.check((await dbgRt(A)).paused === false, 'leaving Play rejoins the live game');

	// ---- 5. idle again ----------------------------------------------------------------------
	await A.page.evaluate(() => window.__tp.test.v1.flowDebug.setDebugOpen(false));
	await setPlay(A, true);
	await A.page.waitForTimeout(600);
	const idle2 = await dbgState(A);
	h.check(idle2.armed === false, `no breakpoint + panel closed = unarmed again (armed=${idle2.armed})`);

	await h.finish(browser);
});
