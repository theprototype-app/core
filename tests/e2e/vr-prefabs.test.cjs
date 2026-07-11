// Phase 115: VR prefabs — Edit ▸ Save prefab into the local library, the
// Add ▸ Prefabs thumbnail window (pin toggle, cells), and ghost placement:
// arm from a cell, instantiate at the ghost spot through the replicated
// prefab path, stay armed for repeats, cancel on grip/close. Lazy-follow
// smoothing and in-headset feel are the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- Edit ▸ Save prefab fills the library (thumbnail included) ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.name = 'TestCrate';
		window.__stores.objectActions.selectObject(box);
		window.__stores.vrMenuOpen.set(true);
		window.__stores.vrControls.executeVRMenuAction('obj:prefab');
	});
	await A.page.waitForTimeout(1200);
	const saved = await A.page.evaluate(() => {
		let list;
		window.__stores.prefabs.prefabs.subscribe((x) => (list = x))();
		const entry = list[list.length - 1];
		return {
			count: list.length,
			name: entry?.name,
			thumb: typeof entry?.thumbnail === 'string' && entry.thumbnail.startsWith('data:image'),
			menuClosed: (() => {
				let v;
				window.__stores.vrMenuOpen.subscribe((x) => (v = x))();
				return v === false;
			})()
		};
	});
	h.check(saved.count === 1 && saved.name === 'TestCrate', `Save prefab adds a library entry (${saved.name})`);
	h.check(saved.thumb, 'the entry renders a thumbnail');
	h.check(saved.menuClosed, 'Save prefab closes the ring');

	// --- Add ▸ Prefabs opens the window; cells render from the store ---
	const openState = await A.page.evaluate(() => {
		const readStore = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		window.__stores.vrMenuOpen.set(true);
		window.__stores.vrControls.executeVRMenuAction('prefabs');
		return {
			open: readStore(window.__stores.vrPrefabsPanelOpen),
			menu: readStore(window.__stores.vrMenuOpen)
		};
	});
	h.check(openState.open === true && openState.menu === false, 'Add - Prefabs opens the window and closes the ring');
	await A.page.waitForTimeout(500);
	const controls = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-prefabs-panel');
					const names = [];
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrprefabs-')) names.push(o.name.slice(10));
					});
					resolve(names);
				})();
			})
	);
	h.check(
		controls.includes('pin') && controls.includes('close') && controls.some((n) => n.startsWith('cell:')),
		`window renders pin, close and thumbnail cells (${controls.length})`
	);

	// --- pin toggle ---
	const pinned = await A.page.evaluate(() => {
		const readStore = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		window.__stores.vrControls.executeVRMenuAction('prefabs:pin');
		const on = readStore(window.__stores.vrPrefabsPinned);
		window.__stores.vrControls.executeVRMenuAction('prefabs:pin');
		return { on, off: readStore(window.__stores.vrPrefabsPinned) };
	});
	h.check(pinned.on === true && pinned.off === false, 'pin toggles the world-fixed flag');

	// --- ghost: arm from a cell, translucent clone rides the scene root ---
	const ghost = await A.page.evaluate(() => {
		const readStore = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		let list;
		window.__stores.prefabs.prefabs.subscribe((x) => (list = x))();
		window.__stores.vrControls.executeVRMenuAction('prefabs:select:' + list[0].id);
		const armed = readStore(window.__stores.vrControls.vrPrefabGhost);
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const clone = scene?.getObjectByName('vr-prefab-ghost');
		let translucent = false;
		clone?.traverse((o) => {
			if (o.material?.transparent && o.material.opacity < 0.5) translucent = true;
		});
		// aim the ghost somewhere specific, as the pointer ray would
		clone?.position.set(2, 0, -3);
		return { armed: armed?.name, hasClone: !!clone, translucent };
	});
	h.check(ghost.armed === 'TestCrate' && ghost.hasClone, 'selecting a cell arms the placement ghost');
	h.check(ghost.translucent, 'the ghost renders translucent');

	// --- placement: instantiates at the ghost spot, stays armed, undoable ---
	const placed = await A.page.evaluate(async () => {
		const readStore = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const before = group.children.length;
		const ok = window.__stores.vrControls.placePrefabGhost();
		const after = group.children.length;
		const child = group.children[group.children.length - 1];
		const stillArmed = !!readStore(window.__stores.vrControls.vrPrefabGhost);
		const again = window.__stores.vrControls.placePrefabGhost();
		const afterSecond = group.children.length;
		window.__stores.history.undo();
		const afterUndo = group.children.length;
		return {
			ok,
			before,
			after,
			afterSecond,
			afterUndo,
			again,
			pos: [child.position.x, child.position.y, child.position.z],
			name: child.name,
			stillArmed
		};
	});
	h.check(
		placed.ok && placed.after === placed.before + 1 && placed.name === 'TestCrate',
		'trigger instantiates the prefab through the replicated path'
	);
	h.check(
		Math.abs(placed.pos[0] - 2) < 1e-6 && Math.abs(placed.pos[2] + 3) < 1e-6,
		`the instance lands at the ghost spot (${placed.pos.map((v) => v.toFixed(1))})`
	);
	h.check(
		placed.stillArmed && placed.again && placed.afterSecond === placed.after + 1,
		'placement stays armed for repeats'
	);
	h.check(placed.afterUndo === placed.afterSecond - 1, 'placements are undoable');

	// --- grip cancels; closing the window drops the ghost too ---
	const cancelled = await A.page.evaluate(() => {
		const readStore = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		window.__stores.vrControls.cancelPrefabGhost();
		const afterCancel = readStore(window.__stores.vrControls.vrPrefabGhost);
		let list;
		window.__stores.prefabs.prefabs.subscribe((x) => (list = x))();
		window.__stores.vrControls.executeVRMenuAction('prefabs:select:' + list[0].id);
		window.__stores.vrControls.executeVRMenuAction('prefabs:close');
		const afterClose = readStore(window.__stores.vrControls.vrPrefabGhost);
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		return {
			afterCancel,
			afterClose,
			cloneGone: !scene?.getObjectByName('vr-prefab-ghost'),
			panelClosed: readStore(window.__stores.vrPrefabsPanelOpen) === false
		};
	});
	h.check(cancelled.afterCancel === null, 'cancel drops the ghost');
	h.check(
		cancelled.afterClose === null && cancelled.cloneGone && cancelled.panelClosed,
		'closing the window cancels an armed ghost'
	);

	await h.finish(browser);
});
