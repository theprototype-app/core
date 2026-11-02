// 52 V1 + V2 — MEASURE AND ARRANGE IN A HEADSET, on IWER (48 G2: the app's own XR path, a Quest 3 emulated).
// A wears the headset; B is a desktop peer that must see every result.
//
//  T  Tools ▸ Measure is picked with the STICK and the stick PRESS (the radial, no test call)
//  M  laser points snap through the snap engine inside a 3° cone: a laser 3 cm inside a box corner puts the
//     point ON the corner (vertex); the chain reads 2.000 m / 90.0° / Total 3.000 m
//  L  the labels are troika text in the scene: they face the viewer and are the same ANGLE tall near and far
//  K  a double tap keeps the chain: a measurement ITEM on A and on B (the 48 B2 item)
//  N  Snap off (the Measure ring) = the same laser does NOT land on the corner (the counterfactual for M)
//  G  grid snapping on: a raw floor point lands on the grid
//  E  Selected ▸ Edit measurement: a press near a point (by angle) picks it up, the next puts it down
//     snapped; ONE undo entry; B sees it; Undo puts it back on both peers
//  H  hand tracking: a pinch while measuring says "pick up a controller" (the shared chip, no toast) and adds nothing
//  A  Selected ▸ Arrange ▸ Align X min (stick-driven) / X even gaps / Drop to ground: the alignCore
//     answer, on A and B, ONE undo restores the whole set on both
//  F  frame cost on the Quest profile: the hover search + the label posing per frame, against 13.9 ms
// A real-Quest row (feel, label legibility at the true eye resolution, haptics) goes on 52-int's checklist.
// Run: APP_URL=https://localhost:5481/ node tests/e2e/vr-measure-iwer.test.cjs   (ONLY=M,A to pick rows;
// SHOTS=<dir> also writes headset eye shots of the labels and the rings there — vrEyes.cjs)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const SHOTS = process.env.SHOTS || '';
const eyes = SHOTS ? require('./vrEyes.cjs') : null;

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(row);
const near = (a, b, tol = 1e-5) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fmt = (p) => (p ? '[' + p.map((v) => (+v).toFixed(3)).join(', ') + ']' : 'null');
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);
	const page = A.page;
	const g = (fn, arg) => page.evaluate(fn, arg);
	const read = (name, p = page) => p.evaluate((n) => { let v; window.__stores[n].subscribe((x) => (v = x))(); return v; }, name);
	const settle = (n = 6) => iwer.frames(page, n);
	const dbg = () => g(() => window.__stores.vrMeasure.vrMeasureDebug());
	const depth = (p = page) => p.evaluate(() => { let d; window.__stores.history.undoStack.subscribe((v) => (d = v.length))(); return d; });
	const items = (p) => p.evaluate(() => window.__stores.measureItems.measurementItems().map((o) => ({ uuid: o.uuid, points: window.__stores.measureItems.worldPointsOf(o) })));

	/** create boxes on A (`/create Box w h d`), return their uuids */
	const createBoxes = (dims) =>
		g(async (list) => {
			const w = window.__stores;
			const out = [];
			for (const d of list) {
				w.commandsHandler.sceneCommand('/create Box ' + d);
				await new Promise((r) => setTimeout(r, 400));
				let gr; w.objectsGroup.subscribe((v) => (gr = v))();
				out.push(gr.children[gr.children.length - 1].uuid);
			}
			return out;
		}, dims);
	/** pose boxes on A and replicate them (the move path), the align-arrange suite's helper */
	const place = (list) =>
		g((items) => {
			const w = window.__stores;
			let gr; w.objectsGroup.subscribe((v) => (gr = v))();
			let p; w.peers.subscribe((v) => (p = v))();
			for (const it of items) {
				const o = gr.getObjectByProperty('uuid', it.uuid);
				o.position.set(...it.pos);
				o.rotation.set(0, 0, 0);
				o.scale.set(1, 1, 1);
				o.updateMatrixWorld(true);
				p.send({ type: 'move', uuid: it.uuid, pos: it.pos, rot: [0, 0, 0], scale: [1, 1, 1] });
			}
		}, list);
	/** world boxes of uuids on a page */
	const boxes = (p, uuids) =>
		p.evaluate((ids) => {
			let gr; window.__stores.objectsGroup.subscribe((v) => (gr = v))();
			return ids.map((id) => {
				const o = gr.getObjectByProperty('uuid', id);
				if (!o) return null;
				o.updateMatrixWorld(true);
				o.geometry.computeBoundingBox();
				const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
				return { pos: o.position.toArray(), min: bb.min.toArray(), max: bb.max.toArray() };
			});
		}, uuids);

	// ---- the headset ---------------------------------------------------------------------------------
	/** eye shots from where the XR camera stands (the labels face IT) — only with SHOTS set */
	const shot = async (name) => {
		if (!eyes) return;
		await settle(4);
		const head = await g(() => {
			let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const cam = r.xr.getCamera();
			cam.updateMatrixWorld(true);
			const e = cam.matrixWorld.elements;
			const f = [-e[8], -e[9], -e[10]];
			return { position: [e[12], e[13], e[14]], yaw: Math.atan2(-f[0], -f[2]), pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) };
		});
		const out = await eyes.save(page, SHOTS + '/' + name, { size: 768, head });
		console.log('shot', out.pair);
	};
	const st = await iwer.enter(page);
	h.check(st.presenting && st.same, 'premise: Play presents the IWER session');
	const menuHand = await read('vrMenuHand');
	const pointer = menuHand === 'right' ? 'left' : 'right';
	const menuButton = menuHand === 'left' ? 'y-button' : 'b-button';
	const P0 = pointer === 'left' ? [-0.2, 1.3, -0.35] : [0.2, 1.3, -0.35];
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	await iwer.pose(page, menuHand, menuHand === 'left' ? [-0.25, 1.1, -0.3] : [0.25, 1.1, -0.3]);
	await iwer.pose(page, pointer, P0);
	await settle(8);
	const w0 = await iwer.controllerWorld(page);
	const rig = w0[pointer].pos.map((v, i) => v - P0[i]);
	const head = w0.head.pos;
	console.log(`menu hand ${menuHand}, pointer ${pointer}, rig offset ${fmt(rig)}, head ${fmt(head)}`);

	/** the pointer controller's world forward */
	const forward = () =>
		g(() => {
			let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
			for (const i of [0, 1]) {
				const c = r.xr.getController(i);
				if (c.userData.handedness !== window.__pointerHand) continue;
				c.updateMatrixWorld(true);
				const e = c.matrixWorld.elements;
				return [-e[8], -e[9], -e[10]];
			}
			return null;
		});
	await g((p) => (window.__pointerHand = p), pointer);
	/** aim the pointer laser (from P0) at a WORLD point */
	const aim = async (target, frames = 6) => {
		const o = P0.map((v, i) => v + rig[i]);
		const d = target.map((v, i) => v - o[i]);
		const yaw = Math.atan2(-d[0], -d[2]);
		const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
		await iwer.pose(page, pointer, P0, { yaw, pitch });
		await settle(frames);
		return { o, d };
	};
	const press = async (hand = pointer) => {
		await iwer.button(page, hand, 'trigger', 1);
		await settle(3);
		await iwer.button(page, hand, 'trigger', 0);
		await settle(5);
	};
	/** pick a sector of the OPEN ring with the stick + stick press (null id = the hub) */
	const stickRun = async (id) => {
		if (id === null) {
			await iwer.stick(page, menuHand, 0, 0);
			await settle(3);
			await iwer.tap(page, menuHand, 'thumbstick');
			await settle(3);
			return true;
		}
		const pick = await g((want) => {
			const m = window.__stores.vrRadialMenu;
			let ring; m.activeRing.subscribe((v) => (ring = v))();
			const ents = m.ringEntries(ring);
			const k = ents.findIndex((e) => e.id === want);
			if (k < 0) return { ring, ids: ents.map((e) => e.id) };
			const a = (k * 2 * Math.PI) / ents.length;
			return { ring, k, x: Math.sin(a), y: -Math.cos(a) };
		}, id);
		if (pick.k == null) {
			h.check(false, `the "${pick.ring}" ring offers ${id} (${pick.ids})`);
			return false;
		}
		await iwer.stick(page, menuHand, pick.x, pick.y);
		await settle(8);
		const hovered = await g(() => { let v; window.__stores.vrControls.vrHovered.subscribe((x) => (v = x))(); return v; });
		await iwer.tap(page, menuHand, 'thumbstick');
		await iwer.stick(page, menuHand, 0, 0);
		await settle(4);
		return hovered === id;
	};
	const openMenu = async () => {
		if (!(await read('vrMenuOpen'))) await iwer.tap(page, menuHand, menuButton);
		await settle(4);
		return read('vrMenuOpen');
	};
	const closeMenu = async () => {
		if (await read('vrMenuOpen')) await iwer.tap(page, menuHand, menuButton);
		await settle(3);
	};

	// the fixture: a 2 x 1 x 1 box standing 2 m ahead of the head, so its top corners are (cx ± 1, 1, cz ± 0.5)
	const [boxId] = await createBoxes(['2 1 1']);
	await page.waitForTimeout(1500); // /create re-seats after it returns
	const C = [head[0], 0.5, head[2] - 2];
	await place([{ uuid: boxId, pos: C }]);
	await h.eventually(() => boxes(B.page, [boxId]), (b) => b[0] && near(b[0].pos, C, 1e-6), 'premise: the box stands 2 m ahead of the head, on A and on B', 20000);
	await g(() => window.__stores.objectActions.deselectObject?.());
	const FL = [C[0] - 1, 1, C[2] + 0.5];
	const FR = [C[0] + 1, 1, C[2] + 0.5];
	const BR = [C[0] + 1, 1, C[2] - 0.5];
	const BL = [C[0] - 1, 1, C[2] - 0.5];
	const TOP = [C[0], 1, C[2]];
	/** 3 cm inside a corner toward the top centre — on the box, off the corner */
	const inside = (corner, by = 0.03) => {
		const d = TOP.map((v, i) => v - corner[i]);
		const l = Math.hypot(...d);
		return corner.map((v, i) => v + (d[i] / l) * by);
	};

	// ---- T. Tools ▸ Measure from the stick ---------------------------------------------------------------
	if (want('T') || want('M') || want('L') || want('K') || want('N') || want('G')) {
		console.log('\n=== T. Tools ▸ Measure ===');
		h.check(await openMenu(), 'the menu button opens the radial');
		h.check(await stickRun('nav:tools'), 'the stick lights Tools ▸ and the press opens it');
		h.check(await stickRun('measure:tool'), 'the stick lights Measure in the Tools ring');
		const d0 = await dbg();
		h.check(d0.active && d0.mode && d0.tool === 'measure', `Measure is the trigger tool (${JSON.stringify({ active: d0.active, mode: d0.mode, tool: d0.tool })})`);
		h.check((await read('vrMenuOpen')) === false, 'picking it closes the radial');
	}

	// ---- M. snapped laser points -----------------------------------------------------------------------
	if (want('M') || want('L') || want('K') || want('N')) {
		console.log('\n=== M. the laser snaps to corners ===');
		const { o, d } = await aim(inside(FL));
		const f = await forward();
		const l = Math.hypot(...d);
		const angle = (Math.acos(Math.min(1, (f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / l)) * 180) / Math.PI;
		h.check(angle < 0.3, `premise: the laser points where the suite aims it (${angle.toFixed(3)}° off)`);
		const off = (Math.atan2(0.03, dist(o, FL)) * 180) / Math.PI;
		console.log(`the laser runs ${off.toFixed(2)}° from the corner`);
		await h.eventually(dbg, (x) => x.hover && near(x.hover.point, FL), `the HOVER sits on the corner while the laser is 3 cm inside it (${off.toFixed(2)}° off)`, 5000);
		const hv = (await dbg()).hover;
		h.check(hv?.snap === 'vertex', `…snapped as a vertex (${hv?.snap})`);
		const marker = await g(() => { let s; window.__stores.globalScene.subscribe((v) => (s = v))(); let vis = false; s.traverse((o) => { if (/snap/i.test(o.name) && o.visible && o.isGroup) vis = true; }); let c; window.__stores.snapEngine.activeSnapCandidate.subscribe((v) => (c = v))(); return { vis, type: c?.type ?? null }; });
		h.check(marker.type === 'vertex', `the snap marker shows the corner under the laser (${JSON.stringify(marker)})`);
		await press();
		let s = await dbg();
		h.check(s.points.length === 1 && near(s.points[0], FL) && s.snaps[0] === 'vertex', `the TRIGGER puts the first point ON the corner ${fmt(s.points[0])} (${s.snaps[0]})`);
		await aim(inside(FR));
		await press();
		await aim(inside(BR));
		await press();
		s = await dbg();
		h.check(s.points.length === 3 && near(s.points[1], FR) && near(s.points[2], BR), `three points: ${s.points.map(fmt).join(' → ')}`);
		const labels = await g(() => window.__vrMeasureLabels.filter((l) => !l.hidden && l.key.startsWith('cur:')).map((l) => l.text));
		h.check(labels.includes('2.000 m') && labels.includes('1.000 m'), `the segments read 2.000 m and 1.000 m (${labels.join(' | ')})`);
		h.check(labels.includes('90.0°'), 'the turn at the corner reads 90.0°');
		h.check(labels.some((t) => t.startsWith('Total 3.000 m')), 'the running total reads Total 3.000 m');
		await iwer.pose(page, 'head', [0, 1.6, 0], { pitch: -0.45 });
		await shot('01-measure-chain-near');
		await iwer.pose(page, 'head', [0, 1.6, 0]);
	}

	// ---- L. the labels: troika text facing you, the same angle tall near and far -----------------------------
	if (want('L')) {
		console.log('\n=== L. labels in the headset ===');
		const look = () =>
			g(() => {
				let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
				let s; window.__stores.globalScene.subscribe((v) => (s = v))();
				const cam = r.xr.getCamera();
				const q = cam.getWorldQuaternion(cam.quaternion.clone());
				const out = [];
				s.traverse((o) => {
					if (o.name !== 'vr-measure-label' || !o.visible) return;
					const lq = o.getWorldQuaternion(o.quaternion.clone());
					const text = o.children.find((c) => c.text != null)?.text;
					out.push({ text, dot: Math.abs(q.dot(lq)), troika: !!o.children.find((c) => c.text != null && c.isMesh) });
				});
				return { out, list: window.__vrMeasureLabels.map((l) => ({ ...l })) };
			});
		await settle(10);
		const a = await look();
		const seg = a.list.find((l) => l.text === '2.000 m');
		h.check(a.out.length >= 4 && a.out.every((x) => x.troika), `the labels are troika text meshes in the scene (${a.out.length}: ${a.out.map((x) => x.text).join(' | ')})`);
		h.check(a.out.every((x) => x.dot > 0.999), `every label faces the viewer (min |q·q| ${Math.min(...a.out.map((x) => x.dot)).toFixed(5)})`);
		h.check(!!seg && Math.abs(seg.height / seg.distance - 0.03) < 1e-6, `a label is 0.03 rad tall: ${seg?.height.toFixed(4)} m at ${seg?.distance.toFixed(3)} m`);
		h.check(!!seg && seg.height >= 0.025, `…which at arm's length is a readable ${((seg?.height ?? 0) * 100).toFixed(1)} cm`);
		await iwer.pose(page, 'head', [0, 1.6, 2.5]); // step back 2.5 m
		await settle(10);
		const b = await look();
		const seg2 = b.list.find((l) => l.text === '2.000 m');
		h.check(!!seg2 && seg2.distance > seg.distance + 2 && Math.abs(seg2.height / seg2.distance - 0.03) < 1e-6, `stepping back, the label GROWS with its distance (${seg?.height.toFixed(3)} m → ${seg2?.height.toFixed(3)} m at ${seg2?.distance.toFixed(2)} m): the same size to the eye`);
		h.check(b.out.every((x) => x.dot > 0.999), '…and still faces the viewer');
		await iwer.pose(page, 'head', [0, 1.6, 2.5], { pitch: -0.25 });
		await shot('02-measure-labels-far');
		await iwer.pose(page, 'head', [0, 1.6, 0]);
		await settle(6);
	}

	// ---- K. a double tap keeps the chain — a measurement ITEM on both peers --------------------------------
	let itemId = null;
	if (want('K') || want('E')) {
		console.log('\n=== K. keep ===');
		if (!(await dbg()).points.length) {
			for (const c of [FL, FR, BR]) {
				await aim(inside(c));
				await press();
			}
		}
		// the chain ends ON BR: take that point back (the ring's Undo point), then put it down with a DOUBLE TAP —
		// the first tap places it, the second, on the same spot, keeps the chain (the desktop double click)
		await g(() => window.__stores.vrControls.executeVRMenuAction('measure:undo'));
		await h.eventually(dbg, (x) => x.points.length === 2, 'the ring\'s Undo point takes the last point back', 5000);
		const before = (await items(page)).length;
		await aim(inside(BR));
		for (let i = 0; i < 2; i++) {
			await iwer.button(page, pointer, 'trigger', 1);
			await settle(2);
			await iwer.button(page, pointer, 'trigger', 0);
			await settle(2);
		}
		await settle(4);
		const after = await items(page);
		const s = await dbg();
		h.check(after.length === before + 1 && s.points.length === 0, `a second press on the same spot KEEPS the chain (${before} → ${after.length} items, drawing ${s.points.length})`);
		const item = after[after.length - 1];
		itemId = item?.uuid ?? null;
		h.check(!!item && item.points.length === 3 && near(item.points[0], FL) && near(item.points[2], BR), `the item holds the three snapped corners (${item?.points.map(fmt).join(' → ')})`);
		await h.eventually(() => items(B.page), (b) => b.some((x) => x.uuid === itemId && x.points.length === 3 && near(x.points[1], FR, 1e-4)), 'B holds the same measurement item (synced)', 15000);
		if (SHOTS) {
			await B.page.evaluate((c) => window.__stores.objectActions.flyTo([c[0] + 2.5, 3, c[2] + 3.5], c, 0), C);
			await B.page.waitForTimeout(1200);
			await B.page.screenshot({ path: SHOTS + '/03-peer-sees-the-item.png' });
		}
	}

	// ---- N. snap off: the same laser does NOT land on the corner (the counterfactual for M) --------------------
	if (want('N')) {
		console.log('\n=== N. the Measure ring and snap off ===');
		h.check(await openMenu(), 'the menu button opens the radial while measuring…');
		const ring = await g(() => { let v; window.__stores.vrRadialMenu.activeRing.subscribe((x) => (v = x))(); return v; });
		h.check(ring === 'measure', `…on the Measure ring (${ring})`);
		if (SHOTS) await iwer.pose(page, 'head', [0, 1.6, 0], { pitch: -0.75, yaw: menuHand === 'right' ? -0.4 : 0.4 });
		await shot('04-measure-ring');
		if (SHOTS) await iwer.pose(page, 'head', [0, 1.6, 0]);
		h.check(await stickRun('measure:snap'), 'the stick picks Snap');
		const snapOn = await g(() => { let v; window.__stores.measure.measureSnap.subscribe((x) => (v = x))(); return v; });
		h.check(snapOn === false, 'Snap is off');
		await closeMenu();
		await aim(inside(FL));
		await press();
		const s = await dbg();
		const p = s.points[s.points.length - 1];
		h.check(!!p && dist(p, FL) > 0.02 && Math.abs(p[1] - 1) < 1e-4, `with Snap off the same laser lands ON THE TOP FACE, ${p ? (dist(p, FL) * 100).toFixed(1) : '?'} cm from the corner — the snap is what put it there`);
		await g(() => window.__stores.vrControls.executeVRMenuAction('measure:snap'));
		await g(() => window.__stores.vrControls.executeVRMenuAction('measure:discard'));
		await h.eventually(dbg, (x) => x.points.length === 0, 'Discard drops the chain being drawn', 5000);
	}

	// ---- G. grid: a raw floor point lands on the grid -------------------------------------------------------------
	if (want('G')) {
		console.log('\n=== G. grid snapping ===');
		await g(() => { const s = window.__stores.snapping; s.snapSettings.set({ translate: 0.5, rotateDeg: 15, scale: 0.1 }); s.snapEnabled.set(true); });
		const floor = [head[0] + 1.27, 0, head[2] - 1.12];
		await aim(floor);
		await press();
		const s = await dbg();
		const p = s.points[s.points.length - 1];
		const expect = [Math.round(floor[0] / 0.5) * 0.5, 0, Math.round(floor[2] / 0.5) * 0.5];
		h.check(!!p && near(p, expect, 1e-4) && s.snaps[s.snaps.length - 1] === 'grid', `a floor point lands on the 0.5 m grid: ${fmt(p)} = ${fmt(expect)} (${s.snaps[s.snaps.length - 1]})`);
		await g(() => window.__stores.snapping.snapEnabled.set(false));
		await aim(floor);
		await press();
		const s2 = await dbg();
		const q = s2.points[s2.points.length - 1];
		h.check(!!q && dist(q, floor) < 0.01 && !near(q, expect, 0.01), `grid off: the same laser lands where it points ${fmt(q)}`);
		await g(() => window.__stores.vrControls.executeVRMenuAction('measure:discard'));
	}

	// ---- E. Selected ▸ Edit measurement -------------------------------------------------------------------------------
	if (want('E') && itemId) {
		console.log('\n=== E. edit a kept measurement ===');
		await g(() => window.__stores.vrControls.executeVRMenuAction('measure:done'));
		await settle(3);
		h.check(!(await dbg()).active, 'Done ends the tool (the trigger selects again)');
		await g((u) => window.__stores.objectActions.applySelectionSet([u]), itemId);
		await settle(3);
		h.check(await openMenu(), 'the radial opens');
		h.check(await stickRun(null), 'the centred stick press takes the hub (Selected)');
		const offered = await g(() => window.__stores.vrRadialMenu.ringEntries('object').map((e) => e.id));
		h.check(offered.includes('obj:editmeasure') && !offered.includes('obj:editmesh'), `a measurement offers Edit measurement, not Edit mesh (${offered.join(', ')})`);
		h.check(await stickRun('obj:editmeasure'), 'the stick picks Edit measurement');
		let s = await dbg();
		h.check(!!s.editing && s.editing.uuid === itemId && s.active, `editing the item from the headset (${JSON.stringify(s.editing)})`);
		const d0 = await depth();
		await aim(FL); // the laser ON the first point: picks it up (by angle, no snap search)
		await press();
		s = await dbg();
		h.check(s.editing?.active === 0, `a press on a point picks it up (active ${s.editing?.active})`);
		await aim(inside(BL)); // put it down 3 cm inside another corner: it snaps there
		await press();
		s = await dbg();
		const a1 = (await items(page)).find((x) => x.uuid === itemId);
		h.check(s.editing?.active === -1 && near(a1.points[0], BL), `the next press puts it down ON the corner it snapped to ${fmt(a1.points[0])}`);
		h.check((await depth()) === d0 + 1, `ONE undo entry for the edit (${d0} → ${await depth()})`);
		await h.eventually(() => items(B.page), (b) => b.some((x) => x.uuid === itemId && near(x.points[0], BL, 1e-4)), 'B sees the edited point', 15000);
		await g(() => window.__stores.vrControls.executeVRMenuAction('undo'));
		await settle(3);
		const a2 = (await items(page)).find((x) => x.uuid === itemId);
		h.check(near(a2.points[0], FL), `Undo puts the point back on A ${fmt(a2.points[0])}`);
		await h.eventually(() => items(B.page), (b) => b.some((x) => x.uuid === itemId && near(x.points[0], FL, 1e-4)), '…and on B', 15000);
		h.check(await openMenu(), 'the radial opens on the Measure ring while editing');
		h.check(await stickRun('measure:done'), 'Done');
		s = await dbg();
		h.check(!s.editing && !s.active && s.tool === 'select', `Done ends the edit and the tool (${JSON.stringify({ editing: s.editing, tool: s.tool })})`);
	}

	// ---- H. hand tracking says "pick up a controller" --------------------------------------------------------------
	if (want('H')) {
		console.log('\n=== H. hands ===');
		await g(() => window.__stores.vrBuildRings && window.__stores.vrMeasure.startVRMeasure());
		const switched = await g(async () => {
			const d = window.__iwer.device;
			try {
				d.primaryInputMode = 'hand';
			} catch {
				return false;
			}
			await new Promise((r) => setTimeout(r, 500));
			let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
			return [...r.xr.getSession().inputSources].some((s) => !!s.hand);
		});
		if (!switched) console.log('SKIP H: this IWER build cannot switch to tracked hands');
		else {
			await settle(10);
			const before = await dbg();
			await g((hand) => { const d = window.__iwer.device; d.hands[hand].updatePinchValue(1); }, pointer);
			await settle(6);
			await g((hand) => { const d = window.__iwer.device; d.hands[hand].updatePinchValue(0); }, pointer);
			await settle(6);
			const after = await dbg();
			const toast = await page.evaluate(() => [...document.querySelectorAll('.tp-toast, [role=status]')].map((e) => e.textContent).join(' | '));
			const note = await g(() => window.__stores.vrHands.handInputDebug());
			h.check(after.handRefusals > before.handRefusals && after.points.length === before.points.length, `a pinch while measuring adds no point (${before.points.length} → ${after.points.length}, refusals ${after.handRefusals})`);
			h.check(note.note?.text === 'Pick up a controller to measure' && note.note?.hand === pointer, `…and says "Pick up a controller" on the shared chip at that hand (${JSON.stringify(note.note)})`);
			// 54 X6: the chip is the one message — no toast says it a second time
			h.check(!/pick up a controller/i.test(toast), `…and no toast doubles it (${toast.slice(0, 120)})`);
			await g(async () => { window.__iwer.device.primaryInputMode = 'controller'; await new Promise((r) => setTimeout(r, 500)); });
			await settle(10);
		}
		await g(() => window.__stores.vrMeasure.stopVRMeasure({ keep: false }));
	}

	// ---- A. Selected ▸ Arrange -------------------------------------------------------------------------------------
	if (want('A')) {
		console.log('\n=== A. arrange from the radial ===');
		const ids = await createBoxes(['1 1 1', '2 1 1', '0.5 1 1']);
		await page.waitForTimeout(1500);
		const START = [
			{ uuid: ids[0], pos: [head[0] - 3, 0.5, head[2] - 4] }, // x [-3.5, -2.5] rel
			{ uuid: ids[1], pos: [head[0] + 1, 2, head[2] - 3] }, //   x [0, 2]
			{ uuid: ids[2], pos: [head[0] + 4, 0.5, head[2] - 5] } //  x [3.75, 4.25]
		];
		await place(START);
		await h.eventually(() => boxes(B.page, ids), (b) => b.every((q, i) => q && near(q.pos, START[i].pos, 1e-6)), 'premise: three boxes posed on A and B', 15000);
		await g((u) => window.__stores.objectActions.applySelectionSet(u), ids.slice(0, 2));
		await settle(3);
		const dis = await g(() => window.__stores.vrRadialMenu.findMenuEntry('arrange:gaps').disabled());
		h.check(dis === true, 'with two selected, Even gaps is greyed (it needs three)');
		await g((u) => window.__stores.objectActions.applySelectionSet(u), ids);
		await settle(3);
		await g(() => window.__stores.vrBuildRings.vrArrangeAxis.set('x'));
		const d0 = await depth();
		const d0B = await depth(B.page);
		h.check(await openMenu(), 'the radial opens');
		h.check(await stickRun(null), 'the hub opens Selected');
		h.check(await stickRun('nav:arrange'), 'the stick picks Arrange ▸');
		if (SHOTS) await iwer.pose(page, 'head', [0, 1.6, 0], { pitch: -0.75, yaw: menuHand === 'right' ? -0.4 : 0.4 });
		await shot('05-arrange-ring');
		if (SHOTS) await iwer.pose(page, 'head', [0, 1.6, 0]);
		h.check(await stickRun('arrange:min'), '…Align X min');
		const minX = START[0].pos[0] - 0.5;
		const test = (b) => b.every((q) => q && Math.abs(q.min[0] - minX) < 1e-6);
		const a = await boxes(page, ids);
		h.check(test(a), `Align X min: every box's left edge on the selection's (${a.map((q) => q.min[0].toFixed(3)).join(', ')} = ${minX.toFixed(3)})`);
		h.check((await depth()) === d0 + 1, `ONE undo entry for the set (${d0} → ${await depth()})`);
		await h.eventually(() => boxes(B.page, ids), test, 'B sees the aligned set', 15000);
		await g(() => window.__stores.vrControls.executeVRMenuAction('undo'));
		await settle(3);
		const u = await boxes(page, ids);
		h.check(u.every((q, i) => near(q.pos, START[i].pos, 1e-6)), 'ONE Undo puts all three back on A');
		await h.eventually(() => boxes(B.page, ids), (b) => b.every((q, i) => q && near(q.pos, START[i].pos, 1e-6)), '…and on B', 15000);
		h.check((await depth(B.page)) === d0B, 'B records no undo entry of its own (the move path)');
		// distribute gaps on X through the radial entries (the stick path is proven above)
		await g(() => {
			const r = window.__stores.vrControls;
			window.__stores.vrMenuOpen.set(true);
			['nav:object', 'nav:arrange', 'arrange:gaps'].forEach((id) => r.executeVRMenuAction(id));
		});
		await h.eventually(() => boxes(page, ids), (b) => {
			const s = [...b].sort((p, q) => p.min[0] - q.min[0]);
			return Math.abs((s[1].min[0] - s[0].max[0]) - (s[2].min[0] - s[1].max[0])) < 1e-6;
		}, 'Distribute X gaps: equal space between neighbours', 5000);
		await h.eventually(() => boxes(B.page, ids), (b) => {
			const s = [...b].sort((p, q) => p.min[0] - q.min[0]);
			return Math.abs((s[1].min[0] - s[0].max[0]) - (s[2].min[0] - s[1].max[0])) < 1e-6;
		}, '…on B', 15000);
		await g(() => {
			const r = window.__stores.vrControls;
			window.__stores.vrMenuOpen.set(true);
			['nav:object', 'nav:arrange', 'arrange:drop'].forEach((id) => r.executeVRMenuAction(id));
		});
		const groundTest = (b) => b.every((q) => q && Math.abs(q.min[1]) < 1e-4);
		await h.eventually(() => boxes(page, ids), groundTest, 'Drop to ground: every box rests on y = 0', 5000);
		await h.eventually(() => boxes(B.page, ids), groundTest, '…on B', 15000);
	}

	// ---- F. frame cost on the Quest profile ----------------------------------------------------------------------------
	if (want('F')) {
		console.log('\n=== F. frame cost ===');
		await g(() => window.__stores.vrMeasure.startVRMeasure());
		for (const c of [FL, FR, BR]) {
			await aim(inside(c));
			await press();
		}
		await aim(inside(BL));
		await g(() => { const c = window.__vrMeasureLabelsCost; c.frames = 0; c.ms = 0; });
		const s0 = await dbg();
		// sweep the laser across the box for ~120 frames (the hover search runs at ~30 Hz, the labels every frame)
		for (let i = 0; i < 12; i++) {
			await aim([C[0] - 1 + (i / 11) * 2, 1, C[2] + 0.4], 10);
		}
		const s1 = await dbg();
		const lc = await g(() => ({ ...window.__vrMeasureLabelsCost }));
		const hoverPerSearch = (s1.hoverMs - s0.hoverMs) / Math.max(1, s1.hovers - s0.hovers);
		const labelsPerFrame = lc.ms / Math.max(1, lc.frames);
		// at 72 Hz the hover search runs on ~42 % of frames (33 ms throttle); budget = the Quest 3's 13.9 ms frame
		const perFrame = labelsPerFrame + hoverPerSearch * Math.min(1, (1000 / 72) / 33);
		console.log(`hover search ${hoverPerSearch.toFixed(3)} ms (${s1.hovers - s0.hovers} searches), labels ${labelsPerFrame.toFixed(3)} ms/frame (${lc.frames} frames) → ${perFrame.toFixed(3)} ms/frame`);
		h.check(s1.hovers - s0.hovers >= 10 && lc.frames >= 60, 'premise: the sweep ran the hover search and the labels');
		h.check(perFrame < 1.4, `the tool costs ${perFrame.toFixed(2)} ms per frame on this box — under 10 % of the 72 Hz budget (13.9 ms)`);
		const calls = await g(() => { let r; window.__stores.globalRenderer.subscribe((v) => (r = v))(); let n = 0; let s; window.__stores.globalScene.subscribe((v) => (s = v))(); s.traverse((o) => { if (o.name === 'vr-measure-label' && o.visible) n += 2; }); return n; });
		console.log(`labels add ${calls} draw calls (plate + text each)`);
		h.check(calls <= 24, `the labels add ${calls} draw calls (≤ 24 for a 4-point chain)`);
		await g(() => window.__stores.vrMeasure.stopVRMeasure({ keep: false }));
	}

	await iwer.exit(page);
	h.check(!(await dbg()).active, 'leaving the headset ends the tool');
	await h.finish(browser);
});
