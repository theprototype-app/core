// Phase 77: viewport right-click menu — right-tap opens the organized menu
// (Add ▸ Mesh/Light nested, search entry), objects spawn at the clicked point
// (replicated), right-drag still orbits, right-tap on an object shows its own
// context menu, and the sidebar lost its Create section.
const h = require('./helpers.cjs');

const names = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))()
			)
	);
const rightTap = async (page, x, y) => {
	await page.mouse.move(x, y);
	await page.mouse.down({ button: 'right' });
	await page.mouse.up({ button: 'right' });
	await page.waitForTimeout(300);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// 125 made the object-search entry opt-in; enable it so the menu shows it
	await A.page.evaluate(() => window.__stores.objectSearchEnabled.set(true));

	// right-click TAP on empty viewport opens the merged menu
	await rightTap(A.page, 700, 400);
	h.check(
		await A.page.getByText('Search objects…', { exact: false }).isVisible(),
		'menu opens with the search entry'
	);
	// (hasText is substring — 'Add' row precedes 'Add note' in DOM order)
	const addRow = A.page.locator('[role="menuitem"]').filter({ hasText: 'Add' }).first();
	h.check(await addRow.isVisible(), 'Add group listed');

	// Add ▸ Mesh ▸ Torus spawns at the clicked ground point and replicates
	await addRow.hover();
	await A.page.waitForTimeout(200);
	// nth(1): the open Add row (ancestor) also matches the 'Mesh' substring
	const meshRow = A.page.locator('[role="menuitem"]').filter({ hasText: 'Mesh' }).nth(1);
	await meshRow.hover();
	await A.page.waitForTimeout(200);
	await A.page.getByText('Torus', { exact: true }).first().click();
	await h.eventually(
		() => Promise.all([names(A.page), names(B.page)]),
		([a, b]) => a.includes('Torus') && b.includes('Torus'),
		'Torus created and replicated'
	);
	const positions = await Promise.all(
		[A.page, B.page].map((page) =>
			page.evaluate(
				() =>
					new Promise((r) =>
						window.__stores.objectsGroup.subscribe((g) =>
							r(g?.children.find((c) => c.name === 'Torus')?.position.toArray())
						)()
					)
			)
		)
	);
	h.check(
		Math.hypot(positions[0][0], positions[0][2]) > 0.5,
		`spawned at the clicked point, not origin (${positions[0].map((v) => v.toFixed(1))})`
	);
	h.check(
		Math.abs(positions[0][0] - positions[1][0]) < 0.01 &&
			Math.abs(positions[0][2] - positions[1][2]) < 0.01,
		'same spot on both peers'
	);

	// the ADD search box (Shift+A) — Enter adds the top-matching primitive.
	// (125 added a SEPARATE "Search objects" box for finding existing objects;
	// this is the add-a-primitive search, #add-search-input.)
	// WAIT for the box rather than sleeping 300ms: the shortcut's action dynamically
	// imports appStore, and with two peers rendering at full rAF that resolved after
	// the old fixed wait — the check failed while the feature worked.
	await A.page.keyboard.press('Shift+KeyA');
	const addBox = A.page.locator('#add-search-input');
	await addBox.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
	h.check(await addBox.isVisible(), 'search box opens');
	await A.page.keyboard.type('ico');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() => names(A.page),
		(list) => list.includes('Icosahedron'),
		'search Enter added the top match'
	);

	// Add ▸ Group creates an empty group
	await rightTap(A.page, 950, 140);
	await A.page.locator('[role="menuitem"]').filter({ hasText: 'Add' }).first().hover();
	await A.page.waitForTimeout(200);
	await A.page.getByText('Group', { exact: true }).first().click();
	await h.eventually(
		() => names(A.page),
		(list) => list.some((n) => n.startsWith('New')),
		'Add > Group creates a group'
	);

	// Shift+A opens the search box directly
	await A.page.keyboard.press('Shift+KeyA');
	await addBox.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
	h.check(await addBox.isVisible(), 'Shift+A opens the search');
	await A.page.keyboard.press('Escape');

	// right-tap ON an object opens the object context menu (not the Add menu) —
	// before the drag test below, which moves the camera. A box, not the torus:
	// a ray through a torus center passes through the hole.
	const boxScreen = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 200));
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children.filter((c) => c.name === 'Box').pop();
		box.position.set(0, 0.5, 0);
		window.__stores.objectsGroup.update((v) => v);
		const cam = await new Promise((r) => window.__stores.globalCamera.subscribe(r)());
		const v = new window.__stores.THREE.Vector3(0, 0.5, 0).project(cam);
		return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
	});
	await A.page.waitForTimeout(200);
	await rightTap(A.page, Math.round(boxScreen[0]), Math.round(boxScreen[1]));
	h.check(
		await A.page.getByText('Focus camera', { exact: true }).isVisible(),
		'right-tap on an object shows its context menu'
	);
	await A.page.mouse.click(200, 200); // close
	await A.page.waitForTimeout(200);

	// right-DRAG does not open the menu (orbit pan keeps working) — last,
	// because it moves the camera
	await A.page.mouse.move(600, 300);
	await A.page.mouse.down({ button: 'right' });
	await A.page.mouse.move(750, 420, { steps: 6 });
	await A.page.mouse.up({ button: 'right' });
	await A.page.waitForTimeout(300);
	h.check(
		!(await A.page.getByText('Search objects…', { exact: false }).isVisible().catch(() => false)) &&
			!(await A.page.getByText('Focus camera', { exact: true }).isVisible().catch(() => false)),
		'right-drag does not open any menu'
	);

	await h.finish(browser);
});
