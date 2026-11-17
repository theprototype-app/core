// 49 J4 (fx-car-blocks) — a modal closed and opened again straight away STAYS open.
//
// ModalDialog synced its `open` binding from the dialog's `toggle` event, which the platform
// fires in a later TASK. Close a modal (its <dialog> is removed and close()d) and open it again
// before that task runs, and the OLD dialog's "closed" toggle arrived after the reopen and wrote
// `open = false` — the manager shut itself. The modules flight fx-car-blocks closes the Modules
// manager after a menu press and opens it for the next install a moment later; it waited 30 s for
// a "User" tab that had already gone (red on every 1.35-1.39 build, local and deployed).
//
// Counterfactual: v1.39.0 — every "stays open" check is red.
// Run: e2e-slot --dev <lane> 5484 -- env APP_URL=https://localhost:5484/ npm run e2e -- modal-reopen
const h = require('./helpers.cjs');

/** close, let svelte remove the dialog (microtasks), open again — all before the next task */
const flip = (page, store) =>
	page.evaluate(async (name) => {
		const s = window.__tp.test.v1[name];
		s.set(true);
		await new Promise((r) => setTimeout(r, 600));
		const shown = !!document.querySelector('dialog[open]');
		s.set(false);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		const removed = !document.querySelector('dialog[open]');
		s.set(true);
		await new Promise((r) => setTimeout(r, 800));
		let now;
		s.subscribe((v) => (now = v))();
		return { shown, removed, store: now, dialog: !!document.querySelector('dialog[open]') };
	}, store);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	for (const store of ['modulesOpen', 'settingsOpen']) {
		const r = await flip(A.page, store);
		h.check(r.shown && r.removed, `premise: ${store} opened, then its dialog left the page (${JSON.stringify(r)})`);
		h.check(r.store === true && r.dialog, `${store}: opened again right after a close, it stays open (${JSON.stringify(r)})`);
		await A.page.evaluate((name) => window.__tp.test.v1[name].set(false), store);
		await A.page.waitForTimeout(400);
	}
	// the ordinary close still closes (the toggle sync must not keep a dialog open)
	await A.page.evaluate(() => window.__tp.test.v1.modulesOpen.set(true));
	await A.page.waitForTimeout(600);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(600);
	const after = await A.page.evaluate(() => {
		let v;
		window.__tp.test.v1.modulesOpen.subscribe((x) => (v = x))();
		return { store: v, dialog: !!document.querySelector('dialog[open]') };
	});
	h.check(after.store === false && !after.dialog, `Escape still closes the manager (${JSON.stringify(after)})`);
	await h.finish(browser);
});
