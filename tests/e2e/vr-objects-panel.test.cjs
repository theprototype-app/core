// Phase 101: VR selection shell + native objects panel — the shell mirrors
// the selection (mesh geometry / box for groups) at the scene root, the panel
// lists top-level objects with scroll + lock chips, rows select through the
// dispatcher and close the panel. On-device pose/feel is manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// three boxes, VR mode flagged (headless — no session needed for the shell).
	// 110 made the two-tone WIREFRAME the default indicator (covered by the
	// vr-palette suite) — this suite asserts the legacy BackSide shell, so opt
	// back into it for the shell block.
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		window.__stores.commandsHandler.sceneCommand('/create cylinder');
		window.__stores.vrWireframeSelection.set(false);
		window.__stores.isVRMode.set(true);
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[0];
		box.position.set(2, 0.5, -1);
		window.__stores.objectActions.selectObject(box.uuid);
		window.__box = box;
	});
	await A.page.waitForTimeout(700);

	// shell mirrors the selected mesh
	const shell = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const group = scene?.getObjectByName('vr-selection-shell');
					const mesh = group?.getObjectByName('vr-selection-shell-mesh');
					resolve(
						mesh
							? {
									visible: group.visible,
									pos: mesh.position.toArray().map((v) => Math.round(v * 100) / 100),
									scale: Math.round(mesh.scale.x * 100) / 100,
									backSide: mesh.material.side === window.__stores.THREE.BackSide,
									inObjects: !!mesh.parent?.parent?.name?.includes('objects')
								}
							: null
					);
				})();
			})
	);
	h.check(!!shell && shell.visible, 'selection shell mounts in VR mode');
	h.check(
		shell.pos.join(',') === '2,0.5,-1' && Math.abs(shell.scale - 1.05) < 0.01 && shell.backSide,
		`shell hugs the selection with a BackSide inflate (${shell.pos} ×${shell.scale})`
	);
	h.check(!shell.inObjects, 'shell lives at the scene root (never in the GLTF sync)');
	await A.page.evaluate(() => window.__stores.vrWireframeSelection.set(true)); // back to the 110 default

	// leaving VR hides the shell
	await A.page.evaluate(() => window.__stores.isVRMode.set(false));
	await A.page.waitForTimeout(300);
	const hidden = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) =>
					resolve(scene?.getObjectByName('vr-selection-shell')?.visible === false)
				)();
			})
	);
	h.check(hidden, 'shell hides outside VR');

	// --- objects panel: rows mirror the scene, actions route ---
	await A.page.evaluate(() => window.__stores.vrObjectsPanelOpen.set(true));
	await A.page.waitForTimeout(500);
	const rows = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-objects-panel');
					const names = [];
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrpanel-select:')) names.push(o.name.slice('vrpanel-select:'.length));
					});
					resolve(names);
				})();
			})
	);
	h.check(rows.length === 3, `panel lists the top-level objects (${rows.length})`);

	// selecting a row through the dispatcher selects + closes
	const picked = await A.page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.vrControls.executeVRMenuAction('panel:select:' + uuid);
				let selected, open;
				window.__stores.selectedObject.subscribe((v) => (selected = v?.uuid))();
				window.__stores.vrObjectsPanelOpen.subscribe((v) => (open = v))();
				resolve({ selected, open });
			}),
		rows[1]
	);
	h.check(picked.selected === rows[1] && picked.open === false, 'panel row selects the object and closes');

	// 109.4: the row CURSOR clamps to the list, follows the stick, and its
	// action id publishes for stick-press selection
	await A.page.evaluate(() => {
		window.__stores.vrObjectsPanelOpen.set(true);
		window.__stores.vrControls.vrPanelCursor.set(5);
	});
	await A.page.waitForTimeout(300);
	const cursorState = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				let cursor, action;
				window.__stores.vrControls.vrPanelCursor.subscribe((v) => (cursor = v))();
				window.__stores.vrControls.vrPanelCursorAction.subscribe((v) => (action = v))();
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-objects-panel');
					let count = 0;
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrpanel-select:')) count++;
					});
					resolve({ cursor, action, count });
				})();
			})
	);
	h.check(cursorState.cursor === 2 && cursorState.count === 3, `cursor clamps to the list (${cursorState.cursor})`);
	h.check(
		cursorState.action?.startsWith('panel:select:'),
		'cursored row publishes its select action for stick-press'
	);
	// dispatching the published action selects that row
	const cursorPick = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				let action;
				window.__stores.vrControls.vrPanelCursorAction.subscribe((v) => (action = v))();
				window.__stores.vrControls.executeVRMenuAction(action);
				let selected, open;
				window.__stores.selectedObject.subscribe((v) => (selected = v?.uuid))();
				window.__stores.vrObjectsPanelOpen.subscribe((v) => (open = v))();
				resolve({ matches: action === 'panel:select:' + selected, open });
			})
	);
	h.check(cursorPick.matches && cursorPick.open === false, 'stick-press path selects the cursored row');
	await A.page.evaluate(() => window.__stores.vrObjectsPanelOpen.set(true));
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('panel:close'));
	const closed = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.vrObjectsPanelOpen.subscribe((v) => resolve(v === false))();
			})
	);
	h.check(closed, 'panel:close dismisses the panel');

	await h.finish(browser);
});
