// 41b H3 — THE SELECTION STRIP FOLLOWS A DRAWER BEING RESIZED IN THE SAME FRAME.
//
// The user: "inspect toolbar stutter when I resize drawers, should be smooth and follow without
// delay". On a 390x844 touch phone with an object selected, a drawer's grab bar is dragged by REAL
// touch events (CDP Input.dispatchTouchEvent) while an in-page requestAnimationFrame sampler records,
// FRAME BY FRAME, the drawer's top edge and the strip's bottom edge. The strip rides a fixed gap above
// the drawer, so for every frame the gap must equal the resting gap — measured against this frame's
// drawer top or, at worst, the previous frame's (<= 1 frame of lag). A strip that re-measures on a
// timer holds a stale position for several frames and then JUMPS: both are counted and must be 0.
//
// Drawers: the dock (Explorer — the dock grip PhoneShell draws), the shell's framed sheet (Objects),
// and the Inspector sheet. Desktop is not involved (the strip is the phone shell's).
const h = require('./helpers.cjs');

/** @param {import('playwright').Page} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
	/** a slow drag through `ys` (one touchMove per ~frame) */
	const drag = async (x, ys, stepMs = 16) => {
		await send('touchStart', [{ x, y: ys[0], id: 1 }]);
		for (let i = 1; i < ys.length; i++) {
			await send('touchMove', [{ x, y: ys[i], id: 1 }]);
			await new Promise((r) => setTimeout(r, stepMs));
		}
		await new Promise((r) => setTimeout(r, 200)); // a slow release, not a flick
		await send('touchEnd', []);
	};
	const tap = async (x, y) => {
		await send('touchStart', [{ x, y, id: 1 }]);
		await send('touchEnd', []);
	};
	return { drag, tap };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const touch = await touchApi(P);
	const rect = (sel) =>
		P.evaluate((s) => {
			const e = document.querySelector(s);
			if (!e) return null;
			const r = e.getBoundingClientRect();
			return r.width || r.height ? { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom } : null;
		}, sel);
	const rest = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			s.phoneShell.phoneSheet.set(null);
			s.viewportMenu.set(null);
			s.objectListClose.set(true);
			s.notificationCenterOpen.set(false);
			s.notesDrawerOpen.set(false);
			s.chatHidden.set('hidden');
			s.mobileUndockAllowed.set(false);
			s.inspectorClose.set(true);
			s.closeMenu.set(true);
			s.explorerClose.set(true);
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
		await P.waitForTimeout(500);
	};
	h.check(await P.evaluate(() => document.documentElement.classList.contains('phone-shell')), 'premise: the phone shell is mounted at 390x844');
	await P.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await P.waitForTimeout(800);

	/** start the per-frame sampler: each frame, the drawer's top and the strip's bottom */
	const startSampler = (sheetSel) =>
		P.evaluate((sel) => {
			const w = /** @type {any} */ (window);
			w.__stripSamples = [];
			w.__stripSampling = true;
			const tick = () => {
				if (!w.__stripSampling) return;
				const sheet = document.querySelector(sel);
				const strip = document.getElementById('ps-strip');
				if (sheet && strip) {
					w.__stripSamples.push({ sheetTop: sheet.getBoundingClientRect().top, stripBottom: strip.getBoundingClientRect().bottom });
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		}, sheetSel);
	const stopSampler = () =>
		P.evaluate(() => {
			const w = /** @type {any} */ (window);
			w.__stripSampling = false;
			return w.__stripSamples;
		});

	/** frames where the strip is neither on this frame's drawer edge nor on the last one's (lag > 1),
	 *  and frames where the gap jumps by more than the drawer moved (a catch-up jump) */
	function judge(samples, gap0) {
		let lagged = 0;
		let jumps = 0;
		let worst = 0;
		for (let i = 1; i < samples.length; i++) {
			const s = samples[i];
			const prev = samples[i - 1];
			const now = Math.abs(s.sheetTop - s.stripBottom - gap0);
			const last = Math.abs(prev.sheetTop - s.stripBottom - gap0);
			const err = Math.min(now, last);
			worst = Math.max(worst, now);
			if (err > 1.5) lagged++;
			// the strip may move by this frame's drawer step or (one frame late) by the last one's
			const sheetMove = Math.abs(s.sheetTop - prev.sheetTop);
			const sheetMoveBefore = Math.abs(prev.sheetTop - samples[Math.max(0, i - 2)].sheetTop);
			const stripMove = Math.abs(s.stripBottom - prev.stripBottom);
			if (stripMove > Math.max(sheetMove, sheetMoveBefore) + 2) jumps++;
		}
		return { frames: samples.length, lagged, jumps, worst: Math.round(worst) };
	}

	/** [name, open(), drawer selector (its top edge), grip selector] */
	const DRAWERS = [
		['the dock (Explorer)', async () => {
			const b = await rect('#ps-explorer');
			await touch.tap(b.x + b.w / 2, b.y + b.h / 2);
		}, '.tp-dock-panel:not(.hidden)', '#ps-dock-grip [data-sheet-grip]'],
		// 41b-int: Objects is a dock tab since 41b H1, so the framed-sheet row drives Chat (still a framed sheet)
		// 78 PL23: Chat is a dock tab now; it is still a framed sheet where undocking is allowed (Settings ▸ Interface)
		['a framed sheet (Chat)', async () => P.evaluate(() => {
			window.__stores.mobileUndockAllowed.set(true);
			window.__stores.chatHidden.set('');
		}), '.ps-sheet', '#ps-sheet-handle']
		// 41b-int: the Inspector is the Properties dock tab on a phone since 41b H1 (the dock row covers its grip)
	];

	for (const [name, open, sheetSel, gripSel] of DRAWERS) {
		await rest();
		await select();
		await open();
		await P.waitForTimeout(1000);
		const g = await rect(gripSel);
		const s0 = await rect(sheetSel);
		const st0 = await rect('#ps-strip');
		if (!g || !s0 || !st0) {
			h.check(false, `${name}: premise — drawer, grab bar and strip on screen (${JSON.stringify({ g, s0, st0 })})`);
			continue;
		}
		const gap0 = s0.top - st0.bottom;
		h.check(gap0 > 0 && gap0 < 48, `${name}: premise — at rest the strip rides just above the drawer (gap ${gap0.toFixed(1)}; the dock's includes its tab row)`);
		// up 160 px, then down 120, one move per frame: the drawer's height follows the finger
		const gx = g.x + g.w / 2;
		const gy = g.y + g.h / 2;
		const ys = [];
		for (let i = 0; i <= 24; i++) ys.push(gy - (160 * i) / 24);
		for (let i = 1; i <= 18; i++) ys.push(gy - 160 + (120 * i) / 18);
		await startSampler(sheetSel);
		await touch.drag(gx, ys);
		await P.waitForTimeout(400);
		const samples = await stopSampler();
		const moved = samples.length ? Math.max(...samples.map((s) => s.sheetTop)) - Math.min(...samples.map((s) => s.sheetTop)) : 0;
		h.check(moved > 80, `${name}: premise — the drag resized the drawer (its top travelled ${Math.round(moved)} px over ${samples.length} frames)`);
		const v = judge(samples, gap0);
		h.check(v.lagged === 0, `${name}: the strip is on the drawer's edge every frame, <= 1 frame behind (${v.lagged} of ${v.frames} frames lag more; worst ${v.worst} px)`);
		h.check(v.jumps === 0, `${name}: the strip never jumps to catch up (${v.jumps} jumps)`);
		const end = await rect(sheetSel);
		const stEnd = await rect('#ps-strip');
		h.check(!!end && !!stEnd && Math.abs(end.top - stEnd.bottom - gap0) < 1.5, `${name}: after the release it rests the same gap above (${end && stEnd ? (end.top - stEnd.bottom).toFixed(1) : 'gone'})`);
	}
	await rest();

	await h.finish(browser);
});
