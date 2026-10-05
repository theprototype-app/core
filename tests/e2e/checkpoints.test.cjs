// 36 B14 — named checkpoints / the version timeline. Save through the real dialog
// (Ctrl+Shift+S), rename / note / pin / compare / restore through the timeline's own
// controls, the size cap's eviction order, the automatic rows that follow autosave (and
// skip an untouched scene), persistence + index reconcile across a reload, and a restore
// with a peer connected going through the session proposal.
const fs = require('fs');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-36/36-editor-extras';

/** h.eventually + the value it settled on (the shared helper returns nothing)
 * @param {() => Promise<any>} fn @param {(v: any) => boolean} pred @param {string} label @param {number} [ms] */
async function until(fn, pred, label, ms = 10000) {
	let last;
	await h.eventually(async () => (last = await fn()), pred, label, ms);
	return last;
}
/** @param {any} page */
const rows = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.checkpoints.checkpoints.subscribe(r)()));
/** @param {any} page */
const objectNames = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))())
	);
/** @param {any} page @param {string} cmd */
const create = (page, cmd) =>
	page.evaluate(async (c) => {
		window.__stores.commandsHandler.sceneCommand(c);
		await new Promise((r) => setTimeout(r, 300));
	}, cmd);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	// automatic rows off while the manual flow is measured; section 5 turns them on
	await page.evaluate(() => window.__stores.checkpoints.autoCheckpoints.set(false));

	// ---- 1. Save through the dialog -----------------------------------------------------
	await create(page, '/create box');
	await create(page, '/create sphere 1');
	await page.locator('canvas').first().click({ position: { x: 40, y: 300 } }).catch(() => {});
	await page.keyboard.press('Control+Shift+S');
	await page.locator('#checkpoint-save-name').waitFor({ timeout: 5000 });
	h.check(true, 'Ctrl+Shift+S opens the Save checkpoint dialog');
	await page.locator('#checkpoint-save-name').fill('Blockout');
	await page.locator('#checkpoint-save-note').fill('box + sphere, before lighting');
	await page.locator('#checkpoint-save-confirm').click();
	let list = await until(() => rows(page), (l) => l.length === 1, 'the checkpoint is listed');
	h.check(list[0].name === 'Blockout' && list[0].note === 'box + sphere, before lighting', 'name and note are kept');
	h.check(list[0].count === 2 && !list[0].auto && !list[0].pinned, 'a named, unpinned row of 2 objects');
	h.check(!!list[0].thumbnail && list[0].bytes > 0, 'it carries a thumbnail and a size');
	await h.eventually(() => page.locator('#checkpoint-save-name').isVisible(), (v) => v === false, 'the dialog closes on save');

	// ---- 2. The timeline: rename, note, pin --------------------------------------------
	await page.evaluate(() => window.__stores.checkpointsOpen.set(true));
	await page.locator('#checkpoint-timeline').waitFor({ timeout: 5000 });
	const row0 = page.locator(`[data-checkpoint="${list[0].id}"]`);
	h.check((await page.locator('[data-checkpoint]').count()) === 1, 'the timeline draws one row');
	await row0.locator('.cp-name').dblclick();
	await row0.locator('.cp-name-input').fill('Blockout v1');
	await row0.locator('.cp-name-input').press('Enter');
	list = await until(() => rows(page), (l) => l[0]?.name === 'Blockout v1', 'double-click renames');
	await row0.locator('.cp-note').click();
	await row0.locator('.cp-note-input').fill('the first pass');
	await row0.locator('.cp-note-input').press('Control+Enter');
	list = await until(() => rows(page), (l) => l[0]?.note === 'the first pass', 'the note is editable in place');
	await row0.locator('button[aria-label="Pin"]').click();
	list = await until(() => rows(page), (l) => l[0]?.pinned === true, 'Pin pins');
	const stored = await page.evaluate(async (id) => (await window.__stores.checkpoints.checkpointPayload(id))?.checkpoint, list[0].id);
	h.check(stored?.name === 'Blockout v1' && stored?.pinned === true && stored?.note === 'the first pass', 'edits reach the stored payload too');

	// ---- 3. A second checkpoint, then compare ------------------------------------------
	await create(page, '/create cone');
	await page.evaluate(() => window.__stores.checkpoints.saveCheckpoint({ name: 'With cone' }));
	list = await until(() => rows(page), (l) => l.length === 2, 'a second checkpoint');
	h.check(list[0].name === 'With cone' && list[0].count === 3, 'newest first, 3 objects');
	h.check((await page.locator('.cp-day').first().textContent()).trim() === 'Today', 'rows are grouped by day');
	await page.locator('#checkpoint-compare').click();
	await page.locator('.cp-pick').nth(0).check();
	await page.locator('.cp-pick').nth(1).check();
	const compare = page.locator('#checkpoint-compare-view');
	await compare.locator('.cp-frame').waitFor({ timeout: 3000 });
	h.check((await compare.locator('img.cp-img').count()) === 2, 'compare shows both pictures');
	const cmpText = await compare.textContent();
	h.check(/Objects\s*2\s*→\s*3\s*\(\+1\)/.test(cmpText), 'compare says what changed (' + cmpText.replace(/\s+/g, ' ').slice(0, 80) + ')');
	h.check(/Blockout v1/.test(cmpText) && /With cone/.test(cmpText), 'compare labels older left, newer right');
	await page.locator('#checkpoint-compare-split').fill('25');
	const clip = await compare.locator('.cp-img-top').evaluate((el) => getComputedStyle(el).clipPath);
	h.check(/25%/.test(clip), 'the swipe divider moves the top picture (' + clip + ')');
	fs.mkdirSync(EVIDENCE, { recursive: true });
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await page.waitForTimeout(300);
	await page.screenshot({ path: EVIDENCE + '/01-timeline-compare-dark.png' });
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(300);
	await page.screenshot({ path: EVIDENCE + '/02-timeline-compare-light.png' });
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	// one picked row compares with "now"
	await page.locator('.cp-pick').nth(0).uncheck();
	h.check(/against the scene now/.test(await compare.textContent()), 'one ticked row compares with the scene now');
	await page.locator('#checkpoint-compare').click();

	// ---- 4. Restore through the UI ----------------------------------------------------
	// an unsaved change first, so the scene being left is not already a row
	await create(page, '/create torus');
	const blockout = list.find((r) => r.name === 'Blockout v1');
	await page.locator(`[data-checkpoint="${blockout.id}"] .cp-restore`).click();
	await page.getByRole('button', { name: 'Restore', exact: true }).last().click();
	await h.eventually(
		() => objectNames(page),
		(n) => n.length === 2 && n.includes('Box') && n.includes('Sphere'),
		'Restore puts the checkpoint back (2 objects)'
	);
	list = await until(() => rows(page), (l) => l.length === 3, 'the scene before it is kept');
	const before = list.find((r) => /^Before restoring/.test(r.name));
	h.check(!!before && before.auto && before.count === 4, 'as an automatic "Before restoring" row of 4 objects');
	await h.eventually(() => page.locator('#checkpoint-timeline').isVisible(), (v) => v === false, 'the timeline closes on restore');
	const sessionsBackups = await page.evaluate(
		() => new Promise((r) => window.__stores.sessions.sessions.subscribe((l) => r(l.filter((s) => /Backup before/.test(s.name)).length))())
	);
	h.check(sessionsBackups === 0, 'no "Backup before" lands in Sessions (the timeline holds it)');

	// ---- 5. The cap: oldest unpinned first, automatic before named, pinned kept ----------
	list = await rows(page);
	const total = list.reduce((n, r) => n + r.bytes, 0);
	const one = Math.max(...list.map((r) => r.bytes));
	await page.evaluate((cap) => window.__stores.checkpoints.checkpointsDebug.capBytes(cap), total + Math.floor(one * 0.5));
	await page.evaluate(() => window.__stores.checkpoints.saveCheckpoint({ name: 'Over the cap' }));
	list = await until(() => rows(page), (l) => l.some((r) => r.name === 'Over the cap'), 'a save over the cap still lands');
	h.check(!list.some((r) => /^Before restoring/.test(r.name)), 'the AUTOMATIC row went first (it was the youngest older row)');
	h.check(list.some((r) => r.name === 'With cone') && list.some((r) => r.name === 'Blockout v1'), 'named rows survive while an automatic one can go');
	// cap at exactly what is stored now, so the next save must evict (smaller scenes than the auto row it replaced)
	const nowTotal = (await rows(page)).reduce((n, r) => n + r.bytes, 0);
	await page.evaluate((cap) => window.__stores.checkpoints.checkpointsDebug.capBytes(cap), nowTotal);
	await page.evaluate(() => window.__stores.checkpoints.saveCheckpoint({ name: 'Over again' }));
	list = await until(() => rows(page), (l) => l.some((r) => r.name === 'Over again'), 'another save over the cap');
	h.check(!list.some((r) => r.name === 'With cone'), 'then the oldest UNPINNED named row');
	h.check(list.some((r) => r.name === 'Blockout v1' && r.pinned), 'the pinned row, though oldest, is kept');
	const keys = await page.evaluate(async () => (await window.__stores.idb?.idbKeys?.()) ?? null);
	if (keys) h.check(keys.filter((k) => String(k).startsWith('checkpoint:')).length === list.length, 'evicted payloads are deleted from idb');
	// pinned rows alone over the cap: a save is refused, nothing evicted
	await page.evaluate(() => window.__stores.checkpoints.checkpointsDebug.capBytes(1));
	const refused = await page.evaluate(() => window.__stores.checkpoints.saveCheckpoint({ name: 'No room' }));
	h.check(refused === null && (await rows(page)).some((r) => r.name === 'Blockout v1'), 'a save that cannot fit is refused and the pinned row stays');
	await page.evaluate(() => window.__stores.checkpoints.checkpointsDebug.capBytes(null));

	// ---- 6. Automatic rows follow autosave --------------------------------------------
	const n0 = (await rows(page)).length;
	await page.evaluate(() => window.__stores.checkpoints.autoCheckpoints.set(true));
	await create(page, '/create torus');
	await page.evaluate(async () => {
		window.__stores.checkpoints.checkpointsDebug.resetAutoClock(0);
		await window.__stores.autosave.saveNow();
	});
	list = await until(() => rows(page), (l) => l.length === n0 + 1 && l[0].auto, 'an autosave write cuts an automatic row', 12000);
	h.check(list[0].count === 3, 'of the scene as it is (3 objects)');
	// nothing changed: no new row even though the interval has passed
	await page.evaluate(async () => {
		window.__stores.checkpoints.checkpointsDebug.resetAutoClock(0);
		await window.__stores.autosave.saveNow();
		await window.__stores.checkpoints.checkpointsDebug.maybeAuto();
	});
	await page.waitForTimeout(1500);
	h.check((await rows(page)).length === n0 + 1, 'an untouched scene cuts no second automatic row');
	// inside the interval: no row even with a change
	await create(page, '/create box');
	await page.evaluate(() => window.__stores.autosave.saveNow());
	await page.waitForTimeout(1500);
	h.check((await rows(page)).length === n0 + 1, 'a change inside the interval waits for the next one');
	// off: nothing
	await page.evaluate(async () => {
		window.__stores.checkpoints.autoCheckpoints.set(false);
		window.__stores.checkpoints.checkpointsDebug.resetAutoClock(0);
		await window.__stores.checkpoints.checkpointsDebug.maybeAuto();
	});
	h.check((await rows(page)).length === n0 + 1, 'with the setting off, no automatic row');

	// ---- 7. Persistence + reconcile ---------------------------------------------------
	const beforeReload = (await rows(page)).map((r) => r.id).sort();
	await h.freshReload(A);
	let after = await until(
		async () => (await rows(page)).map((r) => r.id).sort(),
		(a) => JSON.stringify(a) === JSON.stringify(beforeReload),
		'the timeline survives a reload (' + beforeReload.length + ' rows)',
		15000
	);
	h.check((await page.evaluate(() => window.__stores.checkpoints.autoCheckpoints ? new Promise((r) => window.__stores.checkpoints.autoCheckpoints.subscribe(r)()) : null)) === false, 'the automatic setting persists');
	// lose the index (a crash between the two writes): the payloads re-index themselves
	await page.evaluate(async () => {
		const req = indexedDB.open('theprototype', 1);
		const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
		await new Promise((r) => {
			const tx = db.transaction('snapshots', 'readwrite');
			tx.objectStore('snapshots').delete('checkpoints:index');
			tx.oncomplete = r;
		});
		db.close();
	});
	await h.freshReload(A);
	const ids = async () => (await rows(page)).map((r) => r.id).sort();
	after = await until(ids, (a) => JSON.stringify(a) === JSON.stringify(beforeReload), 'a lost index is rebuilt from the stored checkpoints', 15000);
	h.check((await rows(page)).some((r) => r.name === 'Blockout v1' && r.pinned), 'with names and pins intact');

	// the Storage breakdown counts them as Checkpoints, and reclaiming one there deletes it properly
	const scan = await page.evaluate(async () => {
		const s = await window.__stores.storageUsage.scanStorage();
		const cat = s.categories.find((c) => c.key === 'checkpoints');
		const other = s.categories.find((c) => c.key === 'other');
		return { n: cat?.rows.length ?? -1, kinds: [...new Set(cat?.rows.map((r) => r.kind))], stray: other?.rows.filter((r) => /checkpoint/.test(r.id)).length ?? 0 };
	});
	h.check(scan.n === beforeReload.length && scan.kinds.join() === 'checkpoint' && scan.stray === 0, 'Storage lists them under Checkpoints, none under Other (' + JSON.stringify(scan) + ')');
	const reclaimed = await page.evaluate(async () => {
		const s = await window.__stores.storageUsage.scanStorage();
		const row = s.categories.find((c) => c.key === 'checkpoints').rows.find((r) => !/Blockout/.test(r.label));
		await window.__stores.storageUsage.reclaimRow(row);
		return row.ref;
	});
	h.check(!(await rows(page)).some((r) => r.id === reclaimed), 'reclaiming one in Storage removes it from the timeline too');

	// empty scene: refused
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await page.waitForTimeout(400);
	const empty = await page.evaluate(() => window.__stores.checkpoints.saveCheckpoint({ name: 'nothing' }));
	h.check(empty === null, 'an empty scene is not checkpointed');

	// ---- 8. Restore with a peer connected = a proposal ---------------------------------
	// the reloads above left autosave's Restore/Dismiss offer up on A; it sits where the Approve card lands
	await page.evaluate(() => window.__stores.autosave.dismissRestore());
	await page.waitForTimeout(300);
	// a reload is a new Peer, so A's id from setupPage is stale — B must dial the current one
	A.id = await page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await page.waitForTimeout(800);
	const target = (await rows(page)).find((r) => r.name === 'Blockout v1');
	const result = await page.evaluate((id) => window.__stores.checkpoints.restoreCheckpoint(id), target.id);
	h.check(result === 'proposed', 'with a peer connected the restore is a proposal (' + result + ')');
	await B.page.getByText(/wants to load session/).waitFor({ timeout: 8000 });
	h.check(true, 'the peer is asked');
	await B.page.getByRole('button', { name: 'Accept', exact: true }).click();
	await h.eventually(
		() => objectNames(B.page),
		(n) => n.length === 2 && n.includes('Box') && n.includes('Sphere'),
		'after Accept the peer has the checkpoint',
		15000
	);
	await h.eventually(() => objectNames(page), (n) => n.length === 2, 'and so does the host');
	const bRows = await rows(B.page);
	h.check(bRows.length === 0, 'checkpoints stay LOCAL: the peer has none of the host’s rows');

	await h.finish(browser);
});
