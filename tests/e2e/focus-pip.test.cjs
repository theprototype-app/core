// 43 K5 — FOCUS MODE 2.0, the user's words (2026-10-14): "ctrl+space on 'code' docked window (or any other)
// makes it fullscreen (but it also should hide sidebars and show them back when exit from focus mode), also
// make it really full screen, keep tabs on top opened, and add picture in picture for viewport (allow it to
// be resizable, reuse camera viewport picture in picture but allow it to be on top of any docked window,
// place somewhere bottom right). In short this gap when expanding docked window to focus mode should cover
// entire screen (also I should be able to resize it as now, which would show viewport, but if I open full
// screen, then it shows viewport as picture in picture and I can close it if I want same as camera vieport
// preview). Also allow to be possible to resize camera viewport. Within picture in picture for viewport I
// should be able to pan and rotate to be able to navigate around and use shortcuts to move/resize/rotate
// objects".
//
//   1  premise: the Code window docked + in front, the right sidebar PINNED full height with Configure Scene
//   2  Ctrl+Space over the Code window: it covers the WHOLE window — rect = window rect minus nothing (tab
//      strip on the top edge, panel below to every edge), no 3D view showing anywhere
//   3  the sidebars are hidden while it lasts — and nothing about them changed (open, pinned, side)
//   4  the viewport PiP: bottom-right, above the docked window, a LIVE picture (frames keep coming, the main
//      frame is skipped while covered), its own camera (starts at the editor camera's pose)
//   5  it resizes by its corner and the size is remembered
//   6  a drag in the PiP orbits ITS camera — the editor camera does not move
//   7  close: the PiP goes (the dock stays full); a dock resized DOWN shows the real viewport and no PiP
//   8  Esc: the sidebars come back exactly (visible, pinned width), the dock back to its height, the editor
//      camera where it was; the next maximize shows the PiP again
//   9  the camera preview (16-Q4) resizes by its corner too: aspect kept, height remembered
//  10  the PiP is a second VIEWPORT: F frames the selection with the PiP camera, clicks select / deselect,
//      W/E/R (and the viewport's G) arm the gizmo modes without flying the editor camera, W then a drag on
//      the gizmo IN the PiP moves the selected object (one undo step), Delete deletes
//  11  unfolded N6 (touch, desktop layout, real CDP touch): the tab menu's Maximize fills the window with the
//      PiP up; a one-finger drag in the PiP orbits its camera; a tap selects
//
// Counterfactual: on origin/feat/42-int the dock stops 72 px below the top and 320 px short of the right
// edge (the pinned column's room), there is no PiP, and the camera preview has no grip.
// Run: APP_URL=https://localhost:5435/ npm run e2e -- focus-pip
const h = require('./helpers.cjs');
const THEME = process.env.THEME || 'dark';
const S = (page, fn, arg) => page.evaluate(fn, arg);
const store = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		let v;
		(name ? window.__stores[mod][name] : window.__stores[mod]).subscribe((x) => (v = x))();
		return v;
	}, path);

/** what is on screen */
const look = (page) =>
	S(page, () => {
		const vis = (el) => {
			if (!el) return false;
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
		};
		const box = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
		};
		const dock = [...document.querySelectorAll('.tp-dock-panel')].find((d) => !d.classList.contains('hidden') && d.getBoundingClientRect().height > 0);
		const at = (x, y) => {
			const el = document.elementFromPoint(x, y);
			return el ? (el.tagName === 'CANVAS' && el.closest('.viewport') ? 'VIEW' : el.closest('#viewport-pip') ? 'PIP' : el.closest('.tp-dock-panel') ? 'DOCK' : el.tagName) : null;
		};
		const W = innerWidth;
		const H = innerHeight;
		return {
			focus: document.documentElement.getAttribute('data-focus'),
			dock: box(dock),
			dockId: dock?.id ?? null,
			strip: vis(document.querySelector('.sb-strip')),
			inspector: vis(document.getElementById('inspector')),
			pip: box(document.getElementById('viewport-pip')),
			W,
			H,
			// what the corners, the top strip row and the middle of the window show
			probes: {
				topMid: at(W / 2, 12),
				topRight: at(W - 3, 30),
				botLeft: at(3, H - 3),
				botRight: at(W - 3, H - 3),
				mid: at(W / 2, H / 2)
			}
		};
	});

const camPose = (page) =>
	S(page, () => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		return { p: c.position.toArray().map((n) => +n.toFixed(4)), q: c.quaternion.toArray().map((n) => +n.toFixed(4)) };
	});

h.run(async () => {
	const browser = await h.launch();
	const out = process.env.OUT || '/tmp';
	const P = await h.setupPage(browser, 'D', {
		context: { viewport: { width: 1440, height: 900 } },
		storage: { timelineDocked: 'true', flowDockHeight: '300', 'sidebar:full:right': 'true', theme: THEME }
	});
	const page = P.page;
	// something to look at in the PiP (and to select / move in it)
	const boxUuid = await S(page, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.userData.physics = { mode: 'static' };
		s.objectActions.deselectObject();
		s.inspectorKind?.set?.('scene');
		s.inspectorClose.set(false);
		s.timelineClose.set(false);
		await new Promise((r) => setTimeout(r, 700));
		s.bottomDock.activateDock('timeline');
		return box.uuid;
	});
	await page.waitForTimeout(1500);

	// ---- 1. premise ---------------------------------------------------------------------------------
	let st = await look(page);
	h.check(st.dock && st.dockId && st.strip && st.inspector && !st.focus, `1.1 premise: the Code window is docked in front, the pinned right sidebar is up (${JSON.stringify({ dock: st.dock, id: st.dockId, strip: st.strip, inspector: st.inspector })})`);
	const dockBefore = st.dock;
	h.check(dockBefore && dockBefore.r < st.W - 200, `1.2 premise: the pinned column takes its room from the dock (dock right ${dockBefore?.r} < ${st.W - 200})`);
	const pose0 = await camPose(page);
	await page.screenshot({ path: `${out}/k5-before-${THEME}.png` });

	// ---- 2. Ctrl+Space over the Code window: the WHOLE window ----------------------------------------
	await page.mouse.move(Math.round((dockBefore.l + dockBefore.r) / 2), Math.round((dockBefore.t + dockBefore.b) / 2));
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(1200);
	st = await look(page);
	await page.screenshot({ path: `${out}/k5-focus-${THEME}.png` });
	h.check(st.focus === 'dock', `2.1 Ctrl+Space over the Code window maximizes it (data-focus ${st.focus})`);
	h.check(st.dock && st.dock.l === 0 && st.dock.r === st.W && st.dock.b === st.H, `2.2 ...the panel reaches every edge: left 0, right ${st.W}, bottom ${st.H} (${JSON.stringify(st.dock)})`);
	h.check(st.dock && st.dock.t <= 24, `2.3 ...its tab strip rides the top edge — the panel starts right under it (top ${st.dock?.t} <= 24)`);
	const shown = Object.values(st.probes).filter((v) => v === 'VIEW');
	h.check(shown.length === 0, `2.4 ...no 3D view shows anywhere: corners, the strip row, the middle (${JSON.stringify(st.probes)})`);

	// ---- 3. the sidebars --------------------------------------------------------------------------
	h.check(!st.strip && !st.inspector, `3.1 the sidebar (its tab strip and Configure Scene) is hidden (${st.strip}/${st.inspector})`);
	const sb = await S(page, () => {
		const g = (x) => {
			let v;
			x.subscribe((y) => (v = y))();
			return v;
		};
		const s = window.__stores;
		return { closed: g(s.inspectorClose), full: g(s.sidebars.sidebarFull).right, side: g(s.sidebars.inspectorSide) };
	});
	h.check(sb.closed === false && sb.full === true && sb.side === 'right', `3.2 ...and nothing about it CHANGED: still open, pinned, right (${JSON.stringify(sb)})`);

	// ---- 4. the viewport PiP --------------------------------------------------------------------
	h.check(!!st.pip && st.W - st.pip.r <= 40 && st.H - st.pip.b <= 40, `4.1 the viewport PiP is up, bottom-right (${JSON.stringify(st.pip)})`);
	const pipMid = st.pip && { x: Math.round((st.pip.l + st.pip.r) / 2), y: Math.round((st.pip.t + st.pip.b) / 2) + 10 };
	const onTop = pipMid && (await S(page, (p) => !!document.elementFromPoint(p.x, p.y)?.closest('#viewport-pip'), pipMid));
	h.check(onTop, '4.2 ...on top of the maximized docked window (the PiP owns its centre point)');
	const d0 = await S(page, () => window.__stores.pipViews.pipViewsDebug());
	await page.waitForTimeout(700);
	const d1 = await S(page, () => window.__stores.pipViews.pipViewsDebug());
	h.check(d1.views.viewport && d1.views.viewport.frames > d0.views.viewport.frames, `4.3 ...a LIVE picture: frames keep coming (${d0.views.viewport?.frames} -> ${d1.views.viewport?.frames})`);
	h.check(d1.mainCovered && d1.mainSkipped > d0.mainSkipped, `4.4 ...and the hidden main frame is not drawn meanwhile (skipped ${d0.mainSkipped} -> ${d1.mainSkipped})`);
	const scaled = d1.views.viewport;
	h.check(scaled && scaled.w < st.pip.r - st.pip.l && scaled.w > 50, `4.5 ...rendered at REDUCED resolution (${scaled?.w}x${scaled?.h} for a ${st.pip.r - st.pip.l}-px window)`);
	const picture = await S(page, () => {
		const c = document.querySelector('#viewport-pip canvas');
		const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
		let min = 255,
			max = 0;
		for (let i = 0; i < d.length; i += 4 * 7) {
			const l = d[i] + d[i + 1] + d[i + 2];
			min = Math.min(min, l);
			max = Math.max(max, l);
		}
		return { min, max };
	});
	h.check(picture.max - picture.min > 30, `4.6 ...a real picture, not a blank box (luma spread ${picture.max - picture.min})`);
	const pipCam = (await S(page, () => window.__stores.viewportPip.viewportPipDebug())).camera;
	h.check(pipCam && pipCam.position.every((v, i) => Math.abs(v - pose0.p[i]) < 0.01), `4.7 ...through its OWN camera, which starts at the editor camera's pose (${JSON.stringify(pipCam?.position)} vs ${JSON.stringify(pose0.p)})`);

	// ---- 5. resize by the corner --------------------------------------------------------------------
	const grip = await S(page, () => {
		const r = document.querySelector('#viewport-pip .pip-grip').getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	await page.mouse.move(grip.x, grip.y);
	await page.mouse.down();
	await page.mouse.move(grip.x - 160, grip.y - 90, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(400);
	const big = await look(page);
	const wasW = st.pip.r - st.pip.l;
	const nowW = big.pip.r - big.pip.l;
	h.check(nowW > wasW + 100 && big.pip.b - big.pip.t > st.pip.b - st.pip.t + 50, `5.1 dragging the corner grip makes it bigger (${wasW} -> ${nowW} wide)`);
	h.check(Math.abs(big.pip.r - st.pip.r) <= 2 && Math.abs(big.pip.b - st.pip.b) <= 2, `5.2 ...growing toward the screen, its bottom-right corner put (${st.pip.r},${st.pip.b} -> ${big.pip.r},${big.pip.b})`);
	const saved = await S(page, () => JSON.parse(localStorage.getItem('viewportPip:size') || 'null'));
	h.check(saved && Math.abs(saved.w - nowW) <= 2, `5.3 ...and the size is remembered (${JSON.stringify(saved)})`);

	// ---- 6. a drag in the PiP orbits ITS camera ------------------------------------------------------
	const before6 = (await S(page, () => window.__stores.viewportPip.viewportPipDebug())).camera;
	const mainBefore6 = await camPose(page);
	const c6 = { x: Math.round((big.pip.l + big.pip.r) / 2), y: Math.round((big.pip.t + big.pip.b) / 2) + 20 };
	await page.mouse.move(c6.x, c6.y);
	await page.mouse.down();
	await page.mouse.move(c6.x + 120, c6.y + 30, { steps: 10 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	const after6 = (await S(page, () => window.__stores.viewportPip.viewportPipDebug())).camera;
	const moved6 = after6.position.some((v, i) => Math.abs(v - before6.position[i]) > 0.05);
	h.check(moved6, `6.1 a drag in the PiP orbits its camera (${JSON.stringify(before6.position.map((n) => +n.toFixed(2)))} -> ${JSON.stringify(after6.position.map((n) => +n.toFixed(2)))})`);
	h.check(after6.target.every((v, i) => Math.abs(v - before6.target[i]) < 0.01), '6.2 ...an ORBIT: about its target, which stays put');
	const mainAfter6 = await camPose(page);
	h.check(JSON.stringify(mainAfter6) === JSON.stringify(mainBefore6), '6.3 ...and the editor camera did not move');
	const box6 = (await look(page)).pip;
	h.check(box6 && box6.l === big.pip.l && box6.t === big.pip.t, '6.4 ...nor did the PiP window (a body drag is the picture\'s, not the frame\'s)');

	// ---- 10. the PiP is a second VIEWPORT: select, the transform keys, the gizmo ---------------------
	const sel = () => store(page, 'selectedObjects');
	const boxPos = () =>
		S(page, (u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', u).position.toArray().map((n) => +n.toFixed(3));
		}, boxUuid);
	/** the box's centre, projected through the PiP camera to page pixels */
	const boxInPip = () =>
		S(page, (u) => {
			const THREE = window.__stores.objectsGroup && null;
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const obj = g.getObjectByProperty('uuid', u);
			const view = (() => {
				let v;
				window.__stores.viewportPip.viewportPipView.subscribe((x) => (v = x))();
				return v;
			})();
			const c = document.querySelector('#viewport-pip canvas').getBoundingClientRect();
			const p = obj.getWorldPosition(obj.position.clone()).project(view.camera);
			return { x: Math.round(c.left + ((p.x + 1) / 2) * c.width), y: Math.round(c.top + ((1 - p.y) / 2) * c.height), _: THREE };
		}, boxUuid);
	// F first, with the box selected from the outside, so it fills the PiP for the clicks below
	await S(page, (u) => window.__stores.objectActions.selectObject(u), boxUuid);
	await page.waitForTimeout(300);
	const tgtBefore = (await S(page, () => window.__stores.viewportPip.viewportPipDebug())).camera.target;
	const mainBeforeF = await camPose(page);
	const pipNow = (await look(page)).pip;
	await page.mouse.move(pipNow.l + 40, pipNow.b - 30); // the pointer over the PiP gives it the keyboard
	await page.mouse.click(pipNow.l + 40, pipNow.b - 30, { button: 'middle' });
	await page.keyboard.press('f');
	await page.waitForTimeout(500);
	const tgtF = (await S(page, () => window.__stores.viewportPip.viewportPipDebug())).camera.target;
	const centre = await boxPos();
	h.check(tgtF && tgtF.every((v, i) => Math.abs(v - centre[i]) < 0.05) && JSON.stringify(tgtF) !== JSON.stringify(tgtBefore), `10.1 F over the PiP frames the selection with the PiP camera (target ${JSON.stringify(tgtBefore)} -> ${JSON.stringify(tgtF?.map((n) => +n.toFixed(2)))})`);
	h.check(JSON.stringify(await camPose(page)) === JSON.stringify(mainBeforeF), '10.2 ...the editor camera did not move (F in the PiP is the PiP\'s)');
	// a click on empty space deselects, a click on the box selects it
	await page.mouse.click(pipNow.l + 30, pipNow.t + 40);
	await page.waitForTimeout(300);
	const afterEmpty = await sel();
	const bp = await boxInPip();
	await page.mouse.click(bp.x, bp.y);
	await page.waitForTimeout(400);
	const afterBox = await sel();
	h.check(afterEmpty.length === 0 && afterBox.length === 1 && afterBox[0] === boxUuid, `10.3 clicks in the PiP select: empty space deselects, the box selects it (${afterEmpty.length} -> ${JSON.stringify(afterBox)})`);
	// the transform keys, over the PiP
	await page.keyboard.press('r');
	const mR = await store(page, 'transformMode');
	await page.keyboard.press('e');
	const mE = await store(page, 'transformMode');
	await page.keyboard.press('g');
	const mG = await store(page, 'transformMode');
	const mainBeforeW = await camPose(page);
	await page.keyboard.press('e');
	await page.keyboard.down('w');
	await page.waitForTimeout(400);
	await page.keyboard.up('w');
	const mW = await store(page, 'transformMode');
	h.check(mR === 'scale' && mE === 'rotate' && mG === 'translate' && mW === 'translate', `10.4 over the PiP W/E/R arm Move/Rotate/Scale and G (the viewport's row) Move too (R ${mR}, E ${mE}, G ${mG}, W ${mW})`);
	h.check(JSON.stringify(await camPose(page)) === JSON.stringify(mainBeforeW), '10.5 ...and holding W there does not fly the editor camera');
	// the gizmo: find a point on its X handle through the PiP camera, then drag it
	const handle = await S(page, () => {
		let tc, view;
		window.__stores.TControls.subscribe((v) => (tc = v))();
		window.__stores.viewportPip.viewportPipView.subscribe((v) => (view = v))();
		const c = document.querySelector('#viewport-pip canvas');
		const r = c.getBoundingClientRect();
		const o = tc.object.getWorldPosition(tc.object.position.clone());
		const p0 = o.clone().project(view.camera);
		const p1 = o.clone().add({ x: 1, y: 0, z: 0, isVector3: true }).project(view.camera);
		const dx = p1.x - p0.x;
		const dy = p1.y - p0.y;
		const len = Math.hypot(dx, dy) || 1;
		for (let t = 0.02; t < 1.2; t += 0.01) {
			const x = p0.x + (dx / len) * t;
			const y = p0.y + (dy / len) * t;
			tc.pointerHover({ x, y, button: 0 });
			if (tc.axis === 'X') return { x: Math.round(r.left + ((x + 1) / 2) * r.width), y: Math.round(r.top + ((1 - y) / 2) * r.height), cameraIsPip: tc.camera === view.camera, dom: tc.domElement === c };
		}
		return { cameraIsPip: tc.camera === view.camera, dom: tc.domElement === c };
	});
	h.check(handle.cameraIsPip && handle.dom, `10.6 the transform gizmo is handed the PiP's camera and canvas while it is up (${JSON.stringify(handle)})`);
	const pos0 = await boxPos();
	const pipCam0 = (await S(page, () => window.__stores.viewportPip.viewportPipDebug())).camera.position;
	if (handle.x) {
		await page.mouse.move(handle.x, handle.y);
		await page.waitForTimeout(100);
		await page.mouse.down();
		await page.mouse.move(handle.x + 60, handle.y + 4, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(500);
	}
	const pos1 = await boxPos();
	h.check(!!handle.x && Math.abs(pos1[0] - pos0[0]) > 0.2 && Math.abs(pos1[1] - pos0[1]) < 0.01 && Math.abs(pos1[2] - pos0[2]) < 0.01, `10.7 W then a drag on the gizmo in the PiP moves the selected object along X (${JSON.stringify(pos0)} -> ${JSON.stringify(pos1)})`);
	const pipCam1 = (await S(page, () => window.__stores.viewportPip.viewportPipDebug())).camera.position;
	h.check(pipCam1.every((v, i) => Math.abs(v - pipCam0[i]) < 1e-3), '10.8 ...and the PiP view did NOT orbit with that drag (the gizmo owns the press)');
	await page.keyboard.press('Control+z');
	await page.waitForTimeout(500);
	const pos2 = await boxPos();
	h.check(pos2.every((v, i) => Math.abs(v - pos0[i]) < 0.01), `10.9 ...ONE undo step puts it back (${JSON.stringify(pos2)})`);
	// Delete over the PiP deletes the selection (the viewport's row)
	const doomed = await S(page, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Sphere');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		o.position.set(3, 1, 0);
		s.objectsGroup.update((v) => v);
		s.objectActions.selectObject(o.uuid);
		return o.uuid;
	});
	await page.waitForTimeout(300);
	await page.mouse.move(pipNow.l + 40, pipNow.b - 30);
	await page.keyboard.press('Delete');
	await page.waitForTimeout(600);
	const gone = await S(page, (u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return !g.getObjectByProperty('uuid', u);
	}, doomed);
	h.check(gone, '10.10 Delete over the PiP deletes the selected object');

	// ---- 7. close; a dock resized down shows the real viewport ---------------------------------------
	await page.click('#viewport-pip .pip-close');
	await page.waitForTimeout(400);
	st = await look(page);
	h.check(!st.pip && st.focus === 'dock' && st.dock.t <= 24, `7.1 the PiP's close button closes it; the window stays maximized (${st.focus}, top ${st.dock?.t})`);
	await S(page, () => window.__stores.bottomDock.dockHeight.set(420));
	await page.waitForTimeout(500);
	st = await look(page);
	const covered7 = (await S(page, () => window.__stores.pipViews.pipViewsDebug())).mainCovered;
	h.check(st.focus === 'dock' && st.probes.mid === 'VIEW' && !covered7, `7.2 resizing the maximized window DOWN shows the real 3D view again (middle = ${st.probes.mid}, covered ${covered7})`);
	await S(page, () => window.__stores.viewportPipClosed?.set?.(false));
	await S(page, () => window.__stores.viewportPip.viewportPipClosed.set(false));
	await page.waitForTimeout(300);
	h.check(!(await look(page)).pip, '7.3 ...and no PiP then (it would be a second copy of what is on screen)');
	await S(page, () => window.__stores.bottomDock.dockHeight.set(window.__stores.focusMode.fullDockHeight()));
	await page.waitForTimeout(500);
	h.check(!!(await look(page)).pip, '7.4 back to full height: the PiP is back');

	// ---- 8. Esc restores ------------------------------------------------------------------------
	await page.keyboard.press('Escape');
	await page.waitForTimeout(900);
	st = await look(page);
	await page.screenshot({ path: `${out}/k5-after-${THEME}.png` });
	h.check(!st.focus && st.strip && st.inspector, `8.1 Esc: the sidebar comes back (strip ${st.strip}, Configure Scene ${st.inspector})`);
	h.check(st.dock && Math.abs(st.dock.t - dockBefore.t) <= 2 && Math.abs(st.dock.r - dockBefore.r) <= 2, `8.2 ...the dock is back to its height and beside the pinned column (${JSON.stringify(st.dock)} vs ${JSON.stringify(dockBefore)})`);
	h.check(!st.pip && (await S(page, () => window.__stores.pipViews.pipViewsDebug())).mainCovered === false, '8.3 ...no PiP, and the main frame draws again');
	h.check(JSON.stringify(await camPose(page)) === JSON.stringify(pose0), '8.4 ...and the editor camera is where it was');
	const back = await S(page, () => {
		let tc, cam, r;
		window.__stores.TControls.subscribe((v) => (tc = v))();
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		// threlte connects the gizmo to the canvas's WRAPPER (its `dom`), so "back" = that element again
		const d = tc.domElement;
		return { camera: tc.camera === cam, dom: !!d && d.isConnected && !d.closest('#viewport-pip') && (d === r.domElement || d.contains(r.domElement)) };
	});
	h.check(back.camera && back.dom, `8.4b ...and the gizmo is handed back to the editor camera and canvas (${JSON.stringify(back)})`);
	const dockNow = st.dock;
	await page.mouse.move(Math.round((dockNow.l + dockNow.r) / 2), Math.round((dockNow.t + dockNow.b) / 2));
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(1000);
	st = await look(page);
	h.check(st.focus === 'dock' && !!st.pip, `8.5 the next maximize shows the PiP again (it was reopened in 7; open / closed is remembered since 44 M15) (${st.focus}, ${!!st.pip})`);
	h.check(st.pip && Math.abs(st.pip.r - st.pip.l - nowW) <= 2, `8.6 ...at the remembered size (${st.pip && st.pip.r - st.pip.l} ~ ${nowW})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(600);

	// ---- 9. the camera preview resizes too --------------------------------------------------------
	const camUuid = await S(page, async () => {
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
		return cam.uuid;
	});
	await page.waitForTimeout(800);
	const camFrame = () =>
		S(page, () => {
			const el = [...document.querySelectorAll('.pip')].find((p) => p.id !== 'viewport-pip');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			const g = el.querySelector('.pip-grip')?.getBoundingClientRect();
			return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), grip: g ? { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) } : null };
		});
	const cf0 = await camFrame();
	h.check(!!cf0 && !!cf0.grip && !!camUuid, `9.1 selecting a camera shows its preview, with a corner grip (${JSON.stringify(cf0)})`);
	if (cf0?.grip) {
		await page.mouse.move(cf0.grip.x, cf0.grip.y);
		await page.mouse.down();
		await page.mouse.move(cf0.grip.x - 120, cf0.grip.y - 90, { steps: 8 });
		await page.mouse.up();
		await page.waitForTimeout(500);
	}
	const cf1 = await camFrame();
	const h0 = cf0 ? cf0.b - cf0.t : 0;
	const h1 = cf1 ? cf1.b - cf1.t : 0;
	h.check(h1 > h0 + 50, `9.2 dragging its grip resizes the camera preview (${h0} -> ${h1} tall)`);
	const a0 = cf0 ? (cf0.r - cf0.l) / h0 : 0;
	const a1 = cf1 ? (cf1.r - cf1.l) / h1 : 0;
	h.check(Math.abs(a0 - a1) < 0.05, `9.3 ...keeping the camera's framing aspect (${a0.toFixed(3)} -> ${a1.toFixed(3)})`);
	const dbg = await S(page, () => window.__stores.cameraPip.pipDebug());
	h.check(dbg.rect && Math.abs(dbg.rect.h - h1) <= 2 && Number(await S(page, () => localStorage.getItem('cameraPip:height'))) === dbg.height, `9.4 ...the height is remembered (${dbg.height}, rect ${JSON.stringify(dbg.rect)})`);
	const camViews = (await S(page, () => window.__stores.pipViews.pipViewsDebug())).views;
	h.check(camViews.camera && camViews.camera.frames > 0, `9.5 ...drawn by the same PiP renderer (camera view, ${camViews.camera?.frames} frames)`);
	await page.screenshot({ path: `${out}/k5-camera-pip-${THEME}.png` });

	// ---- 11. unfolded N6 (touch, desktop layout): the same, with fingers -----------------------------
	const T = await h.setupPage(browser, 'T', {
		context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { timelineDocked: 'true', flowDockHeight: '300', theme: THEME }
	});
	const tp = T.page;
	const cdp = await tp.context().newCDPSession(tp);
	const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
	const tBox = await S(tp, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		s.objectActions.deselectObject();
		s.timelineClose.set(false);
		await new Promise((r) => setTimeout(r, 700));
		s.bottomDock.activateDock('timeline');
		await new Promise((r) => setTimeout(r, 900));
		// the touch way in: the dock tab menu's Maximize
		s.focusMode.maximizeDockTab('timeline');
		return box.uuid;
	});
	await tp.waitForTimeout(1200);
	const tl = await look(tp);
	await tp.screenshot({ path: `${out}/k5-unfolded-${THEME}.png` });
	h.check(tl.focus === 'dock' && tl.dock && tl.dock.l === 0 && tl.dock.r === tl.W && tl.dock.b === tl.H && !!tl.pip, `11.1 unfolded N6 (touch): Maximize fills the window and the viewport PiP is up (${JSON.stringify({ dock: tl.dock, pip: tl.pip })})`);
	const t0 = (await S(tp, () => window.__stores.viewportPip.viewportPipDebug())).camera;
	const tc = { x: Math.round((tl.pip.l + tl.pip.r) / 2), y: Math.round((tl.pip.t + tl.pip.b) / 2) + 15 };
	await touch('touchStart', tc.x, tc.y);
	for (let i = 1; i <= 10; i++) await touch('touchMove', tc.x + i * 9, tc.y + i * 2);
	await touch('touchEnd', 0, 0);
	await tp.waitForTimeout(600);
	const t1 = (await S(tp, () => window.__stores.viewportPip.viewportPipDebug())).camera;
	h.check(t1.position.some((v, i) => Math.abs(v - t0.position[i]) > 0.05), `11.2 a one-finger drag in the PiP orbits its camera (${JSON.stringify(t0.position.map((n) => +n.toFixed(2)))} -> ${JSON.stringify(t1.position.map((n) => +n.toFixed(2)))})`);
	const tb = await S(tp, (u) => {
		let g, view;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.viewportPip.viewportPipView.subscribe((v) => (view = v))();
		const o = g.getObjectByProperty('uuid', u);
		const c = document.querySelector('#viewport-pip canvas').getBoundingClientRect();
		const p = o.getWorldPosition(o.position.clone()).project(view.camera);
		return { x: Math.round(c.left + ((p.x + 1) / 2) * c.width), y: Math.round(c.top + ((1 - p.y) / 2) * c.height) };
	}, tBox);
	await touch('touchStart', tb.x, tb.y);
	await touch('touchEnd', 0, 0);
	await tp.waitForTimeout(500);
	const tsel = await store(tp, 'selectedObjects');
	h.check(tsel.length === 1 && tsel[0] === tBox, `11.3 a tap on the box in the PiP selects it (${JSON.stringify(tsel)})`);

	await h.finish(browser);
});
