// 44 M1 — AN UNGROUPED FLOATING WINDOW MOVES BY ITS BODY (the user, preview-1-34: "ungrouped floating windows
// should be possible to move by dragging any place using touch or mouse by click and drag, if just click i can
// activate button or filter (object list as example)").
// Decision: a press-and-move past a 6 px slop (or after a 150 ms touch hold) on any NON-interactive part moves
// the window; a plain click / tap still reaches buttons, inputs and list rows; text inputs, sliders, scrollable
// lists and canvases never start a window drag.
//
//   1  desktop: Objects dragged by its BODY (the filter row's padding) follows the pointer; a click on a row
//      right after still SELECTS it; a press-and-move on a chip or a row does not move the window; a press
//      that stays inside the slop moves nothing
//   2  desktop: Statistics (a dragWindow consumer) moves by its body too; the body drag hands over to the
//      header path, so it lands where the pointer is with the grab point under it
//   3  a GROUPED window does not move by its body (its strip is its grip)
//   4  N6 unfolded, REAL touch (CDP): a touch drag on Objects' body follows the finger at every step with no
//      pointercancel; a tap on a row selects it
// Counterfactual (base = origin/feat/43-int, 1.34.0): every body drag leaves the window where it was.
// SHOTS=<dir> writes the evidence shots.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS || '';
const THEME = process.env.THEME || 'dark';
const DESK = { viewport: { width: 1440, height: 900 } };
const UNFOLDED = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const STORAGE = { theme: THEME, mobileUndockAllowed: 'true', objectListRect: JSON.stringify({ left: 380, top: 160, width: 300, height: 330 }) };

const S = (page, fn, arg) => page.evaluate(fn, arg);
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `m1-${name}-${THEME}.png`) }).catch(() => {});
}
const rect = (page, sel) =>
	S(page, (sel) => {
		const r = document.querySelector(sel)?.getBoundingClientRect();
		return r && r.width ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
	}, sel);
const selection = (page) =>
	S(page, () => {
		let v;
		window.__tp.test.v1.selectedObjects.subscribe((x) => (v = x))();
		return [...(v || [])];
	});

/** a point on the window's BODY the predicate accepts, searched near (fx, fy) of the window's box; the
 *  element under it is returned so a check can say what was pressed */
const bodyPoint = (page, sel, fx = 0.5, fy = 0.6, clear = 0) =>
	S(page, ({ sel, fx, fy, clear }) => {
		const node = document.querySelector(sel);
		const r = node.getBoundingClientRect();
		const head = node.querySelector('.move-handle')?.getBoundingClientRect();
		const top = (head?.bottom ?? r.top) + 2;
		// base (no M1) has no predicate: the same rule, written out, so the counterfactual presses the same spot
		// (a [role] INSIDE the window is a control; the window's own role=region is not)
		const isBodyDragStart =
			window.__tp.test.v1.windowBodyDrag?.isBodyDragStart ??
			((el, n) => n.contains(el) && !el.closest('button, input, select, textarea, label, a[href], .move-handle, canvas, [draggable="true"]') && !(el.closest('[role]') !== n && n.contains(el.closest('[role]'))) && getComputedStyle(el).overflowY !== 'auto');
		const cands = [];
		for (let y = top; y < r.bottom - 4; y += 3) for (let x = r.left + 3; x < r.right - 4; x += 3) cands.push([x, y]);
		const tx = r.left + r.width * fx;
		const ty = r.top + r.height * fy;
		cands.sort((a, b) => Math.hypot(a[0] - tx, a[1] - ty) - Math.hypot(b[0] - tx, b[1] - ty));
		for (const [x, y] of cands) {
			const el = document.elementFromPoint(x, y);
			// `clear`: a finger's touch adjustment snaps to a control within ~a fingertip, so a touch
			// press needs body all around it, not one body pixel
			const ok = (px, py) => {
				const e = document.elementFromPoint(px, py);
				return !!e && node.contains(e) && isBodyDragStart(e, node);
			};
			const ring = clear ? [0, 45, 90, 135, 180, 225, 270, 315].map((a) => [x + clear * Math.cos((a * Math.PI) / 180), y + clear * Math.sin((a * Math.PI) / 180)]) : [];
			if (el && node.contains(el) && isBodyDragStart(el, node) && ring.every(([px, py]) => ok(px, py)))
				return { x: Math.round(x), y: Math.round(y), el: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') };
		}
		return null;
	}, { sel, fx, fy, clear });
const centreOf = (page, sel) =>
	S(page, (sel) => {
		const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length);
		const r = el?.getBoundingClientRect();
		return r ? { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2) } : null;
	}, sel);

async function mouseDrag(page, from, d, steps = 12) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + d.x, from.y + d.y, { steps });
	await page.mouse.up();
	await page.waitForTimeout(250);
}
const moved = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
const near = (v, d, tol = 3) => Math.abs(v.x - d.x) <= tol && Math.abs(v.y - d.y) <= tol;
const still = (v) => Math.abs(v.x) < 3 && Math.abs(v.y) < 3;

async function seedScene(page) {
	await S(page, async () => {
		for (let i = 0; i < 3; i++) window.__tp.test.v1.addObjects.spawnAtPoint('/create Box 1 1 1', [i * 2 - 2, 0.5, -4]);
		await new Promise((r) => setTimeout(r, 800));
		window.__tp.test.v1.objectActions?.applySelectionSet?.([]);
		window.__tp.test.v1.objectListClose.set(false);
	});
	await page.waitForTimeout(900);
}

h.run(async () => {
	const browser = await h.launch();

	// ---------------- desktop ----------------
	const D = await h.setupPage(browser, 'D', { context: DESK, storage: STORAGE });
	const page = D.page;
	await seedScene(page);
	let win = await rect(page, '#object-list');
	h.check(!!win, `premise: the Objects window floats (${JSON.stringify(win)})`);
	await shot(page, '01-objects-before');

	// 1a. body drag
	let pt = await bodyPoint(page, '#object-list', 0.5, 0.2);
	h.check(!!pt, `premise: Objects has a body point that is not a control (${JSON.stringify(pt)})`);
	await mouseDrag(page, pt, { x: 160, y: 90 });
	let after = await rect(page, '#object-list');
	h.check(near(moved(win, after), { x: 160, y: 90 }), `1.1 dragged by its body (${pt.el}) the window follows the pointer: moved ${JSON.stringify(moved(win, after))} for (160,90)`);
	h.check(await S(page, () => document.querySelector('#object-list').hasAttribute('data-body-drag') && !document.querySelector('#object-list').hasAttribute('data-body-dragging')), '1.1b ...and after the drag it is still a body-draggable window (its touch-action and header menu ride on that mark)');
	await shot(page, '02-objects-after-body-drag');

	// 1b. a click on a row right after still selects
	const rowPt = await centreOf(page, '#object-list [role="treeitem"] .obj-row');
	h.check(!!rowPt, 'premise: the tree shows rows');
	await page.mouse.click(rowPt.x, rowPt.y);
	await page.waitForTimeout(350);
	const sel1 = await selection(page);
	h.check(sel1.length === 1, `1.2 a click on a row selects it (${JSON.stringify(sel1)})`);
	const r1 = await rect(page, '#object-list');
	h.check(still(moved(after, r1)), '1.3 ...and the click did not move the window');

	// 1c. a press-and-move on a chip / a row does not move the window
	const chipPt = await centreOf(page, '#object-list .obj-chip');
	await mouseDrag(page, chipPt, { x: 90, y: 70 });
	let r2 = await rect(page, '#object-list');
	h.check(still(moved(r1, r2)), `1.4 a press-and-move on a filter chip leaves the window (${JSON.stringify(moved(r1, r2))})`);
	const rowPt2 = await centreOf(page, '#object-list [role="treeitem"] .obj-row');
	await mouseDrag(page, rowPt2, { x: 60, y: 0 }, 6);
	await page.keyboard.press('Escape').catch(() => {});
	let r3 = await rect(page, '#object-list');
	h.check(still(moved(r2, r3)), `1.5 a press-and-move on a row is the row's own drag, never the window's (${JSON.stringify(moved(r2, r3))})`);

	// 1d. a press inside the slop moves nothing
	pt = await bodyPoint(page, '#object-list', 0.5, 0.2);
	await mouseDrag(page, pt, { x: 4, y: 3 }, 3);
	let r4 = await rect(page, '#object-list');
	h.check(still(moved(r3, r4)), `1.6 a press that travels under the 6 px slop moves nothing (${JSON.stringify(moved(r3, r4))})`);
	const sel2 = await selection(page);
	h.check(JSON.stringify(sel2) === JSON.stringify(sel1), '1.7 ...and a click on the body leaves the selection alone');

	// 1e. the header still drags, its search still types
	const head = await rect(page, '#object-list .move-handle');
	await mouseDrag(page, { x: head.x + 12, y: head.y + head.h / 2 }, { x: -60, y: 40 });
	let r5 = await rect(page, '#object-list');
	h.check(near(moved(r4, r5), { x: -60, y: 40 }), `1.8 the header drags as before (${JSON.stringify(moved(r4, r5))})`);

	// ---------- 2. Statistics: a dragWindow consumer ----------
	await S(page, () => window.__tp.test.v1.sceneBudget.statsOpen.set(true));
	await page.waitForTimeout(700);
	const st0 = await rect(page, '#stats-window');
	const stPt = await bodyPoint(page, '#stats-window', 0.5, 0.7);
	h.check(!!st0 && !!stPt, `premise: Statistics floats with a body point (${JSON.stringify(stPt)})`);
	await mouseDrag(page, stPt, { x: -140, y: 60 });
	const st1 = await rect(page, '#stats-window');
	h.check(near(moved(st0, st1), { x: -140, y: 60 }), `2.1 Statistics moves by its body (${stPt?.el}): ${JSON.stringify(moved(st0, st1))}`);
	const saved = await S(page, () => JSON.parse(localStorage.getItem('win:statsWindow') || 'null'));
	h.check(saved && Math.abs(saved.left - st1.x) < 3, `2.2 ...and its new place is remembered like a header drag's (${JSON.stringify(saved)})`);
	await shot(page, '03-stats-after-body-drag');

	// ---------- 3. a grouped window keeps its strip as the grip ----------
	await S(page, async () => {
		const s = window.__tp?.test.v1;
		s.chatHidden.set('');
		await new Promise((r) => setTimeout(r, 700));
		s.windowTabs.mergeWindows('objects', 'chat');
		await new Promise((r) => setTimeout(r, 300));
		let g;
		s.windowTabs.tabGroups.subscribe((v) => (g = v))();
		s.windowTabs.activateTab(g[0].id, 'objects');
	});
	await page.waitForTimeout(500);
	const grouped = await S(page, () => !!document.querySelector('#object-list')?.dataset.tabMember);
	h.check(grouped, 'premise: Objects is a tab of a group');
	const g0 = await rect(page, '#object-list');
	const gPt = await bodyPoint(page, '#object-list', 0.5, 0.3);
	// the predicate says yes (the body is the body) — the gate is the group, which the action asks
	await mouseDrag(page, gPt, { x: 120, y: 60 });
	const g1 = await rect(page, '#object-list');
	h.check(still(moved(g0, g1)), `3.1 a grouped window does not move by its body (${JSON.stringify(moved(g0, g1))})`);
	await S(page, () => window.__tp.test.v1.windowTabs.removeFromGroup('chat'));
	await page.waitForTimeout(300);

	await D.ctx.close();

	// ---------------- 4. N6 unfolded, real touch ----------------
	const T = await h.setupPage(browser, 'T', { context: UNFOLDED, storage: STORAGE });
	const tp = T.page;
	await seedScene(tp);
	const cdp = await tp.context().newCDPSession(tp);
	await S(tp, () => {
		window.__cancels = 0;
		window.addEventListener('pointercancel', () => window.__cancels++, true);
	});
	const t0 = await rect(tp, '#object-list');
	const tPt = await bodyPoint(tp, '#object-list', 0.5, 0.2, 16);
	h.check(!!t0 && !!tPt, `premise (unfolded): Objects floats with a body point (${JSON.stringify({ t0, tPt })})`);
	const trail = [];
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tPt] });
	await tp.waitForTimeout(40);
	const d = { x: 110, y: 120 };
	for (let i = 1; i <= 16; i++) {
		const fx = (d.x * i) / 16;
		const fy = (d.y * i) / 16;
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tPt.x + fx, y: tPt.y + fy }] });
		await tp.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		const r = await rect(tp, '#object-list');
		trail.push({ fx: Math.round(fx), fy: Math.round(fy), sx: r.x - t0.x, sy: r.y - t0.y });
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tp.waitForTimeout(300);
	const late = trail.filter((t) => Math.hypot(t.fx, t.fy) > 12);
	h.check(late.length > 0 && late.every((t) => Math.abs(t.sx - t.fx) <= 3 && Math.abs(t.sy - t.fy) <= 3), `4.1 a touch drag on the body follows the finger at every step (${JSON.stringify(trail.slice(-4))})`);
	h.check((await S(tp, () => window.__cancels)) === 0, '4.2 ...with no pointercancel (the browser never took it as a pan)');
	await shot(tp, '04-unfolded-after-touch-drag');
	const tRow = await centreOf(tp, '#object-list [role="treeitem"] .obj-row');
	const tw0 = await rect(tp, '#object-list');
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tRow] });
	await tp.waitForTimeout(60);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tp.waitForTimeout(500);
	const tsel = await selection(tp);
	const tw1 = await rect(tp, '#object-list');
	h.check(tsel.length === 1, `4.3 a tap on a row selects it (${JSON.stringify(tsel)})`);
	h.check(still(moved(tw0, tw1)), '4.4 ...and the tap does not move the window');

	await h.finish(browser);
});
