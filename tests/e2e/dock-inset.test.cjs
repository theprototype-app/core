// Phase 105: dock-aware layout — the visible bottom dock publishes
// --bottom-inset; drawers and edge-docked windows end ABOVE it, tracking
// resizes; palette tabs mirror when the palette sits right.
const h = require('./helpers.cjs');

const inset = (page) =>
	page.evaluate(() =>
		parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset') || '0')
	);

// Phase 1 (controls dock rework), revised by W2 and again by W8a: where the bottom
// chrome sits is the user's call, and `floatingToolbar` is ON BY DEFAULT again after the
// on-device pass. ON — THE DEFAULT — the Controls pill and the play FAB in its well
// anchor on --bottom-inset and RIDE ABOVE the dock instead of covering its last ~60px.
// (The old --dock-inset model padded the DOCK's content and only did so at <=500px, so
// every wider screen had the pill over the node palette.) OFF, they stay pinned to the
// viewport floor on the bottom-HUD tier and an open dock passes over that band, exactly
// as it does over the chat / sim buttons beside them.
//   W8a also removed the `bottom` TRANSITION from both modes: the bar sliding as a dock
// opens read as distracting rather than as continuity, so it changes rows in the same
// frame the inset does. That is asserted two ways below — the computed property list,
// and the position being final one frame after a flip.
const bottomChrome = (page) =>
	page.evaluate(() => {
		const fabEl = document.getElementById('play-button');
		// 4b: the bar is our own <nav id="controls-pill">. It was flowbite's BottomNav
		// outer div (matched here as `div.rounded-full.z-45`) until the roster rewrite;
		// the id is stable where a resolved utility class list is not.
		const pillEl = document.querySelector('#controls-pill');
		const dockEl = document.querySelector('#flow-list');
		const fab = fabEl?.getBoundingClientRect();
		const pill = pillEl?.getBoundingClientRect();
		const dock = dockEl?.getBoundingClientRect();
		// who actually wins the pixel: a point INSIDE the pill but clear of the play FAB
		// in the middle of it (the FAB is the pill's own child and answers for itself)
		let hitIsDock = null;
		if (pill) {
			const el = document.elementFromPoint(
				Math.round(pill.left + 12),
				Math.round(pill.top + pill.height / 2)
			);
			hitIsDock = !!el?.closest('#flow-list');
		}
		// the same question for the play FAB, which carries its OWN inline
		// `z-index: var(--z-hud)`: the pill is positioned WITH a z-index, so it is a
		// stacking context and its child cannot escape it whatever it asks for. Measured
		// rather than argued — an inline z that outranked the dock would poke a 50px
		// circle through an open editor.
		let fabHitIsDock = null;
		if (fab) {
			const el = document.elementFromPoint(
				Math.round(fab.left + fab.width / 2),
				Math.round(fab.top + fab.height / 2)
			);
			fabHitIsDock = !!el?.closest('#flow-list');
		}
		return {
			fabHitIsDock,
			fabBottom: fab ? Math.round(fab.bottom) : 0,
			pillBottom: pill ? Math.round(pill.bottom) : 0,
			dockTop: dock ? Math.round(dock.top) : 0,
			pillZ: pillEl ? parseInt(getComputedStyle(pillEl).zIndex || '0') : 0,
			dockZ: dockEl ? parseInt(getComputedStyle(dockEl).zIndex || '0') : 0,
			hitIsDock,
			hasFab: !!fab,
			hasPill: !!pill,
			vh: window.innerHeight
		};
	});

/** flip the LOCAL floatingToolbar pref — the same store the Settings row binds to */
const setFloating = async (page, on) => {
	await page.evaluate((v) => window.__stores.floatingToolbar.set(v), on);
	await page.waitForTimeout(400);
};

/** ...and the same flip driven through the REAL Settings row, so the covered mode is
 *  asserted the way a user reaches it rather than through a store nobody can click.
 *  flowbite's Toggle keeps its real input `sr-only` under a painted track, so a
 *  POSITIONAL click lands on whatever overlays that spot — click the control itself,
 *  which fires the native click+change svelte's bind listens for (dock-chrome's idiom). */
const setFloatingViaSettings = async (page, on) => {
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForTimeout(500);
	await page.getByText('Interface', { exact: true }).first().click();
	await page.waitForTimeout(400);
	const row = page.locator('.setting-row').filter({ hasText: 'Floating toolbar' }).first();
	const toggle = row.locator('input[type="checkbox"]');
	// counted BEFORE the modal closes — a locator counted afterwards finds nothing,
	// which reads as "the row does not exist" rather than "the row has gone away"
	const found = { rows: await row.count(), toggles: await toggle.count(), was: await toggle.isChecked() };
	if (found.was !== on) await toggle.evaluate((el) => el.click());
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(500);
	return found;
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	h.check((await inset(A.page)) === 0, 'inset is 0 with the dock closed');

	// open the flow drawer -> inset = its height; sidebar ends above it
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(700);
	const flowH = (await A.page.locator('#flow-list').boundingBox()).height;
	h.check(Math.abs((await inset(A.page)) - flowH) < 2, `inset follows the dock height (${flowH})`);

	// ...and with the dock open, THE DEFAULT bottom chrome RIDES ABOVE it (measured here,
	// before the sidebar opens — an open sidebar shields the lower-left corner)
	const open = await bottomChrome(A.page);
	h.check(
		open.hasFab && open.hasPill && open.dockTop > 0,
		'pill, FAB and dock are all measurable'
	);
	h.check(
		open.fabBottom <= open.dockTop + 2,
		`W8a: by default the play FAB rides above the dock (${open.fabBottom} <= ${open.dockTop})`
	);
	h.check(
		open.pillBottom <= open.dockTop + 2,
		`...and so does the Controls pill (${open.pillBottom} <= ${open.dockTop})`
	);
	h.check(
		open.hitIsDock === false && open.pillZ > open.dockZ,
		`...winning its own pixel (z ${open.pillZ} > ${open.dockZ})`
	);

	// NO `bottom` transition. The property list alone cannot say so: with no
	// `transition` declared at all, `transitionProperty` computes to the INITIAL value
	// `all` — which looks like "everything animates" and means the opposite, because
	// the duration that goes with it is 0s. The pair is the honest reading.
	const trans = await A.page.evaluate(() => {
		const el = document.getElementById('controls-pill');
		if (!el) return null;
		const cs = getComputedStyle(el);
		return { prop: cs.transitionProperty, dur: cs.transitionDuration };
	});
	const animatesBottom =
		!!trans &&
		trans.prop
			.split(',')
			.map((p, i) => ({
				p: p.trim(),
				d: (trans.dur.split(',')[i] ?? trans.dur.split(',')[0] ?? '0s').trim()
			}))
			.some(({ p, d }) => (p === 'bottom' || p === 'all') && parseFloat(d) > 0);
	h.check(
		!animatesBottom,
		`W8a: the pill animates no 'bottom' transition (property "${trans?.prop}", duration "${trans?.dur}")`
	);
	// ...and demonstrated: one frame after the mode flips, the bar is ALREADY in its
	// final row. A 200ms slide would still be mid-flight at 120ms.
	await setFloating(A.page, false);
	await setFloating(A.page, true);
	await A.page.evaluate(() => window.__stores.floatingToolbar.set(false));
	await A.page.waitForTimeout(400);
	const floorBottom = (await bottomChrome(A.page)).pillBottom;
	await A.page.evaluate(() => window.__stores.floatingToolbar.set(true));
	await A.page.waitForTimeout(120);
	const early = (await bottomChrome(A.page)).pillBottom;
	await A.page.waitForTimeout(700);
	const settled = (await bottomChrome(A.page)).pillBottom;
	h.check(
		floorBottom !== settled,
		`premise: the two modes really do put the bar in different rows (${floorBottom} vs ${settled})`
	);
	h.check(
		early === settled,
		`...and it arrives in one step, not over 200ms (120ms: ${early}, settled: ${settled})`
	);

	// THE COVERED MODE, reached the way a user reaches it — the real Settings row.
	// It takes BOTH prefs since W8a, and that split is the point: "Floating toolbar"
	// decides which ROW the bar sits in, "Toolbar always on top" decides who wins the
	// pixel. Off + on-top ON is a legitimate combination of its own (the bar sits on the
	// floor and the dock passes BEHIND it); the dock only covers it when both are off.
	const rowInfo = await setFloatingViaSettings(A.page, false);
	h.check(rowInfo.rows === 1 && rowInfo.toggles === 1, 'Settings ▸ Interface has a "Floating toolbar" row with a real toggle');
	h.check(rowInfo.was === true, '...which reads ON by default');
	const floorOnly = await bottomChrome(A.page);
	h.check(
		floorOnly.pillBottom > floorOnly.dockTop && floorOnly.pillZ > floorOnly.dockZ,
		`geometry alone drops the bar into the dock's band but keeps its tier (z ${floorOnly.pillZ} > ${floorOnly.dockZ})`
	);
	await A.page.evaluate(() => window.__stores.toolbarAlwaysOnTop.set(false));
	await A.page.waitForTimeout(400);
	const covered = await bottomChrome(A.page);
	h.check(
		covered.vh - covered.pillBottom <= 18,
		`switched off, the pill stays on the viewport floor with the dock open (${covered.vh - covered.pillBottom}px clear)`
	);
	h.check(
		covered.pillBottom > covered.dockTop,
		`...i.e. inside the dock's band, not above it (${covered.pillBottom} > ${covered.dockTop})`
	);
	h.check(
		covered.pillZ < covered.dockZ,
		`the pill sits UNDER the dock's tier (z ${covered.pillZ} < ${covered.dockZ})`
	);
	h.check(covered.hitIsDock === true, 'and the dock owns the pixel over the pill');
	h.check(
		covered.fabHitIsDock === true,
		"...including over the play FAB, whose own z-index cannot escape the pill's stacking context"
	);
	// back to the defaults for the rest of the suite, which drives the Controls toolbar
	// with the dock open — precisely what the covered mode does not allow
	await A.page.evaluate(() => window.__stores.toolbarAlwaysOnTop.set(true));
	await setFloating(A.page, true);

	// 203: the sidebar now FLOATS ON TOP of the dock (z-hud) instead of ending
	// above it — it's a compact panel that is never covered by the dock
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(600);
	const layout = await A.page.evaluate(() => {
		const sb = document.querySelector('#sidebar70');
		const dock = document.querySelector('#flow-list');
		return {
			present: !!sb,
			sbZ: sb ? parseInt(getComputedStyle(sb).zIndex || '0') : 0,
			dockZ: dock ? parseInt(getComputedStyle(dock).zIndex || '0') : 0
		};
	});
	h.check(layout.present, 'the sidebar renders');
	h.check(layout.sbZ >= 40 && layout.sbZ > layout.dockZ, `sidebar floats on top of the dock (z ${layout.sbZ} > ${layout.dockZ})`);

	// resizing the dock updates the inset live
	const hot = await A.page.locator('#flow-list .resize-cue').first().boundingBox();
	await A.page.mouse.move(hot.x + 400, hot.y + 1);
	await A.page.mouse.down();
	await A.page.mouse.move(hot.x + 400, hot.y - 60, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const grown = await inset(A.page);
	h.check(Math.abs(grown - (flowH + 60)) < 12, `inset tracks the resize (${grown})`);

	// an edge-docked object list also ends above the dock
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => {
		const node = document.querySelector('#object-list');
		window.__stores; // hook warm
		// drag it to the left edge via the docking API is UI-driven; emulate the
		// drop by calling the action's path: pointer drag to x=2
	});
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(list.x + 100, list.y + 8);
	await A.page.mouse.down();
	await A.page.mouse.move(2, 300, { steps: 12 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(500);
	const dockedBox = await A.page.evaluate(() => {
		const node = document.querySelector('#object-list');
		const dock = document.querySelector('#flow-list')?.getBoundingClientRect();
		return {
			docked: node?.dataset.docked ?? null,
			bottom: node?.getBoundingClientRect().bottom ?? 0,
			dockTop: dock?.top ?? 0
		};
	});
	h.check(dockedBox.docked === 'left', 'object list edge-docked');
	h.check(
		dockedBox.bottom <= dockedBox.dockTop + 2,
		`edge-docked window ends above the dock (${Math.round(dockedBox.bottom)} <= ${Math.round(dockedBox.dockTop)})`
	);

	// closing the dock releases the inset
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(500);
	h.check((await inset(A.page)) === 0, 'inset returns to 0 when the dock closes');

	// ...and the bottom chrome drops back to the viewport bottom (FAB bottom:10px,
	// pill bottom:16px — the +2 slack absorbs sub-pixel rounding)
	await A.page.waitForTimeout(400); // the 200ms bottom transition, settled
	const shut = await bottomChrome(A.page);
	h.check(
		shut.vh - shut.fabBottom <= 12,
		`play FAB returns to the viewport bottom (${shut.vh - shut.fabBottom}px clear)`
	);
	h.check(
		shut.vh - shut.pillBottom <= 18,
		`Controls pill returns to the viewport bottom (${shut.vh - shut.pillBottom}px clear)`
	);

	// palette tabs mirror when the palette moves right
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(600);
	const before = await A.page.evaluate(() =>
		document.querySelector('#palette-toggle')?.classList.contains('palette-tab-mirrored')
	);
	await A.page.locator('#palette-side').click();
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate(() =>
		document.querySelector('#palette-toggle')?.classList.contains('palette-tab-mirrored')
	);
	h.check(before === false && after === true, 'palette tabs mirror on the right side');
	await A.page.locator('#palette-side').click();

	await h.finish(browser);
});
