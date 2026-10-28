// ROADMAP 56 C13 — THE HOST'S SESSION AS A READ-ONLY EXPLORER VOLUME, two real peers.
//
// H hosts, G joins. What the brief asks the suite to SEE, in order:
//   1. join → "<H>'s session" appears on G above the Library, showing ONLY the files of H's open
//      scene (the default share scope) — H's other files are not even named;
//   2. the rows (names, sizes) arrive with the join and NO bytes do (G's pull count stays 0);
//      a pull for a hash H did not offer is refused BY H (the guard, measured from the guest's side);
//   3. H widens the scope → the rows are resent; Open a text file → it opens read-only, its bytes
//      pulled ONCE, nothing lands in G's Library;
//   4. Copy to my library → one ordinary Library file on G, same name, same bytes (hash);
//   5. Save on host → the session's scene is saved into H's library (H sees the new version);
//   6. G made a viewer → Save on host is disabled with the reason, and H refuses a raw request too;
//   7. H's scope None → G's rows disappear;
//   8. G leaves → the volume unmounts, and G's Library is exactly what it was plus the one copy.
//
// Run: APP_URL='https://localhost:5482/' npm run e2e -- session-volume
const h = require('./helpers.cjs');

const vols = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))();
		return (v ?? []).map((x) => ({
			id: x.id,
			host: x.host,
			scope: x.scope,
			role: x.role,
			items: x.items.map((i) => ({ id: i.id, name: i.name, size: i.size, hash: i.hash, thumb: !!i.thumbnail }))
		}));
	});

const debug = (p) => p.page.evaluate(() => window.__stores.sessionVolumes.volumeDebug());

const library = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).map((i) => ({ name: i.name, hash: i.hash, folderId: i.folderId ?? null, kind: i.kind })).sort((a, b) => (a.name + a.hash).localeCompare(b.name + b.hash));
	});

const toasts = (p) => p.page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.innerText.trim()));

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPage(browser, 'G');
	for (const peer of [H, G]) {
		await peer.page.waitForFunction(() => !!window.__stores?.sessionVolumes && !!window.__stores?.explorer && !!window.__stores?.levels, null, {
			timeout: 60000
		});
		await peer.page.evaluate(async () => {
			const s = window.__stores;
			await s.explorer.loadExplorer();
			await s.explorer.clearLibrary();
			s.levels.currentLevel.set(null);
		});
	}

	// ---- the fixture: H has a saved scene and two files the scene does not use ------------------
	const fixture = await H.page.evaluate(async () => {
		const s = window.__stores;
		const enc = new TextEncoder();
		const notes = await s.explorer.addItemFromBytes(enc.encode('hello from the host\n').buffer, 'notes.txt', null);
		const c = document.createElement('canvas');
		c.width = c.height = 32;
		const g = c.getContext('2d');
		g.fillStyle = 'rgb(200, 40, 40)';
		g.fillRect(0, 0, 32, 32);
		const png = await new Promise((r) => c.toBlob(r, 'image/png'));
		const photo = await s.explorer.addItemFromBytes(await png.arrayBuffer(), 'photo.png', null);
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		const saved = await s.levels.saveSceneAsLevel('Castle', null);
		return { notes: notes && { hash: notes.hash, size: notes.size }, photo: photo && { hash: photo.hash, size: photo.size }, scene: saved && saved.hash };
	});
	h.check(!!fixture.notes && !!fixture.photo && !!fixture.scene, `premise: H holds notes.txt, photo.png and the saved scene "Castle" (${JSON.stringify(fixture)})`);
	const scope0 = await H.page.evaluate(() => {
		let v;
		window.__stores.sessionVolumes.shareScope.subscribe((x) => (v = x))();
		return v;
	});
	h.check(scope0 === 'scene', `premise: H's share scope is the default, Current scene's files (${scope0})`);

	// G: one file of its own, an empty unnamed world (so the connect decision does not ask)
	await G.page.evaluate(async () => {
		const s = window.__stores;
		await s.explorer.addItemFromBytes(new TextEncoder().encode('mine').buffer, 'mine.txt', null);
	});
	const gBefore = await library(G);
	h.check(gBefore.length === 1 && gBefore[0].name === 'mine.txt', `premise: G's Library holds only mine.txt (${gBefore.map((i) => i.name).join(', ')})`);

	await h.connect(G, H);

	// ---- 1. the volume appears, showing the current scene's files only --------------------------
	await h.eventually(
		() => vols(G),
		(v) => v.length === 1 && v[0].items.some((i) => i.name === 'Castle.tpscene'),
		"joining mounts \"H's session\" on G with the open scene's file in it",
		30000
	);
	let v = (await vols(G))[0];
	h.check(v.scope === 'scene' && v.role === 'editor', `…its scope is Current scene's files and G is an editor (${v.scope}/${v.role})`);
	h.check(
		!v.items.some((i) => i.name === 'notes.txt' || i.name === 'photo.png'),
		`…and H's other files are not even named (${v.items.map((i) => i.name).join(', ')})`
	);
	h.check((await debug(G)).pullCount === 0, 'the rows came with the join and no bytes did (pull count 0)');

	await G.page.locator('#explorer-slot').click();
	await G.page.waitForTimeout(900);
	const banner = G.page.locator('[data-session-banner]');
	await h.eventually(() => banner.count(), (n) => n === 1, 'the Explorer shows the "You\'re in …\'s session" banner', 10000);
	h.check(/You're in .+'s session/.test(await banner.innerText()), `…which says where you are (${await banner.innerText()})`);
	const row = G.page.locator('button[data-session-volume]');
	h.check((await row.count()) === 1, 'the session is a root of its own in the tree');
	const treeOrder = await G.page.evaluate(() => {
		const s = document.querySelector('#explorer-sessions');
		const m = document.querySelector('#explorer-mounts') ?? [...document.querySelectorAll('#explorer-tree button')].find((b) => /^\s*Library/.test(b.textContent ?? ''));
		return !!s && (!m || !!(s.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING));
	});
	h.check(treeOrder, '…above the mounts and the Library');

	// ---- 2. the host is the guard: a hash it did not offer is refused ---------------------------
	await G.page.evaluate(
		({ host, hash }) => {
			let p;
			window.__stores.peers.subscribe((x) => (p = x))();
			p.connections[host].send({ type: 'volget', hash });
		},
		{ host: H.id, hash: fixture.notes.hash }
	);
	await h.eventually(
		() => debug(H),
		(d) => d.log.some((l) => l.startsWith('refused volget ' + fixture.notes.hash.slice(0, 12))),
		'a raw pull for notes.txt (not in the scene scope) is REFUSED by H',
		10000
	);
	h.check((await library(G)).length === 1, '…and nothing reached G');

	// ---- 3. H widens the scope; Open pulls once, read-only, and imports nothing -----------------
	await H.page.evaluate(() => window.__stores.sessionVolumes.setShareScope('library'));
	await h.eventually(
		() => vols(G),
		(vs) => vs[0]?.scope === 'library' && ['notes.txt', 'photo.png'].every((n) => vs[0].items.some((i) => i.name === n)),
		"H choosing Whole library resends the rows: notes.txt and photo.png appear",
		15000
	);
	v = (await vols(G))[0];
	const notesRow = v.items.find((i) => i.name === 'notes.txt');
	const photoRow = v.items.find((i) => i.name === 'photo.png');
	h.check(notesRow.size === fixture.notes.size && photoRow.size === fixture.photo.size, `each row carries its size (${notesRow.size}, ${photoRow.size})`);
	h.check((await debug(G)).pullCount === 0, '…and still no bytes moved');
	await h.eventually(() => vols(G), (vs) => vs[0]?.items.find((i) => i.name === 'photo.png')?.thumb === true, "the image's thumbnail rode after the rows", 10000);

	await row.click();
	await G.page.waitForTimeout(800);
	const notesCard = G.page.locator('.ex-cards .explorer-card').filter({ hasText: 'notes.txt' }).first();
	await h.eventually(() => notesCard.count(), (n) => n === 1, "notes.txt is a card inside the session volume", 10000);
	await notesCard.dblclick();
	await h.eventually(() => G.page.locator('#text-editor-readonly').count(), (n) => n === 1, 'Open shows it in the text editor marked Read-only', 20000);
	h.check((await G.page.locator('#text-editor-save').count()) === 0, '…with no Save button');
	// the editor's document (CodeEditor draws it lazily, so read what it was handed)
	const shown = await G.page.evaluate(() => {
		let t;
		window.__stores.fileWindows.textEditorTarget.subscribe((x) => (t = x))();
		return { code: t?.code ?? '', readOnly: !!t?.readOnly };
	});
	h.check(/hello from the host/.test(shown.code) && shown.readOnly, `the editor holds the host's bytes, read-only (${JSON.stringify(shown)})`);
	const afterOpen = await debug(G);
	h.check(afterOpen.pullCount === 1, `the bytes were pulled once, by hash (${afterOpen.pullCount})`);
	const answered = (await debug(H)).log.filter((l) => l.startsWith('answer volget')).length;
	h.check(answered === 1, `H answered exactly one pull (${answered})`);
	h.check(JSON.stringify(await library(G)) === JSON.stringify(gBefore), "Open imported nothing into G's Library");
	await G.page.keyboard.press('Escape');
	await G.page.waitForTimeout(400);

	// ---- 4. Copy to my library ------------------------------------------------------------------
	const photoCard = G.page.locator('.ex-cards .explorer-card').filter({ hasText: 'photo.png' }).first();
	await photoCard.click({ button: 'right' });
	await G.page.waitForSelector('[role=menuitem]', { timeout: 20000 });
	await G.page.locator('[role=menuitem]', { hasText: 'Copy to my library' }).first().click();
	await h.eventually(
		() => library(G),
		(l) => l.some((i) => i.name === 'photo.png' && i.hash === fixture.photo.hash),
		'Copy to my library lands photo.png in G\'s Library with the host\'s exact bytes',
		20000
	);
	h.check((await debug(G)).pullCount === 2, 'one more pull, for the one file copied');

	// ---- 5. Save on host ------------------------------------------------------------------------
	await G.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1300));
		window.__stores.objectActions.deselectObject();
	});
	await h.eventually(
		() => H.page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return g.children.length; }),
		(n) => n === 2,
		"premise: G's edit reached H's world",
		15000
	);
	const saveBtn = G.page.locator('button[id^="session-save-"]');
	h.check(!(await saveBtn.isDisabled()), 'an editor has Save on host');
	await saveBtn.click();
	await h.eventually(() => toasts(G), (t) => t.some((x) => /Saved "Castle" on .+'s device/.test(x)), 'G is told the scene was saved on the host', 30000);
	const hostScenes = await H.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).filter((i) => i.kind === 'scene').map((i) => i.hash);
	});
	h.check(hostScenes.some((x) => x !== fixture.scene), `H's library holds the new version of Castle (${hostScenes.length} scene record(s))`);
	h.check((await debug(H)).log.some((l) => /^volsave from .+: saved Castle/.test(l)), '…saved through the host-side path');
	h.check(!(await library(G)).some((i) => i.kind === 'scene'), "…and nothing was saved into G's own Library");

	// ---- 6. a viewer has no Save on host --------------------------------------------------------
	await H.page.evaluate((gid) => {
		window.__stores.cloudHooks.rolesInfo.set({
			myId: 'host',
			myRole: 'admin',
			amAdmin: true,
			order: [],
			roleOf: (id) => (id === gid ? 'viewer' : 'editor'),
			setRole() {}
		});
	}, G.id);
	await h.eventually(() => vols(G), (vs) => vs[0]?.role === 'viewer', 'H making G a viewer is resent to G', 15000);
	await h.eventually(() => saveBtn.isDisabled(), (d) => d === true, "the viewer's Save on host is disabled", 5000);
	h.check(/view-only/.test((await saveBtn.getAttribute('title')) ?? ''), `…with the reason (${await saveBtn.getAttribute('title')})`);
	h.check(/view-only/.test(await banner.innerText()), '…and the banner says view-only');
	await G.page.evaluate((host) => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		p.connections[host].send({ type: 'volsave', id: 'raw' });
	}, H.id);
	await h.eventually(
		() => debug(H),
		(d) => d.log.some((l) => /^volsave from .+: view-only/.test(l)),
		'a raw Save on host from the viewer is REFUSED by H itself',
		10000
	);
	await H.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	// ---- 7. scope None ------------------------------------------------------------------------
	await H.page.evaluate(() => window.__stores.sessionVolumes.setShareScope('none'));
	await h.eventually(() => vols(G), (vs) => vs[0]?.scope === 'none' && vs[0].items.length === 0, "H's scope None empties G's volume", 15000);
	await h.eventually(() => G.page.locator('.ex-cards .explorer-card').count(), (n) => n === 0, '…and the cards leave the grid', 5000);

	// ---- 8. leave -------------------------------------------------------------------------------
	await G.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		p.leaveSession();
	});
	await h.eventually(() => vols(G), (vs) => vs.length === 0, 'leaving the session unmounts the volume', 15000);
	h.check((await G.page.locator('#explorer-sessions').count()) === 0, '…and its tree root and banner');
	const gAfter = await library(G);
	const expected = [...gBefore, { name: 'photo.png', hash: fixture.photo.hash, folderId: null, kind: 'image' }].sort((a, b) => (a.name + a.hash).localeCompare(b.name + b.hash));
	h.check(
		JSON.stringify(gAfter.map((i) => [i.name, i.hash])) === JSON.stringify(expected.map((i) => [i.name, i.hash])),
		`G's Library is what it was plus the one copy, byte for byte (${gAfter.map((i) => i.name + ':' + i.hash.slice(0, 8)).join(', ')})`
	);

	await h.finish(browser);
});
