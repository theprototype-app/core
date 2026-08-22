// 21-G10 — EXPLORER INPUT POLISH (roadmap 21-G round 2, locked fork 14).
//
// The report class this phase answers is about INPUT, so every check below drives real
// keys and a real pointer. Nothing here writes a store to make something happen; the
// stores are only ever READ, to say what the input produced.
//
// What each section is the guard for:
//
//   1. no window.prompt      the two scene-save entries called prompt(). It cannot be
//                            themed, it blocks the page while it is up, and its Escape
//                            is the browser's. `prompt` is REPLACED with a recorder (and
//                            a dialog listener watches for the native one underneath),
//                            so a regression is a counted call and not a hung run.
//   2. Enter confirms        "New scene…" types a name IN PLACE and creates exactly that
//                            item. The premise check comes first: the input must really
//                            be the focused element, or the keystrokes went somewhere
//                            else and every assertion after it is about nothing.
//   3. Esc cancels           and creates NOTHING — asserted against the item COUNT taken
//                            before, not against "no item with that name", which stays
//                            true if a differently-named one was created.
//   4. Save scene…           the same path with real content behind it, so the card is
//                            proven to reach saveSceneAsLevel and not only newLevel.
//   5. grid New folder       fork 14's inline CARD: it used to start the editor in the
//                            TREE, which on a collapsed sidebar is an input the user
//                            cannot see. Both halves (Esc, then Enter) plus the guard
//                            that the tree does NOT mount a second input for it.
//   6. rename-item           already inline; re-asserted from the grid card because the
//                            commit path was rewritten around it (it is now async).
//   6b. blur COMMITS         21-H1, locked answer 7 — THE ASSERTION THAT FLIPPED.
//                            Clicking away used to throw the typed name away; it commits
//                            now, across the whole inline family (folder create, item
//                            rename, the project name), with Escape the only cancel. The
//                            ordering hazard has its own check: Escape THEN a click away
//                            must still create nothing, or the blur handler would commit
//                            what Escape just cancelled.
//   7. the resizer           the roots section below "New folder". Dragging DOWN gives
//                            the folder list the room (the grip sits ABOVE what it
//                            sizes), the height persists, and it SURVIVES A RELOAD.
//
// Run: APP_URL='https://localhost:5204/' npm run e2e -- explorer-inline-input
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR4nGP8z8Dwn4EIwESMolGF+BUyMjAwMDIQBMQrJKgUvzt/EnIhAJTfBhFVsHRAAAAAAElFTkSuQmCC';

// window.prompt is REPLACED rather than merely watched: a real one would block the run,
// and returning null quietly is exactly what a regression must not be allowed to do
// silently. The counter is the assertion.
const BAN_PROMPT = () => {
	window.__promptCalls = 0;
	window.prompt = (...args) => {
		window.__promptCalls++;
		console.warn('window.prompt called with ' + JSON.stringify(args));
		return null;
	};
};
const promptCalls = (peer) => peer.page.evaluate(() => window.__promptCalls ?? -1);

const itemNames = (peer) =>
	peer.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.map((i) => i.name);
	});

const folderNames = (peer) =>
	peer.page.evaluate(() => {
		let f;
		window.__stores.explorer.explorerFolders.subscribe((v) => (f = v))();
		return f.map((x) => x.name);
	});

// A FIXED offset into the grid is a bet on how many cards are in it and on what the
// dock chrome overlays — the first version of this aimed at (320, 200) and hit a window
// move handle. Scan up from the bottom for a pixel `elementFromPoint` says is the grid
// region ITSELF, so the right-click can only be the background menu.
const gridBlankPoint = (peer) =>
	peer.page.evaluate(() => {
		const region = document.querySelector('#explorer-list [role="region"]');
		if (!region) return { ok: false, why: 'no grid region' };
		const r = region.getBoundingClientRect();
		for (let y = r.bottom - 14; y > r.top + 8; y -= 10)
			for (let x = r.left + 14; x < r.right - 14; x += 14) {
				if (document.elementFromPoint(x, y) === region) return { ok: true, x, y };
			}
		return { ok: false, why: 'every pixel of the grid is covered' };
	});

/** the grid background's context menu, opened where there is certainly no card */
const openGridMenu = async (peer) => {
	const at = await gridBlankPoint(peer);
	if (!at.ok) h.check(false, 'found blank grid background to right-click: ' + at.why);
	await peer.page.mouse.click(at.x, at.y, { button: 'right' });
	await peer.page.waitForTimeout(350);
};

// SCOPED to the open menu on purpose: the tree's own "＋ New folder" button carries the
// same words, and an unscoped getByText picked it — behind the menu's backdrop, so the
// click waited out its 30s instead of failing on the ambiguity.
const clickMenuRow = async (peer, text) => {
	await peer.page.locator('[role="menu"]').getByText(text, { exact: false }).first().click();
	await peer.page.waitForTimeout(350);
};

/** the inline card's input, plus whether it is really where the keys will go */
const cardInputState = (peer) =>
	peer.page.evaluate(() => {
		const input = document.querySelector('#explorer-new-card input');
		if (!input) return { present: false };
		return {
			present: true,
			focused: document.activeElement === input,
			value: input.value,
			// the whole point of "in place": the card sits in the grid, not over it
			inGrid: !!input.closest('#explorer-list [role="region"]'),
			treeInputs: document.querySelectorAll('#explorer-tree input').length
		};
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	// covers this page AND every reload after it
	await A.page.context().addInitScript(BAN_PROMPT);
	await A.page.evaluate(BAN_PROMPT);
	// a NATIVE dialog would never reach the stub — watch for one underneath
	let nativeDialogs = 0;
	A.page.on('dialog', async (d) => {
		nativeDialogs++;
		await d.dismiss();
	});
	await A.page.waitForFunction(() => !!window.__stores?.levels, { timeout: 30000 });

	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(700);

	// =====================================================================
	// 1-2. "New scene…" NAMES ITSELF IN PLACE, AND ENTER CREATES IT
	// =====================================================================
	const before2 = (await itemNames(A)).length;
	await openGridMenu(A);
	await clickMenuRow(A, 'New scene…');
	const opened = await cardInputState(A);
	h.check(opened.present, 'New scene… opens an inline card in the grid, not a dialog');
	// PREMISE: without this every keystroke below could be going to the document
	h.check(opened.focused, 'and its input is the focused element (premise for the keys)');
	h.check(opened.inGrid, `the card is inside the grid region (in place), not floating`);
	h.check(opened.value === 'New scene', `it is pre-filled with a sensible default ("${opened.value}")`);
	h.check(
		opened.treeInputs === 0,
		`and the TREE mounts no second input for it (${opened.treeInputs}) — the duplicate-focus trap`
	);

	// real typing: select-all then the name, then Enter
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Typed Scene');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() => itemNames(A),
		(names) => names.some((n) => n.includes('Typed Scene')),
		'Enter created a scene asset carrying the typed name'
	);
	h.check(
		(await cardInputState(A)).present === false,
		'and the card is gone once the name is committed'
	);
	// 21-H1 (locked answer 6) FLIPPED THIS: a save used to premake a `Scenes` folder,
	// and now lands where the user is looking — here, the library root. The only path
	// left that invents that folder is the empty-library bootstrap button
	// (`files-format-row` owns it); `scene-folders` owns the landing rule in full.
	h.check(
		!(await folderNames(A)).includes('Scenes'),
		`the save invents NO folder — it landed where the user was looking (${JSON.stringify(await folderNames(A))})`
	);
	h.check((await itemNames(A)).length === before2 + 1, 'exactly one item was created');

	// =====================================================================
	// 3. ESCAPE CANCELS, AND CREATES NOTHING
	// =====================================================================
	// counted, not name-matched: "no item called X" stays true when a wrongly-named
	// one was created, which is the failure this is actually watching for
	const before3 = (await itemNames(A)).length;
	const folders3 = (await folderNames(A)).length;
	await openGridMenu(A);
	await clickMenuRow(A, 'New scene…');
	h.check((await cardInputState(A)).present, 'a second card opens (premise for the cancel)');
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Never Saved');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(900);
	h.check((await cardInputState(A)).present === false, 'Escape removes the card');
	const after3 = await itemNames(A);
	h.check(
		after3.length === before3,
		`and creates nothing at all (${before3} items before, ${after3.length} after)`
	);
	h.check(
		(await folderNames(A)).length === folders3,
		'no folder was created by the cancelled scene name either'
	);

	// =====================================================================
	// 4. "SAVE SCENE…" TAKES THE SAME PATH, WITH REAL CONTENT BEHIND IT
	// =====================================================================
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		window.__stores.objectActions.deselectObject();
	});
	await openGridMenu(A);
	await clickMenuRow(A, 'Save scene…');
	const saveCard = await cardInputState(A);
	h.check(saveCard.present && saveCard.focused, 'Save scene… opens the same focused inline card');
	h.check(saveCard.value === 'Scene', `with its own default ("${saveCard.value}")`);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Saved By Hand');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.levels.levelItems().map((i) => i.name)),
		(names) => names.some((n) => n.includes('Saved By Hand')),
		'Enter saved the OPEN scene under the typed name (the Travel node can see it)'
	);
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let c;
				window.__stores.levels.currentLevel.subscribe((v) => (c = v))();
				return c?.name ?? null;
			}),
		(name) => name === 'Saved By Hand',
		'and currentLevel took the typed name — the save really ran, not just an item write'
	);

	// =====================================================================
	// 5. GRID "NEW FOLDER" IS AN INLINE CARD (fork 14), BOTH HALVES
	// =====================================================================
	const folders5 = (await folderNames(A)).length;
	await openGridMenu(A);
	await clickMenuRow(A, 'New folder');
	const folderCard = await cardInputState(A);
	h.check(folderCard.present, 'grid ▸ New folder opens an inline CARD (it used to open in the tree)');
	h.check(folderCard.focused, 'and it is focused (premise)');
	h.check(
		folderCard.treeInputs === 0,
		`the tree mounts NO duplicate input for it (${folderCard.treeInputs})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(400);
	h.check(
		(await folderNames(A)).length === folders5,
		'Escape on the folder card creates no folder'
	);

	await openGridMenu(A);
	await clickMenuRow(A, 'New folder');
	h.check((await cardInputState(A)).present, 'the card reopens (premise for the confirm)');
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Inline Folder');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() => folderNames(A),
		(names) => names.includes('Inline Folder'),
		'Enter on the folder card creates the folder with the typed name'
	);

	// =====================================================================
	// 6. ITEM RENAME IS STILL INLINE (the commit path was rewritten around it)
	// =====================================================================
	await A.page.evaluate((png) => {
		window.__stores.explorer.activeFolder.set(null);
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], 'tiny.png', { type: 'image/png' }));
		document
			.querySelector('#explorer-list')
			.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, TINY_PNG);
	await h.eventually(
		() => itemNames(A),
		(names) => names.includes('tiny.png'),
		'an image imported, to rename (premise)'
	);
	await A.page.locator('#explorer-list .explorer-card', { hasText: 'tiny.png' }).click({ button: 'right' });
	await A.page.waitForTimeout(300);
	await A.page.getByText('Rename', { exact: true }).click();
	await A.page.waitForTimeout(300);
	const renameFocused = await A.page.evaluate(() => {
		const input = document.querySelector('#explorer-list .explorer-card input');
		return !!input && document.activeElement === input;
	});
	h.check(renameFocused, 'item rename opens a focused inline input in its own card');
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('typed-name.png');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() => itemNames(A),
		(names) => names.includes('typed-name.png'),
		'and Enter renames it (the async commit did not break the sync modes)'
	);

	// =====================================================================
	// 6b. CLICKING AWAY COMMITS (21-H1, locked answer 7)
	// =====================================================================
	// This is the assertion that FLIPPED. Blur used to throw the name away, which is the
	// opposite of what every file browser does and of what "type a name, then reach for
	// the mouse" means. Escape is the only cancel now — and the ordering hazard has its
	// own check below, because unmounting a focused input can deliver a blur, and a
	// blur handler that ran after Escape would commit the very thing Escape cancelled.
	const beforeBlur = (await folderNames(A)).length;
	await openGridMenu(A);
	await clickMenuRow(A, 'New folder');
	h.check((await cardInputState(A)).present, 'premise: the folder card is up for the blur');
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Blurred Folder');
	// a REAL click elsewhere, not input.blur() — the bug would live in the handler
	const away = await gridBlankPoint(A);
	if (!away.ok) h.check(false, 'found blank grid to click away to: ' + away.why);
	await A.page.mouse.click(away.x, away.y);
	await h.eventually(
		() => folderNames(A),
		(names) => names.includes('Blurred Folder'),
		'clicking away COMMITS the typed folder name (it used to be thrown away)'
	);
	h.check(
		(await cardInputState(A)).present === false,
		'and the card closes with it'
	);

	// ESCAPE FIRST, THEN BLUR: cancelling must survive losing focus
	const afterBlur = (await folderNames(A)).length;
	h.check(afterBlur === beforeBlur + 1, `premise: exactly one folder came from that (${beforeBlur} -> ${afterBlur})`);
	await openGridMenu(A);
	await clickMenuRow(A, 'New folder');
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Cancelled By Escape');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	const away2 = await gridBlankPoint(A);
	if (away2.ok) await A.page.mouse.click(away2.x, away2.y);
	await A.page.waitForTimeout(700);
	const escNames = await folderNames(A);
	h.check(
		!escNames.includes('Cancelled By Escape') && escNames.length === afterBlur,
		`Escape then a click away still creates NOTHING (${escNames.length} folders, unchanged)`
	);

	// the item rename half of the same family
	await A.page.locator('#explorer-list .explorer-card', { hasText: 'typed-name.png' }).click({ button: 'right' });
	await A.page.waitForTimeout(300);
	await A.page.getByText('Rename', { exact: true }).click();
	await A.page.waitForTimeout(300);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('blur-renamed.png');
	const away3 = await gridBlankPoint(A);
	if (away3.ok) await A.page.mouse.click(away3.x, away3.y);
	await h.eventually(
		() => itemNames(A),
		(names) => names.includes('blur-renamed.png'),
		'a rename commits on blur too — the whole inline family, not just the scene modes'
	);

	// …and the PROJECT name, which lives in its own editor with its own handlers
	await A.page.locator('#explorer-project').click();
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.locator('#explorer-project-input').count()) === 1,
		'premise: the project-name input opened'
	);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Named By Blur');
	const away4 = await gridBlankPoint(A);
	if (away4.ok) await A.page.mouse.click(away4.x, away4.y);
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let m;
				window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
				return m.name ?? '';
			}),
		(name) => name === 'Named By Blur',
		'the project name commits on blur as well'
	);

	// =====================================================================
	// 7. NO PROMPT WAS EVER REACHED
	// =====================================================================
	h.check(
		(await promptCalls(A)) === 0,
		`window.prompt was never called by any of the paths above (${await promptCalls(A)})`
	);
	h.check(nativeDialogs === 0, `and no native dialog appeared underneath the stub (${nativeDialogs})`);

	// =====================================================================
	// 8. THE ROOTS RESIZER
	// =====================================================================
	// expand Packs and Scene first: the section is content-hugging under a cap, so with
	// three short rows in it a cap change moves nothing and the check would be vacuous
	await A.page.locator('#packs-folder').dblclick();
	await A.page.waitForTimeout(500);
	await A.page.locator('#scene-folder').dblclick();
	await A.page.waitForTimeout(500);
	const grip = await A.page.evaluate(() => {
		const el = document.querySelector('#explorer-roots-resize');
		const roots = document.querySelector('#explorer-roots');
		if (!el || !roots) return { present: false };
		const r = el.getBoundingClientRect();
		const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return {
			present: true,
			onTop: at === el,
			x: r.x + r.width / 2,
			y: r.y + r.height / 2,
			maxHeight: roots.style.maxHeight,
			height: Math.round(roots.getBoundingClientRect().height),
			scrollHeight: roots.scrollHeight,
			// the grip must sit BELOW the New folder button — that is what "the section
			// below the New-folder button" means, and it is what decides the drag sign
			belowNewFolder: r.y > document.querySelector('#new-folder').getBoundingClientRect().bottom
		};
	});
	h.check(grip.present, 'the tree has a roots resize grip');
	h.check(grip.onTop, 'and it is the top element at its own centre (premise for the drag)');
	h.check(grip.belowNewFolder, 'it sits below the New folder button, above the section it sizes');
	h.check(
		/^\d+px$/.test(grip.maxHeight ?? ''),
		`the section is bounded by an explicit height, not a percentage (${grip.maxHeight})`
	);
	h.check(
		grip.scrollHeight > grip.height,
		`the expanded roots really overflow the cap (${grip.height} shown of ${grip.scrollHeight}) — premise`
	);

	// drag DOWN: the grip is above the section, so the section SHRINKS and the folder
	// list gets the room
	await A.page.mouse.move(grip.x, grip.y);
	await A.page.mouse.down();
	for (let dy = 8; dy <= 56; dy += 8) await A.page.mouse.move(grip.x, grip.y + dy, { steps: 2 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);
	const shrunk = await A.page.evaluate(() => ({
		maxHeight: parseInt(document.querySelector('#explorer-roots').style.maxHeight),
		height: Math.round(document.querySelector('#explorer-roots').getBoundingClientRect().height),
		stored: parseInt(localStorage.getItem('explorerRootsH') ?? '0')
	}));
	const wasMax = parseInt(grip.maxHeight);
	h.check(
		shrunk.maxHeight < wasMax,
		`dragging down shrank the roots section (${wasMax} -> ${shrunk.maxHeight})`
	);
	h.check(
		shrunk.height < grip.height,
		`and the RENDERED section really got shorter (${grip.height} -> ${shrunk.height}px)`
	);
	h.check(
		shrunk.stored === shrunk.maxHeight,
		`the height persisted on release (stored ${shrunk.stored})`
	);

	// and it comes back that way — a persisted size nobody re-applies is not persisted
	await h.freshReload(A);
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(900);
	const reloaded = await A.page.evaluate(() => {
		const roots = document.querySelector('#explorer-roots');
		return {
			maxHeight: roots ? parseInt(roots.style.maxHeight) : -1,
			stored: parseInt(localStorage.getItem('explorerRootsH') ?? '0')
		};
	});
	h.check(
		reloaded.stored === shrunk.stored,
		`the stored height survived the reload (${reloaded.stored})`
	);
	h.check(
		reloaded.maxHeight === shrunk.maxHeight,
		`and it is APPLIED on mount, not just remembered (${reloaded.maxHeight}px)`
	);

	await h.finish(browser);
});
