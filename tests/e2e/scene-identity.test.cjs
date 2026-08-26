// 21-G9 — IDENTITY AND LOCATION: which project, which scene, and has it changed.
//
// Five things, and the reason each one is here:
//
//   the project NAME     it rides the manifest, so it replicates, persists and travels
//                        inside a .tp for free — and it is what the .tp file is CALLED
//                        (a user who named it "Dungeon Crawl" should not have to
//                        recognise it by timestamp in their Downloads folder).
//   the window TITLE     "Scene* - Project - theprototype", the line every DCC puts in
//                        its title bar. The asterisk means "this differs from the
//                        version its NAME points at", and it is the one part of this
//                        phase with a COST: the answer is `sceneSignature` over
//                        `buildSessionPayload`, which serializes the whole scene. So the
//                        throttle is asserted DIRECTLY — the title must NOT move in the
//                        instant after an edit, and must move once the window passes.
//   the CHIP             Project and Scene in the Explorer header, with the project name
//                        editable IN PLACE (fork 14: never a window.prompt). 21-I2 moved
//                        it out of its own row and in beside the search box; the ids are
//                        deliberately unchanged, so what is asserted here is unchanged
//                        too. Its LAYOUT (where it sits, and that it truncates instead
//                        of pushing the search box off) belongs to explorer-header-panels.
//   the HIGHLIGHT        the open scene's own card wears an accent. Keyed by HASH, which
//                        section 7 proves by renaming the file underneath it.
//   the ACTIVE FOLDER    "Save scene…" lands where the user is looking, and falls back
//                        for every pseudo location (prefabs/packs/scene…) and for an id
//                        that no longer exists. 21-H1 (locked answer 6) changed what it
//                        falls back TO: the library ROOT, never an invented `Scenes`.
//
// Section 7 is the phase's real design claim: the manifest scene NAME is authoritative
// and the item FILENAME is not, so renaming the file must leave travel-by-name, the
// breadcrumb and the highlight all working.
//
// Deliberately NOT here: a two-peer name-replication check. The name rides the existing
// `manifest` message, whose latest-wins/handshake behaviour `project-manifest` already
// covers end to end; a third peer for one string would buy nothing. The VIEWER gate
// (fork 3) is new, and that one is single-peer — section 8.
//
// Run: APP_URL='https://localhost:5200/' npm run e2e -- scene-identity
const h = require('./helpers.cjs');

// ---- reading the world -----------------------------------------------------------
const titleOf = (peer) => peer.page.evaluate(() => document.title);

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

const levelOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

const itemsOf = (peer) =>
	peer.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.map((i) => ({ id: i.id, name: i.name, hash: i.hash, folderId: i.folderId ?? null }));
	});

const childCount = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.children.length ?? 0;
	});

const folderIdNamed = (peer, name) =>
	peer.page.evaluate((n) => {
		let f;
		window.__stores.explorer.explorerFolders.subscribe((v) => (f = v))();
		return f.find((x) => x.name === n)?.id ?? null;
	}, name);

/**
 * A SYNCHRONOUS content edit: move an object and poke the store the way every editor
 * path does. Deliberately not `/create`, whose object lands whenever it lands — this
 * suite has to know the exact moment the dirty pulse fired to say anything about the
 * throttle. It changes the object's matrix, so it changes `toJSON`, so it changes the
 * signature — which is the whole point (a bare poke would not).
 */
const nudgeScene = (peer) =>
	peer.page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const child = g.children[0];
		const before = child.position.x;
		child.position.x += 3;
		child.updateMatrix(); // toJSON reads the matrix the last render composed
		s.objectsGroup.update((v) => v); // the poke IS the dirty signal
		return child.position.x - before;
	});

const makeBox = (peer) =>
	peer.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
	});

/**
 * Run `trigger` (the "Save scene…" menu row) and give the scene a name at whatever that
 * entry puts in front of the user. Today it is a `window.prompt` (21-F4); phase G10
 * replaces it with an inline input, and this suite must not go red on the day that
 * lands — so it accepts either and reports which one it took. The dialog listener has
 * to be attached BEFORE the click: with none, playwright auto-DISMISSES a prompt, and
 * `locator.click` would sit on the blocked page until it did.
 */
async function saveViaMenu(peer, trigger, name) {
	let how = 'nothing';
	const handler = (dialog) => {
		how = 'prompt';
		dialog.accept(name).catch(() => {});
	};
	peer.page.on('dialog', handler);
	try {
		await trigger();
		await peer.page.waitForTimeout(700);
	} finally {
		peer.page.off('dialog', handler);
	}
	if (how !== 'nothing') return how;
	// the G10 shape: an inline input, already focused, Enter confirms
	if (!(await peer.page.evaluate(() => document.activeElement?.tagName === 'INPUT'))) return how;
	await peer.page.keyboard.press('Control+a');
	await peer.page.keyboard.type(name);
	await peer.page.keyboard.press('Enter');
	return 'inline';
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.levels && !!window.__stores?.projectManifest, {
		timeout: 30000
	});

	// =====================================================================
	// 1. THE NAME, AND WHAT IT MAKES THE FILE CALLED
	// =====================================================================
	h.check(
		(await titleOf(A)) === 'theprototype',
		`a pristine app titles itself with just its name ("${await titleOf(A)}")`
	);

	const named = await A.page.evaluate(() => {
		const m = window.__stores.projectManifest;
		const before = { name: m.projectName(), inUse: m.manifestInUse() };
		return {
			before,
			set: m.setProjectName('Dungeon Crawl'),
			again: m.setProjectName('Dungeon Crawl'), // the same name is not a change
			padded: m.setProjectName('  Dungeon Crawl  '), // …and neither is it padded
			name: m.projectName(),
			inUse: m.manifestInUse()
		};
	});
	h.check(
		named.before.name === '' && named.before.inUse === false,
		`premise: no project yet (${JSON.stringify(named.before)})`
	);
	h.check(
		named.set === true && named.again === false && named.padded === false,
		`naming writes once; an identical or merely padded name is refused (${JSON.stringify([named.set, named.again, named.padded])})`
	);
	h.check(named.name === 'Dungeon Crawl', `the name reads back trimmed ("${named.name}")`);
	h.check(
		named.inUse === true,
		'NAMING a project creates one: manifestInUse now gates idb persistence and the handshake on it'
	);
	await h.eventually(
		() => titleOf(A),
		(t) => t === 'Dungeon Crawl - theprototype',
		'the title carries the project even with no scene open'
	);

	// the file dialog's default name — the one place the name meets a filesystem
	const bases = await A.page.evaluate(() => {
		const f = window.__stores.projectFile.projectFileBase;
		return [f('Dungeon Crawl'), f('a/b:c*?"<>|d'), f('  ...  '), f(''), f(null)];
	});
	h.check(
		bases[0] === 'Dungeon Crawl' && bases[1] === 'a-b-c-d',
		`a name becomes a safe basename, path separators and all (${JSON.stringify(bases.slice(0, 2))})`
	);
	h.check(
		bases[2] === '' && bases[3] === '' && bases[4] === '',
		`a name that sanitizes to nothing falls back (the timestamp) rather than to ".tp" (${JSON.stringify(bases.slice(2))})`
	);

	// =====================================================================
	// 2. THE TITLE'S DIRTY ASTERISK — AND THAT IT IS THROTTLED
	// =====================================================================
	await makeBox(A);
	h.check((await childCount(A)) === 1, 'premise: something to save');
	const arena = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	h.check(!!arena?.hash, `Arena saved (${arena?.name})`);
	await h.eventually(
		() => titleOf(A),
		(t) => t === 'Arena - Dungeon Crawl - theprototype',
		'a save names the scene in the title, CLEAN — the file and the world are the same thing'
	);

	// the throttle, asserted in both directions. An unthrottled check would answer
	// inside the same tick as the poke; the COST RULE is that it must not.
	const moved = await nudgeScene(A);
	h.check(Math.abs(moved - 3) < 1e-6, `premise: a real content edit (moved ${moved} in x)`);
	const early = await titleOf(A);
	h.check(
		early === 'Arena - Dungeon Crawl - theprototype',
		`THROTTLED: the whole-scene signature is not recomputed on the edit itself ("${early}")`
	);
	await h.eventually(
		() => titleOf(A),
		(t) => t === 'Arena* - Dungeon Crawl - theprototype',
		'and once the window passes, the asterisk says the scene differs from its saved version',
		8000
	);

	// saving again makes them equal again — and the flag has ONE legitimate way back
	const arena2 = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	h.check(
		arena2.hash !== arena.hash,
		'the edited scene saves as a NEW version (immutable files, a moving pointer)'
	);
	await h.eventually(
		() => titleOf(A),
		(t) => t === 'Arena - Dungeon Crawl - theprototype',
		'the asterisk clears on save'
	);
	h.check(
		(await manifestOf(A)).scenes.Arena.history.length === 2,
		'…and the project holds both versions'
	);

	// the name's other job: what the exported file is CALLED
	const [download] = await Promise.all([
		A.page.waitForEvent('download', { timeout: 20000 }),
		A.page.evaluate(() => window.__stores.projectFile.downloadProject())
	]);
	h.check(
		download.suggestedFilename() === 'Dungeon Crawl.tp',
		`the .tp comes out named after the project (${download.suggestedFilename()})`
	);

	// a SECOND edit must dirty it again: the check stands down once the answer is
	// "dirty" (there is nothing left to learn), so the re-arm is a real behaviour
	await makeBox(A);
	await h.eventually(
		() => titleOf(A),
		(t) => t.startsWith('Arena* - '),
		'a later edit dirties it again — the check re-arms after a save',
		8000
	);

	// =====================================================================
	// 3. PLAYING IS NOT EDITING
	// =====================================================================
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(() => titleOf(A), (t) => !t.includes('*'), 'premise: clean before play');
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(300);
	await nudgeScene(A);
	await A.page.waitForTimeout(3000);
	const playing = await titleOf(A);
	h.check(
		!playing.includes('*'),
		`a game moves objects constantly and none of it is an edit — no asterisk while playing ("${playing}")`
	);
	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	await A.page.waitForTimeout(600);
	await nudgeScene(A);
	await h.eventually(
		() => titleOf(A),
		(t) => t.startsWith('Arena* - '),
		'…and the next edit back in the editor is counted again',
		8000
	);

	// =====================================================================
	// 4. THE EXPLORER HEADER CHIP: Project / Scene, EDITABLE IN PLACE
	// =====================================================================
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(900);
	const chip = async () =>
		A.page.evaluate(() => ({
			project: document.querySelector('#explorer-project')?.textContent?.trim() ?? null,
			editing: !!document.querySelector('#explorer-project-input'),
			scene: document.querySelector('#explorer-scene')?.textContent?.trim() ?? null
		}));
	let c = await chip();
	h.check(
		c.project === 'Dungeon Crawl' && c.scene === 'Arena',
		`the header reads Project / Scene (${JSON.stringify(c)})`
	);

	// Escape cancels — the file's own inline-rename convention, and never a prompt
	await A.page.locator('#explorer-project').click();
	await A.page.waitForTimeout(250);
	h.check((await chip()).editing, 'clicking the project name opens an inline input, not a prompt');
	await A.page.locator('#explorer-project-input').fill('Typed and abandoned');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	c = await chip();
	h.check(
		c.project === 'Dungeon Crawl' && !c.editing,
		`Escape cancels and leaves the name alone (${JSON.stringify(c)})`
	);

	// Enter commits, through setProjectName — so the title moves with it
	await A.page.locator('#explorer-project').click();
	await A.page.locator('#explorer-project-input').fill('Tower Defence');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	h.check(
		(await chip()).project === 'Tower Defence' &&
			(await manifestOf(A)).name === 'Tower Defence',
		'Enter commits into the manifest — one write path, replicated and persisted'
	);
	await h.eventually(
		() => titleOf(A),
		(t) => t.startsWith('Arena') && t.endsWith('Tower Defence - theprototype'),
		'and the window title follows the rename with no save in between'
	);

	// the unnamed fallbacks, both of them
	await A.page.evaluate(() => window.__stores.projectManifest.setProjectName(''));
	await A.page.waitForTimeout(300);
	h.check(
		(await chip()).project === 'Untitled project',
		'an unnamed project says so rather than showing an empty segment'
	);
	const unnamed = await titleOf(A);
	h.check(
		unnamed.startsWith('Arena') && unnamed.endsWith(' - theprototype') && !unnamed.includes('Untitled'),
		`…and the title simply drops the project segment ("${unnamed}")`
	);
	const [unnamedDl] = await Promise.all([
		A.page.waitForEvent('download', { timeout: 20000 }),
		A.page.evaluate(() => window.__stores.projectFile.downloadProject())
	]);
	h.check(
		unnamedDl.suggestedFilename().startsWith('ThePrototype-'),
		`…and its export falls back to the timestamp name, as it always did (${unnamedDl.suggestedFilename()})`
	);
	await A.page.evaluate(() => window.__stores.projectManifest.setProjectName('Tower Defence'));
	await A.page.waitForTimeout(300);

	// =====================================================================
	// 5. THE OPEN SCENE'S CARD WEARS AN ACCENT
	// =====================================================================
	// 21-H1 (locked answer 6): a save invents no folder, so everything saved so far is at
	// the library ROOT — which is where these cards are
	h.check(
		(await folderIdNamed(A, 'Scenes')) === null,
		'premise: no `Scenes` folder was invented — the saves went to the root'
	);
	await A.page.evaluate(() => window.__stores.levels.newLevel('Bystander'));
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(600);
	const highlighted = await A.page.evaluate(() =>
		[...document.querySelectorAll('.explorer-open-scene')].map((el) => el.getAttribute('title'))
	);
	const level = await levelOf(A);
	const openItem = (await itemsOf(A)).find((i) => i.hash === level.hash);
	h.check(
		highlighted.length === 1 && highlighted[0] === openItem.name,
		`exactly one card is marked as the open scene, and it is the right one (${JSON.stringify(highlighted)})`
	);
	const cards = await A.page.evaluate(() => document.querySelectorAll('.explorer-card').length);
	h.check(cards > 1, `premise: there are other scene cards to get it wrong with (${cards})`);
	h.check(
		(await A.page.evaluate(() => document.querySelectorAll('.explorer-open-dot').length)) === 1,
		'the accent carries a titled dot as well as a ring — a bare ring reads as a selection'
	);

	// =====================================================================
	// 6. "SAVE SCENE…" LANDS WHERE THE USER IS LOOKING
	// =====================================================================
	const proto = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Prototypes', null)?.id ?? null
	);
	h.check(!!proto, 'premise: a second real folder');
	const bunker = await A.page.evaluate(
		(id) => window.__stores.levels.saveSceneAsLevel('Bunker', id),
		proto
	);
	h.check(
		(await itemsOf(A)).find((i) => i.id === bunker.id)?.folderId === proto,
		'a save with a real folder lands in it, not at the root'
	);
	const fresh = await A.page.evaluate(
		(id) => window.__stores.levels.newLevel('Blank', id),
		proto
	);
	h.check(
		(await itemsOf(A)).find((i) => i.id === fresh.id)?.folderId === proto,
		'…and so does a New scene'
	);
	// pseudo locations and dead ids both fall back — 21-H1 (locked answer 6) changed WHAT
	// to: the library ROOT, never a folder the app invents on the user's behalf
	const fallbacks = await A.page.evaluate(async () => {
		const l = window.__stores.levels;
		const a = await l.saveSceneAsLevel('Pseudo', 'prefabs');
		const b = await l.saveSceneAsLevel('Ghost', 'no-such-folder-id');
		return [a.id, b.id];
	});
	const after = await itemsOf(A);
	h.check(
		fallbacks.every((id) => (after.find((i) => i.id === id)?.folderId ?? null) === null),
		'a pseudo location (prefabs) and a deleted folder id both fall back to the ROOT'
	);
	h.check(
		(await folderIdNamed(A, 'Scenes')) === null,
		'…and neither of them invented a `Scenes` folder on the way'
	);

	// and through the REAL menu, where activeLibraryFolder() decides
	await A.page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), proto);
	await A.page.waitForTimeout(500);
	await A.page
		.locator('#explorer-list [role="region"]')
		.first()
		.click({ button: 'right', position: { x: 200, y: 140 } });
	await A.page.waitForTimeout(300);
	const saveRow = A.page.locator('[role="menuitem"]', { hasText: 'Save scene' }).first();
	h.check((await saveRow.count()) === 1, 'premise: the grid menu offers Save scene…');
	const how = await saveViaMenu(A, () => saveRow.click(), 'FromMenu');
	await A.page.waitForTimeout(1800);
	const fromMenu = (await itemsOf(A)).find((i) => i.name === 'FromMenu.tpscene');
	h.check(
		!!fromMenu && fromMenu.folderId === proto,
		`the menu save lands in the folder on screen (named via the ${how}; folder ${fromMenu?.folderId === proto})`
	);

	// =====================================================================
	// 7. THE NAME IS AUTHORITATIVE; THE FILENAME IS NOT
	// =====================================================================
	const arenaPointer = (await manifestOf(A)).scenes.Arena.history.at(-1);
	const arenaItem = (await itemsOf(A)).find((i) => i.hash === arenaPointer);
	h.check(!!arenaItem, `premise: the pointer version of Arena is a file here (${arenaItem?.name})`);
	await A.page.evaluate(
		({ id }) => window.__stores.explorer.renameItem(id, 'zzz-old-arena.tpscene'),
		{ id: arenaItem.id }
	);
	await A.page.waitForTimeout(400);
	h.check(
		(await itemsOf(A)).find((i) => i.id === arenaItem.id)?.name === 'zzz-old-arena.tpscene',
		'premise: the FILE is renamed under the scene'
	);
	// travel BY NAME still resolves it: the manifest points at a hash, never a filename
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create sphere'));
	await A.page.waitForTimeout(1200);
	const travelled = await A.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	h.check(travelled === true, 'travel-by-name resolves through the manifest, not the file list');
	await h.eventually(
		() => levelOf(A),
		(l) => l?.name === 'Arena',
		'…and we are on Arena by NAME, whatever its file is called'
	);
	await h.eventually(
		() => titleOf(A),
		(t) => t.startsWith('Arena - '),
		'the title shows the scene name, not the filename'
	);
	h.check(
		(await chip()).scene === 'Arena',
		'and so does the header chip — both read the manifest name'
	);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(600);
	const nowHighlighted = await A.page.evaluate(() =>
		[...document.querySelectorAll('.explorer-open-scene')].map((el) => el.getAttribute('title'))
	);
	h.check(
		nowHighlighted.length === 1 && nowHighlighted[0] === 'zzz-old-arena.tpscene',
		`the highlight follows the HASH, so it survives the rename (${JSON.stringify(nowHighlighted)})`
	);

	// =====================================================================
	// 8. FORK 3: EDITORS NAME THE PROJECT, VIEWERS NEVER
	// =====================================================================
	const gated = await A.page.evaluate(() => {
		const s = window.__stores;
		s.cloudHooks.rolesInfo.set({ myId: 'me', myRole: 'viewer', amAdmin: false, roleOf: () => 'viewer' });
		const refused = s.projectManifest.setProjectName('Viewer Rename');
		s.cloudHooks.rolesInfo.set(null);
		const allowed = s.projectManifest.setProjectName('Keep Renamed');
		return { refused, allowed, name: s.projectManifest.projectName() };
	});
	h.check(
		gated.refused === false && gated.allowed === true && gated.name === 'Keep Renamed',
		`a viewer's rename is refused, not queued; without a roles plugin the gate is inert (${JSON.stringify(gated)})`
	);

	// =====================================================================
	// 9. A RELOAD: the PROJECT is durable, the LOCATION is local
	// =====================================================================
	await A.page.waitForTimeout(500); // the fire-and-forget idb write
	await h.freshReload(A);
	await A.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.projectManifest.projectName()),
		(v) => v === 'Keep Renamed',
		'the project name survives a reload (it rides the manifest into idb)'
	);
	await h.eventually(
		() => titleOf(A),
		(t) => t === 'Keep Renamed - theprototype',
		'and the title comes back with the project but NO scene — where you were is local by design'
	);

	const errs = await h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	await h.finish(browser);
});
