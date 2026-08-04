// 16-Q2: menu → panel deep links and the fixes that ride along.
//  - "More snapping settings…" / "Grid & axes settings…" / "Manage saved views…"
//    OPEN Configure Scene, EXPAND the named section (even if collapsed) and scroll
//    to it; clicking one while the panel is already open must NOT close it (the old
//    `showSidebar('scene')` toggled).
//  - the grid follows the LOOK-AT point (orbit target), horizontally, snapped to
//    whole cells; 'camera' and 'off' still available.
//  - the snapping submenu offers 0.25 for Scale and surfaces a CUSTOM value.
//  - the Physics section's checkboxes are themed (no raw <input type=checkbox>).
//  - adding from the Add menu opens the new object's properties.
const h = require('./helpers.cjs');

const panel = (page) =>
	page.evaluate(
		() =>
			new Promise((r) => {
				let closed = true;
				let kind = null;
				window.__stores.inspectorClose.subscribe((v) => (closed = v))();
				window.__stores.inspectorKind.subscribe((v) => (kind = v))();
				r({ open: !closed, kind });
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const openMenu = async () => {
		await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 240, y: 150, point: [0, 0, 0] }));
		await A.page.waitForTimeout(350);
	};
	/** hover a parent row then click a child by text */
	const pick = async (parent, child) => {
		await openMenu();
		await A.page.locator('[role="menuitem"]').filter({ hasText: parent }).first().hover();
		await A.page.waitForTimeout(300);
		await A.page.getByText(child, { exact: false }).first().click();
		await A.page.waitForTimeout(600);
	};

	// ---------- deep link from a CLOSED panel ----------
	await A.page.evaluate(() => {
		window.__stores.inspectorClose.set(true);
		// collapse the target section first, so expanding is observable
		localStorage.setItem('inspector:sec:Snapping', 'closed');
	});
	await pick('Snapping', 'More snapping settings');
	let state = await panel(A.page);
	h.check(state.open && state.kind === 'scene', `the deep link opens Configure Scene (${JSON.stringify(state)})`);
	const expanded = await A.page.evaluate(() => localStorage.getItem('inspector:sec:Snapping'));
	h.check(expanded === 'open', `the collapsed section was expanded (${expanded})`);
	const snapVisible = await A.page.evaluate(() => !!document.querySelector('#snap-rotate'));
	h.check(snapVisible, 'its contents are rendered');

	// ---------- deep link while the panel is ALREADY open: must not close it ----------
	await pick('View', 'Grid & axes settings');
	state = await panel(A.page);
	h.check(state.open && state.kind === 'scene', 'a second deep link keeps the panel open instead of toggling it');
	const gridVisible = await A.page.evaluate(() => !!document.querySelector('#grid-follow'));
	h.check(gridVisible, 'the Grid section is showing');

	await pick('Camera bookmarks', 'Manage saved views');
	state = await panel(A.page);
	h.check(state.open && state.kind === 'scene', 'and so does the bookmarks one');

	// ---------- grid follow: look-at ----------
	const follow = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.gridSettings.setGrid({ follow: 'lookat', cellSize: 1, matchSnapStep: false });
		let controls = null;
		w.orbitControls.subscribe((v) => (controls = v))();
		controls.target.set(7.4, 3, -4.6); // a target that is NOT on a cell boundary
		await new Promise((r) => setTimeout(r, 400));
		let scene = null;
		w.globalScene.subscribe((v) => (scene = v))();
		let grid = null;
		scene.traverse((n) => {
			if (n.type === 'Mesh' && n.material?.type === 'ShaderMaterial' && n.geometry?.type === 'PlaneGeometry')
				grid = grid ?? n;
		});
		return grid ? { x: grid.position.x, y: grid.position.y, z: grid.position.z } : null;
	});
	h.check(follow !== null, 'found the grid mesh');
	h.check(
		follow && Math.abs(follow.x - 7) < 0.001,
		`the grid centres under the look-at point, snapped to whole cells (x ${follow?.x})`
	);
	h.check(follow && Math.abs(follow.y) < 0.001, `it never lifts vertically (y ${follow?.y})`);
	h.check(follow && Math.abs(follow.z - (-5 + 0.03)) < 0.001, `z follows too (${follow?.z})`);

	// 'off' returns it to the origin
	await A.page.evaluate(() => window.__stores.gridSettings.setGrid({ follow: 'off' }));
	await A.page.waitForTimeout(400);
	const offCentre = await A.page.evaluate(() => {
		let scene = null;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		let grid = null;
		scene.traverse((n) => {
			if (n.type === 'Mesh' && n.material?.type === 'ShaderMaterial' && n.geometry?.type === 'PlaneGeometry')
				grid = grid ?? n;
		});
		return grid ? [grid.position.x, grid.position.z] : null;
	});
	h.check(offCentre && Math.abs(offCentre[0]) < 0.001, `Off puts it back at the origin (${offCentre})`);

	// ---------- snapping submenu: 0.25 for Scale + a custom value ----------
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));
	await A.page.evaluate(() =>
		window.__stores.snapping.snapSettings.set({ translate: 0.5, rotateDeg: 15, scale: 0.075 })
	);
	await openMenu();
	await A.page.locator('[role="menuitem"]').filter({ hasText: 'Snapping' }).first().hover();
	await A.page.waitForTimeout(350);
	const rows = await A.page.evaluate(() => {
		const sub = [...document.querySelectorAll('div')].find(
			(d) =>
				getComputedStyle(d).position === 'fixed' &&
				!d.getAttribute('role') &&
				d.textContent?.includes('Snap to surface')
		);
		return {
			labels: [...(sub?.querySelectorAll('[role="menuitem"]') ?? [])].map((r) => r.textContent?.trim()),
			checked: [...(sub?.querySelectorAll('.ctx-checked') ?? [])].map((r) => r.textContent?.trim())
		};
	});
	h.check(rows.labels.includes('0.25'), `Scale offers 0.25 (${rows.labels.join(' ')})`);
	h.check(rows.labels.includes('0.075'), 'a custom step from the panel appears in the menu');
	h.check(rows.checked.includes('0.075'), 'and it is marked as the active one');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// ---------- physics checkboxes are themed ----------
	const physics = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 250));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		w.physics.setPhysicsFor(box.uuid, { mode: 'dynamic' });
		w.objectActions.selectObject(box.uuid, true);
		localStorage.setItem('inspector:sec:Physics', 'open');
		await new Promise((r) => setTimeout(r, 700));
		const section = [...document.querySelectorAll('div')].find((d) =>
			d.querySelector('#physics-sensor')
		);
		const raw = section ? section.querySelectorAll('input[type="checkbox"]:not([class])').length : -1;
		const sensor = document.querySelector('#physics-sensor');
		return {
			found: !!sensor,
			classed: (sensor?.getAttribute('class') ?? '').length > 0,
			freezeRows: !!document.querySelector('#physics-freeze-rot')
		};
	});
	h.check(physics.found && physics.classed, `the Sensor checkbox is the themed component (${JSON.stringify(physics)})`);

	// ---------- Add opens the new object's properties ----------
	await A.page.evaluate(() => {
		window.__stores.showSidebar('scene'); // start on a DIFFERENT panel
	});
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => window.__stores.addObjects?.spawnAtPoint?.('/create Sphere 0.5', [1, 0, 1]));
	await A.page.waitForTimeout(500);
	const afterAdd = await panel(A.page);
	h.check(
		afterAdd.open && afterAdd.kind === 'selection',
		`adding switches the panel to the new object's properties (${JSON.stringify(afterAdd)})`
	);


	// ---------- 16-Q5: the section HEADER must clear the sticky filter header -----
	const headerVisible = async (label, parent, child) => {
		await A.page.evaluate(() => window.__stores.inspectorClose.set(true));
		await A.page.waitForTimeout(250);
		await pick(parent, child);
		await A.page.waitForTimeout(900); // smooth scroll settles
		return A.page.evaluate((wanted) => {
			const labels = [...document.querySelectorAll('.ui-section-label')];
			const el = labels.find((n) => n.textContent?.trim().toLowerCase().startsWith(wanted.toLowerCase()));
			if (!el) return { found: false };
			const sticky = document.querySelector('#drawer-label')?.getBoundingClientRect();
			const r = el.getBoundingClientRect();
			return { found: true, top: Math.round(r.top), stickyBottom: Math.round(sticky?.bottom ?? 0) };
		}, label);
	};

	const snapHeader = await headerVisible('Snapping', 'Snapping', 'More snapping settings');
	h.check(
		snapHeader.found && snapHeader.top >= snapHeader.stickyBottom - 4,
		`SNAPPING sits below the filter header, not under it (${JSON.stringify(snapHeader)})`
	);
	const gridHeader = await headerVisible('Grid', 'View', 'Grid & axes settings');
	h.check(
		gridHeader.found && gridHeader.top >= gridHeader.stickyBottom - 4,
		`GRID likewise (${JSON.stringify(gridHeader)})`
	);
	const savedViews = await headerVisible('Saved views', 'Camera bookmarks', 'Manage saved views');
	h.check(
		savedViews.found && savedViews.top >= savedViews.stickyBottom - 4 && savedViews.top < 420,
		`"Manage saved views…" lands on SAVED VIEWS itself (${JSON.stringify(savedViews)})`
	);

	// ---------- 16-Q5: snap steps read as clean numbers everywhere ---------------
	const clean = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.snapping.snapEnabled.set(true);
		w.snapping.snapSettings.set({ translate: 0.7999999999999999, rotateDeg: 15, scale: 0.1 });
		w.viewportMenu.set({ x: 240, y: 150, point: [0, 0, 0] });
		await new Promise((r) => setTimeout(r, 400));
		const row = [...document.querySelectorAll('[role="menu"] > [role="menuitem"]')].find((n) =>
			n.textContent?.includes('Snapping')
		);
		const hint = row?.querySelector('.ctx-hint')?.textContent?.trim() ?? '';
		w.viewportMenu.set(null);
		return { hint, ugly: hint.includes('0.7999') };
	});
	h.check(!clean.ugly && clean.hint.startsWith('0.8'), `the menu hint shows 0.8, not float noise (${clean.hint})`);

	await h.finish(browser);
});
