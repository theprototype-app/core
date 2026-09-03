// 21-G8 — THE FILES MENU + OPEN/IMPORT SEMANTICS (fork 12: "Open replaces, Import
// furnishes"). What this suite pins, each proven by driving the real path:
//
//   · the Sidebar Files picker is [ Project | Scene | cog ] with Project the default,
//     and an enabled optional format (GLTF/JSON) on a second row — 21-H1 reshaped it
//   · OPEN .tp warns; DECLINING the warning mutates NOTHING; accepting WIPES the
//     library and restores the file's whole Explorer + manifest, and forgets
//     currentLevel (the NAMED-ONLY travel-away gate must not see the old name)
//   · IMPORT .tp merges in as ONE folder named after the project — manifest untouched
//   · a v1 .tp (format 1, no folders/items) still opens — the additive read
//   · OPEN .tpscene = the current scene, UNSAVED: no project membership, the first
//     edit offers "Save into project", and travel-away does NOT auto-publish it
//
// Run: APP_URL='https://theprototype.app:5201/' npm run e2e -- project-open-import
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');
const crypto = require('crypto');

// ---- page-side helpers ---------------------------------------------------------------
const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});
const libraryOf = (peer) =>
	peer.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.map((i) => ({ name: i.name, hash: i.hash, kind: i.kind, folderId: i.folderId }));
	});
const foldersOf = (peer) =>
	peer.page.evaluate(() => {
		let folders;
		window.__stores.explorer.explorerFolders.subscribe((v) => (folders = v))();
		return folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null }));
	});
const currentLevelOf = (peer) =>
	peer.page.evaluate(() => {
		let at;
		window.__stores.levels.currentLevel.subscribe((v) => (at = v))();
		return at;
	});
const toastsOf = (peer) =>
	peer.page.evaluate(() => {
		let toasts;
		window.__stores.toastStore.subscribe((t) => (toasts = t))();
		// a plain toast is a bare STRING in the store; action/info toasts are objects
		return (toasts ?? []).map((t) =>
			typeof t === 'string' ? { id: null, text: t } : { id: t.id ?? null, text: t.text ?? '' }
		);
	});
const confirmTitleOf = (peer) =>
	peer.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
		return d?.title ?? null;
	});
const answerConfirm = (peer, yes) =>
	peer.page.evaluate((y) => window.__stores.confirmDialog.resolveConfirm(y), yes);
const makeBox = (peer) =>
	peer.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		s.objectActions.deselectObject();
	});
// kick a page-side openProject WITHOUT awaiting (the warning dialog blocks it)
const openOnPage = (peer, b64) =>
	peer.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return await window.__stores.projectFile.openProject(bytes.buffer);
	}, b64);
// 21-I: the import takes the FILE's name and the folder the command was started from,
// so the page-side call carries both the way the Explorer does.
const importFolderOnPage = (peer, b64, opts = {}) =>
	peer.page.evaluate(
		async ({ b64, opts }) => {
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			return await window.__stores.projectFile.importProjectAsFolder(bytes.buffer, opts);
		},
		{ b64, opts }
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });

	// =====================================================================
	// 1. THE SIDEBAR PICKER — [ Project | Scene | cog ], Project default
	// =====================================================================
	// 21-H1 (locked answer 1) reworded and reshaped this row: the TP segment reads
	// "Project" — the KEY and the element id stay `tp`, because the id addresses the
	// FORMAT and not the word — and GLTF moved behind the cog beside JSON, appearing on
	// a SECOND row when enabled. `files-format-row` owns that contract in full; what
	// this suite needs from it is that the picker is there and Project is the default.
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(400);
	h.check(
		(await A.page.locator('#format-tp').count()) === 1,
		'the Project segment exists in the Files picker'
	);
	h.check(
		((await A.page.getAttribute('#format-tp', 'class')) ?? '').includes('on'),
		'Project is the DEFAULT selected format on a fresh profile (no stored preference)'
	);
	h.check(
		((await A.page.getAttribute('#format-tp', 'title')) ?? '').toLowerCase().includes('whole project'),
		'the Project segment says what it saves (the whole project)'
	);
	const segOrder = await A.page.evaluate(() =>
		[...(document.getElementById('format-row')?.querySelectorAll('button') ?? [])]
			.map((b) => b.textContent?.trim())
			.filter((t) => !!t)
	);
	h.check(
		JSON.stringify(segOrder) === JSON.stringify(['Project', 'Scene']),
		`the primary row is [ Project | Scene ] (${JSON.stringify(segOrder)})`
	);
	h.check(
		(await A.page.locator('#format-gltf').count()) === 0 &&
			(await A.page.locator('#format-row-optional').count()) === 0,
		'GLTF is not on it — optional and OFF by default, with no second row until it is enabled'
	);
	// enabling it through the cog puts it on the SECOND row, and only there
	await A.page.locator('#export-settings-cog').click();
	await A.page.waitForTimeout(250);
	await A.page.locator('#show-gltf-format').click();
	await A.page.waitForTimeout(300);
	const optional = await A.page.evaluate(() =>
		[...(document.getElementById('format-row-optional')?.querySelectorAll('button') ?? [])].map((b) =>
			b.textContent?.trim()
		)
	);
	h.check(
		JSON.stringify(optional) === JSON.stringify(['GLTF']),
		`enabling Show GLTF puts it on the optional row (${JSON.stringify(optional)})`
	);
	await A.page.locator('#show-gltf-format').click(); // back off — later sections expect the default
	await A.page.waitForTimeout(250);
	await A.page.locator('#export-settings-modal button', { hasText: 'Close' }).last().click();
	await A.page.waitForTimeout(200);
	// Save with Project and NOTHING AT ALL: the honest refusal, not an empty zip.
	// 21-H1 widened that gate — a library holding anything is a real project now — so
	// this refuses only because the profile is genuinely brand new.
	await A.page.evaluate(() => window.__stores.fileHandler.save('tp'));
	await h.eventually(
		() => toastsOf(A),
		(t) => t.some((x) => /nothing here yet/i.test(x.text)),
		'Save (Project) with nothing at all refuses honestly instead of downloading an empty zip'
	);
	await A.page.evaluate(() => window.__stores.closeMenu.set(true));

	// =====================================================================
	// 2. BUILD A REAL PROJECT ON A, EXPORT IT
	// =====================================================================
	await makeBox(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await A.page.evaluate(async () => {
		const bytes = new TextEncoder().encode('open-import suite asset').buffer;
		const item = await window.__stores.explorer.addItemFromBytes(bytes, 'note.txt', null);
		window.__stores.projectManifest.recordProjectAssets([item.hash]);
	});
	// a NESTED folder with an item — the v2 tree restore has to rebuild both levels
	await A.page.evaluate(async () => {
		const ex = window.__stores.explorer;
		const parent = ex.createFolder('Props', null);
		const child = ex.createFolder('Rocks', parent.id);
		await ex.addItemFromBytes(new TextEncoder().encode('rock data').buffer, 'rock.txt', child.id);
	});
	const exported = await A.page.evaluate(async () => {
		const r = await window.__stores.projectFile.exportProject();
		let s = '';
		for (let i = 0; i < r.bytes.length; i += 8192)
			s += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 8192));
		return { b64: btoa(s), items: r.items, scenes: r.scenes };
	});
	h.check(
		exported.scenes === 1 && exported.items === 3,
		`PREMISE: the export carries 1 scene version and 3 library items (${exported.scenes}/${exported.items})`
	);

	// =====================================================================
	// 3. OPEN, DECLINED — the warning is real and a decline mutates nothing
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	// a pre-existing library B must not lose to a DECLINED open
	await B.page.evaluate(async () => {
		await window.__stores.explorer.addItemFromBytes(
			new TextEncoder().encode('B keeps this').buffer,
			'keep-me.txt',
			null
		);
	});
	const libBefore = await libraryOf(B);
	const declined = openOnPage(B, exported.b64);
	await h.eventually(
		() => confirmTitleOf(B),
		(t) => typeof t === 'string' && t.startsWith('Open project'),
		'OPEN warns before touching anything (fork 12)'
	);
	await answerConfirm(B, false);
	h.check((await declined) === null, 'declining the warning resolves null');
	h.check(
		JSON.stringify(await libraryOf(B)) === JSON.stringify(libBefore) &&
			Object.keys((await manifestOf(B)).scenes).length === 0,
		'…and a DECLINED open mutated nothing — library and manifest untouched'
	);

	// =====================================================================
	// 4. OPEN, ACCEPTED — wipe + whole-Explorer restore + currentLevel reset
	// =====================================================================
	// give B a currentLevel the open must FORGET (the NAMED-ONLY travel-away gate)
	await makeBox(B);
	await B.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('OldWorld'));
	h.check((await currentLevelOf(B))?.name === 'OldWorld', 'PREMISE: B stands in a named scene');
	const accepted = openOnPage(B, exported.b64);
	await h.eventually(
		() => confirmTitleOf(B),
		(t) => typeof t === 'string' && t.startsWith('Open project'),
		'the warning again for the accepted run'
	);
	await answerConfirm(B, true);
	const counts = await accepted;
	h.check(!!counts && counts.items === 3, `open restored the 3 library items (${JSON.stringify(counts)})`);
	const libAfter = await libraryOf(B);
	h.check(
		!libAfter.some((i) => i.name === 'keep-me.txt') && !libAfter.some((i) => i.name === 'OldWorld.tpscene'),
		'OPEN REPLACES: the old library (stray item AND old scene) is gone'
	);
	const foldersAfter = await foldersOf(B);
	const props = foldersAfter.find((f) => f.name === 'Props' && f.parentId === null);
	const rocks = foldersAfter.find((f) => f.name === 'Rocks');
	h.check(
		!!props && !!rocks && rocks.parentId === props.id,
		'the v2 folder TREE came back with its nesting intact (Props/Rocks)'
	);
	h.check(
		libAfter.some((i) => i.name === 'rock.txt' && i.folderId === rocks?.id),
		'…and the nested item landed inside the rebuilt folder'
	);
	h.check(
		Object.keys((await manifestOf(B)).scenes).join() === 'Arena',
		'the manifest is INSTALLED by open (Arena)'
	);
	h.check(
		(await currentLevelOf(B)) === null,
		'currentLevel is FORGOTTEN — the scene on screen belongs to the old project, and a kept name would let travel-away publish old content into the new history'
	);

	// =====================================================================
	// 5. IMPORT AS FOLDER — furnishes, never installs
	// =====================================================================
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	await makeBox(C);
	await C.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('MyOwn'));
	const mBefore = await manifestOf(C);
	// 21-I (user): the folder is named after the FILE, minus its extension — you picked
	// `Dungeon v3.tp` off a disk, so `Dungeon v3` is what you look for afterwards, and two
	// exports of one project would otherwise both land under the same name.
	const importCounts = await importFolderOnPage(C, exported.b64, { fileName: 'Dungeon v3.tp' });
	h.check(!!importCounts && importCounts.items === 3, `import restored 3 items (${JSON.stringify(importCounts)})`);
	const cFolders = await foldersOf(C);
	const projFolder = cFolders.find((f) => f.name === 'Dungeon v3' && f.parentId === null);
	h.check(
		!!projFolder,
		`the .tp merged in as ONE folder named after the FILE, extension stripped (${JSON.stringify(
			cFolders.map((f) => f.name)
		)})`
	);
	const cLib = await libraryOf(C);
	const insideIds = new Set(
		cFolders.filter((f) => f.id === projFolder?.id || f.parentId === projFolder?.id || cFolders.find((p) => p.id === f.parentId)?.parentId === projFolder?.id).map((f) => f.id)
	);
	h.check(
		cLib.filter((i) => i.name !== 'note.txt' && insideIds.has(i.folderId)).length >= 2 ||
			cLib.some((i) => i.folderId === projFolder?.id),
		'imported items live inside the project folder tree'
	);
	h.check(
		JSON.stringify((await manifestOf(C)).scenes) === JSON.stringify(mBefore.scenes),
		'IMPORT NEVER INSTALLS: the manifest is byte-identical (my own project stays mine)'
	);
	h.check(
		(await currentLevelOf(C))?.name === 'MyOwn',
		'…and where I stand is untouched'
	);
	// hash-dedupe: a second import adds no duplicate ITEMS (a second, empty folder is
	// the honest residue of "merge what I do not already have").
	//
	// LOOSE-SCENES FIX (bug 2a) DELIBERATELY CHANGED THE FRONT OF THIS: the dedupe used
	// to happen in SILENCE, so a .tp whose contents were entirely already here reported
	// "Imported N items" having added nothing. It ASKS now — an import is a person
	// importing — and Skip is what produces the old outcome. The contract this section
	// records is therefore the dedupe RESULT, reached through the answer.
	const itemCount = cLib.length;
	const pendingReimport = importFolderOnPage(C, exported.b64, { fileName: 'Dungeon v3.tp' });
	await h.eventually(
		() => C.page.locator('#dup-skip').isVisible().catch(() => false),
		(v) => v === true,
		're-importing a .tp we already hold ASKS instead of deduping in silence'
	);
	await C.page.locator('#dup-skip').click();
	await pendingReimport;
	h.check(
		(await libraryOf(C)).length === itemCount,
		're-importing the same .tp adds no duplicate items (hash-dedupe inside)'
	);
	// the remaining imports in this section are about WHERE a folder lands, not about
	// duplicates — put the rule on Skip so each one is only testing its own claim
	await C.page.evaluate(() =>
		window.__stores.importDuplicates.setDuplicateImportMode('skip')
	);

	// 21-I (user): IT LANDS WHERE THE COMMAND WAS STARTED — inside the folder you are
	// browsing, not always at the root. A pseudo location (`prefabs`, `packs`, `scene…`)
	// or a stale id is not a place a file can go, so those still mean the root.
	const inbox = await C.page.evaluate(
		() => window.__stores.explorer.createFolder('Inbox', null)?.id ?? null
	);
	h.check(!!inbox, 'premise: a real folder to start the command from');
	await importFolderOnPage(C, exported.b64, { fileName: 'Nested.tp', parentId: inbox });
	const nested = (await foldersOf(C)).find((f) => f.name === 'Nested');
	h.check(
		!!nested && nested.parentId === inbox,
		`the import landed INSIDE the folder it was started from (parent ${
			nested?.parentId === inbox ? 'Inbox' : String(nested?.parentId)
		})`
	);
	await importFolderOnPage(C, exported.b64, { fileName: 'Pseudo.tp', parentId: 'prefabs' });
	const pseudo = (await foldersOf(C)).find((f) => f.name === 'Pseudo');
	h.check(
		!!pseudo && pseudo.parentId === null,
		'…and a pseudo location falls back to the library root rather than orphaning the import'
	);

	// =====================================================================
	// 6. A v1 .tp STILL OPENS — the additive read
	// =====================================================================
	const sceneBytes = strToU8('not a real zip, but real BYTES the library can hold');
	const sceneHash = crypto.createHash('sha256').update(sceneBytes).digest('hex');
	const v1 = Buffer.from(
		zipSync({
			'project.json': strToU8(
				JSON.stringify({
					format: 1,
					appVersion: '1.9.0',
					manifest: { scenes: { Legacy: { history: [sceneHash], pinned: [] } }, assets: [], changedAt: 5 },
					scenes: [{ hash: sceneHash, name: 'Legacy.tpscene', file: 'scenes/' + sceneHash + '.tpscene' }],
					assets: []
				})
			),
			['scenes/' + sceneHash + '.tpscene']: sceneBytes
		})
	).toString('base64');
	const D = await h.setupPage(browser, 'D');
	await D.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	const v1Pending = openOnPage(D, v1);
	await h.eventually(
		() => confirmTitleOf(D),
		(t) => typeof t === 'string' && t.startsWith('Open project'),
		'a v1 file takes the same OPEN warning (format 1 <= 2 needs no format confirm)'
	);
	await answerConfirm(D, true);
	const v1Counts = await v1Pending;
	h.check(!!v1Counts && v1Counts.scenes === 1, 'the v1 scenes loop ran (additive read: missing v2 keys are empty lists)');
	const dFolders = await foldersOf(D);
	const dLib = await libraryOf(D);
	// 21-H1 (locked answer 6): a v1 file carries no folder tree, and its scenes land at
	// the library ROOT. They used to be swept into a `Scenes` folder invented for them —
	// the same invented folder the save path just retired, one door over.
	h.check(
		dLib.some((i) => i.hash === sceneHash && i.folderId === null),
		`v1 scenes land at the library root (${JSON.stringify(dLib.map((i) => i.folderId))})`
	);
	h.check(
		!dFolders.some((f) => f.name === 'Scenes'),
		`and no folder is invented to hold them (${JSON.stringify(dFolders.map((f) => f.name))})`
	);
	h.check(
		Object.keys((await manifestOf(D)).scenes).join() === 'Legacy',
		'and the v1 manifest installed'
	);

	// =====================================================================
	// 7. OPEN .tpscene — the current scene, UNSAVED
	// =====================================================================
	const E = await h.setupPage(browser, 'E');
	await E.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	// a HOME scene to travel back to, so the no-auto-publish half is provable
	await makeBox(E);
	const homeHash = await E.page.evaluate(async () => {
		const item = await window.__stores.levels.saveSceneAsLevel('Home');
		return item?.hash ?? null;
	});
	h.check(!!homeHash, 'PREMISE: E has a saved Home scene');
	// a loose .tpscene, exported by the app itself (2 boxes, its own name)
	const looseB64 = await E.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		const payload = s.sessions.buildSessionPayload('LooseScene');
		delete payload.workspace;
		const bytes = await s.sessions.exportSessionZip(payload, { assets: false, packs: false, flow: true });
		let out = '';
		for (let i = 0; i < bytes.length; i += 8192)
			out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
		return btoa(out);
	});
	await E.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const file = new File([bytes], 'LooseScene.tpscene', { type: 'application/zip' });
		await window.__stores.fileHandler.load(file);
	}, looseB64);
	await h.eventually(
		() => currentLevelOf(E),
		(at) => at?.name === 'LooseScene' && at?.unsaved === true,
		'an OPENED .tpscene is the current scene, marked UNSAVED (not a project member)'
	);
	h.check(
		!(await manifestOf(E)).scenes.LooseScene,
		'…and nothing about it entered the manifest'
	);

	// the first-edit prompt: arm-delay first, then a REAL edit
	await E.page.waitForTimeout(1800);
	const beforePrompt = await toastsOf(E);
	h.check(
		!beforePrompt.some((t) => t.id === 'save-into-project'),
		'PREMISE: no save-into-project prompt before any edit'
	);
	await makeBox(E);
	await h.eventually(
		() => toastsOf(E),
		(t) => t.some((x) => x.id === 'save-into-project'),
		'the FIRST edit raises the sticky "Save into project" prompt'
	);

	// travel away WITHOUT saving: the unsaved scene must NOT auto-publish
	await E.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Home'), homeHash);
	await h.eventually(
		() => currentLevelOf(E),
		(at) => at?.name === 'Home',
		'travelled back to Home'
	);
	h.check(
		!(await manifestOf(E)).scenes.LooseScene,
		'travel-away did NOT publish the unsaved scene into the project (fork 12: membership is the user\'s call)'
	);

	// round 2: open again, edit, and TAKE the prompt this time
	await E.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const file = new File([bytes], 'LooseScene.tpscene', { type: 'application/zip' });
		await window.__stores.fileHandler.load(file);
	}, looseB64);
	await h.eventually(
		() => currentLevelOf(E),
		(at) => at?.name === 'LooseScene' && at?.unsaved === true,
		're-opened the loose scene (unsaved again)'
	);
	await E.page.waitForTimeout(1800);
	await makeBox(E);
	await h.eventually(
		() => toastsOf(E),
		(t) => t.some((x) => x.id === 'save-into-project'),
		'the prompt is up for the take-it run'
	);
	// take the prompt through the REAL toast action button
	const clicked = await E.page.evaluate(() => {
		const toast = [...document.querySelectorAll('.tp-toast, [class*="toast"]')].find((el) =>
			el.textContent?.includes('not part of your project')
		);
		const button = toast && [...toast.querySelectorAll('button')].find((b) => b.textContent?.includes('Save into project'));
		if (!button) return false;
		button.click();
		return true;
	});
	h.check(clicked, 'the prompt renders a real "Save into project" action');
	await h.eventually(
		() => manifestOf(E),
		(m) => (m.scenes.LooseScene?.history?.length ?? 0) === 1,
		'taking it SAVES the scene into the project (manifest pointer exists)'
	);
	await h.eventually(
		() => currentLevelOf(E),
		(at) => at?.name === 'LooseScene' && !at.unsaved,
		'…and the unsaved marker cleared (saveSceneAsLevel names it a member)'
	);
	await h.eventually(
		() => toastsOf(E),
		(t) => !t.some((x) => x.id === 'save-into-project'),
		'the prompt dismissed itself after the save'
	);


	// ---- the prompt DISMISSES when the scene it describes is no longer open ----------
	// REPORTED (release check): "even when I do open another scene this toast stays".
	// Two leaks: onNextDirty's unsubscribe was never kept (every open stacked another
	// armed one-shot), and a shown sticky toast had no watcher for its condition ENDING.
	// This section drives the exact report: prompt up -> open another scene -> gone,
	// and then proves the STALE ARM cannot fire either (an edit in the other scene
	// raises nothing about the one that armed).
	await E.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const file = new File([bytes], 'LooseScene.tpscene', { type: 'application/zip' });
		await window.__stores.fileHandler.load(file);
	}, looseB64);
	await h.eventually(
		() => currentLevelOf(E),
		(at) => at?.name === 'LooseScene' && at?.unsaved === true,
		'premise: the loose scene is open (unsaved) once more'
	);
	await E.page.waitForTimeout(1800);
	await makeBox(E);
	await h.eventually(
		() => toastsOf(E),
		(t) => t.some((x) => x.id === 'save-into-project'),
		'premise: the prompt is up'
	);
	await E.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Home'), homeHash);
	await h.eventually(
		() => currentLevelOf(E),
		(at) => at?.name === 'Home',
		'premise: another scene is open now'
	);
	await h.eventually(
		() => toastsOf(E),
		(t) => !t.some((x) => x.id === 'save-into-project'),
		'the prompt DISMISSED itself - it describes the open scene, and that scene left'
	);
	// the stale-arm half: an edit here must not raise a prompt about LooseScene
	await E.page.waitForTimeout(1800);
	await makeBox(E);
	await E.page.waitForTimeout(1200);
	h.check(
		!(await toastsOf(E)).some((x) => x.id === 'save-into-project'),
		'an edit in the OTHER scene raises nothing - the armed one-shot did not outlive its scene'
	);

	await h.finish(browser);
});
