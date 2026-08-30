// A SHORTCUT FOR EVERY TOOLBAR TOOL.
//
// The rebinding system already existed (stable ids, defaultKeys, shortcutOverrides,
// applyOverrides, conflictOf with its scope rule). What was missing was a DEFAULT
// BINDING for most of the toolbar's panels: only the object list (O) and the node
// editor (N) had one, so five dock views and the dock itself could be reached from the
// keyboard not at all.
//
// The scheme under test: the two bare keys stay, the dock takes bare T, and every other
// panel takes `Alt+` its initial. A BINDING NAMES THE TOOL, never a toolbar slot — so
// Alt+A opens the Animation editor wherever it sits in the roster, and even when it is
// not on the toolbar at all.
//
// Everything here is driven with REAL key presses on a blurred body, because the
// registry deliberately stands down for text fields and that is exactly the guard a
// store-poking test would step over.
const h = require('./helpers.cjs');

/** every row this batch adds, and what it should reach */
const NEW_ROWS = [
	{ id: 'panels.dock', keys: 'T', press: 't' },
	{ id: 'panels.explorer', keys: 'Alt+E', press: 'Alt+e', store: 'explorerClose', dock: 'explorer' },
	{ id: 'panels.flow-code', keys: 'Alt+F', press: 'Alt+f', store: 'flowCodeClose', dock: 'flowcode' },
	{ id: 'panels.animation', keys: 'Alt+A', press: 'Alt+a', store: 'animationClose', dock: 'animation' },
	{ id: 'panels.uv-editor', keys: 'Alt+U', press: 'Alt+u', store: 'uvEditorClose', dock: 'uv' },
	{ id: 'panels.shader-editor', keys: 'Alt+S', press: 'Alt+s', store: 'shaderEditorClose', dock: 'shader' },
	{ id: 'panels.hud-editor', keys: 'Alt+H', press: 'Alt+h', store: 'hudEditorClose', dock: 'hud' }
];

/** a real press with nothing focused — never a text field */
async function press(page, key) {
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.keyboard.press(key);
	await page.waitForTimeout(400);
}

const storeVal = (page, name) =>
	page.evaluate((n) => {
		let v;
		window.__stores[n].subscribe((x) => (v = x))();
		return v;
	}, name);

const dockState = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let visible, occ, min, active;
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		s.bottomDock.dockMinimized.subscribe((v) => (min = v))();
		s.bottomDock.bottomDockActive.subscribe((v) => (active = v))();
		return {
			visible,
			minimized: min,
			active,
			present: Object.keys(occ)
				.filter((k) => occ[k]?.present)
				.sort()
		};
	});

const regOf = (page, id) =>
	page.evaluate((sid) => {
		const s = window.__stores.shortcutsRegistry.shortcuts.find((x) => x.id === sid);
		return s
			? {
					keys: s.keys,
					defaultKeys: s.defaultKeys,
					group: s.group,
					label: s.label,
					rebindable: window.__stores.shortcutsRegistry.isRebindable(s)
				}
			: null;
	}, id);

/** close every dock view and un-minimize, so each section starts from one known state */
async function clearDock(page) {
	await page.evaluate(() => {
		const s = window.__stores;
		for (const k of ['flowGraphClose', 'flowCodeClose', 'animationClose', 'uvEditorClose', 'shaderEditorClose', 'hudEditorClose', 'explorerClose'])
			s[k].set(true);
		s.bottomDock.dockMinimized.set(false);
	});
	await page.waitForTimeout(450);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	// every dock view starts DOCKED, so a press has one predictable destination
	await A.page.evaluate(() => {
		for (const k of ['flowDocked', 'flowCodeDocked', 'animationDocked', 'uvDocked', 'shaderDocked', 'hudDocked', 'explorerDocked'])
			localStorage.setItem(k, 'true');
		localStorage.removeItem('shortcutOverrides');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.waitForTimeout(600);

	// ------------------------------------------------------ 1. the rows exist
	for (const row of NEW_ROWS) {
		const r = await regOf(A.page, row.id);
		h.check(!!r, `1.${row.id} the registry has a row for ${row.id}`);
		h.check(r && r.keys === row.keys, `1.${row.id} bound to ${row.keys} (${r && r.keys})`);
		h.check(r && r.defaultKeys === row.keys, `1.${row.id} ...and that IS its default (${r && r.defaultKeys})`);
		h.check(r && r.group === 'Panels', `1.${row.id} listed under Panels (${r && r.group})`);
		h.check(r && r.rebindable === true, `1.${row.id} rebindable like any other row`);
	}
	// the two that already existed are untouched
	const o = await regOf(A.page, 'panels.object-list');
	const n = await regOf(A.page, 'panels.node-editor');
	h.check(o && o.keys === 'O', `1.9 bare O still opens the object list (${o && o.keys})`);
	h.check(n && n.keys === 'N', `1.10 bare N still opens the node editor (${n && n.keys})`);

	// ----------------------------------------- 2. no collisions among the set
	// Reported as EVIDENCE, not just asserted: `conflictOf` returns both halves, and
	// the meshEdit half is the one that matters for this scheme — E/S/F/H/U/A are all
	// bare MESH_EDIT_KEYS, so a bare letter here would silently do nothing for as long
	// as a mesh session is open. `Alt+E` is a DIFFERENT combo string, so it is clear.
	const conflicts = await A.page.evaluate((rows) => {
		const R = window.__stores.shortcutsRegistry;
		const out = {};
		for (const row of rows) {
			const c = R.conflictOf(row.keys, row.id, null);
			out[row.keys] = { with: c.shortcut ? c.shortcut.id : null, meshEdit: c.meshEdit };
		}
		return out;
	}, NEW_ROWS.map((r) => ({ id: r.id, keys: r.keys })));
	for (const row of NEW_ROWS) {
		const c = conflicts[row.keys];
		h.check(c && c.with === null, `2.${row.keys} nothing else answers to ${row.keys} (with=${c && c.with})`);
		h.check(c && c.meshEdit === false, `2.${row.keys} ...and a mesh session does not swallow it (meshEdit=${c && c.meshEdit})`);
	}
	// THE COUNTERFACTUAL FOR THE MODIFIER. Strip Alt and three of the six land straight
	// on a mesh-edit key, where the registry stands down entirely for as long as a
	// session is open — so the row would look bound in Settings and do nothing on the
	// keyboard. This is measured, not assumed: E (extrude), F (create face) and S
	// (scale) collide; A, U and H happen not to, which is exactly why the rule is "all
	// six take Alt" rather than "the ones that need it do" — a scheme a user has to
	// remember the exceptions to is a worse scheme.
	const bare = await A.page.evaluate(() => {
		const R = window.__stores.shortcutsRegistry;
		/** @type {Record<string, boolean>} */
		const out = {};
		for (const k of ['E', 'F', 'A', 'U', 'S', 'H']) out[k] = R.conflictOf(k, undefined, null).meshEdit;
		return out;
	});
	h.check(
		bare.E === true && bare.F === true && bare.S === true,
		`2.bare1 stripping Alt puts E/F/S onto mesh-edit keys, where the registry stands down (${JSON.stringify(bare)})`
	);
	h.check(
		bare.A === false && bare.U === false && bare.H === false,
		`2.bare2 ...while A/U/H are free bare — the reason the rule is "all six", not "the ones that need it" (${JSON.stringify(bare)})`
	);
	// and prove the stand-down is real, not just a warning flag: a live mesh session
	// swallows bare S, and never Alt+S
	const swallowed = await A.page.evaluate(() => {
		const R = window.__stores.shortcutsRegistry;
		return { bareS: R.conflictOf('S', undefined, null).meshEdit, altS: R.conflictOf('Alt+S', undefined, null).meshEdit };
	});
	h.check(
		swallowed.bareS === true && swallowed.altS === false,
		`2.bare3 'S' and 'Alt+S' are DIFFERENT combo strings to MESH_EDIT_KEYS (${JSON.stringify(swallowed)})`
	);

	// ----------------------------------- 3. each Alt+ combo opens ITS panel
	for (const row of NEW_ROWS.filter((r) => r.store)) {
		await clearDock(A.page);
		let closed = await storeVal(A.page, row.store);
		h.check(closed === true, `3.${row.keys} premise: ${row.dock} starts closed`);
		await press(A.page, row.press);
		closed = await storeVal(A.page, row.store);
		const st = await dockState(A.page);
		h.check(closed === false, `3.${row.keys} opens the ${row.dock} view (${row.store}=${closed})`);
		h.check(st.visible === row.dock, `3.${row.keys} ...as the visible dock tab (visible=${st.visible})`);
		// a second press hides it again, per togglePanel's tree (step 4)
		await press(A.page, row.press);
		const after = await dockState(A.page);
		const closedAgain = await storeVal(A.page, row.store);
		h.check(
			closedAgain === true || after.visible !== row.dock,
			`3.${row.keys} a second press hides it (${row.store}=${closedAgain}, visible=${after.visible})`
		);
	}

	// ------------- 3b. THE BINDING NAMES THE TOOL, not a toolbar slot
	// The five optional dock views (Flow Code / Animation / UV / Shader / HUD) are in
	// the roster but NOT on the bar of a fresh profile — they are listed in Customize
	// unchecked. So this is the real case: their keys must work while their button does
	// not exist. If the binding were an index into the button strip, it could not.
	await clearDock(A.page);
	const barTitles = await A.page.evaluate(() =>
		[...document.querySelectorAll('nav p[title]')].map((p) => p.getAttribute('title'))
	);
	const optionalOnBar = ['UV editor', 'Shader editor', 'HUD editor', 'Animation', 'Flow Code'].filter((t) =>
		barTitles.includes(t)
	);
	h.check(
		optionalOnBar.length === 0,
		`3b.1 premise: none of the five optional views has a toolbar button on a fresh profile (on bar: ${optionalOnBar.join(',') || 'none'})`
	);
	await press(A.page, 'Alt+u');
	const uvOpen = await storeVal(A.page, 'uvEditorClose');
	h.check(uvOpen === false, `3b.2 Alt+U opens the UV editor with no button of its own on the bar (uvEditorClose=${uvOpen})`);
	await clearDock(A.page);
	await press(A.page, 'Alt+s');
	const shOpen = await storeVal(A.page, 'shaderEditorClose');
	h.check(shOpen === false, `3b.3 ...and Alt+S the Shader editor (shaderEditorClose=${shOpen})`);

	// ---------------------------------------------- 4. T, in all three states
	// STATE A: the dock is SHOWING -> minimize (every tab stays open).
	await clearDock(A.page);
	await press(A.page, 'Alt+a'); // put one view in the dock
	let st = await dockState(A.page);
	h.check(st.visible === 'animation' && st.minimized === false, `4.1 premise: the dock is showing Animation (visible=${st.visible})`);
	await press(A.page, 't');
	st = await dockState(A.page);
	h.check(st.minimized === true, `4.2 T minimizes a showing dock (minimized=${st.minimized})`);
	h.check(st.present.includes('animation'), `4.3 ...and every tab stays open (present=${st.present.join(',')})`);
	const animStillOpen = await storeVal(A.page, 'animationClose');
	h.check(animStillOpen === false, `4.4 ...the panel itself is not closed (animationClose=${animStillOpen})`);

	// STATE B: MINIMIZED -> bring it back. A minimized dock draws no strip at all, so
	// this key is one of only two ways back and must work from every state.
	await press(A.page, 't');
	st = await dockState(A.page);
	h.check(st.minimized === false, `4.5 T brings a minimized dock back (minimized=${st.minimized})`);
	h.check(st.visible === 'animation', `4.6 ...showing the tab it had (visible=${st.visible})`);

	// STATE C: NOTHING DOCKED -> open the last-active view, docked.
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('uv'));
	await A.page.waitForTimeout(200);
	await clearDock(A.page);
	st = await dockState(A.page);
	h.check(st.present.length === 0 && st.visible === null, `4.7 premise: the dock is empty (present=${st.present.length}, visible=${st.visible})`);
	h.check(st.active === 'uv', `4.8 ...and 'uv' was the last-active view (active=${st.active})`);
	await press(A.page, 't');
	st = await dockState(A.page);
	const uvClosed = await storeVal(A.page, 'uvEditorClose');
	h.check(uvClosed === false, `4.9 T on an empty dock opens the last-active view (uvEditorClose=${uvClosed})`);
	h.check(st.visible === 'uv' && st.minimized === false, `4.10 ...docked and showing (visible=${st.visible}, min=${st.minimized})`);

	// ...and the fallback when bottomDockActive names a view this tree never heard of
	await A.page.evaluate(() => window.__stores.bottomDock.bottomDockActive.set('not-a-view'));
	await clearDock(A.page);
	await press(A.page, 't');
	st = await dockState(A.page);
	const flowClosed = await storeVal(A.page, 'flowGraphClose');
	h.check(flowClosed === false && st.visible === 'flow', `4.11 an unknown last-active view falls back to the Node editor (visible=${st.visible})`);

	// minimize -> reload -> T. `dockMinimized` is deliberately NOT persisted (a
	// minimized dock leaves NO trace on screen, so a reload must never hand somebody a
	// lost panel), and T has to work from whatever state the reload lands in.
	await A.page.evaluate(() => window.__stores.bottomDock.bottomDockActive.set('flow'));
	await press(A.page, 't');
	st = await dockState(A.page);
	h.check(st.minimized === true, `4.12 premise: minimized before the reload (${st.minimized})`);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.waitForTimeout(700);
	st = await dockState(A.page);
	h.check(st.minimized === false, `4.13 a reload restores the dock rather than a lost panel (minimized=${st.minimized})`);
	// bring the dock to a KNOWN showing state, whatever the reload restored, then
	// assert the full round trip on the key alone
	if (!st.visible) {
		await press(A.page, 't');
		st = await dockState(A.page);
	}
	h.check(!!st.visible && !st.minimized, `4.14 ...and T reaches a showing dock from whatever the reload left (visible=${st.visible})`);
	await press(A.page, 't');
	st = await dockState(A.page);
	h.check(st.minimized === true, `4.15 ...T then hides it (minimized=${st.minimized})`);
	await press(A.page, 't');
	st = await dockState(A.page);
	h.check(st.minimized === false && !!st.visible, `4.16 ...and T brings it straight back (visible=${st.visible})`);

	// ------------------------------------------- 5. T is inert in a text field
	// The registry stands down for text entry app-wide; a single-letter panel key is
	// where that would be noticed first (typing "t" in a node field must type a t).
	const typed = await A.page.evaluate(async () => {
		const input = document.createElement('input');
		input.type = 'text';
		input.id = 'zz-typing-probe';
		document.body.appendChild(input);
		input.focus();
		return document.activeElement === input;
	});
	h.check(typed === true, `5.1 premise: a text input holds focus`);
	const beforeMin = (await dockState(A.page)).minimized;
	await A.page.keyboard.press('t');
	await A.page.waitForTimeout(350);
	st = await dockState(A.page);
	const probeValue = await A.page.evaluate(() => {
		const el = document.getElementById('zz-typing-probe');
		const v = el ? el.value : null;
		el?.remove();
		return v;
	});
	h.check(st.minimized === beforeMin, `5.2 T typed into a field does not touch the dock (minimized ${beforeMin} -> ${st.minimized})`);
	h.check(probeValue === 't', `5.3 ...the letter reaches the field (value="${probeValue}")`);

	// ---------------------------------- 6. Alt+ presses reach us, not the browser
	// Alt+E / Alt+F are Chrome menu accelerators on Windows. `handleKeydown` calls
	// preventDefault, so the press must arrive DEFAULT-PREVENTED and leave focus alone.
	await clearDock(A.page);
	// The recorder is installed by an AWAITED evaluate that parks its results on the
	// window — a floating promise-returning evaluate is not guaranteed to have attached
	// its listener before the next call's key press, and a listener that was never
	// attached reads exactly like a key that never arrived.
	await A.page.evaluate(() => {
		document.activeElement instanceof HTMLElement && document.activeElement.blur();
		/** @type {any} */ (window).__altProbe = [];
		/** @type {any} */ (window).__altOnKey = (/** @type {any} */ e) =>
			/** @type {any} */ (window).__altProbe.push({ key: e.key, alt: e.altKey, prevented: e.defaultPrevented });
		// BUBBLE phase on window: the registry's own listener was registered first, so
		// its preventDefault has already run by the time this sees the event
		window.addEventListener('keydown', /** @type {any} */ (window).__altOnKey);
	});
	await A.page.keyboard.press('Alt+e');
	await A.page.waitForTimeout(400);
	const probe = await A.page.evaluate(() => {
		window.removeEventListener('keydown', /** @type {any} */ (window).__altOnKey);
		return { seen: /** @type {any} */ (window).__altProbe, focus: document.activeElement?.tagName ?? null };
	});
	// the listener is registered on `window` in BUBBLE phase, so the registry's
	// preventDefault (also on window, registered first) has already run
	const hit = probe.seen.find((s) => s.alt && String(s.key).toLowerCase() === 'e');
	h.check(!!hit, `6.1 the Alt+E keydown reaches the page at all (${JSON.stringify(probe.seen.slice(0, 3))})`);
	h.check(hit && hit.prevented === true, `6.2 ...and the registry has preventDefault'd it (prevented=${hit && hit.prevented})`);
	h.check(probe.focus === 'BODY' || probe.focus === null, `6.3 ...and focus is not stolen by browser chrome (activeElement=${probe.focus})`);
	const explAfterAlt = await storeVal(A.page, 'explorerClose');
	h.check(explAfterAlt === false, `6.4 ...and the Explorer opened (explorerClose=${explAfterAlt})`);

	// ---------------------------------------- 7. a rebind moves one, and comes back
	// The rows are ordinary registry entries, so the whole Phase-5 machine applies.
	await clearDock(A.page);
	const moved = await A.page.evaluate(() => window.__stores.shortcutsRegistry.rebindShortcut('panels.hud-editor', 'Alt+J'));
	h.check(moved && moved.ok === true, `7.1 Alt+H can be rebound to Alt+J (${JSON.stringify(moved)})`);
	await press(A.page, 'Alt+j');
	let hudClosed = await storeVal(A.page, 'hudEditorClose');
	h.check(hudClosed === false, `7.2 the NEW combo opens the HUD editor (hudEditorClose=${hudClosed})`);
	await clearDock(A.page);
	await press(A.page, 'Alt+h');
	hudClosed = await storeVal(A.page, 'hudEditorClose');
	h.check(hudClosed === true, `7.3 ...and the old one no longer does (hudEditorClose=${hudClosed})`);
	await A.page.evaluate(() => window.__stores.shortcutsRegistry.resetShortcut('panels.hud-editor'));
	await clearDock(A.page);
	await press(A.page, 'Alt+h');
	hudClosed = await storeVal(A.page, 'hudEditorClose');
	const hudReg = await regOf(A.page, 'panels.hud-editor');
	h.check(hudClosed === false && hudReg.keys === 'Alt+H', `7.4 reset puts Alt+H back and it works again (keys=${hudReg.keys})`);

	// ---------------------------------------- 8. the rows render in Settings
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('shortcuts');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForSelector('#shortcut-grid', { timeout: 15000 });
	await A.page.waitForTimeout(300);
	const shown = await A.page.evaluate(
		(ids) =>
			ids.map((id) => {
				const row = document.querySelector(`[data-shortcut="${id}"]`);
				const el = row && (row.querySelector('.shortcut-keys') || row.querySelector('kbd'));
				return { id, keys: el ? el.textContent.trim() : null, text: row ? row.textContent.replace(/\s+/g, ' ').trim() : null };
			}),
		NEW_ROWS.map((r) => r.id)
	);
	for (let i = 0; i < NEW_ROWS.length; i++) {
		h.check(shown[i].keys === NEW_ROWS[i].keys, `8.${i + 1} Settings lists ${NEW_ROWS[i].id} as ${NEW_ROWS[i].keys} (${shown[i].keys})`);
	}
	const dockRow = shown[0].text || '';
	h.check(/dock/i.test(dockRow), `8.dock the T row names the dock ("${dockRow.slice(0, 70)}")`);
	h.check(
		/Node editor|Explorer/i.test(dockRow),
		`8.dock2 ...and says what it contains ("${dockRow.slice(0, 90)}")`
	);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));

	await h.finish(browser);
});
