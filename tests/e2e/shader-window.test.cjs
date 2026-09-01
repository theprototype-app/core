// THE SHADER EDITOR GETS A FLOATING MODE.
//
// It was the ONE dock view with no window at all: no `docked` flag, no dragWindow, no
// window chrome, and an occupancy report that never asked whether it was docked. Two
// other modules carried an exception for that fact — `panelToggles`' `dockOnly` shape
// and `dockMenu.dockTabItems` withholding "Undock" rather than shipping a row that
// could only do nothing. This suite proves the parity and that both exceptions are gone.
//
// Every gesture here is a REAL one: a right-click on the tab and a click on the menu
// row, a real mouse drag on the header, real key presses.
const h = require('./helpers.cjs');

const snap = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let occ, visible, closed, min;
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.bottomDock.dockMinimized.subscribe((v) => (min = v))();
		s.shaderEditorClose.subscribe((v) => (closed = v))();
		const dock = document.getElementById('shader-editor');
		const win = document.getElementById('shader-window');
		const box = win?.getBoundingClientRect();
		return {
			closed,
			minimized: min,
			visible,
			present: !!occ.shader?.present,
			hasDock: !!dock,
			hasWin: !!win,
			winRect: box ? { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) } : null,
			// the graph body has to be present in BOTH modes, or the window is chrome
			// around nothing
			hasBody: !!document.querySelector('#shader-editor .shader-body, #shader-window .shader-body'),
			hasScope: !!document.getElementById('shader-scope'),
			docked: localStorage.getItem('shaderDocked')
		};
	});

async function press(page, key) {
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.keyboard.press(key);
	await page.waitForTimeout(450);
}

/** open the Shader editor as a dock tab from a clean slate */
async function openDocked(page) {
	await page.evaluate(() => {
		localStorage.setItem('shaderDocked', 'true');
		const s = window.__stores;
		s.bottomDock.armDockMode('shader', true);
		s.shaderEditorClose.set(false);
		s.bottomDock.activateDock('shader');
	});
	await page.waitForTimeout(600);
}

/**
 * The centre of a tab in the VISIBLE strip.
 *
 * EVERY docked panel renders its own `<DockTabs />` and the ones that are not showing
 * stay mounted behind a `hidden` class — so a bare `querySelector('[data-dock-tab=…]')`
 * can return the copy inside a hidden panel, whose rect is 0x0 at the origin. A drag
 * synthesized against that lands on the CANVAS and reads exactly like a dead feature.
 * @param {import('playwright').Page} page @param {string} key
 */
const tabCentre = (page, key) =>
	page.evaluate((k) => {
		const el = [...document.querySelectorAll(`[data-dock-tab="${k}"]`)].find(
			(n) => n.getBoundingClientRect().width > 0
		);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const x = Math.round(r.left + r.width / 2);
		const y = Math.round(r.top + r.height / 2);
		const at = document.elementFromPoint(x, y);
		return { x, y, hits: at?.getAttribute?.('data-dock-tab') ?? at?.tagName ?? null };
	}, key);

/** a real drag with the mouse */
async function drag(page, from, to) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	// several steps: the tab drag needs 6px of TRAVEL to promote a press into a drag,
	// and one jump would deliver a single move
	for (let i = 1; i <= 8; i++)
		await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
	await page.waitForTimeout(120);
	await page.mouse.up();
	await page.waitForTimeout(600);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => {
		localStorage.setItem('shaderDocked', 'true');
		localStorage.setItem('flowDocked', 'true');
		localStorage.removeItem('shortcutOverrides');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.waitForTimeout(700);

	// ------------------------------------------------------- 1. docked, as before
	await openDocked(A.page);
	let s = await snap(A.page);
	h.check(s.hasDock && !s.hasWin, `1.1 opens DOCKED by default (dock=${s.hasDock}, window=${s.hasWin})`);
	h.check(s.present === true, `1.2 ...and reports itself as a dock tab (present=${s.present})`);
	h.check(s.visible === 'shader', `1.3 ...as the visible one (visible=${s.visible})`);
	h.check(s.hasBody, `1.4 the graph body renders`);
	const undockBtn = await A.page.evaluate(() => !!document.getElementById('shader-undock'));
	h.check(undockBtn, `1.5 the docked header offers ⧉ Undock (#shader-undock present=${undockBtn})`);
	// the top-edge dock resize cue W6 added must survive the restructure
	const cue = await A.page.evaluate(() => !!document.querySelector('#shader-editor .resize-cue'));
	h.check(cue, `1.6 the top-edge dock resize cue is still there (${cue})`);

	// ------------------------------- 2. the tab menu now OFFERS Undock
	// It was withheld for this ONE key. That row is the exception this batch removes.
	const menuLabels = await A.page.evaluate(async () => {
		const mod = await import('/src/lib/dockMenu.js');
		return {
			shader: mod.dockTabItems('shader').map((i) => i.label),
			uv: mod.dockTabItems('uv').map((i) => i.label)
		};
	});
	h.check(
		menuLabels.shader.some((l) => /Undock/i.test(l)),
		`2.1 the Shader tab menu offers Undock (${menuLabels.shader.join(' | ')})`
	);
	h.check(
		menuLabels.shader.length === menuLabels.uv.length,
		`2.2 ...the same rows a sibling tab gets, no exception left (shader=${menuLabels.shader.length}, uv=${menuLabels.uv.length})`
	);

	// -------------------------- 3. undock through the REAL tab context menu
	const tabAt = await tabCentre(A.page, 'shader');
	h.check(!!tabAt && tabAt.hits === 'shader', `3.1 premise: the visible strip has a Shader editor tab (hits=${tabAt && tabAt.hits})`);
	await A.page.mouse.click(tabAt.x, tabAt.y, { button: 'right' });
	await A.page.waitForTimeout(400);
	const rowClicked = await A.page.evaluate(() => {
		// ContextMenu rows are [role=menuitem] DIVs, never buttons
		const row = [...document.querySelectorAll('[role=menuitem]')].find((el) => /Undock/i.test(el.textContent || ''));
		if (!row) return false;
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return true;
	});
	h.check(rowClicked, `3.2 the menu's Undock row exists and was clicked (${rowClicked})`);
	await A.page.waitForTimeout(800);
	s = await snap(A.page);
	h.check(s.hasWin && !s.hasDock, `3.3 it becomes a floating window (window=${s.hasWin}, dock=${s.hasDock})`);
	h.check(s.present === false, `3.4 ...and stops reporting itself as a dock tab (present=${s.present})`);
	h.check(s.docked === 'false', `3.5 ...the mode is remembered (shaderDocked=${s.docked})`);
	h.check(s.hasBody && s.hasScope, `3.6 ...with the SAME body and scope line inside it (body=${s.hasBody}, scope=${s.hasScope})`);
	const grip = await A.page.evaluate(() => !!document.querySelector('#shader-window .resize-cue'));
	h.check(grip, `3.7 ...and a corner resize grip (${grip})`);

	// ------------------------------------------------- 4. the window drags
	const before = (await snap(A.page)).winRect;
	const hdr = await A.page.evaluate(() => {
		const el = document.querySelector('#shader-window .move-handle');
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
	});
	await drag(A.page, hdr, { x: hdr.x + 120, y: hdr.y + 60 });
	const after = (await snap(A.page)).winRect;
	h.check(
		Math.abs(after.x - before.x - 120) < 24 && Math.abs(after.y - before.y - 60) < 24,
		`4.1 the header drags the window (${before.x},${before.y} -> ${after.x},${after.y})`
	);

	// ------------------------- 5. Alt+S open / raise / hide, FLOATING
	// togglePanel step 3: a window already on top CLOSES, a buried one is RAISED. Both
	// halves need windowFocus to know this window by its key.
	s = await snap(A.page);
	h.check(s.closed === false && s.hasWin, `5.1 premise: floating and open`);
	await press(A.page, 'Alt+s');
	s = await snap(A.page);
	h.check(s.closed === true, `5.2 Alt+S hides a floating window that is on top (closed=${s.closed})`);
	await press(A.page, 'Alt+s');
	s = await snap(A.page);
	h.check(s.closed === false && s.hasWin, `5.3 ...and opens it again (closed=${s.closed}, window=${s.hasWin})`);
	// bury it under another floating window, then Alt+S must RAISE rather than close
	await A.page.evaluate(() => {
		localStorage.setItem('explorerDocked', 'false');
		window.__stores.bottomDock.armDockMode('explorer', false);
		window.__stores.explorerClose.set(false);
	});
	await A.page.waitForTimeout(800);
	const buried = await A.page.evaluate(() => {
		const w = document.getElementById('shader-window');
		const e = document.getElementById('explorer-window');
		if (!w || !e) return null;
		return { shader: parseInt(getComputedStyle(w).zIndex), expl: parseInt(getComputedStyle(e).zIndex) };
	});
	h.check(buried && buried.expl >= buried.shader, `5.4 premise: the Explorer window is above it (${JSON.stringify(buried)})`);
	await press(A.page, 'Alt+s');
	const raised = await A.page.evaluate(() => {
		const w = document.getElementById('shader-window');
		const e = document.getElementById('explorer-window');
		let c;
		window.__stores.shaderEditorClose.subscribe((v) => (c = v))();
		return {
			closed: c,
			shader: w ? parseInt(getComputedStyle(w).zIndex) : null,
			expl: e ? parseInt(getComputedStyle(e).zIndex) : null
		};
	});
	h.check(raised.closed === false, `5.5 Alt+S on a BURIED window does not close it (closed=${raised.closed})`);
	h.check(raised.shader >= raised.expl, `5.6 ...it raises it instead (shader z=${raised.shader}, explorer z=${raised.expl})`);
	await A.page.evaluate(() => window.__stores.explorerClose.set(true));
	await A.page.waitForTimeout(400);

	// ----------------------------------- 6. re-dock with the header button
	await A.page.evaluate(() => document.getElementById('shader-dock')?.click());
	await A.page.waitForTimeout(800);
	s = await snap(A.page);
	h.check(s.hasDock && !s.hasWin, `6.1 ⇩ Dock puts it back in the dock (dock=${s.hasDock}, window=${s.hasWin})`);
	h.check(s.visible === 'shader' && s.present, `6.2 ...as the visible tab (visible=${s.visible}, present=${s.present})`);
	h.check(s.docked === 'true', `6.3 ...and the mode is remembered (shaderDocked=${s.docked})`);

	// ------------------------------ 7. Alt+S open / hide, DOCKED
	await press(A.page, 'Alt+s');
	s = await snap(A.page);
	h.check(s.closed === true || s.visible !== 'shader', `7.1 Alt+S hides the visible dock tab (closed=${s.closed}, visible=${s.visible})`);
	await press(A.page, 'Alt+s');
	s = await snap(A.page);
	h.check(s.closed === false && s.visible === 'shader', `7.2 ...and brings it back (closed=${s.closed}, visible=${s.visible})`);
	// covered by a SIBLING tab: the press must re-activate, never close
	await A.page.evaluate(() => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(500);
	await press(A.page, 'Alt+s');
	s = await snap(A.page);
	h.check(s.closed === false && s.visible === 'shader', `7.3 covered by another tab, Alt+S brings it forward (visible=${s.visible})`);

	// -------------------------------------- 8. W7 drag-out and drag-in
	// Both paths are generic (`armDockMode` / `bottomDockable` over DOCK_FAMILY), so
	// they should work by construction — verified, not assumed.
	await A.page.evaluate(() => {
		window.__arms = [];
		window.__stores.bottomDock.dockModeArm.subscribe((/** @type {any} */ v) => {
			if (v) window.__arms.push(v);
		});
	});
	const tabBox = await tabCentre(A.page, 'shader');
	h.check(
		!!tabBox && tabBox.hits === 'shader',
		`8.0 premise: the pixel we grab IS the Shader tab (elementFromPoint=${tabBox && tabBox.hits})`
	);
	// well clear of the strip: OUT_MARGIN is 44px in every direction
	await drag(A.page, tabBox, { x: tabBox.x, y: Math.max(40, tabBox.y - 320) });
	s = await snap(A.page);
	const arms = await A.page.evaluate(() => window.__arms);
	h.check(s.hasWin && !s.hasDock, `8.1 dragging the tab out of the strip undocks it (window=${s.hasWin}, arms=${JSON.stringify(arms)})`);

	const hdr2 = await A.page.evaluate(() => {
		const el = document.querySelector('#shader-window .move-handle');
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
	});
	const band = await A.page.evaluate(() => window.innerHeight - 12);
	await drag(A.page, hdr2, { x: hdr2.x, y: band });
	s = await snap(A.page);
	h.check(s.hasDock && !s.hasWin, `8.2 dragging its header into the bottom band docks it again (dock=${s.hasDock})`);
	h.check(s.present === true, `8.3 ...and it is a tab once more (present=${s.present})`);

	// --------------------------------------------- 9. the mode survives a reload
	await A.page.evaluate(() => {
		window.__stores.bottomDock.armDockMode('shader', false);
	});
	await A.page.waitForTimeout(700);
	h.check((await snap(A.page)).hasWin, `9.1 premise: floating before the reload`);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.waitForTimeout(800);
	await press(A.page, 'Alt+s');
	s = await snap(A.page);
	h.check(s.hasWin && !s.hasDock, `9.2 it reopens FLOATING after a reload (window=${s.hasWin}, dock=${s.hasDock})`);
	h.check(s.present === false, `9.3 ...and a floating editor is not counted as a dock tab (present=${s.present})`);

	// ------------------------- 10. the shader GRAPH still works in the window
	// The window must be chrome around the real editor, not a second one.
	const graph = await A.page.evaluate(() => {
		const win = document.getElementById('shader-window');
		return {
			empty: !!win?.querySelector('#shader-empty-state'),
			create: !!win?.querySelector('#shader-create-btn'),
			palette: !!win?.querySelector('#shader-palette-toggle'),
			props: !!win?.querySelector('#shader-props-toggle')
		};
	});
	h.check(graph.palette && graph.props, `10.1 both sidebars render in the window (${JSON.stringify(graph)})`);
	h.check(graph.empty && graph.create, `10.2 the empty-state Create button is reachable there (${graph.create})`);
	await A.page.evaluate(() => document.querySelector('#shader-window #shader-create-btn')?.click());
	await A.page.waitForTimeout(700);
	const made = await A.page.evaluate(() => {
		let g;
		window.__stores.shaderGraph.shaderGraphs.subscribe((v) => (g = v))();
		const doc = g[window.__stores.shaderGraph.SCENE_GRAPH_KEY];
		return { nodes: doc ? doc.nodes.length : 0, edges: doc ? doc.edges.length : 0 };
	});
	h.check(made.nodes === 2 && made.edges === 1, `10.3 Create builds the starter graph from the window (${JSON.stringify(made)})`);
	const remove = await A.page.evaluate(() => !!document.querySelector('#shader-window #shader-remove'));
	h.check(remove, `10.4 ...and the Remove button appears in the floating header too (${remove})`);
	await A.page.evaluate(() => document.querySelector('#shader-window #shader-remove')?.click());
	await A.page.waitForTimeout(500);

	// close it cleanly, from the window's own ✕
	await A.page.evaluate(() => document.querySelector('#shader-window #shader-close')?.click());
	await A.page.waitForTimeout(500);
	s = await snap(A.page);
	h.check(s.closed === true && !s.hasWin, `10.5 the window's own ✕ closes it (closed=${s.closed})`);

	await h.finish(browser);
});
