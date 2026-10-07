// 38 R1 — THE SHORTCUT LOCK (SPEC §0: "All keyboard shortcuts (ShortcutSheet.svelte is the
// source list) and their focus rules"). The cheat sheet is GENERATED from the keymap registry
// ($lib/shortcuts.js), so "every shortcut in the sheet" is every registry row; this suite
// locks, through the redesign:
//
//   1. the registry itself — every id, its default keys, scope, group, and whether it is a
//      display-only row (fixed), an editor-owned row (external) or an action;
//   2. the `?` sheet — opens from anywhere but a text field, lists every row, puts the
//      focused scope first and says "has focus", focuses its filter, filters, Esc closes;
//      Ctrl+/ opens Settings › Shortcuts; both still answer over an open modal;
//   3. THE FOCUS RULES as a recorded routing table: for every focus scope a person can give
//      the keyboard to (the 3D viewport, the node editor, the UV / Animation / Shader / HUD
//      editors, a text field, the code editor, an open modal) and every key in the registry,
//      WHICH command fires. Actions are swapped for recorders for this part, so pressing
//      Delete deletes nothing — what is locked is the routing, and the routing is exactly
//      what a redesign can break (a pane that loses its data-key-scope, a header that
//      swallows a press, a new input that steals focus);
//   4. the editor-owned keys: every Edit Mesh row resolves to its command, G arms Move in
//      the timeline, and the hold keys (WASD fly) move the camera only from the viewport;
//   5. a set of REAL effects (actions restored): transform modes, panel toggles, undo/redo,
//      duplicate, delete, focus, chat, snapping.
//
//   LOCK_RECORD=1 node tests/e2e/lock-shortcuts.test.cjs   records fixtures/lock/shortcuts.json
//   npm run e2e -- lock-shortcuts                          verifies
const h = require('./helpers.cjs');
const L = require('./lockHelpers.cjs');

/** registry combo -> a Playwright key press ('' = not pressable: a hold/display row) @param {string} combo */
function pressFor(combo) {
	if (/\s/.test(combo) || /\(hold\)/.test(combo)) return '';
	const parts = combo === 'Ctrl++' ? ['Ctrl', '+'] : combo.split('+');
	const key = parts.pop() || '';
	const mods = parts.map((m) => (m === 'Ctrl' ? 'Control' : m));
	/** @type {Record<string, string>} */
	const named = { '?': 'Shift+Slash', '`': 'Backquote', '=': 'Equal', '-': 'Minus', '/': 'Slash', '+': 'Shift+Equal', _: 'Shift+Minus' };
	let k;
	if (named[key]) k = named[key];
	else if (/^[A-Z]$/.test(key)) k = 'Key' + key;
	else if (/^\d$/.test(key)) k = 'Digit' + key;
	else k = key;
	return [...mods, k].join('+');
}

/** in-page: swap every registry action for a recorder (or put them back) @param {boolean} on */
function wrapActions(on) {
	const w = /** @type {any} */ (window);
	const reg = w.__stores.shortcutsRegistry.shortcuts;
	w.__fired = w.__fired || [];
	for (const row of reg) {
		if (on && typeof row.action === 'function' && !row.__lockOrig) {
			row.__lockOrig = row.action;
			row.action = () => w.__fired.push(row.id);
		} else if (!on && row.__lockOrig) {
			row.action = row.__lockOrig;
			delete row.__lockOrig;
		}
	}
	return reg.filter((/** @type {any} */ r) => r.__lockOrig).length;
}

h.run(async () => {
	const browser = await L.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await L.installProbes(page);

	// a scene to act on: two boxes, one selected
	await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(1500);
	let boxId = await page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const b = g.children.find((c) => c.name === 'Box') ?? g.children[0];
		window.__stores.objectActions.selectObject(b.uuid);
		return b.uuid;
	});
	await page.waitForTimeout(400);

	// ---- 1. the registry --------------------------------------------------------------------
	const registry = await page.evaluate(() =>
		window.__stores.shortcutsRegistry.shortcuts.map((/** @type {any} */ r) => ({
			id: r.id,
			keys: r.keys,
			defaultKeys: r.defaultKeys,
			group: r.group,
			scope: r.scope || 'global',
			label: r.label,
			kind: r.fixed ? 'fixed' : r.external ? 'external' : typeof r.action === 'function' ? 'action' : 'none',
			when: typeof r.when === 'function'
		}))
	);
	const ids = registry.map((/** @type {any} */ r) => r.id);
	h.check(new Set(ids).size === ids.length, `registry ids are unique (${ids.length} rows)`);

	// ---- 2. the cheat sheet (real actions) ----------------------------------------------------
	const canvasPoint = { x: 420, y: 360 };
	const focusViewport = async () => {
		await page.mouse.click(canvasPoint.x, canvasPoint.y);
		await page.waitForTimeout(120);
	};
	await focusViewport();
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), boxId);
	await page.keyboard.press('Shift+Slash');
	await page.locator('#shortcut-sheet').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
	h.check(await page.locator('#shortcut-sheet').isVisible(), '? opens the keyboard cheat sheet');
	const sheet = await page.evaluate(() => ({
		rows: [...document.querySelectorAll('#shortcut-sheet [data-shortcut-id]')].map((e) => e.getAttribute('data-shortcut-id')),
		first: document.querySelector('#shortcut-sheet .sheet-scope')?.getAttribute('data-scope'),
		marked: document.querySelector('#shortcut-sheet .sheet-scope h3')?.textContent?.includes('has focus'),
		filterFocused: document.activeElement?.id === 'shortcut-sheet-filter'
	}));
	const sheetIds = new Set(sheet.rows);
	const missingFromSheet = ids.filter((/** @type {string} */ id) => !sheetIds.has(id));
	h.check(missingFromSheet.length === 0 && sheet.rows.length === ids.length, `the sheet lists every registry row once (${sheet.rows.length}/${ids.length}${missingFromSheet.length ? ', missing ' + missingFromSheet.join(',') : ''})`);
	h.check(sheet.first === 'viewport' && !!sheet.marked, `the focused scope comes first and is marked "has focus" (${sheet.first})`);
	h.check(sheet.filterFocused, 'the filter takes the keyboard when the sheet opens');
	await page.keyboard.type('undo');
	await page.waitForTimeout(150);
	const filtered = await page.evaluate(() => [...document.querySelectorAll('#shortcut-sheet [data-shortcut-id]')].map((e) => e.getAttribute('data-shortcut-id')));
	h.check(filtered.includes('history.undo') && filtered.length < ids.length / 4, `typing filters the rows by label or keys (${filtered.length} for "undo")`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check(!(await page.locator('#shortcut-sheet').isVisible()), 'Escape closes it');
	await focusViewport();
	await page.keyboard.press('Control+Slash');
	await page.waitForTimeout(400);
	h.check((await L.storeValue(page, 'settingsOpen')) === true && (await L.storeValue(page, 'settingsSection')) === 'shortcuts', 'Ctrl+/ opens Settings › Shortcuts');
	await page.keyboard.press('Shift+Slash');
	await page.waitForTimeout(300);
	h.check(await page.locator('#shortcut-sheet').isVisible(), '? still answers over an open modal (Settings)');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(150);
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(300);

	// ---- 3. the routing table (actions swapped for recorders) ----------------------------------
	const combos = [...new Set(registry.map((/** @type {any} */ r) => r.keys))].filter((c) => pressFor(c)).sort();
	const wrapped = await page.evaluate(wrapActions, true);
	h.check(wrapped > 50, `premise — every action row is recorded instead of run (${wrapped})`);

	/** open a dock view and hand it the keyboard by clicking an empty spot of its key-scope host
	 * @param {string} key @param {string} closeStore @param {string} scope */
	const openPane = async (key, closeStore, scope) => {
		await page.evaluate(
			({ key, closeStore }) => {
				const s = window.__stores;
				s[closeStore]?.set?.(false);
				s.bottomDock.activateDock(key);
			},
			{ key, closeStore }
		);
		const host = page.locator(`[data-key-scope="${scope}"]:visible`).first();
		await host.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
		return host;
	};
	/** click a spot of `host` that is the host itself or a plain container (not a control) @param {any} host */
	const giveFocus = async (host) => {
		const spot = await host.evaluate((/** @type {HTMLElement} */ el) => {
			const r = el.getBoundingClientRect();
			for (const [fx, fy] of [[0.5, 0.6], [0.7, 0.7], [0.3, 0.5], [0.85, 0.4], [0.5, 0.85], [0.2, 0.8]]) {
				const x = r.left + r.width * fx;
				const y = r.top + r.height * fy;
				const at = /** @type {HTMLElement|null} */ (document.elementFromPoint(x, y));
				if (!at || !el.contains(at)) continue;
				if (at.closest('button, input, select, textarea, a, [role=button], [role=option], .react-flow__node, .svelte-flow__node')) continue;
				return { x, y };
			}
			return { x: r.left + 4, y: r.top + r.height - 4 };
		});
		await page.mouse.click(spot.x, spot.y);
		await page.waitForTimeout(120);
	};

	/** @type {Record<string, () => Promise<boolean>>} */
	const scopes = {
		viewport: async () => {
			await page.evaluate(() => window.__stores.bottomDock?.dockMinimized?.set?.(true));
			await page.waitForTimeout(150);
			await focusViewport();
			return (await page.evaluate(() => window.__stores.keyScope.lastScope())) === 'viewport';
		},
		nodes: async () => (await giveFocus(await openPane('flow', 'flowGraphClose', 'nodes')), (await page.evaluate(() => window.__stores.keyScope.lastScope())) === 'nodes'),
		uv: async () => (await giveFocus(await openPane('uv', 'uvEditorClose', 'uv')), (await page.evaluate(() => window.__stores.keyScope.lastScope())) === 'uv'),
		animation: async () => (await giveFocus(await openPane('animation', 'animationClose', 'animation')), (await page.evaluate(() => window.__stores.keyScope.lastScope())) === 'animation'),
		shader: async () => (await giveFocus(await openPane('shader', 'shaderEditorClose', 'shader')), (await page.evaluate(() => window.__stores.keyScope.lastScope())) === 'shader'),
		hud: async () => (await giveFocus(await openPane('hud', 'hudEditorClose', 'hud')), (await page.evaluate(() => window.__stores.keyScope.lastScope())) === 'hud'),
		// a plain text field with no Enter action of its own: the Properties filter (the Connect
		// field would DIAL on Ctrl+Enter and take itself off the screen)
		text: async () => {
			await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), boxId);
			const input = page.locator('#inspector-search:visible').first();
			await input.waitFor({ state: 'visible', timeout: 8000 });
			await input.click();
			await input.fill('');
			return (await page.evaluate(() => document.activeElement?.id)) === 'inspector-search';
		},
		modal: async () => {
			await scopes.viewport();
			await page.evaluate(() => {
				window.__stores.settingsSection.set('about');
				window.__stores.settingsOpen.set(true);
			});
			await page.waitForTimeout(300);
			// the keyboard stays where it was (the viewport), the modal is what mutes the keys
			await page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
			return (await L.storeValue(page, 'anyModalOpen')) === true;
		}
	};

	/** @type {Record<string, Record<string, string|null>>} */
	const routing = {};
	for (const [scope, enter] of Object.entries(scopes)) {
		const ok = await enter();
		h.check(ok, `premise — the ${scope} scope can be given the keyboard`);
		if (!ok) continue;
		/** @type {Record<string, string|null>} */
		const table = {};
		const still = () =>
			page.evaluate((scope) => {
				const s = window.__stores;
				const a = document.activeElement;
				if (scope === 'text') return a?.tagName === 'INPUT';
				// a key can close the modal (Escape): from then on it is not the modal scope
				if (scope === 'modal') {
					let open = false;
					s.anyModalOpen.subscribe((v) => (open = !!v))();
					return open;
				}
				const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || /** @type {any} */ (a).isContentEditable);
				let menu = false;
				s.addMenu.subscribe((v) => (menu = menu || !!v))();
				s.viewportMenu.subscribe((v) => (menu = menu || !!v))();
				return !typing && !menu && !document.querySelector('[role=menu]') && s.keyScope.lastScope() === scope;
			}, scope);
		for (const combo of combos) {
			// re-enter whenever the last key moved the keyboard (an editor's own key can move
			// focus or open a menu) — never trust that the scope survived
			if (!(await still())) {
				await page.keyboard.press('Escape').catch(() => {});
				await page.evaluate(() => {
					window.__stores.addMenu.set(null);
					window.__stores.viewportMenu.set(null);
				});
				await enter();
			}
			await page.evaluate(() => (/** @type {any} */ (window).__fired = []));
			await page.keyboard.press(pressFor(combo));
			await page.waitForTimeout(25);
			const fired = await page.evaluate(() => /** @type {any} */ (window).__fired.slice());
			table[combo] = fired.length ? fired.join('|') : null;
		}
		routing[scope] = table;
		if (scope === 'modal') await page.evaluate(() => window.__stores.settingsOpen.set(false));
		console.log(`routing ${scope}: ${Object.values(table).filter(Boolean).length}/${combos.length} keys fire a command`);
	}
	await page.evaluate(wrapActions, false);

	// ---- 4. editor-owned keys -------------------------------------------------------------------
	const meshMap = await page.evaluate(() => {
		const S = window.__stores.shortcutsRegistry;
		return S.shortcuts.filter((/** @type {any} */ r) => r.scope === 'mesh').map((/** @type {any} */ r) => [r.id, S.meshCommandFor(r.keys)]);
	});
	const meshBad = meshMap.filter(([id, got]) => id !== got);
	h.check(meshMap.length > 10 && meshBad.length === 0, `every Edit Mesh key resolves to its own command (${meshMap.length} rows${meshBad.length ? ', wrong ' + JSON.stringify(meshBad) : ''})`);
	// G in the timeline arms Move (the animation editor's own capture handler owns it)
	await giveFocus(await openPane('animation', 'animationClose', 'animation'));
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(150);
	const xform = await page.evaluate(() => /** @type {any} */ (window).__animationDebug?.xform?.());
	h.check(xform === 'move', `G in the timeline arms Move there (${xform})`);
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.__stores.bottomDock?.dockMinimized?.set?.(true));
	await page.waitForTimeout(200);

	// hold-to-fly: W moves the camera from the viewport, not from a text field
	const camPos = () =>
		page.evaluate(() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c.position.toArray()))()));
	await focusViewport();
	let c0 = await camPos();
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(500);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(150);
	let c1 = await camPos();
	const flown = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
	h.check(flown > 0.3, `holding W in the viewport flies the camera (${flown.toFixed(2)} m)`);
	await scopes.text();
	c0 = await camPos();
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(500);
	await page.keyboard.up('KeyW');
	c1 = await camPos();
	h.check(Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]) < 0.01, 'holding W while typing in a text field does not fly');
	await page.evaluate(() => window.__stores.inspectorFilter.set(''));

	// ---- 5. real effects (actions restored) --------------------------------------------------------
	// the editors' own Ctrl+Z/Ctrl+Y (UV, HUD…) ran real undo/redo during the sweep, which
	// re-creates objects under new uuids: find the box again by name
	boxId = await page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return (g.children.find((c) => c.name === 'Box') ?? g.children[0]).uuid;
	});
	await focusViewport();
	// a viewport click resolves its pick after the double-click window: let it, THEN select
	await page.waitForTimeout(700);
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), boxId);
	await page.waitForTimeout(200);
	const selNow = await L.storeValue(page, 'selectedObjects');
	h.check(Array.isArray(selNow) && selNow.length === 1 && selNow[0] === boxId, `premise — the box is the selection (${JSON.stringify(selNow)})`);
	for (const [key, mode] of [['Digit2', 'rotate'], ['Digit3', 'scale'], ['Digit1', 'translate']]) {
		await page.keyboard.press(key);
		await page.waitForTimeout(80);
		h.check((await L.storeValue(page, 'transformMode')) === mode, `${key} sets the gizmo to ${mode}`);
		if (process.env.LOCK_DEBUG) console.log(`  after ${key}: selection ${JSON.stringify(await L.storeValue(page, 'selectedObjects'))}`);
	}
	// the ACTIVE mode's key again (G = Move, already armed by 1) hides the selection and
	// remembers it; once more brings it back (setTransformMode's toggle)
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(200);
	h.check(JSON.stringify(await L.storeValue(page, 'selectedObjects')) === '[]', 'G while Move is already armed puts the selection away (the active mode toggles)');
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(200);
	h.check(JSON.stringify(await L.storeValue(page, 'selectedObjects')) === JSON.stringify([boxId]), 'and G again brings the same selection back');
	h.check((await L.storeValue(page, 'transformMode')) === 'translate', 'G is Move (same as 1)');
	const objectCount = () => page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	const n0 = await objectCount();
	const selD = await L.storeValue(page, 'selectedObjects');
	if (!selD?.length) console.log('  selection lost before Ctrl+D: ' + JSON.stringify(selD));
	const countIs = (/** @type {number} */ n, /** @type {string} */ what) => h.eventually(objectCount, (c) => c === n, what, 5000).catch(() => null);
	await page.keyboard.press('Control+KeyD');
	await countIs(n0 + 1, 'the duplicate lands');
	h.check((await objectCount()) === n0 + 1, `Ctrl+D duplicates the selection (${n0} -> ${await objectCount()})`);
	if ((await objectCount()) !== n0 + 1)
		console.log('  state: ' + JSON.stringify(await page.evaluate(() => {
			const s = window.__stores;
			const r = (/** @type {any} */ st) => { let v; st?.subscribe?.((x) => (v = x))(); return v; };
			return { sel: r(s.selectedObjects), scope: s.keyScope.lastScope(), act: document.activeElement?.id || document.activeElement?.tagName, modal: r(s.anyModalOpen), locked: r(s.isLocked), mode: r(s.editorMode), notes: localStorage.getItem('notifications')?.slice(-300) };
		})));
	await page.waitForTimeout(400);
	await page.keyboard.press('Control+KeyZ');
	await countIs(n0, 'the undo lands');
	h.check((await objectCount()) === n0, `Ctrl+Z undoes it (${await objectCount()})`);
	await page.keyboard.press('Control+KeyY');
	await countIs(n0 + 1, 'the redo lands');
	h.check((await objectCount()) === n0 + 1, `Ctrl+Y redoes it (${await objectCount()})`);
	await page.keyboard.press('Control+Shift+KeyZ');
	await page.waitForTimeout(300);
	await page.keyboard.press('Control+KeyZ');
	await page.waitForTimeout(500);
	h.check((await objectCount()) === n0, 'Ctrl+Shift+Z is redo too (nothing left to redo, then undo goes back)');
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), boxId);
	await page.keyboard.press('Delete');
	await page.waitForTimeout(600);
	h.check((await objectCount()) === n0 - 1, `Delete removes the selection (${await objectCount()})`);
	await page.keyboard.press('Control+KeyZ');
	await page.waitForTimeout(600);
	h.check((await objectCount()) === n0, 'and Ctrl+Z brings it back');
	const objOpen = async () => (await L.storeValue(page, 'objectListClose')) === false;
	const o0 = await objOpen();
	await page.keyboard.press('KeyO');
	await page.waitForTimeout(300);
	h.check((await objOpen()) !== o0, 'O toggles the object list');
	await page.keyboard.press('KeyO');
	await page.waitForTimeout(300);
	const chat0 = await L.storeValue(page, 'chatHidden');
	await focusViewport();
	await page.keyboard.press('KeyC');
	await page.waitForTimeout(200);
	h.check((await L.storeValue(page, 'chatHidden')) !== chat0, `C toggles chat (${chat0} -> ${await L.storeValue(page, 'chatHidden')})`);
	await page.keyboard.press('KeyC');
	const snap0 = await page.evaluate(() => new Promise((r) => window.__stores.snapping.snapTargets.subscribe((t) => r(!!t.enabled))()));
	await page.keyboard.press('KeyM');
	await page.waitForTimeout(150);
	const snap1 = await page.evaluate(() => new Promise((r) => window.__stores.snapping.snapTargets.subscribe((t) => r(!!t.enabled))()));
	h.check(snap1 !== snap0, 'M toggles element snapping');
	await page.keyboard.press('KeyM');
	await page.keyboard.press('Alt+KeyE');
	await page.waitForTimeout(400);
	h.check((await L.storeValue(page, 'explorerClose')) === false, 'Alt+E opens the Explorer');
	await page.keyboard.press('Alt+KeyE');
	await page.waitForTimeout(300);

	// ---- record / verify --------------------------------------------------------------------------
	const now = { registry, routing };
	if (L.RECORD) {
		L.writeFixture('shortcuts', { recordedAt: new Date().toISOString(), ...now });
		return h.finish(browser);
	}
	const fixture = L.readFixture('shortcuts');
	h.check(!!fixture, 'the recorded shortcut lock exists (tests/e2e/fixtures/lock/shortcuts.json)');
	if (fixture) {
		const byId = new Map(registry.map((/** @type {any} */ r) => [r.id, r]));
		for (const want of fixture.registry) {
			const got = byId.get(want.id);
			if (!got) {
				h.check(false, `shortcut ${want.id} still exists`);
				continue;
			}
			const shape = (/** @type {any} */ r) => JSON.stringify([r.keys, r.defaultKeys, r.group, r.scope, r.kind, r.when]);
			h.check(shape(got) === shape(want), `shortcut ${want.id}: ${want.keys} · ${want.scope} · ${want.kind}` + (shape(got) === shape(want) ? '' : `\n      expected ${shape(want)}\n      actual   ${shape(got)}`));
			if (got.label !== want.label) console.log(`WARN shortcut ${want.id} label changed: "${want.label}" -> "${got.label}"`);
		}
		const extra = registry.filter((/** @type {any} */ r) => !fixture.registry.some((/** @type {any} */ w) => w.id === r.id));
		h.check(extra.length === 0, `no unexpected new shortcut rows (${extra.map((/** @type {any} */ r) => r.id).join(',') || 'none'})`);
		for (const [scope, table] of Object.entries(fixture.routing)) {
			const got = routing[scope] ?? {};
			const diff = Object.entries(table).filter(([combo, id]) => (got[combo] ?? null) !== id);
			h.check(diff.length === 0, `focus rules in the ${scope} scope: ${Object.keys(table).length} keys route as recorded` + (diff.length ? '\n      ' + diff.map(([c, id]) => `${c}: expected ${id} got ${got[c] ?? null}`).join('\n      ') : ''));
		}
	}
	await h.finish(browser);
});
