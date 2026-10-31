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

	// --- ghost: arm from a cell — 52-browser: the window's ghost is the SHARED laser ghost
	// (placeDrag's ray mode, absorbs f-vr-place): a box / translucent model at the scene root ---
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
		// aim the laser straight down at (2, 0, -3), as the pointer hand would
		const T = window.__stores.THREE;
		window.__vrPrefabRay = new T.Raycaster(new T.Vector3(2, 5, -3), new T.Vector3(0, -1, 0));
		window.__stores.placeDrag.updateRayPlace(window.__vrPrefabRay);
		const root = window.__stores.placeGhost.ghostRoot();
		let translucent = false;
		root?.traverse((o) => {
			if (o.material?.transparent && o.material.opacity < 0.6) translucent = true;
		});
		const info = window.__stores.placeGhost.ghostInfo();
		return { armed: armed?.name, hasGhost: !!root && info.visible, translucent, mode: window.__stores.placeDrag.state()?.mode, at: info.items[0]?.position };
	});
	h.check(ghost.armed === 'TestCrate' && ghost.hasGhost && ghost.mode === 'ray', `selecting a cell arms the shared laser ghost (${JSON.stringify(ghost)})`);
	h.check(ghost.translucent, 'the ghost renders translucent');
	h.check(Math.abs(ghost.at[0] - 2) < 1e-6 && Math.abs(ghost.at[2] + 3) < 1e-6, `the ghost rides the laser to the floor spot (${ghost.at})`);

	// --- placement: instantiates at the ghost spot, stays armed, undoable ---
	const count = () => A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	const before = await count();
	const ok = await A.page.evaluate(() => window.__stores.vrControls.placePrefabGhost());
	await h.eventually(count, (n) => n === before + 1, 'trigger instantiates the prefab through the replicated path', 5000);
	const placed = await A.page.evaluate(async () => {
		const readStore = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const child = group.children[group.children.length - 1];
		const stillArmed = !!readStore(window.__stores.vrControls.vrPrefabGhost);
		window.__stores.placeDrag.updateRayPlace(window.__vrPrefabRay);
		const again = window.__stores.vrControls.placePrefabGhost();
		return { pos: [child.position.x, child.position.y, child.position.z], name: child.name, stillArmed, again };
	});
	h.check(ok && placed.name === 'TestCrate', `the placed object is the prefab (${placed.name})`);
	h.check(
		Math.abs(placed.pos[0] - 2) < 1e-6 && Math.abs(placed.pos[2] + 3) < 1e-6,
		`the instance lands at the ghost spot (${placed.pos.map((v) => v.toFixed(1))})`
	);
	await h.eventually(count, (n) => n === before + 2, 'placement stays armed for repeats', 5000);
	h.check(placed.stillArmed && placed.again, 'the ghost is still armed after a placement');
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await count()) === before + 1, 'placements are undoable (one undo = one placement)');

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
			cloneGone: !window.__stores.placeGhost.ghostRoot() && !window.__stores.placeDrag.placeDragActive(),
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
