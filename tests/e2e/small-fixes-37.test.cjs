// 37 R18 — four small fixes, one section each:
//  1. Z cycles this viewer's view mode (Shaded / Shaded + AO / Wireframe), a registry row
//  2. the edit wireframe RE-TINTS live when the material colour changes (face + vertex mode)
//  3. note pins stay on their object while the world rig is moved (VR world-grab/colocation)
//  4. a ThemedSelect inside a TRUE modal dialog (showModal) paints above it and takes clicks
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { viewMode: 'shaded' } });
	const page = A.page;
	const readStore = (/** @type {string} */ name) =>
		page.evaluate((n) => {
			let v;
			window.__stores[n].subscribe((x) => (v = x))();
			return v;
		}, name);

	// ---- 1. the view-mode key ---------------------------------------------------------
	const row = await page.evaluate(() => {
		const r = window.__stores.shortcutsRegistry.shortcuts.find((s) => s.id === 'view.cycle');
		return r ? { keys: r.keys, scope: r.scope, label: r.label } : null;
	});
	h.check(row?.keys === 'Z' && row?.scope === 'viewport', `the registry has view.cycle on Z (${JSON.stringify(row)})`);
	const canvas = await page.evaluate(() => {
		const all = [...document.querySelectorAll('canvas')].filter((x) => x.getBoundingClientRect().width > 300);
		const r = all[0].getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	await page.mouse.click(canvas.x, canvas.y);
	await page.waitForTimeout(200);
	const seen = [await readStore('viewMode')];
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press('KeyZ');
		await page.waitForTimeout(250);
		seen.push(await readStore('viewMode'));
	}
	h.check(seen.join(',') === 'shaded,shaded-ao,wireframe,shaded', `Z cycles the modes in chip order (${seen.join(' -> ')})`);
	const wireOn = await page.evaluate(async () => {
		window.__stores.viewMode.set('wireframe');
		await new Promise((r) => setTimeout(r, 200));
		let sc;
		window.__stores.globalScene.subscribe((s) => (sc = s))();
		const on = !!sc.overrideMaterial?.wireframe;
		window.__stores.viewMode.set('shaded');
		return on;
	});
	h.check(wireOn, 'landing on Wireframe really applies the override material');
	const skip = await page.evaluate(() => window.__stores.viewModeCtl.nextViewMode('shaded', true));
	h.check(skip === 'wireframe', 'with the scene providing AO, the cycle skips Shaded + AO (the disabled chip)');
	const rebound = await page.evaluate(() => {
		const reg = window.__stores.shortcutsRegistry;
		const ok = reg.rebindShortcut('view.cycle', 'Shift+Z');
		const keys = reg.shortcuts.find((s) => s.id === 'view.cycle').keys;
		reg.rebindShortcut('view.cycle', 'Z');
		return { ok: ok.ok === true, keys };
	});
	h.check(rebound.ok && /Shift\+Z/.test(String(rebound.keys)), `the key is rebindable (${JSON.stringify(rebound)})`);

	// ---- 2. live wireframe re-tint ------------------------------------------------------
	const tint = await page.evaluate(async () => {
		const { commandsHandler, objectsGroup, objectActions, faceEdit, meshEdit, materialsHandler } = window.__stores;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		commandsHandler.sceneCommand('/create box');
		await wait(700);
		let group = null;
		objectsGroup.subscribe((g) => (group = g))();
		const box = group.children[group.children.length - 1];
		box.material.color.set('#101010');
		objectActions.selectObject(box.uuid);
		const read = () => box.getObjectByName('edit-overlay')?.material?.color?.getHexString();
		faceEdit.enterFaceEdit(box.uuid);
		await wait(400);
		const faceDark = read();
		// the Inspector's path
		materialsHandler.setObjectColor(box.uuid, '#ffffff');
		await wait(300);
		const faceLight = read();
		// a path with no poke at all (a peer's colour message writes the colour directly)
		box.material.color.set('#202020');
		await wait(300);
		const faceDirect = read();
		faceEdit.exitFaceEdit();
		await wait(300);
		// vertex mode: the wire used to keep its build-time colour for the whole session
		meshEdit.enterEditMode(box.uuid);
		await wait(400);
		const vertDark = read();
		box.material.color.set('#f0f0f0');
		await wait(300);
		const vertLight = read();
		meshEdit.exitEditMode();
		await wait(200);
		return { faceDark, faceLight, faceDirect, vertDark, vertLight, uuid: box.uuid };
	});
	h.check(tint.faceDark === '2f81f7', `premise: a dark material gets the light wire (${tint.faceDark})`);
	h.check(tint.faceLight === '1f2937', `face mode: a colour edit mid-session re-tints the wire (${tint.faceLight})`);
	h.check(tint.faceDirect === '2f81f7', `face mode: a direct colour write (no store poke) re-tints too (${tint.faceDirect})`);
	h.check(tint.vertDark === '2f81f7' && tint.vertLight === '1f2937', `vertex mode re-tints live (${tint.vertDark} -> ${tint.vertLight})`);

	// ---- 3. pins under a moved world rig ------------------------------------------------
	const pins = await page.evaluate(async (uuid) => {
		const s = window.__stores;
		const THREE = s.THREE;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const ah = s.annotationsHandler;
		ah.addAnnotation(uuid, [0.2, 0.5, 0.1]);
		let cur = null;
		ah.activeAnnotation.subscribe((a) => (cur = a))();
		ah.setAnnotation({ ...cur.draft, text: 'rig-pin' });
		ah.activeAnnotation.set(null);
		let list = [];
		ah.annotations.subscribe((l) => (list = l))();
		const id = list.find((a) => a.text === 'rig-pin').id;
		let rig = null;
		s.worldRig.subscribe((r) => (rig = r))();
		const pinPos = () => {
			let grp = null;
			ah.pinsGroup.subscribe((g) => (grp = g))();
			const pin = grp?.getObjectByName('pin-' + id);
			const v = new THREE.Vector3();
			pin?.getWorldPosition(v);
			return v;
		};
		await wait(300);
		const dist = () => pinPos().distanceTo(ah.annotationWorldPosition(id));
		const identity = dist();
		// a world grab: shift, turn and shrink the rig (what grip.js updateWorldGrab writes)
		rig.position.set(1.5, -0.4, 2);
		rig.rotation.set(0, 0.7, 0);
		rig.scale.setScalar(0.5);
		rig.updateMatrixWorld(true);
		await wait(400);
		const grabbed = dist();
		rig.position.set(0, 0, 0);
		rig.rotation.set(0, 0, 0);
		rig.scale.setScalar(1);
		rig.updateMatrixWorld(true);
		await wait(300);
		return { identity, grabbed, back: dist() };
	}, tint.uuid);
	h.check(pins.identity < 0.01, `premise: an unmoved rig puts the pin on its anchor (${pins.identity.toFixed(4)})`);
	h.check(pins.grabbed < 0.01, `a moved/turned/scaled rig keeps the pin on its anchor (off by ${pins.grabbed.toFixed(4)})`);
	h.check(pins.back < 0.01, 'and back after the rig resets');

	// ---- 4. ThemedSelect inside a true modal dialog ------------------------------------
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForTimeout(500);
	await page.getByText('Interface', { exact: true }).first().click();
	await page.waitForTimeout(300);
	const themeBefore = await page.evaluate(() => {
		let v;
		window.__stores.themes.theme.subscribe((x) => (v = x))();
		return v;
	});
	// move the theme picker into a fresh showModal() dialog: the case a dialog that reverts
	// to modal would produce (every app dialog is non-modal today, so this is the guard)
	await page.evaluate(() => {
		const wrap = document.querySelector('#theme-select').closest('.ts-wrap');
		window.__tsHome = { parent: wrap.parentNode, next: wrap.nextSibling };
		const dlg = document.createElement('dialog');
		dlg.id = 'r18-modal';
		dlg.style.cssText = 'padding:24px;min-width:300px';
		document.body.appendChild(dlg);
		dlg.appendChild(wrap);
		dlg.showModal();
	});
	await page.waitForTimeout(200);
	await page.click('#r18-modal #theme-select');
	await page.waitForTimeout(250);
	const probe = await page.evaluate(() => {
		const list = document.querySelector('.ts-list');
		const opts = [...(list?.querySelectorAll('li') ?? [])];
		const target = opts.find((o) => o.getAttribute('aria-selected') !== 'true');
		if (!target) return { list: !!list };
		const r = target.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return { list: true, inDialog: !!list.closest('#r18-modal'), hitIsOption: hit === target, x: r.left + r.width / 2, y: r.top + r.height / 2, name: target.textContent.trim() };
	});
	h.check(probe.list && probe.inDialog, `the popup portals INTO the modal dialog (${JSON.stringify({ list: probe.list, inDialog: probe.inDialog })})`);
	h.check(probe.hitIsOption, 'an option is the topmost element at its own centre (paints above the top layer)');
	if (probe.x) await page.mouse.click(probe.x, probe.y);
	await page.waitForTimeout(250);
	const themeAfter = await page.evaluate(() => {
		let v;
		window.__stores.themes.theme.subscribe((x) => (v = x))();
		return v;
	});
	h.check(themeAfter !== themeBefore, `clicking the option picks it inside the modal (${themeBefore} -> ${themeAfter})`);
	await page.evaluate((t) => {
		window.__stores.themes.theme.set(t);
		const dlg = document.querySelector('#r18-modal');
		const wrap = dlg.querySelector('.ts-wrap');
		window.__tsHome.parent.insertBefore(wrap, window.__tsHome.next);
		dlg.close();
		dlg.remove();
	}, themeBefore);
	// outside the modal case nothing changed: the list still goes to <body>
	await page.click('#theme-select');
	await page.waitForTimeout(250);
	const bodyParent = await page.evaluate(() => document.querySelector('.ts-list')?.parentElement === document.body);
	h.check(bodyParent, 'in a non-modal dialog (every app modal today) the list still portals to <body>');
	await page.keyboard.press('Escape');

	await h.finish(browser);
});
