// Phase 154: delete an object from the viewport menu or the keyboard; a group
// asks first. The menu Delete + the Delete/Backspace key both route through
// requestDeleteSelection (replicated + undoable); the key is ignored while a
// text field is focused; deleting a group prompts and only removes on confirm.
const h = require('./helpers.cjs');

const inScene = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return !!g?.getObjectByProperty('uuid', u);
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.flowGraphClose.set(true)); // node editor closed

	// --- requestDeleteSelection removes a single object + undo restores it ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = g.children[g.children.length - 1].uuid;
		window.__stores.objectActions.selectObject(window.__box);
		window.__stores.objectActions.requestDeleteSelection(); // what the menu Delete calls
	});
	await A.page.waitForTimeout(150);
	h.check(!(await inScene(A.page, await A.page.evaluate(() => window.__box))), 'menu Delete removes a single object');
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(150);
	h.check(await inScene(A.page, await A.page.evaluate(() => window.__box)), 'the delete is undoable');

	// --- the Delete KEY removes the current selection ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__sphere = g.children[g.children.length - 1].uuid;
		window.__stores.objectActions.selectObject(window.__sphere);
		document.body.focus();
	});
	await A.page.keyboard.press('Delete');
	await A.page.waitForTimeout(150);
	h.check(!(await inScene(A.page, await A.page.evaluate(() => window.__sphere))), 'the Delete key removes the selection');

	// --- the key is IGNORED while a text field is focused (renaming) ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create cylinder');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__cyl = g.children[g.children.length - 1].uuid;
		window.__stores.objectActions.selectObject(window.__cyl);
	});
	await A.page.locator('input[placeholder="Enter peer ID to connect"]').focus();
	await A.page.keyboard.press('Delete');
	await A.page.waitForTimeout(150);
	h.check(await inScene(A.page, await A.page.evaluate(() => window.__cyl)), 'Delete is ignored while a text field is focused');
	await A.page.evaluate(() => document.body.focus());

	// --- deleting a GROUP prompts (action-toast) + only removes on confirm ---
	const prompted = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const grp = new THREE.Group();
		grp.name = 'MyGroup';
		grp.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
		grp.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
		group.add(grp);
		s.objectsGroup.update((v) => v);
		window.__grp = grp.uuid;
		s.objectActions.selectObject(grp.uuid);
		s.objectActions.requestDeleteSelection();
		let toasts;
		s.toastStore.subscribe((t) => (toasts = t))();
		const confirm = toasts.find((t) => t && t.actions && /Delete "MyGroup"/.test(t.text));
		return { hasPrompt: !!confirm, actionCount: confirm?.actions?.length ?? 0 };
	});
	h.check(prompted.hasPrompt && prompted.actionCount === 2, 'deleting a group shows a Delete/Cancel confirm toast');
	h.check(await inScene(A.page, await A.page.evaluate(() => window.__grp)), 'the group is NOT removed before confirming');

	// confirm -> the group goes
	await A.page.evaluate(() => {
		const s = window.__stores;
		let toasts;
		s.toastStore.subscribe((t) => (toasts = t))();
		const confirm = toasts.find((t) => t && t.actions && /Delete "MyGroup"/.test(t.text));
		confirm.actions.find((a) => a.label === 'Delete').action();
	});
	await A.page.waitForTimeout(150);
	h.check(!(await inScene(A.page, await A.page.evaluate(() => window.__grp))), 'confirming removes the group');

	await h.finish(browser);
});
