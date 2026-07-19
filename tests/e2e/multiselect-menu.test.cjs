// U-2: multi-select context menu — the menu is set-aware (Group selection,
// counted labels, multi delete), Group selection makes one replicated group,
// and a multi prefab captures all members.
const h = require('./helpers.cjs');

// create N boxes on a page, return their uuids
const makeBoxes = (page, n) =>
	page.evaluate((n) => {
		const before = new Set();
		window.__stores.objectsGroup.subscribe((g) => g?.children.forEach((c) => before.add(c.uuid)))();
		for (let i = 0; i < n; i++) window.__stores.commandsHandler.sceneCommand('/create box');
		const ids = [];
		window.__stores.objectsGroup.subscribe((g) =>
			g?.children.forEach((c) => {
				if (!before.has(c.uuid) && c.name === 'Box') ids.push(c.uuid);
			})
		)();
		return ids;
	}, n);

const topLevel = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const groups = [];
					g?.children.forEach((c) => {
						if (c.type === 'Group') groups.push({ uuid: c.uuid, children: c.children.length });
					});
					resolve({ total: g?.children.length ?? 0, groups });
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// --- Group selection: menu item + one replicated group with 3 children ----
	let ids = await makeBoxes(A.page, 3);
	h.check(ids.length === 3, `created 3 boxes (${ids.length})`);

	const menu = await A.page.evaluate((ids) => {
		window.__stores.objectActions.applySelectionSet(ids);
		const items = window.__stores.objectMenu.buildObjectMenuItems(ids[1]);
		return items.map((i) => i.label);
	}, ids);
	h.check(menu.some((l) => l.startsWith('Group selection')), 'menu offers Group selection when multi');
	h.check(menu.some((l) => l === 'Delete (3)'), `Delete label is counted (${menu.find((l) => l.startsWith('Delete'))})`);
	h.check(menu.some((l) => l === 'Duplicate (3)'), 'Duplicate label is counted');

	await A.page.evaluate(() => window.__stores.objectActions.groupSelection());
	await B.page.waitForTimeout(1200);

	let a = await topLevel(A.page);
	h.check(a.groups.length === 1 && a.groups[0].children === 3, `A: one group of 3 (${JSON.stringify(a.groups)})`);
	let b = await topLevel(B.page);
	h.check(b.groups.length === 1 && b.groups[0].children === 3, `B: group replicated with 3 children (${JSON.stringify(b.groups)})`);

	// undo restores the flat layout in ONE step (aibatch)
	await A.page.evaluate(() => window.__stores.history.undo());
	await B.page.waitForTimeout(800);
	a = await topLevel(A.page);
	h.check(a.groups.length === 0, `A: undo removed the group in one step (${a.groups.length} groups)`);

	// --- Multi delete: removes ALL selected, replicated ----------------------
	ids = await makeBoxes(A.page, 3);
	await A.page.evaluate((ids) => {
		window.__stores.objectActions.applySelectionSet(ids);
		window.__stores.objectActions.requestDeleteSelection();
	}, ids);
	await B.page.waitForTimeout(1000);
	const goneA = await A.page.evaluate(
		(ids) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(ids.every((u) => !g.getObjectByProperty('uuid', u))))()
			),
		ids
	);
	h.check(goneA === true, 'multi-delete removed every selected object on A');
	const goneB = await B.page.evaluate(
		(ids) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(ids.every((u) => !g.getObjectByProperty('uuid', u))))()
			),
		ids
	);
	h.check(goneB === true, 'multi-delete replicated to B');

	// --- Multi prefab: one entry whose element is a group of 3 ----------------
	ids = await makeBoxes(A.page, 3);
	const prefab = await A.page.evaluate(async (ids) => {
		window.__stores.objectActions.applySelectionSet(ids);
		const entry = await window.__stores.prefabs.savePrefabSelection(ids, 'Trio');
		return { name: entry?.name, childCount: entry?.element?.object?.children?.length ?? 0 };
	}, ids);
	h.check(prefab.name === 'Trio', `multi prefab saved (${prefab.name})`);
	h.check(prefab.childCount === 3, `prefab captured all 3 members (${prefab.childCount})`);

	await h.finish(browser);
});
