// 53 A3 — FULL KEYBOARD NAVIGATION: a keyboard-only walk through the editor. No mouse anywhere
// until the last section (which proves the canvas still owns Tab as Edit Mesh after a press on it).
//   1. a fresh load: Tab leaves <body> (on v1.39.0 the global Tab = Enter Edit Mesh swallowed EVERY
//      press, so focus never moved — the counterfactual), the first stop is the skip link, the
//      order reads top bar -> toolbar, and every stop wears a visible ring
//   2. the toolbar is ONE tab stop with arrows / Home / End between its cells (roving tabindex)
//   3. the skip link focuses the viewport and Escape leaves it (no keyboard trap in the canvas)
//   4. create an object: the "+" corner button -> Add > Mesh > Cube, all by keys
//   5. the object list from the toolbar, its tree (Enter = Properties) and an Inspector edit
//      (Tab to Position X, type, Enter — the field is left, the row keeps the keyboard's place)
//   6. save: Ctrl+S names the scene in the Explorer's inline field, Enter saves it
//   7. a dialog: Settings from the main menu traps Tab, Escape closes it, focus goes back to the menu
//   8. the keymap still works: digits arm the gizmo, Tab past the last control never edits a mesh,
//      F6 cycles regions, and Tab after a press on the canvas still enters Edit Mesh
// Run: APP_URL=https://theprototype.app:5473/ node tests/e2e/keyboard-walk.test.cjs
const h = require('./helpers.cjs');

const active = (page) =>
	page.evaluate(() => {
		const e = /** @type {HTMLElement | null} */ (document.activeElement);
		if (!e) return { tag: 'none' };
		const cs = getComputedStyle(e);
		return {
			tag: e.tagName.toLowerCase(),
			id: e.id,
			title: e.getAttribute('title') || e.getAttribute('aria-label') || '',
			aria: e.getAttribute('aria-label') || '',
			body: e === document.body,
			ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
			inToolbar: !!e.closest('#controls-pill'),
			inDialog: !!e.closest('dialog'),
			inInspector: !!e.closest('#inspector'),
			inPosition: !!e.closest('#inspector-position'),
			cls: String(e.className || '')
		};
	});
const store = (page, name) => page.evaluate((n) => new Promise((r) => window.__stores[n].subscribe(r)()), name);
const press = async (page, key, times = 1) => {
	for (let i = 0; i < times; i++) {
		await page.keyboard.press(key);
		await page.waitForTimeout(110);
	}
};
/** Tab until `want(active)` — returns the presses it took, or -1 */
const tabUntil = async (page, want, max = 40, key = 'Tab') => {
	for (let i = 1; i <= max; i++) {
		await press(page, key);
		if (want(await active(page))) return i;
	}
	return -1;
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	// ---- 1. a fresh load: Tab moves, in reading order, with a ring
	h.check((await active(page)).body, 'premise: a fresh load has focus on <body>');
	await press(page, 'Tab');
	let a = await active(page);
	h.check(!a.body, `Tab leaves <body> on a fresh load (COUNTERFACTUAL: v1.39.0 kept every press: ${a.tag}#${a.id})`);
	h.check(a.id === 'skip-to-viewport', `the first stop is the skip link (${a.tag}#${a.id})`);
	h.check(a.ring, 'the skip link wears the focus ring');
	await press(page, 'Tab');
	a = await active(page);
	h.check(a.id === 'logo-menu', `then the main menu button, top-left (${a.tag}#${a.id})`);
	/** @type {string[]} */
	const order = [];
	let ringless = [];
	// walk until the toolbar, then a few stops past it (a cloud build has more top-bar stops: rooms,
	// sign-in; since fix-batch-1 #23 the profile panel no longer opens on focus) — no fixed window
	let afterToolbar = -1;
	for (let i = 0; i < 40 && afterToolbar < 6; i++) {
		await press(page, 'Tab');
		a = await active(page);
		if (a.body) break;
		order.push(a.inToolbar ? 'toolbar' : a.id || a.title.slice(0, 18));
		if (afterToolbar >= 0 || a.inToolbar) afterToolbar++;
		if (!a.ring && a.tag !== 'input') ringless.push(`${a.tag}#${a.id}`);
	}
	const firstToolbar = order.indexOf('toolbar');
	h.check(firstToolbar > 0 && order.indexOf('notes-toggle') >= 0 && order.indexOf('notes-toggle') < firstToolbar, `the top bar comes before the toolbar (${order.join(' > ')})`);
	h.check(order.filter((x) => x === 'toolbar').length === 1, 'the toolbar is ONE tab stop');
	h.check(ringless.length === 0, `every control Tab reached wears a visible ring (${ringless.join(', ') || 'all'})`);

	// ---- 2. roving tabindex in the toolbar
	await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#controls-pill [tabindex="0"]'))?.focus());
	const first = (await active(page)).title;
	await press(page, 'ArrowRight');
	const second = (await active(page)).title;
	h.check(second && second !== first && (await active(page)).inToolbar, `→ moves to the next cell (${first} -> ${second})`);
	await press(page, 'End');
	const last = await active(page);
	await press(page, 'Home');
	h.check((await active(page)).title === first && last.title !== first, `Home / End reach the ends (${first} … ${last.title})`);
	h.check((await page.evaluate(() => document.querySelectorAll('#controls-pill [tabindex="0"]').length)) === 1, 'exactly one cell carries tabindex 0');
	const mode = () => page.evaluate(() => new Promise((r) => window.__stores.TControls.subscribe((c) => r(c?.mode))()));
	await press(page, 'Home');
	await press(page, 'ArrowRight'); // Rotate (2)
	await press(page, 'Enter');
	h.check((await mode()) === 'rotate', `Enter presses a <p> cell: Rotate is armed (${await mode()})`);
	await press(page, 'Home');
	await press(page, 'Enter'); // back to Move

	// ---- 3. the skip link and Escape out of the viewport
	await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('skip-to-viewport')).focus());
	await press(page, 'Enter');
	a = await active(page);
	h.check(a.id === 'viewport', `the skip link puts the keyboard in the 3D viewport (${a.tag}#${a.id})`);
	await press(page, 'Escape');
	await page.waitForTimeout(150);
	a = await active(page);
	h.check(a.id !== 'viewport' && !a.body, `Escape leaves the viewport — no keyboard trap (${a.tag}#${a.id})`);

	// ---- 4. create an object from the "+" button, keys only
	const plus = await tabUntil(page, (x) => x.id === 'mobile-add-button', 40);
	h.check(plus > 0, `Tab reaches the "+" corner button (${plus} presses)`);
	await press(page, 'Enter');
	await page.waitForTimeout(300);
	h.check(await page.evaluate(() => !!document.querySelector('.ctx-scroll[role=menu]')), 'Enter opens the add menu');
	const hl = () => page.evaluate(() => [...document.querySelectorAll('.ctx-scroll .ctx-active')].map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ')).pop() ?? '');
	await press(page, 'ArrowDown');
	await press(page, 'ArrowRight'); // Add >
	await press(page, 'ArrowRight'); // Mesh >
	let pick = await hl();
	for (let i = 0; i < 20 && !/^(Cube|Box)\b/.test(pick); i++) {
		await press(page, 'ArrowDown');
		pick = await hl();
	}
	h.check(/^(Cube|Box)\b/.test(pick), `arrows walk Add > Mesh to a cube (${pick})`);
	const before = await page.evaluate(() => window.__stores.objectsGroup && new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children?.length ?? 0))()));
	await press(page, 'Enter');
	await page.waitForTimeout(1200);
	const after = await page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children?.length ?? 0))()));
	const selected = /** @type {string[]} */ (await store(page, 'selectedObjects'));
	h.check(after === before + 1 && selected.length === 1, `Enter creates the cube and selects it (${before} -> ${after}, selected ${selected.length})`);
	a = await active(page);
	h.check(a.id === 'mobile-add-button', `closing the menu hands focus back to the "+" button (${a.tag}#${a.id})`);

	// ---- 5. the object list, its tree, and an Inspector edit
	await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#controls-pill [tabindex="0"]'))?.focus());
	let cell = await tabUntil(page, (x) => /Object list/.test(x.title), 16, 'ArrowRight');
	h.check(cell > 0, 'arrows reach the Object list cell');
	await press(page, 'Enter');
	await page.waitForTimeout(500);
	const tree = await tabUntil(page, (x) => x.id === 'object-tree', 30);
	h.check(tree > 0, `Tab reaches the object tree (${tree} presses)`);
	await press(page, 'Enter');
	await page.waitForTimeout(800);
	h.check((await store(page, 'inspectorClose')) === false, 'Enter on the tree opens Properties');
	const toX = await tabUntil(page, (x) => x.inPosition, 80);
	h.check(toX > 0, `Tab reaches Inspector ▸ Position X (${toX} presses)`);
	await page.keyboard.press('Control+a');
	await page.keyboard.type('2.5');
	await press(page, 'Enter');
	await page.waitForTimeout(300);
	const x = await page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.position?.x))()));
	h.check(Math.abs(Number(x) - 2.5) < 1e-6, `typing 2.5 + Enter moves the cube (x = ${x})`);
	a = await active(page);
	h.check(a.tag !== 'input', `Enter leaves the field (the locked DragRow behaviour: ${a.tag})`);
	await press(page, 'Tab');
	a = await active(page);
	h.check(a.inPosition && a.tag === 'input' && a.aria === 'Y', `the next Tab goes on to Position Y, not to Edit Mesh or the top of the page (${a.tag} ${a.aria})`);
	h.check(!(await page.evaluate(() => new Promise((r) => window.__stores.meshEdit.editingObject.subscribe(r)()))), '…and did not enter Edit Mesh on the selection');

	// ---- 6. save with Ctrl+S, named inline
	await page.keyboard.press('Escape'); // leave the field
	await page.keyboard.press('Control+s');
	await h.eventually(() => active(page), (v) => v.tag === 'input' && /ex-edit/.test(v.cls), 'the Explorer naming field takes the keyboard', 15000);
	a = await active(page);
	h.check(a.tag === 'input' && /ex-edit/.test(a.cls), 'Ctrl+S on an unnamed scene asks for its name in the Explorer, focused');
	await page.keyboard.press('Control+a');
	await page.keyboard.type('Keyboard walk');
	await press(page, 'Enter');
	const level = () => page.evaluate(() => new Promise((r) => window.__stores.levels.currentLevel.subscribe((v) => r(v?.name ?? null))()));
	await h.eventually(level, (v) => v === 'Keyboard walk', 'the scene took its name', 10000);
	h.check((await level()) === 'Keyboard walk', `the open scene is now "Keyboard walk" (${await level()})`);
	const saved = await page.evaluate(() => new Promise((r) => window.__stores.explorer.explorerItems.subscribe((items) => r((items || []).filter((i) => i.kind === 'scene').map((i) => i.name)))()));
	h.check(Array.isArray(saved) && saved.some((n) => /Keyboard walk/.test(n)), `Enter saves the scene into the library (${JSON.stringify(saved)})`);

	// ---- 7. a dialog: trap, Escape, focus return
	await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('logo-menu')).focus());
	await press(page, 'Enter');
	let found = false;
	for (let i = 0; i < 45 && !found; i++) {
		await press(page, 'Tab');
		found = await page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Settings');
	}
	h.check(found, 'Tab walks into the main menu down to Settings');
	await press(page, 'Enter');
	await page.waitForTimeout(700);
	h.check((await active(page)).inDialog, 'Settings opens with the keyboard inside it');
	let escaped = 0;
	for (let i = 0; i < 70; i++) {
		await page.keyboard.press(i % 9 === 8 ? 'Shift+Tab' : 'Tab');
		if (!(await active(page)).inDialog) escaped++;
	}
	h.check(escaped === 0, `Tab never leaves the open dialog (${escaped} of 70 presses escaped)`);
	await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#settings-search'))?.focus());
	await press(page, 'Escape');
	await page.waitForTimeout(500);
	h.check(!(await store(page, 'settingsOpen')), 'Escape closes Settings');
	a = await active(page);
	h.check(a.id === 'logo-menu', `closing hands focus back to the main menu button (${a.tag}#${a.id})`);

	// ---- 8. the keymap is untouched
	await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : 0));
	await press(page, '2');
	h.check((await mode()) === 'rotate', `the 2 key still arms Rotate (${await mode()})`);
	await press(page, '1');
	// the LAST control in the document (the open Explorer, Inspector and object list add many)
	await page.evaluate(() => {
		const all = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')]).filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
		all[all.length - 1]?.focus();
	});
	let wrapped = false;
	for (let i = 0; i < 4 && !wrapped; i++) {
		await press(page, 'Tab');
		wrapped = (await active(page)).id === 'skip-to-viewport';
	}
	h.check(wrapped, 'with an object selected, Tab past the last control wraps round to the skip link');
	h.check(!(await page.evaluate(() => new Promise((r) => window.__stores.meshEdit.editingObject.subscribe(r)()))), '…and never entered Edit Mesh on the way (a keyboard trap on <body>)');
	const regions = [];
	for (let i = 0; i < 4; i++) {
		await press(page, 'F6');
		regions.push((await active(page)).id || (await active(page)).title.slice(0, 12));
	}
	h.check(new Set(regions).size === 4, `F6 cycles regions (${regions.join(' > ')})`);
	// a press on the canvas, then Tab: the Edit Mesh shortcut is still the canvas's
	const cube = selected[0];
	const pt = await page.evaluate((u) => {
		let o;
		window.__stores.objectsGroup.subscribe((g) => (o = g.children.find((c) => c.uuid === u)))();
		const p = o.getWorldPosition(new o.position.constructor());
		return [p.x, p.y, p.z];
	}, cube);
	const px = await h.projectPoint(page, pt);
	await page.mouse.click(px.x, px.y);
	await page.waitForTimeout(400);
	await press(page, 'Tab');
	await page.waitForTimeout(300);
	const editing = await page.evaluate(() => new Promise((r) => window.__stores.meshEdit.editingObject.subscribe(r)()));
	h.check(editing === cube, `after a press on the canvas, Tab still enters Edit Mesh on the selection (${editing ? 'editing' : 'nothing'})`);
	await press(page, 'Escape');

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ').slice(0, 200)})`);
	await h.finish(browser);
});
