// A file asked for by its content hash follows the host's CURRENT sharing settings, two real peers.
//
// H hosts, G joins. Each ask is a raw `getasset`, because the point is what H answers whatever a peer sends:
//   1. Whole library: an unshared file is answered (the grant);
//   2. H narrows to None: the same file and another one are refused, no bytes, no thumbnail;
//   3. what the session needs still travels at None: the open scene's file, a file the scene references,
//      a file shared by hand; an unshare takes that last one back;
//   4. a private scene's files do not travel;
//   5. narrowing ends a send already running;
//   6. the CURRENT version of the project's other scenes travels (a travel by name pulls it) under every scope but
//      None and a private scene; an older version of another scene does not.
//
// Run: APP_URL='https://localhost:5990/' npm run e2e -- asset-ask-scope
const h = require('./helpers.cjs');

const debug = (p) => p.page.evaluate(() => window.__stores.sessionVolumes.volumeDebug());
const holds = (p, hash) => p.page.evaluate((x) => !!window.__stores.explorer.itemByHash(x), hash);
const ask = (p, host, hash, extra = {}) =>
	p.page.evaluate(
		([id, x, more]) => {
			let peers;
			window.__stores.peers.subscribe((v) => (peers = v))();
			peers.connections[id].send({ type: 'getasset', hash: x, ...more });
		},
		[host.id, hash, extra]
	);
const refusals = async (p, hash) => (await debug(p)).log.filter((l) => l.startsWith('refused getasset ' + hash.slice(0, 12))).length;
const setScope = (p, scope) => p.page.evaluate((s) => window.__stores.sessionVolumes.setShareScope(s), scope);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPage(browser, 'G');
	for (const peer of [H, G]) {
		await peer.page.waitForFunction(() => !!window.__stores?.sessionVolumes && !!window.__stores?.explorer && !!window.__stores?.levels, null, { timeout: 60000 });
		await peer.page.evaluate(async () => {
			const s = window.__stores;
			await s.explorer.loadExplorer();
			await s.explorer.clearLibrary();
			s.levels.currentLevel.set(null);
		});
	}

	const f = await H.page.evaluate(async () => {
		const s = window.__stores;
		const add = async (name, text) => {
			const item = await s.explorer.addItemFromBytes(new TextEncoder().encode(text).buffer, name, null);
			return item.hash;
		};
		const c = document.createElement('canvas');
		c.width = c.height = 32;
		c.getContext('2d').fillRect(0, 0, 32, 32);
		const png = await new Promise((r) => c.toBlob(r, 'image/png'));
		const photo = await s.explorer.addItemFromBytes(await png.arrayBuffer(), 'photo.png', null);
		const big = new Uint8Array(20 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;
		const bigItem = await s.explorer.addItemFromBytes(big.buffer, 'big.bin', null);
		const out = {
			granted: await add('granted.txt', 'granted first, withdrawn later'),
			other: await add('other.txt', 'never pulled by anyone'),
			referenced: await add('referenced.txt', 'only a reference in the scene names this'),
			byHand: await add('byhand.txt', 'shared by hand'),
			photo: photo.hash,
			big: bigItem.hash
		};
		const saveAs = async (name) => {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1300));
			s.objectActions.deselectObject();
			return (await s.levels.saveSceneAsLevel(name, null)).hash;
		};
		// two other scenes of the project first (Hall saved twice: an older and a current version); Castle is
		// the one H stands in
		out.hallOld = await saveAs('Hall');
		out.hall = await saveAs('Hall');
		out.yard = await saveAs('Yard');
		out.scene = await saveAs('Castle');
		return out;
	});
	h.check(!!f.granted && !!f.scene && !!f.big, 'premise: H holds its files and the saved scene');

	await h.connect(G, H);
	await h.eventually(() => debug(H), (d) => d.sentTo.includes(G.id), 'premise: G is H\'s guest', 30000);

	// ---- 1. the grant ------------------------------------------------------------------------------
	await setScope(H, 'library');
	await H.page.waitForTimeout(800);
	await ask(G, H, f.granted);
	await h.eventually(() => holds(G, f.granted), (x) => x === true, 'Whole library: the unshared file is answered (the grant)', 20000);

	// ---- 2. narrowed: the same request is refused -----------------------------------------------------
	await setScope(H, 'none');
	await H.page.waitForTimeout(800);
	const before = await refusals(H, f.granted);
	await ask(G, H, f.granted);
	await h.eventually(() => refusals(H, f.granted), (n) => n === before + 1, 'None: H refuses the same file when it is asked again', 15000);
	await ask(G, H, f.other);
	await h.eventually(() => refusals(H, f.other), (n) => n >= 1, 'None: H refuses another file it used to show', 15000);
	await G.page.waitForTimeout(1500);
	h.check(!(await holds(G, f.other)), '…and no bytes reached G');
	await ask(G, H, f.photo, { thumb: true });
	await h.eventually(() => refusals(H, f.photo), (n) => n >= 1, 'None: a thumbnail is refused the same way', 15000);
	const thumb = await G.page.evaluate((x) => {
		let t;
		window.__stores.assetShare.sharedThumbs.subscribe((v) => (t = v))();
		return !!t[x];
	}, f.photo);
	h.check(!thumb, '…and no thumbnail reached G');
	// the one that started it all: narrowing part of the way, Whole library -> Current scene's files
	await setScope(H, 'library');
	await H.page.waitForTimeout(800);
	await setScope(H, 'scene');
	await H.page.waitForTimeout(800);
	const n2 = await refusals(H, f.other);
	await ask(G, H, f.other);
	await h.eventually(() => refusals(H, f.other), (n) => n === n2 + 1, "Current scene's files: a file outside the scene is refused", 15000);

	// ---- 3. what the session needs still travels ---------------------------------------------------------
	await setScope(H, 'none');
	await H.page.waitForTimeout(800);
	await ask(G, H, f.scene);
	await h.eventually(() => holds(G, f.scene), (x) => x === true, "None: the open scene's own file still travels", 20000);
	await H.page.evaluate((x) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		group.children.find((c) => c.isMesh).userData.anAssetReference = x;
	}, f.referenced);
	// the answerer re-reads its scene at most every 5 s, and the refusals above have just read it
	await H.page.waitForTimeout(5500);
	await ask(G, H, f.referenced);
	await h.eventually(() => holds(G, f.referenced), (x) => x === true, 'None: a file the scene references still travels, read from the scene itself', 20000);
	const byHandId = await H.page.evaluate((x) => {
		const s = window.__stores;
		const item = s.explorer.itemByHash(x);
		s.sharedLibrary.shareItem(item.id);
		return item.id;
	}, f.byHand);
	await H.page.waitForTimeout(600);
	await h.eventually(() => holds(G, f.byHand), (x) => x === true, 'a file shared by hand travels at None', 30000);
	await H.page.evaluate((id) => window.__stores.sharedLibrary.unshareItem?.(id), byHandId);
	await H.page.waitForTimeout(1000);
	const n3 = await refusals(H, f.byHand);
	await ask(G, H, f.byHand);
	await h.eventually(() => refusals(H, f.byHand), (n) => n === n3 + 1, '…and unsharing it takes it back', 15000);

	// ---- 4. a private scene ---------------------------------------------------------------------------
	await H.page.evaluate(() => window.__stores.levels.currentLevel.update((l) => ({ ...l, private: true })));
	const n4 = await refusals(H, f.scene);
	await ask(G, H, f.scene);
	await h.eventually(() => refusals(H, f.scene), (n) => n === n4 + 1, "a private scene's file does not travel", 15000);
	await H.page.evaluate(() => window.__stores.levels.currentLevel.update((l) => ({ ...l, private: false })));

	// ---- 5. a running send -------------------------------------------------------------------------------
	await setScope(H, 'library');
	await H.page.waitForTimeout(800);
	await ask(G, H, f.big);
	await h.eventually(
		() => H.page.evaluate(() => {
			let t;
			window.__stores.transferLedger.transfers.subscribe((v) => (t = v))();
			return t.some((x) => x.dir === 'out' && x.state === 'active');
		}),
		(a) => a === true,
		'premise: the big file is being sent',
		30000
	);
	await setScope(H, 'none');
	await G.page.waitForTimeout(8000);
	h.check(!(await holds(G, f.big)), 'narrowing ends a send already running: the file never completes on G');

	// ---- 6. the project's other scenes -------------------------------------------------------------------
	const scenes = await H.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return Object.fromEntries(Object.entries(m?.scenes ?? {}).map(([k, e]) => [k, e.history]));
	});
	h.check(
		scenes.Hall?.at(-1) === f.hall && scenes.Hall?.includes(f.hallOld) && f.hallOld !== f.hall && scenes.Yard?.at(-1) === f.yard,
		`premise: the manifest's current Hall and Yard, and an older Hall (${JSON.stringify(scenes)})`
	);
	h.check(!(await holds(G, f.hall)) && !(await holds(G, f.yard)) && !(await holds(G, f.hallOld)), 'premise: G holds none of them');
	const n6 = await refusals(H, f.hall);
	await ask(G, H, f.hall);
	await h.eventually(() => refusals(H, f.hall), (n) => n === n6 + 1, 'None: another project scene is refused', 15000);
	await setScope(H, 'scene');
	await H.page.evaluate(() => window.__stores.levels.currentLevel.update((l) => ({ ...l, private: true })));
	await H.page.waitForTimeout(800);
	const n7 = await refusals(H, f.yard);
	await ask(G, H, f.yard);
	await h.eventually(() => refusals(H, f.yard), (n) => n === n7 + 1, 'from a private scene: another project scene is refused', 15000);
	await H.page.evaluate(() => window.__stores.levels.currentLevel.update((l) => ({ ...l, private: false })));
	await H.page.waitForTimeout(800);
	const n8 = await refusals(H, f.hallOld);
	await ask(G, H, f.hallOld);
	await h.eventually(() => refusals(H, f.hallOld), (n) => n === n8 + 1, "Current scene's files: an older version of another scene is refused", 15000);
	await G.page.waitForTimeout(1500);
	h.check(!(await holds(G, f.hallOld)), '…and no bytes of it reached G');
	await ask(G, H, f.hall);
	await h.eventually(() => holds(G, f.hall), (x) => x === true, "Current scene's files: another scene's current version travels (travel by name)", 20000);
	const errs = [...(await h.pageErrors(H)), ...(await h.pageErrors(G))];
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	await h.finish(browser);
});
