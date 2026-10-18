// 48 F5 — THREE WINDOW LEFTOVERS from 1.35 (roadmap 44's follow-ups), each red on v1.38.0:
//  A. Statistics is TAB-ABLE: it is offered by another window's "Group with…", offers the others in its own menu,
//     and joins a tab group (it never registered with windowTabs, so no menu listed it and no header merge took it)
//  B. a FLOATING window dropped onto a PANE of the split dock shows IN that pane (a docked tab dragged onto a pane
//     already did, 44 M9; a floating window could only dock as a tab through the strip). The view it replaces stays
//     docked as a tab
//  C. M11 under a pinned Connect bar: an OPEN left column starts below the logo's row (8a73b1c7), so the bar's
//     bottom-left corner stays ROUNDED (a square corner hung over the logo band); a PINNED left column and the right
//     column reach up to the bar, and there the corner is square
// Desktop 1440×900, a real mouse.
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE || null;
const shot = async (page, name) => {
	if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` }).catch(() => {});
};
const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		const st = name ? window.__stores[mod]?.[name] : window.__stores[mod];
		let v;
		st.subscribe((x) => (v = x))();
		return v;
	}, path);
const headerPoint = (page, sel) =>
	S(page, (sel) => {
		const t = document.querySelector(sel + ' .move-handle .wc-label, ' + sel + ' .move-handle .wc-title') ?? document.querySelector(sel + ' .move-handle');
		const r = t.getBoundingClientRect();
		return { x: Math.round(r.left + Math.min(16, r.width / 2)), y: Math.round(r.top + r.height / 2) };
	}, sel);
/** the "Group with…" submenu rows of the menu a header right-click opened */
async function groupWith(page, sel) {
	const pt = await headerPoint(page, sel);
	await page.mouse.click(pt.x, pt.y, { button: 'right' });
	await page.waitForTimeout(400);
	const row = page.locator('[role=menu] [role=menuitem]', { hasText: 'Group with' }).first();
	if (!(await row.count())) return null;
	await row.hover();
	await page.waitForTimeout(400);
	return S(page, () => {
		const r = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((x) => x.textContent.trim().startsWith('Group with'));
		return r ? [...r.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()) : [];
	});
}
async function closeMenus(page) {
	for (let i = 0; i < 3 && (await S(page, () => !!document.querySelector('[role=menu]'))); i++) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(250);
	}
}

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk', {
		context: { viewport: { width: 1440, height: 900 } },
		storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor":true,"editor-touch":true}', flowDocked: 'true', explorerDocked: 'true' }
	});
	const page = D.page;
	await page.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});

	// ═══ A. Statistics is tab-able ═══
	await S(page, () => {
		window.__stores.sceneBudget.statsOpen.set(true);
		window.__stores.chatHidden.set('');
	});
	await page.waitForTimeout(1200);
	h.check(await page.locator('#stats-window').isVisible(), 'A premise: Statistics is open as a floating window');
	let sub = await groupWith(page, '#stats-window');
	h.check(!!sub && sub.includes('Chat'), `A: Statistics' own menu offers Group with… ▸ Chat (${JSON.stringify(sub)})`);
	await closeMenus(page);
	const cands = await S(page, () => window.__stores.windowTabs.groupCandidates('chat').map((c) => c.title));
	h.check(cands.includes('Statistics'), `A: Chat's "Group with…" offers Statistics (${cands.join(', ')})`);
	sub = await groupWith(page, '#stats-window');
	await S(page, () => {
		const row = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((r) => r.textContent.trim().startsWith('Group with'));
		[...(row?.querySelectorAll('[role=menuitem]') ?? [])].find((r) => r.textContent.trim() === 'Chat')?.click();
	});
	await page.waitForTimeout(900);
	const groups = await read(page, 'windowTabs.tabGroups');
	h.check(groups.length === 1 && groups[0].members.includes('stats') && groups[0].members.includes('chat'), `A: Statistics and Chat form one tab group (${JSON.stringify(groups.map((g) => g.members))})`);
	const strip = await S(page, () => [...document.querySelectorAll('.tab-strip [role=tab], .tab-strip button')].map((b) => b.textContent.trim()).filter(Boolean));
	h.check(strip.some((t) => t.includes('Statistics')) && strip.some((t) => t.includes('Chat')), `A: the group's strip shows both tabs (${strip.join(' | ')})`);
	await shot(page, 'a-stats-chat-group');
	// back apart: closing Statistics leaves the group
	await S(page, () => {
		window.__stores.sceneBudget.statsOpen.set(false);
		window.__stores.chatHidden.set('hidden');
	});
	await page.waitForTimeout(800);

	// ═══ B. a floating window dropped onto a split pane ═══
	await S(page, async () => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		s.explorerClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		s.bottomDock.splitDock('flow', 'explorer');
	});
	await page.waitForTimeout(1500);
	const panes = await S(page, () => ['a', 'b'].map((p) => {
		const el = [...document.querySelectorAll(`[data-dock-pane="${p}"]`)].find((e) => e.getBoundingClientRect().width > 0);
		const r = el?.getBoundingClientRect();
		return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) } : null;
	}));
	h.check(!!panes[0] && !!panes[1], `B premise: the dock is split, Node editor | Explorer (${JSON.stringify(panes)})`);
	await S(page, () => window.__stores.sceneBudget.statsOpen.set(true));
	await page.waitForTimeout(1000);
	const from = await headerPoint(page, '#stats-window');
	const to = panes[1];
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 10 });
	await page.mouse.move(to.x, to.y, { steps: 10 });
	await page.waitForTimeout(250);
	const zone = await S(page, () => {
		const z = document.querySelector('.sb-drop-zone');
		const r = z?.getBoundingClientRect();
		return z ? { label: z.textContent.trim(), x: Math.round(r.left), w: Math.round(r.width) } : null;
	});
	h.check(!!zone && /Show in this pane/.test(zone.label) && Math.abs(zone.x - (to.x - to.w / 2)) <= 2, `B: over the right pane the highlight covers that pane and says so (${JSON.stringify(zone)})`);
	await shot(page, 'b-over-pane');
	await page.mouse.up();
	await page.waitForTimeout(1500);
	const split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split?.a === 'flow' && split?.b === 'stats', `B: dropped there, Statistics shows IN the right pane (${JSON.stringify(split)})`);
	const tabs = await read(page, 'bottomDock.dockTabs');
	h.check(tabs.some((t) => t.key === 'explorer'), `B: the Explorer it replaced stays docked as a tab (${tabs.map((t) => t.key).join(', ')})`);
	const shown = await read(page, 'bottomDock.dockShownKeys');
	h.check(shown.includes('flow') && shown.includes('stats'), `B: the dock shows Node editor | Statistics (${shown.join(' | ')})`);
	await shot(page, 'b-dropped');
	await S(page, () => window.__stores.bottomDock.unsplitDock('flow'));
	await page.waitForTimeout(500);

	// ═══ C. M11 under a pinned Connect bar ═══
	const C = await h.setupPage(browser, 'm11', { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toastsInDrawerOnly: 'true', 'connect:pin:desktop': 'pinned', toursSeen: '{"editor":true,"editor-touch":true}' } });
	const P = C.page;
	await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
	const corner = () =>
		P.evaluate(() => {
			const pill = document.querySelector('.connect-pill');
			const cs = getComputedStyle(pill);
			const g = window.__stores.sidebars.geometry;
			let geo;
			g.subscribe((v) => (geo = v))();
			return { bl: parseFloat(cs.borderBottomLeftRadius), br: parseFloat(cs.borderBottomRightRadius), barBottom: Math.round(pill.getBoundingClientRect().bottom), leftTop: geo.left.top, rightTop: geo.right.top };
		});
	const sidebar = async ({ side, open = true, full = false }) => {
		await P.evaluate(({ side, open, full }) => {
			const S = window.__stores;
			S.sidebars.inspectorSide.set(side);
			S.inspectorKind.set('scene');
			S.inspectorClose.set(!open);
			S.sidebars.toggleSidebarFull('left', side === 'left' && full);
			S.sidebars.toggleSidebarFull('right', side === 'right' && full);
			S.sidebars.setSidebarWidth(side, 300);
		}, { side, open, full });
		await P.waitForTimeout(900);
	};
	h.check(await P.evaluate(() => document.documentElement.classList.contains('connect-docked')), 'C premise: the Connect bar is pinned to the top row');
	await sidebar({ side: 'left', full: false });
	let c = await corner();
	h.check(c.leftTop - c.barBottom > 20, `C premise: an OPEN left column starts below the logo band, not at the bar (bar bottom ${c.barBottom}, column top ${c.leftTop})`);
	h.check(c.bl > 4, `C: …so the bar's bottom-LEFT corner stays rounded (radius ${c.bl})`);
	await shot(P, 'c-left-open-rounded');
	await sidebar({ side: 'left', full: true });
	c = await corner();
	h.check(c.bl === 0, `C: a PINNED left column reaches the bar → the bottom-left corner is square (radius ${c.bl})`);
	await sidebar({ side: 'right', full: false });
	c = await corner();
	h.check(c.br === 0 && c.rightTop - c.barBottom < 10, `C: an open RIGHT column tucks under the bar → its corner is square (radius ${c.br}, gap ${c.rightTop - c.barBottom})`);

	h.check(h.pageErrors(D).length === 0 && h.pageErrors(C).length === 0, 'no page errors: ' + [...h.pageErrors(D), ...h.pageErrors(C)].slice(0, 2).join(' | '));
	await h.finish(browser);
});
