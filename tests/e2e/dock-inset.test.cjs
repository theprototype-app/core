// Phase 105: dock-aware layout — the visible bottom dock publishes
// --bottom-inset; drawers and edge-docked windows end ABOVE it, tracking
// resizes; palette tabs mirror when the palette sits right.
const h = require('./helpers.cjs');

const inset = (page) =>
	page.evaluate(() =>
		parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset') || '0')
	);

// Phase 1 (controls dock rework), revised by W2: where the bottom chrome sits is the
// user's call now. `floatingToolbar` OFF — THE DEFAULT — leaves the Controls pill and
// the play FAB in its well pinned to the viewport floor on the bottom-HUD tier, where
// an open dock covers them exactly as it covers the chat / sim buttons beside them. ON,
// they anchor on --bottom-inset and RIDE ABOVE the dock instead of covering its last
// ~60px. (The old --dock-inset model padded the DOCK's content and only did so at
// <=500px, so every wider screen had the pill over the node palette.)
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
	await page.waitForTimeout(400); // the 200ms bottom transition, settled
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

	// ...and with the dock open, the DEFAULT bottom chrome stays on the viewport floor
	// and the dock covers it (measured here, before the sidebar opens — an open sidebar
	// shields the lower-left corner)
	const covered = await bottomChrome(A.page);
	h.check(
		covered.hasFab && covered.hasPill && covered.dockTop > 0,
		'pill, FAB and dock are all measurable'
	);
	h.check(
		covered.vh - covered.pillBottom <= 18,
		`W2: by default the pill stays on the viewport floor with the dock open (${covered.vh - covered.pillBottom}px clear)`
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

	// with the setting ON, the old ride-up behaviour, unchanged
	await setFloating(A.page, true);
	const open = await bottomChrome(A.page);
	h.check(
		open.fabBottom <= open.dockTop + 2,
		`floating toolbar: play FAB rides above the dock (${open.fabBottom} <= ${open.dockTop})`
	);
	h.check(
		open.pillBottom <= open.dockTop + 2,
		`floating toolbar: Controls pill rides above the dock (${open.pillBottom} <= ${open.dockTop})`
	);
	h.check(
		open.hitIsDock === false && open.pillZ > open.dockZ,
		`floating toolbar: the pill wins its own pixel (z ${open.pillZ} > ${open.dockZ})`
	);
	// ...and the setting STAYS on for the rest of the suite, deliberately: everything
	// below drives the Controls toolbar with the dock open, which is precisely what the
	// default no longer allows — the dock covers those buttons (proven three checks up).
	// That is the setting's whole purpose, so the sections about insets and edge-docked
	// windows use it rather than reaching for a test-only door.

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
