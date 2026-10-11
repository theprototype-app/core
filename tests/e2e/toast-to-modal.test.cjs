// 41-modals G16 — a blocking or destructive QUESTION is a kit modal, never a toast. Toasts stay for passive
// outcomes ("Saved", "Copied"). Each section triggers a question that used to be an action toast and checks
// (1) a dialog asks it, (2) no toast carries it, (3) the dialog's answers do what the toast's buttons did.
// Counterfactual (feat/40-int): every section finds the question in the toast store and no dialog.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	const toastTexts = () =>
		page.evaluate(() => {
			let t = [];
			window.__stores.toastStore.subscribe((x) => (t = x))();
			return t.map((x) => String(x?.text ?? x?.message ?? x?.[0] ?? JSON.stringify(x)));
		});
	const dialogText = (/** @type {string} */ sel = 'dialog[open]') =>
		page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ') ?? '', sel);
	const clearToasts = () => page.evaluate(() => window.__stores.toastStore.set([]));
	const count = () =>
		page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			return g.children.length;
		});

	// ---- 1. "Delete flow" ------------------------------------------------------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(800);
	const uuid = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const id = g.children[g.children.length - 1].uuid;
		const F = window.__stores.flowGraphsCtl;
		F.createObjectGraph(id);
		return id;
	});
	await page.evaluate(() => window.__stores.flowNodes?.update?.((n) => n));
	await clearToasts();
	await page.evaluate((id) => { void window.__stores.flowGraphsCtl.requestDeleteObjectGraph(id, 'Box'); }, uuid); // never return the promise: it waits for the answer
	await page.waitForTimeout(500);
	const flowAsk = await dialogText();
	h.check(/Delete this flow\?/.test(flowAsk) && /for everyone/.test(flowAsk), `Delete flow asks in a modal ("${flowAsk.slice(0, 120)}")`);
	h.check(!(await toastTexts()).some((t) => /Delete the flow/i.test(t)), 'no "Delete the flow?" toast');
	await page.locator('#confirm-dialog-cancel').click({ timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(300);
	const hasGraph = (/** @type {string} */ id) =>
		page.evaluate((i) => {
			let g = {};
			window.__stores.flowGraphs.subscribe((x) => (g = x))();
			return i in g;
		}, id);
	h.check(await hasGraph(uuid), 'the premise: the object has a flow');
	h.check(await hasGraph(uuid), 'Cancel keeps the flow');
	await page.evaluate((id) => { void window.__stores.flowGraphsCtl.requestDeleteObjectGraph(id, 'Box'); }, uuid); // never return the promise: it waits for the answer
	await page.waitForTimeout(400);
	await page.locator('#confirm-dialog-ok').click({ timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(400);
	h.check(!(await hasGraph(uuid)), '"Delete flow" in the modal deletes the flow');

	// ---- 2. "Restore previous session?" -----------------------------------------------------
	await clearToasts();
	await page.evaluate(() => window.__stores.autosave.restoreAvailable.set({ objects: 7, ts: Date.now() }));
	await page.waitForTimeout(500);
	const restoreAsk = await dialogText('#restore-session-modal');
	h.check(/Restore previous session\?/.test(restoreAsk) && /7 objects/.test(restoreAsk), `the restore question is a modal ("${restoreAsk.slice(0, 80)}")`);
	h.check(!(await toastTexts()).some((t) => /Restore previous session/.test(t)), 'no restore-session toast');
	// the modal covers the chrome (the logo included) — it is a real modal, not a card
	const logoCovered = await page.evaluate(() => {
		const r = document.querySelector('#logo-menu')?.getBoundingClientRect();
		if (!r) return 'no logo';
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return document.querySelector('#restore-session-modal')?.contains(hit) ? 'covered' : hit?.id || hit?.tagName;
	});
	h.check(logoCovered === 'covered', `the restore modal covers the logo (${logoCovered})`);
	await page.locator('#restore-session-dismiss').click({ timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(400);
	const offer = await page.evaluate(() => {
		let v;
		window.__stores.autosave.restoreAvailable.subscribe((x) => (v = x))();
		return v;
	});
	h.check(offer === null && (await page.locator('#restore-session-modal').count()) === 0, 'Dismiss withdraws the offer and closes the modal');
	// Esc is the dismissive answer too
	await page.evaluate(() => window.__stores.autosave.restoreAvailable.set({ objects: 3, ts: Date.now() }));
	await page.waitForTimeout(400);
	await page.locator('#restore-session-modal').press('Escape', { timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(400);
	const offer2 = await page.evaluate(() => {
		let v;
		window.__stores.autosave.restoreAvailable.subscribe((x) => (v = x))();
		return v;
	});
	h.check(offer2 === null, 'Esc on the restore modal dismisses the offer');

	// ---- 3. a group delete -------------------------------------------------------------------
	await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const kids = g.children.slice(-2).map((c) => c.uuid);
		s.selectedObjects.set(kids);
		s.objectActions.groupSelection();
	});
	await page.waitForTimeout(800);
	const beforeDelete = await count();
	await clearToasts();
	await page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const group = g.children.find((c) => c.type === 'Group' && c.children.length > 1);
		s.objectActions.selectObject(group.uuid);
		s.objectActions.requestDeleteSelection();
	});
	await page.waitForTimeout(500);
	const groupAsk = await dialogText();
	h.check(/Delete this group\?/.test(groupAsk), `deleting a group asks in a modal ("${groupAsk.slice(0, 100)}")`);
	h.check(!(await toastTexts()).some((t) => /and its \d+ object/.test(t)), 'no group-delete toast');
	await page.locator('#confirm-dialog-cancel').click({ timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(300);
	h.check((await count()) === beforeDelete, 'Cancel deletes nothing');

	// ---- 4. GLTF export with nothing selected -------------------------------------------------
	await clearToasts();
	await page.evaluate(() => {
		const s = window.__stores;
		s.selectedObject.set([]);
		s.selectedObjects.set([]);
		s.fileHandler.save('gltf');
	});
	await page.waitForTimeout(500);
	const exportAsk = await dialogText();
	h.check(/Nothing selected/.test(exportAsk) && /Export all/.test(exportAsk), 'export-all asks in a modal');
	h.check(!(await toastTexts()).some((t) => /export the entire scene/i.test(t)), 'no export-all toast');
	await page.locator('#confirm-dialog-cancel').click({ timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(300);

	// ---- 5. passive outcomes stay toasts ------------------------------------------------------
	await clearToasts();
	await page.evaluate(() => window.__stores.showToast('Saved'));
	await page.waitForTimeout(200);
	h.check((await toastTexts()).some((t) => /Saved/.test(t)) && (await page.locator('dialog[open]').count()) === 0, 'a passive "Saved" is still a toast, no dialog');

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
