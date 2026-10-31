// ROADMAP 56 C13 — what a session volume's messages may and may not do, from a client that does not
// use the app's buttons. Run: APP_URL='https://localhost:5437/' npm run e2e -- session-volume-limits
const h = require('./helpers.cjs');

const debug = (p) => p.page.evaluate(() => window.__stores.sessionVolumes.volumeDebug());
const rows = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))();
		return (v ?? []).map((x) => ({ name: x.name, host: x.host, folders: x.folders.length, hashes: x.items.map((i) => i.hash) }));
	});
const scenes = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return Object.fromEntries(Object.entries(m.scenes).map(([k, e]) => [k, e.history.length]));
	});
/** a raw message from one page to another */
const raw = (from, to, msg) =>
	from.page.evaluate(
		({ to, msg }) => {
			let p;
			window.__stores.peers.subscribe((x) => (p = x))();
			p.connections[to].send(msg);
		},
		{ to, msg }
	);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPage(browser, 'G');
	for (const p of [H, G]) await p.page.waitForFunction(() => !!window.__stores?.sessionVolumes && !!window.__stores?.levels, null, { timeout: 60000 });
	const fixture = await H.page.evaluate(async () => {
		const s = window.__stores;
		await s.explorer.loadExplorer();
		await s.explorer.clearLibrary();
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		const other = await s.levels.saveSceneAsLevel('Other', null);
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		const open = await s.levels.saveSceneAsLevel('Open', null);
		const bytes = crypto.getRandomValues(new Uint8Array(65536));
		const big = new Uint8Array(12 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 65536) big.set(bytes.subarray(0, Math.min(65536, big.length - i)), i);
		big[0] = Date.now() % 256;
		const file = await s.explorer.addItemFromBytes(big.buffer, 'big.bin', null, { imported: true });
		big[1] = 7;
		await s.explorer.addItemFromBytes(big.buffer, 'big2.bin', null, { imported: true });
		return { other: other.hash, open: open.hash, big: file.hash };
	});

	// ---- a tab that asks to join tells the other side nothing -----------------------------------
	await h.connect(G, H);
	await h.eventually(() => rows(G), (r) => r.length === 1, 'G joined and shows the session', 120000);
	h.check((await debug(G)).sentTo.length === 0, 'a joiner hands the host no listing of its own');
	h.check((await rows(H)).length === 0, 'the host mounts nothing from its guest');

	// ---- a listing names no content hash ----------------------------------------------------------
	await H.page.evaluate(() => window.__stores.sessionVolumes.setShareScope('library'));
	await h.eventually(() => rows(G), (r) => r[0].hashes.length >= 3, 'the wider scope reaches G', 30000);
	const listed = (await rows(G))[0].hashes;
	h.check(!listed.some((x) => [fixture.other, fixture.open, fixture.big].includes(x)), 'rows carry handles, not content hashes');

	// ---- a save request is about the open scene only ------------------------------------------------
	const before = await scenes(H);
	await raw(G, H.id, { type: 'volsave', id: 'x1', name: 'Other' });
	await G.page.waitForTimeout(4000);
	const after = await scenes(H);
	h.check(after.Other === before.Other, `the request cannot name another scene (${before.Other} -> ${after.Other})`);

	// ---- repeats add nothing --------------------------------------------------------------------
	for (let i = 0; i < 40; i++) await raw(G, H.id, { type: 'getasset', hash: fixture.big });
	await H.page.waitForTimeout(1500);
	const outs = await H.page.evaluate((hash) => {
		let t;
		window.__stores.transferLedger.transfers.subscribe((v) => (t = v))();
		return t.filter((x) => x.dir === 'out' && x.hash === hash).length;
	}, fixture.big);
	h.check(outs <= 1, `40 requests for one file make one send (${outs})`);
	await H.page.evaluate((hash) => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		return window.__stores.assetShare.stopSendingTo(Object.keys(p.connections)[0], hash);
	}, fixture.big).catch(() => {});

	// ---- a hostile listing or announcement costs the receiver nothing -----------------------------
	const alive = async (label) => h.check((await G.page.evaluate(() => 1 + 1).catch(() => 0)) === 2, label);
	await raw(H, G.id, {
		type: 'volidx',
		rev: 99,
		scope: 'library',
		host: 'H',
		role: 'editor',
		folders: [{ id: 'a', parentId: 'a', name: 'a' }, { id: 'a', parentId: null, name: 'a' }, { id: 'b', parentId: 'c', name: 'b' }, { id: 'c', parentId: 'b', name: 'c' }],
		items: []
	});
	await h.eventually(() => rows(G), (r) => r[0].folders === 3, 'a folder list is one row per id', 15000);
	await G.page.evaluate(() => window.__stores.explorerClose.set(false));
	await G.page.waitForTimeout(800);
	await alive('a looped folder list does not hang the Explorer');
	await raw(H, G.id, { type: 'assetstart', hash: 'x', size: 1, chunks: 4294967295 });
	await G.page.waitForTimeout(500);
	await alive('an impossible announcement is ignored');

	// ---- narrowing stops a send already running ----------------------------------------------------
	await H.page.evaluate(() => window.__stores.sessionVolumes.setShareScope('project'));
	await H.page.waitForTimeout(1000);
	await H.page.evaluate(() => window.__stores.sessionVolumes.setShareScope('library'));
	await h.eventually(() => rows(G), (r) => r[0].hashes.length >= 3, 'the listing comes back', 90000);
	const running = G.page.evaluate(async () => {
		let v;
		window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))();
		const vol = v[0];
		const row = vol.items.find((i) => i.name === 'big2.bin');
		if (!row) return 'no row';
		const blob = await window.__stores.sessionVolumes.sessionVolumeBlob(vol.id, row.id, { confirmed: true });
		return blob ? blob.size : null;
	});
	await h.eventually(
		() => H.page.evaluate(() => {
			let t;
			window.__stores.transferLedger.transfers.subscribe((v) => (t = v))();
			return t.some((x) => x.dir === 'out' && x.state === 'active');
		}),
		(a) => a === true,
		'premise: a send is running',
		30000
	);
	await H.page.evaluate(() => window.__stores.sessionVolumes.setShareScope('none'));
	const ended = await Promise.race([running, new Promise((r) => setTimeout(() => r('timeout'), 90000))]);
	h.check(ended === null, `narrowing to None ends the running send (${ended})`);

	const errs = [...(await h.pageErrors(H)), ...(await h.pageErrors(G))];
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	await h.finish(browser);
});
