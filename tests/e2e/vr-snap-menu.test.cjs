// Phase 156: VR Edit > Snap becomes a toggle that opens a controller side-menu
// (Off / Grid / Surface / Rotation) with sub-values (grid step, rotate angle +
// Reset). Mode selection drives the shared snapping stores; Reset zeroes the
// selected object's rotation (replicated + undoable); Surface rests a grabbed
// object on the nearest surface. On-device ray/feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const read = (path) =>
		A.page.evaluate((p) => {
			const s = window.__stores;
			const store = p.includes('.') ? p.split('.').reduce((o, k) => o[k], s) : s[p];
			let v;
			store.subscribe((x) => (v = x))();
			return v && v.uuid !== undefined ? v.uuid : v;
		}, path);

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		window.__stores.objectActions.selectObject(box.uuid);
	});
	await A.page.waitForTimeout(300);

	// --- the Snap ring entry toggles the side-menu open (+ closes siblings) ---
	const opened = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(true);
		s.vrEditMenuOpen.set(true); // a sibling that should be closed
		s.vrControls.executeVRMenuAction('snap');
		const r = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		return {
			menuOpen: r(s.vrSnapMenuOpen),
			ringClosed: r(s.vrMenuOpen) === false,
			siblingClosed: r(s.vrEditMenuOpen) === false
		};
	});
	h.check(opened.menuOpen, 'the Snap entry opens the side-menu');
	h.check(opened.ringClosed && opened.siblingClosed, 'opening Snap closes the ring + sibling panels');

	await A.page.waitForTimeout(400);
	// --- the side-menu renders the four mode rows + Done ---
	const traverse = () =>
		A.page.evaluate(
			() =>
				new Promise((r) => {
					window.__stores.globalScene.subscribe((scene) => {
						const menu = scene?.getObjectByName('vr-snap-menu');
						const names = [];
						menu?.traverse((o) => {
							if (o.name?.startsWith('vrsnap-')) names.push(o.name.slice('vrsnap-'.length));
						});
						r(names);
					})();
				})
		);
	const modes = await traverse();
	h.check(
		['snap:mode:off', 'snap:mode:grid', 'snap:mode:surface', 'snap:mode:rotation', 'snap:close'].every((n) =>
			modes.includes(n)
		),
		`side-menu shows all four modes + Done (${modes.length} rows)`
	);

	// --- picking Grid sets the mode + reveals grid sub-values ---
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('snap:mode:grid'));
	await A.page.waitForTimeout(400);
	const gridRows = await traverse();
	h.check((await read('vrSnapMode')) === 'grid', 'Grid selects the grid mode');
	h.check((await read('snapping.snapEnabled')) === true, 'Grid mode enables gizmo/nudge grid snap');
	h.check(
		['snap:grid:0.1', 'snap:grid:0.5', 'snap:grid:1'].every((n) => gridRows.includes(n)),
		'Grid mode reveals the 0.1 / 0.5 / 1 sub-values'
	);

	// --- a grid sub-value sets the translate step ---
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('snap:grid:0.5'));
	const step = await A.page.evaluate(() => {
		let v; window.__stores.snapping.snapSettings.subscribe((x) => (v = x))();
		return v.translate;
	});
	h.check(step === 0.5, `grid sub-value sets the translate step (${step})`);

	// --- Rotation reveals the angle sub-values + Reset ---
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('snap:mode:rotation'));
	await A.page.waitForTimeout(400);
	const rotRows = await traverse();
	h.check((await read('vrSnapMode')) === 'rotation', 'Rotation selects the rotation mode');
	h.check(
		['snap:rot:15', 'snap:rot:30', 'snap:rot:45', 'snap:rot:reset'].every((n) => rotRows.includes(n)),
		'Rotation reveals 15 / 30 / 45 + Reset (156 adjustment)'
	);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('snap:rot:30'));
	const angle = await A.page.evaluate(() => {
		let v; window.__stores.snapping.snapSettings.subscribe((x) => (v = x))();
		return v.rotateDeg;
	});
	h.check(angle === 30, `rotation sub-value sets the rotate-snap angle (${angle})`);

	// --- Reset zeroes the object rotation, broadcasts a move + records undo ---
	const reset = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__box;
		box.rotation.set(0.3, 0.7, -0.2);
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		s.vrControls.executeVRMenuAction('snap:rot:reset');
		s.peers.set(original);
		const after = { x: box.rotation.x, y: box.rotation.y, z: box.rotation.z };
		s.history.undo();
		const restored = Math.abs(box.rotation.y - 0.7) < 1e-6;
		return { after, moved: captured.some((m) => m.type === 'move'), restored };
	});
	h.check(
		reset.after.x === 0 && reset.after.y === 0 && reset.after.z === 0,
		'Reset zeroes the selected object rotation'
	);
	h.check(reset.moved, 'Reset broadcasts a move to peers');
	h.check(reset.restored, 'Reset is undoable (rotation comes back)');

	// --- Surface mode flips surfaceSnap; dropToSurface rests on the object below ---
	const surface = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrControls.executeVRMenuAction('snap:mode:surface');
		let mode; s.vrSnapMode.subscribe((x) => (mode = x))();
		let surf; s.snapping.surfaceSnap.subscribe((x) => (surf = x))();
		let grid; s.snapping.snapEnabled.subscribe((x) => (grid = x))();
		// a platform + a box floating above it -> dropToSurface rests it on top
		const THREE = s.THREE;
		let group; s.objectsGroup.subscribe((g) => (group = g))();
		const platform = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 4), new THREE.MeshStandardMaterial());
		platform.position.set(0, 1, 0);
		platform.updateMatrixWorld(true);
		group.add(platform);
		const dropped = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		dropped.position.set(0, 5, 0);
		dropped.updateMatrixWorld(true);
		group.add(dropped);
		const changed = s.snapping.dropToSurface(dropped, group);
		const restY = dropped.position.y; // platform top 1.25 + half box 0.5 = 1.75
		group.remove(platform);
		group.remove(dropped);
		return { mode, surf, grid, changed, restY };
	});
	h.check(surface.mode === 'surface' && surface.surf === true, 'Surface mode flips the surfaceSnap store');
	h.check(surface.grid === false, 'Surface mode leaves grid snap off');
	h.check(surface.changed && Math.abs(surface.restY - 1.75) < 1e-3, `dropToSurface rests the box on the platform top (${surface.restY.toFixed(2)})`);

	// --- Off clears both; mode persists to localStorage ---
	const off = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrControls.executeVRMenuAction('snap:mode:off');
		let surf; s.snapping.surfaceSnap.subscribe((x) => (surf = x))();
		let grid; s.snapping.snapEnabled.subscribe((x) => (grid = x))();
		return { surf, grid, stored: localStorage.getItem('vrSnapMode') };
	});
	h.check(off.surf === false && off.grid === false, 'Off disables both surface + grid snap');
	h.check(off.stored === 'off', 'the snap mode persists to localStorage');

	// --- Done closes the side-menu ---
	const done = await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('snap:close');
		let v; window.__stores.vrSnapMenuOpen.subscribe((x) => (v = x))();
		return v;
	});
	h.check(done === false, 'Done closes the Snap side-menu');

	await h.finish(browser);
});
