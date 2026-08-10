// B5: a joiner pulls the scene ONCE, not once per peer.
//
// The handshake's full-state requests (getobjects/getnodes/getannotations/
// getjoints/getnodedefs) used to ride EVERY conn open: the `hosts` mesh-fill
// dials defaulted to getobjects=true, so the Nth joiner downloaded N-1 copies
// of the same scene (the stress harness measured exactly 3x at N=4), and the
// adopted-inbound handshake asked the NEWCOMER for its objects right back —
// which could even pop a bogus share-or-stash prompt. Full state now flows only
// along join/approve relationships: joiner <-> host, each direction once.
// getmodulestate stays on every handshake — it's the one PER-PEER payload in
// the family (each peer answers with its own module/campreview state).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPage(browser, 'C');

	// count get* requests arriving at each peer, by sender — hooked from the
	// start so the join dance is fully covered (conns appear over time, so keep
	// rescanning; peerjs conns are EventEmitters, a second listener is free)
	for (const p of [A, B, C]) {
		await p.page.evaluate(() => {
			const w = window;
			let pc;
			w.__stores.peers.subscribe((v) => (pc = v))();
			const seen = new WeakSet();
			w.__rx = {};
			const hook = (c) => {
				if (!c || c.type !== 'data' || seen.has(c)) return;
				seen.add(c);
				c.on('data', (d) => {
					if (!d || !String(d.type ?? '').startsWith('get')) return;
					const from = d.sender ?? c.peer;
					(w.__rx[from] = w.__rx[from] || []).push(d.type);
				});
			};
			setInterval(() => {
				for (const k of Object.keys(pc.connections)) hook(pc.connections[k]);
				const raw = pc.peer.connections || {};
				for (const k of Object.keys(raw)) (raw[k] || []).forEach(hook);
			}, 150);
		});
	}

	// host A owns a scene
	await A.page.evaluate(() => {
		for (let i = 0; i < 5; i++) window.__stores.commandsHandler.sceneCommand('/create box');
	});
	await A.page.waitForTimeout(1000);

	await h.connect(B, A);
	await h.connect(C, A); // C meshes with B via the hosts flow

	const countOn = (p) =>
		p.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g?.children?.length ?? 0;
		});
	const aCount = await countOn(A);
	await h.eventually(() => countOn(C), (c) => c === aCount, 'C received the scene (count matches A)', 15000);
	await h.eventually(
		() =>
			C.page.evaluate(() => {
				let pc;
				window.__stores.peers.subscribe((v) => (pc = v))();
				return pc.openedPeers.size;
			}),
		(n) => n === 2,
		'C holds open conns to both A and B'
	);

	const rx = {};
	for (const p of [A, B, C]) rx[p.id] = await p.page.evaluate(() => window.__rx);

	const objReqs = (at, from) => (rx[at.id][from.id] || []).filter((t) => t === 'getobjects').length;
	// full state flows along the join/approve edges, once per direction
	h.check(objReqs(A, B) === 1, 'B asked A for objects exactly once (got ' + objReqs(A, B) + ')');
	h.check(objReqs(B, A) === 1, 'A asked B for objects exactly once — the merge direction (got ' + objReqs(B, A) + ')');
	h.check(objReqs(A, C) === 1, 'C asked A for objects exactly once (got ' + objReqs(A, C) + ')');
	// ...and NOT along the mesh-fill edge
	h.check(objReqs(B, C) === 0, 'C did not re-request the scene from B (got ' + objReqs(B, C) + ')');
	h.check(objReqs(C, B) === 0, 'B did not request the scene from joiner C (got ' + objReqs(C, B) + ')');

	// the per-peer request still rides every handshake, including the mesh edge
	const modReqs = (at, from) => (rx[at.id][from.id] || []).filter((t) => t === 'getmodulestate').length;
	h.check(modReqs(B, C) >= 1, 'the mesh edge still exchanges getmodulestate (per-peer payload)');

	// and nobody got the share-or-stash prompt out of the mesh fill
	const bInfo = await B.page.evaluate(() => {
		let t;
		window.__stores.toastStore.subscribe((v) => (t = v))();
		return (t || []).map((x) => (x && x.id) || '');
	});
	h.check(!bInfo.includes('share-or-stash'), 'no bogus share-or-stash prompt on an existing peer');

	await h.finish(browser);
});
