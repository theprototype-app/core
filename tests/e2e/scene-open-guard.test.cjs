// THE UNSAVED-CHANGES GUARD, AND THE NAME A SAVE USES — four reported bugs.
//
//   §1  BUG 3. "Open here (this screen)" called travelToLevel DIRECTLY, so the MENU
//       route skipped the guard the double-click route has. One destructive action,
//       two ways in, one of them guarded.
//   §2  BUG 2. The guard read `$sceneDirty`, which 21-G9 deliberately throttles to one
//       recomputation per 2s because it costs a whole-scene serialization. Edit, then
//       immediately open another scene, and it read a stale `false`: no dialog, work
//       gone. Plus the second half — a scene with NO identity to be dirty against
//       (a brand-new one) is exactly the least-saved work in the app, and was the one
//       thing the guard could never fire for.
//   §3  BUG 1a. Rename the FILE of the scene you are standing in, edit, save — and the
//       save landed under the OLD name, minting a second .tpscene beside the renamed
//       one, because `currentLevel.name` is the manifest key and nothing carried a
//       file rename into it.
//   §4  BUG 1b. "When I create a new scene the filename renames back to what it was":
//       every inline-editor opener ASSIGNED `editing`, so opening a second editor threw
//       the first one's typed value away silently.
//   §5  The download affordances: an icon on Download, and the all-versions archive
//       moved out of the item menu into the Version history header.
//
// Run: APP_URL='https://localhost:5202/' npm run e2e -- scene-open-guard
const h = require('./helpers.cjs');

const at = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

const itemNames = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.map((i) => i.name).sort();
	});

const sceneKeys = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		return Object.keys(m.scenes).sort();
	});

const worldUuids = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return (g?.children ?? []).map((c) => c.uuid).sort();
	});

const dialogOf = (p) =>
	p.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
		return d && { title: d.title, message: d.message, choices: (d.choices ?? []).map((c) => c.label) };
	});

const answerDialog = (p, value) =>
	p.page.evaluate((v) => window.__stores.confirmDialog.resolveConfirm(v), value);

const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		window.__stores.objectActions.deselectObject();
	});

/** a saved project scene holding one recognisable box; leaves the world holding it */
const seedScene = async (p, name) => {
	await addBox(p);
	const item = await p.page.evaluate((n) => window.__stores.levels.saveSceneAsLevel(n), name);
	await p.page.waitForTimeout(900);
	return item;
};

const wipe = async (p) => {
	await p.page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		await s.explorer.clearLibrary();
		s.projectManifest.manifestRestore({ scenes: {}, assets: [], changedAt: 1 }, false);
		s.levels.currentLevel.set(null);
	});
	await p.page.waitForTimeout(700);
};

const card = (p, name) => p.page.locator(`.explorer-card[title="${name}"]`).first();

const menuRows = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
			.map((el) => el.textContent?.trim())
			.filter(Boolean)
	);

/** rename a card through the REAL route: right-click, Rename, type, commit */
const renameCard = async (p, from, to, commit = "Enter") => {
	await closeMenu(p);
	await card(p, from).click({ button: "right" });
	await p.page.waitForTimeout(350);
	// a plain string, not an anchored regex: hasText matches raw textContent, and the
	// menu row carries the surrounding whitespace an anchored /^Rename$/ cannot
	await p.page
		.locator('[role="menu"] [role="menuitem"]')
		.filter({ hasText: 'Rename' })
		.first()
		.click();
	await p.page.waitForTimeout(350);
	// scoped to the CARD: the panel has its own .ui-input fields
	const input = p.page.locator(".explorer-card input.ui-input").first();
	await input.waitFor({ state: "visible", timeout: 10000 });
	await input.fill(to);
	if (commit) await input.press(commit);
	return input;
};

/** right-click real GRID BACKGROUND — a fixed offset lands on a card once the grid fills */
const gridBackgroundMenu = async (peer) => {
	const box = await peer.page.locator('#explorer-list [role="region"]').first().boundingBox();
	if (!box) return false;
	const pt = await peer.page.evaluate((b) => {
		for (let y = b.y + b.height - 8; y > b.y + 6; y -= 10)
			for (let x = b.x + b.width - 12; x > b.x + 10; x -= 24) {
				const el = document.elementFromPoint(x, y);
				if (!el || el.closest('.explorer-card, .explorer-folder-card')) continue;
				if (el.closest('#explorer-list')) return { x, y };
			}
		return null;
	}, box);
	if (!pt) return false;
	await peer.page.mouse.click(pt.x, pt.y, { button: 'right' });
	await peer.page.waitForTimeout(350);
	return true;
};

/** open a scene card's PROPERTIES the way a user does: right-click ▸ Version history */
const openVersionPanel = async (peer, fileName) => {
	await closeMenu(peer);
	await card(peer, fileName).click({ button: "right" });
	await peer.page.waitForTimeout(350);
	await peer.page
		.locator('[role="menu"] [role="menuitem"]')
		.filter({ hasText: 'Version history' })
		.first()
		.click();
	await peer.page.waitForTimeout(600);
};

const closeMenu = async (p) => {
	if (await p.page.locator('[role="menu"]').first().isVisible().catch(() => false))
		await p.page.keyboard.press('Escape');
	await p.page.waitForTimeout(250);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(300);

	// =====================================================================
	// 1. BUG 3 — the MENU route must honour the same guard as the double-click
	// =====================================================================
	await wipe(A);
	const alpha = await seedScene(A, 'Alpha');
	await addBox(A);
	const beta = await seedScene(A, 'Beta');
	h.check(
		!!alpha?.hash && !!beta?.hash && alpha.hash !== beta.hash,
		'premise: two project scenes, each a real file'
	);
	h.check((await at(A))?.name === 'Beta', 'premise: we are standing in Beta');

	// dirty Beta, then reach Alpha THROUGH THE MENU
	const strayA = (await worldUuids(A)).length;
	await addBox(A);
	h.check((await worldUuids(A)).length === strayA + 1, 'premise: Beta has an unsaved edit');
	// past the 2s throttle, so this section tests the ROUTE and not the freshness
	await A.page.waitForTimeout(2600);

	await closeMenu(A);
	await card(A, 'Alpha.tpscene').click({ button: 'right' });
	await A.page.waitForTimeout(350);
	const rows = await menuRows(A);
	h.check(
		rows.some((r) => /Open here/.test(r)),
		`premise: the menu offers Open here (${rows.join(' | ')})`
	);
	await A.page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: 'Open here' }).first().click();
	await h.eventually(
		() => dialogOf(A),
		(d) => !!d && /Alpha\.tpscene/.test(d.title ?? ''),
		'THE FIX: the menu route asks before replacing a scene with unsaved work'
	);
	const d1 = await dialogOf(A);
	h.check(
		JSON.stringify(d1?.choices) === JSON.stringify(['Save and open', 'Open anyway']),
		`…with the same three-way the double-click gives (${JSON.stringify(d1?.choices)})`
	);
	await answerDialog(A, false);
	await A.page.waitForTimeout(700);
	h.check((await at(A))?.name === 'Beta', 'Cancel from the menu route loads nothing');

	// =====================================================================
	// 2. BUG 2 — the verdict must be CURRENT, not the 2s-throttled one
	// =====================================================================
	// The whole point is the timing: edit and open IMMEDIATELY, inside the window in
	// which `$sceneDirty` is still false. Anything slower tests nothing.
	await A.page.evaluate(() => window.__stores.sceneIdentity.sceneDirty.set(false));
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
	});
	await A.page.waitForTimeout(350); // long enough to exist, far short of the 2s throttle
	const staleFlag = await A.page.evaluate(() => {
		let d;
		window.__stores.sceneIdentity.sceneDirty.subscribe((x) => (d = x))();
		return d;
	});
	h.check(
		staleFlag === false,
		`premise: the THROTTLED flag is still stale at this instant (${staleFlag}) — which is what used to lose the work`
	);
	await card(A, 'Alpha.tpscene').dblclick();
	await h.eventually(
		() => dialogOf(A),
		(d) => !!d,
		'THE FIX: the guard recomputes, so a just-made edit is still protected'
	);
	await answerDialog(A, false);
	await A.page.waitForTimeout(600);
	h.check((await at(A))?.name === 'Beta', '…and Cancel kept the edited scene');

	// --- the second half: a scene with NO identity at all ---
	await wipe(A);
	const gamma = await seedScene(A, 'Gamma');
	await A.page.evaluate(() => window.__stores.levels.currentLevel.set(null));
	await addBox(A);
	await A.page.waitForTimeout(400);
	h.check(
		(await at(A)) === null && (await worldUuids(A)).length > 0,
		'premise: real work on screen and no scene identity to be dirty against'
	);
	await card(A, 'Gamma.tpscene').dblclick();
	await h.eventually(
		() => dialogOf(A),
		(d) => !!d && /never been saved/i.test(d.message ?? ''),
		'a scene that has never been saved is guarded too, and the wording says why'
	);
	await answerDialog(A, false);
	await A.page.waitForTimeout(600);
	h.check((await worldUuids(A)).length > 0, '…and Cancel kept it');

	// =====================================================================
	// 3. BUG 1a — a file rename must reach the name the SAVE uses
	// =====================================================================
	await wipe(A);
	// a loose .tpscene: built here, imported as a drop, so the project never names it
	const looseBytes = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		s.objectActions.deselectObject();
		const payload = s.sessions.buildSessionPayload('cube');
		delete payload.workspace;
		const b = await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		return Array.from(b);
	});
	await wipe(A);
	await A.page.evaluate((arr) => {
		const f = new File([new Uint8Array(arr)], 'cube.tpscene', { type: 'application/zip' });
		const dt = new DataTransfer();
		dt.items.add(f);
		document
			.querySelector('#explorer-list')
			.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, looseBytes);
	await h.eventually(
		() => itemNames(A),
		(n) => n.includes('cube.tpscene'),
		'premise: cube.tpscene is in the library'
	);
	await card(A, 'cube.tpscene').dblclick();
	await h.eventually(
		() => at(A),
		(v) => v?.name === 'cube' && v?.unsaved === true,
		'premise: it opens as a LOOSE scene (the project has never heard of it)'
	);

	// rename the FILE through the real inline editor
	await renameCard(A, 'cube.tpscene', 'renamed.tpscene');
	await h.eventually(
		() => itemNames(A),
		(n) => n.includes('renamed.tpscene') && !n.includes('cube.tpscene'),
		'premise: the file really renamed'
	);
	h.check(
		(await at(A))?.name === 'renamed',
		`THE FIX: the open LOOSE scene moved with its file (${(await at(A))?.name})`
	);

	// now the reported sequence: edit, then save
	await addBox(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel(
		(() => { let v; window.__stores.levels.currentLevel.subscribe((x) => (v = x))(); return v.name; })()
	));
	await A.page.waitForTimeout(1400);
	const names = await itemNames(A);
	h.check(
		!names.includes('cube.tpscene'),
		`no phantom under the OLD name (${JSON.stringify(names)})`
	);
	h.check(
		(await sceneKeys(A)).includes('renamed') && !(await sceneKeys(A)).includes('cube'),
		`…and the project filed it under the name the user chose (${JSON.stringify(await sceneKeys(A))})`
	);

	// =====================================================================
	// 4. BUG 1b — opening a second inline editor must not discard the first
	// =====================================================================
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(300);
	const before = await itemNames(A);
	const target = before.find((n) => n.endsWith('.tpscene'));
	h.check(!!target, `premise: a card to rename (${target})`);
	// deliberately NOT committed — the next editor is what has to settle it
	await renameCard(A, target, 'typed-then-abandoned.tpscene', null);
	// …and now open ANOTHER inline editor without committing, the reported sequence
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await gridBackgroundMenu(A);
	const gridRows = await menuRows(A);
	if (gridRows.some((r) => /New scene/.test(r))) {
		await A.page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: 'New scene' }).first().click();
		await A.page.waitForTimeout(600);
		h.check(
			(await itemNames(A)).includes('typed-then-abandoned.tpscene'),
			`THE FIX: the pending rename COMMITTED instead of silently reverting (${JSON.stringify(await itemNames(A))})`
		);
		await A.page.keyboard.press('Escape');
	} else {
		h.check(false, `premise: the grid menu offers New scene (${gridRows.join(' | ')})`);
	}

	// =====================================================================
	// 5. THE DOWNLOAD AFFORDANCES
	// =====================================================================
	await wipe(A);
	await seedScene(A, 'Archive');
	await addBox(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneVersion('Archive', 'v2'));
	await A.page.waitForTimeout(1400);
	h.check(
		(await A.page.evaluate(() => {
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
			return m.scenes['Archive']?.history.length ?? 0;
		})) >= 2,
		'premise: Archive has more than one version'
	);

	await closeMenu(A);
	await card(A, 'Archive.tpscene').click({ button: 'right' });
	await A.page.waitForTimeout(350);
	const itemRows = await menuRows(A);
	h.check(
		itemRows.some((r) => /Download \(\.tpscene\)/.test(r)),
		`the item menu still offers Download (${itemRows.join(' | ')})`
	);
	h.check(
		!itemRows.some((r) => /Download all versions/.test(r)),
		'…and the all-versions archive is no longer a second Download row under it'
	);
	const hasIcon = await A.page.evaluate(() => {
		const row = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((el) =>
			/Download \(\.tpscene\)/.test(el.textContent ?? '')
		);
		return !!row?.querySelector('svg');
	});
	h.check(hasIcon, 'Download carries an icon like the rows around it');
	await closeMenu(A);

	// the archive lives in the panel now, before the count, and does not grow the line
	await openVersionPanel(A, 'Archive.tpscene');
	const panel = await A.page.evaluate(() => {
		const head = document.querySelector('#version-history .vh-head');
		const btn = document.querySelector('#version-download-all');
		const count = document.querySelector('#version-history .vh-count');
		if (!head) return null;
		const kids = [...head.children];
		return {
			present: !!btn,
			beforeCount: !!btn && !!count && kids.indexOf(btn) < kids.indexOf(count),
			headHeight: Math.round(head.getBoundingClientRect().height),
			btnHeight: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
			tooltip: btn?.getAttribute('title') ?? ''
		};
	});
	h.check(!!panel?.present, 'the all-versions archive is in the Version history header');
	h.check(!!panel?.beforeCount, '…before the version count it acts on');
	h.check(
		/Every version of this scene as one .zip/.test(panel?.tooltip ?? ''),
		`…carrying the same tooltip it had in the menu (${panel?.tooltip?.slice(0, 40)}…)`
	);
	h.check(
		(panel?.btnHeight ?? 99) <= 20 && (panel?.headHeight ?? 0) <= 24,
		`…and small enough not to scale up the header line (button ${panel?.btnHeight}px in a ${panel?.headHeight}px head)`
	);
	// and it really produces the archive
	const [dl] = await Promise.all([
		A.page.waitForEvent('download', { timeout: 20000 }),
		A.page.locator('#version-download-all').click()
	]);
	h.check(
		/\.zip$/.test(dl.suggestedFilename()),
		`the button still downloads the versions zip (${dl.suggestedFilename()})`
	);

	h.check((await h.pageErrors(A)).length === 0, `no page errors (${JSON.stringify(await h.pageErrors(A))})`);
	await h.finish(browser);
});
