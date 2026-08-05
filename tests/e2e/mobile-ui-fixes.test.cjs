// Roadmap #9 small fixes: the object-list window clamps to the viewport (its
// subgroups were clipped off-screen on a narrow window), and context menus portal
// to <body> so the Flow menu escapes the flow window's stacking context (was
// trapped below other windows).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// #5: a rect persisted wide reopens clamped inside a narrow viewport
	await A.page.evaluate(() => localStorage.setItem('objectListRect', JSON.stringify({ left: 900, top: 80, width: 600, height: 400 })));
	await A.page.setViewportSize({ width: 520, height: 420 });
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.objectActions, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(500);
	const r = await A.page.evaluate(() => {
		const w = document.querySelector('#object-list').getBoundingClientRect();
		return { left: w.left, top: w.top, right: w.right, bottom: w.bottom, vw: window.innerWidth, vh: window.innerHeight };
	});
	h.check(
		r.left >= -1 && r.top >= -1 && r.right <= r.vw + 1 && r.bottom <= r.vh + 1,
		`object-list window clamps into the viewport (right=${Math.round(r.right)}/${r.vw}, bottom=${Math.round(r.bottom)}/${r.vh})`
	);

	// #6: context menus portal to <body> (so the Flow menu isn't trapped below windows)
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 60, y: 60, point: [0, 0, 0] }));
	await A.page.waitForTimeout(200);
	const portal = await A.page.evaluate(() => {
		const m = document.querySelector('[role="menu"]');
		return { inBody: !!m && m.parentElement === document.body, z: m ? parseInt(getComputedStyle(m).zIndex) : 0 };
	});
	h.check(portal.inBody, 'context menu is portaled to <body>');
	h.check(portal.z >= 1000, `context menu z is above the window tiers (z=${portal.z})`);
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// ---- object rows on TOUCH -------------------------------------------------
	// The row's eye / properties / share / delete buttons were reachable only on
	// HOVER, which a touch screen never produces, and a row had no long-press — so on
	// a phone a row offered nothing but select. (The CSS half is gated on
	// `(pointer: coarse)`, which cannot be emulated here; this covers the DOM and the
	// long-press logic.)
	const uuid = await A.page.evaluate(() => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.showSidebar('objects');
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	await A.page.waitForTimeout(700);
	const actions = await A.page.evaluate((id) => {
		const span = document.getElementById(id)?.querySelector('.row-actions');
		return {
			present: !!span,
			buttons: span?.querySelectorAll('button').length ?? 0,
			titles: [...(span?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('title'))
		};
	}, uuid);
	h.check(
		actions.present && actions.buttons >= 3,
		`an object row carries its per-row buttons (${JSON.stringify(actions.titles)})`
	);
	/** hold the row for `ms`, optionally dragging `move` px, and report the menu */
	const hold = (ms, move = 0) =>
		A.page.evaluate(
			async ({ id, ms, move }) => {
				const row = document.getElementById(id);
				window.__stores.objectContextMenu.set(null);
				const at = (/** @type {number} */ x, /** @type {string} */ type) =>
					row?.dispatchEvent(
						new PointerEvent(type, { pointerType: 'touch', clientX: x, clientY: 100, bubbles: true })
					);
				at(100, 'pointerdown');
				if (move) at(100 + move, 'pointermove');
				await new Promise((r) => setTimeout(r, ms));
				at(100 + move, 'pointerup');
				return new Promise((r) =>
					window.__stores.objectContextMenu.subscribe((/** @type {any} */ m) => r(m ? m.uuid : null))()
				);
			},
			{ id: uuid, ms, move }
		);
	h.check((await hold(700)) === uuid, 'a long press on a row opens its context menu');
	h.check((await hold(120)) === null, 'a quick tap does not — that is a select');
	h.check((await hold(700, 40)) === null, 'a press that MOVES is a scroll or drag, not a menu');
	const mousePress = await A.page.evaluate((id) => {
		const row = document.getElementById(id);
		window.__stores.objectContextMenu.set(null);
		row?.dispatchEvent(
			new PointerEvent('pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10, bubbles: true })
		);
		return new Promise((r) =>
			setTimeout(() => window.__stores.objectContextMenu.subscribe((/** @type {any} */ m) => r(m))(), 700)
		);
	}, uuid);
	h.check(mousePress === null, 'a MOUSE press never long-presses — right-click still owns that');

	// ---- narrow: the full-screen changelog covers the top-right chrome ---------
	// It is a floating window (z 40); at full screen the peers / notifications /
	// notes / profile buttons (997-999) floated on top of it.
	await A.page.setViewportSize({ width: 420, height: 780 });
	await A.page.evaluate(() => window.__stores.whatsNew.openWhatsNew());
	await A.page.waitForTimeout(800);
	const layering = await A.page.evaluate(() => {
		const z = (/** @type {any} */ sel) => {
			const el = document.querySelector(sel);
			return el ? parseInt(getComputedStyle(el).zIndex) || 0 : -1;
		};
		return { win: z('#whats-new-window'), chrome: z('.top-right-chrome') };
	});
	h.check(
		layering.win > layering.chrome && layering.chrome > 0,
		`the full-screen changelog sits above the top-right chrome (${layering.win} > ${layering.chrome})`
	);
	await A.page.evaluate(() => window.__stores.whatsNew.closeWhatsNew());
	await A.page.setViewportSize({ width: 1280, height: 800 });

	// ---- the profile avatar stays ON TOP of its own dropdown ------------------
	// Its z-index used to be written inside the CLASS attribute ("md:order-2;
	// z-index: 999;"), so it was a nonsense class name and the panel covered the very
	// circle its rounded corner is meant to tuck under.
	const profile = await A.page.evaluate(() => {
		const avatar = document.querySelector('#avatar-menu img, #avatar-menu [class*="rounded-full"]');
		const style = avatar ? getComputedStyle(avatar) : null;
		return { z: style ? parseInt(style.zIndex) || 0 : -1, position: style?.position ?? null };
	});
	h.check(
		profile.z >= 999 && profile.position === 'absolute',
		`the avatar is positioned and above the dropdown's 998 (z=${profile.z}, ${profile.position})`
	);

	await h.finish(browser);
});
