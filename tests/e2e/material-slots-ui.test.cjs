// 105-slots phase 2 — the UI of material slots, through the real controls:
//   U1  Inspector ▸ Material exists for a slot list (it was missing) and every row reads / writes the ACTIVE slot
//   U2  the eye switches a slot off and on (one undo step each)
//   U3  the ⋯ menu: Rename, Duplicate, Move up / down, Remove… (asks where the faces go), Select its faces,
//       Assign selected faces — each one undo step
//   U4  "Add material slot" in the Material section's own ⋯ menu on a single-material object
//   U5  Switch material…: a preset swatch, a look from the scene (both COPY into the slot, the id stays), and the
//       CC0 library opened on materials with "Apply to <slot>" (the target store; no network in this suite)
//   U6  the UV editor's Materials pane is the same list (its image / assign buttons kept, ids unchanged)
//   U7  a11y: every row control has a name, Tab reaches them, the arrows move between rows, the menu key opens it
//   U8  the agent: list_materials rows carry id / name / off; set_material by slot id and by name, slotName,
//       slotOff, removeSlot
//   U9  touch (Find N6 folded 390 x 896, unfolded 691 x 634, a touch page): rows and the eye / ⋯ are 44 px,
//       a long press opens the menu, nothing overflows sideways; screenshots
//   U10 dark + light screenshots of the list (evidence)
// Shots: $OUT or ~/.code/lanes-30/105-slots/shots. Counterfactual: on the base, U1 is red (no Material section).
const os = require('os');
const path = require('path');
const fs = require('fs');
const h = require('./helpers.cjs');

const OUT = process.env.OUT || path.join(os.homedir(), '.code/lanes-30/105-slots/shots');
const NAME = 'SlotUiBox';

/** the box: a 3-slot box with red / green / blue, four triangles each @param {any} page */
async function makeBox(page) {
	return page.evaluate(async (name) => {
		const w = window.__tp.test.v1;
		const g0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(g0.children.map((/** @type {any} */ c) => c.uuid));
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		for (let i = 0; i < 50; i++) {
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const box = g.children.find((/** @type {any} */ c) => c.isMesh && !before.has(c.uuid));
			if (box) {
				box.name = name;
				box.position.set(0, 0.5, 0);
				box.rotation.set(0.5, 0.6, 0);
				const M = w.materialsHandler;
				M.addMaterialSlot(box.uuid);
				M.addMaterialSlot(box.uuid);
				M.setObjectMaterials(box.uuid, M.materialsOf(box), [
					{ start: 0, count: 12, materialIndex: 0 },
					{ start: 12, count: 12, materialIndex: 1 },
					{ start: 24, count: 12, materialIndex: 2 }
				]);
				['#ff0000', '#00ff00', '#0000ff'].forEach((hex, i) =>
					M.setObjectColor(box.uuid, hex, true, i)
				);
				M.switchMaterialType(box.uuid, 'MeshPhongMaterial', true, 2);
				return box.uuid;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		return '';
	}, NAME);
}

/** the slots of the box @param {any} page @param {string} [name] */
const slots = (page, name = NAME) =>
	page.evaluate(async (name) => {
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		/** @type {any} */ let o = null;
		g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === name ? n : null));
		if (!o) return null;
		const own = w.materialsHandler.materialsOf(o);
		const list = w.materialSlots?.slotsOf ? w.materialSlots.slotsOf(o) : [];
		/** @type {any} */ let active = 0;
		w.slotDraw?.activeMaterialSlot?.subscribe((/** @type {any} */ v) => (active = v))();
		return {
			n: own.length,
			ids: list.map((/** @type {any} */ s) => s.id),
			names: list.map((/** @type {any} */ s) => s.name),
			faces: list.map((/** @type {any} */ s) => s.faces),
			off: list.map((/** @type {any} */ s) => s.off),
			kinds: list.map((/** @type {any} */ s) => s.kind),
			colors: own.map((/** @type {any} */ m) => '#' + m.color?.getHexString?.()),
			types: own.map((/** @type {any} */ m) => m.type),
			active
		};
	}, name);

/** open the Inspector on the box @param {any} page @param {string} uuid */
async function inspect(page, uuid) {
	await page.evaluate((id) => {
		window.__tp.test.v1.inspectorClose.set(false);
		window.__tp.test.v1.objectActions.selectObject(id);
	}, uuid);
	await page
		.waitForSelector('#select-material', { timeout: 20000, state: 'attached' })
		.catch(() => {});
}

/** click a row's ⋯ and a menu item by its test id @param {any} page @param {number} i @param {string} item */
async function menu(page, i, item, prefix = 'ins-slot') {
	await page.locator('#' + prefix + '-more-' + i).click();
	await page.locator('[data-testid="' + prefix + '-menu-' + item + '"]').click();
	await page.waitForTimeout(250);
}

const undo = (/** @type {any} */ page) => page.evaluate(() => window.__tp.test.v1.history.undo());
/** close the shared menu: Escape (it reaches the menu when its filter holds focus), else through its store, so the
 * menu's backdrop never swallows the next click @param {any} page */
async function closeMenu(page) {
	const focus = await page.evaluate(() =>
		document.activeElement
			? document.activeElement.tagName +
				'.' +
				(document.activeElement.className || '').toString().slice(0, 40)
			: 'none'
	);
	console.log('  closeMenu: focus before Escape = ' + focus);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(150);
	const open = await page.locator('[role="menu"]').count();
	if (open)
		await page.evaluate(async () => (await import('/src/lib/fieldMenu.js')).fieldMenu.set(null));
	await page.waitForTimeout(150);
	return open === 0;
}
const same = (/** @type {any} */ a, /** @type {any} */ b) =>
	JSON.stringify(a) === JSON.stringify(b);

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 800 } }
	});
	await h.answerRestore(A);
	const page = A.page;
	const uuid = await makeBox(page);
	h.check(!!uuid, '0 premise: a 3-slot box');
	await inspect(page, uuid);

	// ---- U1 --------------------------------------------------------------------------------------------------------
	const hasSection = (await page.locator('#select-material').count()) > 0;
	h.check(
		hasSection,
		'U1.1 Inspector ▸ Material shows for an object with 3 slots (it was missing)'
	);
	if (!hasSection) return h.finish(browser);
	await page.waitForSelector('#ins-slot-list', { timeout: 15000 }).catch(() => {});
	h.check(
		(await page.locator('#ins-slot-list > li.slot-row').count()) === 3,
		'U1.2 the slot list has a row per slot'
	);
	const typeLabel = () => page.locator('#select-material .ts-label').innerText();
	await page.locator('#ins-slot-row-2 .slot-main').click();
	await page.waitForTimeout(300);
	h.check((await slots(page))?.active === 2, 'U1.3 tapping a row makes it the active slot');
	h.check(
		/phong/i.test(await typeLabel()),
		'U1.4 the type row reads the ACTIVE slot (slot 3 is Phong): ' + (await typeLabel())
	);
	await page.locator('#ins-slot-row-0 .slot-main').click();
	await page.waitForTimeout(300);
	h.check(
		/standard/i.test(await typeLabel()),
		'U1.5 …and slot 1 again (Standard): ' + (await typeLabel())
	);
	await page.locator('#ins-slot-row-1 .slot-main').click();
	await page.locator('#select-material').click();
	await page.locator('li[role="option"]', { hasText: 'Lambert' }).click();
	await page.waitForTimeout(400);
	let s = await slots(page);
	h.check(
		!!s &&
			same(s.types, ['MeshStandardMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial']) &&
			s.colors[1] === '#00ff00',
		'U1.6 the type row WRITES the active slot only (slot 2 -> Lambert, colour kept): ' +
			JSON.stringify(s?.types)
	);
	await undo(page);
	h.check((await slots(page))?.types[1] === 'MeshStandardMaterial', 'U1.7 one undo step');
	const flash = await page.evaluate(async () => {
		const m = await import('/src/lib/slotFlash.js').catch(() => null);
		return m ? m.slotFlashDebug() : null;
	});
	console.log('U1 flash after the last tap: ' + JSON.stringify(flash));

	// ---- U2 the eye ------------------------------------------------------------------------------------------------
	await page.locator('#ins-slot-eye-1').click();
	await page.waitForTimeout(300);
	s = await slots(page);
	h.check(
		!!s && s.off[1] && s.kinds[1] === 'off',
		'U2.1 the eye switches slot 2 off (it draws the plain default)'
	);
	h.check(
		(await page.locator('#ins-slot-row-1 .slot-badge-off').count()) === 1,
		'U2.2 its row shows the "Off" badge'
	);
	h.check(
		(await page.locator('#ins-slot-eye-1').getAttribute('aria-pressed')) === 'false',
		'U2.3 the eye says it is not shown (aria-pressed false)'
	);
	await page.locator('#ins-slot-eye-1').click();
	await page.waitForTimeout(300);
	h.check((await slots(page))?.off[1] === false, 'U2.4 and on again');
	await undo(page);
	h.check((await slots(page))?.off[1] === true, 'U2.5 undo of "on" = off again (one step)');
	await undo(page);
	h.check((await slots(page))?.off[1] === false, 'U2.6 undo of "off" = on');

	// ---- U3 the ⋯ menu ----------------------------------------------------------------------------------------------
	const s0 = await slots(page);
	await menu(page, 1, 'rename');
	const input = page.locator('#ins-slot-rename-1');
	h.check((await input.count()) === 1, 'U3.1 Rename turns the name into a field');
	await input.fill('Glass');
	await input.press('Enter');
	await page.waitForTimeout(300);
	s = await slots(page);
	h.check(
		s?.names[1] === 'Glass' && s.ids[1] === s0.ids[1],
		'U3.2 the slot is renamed, its id kept: ' + JSON.stringify(s?.names)
	);
	h.check(
		(await page.locator('#ins-slot-row-1 .slot-name').innerText()) === 'Glass',
		'U3.3 the row shows the new name'
	);
	await menu(page, 1, 'duplicate');
	s = await slots(page);
	h.check(
		s?.n === 4 && s.names[2] === 'Glass copy' && s.faces[2] === 0,
		'U3.4 Duplicate puts a copy right after it, with no faces: ' + JSON.stringify(s?.names)
	);
	await undo(page);
	await menu(page, 0, 'down');
	s = await slots(page);
	h.check(
		s?.ids[1] === s0.ids[0] && s.ids[0] === s0.ids[1],
		'U3.5 Move down swaps it with the next slot'
	);
	await undo(page);
	h.check(same((await slots(page))?.ids, s0.ids), 'U3.6 undo of the move');
	const up0 = await page.locator('[data-testid="ins-slot-menu-up"]').count();
	await page.locator('#ins-slot-more-0').click();
	const upDisabled = await page
		.locator('[data-testid="ins-slot-menu-up"]')
		.getAttribute('aria-disabled');
	h.check(await closeMenu(page), 'U3.7b Escape closes the menu opened with a click on ⋯');
	h.check(
		up0 === 0 && upDisabled === 'true',
		'U3.7 the first slot cannot move up (the item is disabled)'
	);
	await menu(page, 1, 'remove');
	const ask = page.locator('#ins-slot-remove-ask');
	h.check(
		(await ask.count()) === 1 && /Move its 4 faces to/.test(await ask.innerText()),
		'U3.8 Remove… on a slot with faces asks where they go'
	);
	await page.locator('#ins-slot-remove-to').selectOption({ label: 'slot2' });
	await page.locator('#ins-slot-remove-confirm').click();
	await page.waitForTimeout(400);
	s = await slots(page);
	h.check(
		s?.n === 2 && same(s.faces, [4, 8]),
		'U3.9 removed; its faces went to the slot picked: ' + JSON.stringify(s?.faces)
	);
	await undo(page);
	h.check((await slots(page))?.n === 3, 'U3.10 one undo step brings it back');
	await menu(page, 2, 'select');
	await page.waitForTimeout(800);
	const picked = await page.evaluate(async () => {
		const f = await import('/src/lib/faceEdit.js');
		/** @type {any} */ let sel = [];
		f.faceEditSelectedTris.subscribe((/** @type {any} */ v) => (sel = v))();
		/** @type {any} */ let obj = null;
		f.faceEditObject.subscribe((/** @type {any} */ v) => (obj = v))();
		return { n: sel.length, obj };
	});
	h.check(
		picked.obj === uuid && picked.n === 4,
		"U3.11 Select its faces opens Edit Mesh with that slot's 4 triangles picked: " +
			JSON.stringify(picked)
	);
	await menu(page, 0, 'assign');
	s = await slots(page);
	h.check(
		!!s && same(s.faces, [8, 4, 0]),
		'U3.12 Assign selected faces moves the picked faces to that slot: ' + JSON.stringify(s?.faces)
	);
	// leave Edit Mesh first: the session folds into ONE undo entry when it ends (editSession.js)
	await page.evaluate(async () => (await import('/src/lib/faceEdit.js')).exitFaceEdit());
	await page.waitForTimeout(500);
	await undo(page);
	await page.waitForTimeout(400);
	h.check(same((await slots(page))?.faces, [4, 4, 4]), 'U3.13 undo of the assignment');

	// ---- U4 Add slot from the section ⋯ ----------------------------------------------------------------------------
	const single = await page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const g0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(g0.children.map((/** @type {any} */ c) => c.uuid));
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		for (let i = 0; i < 50; i++) {
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const o = g.children.find((/** @type {any} */ c) => c.isMesh && !before.has(c.uuid));
			if (o) {
				o.name = 'SlotUiBall';
				o.position.set(2, 0.5, 0);
				return o.uuid;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		return '';
	});
	await inspect(page, single);
	h.check(
		(await page.locator('#ins-slot-list').count()) === 0,
		'U4.1 a single-material object shows no slot list'
	);
	await page.locator('[data-section-menu="Material"]').click();
	await page.locator('[data-testid="material-add-slot"]').click();
	await page.waitForTimeout(500);
	h.check(
		(await slots(page, 'SlotUiBall'))?.n === 2,
		"U4.2 the Material section's ⋯ > Add material slot makes it two slots"
	);
	await page.waitForSelector('#ins-slot-list', { timeout: 10000 }).catch(() => {});
	h.check(
		(await page.locator('#ins-slot-list > li.slot-row').count()) === 2,
		'U4.3 and the list appears'
	);
	await undo(page);
	await inspect(page, uuid);
	await page.waitForSelector('#ins-slot-list', { timeout: 10000 }).catch(() => {});

	// ---- U5 Switch material… ----------------------------------------------------------------------------------------
	const beforeSwitch = await slots(page);
	await menu(page, 1, 'switch');
	h.check(
		(await page.locator('#slot-switch').count()) === 1,
		'U5.1 Switch material… opens its popover (exactly one)'
	);
	await page.locator('#slot-switch [data-switch-preset="Wood"]').click();
	await page.waitForTimeout(500);
	s = await slots(page);
	h.check(
		!!s &&
			s.colors[1] !== '#00ff00' &&
			s.ids[1] === beforeSwitch.ids[1] &&
			s.colors[0] === '#ff0000',
		'U5.2 a preset swatch copies into that slot only; its id stays: ' + JSON.stringify(s?.colors)
	);
	h.check(
		(await page.locator('#slot-switch').count()) === 0,
		'U5.2b the popover is gone after a pick'
	);
	await undo(page);
	await menu(page, 1, 'switch');
	const sceneItem = page.locator('#slot-switch [data-switch-scene="' + uuid + ':2"]');
	h.check(
		(await sceneItem.count()) === 1,
		'U5.3 "In this scene" lists the other slots by object and slot name'
	);
	await sceneItem.click();
	await page.waitForTimeout(500);
	s = await slots(page);
	h.check(
		!!s &&
			s.colors[1] === '#0000ff' &&
			s.types[1] === 'MeshPhongMaterial' &&
			s.ids[1] === beforeSwitch.ids[1],
		'U5.4 a look from the scene is copied into the slot (id kept): ' +
			JSON.stringify({ c: s?.colors, t: s?.types })
	);
	await undo(page);
	await menu(page, 1, 'switch');
	await page.locator('#slot-switch-cc0').click();
	await page.waitForTimeout(800);
	const target = await page.evaluate(async () => {
		const st = await import('/src/lib/cc0/assetBrowserState.js');
		/** @type {any} */ let t = null,
			open = false,
			kind = '';
		st.assetBrowserTarget.subscribe((/** @type {any} */ v) => (t = v))();
		st.assetBrowserOpen.subscribe((/** @type {any} */ v) => (open = v))();
		st.assetBrowserKind.subscribe((/** @type {any} */ v) => (kind = v))();
		return { t, open, kind };
	});
	h.check(
		target.open && target.kind === 'materials' && target.t?.uuid === uuid && target.t?.slot === 1,
		'U5.5 the CC0 library opens on materials, aimed at that slot: ' + JSON.stringify(target)
	);
	await page.evaluate(async () =>
		(await import('/src/lib/cc0/assetBrowserState.js')).assetBrowserOpen.set(false)
	);
	const cleared = await page.evaluate(async () => {
		const st = await import('/src/lib/cc0/assetBrowserState.js');
		/** @type {any} */ let t = 1;
		st.assetBrowserTarget.subscribe((/** @type {any} */ v) => (t = v))();
		return t;
	});
	h.check(cleared === null, 'U5.6 closing the browser forgets the slot target');

	// ---- U6 the UV editor's pane is the same list --------------------------------------------------------------------
	await page.evaluate(() => {
		const w = window.__tp.test.v1;
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
	});
	await page.waitForSelector('#uv-slot-list', { timeout: 15000 }).catch(() => {});
	const uv = await page.evaluate(() => ({
		rows: document.querySelectorAll('#uv-slot-list [data-uv-slot]').length,
		image: !!document.getElementById('uv-slot-image-1'),
		assign: !!document.getElementById('uv-slot-assign-1'),
		more: !!document.getElementById('uv-slot-more-1')
	}));
	if (!uv.rows)
		console.log('SKIP U6: the UV editor did not open from this suite (' + JSON.stringify(uv) + ')');
	else
		h.check(
			uv.rows === 3 && uv.image && uv.assign && uv.more,
			"U6 the UV editor's Materials pane is the same list, with its image / assign buttons: " +
				JSON.stringify(uv)
		);

	// ---- U7 a11y --------------------------------------------------------------------------------------------------
	const names = await page.evaluate(() =>
		[...document.querySelectorAll('#ins-slot-list button')].map((b) =>
			(b.getAttribute('aria-label') || b.textContent || '').trim()
		)
	);
	h.check(
		names.length === 9 && names.every((n) => n.length > 2),
		'U7.1 every row control has an accessible name: ' + JSON.stringify(names)
	);
	await page.locator('#ins-slot-row-0 .slot-main').focus();
	await page.keyboard.press('ArrowDown');
	const focused = await page.evaluate(() => document.activeElement?.closest('li')?.id ?? '');
	h.check(focused === 'ins-slot-row-1', 'U7.2 ArrowDown moves focus to the next row: ' + focused);
	await page.keyboard.press('Tab');
	const tabbed = await page.evaluate(() => document.activeElement?.id ?? '');
	h.check(tabbed === 'ins-slot-eye-1', "U7.3 Tab reaches the row's eye: " + tabbed);
	await page.locator('#ins-slot-row-1 .slot-main').focus();
	await page.keyboard.press('Shift+F10');
	await page.waitForTimeout(300);
	h.check(
		(await page.locator('[data-testid="ins-slot-menu-rename"]').count()) === 1,
		"U7.4 Shift+F10 opens the row's menu from the keyboard"
	);
	h.check(await closeMenu(page), 'U7.5 Escape closes the menu opened from the keyboard');

	// ---- U8 the agent ------------------------------------------------------------------------------------------------
	const depth = () =>
		page.evaluate(
			() =>
				new Promise((r) =>
					window.__tp.test.v1.history.undoStack.subscribe((/** @type {any} */ v) => r(v.length))()
				)
		);
	const agentDepth = await depth();
	const agent = await page.evaluate(async (uuid) => {
		const t = window.__tp.test.v1.aiTools;
		const list = await t.executeAiTool('list_materials', { objects: [uuid] });
		const row = list?.objects?.[0];
		const ids = (row?.slots ?? []).map((/** @type {any} */ s) => s.id);
		// slot 1 (Standard: slot 3 is the Phong one, which has no roughness)
		const r1 = await t.executeAiTool('set_material', {
			objects: [uuid],
			slot: ids[0],
			roughness: 0.25
		});
		const r2 = await t.executeAiTool('set_material', {
			objects: [uuid],
			slot: 'Glass',
			slotName: 'Window',
			slotOff: true
		});
		const after = await t.executeAiTool('list_materials', { objects: [uuid] });
		const r3 = await t.executeAiTool('set_material', {
			objects: [uuid],
			slot: 'Window',
			removeSlot: { to: 0 }
		});
		const final = await t.executeAiTool('list_materials', { objects: [uuid] });
		return {
			first: row?.slots,
			r1,
			r2,
			after: after?.objects?.[0]?.slots,
			r3,
			final: final?.objects?.[0]?.slots
		};
	}, uuid);
	h.check(
		Array.isArray(agent.first) &&
			agent.first.length === 3 &&
			agent.first.every((/** @type {any} */ s) => typeof s.id === 'string'),
		'U8.1 list_materials rows carry the slot id: ' +
			JSON.stringify(agent.first?.map((/** @type {any} */ s) => [s.slot, s.id, s.name]))
	);
	h.check(
		agent.after?.[0]?.roughness === 0.25 && agent.after?.[1]?.roughness !== 0.25,
		'U8.2 set_material {slot: <id>} writes that slot only: ' + JSON.stringify(agent.r1)
	);
	h.check(
		agent.after?.[1]?.name === 'Window' && agent.after?.[1]?.off === true,
		'U8.3 {slot: <name>, slotName, slotOff} renames and switches it off: ' +
			JSON.stringify(agent.after?.[1])
	);
	h.check(
		agent.final?.length === 2 && !agent.final.some((/** @type {any} */ s) => s.name === 'Window'),
		'U8.4 removeSlot {to} removes it: ' + JSON.stringify(agent.r3)
	);
	const steps = /** @type {number} */ (await depth()) - /** @type {number} */ (agentDepth);
	for (let i = 0; i < steps; i++) await undo(page);
	await page.waitForTimeout(300);
	s = await slots(page);
	h.check(
		s?.n === 3 && s.names[1] === 'Glass' && !s.off[1],
		"U8.5 the agent's " +
			steps +
			' edits undo like any other (three slots, "Glass" on): ' +
			JSON.stringify(s?.names)
	);

	// ---- U10 dark + light evidence -----------------------------------------------------------------------------------
	for (const theme of ['dark', 'light']) {
		await page.evaluate(
			async (theme) => (await import('/src/lib/themes.js')).theme.set(theme),
			theme
		);
		await page.waitForTimeout(500);
		await page
			.locator('#ins-slot-list')
			.screenshot({ path: path.join(OUT, 'slot-list-' + theme + '.png') })
			.catch(() => {});
	}
	await page.evaluate(async () => (await import('/src/lib/themes.js')).theme.set('dark'));

	// ---- U9 touch: Find N6 folded + unfolded ----------------------------------------------------------------------------
	for (const [posture, width, height] of /** @type {[string, number, number][]} */ ([
		['folded', 390, 896],
		['unfolded', 691, 634]
	])) {
		const T = await h.setupPage(browser, 'T-' + posture, {
			context: { viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
		});
		await h.answerRestore(T);
		const tu = await makeBox(T.page);
		await inspect(T.page, tu);
		await T.page.waitForSelector('#ins-slot-list', { timeout: 20000 }).catch(() => {});
		await T.page
			.locator('#ins-slot-list')
			.scrollIntoViewIfNeeded()
			.catch(() => {});
		const fit = await T.page.evaluate(() => {
			const rows = [...document.querySelectorAll('#ins-slot-list > li.slot-row')].map((li) => {
				const r = li.getBoundingClientRect();
				const eye = li.querySelector('[id^="ins-slot-eye-"]')?.getBoundingClientRect();
				const more = li.querySelector('[id^="ins-slot-more-"]')?.getBoundingClientRect();
				return {
					h: Math.round(r.height),
					right: Math.round(r.right),
					eye: eye ? [Math.round(eye.width), Math.round(eye.height)] : null,
					more: more ? [Math.round(more.width), Math.round(more.height)] : null
				};
			});
			return {
				rows,
				vw: innerWidth,
				pageScroll: document.documentElement.scrollWidth - innerWidth,
				coarse: matchMedia('(pointer: coarse)').matches
			};
		});
		h.check(fit.coarse, 'U9 ' + posture + ' premise: a coarse pointer');
		h.check(
			fit.rows.length === 3 && fit.rows.every((r) => r.h >= 44),
			'U9.1 ' + posture + ': rows are 44 px: ' + JSON.stringify(fit.rows.map((r) => r.h))
		);
		h.check(
			fit.rows.every(
				(r) =>
					r.eye && r.more && r.eye[0] >= 44 && r.eye[1] >= 44 && r.more[0] >= 44 && r.more[1] >= 44
			),
			'U9.2 ' +
				posture +
				': the eye and ⋯ are 44 px targets: ' +
				JSON.stringify(fit.rows.map((r) => [r.eye, r.more]))
		);
		h.check(
			fit.rows.every((r) => r.right <= fit.vw + 1) && fit.pageScroll <= 0,
			'U9.3 ' + posture + ': nothing overflows sideways'
		);
		await T.page.screenshot({ path: path.join(OUT, 'n6-' + posture + '.png') }).catch(() => {});
		// a long press on a row opens its menu (touchHold: 450 ms)
		const box = await T.page.locator('#ins-slot-row-1 .slot-main').boundingBox();
		if (box) {
			const cx = box.x + box.width / 2;
			const cy = box.y + box.height / 2;
			const cdp = await T.page.context().newCDPSession(T.page);
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchStart',
				touchPoints: [{ x: cx, y: cy }]
			});
			await T.page.waitForTimeout(700);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await T.page.waitForTimeout(300);
			h.check(
				(await T.page.locator('[data-testid="ins-slot-menu-rename"]').count()) === 1,
				'U9.4 ' + posture + ': a long press on a row opens its menu'
			);
			await T.page
				.screenshot({ path: path.join(OUT, 'n6-' + posture + '-menu.png') })
				.catch(() => {});
		}
		h.check(
			h.pageErrors(T).length === 0,
			'U9.5 ' + posture + ': no page errors (' + JSON.stringify(h.pageErrors(T)) + ')'
		);
		await T.ctx.close();
	}

	h.check(
		h.pageErrors(A).length === 0,
		'U11 no page errors (' + JSON.stringify(h.pageErrors(A)) + ')'
	);
	await h.finish(browser);
});
