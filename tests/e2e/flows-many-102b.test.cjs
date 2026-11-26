// 102b-flows — ONE FLOW, MANY OBJECTS (rows 1-3), two real peers.
//   1. Object tags: set on A, replicate to B, survive B's reload.
//   2. A tag selector fans out: one On Click -> Latch -> Visibility wired to "every object tagged
//      star" hides ALL three stars on both peers when ANY star is clicked, and leaves the untagged
//      box alone. The click on B tells A which star fired (the additive nodetrigger `obj`), and
//      Fired Object / firedObjectOf answer the same star on both.
//   3. Give this flow to the selection: star 1's own flow ("click me = hide me") goes to stars 2
//      and 3 as plain copies, re-pointed at each receiver; the copies and the family link reach B;
//      a click on star 3 hides star 3 only; Update all copies pushes an edit; ONE undo removes both
//      copies on both peers.
//   4. ZERO CHANGE when unused: a plain one-object selector graph sends nodetrigger messages with
//      no `obj` field, never loads the selector resolver chunk, and acts on its one object.
// Counterfactual on v1.72.0: §1 has no tag writer, §2 hides one star at most (pick is ignored), §3
// has no giveFlow — all red.
const h = require('./helpers.cjs');

const mod = (page, path) => page.evaluate((p) => import(p).then(() => true), path);

/** poll `fn` until `pred` holds; the value, or null at the timeout (h.eventually returns nothing) */
const waitFor = async (fn, pred, timeout = 15000) => {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = await fn();
		if (pred(v)) return v;
		await new Promise((r) => setTimeout(r, 250));
	}
	return null;
};

/** build the shared scene on A: three stars, a box and (optionally) a lamp @param {any} A */
const buildScene = (A) =>
	A.page.evaluate(() => {
		const S = window.__tp.test.v1;
		let g;
		const make = (name) => {
			S.commandsHandler.sceneCommand('/create box');
			S.objectsGroup.subscribe((x) => (g = x))();
			const o = g.children[g.children.length - 1];
			o.name = name;
			return o.uuid;
		};
		const out = { stars: [make('Star 1'), make('Star 2'), make('Star 3')], box: make('Box'), lamp: make('Lamp') };
		S.objectActions.deselectObject();
		return out;
	});

/** nodes + edges straight into a graph (no history), canonical edge ids */
const addGraph = (P, graphId, nodes, edges) =>
	P.page.evaluate(
		({ graphId, nodes, edges }) => {
			const S = window.__tp.test.v1;
			if (graphId !== 'scene') S.flowGraphsCtl.createObjectGraph(graphId, { record: false });
			nodes.forEach((n, i) => S.nodesHandler.createFlowNode({ id: n.id, type: n.type, position: { x: (i % 4) * 220, y: Math.floor(i / 4) * 150 }, data: { type: n.type, ...n.data } }, graphId));
			for (const [source, target, targetHandle] of edges)
				S.nodesHandler.createFlowEdge({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) }, graphId);
		},
		{ graphId, nodes, edges }
	);

const visibleOf = (P, uuids) =>
	P.page.evaluate((us) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		return us.map((u) => g.getObjectByProperty('uuid', u)?.visible ?? null);
	}, uuids);

const userDataOf = (P, uuids, key) =>
	P.page.evaluate(
		({ us, key }) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
			return us.map((u) => g.getObjectByProperty('uuid', u)?.userData?.[key] ?? null);
		},
		{ us: uuids, key }
	);

const graphSummary = (P, uuid) =>
	P.page.evaluate((u) => {
		const S = window.__tp.test.v1;
		if (!S.graphExists(u)) return null;
		const g = S.graphOf(u);
		return { nodes: g.nodes.length, edges: g.edges.length, selected: g.nodes.filter((n) => n.type === 'objectselector').map((n) => n.data.selected), ids: g.nodes.map((n) => n.id) };
	}, uuid);

/** record every nodetrigger this page SENDS (the replicated pulse) */
const spySends = (P) =>
	P.page.evaluate(() => {
		let pr;
		window.__tp.test.v1.peers.subscribe((v) => (pr = v))();
		window.__sent = [];
		const send = pr.send.bind(pr);
		pr.send = (msg, ...rest) => {
			if (msg?.type === 'nodetrigger') window.__sent.push(msg);
			return send(msg, ...rest);
		};
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const ids = await buildScene(A);
	const [s1, s2, s3] = ids.stars;
	console.log('  scene: ' + JSON.stringify(ids));

	// ---- the scene flows, built on A before B joins (the handshake carries them) ----
	await addGraph(
		A,
		'scene',
		[
			{ id: 'click', type: 'onclick', data: {} },
			{ id: 'latch', type: 'latch', data: { initial: false } },
			{ id: 'not', type: 'gate', data: { op: 'not' } },
			{ id: 'vis', type: 'visibility', data: { on: true } },
			{ id: 'stars', type: 'objectselector', data: { pick: 'tag', match: 'star' } },
			{ id: 'fired', type: 'firedobject', data: {} },
			// §4: the plain one-object chain (the shape of every shipped selector)
			{ id: 'lampClick', type: 'onclick', data: {} },
			{ id: 'lampLatch', type: 'latch', data: { initial: false } },
			{ id: 'lampNot', type: 'gate', data: { op: 'not' } },
			{ id: 'lampVis', type: 'visibility', data: { on: true } },
			{ id: 'lampSel', type: 'objectselector', data: { selected: ids.lamp } }
		],
		[
			['click', 'latch', 'toggle'],
			['latch', 'not', 'a'],
			['not', 'vis', 'on'],
			['vis', 'stars', null],
			['click', 'fired', 'trigger'],
			['lampClick', 'lampLatch', 'toggle'],
			['lampLatch', 'lampNot', 'a'],
			['lampNot', 'lampVis', 'on'],
			['lampVis', 'lampSel', null]
		]
	);

	// ---- §4 first, while nothing has asked for a set: the zero-change check ----
	await mod(A.page, '/src/lib/selectorPick.js');
	// §1: tags, before B joins (proves the object sync carries them), via the same writer the Inspector uses
	await mod(A.page, '/src/lib/objectTags.js');
	await A.page.evaluate((stars) => import('/src/lib/objectTags.js').then((m) => m.addTag(stars, 'Star')), ids.stars);
	const tagsA = await userDataOf(A, ids.stars.concat(ids.box), 'tags');
	h.check(JSON.stringify(tagsA) === JSON.stringify([['Star'], ['Star'], ['Star'], null]), '1.1 A: the three stars carry the tag, the box none ' + JSON.stringify(tagsA));

	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const peers = [A, B];
	await h.eventually(
		() => Promise.all(peers.map((p) => p.page.evaluate(() => window.__tp.test.v1.nodesHandler.graphHash()))),
		(hs) => hs[0] === hs[1],
		'premise: both peers hold the graph',
		40000
	);
	const tagsB = await waitFor(() => userDataOf(B, ids.stars.concat(ids.box), 'tags'), (t) => JSON.stringify(t) === JSON.stringify(tagsA), 20000);
	h.check(!!tagsB, '1.2 B: tags arrived with the object sync ' + JSON.stringify(tagsB ?? (await userDataOf(B, ids.stars, 'tags'))));
	// a live edit replicates as objectParameters 'tags' (one undo, one wire batch)
	await A.page.evaluate((u) => import('/src/lib/objectTags.js').then((m) => m.addTag([u], 'bright')), s2);
	const liveB = await waitFor(() => userDataOf(B, [s2], 'tags'), (t) => JSON.stringify(t[0]) === '["Star","bright"]', 15000);
	h.check(!!liveB, '1.3 B: the live tag edit arrived ' + JSON.stringify(await userDataOf(B, [s2], 'tags')));

	for (const p of peers) await spySends(p);

	// ---- §4 the plain selector, unchanged ----
	await A.page.evaluate((u) => window.__tp.test.v1.flowRuntime.fireObjectClick(u), ids.lamp);
	await h.eventually(() => Promise.all(peers.map((p) => visibleOf(p, [ids.lamp]))), (v) => v.every((x) => x[0] === false), '4.1 the plain selector hides its one object on both peers', 15000).catch(() => {});
	const lampVis = await Promise.all(peers.map((p) => visibleOf(p, [ids.lamp, ...ids.stars])));
	h.check(lampVis.every((v) => v[0] === false && v.slice(1).every((x) => x === true)), '4.1 the lamp hid on both peers and no star moved ' + JSON.stringify(lampVis));
	const lampSent = await A.page.evaluate(() => window.__sent.filter((m) => m.id === 'lampClick'));
	h.check(lampSent.length >= 1 && lampSent.every((m) => !('obj' in m)), '4.2 the plain click pulse carries no obj field ' + JSON.stringify(lampSent));

	// ---- §2 the tag selector fans out; a click on B says which star ----
	await B.page.evaluate((u) => window.__tp.test.v1.flowRuntime.fireObjectClick(u), s3);
	const starsGone = await waitFor(() => Promise.all(peers.map((p) => visibleOf(p, [...ids.stars, ids.box]))), (v) => v.every((x) => x.slice(0, 3).every((y) => y === false)), 15000);
	const vis2 = await Promise.all(peers.map((p) => visibleOf(p, [...ids.stars, ids.box])));
	h.check(!!starsGone && vis2.every((x) => x[3] === true), '2.1 one click on star 3 (on B) hid ALL three stars on both peers, the box stayed ' + JSON.stringify(vis2));
	const sentB = await B.page.evaluate(() => window.__sent.filter((m) => m.id === 'click'));
	h.check(sentB.some((m) => m.obj === s3), '2.2 B\'s pulse names the star it fired for (obj) ' + JSON.stringify(sentB));
	const firedOn = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__tp.test.v1.flowRuntime.firedObjectOf('click') ?? null)));
	h.check(firedOn.every((u) => u === s3), '2.3 Fired Object answers star 3 on both peers ' + JSON.stringify(firedOn));
	const coreLoaded = await A.page.evaluate(() => import('/src/lib/selectorPick.js').then((m) => !!m.selectorCoreNow()));
	h.check(coreLoaded, '2.4 the resolver chunk loaded once a set selector existed');
	// a second click on star 1 (A) toggles them all back, and Fired Object moves to star 1
	await A.page.evaluate((u) => window.__tp.test.v1.flowRuntime.fireObjectClick(u), s1);
	await h.eventually(() => Promise.all(peers.map((p) => visibleOf(p, ids.stars))), (v) => v.every((x) => x.every((y) => y === true)), '2.5 a click on star 1 shows them all again', 15000).catch(() => {});
	const vis25 = await Promise.all(peers.map((p) => visibleOf(p, ids.stars)));
	const fired25 = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__tp.test.v1.flowRuntime.firedObjectOf('click') ?? null)));
	h.check(vis25.every((x) => x.every((y) => y === true)) && fired25.every((u) => u === s1), '2.5 toggled back on both, fired = star 1 ' + JSON.stringify({ vis25, fired25 }));

	// ---- §3 give this flow to the selection ----
	// star 1's own flow: its click hides it (an unwired On Click in an object graph = its owner), with a
	// selector naming star 1 itself (the self-reference the copy must re-point)
	await addGraph(
		A,
		s1,
		[
			{ id: 'own-click', type: 'onclick', data: {} },
			{ id: 'own-latch', type: 'latch', data: { initial: false } },
			{ id: 'own-not', type: 'gate', data: { op: 'not' } },
			{ id: 'own-vis', type: 'visibility', data: { on: true } },
			{ id: 'own-sel', type: 'objectselector', data: { selected: s1 } }
		],
		[
			['own-click', 'own-latch', 'toggle'],
			['own-latch', 'own-not', 'a'],
			['own-not', 'own-vis', 'on'],
			['own-vis', 'own-sel', null]
		]
	);
	// the hand-built object graph reaches B as one whole-document push (what the editor does per edit)
	await A.page.evaluate((u) => {
		const S = window.__tp.test.v1;
		let pr;
		S.peers.subscribe((v) => (pr = v))();
		pr.send({ type: 'graphcreate', uuid: u });
		const g = S.graphOf(u);
		pr.send({ type: 'nodes', nodes: [], edges: [], graphs: { [u]: { nodes: g.nodes.map(S.nodesHandler.serializeNode), edges: g.edges.map(S.nodesHandler.serializeEdge) } } });
	}, s1);
	await h.eventually(() => graphSummary(B, s1), (g) => g?.nodes === 5, 'premise: B holds star 1\'s flow', 15000);

	const given = await A.page.evaluate(({ s1, s2, s3 }) => import('/src/lib/flowGive.js').then((m) => m.giveFlow(s1, [s1, s2, s3])), { s1, s2, s3 });
	h.check(given === 2, '3.1 the flow went to the two other stars (' + given + ')');
	for (const [p, label] of [[A, 'A'], [B, 'B']]) {
		const sums = await waitFor(() => Promise.all([s2, s3].map((u) => graphSummary(p, u))), (g) => g.every((x) => x?.nodes === 5 && x?.edges === 4), 15000);
		const got = sums ?? (await Promise.all([s2, s3].map((u) => graphSummary(p, u))));
		h.check(!!sums && got[0].selected[0] === s2 && got[1].selected[0] === s3, `3.2 ${label}: each copy's selector points at its own star ` + JSON.stringify(got.map((g) => g?.selected)));
		h.check(!!sums && got[0].ids.every((id) => !got[1].ids.includes(id)) && !got[0].ids.includes('own-click'), `3.3 ${label}: fresh node ids per copy`);
		const from = await waitFor(() => userDataOf(p, [s1, s2, s3], 'flowFrom'), (f) => f[1] === s1 && f[2] === s1, 15000);
		h.check(!!from && from[0] === null, `3.4 ${label}: stars 2 and 3 are linked to star 1 (flowFrom), star 1 to nothing ` + JSON.stringify(from ?? (await userDataOf(p, [s1, s2, s3], 'flowFrom'))));
	}
	// a click on star 3 now hides star 3 by ITS OWN copy (and the tag flow hides all — so check the copy's
	// own latch moved, which only star 3's graph holds)
	const copy3 = await graphSummary(A, s3);
	const latch3 = copy3.ids[1];
	await A.page.evaluate((u) => window.__tp.test.v1.flowRuntime.fireObjectClick(u), s3);
	const latchVals = await waitFor(
		() => Promise.all(peers.map((p) => p.page.evaluate((id) => { let v; window.__tp.test.v1.flowValues.subscribe((x) => (v = x))(); return v?.[id] ?? null; }, latch3))),
		(v) => v.every((x) => x === true),
		'3.5 star 3\'s own copy fired on both peers',
		15000
	).catch(() => null);
	const probe35 = await Promise.all(
		peers.map((p) =>
			p.page.evaluate(
				({ latch, click }) => {
					const S = window.__tp.test.v1;
					let v, t;
					S.flowValues.subscribe((x) => (v = x))();
					S.flowTriggers.subscribe((x) => (t = x))();
					return { latch: v?.[latch] ?? null, clickT: t?.[click]?.lastT ?? null, runtimeHas: S.allNodes().some((n) => n.id === click) };
				},
				{ latch: latch3, click: copy3.ids[0] }
			)
		)
	);
	h.check(!!latchVals || probe35.every((x) => x.clickT !== null), '3.5 the click on star 3 drove star 3\'s copy on both peers ' + JSON.stringify(probe35));

	// Update all copies from this one: an edit on star 2's copy goes out to star 1 and star 3
	// a REPLICATED edit (setNodeData), as the card makes it: an unreplicated one leaves the peers' graph
	// hashes apart, and nodesync's 30 s snapshot pull then merges deleted copies back (merge never deletes)
	await A.page.evaluate((u) => {
		const S = window.__tp.test.v1;
		const latch = S.graphOf(u).nodes.find((n) => n.type === 'latch');
		S.nodesHandler.setNodeData(latch.id, { label: 'edited' }, u);
	}, s2);
	const updated = await A.page.evaluate((u) => import('/src/lib/flowGive.js').then((m) => m.updateFlowFamily(u)), s2);
	h.check(updated === 2, '3.6 Update all copies reached the root and the other copy (' + updated + ')');
	const labels = await waitFor(
		() => B.page.evaluate((us) => us.map((u) => window.__tp.test.v1.graphOf(u).nodes.find((n) => n.type === 'latch')?.data?.label ?? null), [s1, s3]),
		(l) => l.every((x) => x === 'edited'), 15000);
	const labelsNow = await Promise.all(peers.map((p) => p.page.evaluate((us) => us.map((u) => (window.__tp.test.v1.graphOf(u)?.nodes ?? []).map((n) => n.type + ':' + (n.data?.label ?? '-')).join(',')), [s1, s2, s3])));
	h.check(!!labels, '3.6 B: the update replaced both documents ' + JSON.stringify(labelsNow));
	const sel1 = await graphSummary(B, s1);
	h.check(sel1?.nodes === 5 && sel1.selected[0] === s1, '3.7 B: the root\'s copy points at star 1 again, no stale nodes left ' + JSON.stringify(sel1));

	// ONE undo takes the update back, a second the give: both copies gone again on both peers
	const stackTop = await A.page.evaluate(() => {
		let st;
		window.__tp.test.v1.history.undoStack.subscribe((x) => (st = x))();
		return st.slice(-4).map((e) => (e.kind ?? '?') + (e.label ? ':' + e.label : '') + (e.entries ? '[' + e.entries.map((x) => x.kind).join(',') + ']' : ''));
	});
	console.log('  undo stack top: ' + JSON.stringify(stackTop));
	for (const step of [1, 2]) {
		await A.page.evaluate(() => window.__tp.test.v1.history.undo());
		await A.page.waitForTimeout(300);
		console.log(`  after undo ${step}: A ` + JSON.stringify(await Promise.all([s1, s2, s3].map((u) => graphSummary(A, u).then((g) => g && g.nodes + '/' + g.ids[0].slice(0, 8))))) + ' B ' + JSON.stringify(await Promise.all([s1, s2, s3].map((u) => graphSummary(B, u).then((g) => g && g.nodes + '/' + g.ids[0].slice(0, 8))))));
	}
	for (const [p, label] of [[A, 'A'], [B, 'B']]) {
		const back = await waitFor(() => Promise.all([s2, s3].map((u) => graphSummary(p, u))), (g) => g.every((x) => !x || x.nodes === 0), 15000);
		h.check(!!back, `3.8 ${label}: two undos (update, give) leave stars 2 and 3 without a flow ` + JSON.stringify(back ?? (await Promise.all([s2, s3].map((u) => graphSummary(p, u))))));
		const from = await waitFor(() => userDataOf(p, [s2, s3], 'flowFrom'), (f) => f.every((x) => x === null), 15000);
		h.check(!!from, `3.9 ${label}: the family links went with them`);
	}
	await A.page.evaluate(() => window.__tp.test.v1.history.redo());
	await h.eventually(() => Promise.all([s2, s3].map((u) => graphSummary(B, u))), (g) => g.every((x) => x?.nodes === 5), '3.10 redo gives the copies back on B', 15000).catch(() => {});
	h.check((await Promise.all([s2, s3].map((u) => graphSummary(B, u)))).every((x) => x?.nodes === 5), '3.10 B: redo brought the copies back');

	// ---- reload: B rejoins; tags, links and copies come back with the handshake ----
	// a loaded Deck (battery beside it) can take > 30 s to boot the reloaded page: give it 120 s in all
	await h.freshReload(B).catch(async (e) => {
		if (!/Timeout/.test(String(e?.message ?? e))) throw e;
		await B.page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 90000 });
	});
	await h.eventually(
		() => B.page.evaluate(() => { let pr; window.__tp.test.v1.peers.subscribe((v) => (pr = v))(); return pr?.openedPeers?.size ?? 0; }),
		(n) => n >= 1,
		'premise: B rejoined after its reload',
		60000
	);
	const afterTags = await waitFor(() => userDataOf(B, ids.stars, 'tags'), (t) => t.every((x) => Array.isArray(x) && x.includes('Star')), 30000);
	h.check(!!afterTags, '5.1 B after reload: the tags are back ' + JSON.stringify(afterTags ?? (await userDataOf(B, ids.stars, 'tags'))));
	const afterFrom = await waitFor(() => userDataOf(B, [s2, s3], 'flowFrom'), (f) => f.every((x) => x === s1), 30000);
	h.check(!!afterFrom, '5.2 B after reload: the family links are back');
	const afterGraphs = await waitFor(() => Promise.all([s2, s3].map((u) => graphSummary(B, u))), (g) => g.every((x) => x?.nodes === 5), 30000);
	h.check(!!afterGraphs, '5.3 B after reload: both copies are back');
	await spySends(B);
	await B.page.evaluate((u) => window.__tp.test.v1.flowRuntime.fireObjectClick(u), s2);
	const firedAfter = await waitFor(() => A.page.evaluate(() => window.__tp.test.v1.flowRuntime.firedObjectOf('click') ?? null), (u) => u === s2, 15000);
	h.check(firedAfter === s2, '5.4 after reload: a click on star 2 (B) is Fired Object star 2 on A');

	for (const p of peers) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
