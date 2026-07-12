// Phase 137: VR Edit Mesh side-menu — the Edit ring drops Show/Hide + the
// Vertices/Faces▸ entries for one toggle "Edit Mesh" that opens a controller
// side-menu with the mode rows + face tools; mode switching flips the
// meshEdit/faceEdit session. On-device feel is manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const read = (name) =>
		A.page.evaluate((n) => {
			let v;
			const s = window.__stores;
			(s[n] ?? s.faceEdit[n] ?? s.meshEdit[n]).subscribe((x) => (v = x))();
			return v && v.uuid !== undefined ? v.uuid : v;
		}, name);

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		window.__stores.objectActions.selectObject(box.uuid);
	});
	await A.page.waitForTimeout(300);

	// --- Edit Mesh toggles mesh edit + the side-menu (defaults to Faces) ---
	const opened = await A.page.evaluate(() => {
		window.__stores.vrMenuOpen.set(true);
		window.__stores.vrControls.executeVRMenuAction('obj:editmesh');
		const r = (s) => { let v; s.subscribe((x) => (v = x))(); return v; };
		return {
			menuOpen: r(window.__stores.vrEditMenuOpen),
			faceEditing: r(window.__stores.faceEdit.faceEditObject) === window.__box.uuid,
			ringClosed: r(window.__stores.vrMenuOpen) === false
		};
	});
	h.check(opened.menuOpen && opened.faceEditing, 'Edit Mesh enters Faces mode + opens the side-menu');
	h.check(opened.ringClosed, 'the radial ring closes');

	await A.page.waitForTimeout(400);
	// --- the side-menu renders mode rows + face tools ---
	const rows = await A.page.evaluate(
		() =>
			new Promise((r) => {
				window.__stores.globalScene.subscribe((scene) => {
					const menu = scene?.getObjectByName('vr-edit-menu');
					const names = [];
					menu?.traverse((o) => {
						if (o.name?.startsWith('vredit-')) names.push(o.name.slice('vredit-'.length));
					});
					r(names);
				})();
			})
	);
	h.check(
		rows.includes('edit:mode:vertices') && rows.includes('edit:mode:faces') && rows.includes('edit:close'),
		`side-menu has both mode rows + close (${rows.length})`
	);
	h.check(
		rows.includes('face:extrude') && rows.includes('face:inset') && rows.includes('face:move') && rows.includes('face:delete'),
		'Faces mode shows the four op rows'
	);

	// --- switching to Vertices flips the session ---
	const switched = await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('edit:mode:vertices');
		const r = (s) => { let v; s.subscribe((x) => (v = x))(); return v; };
		return {
			vertexEditing: r(window.__stores.meshEdit.editingObject) === window.__box.uuid,
			faceCleared: r(window.__stores.faceEdit.faceEditObject) === null
		};
	});
	h.check(switched.vertexEditing && switched.faceCleared, 'switching to Vertices flips the edit session');

	// --- arming a face op after switching back to Faces ---
	const armed = await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('edit:mode:faces');
		window.__stores.vrControls.executeVRMenuAction('face:inset');
		let op; window.__stores.faceEdit.faceEditOp.subscribe((x) => (op = x))();
		return op;
	});
	h.check(armed === 'inset', 'Faces tool rows arm the op');

	// --- Done closes + exits both sessions ---
	const closed = await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('edit:close');
		const r = (s) => { let v; s.subscribe((x) => (v = x))(); return v; };
		return {
			menu: r(window.__stores.vrEditMenuOpen),
			face: r(window.__stores.faceEdit.faceEditObject),
			vertex: r(window.__stores.meshEdit.editingObject)
		};
	});
	h.check(closed.menu === false && closed.face === null && closed.vertex === null, 'Done exits edit + closes the menu');

	await h.finish(browser);
});
