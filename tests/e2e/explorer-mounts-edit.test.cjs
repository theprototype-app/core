// R22 ROUND 13 P3b — EDITING A MOUNTED VOLUME.
//
//   "Load for session button should stay, it replace entire project, mount button is a
//    new button... it would likely be better to be able to mount/unmount multiple
//    projects and have them above 'Library' with save icon and x icon, so current open
//    project memory is not affected."
//
// The EDITING half of the mounted-volumes suite. An edit inside a mount is BUFFERED on the
// volume record (dirty, disk untouched, and it survives a reload); Save writes it back into
// the saved project and touches no live store; copying a file OUT is an ordinary
// hash-deduped library import while copying one IN is buffered until Save; and unmounting a
// dirty volume asks a question with three answers, each of which leaves the view somewhere
// defensible — including the exception where the user walked off during the question.
//
// It was split out of `explorer-mounts` when that file ran past the runner's 8-minute
// per-suite budget (tests/e2e/run.cjs) and was killed mid-run at 480s with every executed
// check green. The section NUMBERS are the undivided file's, kept so a reader can put the
// two halves back beside the original. This half BUILDS ITS OWN PREMISES: §10 already
// cleared the library, made its two fixture files and saved and mounted the project it
// edits, which is why the seam is exactly here — all that had to be added above it is the
// loaded library, an empty mount list and one object in the scene.
//
// Premise traps paid for up front:
//  · ContextMenu rows are `[role=menuitem]` DIVs, not buttons.
//  · The Sessions manager is a NON-modal dialog — it must be closed again or it sits over
//    the Explorer.
//  · `#session-save-confirm` needs a name in `#session-save-name`; two projects with the
//    same name are indistinguishable in the picker.
//
// Run: APP_URL='https://localhost:5205/' npm run e2e -- explorer-mounts-edit
const h = require('./helpers.cjs');

/** the mounted volumes, flattened to what the assertions read */
const vols = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
		return (v ?? []).map((r) => ({
			id: r.id,
			sessionId: r.sessionId,
			name: r.name,
			folders: (r.folders ?? []).map((f) => f.name).sort(),
			items: (r.items ?? []).map((i) => i.name).sort(),
			itemIds: (r.items ?? []).map((i) => i.id),
			hashes: (r.items ?? []).map((i) => i.hash),
			sizes: (r.items ?? []).map((i) => i.size),
			buffered: (r.items ?? []).filter((i) => !!i.blob).length,
			dirty: !!r.dirty,
			missing: !!r.missing
		}));
	});

/** the LIVE library, as one comparable string — the thing a mount must never move */
const librarySnapshot = (p) =>
	p.page.evaluate(() => {
		const e = window.__stores.explorer;
		const read = (s) => {
			let v;
			s.subscribe((x) => (v = x))();
			return v ?? [];
		};
		return JSON.stringify({
			folders: read(e.explorerFolders),
			items: read(e.explorerItems),
			hidden: read(e.hiddenItems)
		});
	});

/** the shared index as the project document carries it */
const sharedIndex = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		return JSON.stringify({ folders: m.folders ?? [], items: m.items ?? [] });
	});

const menuRows = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].map((el) => el.innerText.trim()).filter(Boolean)
	);

const activeFolderOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.activeFolder.subscribe((x) => (v = x))();
		return v;
	});

/** save the CURRENT scene+library as a project, through the real Sessions UI */
async function saveProject(p, name) {
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await p.page.waitForTimeout(900);
	await p.page.locator('#session-save-project').click();
	await p.page.waitForTimeout(400);
	await p.page.locator('#session-save-name').fill(name);
	await p.page.locator('#session-save-confirm').click();
	await h.eventually(
		() =>
			p.page.evaluate(() => {
				let v;
				window.__stores.sessions.sessions.subscribe((x) => (v = x))();
				return (v ?? []).map((m) => m.name);
			}),
		(names) => names.includes(name),
		'the project "' + name + '" is saved',
		25000
	);
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await p.page.waitForTimeout(500);
}

/** mount a saved project through the Explorer's own picker */
async function mountThroughUi(p, name) {
	await p.page.locator('#explorer-mount-add').click();
	// the picker AWAITS loadSessions(), which reads every saved payload in full — with a
	// real project's blobs in there that is comfortably longer than any fixed sleep
	await p.page.waitForSelector('[role=menuitem]', { timeout: 20000 });
	await p.page.waitForTimeout(300);
	const rows = await menuRows(p);
	const row = rows.find((r) => r.startsWith(name));
	if (!row) throw new Error('the mount picker did not offer "' + name + '": ' + JSON.stringify(rows));
	await p.page.locator('[role=menuitem]', { hasText: name }).first().click();
	// mounting reads the whole saved payload out of idb (blobs included), so wait on the
	// STORE rather than on a sleep
	await h.eventually(
		() => vols(p),
		(list) => list.some((v) => v.name === name),
		'"' + name + '" is mounted',
		20000
	);
	await p.page.waitForTimeout(400);
	return rows;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(
		() => !!window.__stores?.mountedVolumes && !!window.__stores?.explorer && !!window.__stores?.sessions,
		null,
		{ timeout: 30000 }
	);
	h.check(true, 'premise: the mountedVolumes leaf is on the debug hook');

	// a clean library and a scene worth saving. Section 10 builds the fixture FILES itself,
	// which is why the seam is here — all this half needs first is the state the
	// undivided suite's opening block used to leave behind: the library loaded from idb,
	// nothing mounted, and one object in the scene so a saved project is a real one.
	await page.evaluate(async () => {
		const s = window.__stores;
		await s.explorer.loadExplorer();
		await s.explorer.clearLibrary();
		for (const v of await new Promise((r) => {
			s.mountedVolumes.mountedVolumes.subscribe((x) => r(x ?? []))();
		}))
			await s.mountedVolumes.unmountVolume(v.id);
		s.commandsHandler.sceneCommand('/create box');
	});
	await page.waitForTimeout(1400);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(400);

	// and the Explorer OPEN: section 10 mounts through the picker, whose entry point is
	// `#explorer-mount-add` inside the panel. In the undivided suite section 2 had opened
	// it and every later section inherited that; here it is a premise this half owes
	// itself. (Section 13 opens it again after its reload, exactly as it always did.)
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);

	// ---- 10. P3b: a clean mount to EDIT ---------------------------------------------
	// In the undivided suite the volume above this line had had its saved record deleted
	// on purpose, so P3b started from a fresh project rather than reasoning about a
	// broken one. It still does, and that is exactly why the seam is here.
	await page.evaluate(async () => {
		const s2 = window.__stores;
		let mv;
		s2.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		for (const v of mv) await s2.mountedVolumes.unmountVolume(v.id);
		await s2.explorer.clearLibrary();
		const enc = (t) => new TextEncoder().encode(t).buffer;
		const f = s2.explorer.createFolder('Timber', null);
		await s2.explorer.addItemFromBytes(enc('p'.repeat(220)), 'plank.txt', f.id);
		await s2.explorer.addItemFromBytes(enc('n'.repeat(310)), 'nails.txt', null);
	});
	await page.waitForTimeout(700);
	await saveProject(A, 'Yard');
	await mountThroughUi(A, 'Yard');
	let yard = (await vols(A))[0];
	h.check(
		!!yard && yard.name === 'Yard' && !yard.dirty,
		`a fresh mount starts clean (${yard && yard.name}, dirty=${yard && yard.dirty})`
	);
	// the library, and the SAVED RECORD, as they stand before any edit
	const libBeforeEdit = await librarySnapshot(A);
	const savedNames = (peer, sessionId) =>
		peer.page.evaluate(async (id) => {
			const rec = await window.__stores.idb.idbGet('session:' + id);
			return (rec?.library?.items ?? []).map((i) => i.name).sort();
		}, sessionId);
	const beforeSave = await savedNames(A, yard.sessionId);
	h.check(
		beforeSave.join(',') === 'nails.txt,plank.txt',
		`premise: the saved project holds both files (${beforeSave.join(',')})`
	);

	// ---- 11. an edit is BUFFERED: dirty, and disk untouched -------------------------
	await page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + yard.id);
	await page.waitForTimeout(600);
	const target = (await vols(A))[0].itemIds[0];
	await page.evaluate(async (id) => {
		const s2 = window.__stores;
		let mv;
		s2.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const row = mv[0].items.find((i) => i.id === id);
		s2.mountedVolumes.volumeRenameItem(mv[0].id, id, 'renamed-' + row.name);
	}, target);
	await page.waitForTimeout(600);
	yard = (await vols(A))[0];
	h.check(
		yard.dirty && yard.items.some((nm) => nm.startsWith('renamed-')),
		`a rename inside the mount is buffered and marks it dirty (${yard.items.join(',')})`
	);
	h.check(
		await page.locator('#mount-save-' + yard.id).isEnabled(),
		'…the Save button LIGHTS (it is disabled while there is nothing to write)'
	);
	h.check(
		(await librarySnapshot(A)) === libBeforeEdit,
		'…the live library is untouched by the edit'
	);
	h.check(
		(await savedNames(A, yard.sessionId)).join(',') === beforeSave.join(','),
		'…and NOTHING has reached the saved project yet'
	);

	// ---- 12. THE BUFFER SURVIVES A RELOAD (the guard proven by breaking it) ---------
	await h.freshReload(A);
	await page.waitForFunction(() => !!window.__stores?.mountedVolumes, null, { timeout: 30000 });
	await page.evaluate(async () => {
		await window.__stores.mountedVolumes.loadMountedVolumes();
		await window.__stores.explorer.loadExplorer();
	});
	await page.waitForTimeout(1200);
	const survived = (await vols(A))[0];
	h.check(
		!!survived && survived.items.some((nm) => nm.startsWith('renamed-')),
		`the BUFFERED edit survives a reload — a reload that discarded it would silently lose work (${survived && survived.items.join(',')})`
	);
	h.check(survived.dirty, '…and it still reads as unsaved');

	// ---- 13. SAVE BACK ---------------------------------------------------------------
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(800);
	const manifestBefore = await sharedIndex(A);
	await page.locator('#mount-save-' + survived.id).click();
	await h.eventually(
		() => savedNames(A, survived.sessionId),
		(names) => names.some((nm) => nm.startsWith('renamed-')),
		'Save writes the edit back into the saved project',
		20000
	);
	await h.eventually(
		() => vols(A),
		(list) => !list[0].dirty,
		'the mount stops reading as dirty once it is written',
		15000
	);
	const saved = (await vols(A))[0];
	h.check(
		saved.buffered === 0,
		'…and stops carrying a second copy of the bytes (they are in the session again)'
	);
	h.check(
		(await librarySnapshot(A)) === libBeforeEdit,
		'SAVE-BACK TOUCHED NO LIVE STORE: the library is still byte-identical'
	);
	h.check(
		(await sharedIndex(A)) === manifestBefore,
		'…and the project manifest is untouched by it'
	);
	const bothStillThere = await savedNames(A, survived.sessionId);
	h.check(
		bothStillThere.length === 2,
		`…and the OTHER file is still in the record — a save is a rewrite, not a replace of what it knows (${bothStillThere.join(',')})`
	);

	// ---- 14. copy OUT is a real import, hash-deduped --------------------------------
	// FIXTURE, and it cost a red to learn: a RENAME does not change bytes, so the file in
	// the mount is content-identical to the one the library already holds — and
	// `addItemFromBytes` correctly answers with the item it has. The copy-out was working
	// and the count could not move. Empty the library so the import has something to do.
	await page.evaluate(async () => {
		await window.__stores.explorer.clearLibrary();
	});
	await page.waitForTimeout(600);
	await page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + saved.id);
	await page.waitForTimeout(700);
	const copyOut = await page.evaluate(() => {
		const card = document.querySelector('.ex-cards [data-card-id^="vitem:"]');
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const lib = document.querySelector('#explorer-root-row');
		lib.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		lib.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		return card.getAttribute('data-card-id');
	});
	await h.eventually(
		() =>
			page.evaluate(() => {
				let v;
				window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
				return v.map((i) => i.name);
			}),
		(names) => names.length === 1,
		'dragging a mounted file onto Library IMPORTS it',
		15000
	);
	const afterCopyOut = await page.evaluate((id) => {
		const s2 = window.__stores;
		let lib;
		s2.explorer.explorerItems.subscribe((x) => (lib = x))();
		let mv;
		s2.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const row = mv[0].items.find((i) => i.id === id);
		return {
			libNames: lib.map((i) => i.name).sort(),
			matchedByHash: lib.filter((i) => i.hash === row.hash).length,
			stillInVolume: mv[0].items.length,
			dirty: !!mv[0].dirty
		};
	}, copyOut);
	h.check(
		afterCopyOut.matchedByHash === 1,
		`…as a real library item with the SAME content hash (${afterCopyOut.libNames.join(',')})`
	);
	h.check(
		afterCopyOut.stillInVolume === 2 && !afterCopyOut.dirty,
		'…and copying OUT changes nothing in the mount (it is a copy, not a move)'
	);
	// the same bytes again are the same file — the library's own invariant, inherited free
	await page.evaluate(() => {
		const card = document.querySelector('.ex-cards [data-card-id^="vitem:"]');
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const lib = document.querySelector('#explorer-root-row');
		lib.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		lib.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
	});
	await page.waitForTimeout(1500);
	const twiceOut = await page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.length;
	});
	h.check(
		twiceOut === 1,
		`copying the same file out twice is ONE item — the one-item-per-hash invariant, inherited rather than re-implemented (${twiceOut})`
	);

	// ---- 15. copy IN is buffered ----------------------------------------------------
	// bytes the VOLUME does not hold, for the mirror of the reason above: a volume dedupes
	// on its own hashes, so copying in something it already has is a no-op by design
	await page.evaluate(async () => {
		const enc = (t) => new TextEncoder().encode(t).buffer;
		await window.__stores.explorer.addItemFromBytes(enc('k'.repeat(455)), 'brick.txt', null);
	});
	await page.waitForTimeout(600);
	await page.locator('#explorer-root-row').click();
	await page.waitForTimeout(600);
	const libCard = await page.evaluate(() => {
		const el = [...document.querySelectorAll('.ex-cards .explorer-card')].find((c) =>
			(c.innerText ?? '').includes('brick.txt')
		);
		return el?.getAttribute('data-card-id') ?? null;
	});
	h.check(!!libCard, 'premise: the library file to drag is on screen');
	await page.evaluate(
		({ id, vol }) => {
			const card = document.querySelector('[data-card-id="' + id + '"]');
			const dt = new DataTransfer();
			card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
			const row = document.querySelector('[data-mount="' + vol + '"]');
			row.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
			row.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		},
		{ id: libCard, vol: saved.id }
	);
	await h.eventually(
		() => vols(A),
		(list) => list[0].items.some((nm) => nm === 'brick.txt'),
		'dragging a library file onto a mount copies it IN',
		15000
	);
	const afterCopyIn = await vols(A);
	h.check(
		afterCopyIn[0].dirty && afterCopyIn[0].buffered === 1,
		`…buffered, with its bytes carried on the mount record so a reload cannot lose them (${afterCopyIn[0].buffered} buffered)`
	);
	h.check(
		(await savedNames(A, saved.sessionId)).length === 2,
		'…and nothing has reached the saved project until Save is pressed'
	);
	await page.locator('#mount-save-' + saved.id).click();
	await h.eventually(
		() => savedNames(A, saved.sessionId),
		(names) => names.length === 3,
		'…which then writes all three',
		20000
	);

	// ---- 16. unmount with unsaved changes: THREE outcomes, and the view MOVES --------
	//
	// R22 round 13 (user): "it should also navigate user forcefully to that project in
	// explorer, so user would see what he dismiss, and logical to have to have option
	// 'save and unmount' there and all save/discard/cancel options after complete should
	// return user to the folder he were, right? unless I have navigated to some folder
	// while this notification is opened".
	//
	// Four things are measured here and the LAST is the one worth breaking the code over:
	// the restore has an EXCEPTION, and an exception nothing exercises is a comment. The
	// three destinations a settle can pick (back where you were / left where you walked /
	// the Library because the place itself has gone) each get their own reading.
	// ---------------------------------------------------------------------------------
	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		window.__stores.mountedVolumes.volumeRenameItem(mv[0].id, mv[0].items[0].id, 'edited-again.txt');
	});
	// A SAVE IS SEVERAL AWAITS LONG, so this rename lands while the one above may still be
	// finishing — and a save that cleared `dirty` unconditionally would mark it saved when
	// it is not. Measured exactly that way before `rev` existed: the flag read clean and
	// the next unmount took the no-confirm path and discarded the edit.
	await page.waitForTimeout(2000);
	let dirtyVol = (await vols(A))[0];
	h.check(
		dirtyVol.dirty,
		'an edit made while a save is still finishing STAYS dirty — the save is of the older revision'
	);

	// two places to be. `activeFolder.set` is exactly what `openFolder` does (minus
	// clearing the search box), and it is how §11 already navigates in this file.
	const spots = await page.evaluate(() => {
		const e = window.__stores.explorer;
		return { away: e.createFolder('Away', null).id, elsewhere: e.createFolder('Elsewhere', null).id };
	});
	const goTo = (id) => page.evaluate((f) => window.__stores.explorer.activeFolder.set(f), id);
	const armUnmount = async (id) => {
		await page.locator('#mount-unmount-' + id).click();
		await page.waitForSelector('#explorer-confirm-yes', { timeout: 15000 });
		await page.waitForTimeout(300);
	};

	// 16a — the question, its three answers, and the FORCED navigation
	await goTo(spots.away);
	await page.waitForTimeout(500);
	h.check(
		(await activeFolderOf(A)) === spots.away,
		'premise: the user is standing in a Library folder, not in the mount'
	);
	await armUnmount(dirtyVol.id);
	h.check(
		(await activeFolderOf(A)) === `vol:${dirtyVol.id}`,
		'asking MOVES the view onto the mount — the question is answered while looking at the files it is about'
	);
	// view-agnostic on purpose: the grid mode is a REMEMBERED pref, so a card selector
	// alone would read 0 in list view and this check would report a broken feature
	const shownRows = await page.evaluate(
		() => document.querySelectorAll('#explorer-grid [data-card-id^="vitem:"]').length
	);
	h.check(
		shownRows > 0,
		`…and those files are on screen under the standing question (${shownRows} rows)`
	);
	const labels = await page.evaluate(() => ({
		yes: document.querySelector('#explorer-confirm-yes')?.innerText.trim() ?? null,
		alt: document.querySelector('#explorer-confirm-alt')?.innerText.trim() ?? null,
		no: document.querySelector('#explorer-confirm-no')?.innerText.trim() ?? null,
		settings: document.querySelectorAll('#explorer-confirm-settings').length,
		// the PRIMARY must not wear the destructive red: it is the answer that loses nothing
		yesBg: getComputedStyle(document.querySelector('#explorer-confirm-yes')).backgroundColor,
		altBg: document.querySelector('#explorer-confirm-alt')
			? getComputedStyle(document.querySelector('#explorer-confirm-alt')).backgroundColor
			: null
	}));
	h.check(
		labels.yes === 'Save and unmount' && labels.alt === 'Discard and unmount' && labels.no === 'Cancel',
		`three outcomes, not two (${labels.yes} | ${labels.alt} | ${labels.no})`
	);
	// PAIRED with the three labels above, so "no File settings button" cannot pass against
	// a strip that never rendered
	h.check(
		labels.settings === 0,
		'…and the recycle-bin settings link is absent: this question is not a delete'
	);
	// COMPUTED colour, never the class string — the class was never the thing in doubt
	// (the documented `.tbx-on` lesson: an unlayered rule can beat the class you can see)
	h.check(
		labels.altBg === 'rgb(185, 28, 28)' && labels.yesBg !== labels.altBg,
		`the destructive red is on Discard, not on Save (save=${labels.yesBg}, discard=${labels.altBg})`
	);

	// 16b — CANCEL returns you to where the flow found you
	await page.locator('#explorer-confirm-no').click();
	await page.waitForTimeout(600);
	const afterCancel = (await vols(A))[0];
	h.check(
		!!afterCancel && afterCancel.dirty,
		'Cancel leaves it mounted WITH its edits (dirty=' + (afterCancel && afterCancel.dirty) + ')'
	);
	h.check(
		(await activeFolderOf(A)) === spots.away,
		'…and puts the view back in the folder the flow took it from'
	);

	// 16c — THE EXCEPTION: navigate while the question stands and you are LEFT THERE.
	// This is the guard the round was written around; it is proven by breaking it below.
	await armUnmount(dirtyVol.id);
	await goTo(spots.elsewhere);
	await page.waitForTimeout(400);
	h.check(
		await page.locator('#explorer-confirm-yes').isVisible(),
		'premise: walking away does not dismiss the question — the strip is not modal'
	);
	await page.locator('#explorer-confirm-alt').click();
	await page.waitForTimeout(800);
	h.check((await vols(A)).length === 0, "Discard and unmount unmounts it");
	h.check(
		(await activeFolderOf(A)) === spots.elsewhere,
		'…and leaves the view where the USER put it, not where the flow found it — a navigation made during the question is a decision'
	);
	const discarded = await savedNames(A, dirtyVol.sessionId);
	h.check(
		!discarded.includes('edited-again.txt'),
		`…and the discarded edit never reached the saved project (${discarded.join(',')})`
	);

	// 16d — SAVE AND UNMOUNT is the outcome that did not exist before: it writes.
	await page.evaluate((id) => window.__stores.mountedVolumes.mountVolume(id), dirtyVol.sessionId);
	await h.eventually(() => vols(A), (l) => l.length === 1, 'premise: it is mounted again', 15000);
	dirtyVol = (await vols(A))[0];
	await page.evaluate((v) => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const rec = mv.find((x) => x.id === v);
		window.__stores.mountedVolumes.volumeRenameItem(v, rec.items[0].id, 'kept-by-save.txt');
	}, dirtyVol.id);
	await page.waitForTimeout(500);
	await goTo(spots.away);
	await page.waitForTimeout(400);
	await armUnmount(dirtyVol.id);
	await page.locator('#explorer-confirm-yes').click();
	await h.eventually(
		() => savedNames(A, dirtyVol.sessionId),
		(names) => names.includes('kept-by-save.txt'),
		'Save and unmount WRITES the buffered edit into the saved project',
		20000
	);
	await h.eventually(
		() => vols(A),
		(l) => l.length === 0,
		'…and then unmounts it',
		15000
	);
	h.check(
		(await activeFolderOf(A)) === spots.away,
		'…and returns the view to the folder the flow found it in'
	);

	// 16e — the place you came from can be INSIDE the volume, and after an unmount it is
	// not a place at all. Walking into one of its subfolders to look at what you are about
	// to lose is the ordinary thing to do, so this is not a corner case.
	await page.evaluate((id) => window.__stores.mountedVolumes.mountVolume(id), dirtyVol.sessionId);
	await h.eventually(() => vols(A), (l) => l.length === 1, 'premise: mounted once more', 15000);
	const inner = (await vols(A))[0];
	const innerFolder = await page.evaluate((v) => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const rec = mv.find((x) => x.id === v);
		window.__stores.mountedVolumes.volumeRenameItem(v, rec.items[0].id, 'doomed.txt');
		return rec.folders[0]?.id ?? null;
	}, inner.id);
	h.check(!!innerFolder, 'premise: the mount has a folder to stand in');
	await page.waitForTimeout(400);
	await armUnmount(inner.id);
	await goTo(`vol:${inner.id}:${innerFolder}`);
	await page.waitForTimeout(400);
	await page.locator('#explorer-confirm-alt').click();
	await page.waitForTimeout(900);
	h.check(
		(await activeFolderOf(A)) === null,
		'a view standing INSIDE the volume when it is unmounted lands on the Library, never on a folder that no longer exists (' +
			JSON.stringify(await activeFolderOf(A)) +
			')'
	);

	// 16f — A PINNED PSEUDO ROOT is somewhere you can be standing when you press ✕, and
	// the list of them GROWS. The first `placeStillThere` enumerated them the way `goUp`
	// does; `deletedlog` was pinned by another lane the same day and merged textually
	// clean, after which cancelling an unmount from that row dumped you at the Library.
	// Every root the tree pins is checked here, so the next one to arrive is covered by
	// construction rather than by somebody remembering.
	const roots = ['prefabs', 'packs', 'scene', 'scene:textures', 'deleted', 'deletedlog'];
	await page.evaluate((id) => window.__stores.mountedVolumes.mountVolume(id), dirtyVol.sessionId);
	await h.eventually(() => vols(A), (l) => l.length === 1, 'premise: mounted for the roots pass', 15000);
	const rootVol = (await vols(A))[0];
	await page.evaluate((v) => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const rec = mv.find((x) => x.id === v);
		window.__stores.mountedVolumes.volumeRenameItem(v, rec.items[0].id, 'roots.txt');
	}, rootVol.id);
	await page.waitForTimeout(400);
	const restored = [];
	for (const root of roots) {
		await goTo(root);
		await page.waitForTimeout(250);
		await armUnmount(rootVol.id);
		await page.locator('#explorer-confirm-no').click();
		await page.waitForTimeout(400);
		restored.push(root + (((await activeFolderOf(A)) === root) ? ':ok' : ':LOST'));
	}
	h.check(
		restored.every((r) => r.endsWith(':ok')),
		'Cancel returns you to EVERY pinned root, not only the ones an enumeration remembered (' +
			restored.join(', ') + ')'
	);
	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		for (const v of mv) await window.__stores.mountedVolumes.unmountVolume(v.id);
	});
	await page.waitForTimeout(400);
	await goTo(null);
	await page.waitForTimeout(300);


	await h.finish(browser);
});