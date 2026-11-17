// 45 N1-N4 — the user's preview-1-35 review of the clusters (Controls.svelte, Connect.svelte, TouchTools.svelte,
// Users.svelte, Sidebar.svelte):
//   N1  a right-click (a long press on touch) on the Connect pill opens its cluster menu OUTSIDE Edit positions too:
//       Move, Pin to top row / Float, Reset position, Reset all — and Move really moves it
//   N2  the top-left cluster (the row beside the logo): "Show cluster" in Edit positions shows it on a desktop whose
//       default keeps it hidden (remembered = the Touch tools setting, layout chrome), and its grip drags it
//   N3  no animation on the top clusters, the burger (logo) and the profile when a sidebar opens / closes / hides:
//       no CSS transition on their position, and the position is final on the first layout read after the change
//   N4  the profile menu opens next to the profile button's CURRENT position (a pinned right sidebar moves it)
// Desktop 1440×900 with a REAL mouse; the OPPO Find N6 UNFOLDED (770×850, DPR 2.9) with REAL touch (CDP); FOLDED
// (390×896) where a row has a phone-shell meaning. Counterfactual: on origin/feat/44-int (1.35.0) each row is red.
// ONLY=n1,n2,n3,n4 runs a subset.
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
		if (!r.width || !r.height) return null;
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
	}, sel);
const menuOpen = (page) => page.evaluate(() => !!document.querySelector('[role="menu"]'));
const menuRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
			.map((el) => ({ label: el.textContent.trim(), disabled: el.getAttribute('aria-disabled') === 'true' || el.className.includes('disabled') }))
			.filter((r) => r.label)
	);
const labels = async (page) => (await menuRows(page)).map((r) => r.label + (r.disabled ? ' (off)' : ''));
async function closeMenus(page) {
	for (let i = 0; i < 3 && (await menuOpen(page)); i++) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(200);
	}
}
/** the row drawn where the placement engine put it, and near where it was dropped (the fractions of the free span keep
 *  a cluster's RELATIVE place, so a row that loses its edit "+" lands a few px off its edit-time left edge — 44's model) */
const atEngineBox = async (page, sel, id, drop, near = 40) => {
	const r = await rect(page, sel);
	const b = await page.evaluate((i) => window.__clusters?.boxes?.[i] ?? null, id);
	return { ok: !!r && !!b && Math.abs(r.left - b.left) <= 1 && Math.abs(r.top - b.top) <= 1 && Math.abs(r.cx - drop.cx) <= near && Math.abs(r.cy - drop.cy) <= near, r, b };
};
const store = (page, name) => page.evaluate((n) => { let v; window.__tp.test.v1[n].subscribe((x) => (v = x))(); return v; }, name);
async function touchKit(P) {
	const cdp = await P.context().newCDPSession(P);
	const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
	const tap = async (p) => {
		await touch('touchStart', p.x, p.y);
		await P.waitForTimeout(60);
		await touch('touchEnd');
		await P.waitForTimeout(350);
	};
	const hold = async (p, ms = 800) => {
		await touch('touchStart', p.x, p.y);
		await P.waitForTimeout(ms);
		await touch('touchEnd');
		await P.waitForTimeout(350);
	};
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
async function pickRow(P, label, kit) {
	const row = P.locator('[role="menu"] [role="menuitem"]', { hasText: label }).first();
	if (kit) await kit.tap(await centre(row));
	else await row.click();
	await P.waitForTimeout(400);
}
const enterEdit = async (P, kit) => {
	if (kit) {
		for (let i = 0; i < 3 && !(await menuOpen(P)); i++) await kit.hold(await centre(P.locator('#controls-pill [title="Explorer"]')));
		await pickRow(P, 'Edit positions', kit);
	} else {
		await P.locator('#controls-pill > div > [title="Explorer"]').click({ button: 'right' });
		await P.waitForTimeout(300);
		await P.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
	}
	await P.waitForTimeout(900);
};
const apply = async (P, kit) => {
	if (kit) await kit.tap(await centre(P.locator('#toolbar-edit-apply')));
	else await P.locator('#toolbar-edit-apply').click();
	await P.waitForTimeout(800);
};
const gripMenu = async (P, id, kit) => {
	if (kit) await kit.tap(await centre(P.locator(`#cluster-grip-${id}`)));
	else await P.locator(`#cluster-grip-${id}`).click();
	await P.waitForTimeout(400);
	return labels(P);
};
async function sidebar(page, { side = 'right', open = true, full = false, w = 320 } = {}) {
	await page.evaluate(({ side, open, full, w }) => {
		const S = window.__tp?.test.v1;
		S.sidebars.inspectorSide.set(side);
		S.inspectorKind.set('scene');
		S.inspectorClose.set(!open);
		S.sidebars.toggleSidebarFull('left', side === 'left' && full);
		S.sidebars.toggleSidebarFull('right', side === 'right' && full);
		S.sidebars.setSidebarWidth(side, w);
	}, { side, open, full, w });
	await page.waitForTimeout(800);
}
const DESK = { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toastsInDrawerOnly: 'true' } };
const UNFOLDED = {
	context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
	storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
};
const FOLDED = {
	context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
	storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}' }
};
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (key) => !ONLY.length || ONLY.includes(key);

h.run(async () => {
	const browser = await h.launch();
	const open = async (name, opts) => {
		const A = await h.setupPage(browser, name, opts);
		await A.page.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
		return A;
	};
	// a point on the pill that is no button and no field (the status dot) — a press there is the pill's alone
	const pillSpot = async (P) => {
		const dot = P.locator('.connect-pill #connect-status, .connect-pill .cx-status-dot').first();
		if ((await dot.count()) && (await dot.isVisible())) return centre(dot);
		return centre(P.locator('.connect-pill'));
	};

	// ═══ N1 — the Connect pill's cluster menu outside Edit positions ═══
	if (want('n1')) {
		const A = await open('n1-desk', DESK);
		const P = A.page;
		const T = '[desktop] ';
		h.check(!(await P.locator('#toolbar-edit-apply').count()) && (await P.evaluate(() => window.__connectDock?.pinned)) === false, T + 'premise: not in Edit positions, the pill floats (the desktop default)');
		const p0 = await rect(P, '.connect-pill');
		const at = await pillSpot(P);
		await P.mouse.click(at.x, at.y, { button: 'right' });
		await P.waitForTimeout(400);
		let rows = await labels(P);
		h.check(rows.join('|') === 'Move|Pin to top row|Reset position (off)|Reset all positions (off)', T + `N1: a right-click on the pill opens its cluster menu — ${rows.join(' | ') || '(no menu)'}`);
		await shot(P, 'n1-desk-menu');
		await closeMenus(P);
		// the dial field keeps its own (browser / paste) menu
		const field = P.locator('.connect-pill input.cx-input').first();
		if (await field.count()) {
			await field.click({ button: 'right' });
			await P.waitForTimeout(350);
			h.check(!(await menuOpen(P)), T + 'N1: a right-click in the dial field leaves it its own menu (no cluster menu)');
			await P.keyboard.press('Escape');
		}
		// Move: the pill follows the pointer, a click places it
		await P.mouse.click(at.x, at.y, { button: 'right' });
		await P.waitForTimeout(400);
		if (await menuOpen(P)) {
			await pickRow(P, 'Move');
			h.check(await P.locator('#cluster-move-hint').isVisible(), T + 'N1: Move arms the pill (the move hint says how to place it)');
			await P.mouse.move(at.x - 120, at.y + 120, { steps: 6 });
			await P.mouse.move(at.x - 260, at.y + 300, { steps: 6 });
			await P.waitForTimeout(200);
			await P.mouse.click(at.x - 260, at.y + 300);
			await P.waitForTimeout(800);
		}
		const p1 = await rect(P, '.connect-pill');
		const c = (await stored(P))?.clusters?.connect;
		h.check(!!p1 && p0.left - p1.left > 200 && p1.top - p0.top > 250, T + `N1: …and the pill moved there (${Math.round(p0.left)},${Math.round(p0.top)} → ${p1 ? Math.round(p1.left) + ',' + Math.round(p1.top) : 'gone'})`);
		h.check(typeof c?.x === 'number' && typeof c?.y === 'number', T + `N1: the place is stored with the record (${JSON.stringify(c)})`);
		await shot(P, 'n1-desk-moved');
		// Reset position from the same menu brings it home
		const at2 = await pillSpot(P);
		await P.mouse.click(at2.x, at2.y, { button: 'right' });
		await P.waitForTimeout(400);
		rows = await labels(P);
		h.check(rows.includes('Reset position') && rows.includes('Reset all positions'), T + `N1: placed, Reset position / Reset all are offered (${rows.join(' | ')})`);
		if (rows.includes('Reset position')) await pickRow(P, 'Reset position');
		await P.waitForTimeout(600);
		const p2 = await rect(P, '.connect-pill');
		h.check(!!p2 && Math.abs(p2.cx - p0.cx) <= 2 && Math.abs(p2.top - p0.top) <= 2 && typeof (await stored(P))?.clusters?.connect?.x !== 'number', T + 'N1: Reset position puts it back at the top centre');
		// Pin to top row / Float from the menu (per shell, remembered)
		await P.mouse.click(at.x, at.y, { button: 'right' });
		await P.waitForTimeout(400);
		if (await menuOpen(P)) await pickRow(P, 'Pin to top row');
		await P.waitForTimeout(600);
		h.check((await P.evaluate(() => localStorage.getItem('connect:pin:desktop'))) === 'pinned' && (await P.evaluate(() => window.__connectDock?.pinned)) === true, T + 'N1: Pin to top row pins it (remembered for the desktop shell)');
		const at3 = await pillSpot(P);
		await P.mouse.click(at3.x, at3.y, { button: 'right' });
		await P.waitForTimeout(400);
		rows = await labels(P);
		h.check(rows.includes('Move (off)') && rows.includes('Float'), T + `N1: pinned, Move is off and Float is offered (${rows.join(' | ')})`);
		if (rows.includes('Float')) await pickRow(P, 'Float');
		await P.waitForTimeout(600);
		h.check((await P.evaluate(() => window.__connectDock?.pinned)) === false, T + 'N1: Float floats it again');
		h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
		await A.ctx.close();

		// the N6 UNFOLDED: a long press (real touch) opens the menu; it pins by default there
		{
			const U = await open('n1-unfolded', UNFOLDED);
			const Q = U.page;
			const TU = '[unfolded] ';
			const kit = await touchKit(Q);
			h.check((await Q.evaluate(() => window.__connectDock?.pinned)) === true, TU + 'premise: the unfolded phone pins the pill to the top row');
			await kit.hold(await pillSpot(Q));
			rows = await labels(Q);
			h.check(rows.join('|') === 'Move (off)|Float|Reset position (off)|Reset all positions (off)', TU + `N1: a long press on the pill opens its cluster menu — ${rows.join(' | ') || '(no menu)'}`);
			await shot(Q, 'n1-unfolded-menu');
			if (rows.includes('Float')) await pickRow(Q, 'Float', kit);
			await Q.waitForTimeout(700);
			h.check((await Q.evaluate(() => localStorage.getItem('connect:pin:touch'))) === 'float', TU + 'N1: Float from the long-press menu (remembered for the touch shell)');
			// a quick tap on the pill is still a tap (no menu)
			await kit.tap(await pillSpot(Q));
			h.check(!(await menuOpen(Q)), TU + 'N1: a quick tap opens no menu');
			h.check(h.pageErrors(U).length === 0, TU + `no page errors (${h.pageErrors(U).join(' / ')})`);
			await U.ctx.close();
		}
	}

	// ═══ N2 — the row beside the logo: Show cluster on a default-hidden desktop, and its grip drags it ═══
	if (want('n2')) {
		const A = await open('n2-desk', DESK);
		const P = A.page;
		const T = '[desktop] ';
		h.check((await store(P, 'touchTools')) === false && !(await rect(P, '#touch-tools')), T + 'premise: a desktop hides the row beside the logo by default');
		await enterEdit(P);
		h.check(!!(await rect(P, '#cluster-grip-touch')), T + 'premise: Edit positions draws the row with its grip');
		let rows = await gripMenu(P, 'touch');
		h.check(rows.includes('Show cluster') && !rows.includes('Hide cluster'), T + `N2: hidden by default, its menu offers Show cluster (${rows.join(' | ')})`);
		const faint0 = await P.evaluate(() => getComputedStyle(document.getElementById('touch-tools')).opacity);
		if (rows.includes('Show cluster')) await pickRow(P, 'Show cluster');
		const faint1 = await P.evaluate(() => getComputedStyle(document.getElementById('touch-tools')).opacity);
		h.check(faint0 === '0.35' && faint1 === '1', T + `N2: the placeholder is drawn faint while hidden and full once shown (${faint0} → ${faint1})`);
		rows = await gripMenu(P, 'touch');
		h.check(rows.includes('Hide cluster'), T + `N2: …and its menu now offers Hide cluster (${rows.join(' | ')})`);
		await closeMenus(P);
		// THE GRIP DRAGS IT, live
		const r0 = await rect(P, '#touch-tools');
		const g = await centre(P.locator('#cluster-grip-touch'));
		await P.mouse.move(g.x, g.y);
		await P.mouse.down();
		await P.mouse.move(g.x + 150, g.y + 120, { steps: 5 });
		await P.mouse.move(g.x + 330, g.y + 260, { steps: 5 });
		await P.waitForTimeout(150);
		const rMid = await rect(P, '#touch-tools');
		await P.mouse.up();
		await P.waitForTimeout(600);
		const r1 = await rect(P, '#touch-tools');
		h.check(!!rMid && rMid.left - r0.left > 250 && rMid.top - r0.top > 200, T + `N2: the row follows its grip while dragged (${Math.round(r0.left)},${Math.round(r0.top)} → ${rMid ? Math.round(rMid.left) + ',' + Math.round(rMid.top) : '?'})`);
		h.check(!!r1 && r1.left - r0.left > 250 && r1.top - r0.top > 200, T + `N2: …and stays where it was dropped (${r1 ? Math.round(r1.left) + ',' + Math.round(r1.top) : '?'})`);
		await shot(P, 'n2-desk-dragged');
		await apply(P);
		const e2 = await atEngineBox(P, '#touch-tools', 'touch', r1);
		h.check(e2.ok, T + `N2: ✓ shows the row there outside Edit positions (${e2.r ? Math.round(e2.r.left) + ',' + Math.round(e2.r.top) : 'gone'}; engine ${e2.b ? Math.round(e2.b.left) + ',' + Math.round(e2.b.top) : '?'}; dropped ${Math.round(r1.left)},${Math.round(r1.top)})`);
		h.check((await store(P, 'touchTools')) === true && (await P.evaluate(() => localStorage.getItem('touchTools'))) === 'true', T + 'N2: remembered — the Touch tools setting is on (layout chrome: a saved layout carries it)');
		const c = (await stored(P))?.clusters?.touch;
		h.check(typeof c?.x === 'number' && typeof c?.y === 'number' && !c.hidden, T + `N2: the place is stored (${JSON.stringify(c)})`);
		await shot(P, 'n2-desk-applied');
		// rotate works on this row too (its column rule lost to the component's own style before)
		await enterEdit(P);
		rows = await gripMenu(P, 'touch');
		if (rows.includes('Rotate to vertical')) await pickRow(P, 'Rotate to vertical');
		const dir = await P.evaluate(() => getComputedStyle(document.getElementById('touch-tools')).flexDirection);
		h.check(dir === 'column', T + `N2: Rotate to vertical stands the row in a column (${dir})`);
		rows = await gripMenu(P, 'touch');
		if (rows.includes('Rotate to horizontal')) await pickRow(P, 'Rotate to horizontal');
		// Hide cluster → ✓ hides it (Touch tools off); Show then Cancel changes nothing
		rows = await gripMenu(P, 'touch');
		if (rows.includes('Hide cluster')) await pickRow(P, 'Hide cluster');
		await apply(P);
		h.check(!(await rect(P, '#touch-tools')) && (await store(P, 'touchTools')) === false, T + 'N2: Hide cluster + ✓ hides the row (Touch tools off)');
		await enterEdit(P);
		rows = await gripMenu(P, 'touch');
		if (rows.includes('Show cluster')) await pickRow(P, 'Show cluster');
		await P.keyboard.press('Escape'); // cancels Edit positions
		await P.waitForTimeout(600);
		h.check((await P.locator('#toolbar-edit-apply').count()) === 0 && (await store(P, 'touchTools')) === false && !(await rect(P, '#touch-tools')), T + 'N2: Show cluster then Cancel leaves the row hidden');
		// Show all brings it back too
		await enterEdit(P);
		await gripMenu(P, 'right');
		rows = await labels(P);
		h.check(rows.includes('Show all'), T + `N2: Show all is offered while the row is hidden (${rows.join(' | ')})`);
		if (rows.includes('Show all')) await pickRow(P, 'Show all');
		await apply(P);
		h.check(!!(await rect(P, '#touch-tools')) && (await store(P, 'touchTools')) === true, T + 'N2: Show all + ✓ shows the row');
		h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
		await A.ctx.close();

		// the N6 UNFOLDED (Touch tools on by default there): a finger on the row's grip drags it
		{
			const U = await open('n2-unfolded', UNFOLDED);
			const Q = U.page;
			const TU = '[unfolded] ';
			const kit = await touchKit(Q);
			h.check((await store(Q, 'touchTools')) === true && !!(await rect(Q, '#touch-tools')), TU + 'premise: the row beside the logo shows on touch');
			await enterEdit(Q, kit);
			const u0 = await rect(Q, '#touch-tools');
			const gp = await centre(Q.locator('#cluster-grip-touch'));
			await kit.drag(gp, { x: gp.x + 180, y: gp.y + 300 }, 14);
			const u1 = await rect(Q, '#touch-tools');
			h.check(!!u0 && !!u1 && u1.left - u0.left > 120 && u1.top - u0.top > 220, TU + `N2: a finger drags the row by its grip (${u0 ? Math.round(u0.left) + ',' + Math.round(u0.top) : '?'} → ${u1 ? Math.round(u1.left) + ',' + Math.round(u1.top) : '?'})`);
			await apply(Q, kit);
			const e2 = await atEngineBox(Q, '#touch-tools', 'touch', u1);
			h.check(e2.ok, TU + `N2: …and ✓ keeps it there (${e2.r ? Math.round(e2.r.left) + ',' + Math.round(e2.r.top) : 'gone'}; engine ${e2.b ? Math.round(e2.b.left) + ',' + Math.round(e2.b.top) : '?'}; dropped ${u1 ? Math.round(u1.left) + ',' + Math.round(u1.top) : '?'})`);
			await shot(Q, 'n2-unfolded-dragged');
			h.check(h.pageErrors(U).length === 0, TU + `no page errors (${h.pageErrors(U).join(' / ')})`);
			await U.ctx.close();
		}
	}

	// ═══ N3 — no animation on the top clusters, the logo and the profile when a sidebar opens / closes / hides ═══
	if (want('n3')) {
		// One page script per step: change the sidebar, let svelte flush (a task, before any frame on this box),
		// then read (1) every running CSS transition on the movers and their ancestors, (2) the rects at once,
		// (3) the rects one frame later and (4) settled (700 ms). Under a transition (2) is the OLD place.
		const STEP = async (P, step) =>
			P.evaluate(async (step) => {
				const S = window.__tp?.test.v1;
				const SELS = ['#logo-menu', '#touch-tools', '#hud-tr', '#avatar-trigger', '.connect-pill'];
				const read = () => Object.fromEntries(SELS.map((s) => {
					const r = document.querySelector(s)?.getBoundingClientRect();
					return [s, r && r.width ? [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10] : null];
				}));
				if (step === 'pin-left') {
					S.sidebars.inspectorSide.set('left');
					S.inspectorKind.set('scene');
					S.inspectorClose.set(false);
					S.sidebars.toggleSidebarFull('left', true);
				} else if (step === 'pin-right') {
					S.sidebars.toggleSidebarFull('left', false);
					S.sidebars.inspectorSide.set('right');
					S.sidebars.toggleSidebarFull('right', true);
				} else if (step === 'close') {
					S.inspectorClose.set(true);
				}
				await new Promise((r) => setTimeout(r, 0));
				const running = [];
				for (const s of SELS) {
					for (let n = document.querySelector(s); n && n !== document.body; n = n.parentElement) {
						for (const a of n.getAnimations?.() ?? []) {
							if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition && ['left', 'right', 'top', 'transform'].includes(a.transitionProperty) && a.playState === 'running') running.push(`${n.id || n.className.split(' ')[0]}:${a.transitionProperty}`);
						}
					}
				}
				const now = read();
				await new Promise((r) => requestAnimationFrame(() => r()));
				const frame = read();
				await new Promise((r) => setTimeout(r, 700));
				const settled = read();
				const props = Object.fromEntries(['#logo-menu', '#touch-tools', '.top-right-chrome', '.connect-wrap'].map((s) => {
					const el = document.querySelector(s);
					if (!el) return [s, null];
					const cs = getComputedStyle(el);
					const names = cs.transitionProperty.split(',').map((x) => x.trim());
					const durs = cs.transitionDuration.split(',').map((x) => parseFloat(x) || 0);
					// a position property (or `all`) with a duration — the lists repeat to the longer one's length
					return [s, names.filter((n, i) => ['left', 'right', 'top', 'all'].includes(n) && durs[i % durs.length] > 0)];
				}));
				return { running: [...new Set(running)], now, frame, settled, props };
			}, step);
		const same = (a, b) => Object.keys(b).every((k) => (a[k] == null && b[k] == null) || (a[k] && b[k] && Math.abs(a[k][0] - b[k][0]) <= 0.5 && Math.abs(a[k][1] - b[k][1]) <= 0.5));
		const moved = (a, b, keys) => keys.filter((k) => a[k] && b[k] && Math.abs(a[k][0] - b[k][0]) > 4);
		for (const [label, opts] of [['desktop', DESK], ['unfolded', UNFOLDED]]) {
			const A = await open('n3-' + label, opts);
			const P = A.page;
			const T = `[${label}] `;
			await P.evaluate(() => window.__tp.test.v1.touchTools.set(true));
			await P.waitForTimeout(500);
			let before = (await STEP(P, 'none')).settled;
			for (const [step, movers] of [['pin-left', ['#logo-menu', '#touch-tools']], ['pin-right', ['#logo-menu', '#hud-tr', '#avatar-trigger']], ['close', ['#hud-tr', '#avatar-trigger']]]) {
				const r = await STEP(P, step);
				const m = moved(before, r.settled, movers);
				h.check(m.length === movers.length, T + `premise (${step}): ${movers.join(', ')} change place (${m.join(', ') || 'none moved'})`);
				h.check(r.running.length === 0, T + `N3 (${step}): no position transition runs on the top clusters, the logo or the profile (${r.running.join(', ') || 'none'})`);
				h.check(same(r.now, r.settled) && same(r.frame, r.settled), T + `N3 (${step}): everything is at its new place at once and on the next frame` + (same(r.now, r.settled) ? '' : ` (at once ${JSON.stringify(r.now)} vs settled ${JSON.stringify(r.settled)})`));
				before = r.settled;
			}
			const props = (await STEP(P, 'none')).props;
			h.check(Object.values(props).every((v) => v == null || v.length === 0), T + `N3: no position transition is declared on the movers (${JSON.stringify(props)})`);
			h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
			await A.ctx.close();
		}
	}

	// ═══ N4 — the profile menu opens next to the profile button where it is now ═══
	if (want('n4')) {
		const openProfile = async (P, kit) => {
			if (kit) await kit.tap(await centre(P.locator('#avatar-trigger')));
			else await P.locator('#avatar-trigger').click();
			await P.waitForTimeout(600);
		};
		const closeProfile = async (P) => {
			await P.keyboard.press('Escape');
			await P.waitForTimeout(400);
		};
		for (const [label, opts] of [['desktop', DESK], ['unfolded', UNFOLDED]]) {
			const A = await open('n4-' + label, opts);
			const P = A.page;
			const T = `[${label}] `;
			const kit = label === 'unfolded' ? await touchKit(P) : null;
			const vw = label === 'desktop' ? 1440 : 770;
			// as before: the corner
			await openProfile(P, kit);
			let t = await rect(P, '#avatar-trigger');
			let d = await rect(P, '#avatar-dropdown');
			h.check(!!d && Math.abs(d.right - t.right) <= 1 && d.top <= t.bottom + 4, T + `N4: no sidebar — the menu hangs from the profile circle (menu right ${d ? Math.round(d.right) : '?'}, circle right ${Math.round(t.right)})`);
			await closeProfile(P);
			// a pinned right sidebar moves the circle inward: the menu opens beside it, not over the sidebar
			await sidebar(P, { side: 'right', open: true, full: true, w: label === 'desktop' ? 360 : 300 });
			t = await rect(P, '#avatar-trigger');
			h.check(t.right < vw - 200, T + `premise: the pinned right sidebar moved the profile circle (right ${Math.round(t.right)})`);
			await openProfile(P, kit);
			d = await rect(P, '#avatar-dropdown');
			h.check(!!d && Math.abs(d.right - t.right) <= 1 && d.top <= t.bottom + 4 && d.bottom > t.bottom, T + `N4: pinned right sidebar — the menu opens next to the moved circle (menu right ${d ? Math.round(d.right) : '?'}, circle right ${Math.round(t.right)})`);
			await shot(P, `n4-${label}-pinned`);
			// the sidebar unpinned while the menu is open: the menu follows the circle back
			await P.evaluate(() => window.__tp.test.v1.sidebars.toggleSidebarFull('right', false));
			await P.waitForTimeout(600);
			t = await rect(P, '#avatar-trigger');
			d = await rect(P, '#avatar-dropdown');
			if (d) h.check(Math.abs(d.right - t.right) <= 1, T + `N4: unpinned while open, the menu follows the circle (menu right ${Math.round(d.right)}, circle right ${Math.round(t.right)})`);
			await closeProfile(P);
			h.check(h.pageErrors(A).length === 0, T + `no page errors (${h.pageErrors(A).join(' / ')})`);
			await A.ctx.close();
		}
		// FOLDED: the phone shell's profile menu stays a bottom sheet the width of the screen
		{
			const A = await open('n4-folded', FOLDED);
			const P = A.page;
			const kit = await touchKit(P);
			await openProfile(P, kit);
			const d = await rect(P, '#avatar-dropdown');
			h.check(!!d && Math.round(d.left) === 0 && Math.round(d.right) === 390 && d.bottom > 600, `[folded] N4: the phone's profile menu is still the full-width bottom sheet (${d ? [d.left, d.right, d.top, d.bottom].map(Math.round).join(',') : 'none'})`);
			await A.ctx.close();
		}
	}

	await h.finish(browser);
});
