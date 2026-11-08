// 43 J3 — copy / paste / reset on values, vectors and sections in Properties + Configure Scene.
//   1  copy Position from box A (right-click the row NAME = the vector menu), paste it into box
//      B's Position and into B's Scale (a vector pastes into ANY vector row) — one undo step each
//   2  per-axis menu (right-click an X/Y/Z box): copy one value, paste it, Paste Y only, Reset
//   3  text a person typed into a notepad / code editor: "1, 2, 3", "Vector3(1,2,3)", the JSON
//      block; units as the panel shows them (degrees for a rotation); a refusal with a reason
//   4  hovered Ctrl+C / Ctrl+V (Blender's convention) — copy/paste events, no permission prompt
//   5  section: Copy section on A's Transform header -> the JSON block on the clipboard; Paste
//      section on B = all three vectors, ONE undo step; a section pasted onto a row by name
//   6  multiselect: "Paste to all selected (N)" puts the transform on every selected object
//   7  value rows on their own: a slider row (Roughness), a toggle, a choice, a colour, and a
//      Configure Scene row (Exposure) — copy / paste / reset
//   8  phone (OPPO Find N6 folded, real touch): a LONG PRESS opens the menu, the release does
//      not start typing in the field, and Paste vector works; 98-int: a SLOW finger drag (0.9 s, under the
//      10 px hold slop) on a slider drags and never opens the menu (device-lab-3, HONOR); a slow scrub on a value box scrubs
const h = require('./helpers.cjs');

const CTX = { permissions: ['clipboard-read', 'clipboard-write'] };

/** @param {any} page */
const store = (page, expr) => page.evaluate(expr);

/** @param {any} page @param {string} uuid */
const poseOf = (page, uuid) =>
	page.evaluate((id) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		const r = (n) => Math.round(n * 1000) / 1000;
		return { pos: o.position.toArray().map(r), rot: [o.rotation.x, o.rotation.y, o.rotation.z].map(r), scale: o.scale.toArray().map(r) };
	}, uuid);

/** @param {any} page @param {number[]} pos @returns {Promise<string>} */
const makeBox = (page, pos) =>
	page.evaluate(async (p) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 300));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(p[0], p[1], p[2]);
		box.userData.physics = { mode: 'static' };
		return box.uuid;
	}, pos);

/** @param {any} page @param {string} uuid */
const select = async (page, uuid) => {
	await page.evaluate((id) => {
		localStorage.setItem('inspector:sec:Transform', 'open');
		window.__stores.objectActions.selectObject(id, true);
	}, uuid);
	await page.waitForTimeout(500);
};

const undoDepth = (page) => store(page, () => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const undo = (page) => store(page, () => window.__stores.history.undo());
const clipText = (page) => page.evaluate(() => navigator.clipboard.readText());
/** @param {any} page @param {string} text */
const setClip = (page, text) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
const near = (a, b, eps = 0.002) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

/** the row wrapping one of the transform field groups @param {any} page @param {string} id */
const rowOf = (page, id) => page.locator('.pr', { has: page.locator('#' + id) });
/** @param {any} page */
const menuItem = (page, label) => page.locator('[role="menuitem"]').filter({ hasText: label }).first();
let lastAim = '';
/** right-click a locator, remembering what was under the cursor (for a failure report) @param {any} loc */
async function rclick(loc) {
	await loc.scrollIntoViewIfNeeded();
	const box = await loc.boundingBox();
	const page = loc.page();
	const x = box.x + Math.min(box.width / 2, 20);
	const y = box.y + box.height / 2;
	lastAim = await page.evaluate(
		([px, py]) => {
			const el = document.elementFromPoint(px, py);
			return `${el?.tagName}.${String(el?.className).slice(0, 40)} "${(el?.textContent ?? '').slice(0, 20)}" active=${document.activeElement?.tagName}`;
		},
		[x, y]
	);
	await page.mouse.click(x, y, { button: 'right' });
	await page.waitForTimeout(150);
}
/** @param {any} page */
async function pick(page, label) {
	const item = menuItem(page, label);
	try {
		await item.waitFor({ state: 'visible', timeout: 5000 });
	} catch (err) {
		const state = await page.evaluate(() => JSON.stringify(window.__stores.fieldMenu.fieldMenu ? (() => { let v; window.__stores.fieldMenu.fieldMenu.subscribe((x) => (v = x))(); return v?.items?.map((i) => i.label ?? i.section); })() : null));
		console.log(`[pick "${label}"] aimed at: ${lastAim} · menu items: ${state}`);
		throw err;
	}
	await item.click();
	await page.waitForTimeout(700); // the transform seal records 500 ms after the last change
}
/** @param {any} page */
const menuOpen = (page) => page.locator('[role="menuitem"]').first().isVisible().catch(() => false);
/** @param {any} page */
const lastToast = (page) => store(page, () => new Promise((r) => window.__stores.toastStore?.subscribe((t) => r(JSON.stringify(t)))?.() ?? r('')));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1440, height: 900 }, ...CTX } });
	const P = A.page;

	const boxA = await makeBox(P, [1.25, 0, -3]);
	const boxB = await makeBox(P, [5, 5, 5]);
	await P.evaluate((id) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		o.rotation.set(0, Math.PI / 2, 0);
		o.scale.set(2, 3, 4);
	}, boxA);

	// ---------- 1  vector: copy Position from A, paste into B's Position and B's Scale ----------
	await select(P, boxA);
	await rclick(rowOf(P, 'inspector-position').locator('.pr-label'));
	h.check(await menuOpen(P), '1.0 right-click on the Position NAME opens the field menu');
	for (const label of ['Copy vector', 'Paste vector', 'Reset', 'Paste X only', 'Paste Y only', 'Paste Z only'])
		h.check(await menuItem(P, label).isVisible(), `1.1 the vector menu offers "${label}"`);
	await pick(P, 'Copy vector');
	const copied = await clipText(P);
	h.check(copied === 'position: 1.25, 0, -3', `1.2 the clipboard holds the text form (${JSON.stringify(copied)})`);

	await select(P, boxB);
	let depth = await undoDepth(P);
	await rclick(rowOf(P, 'inspector-position').locator('.pr-label'));
	await pick(P, 'Paste vector');
	let b = await poseOf(P, boxB);
	h.check(near(b.pos, [1.25, 0, -3]), `1.3 Paste vector puts A's position on B (${b.pos})`);
	h.check((await undoDepth(P)) === depth + 1, `1.4 the paste is ONE undo step (${depth} -> ${await undoDepth(P)})`);
	await undo(P);
	await P.waitForTimeout(300);
	b = await poseOf(P, boxB);
	h.check(near(b.pos, [5, 5, 5]), `1.5 one undo puts all three axes back (${b.pos})`);

	await rclick(rowOf(P, 'inspector-scale').locator('.pr-label'));
	await pick(P, 'Paste vector');
	b = await poseOf(P, boxB);
	h.check(near(b.scale, [1.25, 0, -3]), `1.6 a position pastes into a DIFFERENT vector row (scale ${b.scale})`);
	await rclick(rowOf(P, 'inspector-scale').locator('.pr-label'));
	await pick(P, 'Reset');
	b = await poseOf(P, boxB);
	h.check(near(b.scale, [1, 1, 1]), `1.7 Reset puts the scale back to 1, 1, 1 (${b.scale})`);

	// ---------- 2  per axis ----------
	await rclick(rowOf(P, 'inspector-position').locator('.dn-wrap').nth(1));
	h.check(await menuItem(P, 'Reset to default').isVisible(), '2.0 right-click on the Y box opens the per-value menu');
	await pick(P, 'Copy');
	h.check((await clipText(P)) === '5', `2.1 Copy on Y copies one number (${await clipText(P)})`);
	await rclick(rowOf(P, 'inspector-position').locator('.dn-wrap').nth(0));
	await pick(P, 'Paste');
	b = await poseOf(P, boxB);
	h.check(near(b.pos, [5, 5, 5]), `2.2 Paste on X takes the number (${b.pos})`);
	await setClip(P, '7, 8, 9');
	await rclick(rowOf(P, 'inspector-position').locator('.pr-label'));
	await pick(P, 'Paste Y only');
	b = await poseOf(P, boxB);
	h.check(near(b.pos, [5, 8, 5]), `2.3 Paste Y only takes the vector's Y and leaves X and Z (${b.pos})`);
	await rclick(rowOf(P, 'inspector-position').locator('.dn-wrap').nth(1));
	await pick(P, 'Reset to default');
	b = await poseOf(P, boxB);
	h.check(near(b.pos, [5, 0, 5]), `2.4 Reset on Y puts only Y back to 0 (${b.pos})`);

	// ---------- 3  text a person typed ----------
	for (const [text, want] of /** @type {[string, number[]][]} */ ([
		['1, 2, 3', [1, 2, 3]],
		['Vector3(4,5,6)', [4, 5, 6]],
		['{"transform":{"position":[-1,-2,-3],"rotation":[0,90,0],"scale":[1,1,1]}}', [-1, -2, -3]],
		['[0.5, 1.5, 2.5]', [0.5, 1.5, 2.5]]
	])) {
		await setClip(P, text);
		await rclick(rowOf(P, 'inspector-position').locator('.pr-label'));
		await pick(P, 'Paste vector');
		b = await poseOf(P, boxB);
		h.check(near(b.pos, want), `3.0 Paste vector from ${JSON.stringify(text)} -> ${b.pos}`);
	}
	await setClip(P, '0, 90, 0');
	await rclick(rowOf(P, 'inspector-rotation').locator('.pr-label'));
	await pick(P, 'Paste vector');
	b = await poseOf(P, boxB);
	h.check(Math.abs(b.rot[1] - 1.571) < 0.002, `3.1 a rotation paste reads DEGREES, as the panel shows them (${b.rot})`);
	await rclick(rowOf(P, 'inspector-rotation').locator('.pr-label'));
	await pick(P, 'Copy vector');
	h.check((await clipText(P)) === 'rotation: 0, 90, 0', `3.2 a rotation copies in degrees (${await clipText(P)})`);
	const before3 = await poseOf(P, boxB);
	await setClip(P, '42');
	await rclick(rowOf(P, 'inspector-position').locator('.pr-label'));
	await pick(P, 'Paste vector');
	h.check(near((await poseOf(P, boxB)).pos, before3.pos), '3.3 one number on a vector is REFUSED (nothing moves)');
	const toast3 = await lastToast(P);
	h.check(/Paste refused/.test(toast3) && /x, y, z/.test(toast3), `3.4 the refusal says why (${toast3.slice(0, 120)})`);

	// ---------- 4  hovered Ctrl+C / Ctrl+V ----------
	await select(P, boxA);
	await rowOf(P, 'inspector-position').locator('.pr-label').hover();
	await P.keyboard.press('Control+C');
	await P.waitForTimeout(300);
	h.check((await clipText(P)) === 'position: 1.25, 0, -3', `4.0 Ctrl+C over the Position row copies it (${await clipText(P)})`);
	await select(P, boxB);
	await rowOf(P, 'inspector-position').locator('.pr-label').hover();
	await P.keyboard.press('Control+V');
	await P.waitForTimeout(800);
	b = await poseOf(P, boxB);
	h.check(near(b.pos, [1.25, 0, -3]), `4.1 Ctrl+V over B's Position pastes it (${b.pos})`);

	// ---------- 5  section ----------
	await select(P, boxA);
	const head = P.locator('.sec-panel-head', { hasText: 'Transform' }).first();
	await rclick(head);
	for (const label of ['Copy section', 'Copy as JSON', 'Paste section', 'Reset section'])
		h.check(await menuItem(P, label).isVisible(), `5.0 the section menu offers "${label}"`);
	await pick(P, 'Copy section');
	const sectionText = await clipText(P);
	h.check(
		sectionText === '{"transform":{"position":[1.25,0,-3],"rotation":[0,90,0],"scale":[2,3,4]}}',
		`5.1 Copy section = the JSON block (${sectionText})`
	);
	await select(P, boxB);
	depth = await undoDepth(P);
	await rclick(P.locator('.sec-panel-head', { hasText: 'Transform' }).first());
	await pick(P, 'Paste section');
	b = await poseOf(P, boxB);
	h.check(near(b.pos, [1.25, 0, -3]) && Math.abs(b.rot[1] - 1.571) < 0.002 && near(b.scale, [2, 3, 4]), `5.2 Paste section copies all three (${JSON.stringify(b)})`);
	h.check((await undoDepth(P)) === depth + 1, `5.3 the section paste is ONE undo step (${depth} -> ${await undoDepth(P)})`);
	await undo(P);
	await P.waitForTimeout(300);
	const undone = await poseOf(P, boxB);
	h.check(!near(undone.scale, [2, 3, 4]), `5.4 one undo takes the whole section paste back (${JSON.stringify(undone)})`);
	// the lines form, typed by hand
	await setClip(P, 'transform:\nposition: 3, 2, 1\nscale: 1, 1, 1');
	await rclick(P.locator('.sec-panel-head', { hasText: 'Transform' }).first());
	await pick(P, 'Paste section');
	b = await poseOf(P, boxB);
	h.check(near(b.pos, [3, 2, 1]) && near(b.scale, [1, 1, 1]), `5.5 "name: value" lines paste on the header (${JSON.stringify(b)})`);
	await rclick(P.locator('.sec-panel-head', { hasText: 'Transform' }).first());
	await pick(P, 'Copy as JSON');
	h.check(/\n {2}"transform"/.test(await clipText(P)), '5.6 Copy as JSON is the indented block');

	// ---------- 6  multiselect: paste to all ----------
	const boxC = await makeBox(P, [-6, 0, 0]);
	await setClip(P, sectionText);
	await P.evaluate((ids) => window.__stores.objectActions.applySelectionSet(ids, true), [boxB, boxC]);
	await P.waitForTimeout(600);
	await rclick(P.locator('.sec-panel-head', { hasText: 'Transform' }).first());
	const allItem = menuItem(P, 'Paste to all selected (2)');
	h.check(await allItem.isVisible().catch(() => false), '6.0 with two selected the Transform header offers "Paste to all selected (2)"');
	depth = await undoDepth(P);
	await pick(P, 'Paste to all selected (2)');
	const pb = await poseOf(P, boxB);
	const pc = await poseOf(P, boxC);
	h.check(near(pb.pos, [1.25, 0, -3]) && near(pc.pos, [1.25, 0, -3]) && near(pc.scale, [2, 3, 4]), `6.1 both take the pasted transform (${pb.pos} / ${pc.pos} ${pc.scale})`);
	h.check((await undoDepth(P)) === depth + 1, '6.2 paste to all is ONE undo step');

	// ---------- 7  value rows on their own: slider, toggle, choice, colour; Configure Scene ----------
	await select(P, boxB);
	await P.evaluate(() => localStorage.setItem('inspector:sec:Material', 'open'));
	await select(P, boxB);
	const matB = () =>
		P.evaluate((id) => {
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const m = g.getObjectByProperty('uuid', id).material;
			return { roughness: m.roughness, side: m.side, color: '#' + m.color.getHexString() };
		}, boxB);
	const rough = P.locator('.pr', { has: P.locator('.pr-label', { hasText: /^Roughness$/ }) }).first();
	await setClip(P, '0.25');
	await rclick(rough.locator('.pr-label'));
	h.check(await menuItem(P, 'Reset to default').isVisible(), '7.0 a slider row (Roughness) opens the value menu');
	await pick(P, 'Paste');
	h.check(Math.abs((await matB()).roughness - 0.25) < 1e-6, `7.1 Paste sets Roughness 0.25 (${(await matB()).roughness})`);
	await rclick(rough.locator('.pr-label'));
	await pick(P, 'Copy');
	h.check((await clipText(P)) === '0.25', `7.2 Copy on the row copies the number (${await clipText(P)})`);
	await rclick(rough.locator('.pr-label'));
	await pick(P, 'Reset to default');
	h.check((await matB()).roughness === 1, `7.3 Reset puts Roughness back to its default 1 (${(await matB()).roughness})`);
	// a choice (Side): paste the LABEL a person reads
	const sideLabel = P.locator('span', { hasText: /^Side$/ }).first();
	await setClip(P, 'Double');
	await rclick(sideLabel);
	await pick(P, 'Paste');
	h.check((await matB()).side === 2, `7.4 a choice takes a pasted label ("Double" -> side ${(await matB()).side})`);
	await rclick(sideLabel);
	await pick(P, 'Copy');
	h.check((await clipText(P)) === 'Double', `7.5 a choice copies the label it shows (${await clipText(P)})`);
	// a toggle (Cast shadow)
	const castRow = P.locator('.it', { has: P.locator('#inspector-cast-shadow') });
	const cast = () => P.evaluate((id) => { let g = null; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !!g.getObjectByProperty('uuid', id).castShadow; }, boxB);
	const castBefore = await cast();
	await setClip(P, castBefore ? 'off' : 'on');
	await rclick(castRow);
	await pick(P, 'Paste');
	h.check((await cast()) === !castBefore, `7.6 a toggle takes "on"/"off" (${castBefore} -> ${await cast()})`);
	// a colour (the material picker)
	await setClip(P, 'rgb(255, 0, 0)');
	const matSection = P.locator('.sec-panel', { has: P.locator('.sec-panel-head', { hasText: 'Material' }) }).first();
	await rclick(matSection.locator('[data-field="Color"] input').first());
	h.check(await menuItem(P, 'Paste').isVisible().catch(() => false), '7.7 right-click on the material colour picker opens the field menu');
	await pick(P, 'Paste');
	h.check((await matB()).color === '#ff0000', `7.8 the material colour takes rgb(255, 0, 0) (${(await matB()).color})`);
	// Configure Scene: Exposure
	await P.evaluate(() => window.__stores.openSceneSection('Environment'));
	await P.waitForTimeout(900);
	const exposure = () => P.evaluate(() => new Promise((r) => (window.__stores.environment.environment ?? window.__stores.environment).subscribe((e) => r(e.exposure))()));
	const expRow = P.locator('.pr', { has: P.locator('.pr-label', { hasText: /^Exposure$/ }) }).first();
	await setClip(P, '1.5');
	await rclick(expRow.locator('.pr-label'));
	await pick(P, 'Paste');
	h.check(Math.abs((await exposure()) - 1.5) < 1e-6, `7.9 Configure Scene: Exposure takes a paste (${await exposure()})`);
	await rclick(expRow.locator('.pr-label'));
	await pick(P, 'Reset to default');
	h.check(Math.abs((await exposure()) - 1) < 1e-6, `7.10 Configure Scene: Reset puts Exposure back to 1 (${await exposure()})`);
	const envHead = P.locator('.sec-panel-head', { hasText: 'Environment' }).first();
	await rclick(envHead);
	await pick(P, 'Copy section');
	const envText = await clipText(P);
	h.check(/^\{"environment":\{/.test(envText) && /"exposure":1/.test(envText), `7.11 Configure Scene sections copy too (${envText.slice(0, 90)})`);

	// a raw colour swatch in a sub-panel (the Water panel draws its own <input type="color">,
	// no clipboard code of its own) answers through the Inspector root's native fallback
	await P.evaluate((id) => {
		const st = window.__stores;
		const key = st.waterPresets.WATER_PRESETS[0].key;
		st.waterActions.setObjectWater(id, st.waterPresets.waterPreset(key, { shape: 'box' }), { immediate: true });
		localStorage.setItem('inspector:sec:Water', 'open');
	}, boxC);
	await select(P, boxC);
	const swatch = P.locator('#inspector input[aria-label="Shallow colour"]').first();
	h.check((await swatch.count()) > 0, '7.12 fixture: the Water panel shows its Shallow colour swatch');
	if (await swatch.count()) {
		await rclick(swatch);
		await pick(P, 'Copy');
		h.check((await clipText(P)) === (await swatch.inputValue()), `7.13 a raw sub-panel swatch copies its colour (${await clipText(P)})`);
		await setClip(P, '#123456');
		await rclick(swatch);
		await pick(P, 'Paste');
		const shallow = await P.evaluate((id) => {
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', id).userData.water?.look?.shallowColor;
		}, boxC);
		h.check(shallow === '#123456', `7.14 a paste reaches the water's look through the swatch's own handler (${shallow})`);
	}

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ').slice(0, 200)})`);
	await A.ctx.close();

	// ---------- 8  phone: long press (OPPO Find N6 folded, real touch events) ----------
	const F = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9, ...CTX },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const Q = F.page;
	const cdp = await Q.context().newCDPSession(Q);
	/** @param {number} x @param {number} y @param {number} ms */
	const press = async (x, y, ms) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		await new Promise((r) => setTimeout(r, ms));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	const centre = async (/** @type {any} */ loc) => {
		await loc.scrollIntoViewIfNeeded();
		const r = await loc.boundingBox();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	};
	const qA = await makeBox(Q, [2, 1, 0]);
	const qB = await makeBox(Q, [-2, 4, 0]);
	await select(Q, qA);
	const qPosRow = rowOf(Q, 'inspector-position');
	h.check(await qPosRow.isVisible().catch(() => false), '8.0 phone: the Properties Transform rows are on screen');
	let c = await centre(qPosRow.locator('.pr-label'));
	await press(c.x, c.y, 750);
	await Q.waitForTimeout(300);
	h.check(await menuItem(Q, 'Copy vector').isVisible().catch(() => false), '8.1 phone: a LONG PRESS on Position opens the vector menu');
	c = await centre(menuItem(Q, 'Copy vector'));
	await press(c.x, c.y, 60);
	await Q.waitForTimeout(500);
	await select(Q, qB);
	c = await centre(rowOf(Q, 'inspector-position').locator('.pr-label'));
	await press(c.x, c.y, 750);
	await Q.waitForTimeout(300);
	c = await centre(menuItem(Q, 'Paste vector'));
	await press(c.x, c.y, 60);
	await Q.waitForTimeout(900);
	const qb = await poseOf(Q, qB);
	h.check(near(qb.pos, [2, 1, 0]), `8.2 phone: Paste vector from the long-press menu (${qb.pos})`);
	// a long press on a value BOX opens the per-value menu and its release does not start typing
	c = await centre(rowOf(Q, 'inspector-position').locator('.dn-wrap').nth(0));
	await press(c.x, c.y, 750);
	await Q.waitForTimeout(300);
	h.check(await menuItem(Q, 'Reset to default').isVisible().catch(() => false), '8.3 phone: a long press on the X box opens the per-value menu');
	const focusedInput = await Q.evaluate(() => document.activeElement?.classList?.contains('dn-input') ?? false);
	h.check(!focusedInput, '8.4 phone: the release that ends the long press does NOT focus the field (no keyboard)');
	// a short tap still types (the long press did not break the field)
	await Q.keyboard.press('Escape');
	await Q.evaluate(() => window.__stores.fieldMenu.fieldMenu.set(null));
	await Q.waitForTimeout(300);
	c = await centre(rowOf(Q, 'inspector-position').locator('.dn-wrap').nth(0));
	await press(c.x, c.y, 60);
	await Q.waitForTimeout(400);
	h.check(await Q.evaluate(() => document.activeElement?.classList?.contains('dn-input') ?? false), '8.5 phone: a short tap on the box still starts typing');
	// 8.6/8.7 a slow drag is a drag, not a long press (98-int)
	await Q.keyboard.press('Escape');
	await Q.evaluate(() => window.__stores.fieldMenu.fieldMenu.set(null));
	await Q.waitForTimeout(300);
	/** @param {number} x @param {number} y @param {number} dx total px over 900 ms */
	const slowDrag = async (x, y, dx) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		for (let i = 1; i <= 9; i++) {
			await new Promise((r) => setTimeout(r, 100));
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 9, y, id: 1 }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	const fieldMenuUp = () => Q.evaluate(() => {
		/** @type {any} */ let m;
		window.__stores.fieldMenu.fieldMenu.subscribe((v) => (m = v))();
		return !!m;
	});
	const range = Q.locator('input[type="range"]:visible').first();
	if (await range.count()) {
		c = await centre(range);
		await slowDrag(c.x, c.y, 8);
		await Q.waitForTimeout(300);
		h.check(!(await fieldMenuUp()), '8.6 phone: a slow 0.9 s drag on a slider does NOT open the field menu');
	} else h.check(false, '8.6 phone: no slider on screen to drag');
	await Q.evaluate(() => window.__stores.fieldMenu.fieldMenu.set(null));
	// a real slow scrub (30 px in 0.9 s) on a value box still scrubs and opens nothing (a guard: a hold under
	// Chrome's own touch slop IS a long press there, and opening the menu is right)
	await Q.keyboard.press('Escape');
	await Q.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
	const x0 = (await poseOf(Q, qB)).pos[0];
	c = await centre(rowOf(Q, 'inspector-position').locator('.dn-wrap').nth(0));
	await slowDrag(c.x, c.y, 30);
	await Q.waitForTimeout(400);
	const x1 = (await poseOf(Q, qB)).pos[0];
	h.check(!(await fieldMenuUp()) && x1 !== x0, `8.7 phone: a slow 30 px scrub on a value box scrubs (${x0} -> ${x1}) and opens no menu`);
	await Q.evaluate(() => window.__stores.fieldMenu.fieldMenu.set(null));
	h.check(h.pageErrors(F).length === 0, `phone: no page errors (${h.pageErrors(F).join(' | ').slice(0, 200)})`);
	await F.ctx.close();
	await h.finish(browser);
});
