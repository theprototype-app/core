// 38 R1 — THE OBJECT LIST GROUP LOCK (NOTES-38 #3: "Groups must still expand/collapse … add
// it to the behaviour lock"). The redesign restyles the tree rows; what a group does may not
// change:
//   · the caret EXPANDS / COLLAPSES a group by click (aria-expanded on the treeitem, the
//     children's rows appear / go), and a click on the caret does not select the row;
//   · the keyboard: → expands, → again steps into the first child, ← on a child goes to its
//     group, ← on an open group collapses it (object-list-keys covers the rest of the walk);
//   · STATE IS KEPT: a group stays open across selecting other objects, closing and reopening
//     the list, and a collapsed one stays collapsed; what a page RELOAD does is asserted as it
//     is today (expansion is session state, not saved).
const h = require('./helpers.cjs');
const L = require('./lockHelpers.cjs');

h.run(async () => {
	const browser = await L.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	// [Group{Box, Sphere}, Cone] — the object-list-keys fixture
	const ids = await page.evaluate(() => {
		const s = window.__stores;
		const box = s.addObjects.spawnAtPoint('/create Box 1 1 1', [2, 0.5, 0]);
		const sphere = s.addObjects.spawnAtPoint('/create Sphere 0.5', [-2, 0.5, 0]);
		s.objectActions.selectObject(box.uuid);
		s.objectActions.selectObject(sphere.uuid, false, true);
		s.objectActions.groupSelection();
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const group = g.getObjectByProperty('uuid', box.uuid).parent;
		const cone = s.addObjects.spawnAtPoint('/create Cone 0.5 1', [0, 0.5, 3]);
		s.objectActions.deselectObject();
		s.objectListClose.set(false);
		return { box: box.uuid, sphere: sphere.uuid, group: group.uuid, cone: cone.uuid };
	});
	await page.waitForTimeout(600);
	// grouping opens the new group once; start from a COLLAPSED tree
	await page.evaluate(() => {
		window.__stores.toggleExpand.set(null);
		window.__stores.expandedObjects.set(new Set());
	});
	await page.waitForTimeout(250);

	const groupRow = page.locator(`[role=treeitem][id="${ids.group}"]`);
	const childVisible = (/** @type {string} */ uuid) =>
		page.evaluate((u) => {
			const el = document.getElementById(u);
			return !!el && el.getClientRects().length > 0;
		}, uuid);
	const expanded = async () => (await groupRow.getAttribute('aria-expanded')) === 'true';
	const selection = () => L.storeValue(page, 'selectedObjects');

	h.check((await groupRow.count()) === 1, 'the group has a tree row');
	h.check(!(await expanded()) && !(await childVisible(ids.box)), 'premise — the group starts collapsed, its children hidden');

	// ---- click the caret --------------------------------------------------------------------
	const caret = groupRow.locator('button[title="Expand group"], button[title="Collapse group"]').first();
	h.check((await caret.count()) === 1, 'a group row has an expand/collapse control (rows without children do not)');
	h.check((await page.locator(`[id="${ids.cone}"] button[title="Expand group"]`).count()) === 0, 'a leaf row has no caret');
	await caret.click();
	await page.waitForTimeout(250);
	h.check(await expanded(), 'clicking the caret expands the group (aria-expanded=true)');
	h.check((await childVisible(ids.box)) && (await childVisible(ids.sphere)), 'and shows its children');
	h.check(JSON.stringify(await selection()) === '[]', 'a caret click does not select the row');
	await caret.click();
	await page.waitForTimeout(250);
	h.check(!(await expanded()) && !(await childVisible(ids.box)), 'clicking it again collapses the group and hides the children');

	// ---- the keyboard ------------------------------------------------------------------------
	const tree = page.locator('#object-tree');
	await tree.focus();
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.group);
	await page.waitForTimeout(150);
	await tree.focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(200);
	h.check(await expanded(), '→ on a collapsed group expands it');
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(200);
	h.check(JSON.stringify(await selection()) === JSON.stringify([ids.box]), '→ on an open group steps into its first child');
	await page.keyboard.press('ArrowLeft');
	await page.waitForTimeout(200);
	h.check(JSON.stringify(await selection()) === JSON.stringify([ids.group]), '← on a child goes to its group');
	await page.keyboard.press('ArrowLeft');
	await page.waitForTimeout(200);
	h.check(!(await expanded()), '← on an open group collapses it');
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(200);
	h.check(await expanded(), 'and → opens it again');

	// ---- state kept ----------------------------------------------------------------------------
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.cone);
	await page.waitForTimeout(200);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(200);
	h.check(await expanded(), 'an open group stays open while the selection moves elsewhere and away');
	await page.evaluate(() => window.__stores.objectListClose.set(true));
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(500);
	h.check(await expanded(), 'closing and reopening the list keeps the group open');
	h.check(await childVisible(ids.box), 'with its children showing');
	await caret.click();
	await page.waitForTimeout(250);
	await page.evaluate(() => window.__stores.objectListClose.set(true));
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(500);
	h.check(!(await expanded()), 'and a collapsed group stays collapsed across a reopen');

	// selecting a child from elsewhere (the viewport) while its group is collapsed: the row is
	// revealed or not — asserted as today
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.sphere);
	await page.waitForTimeout(400);
	const revealOnSelect = await expanded();
	console.log(`  (today: selecting a child of a collapsed group from outside the list ${revealOnSelect ? 'expands' : 'does not expand'} the group)`);
	h.check(revealOnSelect === false, 'selecting a child of a collapsed group from outside the list leaves the group collapsed (as today)');

	await h.finish(browser);
});
