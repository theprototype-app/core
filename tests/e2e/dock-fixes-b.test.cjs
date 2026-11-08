// dock-fixes, owner additions 2026-11-08 06:40 (shots 4-0621, 5-0631) — the second half of the dock-fixes lane.
//   A' opening / growing the BOTTOM dock squashed both unpinned sidebars to bare tab strips. Owner correction: never
//      clamp the dock (growing it is the point) — a column left < 240 px AUTO-HIDES and comes back when the room
//      returns; two columns that would leave no usable viewport (the unfolded phone) -> the EARLIER one auto-hides
//   B  the main menu pushed a left-docked Configure Scene sideways over the right column: the menu OVERLAYS the
//      column, the column does not move
//   C  segmented controls overflowed ("Auto HighMediumLow"): no option's label spills out of its slot, options never
//      overlap (they wrap to a second row instead)
//   D  Free assets (CC0) from the main menu opened floating while a dock was on screen: it opens as a tab there
//   E  the open menu cut the bottom toolbar: the menu ends above it; the budget chip never sits on a HUD button
//   (F and the shared show / hide pattern wait for the owner's pick from the mockups — branch feat/dock-fixes-pattern)
// Screenshots: OUT/dock-fixes-b-*.png.
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';

const DESK = { viewport: { width: 1440, height: 900 } };
const UNFOLD = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const BASE_STORAGE = { explorerDocked: 'false', statsDocked: 'false', chatDocked: 'false', aiAssistantDocked: 'false', 'sidebar:inspectorSide': 'right' };

const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		const st = name ? window.__stores[mod]?.[name] : window.__stores[mod];
		if (!st?.subscribe) return null;
		let v;
		st.subscribe((x) => (v = x))();
		return v;
	}, path);
const rectOf = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return r.width && r.height ? { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null;
	}, sel);
async function clickAt(page, sel, opts = {}) {
	const r = await rectOf(page, sel);
	if (!r) return false;
	await page.mouse.click(r.left + r.w / 2, r.top + r.h / 2, opts);
	await page.waitForTimeout(500);
	return true;
}
async function openScene(page) {
	await S(page, () => {
		window.__stores.inspectorKind.set('scene');
		window.__stores.inspectorClose.set(false);
	});
	await page.waitForTimeout(1200);
}
/** room an unpinned open column has under its strip, per visible side */
const columnRoom = (page) =>
	S(page, () => {
		const out = {};
		for (const s of ['left', 'right']) {
			const strip = document.querySelector('#sidebar-strip-' + s)?.getBoundingClientRect();
			const grip = document.querySelector('#sidebar-grip-' + s)?.getBoundingClientRect();
			if (strip?.width && grip?.height) out[s] = Math.round(grip.bottom - strip.bottom);
		}
		return out;
	});
/** every segmented option whose label spills out of it, and options that overlap a sibling */
const segFaults = (page, scope) =>
	S(page, (scope) => {
		const bad = [];
		for (const seg of document.querySelectorAll(`${scope} .seg, ${scope} .tp-seg`)) {
			const opts = [...seg.querySelectorAll(':scope > button')].filter((b) => b.getBoundingClientRect().width);
			for (const b of opts) {
				const r = b.getBoundingClientRect();
				const span = b.querySelector('span:last-child') || b;
				const t = span.getBoundingClientRect();
				if (t.left < r.left - 1 || t.right > r.right + 1 || b.scrollWidth > b.clientWidth + 1) bad.push(`${seg.id || seg.className.split(' ')[0]}:${b.textContent.trim()} spills`);
			}
			for (let i = 0; i < opts.length; i++)
				for (let j = i + 1; j < opts.length; j++) {
					const a = opts[i].getBoundingClientRect();
					const b = opts[j].getBoundingClientRect();
					if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) bad.push(`${seg.id}:${opts[i].textContent.trim()}/${opts[j].textContent.trim()} overlap`);
				}
		}
		return bad;
	}, scope);

h.run(async () => {
	const browser = await h.launch();
	let page, v, r;

	// ================================ desktop ================================
	const D = await h.setupPage(browser, 'desk', { context: DESK, storage: BASE_STORAGE });
	page = D.page;
	await openScene(page);

	// ---- A': the dock is never clamped; a column without room auto-hides and comes back ----
	const auto = () => read(page, 'sidebars.sidebarAutoHidden');
	await S(page, () => {
		window.__stores.bottomDock.setDockEmptyOpen(true);
		window.__stores.bottomDock.dockHeight.set(2000); // clampH -> the dock's own max
	});
	await page.waitForTimeout(900);
	v = await read(page, 'sidebars.sidebarVisible');
	let ah = await auto();
	const tallH = await read(page, 'bottomDock.dockHeight');
	h.check(v?.right === false && ah?.right === true && tallH >= 600, `A1 the dock grown tall (${tallH} px, not clamped): the right column auto-hides instead of being squashed (${JSON.stringify(v)}) (owner A')`);
	h.check((await read(page, 'sidebars.sidebarMode'))?.right !== 'hidden', `A2 …a free-space hide, not the person's: its mode is untouched`);
	await page.screenshot({ path: `${OUT}/dock-fixes-b-a-dock-tall.png` });
	await S(page, () => window.__stores.bottomDock.dockHeight.set(300));
	await page.waitForTimeout(900);
	v = await read(page, 'sidebars.sidebarVisible');
	h.check(v?.right === true, `A3 the dock lowered again: the column comes back by itself (${JSON.stringify(v)})`);
	await S(page, () => window.__stores.bottomDock.dockHeight.set(2000));
	await page.waitForTimeout(700);
	await S(page, () => window.__stores.sidebars.toggleSidebar('right', true));
	await page.waitForTimeout(900);
	v = await read(page, 'sidebars.sidebarVisible');
	const madeRoom = await read(page, 'bottomDock.dockHeight');
	h.check(v?.right === true && madeRoom < tallH, `A4 an explicit show of the tucked-away column wins: the dock gives back just the room it needs (${tallH} -> ${madeRoom})`);
	await S(page, () => window.__stores.bottomDock.dockHeight.set(300));
	await page.waitForTimeout(500);

	// ---- D: Free assets from the main menu opens in the dock on screen ----
	await S(page, () => window.__stores.closeMenu.set(false));
	await page.waitForTimeout(500);
	await clickAt(page, '#open-asset-browser');
	await page.waitForTimeout(900);
	const whereD = await S(page, () => window.__stores.dockMenu.windowWhere('assets'));
	h.check(whereD === 'dock', `D1 the dock on screen: main menu ▸ Free assets opens as a dock tab (${whereD}) (owner D)`);
	await S(page, () => {
		window.__stores.dockHost.HOSTED.assets.close();
		window.__stores.bottomDock.setDockEmptyOpen(false);
		window.__stores.bottomDock.dockMinimized.set(true);
	});
	await page.waitForTimeout(600);
	await S(page, () => window.__stores.closeMenu.set(false));
	await page.waitForTimeout(500);
	await clickAt(page, '#open-asset-browser');
	await page.waitForTimeout(900);
	const whereD2 = await S(page, () => window.__stores.dockMenu.windowWhere('assets'));
	const ctxD2 = await S(page, () => {
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const s = window.__stores;
		return { vis: g(s.sidebars.sidebarVisible), auto: g(s.sidebars.sidebarAutoHidden), inset: g(s.bottomDock.bottomInset), tabs: g(s.sidebars.sidebarTabs) };
	});
	h.check(whereD2 === 'right', `D2 no dock, the right column open: it opens as a tab of that column (${whereD2}; ${JSON.stringify(ctxD2)})`);
	await S(page, () => {
		window.__stores.dockHost.HOSTED.assets.close();
		window.__stores.bottomDock.dockMinimized.set(false);
	});
	await page.waitForTimeout(500);

	// ---- PC-5: the Templates dialog keeps one height whatever the tab (it jumped ~44 px at 1920) ----
	await S(page, () => window.__stores.templatesModalOpen.set(true));
	await page.waitForSelector('#templates-tab-examples', { timeout: 15000 });
	const tplH = [];
	for (const t of ['general', 'examples', 'games', 'general']) {
		await page.locator('#templates-tab-' + t).click();
		await page.waitForTimeout(700);
		tplH.push(await S(page, () => Math.round(document.getElementById('templates-modal')?.getBoundingClientRect().height || 0)));
	}
	h.check(tplH[0] > 0 && tplH.every((x) => Math.abs(x - tplH[0]) <= 1), `PC5 the Templates dialog keeps one height across General / Examples / Games (${tplH.join(' / ')})`);
	await S(page, () => window.__stores.templatesModalOpen.set(false));
	await page.waitForTimeout(400);

	// ---- PC-4: the Objects window's filter chips fade the edge they scroll past instead of cutting "St…" ----
	await S(page, () => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(800);
	const chips = await S(page, () => {
		const n = document.getElementById('filter-chips');
		if (!n) return null;
		const before = { fade: n.dataset.fade || '', more: n.scrollWidth - n.clientWidth };
		n.scrollLeft = n.scrollWidth;
		return new Promise((res) => setTimeout(() => res({ ...before, after: n.dataset.fade || '' }), 150));
	});
	h.check(!!chips && (chips.more <= 1 ? chips.fade === '' : chips.fade === 'end' && chips.after === 'start'), `PC4 the chip row fades its scrolling edge: 'end' at rest, 'start' scrolled to the end (${JSON.stringify(chips)})`);
	await S(page, () => window.__stores.objectListClose.set(true));
	await page.waitForTimeout(300);

	await D.ctx.close();

	// ================================ N6 unfolded ================================
	for (const theme of ['dark', 'light']) {
		const U = await h.setupPage(browser, 'unfold-' + theme, { context: { ...UNFOLD, colorScheme: theme }, storage: { ...BASE_STORAGE, theme, 'sidebar:inspectorSide': 'left' } });
		page = U.page;
		await openScene(page);
		// ---- C: the Quality preset and every other segmented control in Configure Scene fit ----
		const faults = await segFaults(page, 'body');
		h.check(faults.length === 0, `C1 [${theme}] no segmented option spills out of its slot or overlaps another (${faults.slice(0, 6).join(' | ') || 'none'}) (owner C)`);
		const preset = await S(page, () => {
			const seg = document.querySelector('#scene-quality-preset');
			if (!seg) return null;
			return [...seg.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().width));
		});
		h.check(!!preset && preset.every((w) => w >= 36), `C2 [${theme}] the Quality preset's four options each keep their label width (${JSON.stringify(preset)})`);
		await page.screenshot({ path: `${OUT}/dock-fixes-b-c-unfolded-${theme}.png` });

		if (theme === 'dark') {
			// ---- A': two columns would leave no usable viewport on the unfolded phone: the EARLIER one tucks away ----
			await S(page, () => window.__stores.aiAssistantHidden.set(''));
			await page.waitForTimeout(400);
			await S(page, () => window.__stores.docking.dockToSide('aiAssistant', 'right'));
			await page.waitForTimeout(1200);
			v = await read(page, 'sidebars.sidebarVisible');
			const ah2 = await read(page, 'sidebars.sidebarAutoHidden');
			h.check(v?.right === true && v?.left === false && ah2?.left === true, `A5 unfolded: the AI assistant opened on the right — Configure Scene (left, opened earlier) tucks away (${JSON.stringify(v)})`);
			await page.screenshot({ path: `${OUT}/dock-fixes-b-a-two-columns-unfolded.png` });
			await S(page, () => window.__stores.sidebars.toggleSidebar('left', true));
			await page.waitForTimeout(900);
			v = await read(page, 'sidebars.sidebarVisible');
			h.check(v?.left === true && v?.right === false, `A6 showing the left one again: now the right one gives way (${JSON.stringify(v)})`);
			await S(page, () => window.__stores.sidebars.toggleSidebar('right', false));
			await page.waitForTimeout(700);
			v = await read(page, 'sidebars.sidebarVisible');
			h.check(v?.left === true && v?.right === false, `A7 hiding the right one keeps the left (${JSON.stringify(v)})`);
			await S(page, () => {
				window.__stores.dockHost.HOSTED.aiAssistant.close();
				window.__stores.sidebars.sidebarMode.update((m) => ({ ...m, right: 'auto' }));
			});
			await page.waitForTimeout(700);
			await openScene(page);
			// ---- B: the menu overlays the left column, the column does not move ----
			const colBefore = await rectOf(page, '#sidebar-strip-left');
			const rightBefore = await rectOf(page, '#sidebar-strip-right');
			await S(page, () => window.__stores.closeMenu.set(false));
			await page.waitForTimeout(700);
			const colAfter = await rectOf(page, '#sidebar-strip-left');
			const menuTop = await S(page, () => {
				const m = document.querySelector('.app-sidebar')?.getBoundingClientRect();
				if (!m) return null;
				const el = document.elementFromPoint(m.left + m.width / 2, m.top + Math.min(m.height / 2, 140));
				return !!el?.closest('.app-sidebar');
			});
			h.check(!!colBefore && !!colAfter && colAfter.left === colBefore.left && menuTop === true, `B1 the main menu opens OVER the left column, which stays put (${colBefore?.left} -> ${colAfter?.left}; menu on top ${menuTop}) (owner B)`);
			const rightAfter = await rectOf(page, '#sidebar-strip-right');
			h.check(JSON.stringify(rightBefore) === JSON.stringify(rightAfter), `B2 …and nothing moves over the right column (${JSON.stringify(rightAfter)})`);
			// ---- E: the open menu ends above the toolbar ----
			const ePill = await rectOf(page, '#controls-pill');
			const eMenu = await rectOf(page, '.app-sidebar');
			const under = ePill && eMenu && ePill.left < eMenu.right && ePill.right > eMenu.left;
			h.check(!under || eMenu.bottom <= ePill.top + 1, `E1 the open menu ends above the bottom toolbar (menu bottom ${eMenu?.bottom}, toolbar top ${ePill?.top}, under ${!!under}) (owner E)`);
			await page.screenshot({ path: `${OUT}/dock-fixes-b-b-menu-over-column.png` });
			await S(page, () => window.__stores.closeMenu.set(true));
			await page.waitForTimeout(500);
			// the budget chip never sits on a HUD button
			const chip = await S(page, () => {
				const c = document.querySelector('#budget-chip-wrap:not(.bc-hidden)')?.getBoundingClientRect();
				if (!c?.width) return { shown: false, hits: [] };
				const hits = [];
				for (const el of document.querySelectorAll('.hud-stack > *, #hud-tr > *, #sim-controls')) {
					const r = el.getBoundingClientRect();
					if (r.width && r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) hits.push(el.id || el.className);
				}
				return { shown: true, hits };
			});
			h.check(chip.hits.length === 0, `E2 the budget chip touches no HUD button (${JSON.stringify(chip)})`);
		}
		await U.ctx.close();
	}
	await h.finish(browser);
});
