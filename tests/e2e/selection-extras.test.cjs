// Phase 85 — Ctrl+A select-all and the configurable double-click.
//
// Both drive the REAL input paths: Ctrl+A through the window keydown the
// shortcuts registry listens on, and the double-click through two real mouse
// clicks on a projected object position. A store-level version of either would
// pass with the dispatch broken, which is the whole failure mode here.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const built = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		w.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		// spread them so a projected click can hit one without the others in front
		g.children.forEach((c, i) => c.position.set(i * 3 - 3, 0, 0));
		w.objectsGroup.update((v) => v);
		w.objectActions.deselectObject();
		return {
			count: g.children.length,
			uuids: g.children.map((c) => c.uuid),
			kinds: g.children.map((c) => (c.isMesh ? c.geometry.type : c.type))
		};
	});
	h.check(built.count === 3, `three objects in the scene (premise: ${built.count})`);
	h.check(
		built.kinds.filter((k) => k === 'BoxGeometry').length === 2,
		`two of them share a kind (premise: ${JSON.stringify(built.kinds)})`
	);

	// ---- 1. Ctrl+A through the real keydown --------------------------------
	await A.page.keyboard.press('Control+a');
	await A.page.waitForTimeout(300);
	const all = await A.page.evaluate(() => {
		let set = [];
		window.__stores.selectedObjects.subscribe((v) => (set = v))();
		return set.length;
	});
	h.check(all === 3, `Ctrl+A selects every object (${all} of 3)`);

	// it must NOT fire while a mesh session owns the key for its own elements
	const inSession = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.objectActions.deselectObject();
		w.faceEdit.enterFaceEdit(uuid);
		await new Promise((r) => setTimeout(r, 300));
		return !!w.faceEdit.faceEditObject;
	}, built.uuids[0]);
	h.check(inSession, 'a mesh session is open (premise)');
	await A.page.keyboard.press('Control+a');
	await A.page.waitForTimeout(250);
	const duringSession = await A.page.evaluate(() => {
		const w = window.__stores;
		let set = [];
		w.selectedObjects.subscribe((v) => (set = v))();
		let picked = [];
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (picked = v))();
		w.faceEdit.exitFaceEdit();
		return { objects: set.length, faces: picked.length };
	});
	h.check(
		duringSession.objects <= 1,
		`Ctrl+A does not select the scene during a mesh session (${duringSession.objects} objects)`
	);
	h.check(
		duringSession.faces > 0,
		`...it selected mesh FACES instead, which is whose key it is (${duringSession.faces})`
	);

	// ---- 2. the double-click action ----------------------------------------
	const dblclick = async (uuid) => {
		const position = await A.page.evaluate((id) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', id);
			return [o.position.x, o.position.y, o.position.z];
		}, uuid);
		const point = await h.projectPoint(A.page, position);
		await A.page.mouse.click(point.x, point.y);
		await A.page.waitForTimeout(90);
		await A.page.mouse.click(point.x, point.y);
		await A.page.waitForTimeout(700);
	};

	// default: properties. (15-O's behaviour, and it stays the default.)
	const asDefault = await A.page.evaluate(() => {
		let value;
		window.__stores.selectionPrefs.doubleClickAction.subscribe((v) => (value = v))();
		return value;
	});
	h.check(asDefault === 'properties', `the default action is unchanged (${asDefault})`);

	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await dblclick(built.uuids[0]);
	const opened = await A.page.evaluate(() => {
		let open = null;
		window.__stores.inspectorOpen?.subscribe?.((v) => (open = v))();
		let set = [];
		window.__stores.selectedObjects.subscribe((v) => (set = v))();
		return { open, selected: set.length };
	});
	h.check(opened.selected === 1, 'a double-click still selects the object it hit');

	// 'meshedit' — the same gesture enters the mesh editor
	await A.page.evaluate(() => {
		window.__stores.selectionPrefs.doubleClickAction.set('meshedit');
		window.__stores.objectActions.deselectObject();
	});
	await dblclick(built.uuids[0]);
	const editing = await A.page.evaluate(() => {
		const w = window.__stores;
		let value = null;
		w.faceEdit.faceEditObject.subscribe((v) => (value = v))();
		w.faceEdit.exitFaceEdit();
		return value;
	});
	h.check(editing === built.uuids[0], 'with "Edit mesh" set, a double-click opens the mesh editor');

	// 'sametype' — both boxes, not the sphere
	await A.page.evaluate(() => {
		window.__stores.selectionPrefs.doubleClickAction.set('sametype');
		window.__stores.objectActions.deselectObject();
	});
	await dblclick(built.uuids[0]);
	const sameType = await A.page.evaluate(() => {
		let set = [];
		window.__stores.selectedObjects.subscribe((v) => (set = v))();
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return set.map((id) => {
			const o = g.getObjectByProperty('uuid', id);
			return o.isMesh ? o.geometry.type : o.type;
		});
	});
	h.check(
		sameType.length === 2 && sameType.every((k) => k === 'BoxGeometry'),
		`"Select same type" picks both boxes and not the sphere (${JSON.stringify(sameType)})`
	);

	// 'isolate' — the others are hidden, Escape brings them back
	await A.page.evaluate(() => {
		window.__stores.selectionPrefs.doubleClickAction.set('isolate');
		window.__stores.objectActions.deselectObject();
	});
	await dblclick(built.uuids[0]);
	const isolated = await A.page.evaluate((keep) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return {
			visible: g.children.filter((c) => c.visible !== false).map((c) => c.uuid),
			isolated: window.__stores.objectActions.isIsolated(),
			keep
		};
	}, built.uuids[0]);
	h.check(
		isolated.visible.length === 1 && isolated.visible[0] === built.uuids[0],
		`"Focus and isolate" leaves only the target visible (${isolated.visible.length} visible)`
	);
	h.check(isolated.isolated, 'and the app knows it is isolated');

	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);
	const restored = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return {
			visible: g.children.filter((c) => c.visible !== false).length,
			isolated: window.__stores.objectActions.isIsolated()
		};
	});
	h.check(restored.visible === 3, `Escape brings the scene back (${restored.visible} visible)`);
	h.check(!restored.isolated, '...and clears the isolation state');

	// an object the USER hid must stay hidden across an isolate/restore — the
	// snapshot remembers each object's own visibility, it does not just show all
	const respectsHidden = await A.page.evaluate((uuids) => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const hidden = g.getObjectByProperty('uuid', uuids[2]);
		hidden.visible = false; // the user hid this one
		w.objectActions.isolateObjects([uuids[0]]);
		w.objectActions.clearIsolation();
		return {
			stillHidden: hidden.visible === false,
			others: g.children.filter((c) => c.visible !== false).length
		};
	}, built.uuids);
	h.check(
		respectsHidden.stillHidden,
		'an object the user had hidden is NOT revealed by leaving an isolation'
	);
	h.check(respectsHidden.others === 2, `...while the rest come back (${respectsHidden.others})`);

	// Escape must be left alone when nothing is isolated (the `when` guard) —
	// otherwise the registry would swallow every Escape in the app
	const escapeFree = await A.page.evaluate(() => {
		const registry = window.__stores.shortcutsRegistry;
		const entry = registry.shortcuts.find((s) => s.keys === 'Escape');
		return { hasEntry: !!entry, declines: entry ? entry.when() === false : null };
	});
	h.check(escapeFree.hasEntry, 'Escape is in the shortcut registry (so it is listed in Settings)');
	h.check(
		escapeFree.declines,
		'...and declines the key when nothing is isolated, leaving other handlers alone'
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
