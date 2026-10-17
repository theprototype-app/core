// 47 M1 — the Measure tool: snapped points, chains with a running total and the angle between
// segments, and the touch tap path on a phone.
// 48 B2 — a kept measurement is a SCENE ITEM (replacing 47's local pins): kept by Keep / ✓, on
// BOTH peers, in the object list, selected by clicking its line, edited with Tab (pick a point
// up, put it down — the same snapping), one undo per edit, Backspace in the editor never deletes
// the item, labels of short segments never overlap, and it survives a save/load and the
// late-joiner send path.
//
// A is a desktop page driven with a REAL mouse; B is an OPPO Find N6 FOLDED phone (touch, DPR 3)
// driven with real CDP touch events. The fixture is a 2 x 1 x 1 box at (0, 0.5, 0), so its top
// corners are (±1, 1, ±0.5): the top front edge is exactly 2 m, the right edge exactly 1 m, and
// the two meet at 90°. Every click aims a few pixels INSIDE the corner it means (the ray must hit
// the box) — so a reading of exactly 2.000 m is the snap's doing, and the counterfactual (snap
// switched off, same pixels) proves it reads something else.
const h = require('./helpers.cjs');

const N6_FOLDED = { hasTouch: true, isMobile: true, deviceScaleFactor: 3, viewport: { width: 380, height: 792 } };
const CORNER_FL = [-1, 1, 0.5]; // top front-left
const CORNER_FR = [1, 1, 0.5]; // top front-right
const CORNER_BR = [1, 1, -0.5]; // top back-right
const TOP_CENTRE = [0, 1, 0];
const VIEW = { pos: [3, 3.5, 4.5], target: [0, 0.5, 0] };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const state = (page) =>
	page.evaluate(() => {
		const m = window.__stores.measure;
		const read = (s) => {
			let v;
			s.subscribe((x) => (v = x))();
			return v;
		};
		const cur = read(m.measurement);
		const mi = window.__stores.measureItems;
		const items = mi.measurementItems().map((o) => ({ uuid: o.uuid, name: o.name, points: mi.worldPointsOf(o) }));
		const labels = [...document.querySelectorAll('#measure-labels .measure-label')]
			.filter((el) => el.dataset.hidden !== '1')
			.map((el) => {
				const r = el.getBoundingClientRect();
				return {
					key: el.dataset.key,
					kind: el.dataset.kind,
					item: el.dataset.item === '1',
					text: el.textContent.trim(),
					x: parseFloat(el.style.left),
					y: parseFloat(el.style.top),
					rect: [r.left, r.top, r.right, r.bottom]
				};
			});
		return { cur, items, labels, mode: read(m.measureMode), editing: read(m.measureEditing) };
	});

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** the pixel a few px from `corner` toward `toward` (both projected) */
async function aimInside(page, corner, toward = TOP_CENTRE, px = 6) {
	const c = await h.projectPoint(page, corner);
	const t = await h.projectPoint(page, toward);
	const len = Math.hypot(t.x - c.x, t.y - c.y) || 1;
	return { x: c.x + ((t.x - c.x) / len) * px, y: c.y + ((t.y - c.y) / len) * px };
}

async function setView(page, view) {
	await page.evaluate((v) => window.__stores.objectActions.flyTo(v.pos, v.target, 0), view);
	await page.waitForTimeout(600);
}

/** what is under a pixel — a click that lands on chrome is not a viewport click */
const underIsCanvas = (page, p) => underOf(page, p).then((u) => u === 'CANVAS');
/** what is under a pixel: 'CANVAS' for the renderer's own, else a short description */
const underOf = (page, p) =>
	page.evaluate(({ x, y }) => {
		const el = document.elementFromPoint(x, y);
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		if (el === r.domElement) return 'CANVAS';
		return el ? `${el.tagName}#${el.id}.${String(el.className?.baseVal ?? el.className).slice(0, 60)}` : 'nothing';
	}, p);

async function click(page, p) {
	await page.mouse.move(p.x - 3, p.y - 3);
	await page.mouse.move(p.x, p.y, { steps: 3 });
	await page.waitForTimeout(120);
	await page.mouse.down();
	await page.mouse.up();
	await page.waitForTimeout(550); // past the double-click-pins window
}

async function tap(cdp, p, holdMs = 90) {
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
	await nap(holdMs);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await nap(550);
}

h.run(async () => {
	// the GPU backend: on the software one a frame can land between the press and the release,
	// and a click held past 400 ms is (rightly) an orbit, not a click
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { context: N6_FOLDED });
	await h.connect(A, B);

	// --- the fixture: a 2 x 1 x 1 box, posed on A and replicated ---
	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 2 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await A.page.waitForTimeout(1500); // /create re-seats after it returns
	await A.page.evaluate((id) => {
		const w = window.__stores;
		let g; w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		o.position.set(0, 0.5, 0);
		o.rotation.set(0, 0, 0);
		o.updateMatrixWorld(true);
		let p; w.peers.subscribe((v) => (p = v))();
		p.send({ type: 'move', uuid: id, pos: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
		w.objectActions.deselectObject?.();
	}, uuid);
	const boxOn = (page) =>
		page.evaluate((id) => {
			let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', id);
			if (!o) return null;
			return { x: o.position.x, y: o.position.y, z: o.position.z };
		}, uuid);
	await h.eventually(() => boxOn(B.page), (p) => p && Math.abs(p.y - 0.5) < 1e-6 && Math.abs(p.x) < 1e-6, 'premise: B holds the posed box', 20000);
	const size = await A.page.evaluate((id) => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		o.geometry.computeBoundingBox();
		const bb = o.geometry.boundingBox;
		return [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
	}, uuid);
	h.check(Math.abs(size[0] - 2) < 1e-6 && Math.abs(size[1] - 1) < 1e-6 && Math.abs(size[2] - 1) < 1e-6, `premise: the box is 2 x 1 x 1 (${size.map((n) => n.toFixed(3))})`);

	// --- 1. counterfactual first: snapping OFF, the same pixels do NOT read the box size ---
	await setView(A.page, VIEW);
	await A.page.evaluate(() => {
		const m = window.__stores.measure;
		m.measureSnap.set(false);
		m.startMeasure();
	});
	const pFL = await aimInside(A.page, CORNER_FL);
	const pFR = await aimInside(A.page, CORNER_FR);
	h.check((await underIsCanvas(A.page, pFL)) && (await underIsCanvas(A.page, pFR)), 'premise: both aim points are bare viewport');
	await click(A.page, pFL);
	await click(A.page, pFR);
	let s = await state(A.page);
	const raw = s.cur ? dist(s.cur.points[0], s.cur.points[1]) : NaN;
	h.check(s.cur?.points.length === 2 && Math.abs(raw - 2) > 0.01, `COUNTERFACTUAL: unsnapped clicks a few px inside the corners do not read 2 m (${raw.toFixed(4)})`);

	// --- 2. snapped two-point distance equals the box size ---
	await A.page.evaluate(() => {
		const m = window.__stores.measure;
		m.discardMeasurement();
		m.measureSnap.set(true);
	});
	await click(A.page, pFL);
	await click(A.page, pFR);
	s = await state(A.page);
	const snapped = s.cur ? dist(s.cur.points[0], s.cur.points[1]) : NaN;
	h.check(s.cur?.snaps?.every((t) => t === 'vertex'), `both points snapped to a vertex (${JSON.stringify(s.cur?.snaps)})`);
	h.check(Math.abs(snapped - 2) < 1e-5, `snapped distance equals the box width: ${snapped.toFixed(6)} m`);
	h.check(s.labels.length === 1 && s.labels[0].kind === 'segment' && s.labels[0].text === '2.000 m', `the DOM shows ONE label, 2.000 m — no 0 m preview while the cursor rests on the point (${s.labels.map((l) => l.text).join(' | ')})`);
	const readout = await A.page.locator('#measure-last').textContent().catch(() => '');
	h.check(readout?.trim() === '2.000 m', `the toolbox readout reads 2.000 m ("${readout}")`);

	// --- 3. a chain of 3 points: running total + the angle between the segments ---
	const pBR = await aimInside(A.page, CORNER_BR);
	h.check(await underIsCanvas(A.page, pBR), 'premise: the third aim point is bare viewport');
	await click(A.page, pBR);
	s = await state(A.page);
	const seg2 = s.cur?.points.length === 3 ? dist(s.cur.points[1], s.cur.points[2]) : NaN;
	h.check(Math.abs(seg2 - 1) < 1e-5, `the second segment is the box depth: ${seg2.toFixed(6)} m`);
	const total = s.labels.find((l) => l.kind === 'total');
	const angle = s.labels.find((l) => l.kind === 'angle');
	h.check(total?.text === 'Total 3.000 m', `the chain shows its total (${total?.text})`);
	h.check(angle?.text === '90.0°', `the chain shows the angle between the segments (${angle?.text})`);
	const tTotal = (await A.page.locator('#measure-total').textContent().catch(() => '')).trim();
	const tAngle = (await A.page.locator('#measure-angle').textContent().catch(() => '')).trim();
	h.check(tTotal === '3.000 m' && tAngle === '90.0°', `the toolbox agrees (total ${tTotal}, angle ${tAngle})`);
	// Backspace drops the last point, a third click puts it back
	await A.page.locator('#measure-undo-point').click();
	s = await state(A.page);
	// (the cursor still rests on the removed point, so the live PREVIEW draws a third point again —
	// the committed chain is what the toolbox reads)
	h.check(s.cur?.points.length === 2 && (await A.page.locator('#measure-total').count()) === 0, 'Undo point removes the last point and its total');
	await click(A.page, pBR);

	// --- 4. Keep: the chain becomes a SCENE ITEM, on both peers, and its labels follow the camera ---
	await A.page.locator('#measure-pin').click();
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.items.length === 1 && s.cur === null, `Keep makes ONE measurement item and starts a fresh chain (items ${s.items.length})`);
	const item = s.items[0];
	h.check(item?.name === 'Measurement' && item.points.length === 3, `the item is named Measurement and holds the 3 points (${item?.points.length})`);
	const kept = s.labels.filter((l) => l.item);
	h.check(kept.length === 4, `the item keeps its 4 labels — 2 lengths, the angle, the total (${kept.map((l) => l.text).join(' | ')})`);
	const before = kept.find((l) => l.kind === 'segment' && l.text === '2.000 m');
	// ✓ keeps whatever is being drawn: a second chain, then Done
	const pTL = await aimInside(A.page, [-1, 1, -0.5]);
	await click(A.page, pFL);
	await click(A.page, pTL);
	await A.page.locator('#measure-done').click();
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(!s.mode && s.items.length === 2, `✓ KEEPS the chain being drawn (47 dropped it): ${s.items.length} items, tool closed`);
	h.check(s.labels.filter((l) => l.item).length === 5, `both items' labels stay on screen after the tool closes (${s.labels.length})`);
	const second = s.items.find((i) => i.uuid !== item.uuid);
	h.check(!!second && Math.abs(dist(second.points[0], second.points[1]) - 1) < 1e-5, `the ✓-kept chain is the 1 m left edge (${second && dist(second.points[0], second.points[1]).toFixed(6)})`);
	await setView(A.page, { pos: [-4, 2.2, 3.2], target: [0, 0.5, 0] });
	s = await state(A.page);
	const after = s.labels.find((l) => l.key === before?.key);
	const expected = await h.projectPoint(A.page, [0, 1, 0.5]); // the front edge's midpoint
	h.check(!!after && Math.hypot(after.x - before.x, after.y - before.y) > 40, `the item's label moved with the camera (${before && before.x.toFixed(0)},${before && before.y.toFixed(0)} -> ${after && after.x.toFixed(0)},${after && after.y.toFixed(0)})`);
	// a segment label sits 15 px above its midpoint (measureCore.layoutLabels) when nothing crowds it
	h.check(!!after && Math.abs(after.x - expected.x) < 1.5 && Math.abs(after.y - (expected.y - 15)) < 1.5, `…and sits over the edge's midpoint in the new view (off by ${after ? Math.hypot(after.x - expected.x, after.y + 15 - expected.y).toFixed(2) : '—'} px)`);
	await h.eventually(() => state(B.page), (b) => b.items.length === 2, 'the measurements REPLICATED: B holds both items', 15000);
	const onB = await state(B.page);
	const bItem = onB.items.find((i) => i.uuid === item.uuid);
	h.check(!!bItem && bItem.points.every((p, k) => dist(p, item.points[k]) < 1e-5), `B holds the same points under the same uuid (A ${JSON.stringify(item.points)} B ${JSON.stringify(bItem?.points)})`);
	h.check(onB.labels.filter((l) => l.item).length >= 4, `B draws the item's labels (${onB.labels.length})`);
	// the object list lists it
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(500);
	const listed = await A.page.evaluate(() => (document.querySelector('#object-list')?.textContent ?? '').match(/Measurement/g)?.length ?? 0);
	h.check(listed >= 2, `the object list has a row per measurement (${listed})`);
	await A.page.evaluate(() => window.__stores.objectListClose.set(true));
	// no physics body: an empty node has no collider
	const colliders = await A.page.evaluate((u) => window.__stores.colliderSpec?.colliderSpecOf?.(window.__stores.measureItems.measurementOf(u)) ?? 'n/a', item.uuid);
	h.check(colliders === null || colliders === 'n/a', `a measurement has no collider spec (${JSON.stringify(colliders)})`);

	// --- 5. select by clicking its line; Tab edits its points with the same snapping ---
	await setView(A.page, VIEW);
	const mid = await h.projectPoint(A.page, [0, 1, 0.5]);
	const miss = { x: mid.x, y: mid.y + 40 };
	h.check((await underIsCanvas(A.page, mid)) && (await underIsCanvas(A.page, miss)), 'premise: the line and the miss point are bare viewport');
	const sel = () => A.page.evaluate(() => new Promise((r) => window.__stores.selectedObjects.subscribe(r)()));
	await click(A.page, miss); // on the box face, 40 px off the line
	h.check(!(await sel()).includes(item.uuid), 'COUNTERFACTUAL: a click 40 px off the line does not select the measurement');
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await click(A.page, mid);
	h.check((await sel()).includes(item.uuid), 'a click ON the line selects the measurement (over the box face it lies on)');
	await A.page.keyboard.press('Tab');
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(s.mode && s.editing?.uuid === item.uuid && s.editing.active === -1, `Tab on the selected measurement opens its EDITOR (${JSON.stringify(s.editing)})`);
	h.check((await A.page.evaluate(() => new Promise((r) => window.__stores.gizmoSuppressed.subscribe(r)()))) === true, 'no gizmo while editing (a press would move the whole item)');
	// pick up the middle point (the front-right corner) and put it on the back-left corner
	const pickAt = await h.projectPoint(A.page, CORNER_FR);
	const CORNER_BL = [-1, 1, -0.5];
	const putAt = await aimInside(A.page, CORNER_BL);
	// the editor's start toast can sit over the box for its few seconds — a click there is the toast's
	await h.eventually(async () => [await underOf(A.page, pickAt), await underOf(A.page, putAt)], (u) => u.every((x) => x === 'CANVAS'), 'premise: the pick and put points are bare viewport', 12000);
	// counterfactual: snapping OFF, the same pixels do not land on the corner
	await A.page.evaluate(() => window.__stores.measure.measureSnap.set(false));
	await click(A.page, pickAt);
	h.check((await state(A.page)).editing?.active === 1, 'a click on a point PICKS IT UP (point 2)');
	await click(A.page, putAt);
	let edited = (await state(A.page)).items.find((i) => i.uuid === item.uuid);
	const rawOff = edited ? dist(edited.points[1], CORNER_BL) : NaN;
	h.check(rawOff > 0.01, `COUNTERFACTUAL: placed with snapping off it misses the corner (${rawOff.toFixed(4)} m off)`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(300);
	edited = (await state(A.page)).items.find((i) => i.uuid === item.uuid);
	h.check(!!edited && dist(edited.points[1], CORNER_FR) < 1e-5, 'ONE undo puts the point back');
	await A.page.evaluate(() => window.__stores.measure.measureSnap.set(true));
	await click(A.page, pickAt);
	h.check((await state(A.page)).editing?.active === 1, 'premise: point 2 is picked up again');
	await click(A.page, putAt);
	edited = (await state(A.page)).items.find((i) => i.uuid === item.uuid);
	h.check(!!edited && dist(edited.points[1], CORNER_BL) < 1e-5, `with snapping on it lands EXACTLY on the corner (${edited && dist(edited.points[1], CORNER_BL).toExponential(2)})`);
	const st = edited ? [dist(edited.points[0], edited.points[1]), dist(edited.points[1], edited.points[2])] : [];
	h.check(Math.abs(st[0] - 1) < 1e-5 && Math.abs(st[1] - 2) < 1e-5, `the chain now reads 1 m then 2 m (${st.map((n) => n.toFixed(5))})`);
	await h.eventually(
		() => state(B.page),
		(b) => {
			const i = b.items.find((x) => x.uuid === item.uuid);
			return !!i && dist(i.points[1], CORNER_BL) < 1e-5;
		},
		'the edit REPLICATED to B',
		10000
	);
	// a click away from every point ADDS one at the end; Backspace removes it again — and does
	// NOT delete the selected item (the shortcut registry's Backspace = delete)
	await click(A.page, pFR);
	h.check((await state(A.page)).items.find((i) => i.uuid === item.uuid)?.points.length === 4, 'a click away from the points adds one at the end');
	await A.page.keyboard.press('Backspace');
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(s.items.find((i) => i.uuid === item.uuid)?.points.length === 3, 'Backspace in the editor removes the point…');
	h.check(s.items.length === 2, `…and does NOT delete the measurement (${s.items.length} items)`);
	await A.page.keyboard.press('Tab');
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(!s.mode && !s.editing, 'Tab again finishes editing');
	h.check((await A.page.evaluate(() => new Promise((r) => window.__stores.gizmoSuppressed.subscribe(r)()))) === false, 'the gizmo comes back on the item');

	// --- 6. labels of SHORT segments never overlap ---
	const shortUuid = await A.page.evaluate(() => {
		const pts = [[-1, 0, 1.2], [-0.97, 0, 1.2], [-0.94, 0, 1.2], [-0.91, 0, 1.2], [-0.88, 0, 1.2]];
		return window.__stores.measureItems.createMeasurement(pts)?.uuid;
	});
	await setView(A.page, { pos: [6, 6, 9], target: [0, 0.5, 0] });
	s = await state(A.page);
	const shortLabels = s.labels.filter((l) => l.key.startsWith(shortUuid));
	const overlaps = [];
	for (let i = 0; i < shortLabels.length; i++)
		for (let j = i + 1; j < shortLabels.length; j++) {
			const a = shortLabels[i].rect;
			const b = shortLabels[j].rect;
			if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) overlaps.push(shortLabels[i].text + '/' + shortLabels[j].text);
		}
	const anchorsPx = await Promise.all([[-0.985, 0, 1.2], [-0.955, 0, 1.2]].map((p) => h.projectPoint(A.page, p)));
	h.check(Math.hypot(anchorsPx[0].x - anchorsPx[1].x, anchorsPx[0].y - anchorsPx[1].y) < 30, 'premise: neighbouring segment midpoints are under 30 px apart (their pills would collide)');
	h.check(shortLabels.length >= 4 && overlaps.length === 0, `no two drawn labels overlap on a chain of 3 cm segments (${shortLabels.length} drawn, overlaps: ${overlaps.join(', ') || 'none'})`);
	if (process.env.SHOTS_DIR) await A.page.screenshot({ path: `${process.env.SHOTS_DIR}/03-measure-short-segments.png` });

	// --- 7. the touch tap path: B (phone) measures with two finger taps and keeps it ---
	// a portrait 380-px screen sees a narrow horizontal field: stand back so the whole box fits
	await setView(B.page, { pos: [6, 7, 9], target: [0, 0.5, 0] });
	await B.page.evaluate(() => window.__stores.measure.startMeasure());
	await B.page.waitForTimeout(500);
	const cdp = await B.ctx.newCDPSession(B.page);
	const qFL = await aimInside(B.page, CORNER_FL, TOP_CENTRE, 5);
	const qFR = await aimInside(B.page, CORNER_FR, TOP_CENTRE, 5);
	// the start toast can sit over the box on a 380-px screen for its few seconds
	await h.eventually(async () => [await underOf(B.page, qFL), await underOf(B.page, qFR)], (u) => u.every((x) => x === 'CANVAS'), 'premise: both tap points are bare viewport on the phone', 12000);
	await tap(cdp, qFL);
	await tap(cdp, qFR);
	s = await state(B.page);
	const tapped = s.cur?.points.length === 2 ? dist(s.cur.points[0], s.cur.points[1]) : NaN;
	h.check(Math.abs(tapped - 2) < 1e-5, `two finger taps measure the snapped 2 m edge on the phone (${tapped.toFixed(6)}, snaps ${JSON.stringify(s.cur?.snaps)})`);
	const keepBox = await B.page.locator('#measure-pin').boundingBox();
	h.check(!!keepBox, 'the phone shows the Measure sheet with its Keep command');
	const bItems = s.items.length;
	if (keepBox) await tap(cdp, { x: keepBox.x + keepBox.width / 2, y: keepBox.y + keepBox.height / 2 });
	s = await state(B.page);
	h.check(s.items.length === bItems + 1, `a tap on Keep keeps it on the phone (${bItems} -> ${s.items.length})`);
	await h.eventually(() => state(A.page), (a) => a.items.length === bItems + 1, 'the phone\'s measurement reaches A', 10000);
	await B.page.evaluate(() => window.__stores.measure.stopMeasure({ keep: false }));

	// --- 8. save / load, and the late-joiner send path ---
	const itemCount = (await state(A.page)).items.length;
	const zip = await A.page.evaluate(async () => {
		const ss = window.__stores.sessions;
		const out = await ss.exportSessionZip(ss.buildSessionPayload('Measured'));
		return Array.from(new Uint8Array(out instanceof Blob ? await out.arrayBuffer() : out));
	});
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(800);
	h.check((await state(A.page)).items.length === 0, 'premise: the scene is cleared');
	await A.page.evaluate(async (arr) => {
		const ss = window.__stores.sessions;
		await ss.applySession(await ss.readSessionZip(new Uint8Array(arr).buffer), { backup: false });
	}, zip);
	await h.eventually(() => state(A.page), (a) => a.items.length === itemCount, `a save/load round trip brings back all ${itemCount} measurements`, 15000);
	const reloaded = (await state(A.page)).items.find((i) => i.uuid === item.uuid);
	h.check(!!reloaded && dist(reloaded.points[1], CORNER_BL) < 1e-5, 'with their edited points');
	const sent = await A.page.evaluate(() => {
		const out = [];
		window.__stores.commandsHandler.sendObject({ send: (m) => out.push(m) });
		return out.filter((m) => m.type === 'object' && m.element?.object?.userData?.measure).map((m) => m.element.object.userData.measure.points.length);
	});
	h.check(sent.length === itemCount, `the late-joiner sync sends every measurement as toJSON with its record (${sent.length} of ${itemCount})`);

	// --- 9. Delete measurements: every item, one undo ---
	await A.page.evaluate(() => window.__stores.measureItems.deleteAllMeasurements());
	await A.page.waitForTimeout(500);
	h.check((await state(A.page)).items.length === 0, 'Delete measurements removes every item');
	await h.eventually(() => state(B.page), (b) => b.items.length === 0, '…on B too', 10000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => state(A.page), (a) => a.items.length === itemCount, 'ONE undo brings them all back', 10000);

	await h.finish(browser);
});
