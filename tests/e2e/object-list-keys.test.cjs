// 24-B2: keyboard navigation in the object list. Rows had no keyboard handling and
// expansion was per-row local state the parent could not see (reported: "down/up
// arrows in object list should move between objects"). Expansion now lives in the
// `expandedObjects` store, `visibleObjectRows` (lib/objectListNav.js) is the flat
// visible order, and the list container (role="tree") owns the keys: ↑/↓ select
// (gizmo follows), Shift extends, → expands / ← collapses or goes to the parent,
// Home/End, Enter = Properties, F2 = rename, Escape blurs, letters type-ahead. The
// search box keeps its own keys and hands ↓ to the tree.
const h = require('./helpers.cjs');

const state = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const get = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const controls = get(s.TControls);
		return {
			selected: get(s.selectedObjects),
			attached: controls?.object ? (controls.object.userData?.isMultiPivot ? 'pivot' : 'object') : null,
			expanded: [...get(s.expandedObjects)],
			renaming: get(s.renamingObject),
			inspectorClosed: get(s.inspectorClose),
			treeFocused: document.activeElement?.id === 'object-tree',
			renameFocused: document.activeElement?.classList?.contains('row-rename') ?? false
		};
	});
const camPos = (page) => page.evaluate(() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c?.position?.toArray()))()));
const moved = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const press = async (page, key) => {
	await page.keyboard.press(key);
	await page.waitForTimeout(160);
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// cube + sphere grouped, then a cone: rows = [Group{Box, Sphere}, Cone]
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
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	// grouping asks the new group's row to expand (toggleExpand) once it mounts — start
	// this walk from a COLLAPSED group
	await page.evaluate(() => {
		window.__stores.toggleExpand.set(null);
		window.__stores.expandedObjects.set(new Set());
	});
	await page.waitForTimeout(200);
	const rows = await page.evaluate(() => {
		const s = window.__stores;
		let g, x;
		s.objectsGroup.subscribe((v) => (g = v))();
		s.expandedObjects.subscribe((v) => (x = v))();
		return s.objectListNav?.visibleObjectRows?.(g, x, null) ?? null;
	});
	h.check(!!rows, 'objectListNav is exposed to the suite');
	h.check(rows.length === 2 && rows[0].uuid === ids.group && rows[0].hasKids && rows[1].uuid === ids.cone, `premise: two visible rows, the group collapsed (${rows.map((r) => r.name).join(', ')})`);
	const tree = page.locator('#object-tree');
	h.check((await tree.count()) === 1 && (await tree.getAttribute('role')) === 'tree', 'the list body is a focusable tree');

	// ---- focus + ↓ ↓ → ------------------------------------------------------------------
	await tree.focus();
	await page.waitForTimeout(100);
	await press(page, 'ArrowDown');
	let s = await state(page);
	h.check(s.treeFocused && s.selected.length === 1 && s.selected[0] === ids.group && s.attached === 'object', `↓ from nothing selects the first row, the group, gizmo attached (${s.attached})`);
	await press(page, 'ArrowRight');
	s = await state(page);
	h.check(s.expanded.includes(ids.group), '→ expands the group');
	await press(page, 'ArrowDown');
	s = await state(page);
	h.check(s.selected[0] === ids.box, `↓ walks into the expanded group's first child (the box)`);
	await press(page, 'Shift+ArrowDown');
	s = await state(page);
	h.check(s.selected.length === 2 && s.selected.includes(ids.box) && s.selected.includes(ids.sphere) && s.attached === 'pivot', `Shift+↓ extends the set (${s.selected.length}, ${s.attached})`);

	// ---- ← twice: parent, then collapse ------------------------------------------------
	await press(page, 'ArrowLeft');
	s = await state(page);
	h.check(s.selected.length === 1 && s.selected[0] === ids.group, `← on a leaf goes to the parent (${s.selected.length})`);
	await press(page, 'ArrowLeft');
	s = await state(page);
	h.check(!s.expanded.includes(ids.group) && s.selected[0] === ids.group, '← on an open group collapses it');
	await press(page, 'ArrowDown');
	s = await state(page);
	h.check(s.selected[0] === ids.cone, '↓ skips the collapsed children and lands on the cone');
	await press(page, 'Home');
	s = await state(page);
	h.check(s.selected[0] === ids.group, 'Home selects the first row');
	await press(page, 'End');
	s = await state(page);
	h.check(s.selected[0] === ids.cone, 'End selects the last row');

	// ---- Enter = Properties ------------------------------------------------------------
	await page.evaluate(() => window.__stores.closeSelectionInspector());
	await page.waitForTimeout(100);
	await press(page, 'Enter');
	s = await state(page);
	h.check(s.inspectorClosed === false, 'Enter opens Properties for the row');

	// ---- F2 = rename, and the rename input owns its keys ------------------------------
	await tree.focus();
	await press(page, 'F2');
	s = await state(page);
	h.check(s.renaming === ids.cone && s.renameFocused, `F2 opens the inline rename input (${s.renaming === ids.cone}, focused ${s.renameFocused})`);
	const c0 = await camPos(page);
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(400);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(150);
	const c1 = await camPos(page);
	h.check(moved(c0, c1) < 0.01, `W inside the rename input does not fly the camera (moved ${moved(c0, c1).toFixed(3)})`);
	await press(page, 'Escape'); // cancels the rename (the input's own key)
	s = await state(page);
	h.check(s.renaming === null, 'Escape in the input cancels the rename');

	// ---- type-ahead --------------------------------------------------------------------
	await tree.focus();
	await press(page, 'Home');
	await page.keyboard.type('c');
	await page.waitForTimeout(200);
	s = await state(page);
	h.check(s.selected[0] === ids.cone, 'typing "c" jumps to the Cone');
	await page.waitForTimeout(600);
	await press(page, 'ArrowRight'); // no-op on a leaf
	await press(page, 'Home');
	await press(page, 'ArrowRight');
	await page.keyboard.type('sp');
	await page.waitForTimeout(200);
	s = await state(page);
	h.check(s.selected[0] === ids.sphere, 'typing "sp" reaches the Sphere inside the open group');
	// the physical-key fallback: a Cyrillic layout's key on KeyC still finds the Cone
	await page.waitForTimeout(600);
	await page.evaluate(() => {
		document.getElementById('object-tree').dispatchEvent(new KeyboardEvent('keydown', { key: 'с', code: 'KeyC', bubbles: true, cancelable: true }));
	});
	await page.waitForTimeout(200);
	s = await state(page);
	h.check(s.selected[0] === ids.cone, 'a Cyrillic с on the C key still type-aheads to the Cone (physical fallback)');

	// ---- Escape blurs the tree and the viewport flies again ----------------------------
	await press(page, 'Escape');
	s = await state(page);
	h.check(!s.treeFocused, 'Escape blurs the tree');
	const c2 = await camPos(page);
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(400);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(150);
	const c3 = await camPos(page);
	h.check(moved(c2, c3) > 0.1, `W flies the camera once the list is blurred (moved ${moved(c2, c3).toFixed(2)})`);

	// ---- the search box hands ↓ to the tree ---------------------------------------------
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.locator('#object-search').fill('');
	await page.locator('#object-search').focus();
	await press(page, 'ArrowDown');
	s = await state(page);
	h.check(s.treeFocused && s.selected.length === 1, `↓ from the search box focuses the tree and selects the first row (${s.selected.length})`);
	await press(page, 'ArrowDown');
	s = await state(page);
	h.check(s.selected[0] !== ids.group, 'and the arrows keep walking from there');

	// ---- expansion survives the filter (ancestors auto-expand into the store) -----------
	await page.evaluate(() => window.__stores.expandedObjects.set(new Set()));
	await page.locator('#object-search').fill('sphere');
	await page.waitForTimeout(400);
	s = await state(page);
	h.check(s.expanded.includes(ids.group), 'a search that matches a child auto-expands its group in the store');
	await page.locator('#object-search').press('Escape');

	await h.finish(browser);
});
