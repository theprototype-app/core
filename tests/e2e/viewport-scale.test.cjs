// W9: THE BOTTOM DOCK IS A LAYOUT REGION, NOT AN OVERLAY.
//
// The 3D viewport used to be the whole window with the dock drawn on top of it. It
// now ENDS where an open dock begins, the way every DCC lays out its viewport — and
// a user can put the old behaviour back from Settings ▸ Interface ▸ Viewport.
//
// The shrink itself is nearly free: threlte sizes the renderer from a ResizeObserver
// on the Canvas's parent, so moving that parent's bottom edge carries the drawing
// buffer, the camera aspect, the composer and N8AO with it. What is NOT free is every
// place that mapped a pointer to NDC with `window.innerWidth/innerHeight` — each of
// those is wrong by exactly the dock's height the moment the canvas stops being the
// window. Section 4 is the guard for that class, and it is the one that goes red by
// the dock height if the fix is reverted (the counterfactual, run and recorded).
const h = require('./helpers.cjs');

/** the live geometry: CSS canvas box, the drawing buffer, the camera's aspect */
const geom = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalRenderer.subscribe((r) => {
					window.__stores.globalCamera.subscribe((cam) => {
						const el = r?.domElement;
						const rect = el?.getBoundingClientRect();
						const size = r ? r.getSize(new window.__stores.THREE.Vector2()) : null;
						window.__stores.bottomDock.bottomInset.subscribe((inset) => {
							resolve({
								css: rect
									? {
											top: Math.round(rect.top),
											height: Math.round(rect.height),
											width: Math.round(rect.width)
										}
									: null,
								buffer: size ? { w: Math.round(size.x), h: Math.round(size.y) } : null,
								aspect: cam ? +cam.aspect.toFixed(4) : null,
								inset,
								win: { w: window.innerWidth, h: window.innerHeight }
							});
						})();
					})();
				})();
			})
	);

const openDock = (page) =>
	page.evaluate(() => {
		window.__stores.explorerClose.set(false);
		window.__stores.bottomDock.activateDock('explorer');
		window.__stores.bottomDock.dockHeight.set(260);
	});

const closeDock = (page) => page.evaluate(() => window.__stores.explorerClose.set(true));

const selection = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.selectedObjects.subscribe((s) => r([...(s ?? [])]))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 720 } }
	});

	// ---------------------------------------------------------------- 1. premise
	await closeDock(A.page);
	await A.page.waitForTimeout(900);
	let g = await geom(A.page);
	h.check(g.inset === 0, '1.1 premise: nothing is docked, so the dock reserves no space');
	h.check(
		g.css && Math.abs(g.css.height - g.win.h) <= 1 && g.css.top === 0,
		`1.2 premise: with the dock closed the canvas IS the window (${g.css?.height} of ${g.win.h}px)`
	);
	const fullHeight = g.css.height;
	const fullAspect = g.aspect;

	// ------------------------------------------------- 2. opening the dock shrinks it
	await openDock(A.page);
	await A.page.waitForTimeout(1200);
	g = await geom(A.page);
	h.check(g.inset > 0, `2.1 the dock reports a height (${g.inset}px)`);
	h.check(
		Math.abs(g.css.height - (g.win.h - g.inset)) <= 1,
		`2.2 the canvas ends where the dock begins: ${g.css.height} = ${g.win.h} - ${g.inset}`
	);
	h.check(
		g.css.height < fullHeight - 100,
		`2.3 ...which is materially smaller than the window (${g.css.height} < ${fullHeight})`
	);
	// the DRAWING BUFFER is the half that actually costs GPU memory — a CSS-only
	// shrink would letterbox a stale buffer instead of rendering fewer pixels
	h.check(
		g.buffer && Math.abs(g.buffer.h - g.css.height) <= 2,
		`2.4 threlte re-sized the drawing buffer to match (${g.buffer?.h} for a ${g.css.height}px box)`
	);
	h.check(
		g.aspect !== null && Math.abs(g.aspect - g.css.width / g.css.height) < 0.01,
		`2.5 the camera aspect followed (${g.aspect} for ${g.css.width}x${g.css.height})`
	);
	h.check(
		g.aspect > fullAspect + 0.2,
		`2.6 ...and is genuinely different from the full-window one (${g.aspect} vs ${fullAspect})`
	);

	// ------------------------------------------------------ 3. the top-edge drag
	const grip = await A.page.evaluate(() => {
		const el = document.querySelector('#explorer-list .resize-cue');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	h.check(!!grip, '3.1 premise: the dock has a top-edge resize grip');
	const beforeDrag = g.css.height;
	await A.page.mouse.move(grip.x, grip.y);
	await A.page.mouse.down();
	for (let i = 1; i <= 20; i++) {
		await A.page.mouse.move(grip.x, grip.y - i * 6);
		await A.page.waitForTimeout(16);
	}
	await A.page.mouse.up();
	await A.page.waitForTimeout(700);
	g = await geom(A.page);
	h.check(
		g.css.height < beforeDrag - 80,
		`3.2 dragging the dock taller shrinks the viewport live (${beforeDrag} -> ${g.css.height}px)`
	);
	h.check(
		Math.abs(g.css.height - (g.win.h - g.inset)) <= 1 && Math.abs(g.buffer.h - g.css.height) <= 2,
		'3.3 ...and the canvas, the dock and the drawing buffer all still agree'
	);
	// back to a workable size for the picking sections
	await A.page.evaluate(() => window.__stores.bottomDock.dockHeight.set(260));
	await A.page.waitForTimeout(800);

	// --------------------------------------- 4. THE COORDINATE CLASS: picking + drops
	// A box parked low in the frame, so an error of the dock's height is unmissable.
	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 900));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.position.set(0, 0, 0);
		// a physics box falls; park it where we put it
		box.userData.physics = { mode: 'static' };
		box.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
		return box.uuid;
	});
	await A.page.waitForTimeout(900);
	// aim at the box through the SHRUNK canvas (helpers.projectPoint is canvas-aware)
	const at = await h.projectPoint(A.page, [0, 0, 0]);
	g = await geom(A.page);
	h.check(
		at.y < g.css.height && at.y > 0,
		`4.1 premise: the target projects inside the shrunk viewport (y ${Math.round(at.y)} < ${g.css.height})`
	);
	const overCanvas = await A.page.evaluate(
		(p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null,
		at
	);
	h.check(overCanvas === 'CANVAS', `4.2 premise: that pixel really is the canvas (${overCanvas})`);
	await A.page.evaluate(() => window.__stores.selectedObjects.set([]));
	await A.page.mouse.click(Math.round(at.x), Math.round(at.y));
	await A.page.waitForTimeout(700);
	let sel = await selection(A.page);
	h.check(
		sel.length === 1 && sel[0] === uuid,
		`4.3 clicking an object low in the shrunk viewport selects THAT object (${sel.length} picked)`
	);

	// explorerDrop: the drop must land where the cursor is, not a dock-height below it.
	// This reads the ray directly, which is what the real drag-drop handler calls.
	const drop = await A.page.evaluate(
		(p) => window.__stores.explorerDrop.dropTarget(p.x, p.y),
		at
	);
	h.check(
		drop && drop.object && drop.object.uuid === uuid,
		'4.4 an Explorer drop at that same pixel resolves to the same object'
	);
	h.check(
		drop.point && Math.hypot(drop.point[0] - 0, drop.point[2] - 0) < 1.6,
		`4.5 ...and its world point is on the box, not below it (${drop.point?.map((n) => n.toFixed(2))})`
	);
	// the module SDK's public pointer ray is the same class of bug, via api.pointerRay
	const rayHit = await A.page.evaluate(async (p) => {
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x, clientY: p.y }));
		await new Promise((r) => setTimeout(r, 60));
		const ray = window.__stores.moduleSDK.pointerRayNow();
		if (!ray) return null;
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const hits = ray.intersectObjects(group.children, true);
		return hits[0] ? window.__stores.objectActions.topLevelObjectOf(hits[0].object).uuid : null;
	}, at);
	h.check(rayHit === uuid, '4.6 api.pointerRay() hits what is under the cursor, not below it');

	// --------------------------------------------- 5. the PiP stays out of the dock
	await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 800));
	});
	await A.page.waitForTimeout(900);
	const camUuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const cam = group.children.find((c) => c.userData?.camera);
		if (cam) w.selectedObjects.set([cam.uuid]);
		return cam?.uuid ?? null;
	});
	await A.page.waitForTimeout(900);
	h.check(!!camUuid, '5.1 premise: a camera object exists and is selected');
	let pip = await A.page.evaluate(() => window.__stores.cameraPip.pipDebug());
	g = await geom(A.page);
	h.check(
		!!pip.rect && pip.rect.y + pip.rect.h <= g.css.height + 1,
		`5.2 the parked PiP sits inside the viewport, clear of the dock (bottom ${pip.rect ? pip.rect.y + pip.rect.h : '-'} <= ${g.css.height})`
	);
	// drag it hard into the dock band: the clamp must refuse
	await A.page.evaluate((winH) => {
		window.__stores.cameraPip.pipPosition.set({ x: 300, y: winH + 400 });
	}, 720);
	await A.page.waitForTimeout(600);
	pip = await A.page.evaluate(() => window.__stores.cameraPip.pipDebug());
	g = await geom(A.page);
	h.check(
		!!pip.rect && pip.rect.y + pip.rect.h <= g.css.height + 1,
		`5.3 a PiP dragged past the bottom is clamped ABOVE the dock, where its picture still draws (bottom ${pip.rect ? pip.rect.y + pip.rect.h : '-'} <= ${g.css.height})`
	);
	await A.page.evaluate(() => {
		window.__stores.cameraPip.resetPipPosition();
		window.__stores.selectedObjects.set([]);
	});
	await A.page.waitForTimeout(400);

	// ------------------------------------------------------------ 6. play mode
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(1400);
	g = await geom(A.page);
	h.check(
		Math.abs(g.css.height - g.win.h) <= 1,
		`6.1 play mode gives the viewport its full height back (${g.css.height} of ${g.win.h}px)`
	);
	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	await A.page.waitForTimeout(1600);
	g = await geom(A.page);
	h.check(
		Math.abs(g.css.height - (g.win.h - g.inset)) <= 1,
		'6.2 leaving play mode gives the space back to the dock'
	);

	// --------------------------------- 7. the pref, through the REAL Settings row
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(600);
	await A.page.getByText('Interface', { exact: true }).first().click();
	await A.page.waitForTimeout(500);
	const row = A.page.locator('.setting-row').filter({ hasText: 'Dock resizes the viewport' }).first();
	h.check((await row.count()) === 1, '7.1 Settings ▸ Interface has a "Dock resizes the viewport" row');
	const toggle = row.locator('input[type="checkbox"]');
	h.check((await toggle.count()) === 1, '7.2 ...with a real toggle');
	h.check(await toggle.isChecked(), '7.3 ...which is ON by default');
	// flowbite keeps the real input `sr-only` under a painted track, so click the
	// control itself rather than its coordinates (dock-chrome's idiom)
	await toggle.evaluate((el) => el.click());
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(900);
	g = await geom(A.page);
	h.check(
		g.inset > 0 && Math.abs(g.css.height - g.win.h) <= 1,
		`7.4 pref OFF: the canvas is full-window again while the dock is still open (${g.css.height} of ${g.win.h}, dock ${g.inset}px)`
	);
	const covered = await A.page.evaluate((winH) => {
		const el = document.elementFromPoint(200, winH - 40);
		return el?.closest('#explorer-list') ? 'dock' : (el?.tagName ?? null);
	}, 720);
	h.check(covered === 'dock', `7.5 ...and the dock is drawn OVER it, the pre-W9 behaviour (${covered})`);
	const persisted = await A.page.evaluate(
		() => JSON.parse(localStorage.getItem('viewPrefs') || '{}').dockPushesViewport
	);
	h.check(persisted === false, '7.6 the choice persists to localStorage (a local pref)');

	// back ON, and the viewport shrinks again — the toggle works in both directions
	await A.page.evaluate(() =>
		window.__stores.viewPrefs.setViewPrefs({ dockPushesViewport: true })
	);
	await A.page.waitForTimeout(900);
	g = await geom(A.page);
	h.check(
		Math.abs(g.css.height - (g.win.h - g.inset)) <= 1,
		'7.7 turning it back on shrinks the viewport again'
	);

	// ------------------------------------------------- 8. closing the dock restores
	await closeDock(A.page);
	await A.page.waitForTimeout(1200);
	g = await geom(A.page);
	h.check(g.inset === 0, '8.1 closing the dock releases its space');
	h.check(
		Math.abs(g.css.height - g.win.h) <= 1 && Math.abs(g.buffer.h - g.win.h) <= 2,
		`8.2 the viewport (and its buffer) go back to the full window (${g.css.height} of ${g.win.h}px)`
	);
	h.check(
		Math.abs(g.aspect - fullAspect) < 0.01,
		`8.3 ...and the camera aspect is exactly what it started as (${g.aspect} vs ${fullAspect})`
	);

	// ------------------------- 9. the knife, cut through the SHRUNK viewport
	// The knife takes its line in CLIENT pixels and projects the mesh itself to
	// compare — so if the two are measured in different spaces the cut lands
	// somewhere else entirely. mesh-knife covers the maths with the dock closed;
	// this is the same geometric claim with the viewport resized under it.
	await openDock(A.page);
	await A.page.waitForTimeout(1200);
	const knife = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const THREE = s.THREE;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(0, 0, 0);
		box.updateMatrixWorld(true);
		fe.exitFaceEdit();
		fe.enterFaceEdit(box.uuid);
		let camera;
		s.globalCamera.subscribe((c) => (camera = c))();
		camera.position.set(3.5, 3, 4.5);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld(true);
		// project against the CANVAS — the same box the app's own knife projects into
		let renderer;
		s.globalRenderer.subscribe((r) => (renderer = r))();
		const rect = renderer.domElement.getBoundingClientRect();
		const project = (v) => {
			const p = v.clone().project(camera);
			return [
				rect.left + ((p.x + 1) / 2) * rect.width,
				rect.top + ((1 - p.y) / 2) * rect.height
			];
		};
		// A HORIZONTAL cut through the midpoint of a VERTICAL edge, measured in Y.
		//
		// The obvious version of this check — a VERTICAL cut line, measured in X —
		// CANNOT FAIL: the canvas and the window are the same WIDTH, so a screen x maps
		// identically either way, while the whole error being guarded against lives in
		// y. It was written that way first and passed with the fix reverted, which is
		// what gave it away. The front-right edge runs (1,-1,1) -> (1,1,1), midpoint
		// (1,0,1), and a horizontal line through it must cut it at y = 0.
		const midpoint = new THREE.Vector3(1, -1, 1).lerp(new THREE.Vector3(1, 1, 1), 0.5);
		const screenMid = project(midpoint);
		const ok = fe.knifeCut([screenMid[0] - 600, screenMid[1]], [screenMid[0] + 600, screenMid[1]]);
		const tris = fe.readTriangles(box.geometry);
		let best = 1e9;
		for (const t of tris)
			for (const v of t) {
				if (Math.abs(v.x - 1) > 1e-4 || Math.abs(v.z - 1) > 1e-4) continue; // on the edge
				if (Math.abs(Math.abs(v.y) - 1) < 1e-4) continue; // skip the two corners
				best = Math.min(best, Math.abs(v.y));
			}
		fe.exitFaceEdit();
		return { ok, offset: best, canvasH: Math.round(rect.height) };
	});
	h.check(knife.ok === true, `9.1 the knife cuts with the dock open (canvas ${knife.canvasH}px tall)`);
	h.check(
		knife.offset < 0.05,
		`9.2 ...and the cut lands on the aimed world point, not a dock-height away (offset ${knife.offset.toFixed(4)} of a 2m box)`
	);

	await h.finish(browser);
});
