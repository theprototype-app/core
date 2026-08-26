// R22 ROUND 11, PHASE 1 — three reported delete/confirm items.
//
//  §1-§5  "when right click delete instead of toast confirmation I should have
//         confirmation within Explorer (otherwise its confusing to see toast its almost
//         invisible for user eye in that case as viewport is above and file operations
//         happen inside Explorer)". FIVE destructive file actions asked somewhere else:
//         three through the app-wide modal (item, prefab, Empty Deleted) and TWO through
//         a two-button toast over the viewport (folder, batch) — which is the shape the
//         report actually names. All five now arm ONE strip pinned to the top of the grid.
//  §6-§9  "should be able to drag to 'Deleted' files and folder from library without
//         confirmation". The pinned row is a drop target; the drag carries the whole
//         selection (round 10's rule); a FOLDER bins its files one by one, because
//         `deleteFolder` reclaims their bytes and an unconfirmed gesture may not do
//         anything irreversible.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- explorer-delete-confirm
const h = require('./helpers.cjs');

/** the app-wide modal, which after this round must never open for a delete */
const modalOf = (p) =>
	p.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
		return d ? d.title : null;
	});

/** the inline strip: its title, or null */
const stripOf = (p) =>
	p.page.evaluate(() => {
		const el = document.querySelector('#explorer-confirm');
		if (!el) return null;
		return {
			title: el.querySelector('.ex-confirm-title')?.textContent?.trim() ?? '',
			detail: el.querySelector('.ex-confirm-detail')?.textContent?.trim() ?? '',
			yes: document.querySelector('#explorer-confirm-yes')?.textContent?.trim() ?? '',
			focused: document.activeElement?.id ?? ''
		};
	});

const visibleNames = (p) =>
	p.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.map((i) => i.name).sort();
	});

const binNames = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return window.__stores.sharedLibrary
			.deletedLog(m)
			.map((r) => r.name)
			.sort();
	});

const toastTexts = (p) =>
	p.page.evaluate(() => {
		let t;
		window.__stores.toastStore.subscribe((v) => (t = v))();
		return (t ?? []).map((x) => String(typeof x === 'string' ? x : (x.text ?? x.message ?? '')));
	});

const clearToasts = (p) => p.page.evaluate(() => window.__stores.toastStore.set([]));

/** right-click a card by id and read the menu row labels */
async function cardMenu(p, id) {
	await p.page.evaluate((cardId) => {
		const el = document.querySelector('[data-card-id="' + cardId + '"]');
		const box = el.getBoundingClientRect();
		el.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				clientX: Math.round(box.left + 8),
				clientY: Math.round(box.top + 8)
			})
		);
	}, id);
	await p.page.waitForTimeout(350);
}

/** close a portaled menu with a REAL pointerdown (it ignores a plain click) */
async function closeMenu(p) {
	await p.page.mouse.move(4, 300);
	await p.page.mouse.down();
	await p.page.mouse.up();
	await p.page.waitForTimeout(200);
}

/** one DataTransfer across dragstart/dragover/drop, so the payload the app wrote is the
 * payload it reads back (round 10's recipe) */
const dragOnto = (p, fromCardId, toSelector) =>
	p.page.evaluate(
		({ from, to }) => {
			const card = document.querySelector('[data-card-id="' + from + '"]');
			const target = document.querySelector(to);
			if (!card || !target) return { ok: false, why: !card ? 'no card' : 'no target' };
			const dt = new DataTransfer();
			card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
			const payload = dt.getData('application/x-explorer-item') || dt.getData('application/x-explorer-folder');
			target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
			target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
			return { ok: true, payload: payload ? JSON.parse(payload) : null };
		},
		{ from: fromCardId, to: toSelector }
	);

const seedFiles = (p, names, folderId = null) =>
	p.page.evaluate(
		async ({ list, dir }) => {
			const e = window.__stores.explorer;
			const enc = (s) => new TextEncoder().encode(s).buffer;
			const out = [];
			for (const n of list) out.push((await e.addItemFromBytes(enc('body-of-' + n), n, dir)).id);
			return out;
		},
		{ list: names, dir: folderId }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.explorer && !!window.__stores?.sharedLibrary, null, {
		timeout: 30000
	});
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.waitForTimeout(400);
	// the bin must survive this run rather than being emptied under it
	await page.evaluate(() => window.__stores.sharedLibrary.keepRecycleBin.set(true));

	const wipe = () =>
		page.evaluate(async () => {
			await window.__stores.explorer.clearLibrary();
			const pm = window.__stores.projectManifest;
			pm.projectManifest.update((m) => ({ ...m, deleted: [], removed: { items: {}, folders: {} } }));
		});

	await wipe();
	const ids = await seedFiles(A, ['alpha.txt', 'beta.txt', 'gamma.txt']);
	await page.waitForTimeout(500);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(800);

	// ---- 1. Delete asks INSIDE the Explorer, and the modal never opens ---------------
	h.check((await visibleNames(A)).length === 3, 'premise: three files in the library');
	await cardMenu(A, ids[0]);
	const menuRows = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((r) => r.innerText.trim())
	);
	h.check(menuRows.includes('Delete'), 'premise: the item menu offers Delete (' + menuRows.length + ' rows)');
	await page.getByRole('menuitem', { name: /^Delete$/ }).click();
	await page.waitForTimeout(400);

	const strip = await stripOf(A);
	h.check(!!strip, 'the question appears as a strip inside the Explorer');
	h.check(
		!!strip && /alpha\.txt/.test(strip.title),
		'and it names the file (' + (strip ? strip.title : 'n/a') + ')'
	);
	h.check((await modalOf(A)) === null, 'the app-wide modal did NOT open');
	h.check(
		!(await toastTexts(A)).some((t) => /^Delete /.test(t)),
		'and no confirmation toast was thrown over the viewport'
	);
	h.check(
		!!strip && strip.focused === 'explorer-confirm-yes',
		'the answer takes focus, so Enter confirms and Esc has a handler to reach (' +
			(strip ? strip.focused : 'n/a') +
			')'
	);
	h.check(
		(await visibleNames(A)).length === 3,
		'NOTHING is deleted while the question is standing'
	);

	// the strip is INSIDE the scroller it is about — that is the whole point of the report
	const inside = await page.evaluate(() => {
		const s = document.querySelector('#explorer-confirm');
		const g = document.querySelector('#explorer-grid');
		if (!s || !g) return null;
		const sr = s.getBoundingClientRect();
		const gr = g.getBoundingClientRect();
		return { in: sr.top >= gr.top - 2 && sr.left >= gr.left - 2 && sr.right <= gr.right + 2, w: Math.round(sr.width) };
	});
	h.check(!!inside && inside.in, 'it is laid out inside #explorer-grid (' + JSON.stringify(inside) + ')');

	// ---- 2. Cancel, then Escape ------------------------------------------------------
	await page.locator('#explorer-confirm-no').click();
	await page.waitForTimeout(300);
	h.check((await stripOf(A)) === null, 'Cancel dismisses the strip');
	h.check((await visibleNames(A)).length === 3, 'and deletes nothing');

	await cardMenu(A, ids[0]);
	await page.getByRole('menuitem', { name: /^Delete$/ }).click();
	await page.waitForTimeout(400);
	h.check(!!(await stripOf(A)), 'premise: armed again');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	h.check((await stripOf(A)) === null, 'Escape dismisses it too');
	h.check((await visibleNames(A)).length === 3, 'and still deletes nothing');

	// ---- 3. the second press is the answer -------------------------------------------
	await clearToasts(A);
	await cardMenu(A, ids[0]);
	await page.getByRole('menuitem', { name: /^Delete$/ }).click();
	await page.waitForTimeout(400);
	await page.locator('#explorer-confirm-yes').click();
	await page.waitForTimeout(700);
	h.check((await stripOf(A)) === null, 'answering closes the strip');
	const after1 = await visibleNames(A);
	h.check(
		after1.length === 2 && !after1.includes('alpha.txt'),
		'the file is gone from the library (' + JSON.stringify(after1) + ')'
	);
	h.check((await binNames(A)).includes('alpha.txt'), 'and it is in Deleted, where it can be restored');

	// ---- 4. `deleteWithoutConfirm` still skips the asking -----------------------------
	await page.evaluate(() => window.__stores.sharedLibrary.deleteWithoutConfirm.set(true));
	await cardMenu(A, ids[1]);
	await page.getByRole('menuitem', { name: /^Delete$/ }).click();
	await page.waitForTimeout(600);
	h.check((await stripOf(A)) === null, 'with "do not ask" on there is no strip');
	h.check(
		!(await visibleNames(A)).includes('beta.txt'),
		'and the delete happened straight away — moving WHERE we ask did not re-enable asking'
	);

	// ...but Empty Deleted asks ANYWAY: the bin is what makes a delete reversible, and
	// emptying it is the one act in the Explorer that takes bytes for good.
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('deleted'));
	await page.waitForTimeout(500);
	await page.locator('#deleted-folder').click({ button: 'right' });
	await page.waitForTimeout(400);
	const binMenu = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((r) => r.innerText.trim())
	);
	h.check(
		binMenu.some((t) => /^Empty Deleted/.test(t)),
		'premise: the bin row offers Empty Deleted (' + JSON.stringify(binMenu.slice(-2)) + ')'
	);
	await page.getByRole('menuitem', { name: /^Empty Deleted/ }).click();
	await page.waitForTimeout(400);
	const emptyStrip = await stripOf(A);
	h.check(
		!!emptyStrip && /Empty Deleted/.test(emptyStrip.title),
		'Empty Deleted asks in the strip EVEN WITH "do not ask" on (' +
			(emptyStrip ? emptyStrip.title : 'n/a') +
			')'
	);
	h.check((await modalOf(A)) === null, 'and not through the app-wide modal');
	await page.locator('#explorer-confirm-no').click();
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.sharedLibrary.deleteWithoutConfirm.set(false));
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(400);

	// ---- 5. the two TOAST confirms became the same strip ------------------------------
	await wipe();
	const folderIds = await page.evaluate(() => {
		const e = window.__stores.explorer;
		return { doomed: e.createFolder('Doomed', null).id, keep: e.createFolder('Keep', null).id };
	});
	await seedFiles(A, ['inside-a.txt', 'inside-b.txt'], folderIds.doomed);
	const looseIds = await seedFiles(A, ['loose-1.txt', 'loose-2.txt']);
	await page.waitForTimeout(700);
	await clearToasts(A);

	// a FOLDER — this was a toast pair
	await cardMenu(A, folderIds.doomed);
	await page.getByRole('menuitem', { name: /^Delete folder$/ }).click();
	await page.waitForTimeout(400);
	const folderStrip = await stripOf(A);
	h.check(
		!!folderStrip && /Doomed/.test(folderStrip.title),
		'deleting a FOLDER asks in the strip, not in a toast (' + (folderStrip ? folderStrip.title : 'n/a') + ')'
	);
	h.check(
		!!folderStrip && /destroyed/.test(folderStrip.detail),
		'and it says the files inside are DESTROYED — the asymmetry that keeps this one asking (' +
			(folderStrip ? folderStrip.detail : 'n/a') +
			')'
	);
	h.check(
		!(await toastTexts(A)).some((t) => /^Delete "/.test(t)),
		'no two-button toast was raised for it'
	);
	await page.locator('#explorer-confirm-no').click();
	await page.waitForTimeout(300);

	// a BATCH — this was a toast pair too
	await page.evaluate((sel) => {
		const click = (id, ctrl) =>
			document
				.querySelector('[data-card-id="' + id + '"]')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ctrl }));
		click(sel[0], false);
		click(sel[1], true);
	}, looseIds);
	await page.waitForTimeout(300);
	await cardMenu(A, looseIds[1]);
	const batchRows = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((r) => r.innerText.trim())
	);
	const delRow = batchRows.find((t) => /^Delete /.test(t));
	h.check(!!delRow, 'premise: the batch menu offers a counted Delete (' + delRow + ')');
	await page.getByRole('menuitem', { name: new RegExp('^' + delRow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }).click();
	await page.waitForTimeout(400);
	const batchStrip = await stripOf(A);
	h.check(
		!!batchStrip && /^Delete 2 items\?$/.test(batchStrip.title),
		'a BATCH delete asks in the strip and names the count (' + (batchStrip ? batchStrip.title : 'n/a') + ')'
	);
	await page.locator('#explorer-confirm-no').click();
	await page.waitForTimeout(300);
	h.check(
		(await visibleNames(A)).filter((n) => /^loose/.test(n)).length === 2,
		'cancelling a batch keeps both files'
	);

	// ---- 6. THE DELETED ROW IS A DROP TARGET, and it appears for a drag ---------------
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.evaluate(() => {
		const pm = window.__stores.projectManifest;
		pm.projectManifest.update((m) => ({ ...m, deleted: [] }));
	});
	await page.waitForTimeout(500);
	h.check(
		(await page.locator('#deleted-folder').count()) === 0,
		'premise: the bin row is hidden while the bin is empty'
	);
	// dragstart alone must unhide it, or the FIRST delete-by-drag is impossible
	await page.evaluate((id) => {
		const card = document.querySelector('[data-card-id="' + id + '"]');
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
	}, looseIds[0]);
	await page.waitForTimeout(300);
	h.check(
		(await page.locator('#deleted-folder').count()) === 1,
		'a library drag unhides it — a row you cannot see is a row you cannot drop on'
	);
	await page.evaluate(() => window.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
	await page.waitForTimeout(300);
	h.check((await page.locator('#deleted-folder').count()) === 0, 'and it hides again when the drag ends');

	// ---- 7. a drop deletes with NO confirmation, carrying the whole selection ----------
	await clearToasts(A);
	await page.evaluate((sel) => {
		const click = (id, ctrl) =>
			document
				.querySelector('[data-card-id="' + id + '"]')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ctrl }));
		click(sel[0], false);
		click(sel[1], true);
	}, looseIds);
	await page.waitForTimeout(300);
	// dragstart and the drop are TWO evaluates on purpose: the bin row only exists once
	// `libraryDragging` has re-rendered, and svelte has not flushed inside the same tick.
	// A real drag never has this problem — a person moves the pointer over the row long
	// after the frame that unhid it.
	const carried = await page.evaluate((sel) => {
		const card = document.querySelector('[data-card-id="' + sel[1] + '"]');
		window.__dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }));
		const payload = JSON.parse(window.__dt.getData('application/x-explorer-item'));
		return payload.items?.length ?? 1;
	}, looseIds);
	await page.waitForTimeout(300);
	const dropped = await page.evaluate(() => {
		const row = document.querySelector('#deleted-folder');
		if (!row) return { dropped: false };
		row.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: window.__dt }));
		row.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: window.__dt }));
		return { dropped: true };
	});
	await page.waitForTimeout(900);
	h.check(
		dropped.dropped && carried === 2,
		'premise: the drag carried BOTH selected files (' + JSON.stringify({ carried, ...dropped }) + ')'
	);
	h.check((await stripOf(A)) === null, 'a DROP asks nothing — the gesture is its own consent');
	const leftOver = (await visibleNames(A)).filter((n) => /^loose/.test(n));
	h.check(
		leftOver.length === 0,
		'and BOTH files are gone, not just the card that was picked up (' + JSON.stringify(leftOver) + ')'
	);
	const binned = await binNames(A);
	h.check(
		binned.includes('loose-1.txt') && binned.includes('loose-2.txt'),
		'both are in Deleted, restorable (' + JSON.stringify(binned) + ')'
	);
	const restorable = await page.evaluate(() =>
		window.__stores.sharedLibrary.canRestoreDeleted(
			(() => {
				let items;
				window.__stores.explorer.hiddenItems.subscribe((v) => (items = v))();
				return items.find((i) => i.name === 'loose-1.txt')?.hash;
			})()
		)
	);
	h.check(restorable, 'a dropped file keeps its bytes — Restore can work');

	// ---- 8. a FOLDER drop bins its files rather than destroying them ------------------
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(400);
	const folderDrop = await page.evaluate((fid) => {
		const card = document.querySelector('[data-card-id="' + fid + '"]');
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const row = document.querySelector('#deleted-folder');
		if (!row) return { dropped: false };
		row.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		row.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		return { dropped: true };
	}, folderIds.doomed);
	await page.waitForTimeout(1200);
	h.check(folderDrop.dropped, 'premise: the folder was dropped on the bin row');
	const foldersLeft = await page.evaluate(() => {
		let f;
		window.__stores.explorer.explorerFolders.subscribe((v) => (f = v))();
		return f.map((x) => x.name).sort();
	});
	h.check(
		!foldersLeft.includes('Doomed') && foldersLeft.includes('Keep'),
		'the folder is gone and its neighbour is untouched (' + JSON.stringify(foldersLeft) + ')'
	);
	const insideBin = await binNames(A);
	h.check(
		insideBin.includes('inside-a.txt') && insideBin.includes('inside-b.txt'),
		'every file that was inside it is in Deleted (' + JSON.stringify(insideBin) + ')'
	);
	// THE POINT of doing it file by file: `deleteFolder` reclaims blobs, and an
	// unconfirmed gesture may not do anything irreversible
	const bytesKept = await page.evaluate(() => {
		let items;
		window.__stores.explorer.hiddenItems.subscribe((v) => (items = v))();
		const row = items.find((i) => i.name === 'inside-a.txt');
		return row ? { canRestore: window.__stores.sharedLibrary.canRestoreDeleted(row.hash), folderId: row.folderId } : null;
	});
	h.check(
		!!bytesKept && bytesKept.canRestore,
		'their BYTES survive, so the drop is reversible (' + JSON.stringify(bytesKept) + ')'
	);
	h.check(
		!!bytesKept && (bytesKept.folderId ?? null) === null,
		'and they lost their folderId, so Restore puts them at the root instead of inside a folder that no longer exists'
	);

	// ---- 9. restore really works from a dropped file ---------------------------------
	const restored = await page.evaluate(() => {
		let items;
		window.__stores.explorer.hiddenItems.subscribe((v) => (items = v))();
		const row = items.find((i) => i.name === 'inside-a.txt');
		return window.__stores.sharedLibrary.restoreDeletedItem(row.hash);
	});
	await page.waitForTimeout(700);
	h.check(restored, 'Restore returns true for a file binned by drag');
	h.check(
		(await visibleNames(A)).includes('inside-a.txt'),
		'and the file is back on the visible shelf'
	);

	// ---- 10. R22 ROUND 12: the way OUT of being asked ---------------------------------
	// "for delete add Settings button after tooltip 'It moves to Deleted...' which will open
	// app settings modal with Files accordion expanded". The strip's detail talks about the
	// bin and about being asked at all, and BOTH of those are switches in Settings - so it
	// offers the way there instead of describing it.
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(500);
	const freshIds = await seedFiles(A, ['settings-probe.txt']);
	await page.waitForTimeout(600);
	await cardMenu(A, freshIds[0]);
	await page.getByRole('menuitem', { name: /^Delete$/ }).click();
	await page.waitForTimeout(400);
	h.check(!!(await stripOf(A)), 'premise: the strip is armed');
	h.check(
		(await page.locator('#explorer-confirm-settings').count()) === 1,
		'the strip offers a File settings button beside the question'
	);
	await page.locator('#explorer-confirm-settings').click();
	await page.waitForTimeout(900);
	const opened = await page.evaluate(() => {
		let open, section;
		window.__stores.settingsOpen.subscribe((v) => (open = v))();
		window.__stores.settingsSection.subscribe((v) => (section = v))();
		// which accordion is actually EXPANDED, read from the DOM rather than from the store
		// that asked for it - the store being right while the panel stays shut is the bug
		// this deep link existed-but-did-nothing form of, until round 12 wired the last line
		// A NON-MODAL <dialog> CARRIES NO EXPLICIT role, so '[role="dialog"]' matches nothing
		// here — this app's modals are deliberately non-modal (dialog.show()) so the chrome
		// above --z-modal stays clickable, and only the truly-modal ConfirmModal gets the
		// aria-modal attribute the z-index remap keys on. Query the ELEMENT.
		const heads = [...document.querySelectorAll('dialog[open] button')]
			.filter((b) => /^(Explorer|Files)$/.test((b.textContent || '').trim()));
		return {
			open,
			section,
			expanded: heads.some((b) => b.getAttribute('aria-expanded') === 'true'),
			// the switches the strip's own words are about
			hasRecycle: !!document.querySelector('dialog[open]')?.textContent?.match(/recycle bin/i)
		};
	});
	h.check(opened.open === true, 'it opens the Settings modal');
	h.check(
		opened.section === 'explorer',
		'...through the app deep-link seam, not a second concept (' + opened.section + ')'
	);
	h.check(
		opened.expanded,
		'...with the file section EXPANDED - the line that was missing from the seam'
	);
	h.check(
		opened.hasRecycle,
		'...and it really is the section holding the switches the strip talks about'
	);
	h.check((await stripOf(A)) === null, 'the question is dismissed on the way - it is answered in Settings now');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(600);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
