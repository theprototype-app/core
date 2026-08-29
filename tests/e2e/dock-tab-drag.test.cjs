// W7 — THE DOCK'S GESTURE HALF. Four capabilities, one gesture model:
//
//  1. the tab ORDER is user data (`dockTabOrder`, LOCAL + persisted). `DOCK_FAMILY`
//     is now only the order the app SHIPS with, and a key the stored list has never
//     seen is spliced in beside its siblings rather than dropped or pushed to the front.
//  2. the tab's right-click menu gained Move left / Move right, each disabled at its
//     end of the strip. That is also the TOUCH path — the drag stands down on a coarse
//     pointer, where a horizontal drag inside a 22px strip is the strip's own scroll.
//  3. DRAGGING a tab reorders it inside the strip and UNDOCKS it when released clear of
//     the strip (its rect inflated by 44px, the same reach docking.js gives an edge).
//     The promotion is 6px of TRAVEL, never a timer: a still press is what Android turns
//     into `contextmenu`, so a timer would race the long-press menu and eat it.
//  4. dragging a floating panel's header into the bottom BAND docks it again.
//
// PRECEDENCE, asserted in section 6 because three systems listen for the same drop:
// a header-merge target (windowTabs) beats everything — it is the smaller, more
// deliberate aim — then the bottom band, then docking.js's left/right edges.
//
// HAZARD this suite lives with: DockTabs renders inside EVERY docked panel and hides
// with a class, so ids and `.tab-note` repeat across the DOM. Every read and every
// click below is scoped to the VISIBLE panel.
const h = require('./helpers.cjs');

const VISIBLE_PANEL =
	'#flow-list, #explorer-list, #flow-code-dock, #uv-dock, #shader-editor, #hud-dock, #animation-dock';

const state = (page) =>
	page.evaluate((sel) => {
		const s = window.__stores;
		let tabs, occ, visible, order;
		s.bottomDock.dockTabs.subscribe((v) => (tabs = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.bottomDock.dockTabOrder.subscribe((v) => (order = v))();
		const panel = [...document.querySelectorAll(sel)].find((el) => !el.classList.contains('hidden'));
		const strip = panel
			? [...panel.querySelectorAll('[data-dock-tab]')].map((el) => el.dataset.dockTab)
			: [];
		return {
			tabs: tabs.map((t) => t.key),
			present: Object.keys(occ).filter((k) => occ[k]?.present).sort(),
			visible,
			order,
			strip,
			stored: JSON.parse(localStorage.getItem('dockTabOrder') ?? 'null'),
			flowWindow: !!document.querySelector('#flow-window'),
			uvWindow: !!document.querySelector('#uv-window')
		};
	}, VISIBLE_PANEL);

/** the centre of a tab in the VISIBLE panel's strip (ids repeat across hidden panels) */
const tabAt = (page, key) =>
	page.evaluate(
		([sel, k]) => {
			const panel = [...document.querySelectorAll(sel)].find((el) => !el.classList.contains('hidden'));
			const el = panel?.querySelector(`[data-dock-tab="${k}"]`);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return {
				x: Math.round(r.x + r.width / 2),
				y: Math.round(r.y + r.height / 2),
				left: Math.round(r.left),
				right: Math.round(r.right),
				bottom: Math.round(r.bottom)
			};
		},
		[VISIBLE_PANEL, key]
	);

/** a REAL mouse drag, stepped so pointermove actually fires (a single move can be
 * coalesced away, and the 6px promotion needs a move to see) */
async function drag(page, from, to, steps = 12) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + 10, from.y, { steps: 3 }); // clear the 6px threshold first
	await page.mouse.move(to.x, to.y, { steps });
	await page.waitForTimeout(120);
	await page.mouse.up();
	await page.waitForTimeout(600);
}

/** open a tab's context menu with a REAL right-click and read its rows */
async function tabMenuRows(page, key) {
	const at = await tabAt(page, key);
	if (!at) return null;
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await page.waitForTimeout(350);
	return page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].map((el) => ({
			label: el.textContent.trim(),
			// a disabled row is styled, not marked — ContextMenu's own `run()` early-returns
			// on `item.disabled`, and the class is the only thing the DOM shows for it
			disabled: el.className.includes('cursor-default')
		}))
	);
}

async function clickMenuRow(page, label) {
	const hit = await page.evaluate((lbl) => {
		const row = [...document.querySelectorAll('[role=menuitem]')].find(
			(e) => e.textContent.trim().toLowerCase() === lbl.toLowerCase()
		);
		if (!row || row.className.includes('cursor-default')) return false;
		row.click();
		return true;
	}, label);
	await page.waitForTimeout(600);
	return hit;
}

const closeMenus = async (page) => {
	await page.keyboard.press('Escape');
	await page.waitForTimeout(250);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- 0. premise: three views docked, the strip order is the shipped one ---
	await A.page.evaluate(() => {
		localStorage.removeItem('dockTabOrder');
		localStorage.setItem('flowDocked', 'true');
		localStorage.setItem('explorerDocked', 'true');
		localStorage.setItem('uvDocked', 'true');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.uvEditorClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(900);

	let d = await state(A.page);
	h.check(
		d.present.join(',') === 'explorer,flow,uv',
		`0.1 premise: three views are docked (${d.present.join(',')})`
	);
	h.check(
		d.strip.join(',') === 'flow,uv,explorer',
		`0.2 the strip is in DOCK_FAMILY order to start (${d.strip.join(',')})`
	);
	h.check(d.visible === 'flow', `0.3 the Node editor is showing (${d.visible})`);
	// the store persists its RESOLVED value on subscribe (bottomDockActive's own
	// precedent), so "untouched" is the shipped order written out, not an absent key —
	// which is also what heals a partial list left by an older release, once.
	h.check(
		d.stored?.join(',') === 'flow,flowcode,animation,uv,shader,hud,explorer',
		`0.4 untouched, the persisted order IS the shipped one (${JSON.stringify(d.stored)})`
	);

	// --- 1. the order model itself (resolveOrder's promise about an unknown key) ---
	const resolved = await A.page.evaluate(() => {
		const r = window.__stores.bottomDock.resolveOrder;
		return {
			// a stored order that predates 'hud' and 'uv' entirely
			partial: r(['explorer', 'flow']),
			// junk and duplicates
			dirty: r(['nope', 'flow', 'flow', 'explorer']),
			empty: r([])
		};
	});
	// the stored list put Explorer FIRST and Node editor second — a hand-made order, and
	// both positions have to survive being merged with five keys the list never saw
	h.check(
		resolved.partial[0] === 'explorer' && resolved.partial[1] === 'flow',
		`1.1 a partial stored order keeps every position it DID state (${resolved.partial.join(',')})`
	);
	h.check(
		resolved.partial.length === 7 &&
			resolved.partial.slice(2).join(',') === 'flowcode,animation,uv,shader,hud',
		`1.2 ...and the keys it never heard of come back beside their siblings, in family order, not at the front (${resolved.partial.join(',')})`
	);
	h.check(
		resolved.dirty.filter((k) => k === 'flow').length === 1 && !resolved.dirty.includes('nope'),
		`1.3 duplicates collapse and an unknown key is dropped (${resolved.dirty.join(',')})`
	);
	h.check(
		resolved.empty.join(',') === 'flow,flowcode,animation,uv,shader,hud,explorer',
		`1.4 an empty stored order resolves to the shipped one (${resolved.empty.join(',')})`
	);

	// --- 2. DRAG a tab across its neighbour — it reorders, and it persists ---
	let flowTab = await tabAt(A.page, 'flow');
	let uvTab = await tabAt(A.page, 'uv');
	h.check(!!flowTab && !!uvTab, '2.0 premise: both tabs are on screen to drag between');
	// drag Node editor to the RIGHT, past the UV editor's midpoint
	await drag(A.page, flowTab, { x: uvTab.right - 2, y: uvTab.y });
	d = await state(A.page);
	h.check(
		d.strip.join(',') === 'uv,flow,explorer',
		`2.1 dragging the Node editor past the UV editor reorders the strip (${d.strip.join(',')})`
	);
	h.check(
		d.tabs.join(',') === 'uv,flow,explorer',
		`2.2 ...and dockTabs agrees, so it is the store and not just the markup (${d.tabs.join(',')})`
	);
	h.check(
		Array.isArray(d.stored) && d.stored.indexOf('uv') < d.stored.indexOf('flow'),
		`2.3 ...and it is persisted (${JSON.stringify(d.stored)})`
	);
	h.check(d.visible === 'flow', `2.4 the drag did NOT change which tab is showing (${d.visible})`);

	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	// the close stores are not persisted, so a reload starts with every panel closed —
	// reopen the same three, which is also the point: the ORDER is what has to survive
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.uvEditorClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(1200);
	d = await state(A.page);
	h.check(
		d.strip.join(',') === 'uv,flow,explorer',
		`2.5 the order SURVIVES A RELOAD (${d.strip.join(',')})`
	);

	// --- 3. drag vs click: a press that never travels still activates ---
	// (both orders, because a sticky "that was a drag" flag would eat exactly one of them)
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('flow'));
	await A.page.waitForTimeout(500);
	let explTab = await tabAt(A.page, 'explorer');
	await A.page.mouse.click(explTab.x, explTab.y);
	await A.page.waitForTimeout(600);
	d = await state(A.page);
	h.check(d.visible === 'explorer', `3.1 a plain click still activates the tab (${d.visible})`);
	h.check(
		d.strip.join(',') === 'uv,flow,explorer',
		`3.2 ...and moved nothing (${d.strip.join(',')})`
	);
	// now a real drag, then a click again — the suppression must expire
	flowTab = await tabAt(A.page, 'flow');
	uvTab = await tabAt(A.page, 'uv');
	await drag(A.page, flowTab, { x: uvTab.left + 2, y: uvTab.y });
	d = await state(A.page);
	h.check(
		d.strip.join(',') === 'flow,uv,explorer',
		`3.3 the drag back reorders again (${d.strip.join(',')})`
	);
	h.check(
		d.visible === 'explorer',
		`3.4 ...and the drag did NOT activate the tab it grabbed (${d.visible})`
	);
	flowTab = await tabAt(A.page, 'flow');
	await A.page.mouse.click(flowTab.x, flowTab.y);
	await A.page.waitForTimeout(600);
	d = await state(A.page);
	h.check(d.visible === 'flow', `3.5 the very next plain click activates again (${d.visible})`);

	// A JITTERED click — the case the 6px threshold actually exists for. `mouse.click()`
	// emits no pointermove at all, so it never reaches the threshold and would pass with
	// ANY value; a real finger or mouse wobbles a pixel or two on the way down. 3px must
	// still read as a click.
	explTab = await tabAt(A.page, 'explorer');
	await A.page.mouse.move(explTab.x, explTab.y);
	await A.page.mouse.down();
	await A.page.mouse.move(explTab.x + 3, explTab.y + 1, { steps: 3 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(600);
	d = await state(A.page);
	h.check(
		d.visible === 'explorer',
		`3.6 a click that wobbles 3px is still a CLICK, not a drag (${d.visible})`
	);
	h.check(
		d.strip.join(',') === 'flow,uv,explorer',
		`3.7 ...and it moved nothing (${d.strip.join(',')})`
	);
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('flow'));
	await A.page.waitForTimeout(400);

	// --- 4. the menu's Move rows agree with the drag, and disable at the ends ---
	let rows = await tabMenuRows(A.page, 'flow');
	h.check(
		rows.some((r) => r.label === 'Move left') && rows.some((r) => r.label === 'Move right'),
		`4.1 the tab menu offers both Move rows (${rows.map((r) => r.label).join('|')})`
	);
	h.check(
		rows.find((r) => r.label === 'Move left')?.disabled === true,
		'4.2 Move left is DISABLED on the leftmost tab'
	);
	h.check(
		rows.find((r) => r.label === 'Move right')?.disabled === false,
		'4.3 ...and Move right is live there'
	);
	h.check(await clickMenuRow(A.page, 'Move right'), '4.4 Move right runs');
	d = await state(A.page);
	h.check(
		d.strip.join(',') === 'uv,flow,explorer',
		`4.5 ...and lands the tab exactly where the drag did (${d.strip.join(',')})`
	);
	await closeMenus(A.page);

	rows = await tabMenuRows(A.page, 'explorer');
	h.check(
		rows.find((r) => r.label === 'Move right')?.disabled === true,
		'4.6 Move right is DISABLED on the rightmost tab'
	);
	h.check(
		rows.find((r) => r.label === 'Move left')?.disabled === false,
		'4.7 ...and Move left is live there'
	);
	await closeMenus(A.page);
	// put it back for the sections below
	h.check(!!(await tabMenuRows(A.page, 'flow')), '4.8 premise: the menu opens on the Node editor');
	await clickMenuRow(A.page, 'Move left');
	d = await state(A.page);
	h.check(d.strip.join(',') === 'flow,uv,explorer', `4.9 Move left is its mirror (${d.strip.join(',')})`);
	await closeMenus(A.page);

	// --- 5. drag a tab OUT of the strip — it undocks ---
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('flow'));
	await A.page.waitForTimeout(500);
	flowTab = await tabAt(A.page, 'flow');
	// straight down into the panel body, well past the 44px margin under the strip
	await drag(A.page, flowTab, { x: flowTab.x, y: flowTab.bottom + 160 });
	d = await state(A.page);
	h.check(d.flowWindow, '5.1 dragging a tab out of the strip UNDOCKS it into a floating window');
	h.check(
		!d.present.includes('flow'),
		`5.2 ...so it is no longer a dock occupant (${d.present.join(',')})`
	);
	h.check(
		!d.strip.includes('flow') && d.strip.length === 2,
		`5.3 ...and it left the strip (${d.strip.join(',')})`
	);
	h.check(
		d.visible === 'uv' || d.visible === 'explorer',
		`5.4 ...and the dock fell back to a surviving tab (${d.visible})`
	);

	/**
	 * Where a floating window's `.move-handle` sits — and the pixel is only handed back
	 * once it RESOLVES to that handle. Undocking raises a toast, and the toast stack is
	 * composited right over the top of the screen where these headers live: a pointerdown
	 * that lands on `.tp-toast-text` never reaches `.move-handle`, so no drag starts and
	 * the whole gesture silently does nothing (measured — it is what made this section
	 * read as a dead feature). Waiting on the transient toast is the honest fix.
	 */
	async function headerAt(page, id) {
		for (let i = 0; i < 40; i++) {
			const at = await page.evaluate((sel) => {
				// clear the stack rather than outwait it: an undock raises a toast, and some
				// of this app's toasts are STICKY by design (they are never auto-dismissed)
				window.__stores.toastStore.set([]);
				const hd = document.querySelector(sel)?.querySelector('.move-handle');
				const r = hd?.getBoundingClientRect();
				if (!r) return null;
				const x = Math.round(r.x + r.width / 2);
				const y = Math.round(r.y + r.height / 2);
				const top = document.elementFromPoint(x, y);
				return {
					x,
					y,
					clear: !!top && !!top.closest('.move-handle'),
					// name whatever IS covering it — a grab that lands on the wrong element
					// reads exactly like a dead feature, so the failure has to say why
					blocker: top ? (top.id || top.className?.toString?.() || top.tagName).slice(0, 60) : 'nothing'
				};
			}, id);
			if (at?.clear) return { x: at.x, y: at.y };
			lastBlocker = at?.blocker ?? 'no header';
			await page.waitForTimeout(300);
		}
		return null;
	}
	let lastBlocker = '';

	// --- 6. drag the floating window's HEADER into the bottom band — it docks ---
	let from = await headerAt(A.page, '#flow-window');
	h.check(!!from, '6.0 premise: the Node editor is a lone floating window with a grabbable header');
	const bandY = await A.page.evaluate(() => window.innerHeight - 12);
	await drag(A.page, from, { x: 640, y: bandY });
	d = await state(A.page);
	h.check(
		d.present.includes('flow'),
		`6.1 dragging a floating panel into the bottom band DOCKS it (${d.present.join(',')})`
	);
	h.check(d.visible === 'flow', `6.2 ...and makes it the visible tab (${d.visible})`);
	h.check(!d.flowWindow, '6.3 ...and the floating window is gone');
	h.check(d.strip.includes('flow'), `6.4 ...and it is back in the strip (${d.strip.join(',')})`);

	// --- 7. the band does not steal an ordinary drag ---
	await A.page.evaluate(() => window.__stores.bottomDock.armDockMode('flow', false));
	await A.page.waitForTimeout(900);
	from = await headerAt(A.page, '#flow-window');
	h.check(!!from, '7.0 premise: the Node editor floats again');
	await drag(A.page, from, { x: 640, y: 300 });
	const moved = await headerAt(A.page, '#flow-window');
	// the PREMISE that makes 7.2 mean anything: a drop that leaves the window floating
	// reads identically to a gesture that never started at all, so prove it really dragged
	h.check(
		moved && Math.abs(moved.y - from.y) > 40,
		`7.1 premise: the window really followed the pointer (${from.y} -> ${moved?.y})`
	);
	d = await state(A.page);
	h.check(
		!d.present.includes('flow') && d.flowWindow,
		`7.2 a header dropped mid-screen leaves the window floating (${d.present.join(',')})`
	);

	// --- 8. PRECEDENCE: a header target beats the band, even INSIDE the band ---
	// Undock the UV editor and park it so its header sits DOWN IN THE BAND — the only
	// arrangement where the two rules genuinely compete. Merging must win: a header is a
	// small deliberate aim, the band is a strip of screen.
	// This section runs LAST on purpose. A merged pair draws TabStrips over the header
	// area, so the window it leaves behind has no `.move-handle` to grab and any later
	// drag in this file would silently do nothing (which is how 7.2 passed vacuously
	// when this section came first).
	// Get the Node editor UP first, and do it BEFORE the second window exists — these
	// windows are ~760px wide on a 1280px viewport, so whichever is parked lower covers
	// the other's header outright and the grab lands on the wrong window (measured: the
	// UV editor's empty-state panel, which is what `lastBlocker` is for).
	from = await headerAt(A.page, '#flow-window');
	h.check(!!from, `8.0a premise: the Node editor header is grabbable (blocked by: ${lastBlocker})`);
	await drag(A.page, from, { x: 640, y: 120 });
	await A.page.evaluate(() => window.__stores.bottomDock.armDockMode('uv', false));
	await A.page.waitForTimeout(900);
	// GROW THE BAND UP TO THE WINDOW rather than pushing the window down into the band.
	// Shoving a window to the bottom edge is undone twice over — dragWindow's "snap it
	// fully back on-screen" clamp reclaims it, and svelte re-applies its own `style:`
	// height on the next render — so the drop lands nowhere near a header and the test
	// reads as a broken feature (measured). The dock's height is shared and the band is
	// the dock's rect, so a tall dock puts the band under a window sitting at an
	// ordinary, stable position.
	await A.page.evaluate(() => {
		window.__stores.bottomDock.dockHeight.set(560);
		const el = document.querySelector('#uv-window');
		if (el) {
			el.style.left = '300px';
			el.style.top = '220px';
		}
	});
	await A.page.waitForTimeout(700);
	// re-read AFTER the settle, so what we assert is where it actually ended up
	const parked = await A.page.evaluate(() => {
		const el = document.querySelector('#uv-window');
		const hd = el?.querySelector('.move-handle');
		if (!hd) return null;
		let inset;
		window.__stores.bottomDock.bottomInset.subscribe((v) => (inset = v))();
		const r = hd.getBoundingClientRect();
		return {
			at: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
			bandTop: window.innerHeight - Math.max(inset, 44)
		};
	});
	h.check(!!parked, '8.0 premise: the UV editor is floating and parked low');
	h.check(
		parked.at.y >= parked.bandTop,
		`8.1 premise: its header really is INSIDE the dock band (y=${parked.at.y} band starts ${parked.bandTop})`
	);
	from = await headerAt(A.page, '#flow-window');
	h.check(!!from, `8.1b premise: the Node editor header is still grabbable (blocked by: ${lastBlocker})`);
	h.check(
		from && from.y < parked.bandTop,
		`8.1c premise: ...and it is being grabbed from OUTSIDE the band (y=${from?.y})`
	);
	await drag(A.page, from, parked.at);
	const merged = await A.page.evaluate(() => {
		// windowTabs is not on the debug hook; a merge shows in the DOM — the drop TARGET
		// becomes the inactive member and is display:none'd
		const uv = document.querySelector('#uv-window');
		return { uvHidden: uv?.style.display === 'none' };
	});
	d = await state(A.page);
	h.check(
		merged.uvHidden,
		'8.2 PRECEDENCE: dropped on another window HEADER inside the band, it MERGES into a tab group'
	);
	h.check(
		!d.present.includes('flow') && !d.present.includes('uv'),
		`8.3 ...and the band did NOT dock either window (${d.present.join(',')})`
	);

	// leave the dock as we found it
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.bottomDock.dockHeight.set(320);
		s.uvEditorClose.set(true);
		s.bottomDock.armDockMode('flow', true);
	});
	await A.page.waitForTimeout(900);

	// --- 9. the band must NOT swallow an edge dock it could never accept ---
	// docking.js stands its left/right edges down inside the band, so a DOCK_FAMILY panel
	// dropped in the bottom corner joins the dock instead of becoming a side panel. That
	// stand-down has to be SCOPED to windows the dock can actually take: the object list
	// edge-docks and can never be a tab, so an unscoped rule silently kills its drop in
	// the bottom strip of BOTH edges. That is the worst kind of regression — the drag
	// does nothing at all, which reads as the window ignoring you.
	await A.page.evaluate(() => {
		localStorage.removeItem('dockedWindows');
		window.__stores.objectListClose.set(false);
	});
	await A.page.waitForTimeout(800);
	const objDrop = await A.page.evaluate(() => {
		const el = document.querySelector('#object-list');
		const hd = el?.querySelector('.move-handle') ?? el;
		const r = hd?.getBoundingClientRect();
		let inset;
		window.__stores.bottomDock.bottomInset.subscribe((v) => (inset = v))();
		return {
			from: r
				? { x: Math.round(r.x + Math.min(60, r.width / 2)), y: Math.round(r.y + r.height / 2) }
				: null,
			// a right-edge drop DEEP inside the band: with the dock open the band starts at
			// vh - inset, so this y is unambiguously inside it
			to: { x: window.innerWidth - 8, y: window.innerHeight - 20 },
			bandTop: window.innerHeight - Math.max(inset, 44)
		};
	});
	h.check(!!objDrop.from, '9.0 premise: the object list is open with a grabbable header');
	h.check(
		objDrop.to.y >= objDrop.bandTop,
		`9.1 premise: the drop really is inside the dock band (y=${objDrop.to.y}, band starts ${objDrop.bandTop})`
	);
	await drag(A.page, objDrop.from, objDrop.to);
	const objDocked = await A.page.evaluate(() => {
		const el = document.querySelector('#object-list');
		const r = el?.getBoundingClientRect();
		return {
			side: el?.dataset?.docked ?? null,
			right: r ? Math.round(r.x + r.width) : 0,
			vw: window.innerWidth
		};
	});
	h.check(
		objDocked.side === 'right' && Math.abs(objDocked.right - objDocked.vw) < 6,
		`9.2 a window the dock cannot take still EDGE-docks from inside the band (docked=${objDocked.side} right=${objDocked.right}/${objDocked.vw})`
	);
	await A.page.evaluate(() => {
		localStorage.removeItem('dockedWindows');
		window.__stores.objectListClose.set(true);
	});
	await A.page.waitForTimeout(400);

	await h.finish(browser);
});
