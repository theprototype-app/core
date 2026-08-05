// 16-P3: grid + snapping settings.
//  - Configure Scene grows a Grid section (show, cell size, "match snapping
//    step", major lines, colours, fade, extent, follow, origin axes) and a
//    Snapping section (steps as chips + free numbers, surface snap) — all LOCAL
//    prefs, persisted, never replicated.
//  - The viewport menu's snapping submenu is SECTIONED and marks the active
//    choice with `.ctx-checked` (bold + accent) instead of the old '● ' prefix
//    that shifted labels sideways.
const h = require('./helpers.cjs');

const grid = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.gridSettings.gridSettings.subscribe((v) => r({ ...v }))()));

/** open the viewport menu and read its Snapping submenu */
async function snapSubmenu(page) {
	await page.evaluate(() => window.__stores.viewportMenu.set({ x: 240, y: 150, point: [0, 0, 0] }));
	await page.waitForTimeout(350);
	await page.locator('[role="menuitem"]').filter({ hasText: 'Snapping' }).first().hover();
	await page.waitForTimeout(300);
	return page.evaluate(() => {
		const sub = [...document.querySelectorAll('div')].find(
			(d) =>
				getComputedStyle(d).position === 'fixed' &&
				!d.getAttribute('role') &&
				d.textContent?.includes('Snap to surface')
		);
		const parentHint = [...document.querySelectorAll('[role="menu"] > [role="menuitem"]')]
			.find((r) => r.textContent?.includes('Snapping'))
			?.querySelector('.ctx-hint')?.textContent?.trim();
		return {
			found: !!sub,
			sections: [...(sub?.querySelectorAll('.ctx-section') ?? [])].map((s) => s.textContent?.trim()),
			checked: [...(sub?.querySelectorAll('.ctx-checked') ?? [])].map((s) => s.textContent?.trim()),
			bullets: (sub?.textContent ?? '').includes('●'),
			parentHint,
			rows: [...(sub?.querySelectorAll('[role="menuitem"]') ?? [])].map((r) => r.textContent?.trim())
		};
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- the menu submenu: sections + checked, no bullets ----------
	await A.page.evaluate(() => {
		window.__stores.snapping.snapEnabled.set(true);
		window.__stores.snapping.snapSettings.set({ translate: 0.5, rotateDeg: 15, scale: 0.1 });
	});
	let sub = await snapSubmenu(A.page);
	h.check(sub.found, 'the Snapping submenu opens');
	h.check(
		['Position', 'Rotation', 'Scale', 'Surface'].every((s) => sub.sections.includes(s)),
		`it is sectioned (${sub.sections.filter(Boolean)})`
	);
	h.check(!sub.bullets, 'the ● prefix is gone');
	h.check(
		sub.checked.includes('0.5') && sub.checked.includes('15°') && sub.checked.includes('0.1'),
		`the active steps are marked bold+accent (${sub.checked})`
	);
	h.check(
		sub.parentHint === '0.5 · 15° · 0.1',
		`the parent row shows the live steps (${sub.parentHint})`
	);
	h.check(
		sub.rows.some((r) => r.startsWith('More snapping settings')),
		'a row jumps to Configure Scene'
	);

	// clicking a step updates the store AND the checked mark follows
	await A.page.evaluate(() => {
		const rows = [...document.querySelectorAll('div')]
			.find((d) => getComputedStyle(d).position === 'fixed' && d.textContent?.includes('Snap to surface'))
			?.querySelectorAll('[role="menuitem"]');
		[...rows].find((r) => r.textContent?.trim() === '45°')?.click();
	});
	await A.page.waitForTimeout(200);
	const rot = await A.page.evaluate(
		() => new Promise((r) => window.__stores.snapping.snapSettings.subscribe((v) => r(v.rotateDeg))())
	);
	h.check(rot === 45, `clicking a step applies it (${rot}°)`);
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));
	sub = await snapSubmenu(A.page);
	h.check(sub.checked.includes('45°'), 'the mark moved to the new step');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// ---------- Configure Scene: Grid + Snapping sections ----------
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(500);
	const sections = await A.page.evaluate(() =>
		[...document.querySelectorAll('#drawer-label, .ui-section-label, button, span, h3, h4, p')]
			.map((el) => el.textContent?.trim())
			.filter((t) => t === 'Grid' || t === 'Snapping')
	);
	h.check(sections.includes('Grid') && sections.includes('Snapping'), 'Configure Scene has Grid + Snapping sections');

	// grid params reach the store and persist
	await A.page.evaluate(() => {
		document.querySelector('#grid-axes').click();
		document.querySelector('#grid-infinite').click();
	});
	await A.page.waitForTimeout(250);
	let g = await grid(A.page);
	h.check(g.showAxes === true, 'the origin-axes toggle reaches the store');
	h.check(g.infinite === false, 'the infinite toggle reaches the store');
	// the helper lives in the world-grab rig (scene side), NOT inside objectsGroup —
	// anything under objectsGroup would enter GLTF sync and duplicate for peers
	const axes = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let scene = null;
				let objects = null;
				window.__stores.globalScene.subscribe((s) => (scene = s))();
				window.__stores.objectsGroup.subscribe((g) => (objects = g))();
				let inScene = false;
				let inObjects = false;
				scene?.traverse((n) => {
					if (n.type !== 'AxesHelper') return;
					inScene = true;
					let parent = n.parent;
					while (parent) {
						if (parent === objects) inObjects = true;
						parent = parent.parent;
					}
				});
				r({ inScene, inObjects });
			})
	);
	h.check(axes.inScene && !axes.inObjects, `an AxesHelper renders outside objectsGroup (${JSON.stringify(axes)})`);

	// "match snapping step" makes the drawn cell follow the snap step
	await A.page.evaluate(() => {
		document.querySelector('#grid-match-snap').click();
		window.__stores.snapping.snapSettings.update((s) => ({ ...s, translate: 0.25 }));
	});
	await A.page.waitForTimeout(250);
	const cell = await A.page.evaluate(() =>
		window.__stores.gridSettings.effectiveCell(
			JSON.parse(localStorage.getItem('gridSettings')),
			0.25
		)
	);
	h.check(cell === 0.25, `match-snap-step drives the cell size (${cell})`);

	// prefs survive a reload (LOCAL, localStorage — never replicated)
	await A.page.evaluate(() => document.querySelector('#grid-cell-color').value);
	await h.freshReload(A);
	await A.page.waitForTimeout(1200);
	g = await grid(A.page);
	h.check(g.showAxes === true && g.infinite === false && g.matchSnapStep === true, 'grid prefs persist across a reload');

	// snapping numbers accept a free value
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(500);
	await A.page.locator('#snap-rotate').fill('7.5');
	await A.page.locator('#snap-rotate').dispatchEvent('change');
	await A.page.waitForTimeout(250);
	const custom = await A.page.evaluate(
		() => new Promise((r) => window.__stores.snapping.snapSettings.subscribe((v) => r(v.rotateDeg))())
	);
	h.check(custom === 7.5, `a custom rotation step is accepted (${custom}°)`);

	// 15-H13: 'lookat' follow snaps the grid centre by the SECTION period, not by a
	// single cell — a per-cell snap kept the thin lines world-locked but hopped every
	// THICK line one cell per step (the "grid snaps while panning" report). The fade
	// circle must stay on the UNSNAPPED camera point (threlte's default) so it glides.
	await A.page.evaluate(() => {
		window.__stores.gridSettings.setGrid({
			follow: 'lookat',
			cellSize: 1,
			sectionEvery: 10,
			matchSnapStep: false,
			infinite: true,
			fadeMode: 'auto'
		});
		let oc;
		window.__stores.orbitControls.subscribe((x) => (oc = x))();
		oc.target.set(3.7, 0, -12.4); // deliberately off both the cell and section lattice
		oc.update();
	});
	await A.page.waitForTimeout(600);
	const gridMesh = await A.page.evaluate(
		() =>
			new Promise((r) => {
				window.__stores.globalScene.subscribe((scene) => {
					let found = null;
					scene.traverse((node) => {
						if (!found && node.isMesh && node.material?.uniforms?.fadeOrigin) found = node;
					});
					if (!found) return r(null);
					let camera;
					window.__stores.globalCamera.subscribe((c) => (camera = c))();
					const origin = found.material.uniforms.fadeOrigin.value;
					r({
						x: found.position.x,
						z: found.position.z,
						fadeOrigin: [origin.x, origin.y, origin.z],
						camera: [camera.position.x, camera.position.z]
					});
				})();
			})
	);
	const onLattice = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-4;
	h.check(
		!!gridMesh && onLattice(gridMesh.x, 10) && onLattice(gridMesh.z - 0.03, 10),
		`H13: the follow centre lands on the SECTION lattice (${gridMesh && gridMesh.x}, ${
			gridMesh && (gridMesh.z - 0.03).toFixed(2)
		}) so no line moves`
	);
	h.check(
		!!gridMesh && Math.abs(gridMesh.z - 0.03 + 10) < 1e-4,
		`H13: it still FOLLOWS the look-at target (z ${gridMesh && (gridMesh.z - 0.03).toFixed(2)} for a target at -12.4)`
	);
	h.check(
		!!gridMesh &&
			Math.abs(gridMesh.fadeOrigin[0] - gridMesh.camera[0]) < 0.01 &&
			Math.abs(gridMesh.fadeOrigin[2] - gridMesh.camera[1]) < 0.01,
		`H13: the fade circle stays on the unsnapped camera point (${gridMesh?.fadeOrigin
			.map((v) => v.toFixed(1))
			.join(',')} vs camera ${gridMesh?.camera.map((v) => v.toFixed(1)).join(',')})`
	);

	await h.finish(browser);
});
