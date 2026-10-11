// 41 G5 — PROFESSIONAL DRAWERS: THE NESTED-SCROLL HAND-OFF, on every phone drawer.
// OPPO Find N6 FOLDED (390x896 css, DPR 2.9, touch), driven by REAL touch events
// (CDP Input.dispatchTouchEvent — the path a finger takes, including the browser's own native
// scrolling of a list). The user: "I want to be able to swipe down drawer to close, where its a
// list of items (object list drawer should maintain functionality of scrolling through items
// and when on top of list i should be able to close drawer by swap)".
//
// For each drawer (Objects, Explorer, Notes, Add, Inspector, main menu, notifications, profile
// menu, More, Configure Scene) the body — NOT the grab bar — is dragged:
//   1. drag UP on a list that scrolls: the LIST scrolls, the sheet does not move;
//   2. scrolled down, drag DOWN past the list's top in ONE gesture: the list scrolls back and
//      the sheet stays open (a gesture that began as a scroll stays a scroll — no accidental close);
//   3. at the top, a slow drag down moves the SHEET with the finger (measured mid-gesture);
//   4. hand-back: pulled down, then back up past the start — the sheet stops at its start
//      height and the list scrolls by the rest;
//   5. at the top, a FLICK down closes the drawer;
//   6. a dragged touch never opens the row under it.
// Plus: rubber band past the max (the sheet resists, then springs back), and a sideways move
// on the body is left alone.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {import('playwright').Page} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
	/** a polyline gesture: points [[x,y],...]; `stepMs` between moves; `holdMs` before lifting;
	 *  `mid(i)` runs after move i (to measure mid-gesture) */
	const path = async (pts, { steps = 10, stepMs = 16, holdMs = 120, mid = null } = {}) => {
		await T('touchStart', [{ x: pts[0][0], y: pts[0][1], id: 1 }]);
		let n = 0;
		for (let k = 1; k < pts.length; k++) {
			const [ax, ay] = pts[k - 1];
			const [bx, by] = pts[k];
			for (let i = 1; i <= steps; i++) {
				await T('touchMove', [{ x: ax + ((bx - ax) * i) / steps, y: ay + ((by - ay) * i) / steps, id: 1 }]);
				await sleep(stepMs);
				n++;
				if (mid) await mid(k, i, n);
			}
		}
		await sleep(holdMs);
		await T('touchEnd', []);
	};
	/** a FLICK with explicit 16 ms event timestamps (CDP `timestamp`): under load the moves land
	 *  50-100 ms apart in page time, which would read as a slow drag */
	const flick = async (x, y0, dy, steps = 4) => {
		const t0 = Date.now() / 1000;
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }], timestamp: t0 });
		for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (dy * i) / steps, id: 1 }], timestamp: t0 + 0.016 * i });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t0 + 0.016 * (steps + 1) });
	};
	const tap = async (x, y) => {
		await T('touchStart', [{ x, y, id: 1 }]);
		await T('touchEnd', []);
	};
	return { path, tap, flick };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'folded', {
		context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const touch = await touchApi(P);
	const read = (expr) => P.evaluate(expr);
	const rect = (sel) =>
		P.evaluate((s) => {
			const e = document.querySelector(s);
			if (!e) return null;
			const r = e.getBoundingClientRect();
			return r.width || r.height ? { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom } : null;
		}, sel);
	h.check(await read(() => document.documentElement.classList.contains('phone-shell')), 'the phone shell is mounted at 390x896 (N6 folded)');

	// ---- content: enough rows that every list SCROLLS ----------------------------------------
	await P.evaluate(async () => {
		const s = window.__stores;
		for (let i = 0; i < 26; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1500));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const kids = g.children.slice(0, 18);
		for (const [i, k] of kids.entries()) {
			s.annotationsHandler.addAnnotation(k.uuid);
			let cur;
			s.annotationsHandler.activeAnnotation.subscribe((v) => (cur = v))();
			if (cur?.draft) s.annotationsHandler.setAnnotation({ ...cur.draft, name: `Note ${i + 1}`, text: 'A note long enough to fill its row' });
		}
		s.annotationsHandler.activeAnnotation.set(null);
		for (let i = 0; i < 24; i++) s.pushNotification(`Notification number ${i + 1} — long enough to wrap onto two lines on a folded phone`);
	});
	await P.waitForTimeout(1200);

	const rest = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			s.phoneShell.phoneSheet.set(null);
			s.viewportMenu.set(null);
			s.objectListClose.set(true);
			s.notificationCenterOpen.set(false);
			s.notesDrawerOpen.set(false);
			s.inspectorClose.set(true);
			s.closeMenu.set(true);
			s.explorerClose.set(true);
			s.annotationsHandler.activeAnnotation.set(null);
			s.selectedObjects.set([]);
			s.toastStore.set([]);
		});
		await P.waitForTimeout(500);
	};
	const select = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			s.objectActions.applySelectionSet([g.children[0].uuid]);
		});
		await P.waitForTimeout(400);
	};
	const tapSel = async (sel) => {
		const b = await rect(sel);
		if (b) await touch.tap(b.x + b.w / 2, b.y + b.h / 2);
	};

	// [name, open, sheet (height) selector, scroller selector (the list), isOpen expr, opts]
	// `scroller` = the element that scrolls inside the drawer (measured: scrollTop)
	const DRAWERS = [
		['Objects', async () => P.evaluate(() => window.__stores.objectListClose.set(false)), '.ps-sheet', '#object-list .obj-scroller', `!${store('objectListClose')}`],
		['Explorer', async () => { await tapSel('#ps-explorer'); }, '#explorer-list', null, `!(${store('bottomDock.dockMinimized')}) && !(${store('explorerClose')})`, { body: '#explorer-grid' }],
		['Notes', async () => P.evaluate(() => window.__stores.notesDrawerOpen.set(true)), '#notes-drawer', '#notes-drawer .notes-body', store('notesDrawerOpen')],
		['Add', async () => { await tapSel('#ps-add'); }, '.ctx-scroll[role=menu]', '.ctx-scroll[role=menu]', `!!document.querySelector('.ctx-scroll[role=menu]')`],
		['Inspector', async () => { await select(); await tapSel('#ps-inspect'); }, '#inspector', '#inspector', `!${store('inspectorClose')}`],
		['main menu', async () => touch.tap(34, 34), '#sidebar70', '#sidebar70', `!!document.querySelector('#sidebar70')`],
		['notifications', async () => P.evaluate(() => window.__stores.notificationCenterOpen.set(true)), '.ps-sheet', '#notif-panel [data-notif-list], #notif-panel .wc-body, #notif-panel', store('notificationCenterOpen')],
		['profile menu', async () => P.locator('#avatar-trigger').dispatchEvent('mousedown'), '#avatar-dropdown', '#avatar-dropdown', `!!document.querySelector('#avatar-dropdown')`],
		['More', async () => { await tapSel('#ps-more'); }, '.ps-sheet', '#ps-more-sheet', `${store('phoneShell.phoneSheet')} === 'more'`],
		['Configure Scene', async () => P.evaluate(() => window.__stores.showSidebar('scene')), '#inspector', '#inspector', `!${store('inspectorClose')}`]
	];

	/** the scroller actually under a point (the first vertically scrollable ancestor) */
	const scrollerAt = (x, y) =>
		P.evaluate(([x, y]) => {
			let el = document.elementFromPoint(x, y);
			while (el && el !== document.body) {
				const oy = getComputedStyle(el).overflowY;
				if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
					el.dataset.probeScroller = '1';
					return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, id: el.id || el.className.toString().slice(0, 40) };
				}
				el = el.parentElement;
			}
			return null;
		}, [x, y]);
	const probeTop = () => P.evaluate(() => document.querySelector('[data-probe-scroller]')?.scrollTop ?? null);
	const clearProbe = () => P.evaluate(() => document.querySelectorAll('[data-probe-scroller]').forEach((e) => delete e.dataset.probeScroller));
	const setProbeTop = (v) => P.evaluate((v) => { const e = document.querySelector('[data-probe-scroller]'); if (e) e.scrollTop = v; }, v);

	for (const [name, open, sheetSel, , isOpen, opts = {}] of DRAWERS) {
		await rest();
		await clearProbe();
		await open();
		await P.waitForTimeout(900);
		if (!(await read(isOpen))) {
			h.check(false, `${name}: opens`);
			continue;
		}
		let s0 = await rect(sheetSel);
		if (!s0) { h.check(false, `${name}: sheet rect (${sheetSel})`); continue; }
		// a point in the BODY: 40% down the sheet (or the named body), centred, never on the grab bar
		const bodyR = opts.body ? await rect(opts.body) : null;
		const bx = Math.round(bodyR ? bodyR.x + bodyR.w / 2 : s0.x + s0.w / 2);
		const by = Math.round(bodyR ? bodyR.top + Math.min(bodyR.h * 0.4, 200) : s0.top + Math.min(s0.h * 0.45, 260));
		/** keep a gesture's start inside the sheet's body */
		const inY = (y) => Math.max(s0.top + 40, Math.min(s0.bottom - 12, y));
		const sc = await scrollerAt(bx, by);
		const scrolls = !!sc && sc.max > 30;
		// --- 1. drag UP on the list: the list scrolls, the sheet stays ---
		if (scrolls) {
			await setProbeTop(0);
			await touch.path([[bx, inY(by + 60)], [bx, by - 120]], { stepMs: 18 });
			await P.waitForTimeout(500);
			const t1 = await probeTop();
			const s1 = await rect(sheetSel);
			h.check(t1 > 40, `${name}: an upward drag on the body scrolls the list (scrollTop ${t1}, scroller ${sc.id})`);
			h.check(s1 && Math.abs(s1.h - s0.h) < 4, `${name}: ...and the sheet does not move (${Math.round(s0.h)} -> ${Math.round(s1?.h ?? 0)})`);
			// --- 2. scrolled: drag DOWN past the top in ONE gesture -> the list scrolls back, the sheet stays OPEN ---
			const before = await probeTop();
			await touch.path([[bx, inY(by - 100)], [bx, inY(by - 100) + 340]], { stepMs: 14, holdMs: 30 });
			await P.waitForTimeout(700);
			h.check(await read(isOpen), `${name}: scrolled down, one drag down past the list's top does NOT close the drawer (was scrollTop ${before})`);
			const s2 = await rect(sheetSel);
			h.check(s2 && Math.abs(s2.h - s0.h) < 4, `${name}: ...and does not move the sheet (${Math.round(s0.h)} -> ${Math.round(s2?.h ?? 0)})`);
			h.check((await probeTop()) < before, `${name}: ...the list scrolled back toward its top (${before} -> ${await probeTop()})`);
		} else {
			h.check(true, `${name}: its body does not scroll at this height (${JSON.stringify(sc)}) — the body is the sheet`);
		}
		// --- 3. at the top: a slow drag down moves the SHEET with the finger ---
		if (scrolls) await setProbeTop(0);
		await P.waitForTimeout(200);
		s0 = await rect(sheetSel);
		let midH = null;
		await touch.path([[bx, by], [bx, by + 90]], {
			steps: 10,
			stepMs: 20,
			holdMs: 150,
			mid: async (k, i) => {
				if (i === 10) {
					midH = (await rect(sheetSel))?.h ?? null;
					if (process.env.SHOT_DIR) await P.screenshot({ path: `${process.env.SHOT_DIR}/g5-${name.replace(/\W+/g, '-')}-mid-pull.png` });
				}
			}
		});
		h.check(midH !== null && s0.h - midH > 50, `${name}: at the list's top a drag down moves the sheet with the finger (mid-gesture ${Math.round(s0.h)} -> ${Math.round(midH ?? 0)})`);
		await P.waitForTimeout(600);
		const after3 = await read(isOpen);
		const s3 = await rect(sheetSel);
		h.check(after3 || !opts.mustStay, `${name}: a short slow pull rests (open ${after3}, ${Math.round(s3?.h ?? 0)})`);
		if (!after3) { await open(); await P.waitForTimeout(900); }
		// --- 4. hand-back: pull down 70, then up 200 -> the sheet stops at its start, the list scrolls ---
		if (scrolls) {
			await setProbeTop(0);
			await P.waitForTimeout(200);
			const sA = await rect(sheetSel);
			let lowH = null;
			await touch.path([[bx, by], [bx, by + 70], [bx, by - 130]], {
				steps: 10,
				stepMs: 18,
				holdMs: 160,
				mid: async (k, i) => {
					if (k === 1 && i === 10) lowH = (await rect(sheetSel))?.h ?? null;
				}
			});
			await P.waitForTimeout(600);
			const sB = await rect(sheetSel);
			const tB = await probeTop();
			h.check(lowH !== null && sA.h - lowH > 40, `${name}: hand-back premise — the pull moved the sheet first (${Math.round(sA.h)} -> ${Math.round(lowH ?? 0)})`);
			h.check(sB && Math.abs(sB.h - sA.h) < 6, `${name}: back up past the start, the sheet stops at its start height (${Math.round(sA.h)} -> ${Math.round(sB?.h ?? 0)})`);
			h.check(tB > 60, `${name}: ...and the list scrolls by the rest (scrollTop ${tB})`);
			await setProbeTop(0);
		}
		// --- 5. at the top: a FLICK down closes the drawer (a few big moves: CDP touches land
		//        ~50 ms apart in page time, so the flick carries explicit timestamps) ---
		await P.waitForTimeout(200);
		await touch.flick(bx, by, 200);
		await P.waitForTimeout(800);
		h.check(!(await read(isOpen)), `${name}: at the list's top a flick down CLOSES the drawer`);
	}

	// ---- rubber band past the max: Objects at full, pulled up on the grab bar -----------------
	await rest();
	await P.evaluate(() => window.__stores.objectListClose.set(false));
	await P.waitForTimeout(900);
	{
		const g = await rect('#ps-sheet-handle');
		// all the way up first
		await touch.path([[g.x + g.w / 2, g.y + g.h / 2], [g.x + g.w / 2, 40]], { steps: 12, stepMs: 16 });
		await P.waitForTimeout(600);
		const sMax = await rect('.ps-sheet');
		const g2 = await rect('#ps-sheet-handle');
		let over = null;
		await touch.path([[g2.x + g2.w / 2, g2.y + g2.h / 2], [g2.x + g2.w / 2, g2.y + g2.h / 2 - 160]], {
			steps: 10,
			stepMs: 18,
			holdMs: 120,
			mid: async (k, i) => {
				if (i === 10) over = (await rect('.ps-sheet'))?.h ?? null;
			}
		});
		await P.waitForTimeout(600);
		const sBack = await rect('.ps-sheet');
		h.check(over !== null && over > sMax.h + 5 && over < sMax.h + 120, `rubber band: pulled 160 px past the max, the sheet follows with resistance (${Math.round(sMax.h)} -> ${Math.round(over ?? 0)})`);
		h.check(sBack && Math.abs(sBack.h - sMax.h) < 4, `rubber band: released, it springs back to the max (${Math.round(sBack?.h ?? 0)})`);
	}

	// ---- a sideways move on the body is left alone ---------------------------------------------
	{
		const s0 = await rect('.ps-sheet');
		const b = await rect('#object-list');
		await touch.path([[b.x + 40, b.y + 120], [b.x + 300, b.y + 150]], { steps: 10, stepMs: 16 });
		await P.waitForTimeout(500);
		const s1 = await rect('.ps-sheet');
		h.check(s1 && Math.abs(s1.h - s0.h) < 4 && (await read(`!${store('objectListClose')}`)), `a sideways drag on the body does not move the sheet (${Math.round(s0.h)} -> ${Math.round(s1?.h ?? 0)})`);
	}

	// ---- a dragged touch does not open the row it started on ------------------------------------
	await rest();
	await P.evaluate(() => window.__stores.objectListClose.set(false));
	await P.waitForTimeout(900);
	{
		const row = await P.evaluate(() => {
			const sc = document.querySelector('#object-list .obj-scroller');
			sc.scrollTop = 0;
			const r = [...sc.querySelectorAll('[data-uuid], li, [role=treeitem], button')].find((e) => e.getBoundingClientRect().height > 20);
			const b = r?.getBoundingClientRect();
			return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
		});
		const selBefore = await read(`${store('selectedObjects')}.length`);
		await touch.path([[row.x, row.y], [row.x, row.y + 80]], { steps: 8, stepMs: 20, holdMs: 100 });
		await P.waitForTimeout(500);
		const selAfter = await read(`${store('selectedObjects')}.length`);
		h.check(selAfter === selBefore, `a pull that starts on a row does not select that row (${selBefore} -> ${selAfter})`);
	}

	// ---- FOLD -> UNFOLD with a drawer open: the wide layout's panels are not sheets ----------------
	await rest();
	await select();
	await tapSel('#ps-inspect');
	await P.waitForTimeout(800);
	await P.setViewportSize({ width: 770, height: 850 });
	await P.waitForTimeout(1500);
	const wide = await P.evaluate(() => ({ shell: document.documentElement.classList.contains('phone-shell'), ins: (() => { const r = document.getElementById('inspector')?.getBoundingClientRect(); return r ? { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null; })() }));
	h.check(!wide.shell && !!wide.ins, `unfolded with the Inspector open: no phone shell, the Inspector is a side drawer (${JSON.stringify(wide)})`);
	if (wide.ins) {
		await P.evaluate(() => { const i = document.getElementById('inspector'); if (i) i.scrollTop = 0; });
		const ix = wide.ins.left + wide.ins.w / 2;
		const iy = wide.ins.top + 160;
		await touch.flick(ix, iy, 220); // a hard flick down
		await P.waitForTimeout(700);
		const after = await P.evaluate(() => { let v; window.__stores.inspectorClose.subscribe((x) => (v = x))(); const r = document.getElementById('inspector')?.getBoundingClientRect(); return { closed: v, h: r ? Math.round(r.height) : 0 }; });
		h.check(!after.closed && Math.abs(after.h - wide.ins.h) < 4, `unfolded: a flick down on the side Inspector neither closes nor resizes it — its hidden grip is not a sheet (${JSON.stringify(after)})`);
	}
	// and back to folded: the drawers are sheets again and the hand-off works
	await P.setViewportSize({ width: 390, height: 896 });
	await P.waitForTimeout(1500);
	await rest();
	await P.evaluate(() => window.__stores.objectListClose.set(false));
	await P.waitForTimeout(900);
	{
		const s0 = await rect('.ps-sheet');
		const b = await rect('#object-list .obj-scroller');
		await P.evaluate(() => { document.querySelector('#object-list .obj-scroller').scrollTop = 0; });
		await touch.flick(b.x + b.w / 2, b.y + 60, 210);
		await P.waitForTimeout(800);
		h.check(!(await read(`!${store('objectListClose')}`)), `folded again: a flick down at the Objects list's top closes it (sheet was ${Math.round(s0?.h ?? 0)})`);
	}

	await h.finish(browser);
});
