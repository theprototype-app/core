// dock-fixes (owner list 2026-11-08, 1.63 walk-through prep) — sidebars, the AI window and the chrome around them:
//   1 'Sidebars must ALWAYS be hideable with a button (today the hide control only appears once every tab is closed)'
//   2 'The AI assistant window cannot be dragged partly off screen without shrinking; the Object list floating window can'
//   3 'Click AI assistant -> dock it to a sidebar -> click the AI assistant button again: the window hides but its
//      sidebar tab stays and the sidebar does not collapse when it was the only tab'
//   4 'Bottom buttons draw ON TOP of the sidebars' + the owner's N6 shots: the top-right cluster over the right
//      sidebar's header, the "+" / AI buttons over the docked AI assistant, the toolbar over the chat / mic buttons
//      -> every floating overlay sits in the FREE viewport between the open sidebars, the toolbar folds before it
//      would overlap anything
//   6 'Right-click context menu on tabs in a DOCKED panel lacks the Lucide icons; the sidebar one has them'
//   8 'a "Panels" toggle button in the top-right cluster' (unfolded phone / tablet; hideable from its own menu)
//
//   D1  desktop 1440x900: the right column (Configure Scene) has its hide button WITH a tab; it hides the column and
//       keeps the panel open; the shortcut brings it back
//   D2  the AI window dragged 520 px down keeps its height (it shrank with its own top before)
//   D3  the AI assistant docked to the right sidebar: its button closes it AND the column; again brings both back;
//       covered by Configure Scene the button brings it forward instead; a column kept open EMPTY (its × first)
//       still collapses when the button closes the tab
//   D4  free rect on desktop: Configure Scene open (not pinned) — no overlay over the column; pinned, the profile
//       and the top-right group step inward; 1000x760 with BOTH columns: the toolbar sits between them, folded
//   D5  the bottom dock's tab menu: an icon on every row (the sidebar tab menu's look)
//   D6  no Panels button on a mouse desktop (Auto)
//   U1  N6 unfolded 770x850 touch, Connect docked: the right column's header is not under the top-right group /
//       the profile; with the AI assistant pinned on the left, the corner buttons and the toolbar clear both columns
//   U2  the Panels button: shown (Auto, touch), hides both columns with their tabs open, brings them back; its menu
//       has "Hide this button" which removes it (mode 'off')
//   F1  N6 folded 390x896: no Panels button, the free-rect bus reads 0
//
// Counterfactual (feat/98-int b1e83cf8): D1 no hide button beside a tab; D2 the window shrinks; D3 the tab and the
// column stay; D4 the right corner stack sits on the column; D5 rows without icons; U1 the profile over the column
// header; U2/D6 no Panels button. Screenshots: OUT/dock-fixes-*.png (both themes in U1).
// Run: APP_URL=https://theprototype.app:6990/ npm run e2e -- dock-fixes
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';

const DESK = { viewport: { width: 1440, height: 900 } };
const SMALL = { viewport: { width: 1000, height: 760 } };
const UNFOLD = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const FOLD = { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
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
async function tapAt(page, sel) {
	const r = await rectOf(page, sel);
	if (!r) return false;
	await page.touchscreen.tap(r.left + r.w / 2, r.top + r.h / 2);
	await page.waitForTimeout(500);
	return true;
}
const menuRows = (page) =>
	S(page, () =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
			title: el.querySelector('.flex-1')?.textContent.trim() ?? el.textContent.trim(),
			icon: !!el.querySelector('.ctx-ico svg')
		}))
	);
async function clickRow(page, title) {
	const pt = await S(page, (title) => {
		const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((r) => (r.querySelector('.flex-1')?.textContent.trim() ?? r.textContent.trim()) === title);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) };
	}, title);
	if (!pt) return false;
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(700);
	return true;
}
const sides = (page) => read(page, 'sidebars.sidebarVisible');
const tabs = (page) => read(page, 'sidebars.sidebarTabs');

/** every floating overlay that sits over an open sidebar column (strip top .. grip bottom) */
const overlays = (page) =>
	S(page, () => {
		const cols = [];
		for (const s of ['left', 'right']) {
			const strip = document.querySelector('#sidebar-strip-' + s)?.getBoundingClientRect();
			const grip = document.querySelector('#sidebar-grip-' + s)?.getBoundingClientRect();
			if (!strip || !strip.width) continue;
			cols.push({ side: s, left: strip.left, right: strip.right, top: strip.top, bottom: grip?.bottom ?? innerHeight });
		}
		const SEL = ['#hud-stack-left > *', '#hud-stack-right > *', '#controls-pill', '#hud-tr > *', '#avatar-trigger', '#budget-chip-wrap:not(.bc-hidden)', '#touch-tools > *', '#sim-controls'];
		const hits = [];
		for (const sel of SEL)
			for (const el of document.querySelectorAll(sel)) {
				const r = el.getBoundingClientRect();
				if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
				for (const c of cols)
					if (r.left < c.right - 1 && r.right > c.left + 1 && r.top < c.bottom - 1 && r.bottom > c.top + 1)
						hits.push(`${sel.split(' ')[0]}${el.id ? '#' + el.id : ''} over ${c.side} [${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}]`);
			}
		// …and the clusters over EACH OTHER (the toolbar vs the corner stacks: three clusters in a narrow free width)
		const pill = document.querySelector('#controls-pill')?.getBoundingClientRect();
		const clash = [];
		if (pill?.width)
			for (const el of document.querySelectorAll('#hud-stack-left > *, #hud-stack-right > *')) {
				const r = el.getBoundingClientRect();
				if (r.width && r.left < pill.right - 1 && r.right > pill.left + 1 && r.top < pill.bottom - 1 && r.bottom > pill.top + 1) clash.push('#' + el.id + ' over the toolbar');
			}
		hits.push(...clash);
		return { cols: cols.map((c) => `${c.side} ${Math.round(c.left)}..${Math.round(c.right)} y${Math.round(c.top)}..${Math.round(c.bottom)}`), hits };
	});

async function openScene(page) {
	await S(page, () => {
		window.__stores.inspectorKind.set('scene');
		window.__stores.inspectorClose.set(false);
	});
	await page.waitForTimeout(1200);
}

/** the AI button wherever the layout put it (a corner stack by default); the toggle tree directly when absent */
async function pressAi(page) {
	if (await clickAt(page, '#ai-hud-button')) return 'button';
	await S(page, () => window.__stores.panelToggles.toggleHostedWindow('aiAssistant'));
	await page.waitForTimeout(500);
	return 'tree';
}

h.run(async () => {
	const browser = await h.launch();

	// ================================ desktop ================================
	const D = await h.setupPage(browser, 'desk', { context: DESK, storage: { ...BASE_STORAGE, 'win:aiAssistant': JSON.stringify({ left: 420, top: 160 }) } });
	let page = D.page;

	// ---- D1: the hide button beside a tab ----
	await openScene(page);
	let t = await tabs(page);
	h.check(t?.right?.join() === 'inspector', `D1.0 premise: Configure Scene is the right column's tab (${JSON.stringify(t)})`);
	h.check(!!(await rectOf(page, '#sidebar-hide-right')), 'D1.1 the right column shows its hide button WITH a tab in it (item 1)');
	await clickAt(page, '#sidebar-hide-right');
	let v = await sides(page);
	h.check(v?.right === false, `D1.2 the hide button hides the column (${JSON.stringify(v)})`);
	h.check((await read(page, 'inspectorClose')) === false, 'D1.3 …and Configure Scene stays open behind it');
	await S(page, () => window.__stores.sidebars.toggleSidebar('right', true));
	await page.waitForTimeout(500);
	h.check((await sides(page))?.right === true, 'D1.4 the column comes back with its tab');
	await page.screenshot({ path: `${OUT}/dock-fixes-01-hide-button.png` });

	// ---- D4a: the free rect on desktop, unpinned column ----
	let o = await overlays(page);
	h.check(o.cols.length === 1 && o.hits.length === 0, `D4.1 no overlay over the open (unpinned) right column (item 4) — cols ${o.cols.join(' | ')}; hits ${o.hits.join(' | ') || 'none'}`);
	const freeR = await S(page, () => getComputedStyle(document.documentElement).getPropertyValue('--sb-free-right').trim());
	const colW = (await read(page, 'sidebars.sidebarWidth'))?.right;
	h.check(freeR === colW + 'px', `D4.2 --sb-free-right is the open column's width (${freeR} vs ${colW})`);
	const pill = await rectOf(page, '#controls-pill');
	h.check(!!pill && Math.abs((pill.left + pill.right) / 2 - (1440 - colW) / 2) <= 12, `D4.3 the toolbar is centred in the free width (centre ${pill && (pill.left + pill.right) / 2} vs ${(1440 - colW) / 2})`);
	// pinned: the top row gives way too
	await S(page, () => window.__stores.sidebars.toggleSidebarFull('right', true));
	await page.waitForTimeout(700);
	o = await overlays(page);
	h.check(o.hits.length === 0, `D4.4 pinned (full height), nothing over the column — the profile and the top-right group step inward (${o.hits.join(' | ') || 'none'})`);
	await S(page, () => window.__stores.sidebars.toggleSidebarFull('right', false));
	await page.waitForTimeout(500);

	// ---- D2: the AI window keeps its size off the bottom ----
	await S(page, () => window.__stores.aiAssistantHidden.set(''));
	await page.waitForTimeout(1200);
	const a0 = await rectOf(page, '#ai-assistant-window');
	const head = await rectOf(page, '#ai-assistant-window .move-handle');
	h.check(!!a0 && !!head, `D2.0 premise: the AI assistant floats (${JSON.stringify(a0)})`);
	if (a0 && head) {
		const x = head.left + 60;
		const y = head.top + head.h / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + i * 52, { steps: 2 });
		const mid = await rectOf(page, '#ai-assistant-window');
		await page.mouse.up();
		await page.waitForTimeout(500);
		const a1 = await rectOf(page, '#ai-assistant-window');
		h.check(!!mid && mid.top > a0.top + 300 && Math.abs(mid.h - a0.h) <= 1, `D2.1 dragged ${mid && mid.top - a0.top} px down, the window keeps its height mid-drag (${a0.h} -> ${mid?.h}) (item 2)`);
		h.check(!!a1 && Math.abs(a1.h - a0.h) <= 1 && a1.bottom > 900, `D2.2 …and after the release, partly off the bottom (${a0.h} -> ${a1?.h}, bottom ${a1?.bottom})`);
		h.check(!!a1 && a1.top < 900 - 20, `D2.3 its header stays on screen (top ${a1?.top})`);
	}
	await S(page, () => window.__stores.aiAssistantHidden.set('hidden'));
	await page.waitForTimeout(400);

	// ---- D3: the AI button and its sidebar tab ----
	await S(page, () => window.__stores.inspectorClose.set(true));
	await page.waitForTimeout(500);
	await S(page, () => window.__stores.sidebars.sidebarMode.set({ left: 'auto', right: 'auto' }));
	await S(page, () => window.__stores.aiAssistantHidden.set(''));
	await page.waitForTimeout(500);
	await S(page, () => window.__stores.docking.dockToSide('aiAssistant', 'right'));
	await page.waitForTimeout(900);
	t = await tabs(page);
	h.check(t?.right?.join() === 'aiAssistant', `D3.0 premise: the AI assistant is the right column's only tab (${JSON.stringify(t)})`);
	const how = await pressAi(page);
	await page.waitForTimeout(400);
	t = await tabs(page);
	v = await sides(page);
	h.check((await read(page, 'aiAssistantHidden')) === 'hidden', `D3.1 the AI button (${how}) closes the AI assistant`);
	h.check(!t?.right?.includes('aiAssistant'), `D3.2 …its sidebar tab goes with it (${JSON.stringify(t)}) (item 3)`);
	h.check(v?.right === false, `D3.3 …and the column it was the only tab of collapses (${JSON.stringify(v)})`);
	await pressAi(page);
	await page.waitForTimeout(600);
	t = await tabs(page);
	h.check((await read(page, 'aiAssistantHidden')) === '' && t?.right?.includes('aiAssistant') && (await sides(page))?.right === true, `D3.4 again: open, back as the right column's tab (${JSON.stringify(t)})`);
	await openScene(page);
	h.check((await read(page, 'sidebars.sidebarShown'))?.right === 'inspector', 'D3.5 premise: Configure Scene covers it');
	await pressAi(page);
	await page.waitForTimeout(400);
	h.check((await read(page, 'aiAssistantHidden')) === '' && (await read(page, 'sidebars.sidebarShown'))?.right === 'aiAssistant', 'D3.6 covered, the AI button brings its tab forward instead of closing it');
	// a column kept open EMPTY (its last tab closed by ×) still collapses when the button closes the tab
	await S(page, () => window.__stores.inspectorClose.set(true));
	await page.waitForTimeout(400);
	await clickAt(page, '[data-sidebar-tab-close="aiAssistant"]');
	await page.waitForTimeout(400);
	h.check((await read(page, 'sidebars.sidebarMode'))?.right === 'open' && (await sides(page))?.right === true, 'D3.7 premise: its × emptied the column, which stays open (44 M7)');
	await pressAi(page);
	await page.waitForTimeout(600);
	h.check((await tabs(page))?.right?.includes('aiAssistant'), 'D3.8 the button opens it into the column again');
	await pressAi(page);
	await page.waitForTimeout(600);
	h.check((await sides(page))?.right === false, `D3.9 …and closing it by the button collapses the column too (${JSON.stringify(await read(page, 'sidebars.sidebarMode'))})`);

	// ---- D5: the bottom dock's tab menu ----
	await S(page, () => {
		window.__stores.flowGraphClose.set(false);
	});
	await page.waitForTimeout(400);
	await S(page, () => window.__stores.bottomDock.activateDock('flow'));
	await page.waitForTimeout(1200);
	const dockTab = (await rectOf(page, '[data-dock-tab="flow"]')) ? '[data-dock-tab="flow"]' : '[data-dock-tab]';
	if (await clickAt(page, dockTab, { button: 'right' })) {
		const rows = await menuRows(page);
		const bare = rows.filter((r) => !r.icon).map((r) => r.title);
		h.check(rows.length >= 3 && bare.length === 0, `D5.1 every row of the dock tab menu has its icon (item 6) — ${rows.length} rows, without: ${bare.join(', ') || 'none'}`);
		await page.screenshot({ path: `${OUT}/dock-fixes-05-dock-tab-menu.png` });
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	} else h.check(false, 'D5.0 premise: a bottom-dock tab to right-click');

	// ---- D6: no Panels button on a mouse desktop ----
	h.check(!(await rectOf(page, '#panels-toggle')), 'D6.1 no Panels button on a mouse desktop (Auto)');
	await D.ctx.close();

	// ---- D4b: a narrow desktop with BOTH columns open ----
	const N = await h.setupPage(browser, 'small', { context: SMALL, storage: { ...BASE_STORAGE, 'win:aiAssistant': JSON.stringify({ left: 300, top: 160 }) } });
	page = N.page;
	await openScene(page);
	await S(page, () => window.__stores.aiAssistantHidden.set(''));
	await page.waitForTimeout(500);
	await S(page, () => window.__stores.docking.dockToSide('aiAssistant', 'left'));
	await page.waitForTimeout(1200);
	v = await sides(page);
	o = await overlays(page);
	const track = await S(page, () => window.__toolbarTrack ?? null);
	h.check(v?.left && v?.right, `D4.5 premise: both columns open at 1000 px (${JSON.stringify(v)})`);
	h.check(o.hits.length === 0, `D4.6 nothing over either column — cols ${o.cols.join(' | ')}; hits ${o.hits.join(' | ') || 'none'}`);
	h.check(!!track?.room?.ok && track.room.left >= o.cols.length && JSON.stringify(track?.folded ?? '').length > 0, `D4.7 the toolbar's band is the free width (${JSON.stringify(track?.room)}; folded ${JSON.stringify(track?.folded)})`);
	await page.screenshot({ path: `${OUT}/dock-fixes-04-narrow-both-columns.png` });
	await N.ctx.close();

	// ================================ N6 unfolded ================================
	for (const theme of ['dark', 'light']) {
		const U = await h.setupPage(browser, 'unfold-' + theme, { context: { ...UNFOLD, colorScheme: theme }, storage: { ...BASE_STORAGE, theme } });
		page = U.page;
		await openScene(page);
		const docked = await read(page, 'connectDocked');
		o = await overlays(page);
		h.check(o.hits.length === 0, `U1.1 [${theme}] Connect ${docked ? 'docked' : 'floating'}: nothing over the right column's header or body — cols ${o.cols.join(' | ')}; hits ${o.hits.join(' | ') || 'none'}`);
		await S(page, () => window.__stores.aiAssistantHidden.set(''));
		await page.waitForTimeout(400);
		await S(page, () => {
			window.__stores.docking.dockToSide('aiAssistant', 'left');
			window.__stores.sidebars.toggleSidebarFull('left', true);
		});
		await page.waitForTimeout(1200);
		o = await overlays(page);
		h.check((await sides(page))?.left === true && o.hits.length === 0, `U1.2 [${theme}] the AI assistant pinned left + Configure Scene right: the corner buttons and the toolbar clear both — cols ${o.cols.join(' | ')}; hits ${o.hits.join(' | ') || 'none'}`);
		await page.screenshot({ path: `${OUT}/dock-fixes-u1-unfolded-${theme}.png` });

		if (theme === 'dark') {
			// ---- U2: the Panels button ----
			h.check(!!(await rectOf(page, '#panels-toggle')), 'U2.1 the Panels button is in the top-right group on the unfolded phone (Auto, touch) (item 8)');
			await tapAt(page, '#panels-toggle');
			await page.waitForTimeout(400);
			v = await sides(page);
			t = await tabs(page);
			h.check(v?.left === false && v?.right === false, `U2.2 a tap hides both columns (${JSON.stringify(v)})`);
			h.check(t?.left?.includes('aiAssistant') && t?.right?.includes('inspector'), `U2.3 …with their tabs still open (${JSON.stringify(t)})`);
			await page.screenshot({ path: `${OUT}/dock-fixes-u2-panels-hidden.png` });
			await tapAt(page, '#panels-toggle');
			await page.waitForTimeout(500);
			v = await sides(page);
			h.check(v?.left === true && v?.right === true, `U2.4 another tap brings both back (${JSON.stringify(v)})`);
			await clickAt(page, '#panels-toggle', { button: 'right' });
			const rows = await menuRows(page);
			h.check(rows.some((r) => r.title === 'Hide this button' && r.icon), `U2.5 its menu offers "Hide this button" (${rows.map((r) => r.title).join(', ')})`);
			await clickRow(page, 'Hide this button');
			h.check(!(await rectOf(page, '#panels-toggle')) && (await read(page, 'panelsButton.panelsButtonMode')) === 'off', 'U2.6 …which removes it (Settings ▸ Panels button brings it back)');
			await S(page, () => window.__stores.panelsButton?.panelsButtonMode.set('auto'));
		}
		await U.ctx.close();
	}

	// ================================ N6 folded ================================
	const F = await h.setupPage(browser, 'fold', { context: FOLD, storage: BASE_STORAGE });
	page = F.page;
	await openScene(page);
	h.check(!(await rectOf(page, '#panels-toggle')), 'F1.1 no Panels button on the folded phone');
	const free = await S(page, () => ['left', 'right'].map((s) => getComputedStyle(document.documentElement).getPropertyValue('--sb-free-' + s).trim()));
	h.check(free.every((x) => x === '0px' || x === ''), `F1.2 the free-rect bus reads 0 on the folded phone (${free.join(', ')})`);
	await F.ctx.close();
	await h.finish(browser);
});
