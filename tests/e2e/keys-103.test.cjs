// 103-keys: keymap presets, start-at-once Move / Rotate / Resize (viewport), Fly with WASD,
// Fly direction, and the object list taking the keyboard. Two peers for the modal move.
//   1  presets: ThePrototype = today's keys; Blender / Unity bindings; no new collisions; a user's
//      own rebind wins and makes a colliding preset key stand down
//   2  nothing changes with no setting touched: G still picks Move, no gesture starts
//   3  Blender preset: G X 2 Enter, typed; G + pointer + X lock; Esc and right-click cancel; one
//      undo step; R Z 90; Alt+S 2; Alt+S X 2; the on-screen line
//   4  a second peer sees the committed pose (the gizmo's `move`)
//   5  Fly direction: Level keeps height, Where I look climbs/sinks; Fly with WASD = right button
//   6  the object list takes the keyboard when it opens (O) and when it is brought to front
const h = require('./helpers.cjs');

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

/** @param {any} page */
async function pose(page, uuid) {
	return page.evaluate((u) => {
		const g = window.__tp.test.v1.objectsGroup;
		let group;
		g.subscribe((x) => (group = x))();
		const o = group.getObjectByProperty('uuid', u);
		return o ? { pos: o.position.toArray(), rot: o.rotation.toArray().slice(0, 3), scale: o.scale.toArray() } : null;
	}, uuid);
}

/** the canvas centre in client px @param {any} page */
async function canvasCentre(page) {
	return page.evaluate(() => {
		const c = document.querySelector('canvas');
		const r = c.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
}

/** press a start-at-once key and wait until its gesture is running (the engine is a lazy chunk)
 * @param {any} page @param {string} key */
async function startNow(page, key) {
	await page.keyboard.press(key);
	await page.waitForFunction(() => !!document.querySelector('#modal-transform-line'), null, { timeout: 8000 }).catch(() => {});
}

const lineState = (page) =>
	page.evaluate(() => {
		const el = document.querySelector('#modal-transform-line');
		return el ? { mode: el.dataset.mode, locks: el.dataset.locks, text: el.textContent } : null;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	// ---- 1. presets ---------------------------------------------------------------------------
	// the default preset never loads the preset tables (the boot rule); after this the switch is sync
	const lazyAtBoot = await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /keymapPresets/.test(e.name)));
	h.check(!lazyAtBoot, `1.0 the default keymap never fetches the preset tables at boot`);
	await page.evaluate(() => window.__tp.test.v1.shortcutsRegistry.loadKeymapPresets().then(() => true));
	const presets = await page.evaluate(() => {
		const r = window.__tp.test.v1.shortcutsRegistry;
		const fly = window.__tp.test.v1.flyPrefs;
		const key = (id) => r.bindingOf(id);
		/** colliding pairs, the registry's own scope rule */
		const collisions = () => {
			const rows = r.shortcuts.filter((s) => r.isRebindable(s) && s.keys);
			const out = [];
			for (let i = 0; i < rows.length; i++)
				for (let j = i + 1; j < rows.length; j++) {
					const a = rows[i];
					const b = rows[j];
					if (a.keys !== b.keys) continue;
					const sa = a.scope || 'global';
					const sb = b.scope || 'global';
					const hit = sa === sb || (!a.external && !b.external && (sa === 'global' || sb === 'global'));
					if (hit) out.push(a.id + '|' + b.id);
				}
			return out.sort();
		};
		const out = { base: {}, blender: {}, blenderRmb: {}, unity: {}, unityRmb: {} };
		out.premise = { preset: r.shortcuts && localStorage.getItem('keymapPreset'), fly: localStorage.getItem('flyWithWasd') };
		const ids = ['transform.move', 'transform.grab', 'transform.now-move', 'transform.now-rotate', 'transform.now-scale', 'transform.lock-x', 'panels.shader-editor', 'uv.now-scale', 'uv.grab', 'movement.fly-direction'];
		const snap = (bucket) => {
			for (const id of ids) bucket[id] = key(id);
			bucket.collisions = collisions();
		};
		snap(out.base);
		r.setKeymapPreset('blender');
		snap(out.blender);
		fly.flyWithWasd.set('rmb');
		snap(out.blenderRmb);
		r.setKeymapPreset('unity');
		snap(out.unityRmb);
		fly.flyWithWasd.set('always');
		snap(out.unity);
		// a user's rebind wins, and a preset key that lands on it stands down
		r.setKeymapPreset('theprototype');
		r.setOverride('transform.scale', 'R');
		r.setKeymapPreset('blender');
		out.standDown = { scale: key('transform.scale'), rotateNow: key('transform.now-rotate') };
		r.resetShortcut('transform.scale');
		out.afterReset = key('transform.now-rotate');
		r.setKeymapPreset('theprototype');
		out.stored = localStorage.getItem('keymapPreset');
		return out;
	});
	const b = presets.base;
	h.check(b['transform.move'] === '1' && b['transform.grab'] === 'G' && b['transform.now-move'] === '' && b['transform.lock-x'] === '' && b['movement.fly-direction'] === '', `1.1 ThePrototype = today's keys: 1 / G, the new rows unbound (${JSON.stringify(b)})`);
	const bl = presets.blender;
	h.check(bl['transform.now-move'] === 'G' && bl['transform.grab'] === '' && bl['transform.now-rotate'] === 'R' && bl['transform.now-scale'] === 'Alt+S' && bl['panels.shader-editor'] === 'Alt+Shift+S' && bl['transform.lock-x'] === 'X' && bl['transform.move'] === '1', `1.2 Blender: G / R / Alt+S, X lock, shader editor -> Alt+Shift+S, 1 stays (${JSON.stringify(bl)})`);
	h.check(presets.blenderRmb['transform.now-scale'] === 'S' && presets.blenderRmb['panels.shader-editor'] === 'Alt+S' && bl['uv.now-scale'] === 'S' && bl['uv.grab'] === '', `1.3 Blender + right-button fly: bare S resizes, Alt+S is the shader editor again; UV S (${presets.blenderRmb['transform.now-scale']})`);
	h.check(presets.unityRmb['transform.move'] === 'W' && presets.unity['transform.move'] === '1', `1.4 Unity: W / E / R only once the fly keys wait for the right button (${presets.unityRmb['transform.move']} / ${presets.unity['transform.move']})`);
	const base = JSON.stringify(b.collisions);
	const extra = ['blender', 'blenderRmb', 'unity', 'unityRmb'].map((k) => presets[k].collisions.filter((c) => !b.collisions.includes(c)));
	h.check(extra.every((e) => e.length === 0), `1.5 no preset adds a key collision (base ${base}; new ${JSON.stringify(extra)})`);
	h.check(presets.standDown.scale === 'R' && presets.standDown.rotateNow === '' && presets.afterReset === 'R', `1.6 a user's rebind wins over the preset; the preset key stands down, and returns on reset (${JSON.stringify(presets.standDown)} -> ${presets.afterReset})`);
	h.check(presets.stored === null, `1.7 the default preset stores nothing (${presets.stored})`);

	// a box to move, selected, the viewport holding the keys
	await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1500);
	const c = await canvasCentre(page);
	await page.mouse.click(c.x + 300, c.y + 250); // the viewport takes the keyboard (empty ground)
	await page.waitForTimeout(300);
	const boxId = await page.evaluate(async () => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		const b = g.children.find((o) => o.name === 'Box') ?? g.children[0];
		window.__tp.test.v1.objectActions.selectObject(b.uuid);
		return b.uuid;
	});
	await page.waitForTimeout(400);
	const start = await pose(page, boxId);
	/** the selection is the premise of every gesture below: set it again and say so */
	const selectBox = async (label) => {
		await page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), boxId);
		await page.waitForTimeout(250);
		const n = await page.evaluate(() => new Promise((r) => window.__tp.test.v1.selectedObjects.subscribe((x) => r(x.length))()));
		h.check(n === 1, `${label} premise: the box is selected (${n})`);
	};
	await selectBox('2.0');

	// ---- 2. nothing changes with no setting touched ------------------------------------------
	await page.mouse.move(c.x, c.y);
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(300);
	await page.mouse.move(c.x + 120, c.y + 40);
	await page.waitForTimeout(300);
	const p2 = await pose(page, boxId);
	const mode2 = await page.evaluate(() => new Promise((r) => window.__tp.test.v1.transformMode.subscribe(r)()));
	h.check(JSON.stringify(p2) === JSON.stringify(start) && !(await lineState(page)) && mode2 === 'translate', `2.1 default keys: G picks Move and starts nothing (${mode2}, moved: ${JSON.stringify(p2) !== JSON.stringify(start)})`);

	// ---- 3. Blender preset, the gesture -------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.shortcutsRegistry.setKeymapPreset('blender'));
	await selectBox('3.0');

	// 3.1 typed: G X 2 Enter
	await startNow(page, 'KeyG');
	const l1 = await lineState(page);
	await page.keyboard.press('KeyX');
	await page.keyboard.press('Digit2');
	const l2 = await lineState(page);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	const p31 = await pose(page, boxId);
	h.check(l1?.mode === 'translate' && l2?.locks === 'x' && /2/.test(l2?.text ?? ''), `3.1 G opens the line (Move), X locks, the typed 2 shows (${JSON.stringify(l2)})`);
	h.check(near(p31.pos[0], start.pos[0] + 2) && near(p31.pos[1], start.pos[1]) && near(p31.pos[2], start.pos[2]) && !(await lineState(page)), `3.2 G X 2 Enter moves exactly 2 m along X (${p31.pos.map((n) => n.toFixed(3))})`);

	// 3.3 one undo step
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await page.waitForTimeout(300);
	const p33 = await pose(page, boxId);
	h.check(near(p33.pos[0], start.pos[0]), `3.3 one Ctrl+Z puts it back (${p33.pos[0].toFixed(3)})`);

	// 3.4 the pointer + an axis lock
	await page.mouse.move(c.x, c.y);
	await startNow(page, 'KeyG');
	await page.keyboard.press('KeyX');
	await page.mouse.move(c.x + 60, c.y + 30, { steps: 4 });
	await page.mouse.move(c.x + 160, c.y + 60, { steps: 6 });
	await page.waitForTimeout(200);
	const live = await pose(page, boxId);
	await page.mouse.click(c.x + 160, c.y + 60); // a click keeps it
	await page.waitForTimeout(300);
	const p34 = await pose(page, boxId);
	h.check(Math.abs(live.pos[0] - start.pos[0]) > 0.05 && near(live.pos[1], start.pos[1]) && near(live.pos[2], start.pos[2]), `3.4 the selection follows the pointer, X only (dx ${(live.pos[0] - start.pos[0]).toFixed(3)}, dy ${(live.pos[1] - start.pos[1]).toFixed(4)}, dz ${(live.pos[2] - start.pos[2]).toFixed(4)})`);
	h.check(near(p34.pos[0], live.pos[0], 0.05) && !(await lineState(page)), `3.5 a left click keeps it (${p34.pos[0].toFixed(3)})`);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await page.waitForTimeout(300);
	await selectBox('3.6');

	// 3.6 Esc cancels, 3.7 right-click cancels and opens no menu
	await startNow(page, 'KeyG');
	await page.mouse.move(c.x + 200, c.y + 100, { steps: 5 });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	const p36 = await pose(page, boxId);
	h.check(JSON.stringify(p36.pos.map((n) => n.toFixed(4))) === JSON.stringify(start.pos.map((n) => n.toFixed(4))), `3.6 Esc puts it back (${p36.pos.map((n) => n.toFixed(3))})`);
	await page.mouse.move(c.x, c.y);
	await startNow(page, 'KeyG');
	await page.mouse.move(c.x - 150, c.y + 80, { steps: 5 });
	await page.mouse.click(c.x - 150, c.y + 80, { button: 'right' });
	await page.waitForTimeout(400);
	const p37 = await pose(page, boxId);
	const menuOpen = await page.evaluate(() => {
		let m;
		window.__tp.test.v1.viewportMenu.subscribe((x) => (m = x))();
		let o;
		window.__tp.test.v1.objectContextMenu.subscribe((x) => (o = x))();
		return !!m || !!o;
	});
	h.check(near(p37.pos[0], start.pos[0]) && near(p37.pos[2], start.pos[2]) && !menuOpen, `3.7 a right click cancels and opens no menu (menu: ${menuOpen})`);

	// 3.8 R Z 90 Enter, 3.9 Alt+S 2 Enter, 3.10 Alt+S X 2 Enter
	await selectBox('3.8');
	await startNow(page, 'KeyR');
	await page.keyboard.press('KeyZ');
	await page.keyboard.type('90');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	const p38 = await pose(page, boxId);
	h.check(near(Math.abs(p38.rot[2]), Math.PI / 2, 1e-3) && near(p38.rot[0], 0) && near(p38.rot[1], 0), `3.8 R Z 90 turns it a quarter about Z (${p38.rot.map((n) => n.toFixed(3))})`);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await page.waitForTimeout(200);
	await startNow(page, 'Alt+KeyS');
	await page.keyboard.press('Digit2');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	const p39 = await pose(page, boxId);
	h.check(p39.scale.every((n, i) => near(n, start.scale[i] * 2)), `3.9 Alt+S 2 doubles the size (${p39.scale.map((n) => n.toFixed(3))})`);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await page.waitForTimeout(200);
	await startNow(page, 'Alt+KeyS');
	await page.keyboard.press('KeyX');
	await page.keyboard.press('Digit3');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	const p310 = await pose(page, boxId);
	h.check(near(p310.scale[0], start.scale[0] * 3) && near(p310.scale[1], start.scale[1]) && near(p310.scale[2], start.scale[2]), `3.10 Alt+S X 3 stretches X alone (${p310.scale.map((n) => n.toFixed(3))})`);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await page.waitForTimeout(200);
	const p311 = await pose(page, boxId);
	h.check(p311.scale.every((n, i) => near(n, start.scale[i])) && near(p311.rot[2], start.rot[2]), `3.11 every gesture was ONE undo step (back to the start: ${p311.scale.map((n) => n.toFixed(2))})`);

	// ---- 4. a second peer sees the result ----------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await B.page.waitForTimeout(2500);
	await page.mouse.click(c.x + 300, c.y + 250);
	await selectBox('4.0');
	await startNow(page, 'KeyG');
	await page.keyboard.press('KeyY');
	await page.keyboard.type('1.5');
	await page.keyboard.press('Enter');
	const onA = await pose(page, boxId);
	h.check(near(onA.pos[1], start.pos[1] + 1.5), `4.1 A: G Y 1.5 Enter lifts it 1.5 m (${onA.pos[1].toFixed(3)})`);
	await h.eventually(() => pose(B.page, boxId), (p) => !!p && near(p.pos[1], onA.pos[1], 1e-3), `4.2 peer B sees the committed pose (the gizmo's move message)`, 15000);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.closePeer(B);

	// ---- 5. fly direction + fly with WASD ----------------------------------------------------
	const camY = () => page.evaluate(() => new Promise((r) => window.__tp.test.v1.globalCamera.subscribe((cam) => r(cam.position.y))()));
	const lookDown = () =>
		page.evaluate(() => {
			let cam;
			window.__tp.test.v1.globalCamera.subscribe((x) => (cam = x))();
			let orbit;
			window.__tp.test.v1.orbitControls.subscribe((x) => (orbit = x))();
			cam.position.set(0, 6, 6);
			orbit?.target?.set(0, 0, 0);
			orbit?.update?.();
			cam.lookAt(0, 0, 0);
		});
	const fly = async (key, ms = 500) => {
		await page.keyboard.down(key);
		await page.waitForTimeout(ms);
		await page.keyboard.up(key);
		await page.waitForTimeout(200);
	};
	await page.mouse.click(c.x + 300, c.y + 250);
	await lookDown();
	let y0 = await camY();
	await fly('KeyW');
	let y1 = await camY();
	h.check(near(y0, y1, 1e-3), `5.1 Level (default): W keeps the height while looking down (${y0.toFixed(3)} -> ${y1.toFixed(3)})`);
	await page.evaluate(() => window.__tp.test.v1.flyPrefs.flyDirection.set('look'));
	await lookDown();
	y0 = await camY();
	await fly('KeyW');
	y1 = await camY();
	h.check(y1 < y0 - 0.1, `5.2 Where I look: W follows the view down (${y0.toFixed(3)} -> ${y1.toFixed(3)})`);
	y0 = await camY();
	await fly('KeyE');
	y1 = await camY();
	h.check(y1 > y0 + 0.1, `5.3 E still rises straight up (${y0.toFixed(3)} -> ${y1.toFixed(3)})`);
	await page.evaluate(() => window.__tp.test.v1.flyPrefs.flyDirection.set('level'));
	// right-button fly
	await page.evaluate(() => window.__tp.test.v1.flyPrefs.flyWithWasd.set('rmb'));
	const camPos = () => page.evaluate(() => new Promise((r) => window.__tp.test.v1.globalCamera.subscribe((cam) => r(cam.position.toArray()))()));
	const dist = (a, b2) => Math.hypot(a[0] - b2[0], a[1] - b2[1], a[2] - b2[2]);
	let a0 = await camPos();
	await fly('KeyA');
	let a1 = await camPos();
	h.check(dist(a0, a1) < 1e-3, `5.4 right-button mode: A alone does not fly (${dist(a0, a1).toFixed(4)})`);
	await page.mouse.move(c.x + 300, c.y + 250);
	await page.mouse.down({ button: 'right' });
	a0 = await camPos();
	await page.keyboard.down('KeyA');
	await page.waitForTimeout(500);
	await page.keyboard.up('KeyA');
	await page.mouse.up({ button: 'right' });
	await page.waitForTimeout(400);
	a1 = await camPos();
	const menuAfterFly = await page.evaluate(() => {
		let m;
		window.__tp.test.v1.viewportMenu.subscribe((x) => (m = x))();
		return !!m;
	});
	h.check(dist(a0, a1) > 0.1 && !menuAfterFly, `5.5 holding the right button, A flies and the release opens no menu (moved ${dist(a0, a1).toFixed(2)}, menu ${menuAfterFly})`);
	await page.evaluate(() => {
		window.__tp.test.v1.flyPrefs.flyWithWasd.set('always');
		window.__tp.test.v1.shortcutsRegistry.setKeymapPreset('theprototype');
	});

	// ---- 5b. the status line never covers a touch bar (row 6) --------------------------------
	await page.evaluate(() => {
		const v = window.__tp.test.v1;
		v.touchTools.set(true);
		v.shortcutsRegistry.setKeymapPreset('blender');
	});
	await page.waitForTimeout(500);
	// park the touch row right where the line sits by default (top centre)
	// a stylesheet rule, because the cluster layout rewrites the row's classes and style attribute
	await page.evaluate(() => {
		const css = document.createElement('style');
		css.id = 'park-touch-103';
		css.textContent = `#touch-tools { left: ${Math.round(innerWidth / 2 - 60)}px !important; top: 56px !important; }`;
		document.head.appendChild(css);
	});
	await page.waitForTimeout(300);
	const tt = await page.evaluate(() => {
		const r = document.querySelector('#touch-tools')?.getBoundingClientRect();
		return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
	});
	h.check(!!tt && tt.top < 90 && tt.bottom > 64 && tt.left < 1440 / 2 && tt.right > 1440 / 2, `5.6 premise: the touch row sits over the line's default spot (${JSON.stringify(tt)})`);
	await selectBox('5.6');
	await page.mouse.move(c.x, c.y);
	await startNow(page, 'KeyG');
	const lineBox = await page.evaluate(() => {
		const r = document.querySelector('#modal-transform-line')?.getBoundingClientRect();
		return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
	});
	const ttNow = await page.evaluate(() => {
		const r = document.querySelector('#touch-tools')?.getBoundingClientRect();
		return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
	});
	await page.keyboard.press('Escape');
	h.check(JSON.stringify(ttNow) === JSON.stringify(tt), `5.6b premise: the touch row is still parked there while the line shows (${JSON.stringify(ttNow)})`);
	const clear = !!lineBox && !!tt && !(lineBox.left < tt.right && tt.left < lineBox.right && lineBox.top < tt.bottom && tt.top < lineBox.bottom);
	h.check(clear && lineBox.top >= 0 && lineBox.bottom <= 900, `5.7 the line steps clear of the touch row and stays on screen (${JSON.stringify(lineBox)})`);
	await page.evaluate(() => {
		document.getElementById('park-touch-103')?.remove();
		window.__tp.test.v1.touchTools.set(false);
		window.__tp.test.v1.shortcutsRegistry.setKeymapPreset('theprototype');
	});

	// ---- 6. the object list takes the keyboard -----------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.objectListClose.set(true));
	await page.mouse.click(c.x + 300, c.y + 250);
	await page.waitForTimeout(300);
	await page.keyboard.press('KeyO');
	const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
	await h.eventually(active, (id) => id === 'object-tree', '6.1 O opens the object list with the keyboard in it', 4000);
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(300);
	const sel = await page.evaluate(() => new Promise((r) => window.__tp.test.v1.selectedObjects.subscribe(r)()));
	h.check(sel.length === 1, `6.2 Down selects a row straight away (${sel.length})`);
	// brought to front by its button / key (the programmatic raise every opener goes through)
	await page.mouse.click(c.x + 300, c.y + 250);
	await page.waitForTimeout(300);
	h.check((await active()) !== 'object-tree', `6.3 premise: the viewport has the keyboard again (${await active()})`);
	await page.evaluate(() => window.__tp.test.v1.windowFocus.raiseWindow('objects'));
	await h.eventually(active, (id) => id === 'object-tree', '6.4 raising the list (its button / key) hands it the keyboard', 4000);
	// brought to front by a press on its header (no control there: the focus would stay on <body>)
	await page.mouse.click(c.x + 300, c.y + 250);
	await page.waitForTimeout(300);
	const head = await page.evaluate(() => {
		const r = document.querySelector('#object-list')?.getBoundingClientRect();
		const title = [...document.querySelectorAll('#object-list *')].find((el) => el.children.length === 0 && el.textContent?.trim() === 'Objects');
		const t = title?.getBoundingClientRect();
		return t ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : r ? { x: r.left + 40, y: r.top + 10 } : null;
	});
	if (head) await page.mouse.click(head.x, head.y);
	await h.eventually(active, (id) => id === 'object-tree', '6.5 a press on the list header hands it the keyboard', 4000);
	// a field inside the window keeps its focus (never stolen)
	await page.evaluate(() => {
		const input = document.querySelector('#object-list input');
		input?.focus();
	});
	const hasInput = await page.evaluate(() => !!document.querySelector('#object-list input'));
	if (hasInput) {
		await page.evaluate(() => window.__tp.test.v1.windowFocus.raiseWindow('objects'));
		await page.waitForTimeout(300);
		h.check((await page.evaluate(() => document.activeElement?.tagName)) === 'INPUT', `6.6 a raise never steals the focus from a field inside the window`);
	}

	await h.finish(browser);
});
