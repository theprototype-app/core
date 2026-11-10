// 78 pl-windows (the 1.64 windows / layout polish, owner-approved 2026-11-09). One suite, three devices:
//   desktop 1920x1080 (mouse), HONOR 718x587 (touch, the desktop layout), OPPO N6 unfolded 770x837 -> folded 353x681.
//
//   PL4  (PC-14)  a floating window that OPENS never sits under an open sidebar column, nor off-screen
//   PL38          Chat and the AI assistant have a corner resize grip; the size is kept (win:<key>) across a reload
//   PL39          Small / Half / Full: a double click on the header cycles them (Half -> Full -> Small), the header
//                 menu's Size row offers them, a double TAP does it by finger, and on a touch screen the corner grip
//                 takes a finger 22 px in from the corner (the 28 px touch grip)
//   PL3           the workspace record (Restore, layouts) covers Chat, AI, Statistics, Free assets, HUD, Timeline, Profiler
//   PL20 (PC-4)   the Objects filter chips wrap: none is cut
//   PL21 (PC-8)   Far clip / Look for sit in the panel's label column; the Far clip box in the value column
//   PL6  (UI-5)   HONOR: a tall AI window (a long welcome) ends above the toolbar instead of covering it
//   PL7  (UI-6)   HONOR: the main menu ends above the toolbar and the + corner stack, and scrolls (bottom edge fades)
//   PL8  (UI-7)   folded: the Free assets kind tabs wrap, none is cut
//   PL23 (G19)    folded: Chat, the AI assistant and Free assets docked on the unfolded phone (bottom dock or a sidebar
//                 column) become phone DOCK tabs on the fold — no floating sheet — and go back where they were on the unfold
//
// Counterfactual (base feat/78-int f873ddf1, probe lanes-30/after-78/78-pl-windows/probe-base.log): stats/explorer at
// x 120/160 under a 320 px left column, chat/AI at x 1405-1905 under the right one; chips 295 > 248 px; Far clip label
// +4 px; folded assets tabs 439 > 335 px; folded chat / AI = framed sheets (data-ps-host); no Size row, no grip on Chat/AI.
// Shots (dark + light): OUT/windows-polish-*.png.
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';
const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		let v;
		(name ? window.__stores[mod][name] : window.__stores[mod]).subscribe((x) => (v = x))();
		return v;
	}, path);
const FLOATING = { explorerDocked: 'false', statsDocked: 'false', chatDocked: 'false', aiAssistantDocked: 'false', assetBrowserDocked: 'false', 'sidebar:inspectorSide': 'right' };
const rectOf = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), pd: el.getAttribute('data-pd-host'), ps: el.getAttribute('data-ps-host'), preset: el.dataset.sizePreset ?? null };
	}, sel);
const freeArea = (page) =>
	S(page, () => {
		const cs = getComputedStyle(document.documentElement);
		return { l: parseFloat(cs.getPropertyValue('--sb-free-left')) || 0, r: innerWidth - (parseFloat(cs.getPropertyValue('--sb-free-right')) || 0), vw: innerWidth, vh: innerHeight };
	});
/** dark + light shot of the page as it is now */
async function shots(page, name) {
	await page.screenshot({ path: `${OUT}/windows-polish-${name}-dark.png` });
	await S(page, () => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${OUT}/windows-polish-${name}-light.png` });
	await S(page, () => window.__stores.themes.theme.set('dark'));
	await page.waitForTimeout(300);
}
const headerPoint = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel + ' .move-handle');
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) };
	}, sel);

h.run(async () => {
	const browser = await h.launch();

	// =========================================== desktop 1920x1080 ===========================================
	{
		const P = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1920, height: 1080 } }, storage: FLOATING });
		const page = P.page;
		await S(page, () => {
			const st = window.__stores;
			st.inspectorKind.set('scene');
			st.inspectorClose.set(false);
			st.sidebars.toggleSidebar('right', true);
			st.sidebars.toggleSidebar('left', true);
		});
		await page.waitForTimeout(1500);
		const free = await freeArea(page);
		h.check(free.l > 0 && free.r < free.vw, `premise: both columns open (free area ${free.l}..${free.r} of ${free.vw})`);

		// ---- PL4: every window opens in the free area, on-screen
		const WINS = [
			['Statistics', '#stats-window', () => window.__stores.dockHost.HOSTED.stats.open()],
			['Chat', '#chat-window', () => window.__stores.chatHidden.set('')],
			['AI assistant', '#ai-assistant-window', () => window.__stores.aiAssistantHidden.set('')],
			['Explorer', '#explorer-window', () => window.__stores.explorerClose.set(false)],
			['Free assets', '#asset-browser-window', () => window.__stores.dockHost.HOSTED.assets.open()],
			['Objects', '#object-list', () => window.__stores.objectListClose.set(false)]
		];
		for (const [name, sel, open] of WINS) {
			await page.evaluate(open);
			// Free assets loads its chunk the first time it opens (cold on a dev server)
			await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {});
			await page.waitForTimeout(1100);
			const r = await rectOf(page, sel);
			h.check(!!r && r.l >= free.l && r.r <= free.r && r.t >= 0 && r.b <= free.vh, `PL4 ${name} opens between the columns, on-screen (${JSON.stringify(r)} in ${free.l}..${free.r})`);
		}
		await shots(page, 'desk-1920-columns-windows');
		// ...except a window placed over a column ON PURPOSE (the 45 N7 Ctrl drop): it reopens where it was put
		{
			// (the AI window opened after Chat lies over Chat's header)
			await S(page, () => window.__stores.aiAssistantHidden.set('hidden'));
			await page.waitForTimeout(400);
			const p = await headerPoint(page, '#chat-window');
			await page.keyboard.down('Control');
			await page.mouse.move(p.x, p.y);
			await page.mouse.down();
			await page.mouse.move((p.x + 200) / 2, p.y, { steps: 8 });
			await page.mouse.move(200, 300, { steps: 8 });
			await page.mouse.up();
			await page.keyboard.up('Control');
			await page.waitForTimeout(700);
			const placed = await rectOf(page, '#chat-window');
			await S(page, () => window.__stores.chatHidden.set('hidden'));
			await page.waitForTimeout(500);
			await S(page, () => window.__stores.chatHidden.set(''));
			await page.waitForTimeout(1100);
			const again = await rectOf(page, '#chat-window');
			const docked = await S(page, () => document.getElementById('chat-window')?.dataset.docked ?? null);
			h.check(!docked && !!placed && placed.l < free.l && !!again && Math.abs(again.l - placed.l) <= 2, `PL4 a window Ctrl-dropped over the left column reopens there (${JSON.stringify({ placed, again, docked })})`);
			await S(page, () => localStorage.removeItem('win:chat'));
			await S(page, () => window.__stores.chatHidden.set('hidden'));
			await page.waitForTimeout(400);
			await S(page, () => window.__stores.chatHidden.set(''));
			await page.waitForTimeout(900);
		}

		// ---- PL20: the Objects filter chips wrap, none cut
		const chips = await S(page, () => {
			const n = document.getElementById('filter-chips');
			const win = document.getElementById('object-list')?.getBoundingClientRect();
			const cfg = document.getElementById('chip-config')?.getBoundingClientRect();
			if (!n || !win) return null;
			const cut = [...n.querySelectorAll('button')].filter((b) => {
				const r = b.getBoundingClientRect();
				return r.right > (cfg ? cfg.left : win.right) + 1 || r.left < win.left - 1;
			});
			return { sw: n.scrollWidth, cw: n.clientWidth, n: n.querySelectorAll('button').length, cut: cut.map((b) => b.textContent.trim()) };
		});
		h.check(!!chips && chips.sw <= chips.cw + 1 && chips.cut.length === 0 && chips.n >= 5, `PL20 every Objects filter chip shows whole: the row wraps (${JSON.stringify(chips)})`);
		await page.locator('#object-list').screenshot({ path: `${OUT}/windows-polish-objects-chips-dark.png` });
		await S(page, () => window.__stores.themes.theme.set('light'));
		await page.waitForTimeout(400);
		await page.locator('#object-list').screenshot({ path: `${OUT}/windows-polish-objects-chips-light.png` });
		await S(page, () => window.__stores.themes.theme.set('dark'));
		await S(page, () => {
			window.__stores.objectListClose.set(true);
			window.__stores.dockHost.HOSTED.assets.close();
			window.__stores.explorerClose.set(true);
			window.__stores.dockHost.HOSTED.stats.close();
		});
		await page.waitForTimeout(500);

		// ---- PL21: Far clip / Look for in the label column, the Far clip box in the value column
		// 78-int: Configure Scene opens with only Environment + Scene look expanded (PL17) - deep-link Camera open first
		await S(page, () => window.__stores.openSceneSection('Camera'));
		await page.waitForFunction(() => !!document.getElementById('camera-far'), null, { timeout: 8000 }).catch(() => {});
		await page.waitForTimeout(400);
		const cols = await S(page, () => {
			const rowOf = (txt) => [...document.querySelectorAll('#inspector .pr')].find((r) => r.querySelector('.pr-label')?.textContent.trim() === txt);
			const out = {};
			for (const t of ['Far clip', 'Near clip', 'Camera FOV', 'Look for']) {
				const row = rowOf(t);
				const l = row?.querySelector('.pr-label')?.getBoundingClientRect();
				const v = row?.querySelector('.pr-value')?.getBoundingClientRect();
				out[t] = row ? { label: Math.round(l.left), value: v ? Math.round(v.left) : null } : null;
			}
			out.farInPr = !!document.getElementById('camera-far')?.closest('.pr .pr-value');
			return out;
		});
		const far = cols['Far clip'];
		const near = cols['Near clip'];
		h.check(!!far && !!near && Math.abs(far.label - near.label) <= 1, `PL21 the Far clip label sits in the label column with Near clip (${JSON.stringify(cols)})`);
		h.check(!!far && !!near && cols.farInPr && far.value !== null && Math.abs(far.value - near.value) <= 1, `PL21 the Far clip box sits in the value column, under Near clip's box`);
		h.check(!!cols['Look for'] && Math.abs(cols['Look for'].label - near.label) <= 1, `PL21 "Look for" sits in the label column too`);
		await S(page, () => document.getElementById('camera-far')?.scrollIntoView({ block: 'center' }));
		await page.waitForTimeout(400);
		await page.locator('#inspector').screenshot({ path: `${OUT}/windows-polish-far-clip-dark.png` });
		await S(page, () => window.__stores.themes.theme.set('light'));
		await page.waitForTimeout(400);
		await page.locator('#inspector').screenshot({ path: `${OUT}/windows-polish-far-clip-light.png` });
		await S(page, () => window.__stores.themes.theme.set('dark'));

		// ---- PL38: Chat and AI have the corner grip, and it resizes
		await S(page, () => {
			window.__stores.aiAssistantHidden.set('hidden');
			for (const s of ['left', 'right']) window.__stores.sidebars.toggleSidebar(s, false);
		});
		await page.waitForTimeout(900);
		for (const [name, sel, key] of [['Chat', '#chat-window', 'chat'], ['AI assistant', '#ai-assistant-window', 'aiAssistant']]) {
			if (key === 'aiAssistant') await S(page, () => window.__stores.aiAssistantHidden.set(''));
			await page.waitForTimeout(700);
			const g = await S(page, (sel) => {
				const grip = document.querySelector(sel + ' > .dw-resize');
				const r = grip?.getBoundingClientRect();
				return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === grip } : null;
			}, sel);
			h.check(!!g && g.top, `PL38 ${name} has a corner resize grip, on top at its spot (${JSON.stringify(g)})`);
			if (!g) continue;
			const before = await rectOf(page, sel);
			await page.mouse.move(g.x, g.y);
			await page.mouse.down();
			for (let i = 1; i <= 8; i++) await page.mouse.move(g.x - 10 * i, g.y - 6 * i);
			await page.mouse.up();
			await page.waitForTimeout(400);
			const after = await rectOf(page, sel);
			const stored = await S(page, (key) => JSON.parse(localStorage.getItem('win:' + key) ?? 'null'), key);
			h.check(!!after && after.w < before.w - 40 && after.h < before.h - 20 && stored?.w === after.w && stored?.h === after.h, `PL38 dragging ${name}'s grip resizes it and saves the size (${before.w}x${before.h} -> ${after?.w}x${after?.h}, stored ${JSON.stringify(stored)})`);
		}

		// ---- PL39: a double click on the header cycles Half -> Full -> Small, inside the free area
		await S(page, () => {
			window.__stores.aiAssistantHidden.set('hidden');
			window.__stores.sidebars.toggleSidebar('right', true);
		});
		await page.waitForTimeout(1000);
		const free2 = await freeArea(page);
		const cycle = [];
		for (const want of ['half', 'full', 'small']) {
			const p = await headerPoint(page, '#chat-window');
			await page.mouse.dblclick(p.x, p.y);
			await page.waitForTimeout(500);
			const r = await rectOf(page, '#chat-window');
			cycle.push({ want, r });
			if (want === 'full') await shots(page, 'desk-chat-full');
			if (want === 'half') await shots(page, 'desk-chat-half');
		}
		const [half, full, small] = cycle.map((c) => c.r);
		const freeW = free2.r - free2.l;
		h.check(!!half && half.preset === 'half' && Math.abs(half.w - (freeW - 24) / 2) <= 6 && half.l >= free2.l && half.r <= free2.r, `PL39 1st double click: Half — half the free width (${JSON.stringify(half)}, free ${free2.l}..${free2.r})`);
		h.check(!!full && full.preset === 'full' && full.w >= freeW - 20 && full.l >= free2.l && full.r <= free2.r && full.h > 600, `PL39 2nd: Full — the whole free area between the sidebars (${JSON.stringify(full)})`);
		h.check(!!small && small.preset === 'small' && small.w <= 400 && small.h <= 340, `PL39 3rd: Small (${JSON.stringify(small)})`);
		const pill = await rectOf(page, '#controls-pill');
		h.check(!!full && !!pill && (full.b <= pill.t || full.r <= pill.l || full.l >= pill.r), `PL39 Full stops above the toolbar (${full?.b} <= ${pill?.t})`);
		const kept = await S(page, () => JSON.parse(localStorage.getItem('win:chat') ?? 'null'));
		h.check(kept?.preset === 'small', `PL39 the preset is remembered with the window's rect (${JSON.stringify(kept)})`);
		// the header menu's Size row
		const hp = await headerPoint(page, '#chat-window');
		await page.mouse.click(hp.x, hp.y, { button: 'right' });
		await page.waitForTimeout(500);
		const rows = await S(page, () => [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((r) => r.textContent.trim()));
		h.check(rows.some((r) => r.startsWith('Size')), `PL39 the header menu has a Size row (${JSON.stringify(rows)})`);
		await page.locator('[role=menu] [role=menuitem]', { hasText: /^\s*Size/ }).first().hover();
		await page.waitForTimeout(500);
		const sub = await S(page, () => [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((r) => r.textContent.trim()));
		h.check(['Small', 'Half', 'Full'].every((x) => sub.some((r) => r.startsWith(x))), `PL39 Size ▸ Small / Half / Full (${JSON.stringify(sub)})`);
		await shots(page, 'desk-size-menu');
		await page.locator('[role=menu] [role=menuitem]', { hasText: /^\s*Full\s*$/ }).first().click();
		await page.waitForTimeout(500);
		h.check((await rectOf(page, '#chat-window'))?.preset === 'full', 'PL39 Size ▸ Full sizes the window to Full');
		// a hand resize drops the preset (the size is the user's again)
		const g = await S(page, () => {
			const r = document.querySelector('#chat-window > .dw-resize').getBoundingClientRect();
			return { x: r.left + 8, y: r.top + 8 };
		});
		await page.mouse.move(g.x, g.y);
		await page.mouse.down();
		for (let i = 1; i <= 5; i++) await page.mouse.move(g.x - 20 * i, g.y - 10 * i);
		await page.mouse.up();
		await page.waitForTimeout(300);
		h.check((await rectOf(page, '#chat-window'))?.preset === null, 'PL39 a hand resize leaves the preset');

		// ---- PL3: the workspace record covers the windows a Restore missed
		await S(page, () => {
			const st = window.__stores;
			st.aiAssistantHidden.set('');
			st.dockHost.HOSTED.stats.open();
			st.dockHost.HOSTED.assets.open();
			st.hudEditorClose.set(false);
		});
		await page.waitForTimeout(800);
		const snap = await S(page, () => window.__stores.workspace.snapshotWorkspace());
		const want = ['chat', 'aiAssistant', 'stats', 'assets', 'hud'];
		h.check(!!snap && want.every((k) => snap.open[k] === true) && ['timeline', 'profiler'].every((k) => snap.open[k] === false), `PL3 the workspace record names Chat, AI, Statistics, Free assets, HUD, Timeline, Profiler (${JSON.stringify(snap?.open)})`);
		await S(page, () => window.__stores.workspace.closeWorkspace());
		await page.waitForTimeout(500);
		const closed = { chat: await read(page, 'chatHidden'), ai: await read(page, 'aiAssistantHidden') };
		await S(page, (snap) => window.__stores.workspace.applyWorkspace(snap), snap);
		await page.waitForTimeout(1000);
		await page.waitForFunction(() => (document.querySelector('#asset-browser-window')?.getBoundingClientRect().width ?? 0) > 0, null, { timeout: 15000 }).catch(() => {});
		const back = await S(page, () => ['#chat-window', '#ai-assistant-window', '#stats-window', '#asset-browser-window'].map((sel) => {
			const el = document.querySelector(sel);
			return !!el && el.getBoundingClientRect().width > 0;
		}));
		h.check(closed.chat === 'hidden' && closed.ai === 'hidden' && back.every(Boolean), `PL3 closed, then the record applied: Chat, AI, Statistics and Free assets come back (${JSON.stringify({ closed, back })})`);
		// the size of a resized window across a real reload
		const sized = await S(page, () => JSON.parse(localStorage.getItem('win:aiAssistant') ?? 'null'));
		await h.freshReload(P);
		await h.answerRestore(P);
		await page.waitForTimeout(1500);
		await S(page, () => window.__stores.aiAssistantHidden.set(''));
		await page.waitForTimeout(1200);
		const ai = await rectOf(page, '#ai-assistant-window');
		h.check(!!sized && !!ai && Math.abs(ai.w - sized.w) <= 1 && Math.abs(ai.h - sized.h) <= 1, `PL3/PL38 the AI window's size survives a reload (${JSON.stringify({ sized, ai })})`);

		// ---- PL2: the viewport menu's rows carry icons (a row's own, else its verb's); no glyph-prefixed labels
		await S(page, () => window.__stores.aiAssistantHidden.set('hidden'));
		await page.waitForTimeout(400);
		const bareRows = async () =>
			S(page, () => {
				const menus = [...document.querySelectorAll('[role=menu]')].filter((m) => m.getClientRects().length);
				const rows = menus.flatMap((m) => [...m.querySelectorAll('[role=menuitem]')]).filter((r) => r.getClientRects().length);
				const own = (r) => r.querySelector(':scope > span .flex-1, :scope > span > .flex-1')?.textContent.trim() ?? r.textContent.trim();
				return { n: rows.length, bare: rows.filter((r) => !r.querySelector('.ctx-ico svg')).map(own), glyph: rows.map(own).filter((t) => /^[▶■↺❚●✓✕]/.test(t)) };
			});
		await page.mouse.click(960, 600, { button: 'right' });
		await page.waitForTimeout(600);
		const top = await bareRows();
		await page.locator('[role=menu] [role=menuitem]', { hasText: /^\s*Tools/ }).first().hover();
		await page.waitForTimeout(500);
		const tools = await bareRows();
		h.check(top.n >= 6 && top.bare.length === 0 && tools.bare.length === 0 && tools.glyph.length === 0, `PL2 the viewport menu and its Tools submenu: every row has an icon, no glyph-prefixed label (${JSON.stringify({ top, tools })})`);
		await shots(page, 'desk-viewport-menu-tools');
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		await P.ctx.close();
	}

	// =========================================== HONOR 718x587 (touch) ===========================================
	{
		const P = await h.setupPage(browser, 'honor', { context: { viewport: { width: 718, height: 587 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, storage: FLOATING });
		const page = P.page;
		// ---- PL6: a TALL AI window (the long welcome the device lab saw; the dev build's is short) ends above the toolbar
		await S(page, () => window.__stores.aiAssistantHidden.set(''));
		await page.waitForTimeout(900);
		await S(page, () => {
			const win = document.getElementById('ai-assistant-window');
			const pad = document.createElement('div');
			pad.id = 'e2e-tall-welcome';
			pad.style.cssText = 'height: 900px; flex-shrink: 0';
			win.appendChild(pad);
			window.__stores.aiAssistantHidden.set('hidden');
		});
		await page.waitForTimeout(600);
		await S(page, () => window.__stores.aiAssistantHidden.set(''));
		await page.waitForTimeout(1200);
		const ai = await rectOf(page, '#ai-assistant-window');
		const pill = await rectOf(page, '#controls-pill');
		const onTop = await S(page, () => {
			const p = document.getElementById('controls-pill').getBoundingClientRect();
			const t = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2);
			return !!t?.closest('#controls-pill');
		});
		h.check(!!ai && !!pill && ai.b <= pill.t && onTop, `PL6 HONOR: the tall AI window ends above the toolbar, which stays on top (${JSON.stringify({ ai, pill, onTop })})`);
		await shots(page, 'honor-ai-tall');
		await S(page, () => {
			document.getElementById('e2e-tall-welcome')?.remove();
			window.__stores.aiAssistantHidden.set('hidden');
		});

		// ---- PL7: the main menu ends above the toolbar and the + stack, inside the screen, and scrolls with a fade
		await S(page, () => window.__stores.closeMenu.set(false));
		await page.waitForTimeout(1000);
		const menu = await S(page, () => {
			const el = document.getElementById('sidebar70');
			const r = el.getBoundingClientRect();
			const pill = document.getElementById('controls-pill')?.getBoundingClientRect();
			const stack = [...document.querySelectorAll('#hud-stack-left > *')].map((e) => e.getBoundingClientRect()).filter((s) => s.width && s.left < r.right && s.right > r.left);
			return { b: Math.round(r.bottom), vh: innerHeight, pillT: pill ? Math.round(pill.top) : null, stackT: stack.length ? Math.round(Math.min(...stack.map((s) => s.top))) : null, scrolls: el.scrollHeight > el.clientHeight + 1, fade: el.dataset.fadeY || '' };
		});
		h.check(menu.b <= menu.vh && (menu.stackT === null || menu.b <= menu.stackT) && (menu.pillT === null || menu.b <= menu.pillT), `PL7 HONOR: the main menu ends inside the screen, above the toolbar and the + corner stack (${JSON.stringify(menu)})`);
		h.check(!menu.scrolls || menu.fade === 'end', `PL7 ...and what does not fit scrolls, its bottom edge fading (${menu.fade})`);
		await shots(page, 'honor-menu');
		await S(page, () => window.__stores.closeMenu.set(true));
		await page.waitForTimeout(500);

		// ---- PL39 on a touch screen: the 28 px grip and the double TAP
		await S(page, () => window.__stores.chatHidden.set(''));
		await page.waitForTimeout(900);
		const grip = await S(page, () => {
			const win = document.getElementById('chat-window');
			const r = win.getBoundingClientRect();
			const t = document.elementFromPoint(r.right - 22, r.bottom - 22);
			return { coarse: matchMedia('(pointer: coarse)').matches, hit: !!t?.closest('.dw-resize'), at: t?.className ?? t?.tagName };
		});
		h.check(grip.coarse && grip.hit, `PL39 touch: a finger 22 px in from Chat's corner lands on the resize grip (the 28 px touch grip) (${JSON.stringify(grip)})`);
		const tp = await headerPoint(page, '#chat-window');
		await page.touchscreen.tap(tp.x, tp.y);
		await page.waitForTimeout(120);
		await page.touchscreen.tap(tp.x, tp.y);
		await page.waitForTimeout(600);
		const tapped = await rectOf(page, '#chat-window');
		h.check(tapped?.preset === 'half', `PL39 touch: a double tap on Chat's header sizes it to Half (${JSON.stringify(tapped)})`);
		await shots(page, 'honor-chat-half');
		await P.ctx.close();
	}

	// =========================================== N6: unfolded -> folded -> unfolded ===========================================
	{
		const UNFOLDED = { width: 770, height: 837 };
		const FOLDED = { width: 353, height: 681 };
		const P = await h.setupPage(browser, 'n6', { context: { viewport: UNFOLDED, hasTouch: true, isMobile: true, deviceScaleFactor: 2.8 }, storage: FLOATING });
		const page = P.page;
		// ---- PL23 bottom dock: Free assets, AI, Chat docked, Chat in front
		await S(page, () => {
			const d = window.__stores.dockHost;
			for (const k of ['assets', 'aiAssistant', 'chat']) d.setHostedDocked(k, true);
			window.__stores.bottomDock.activateDock('chat');
		});
		await page.waitForTimeout(1500);
		const wide = await S(page, () => {
			let v;
			window.__stores.dockHost.hostedTabsOpen.subscribe((x) => (v = x))();
			return v;
		});
		h.check(wide.chat && wide.aiAssistant && wide.assets, `PL23 premise: unfolded, Chat / AI / Free assets are bottom-dock tabs (${JSON.stringify(wide)})`);
		await page.setViewportSize(FOLDED);
		await page.waitForTimeout(2500);
		const folded = await S(page, () => {
			const st = window.__stores;
			let phoneTabs, key;
			st.phoneDock.phoneTabsOpen.subscribe((x) => (phoneTabs = x))();
			st.bottomDock.visibleDockKey.subscribe((x) => (key = x))();
			const el = (sel) => {
				const e = document.querySelector(sel);
				const r = e?.getBoundingClientRect();
				return e ? { pd: e.getAttribute('data-pd-host'), ps: e.getAttribute('data-ps-host'), w: Math.round(r.width), h: Math.round(r.height) } : null;
			};
			return { shell: document.documentElement.classList.contains('phone-shell'), phoneTabs, key, sheet: !!document.querySelector('.ps-sheet'), chat: el('#chat-window'), ai: el('#ai-assistant-window'), assets: el('#asset-browser-window'), strip: [...document.querySelectorAll('[data-dock-tab]')].filter((t) => t.getBoundingClientRect().width > 0).map((t) => t.getAttribute('data-dock-tab')) };
		});
		h.check(folded.shell && folded.phoneTabs.chat && folded.phoneTabs.aiAssistant && folded.phoneTabs.assets, `PL23 folded: Chat, AI and Free assets are phone dock tabs (${JSON.stringify(folded.phoneTabs)})`);
		h.check(folded.chat?.pd === 'shown' && folded.chat.w === FOLDED.width && folded.key === 'chat', `PL23 folded: Chat — in front before the fold — is the tab in front, full width in the dock (${JSON.stringify({ chat: folded.chat, key: folded.key })})`);
		h.check(folded.ai?.pd === 'hidden' && folded.assets?.pd === 'hidden', `PL23 folded: AI and Free assets wait behind it as tabs, mounted (${JSON.stringify({ ai: folded.ai, assets: folded.assets })})`);
		h.check(!folded.sheet && !folded.chat?.ps && !folded.ai?.ps, `PL23 folded: no floating sheet piled over the bar`);
		h.check(['chat', 'aiAssistant', 'assets'].every((k) => folded.strip.includes(k)), `PL23 folded: the strip shows their three tabs (${JSON.stringify(folded.strip)})`);
		await shots(page, 'folded-chat-tab');
		// ---- PL8: Free assets in front, its kind tabs wrap (none cut)
		await S(page, () => window.__stores.bottomDock.activateDock('assets'));
		await page.waitForTimeout(1200);
		const tabs = await S(page, () => {
			const win = document.getElementById('asset-browser-window');
			const l = win?.querySelector('[role="tablist"]');
			if (!l) return null;
			const wr = win.getBoundingClientRect();
			const cut = [...l.querySelectorAll('[role="tab"]')].filter((t) => {
				const r = t.getBoundingClientRect();
				return r.right > wr.right + 1 || r.left < wr.left - 1;
			});
			return { sw: l.scrollWidth, cw: l.clientWidth, n: l.querySelectorAll('[role="tab"]').length, cut: cut.map((t) => t.textContent.trim()), pd: win.getAttribute('data-pd-host') };
		});
		h.check(!!tabs && tabs.pd === 'shown' && tabs.sw <= tabs.cw + 1 && tabs.cut.length === 0 && tabs.n >= 5, `PL8 folded: Free assets (a dock tab) shows every kind tab whole: they wrap (${JSON.stringify(tabs)})`);
		await shots(page, 'folded-free-assets');
		// the bar's Chat item: shows the chat tab, a second tap minimizes the dock
		await S(page, () => window.__stores.phoneDock.phoneBarTap('chat'));
		await page.waitForTimeout(600);
		const k1 = await read(page, 'bottomDock.visibleDockKey');
		await S(page, () => window.__stores.phoneDock.phoneBarTap('chat'));
		await page.waitForTimeout(600);
		const min = await read(page, 'bottomDock.dockMinimized');
		h.check(k1 === 'chat' && min === true && (await read(page, 'chatHidden')) === '', `PL23 folded: the bar's Chat brings its tab forward, a second tap minimizes the dock (chat stays open) (${JSON.stringify({ k1, min })})`);
		await S(page, () => window.__stores.bottomDock.dockMinimized.set(false));
		// ---- unfold: back in the bottom dock
		await page.setViewportSize(UNFOLDED);
		await page.waitForTimeout(2500);
		const back = await S(page, () => {
			const st = window.__stores;
			let hosted, docked;
			st.dockHost.hostedTabsOpen.subscribe((x) => (hosted = x))();
			st.dockHost.hostedDocked.subscribe((x) => (docked = x))();
			return { shell: document.documentElement.classList.contains('phone-shell'), hosted, docked, ps: !!document.querySelector('[data-ps-host]') };
		});
		h.check(!back.shell && back.hosted.chat && back.hosted.aiAssistant && back.hosted.assets && !back.ps, `PL23 unfolded again: all three are bottom-dock tabs as before (${JSON.stringify(back)})`);
		await shots(page, 'unfolded-again-dock');
		// ---- PL23 side column: Chat in the right column, fold, unfold
		await S(page, () => {
			const d = window.__stores.dockHost;
			for (const k of ['assets', 'aiAssistant', 'chat']) d.setHostedDocked(k, false);
			window.__stores.aiAssistantHidden.set('hidden');
			window.__stores.dockHost.HOSTED.assets.close();
		});
		await page.waitForTimeout(800);
		await S(page, () => window.__stores.docking.dockToSide('chat', 'right'));
		await page.waitForTimeout(1200);
		const side0 = await S(page, () => document.getElementById('chat-window')?.dataset.docked ?? null);
		h.check(side0 === 'right', `PL23 premise: Chat is a tab of the right column (${side0})`);
		await page.setViewportSize(FOLDED);
		await page.waitForTimeout(2500);
		const sideFold = await rectOf(page, '#chat-window');
		h.check(sideFold?.pd === 'shown' && !sideFold.ps && sideFold.w === FOLDED.width, `PL23 folded: the column's Chat is a phone dock tab, not a sheet (${JSON.stringify(sideFold)})`);
		await page.setViewportSize(UNFOLDED);
		await page.waitForTimeout(2500);
		const side1 = await S(page, () => ({ docked: document.getElementById('chat-window')?.dataset.docked ?? null, pd: document.getElementById('chat-window')?.getAttribute('data-pd-host') }));
		h.check(side1.docked === 'right' && !side1.pd, `PL23 unfolded again: Chat is back in the right column (${JSON.stringify(side1)})`);
		await P.ctx.close();
	}

	await h.finish(browser);
});
