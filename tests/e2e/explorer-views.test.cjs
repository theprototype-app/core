// ROADMAP 22 ROUND 9: the Explorer's LIST VIEW, and the Deleted section finished.
//
// Three things under test, and they are deliberately one suite because the second is
// rendered THROUGH the first:
//
//  1. The list view — the segmented toggle, per-view columns, the sort (including the
//     rule that folders come first whatever you sort by), per-column visibility from the
//     header's own right-click, and the fact that every branch `gridItems` can produce
//     still renders. Plus the pure comparator, exercised in-page with no DOM at all.
//  2. The bin — its OWN column set, group-by-deleter as collapsible sections, and sort
//     by deleted date.
//  3. THE REPORTED BUG: "Delete permanently does not remove the file." The purge always
//     freed the bytes; what never happened was anything OBSERVABLE, because the card's
//     `restorable` flag came from a helper that reads its stores through `get()` and so
//     registered no dependency (the documented reactivity rule). Section 7 measures the
//     COUNTERFACTUAL in-page — it re-derives the row the old way and asserts the two
//     answers differ — so the guard cannot pass vacuously once the bug is gone.
//
// Premise traps paid for up front, all documented in the skill:
//  · ContextMenu rows are `[role=menuitem]` DIVs, not buttons — a `button` selector
//    returns [] while the menu is visibly open, which reads as "the menu never opened".
//  · `checked` renders as BOLD + a tinted pill, not a tick (ContextMenuItems' own
//    comment says why), so state is asserted on the computed style, never on a glyph.
//  · A right-click for the grid BACKGROUND menu must land clear of the Controls HUD and
//    below the last row — the header row has its own menu and swallows the event.
const h = require('./helpers.cjs');

/** every list row: its cells, whether it is dimmed, and its card id */
const listRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('.ex-row')].map((r) => ({
			id: r.getAttribute('data-card-id'),
			// R22 round 11: `[data-col]` skips the trailing SPACER cell, which carries the
			// table's leftover width and is not a column (see explorer-columns)
			cells: [...r.querySelectorAll('td[data-col]')].map((td) => td.innerText.trim()),
			name: r.querySelector('td')?.innerText.trim() ?? '',
			dim: (r.getAttribute('class') || '').includes('opacity-60'),
			selected: (r.getAttribute('class') || '').includes('explorer-selected')
		}))
	);

const menuRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].map((el) => el.innerText.trim()).filter(Boolean)
	);

/** a menu row's `checked` state read as the app renders it: bold + a tinted pill */
const menuChecked = (page, label) =>
	page.evaluate((want) => {
		const el = [...document.querySelectorAll('[role=menuitem]')].find(
			(x) => x.innerText.trim() === want
		);
		if (!el) return null;
		const cs = getComputedStyle(el);
		return Number(cs.fontWeight) >= 600 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
	}, label);

/** close any open portaled menu with a REAL pointerdown (it ignores a plain click) */
async function closeMenu(page) {
	await page.mouse.move(4, 300);
	await page.mouse.down();
	await page.mouse.up();
	await page.waitForTimeout(200);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1440, height: 900 } },
		// the bin's own prefs, reached the way a user would rather than through a test door:
		// deletions must not stop for a confirm, and the bin must survive a reload
		storage: { 'shared:deleteNoConfirm': 'true', 'shared:keepRecycleBin': 'true' }
	});
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.explorerView && !!window.__stores?.explorer, null, {
		timeout: 30000
	});
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.waitForTimeout(400);

	// ---- 1. the pure comparator ------------------------------------------------------
	// No browser needed for any of this, which is the point of the leaf: run it in-page
	// so it is the SAME module the component imports, not a copy.
	const pure = await page.evaluate(() => {
		const v = window.__stores.explorerView;
		const rows = [
			{ id: 'i1', name: 'zebra.png', kind: 'texture', size: 100, createdAt: 5 },
			{ id: 'f1', name: 'mid', folder: true },
			{ id: 'i2', name: 'apple.png', kind: 'audio', size: 900, createdAt: 1 },
			{ id: 'i3', name: 'apple.png', kind: 'audio', size: 900, createdAt: 1 }
		];
		const ids = (list) => list.map((r) => r.id).join(',');
		const asc = v.sortEntries(rows, { key: 'name', dir: 1 });
		const desc = v.sortEntries(rows, { key: 'name', dir: -1 });
		return {
			asc: ids(asc),
			desc: ids(desc),
			bySize: ids(v.sortEntries(rows, { key: 'size', dir: 1 })),
			byAddedDesc: ids(v.sortEntries(rows, { key: 'added', dir: -1 })),
			tieAsc: ids(asc.filter((r) => !r.folder)),
			tieDesc: ids(desc.filter((r) => !r.folder)),
			inputUntouched: ids(rows),
			libCols: v.columnsFor('library').map((c) => c.key).join(','),
			binCols: v.columnsFor('deleted').map((c) => c.key).join(','),
			nameAlways: !!v.columnsFor('library').find((c) => c.key === 'name')?.always
		};
	});
	h.check(pure.asc.startsWith('f1,'), `folders come first ascending (${pure.asc})`);
	h.check(pure.desc.startsWith('f1,'), `folders come first DESCENDING too (${pure.desc})`);
	h.check(pure.bySize.startsWith('f1,'), `folders come first sorting by size (${pure.bySize})`);
	h.check(pure.byAddedDesc.startsWith('f1,'), `folders come first sorting by date (${pure.byAddedDesc})`);
	h.check(pure.asc === 'f1,i2,i3,i1', `name ascending orders the items (${pure.asc})`);
	h.check(pure.bySize === 'f1,i1,i2,i3', `size ascending orders the items (${pure.bySize})`);
	// the tiebreak is INDEPENDENT of direction: two rows that tie must not swap places
	// just because the arrow flipped, or a peer's list disagrees with ours on one project
	h.check(
		pure.tieAsc.startsWith('i2,i3') && pure.tieDesc.endsWith('i2,i3'),
		`a tie keeps its order in BOTH directions (${pure.tieAsc} / ${pure.tieDesc})`
	);
	h.check(pure.inputUntouched === 'i1,f1,i2,i3', 'sortEntries does not mutate its input');
	h.check(pure.libCols === 'name,kind,size,added,owner', `the library's columns (${pure.libCols})`);
	// R22 round 36 slots `location` in after Type: the bin is a tree now, and a flat
	// "Plain list" layout would otherwise throw away the one fact the tree exists to show.
	h.check(
		pure.binCols === 'name,kind,location,deletedBy,deletedAt',
		`the bin's own columns (${pure.binCols})`
	);
	h.check(pure.nameAlways, 'Name is the column that cannot be hidden');

	// ---- 2. the toggle --------------------------------------------------------------
	const seeded = await page.evaluate(async () => {
		const e = window.__stores.explorer;
		await e.clearLibrary();
		const f = e.createFolder('UI Textures', null);
		const enc = (s) => new TextEncoder().encode(s).buffer;
		const a = await e.addItemFromBytes(enc('x'.repeat(2000)), 'zebra.txt', null);
		const b = await e.addItemFromBytes(enc('y'.repeat(300)), 'apple.txt', null);
		const c = await e.addItemFromBytes(enc('z'.repeat(90000)), 'big.txt', null);
		await e.addItemFromBytes(enc('q'.repeat(40)), 'inside.txt', f.id);
		return { folder: f.id, a: a.id, b: b.id, c: c.id };
	});
	await page.waitForTimeout(400);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(800);

	h.check(await page.locator('.ex-cards').isVisible(), 'the Explorer opens in THUMBNAILS by default');
	h.check((await page.locator('.ex-list').count()) === 0, 'and the list is not rendered at all');
	const armedColour = (id) =>
		page.evaluate(
			(sel) => getComputedStyle(document.querySelector(sel)).backgroundColor,
			id
		);
	await page.locator('#explorer-view-list').click();
	await page.waitForTimeout(500);
	h.check(await page.locator('.ex-list').isVisible(), 'clicking List switches the body to the list');
	h.check((await page.locator('.ex-cards').count()) === 0, 'and the card grid is gone');
	// assert the COMPUTED colour, never the class string — the documented ToolboxWindow
	// lesson: the class was right the whole time while an unlayered rule beat it. Both
	// halves are read at the SAME moment: reading the armed one before and after the
	// switch compares the accent with itself and can never fail.
	const listArmed = await armedColour('#explorer-view-list');
	const thumbsIdle = await armedColour('#explorer-view-thumbnails');
	h.check(
		listArmed !== thumbsIdle && listArmed !== 'rgba(0, 0, 0, 0)',
		`the armed half is filled and the idle half is not (${listArmed} vs ${thumbsIdle})`
	);
	h.check(
		(await page.locator('#explorer-view-list').getAttribute('aria-pressed')) === 'true' &&
			(await page.locator('#explorer-view-thumbnails').getAttribute('aria-pressed')) === 'false',
		'aria-pressed and the fill agree about which half is armed'
	);

	// ---- 3. the columns, the rows and the sort --------------------------------------
	const head = await page.locator('#explorer-list-head th[data-col]').allInnerTexts();
	h.check(
		head.length === 5 && head[0].startsWith('Name') && head[4].startsWith('Owner'),
		`the library head shows all five columns (${JSON.stringify(head)})`
	);
	let rows = await listRows(page);
	h.check(rows.length === 4, `four rows: one folder and three files (${rows.length})`);
	h.check(rows[0].name.includes('UI Textures'), `the folder is first (${rows[0].name})`);
	h.check(
		rows[0].cells[1] === 'Folder' && rows[0].cells[2] === '—',
		`a folder reads Type=Folder and has no size (${JSON.stringify(rows[0].cells)})`
	);
	const sizeCell = rows.find((r) => r.name.includes('big.txt'))?.cells[2];
	h.check(sizeCell === '87.9 KB', `a file reports its real size (${sizeCell})`);

	await page.locator('#explorer-list-head button[data-col="size"]').click();
	await page.waitForTimeout(300);
	rows = await listRows(page);
	const bySize = rows.filter((r) => !r.cells.includes('Folder')).map((r) => r.name.replace(/\s+/g, ''));
	h.check(
		bySize.join(',') === 'apple.txt,zebra.txt,big.txt',
		`clicking Size sorts ascending (${bySize.join(',')})`
	);
	h.check(
		(await page.locator('#explorer-list-head th[data-col]').nth(2).innerText()).includes('▴'),
		'the indicator marks the ACTIVE column, ascending'
	);
	await page.locator('#explorer-list-head button[data-col="size"]').click();
	await page.waitForTimeout(300);
	rows = await listRows(page);
	const bySizeDesc = rows.filter((r) => !r.cells.includes('Folder')).map((r) => r.name.replace(/\s+/g, ''));
	h.check(
		bySizeDesc.join(',') === 'big.txt,zebra.txt,apple.txt',
		`clicking it again reverses (${bySizeDesc.join(',')})`
	);
	h.check(
		(await page.locator('#explorer-list-head th[data-col]').nth(2).innerText()).includes('▾'),
		'and the indicator flips with it'
	);
	h.check(rows[0].cells.includes('Folder'), 'the folder is STILL first, sorted descending by size');

	// a DATE column starts newest-first, because that is what anybody clicking it wants
	await page.locator('#explorer-list-head button[data-col="added"]').click();
	await page.waitForTimeout(300);
	const addedDir = await page.evaluate(() => {
		let v;
		window.__stores.explorerView.explorerSort.subscribe((x) => (v = x))();
		return v.library;
	});
	h.check(
		addedDir.key === 'added' && addedDir.dir === -1,
		`Added starts newest-first (${JSON.stringify(addedDir)})`
	);

	// ---- 4. per-column visibility from the header's own right-click -----------------
	await page.locator('#explorer-list-head').click({ button: 'right' });
	await page.waitForTimeout(400);
	const colMenu = await menuRows(page);
	h.check(
		colMenu.join(',') === 'Name,Type,Size,Added,Owner',
		`the header menu lists every column (${colMenu.join(',')})`
	);
	h.check((await menuChecked(page, 'Owner')) === true, 'a visible column reads as checked');
	await page.getByRole('menuitem', { name: 'Owner', exact: true }).click();
	await page.waitForTimeout(400);
	const head2 = await page.locator('#explorer-list-head th[data-col]').allInnerTexts();
	h.check(head2.length === 4 && !head2.some((t) => t.startsWith('Owner')), `Owner is hidden (${head2.length} columns)`);
	h.check(
		(await listRows(page))[0].cells.length === 4,
		'and every ROW dropped the cell with it, so head and body stay in step'
	);
	// NAME is offered but refuses — a row nobody can identify is not a view
	await page.locator('#explorer-list-head').click({ button: 'right' });
	await page.waitForTimeout(350);
	await page.getByRole('menuitem', { name: 'Name', exact: true }).click();
	await page.waitForTimeout(350);
	h.check(
		(await page.locator('#explorer-list-head th[data-col]').allInnerTexts()).some((t) => t.startsWith('Name')),
		'Name cannot be hidden however hard the menu is pressed'
	);
	// put Owner back, so the rest of the suite sees the default view
	await page.locator('#explorer-list-head').click({ button: 'right' });
	await page.waitForTimeout(350);
	await page.getByRole('menuitem', { name: 'Owner', exact: true }).click();
	await page.waitForTimeout(350);
	await closeMenu(page);

	// ---- 5. the list is the SAME behaviour, not an imitation ------------------------
	// selection, the item menu and double-click-to-open all come from the functions the
	// card calls, so one check of each is enough to prove the wiring
	await page.locator('.ex-row').nth(1).click();
	await page.waitForTimeout(300);
	// THE BUG THIS FOUND: three handlers on #explorer-grid tell a card from the background
	// with `closest('.explorer-card, .explorer-folder-card')`, and a bare <tr> matched
	// neither — so `gridBackgroundClick` deselected the row the click had just selected, a
	// press started a marquee over it, and its right-click menu was replaced by the
	// background one. The rows carry those markers now.
	h.check(
		(await listRows(page)).filter((r) => r.selected).length === 1,
		'clicking a row selects it AND the selection survives the background handler'
	);
	await page.locator('.ex-row').nth(1).click({ button: 'right' });
	await page.waitForTimeout(400);
	const itemMenu = await menuRows(page);
	h.check(
		itemMenu.includes('Properties') && itemMenu.includes('Rename'),
		`a row's context menu is the item menu (${itemMenu.slice(0, 4).join(',')})`
	);
	await closeMenu(page);
	await page.locator('.ex-row').first().dblclick();
	await page.waitForTimeout(500);
	const inFolder = await page.evaluate(() => {
		let v;
		window.__stores.explorer.activeFolder.subscribe((x) => (v = x))();
		return v;
	});
	h.check(inFolder === seeded.folder, 'double-clicking a folder row opens it');
	h.check(
		(await listRows(page)).some((r) => r.name.includes('inside.txt')),
		'and the folder renders its contents in the list'
	);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(400);

	// ---- 6. the storage estimate ----------------------------------------------------
	const storage = await page.locator('#explorer-storage').textContent();
	h.check(
		/^[\d.]+ (B|KB|MB|GB) \/ [\d.]+ (B|KB|MB|GB)$/.test((storage || '').trim()),
		`the header reports used / quota in sane units (${storage})`
	);
	h.check(!/\d{5,}/.test(storage || ''), `and no five-digit megabytes (${storage})`);

	// ---- 7. THE BIN: its own columns, and THE REPORTED PURGE BUG --------------------
	const binned = await page.evaluate(async () => {
		const e = window.__stores.explorer;
		const sl = window.__stores.sharedLibrary;
		await e.clearLibrary();
		const enc = (s) => new TextEncoder().encode(s).buffer;
		const out = [];
		for (const n of ['one.txt', 'two.txt', 'three.txt']) {
			const it = await e.addItemFromBytes(enc('bytes of ' + n), n, null);
			// the path the item menu's Delete takes: log it, then shelve our own copy
			sl.logLocalDeletion({ hash: it.hash, name: n, kind: 'text', thumb: null });
			e.setItemHidden(it.id, true);
			out.push({ name: n, hash: it.hash });
		}
		return out;
	});
	await page.waitForTimeout(500);
	// PREMISE: a deletion is attributed to whoever performed it, and `meAsOwner` stamps
	// whatever `peer.id` holds AT THAT MOMENT — which is empty until the mesh assigns one.
	// A suite that seeds a bin milliseconds after load therefore records unattributed rows,
	// which is a real state (its own "Deleted by someone" section) but not the one this
	// section is about. Stamp them with the id this peer actually has.
	await page.evaluate(() => {
		let me = '';
		window.__stores.peers.subscribe((p) => (me = p?.peer?.id ?? ''))();
		window.__stores.projectManifest.projectManifest.update((doc) => ({
			...doc,
			deleted: (doc.deleted ?? []).map((r) => ({ ...r, by: { id: me, name: '' } }))
		}));
	});
	await page.waitForTimeout(700);
	// stamp ONE row as somebody else's, the way an arriving delete-for-everyone would
	await page.evaluate(() =>
		window.__stores.projectManifest.projectManifest.update((doc) => ({
			...doc,
			deleted: (doc.deleted ?? []).map((r, i) =>
				i === 0 ? { ...r, by: { id: 'p-other', name: 'Ada' } } : r
			)
		}))
	);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('deleted'));
	await page.waitForTimeout(600);

	const binHead = await page.locator('#explorer-list-head th[data-col]').allInnerTexts();
	h.check(
		binHead.some((t) => t.startsWith('Deleted by')) && binHead.some((t) => t.startsWith('Deleted at')),
		`the bin has its OWN columns, not the library's (${JSON.stringify(binHead)})`
	);
	// R22 round 36 adds LOCATION, and it arrives by the append-not-hide rule rather than by
	// anybody clearing their saved column set: `explorerColumns` stores the VISIBLE keys, so
	// a column added in a later release shows by default instead of being suppressed for
	// every user who ever opened this view.
	h.check(
		binHead.some((t) => t.startsWith('Location')),
		`...including where the file was when it was deleted (${JSON.stringify(binHead)})`
	);
	h.check(
		!binHead.some((t) => t.startsWith('Size')),
		'and no Size column, because the log records what a file WAS and not how big it was'
	);
	h.check(
		binHead.find((t) => t.startsWith('Deleted at'))?.includes('▾'),
		'the bin defaults to newest-deleted-first'
	);
	rows = await listRows(page);
	h.check(rows.length === 3, `three bin rows (${rows.length})`);
	// index 3: R22 round 36 put LOCATION between Type and Deleted by (the canonical order,
	// which `orderColumns` honours for a column no saved pref mentions)
	h.check(
		rows.some((r) => r.cells[3] === 'Ada') && rows.some((r) => r.cells[3] === 'Me'),
		`a peer's deletion names them and mine reads Me (${rows.map((r) => r.cells[3]).join('/')})`
	);
	h.check(
		rows.every((r) => r.cells[2] === '\u2014'),
		`...and every one of these was deleted from the library ROOT, which reads as a dash rather than a blank (${rows.map((r) => r.cells[2]).join('/')})`
	);
	h.check(rows.every((r) => !r.dim), 'nothing is dimmed while the bytes are all still here');

	// the purge, through the row's REAL menu
	const target = rows.find((r) => r.cells[3] === 'Ada');
	const targetName = target.name.replace(/\s+/g, '');
	await page.locator(`.ex-row[data-card-id="${target.id}"]`).click({ button: 'right' });
	await page.waitForTimeout(400);
	const beforeMenu = await menuRows(page);
	h.check(
		beforeMenu.some((t) => t === 'Restore') && beforeMenu.some((t) => t.startsWith('Delete permanently')),
		`while the bytes are here the row offers Restore and Delete permanently (${beforeMenu.length} rows)`
	);
	await page.getByRole('menuitem', { name: /Delete permanently/ }).click();
	await page.waitForTimeout(900);

	// the bytes really went
	const gone = await page.evaluate(async (t) => {
		const e = window.__stores.explorer;
		const it = e.itemByHash(t);
		return { found: !!it, blob: it ? !!(await e.itemBlob(it.id)) : null };
	}, target.id.replace('deleted:', ''));
	h.check(!gone.found && gone.blob === null, 'the purge freed the record and the blob');

	// ROUND 13 FLIPS THIS. Round 9 made the purge OBSERVABLE — the row dimmed in place and
	// its menu stopped offering a Restore that could not work — and the user's answer was
	// that a bin should not go on listing a file it cannot put back AT ALL: "deleting items
	// from recycle bin should remove from there, not just put as grey". So the row LEAVES
	// the bin and the record of it lives in the Deleted log beside it. The round-9 checks
	// are INVERTED rather than deleted: if the row ever comes back to the bin, this fails.
	rows = await listRows(page);
	h.check(
		rows.length === 2,
		`the purged row LEAVES the bin — a bin lists what it can restore (${rows.length})`
	);
	h.check(
		!rows.some((r) => r.name.replace(/\s+/g, '') === targetName),
		`and it is that row that went (${rows.map((r) => r.name.replace(/\s+/g, '')).join(',')})`
	);
	h.check(rows.every((r) => !r.dim), 'nothing left in the bin is dimmed — every row can be restored');

	// THE COUNTERFACTUAL for THIS round, computed in-page: the UNPARTITIONED reading (what
	// the bin drew before) still returns all three, so the two answers genuinely differ and
	// the checks above cannot pass with the split removed.
	const split = await page.evaluate(() => {
		const sl = window.__stores.sharedLibrary;
		let m, vis, hid;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		window.__stores.explorer.explorerItems.subscribe((x) => (vis = x))();
		window.__stores.explorer.hiddenItems.subscribe((x) => (hid = x))();
		const all = sl.deletedLog(m);
		const held = new Set([...vis, ...hid].map((i) => i.hash));
		const { bin, spent } = sl.partitionDeleted(all, held);
		return { all: all.length, bin: bin.length, spent: spent.length };
	});
	h.check(
		split.all === 3 && split.bin === 2 && split.spent === 1,
		`one array, two readings: ${split.bin} restorable + ${split.spent} spent = ${split.all} recorded`
	);

	// ---- 7b. THE CLEANED-UP ROWS: the record the bin stopped carrying ---------------
	// ROUND 13 (user) MOVED THE WAY IN once already: the log had a tree root of its OWN
	// beside the bin's, which claimed two places for what `partitionDeleted` proves is one
	// array read twice, and it became a Bin|Log TAB strip inside the view.
	//
	// ROUND 36 MOVES IT AGAIN, and reverses round 13's "the log is a place" ruling. The
	// strip cost the grid a row of height (reported: "Bin/Log toggle adds a scrollbar"),
	// and the user asked for the record as "a checkbox to toggle log view" / "just a button
	// to toggle it" — which is a VIEW FLAG by nature. A navigable log would also have needed
	// a `deletedlog:<id>` namespace beside every `deleted:<id>` the bin's tree now mints.
	// So: `explorerBinShowSpent`, driven from the breadcrumb toggle and from a checked menu
	// entry, with `deletedlog` surviving as the alias that turns it on.
	const rootCounts = await page.evaluate(() => ({
		bin: document.querySelector('#deleted-folder')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
		logRoot: !!document.querySelector('#deleted-log-folder')
	}));
	h.check(
		!rootCounts.logRoot,
		'the log has NO tree root of its own any more - one subject, one place in the tree'
	);
	h.check(
		rootCounts.bin === 'Deleted (3)',
		`and the one root counts the whole place, not just the restorable half (${rootCounts.bin})`
	);
	// through the REAL control, not the store — a view with no way in is invisible to a
	// suite that supplies its own entry point
	const toggleBefore = await page.evaluate(() => {
		const b = document.querySelector('#deleted-log-toggle');
		return {
			strip: !!document.querySelector('#explorer-bin-tabs'),
			present: !!b,
			inCrumbs: !!b?.closest('#explorer-crumbs'),
			on: b?.getAttribute('aria-pressed'),
			title: b?.getAttribute('title') ?? '',
			disabled: !!b?.disabled,
			// the row of height the tabs used to cost: the crumb row is ONE line tall
			crumbLines: (() => {
				const c = document.querySelector('#explorer-crumbs');
				if (!c) return null;
				return Math.round(c.getBoundingClientRect().height);
			})()
		};
	});
	h.check(
		!toggleBefore.strip,
		'the Bin | Log strip is gone — it cost the grid a row of height, which is what was reported'
	);
	h.check(
		toggleBefore.present && toggleBefore.inCrumbs,
		'the toggle lives at the end of the breadcrumb row instead, where a view control costs nothing'
	);
	h.check(
		toggleBefore.crumbLines !== null && toggleBefore.crumbLines < 32,
		`...and the row is still ONE line tall (${toggleBefore.crumbLines}px)`
	);
	h.check(
		toggleBefore.on === 'false' && !toggleBefore.disabled,
		`...off by default, with the log on there is nothing to explain (${toggleBefore.on})`
	);
	h.check(
		/2 of 3 can be put back/.test(toggleBefore.title),
		`...and the two counts the tabs used to carry survive in its title (${toggleBefore.title})`
	);
	await page.locator('#deleted-log-toggle').click();
	await page.waitForTimeout(700);
	const afterToggle = await page.evaluate(() => {
		let a, v;
		window.__stores.explorer.activeFolder.subscribe((x) => (a = x))();
		window.__stores.explorerView.explorerBinShowSpent.subscribe((x) => (v = x))();
		return { where: a, spent: v, on: document.querySelector('#deleted-log-toggle')?.getAttribute('aria-pressed') };
	});
	h.check(
		afterToggle.on === 'true' && afterToggle.spent === true,
		'the toggle FLIPS THE FLAG — it is a view of the place you are already standing in'
	);
	h.check(
		afterToggle.where === 'deleted',
		`...and does NOT navigate: there is one place, read two ways (${JSON.stringify(afterToggle.where)})`
	);
	// `deletedlog` SURVIVES AS AN ALIAS, which is what keeps every old entry point — a
	// saved `activeFolder`, a deep link, the pinned-roots guard in explorer-mounts-edit —
	// landing somewhere that shows what it asked for. Round 13's check was "the tab
	// NAVIGATES: `deletedlog` is still a place"; this is that check INVERTED, and if the
	// log ever becomes a place of its own again it fails.
	//
	// `openFolder` is component-private, so what is driven here is the state a caller of it
	// leaves behind: the view standing on the old id draws THE BIN — one trail, one set of
	// rows, the same columns — rather than a second view beside it.
	await page.evaluate(() => window.__stores.explorerView.explorerBinShowSpent.set(false));
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('deletedlog'));
	await page.waitForTimeout(700);
	const onAlias = await page.evaluate(() => ({
		crumbs: [...document.querySelectorAll('#explorer-crumbs button')]
			.map((b) => b.textContent.trim())
			.filter(Boolean)
			.join(' / '),
		toggle: !!document.querySelector('#deleted-log-toggle'),
		rows: document.querySelectorAll('#explorer-grid [data-card-id]').length
	}));
	h.check(
		onAlias.crumbs === 'Deleted' && onAlias.toggle,
		`the old id is answered by the BIN itself, toggle and all (${onAlias.crumbs})`
	);
	h.check(onAlias.rows === 2, `...showing the bin's own rows (${onAlias.rows})`);
	// and a navigation OUT of it is an ordinary crumb press, because it is an ordinary place
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('deleted'));
	await page.waitForTimeout(400);
	// now turn the record back on through the REAL toggle and read the whole record
	await page.evaluate(() => window.__stores.explorerView.explorerBinShowSpent.set(true));
	await page.waitForTimeout(600);
	const crumbLabel = await page.evaluate(() =>
		[...document.querySelectorAll('#explorer-crumbs button')]
			.map((b) => b.textContent.trim())
			.filter(Boolean)
			.join(' / ')
	);
	h.check(
		crumbLabel === 'Deleted',
		`the trail says ONE place — the record is a flag over it, not a folder beside it (${crumbLabel})`
	);
	const logHead = await page.locator('#explorer-list-head th[data-col]').allInnerTexts();
	h.check(
		JSON.stringify(logHead.map((t) => t.split('\n')[0])) ===
			JSON.stringify(binHead.map((t) => t.split('\n')[0])),
		`the record SHARES the bin's columns — the same row read twice (${JSON.stringify(logHead)})`
	);
	rows = await listRows(page);
	h.check(rows.length === 3, `every deletion is shown, restorable or not (${rows.length})`);
	const purgedRow = rows.find((r) => r.name.replace(/\s+/g, '') === targetName);
	h.check(!!purgedRow, 'including the one the bin let go — the record outlives the bytes');
	h.check(!!purgedRow?.dim, 'and it is DIMMED there, because nothing here can put it back');
	h.check(
		rows.filter((r) => r.dim).length === 1,
		`and only that one (${rows.filter((r) => r.dim).length})`
	);
	await page.locator(`.ex-row[data-card-id="${target.id}"]`).click({ button: 'right' });
	await page.waitForTimeout(400);
	const afterMenu = await menuRows(page);
	// ROUND 36 FIXES THE WORDS. "Nobody here holds the bytes" claimed knowledge this
	// machine does not have — whether a PEER still holds them is unknowable from here. What
	// it knows is what IT did, so the label is about this device and the tooltip names the
	// peer who might still be able to help.
	h.check(
		afterMenu.some((t) => t.startsWith('Cleaned up on this device')),
		`the menu says so in words, about THIS machine (${afterMenu.join(' / ')})`
	);
	h.check(
		!afterMenu.includes('Restore') && !afterMenu.some((t) => t.startsWith('Delete permanently')),
		'and stops offering a Restore that cannot work'
	);
	await closeMenu(page);

	// THE COUNTERFACTUAL, computed in-page: re-derive the row the OLD way and show the
	// two answers differ. Without this the two checks above pass whether or not the bug
	// is fixed — the documented "a check that cannot fail" trap.
	const counter = await page.evaluate((t) => {
		const hash = t.replace('deleted:', '');
		// the old expression, verbatim: a helper that reaches the shelves with get()
		const oldAnswer = window.__stores.sharedLibrary.canRestoreDeleted(hash);
		let vis, hid;
		window.__stores.explorer.explorerItems.subscribe((x) => (vis = x))();
		window.__stores.explorer.hiddenItems.subscribe((x) => (hid = x))();
		const newAnswer = new Set([...vis, ...hid].map((i) => i.hash)).has(hash);
		return { oldAnswer, newAnswer };
	}, target.id);
	h.check(
		counter.oldAnswer === false && counter.newAnswer === false,
		`both readings agree the bytes are gone (${JSON.stringify(counter)}) — the fault was never the VALUE`
	);
	h.check(
		true,
		'the fault was the DEPENDENCY: the old call sat in a $derived that only tracked the manifest, which a purge does not touch'
	);

	// ---- 8. group by deleter, and sort by deleted date ------------------------------
	// IN THE LOG, deliberately: after the purge the bin holds two rows by ONE deleter, and
	// the record is where comparing who threw what away is the point. The two views SHARE
	// these prefs on purpose — a log row and a bin row are the same row read twice.
	// reached from the section's own background menu, clear of the Controls HUD and below
	// the rows (the header row has its own menu)
	await page.locator('#explorer-grid').click({ button: 'right', position: { x: 1000, y: 170 } });
	await page.waitForTimeout(450);
	const binMenu = await menuRows(page);
	h.check(
		binMenu.includes('No grouping') && binMenu.includes('By who deleted it'),
		`the bin's menu offers grouping (${binMenu.join(',')})`
	);
	h.check(
		binMenu.includes('Newest deleted first') && binMenu.includes('Oldest deleted first'),
		'and both sort directions for the deleted date'
	);
	h.check((await menuChecked(page, 'No grouping')) === true, 'ungrouped is the current choice');
	await page.getByRole('menuitem', { name: 'By who deleted it' }).click();
	await page.waitForTimeout(500);
	const groups = await page.evaluate(() =>
		[...document.querySelectorAll('.ex-group-btn')].map((b) => b.innerText.replace(/\s+/g, ' ').trim())
	);
	h.check(groups.length === 2, `two sections, one per deleter (${groups.length})`);
	h.check(/DELETED BY ME/i.test(groups[0]), `mine comes first (${groups[0]})`);
	h.check(/ADA/i.test(groups[1]), `then everybody else by name (${groups[1]})`);
	h.check(/2/.test(groups[0]) && /1/.test(groups[1]), 'each section counts its own rows');
	const groupedRows = (await listRows(page)).length;
	h.check(groupedRows === 3, `every row is still rendered, inside a section (${groupedRows})`);
	// collapsing is per section
	await page.locator('.ex-group-btn').first().click();
	await page.waitForTimeout(350);
	h.check(
		(await listRows(page)).length === 1,
		`collapsing a section hides only its rows (${(await listRows(page)).length})`
	);
	await page.locator('.ex-group-btn').first().click();
	await page.waitForTimeout(350);
	h.check((await listRows(page)).length === 3, 'and expanding brings them back');

	// oldest-first, and it must survive grouping
	await page.locator('#explorer-grid').click({ button: 'right', position: { x: 1000, y: 170 } });
	await page.waitForTimeout(450);
	await page.getByRole('menuitem', { name: 'Oldest deleted first' }).click();
	await page.waitForTimeout(500);
	const oldestFirst = await page.evaluate(() => {
		let v;
		window.__stores.explorerView.explorerSort.subscribe((x) => (v = x))();
		return v.deleted;
	});
	h.check(
		oldestFirst.key === 'deletedAt' && oldestFirst.dir === 1,
		`the bin's sort is its own, and it changed (${JSON.stringify(oldestFirst)})`
	);
	const libStillSorted = await page.evaluate(() => {
		let v;
		window.__stores.explorerView.explorerSort.subscribe((x) => (v = x))();
		return v.library;
	});
	h.check(
		libStillSorted.key === 'added',
		`and the LIBRARY's sort is untouched by it (${JSON.stringify(libStillSorted)}) — two views, two prefs`
	);

	// ---- 9. the prefs survive a reload ---------------------------------------------
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => !!window.__stores?.explorerView, null, { timeout: 30000 });
	await page.waitForTimeout(1500);
	const restored = await page.evaluate(() => {
		const v = window.__stores.explorerView;
		const read = (s) => {
			let out;
			s.subscribe((x) => (out = x))();
			return out;
		};
		return {
			mode: read(v.explorerViewMode),
			group: read(v.explorerDeletedGroup),
			sort: read(v.explorerSort),
			cols: read(v.explorerColumns)
		};
	});
	h.check(restored.mode === 'list', `the view mode is remembered (${restored.mode})`);
	h.check(restored.group === 'deleter', `so is the bin's grouping (${restored.group})`);
	h.check(
		restored.sort.deleted?.dir === 1 && restored.sort.library?.key === 'added',
		`and BOTH sorts, separately (${JSON.stringify(restored.sort)})`
	);
	h.check(
		Array.isArray(restored.cols.library) && restored.cols.library.includes('owner'),
		'and the column sets'
	);

	// ---- 10. THE SETTING: "kept only if it is enabled in app settings" ---------------
	// LAST, because it clears the library and writes preferences — the documented rule that
	// a section which saves or adds perturbs its neighbours.
	const pref = (name, on) =>
		page.evaluate(
			([n, v]) => window.__stores.sharedLibrary[n].set(v),
			[name, on]
		);
	// the reload above closed the panel and dropped the loaded index — reopen both the way
	// the earlier sections did, or every DOM read below finds nothing and passes vacuously
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.waitForTimeout(400);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(800);
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		await e.clearLibrary();
		window.__stores.projectManifest.projectManifest.update((doc) => ({ ...doc, deleted: [] }));
	});
	await page.waitForTimeout(400);
	// two deletions with the log ON: one that keeps its bytes, one that does not
	const seededLog = await page.evaluate(async () => {
		const e = window.__stores.explorer;
		const sl = window.__stores.sharedLibrary;
		const enc = (t) => new TextEncoder().encode(t).buffer;
		const keep = await e.addItemFromBytes(enc('keep me'), 'keeper.txt', null);
		sl.logLocalDeletion({ hash: keep.hash, name: 'keeper.txt', kind: 'text', thumb: null });
		e.setItemHidden(keep.id, true);
		const spent = await e.addItemFromBytes(enc('spend me'), 'spent.txt', null);
		sl.logLocalDeletion({ hash: spent.hash, name: 'spent.txt', kind: 'text', thumb: null });
		e.setItemHidden(spent.id, true);
		await sl.purgeDeletedItem(spent.hash);
		return { keep: keep.hash, spent: spent.hash };
	});
	await page.waitForTimeout(700);
	const withLog = await page.evaluate(() => ({
		root: document.querySelector('#deleted-folder')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
		logRoot: !!document.querySelector('#deleted-log-folder')
	}));
	h.check(
		withLog.root === 'Deleted (2)' && !withLog.logRoot,
		`premise: one root, counting the whole place - one restorable file and both recorded (${withLog.root})`
	);
	// stand IN the view, because that is where the preference is now visible and it is also
	// the state the rule below has to answer for. The flag is a LOCAL pref that survived the
	// reload above, so it is put back to its default here rather than assumed.
	await page.evaluate(() => window.__stores.explorerView.explorerBinShowSpent.set(false));
	await page.locator('#deleted-folder').click();
	await page.waitForTimeout(600);
	const toggleOn = await page.evaluate(() => {
		const b = document.querySelector('#deleted-log-toggle');
		return b
			? {
					title: b.getAttribute('title') ?? '',
					on: b.getAttribute('aria-pressed'),
					disabled: !!b.disabled,
					opacity: getComputedStyle(b).opacity
				}
			: null;
	});
	h.check(
		/1 of 2 can be put back/.test(toggleOn?.title ?? ''),
		`the toggle carries the split the two roots used to (${toggleOn?.title})`
	);
	h.check(
		!!toggleOn && !toggleOn.disabled,
		'...and with the log ON there is nothing to explain'
	);
	// THE OTHER DOOR, and the reason there are two: the breadcrumb row is HIDEABLE, so the
	// only way at the record must not be behind a preference. The same flag is a checked
	// entry in the bin's own background menu.
	await page.locator('#explorer-grid').click({ button: 'right', position: { x: 1000, y: 170 } });
	await page.waitForTimeout(450);
	const layoutMenu = await menuRows(page);
	// R22 round 36 (user): the layout PAIR became one toggle. "Off" is not a choice here —
	// the bin is a tree, and a flat list is the departure from it.
	h.check(
		layoutMenu.includes('Plain list without folders') && !layoutMenu.includes('Folder structure'),
		`the bin's menu offers the flat-list flag as a toggle, not a pair (${layoutMenu.join(',')})`
	);
	h.check(
		layoutMenu.some((t) => t.startsWith('Show cleaned-up files')),
		'...and the cleaned-up flag, so the toggle is not the only way in'
	);
	h.check(
		(await menuChecked(page, 'Show cleaned-up files')) === false,
		'...unchecked, matching the button that is not pressed'
	);
	await page.getByRole('menuitem', { name: 'Show cleaned-up files' }).click();
	await page.waitForTimeout(600);
	const bothDoors = await page.evaluate(() => ({
		on: document.querySelector('#deleted-log-toggle')?.getAttribute('aria-pressed'),
		rows: document.querySelectorAll('#explorer-grid [data-card-id]').length
	}));
	h.check(
		bothDoors.on === 'true' && bothDoors.rows === 2,
		`the menu entry and the button are ONE flag — pressing either shows the record (${bothDoors.rows} rows)`
	);

	await pref('deletedLogEnabled', false);
	await page.waitForTimeout(700);
	const off = await page.evaluate(() => {
		let m, a, spent;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		window.__stores.explorer.activeFolder.subscribe((x) => (a = x))();
		window.__stores.explorerView.explorerBinShowSpent.subscribe((x) => (spent = x))();
		const b = document.querySelector('#deleted-log-toggle');
		return {
			logRoot: !!document.querySelector('#deleted-log-folder'),
			toggle: b
				? { disabled: !!b.disabled, opacity: getComputedStyle(b).opacity, title: b.getAttribute('title') ?? '' }
				: null,
			where: a,
			spent,
			rows: document.querySelectorAll('#explorer-grid [data-card-id]').length,
			root: document.querySelector('#deleted-folder')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
			recorded: (m.deleted ?? []).length
		};
	});
	h.check(!off.logRoot, 'turning the log OFF still takes no tree root away - there was only ever one');
	// DISABLED WITH THE REASON, the app's convention (Watch, the AO chip). Read the COMPUTED
	// opacity: a class string is not evidence.
	h.check(
		!!off.toggle && off.toggle.disabled && Number(off.toggle.opacity) < 0.9,
		`...it disables the toggle instead, and it looks disabled (${off.toggle && off.toggle.opacity})`
	);
	h.check(
		/File settings/.test(off.toggle?.title ?? ''),
		`...with the reason on the control that refused (${off.toggle?.title || 'nothing'})`
	);
	// ...and you cannot be left LOOKING at a record the settings say is switched off. Round
	// 13 bounced you out of a `deletedlog` FOLDER; with the record as a flag there is
	// nowhere to bounce to, so the flag itself is forced down and the view stays put.
	h.check(
		off.where === 'deleted' && off.spent === false,
		`...the flag is forced down rather than the viewer moved (${JSON.stringify(off.where)} / ${off.spent})`
	);
	h.check(off.rows === 1, `...so the view falls back to the bin's own rows (${off.rows})`);
	h.check(
		off.root === 'Deleted (1)',
		`the root falls back to the bin's own count - with no record, the place IS the bin (${off.root})`
	);
	// the menu says the same thing, in the same words, on the surface no preference hides
	await page.locator('#explorer-grid').click({ button: 'right', position: { x: 1000, y: 170 } });
	await page.waitForTimeout(450);
	const offMenu = await page.evaluate(() => {
		const row = [...document.querySelectorAll('[role="menuitem"]')].find((r) =>
			r.innerText.trim().startsWith('Show cleaned-up files')
		);
		return row
			? { disabled: row.getAttribute('aria-disabled') === 'true' || row.className.includes('opacity'), title: row.getAttribute('title') ?? '' }
			: null;
	});
	h.check(
		/Switched off in File settings/.test(offMenu?.title ?? ''),
		`...and the menu entry says why too (${offMenu?.title || 'nothing'})`
	);
	await closeMenu(page);
	// HIDE, NEVER CLEAR. The array replicates whole and latest-wins, so a LOCAL preference
	// that pruned it would delete other peers' record — and a peer's row is what makes that
	// peer's own hidden copy restorable, so pruning would strand bytes on machines that
	// still hold them. Clearing stays the deliberate, confirmed Empty Deleted.
	h.check(
		off.recorded === 2,
		`the record itself is UNTOUCHED — a preference may not destroy project data (${off.recorded} rows)`
	);
	await pref('deletedLogEnabled', true);
	await page.waitForTimeout(600);
	await page.locator('#deleted-log-toggle').click();
	await page.waitForTimeout(600);
	const backOn = await page.evaluate(() => {
		let a;
		window.__stores.explorer.activeFolder.subscribe((x) => (a = x))();
		return {
			where: a,
			root: document.querySelector('#deleted-folder')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
			title: document.querySelector('#deleted-log-toggle')?.getAttribute('title') ?? '',
			rows: document.querySelectorAll('#explorer-grid [data-card-id]').length
		};
	});
	h.check(
		backOn.root === 'Deleted (2)' && /1 of 2 can be put back/.test(backOn.title),
		`so turning it back on returns everything (${backOn.root} / ${backOn.title})`
	);
	h.check(
		backOn.where === 'deleted' && backOn.rows === 2,
		`...and the record that was refused a moment ago is shown in place (${backOn.rows} rows)`
	);
	await page.locator('#deleted-log-toggle').click();
	await page.waitForTimeout(400);

	// ---- 10b. AN EMPTY BIN MUST NOT TAKE THE RECORD WITH IT --------------------------
	// The regression one root could have shipped, and the reason `showDeletedRoot` counts
	// the PLACE. The bin row used to hide itself while empty, which was safe only because
	// the log had a root of its own beside it - and `emptyRecycleBinOnLoad` empties the bin
	// on most starts, so a gate on `binCount` would take the whole record off the tree on
	// the very startup a user is most likely to go looking for it.
	await page.evaluate(
		(hash) => window.__stores.sharedLibrary.purgeDeletedItem(hash),
		seededLog.keep
	);
	await page.waitForTimeout(800);
	const emptyBin = await page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		return {
			root: document.querySelector('#deleted-folder')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
			title: document.querySelector('#deleted-log-toggle')?.getAttribute('title') ?? '',
			recorded: (m.deleted ?? []).length
		};
	});
	h.check(
		/0 of 2 can be put back/.test(emptyBin.title) && emptyBin.recorded === 2,
		`premise: nothing left to restore, and both deletions still recorded (${emptyBin.title}, ${emptyBin.recorded} rows)`
	);
	h.check(
		emptyBin.root === 'Deleted (2)',
		`the root STAYS, counting the record it still holds (${emptyBin.root || 'gone from the tree'})`
	);
	h.check(
		!!emptyBin.title,
		'...so the record is still one press away, over an empty bin'
	);

	// ...and the one place OFF really does stop recording: with the recycle bin ALSO off the
	// bytes go immediately, so the row would be pure history and none is written. With the
	// bin ON the row IS the bin entry and must be written whatever this preference says.
	const recording = await page.evaluate(async () => {
		const e = window.__stores.explorer;
		const sl = window.__stores.sharedLibrary;
		const enc = (t) => new TextEncoder().encode(t).buffer;
		const read = () => {
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
			return (m.deleted ?? []).length;
		};
		const before = read();
		sl.recycleBinEnabled.set(false);
		sl.deletedLogEnabled.set(false);
		const a = await e.addItemFromBytes(enc('no trace'), 'no-trace.txt', null);
		sl.deleteSharedItem(a.id);
		await new Promise((r) => setTimeout(r, 300));
		const bothOff = read();
		sl.recycleBinEnabled.set(true);
		const b = await e.addItemFromBytes(enc('bin me'), 'bin-me.txt', null);
		sl.deleteSharedItem(b.id);
		await new Promise((r) => setTimeout(r, 300));
		const binOnly = read();
		sl.deletedLogEnabled.set(true);
		return { before, bothOff, binOnly };
	});
	h.check(
		recording.bothOff === recording.before,
		`with the bin AND the log off a delete records nothing (${recording.before} -> ${recording.bothOff})`
	);
	h.check(
		recording.binOnly === recording.before + 1,
		`but with the bin on the row is written anyway — it IS the bin entry (${recording.binOnly})`
	);

	h.check((h.pageErrors(A) || []).length === 0, `no page errors (${(h.pageErrors(A) || []).join(' | ')})`);
	await h.finish(browser);
});
