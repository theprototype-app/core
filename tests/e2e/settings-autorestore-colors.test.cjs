// 18-A: the auto-restore-on-load preference and the viewport LINE COLOUR prefs.
//
// Two things worth knowing about the shape of this suite:
//  - the restore path only ever runs on an EMPTY scene, so the snapshot is written
//    by a real `saveNow()` and then picked up by a RELOAD of the same context
//    (IndexedDB survives it, the scene does not) — there is no way to fake it that
//    still exercises checkRestore's own gate.
//  - the outline colour lives in a postprocessing uniform, not in any store, so it
//    is read through the component's own `__outlineDebug` hook.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();

	// ---------------------------------------------------------------- colours
	const A = await h.setupPage(browser, 'A');

	const defaults = await A.page.evaluate(() => {
		let prefs = null;
		window.__stores.viewPrefs.viewPrefs.subscribe((v) => (prefs = v))();
		return prefs;
	});
	h.check(defaults?.wireColor === '#9aa4b0', `default wire colour (${defaults?.wireColor})`);
	h.check(defaults?.outlineColor === '#353535', `default outline colour (${defaults?.outlineColor})`);
	h.check(defaults?.editWireColor === 'auto', `edit wire defaults to auto (${defaults?.editWireColor})`);

	// --- wireframe view mode reads (and live-updates) the pref ---------------
	const wire = await A.page.evaluate(async () => {
		const { viewPrefs, viewMode, globalScene } = window.__stores;
		viewPrefs.setViewPrefs({ wireColor: '#ff8800' });
		viewMode.set('wireframe');
		await new Promise((r) => setTimeout(r, 300));
		let scene = null;
		globalScene.subscribe((s) => (scene = s))();
		const atSwitch = scene?.overrideMaterial?.color?.getHexString();
		// and again while the mode is already active — the material is a singleton,
		// so this must be a live write, not a rebuild-on-next-switch
		viewPrefs.setViewPrefs({ wireColor: '#00c8ff' });
		await new Promise((r) => setTimeout(r, 200));
		const live = scene?.overrideMaterial?.color?.getHexString();
		viewMode.set('shaded');
		return { atSwitch, live, isWire: !!scene?.overrideMaterial };
	});
	h.check(wire.atSwitch === 'ff8800', `wireframe uses the pref colour (${wire.atSwitch})`);
	h.check(wire.live === '00c8ff', `wireframe colour updates live (${wire.live})`);

	// --- selection outline colour -------------------------------------------
	const outline = await A.page.evaluate(async () => {
		const before = window.__outlineDebug?.();
		window.__stores.viewPrefs.setViewPrefs({ outlineColor: '#22ff88' });
		await new Promise((r) => setTimeout(r, 300));
		const after = window.__outlineDebug?.();
		return { before, after };
	});
	h.check(
		outline.before?.selectedColor === '353535',
		`outline starts at the default (${outline.before?.selectedColor})`
	);
	h.check(
		outline.after?.selectedColor === '22ff88',
		`selection outline follows the pref (${outline.after?.selectedColor})`
	);
	h.check(
		outline.after?.lockedColor === outline.before?.lockedColor,
		`the LOCKED outline is untouched (${outline.after?.lockedColor}) — it means "a peer holds this"`
	);

	// --- Edit Mesh overlay: auto (luminance) vs a pinned colour --------------
	const editWire = await A.page.evaluate(async () => {
		const { commandsHandler, objectsGroup, objectActions, faceEdit, viewPrefs } = window.__stores;
		commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		let group = null;
		objectsGroup.subscribe((g) => (group = g))();
		const box = group.children[group.children.length - 1];
		// a DARK material, so 'auto' takes the light branch and cannot coincide
		// with the colour we pin below
		box.material.color.set('#101010');
		objectActions.selectObject(box.uuid);
		faceEdit.enterFaceEdit(box.uuid);
		await new Promise((r) => setTimeout(r, 400));
		const read = () => box.getObjectByName('edit-overlay')?.material?.color?.getHexString();
		const auto = read();
		viewPrefs.setViewPrefs({ editWireColor: '#ff00aa' });
		await new Promise((r) => setTimeout(r, 400));
		const pinned = read();
		viewPrefs.setViewPrefs({ editWireColor: 'auto' });
		await new Promise((r) => setTimeout(r, 400));
		const backToAuto = read();
		faceEdit.exitFaceEdit();
		return { auto, pinned, backToAuto };
	});
	h.check(editWire.auto === '2f81f7', `'auto' picks from the material's luminance (${editWire.auto})`);
	h.check(editWire.pinned === 'ff00aa', `a pinned colour rebuilds the overlay (${editWire.pinned})`);
	h.check(
		editWire.backToAuto === '2f81f7',
		`switching back to auto restores the luminance pick (${editWire.backToAuto})`
	);

	// --- the reset chip ------------------------------------------------------
	const reset = await A.page.evaluate(async () => {
		window.__stores.viewPrefs.resetViewPrefs();
		await new Promise((r) => setTimeout(r, 200));
		let prefs = null;
		window.__stores.viewPrefs.viewPrefs.subscribe((v) => (prefs = v))();
		return prefs;
	});
	h.check(
		reset?.wireColor === '#9aa4b0' && reset?.outlineColor === '#353535' && reset?.editWireColor === 'auto',
		'reset puts every line colour back to its default'
	);

	// --- the Settings rows exist and are wired -------------------------------
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	await A.page.getByText('Scene', { exact: true }).first().click();
	await A.page.waitForTimeout(400);
	for (const id of ['#auto-restore', '#wire-color', '#outline-color', '#edit-wire-auto', '#edit-wire-color', '#reset-view-colors'])
		h.check(await A.page.locator(id).count() > 0, `Settings ▸ Scene has ${id}`);

	// the colour input writes the store (drive the real input path, not the setter)
	await A.page.locator('#wire-color').evaluate((el) => {
		el.value = '#123456';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await A.page.waitForTimeout(200);
	const fromInput = await A.page.evaluate(() => {
		let prefs = null;
		window.__stores.viewPrefs.viewPrefs.subscribe((v) => (prefs = v))();
		return prefs?.wireColor;
	});
	h.check(fromInput === '#123456', `the Settings swatch writes the pref (${fromInput})`);

	// the Auto checkbox flips editWireColor between 'auto' and a hex
	await A.page.locator('#edit-wire-auto').uncheck();
	await A.page.waitForTimeout(200);
	const unchecked = await A.page.evaluate(() => {
		let prefs = null;
		window.__stores.viewPrefs.viewPrefs.subscribe((v) => (prefs = v))();
		return prefs?.editWireColor;
	});
	h.check(unchecked !== 'auto' && /^#/.test(unchecked ?? ''), `unticking Auto pins a hex (${unchecked})`);
	const colorDisabled = await A.page.locator('#edit-wire-color').isDisabled();
	h.check(colorDisabled === false, 'the swatch is enabled once Auto is off');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));

	// prefs survive a reload (localStorage, per device)
	await h.freshReload(A);
	await A.page.waitForTimeout(1500);
	const persisted = await A.page.evaluate(() => {
		let prefs = null;
		window.__stores.viewPrefs.viewPrefs.subscribe((v) => (prefs = v))();
		return prefs;
	});
	h.check(persisted?.wireColor === '#123456', `colours persist across a reload (${persisted?.wireColor})`);
	await A.ctx.close();

	// ------------------------------------------------- auto-restore: pref OFF
	// The default must still ASK. Build a scene, save it, reload: with no pref the
	// sticky 'restore-session' prompt appears and nothing is restored by itself.
	const B = await h.setupPage(browser, 'B');
	await B.page.evaluate(async () => {
		const { commandsHandler, autosave } = window.__stores;
		commandsHandler.sceneCommand('/create box');
		commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 800));
		await autosave.saveNow();
	});
	await B.page.waitForTimeout(600);
	await h.freshReload(B);
	await B.page.waitForTimeout(3000);

	const offState = await B.page.evaluate(() => {
		let toasts = [];
		window.__stores.toastStore.subscribe((l) => (toasts = l))();
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return {
			objects: group?.children.length ?? -1,
			prompt: toasts.find((t) => t && t.id === 'restore-session')?.text ?? '',
			done: toasts.some((t) => t && t.id === 'restore-done')
		};
	});
	h.check(offState.objects === 0, `pref OFF restores nothing by itself (${offState.objects} objects)`);
	h.check(/Restore previous session/.test(offState.prompt), `pref OFF still ASKS ("${offState.prompt}")`);
	h.check(offState.done === false, 'no auto-restore report when the pref is off');
	await B.ctx.close();

	// -------------------------------------------------- auto-restore: pref ON
	const C = await h.setupPage(browser, 'C');
	await C.page.evaluate(async () => {
		const { commandsHandler, autosave } = window.__stores;
		commandsHandler.sceneCommand('/create box');
		commandsHandler.sceneCommand('/create sphere');
		commandsHandler.sceneCommand('/create cylinder');
		await new Promise((r) => setTimeout(r, 900));
		await autosave.saveNow();
		autosave.autoRestoreEnabled.set(true);
	});
	await C.page.waitForTimeout(600);
	await h.freshReload(C);
	// the restore parses a GLTF, so give it room
	await C.page.waitForTimeout(4000);

	const onState = await C.page.evaluate(() => {
		let toasts = [];
		window.__stores.toastStore.subscribe((l) => (toasts = l))();
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const done = toasts.find((t) => t && t.id === 'restore-done');
		return {
			objects: group?.children.length ?? -1,
			text: done?.text ?? '',
			sticky: !!done?.sticky,
			kind: done?.kind ?? '',
			prompt: toasts.some((t) => t && t.id === 'restore-session')
		};
	});
	h.check(onState.objects === 3, `pref ON restores the scene by itself (${onState.objects} objects)`);
	h.check(onState.prompt === false, 'the "Restore previous session?" prompt never appears');
	h.check(
		/^Restored 3 objects from your last session \(saved .+\)$/.test(onState.text),
		`the report names the count AND when it was saved ("${onState.text}")`
	);
	h.check(onState.sticky && onState.kind === 'info', 'the report is a sticky info toast');

	// STICKY means it outlives the 15s transient window — the whole point of the
	// phrasing ask ("show unless closed")
	await C.page.waitForTimeout(16000);
	const survived = await C.page.evaluate(() => {
		let toasts = [];
		window.__stores.toastStore.subscribe((l) => (toasts = l))();
		return toasts.some((t) => t && t.id === 'restore-done');
	});
	h.check(survived, 'the report is still there after the transient timeout');

	// and it goes away when the user closes it
	const closed = await C.page.evaluate(async () => {
		window.__stores.dismissToastById('restore-done');
		await new Promise((r) => setTimeout(r, 200));
		let toasts = [];
		window.__stores.toastStore.subscribe((l) => (toasts = l))();
		return toasts.some((t) => t && t.id === 'restore-done');
	});
	h.check(closed === false, 'closing the report dismisses it');

	await h.finish(browser);
});
