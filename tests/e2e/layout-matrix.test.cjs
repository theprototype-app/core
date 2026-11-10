// dock-fixes (owner 2026-11-08 06:40, "checks missed these") — THE CHROME LAYOUT MATRIX. Seven viewports x the chrome
// states people actually sit in, a screenshot of each, and four automatic checks per state:
//   OVERLAP   a floating overlay (corner stacks, the toolbar, the top-right group, the profile, the budget chip, the
//             touch tools, sim controls, hud cells) that is TOPMOST where its rect meets a PANEL rect (an open sidebar column, the
//             bottom dock, a floating window). Menus are popovers: they may cover panels and are checked for OFF only.
//   OVERFLOW  a control whose text is wider than its box (scrollWidth > clientWidth) without an ellipsis — buttons,
//             segmented options, tabs.
//   OFF       an overlay, a column's strip or a menu that leaves the screen.
//   COVERED   the toolbar, the profile or the top-right group is not the topmost thing at its centre (no menu open).
// Devices: N6 unfolded (2156x2344 @2.8 -> 770x837) in portrait AND landscape (837x770), N6 folded (1060x2376 @2.8 -> 379x849), HONOR (718x587 @2),
// tablet 1024x768 (touch), desktop 1280x800 and 1920x1080. States: nothing open · right column (Configure Scene) ·
// both columns · bottom dock open + grown tall · main menu open · profile menu open · a floating window ·
// Configure Scene docked LEFT · the floating AI window. The phone shell (folded) has no columns; its states that need them are skipped.
// Screenshots: OUT/layout-matrix-<device>-<state>.png. Part of the chrome suites (battery.json).
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';

const DEVICES = [
	{ id: 'n6-unfolded', ctx: { viewport: { width: 770, height: 837 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.8 } },
	{ id: 'n6-unfolded-land', ctx: { viewport: { width: 837, height: 770 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.8 } },
	{ id: 'n6-folded', ctx: { viewport: { width: 379, height: 849 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.8 }, phone: true },
	{ id: 'honor', ctx: { viewport: { width: 718, height: 587 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
	{ id: 'tablet-1024', ctx: { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
	{ id: 'desktop-1280', ctx: { viewport: { width: 1280, height: 800 } } },
	{ id: 'desktop-1920', ctx: { viewport: { width: 1920, height: 1080 } } }
];
const STORAGE = { explorerDocked: 'false', statsDocked: 'false', chatDocked: 'false', aiAssistantDocked: 'false', 'sidebar:inspectorSide': 'right' };

const S = (page, fn, arg) => page.evaluate(fn, arg);

/** reset to "nothing open": no columns, no dock, no menus, no floating windows */
async function reset(page) {
	await S(page, () => {
		const st = window.__stores;
		st.closeMenu.set(true);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		st.inspectorClose.set(true);
		st.dockHost?.HOSTED?.stats?.close();
		st.dockHost?.HOSTED?.chat?.close();
		st.aiAssistantHidden?.set('hidden');
		st.bottomDock.setDockEmptyOpen(false);
		st.bottomDock.dockMinimized.set(true);
		for (const s of ['left', 'right']) st.sidebars.toggleSidebar(s, false);
	});
	await page.waitForTimeout(700);
}

const STATES = [
	{ id: 'closed', run: async () => {} },
	{ id: 'right-column', columns: true, run: async (page) => openScene(page, 'right') },
	{ id: 'both-columns', columns: true, run: async (page) => {
		await openScene(page, 'right');
		await S(page, () => {
			window.__stores.aiAssistantHidden.set('');
		});
		await page.waitForTimeout(400);
		await S(page, () => window.__stores.docking.dockToSide('chat', 'left'));
		await page.waitForTimeout(900);
	} },
	{ id: 'dock-tall', run: async (page) => {
		await openScene(page, 'right');
		await S(page, () => {
			window.__stores.bottomDock.dockMinimized.set(false);
			window.__stores.bottomDock.setDockEmptyOpen(true);
			// the dock's own maximum (bottomDock clampH: 80 % of the screen, 200 px kept for the top row) — a raw .set()
			// skips that clamp, which only the drag and the load apply
			window.__stores.bottomDock.dockHeight.set(Math.round(Math.min(innerHeight * 0.8, innerHeight - 200)));
		});
		await page.waitForTimeout(1000);
	} },
	{ id: 'main-menu', run: async (page) => {
		await openScene(page, 'right');
		await S(page, () => window.__stores.closeMenu.set(false));
		await page.waitForTimeout(700);
	} },
	{ id: 'profile-menu', run: async (page) => {
		await openScene(page, 'right');
		const r = await S(page, () => {
			const el = document.querySelector('#avatar-trigger');
			const b = el?.getBoundingClientRect();
			return b?.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
		});
		if (r) await page.mouse.click(r.x, r.y);
		await page.waitForTimeout(700);
	} },
	{ id: 'floating-window', run: async (page) => {
		await openScene(page, 'right');
		await S(page, () => window.__stores.dockHost?.HOSTED?.stats?.open());
		await page.waitForTimeout(900);
	} },
	{ id: 'scene-left', columns: true, run: async (page) => openScene(page, 'left') },
	// UI-5 (device lab, HONOR 718x587): the floating AI window covered the whole toolbar
	{ id: 'ai-window', run: async (page) => {
		await S(page, () => window.__stores.aiAssistantHidden.set(''));
		await page.waitForTimeout(1100);
	} }
];
const MENU_STATES = new Set(['main-menu', 'profile-menu']);

/** @param {import('playwright').Page} page @param {'left'|'right'} side */
async function openScene(page, side) {
	await S(page, (side) => {
		const st = window.__stores;
		st.sidebars.inspectorSide.set(side);
		st.inspectorKind.set('scene');
		st.inspectorClose.set(false);
		st.sidebars.toggleSidebar(side, true);
	}, side);
	await page.waitForTimeout(1100);
}

/** the three checks, measured in the page */
const measure = (page, menus) =>
	S(page, (menus) => {
		const vw = innerWidth;
		const vh = innerHeight;
		const vis = (el) => {
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) return null;
			const cs = getComputedStyle(el);
			if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return null;
			return r;
		};
		const name = (el) => (el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase());
		// PANELS
		const panels = [];
		for (const s of ['left', 'right']) {
			const strip = document.querySelector('#sidebar-strip-' + s);
			const grip = document.querySelector('#sidebar-grip-' + s);
			const r = strip && vis(strip);
			if (r) panels.push({ name: s + ' column', l: r.left, r: r.right, t: r.top, b: grip?.getBoundingClientRect().bottom ?? vh, el: strip });
		}
		for (const el of document.querySelectorAll('[data-dock-panel], .dock-host, #phone-dock')) {
			const r = vis(el);
			if (r && r.height > 40) panels.push({ name: 'dock', l: r.left, r: r.right, t: r.top, b: r.bottom, el });
		}
		for (const el of document.querySelectorAll('#stats-window')) {
			const r = vis(el);
			if (r && el.dataset.docked !== 'left' && el.dataset.docked !== 'right' && !el.closest('[data-sidebar-member]')) panels.push({ name: 'floating stats', l: r.left, r: r.right, t: r.top, b: r.bottom, el });
		}
		// OVERLAYS
		const OVER = ['#hud-stack-left > *', '#hud-stack-right > *', '#controls-pill', '#hud-tr > *', '#avatar-trigger', '#budget-chip-wrap:not(.bc-hidden)', '#touch-tools > *', '#sim-controls', '.hud-cell'];
		const overlap = [];
		const off = [];
		const seen = new Set();
		for (const sel of OVER)
			for (const el of document.querySelectorAll(sel)) {
				if (seen.has(el)) continue;
				seen.add(el);
				const r = vis(el);
				if (!r) continue;
				for (const p of panels) {
					if (p.el.contains(el) || el.contains(p.el)) continue;
					const l = Math.max(r.left, p.l), rr = Math.min(r.right, p.r), t = Math.max(r.top, p.t), b = Math.min(r.bottom, p.b);
					if (rr - l <= 1 || b - t <= 1) continue;
					// only a VISIBLE collision counts: the overlay is the topmost thing in the middle of the shared rect (a stack the
					// dock or a window sits on top of is covered, not colliding — that is a layering choice, COVERED judges the must-reach ones)
					const top = document.elementFromPoint((l + rr) / 2, (t + b) / 2);
					if (top && (el === top || el.contains(top))) overlap.push(`${name(el)} over ${p.name} @${Math.round((l + rr) / 2)},${Math.round((t + b) / 2)}`);
				}
				if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) off.push(`${name(el)} [${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}]`);
			}
		for (const el of document.querySelectorAll('[id^="sidebar-strip-"], .app-sidebar, [role="menu"]')) {
			const r = vis(el);
			if (r && (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)) off.push(`${name(el)} [${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}]`);
		}
		// OVERFLOW
		const overflow = [];
		for (const el of document.querySelectorAll('button, [role="tab"], [role="radio"], .seg-opt')) {
			const r = vis(el);
			if (!r || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue;
			if (el.closest('[aria-hidden="true"], .ab-card, canvas')) continue;
			const cs = getComputedStyle(el);
			if (cs.textOverflow === 'ellipsis' || el.querySelector('*')?.matches?.('.truncate')) continue;
			if (!el.textContent.trim()) continue;
			if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
			// the TEXT's own width against the content box — scrollWidth also counts anything else that sticks out of the box
			// (a hit-area pseudo, a badge), which made the toast's ✕ read 33 > 22 with nothing clipped
			// only text that is DRAWN: a visually-hidden screen-reader copy (sr-only, clipped to 1 px) is not on screen
			let tl = Infinity, tr = -Infinity;
			const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			for (let n = walk.nextNode(); n; n = walk.nextNode()) {
				if (!n.textContent.trim()) continue;
				const p = n.parentElement;
				const pr = p.getBoundingClientRect();
				const pcs = getComputedStyle(p);
				if (pr.width <= 1 || pr.height <= 1 || pcs.visibility === 'hidden' || pcs.display === 'none' || (pcs.clip && pcs.clip !== 'auto') || (pcs.clipPath && pcs.clipPath !== 'none')) continue;
				const range = document.createRange();
				range.selectNodeContents(n);
				const rr = range.getBoundingClientRect();
				if (!rr.width) continue;
				tl = Math.min(tl, rr.left);
				tr = Math.max(tr, rr.right);
			}
			const tw = tr > tl ? tr - tl : 0;
			const inner = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
			if (tw > inner + 2) overflow.push(`${name(el)} "${el.textContent.trim().slice(0, 24)}" text ${Math.round(tw)}>${Math.round(inner)}`);
		}
		// COVERED: the controls a person must always reach (the toolbar, the profile, the top-right group) are the
		// TOPMOST thing at their centre — device lab UI-3 (avatar under the right column) and UI-5 (the AI window over
		// the toolbar). An open menu may cover them (popovers), so the menu states skip it.
		const covered = [];
		if (!menus)
			for (const el of document.querySelectorAll('#controls-pill, #avatar-trigger, #hud-tr > *')) {
				const r = vis(el);
				if (!r || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue;
				const top = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
				if (top && !el.contains(top) && !top.contains(el)) covered.push(`${name(el)} under ${name(top.closest('[id]') || top)}`);
			}
		return { panels: panels.map((p) => p.name), overlap, off, overflow, covered };
	}, menus);

h.run(async () => {
	const browser = await h.launch();
	const fails = [];
	for (const dev of DEVICES) {
		for (const theme of dev.id === 'n6-unfolded' ? ['dark', 'light'] : ['dark']) {
			const P = await h.setupPage(browser, `${dev.id}-${theme}`, { context: { ...dev.ctx, colorScheme: theme }, storage: { ...STORAGE, theme } });
			const page = P.page;
			for (const state of STATES) {
				if (dev.phone && state.columns) continue;
				await reset(page);
				await state.run(page);
				const m = await measure(page, MENU_STATES.has(state.id));
				await page.screenshot({ path: `${OUT}/layout-matrix-${dev.id}-${theme}-${state.id}.png` });
				const tag = `${dev.id}/${theme}/${state.id}`;
				h.check(m.overlap.length === 0, `${tag} OVERLAP: no overlay over a panel (${m.panels.join(', ') || 'no panels'}) — ${m.overlap.slice(0, 5).join(' | ') || 'none'}`);
				h.check(m.overflow.length === 0, `${tag} OVERFLOW: no control text wider than its box — ${m.overflow.slice(0, 5).join(' | ') || 'none'}`);
				h.check(m.off.length === 0, `${tag} OFF: nothing off-screen — ${m.off.slice(0, 5).join(' | ') || 'none'}`);
				h.check(m.covered.length === 0, `${tag} COVERED: toolbar, profile and top-right group on top — ${m.covered.slice(0, 5).join(' | ') || 'none'}`);
				if (m.overlap.length + m.overflow.length + m.off.length + m.covered.length) fails.push(tag);
			}
			await P.ctx.close();
		}
	}
	console.log('layout-matrix states with a finding: ' + (fails.join(', ') || 'none'));
	await h.finish(browser);
});
