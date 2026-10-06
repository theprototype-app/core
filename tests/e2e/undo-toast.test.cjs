// 37 R25: Undo after a destructive action — Clear scene. The clear happens at once, a toast
// offers Undo for ~8 s, and Undo puts the scene back EXACTLY (same uuids, notes, sky) on
// EVERY peer, because the restore goes through the replicated load path.
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');

h.run(async () => {

	/** evidence screenshots in dark + light (only when EVIDENCE_DIR is set — the lane's runner sets it) */
	async function shots(/** @type {any} */ page, /** @type {string} */ name, /** @type {string} */ sel) {
		const dir = process.env.EVIDENCE_DIR;
		if (!dir) return;
		const before = await page.evaluate(() => {
			let v;
			window.__stores.themes.theme.subscribe((x) => (v = x))();
			return v;
		});
		for (const t of ['dark', 'light']) {
			await page.evaluate((x) => window.__stores.themes.theme.set(x), t);
			await page.waitForTimeout(300);
			await page.locator(sel).first().screenshot({ path: require('path').join(dir, `${name}-${t}.png`) }).catch((e) => console.log('screenshot failed: ' + e.message));
		}
		await page.evaluate((x) => window.__stores.themes.theme.set(x), before);
	}
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const pa = A.page;

	const uuids = (/** @type {any} */ page) =>
		page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			return (g?.children ?? []).map((c) => c.uuid).sort();
		});
	const notes = (/** @type {any} */ page) =>
		page.evaluate(() => {
			let v;
			window.__stores.annotationsHandler.annotations.subscribe((x) => (v = x))();
			return v.map((a) => a.text).sort();
		});
	const preset = (/** @type {any} */ page) =>
		page.evaluate(() => {
			let v;
			window.__stores.environment.environment.subscribe((x) => (v = x))();
			return v?.preset;
		});
	const undoCard = () => pa.locator('.tp-toast--undo');
	async function openClear() {
		await pa.evaluate(() => window.__stores.closeMenu.set(false));
		await pa.waitForTimeout(300);
		await pa.locator('#clear-scene').click();
		await h.eventually(() => pa.locator('#confirm-clear-scene').isVisible(), (v) => v, 'the Clear scene dialog opens', 20000);
	}

	// ---- 0. a scene worth keeping: three objects, a note, a sky -----------------------
	for (const cmd of ['/create box', '/create sphere 1', '/create cone 1'])
		await pa.evaluate((c) => window.__stores.commandsHandler.sceneCommand(c), cmd);
	await h.eventually(() => uuids(B.page), (u) => u.length === 3, 'premise: B holds the three objects', 20000);
	const original = await uuids(pa);
	await pa.evaluate((uuid) => {
		const ah = window.__stores.annotationsHandler;
		ah.addAnnotation(uuid, null);
		let cur;
		ah.activeAnnotation.subscribe((a) => (cur = a))();
		ah.setAnnotation({ ...cur.draft, text: 'keep me' });
		ah.activeAnnotation.set(null);
		window.__stores.environment.setEnvironment('sunset');
	}, original[0]);
	await h.eventually(() => notes(B.page), (n) => n.includes('keep me'), 'premise: B holds the note');
	await h.eventually(() => preset(B.page), (p) => p === 'sunset', 'premise: B has the sunset sky');

	// evidence: a long-lived offer (a screenshot on a loaded box can outlast the real 8 s)
	if (process.env.EVIDENCE_DIR) {
		await pa.evaluate(() => window.__stores.undoToast.offerUndo({ id: 'shot', text: '3 objects cleared. Still here: sky & look.', undo: () => {}, ms: 120000, actions: [{ label: 'Clear those too', action: () => {} }] }));
		await shots(pa, '40-undo-toast', '.tp-toast--undo');
		await pa.evaluate(() => window.__stores.undoToast.withdrawUndo('shot'));
	}

	// ---- 1. Clear objects, then Undo ------------------------------------------------
	await openClear();
	await pa.locator('#confirm-dialog-clear').click(); // "Clear objects" (the box starts off)
	await h.eventually(() => uuids(B.page), (u) => u.length === 0, '1.1 the clear reached B', 20000);
	h.check((await uuids(pa)).length === 0, '1.2 and A is empty');
	await h.eventually(() => undoCard().isVisible(), (v) => v, '1.3 a toast offers Undo');
	const text = await undoCard().textContent();
	h.check(/3 objects cleared/.test(text) && /Still here:.*sky/.test(text), `1.4 it says what went and what stayed (${text?.replace(/\s+/g, ' ').trim()})`);
	h.check((await pa.locator('.tp-toast--undo .tp-toast-ttl').count()) >= 1, '1.5 the card shows the time left (draining bar)');
	await pa.locator('.tp-toast--undo .tp-toast-action', { hasText: 'Undo' }).click({ force: true }) // the stack reflows as other toasts come and go; the press is what is under test;
	await h.eventually(() => uuids(pa), (u) => u.join() === original.join(), '1.6 Undo: A has the SAME objects back (uuids)', 30000);
	await h.eventually(() => uuids(B.page), (u) => u.join() === original.join(), '1.7 and so does B', 30000);
	await h.eventually(() => notes(B.page), (n) => n.includes('keep me'), '1.8 the note is back on B');
	h.check((await notes(pa)).includes('keep me'), '1.9 and on A');
	h.check((await undoCard().count()) === 0, '1.10 the offer is gone once used');
	const dbg = await pa.evaluate(() => window.__stores.undoToast.undoToastDebug());
	h.check(dbg.undone === 1 && dbg.live.length === 0, `1.11 one undo, nothing left on offer (${JSON.stringify(dbg)})`);

	// ---- 2. Clear everything (sky reset for everyone), then Undo -------------------------
	await openClear();
	await pa.locator('#confirm-dialog-check').check();
	await pa.locator('#confirm-dialog-clear').click(); // "Clear everything"
	await h.eventually(() => preset(B.page), (p) => p !== 'sunset', '2.1 Clear everything reset the sky on B', 20000);
	await h.eventually(() => uuids(B.page), (u) => u.length === 0, '2.2 and emptied B');
	await h.eventually(() => undoCard().isVisible(), (v) => v, '2.3 Undo offered');
	await pa.locator('.tp-toast--undo .tp-toast-action', { hasText: 'Undo' }).click({ force: true }) // the stack reflows as other toasts come and go; the press is what is under test;
	await h.eventually(() => preset(B.page), (p) => p === 'sunset', '2.4 Undo: the sky is back on B', 30000);
	await h.eventually(() => uuids(B.page), (u) => u.join() === original.join(), '2.5 the objects too', 30000);
	h.check((await preset(pa)) === 'sunset', '2.6 and on A');

	// ---- 3. delete the selection, then Undo (the same uuids back on both peers) ----------
	const doomed = original.slice(0, 2);
	await pa.evaluate((ids) => {
		window.__stores.objectActions.applySelectionSet(ids);
	}, doomed);
	const removed = await pa.evaluate(() => window.__stores.objectActions.deleteSelection());
	h.check(removed === 2, `3.1 premise: the selection delete removed two (${removed})`);
	await h.eventually(() => uuids(B.page), (u) => u.length === 1, '3.2 the delete reached B', 20000);
	await h.eventually(() => undoCard().textContent(), (t) => /Deleted 2 objects/.test(t ?? ''), '3.3 a toast offers Undo for the delete');
	const top = await pa.evaluate(() => {
		let st;
		window.__stores.history.undoStack.subscribe((x) => (st = x))();
		return st[st.length - 1]?.label;
	});
	h.check(top === 'Delete', `3.4 the delete is ONE history entry (${top})`);
	// something else happens before the Undo: the toast must still undo the DELETE, not that
	await pa.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await h.eventually(() => uuids(pa), (u) => u.length === 2, '3.5 premise: another object was added after the delete');
	await pa.locator('.tp-toast--undo .tp-toast-action', { hasText: 'Undo' }).click({ force: true }) // the stack reflows as other toasts come and go; the press is what is under test;
	await h.eventually(() => uuids(pa), (u) => doomed.every((id) => u.includes(id)) && u.length === 4, '3.6 Undo brings the two deleted objects back (the newer box stays)', 20000);
	await h.eventually(() => uuids(B.page), (u) => doomed.every((id) => u.includes(id)), '3.7 on B too', 20000);

	// ---- 4. remove a module, then Undo (record back, running again) ----------------------
	const mod = zipSync({
		'manifest.json': strToU8(JSON.stringify({ id: 'r25-probe', name: 'R25 Probe', version: '1.0.0', entry: 'module.js' })),
		'module.js': strToU8('export default { id: "r25-probe", name: "R25 Probe", version: "1.0.0", register(api) {} };\n')
	});
	await pa.evaluate(async (bytes) => window.__stores.userModules.installZip(new File([new Uint8Array(bytes)], 'r25-probe.zip')), Array.from(mod));
	const modState = () =>
		pa.evaluate(() => {
			let list = [];
			window.__stores.userModules.userModules.subscribe((x) => (list = x))();
			return { stored: list.some((m) => m.id === 'r25-probe'), loaded: window.__stores.moduleSDK.isModuleLoaded('r25-probe') };
		});
	await h.eventually(modState, (m) => m.stored && m.loaded, '4.1 premise: the module is installed and running');
	await pa.evaluate(() => window.__stores.userModules.removeUserModule('r25-probe'));
	h.check(JSON.stringify(await modState()) === JSON.stringify({ stored: false, loaded: false }), '4.2 Remove takes it out at once');
	await h.eventually(() => undoCard().textContent(), (t) => /R25 Probe" removed/.test(t ?? ''), '4.3 a toast offers Undo');
	await pa.locator('.tp-toast--undo .tp-toast-action', { hasText: 'Undo' }).click({ force: true }) // the stack reflows as other toasts come and go; the press is what is under test;
	await h.eventually(modState, (m) => m.stored && m.loaded, '4.4 Undo: installed and running again');
	const persisted = await pa.evaluate(async () => {
		const { idbGet } = await import('/src/lib/idb.js');
		return ((await idbGet('user-modules-v1')) ?? []).some((m) => m.id === 'r25-probe');
	});
	h.check(persisted, '4.5 and stored, so it survives a reload');
	await pa.evaluate(() => window.__stores.userModules.removeUserModule('r25-probe'));
	await pa.evaluate(() => window.__stores.undoToast.withdrawUndo('remove-module'));

	// ---- 5. Reset settings, then Undo (every stored key back) ----------------------------
	await pa.evaluate(() => localStorage.setItem('r25:probe', 'kept'));
	const keysBefore = await pa.evaluate(() => Object.keys(localStorage).length);
	await pa.evaluate(() => window.__stores.settingsOpen.set(true));
	await pa.locator('#settings-reset').click();
	h.check((await pa.evaluate(() => localStorage.getItem('r25:probe'))) === null, '5.1 Reset settings clears the stored settings');
	await h.eventually(() => undoCard().textContent(), (t) => /Settings reset/.test(t ?? ''), '5.2 a toast offers Undo');
	await pa.locator('.tp-toast--undo .tp-toast-action', { hasText: 'Undo' }).click({ force: true }) // the stack reflows as other toasts come and go; the press is what is under test;
	await pa.waitForTimeout(200);
	h.check((await pa.evaluate(() => localStorage.getItem('r25:probe'))) === 'kept', '5.3 Undo writes them back');
	const keysAfter = await pa.evaluate(() => Object.keys(localStorage).length);
	h.check(keysAfter >= keysBefore, `5.4 every key (${keysBefore} -> ${keysAfter})`);
	await pa.evaluate(() => window.__stores.settingsOpen.set(false));
	await pa.waitForTimeout(300);

	// ---- 6. the offer EXPIRES: after ~8 s there is nothing to undo ---------------------
	await openClear();
	await pa.locator('#confirm-dialog-clear').click();
	await h.eventually(() => undoCard().isVisible(), (v) => v, '6.1 Undo offered');
	// the drawer hides viewport toasts while open: the offer must still run out (its timer
	// is the module's, not the rendered card's)
	await pa.evaluate(() => window.__stores.toastsInDrawerOnly?.set?.(true));
	await pa.waitForTimeout(8600);
	await pa.evaluate(() => window.__stores.toastsInDrawerOnly?.set?.(false));
	const after = await pa.evaluate(() => window.__stores.undoToast.undoToastDebug());
	h.check(after.live.length === 0 && after.toasts === 0 && after.expired >= 1, `6.2 after 8 s the offer is gone (${JSON.stringify(after)})`);
	h.check((await undoCard().count()) === 0, '6.3 no Undo card on screen');
	h.check((await uuids(pa)).length === 0 && (await uuids(B.page)).length === 0, '6.4 and the clear stands');
	const hist = await pa.evaluate(() => {
		let v;
		window.__stores.notifications.subscribe((x) => (v = x))();
		return v.filter((n) => /objects cleared/.test(n.text)).map((n) => n.kind);
	});
	h.check(hist.length >= 1 && !hist.includes('action'), `6.5 the notification history keeps the text, not a stale Undo (${hist.join(',')})`);

	await h.finish(browser);
});
