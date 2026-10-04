// 36 B1 — CTRL+D DUPLICATES WHAT IS SELECTED, AND NOTHING WHEN NOTHING IS. A fresh creation is
// selected (the selection SET, 15-K3), so Ctrl+D right after creating duplicates IT; with nothing
// selected Ctrl+D says so and creates nothing — including the stale case this lane fixed: select
// A, deselect, a peer then locks A, Ctrl+D used to duplicate A (the sticky primary read as a
// "locked view"). Viewing a peer-locked object on purpose still duplicates it.
// Run: APP_URL=https://theprototype.app:5321/ npm run e2e -- duplicate-after-create
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	const state = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const read = (st) => {
				let v;
				st.subscribe((x) => (v = x))();
				return v;
			};
			return { count: read(s.objectsGroup).children.length, set: [...read(s.selectedObjects)], primary: read(s.selectedObject)?.uuid ?? null };
		});
	const ctrlD = async () => {
		await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur?.());
		await page.keyboard.press('Control+d');
		await page.waitForTimeout(500);
	};
	const toastSaid = (re) => page.evaluate((re) => [...document.querySelectorAll('.tp-toast, [role=status], .toast')].some((t) => new RegExp(re).test(t.textContent || '')), re);

	// ---- 1. create, then Ctrl+D: the NEW object is duplicated
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(600);
	const made = await state();
	h.check(made.set.length === 1 && made.set[0] === made.primary, `creation selects the new object in the SET (${JSON.stringify(made.set)})`);
	await ctrlD();
	let s = await state();
	h.check(s.count === made.count + 1, `Ctrl+D right after creating duplicates it (${made.count} -> ${s.count})`);
	h.check(s.set.length === 1 && s.set[0] !== made.set[0], 'the copy is the new selection');
	const copy = s.set[0];

	// ---- 2. nothing selected: Ctrl+D creates nothing and says so
	await page.evaluate(() => window.__stores.objectActions?.deselectObject?.() ?? window.__stores.selectedObjects.set([]));
	await page.waitForTimeout(300);
	const before = (await state()).count;
	await ctrlD();
	s = await state();
	h.check(s.count === before, `with nothing selected Ctrl+D creates nothing (${before} -> ${s.count})`);
	h.check(await toastSaid('Nothing selected to duplicate'), 'and says "Nothing selected to duplicate"');

	// ---- 3. THE STALE CASE: the sticky primary becomes peer-locked after a deselect
	await page.evaluate((uuid) => {
		const s = window.__stores;
		s.lockedObjects.update((l) => [...l, ['zz-peer', uuid]]);
	}, s.primary);
	await ctrlD();
	const s3 = await state();
	h.check(s3.count === before, `a deselected object a peer then locks is NOT duplicated by Ctrl+D (${before} -> ${s3.count})`);

	// ---- 4. viewing a peer-locked object ON PURPOSE still duplicates it (the legit empty-set case)
	await page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), s.primary);
	await page.waitForTimeout(300);
	const v = await state();
	h.check(v.set.length === 0 && v.primary === s.primary, 'premise: a locked object is VIEWED (set empty, primary = it)');
	await ctrlD();
	h.check((await state()).count === before + 1, 'Ctrl+D duplicates the object being viewed');
	await page.evaluate((uuid) => window.__stores.lockedObjects.update((l) => l.filter((e) => e[1] !== uuid)), s.primary);

	// ---- 5. a group made from the selection is selected, and Ctrl+D duplicates the group
	await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(800);
	const g = await page.evaluate(() => {
		const s = window.__stores;
		let grp;
		s.objectsGroup.subscribe((x) => (grp = x))();
		const kids = grp.children.slice(-2).map((o) => o.uuid);
		s.objectActions.applySelectionSet(kids);
		s.objectActions.groupSelection();
		let set;
		s.selectedObjects.subscribe((x) => (set = x))();
		let primary;
		s.selectedObject.subscribe((x) => (primary = x))();
		return { set: [...set], isGroup: !!primary?.isGroup, count: grp.children.length };
	});
	await page.waitForTimeout(400);
	h.check(g.set.length === 1 && g.isGroup, `grouping selects the new group (${JSON.stringify(g)})`);
	await ctrlD();
	h.check((await state()).count === g.count + 1, 'Ctrl+D duplicates the group');

	// ---- 6. undo a creation: the set must not keep a ghost Ctrl+D could act on
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create cone'));
	await page.waitForTimeout(600);
	const c = await state();
	await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur?.());
	await page.keyboard.press('Control+z');
	await page.waitForTimeout(600);
	const u = await state();
	h.check(u.count === c.count - 1, `premise: undo removed the cone (${c.count} -> ${u.count})`);
	await ctrlD();
	h.check((await state()).count === u.count, `after undoing a creation Ctrl+D does not bring a ghost back (${u.count} -> ${(await state()).count})`);
	void copy;
	await h.finish(browser);
});
