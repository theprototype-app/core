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
	await A.page.setViewportSize({ width: 1280, height: 800 });
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

	// DESKTOP counterpart: on a fine pointer those buttons are revealed by HOVER, and
	// that was broken too — `styles/chat.css` (plain global CSS, therefore UNLAYERED)
	// carried a duplicate `.hidden { display: none }`, and unlayered beats anything in
	// Tailwind's @layer utilities whatever its specificity. So `group-hover/row:flex`
	// matched the row and still lost. Hovering with a REAL mouse here (a synthetic
	// event cannot produce :hover) fails if that duplicate ever comes back.
	const rowBox = await A.page.locator(`[id="${uuid}"]`).first().boundingBox();
	let hoverDisplay = 'no row';
	if (rowBox) {
		await A.page.mouse.move(rowBox.x + 20, rowBox.y + rowBox.height / 2);
		await A.page.waitForTimeout(300);
		hoverDisplay = await A.page.evaluate(
			(id) => getComputedStyle(document.getElementById(id).querySelector('.row-actions')).display,
			uuid
		);
	}
	h.check(hoverDisplay === 'flex', `hovering a row reveals its buttons on desktop (display=${hoverDisplay})`);
	await A.page.mouse.move(640, 700); // off the list again
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

	// The press that OPENS the menu is still down when it appears, so the menu's
	// outside-click backdrop mounts underneath that finger and the lift landed on it —
	// the menu flashed open and shut. The backdrop now closes only on a click whose
	// PRESS also landed on it. (`hold()` above cannot see this: synthetic events never
	// produce the backdrop's own click, which is exactly why the bug shipped.)
	const menuOpen = () =>
		A.page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.objectContextMenu.subscribe((/** @type {any} */ m) => r(!!m))()
				)
		);
	/** @param {boolean} withPress does the click get a matching pointerdown first? */
	const tapBackdrop = (withPress) =>
		A.page.evaluate((press) => {
			const backs = [...document.querySelectorAll('div[role="presentation"].fixed.inset-0')];
			const el = backs[backs.length - 1];
			if (!el) return 'no backdrop';
			if (press) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
			el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			return 'ok';
		}, withPress);
	await hold(700);
	await A.page.waitForTimeout(250);
	h.check(await menuOpen(), 'the long press leaves the row menu open');
	h.check((await tapBackdrop(false)) === 'ok', 'the menu renders an outside-click backdrop');
	await A.page.waitForTimeout(150);
	h.check(await menuOpen(), 'the finger LIFT that opened the menu does not close it again');
	await tapBackdrop(true);
	await A.page.waitForTimeout(150);
	h.check(!(await menuOpen()), 'a real outside tap — press AND click on the backdrop — closes it');

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

	// ---- the profile circle stays on top of its own menu ----------------------
	// No z-index can do this: flowbite 1.x renders a Dropdown as a TOP-LAYER popover
	// (`popover="manual"`, `:popover-open`), and the top layer paints above the whole
	// page whatever the z-index — measured, the panel at 996 covered an avatar at 2000,
	// and a screenshot showed the circle gone entirely. So the circle is drawn INSIDE
	// the panel, seated in the notch its 1.5rem top-right corner exists for. Two earlier
	// versions of this check compared z-index NUMBERS or asserted the stacking-context
	// premise; both passed while the user watched the menu swallow the circle. This one
	// opens the menu with a TRUSTED Playwright click (flowbite's trigger ignores
	// `el.click()` from evaluate) and asks what is actually at that position.
	await A.page.locator('#avatar-menu img, #avatar-menu [class*="rounded-full"]').first().click({ force: true });
	await A.page.waitForTimeout(700);
	const CIRCLE = '[aria-label="Close profile menu"]';
	const profile = await A.page.evaluate((sel) => {
		const panel = document.querySelector('[popover]:popover-open');
		const circle = panel?.querySelector(sel);
		if (!panel || !circle) return { open: !!panel, hasCircle: !!circle };
		const b = circle.getBoundingClientRect();
		const p = panel.getBoundingClientRect();
		const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
		return {
			open: true,
			hasCircle: true,
			onTop: !!hit?.closest(sel),
			// it has to sit ON the panel, not float above it: same top, same right edge
			seated: Math.abs(b.top - p.top) <= 2 && Math.abs(b.right - p.right) <= 2
		};
	}, CIRCLE);
	h.check(
		profile.open && profile.hasCircle,
		`the profile menu opens and carries its own avatar circle (${JSON.stringify(profile)})`
	);
	h.check(profile.onTop, 'the circle — not the menu under it — is what you see and click at that spot');
	h.check(profile.seated, 'the circle is seated in the panel top-right notch, matching the closed position');
	// clicking it closes the menu, like clicking the trigger again
	await A.page.locator(CIRCLE).first().click({ force: true });
	await A.page.waitForTimeout(400);
	const closed = await A.page.evaluate(() => !document.querySelector('[popover]:popover-open'));
	h.check(closed, 'clicking the circle closes the profile menu');

	// ...and the panel is ANCHORED to that circle. It used to anchor to #avatar-menu, an
	// invisible 208x0 flex box whose right edge merely coincides with the circle (both
	// inset 20px) — on a phone the coincidence broke and the menu slid to the window
	// edge. Desktop-Chromium at a phone-sized viewport does NOT reproduce that slide
	// (measured identical at 430/412/393/375/360/320), so this asserts the MECHANISM:
	// the trigger is the 48px circle, not a wide box. The phone itself is the user's
	// check. Also asserts the alignment at a narrow width, to catch future drift.
	await A.page.setViewportSize({ width: 393, height: 800 });
	await A.page.waitForTimeout(400);
	await A.page.locator('#avatar-trigger').first().click({ force: true });
	await A.page.waitForTimeout(600);
	const anchor = await A.page.evaluate(() => {
		const t = document.querySelector('#avatar-trigger')?.getBoundingClientRect();
		const p = document.querySelector('[popover]:popover-open')?.getBoundingClientRect();
		if (!t || !p) return null;
		return {
			trigger: [Math.round(t.width), Math.round(t.height)],
			rightGap: Math.round(p.right - t.right),
			topGap: Math.round(p.top - t.top),
			inset: Math.round(window.innerWidth - p.right)
		};
	});
	h.check(
		!!anchor && anchor.trigger[0] <= 60 && anchor.trigger[1] >= 40,
		`the dropdown's trigger is the avatar circle itself, not a wide invisible box (${JSON.stringify(anchor)})`
	);
	h.check(
		!!anchor && Math.abs(anchor.rightGap) <= 2 && Math.abs(anchor.topGap) <= 2 && anchor.inset >= 12,
		`on a narrow screen the panel seats on the circle and stays off the window edge (${JSON.stringify(anchor)})`
	);
	await A.page.locator(CIRCLE).first().click({ force: true });
	await A.page.waitForTimeout(300);
	await A.page.setViewportSize({ width: 1280, height: 800 });

	// ---- narrow: the sheet also outranks the LOGO, and only there -------------
	await A.page.setViewportSize({ width: 420, height: 780 });
	await A.page.evaluate(() => window.__stores.whatsNew.openWhatsNew());
	await A.page.waitForTimeout(800);
	const logoNarrow = await A.page.evaluate(() => {
		const z = (/** @type {string} */ sel) => {
			const el = document.querySelector(sel);
			return el ? parseInt(getComputedStyle(el).zIndex) || 0 : -1;
		};
		return { sheet: z('#whats-new-window'), logo: z('.burger'), marked: document.documentElement.classList.contains('wn-sheet') };
	});
	h.check(
		logoNarrow.marked && logoNarrow.sheet > logoNarrow.logo,
		`the full-screen sheet outranks the logo (${logoNarrow.sheet} > ${logoNarrow.logo})`
	);
	await A.page.evaluate(() => window.__stores.whatsNew.closeWhatsNew());
	await A.page.waitForTimeout(300);
	const logoRestored = await A.page.evaluate(() => ({
		logo: parseInt(getComputedStyle(document.querySelector('.burger')).zIndex) || 0,
		marked: document.documentElement.classList.contains('wn-sheet')
	}));
	h.check(
		!logoRestored.marked && logoRestored.logo > 1000,
		`closing it gives the logo its layer back (${logoRestored.logo})`
	);
	// WIDE: the logo keeps its layer — this is an ordinary floating window there
	await A.page.setViewportSize({ width: 1280, height: 800 });
	await A.page.evaluate(() => window.__stores.whatsNew.openWhatsNew());
	await A.page.waitForTimeout(700);
	const wide = await A.page.evaluate(() => ({
		logo: parseInt(getComputedStyle(document.querySelector('.burger')).zIndex) || 0,
		marked: document.documentElement.classList.contains('wn-sheet')
	}));
	h.check(
		!wide.marked && wide.logo > 1000,
		`on a wide screen the logo is untouched (${wide.logo}, marked=${wide.marked})`
	);
	await A.page.evaluate(() => window.__stores.whatsNew.closeWhatsNew());

	// ---- a window shoved off the RIGHT edge must not drag the chrome with it ----
	// The object-list window was the last `position: absolute` floating window. An
	// absolutely-positioned box parked past the right/bottom edge joins the document's
	// scroll overflow and GROWS the page — which on a phone slides the fixed chrome
	// (Connect bar, profile, corner HUD) sideways as you drag. Fixed windows, which is
	// what every other one already is, never contribute to that overflow. The page
	// growth below is the mechanism and is what this asserts; the visible chrome drift
	// is the mobile-browser consequence of it and is the user's on-device check.
	// a DOCKED object list is laid out by docking.js, not by its own drag handler, and
	// that state persists per key — start from floating so the drag below is a real move
	await A.page.evaluate(() => {
		localStorage.removeItem('dockedWindows');
		localStorage.removeItem('dockWidth:objects');
	});
	await A.page.setViewportSize({ width: 430, height: 800 });
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.objectActions, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(700);
	const pageSnap = () =>
		A.page.evaluate(() => {
			const at = (/** @type {string} */ sel) => {
				const el = document.querySelector(sel);
				if (!el) return null;
				const b = el.getBoundingClientRect();
				return `${Math.round(b.left)},${Math.round(b.top)}`;
			};
			const list = document.querySelector('#object-list').getBoundingClientRect();
			return {
				docW: document.documentElement.scrollWidth,
				docH: document.documentElement.scrollHeight,
				inner: window.innerWidth,
				listLeft: Math.round(list.left),
				listRight: Math.round(list.right),
				chrome: [at('.connect-pill') || at('.connect-wrap'), at('#avatar-menu'), at('#chat-button')].join('|')
			};
		});
	const preDrag = await pageSnap();
	// The drag is driven through the handler's own events rather than a real mouse: at
	// 430px the top chrome (logo, profile, notification buttons) covers this window's
	// whole header, so nothing on it is hit-testable — every real-mouse attempt grabbed
	// a BUTTON and moved nothing, which the premise check below caught. `movementX` is
	// part of MouseEventInit, so a synthesized pointermove drives the same code path.
	await A.page.evaluate(() => {
		const head = document.querySelector('#object-list .move-handle');
		head.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 100, clientY: 90 })
		);
		// clientX matters as well as movementX: the dock zones read the pointer, and moves
		// that carried the default clientX of 0 docked the window to the left edge instead
		// of moving it. Staying mid-screen keeps this a plain move.
		for (let i = 0; i < 5; i++)
			window.dispatchEvent(new PointerEvent('pointermove', { movementX: 40, clientX: 120 + i * 40, clientY: 90 }));
		// the LIFT decides docking (docking.js reads clientX on pointerup, and a default
		// of 0 reads as the left dock zone), so it lands mid-screen too. On a real phone
		// `(pointer: coarse)` disables edge docking entirely — this only bites headless.
		window.dispatchEvent(new PointerEvent('pointerup', { clientX: 280, clientY: 90 }));
	});
	await A.page.waitForTimeout(400);
	const postDrag = await pageSnap();
	h.check(
		postDrag.listLeft > preDrag.listLeft + 100 && postDrag.listRight > postDrag.inner + 20,
		`premise: the drag shoved the window right and off the edge (left ${preDrag.listLeft} -> ${postDrag.listLeft}, right ${postDrag.listRight} > ${postDrag.inner})`
	);
	h.check(
		postDrag.docW === postDrag.inner && postDrag.docH === preDrag.docH,
		`a window parked off the right edge does not grow the page (docW=${postDrag.docW}/${postDrag.inner}, docH=${postDrag.docH})`
	);
	h.check(
		postDrag.chrome === preDrag.chrome,
		`the Connect bar, profile and corner HUD stay put (${postDrag.chrome})`
	);
	await A.page.evaluate(() => {
		window.__stores.objectListClose.set(true);
		localStorage.removeItem('objectListRect');
	});
	await A.page.setViewportSize({ width: 1280, height: 800 });

	await h.finish(browser);
});
