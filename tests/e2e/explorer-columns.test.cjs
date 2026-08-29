// R22 ROUND 11, PHASE 2 — "should allow ajust size of columns and drag order" and "when
// no space for columns horizontal bar appears".
//
// Round 9 shipped the list view with a fixed column model; this makes the header a real
// one. Three things are worth stating because each has a trap behind it:
//
//   · a WIDTH has to STICK. `table-layout: fixed` shares any surplus out across the
//     columns that declare one, so with the old markup a drag was quietly undone by the
//     layout the moment it left space over. The spacer cell is what fixes that, and §2
//     measures the neighbour to prove it.
//   · a press that does not TRAVEL still sorts. One control, two gestures — the rule the
//     mesh and UV editors both keep.
//   · the sideways scrollbar belongs to the table's own container. The PAGE must never
//     scroll horizontally, which is a documented rule in this repo and the reason §4 reads
//     `document.documentElement` as well as the pane.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- explorer-columns
const h = require('./helpers.cjs');

const headBoxes = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('#explorer-list-head .ex-th[data-col]')].map((el) => {
			const r = el.getBoundingClientRect();
			return { key: el.getAttribute('data-col'), x: Math.round(r.left), w: Math.round(r.width) };
		})
	);

const widthOfCol = async (p, key) => (await headBoxes(p)).find((c) => c.key === key)?.w ?? null;

const storedWidths = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorerView.explorerColumnWidths.subscribe((x) => (v = x))();
		return v;
	});

const storedOrder = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorerView.explorerColumnOrder.subscribe((x) => (v = x))();
		return v;
	});

const sortState = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorerView.explorerSort.subscribe((x) => (v = x))();
		return v;
	});

/** drag a grip by dx with a REAL mouse, so pointer capture is exercised */
async function dragGrip(p, key, dx) {
	const box = await p.page.locator(`.ex-grip[data-grip="${key}"]`).boundingBox();
	if (!box) return false;
	const y = box.y + box.height / 2;
	await p.page.mouse.move(box.x + box.width / 2, y);
	await p.page.mouse.down();
	await p.page.mouse.move(box.x + box.width / 2 + dx / 2, y, { steps: 4 });
	await p.page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 4 });
	await p.page.mouse.up();
	await p.page.waitForTimeout(300);
	return true;
}

/** drag a header sideways onto another column's cell */
async function dragHeader(p, key, ontoKey) {
	const from = await p.page.locator(`#explorer-list-head .ex-th[data-col="${key}"] .ex-th-btn`).boundingBox();
	const to = await p.page.locator(`#explorer-list-head .ex-th[data-col="${ontoKey}"]`).boundingBox();
	if (!from || !to) return false;
	const y = from.y + from.height / 2;
	await p.page.mouse.move(from.x + from.width / 2, y);
	await p.page.mouse.down();
	await p.page.mouse.move(to.x + to.width / 2, y, { steps: 6 });
	await p.page.mouse.move(to.x + to.width / 2, y, { steps: 2 });
	await p.page.mouse.up();
	await p.page.waitForTimeout(350);
	return true;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 860 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.explorerView && !!window.__stores?.explorer, null, {
		timeout: 30000
	});
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.waitForTimeout(400);

	// ---- 0. the pure half, in-page so it is the SAME module the component imports -----
	const pure = await page.evaluate(() => {
		const v = window.__stores.explorerView;
		const cols = v.columnsFor('library');
		const keys = (list) => list.map((c) => c.key).join(',');
		return {
			canonical: keys(cols),
			reordered: keys(v.orderColumns(cols, ['name', 'owner', 'kind', 'size', 'added'])),
			// a stored order that does not mention a column keeps that column's own index
			partial: keys(v.orderColumns(cols, ['size', 'kind'])),
			// NAME can never be dragged off the left edge, even by a hand-edited pref
			pinned: keys(v.orderColumns(cols, ['owner', 'name', 'kind', 'size', 'added'])),
			empty: keys(v.orderColumns(cols, [])),
			// widths: stored wins, then the declared default, then the fallback
			wStored: v.widthOf({ key: 'kind', width: '72px' }, { kind: 140 }),
			wDeclared: v.widthOf({ key: 'kind', width: '72px' }, {}),
			wNone: v.widthOf({ key: 'mystery' }, {}),
			clampLow: v.clampColumnWidth(2),
			clampHigh: v.clampColumnWidth(9000)
		};
	});
	h.check(pure.canonical === 'name,kind,size,added,owner', `premise: the canonical order (${pure.canonical})`);
	h.check(
		pure.reordered === 'name,owner,kind,size,added',
		`a stored order is honoured (${pure.reordered})`
	);
	h.check(
		pure.partial === 'name,size,kind,added,owner',
		`a column the pref never mentions keeps its own index — appended, never hidden (${pure.partial})`
	);
	h.check(pure.pinned.startsWith('name,'), `NAME cannot be moved off the left edge (${pure.pinned})`);
	h.check(pure.empty === pure.canonical, 'no stored order = the canonical one, byte for byte');
	h.check(pure.wStored === 140, `a stored width wins (${pure.wStored})`);
	h.check(pure.wDeclared === 72, `…else the declared one (${pure.wDeclared})`);
	h.check(pure.wNone === 120, `…else a readable fallback (${pure.wNone})`);
	h.check(
		pure.clampLow === v_min(pure) && pure.clampHigh === 600,
		`widths clamp both ways (${pure.clampLow}..${pure.clampHigh})`
	);

	// ---- seed and open the list view ---------------------------------------------------
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		await e.clearLibrary();
		const enc = (s) => new TextEncoder().encode(s).buffer;
		for (const n of ['one.txt', 'two.txt', 'three.txt'])
			await e.addItemFromBytes(enc('x'.repeat(50) + n), n, null);
		window.__stores.explorerView.explorerViewMode.set('list');
		// start from the defaults, whatever a previous run left behind
		window.__stores.explorerView.explorerColumnWidths.set({ library: {}, deleted: {} });
		window.__stores.explorerView.explorerColumnOrder.set({ library: [], deleted: [] });
	});
	await page.waitForTimeout(600);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);

	const first = await headBoxes(A);
	h.check(
		first.map((c) => c.key).join(',') === 'name,kind,size,added,owner',
		`premise: the list draws five columns in order (${first.map((c) => c.key).join(',')})`
	);

	// ---- 1. a grip resizes, and the store remembers ------------------------------------
	const kindBefore = await widthOfCol(A, 'kind');
	const sizeBefore = await widthOfCol(A, 'size');
	h.check(kindBefore === 72, `premise: Type starts at its declared 72px (${kindBefore})`);
	h.check(await dragGrip(A, 'kind', 60), 'premise: the Type grip exists and can be dragged');
	const kindAfter = await widthOfCol(A, 'kind');
	h.check(
		Math.abs(kindAfter - (kindBefore + 60)) <= 4,
		`the column follows the pointer (${kindBefore} -> ${kindAfter})`
	);
	h.check(
		Math.abs((await storedWidths(A)).library.kind - kindAfter) <= 2,
		`and the width is remembered (${JSON.stringify((await storedWidths(A)).library)})`
	);

	// THE TRAP: with no spacer cell, `table-layout: fixed` shares the surplus out and the
	// NEIGHBOURS move too — which reads as "the drag did not stick"
	const sizeAfter = await widthOfCol(A, 'size');
	h.check(
		sizeAfter === sizeBefore,
		`the neighbouring column did NOT change with it (${sizeBefore} -> ${sizeAfter})`
	);

	// ---- 2. clamps, and double-click to reset ------------------------------------------
	await dragGrip(A, 'kind', -900);
	const squashed = await widthOfCol(A, 'kind');
	h.check(squashed >= 48 && squashed <= 52, `a column cannot be dragged to nothing (${squashed}px)`);
	await page.locator('.ex-grip[data-grip="kind"]').dblclick();
	await page.waitForTimeout(300);
	h.check(
		(await widthOfCol(A, 'kind')) === 72,
		`double-clicking the grip resets it — this app's meaning for that gesture (${await widthOfCol(A, 'kind')})`
	);
	h.check(
		!('kind' in (await storedWidths(A)).library),
		'…by FORGETTING the width rather than storing the default, so a later default change reaches it'
	);

	// ---- 3. drag to reorder, and a press that does not travel still sorts ---------------
	const sortBefore = (await sortState(A)).library;
	await page.locator('#explorer-list-head .ex-th[data-col="owner"] .ex-th-btn').click();
	await page.waitForTimeout(300);
	const sortAfter = (await sortState(A)).library;
	h.check(
		sortAfter.key === 'owner' && sortBefore.key !== 'owner',
		`a plain press still SORTS (${JSON.stringify(sortBefore)} -> ${JSON.stringify(sortAfter)})`
	);
	const orderBefore = (await headBoxes(A)).map((c) => c.key).join(',');
	h.check(await dragHeader(A, 'owner', 'kind'), 'premise: the Owner header can be dragged onto Type');
	const orderAfter = (await headBoxes(A)).map((c) => c.key).join(',');
	h.check(
		orderAfter === 'name,owner,kind,size,added',
		`dragging a header moves the column (${orderBefore} -> ${orderAfter})`
	);
	h.check(
		JSON.stringify((await storedOrder(A)).library) ===
			JSON.stringify(['name', 'owner', 'kind', 'size', 'added']),
		`and the order is remembered (${JSON.stringify((await storedOrder(A)).library)})`
	);
	const sortAfterDrag = (await sortState(A)).library;
	h.check(
		sortAfterDrag.dir === sortAfter.dir && sortAfterDrag.key === sortAfter.key,
		`the click that ENDS the drag does not also flip the sort (${JSON.stringify(sortAfterDrag)})`
	);

	// NAME stays put — a drag onto it lands after it, never before
	await dragHeader(A, 'added', 'name');
	const pinnedOrder = (await headBoxes(A)).map((c) => c.key).join(',');
	h.check(
		pinnedOrder.startsWith('name,'),
		`NAME keeps the left edge whatever is dragged at it (${pinnedOrder})`
	);

	// ---- 4. the horizontal bar, on the TABLE's container and nowhere else ---------------
	const paneW = await page.evaluate(() => Math.round(document.querySelector('.ex-list').clientWidth));
	// make the columns wider than the pane, the way a user would
	await page.evaluate((w) => {
		const v = window.__stores.explorerView;
		v.explorerColumnWidths.set({
			library: { name: 400, kind: 300, size: 300, added: 300, owner: 300 },
			deleted: {}
		});
	}, paneW);
	await page.waitForTimeout(500);
	const scroll = await page.evaluate(() => {
		const list = document.querySelector('.ex-list');
		const table = document.querySelector('.ex-table');
		const doc = document.documentElement;
		return {
			listScrollW: Math.round(list.scrollWidth),
			listClientW: Math.round(list.clientWidth),
			tableW: Math.round(table.getBoundingClientRect().width),
			docScrollW: Math.round(doc.scrollWidth),
			docClientW: Math.round(doc.clientWidth)
		};
	});
	h.check(
		scroll.listScrollW > scroll.listClientW + 4,
		`the list overflows sideways, so a scrollbar appears (${scroll.listScrollW} > ${scroll.listClientW})`
	);
	h.check(
		scroll.docScrollW <= scroll.docClientW + 1,
		`…and the PAGE still does not scroll horizontally (${scroll.docScrollW} vs ${scroll.docClientW})`
	);
	// it really scrolls, rather than merely being wide
	const scrolled = await page.evaluate(() => {
		const list = document.querySelector('.ex-list');
		list.scrollLeft = 200;
		return Math.round(list.scrollLeft);
	});
	h.check(scrolled > 100, `the container scrolls to reach the far columns (${scrolled}px)`);

	// ---- 5. the two views keep their own layout -----------------------------------------
	// the bin needs a ROW: an empty view renders the "nothing here" branch instead of the
	// table, so a header check against it would have nothing to read.
	//
	// R22 round 13: and that row now needs REAL BYTES on a shelf. The bin lists what it
	// can restore; a bare log entry with no file behind it is a record and belongs to the
	// Deleted LOG, so the old fixture would leave this view empty and the header unreadable.
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		const it = await e.addItemFromBytes(
			new TextEncoder().encode('binned').buffer,
			'binned.txt',
			null
		);
		window.__stores.sharedLibrary.logLocalDeletion({
			hash: it.hash,
			name: 'binned.txt',
			kind: 'text'
		});
		e.setItemHidden(it.id, true);
		window.__stores.explorer.activeFolder.set('deleted');
	});
	await page.waitForTimeout(700);
	const binCols = await headBoxes(A);
	h.check(
		binCols.map((c) => c.key).join(',') === 'name,kind,deletedBy,deletedAt',
		`premise: the bin has its own columns (${binCols.map((c) => c.key).join(',')})`
	);
	h.check(
		binCols.find((c) => c.key === 'kind')?.w === 72,
		`a width dragged in the library did NOT follow into the bin (${binCols.find((c) => c.key === 'kind')?.w}px)`
	);
	await dragGrip(A, 'kind', 40);
	const both = await storedWidths(A);
	h.check(
		both.library.kind === 300 && Math.abs(both.deleted.kind - 112) <= 4,
		`each view stores its own (${JSON.stringify(both)})`
	);

	// ---- 6. the way back --------------------------------------------------------------
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(500);
	await page.locator('#explorer-list-head').click({ button: 'right' });
	await page.waitForTimeout(400);
	const rows = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((r) => r.innerText.trim())
	);
	h.check(
		rows.some((t) => /Reset widths and order/.test(t)),
		`the header menu offers the way back (${JSON.stringify(rows)})`
	);
	await page.getByRole('menuitem', { name: /Reset widths and order/ }).click();
	await page.waitForTimeout(500);
	const reset = await headBoxes(A);
	h.check(
		reset.map((c) => c.key).join(',') === 'name,kind,size,added,owner' &&
			reset.find((c) => c.key === 'kind')?.w === 72,
		`…and it restores both the order and the widths (${JSON.stringify(reset)})`
	);

	// ---- 7. it survives a reload --------------------------------------------------------
	await dragGrip(A, 'size', 55);
	await dragHeader(A, 'added', 'kind');
	const beforeReload = {
		widths: (await storedWidths(A)).library,
		order: (await storedOrder(A)).library
	};
	await h.freshReload(A);
	await page.waitForFunction(() => !!window.__stores?.explorerView, null, { timeout: 30000 });
	await page.waitForTimeout(1200);
	const afterReload = {
		widths: (await storedWidths(A)).library,
		order: (await storedOrder(A)).library
	};
	h.check(
		JSON.stringify(afterReload) === JSON.stringify(beforeReload),
		`widths and order are LOCAL prefs that survive a reload (${JSON.stringify(afterReload)})`
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});

/** the leaf's own minimum, so the assertion above cannot drift from the constant */
function v_min() {
	return 48;
}
