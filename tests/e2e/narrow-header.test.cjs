// showhide-v8 §3 — THE NARROW HEADER. The owner: "this view for mobile (folded or when split view and not enough space)
// will be taken as example for other mobile view tabs instead of sidebars" (the Animation tab's phone header), and
// "when split view and short in space in width, header breaks and covers interface of right window split ... headers
// should also be possible to drag left/right if no space to show everything".
//
// Every docked window built on WindowShell (Explorer, UV editor, HUD editor, Profiler, Image editor) on a touch phone
// whose dock is narrower than 560 px:
//   1  FOLDED (390 px): one header row names every view (primary pane, main area, each side mode); no edge handles;
//      the main area is in front; a tap shows that view full width with the main area hidden; the same tap again goes
//      back; the pick is remembered across a reload
//   2  UNFOLDED, dock not split (770 px): the column panes and their edge handles as before (counterfactual for 1)
//   3  UNFOLDED, dock split Explorer | Node editor: the Explorer half gets the header, and nothing of the Explorer's
//      own header row is drawn over the Node editor half (it scrolls sideways instead)
//   4  DESKTOP (1280 px, mouse): no header, the handles as before; the HUD's cog and the UV editor's right panel are
//      arrow handles carrying their Lucide role icon (§2)
//
// Run: APP_URL=https://theprototype.app:6995/ npm run e2e -- narrow-header
const h = require('./helpers.cjs');

const PHONE = { hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const TOURS = '{"editor-touch":true,"editor":true}';
const DOCKED = { flowDocked: 'true', explorerDocked: 'true', uvDocked: 'true', hudDocked: 'true' };
const CLOSERS = ['explorerClose', 'flowGraphClose', 'uvEditorClose', 'hudEditorClose', 'codeWorkspaceClose', 'profilerClose'];
const WINDOWS = [
	// [closer, name, root, expected header keys]
	['explorerClose', 'Explorer', '#explorer-list', ['primary', 'main', 'props', 'history', 'settings']],
	['uvEditorClose', 'UV editor', '#uv-dock', ['primary', 'main', 'tool', 'settings']],
	['hudEditorClose', 'HUD editor', '#hud-dock', ['primary', 'main', 'props']],
	['profilerClose', 'Profiler', '#profiler-dock', ['primary', 'main', 'details', 'settings']]
];
const S = (page, fn, arg) => page.evaluate(fn, arg);

async function showOnly(P, which) {
	await S(P, ({ which, closers }) => {
		for (const c of closers) window.__stores[c].set(c !== which);
	}, { which, closers: CLOSERS });
	await P.waitForTimeout(1200);
}
async function answerRestore(P) {
	for (let i = 0; i < 10; i++) {
		// a fresh context can still be navigating (or the dev server reloads it): a lost context is a retry, not a crash
		const b = await P.$('#restore-session-dismiss').catch(() => null);
		if (b) return b.click().catch(() => {});
		await P.waitForTimeout(300);
	}
}
/** the shell of the docked window in front: header keys, handles, which view shows */
const shell = (P, root) =>
	S(P, (root) => {
		const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
		const r = document.querySelector(root);
		const ws = r?.querySelector('.ws-root');
		if (!ws) return null;
		const main = ws.querySelector(':scope > .ws-main');
		const panels = [...ws.querySelectorAll(':scope > .ws-panel')].filter(vis);
		const wr = ws.getBoundingClientRect();
		return {
			narrow: ws.hasAttribute('data-ws-narrow'),
			header: [...ws.querySelectorAll(':scope > .ws-hdr [data-ws-pane]')].map((b) => b.getAttribute('data-ws-pane')),
			active: ws.querySelector(':scope > .ws-hdr [aria-selected="true"]')?.getAttribute('data-ws-pane') ?? null,
			handles: [...ws.querySelectorAll(':scope > .tp-pane-handle')].filter(vis).length,
			main: vis(main),
			panels: panels.map((p) => ({ sec: p.classList.contains('ws-panel-secondary'), full: Math.abs(p.getBoundingClientRect().width - wr.width) <= 2 })),
			w: Math.round(wr.width)
		};
	}, root);

h.run(async () => {
	const browser = await h.launch();

	// ---------------------------------------------------------------- 1. folded
	{
		const A = await h.setupPage(browser, 'folded', { context: { viewport: { width: 390, height: 844 }, ...PHONE }, storage: { theme: 'dark', toursSeen: TOURS } });
		const P = A.page;
		await answerRestore(P);
		for (const [closer, name, root, keys] of WINDOWS) {
			await showOnly(P, closer);
			let s = await shell(P, root);
			if (!s) {
				h.check(false, `1.0 folded ${name}: its shell is on screen`);
				continue;
			}
			h.check(s.narrow && JSON.stringify(s.header) === JSON.stringify(keys), `1.1 folded ${name}: one header names every view ${JSON.stringify(s.header)}`);
			h.check(s.handles === 0, `1.2 folded ${name}: no edge handles (${s.handles})`);
			h.check(s.active === 'main' && s.main && s.panels.length === 0, `1.3 folded ${name}: the main area is in front (${JSON.stringify({ active: s.active, panels: s.panels })})`);
			const side = keys[keys.length - 1];
			await P.locator(`${root} .ws-hdr [data-ws-pane="${side}"]`).tap();
			await P.waitForTimeout(400);
			s = await shell(P, root);
			h.check(s.active === side && !s.main && s.panels.length === 1 && s.panels[0].sec && s.panels[0].full, `1.4 folded ${name}: a tap on "${side}" shows it full width, the main area hidden (${JSON.stringify(s)})`);
			await P.locator(`${root} .ws-hdr [data-ws-pane="${side}"]`).tap();
			await P.waitForTimeout(400);
			s = await shell(P, root);
			h.check(s.active === 'main' && s.main && s.panels.length === 0, `1.5 folded ${name}: the same tap again goes back to the main area`);
		}
		// remembered: the Explorer's folder tree picked, then a reload
		await showOnly(P, 'explorerClose');
		await P.locator('#explorer-list .ws-hdr [data-ws-pane="primary"]').tap();
		await P.waitForTimeout(400);
		await h.freshReload(A);
		await answerRestore(P);
		await P.waitForTimeout(800);
		await showOnly(P, 'explorerClose');
		const s = await shell(P, '#explorer-list');
		h.check(s?.active === 'primary' && s.panels.length === 1 && !s.panels[0].sec, `1.6 folded: the view picked is remembered across a reload (${JSON.stringify(s)})`);
		await A.ctx.close();
	}

	// ---------------------------------------------------------------- 2 + 3. unfolded
	{
		const A = await h.setupPage(browser, 'unfolded', { context: { viewport: { width: 770, height: 850 }, ...PHONE }, storage: { theme: 'dark', toursSeen: TOURS, ...DOCKED, bottomDockSplits: '[]' } });
		const P = A.page;
		await answerRestore(P);
		await showOnly(P, 'explorerClose');
		let s = await shell(P, '#explorer-list');
		h.check(!!s && !s.narrow && s.header.length === 0 && s.handles >= 1, `2.1 unfolded, not split: the Explorer keeps its column panes and edge handles (${JSON.stringify(s)})`);
		await S(P, async () => {
			const st = window.__stores;
			st.flowGraphClose.set(false);
			await new Promise((r) => setTimeout(r, 600));
			st.bottomDock.activateDock('explorer');
			st.bottomDock.splitDock('explorer', 'flow', 0.4);
		});
		await P.waitForTimeout(1200);
		s = await shell(P, '#explorer-list');
		h.check(!!s && s.narrow && s.header.includes('main'), `3.1 unfolded, split: the Explorer half gets the header (${JSON.stringify(s)})`);
		const over = () =>
			S(P, () => {
				const div = document.getElementById('dock-split-divider')?.getBoundingClientRect();
				if (!div) return { split: false };
				const hits = new Set();
				for (let y = Math.round(div.top); y < div.top + 160; y += 4)
					for (let x = Math.round(div.right + 2); x < div.right + 300; x += 8) {
						const el = document.elementFromPoint(x, y);
						// the dock's tab strip is ONE row for the pair by design (44 M9), so it is not a spill
						if (el?.closest('#explorer-list') && !el.closest('.dt-row')) hits.add(el.id || el.className?.baseVal || String(el.className).slice(0, 30));
					}
				return { split: true, hits: [...hits] };
			});
		const o = await over();
		h.check(o.split && o.hits.length === 0, `3.2 nothing of the Explorer's header is drawn over the Node editor half (${JSON.stringify(o)})`);
		// counterfactual: the row really is wider than its half (so 3.2 is not vacuous) — the strip has content to scroll,
		// and with its clipping switched off it spills into the other half
		const fit = await S(P, () => {
			const strip = document.querySelector('#explorer-list #explorer-dock-strip');
			return strip ? { scrollW: strip.scrollWidth, clientW: strip.clientWidth } : null;
		});
		await S(P, () => {
			const strip = document.querySelector('#explorer-list #explorer-dock-strip');
			if (strip) for (const k of ['overflow', 'overflow-x']) strip.style.setProperty(k, 'visible', 'important');
		});
		await P.waitForTimeout(200);
		const o2 = await over();
		h.check(!!fit && fit.scrollW > fit.clientW + 4, `3.3 (counterfactual) the row is wider than its half and scrolls (${JSON.stringify(fit)}; unclipped spill ${JSON.stringify(o2.hits)})`);
		await A.ctx.close();
	}

	// ---------------------------------------------------------------- 4. desktop
	{
		const A = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1280, height: 800 } }, storage: { theme: 'dark', toursSeen: TOURS, ...DOCKED, bottomDockSplits: '[]' } });
		const P = A.page;
		await answerRestore(P);
		await showOnly(P, 'explorerClose');
		const s = await shell(P, '#explorer-list');
		h.check(!!s && !s.narrow && s.header.length === 0 && s.handles >= 1, `4.1 desktop: no header, the edge handles as before (${JSON.stringify(s)})`);
		// §2: the HUD's right cog and the UV editor's right panel are arrow handles (the PaneHandle shape) carrying the Lucide role icon
		for (const [closer, root, icons] of [['hudEditorClose', '#hud-dock', ['lucide-settings']], ['uvEditorClose', '#uv-dock', ['lucide-brush', 'lucide-settings']]]) {
			await showOnly(P, closer);
			const hd = await S(P, (root) => {
				const b = document.querySelector(`${root} .ws-root > [data-ws-secondary-toggle]`);
				if (!b) return null;
				const r = b.getBoundingClientRect();
				const ws = b.closest('.ws-root').getBoundingClientRect();
				return { handle: b.classList.contains('tp-pane-handle'), svgs: [...b.querySelectorAll('svg')].map((x) => String(x.className.baseVal)), atRight: Math.abs(ws.right - r.right) < 2 || !!b.getAttribute('aria-expanded') };
			}, root);
			h.check(!!hd && hd.handle && hd.atRight && hd.svgs.some((c) => icons.some((i) => c.includes(i))), `4.2 ${root}: the right panel opens from an arrow handle with its role icon (${JSON.stringify(hd)})`);
		}
		await A.ctx.close();
	}

	await h.finish(browser);
});
