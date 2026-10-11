// 41-select — the user's 1.32 preview review, the selection rows (roadmap 41):
//
//   G2   creating an object never OPENS the Inspector; one that is already open follows it
//   G11  the phone selection strip: Inspect is an icon TOGGLE whose pressed state is the
//        Inspector really being open (it looked pressed all the time); Multi-select and
//        Interact toggles sit after Scale; all nine cells fit a folded N6
//   G13  Interact ON deselects (the set is stashed) and the strip stays; OFF restores it,
//        minus anything deleted meanwhile — phone strip, unfolded and desktop Controls cell
//   G14  a FINGER's tap on a selected object deselects it; in Multi-select taps toggle;
//        a mouse click on a selected object still keeps it (desktop unchanged)
//   G4   Interact + physics: a finger (and the mouse) carries a body from the point it took
//        it, on a camera-facing plane — the grab point stays under the finger, near or far
//        (it used to jump the body's ORIGIN onto the ray at 0.8-6 m) — and the release is a
//        bounded throw
//
// Phone gestures are REAL touch events (CDP Input.dispatchTouchEvent). Devices: OPPO Find N6
// folded (390x896, DPR 2.9) and unfolded (770x850, DPR 2.9), desktop 1440x900 with a mouse.
const h = require('./helpers.cjs');

const N6_FOLDED = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };
const N6_UNFOLDED = { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const STORAGE = { toursSeen: '{"editor-touch":true,"editor":true}' };

/** read a store by dotted path on window.__stores @param {any} page @param {string} path */
const store = (page, path) =>
	page.evaluate((p) => {
		let s = window.__stores;
		for (const k of p.split('.')) s = s[k];
		let v;
		s.subscribe((x) => (v = x))();
		return v;
	}, path);

/** @param {any} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const send = (type, x, y) =>
		cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4 }] });
	const tap = async (x, y) => {
		await send('touchStart', x, y);
		await new Promise((r) => setTimeout(r, 60));
		await send('touchEnd', x, y);
	};
	return { send, tap };
}

/** tap an element's centre with a finger @param {any} page @param {any} touch @param {string} sel */
async function tapEl(page, touch, sel) {
	const r = await page.evaluate((s) => {
		const e = document.querySelector(s);
		if (!e) return null;
		const b = e.getBoundingClientRect();
		return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	}, sel);
	if (!r) return false;
	await touch.tap(r.x, r.y);
	await page.waitForTimeout(350);
	return true;
}

/** put the editor camera at `pos` looking at `target` @param {any} page */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__stores.editorCam.subscribe((v) => (cam = v))();
			window.__stores.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			if (orbit?.target) {
				orbit.target.set(t[0], t[1], t[2]);
				orbit.update?.();
			}
			cam.lookAt(t[0], t[1], t[2]);
			cam.updateMatrixWorld(true);
		},
		[pos, target]
	);
	await page.waitForTimeout(250);
}

/** make a box through the replicated create, placed at `at` @returns {Promise<string>} */
const make = (page, at, size = 1) =>
	page.evaluate(
		([p, s]) => {
			const st = window.__stores;
			st.commandsHandler.sceneCommand(`/create Box ${s} ${s} ${s}`);
			let g;
			st.objectsGroup.subscribe((v) => (g = v))();
			const o = g.children[g.children.length - 1];
			o.position.set(p[0], p[1], p[2]);
			o.updateMatrixWorld(true);
			return o.uuid;
		},
		[at, size]
	);

/** where a world point (or an object's centre + a pixel offset) is on screen, and what the app's pick hits there */
const screenOf = (page, uuid, dx = 0, dy = 0) =>
	page.evaluate(
		([u, ox, oy]) => {
			const s = window.__stores;
			const THREE = s.THREE;
			let g, cam, r;
			s.objectsGroup.subscribe((v) => (g = v))();
			s.globalCamera.subscribe((v) => (cam = v))();
			s.globalRenderer.subscribe((v) => (r = v))();
			const o = g.getObjectByProperty('uuid', u);
			if (!o) return null;
			o.updateWorldMatrix(true, true);
			const c = o.getWorldPosition(new THREE.Vector3());
			const rect = r.domElement.getBoundingClientRect();
			const v = c.clone().project(cam);
			const x = rect.left + ((v.x + 1) / 2) * rect.width;
			const y = rect.top + ((1 - v.y) / 2) * rect.height;
			const px = x + ox;
			const py = y + oy;
			const ndc = new THREE.Vector2(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1);
			const ray = new THREE.Raycaster();
			ray.setFromCamera(ndc, cam);
			const hit = s.scenePick.sceneHits(ray)[0];
			let top = hit?.object;
			while (top && top.parent && top.parent !== g) top = top.parent;
			const under = document.elementFromPoint(px, py);
			const local = hit ? o.worldToLocal(hit.point.clone()).toArray() : null;
			return { cx: x, cy: y, x: px, y: py, hits: top?.uuid === u, onCanvas: under === r.domElement, pos: o.position.toArray(), local };
		},
		[uuid, dx, dy]
	);

/** where a point fixed on the object (its own frame) is on screen now */
const screenOfLocal = (page, uuid, local) =>
	page.evaluate(
		([u, l]) => {
			const s = window.__stores;
			const THREE = s.THREE;
			let g, cam, r;
			s.objectsGroup.subscribe((v) => (g = v))();
			s.globalCamera.subscribe((v) => (cam = v))();
			s.globalRenderer.subscribe((v) => (r = v))();
			const o = g.getObjectByProperty('uuid', u);
			o.updateWorldMatrix(true, true);
			const v = o.localToWorld(new THREE.Vector3(l[0], l[1], l[2])).project(cam);
			const rect = r.domElement.getBoundingClientRect();
			return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
		},
		[uuid, local]
	);

const sel = (page) => store(page, 'selectedObjects');
const strip = (page) =>
	page.evaluate(() => {
		const s = document.getElementById('ps-strip');
		if (!s) return null;
		const b = s.getBoundingClientRect();
		const cells = [...s.querySelectorAll('button')].map((e) => {
			const r = e.getBoundingClientRect();
			return { id: e.id, l: Math.round(r.left), r: Math.round(r.right), pressed: e.getAttribute('aria-pressed'), disabled: e.disabled, text: e.textContent.trim() };
		});
		return { visible: b.width > 0 && getComputedStyle(s).display !== 'none', overflow: s.scrollWidth - s.clientWidth, cells };
	});
const cell = (st, id) => st?.cells.find((c) => c.id === id) ?? null;

/** close everything a section may have left open */
async function rest(page) {
	await page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.setEditorMode('edit');
		s.multiSelectMode.set(false);
		s.objectActions.deselectObject();
		s.inspectorClose.set(true);
		s.phoneShell?.phoneSheet?.set(null);
		s.objectListClose.set(true);
		s.toastStore.set([]);
	});
	await page.waitForTimeout(700); // past the double-tap and the select-behind window
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// =============================================================== the folded N6
	console.log('\n=== N6 folded 390x896 (touch) ===');
	const A = await h.setupPage(browser, 'folded', { context: N6_FOLDED, storage: STORAGE });
	const P = A.page;
	const touch = await touchApi(P);
	h.check(await P.evaluate(() => document.documentElement.classList.contains('phone-shell')), '(premise) the phone shell is mounted');
	await look(P, [0, 3, 6], [0, 0.5, 0]);

	// ---- G2 ----
	await rest(P);
	const g2closed = await P.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [-1.2, 0.5, 0])?.uuid);
	await P.waitForTimeout(500);
	h.check((await store(P, 'inspectorClose')) === true, 'G2 adding a primitive with the Inspector closed does NOT open it');
	h.check((await sel(P)).includes(g2closed), 'G2 ...the new object is selected');
	await P.evaluate(() => window.__stores.showSidebar('scene'));
	await P.waitForTimeout(400);
	const g2open = await P.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [1.2, 0.5, 0])?.uuid);
	await P.waitForTimeout(500);
	h.check(
		(await store(P, 'inspectorClose')) === false && (await store(P, 'inspectorKind')) === 'selection',
		'G2 an Inspector that is already open follows the new object'
	);
	h.check((await sel(P)).includes(g2open), 'G2 ...which is selected');
	const boxA = g2closed;
	const boxB = g2open;
	// a folded phone is narrow: bring both boxes into its view
	await P.evaluate(([a, b]) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', a).position.set(-0.75, 0.5, 0);
		g.getObjectByProperty('uuid', b).position.set(0.75, 0.5, 0);
	}, [boxA, boxB]);
	await look(P, [0, 3, 7], [0, 0.5, 0]);

	// ---- G11 ----
	await rest(P);
	await P.evaluate((u) => window.__stores.objectActions.selectObject(u), boxA);
	await P.waitForTimeout(400);
	let st = await strip(P);
	const order = (st?.cells ?? []).map((c) => c.id).join(',');
	h.check(
		order === 'ps-move,ps-rotate,ps-scale,ps-multiselect,ps-interact,ps-inspect,ps-undo,ps-redo',
		`G11 the strip: Move Rotate Scale, then Multi-select + Interact, then Inspect, Undo, Redo (${order})`
	);
	h.check(!!st && st.overflow <= 1 && st.cells.every((c) => c.l >= 0 && c.r <= 390), `G11 every cell fits 390 px, nothing scrolled away (${JSON.stringify(st?.cells.map((c) => [c.id, c.l, c.r]))})`);
	h.check(cell(st, 'ps-inspect')?.text === '', `G11 Inspect is icon-only ("${cell(st, 'ps-inspect')?.text}")`);
	h.check(cell(st, 'ps-inspect')?.pressed === 'false', `G11 Inspect is NOT pressed while the Inspector is closed (${cell(st, 'ps-inspect')?.pressed})`);
	await tapEl(P, touch, '#ps-inspect');
	await P.waitForTimeout(300);
	st = await strip(P);
	h.check(
		(await store(P, 'inspectorClose')) === false && cell(st, 'ps-inspect')?.pressed === 'true',
		`G11 a tap opens the Inspector and Inspect shows pressed (${cell(st, 'ps-inspect')?.pressed})`
	);
	await tapEl(P, touch, '#ps-inspect');
	await P.waitForTimeout(300);
	st = await strip(P);
	h.check(
		(await store(P, 'inspectorClose')) === true && cell(st, 'ps-inspect')?.pressed === 'false',
		`G11 a second tap CLOSES it and Inspect is unpressed again (${cell(st, 'ps-inspect')?.pressed})`
	);
	h.check(cell(st, 'ps-multiselect')?.pressed === 'false', 'G11 Multi-select shows off');
	await tapEl(P, touch, '#ps-multiselect');
	st = await strip(P);
	h.check((await store(P, 'multiSelectMode')) === true && cell(st, 'ps-multiselect')?.pressed === 'true', 'G11 Multi-select toggles on (pressed)');
	await tapEl(P, touch, '#ps-multiselect');
	st = await strip(P);
	h.check((await store(P, 'multiSelectMode')) === false && cell(st, 'ps-multiselect')?.pressed === 'false', 'G11 ...and off (unpressed)');

	// ---- G13 ----
	h.check(cell(st, 'ps-interact')?.pressed === 'false', 'G13 Interact shows off');
	await tapEl(P, touch, '#ps-interact');
	st = await strip(P);
	h.check((await store(P, 'editorMode')) === 'interact', 'G13 the strip turns Interact on');
	h.check((await sel(P)).length === 0, `G13 Interact deselects everything (${(await sel(P)).length})`);
	h.check(!!st?.visible && cell(st, 'ps-interact')?.pressed === 'true', 'G13 ...and the strip STAYS, Interact pressed, so it can be turned off');
	h.check(cell(st, 'ps-move')?.disabled === true && cell(st, 'ps-inspect')?.disabled === true, 'G13 with nothing selected Move and Inspect are disabled');
	await tapEl(P, touch, '#ps-interact');
	h.check((await store(P, 'editorMode')) === 'edit', 'G13 the strip turns Interact off');
	h.check(JSON.stringify(await sel(P)) === JSON.stringify([boxA]), `G13 ...and the selection comes back (${JSON.stringify(await sel(P))})`);
	await P.evaluate(([a, b]) => window.__stores.objectActions.applySelectionSet([a, b]), [boxA, boxB]);
	await P.waitForTimeout(300);
	await tapEl(P, touch, '#ps-interact');
	const doomed = await make(P, [0, 0.5, -3]);
	await P.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await P.evaluate(([a, b]) => window.__stores.objectActions.applySelectionSet([a, b]), [boxA, doomed]);
	await P.waitForTimeout(300);
	await tapEl(P, touch, '#ps-interact');
	await P.evaluate((u) => window.__stores.objectActions.deleteObjectsByUuid([u]), doomed);
	await P.waitForTimeout(300);
	await tapEl(P, touch, '#ps-interact');
	h.check(JSON.stringify(await sel(P)) === JSON.stringify([boxA]), `G13 an object deleted during Interact is dropped from the restore (${JSON.stringify(await sel(P))})`);

	// ---- G14 ----
	await rest(P);
	let at = await screenOf(P, boxA);
	h.check(!!at?.hits && at.onCanvas, `(premise) the finger lands on box A (${JSON.stringify(at)})`);
	await touch.tap(at.x, at.y);
	await P.waitForTimeout(700);
	h.check(JSON.stringify(await sel(P)) === JSON.stringify([boxA]), 'G14 a tap selects box A');
	await touch.tap(at.x, at.y);
	await P.waitForTimeout(700);
	h.check((await sel(P)).length === 0, `G14 a tap on the SELECTED box deselects it (${JSON.stringify(await sel(P))})`);
	await touch.tap(at.x, at.y);
	await P.waitForTimeout(700);
	h.check(JSON.stringify(await sel(P)) === JSON.stringify([boxA]), 'G14 ...and a third tap selects it again');
	await rest(P);
	await P.evaluate(() => window.__stores.multiSelectMode.set(true));
	await P.waitForTimeout(200);
	const atB = await screenOf(P, boxB);
	at = await screenOf(P, boxA);
	await touch.tap(at.x, at.y);
	await P.waitForTimeout(700);
	await touch.tap(atB.x, atB.y);
	await P.waitForTimeout(700);
	h.check(JSON.stringify([...(await sel(P))].sort()) === JSON.stringify([boxA, boxB].sort()), `G14 Multi-select: taps ADD (${JSON.stringify(await sel(P))})`);
	await touch.tap(at.x, at.y);
	await P.waitForTimeout(700);
	h.check(JSON.stringify(await sel(P)) === JSON.stringify([boxB]), `G14 Multi-select: a tap on a member takes it OUT (${JSON.stringify(await sel(P))})`);
	await rest(P);

	// ---- G4 (touch) ----
	console.log('\n=== G4: Interact + physics, carried by a finger ===');
	await P.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	await P.waitForTimeout(2500);
	// a large crate, near: the finger takes it well off its centre
	const crate = await make(P, [0, 0.6, 0], 1.2);
	await P.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		// light, so the carry spring is at its stiffest (k 20/s) and a flick can really fling it
		o.userData.physics = { mode: 'dynamic', mass: 0.25 };
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 } });
		// the other boxes off to the side, out of the way
		for (const c of g.children) if (c.uuid !== u) c.position.x += c.position.x < 0 ? -4 : 4;
	}, crate);
	await P.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => P.evaluate(() => window.__stores.physics.physicsDebug().length), (n) => n > 0, '(premise) the simulation runs');
	await P.waitForTimeout(1200);
	await P.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));

	/** carry with a finger: take it at (dx, dy) px from its centre, move the finger by (mx, my) in `steps`, hold, then let go */
	async function fingerCarry(uuid, dx, dy, mx, my, { steps = 16, stepMs = 25, holdMs = 600, flick = false } = {}) {
		const t0 = await screenOf(P, uuid, dx, dy);
		const cam0 = (await store(P, 'globalCamera')) ? await P.evaluate(() => { let c; window.__stores.globalCamera.subscribe((v) => (c = v))(); return c.position.toArray(); }) : null;
		await touch.send('touchStart', t0.x, t0.y);
		await P.waitForTimeout(250);
		const taken = await P.evaluate(() => window.__stores.playInteract.playInteractDebug().carrying);
		const t1 = await screenOf(P, uuid);
		const grip0 = t0.local ? await screenOfLocal(P, uuid, t0.local) : null;
		for (let i = 1; i <= steps; i++) {
			await touch.send('touchMove', t0.x + (mx * i) / steps, t0.y + (my * i) / steps);
			await P.waitForTimeout(stepMs);
		}
		// a flick lets go the moment the finger stops (reading the screen first would let the carry settle)
		if (flick) await touch.send('touchEnd', 0, 0);
		else await P.waitForTimeout(holdMs);
		const vFlick = flick ? await P.evaluate((u) => window.__stores.physics.bodyVelocityOf(u), uuid) : null;
		const t2 = await screenOf(P, uuid);
		const grip2 = t0.local ? await screenOfLocal(P, uuid, t0.local) : null;
		if (!flick) await touch.send('touchEnd', 0, 0);
		const v = vFlick ?? (await P.evaluate((u) => window.__stores.physics.bodyVelocityOf(u), uuid));
		await P.waitForTimeout(80);
		const v2 = await P.evaluate((u) => window.__stores.physics.bodyVelocityOf(u), uuid);
		const cam1 = await P.evaluate(() => { let c; window.__stores.globalCamera.subscribe((v) => (c = v))(); return c.position.toArray(); });
		const camMoved = cam0 ? Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) : 0;
		const speed = (x) => (x ? Math.hypot(...x.linvel) : null);
		return {
			hit: t0.hits,
			taken: taken === uuid,
			jump: Math.hypot(t1.cx - t0.cx, t1.cy - t0.cy), // the centre's screen move at the grab, before the finger moved
			// the point the finger took stays under the finger (the centre, deeper on a near object, moves less)
			track: grip0 && grip2 ? Math.hypot(grip2.x - (t0.x + mx), grip2.y - (t0.y + my)) : 999,
			grip0: grip0 ? Math.hypot(grip0.x - t0.x, grip0.y - t0.y) : 999,
			moved: Math.hypot(t2.cx - t0.cx, t2.cy - t0.cy),
			speed: speed(v) ?? 0, // the release velocity itself (gravity adds to it a moment later)
			speedLater: speed(v2) ?? 0,
			camMoved,
			world: [t0.pos, t2.pos]
		};
	}

	// NEAR: the crate fills a good part of the view; take it 40 px right of / 30 px below its centre
	await look(P, [0, 1.6, 2.6], [0, 0.6, 0]);
	let c = await fingerCarry(crate, 40, 30, 70, -110);
	h.check(c.hit && c.taken, `G4 (near) a finger on the crate takes it (${JSON.stringify({ hit: c.hit, taken: c.taken })})`);
	h.check(c.jump < 8, `G4 (near) taking it does not jump it — its centre stays put on screen (${c.jump.toFixed(1)} px)`);
	h.check(c.grip0 < 3, `(premise) the tracked grip point is where the finger landed (${c.grip0.toFixed(1)} px)`);
	h.check(c.track < 14, `G4 (near) it follows the finger RELATIVE to where it was taken (off by ${c.track.toFixed(1)} px of a ${Math.hypot(70, 110).toFixed(0)} px move)`);
	h.check(c.camMoved < 0.02, `G4 (near) the carry does not orbit the camera (${c.camMoved.toFixed(3)} m)`);
	h.check(c.speed < 0.5, `G4 (near) a held-then-released crate is put down, not thrown (${c.speed.toFixed(2)} m/s at release)`);
	await P.waitForTimeout(1500);

	// FAR: 10 m away — it used to be pulled in to 6 m
	await P.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		window.__stores.physics.setBodyVelocity?.(u, [0, 0, 0], [0, 0, 0]);
		return o.position.toArray();
	}, crate);
	const crateAt = (await screenOf(P, crate)).pos;
	await look(P, [crateAt[0], 3, crateAt[2] + 10], [crateAt[0], 0.6, crateAt[2]]);
	const dist0 = await P.evaluate((u) => {
		let g, cam;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		return cam.position.distanceTo(g.getObjectByProperty('uuid', u).position);
	}, crate);
	c = await fingerCarry(crate, 6, 4, -60, -50);
	const dist1 = await P.evaluate((u) => {
		let g, cam;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		return cam.position.distanceTo(g.getObjectByProperty('uuid', u).position);
	}, crate);
	h.check(c.hit && c.taken, 'G4 (far) the finger takes the crate 10 m away');
	h.check(c.jump < 8 && Math.abs(dist1 - dist0) < 0.6, `G4 (far) it stays at its distance (${dist0.toFixed(2)} -> ${dist1.toFixed(2)} m, jump ${c.jump.toFixed(1)} px)`);
	h.check(c.track < 14, `G4 (far) and follows the finger (off by ${c.track.toFixed(1)} px)`);
	await P.waitForTimeout(1500);

	// a FLICK: released mid-move, the throw is bounded
	const crateAt2 = (await screenOf(P, crate)).pos;
	await look(P, [crateAt2[0], 1.6, crateAt2[2] + 2.6], [crateAt2[0], 0.6, crateAt2[2]]);
	c = await fingerCarry(crate, 10, 10, 60, -380, { steps: 3, stepMs: 16, flick: true });
	h.check(c.taken, 'G4 (flick) taken');
	h.check(c.speed > 0.3 && c.speed <= 8.05, `G4 (flick) letting go mid-move THROWS, bounded to 8 m/s (${c.speed.toFixed(2)} m/s at release)`);
	await P.evaluate(() => window.__stores.physics.stopSimulation());
	await P.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await A.ctx.close();

	// =============================================================== the unfolded N6
	console.log('\n=== N6 unfolded 770x850 (touch) ===');
	const U = await h.setupPage(browser, 'unfolded', { context: N6_UNFOLDED, storage: STORAGE });
	const Q = U.page;
	const touchU = await touchApi(Q);
	await look(Q, [0, 3, 6], [0, 0.5, 0]);
	const ua = await make(Q, [-1.2, 0.5, 0]);
	await rest(Q);
	at = await screenOf(Q, ua);
	h.check(!!at?.hits && at.onCanvas, '(premise) the finger lands on the box (unfolded)');
	await touchU.tap(at.x, at.y);
	await Q.waitForTimeout(700);
	h.check(JSON.stringify(await sel(Q)) === JSON.stringify([ua]), 'G14 (unfolded) a tap selects');
	await touchU.tap(at.x, at.y);
	await Q.waitForTimeout(700);
	h.check((await sel(Q)).length === 0, `G14 (unfolded) a tap on the selected box deselects it (${JSON.stringify(await sel(Q))})`);
	await touchU.tap(at.x, at.y);
	await Q.waitForTimeout(700);
	const modeCell = '#editor-mode-toggle';
	h.check(await tapEl(Q, touchU, modeCell), '(premise) the Interact cell is on the bar (unfolded)');
	h.check((await store(Q, 'editorMode')) === 'interact' && (await sel(Q)).length === 0, 'G13 (unfolded) Interact deselects');
	await tapEl(Q, touchU, modeCell);
	h.check(JSON.stringify(await sel(Q)) === JSON.stringify([ua]), `G13 (unfolded) and Edit restores (${JSON.stringify(await sel(Q))})`);
	await U.ctx.close();

	// =============================================================== desktop
	console.log('\n=== desktop 1440x900 (mouse) ===');
	const D = await h.setupPage(browser, 'desktop', { context: DESKTOP });
	const M = D.page;
	await look(M, [0, 3, 6], [0, 0.5, 0]);
	await rest(M);
	const da = await M.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [-1.2, 0.5, 0])?.uuid);
	await M.waitForTimeout(500);
	h.check((await store(M, 'inspectorClose')) === true && (await sel(M)).includes(da), 'G2 (desktop) adding selects and leaves the Inspector closed');
	await rest(M);
	at = await screenOf(M, da);
	await M.mouse.click(at.x, at.y);
	await M.waitForTimeout(700);
	await M.mouse.click(at.x, at.y);
	await M.waitForTimeout(700);
	h.check(JSON.stringify(await sel(M)) === JSON.stringify([da]), `G14 (desktop) a MOUSE click on the selected box keeps it selected (${JSON.stringify(await sel(M))})`);
	await M.click(modeCell);
	await M.waitForTimeout(300);
	h.check((await store(M, 'editorMode')) === 'interact' && (await sel(M)).length === 0, 'G13 (desktop) the Interact cell deselects');
	await M.click(modeCell);
	await M.waitForTimeout(300);
	h.check(JSON.stringify(await sel(M)) === JSON.stringify([da]), 'G13 (desktop) and Edit restores the selection');

	// G4 with the mouse: the same grab-point carry
	await M.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	await M.waitForTimeout(2500);
	const mc = await make(M, [1.2, 0.6, 0], 1.2);
	await M.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', u).userData.physics = { mode: 'dynamic', mass: 1 };
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 } });
		s.objectActions.deselectObject();
	}, mc);
	await M.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => M.evaluate(() => window.__stores.physics.physicsDebug().length), (n) => n > 0, '(premise) the desktop simulation runs');
	await M.waitForTimeout(1200);
	await M.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await look(M, [1.2, 1.6, 2.8], [1.2, 0.6, 0]);
	const m0 = await screenOf(M, mc, 60, 40);
	await M.mouse.move(m0.x, m0.y);
	await M.mouse.down();
	await M.waitForTimeout(250);
	const mTaken = await M.evaluate(() => window.__stores.playInteract.playInteractDebug().carrying);
	const m1 = await screenOf(M, mc);
	const mg0 = await screenOfLocal(M, mc, m0.local);
	for (let i = 1; i <= 16; i++) {
		await M.mouse.move(m0.x - (120 * i) / 16, m0.y - (90 * i) / 16);
		await M.waitForTimeout(25);
	}
	await M.waitForTimeout(600);
	const mg2 = await screenOfLocal(M, mc, m0.local);
	await M.mouse.up();
	h.check(mTaken === mc, 'G4 (mouse) a press on the crate takes it');
	h.check(Math.hypot(m1.cx - m0.cx, m1.cy - m0.cy) < 8, `G4 (mouse) no jump at the grab (${Math.hypot(m1.cx - m0.cx, m1.cy - m0.cy).toFixed(1)} px)`);
	h.check(Math.hypot(mg0.x - m0.x, mg0.y - m0.y) < 3, '(premise) the tracked grip point is under the cursor');
	const mTrack = Math.hypot(mg2.x - (m0.x - 120), mg2.y - (m0.y - 90));
	h.check(mTrack < 14, `G4 (mouse) it follows the cursor from where it was taken (off by ${mTrack.toFixed(1)} px)`);
	await M.evaluate(() => window.__stores.physics.stopSimulation());
	await D.ctx.close();

	await h.finish(browser);
});
