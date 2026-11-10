// 44 L5 — THE RESIZEOBSERVER-LOOP GUARD across the 43 features. The user saw "ResizeObserver loop completed
// with undelivered notifications" once on 1.34 desktop. The browser raises it as a window 'error' event (no
// error object) whenever an observer's callback changes the size of something observed at the same or a
// shallower depth inside the same frame — and diagnostics.js turns that event into the "Something went wrong"
// card. So this suite listens TWO ways from the first frame (an init script, before the app's own code):
//   · a window 'error' listener in CAPTURE (so nothing the app does can hide it), tagged with the phase,
//   · the diagnostics ring (`__stores.diagnostics.lines()`) — what the user would hand over,
// and drives every 43 feature that resizes or re-measures chrome, one PHASE at a time, so a red names the
// feature: toolbar overflow (J10), sidebar resize (K1/K2), the Connect pill's own row (K4), focus mode + the
// viewport PiP + the resizable camera preview (K5), the sidebar tab strip (J4), window resizes across every
// threshold, and the phone dock tabs + the fold/unfold transition.
// Desktop 1440x900 (real mouse), unfolded OPPO Find N6 770x850 DPR 2.9 (real CDP touch), folded 390x896.
// Counterfactual: on origin/feat/43-int the phase that trips is RED (see the lane evidence).
// ONLY=desk,unfolded,folded runs those groups alone; THEME=light switches the theme.
const h = require('./helpers.cjs');

const THEME = process.env.THEME || 'dark';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);

/** installed before ANY app code: every RO-loop error, with the phase it happened in */
const LISTEN = () => {
	window.__roPhase = 'boot';
	window.__roLoop = [];
	window.addEventListener(
		'error',
		(e) => {
			const m = String(e.message || '');
			if (/ResizeObserver loop/.test(m)) window.__roLoop.push({ phase: window.__roPhase, m, t: Math.round(performance.now()) });
		},
		true
	);
};

/** everything seen so far: the window listener's list + the diagnostics ring's matching lines */
const seen = (P) =>
	P.evaluate(() => {
		const d = window.__stores && window.__stores.diagnostics;
		const lines = d && typeof d.lines === 'function' ? d.lines().filter((l) => /ResizeObserver loop/.test(l)) : null;
		return { win: window.__roLoop.slice(), diag: lines };
	});
const crashToast = (P) =>
	P.evaluate(() => [...document.querySelectorAll('.tp-toast, [role=status], [role=alert]')].some((t) => /ResizeObserver/.test(t.textContent || '')));

/** run one phase and check it raised nothing — by both readers */
async function phase(P, T, name, fn) {
	await P.evaluate((n) => (window.__roPhase = n), name);
	const before = await seen(P);
	let threw = null;
	try {
		await fn();
	} catch (err) {
		threw = String(err && err.message ? err.message : err).split('\n')[0];
	}
	await P.waitForTimeout(700); // a loop error is reported at the end of the frame that caused it
	const after = await seen(P);
	const win = after.win.length - before.win.length;
	const diag = after.diag == null ? null : after.diag.length - (before.diag ? before.diag.length : 0);
	h.check(!threw, `${T}${name}: (premise) the phase ran (${threw || 'ok'})`);
	h.check(win === 0 && (diag == null || diag === 0), `${T}${name}: no "ResizeObserver loop" error (window ${win}, diagnostics ${diag == null ? 'n/a' : diag})`);
}

const S = (P, fn, arg) => P.evaluate(fn, arg);
const rect = (P, sel) => S(P, (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);

/** every bar-able button on the bar (the J10 driver's record) */
const ALL_ON = { order: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation', 'timeline', 'uv', 'shader', 'hud', 'profiler', 'code'], hidden: [], spacerIndex: 5, seen: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation', 'timeline', 'uv', 'shader', 'hud', 'profiler', 'code', 'ai', 'add', 'chat', 'mic', 'notes', 'notifications', 'peers', 'undo', 'redo', 'multiselect'] };
const CROWDED = { ...ALL_ON, left: [], right: [], top: ['notes', 'notifications', 'chat', 'mic'], touch: ['undo', 'redo', 'multiselect', 'ai'] };
const SPARSE = { ...ALL_ON, top: [], touch: [] };
/** swap the stored toolbar record in place (no reload) */
const setBar = (P, rec) =>
	S(P, (v) => {
		if (v == null) localStorage.removeItem('controlsLayout');
		else localStorage.setItem('controlsLayout', JSON.stringify(v));
		window.__stores.uiLayoutsCore?.runLayoutReloaders();
	}, rec);
/** the Inspector as a sidebar column */
const sidebar = (P, o) =>
	S(P, ({ side = 'right', open = true, full = false, w = 320, kind = 'scene' }) => {
		const s = window.__stores;
		s.sidebars.inspectorSide.set(side);
		s.inspectorKind.set(kind);
		s.inspectorClose.set(!open);
		s.sidebars.toggleSidebarFull('left', side === 'left' && full);
		s.sidebars.toggleSidebarFull('right', side === 'right' && full);
		s.sidebars.setSidebarWidth(side, w);
	}, o);

async function touchApi(P) {
	const cdp = await P.context().newCDPSession(P);
	const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4 }];
	return {
		async drag(a, b, steps = 16) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a[0], a[1]) });
			for (let i = 1; i <= steps; i++) {
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps) });
				await new Promise((r) => setTimeout(r, 16));
			}
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		}
	};
}

/** a mouse drag in small steps, one frame apart */
async function mouseDrag(P, a, b, steps = 14) {
	await P.mouse.move(a[0], a[1]);
	await P.mouse.down();
	for (let i = 1; i <= steps; i++) {
		await P.mouse.move(a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps);
		await P.waitForTimeout(24);
	}
	await P.mouse.up();
}

/** a box + the Code window docked in front (the focus/PiP fixture) */
async function seedScene(P) {
	await S(P, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 500));
		s.objectActions.deselectObject();
	});
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ═══ DESKTOP 1440x900, real mouse ═══════════════════════════════════════════════════════════════
	if (want('desk')) {
		const T = `[desk ${THEME}] `;
		const A = await h.setupPage(browser, 'desk', {
			context: { viewport: { width: 1440, height: 900 } },
			storage: { theme: THEME, toastsInDrawerOnly: 'true', timelineDocked: 'true', flowDockHeight: '300' },
			init: LISTEN
		});
		const P = A.page;
		h.check((await seen(P)).diag != null, `${T}premise: the diagnostics ring is readable (the second reader)`);
		await seedScene(P);
		await phase(P, T, 'boot + a box', async () => {});

		// J10 — the toolbar overflow: every button on, a pinned sidebar narrowing the room step by step
		await phase(P, T, 'J10 toolbar overflow', async () => {
			await P.setViewportSize({ width: 1100, height: 900 });
			await setBar(P, ALL_ON);
			await P.waitForTimeout(500);
			for (const w of [440, 400, 340, 290, 250, 440]) {
				await sidebar(P, { side: 'right', full: true, w });
				await P.waitForTimeout(450);
			}
			const ov = await rect(P, '#toolbar-overflow');
			if (ov) {
				await P.mouse.click(ov.x + ov.w / 2, ov.y + ov.h / 2);
				await P.waitForTimeout(400);
				await P.keyboard.press('Escape');
			}
			await sidebar(P, { side: 'right', full: false, w: 440 });
			await P.waitForTimeout(400);
			await sidebar(P, { open: false });
		});

		// J10 — THE ONE THAT TRIPPED (44 L5): the bar changes its OWN width while a pinned sidebar holds it at its
		// fold edge — what a pointer-type switch on a 2-in-1 (hud.css's coarse cells), a browser zoom or a late
		// webfont does with no window resize. The track observer watches the bar, re-folds it in its callback
		// and so resized the bar it was observing inside the delivery pass: one loop error per change.
		await phase(P, T, 'J10 the bar resizes itself at its fold edge', async () => {
			await P.setViewportSize({ width: 1100, height: 900 });
			await setBar(P, ALL_ON);
			for (const w of [440, 400, 360]) {
				await sidebar(P, { side: 'right', full: true, w });
				await P.waitForTimeout(450);
				for (const cell of ['44px', '38px', '50px', '38px']) {
					await S(P, (c) => document.documentElement.style.setProperty('--hud-cell', c), cell);
					await P.waitForTimeout(250);
				}
				await S(P, () => document.documentElement.style.removeProperty('--hud-cell'));
				await P.waitForTimeout(250);
			}
			const f = await S(P, () => document.getElementById('toolbar-overflow')?.dataset.folded ?? '');
			if (!f) throw new Error('premise: nothing folded — the bar was not at its fold edge');
			await sidebar(P, { open: false });
			await setBar(P, null);
			await P.setViewportSize({ width: 1440, height: 900 });
		});

		// K1 — a sidebar resized by its grip with a real mouse, both sides pinned Full height
		await phase(P, T, 'K1 sidebar grip resize', async () => {
			await P.setViewportSize({ width: 1440, height: 900 });
			await S(P, () => {
				const s = window.__stores;
				s.sidebars.toggleSidebarFull('left', true);
				s.sidebars.toggleSidebarFull('right', true);
				s.objectListClose?.set?.(false);
			});
			await sidebar(P, { side: 'right', full: true, w: 320 });
			await P.waitForTimeout(800);
			for (const side of ['right', 'left']) {
				const g = await rect(P, `#sidebar-grip-${side}`);
				if (!g) continue;
				const x = g.x + g.w / 2;
				const y = g.y + Math.min(300, g.h / 2);
				const dir = side === 'left' ? 1 : -1;
				await mouseDrag(P, [x, y], [x + dir * 220, y], 16);
				await P.waitForTimeout(300);
				await mouseDrag(P, [x + dir * 220, y], [x - dir * 60, y], 16);
				await P.waitForTimeout(300);
			}
		});

		// J4 — the sidebar tab strip: several windows in one column, narrowed until the strip scrolls
		await phase(P, T, 'J4 sidebar tab strip', async () => {
			await S(P, () => {
				const s = window.__stores;
				for (const k of ['objects', 'explorer', 'flow']) {
					try {
						s.sidebars.moveSidebarTab(k, 'right');
					} catch {
						/* a build without that window in a sidebar */
					}
				}
				s.sidebars.setSidebarWidth('right', 260);
			});
			await P.waitForTimeout(900);
			await S(P, () => window.__stores.sidebars.setSidebarWidth('right', 480));
			await P.waitForTimeout(600);
			await S(P, () => window.__stores.sidebars.setSidebarWidth('right', 250));
			await P.waitForTimeout(600);
		});

		// K4 — the Connect pill takes its own row when the top row fills, and comes back
		await phase(P, T, 'K4 Connect pill row', async () => {
			await S(P, () => {
				const s = window.__stores;
				s.sidebars.toggleSidebarFull('left', false);
				s.sidebars.toggleSidebarFull('right', false);
				s.inspectorClose.set(true);
				s.touchTools.set(true);
			});
			for (const width of [1440, 1100, 900, 760]) {
				await P.setViewportSize({ width, height: 900 });
				for (const bar of [null, CROWDED, SPARSE, CROWDED]) {
					await setBar(P, bar);
					await P.waitForTimeout(450);
				}
			}
			await P.setViewportSize({ width: 1440, height: 900 });
			await S(P, () => window.__stores.touchTools.set(false));
			await setBar(P, null);
		});

		// the window itself across every header / toolbar / Connect threshold, a sidebar pinned
		await phase(P, T, 'window resize sweep', async () => {
			await setBar(P, ALL_ON);
			await sidebar(P, { side: 'right', full: true, w: 340 });
			for (const w of [1440, 1280, 1100, 960, 820, 700, 640, 560, 1440]) {
				await P.setViewportSize({ width: w, height: 900 });
				await P.waitForTimeout(300);
			}
			await sidebar(P, { open: false });
			await setBar(P, null);
		});

		// K5 — focus mode: Ctrl+Space maximizes the docked Code window, the viewport PiP comes up, is resized,
		// moved, closed, the dock resized down and back, Esc restores; then the camera preview resized
		await phase(P, T, 'K5 focus + viewport PiP', async () => {
			await sidebar(P, { side: 'right', full: true, w: 320 });
			await S(P, async () => {
				const s = window.__stores;
				s.timelineClose.set(false);
				await new Promise((r) => setTimeout(r, 700));
				s.bottomDock.activateDock('timeline');
			});
			await P.waitForTimeout(900);
			const dock = await S(P, () => {
				const d = [...document.querySelectorAll('.tp-dock-panel')].find((x) => !x.classList.contains('hidden') && x.getBoundingClientRect().height > 0);
				const r = d && d.getBoundingClientRect();
				return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
			});
			if (!dock) throw new Error('no docked Code window');
			await P.mouse.move(dock.x, dock.y);
			await P.keyboard.press('Control+Space');
			await P.waitForTimeout(1200);
			const grip = await rect(P, '#viewport-pip .pip-grip');
			if (!grip) throw new Error('no viewport PiP');
			await mouseDrag(P, [grip.x + grip.w / 2, grip.y + grip.h / 2], [grip.x - 160, grip.y - 90], 10);
			await P.waitForTimeout(300);
			await mouseDrag(P, [grip.x - 160, grip.y - 90], [grip.x + 40, grip.y + 30], 10);
			const bar = await rect(P, '#viewport-pip');
			if (bar) await mouseDrag(P, [bar.x + 40, bar.y + 10], [bar.x - 200, bar.y - 120], 10);
			await P.waitForTimeout(300);
			await P.click('#viewport-pip .pip-close').catch(() => {});
			await P.waitForTimeout(300);
			await S(P, () => window.__stores.bottomDock.dockHeight.set(420));
			await P.waitForTimeout(500);
			await S(P, () => window.__stores.viewportPip.viewportPipClosed.set(false));
			await S(P, () => window.__stores.bottomDock.dockHeight.set(window.__stores.focusMode.fullDockHeight()));
			await P.waitForTimeout(600);
			await P.setViewportSize({ width: 1100, height: 800 });
			await P.waitForTimeout(400);
			await P.setViewportSize({ width: 1440, height: 900 });
			await P.waitForTimeout(400);
			await P.keyboard.press('Escape');
			await P.waitForTimeout(900);
		});

		await phase(P, T, 'K5 camera preview resize', async () => {
			await S(P, async () => {
				const s = window.__stores;
				s.inspectorClose.set(true);
				s.commandsHandler.sceneCommand('/create Camera');
				await new Promise((r) => setTimeout(r, 400));
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				const cam = g.children[g.children.length - 1];
				cam.position.set(-5, 3, 6);
				s.objectsGroup.update((v) => v);
				s.objectActions.selectObject(cam.uuid);
			});
			await P.waitForTimeout(900);
			const g = await S(P, () => {
				const el = [...document.querySelectorAll('.pip')].find((p) => p.id !== 'viewport-pip');
				const r = el && el.querySelector('.pip-grip')?.getBoundingClientRect();
				return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
			});
			if (!g) throw new Error('no camera preview grip');
			await mouseDrag(P, [g.x, g.y], [g.x - 120, g.y - 90], 10);
			await P.waitForTimeout(300);
			await mouseDrag(P, [g.x - 120, g.y - 90], [g.x + 30, g.y + 20], 10);
			await S(P, () => window.__stores.objectActions.deselectObject());
		});

		h.check(!(await crashToast(P)), `${T}no "Something went wrong: ResizeObserver" card at the end`);
		// the POSITIVE CONTROL: an observer that grows its own target must be caught by BOTH readers, or every
		// green above is a guard that cannot see
		await P.evaluate(() => (window.__roPhase = 'control'));
		const c0 = await seen(P);
		await S(P, () => {
			const d = document.createElement('div');
			d.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;pointer-events:none';
			document.body.appendChild(d);
			let n = 0;
			const ro = new ResizeObserver(() => {
				if (n++ < 2) d.style.width = 10 + n * 10 + 'px';
				else {
					ro.disconnect();
					d.remove();
				}
			});
			ro.observe(d);
		});
		await P.waitForTimeout(600);
		const c1 = await seen(P);
		h.check(c1.win.length > c0.win.length && c1.diag.length > c0.diag.length, `${T}control: a deliberate loop IS seen by both readers (window +${c1.win.length - c0.win.length}, diagnostics +${c1.diag.length - c0.diag.length})`);
		await S(P, () => window.__stores.diagnostics.clearDiagnostics());
		const all = await seen(P);
		console.log(`${T}RO loop errors by phase: ${JSON.stringify(all.win.map((e) => e.phase))}`);
		await A.ctx.close();
	}

	// ═══ OPPO Find N6 UNFOLDED (770x850, DPR 2.9) — real touch, desktop layout ═════════════════════════
	if (want('unfolded')) {
		const T = `[unfolded ${THEME}] `;
		const A = await h.setupPage(browser, 'unfolded', {
			context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { theme: THEME, toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}', timelineDocked: 'true', flowDockHeight: '300' },
			init: LISTEN
		});
		const P = A.page;
		const touch = await touchApi(P);
		await seedScene(P);
		await phase(P, T, 'boot + a box', async () => {});

		await phase(P, T, 'K2 sidebar grip past the minimum (touch)', async () => {
			await S(P, async () => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				s.objectActions.selectObject(g.children[g.children.length - 1].uuid, true);
				s.inspectorPinned.set(true);
				s.showSidebar('properties');
			});
			await P.waitForTimeout(1200);
			const g = await rect(P, '#sidebar-grip-right');
			if (!g) throw new Error('no right grip');
			const x = Math.round(g.x + g.w / 2);
			const y = Math.round(g.y + Math.min(300, g.h / 2));
			// showhide-v8: past the minimum but short of the border-close zone (MIN_W - 80 px closes the column now)
			await touch.drag([x, y], [770 - 210, y], 20);
			await P.waitForTimeout(400);
			await touch.drag([Math.round((await rect(P, '#sidebar-grip-right')).x + 3), y], [300, y], 20);
			await P.waitForTimeout(400);
			await S(P, () => window.__stores.showSidebar('scene'));
			await P.waitForTimeout(800);
		});

		await phase(P, T, 'J10 toolbar overflow (unfolded)', async () => {
			await setBar(P, ALL_ON);
			await P.waitForTimeout(600);
			await sidebar(P, { side: 'right', full: true, w: 300 });
			await P.waitForTimeout(600);
			await sidebar(P, { side: 'right', full: true, w: 250 });
			await P.waitForTimeout(600);
			await sidebar(P, { open: false });
			await setBar(P, null);
		});

		await phase(P, T, 'K5 Maximize + PiP (touch)', async () => {
			await S(P, async () => {
				const s = window.__stores;
				s.timelineClose.set(false);
				await new Promise((r) => setTimeout(r, 700));
				s.bottomDock.activateDock('timeline');
				await new Promise((r) => setTimeout(r, 900));
				s.focusMode.maximizeDockTab('timeline');
			});
			await P.waitForTimeout(1200);
			const pip = await rect(P, '#viewport-pip canvas');
			if (!pip) throw new Error('no viewport PiP');
			const c = [Math.round(pip.x + pip.w / 2), Math.round(pip.y + pip.h / 2)];
			await touch.drag(c, [c[0] + 90, c[1] + 20], 10);
			await P.waitForTimeout(400);
			await P.keyboard.press('Escape');
			await P.waitForTimeout(900);
		});

		h.check(!(await crashToast(P)), `${T}no "Something went wrong: ResizeObserver" card at the end`);
		await A.ctx.close();
	}

	// ═══ FOLDED 390x896 — the phone shell, its dock tabs, and the fold <-> unfold transition ═══════════
	if (want('folded')) {
		const T = `[folded ${THEME}] `;
		const A = await h.setupPage(browser, 'folded', {
			context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { theme: THEME, toursSeen: '{"editor-touch":true,"editor":true}' },
			init: LISTEN
		});
		const P = A.page;
		const touch = await touchApi(P);
		await seedScene(P);
		await phase(P, T, 'boot + a box', async () => {});

		await phase(P, T, 'J1 phone dock tabs (Statistics, Objects, Explorer)', async () => {
			await S(P, () => window.__stores.sceneBudget.statsOpen.set(true));
			await P.waitForTimeout(900);
			await S(P, () => window.__stores.objectListClose.set(false));
			await P.waitForTimeout(700);
			await S(P, () => window.__stores.explorerClose.set(false));
			await P.waitForTimeout(1200);
			for (let k = 0; k < 2; k++) {
				for (const name of ['Statistics', 'Objects', 'Explorer']) {
					const t = P.locator('.tp-dock-tab, [role=tab]', { hasText: name }).first();
					if (await t.count()) {
						await t.tap().catch(() => {});
						await P.waitForTimeout(350);
					}
				}
			}
			const gb = await rect(P, '#ps-dock-grip');
			if (gb) {
				const x = Math.round(gb.x + gb.w / 2);
				const y = Math.round(gb.y + gb.h / 2);
				await touch.drag([x, y], [x, y - 160], 14);
				await P.waitForTimeout(300);
				await touch.drag([x, y - 160], [x, y + 60], 14);
			}
		});

		await phase(P, T, 'fold <-> unfold transition', async () => {
			for (const [w, hgt] of [[770, 850], [390, 896], [770, 850], [390, 896]]) {
				await P.setViewportSize({ width: w, height: hgt });
				await P.waitForTimeout(1100);
			}
		});

		h.check(!(await crashToast(P)), `${T}no "Something went wrong: ResizeObserver" card at the end`);
		await A.ctx.close();
	}

	await h.finish(browser);
});
