// 36 U9 — EDIT WHILE LOADING, ACROSS PEERS. A kit piece arrives on both peers as a stub (the
// ordinary `object` message a placement / session load sends), both draw a placeholder while the
// file is held, A moves the placeholder through the Inspector, and B sees the move on its own
// placeholder; when the file arrives, BOTH models land where A put the box. Then a 404 is red
// on both peers and A's Replace model… (same uuid) reaches B and fills there too.
//
//   APP_URL=https://theprototype.app:5324/ node tests/e2e/placeholders-peers.test.cjs
const h = require('./helpers.cjs');
const { startFaultServer } = require('./faultServer.cjs');

const BOX = [-0.6, 0, -0.5, 0.6, 1.2, 0.5];

async function until(fn, predicate, label, timeout = 15000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	console.log('  last: ' + JSON.stringify(last)?.slice(0, 600));
	h.check(false, label);
	return last;
}

const facts = (peer, uuid) =>
	peer.page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		const info = s.packRefs.stubLoadInfo(o);
		return {
			stub: !!o.userData.packStub,
			children: o.children.length,
			pos: o.position.toArray().map((v) => Math.round(v * 1000) / 1000),
			path: o.userData.packRef?.path ?? null,
			phase: info?.load?.phase ?? (info ? 'pending' : 'done'),
			drawn: s.placeholders.placeholderInstances().some((i) => i.uuid === uuid)
		};
	}, uuid);

/** A adds a stub and broadcasts it the way a placement of a pristine piece does (sendObjects' stub path). */
const shareStub = (peer, url, pos) =>
	peer.page.evaluate(
		({ url, pos, box }) => {
			const s = window.__stores;
			let g, p;
			s.objectsGroup.subscribe((v) => (g = v))();
			s.peers.subscribe((v) => (p = v))();
			const stub = new g.constructor();
			stub.name = 'Piece';
			stub.position.set(pos[0], pos[1], pos[2]);
			stub.userData = { packRef: { pack: 'test', item: 'Piece', path: url, box }, packStub: true };
			g.add(stub);
			s.pokeScene();
			p.send({ type: 'object', element: s.packRefs.stubElementOf(stub) });
			return stub.uuid;
		},
		{ url, pos, box: BOX }
	);

h.run(async () => {
	const fsrv = await startFaultServer({});
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { storage: { placeholderStuckSeconds: '120' } });
	const B = await h.setupPage(browser, 'B', { storage: { placeholderStuckSeconds: '120' } });
	await h.connect(B, A);

	// ---- 1. a move while loading replicates, and both models land on it --------------------
	const held = await shareStub(A, fsrv.url('hold', 'Shared'), [0, 0, 0]);
	await until(() => facts(B, held), (f) => f?.stub && f.drawn, 'B receives the stub and draws its placeholder');
	h.check((await facts(A, held))?.drawn, 'A draws it too');
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), held);
	await A.page.waitForSelector('#load-state-panel', { timeout: 8000 }).catch(() => {});
	await A.page.locator('#inspector-position .dn-wrap').first().click();
	await A.page.locator('#inspector-position .dn-input').first().fill('2.5');
	await A.page.keyboard.press('Enter');
	await until(() => facts(B, held), (f) => f?.pos[0] === 2.5 && f.stub, "B's placeholder follows A's edit while both are still loading");
	fsrv.release('/hold/Shared.glb');
	const a = await until(() => facts(A, held), (f) => f && !f.stub && f.children > 0, 'the model arrives on A');
	const b = await until(() => facts(B, held), (f) => f && !f.stub && f.children > 0, 'the model arrives on B');
	h.check(a?.pos[0] === 2.5 && b?.pos[0] === 2.5, `both models landed at the moved position (A ${a?.pos}, B ${b?.pos})`);

	// ---- 2. red on both, Replace model… replicates (same uuid) -------------------------------
	const gone = await shareStub(A, fsrv.url('404', 'Gone'), [-2, 0, 0]);
	await until(() => facts(A, gone), (f) => f?.phase === 'failed', 'a 404 is red on A');
	await until(() => facts(B, gone), (f) => f?.phase === 'failed', '…and on B (each peer fetches for itself)');
	const okUrl = fsrv.url('ok', 'Instead');
	await A.page.evaluate(({ u, url }) => window.__stores.replaceModel.replaceWithPackItem(u, { glbUrl: url, name: 'Instead', packName: 'test' }), { u: gone, url: okUrl });
	const rb = await until(() => facts(B, gone), (f) => f && !f.stub && f.children > 0, "A's Replace model… fills on B under the same uuid");
	h.check(rb?.path === okUrl && rb?.pos[0] === -2, `B points at the new file at the old place (${rb?.pos})`);

	await fsrv.close();
	await h.finish(browser);
});
