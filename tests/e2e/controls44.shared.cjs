// 44 M4 / M11 / M12 / M13 / M14 — the user's preview-1-34 review of the toolbar, the corner clusters and the
// Connect pill (Controls.svelte, Connect.svelte, TouchTools.svelte):
//   M4  toolbar menu ▸ Move toolbar works on TOUCH: the finger drags the bar and the lift places it
//   M11 the Connect pill pinned to the top row + a sidebar open: its bottom corner on that side is square
//   M12 Edit positions: right-click / long press a cluster → Move, Reset position, Flip, Rotate 90° (the bar),
//       Hide cluster / Show all; the unpinned Connect pill's edit outline sits ON the pill (no gap to its "−")
//   M13 the top-left cluster (the row beside the logo) slides with a pinned left sidebar like the logo, and in
//       Edit positions beside any open left sidebar; no room on the top row → the Connect pill goes compact
//   M14 Connect's drawer has "Pin to top row" / "Float" — per shell (pinned on the unfolded phone, floating on
//       desktop), remembered, carried by layouts
// Desktop 1440×900 with a REAL mouse; the OPPO Find N6 UNFOLDED (770×850, DPR 2.9) with REAL touch (CDP) and
// FOLDED (390×896). Counterfactual: on origin/feat/43-int (the 1.34.0 candidate) each row is red.
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOT_DIR || null;
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
};
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('controlsLayout') ?? 'null'));
const centre = async (loc) => {
	const b = await loc.boundingBox();
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const rect = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
	}, sel);
const menuOpen = (page) => page.evaluate(() => !!document.querySelector('[role="menu"]'));
const menuRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
			.map((el) => ({ label: el.textContent.trim(), checked: el.className.includes('ctx-checked'), disabled: el.getAttribute('aria-disabled') === 'true' || el.className.includes('disabled') }))
			.filter((r) => r.label)
	);
async function closeMenus(page) {
	for (let i = 0; i < 3 && (await menuOpen(page)); i++) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(200);
	}
}
async function sidebar(page, { side = 'right', open = true, full = false, w = 320 } = {}) {
	await page.evaluate(({ side, open, full, w }) => {
		const S = window.__stores;
		S.sidebars.inspectorSide.set(side);
		S.inspectorKind.set('scene');
		S.inspectorClose.set(!open);
		S.sidebars.toggleSidebarFull('left', side === 'left' && full);
		S.sidebars.toggleSidebarFull('right', side === 'right' && full);
		S.sidebars.setSidebarWidth(side, w);
	}, { side, open, full, w });
	await page.waitForTimeout(800);
}
/** swap the stored toolbar record in place (no reload: 4-5 reloads in one tab kill headless Chromium) */
async function setBar(page, json) {
	await page.evaluate((v) => {
		if (v == null) localStorage.removeItem('controlsLayout');
		else localStorage.setItem('controlsLayout', v);
		window.__stores.uiLayoutsCore?.runLayoutReloaders();
	}, json);
	await page.waitForTimeout(600);
}
/** a short bar (so it has room to travel on the unfolded phone) */
const SHORT = JSON.stringify({ order: ['move', 'rotate', 'objects', 'explorer'], hidden: [], spacerIndex: 2, seen: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation'] });

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

/** real CDP touch helpers for a page */
async function touchKit(P) {
	const cdp = await P.context().newCDPSession(P);
	const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
	const tap = async (p) => {
		await touch('touchStart', p.x, p.y);
		await P.waitForTimeout(60);
		await touch('touchEnd');
		await P.waitForTimeout(350);
	};
	const hold = async (p, ms = 750) => {
		await touch('touchStart', p.x, p.y);
		await P.waitForTimeout(ms);
		await touch('touchEnd');
		await P.waitForTimeout(350);
	};
	/** a finger drag in `steps` moves, lifted at the end */
	const drag = async (from, to, steps = 12) => {
		await touch('touchStart', from.x, from.y);
		await P.waitForTimeout(80);
		for (let i = 1; i <= steps; i++) {
			await touch('touchMove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
			await P.waitForTimeout(30);
		}
		await touch('touchEnd');
		await P.waitForTimeout(400);
	};
	return { touch, tap, hold, drag };
}
/** tap / click a menu row by its label */
async function pickRow(P, label, kit) {
	const row = P.locator('[role="menu"] [role="menuitem"]', { hasText: label }).first();
	if (kit) await kit.tap(await centre(row));
	else await row.click();
	await P.waitForTimeout(350);
}

module.exports = (/** @type {string[]} */ parts) => {
	const want = (/** @type {string} */ key) => parts.includes(key) && (!ONLY.length || ONLY.includes(key));
	h.run(async () => {
		const browser = await h.launch();

		// ═══ M4 — Move toolbar on TOUCH (the N6 unfolded, real CDP touch) + the mouse path unchanged ═══
		if (want('m4')) {
			const A = await h.setupPage(browser, 'm4-unfolded', {
				context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
				storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
			});
			const P = A.page;
			const T = '[unfolded] ';
			const kit = await touchKit(P);
			await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
			await setBar(P, SHORT);
			const track = await P.evaluate(() => window.__toolbarTrack);
			h.check(track?.ok === true && track.max - track.min > 150, T + `premise: the short bar has room to travel (${Math.round(track?.min)}..${Math.round(track?.max)})`);
			const b0 = await rect(P, '#controls-pill');
			// long press a cell → the toolbar menu → Move toolbar
			const openMenu = async () => {
				for (let i = 0; i < 3 && !(await menuOpen(P)); i++) await kit.hold(await centre(P.locator('#controls-pill [title="Explorer"]')));
			};
			await openMenu();
			const rows = await menuRows(P);
			const mv = rows.find((r) => r.label === 'Move toolbar');
			h.check(!!mv && !mv.disabled, T + `M4: a long press offers Move toolbar, enabled (${rows.map((r) => r.label).join(' | ')})`);
			await pickRow(P, 'Move toolbar', kit);
			h.check(await P.locator('#toolbar-move-hint').isVisible(), T + 'M4: armed, the bar says how to place it (hint + Cancel)');
			await shot(P, 'm4-armed-unfolded');
			// a finger drags the bar: down on the bar, slide 170 px left, lift
			const from = { x: b0.cx, y: b0.cy };
			await kit.drag(from, { x: from.x - 170, y: from.y - 6 });
			let b1 = await rect(P, '#controls-pill');
			const moved = b0.cx - b1.cx;
			h.check(moved > 120, T + `M4: the finger dragged the bar left (${Math.round(b0.cx)} → ${Math.round(b1.cx)})`);
			h.check(!(await P.locator('#toolbar-move-hint').count()), T + 'M4: the lift placed it (the armed move ended)');
			const posX = (await stored(P))?.posX;
			h.check(typeof posX === 'number' && posX < 0.4, T + `M4: …and the place is stored (posX ${posX})`);
			await shot(P, 'm4-placed-unfolded');
			// the drag does not ALSO press the cell it lifted on (no panel opened)
			const opened = await P.evaluate(() => { let v; window.__stores.explorerClose.subscribe((x) => (v = x))(); return v === false; });
			h.check(!opened, T + 'M4: the lift did not press the button under the finger');
			// Cancel puts the bar back where it was
			await openMenu();
			await pickRow(P, 'Move toolbar', kit);
			const before = await rect(P, '#controls-pill');
			await kit.tap(await centre(P.locator('#toolbar-move-cancel')));
			const after = await rect(P, '#controls-pill');
			h.check(!(await P.locator('#toolbar-move-hint').count()) && Math.abs(after.cx - before.cx) < 2, T + `M4: Cancel ends the armed move, the bar stays (${Math.round(before.cx)} / ${Math.round(after.cx)})`);
			await P.evaluate(() => window.__stores.explorerClose.set(true));
			h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
			await setBar(P, null);
			await A.ctx.close();

			// the MOUSE path is unchanged: armed, the bar follows the pointer and a click places it
			const D = await h.setupPage(browser, 'm4-desk', { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toastsInDrawerOnly: 'true' } });
			const Q = D.page;
			const TD = '[desktop] ';
			await Q.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
			const d0 = await rect(Q, '#controls-pill');
			await Q.locator('#controls-pill [title="Explorer"]').click({ button: 'right' });
			await Q.waitForTimeout(300);
			const at = await Q.evaluate(() => { const m = document.querySelector('[role="menu"]').getBoundingClientRect(); return { x: m.left, y: m.top }; });
			await Q.getByRole('menuitem', { name: 'Move toolbar', exact: true }).click();
			await Q.waitForTimeout(300);
			h.check(await Q.locator('#toolbar-move-hint').isVisible(), TD + 'M4: armed by mouse, the hint shows too');
			const p0 = await Q.evaluate(() => window.__toolbarTrack);
			await Q.mouse.move(at.x, at.y);
			await Q.mouse.move(at.x - 200, at.y, { steps: 6 });
			await Q.waitForTimeout(200);
			const d1 = await rect(Q, '#controls-pill');
			h.check(d0.cx - d1.cx > 150, TD + `M4: the bar follows the mouse with no button held (${Math.round(d0.cx)} → ${Math.round(d1.cx)}, track ${Math.round(p0.min)}..${Math.round(p0.max)})`);
			await Q.mouse.click(at.x - 200, at.y);
			await Q.waitForTimeout(300);
			h.check(!(await Q.locator('#toolbar-move-hint').count()) && typeof (await stored(Q))?.posX === 'number', TD + 'M4: a click places it and stores it');
			h.check(h.pageErrors(D).length === 0, TD + `no page errors (${h.pageErrors(D).join(' / ')})`);
			await D.ctx.close();
		}

		// ═══ M14 + M13 (compact) — Connect "Pin to top row" / "Float", per shell; floating + crowded = compact ═══
		if (want('m14')) {
			const dock = (page) => page.evaluate(() => window.__connectDock);
			const ALL_ON = { order: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation'], hidden: [], spacerIndex: 5, seen: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation', 'notes', 'notifications', 'chat', 'mic', 'undo', 'redo', 'multiselect', 'ai', 'add'] };
			const CROWDED = JSON.stringify({ ...ALL_ON, left: [], right: [], top: ['notes', 'notifications', 'chat', 'mic'], touch: ['undo', 'redo', 'multiselect', 'ai'] });
			const SPARSE = JSON.stringify({ ...ALL_ON, top: [], touch: [] });
			/** does the pill overlap any wall of the top row? */
			const hits = (page) =>
				page.evaluate(() => {
					const pill = document.querySelector('.connect-pill').getBoundingClientRect();
					const out = [];
					for (const sel of ['#logo-menu', '#touch-tools', '#hud-tr', '#avatar-trigger']) {
						const el = document.querySelector(sel);
						const r = el?.getBoundingClientRect();
						if (!r || !r.width || !r.height) continue;
						if (sel === '#touch-tools' && el.classList.contains('tt-stacked')) continue;
						if (r.left < pill.right && r.right > pill.left && r.top < pill.bottom && r.bottom > pill.top) out.push(sel);
					}
					return out;
				});
			for (const theme of ['dark', 'light']) {
				const A = await h.setupPage(browser, 'm14-desk-' + theme, { context: { viewport: { width: 1440, height: 900 } }, storage: { theme, toastsInDrawerOnly: 'true' } });
				const P = A.page;
				const T = `[desktop ${theme}] `;
				await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
				let d = await dock(P);
				h.check(d && d.pinned === false && !d.docked && !d.squeezed, T + `M14: desktop default = floating, the pill centred (${JSON.stringify(d)})`);
				// M13: crowd the top row at 900 px → the floating pill goes COMPACT, never its own row
				await P.setViewportSize({ width: 900, height: 900 });
				await P.evaluate(() => window.__stores.touchTools.set(true));
				await setBar(P, CROWDED);
				await P.waitForTimeout(500);
				d = await dock(P);
				const pill = await rect(P, '.connect-pill');
				h.check(d.squeezed === true && d.docked === false && pill.width <= 120, T + `M13/M14: no room on the top row → compact (dot + chevron), not its own row (${Math.round(pill.width)} px, needs ${Math.round(d.naturalWidth)} in ${Math.round(d.available)})`);
				h.check((await hits(P)).length === 0 && !(await P.locator('.connect-pill input.cx-input').count()), T + `M13: compact, it overlaps nothing (${(await hits(P)).join(',') || 'clear'})`);
				await shot(P, `m14-compact-${theme}`);
				// the dot shows the full bar over the row; a press elsewhere puts it back
				await P.locator('#connect-squeeze-dot').click();
				await P.waitForTimeout(300);
				h.check(await P.locator('.connect-pill input.cx-input').isVisible(), T + 'M14: the dot shows the full bar (the dial field is there)');
				await shot(P, `m14-peek-${theme}`);
				await P.mouse.click(450, 500);
				await P.waitForTimeout(400);
				h.check((await dock(P)).squeezed && !(await P.locator('.connect-pill input.cx-input').count()), T + 'M14: a press elsewhere folds it back to compact');
				// the chevron still opens the drawer, readable width
				await P.locator('#connect-info-button').click();
				await P.waitForTimeout(400);
				const drawer = await rect(P, '[data-testid="connect-info-drawer"]');
				h.check(drawer && drawer.width >= 300, T + `M14: compact, the chevron opens a full-width drawer (${Math.round(drawer?.width)} px)`);
				await P.locator('#connect-info-button').click();
				await P.waitForTimeout(300);
				// room returns → the full pill again
				await setBar(P, SPARSE);
				await P.waitForTimeout(600);
				d = await dock(P);
				h.check(!d.squeezed && !d.docked && (await P.locator('.connect-pill input.cx-input').isVisible()), T + `M13: room returns → the full pill, centred (${JSON.stringify({ n: d.naturalWidth, a: d.available })})`);
				await setBar(P, null);
				await P.evaluate(() => window.__stores.touchTools.set(false));
				await P.setViewportSize({ width: 1440, height: 900 });
				await P.waitForTimeout(500);
				// the drawer's toggle: Float → Pinned
				await P.locator('#connect-info-button').click();
				await P.waitForTimeout(400);
				const tg = P.locator('#connect-pin-toggle');
				h.check((await tg.count()) === 1 && (await tg.getAttribute('aria-pressed')) === 'false', T + 'M14: the drawer has the "Pin to top row" toggle, off on desktop');
				await tg.click();
				await P.waitForTimeout(600);
				d = await dock(P);
				const bar = await rect(P, '.connect-pill');
				h.check(d.pinned && d.docked && bar.width >= 1430 && bar.top <= 1, T + `M14: pinned → its own full-width row along the top (${Math.round(bar.width)} px at ${Math.round(bar.top)})`);
				h.check((await P.evaluate(() => localStorage.getItem('connect:pin:desktop'))) === 'pinned' && (await P.evaluate(() => localStorage.getItem('connect:pin:touch'))) == null, T + 'M14: remembered for THIS shell only (desktop key, the touch key untouched)');
				await shot(P, `m14-pinned-${theme}`);
				// a layout carries it
				const saved = await P.evaluate(() => window.__stores.uiLayouts.saveLayout('M14'));
				const rec = await P.evaluate(() => JSON.parse(localStorage.getItem('uiLayouts')).find((l) => l.name === 'M14'));
				h.check(saved.ok && rec?.chrome?.desktop?.['connect:pin:desktop'] === 'pinned', T + 'M14: a saved layout carries the pin');
				await P.locator('#connect-pin-toggle').click();
				await P.waitForTimeout(600);
				h.check(!(await dock(P)).docked, T + 'M14: Float → back to the centred pill');
				await P.evaluate((id) => window.__stores.uiLayouts.applyLayout(id), rec.id);
				await P.waitForTimeout(800);
				h.check((await dock(P)).docked && (await dock(P)).pinned, T + 'M14: applying the layout pins it again');
				await P.evaluate((id) => window.__stores.uiLayouts.deleteLayout?.(id), rec.id).catch(() => {});
				await P.evaluate(() => localStorage.removeItem('connect:pin:desktop'));
				h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
				await A.ctx.close();
			}
			// the N6 UNFOLDED: pinned by default; the toggle floats it (real touch)
			{
				const A = await h.setupPage(browser, 'm14-unfolded', {
					context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
					storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
				});
				const P = A.page;
				const T = '[unfolded] ';
				const kit = await touchKit(P);
				await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
				let d = await dock(P);
				h.check(d.pinned === true && d.docked === true, T + 'M14: the unfolded phone pins it to the top row by default');
				await kit.tap(await centre(P.locator('#connect-info-button')));
				const tg = P.locator('#connect-pin-toggle');
				h.check((await tg.count()) === 1 && (await tg.getAttribute('aria-pressed')) === 'true', T + 'M14: the drawer toggle reads Pinned');
				await kit.tap(await centre(tg));
				await P.waitForTimeout(600);
				d = await dock(P);
				h.check(d.pinned === false && d.docked === false && (await hits(P)).length === 0, T + `M14: tapped → floating, ${d.squeezed ? 'compact' : 'centred'}, clear of the row (${JSON.stringify({ n: Math.round(d.naturalWidth), a: Math.round(d.available) })})`);
				h.check((await P.evaluate(() => localStorage.getItem('connect:pin:touch'))) === 'float', T + 'M14: remembered for the touch shell');
				await shot(P, 'm14-unfolded-float');
				h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
				await A.ctx.close();
			}
			// FOLDED: the phone shell's Connect is a chip + sheet — the toggle is not offered there
			{
				const A = await h.setupPage(browser, 'm14-folded', {
					context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
					storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
				});
				const P = A.page;
				const kit = await touchKit(P);
				await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
				await kit.tap(await centre(P.locator('#ps-connect-chip')));
				await P.waitForTimeout(500);
				h.check((await P.locator('[data-testid="connect-info-drawer"]').count()) >= 1 && (await P.locator('#connect-pin-toggle').count()) === 0, '[folded] M14: the Connection sheet shows the drawer without the pin toggle (the chip IS the top row)');
				await A.ctx.close();
			}
		}

		// ═══ M11 — pinned Connect bar + an open sidebar: the bottom corner on that side is square ═══
		if (want('m11')) {
			const radii = (page) => page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.connect-pill')); return { bl: parseFloat(cs.borderBottomLeftRadius), br: parseFloat(cs.borderBottomRightRadius) }; });
			for (const [label, ctx, storage] of [
				['unfolded', { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 }, {}],
				['desktop', { viewport: { width: 1440, height: 900 } }, { 'connect:pin:desktop': 'pinned' }]
			]) {
				const A = await h.setupPage(browser, 'm11-' + label, { context: ctx, storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}', ...storage } });
				const P = A.page;
				const T = `[${label}] `;
				await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
				h.check((await P.evaluate(() => window.__connectDock?.docked)) === true || (await P.evaluate(() => document.documentElement.classList.contains('connect-docked'))), T + 'premise: the Connect bar is pinned to the top row');
				let r = await radii(P);
				h.check(r.bl > 4 && r.br > 4, T + `M11: no sidebar → both bottom corners rounded (${r.bl}/${r.br})`);
				for (const full of [false, true]) {
					const how = full ? 'pinned' : 'open';
					await sidebar(P, { side: 'right', full, w: 300 });
					r = await radii(P);
					h.check(r.br === 0 && r.bl > 4, T + `M11: a right sidebar (${how}) → the bottom-RIGHT corner square, the left rounded (${r.bl}/${r.br})`);
					if (full) await shot(P, `m11-${label}-right-${how}`);
					await sidebar(P, { side: 'left', full, w: 300 });
					r = await radii(P);
					// 48 F5: an OPEN left column under the pinned bar starts below the logo's row (8a73b1c7) — the bar's
					// corner does not meet it there, so it stays rounded; a pinned one reaches the bar
					if (full) h.check(r.bl === 0 && r.br > 4, T + `M11: a left sidebar (${how}) → the bottom-LEFT corner square (${r.bl}/${r.br})`);
					else h.check(r.bl > 4 && r.br > 4, T + `M11 (48 F5): an open left sidebar starts below the logo band → both corners rounded (${r.bl}/${r.br})`);
				}
				// the corner pixel: what is drawn just inside the bar's bottom-right corner is the bar, not the scene
				await sidebar(P, { side: 'right', full: true, w: 300 });
				const sameAsBar = await P.evaluate(() => {
					const pill = document.querySelector('.connect-pill').getBoundingClientRect();
					const el = document.elementFromPoint(pill.right - 1.5, pill.bottom - 1.5);
					return !!el?.closest('.connect-pill');
				});
				h.check(sameAsBar, T + 'M11: the bar\'s bottom-right corner pixel belongs to the bar (no viewport through it)');
				await sidebar(P, { open: false });
				r = await radii(P);
				h.check(r.bl > 4 && r.br > 4, T + `M11: sidebars closed → rounded again (${r.bl}/${r.br})`);
				h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
				await A.ctx.close();
			}
		}

		// ═══ M13 — the row beside the logo slides with the left sidebar; Edit positions sits beside open sidebars ═══
		// ═══ M12 (gap) — the unpinned Connect pill's Edit-positions outline sits ON the pill ═══
		if (want('m13')) {
			const enterEdit = async (P) => {
				await P.locator('#controls-pill > div > [title="Explorer"]').click({ button: 'right' });
				await P.waitForTimeout(300);
				await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
				await P.waitForTimeout(900);
			};
			const A = await h.setupPage(browser, 'm13-desk', { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toastsInDrawerOnly: 'true' } });
			const P = A.page;
			const T = '[desktop] ';
			await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
			// GAP: Touch tools OFF, so entering Edit positions makes the row beside the logo appear and the pill slide
			await sidebar(P, { side: 'left', full: true, w: 360 });
			await enterEdit(P);
			const gap = await P.evaluate(() => {
				const pill = document.querySelector('.connect-pill').getBoundingClientRect();
				const out = document.querySelector('.hud-edit-connect')?.getBoundingClientRect();
				return out ? { dl: Math.abs(out.left - pill.left), dr: Math.abs(out.right - pill.right), dt: Math.abs(out.top - pill.top) } : null;
			});
			h.check(!!gap && gap.dl <= 1 && gap.dr <= 1 && gap.dt <= 1, T + `M12: in Edit positions the Connect outline (and its "−") sits ON the pill (off by ${JSON.stringify(gap)})`);
			await P.screenshot({ path: SHOTS ? `${SHOTS}/m12-connect-outline.png` : '/dev/null', clip: { x: 360, y: 0, width: 1080, height: 80 } }).catch(() => {});
			// the row beside the logo, in Edit positions, beside the PINNED left column
			let g = await P.evaluate(() => { let v; window.__stores.sidebars.geometry.subscribe((x) => (v = x))(); return v; });
			let tt = await rect(P, '#touch-tools');
			const logo = await rect(P, '#logo-menu');
			// beside the logo (78 + w) or, with no room there, stacked under it (14 + w) — either way beside the column
			h.check(tt && (Math.abs(tt.left - (78 + g.left.w)) <= 2 || Math.abs(tt.left - (14 + g.left.w)) <= 2), T + `M13: Edit positions, pinned left sidebar → the row beside the logo slides with it (${Math.round(tt?.left)}, logo ${Math.round(logo.left)}, column ${g.left.w})`);
			let st = await rect(P, '#hud-stack-left');
			h.check(st.left >= g.left.w + 8, T + `M13: …and the bottom-left stack's placeholders are beside it too (${Math.round(st.left)})`);
			await shot(P, 'm13-edit-left-pinned');
			await P.keyboard.press('Escape');
			await P.waitForTimeout(300);
			// outside Edit positions (Touch tools on): pinned → the row follows the logo
			await P.evaluate(() => window.__stores.touchTools.set(true));
			await P.waitForTimeout(500);
			tt = await rect(P, '#touch-tools');
			h.check(Math.abs(tt.left - (78 + g.left.w)) <= 2 || Math.abs(tt.left - (14 + g.left.w)) <= 2, T + `M13: pinned left sidebar → the row beside the logo slides with the logo (beside or stacked under it: ${Math.round(tt.left)})`);
			const pillHits = await P.evaluate(() => {
				const p = document.querySelector('.connect-pill').getBoundingClientRect();
				const t = document.getElementById('touch-tools').getBoundingClientRect();
				return t.left < p.right && t.right > p.left && t.top < p.bottom && t.bottom > p.top;
			});
			h.check(!pillHits, T + 'M13: …and the Connect pill keeps clear of it');
			// an OPEN (unpinned) left column starts below the logo's row: the row stays…
			await sidebar(P, { side: 'left', full: false, w: 360 });
			g = await P.evaluate(() => { let v; window.__stores.sidebars.geometry.subscribe((x) => (v = x))(); return v; });
			tt = await rect(P, '#touch-tools');
			h.check(Math.abs(tt.left - 78) <= 2, T + `M13: an unpinned left column below the row leaves the row in place (${Math.round(tt.left)})`);
			// …but in Edit positions every cluster sits beside it
			await enterEdit(P);
			tt = await rect(P, '#touch-tools');
			st = await rect(P, '#hud-stack-left');
			const colRight = g.leftX + g.left.w;
			h.check(tt.left >= colRight && st.left >= colRight + 8, T + `M13: Edit positions + an open left column → the row (${Math.round(tt.left)}) and the stack (${Math.round(st.left)}) beside it (${Math.round(colRight)})`);
			await P.keyboard.press('Escape');
			await sidebar(P, { side: 'right', full: false, w: 320 });
			await enterEdit(P);
			const sr = await rect(P, '#hud-stack-right');
			h.check(1440 - sr.right >= 320 + 8, T + `M13: …and the right stack beside an open right column (${Math.round(1440 - sr.right)} from the edge)`);
			await shot(P, 'm13-edit-right-open');
			await P.keyboard.press('Escape');
			await P.waitForTimeout(300);
			st = await rect(P, '#hud-stack-right');
			h.check(Math.abs(1440 - st.right - 16) <= 1, T + `M13: leaving Edit positions puts the stack back in its corner (${Math.round(1440 - st.right)})`);
			await sidebar(P, { open: false });
			await P.evaluate(() => window.__stores.touchTools.set(false));
			h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
			await A.ctx.close();
			// the N6 unfolded: a pinned left sidebar moves the row (touch tools are on by default on touch)
			const U = await h.setupPage(browser, 'm13-unfolded', {
				context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
				storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
			});
			const Q = U.page;
			await Q.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
			await sidebar(Q, { side: 'left', full: true, w: 280 });
			const ut = await rect(Q, '#touch-tools');
			const ul = await rect(Q, '#logo-menu');
			h.check(ut && ut.left >= 280 && ul.left >= 280, `[unfolded] M13: a pinned left sidebar slides the logo (${Math.round(ul.left)}) and its row (${Math.round(ut?.left)})`);
			await shot(Q, 'm13-unfolded-left-pinned');
			h.check(h.pageErrors(U).length === 0, `[unfolded] no page errors (${h.pageErrors(U).join(' / ')})`);
			await U.ctx.close();
		}

		// ═══ M12b — clusters: free anchored placement (snapping, no overlaps, relative across resize / fold), rotate,
		//            Reset position / Reset all, Hide / Show all, layouts carry it ═══
		if (want('m12')) {
			const enterEdit = async (P) => {
				await P.locator('#controls-pill > div > [title="Explorer"]').click({ button: 'right' });
				await P.waitForTimeout(300);
				await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
				await P.waitForTimeout(900);
			};
			const apply = async (P) => {
				await P.locator('#toolbar-edit-apply').click();
				await P.waitForTimeout(700);
			};
			const clusters = (P) => P.evaluate(() => window.__clusters);
			const rec = async (P) => (await stored(P))?.clusters ?? {};
			/** mouse-drag a cluster's grip by (dx, dy), reading the guides mid-drag */
			const dragGrip = async (P, id, dx, dy) => {
				const g = await centre(P.locator(`#cluster-grip-${id}`));
				await P.mouse.move(g.x, g.y);
				await P.mouse.down();
				await P.mouse.move(g.x + dx / 2, g.y + dy / 2, { steps: 5 });
				await P.mouse.move(g.x + dx, g.y + dy, { steps: 5 });
				await P.waitForTimeout(150);
				const guides = await P.locator('.cl-guide').count();
				await P.mouse.up();
				await P.waitForTimeout(500);
				return guides;
			};
			const clusterMenu = async (P, id) => {
				await P.locator(`#cluster-grip-${id}`).click();
				await P.waitForTimeout(350);
				return (await menuRows(P)).map((r) => r.label + (r.disabled ? ' (off)' : ''));
			};
			const overlapAny = (P, sel, others) =>
				P.evaluate(([s, o]) => {
					const a = document.querySelector(s)?.getBoundingClientRect();
					if (!a) return ['missing'];
					return o.filter((q) => {
						const b = document.querySelector(q)?.getBoundingClientRect();
						return b && b.width && b.height && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
					});
				}, [sel, others]);
			const ALL = ['#controls-pill', '#hud-stack-left', '#hud-stack-right', '#touch-tools', '#hud-tr', '.connect-pill', '#logo-menu', '#avatar-trigger'];

			const A = await h.setupPage(browser, 'm12-desk', { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toastsInDrawerOnly: 'true' } });
			const P = A.page;
			const T = '[desktop] ';
			await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
			await enterEdit(P);
			const grips = await P.evaluate(() => [...document.querySelectorAll('[data-cluster-grip]')].map((g) => g.dataset.clusterGrip).sort());
			h.check(['bar', 'connect', 'left', 'right', 'top', 'touch'].every((id) => grips.includes(id)), T + `M12b: Edit positions draws a grip on every cluster (${grips.join(',')})`);
			await shot(P, 'm12-edit-grips');
			// the menu: no flips; Move / Rotate / Reset / Reset all / Hide / Show all
			let rows = await clusterMenu(P, 'right');
			h.check(rows.includes('Move') && rows.includes('Rotate to horizontal') && rows.some((r) => r.startsWith('Reset position')) && rows.some((r) => r.startsWith('Reset all positions')) && rows.includes('Hide cluster') && !rows.some((r) => /flip/i.test(r)), T + `M12b: the cluster menu (no flips) — ${rows.join(' | ')}`);
			await closeMenus(P);
			rows = await clusterMenu(P, 'connect');
			h.check(!rows.some((r) => r.startsWith('Rotate')) && rows.some((r) => r === 'Pin to top row' || r === 'Float'), T + `M12b: the Connect bar does not rotate, it has Pin to top row / Float (${rows.join(' | ')})`);
			await closeMenus(P);
			rows = await clusterMenu(P, 'bar');
			h.check(rows.includes('Hide cluster (off)'), T + 'M12b: the toolbar cannot be hidden (Play lives there)');
			await closeMenus(P);
			// right-click on a placeholder opens its cluster's menu too
			// (the placeholders jiggle, which Playwright reads as never "stable": press at the centre instead)
			const ph = await centre(P.locator('#hud-stack-right [data-edit-wrap]').first());
			await P.mouse.click(ph.x, ph.y, { button: 'right' });
			await P.waitForTimeout(350);
			rows = (await menuRows(P)).map((r) => r.label);
			h.check(rows.includes('Rotate to horizontal'), T + 'M12b: a right-click on a placeholder opens its cluster menu');
			await closeMenus(P);

			// FREE PLACEMENT + SNAP: drag the right stack toward the window's centre line → snaps onto it (guide shown)
			const r0 = await rect(P, '#hud-stack-right');
			const target = 720 - r0.cx + 6; // 6 px off the centre line
			const guides = await dragGrip(P, 'right', target, -320);
			let r1 = await rect(P, '#hud-stack-right');
			h.check(Math.abs(r1.cx - 720) <= 1 && guides >= 1, T + `M12b: dropped near the centre line, it snaps onto it (centre ${Math.round(r1.cx)}, ${guides} guide line(s) while dragging)`);
			h.check((await overlapAny(P, '#hud-stack-right', ALL.filter((s) => s !== '#hud-stack-right'))).length === 0, T + 'M12b: …and overlaps nothing');
			// NO OVERLAP: drop the left stack ON the bar → nudged to the nearest free spot
			const bar = await rect(P, '#controls-pill');
			const l0 = await rect(P, '#hud-stack-left');
			await dragGrip(P, 'left', bar.cx - 120 - l0.cx, bar.cy - l0.cy);
			const hitsL = await overlapAny(P, '#hud-stack-left', ALL.filter((s) => s !== '#hud-stack-left'));
			h.check(hitsL.length === 0, T + `M12b: dropped on the toolbar, the left stack is nudged clear of it (${hitsL.join(',') || 'clear'})`);
			await shot(P, 'm12-placed-edit');
			// ✓ applies: stored as anchor + fractions
			await apply(P);
			let c = await rec(P);
			h.check(typeof c.right?.x === 'number' && typeof c.right?.y === 'number' && typeof c.right?.a === 'string' && Math.abs(c.right.x - 0.5) < 0.02, T + `M12b: ✓ stores the place as anchor + fractions (${JSON.stringify(c.right)})`);
			r1 = await rect(P, '#hud-stack-right');
			h.check(Math.abs(r1.cx - 720) <= 1, T + 'M12b: …and draws it there outside Edit positions');
			// RELATIVE across a resize: 1440 → 1100 → 1440
			const fr = (r, vw, vh) => ({ x: (r.left - 16) / (vw - 32 - r.width), y: (r.top - 16) / (vh - 32 - r.height) });
			const f0 = fr(r1, 1440, 900);
			await P.setViewportSize({ width: 1100, height: 760 });
			await P.waitForTimeout(800);
			const r2 = await rect(P, '#hud-stack-right');
			const f2 = fr(r2, 1100, 760);
			h.check(Math.abs(f2.x - f0.x) < 0.02 && Math.abs(f2.y - f0.y) < 0.03, T + `M12b: a smaller window keeps the RELATIVE place (${f0.x.toFixed(3)},${f0.y.toFixed(3)} → ${f2.x.toFixed(3)},${f2.y.toFixed(3)})`);
			await P.setViewportSize({ width: 1440, height: 900 });
			await P.waitForTimeout(800);
			const r3 = await rect(P, '#hud-stack-right');
			h.check(Math.abs(r3.cx - r1.cx) <= 1 && Math.abs(r3.top - r1.top) <= 1, T + `M12b: …and comes back to the same spot (${Math.round(r1.cx)},${Math.round(r1.top)} / ${Math.round(r3.cx)},${Math.round(r3.top)})`);
			// a PINNED sidebar narrows the area: an edge-glued cluster stays beside it, never under it
			await enterEdit(P);
			const tr0 = await rect(P, '#hud-tr');
			await dragGrip(P, 'top', 1440 - 16 - tr0.right + 4, 300); // glued to the right edge
			await apply(P);
			c = await rec(P);
			h.check(c.top?.x === 1, T + `premise: the top-right group is glued to the right edge (x ${c.top?.x})`);
			await sidebar(P, { side: 'right', full: true, w: 360 });
			let tr = await rect(P, '#hud-tr');
			h.check(tr.right <= 1440 - 360 - 15 && tr.right >= 1440 - 360 - 18, T + `M12b: a pinned right sidebar → the edge-glued group sits beside it (right ${Math.round(tr.right)})`);
			await sidebar(P, { open: false });
			tr = await rect(P, '#hud-tr');
			h.check(Math.abs(tr.right - (1440 - 16)) <= 1, T + 'M12b: unpinned → back on the window edge');
			// the DOCK: a cluster at the bottom stays above the visible dock
			await P.evaluate(() => window.__stores.explorerClose.set(false));
			await P.waitForTimeout(1000);
			const inset = await P.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset')) || 0);
			const st = await rect(P, '#hud-stack-left');
			h.check(inset > 100 ? st.bottom <= 900 - inset : true, T + `M12b: with the dock open (${inset}px) the placed stack stays above it (bottom ${Math.round(st.bottom)})`);
			await P.evaluate(() => window.__stores.explorerClose.set(true));
			await P.waitForTimeout(600);
			// ROTATE: the bar to vertical (a screen edge), the left stack to a row
			await enterEdit(P);
			await clusterMenu(P, 'bar');
			await pickRow(P, 'Rotate to vertical');
			await P.waitForTimeout(500);
			await clusterMenu(P, 'left');
			await pickRow(P, 'Rotate to horizontal');
			await P.waitForTimeout(500);
			await shot(P, 'm12-rotated-edit');
			await apply(P);
			const vb = await rect(P, '#controls-pill');
			const hl = await rect(P, '#hud-stack-left');
			h.check(vb.height > vb.width * 2 && vb.left <= 20, T + `M12b: the toolbar stands vertical on the left edge (${Math.round(vb.width)}×${Math.round(vb.height)} at x ${Math.round(vb.left)})`);
			h.check(hl.width > hl.height, T + `M12b: the left stack lies in a row (${Math.round(hl.width)}×${Math.round(hl.height)})`);
			h.check((await overlapAny(P, '#controls-pill', ALL.filter((s) => s !== '#controls-pill'))).length === 0, T + 'M12b: the vertical bar overlaps nothing');
			await shot(P, 'm12-rotated');
			// Play still works from the vertical bar
			h.check(await P.locator('#play-button').isVisible(), T + 'M12b: Play is on the vertical bar');
			// LAYOUTS carry place + orientation
			const saved = await P.evaluate(() => window.__stores.uiLayouts.saveLayout('M12b'));
			const lay = await P.evaluate(() => JSON.parse(localStorage.getItem('uiLayouts')).find((l) => l.name === 'M12b'));
			h.check(saved.ok && JSON.parse(lay.chrome.desktop.controlsLayout).clusters?.bar?.rotated === true, T + 'M12b: a saved layout carries the clusters (place + rotation)');
			// HIDE / SHOW ALL
			await enterEdit(P);
			await clusterMenu(P, 'top');
			await pickRow(P, 'Hide cluster');
			await apply(P);
			h.check(!(await P.locator('#hud-tr').isVisible()), T + 'M12b: Hide cluster hides the top-right group');
			await enterEdit(P);
			h.check(await P.locator('#cluster-grip-top').count(), T + 'M12b: …in Edit positions it is still there (faint) with its grip');
			rows = await clusterMenu(P, 'bar');
			h.check(rows.includes('Show all'), T + 'M12b: Show all is offered');
			await pickRow(P, 'Show all');
			await apply(P);
			h.check(await P.locator('#hud-tr').isVisible(), T + 'M12b: Show all brings it back');
			// RESET ALL positions (rotations stay); a reset applied layout brings the places back
			await enterEdit(P);
			await clusterMenu(P, 'right');
			await pickRow(P, 'Reset all positions');
			await apply(P);
			c = await rec(P);
			const sr = await rect(P, '#hud-stack-right');
			h.check(typeof c.right?.x !== 'number' && Math.abs(1440 - sr.right - 16) <= 1, T + `M12b: Reset all positions puts the stacks home (right stack ${Math.round(1440 - sr.right)} from the edge)`);
			h.check(c.bar?.rotated === true, T + 'M12b: …rotations stay');
			await P.evaluate((id) => window.__stores.uiLayouts.applyLayout(id), lay.id);
			await P.waitForTimeout(900);
			c = await rec(P);
			h.check(typeof c.right?.x === 'number' && c.left?.rotated === true, T + 'M12b: applying the layout brings the places and rotations back');
			// back to the default
			await setBar(P, null);
			await P.evaluate((id) => window.__stores.uiLayouts.deleteLayout?.(id), lay.id).catch(() => {});
			await P.waitForTimeout(500);
			const bb = await rect(P, '#controls-pill');
			h.check(Math.abs(bb.cx - 720) <= 2 && bb.bottom >= 900 - 20, T + 'premise: a cleared record = everything home');
			h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
			await A.ctx.close();

			// the N6 UNFOLDED, real touch: the grip drags by finger, a long press on a placeholder opens the menu,
			// and FOLD → UNFOLD keeps the relative place
			const U = await h.setupPage(browser, 'm12-unfolded', {
				context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
				storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
			});
			const Q = U.page;
			const TU = '[unfolded] ';
			const kit = await touchKit(Q);
			await Q.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
			for (let i = 0; i < 3 && !(await menuOpen(Q)); i++) await kit.hold(await centre(Q.locator('#controls-pill [title="Explorer"]')));
			await pickRow(Q, 'Edit positions', kit);
			await Q.waitForTimeout(800);
			h.check((await Q.locator('[data-cluster-grip]').count()) >= 5, TU + 'premise: Edit positions with grips on touch');
			await kit.hold(await centre(Q.locator('#hud-stack-left [data-edit-wrap]').first()), 800);
			rows = (await menuRows(Q)).map((r) => r.label);
			h.check(rows.includes('Rotate to horizontal') && rows.includes('Move'), TU + `M12b: a long press on a placeholder opens its cluster menu (${rows.join(' | ')})`);
			// a finger closes a menu by tapping outside it (on touch nothing holds the menu's keys, so no Escape) — and
			// that tap closes the MENU only, Edit positions stays
			await kit.tap({ x: 400, y: 300 });
			h.check(!(await menuOpen(Q)) && (await Q.locator('#toolbar-edit-apply').count()) === 1, TU + 'M12b: a tap outside closes the cluster menu and keeps Edit positions');
			const ul0 = await rect(Q, '#hud-stack-left');
			const gp = await centre(Q.locator('#cluster-grip-left'));
			await kit.drag(gp, { x: gp.x + 260, y: gp.y - 260 }, 14);
			const ul1 = await rect(Q, '#hud-stack-left');
			h.check(ul1.left - ul0.left > 200 && ul0.top - ul1.top > 200, TU + `M12b: a finger drags the grip — the stack follows (${Math.round(ul0.left)},${Math.round(ul0.top)} → ${Math.round(ul1.left)},${Math.round(ul1.top)})`);
			await kit.tap(await centre(Q.locator('#toolbar-edit-apply')));
			await Q.waitForTimeout(600);
			const fu0 = await rect(Q, '#hud-stack-left');
			const ff0 = fr(fu0, 770, 850);
			await Q.setViewportSize({ width: 390, height: 896 }); // FOLD → the phone shell
			await Q.waitForTimeout(1200);
			h.check(await Q.evaluate(() => document.documentElement.classList.contains('phone-shell')), TU + 'premise: folded = the phone shell');
			await Q.setViewportSize({ width: 770, height: 850 }); // UNFOLD
			await Q.waitForTimeout(1500);
			const fu1 = await rect(Q, '#hud-stack-left');
			const ff1 = fr(fu1, 770, 850);
			h.check(Math.abs(ff1.x - ff0.x) < 0.02 && Math.abs(ff1.y - ff0.y) < 0.02, TU + `M12b: fold → unfold keeps the stack's relative place (${ff0.x.toFixed(3)},${ff0.y.toFixed(3)} → ${ff1.x.toFixed(3)},${ff1.y.toFixed(3)})`);
			await shot(Q, 'm12-unfolded-placed');
			h.check(h.pageErrors(U).length === 0, TU + `no page errors (${h.pageErrors(U).join(' / ')})`);
			await U.ctx.close();
		}

		await h.finish(browser);
	});
};
