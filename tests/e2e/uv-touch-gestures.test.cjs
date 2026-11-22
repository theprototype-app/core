// 103 H2 — the UV editor and the image preview on TOUCH, with synthetic touch / pen pointer events:
//   - the wheel zooms toward the pointer (UV editor: kept; image preview: it zoomed about the centre)
//   - one finger uses the active tool (paints, before any pen is seen)
//   - a SECOND finger cancels the open stroke — no stray dot here or on the peer — and pinch-zooms about the
//     fingers' centre, panning as the centre moves; the stroke never resumes
//   - once a pen is seen, a finger in Paint pans and paints nothing ("Pen only draws", on by default); turned off,
//     fingers paint again
//   - a palm landing while the pen paints is ignored: the pen's stroke runs to its end
//   - the image preview pinch-zooms about the fingers' centre
//
// COUNTERFACTUAL: on the base the second finger's pointerdown starts a new stroke over the first (a stray dot, and
// the peer's preview keeps it), the pinch does nothing, a finger keeps painting after a pen, a palm's pointerup
// ends the pen's stroke, and the preview's wheel zoom moves the point under the pointer.
const h = require('./helpers.cjs');

const openOnBox = async (page) => {
	const uuid = await page.evaluate(async () => {
		const w = window.__tp?.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'touch-box';
		w.objectActions.selectObject(box.uuid);
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
		w.uvEditor.uvTool.set('paint');
		w.uvEditor.uvBrushSize.set(30);
		w.uvEditor.uvBrushColor.set('#1060ff');
		w.uvEditor.uvPenPressure.set('size');
		return box.uuid;
	});
	await page.waitForTimeout(1500);
	return uuid;
};

/** dispatch one pointer event at UV (u, v) on the UV canvas (down on the canvas, move/up on window) */
const ev = (page, type, u, v, o) =>
	page.evaluate(
		({ type, u, v, o }) => {
			const el = document.getElementById('uv-canvas');
			const r = el.getBoundingClientRect();
			const p = window.__uvDebug().project(u, v);
			const init = { clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true, pointerId: o.id, pointerType: o.type, pressure: o.pressure ?? 0.5, buttons: type === 'pointerup' ? 0 : 1, isPrimary: !!o.primary };
			(type === 'pointerdown' ? el : window).dispatchEvent(new PointerEvent(type, init));
		},
		{ type, u, v, o }
	);
/** the same at a screen point (view px) */
const evXY = (page, type, x, y, o) =>
	page.evaluate(
		({ type, x, y, o }) => {
			const el = document.getElementById('uv-canvas');
			const r = el.getBoundingClientRect();
			const init = { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: o.id, pointerType: o.type, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1 };
			(type === 'pointerdown' ? el : window).dispatchEvent(new PointerEvent(type, init));
		},
		{ type, x, y, o }
	);
const dbg = (page) => page.evaluate(() => { const d = window.__uvDebug(); return { zoom: d.zoom, panX: d.panX, panY: d.panY, gesture: d.gesture, viewW: d.viewW, viewH: d.viewH, p: d.project(0.5, 0.5) }; });
const wait = (page, ms) => page.waitForTimeout(ms);

/** how many pixels in a UV box are the brush blue: the live canvas, else the committed map */
const blueIn = (page, uuid, u0, u1, v0, v1) =>
	page.evaluate(
		async ({ uuid, u0, u1, v0, v1 }) => {
			const w = window.__tp.test.v1;
			let g;
			w.objectsGroup.subscribe((x) => (g = x))();
			const o = g?.getObjectByProperty('uuid', uuid);
			const m = Array.isArray(o?.material) ? o.material[0] : o?.material;
			let c = w.uvEditor.paintPreviewCanvas(uuid, 0);
			const img = m?.map?.image;
			if (!c && img && typeof img.getContext === 'function') c = img;
			if (!c && img) {
				// an <img> still decoding: wait (bounded); an ImageBitmap / canvas has no `complete` and is ready
				if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement && !img.complete)
					await new Promise((r) => { img.addEventListener('load', r, { once: true }); setTimeout(r, 5000); });
				c = document.createElement('canvas');
				c.width = img.naturalWidth || img.width;
				c.height = img.naturalHeight || img.height;
				c.getContext('2d').drawImage(img, 0, 0);
			}
			if (!c) return 0;
			const x0 = Math.floor(u0 * c.width);
			const x1 = Math.ceil(u1 * c.width);
			const y0 = Math.floor((1 - v1) * c.height);
			const y1 = Math.ceil((1 - v0) * c.height);
			const d = c.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, x1 - x0, y1 - y0).data;
			let n = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 180 && d[i] < 120) n++;
			return n;
		},
		{ uuid, u0, u1, v0, v1 }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const page = A.page;
	const uuid = await openOnBox(page);
	h.check(!!uuid, 'premise: a box in the UV editor, Paint armed');
	await page.evaluate(() => window.__tp.test.v1.penInput.penSeen.set(false));

	// ---- 1. the wheel zooms toward the pointer ---------------------------------------------------------------------
	const before = await page.evaluate(() => window.__uvDebug().project(0.25, 0.75));
	await page.evaluate(({ x, y }) => {
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		el.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + x, clientY: r.top + y, deltaY: -100, bubbles: true, cancelable: true }));
	}, before);
	const afterWheel = await page.evaluate(() => ({ p: window.__uvDebug().project(0.25, 0.75), zoom: window.__uvDebug().zoom }));
	h.check(afterWheel.zoom > 1.05 && Math.hypot(afterWheel.p.x - before.x, afterWheel.p.y - before.y) < 1, `UV editor: the wheel zooms toward the pointer (zoom ${afterWheel.zoom.toFixed(2)}, the point under it moved ${Math.hypot(afterWheel.p.x - before.x, afterWheel.p.y - before.y).toFixed(2)} px)`);
	// back to 1:1: one wheel step out at the same point
	await page.evaluate(({ x, y }) => {
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		el.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + x, clientY: r.top + y, deltaY: 100, bubbles: true, cancelable: true }));
	}, before);

	// ---- 2. one finger paints (no pen seen yet) --------------------------------------------------------------------
	const F1 = { id: 21, type: 'touch', primary: true };
	await ev(page, 'pointerdown', 0.15, 0.85, F1);
	await wait(page, 200);
	for (let i = 1; i <= 8; i++) {
		await ev(page, 'pointermove', 0.15 + i * 0.03, 0.85, F1);
		await wait(page, 30);
	}
	await ev(page, 'pointerup', 0.39, 0.85, F1);
	await wait(page, 700);
	const finger = await blueIn(page, uuid, 0.15, 0.4, 0.8, 0.9);
	h.check(finger > 500, `one finger paints with the active tool before any pen is seen (${finger} blue px)`);

	// ---- 3. a second finger: the open stroke is CANCELLED (here and on B), then the pinch zooms about the centre ----
	await ev(page, 'pointerdown', 0.6, 0.3, F1);
	await wait(page, 200);
	for (let i = 1; i <= 5; i++) {
		await ev(page, 'pointermove', 0.6 + i * 0.02, 0.3, F1);
		await wait(page, 40);
	}
	await wait(page, 300); // past the 66 ms throttle: B has the live segments
	const liveOnB = await blueIn(B.page, uuid, 0.55, 0.75, 0.25, 0.35);
	h.check(liveOnB > 50, `premise: B draws the first finger's live stroke (${liveOnB} blue px)`);
	const v0 = await dbg(page);
	// the second finger lands; the fingers' centre is the view centre's neighbourhood
	const c = { x: v0.viewW / 2, y: v0.viewH / 2 };
	const F2 = { id: 22, type: 'touch' };
	// move finger 1 to (c.x - 40) so the pinch starts from known points
	await evXY(page, 'pointermove', c.x - 40, c.y, F1);
	await evXY(page, 'pointerdown', c.x + 40, c.y, F2);
	await wait(page, 100);
	const pinchStart = await dbg(page);
	h.check(pinchStart.gesture === 'pinch', `two fingers start a pinch (gesture ${pinchStart.gesture})`);
	const uvUnder = await page.evaluate(({ x, y }) => { const d = window.__uvDebug(); return { u: (x - (d.project(0, 0).x)) / (d.project(1, 0).x - d.project(0, 0).x), v: (y - d.project(0, 1).y) / (d.project(0, 0).y - d.project(0, 1).y) }; }, c);
	await wait(page, 400);
	const strayA = await blueIn(page, uuid, 0.55, 0.75, 0.25, 0.35);
	h.check(strayA === 0, `the first finger's stroke is cancelled — no stray dot (${strayA} blue px)`);
	await h.eventually(() => blueIn(B.page, uuid, 0.55, 0.75, 0.25, 0.35), (n) => n === 0, "...and peer B's live preview of it is gone too", 8000);
	// spread the fingers 80 -> 160 px: zoom x2 about the centre
	for (let k = 1; k <= 4; k++) {
		await evXY(page, 'pointermove', c.x - 40 - k * 10, c.y, F1);
		await evXY(page, 'pointermove', c.x + 40 + k * 10, c.y, F2);
	}
	await wait(page, 100);
	const spread = await dbg(page);
	const zr = spread.zoom / pinchStart.zoom;
	h.check(Math.abs(zr - 2) < 0.05, `spreading the fingers to twice their distance doubles the zoom (x${zr.toFixed(3)})`);
	const centreNow = await page.evaluate(({ u, v }) => window.__uvDebug().project(u, 1 - v), uvUnder);
	h.check(Math.hypot(centreNow.x - c.x, centreNow.y - c.y) < 1.5, `...about the fingers' centre: the UV point under it stays (${Math.hypot(centreNow.x - c.x, centreNow.y - c.y).toFixed(2)} px off)`);
	// move both fingers 30 px right: a pan
	await evXY(page, 'pointermove', c.x - 80 + 30, c.y, F1);
	await evXY(page, 'pointermove', c.x + 80 + 30, c.y, F2);
	await wait(page, 50);
	const panned = await dbg(page);
	h.check(Math.abs(panned.p.x - spread.p.x - 30) < 1.5 && Math.abs(panned.zoom - spread.zoom) < 1e-6, `moving both fingers pans the view with them (${(panned.p.x - spread.p.x).toFixed(1)} px of 30)`);
	await evXY(page, 'pointerup', c.x + 110, c.y, F2);
	await wait(page, 50);
	// the finger left on the glass does nothing: moving it neither paints nor pans
	const held = await dbg(page);
	await evXY(page, 'pointermove', c.x - 20, c.y + 40, F1);
	await wait(page, 50);
	const held2 = await dbg(page);
	await evXY(page, 'pointerup', c.x - 20, c.y + 40, F1);
	await wait(page, 600);
	h.check(held.gesture === 'idle' && held2.panX === held.panX && held2.zoom === held.zoom, `lifting a finger ends the pinch; the one left does nothing (gesture ${held.gesture})`);
	const strayAfter = await blueIn(page, uuid, 0.55, 0.75, 0.25, 0.35);
	h.check(strayAfter === 0, `nothing was painted by the pinch (${strayAfter} blue px)`);

	// ---- 4. once a pen is seen, a finger pans and paints nothing --------------------------------------------------
	const PEN = { id: 31, type: 'pen', pressure: 0.6, primary: true };
	await ev(page, 'pointerdown', 0.1, 0.1, PEN);
	await wait(page, 200);
	for (let i = 1; i <= 6; i++) {
		await ev(page, 'pointermove', 0.1 + i * 0.03, 0.1, PEN);
		await wait(page, 30);
	}
	await ev(page, 'pointerup', 0.28, 0.1, PEN);
	await wait(page, 600);
	const seen = await page.evaluate(() => { let v; window.__tp.test.v1.penInput.penSeen.subscribe((x) => (v = x))(); return v; });
	h.check(seen === true, 'a pen event switches "Pen only draws" on');
	const note = await page.evaluate(() => !!document.getElementById('uv-pen-only-note'));
	h.check(note, '...and the brush panel says so');
	const p0 = await dbg(page);
	await ev(page, 'pointerdown', 0.6, 0.6, F1);
	await wait(page, 200);
	for (let i = 1; i <= 6; i++) {
		await ev(page, 'pointermove', 0.6 + i * 0.03, 0.6, F1);
		await wait(page, 30);
	}
	const fingerPanned = await dbg(page);
	await ev(page, 'pointerup', 0.8, 0.6, F1);
	await wait(page, 600);
	const fingerPaint = await blueIn(page, uuid, 0.55, 0.85, 0.5, 0.7);
	h.check(fingerPaint === 0 && fingerPanned.gesture === 'pan' && fingerPanned.panX !== p0.panX, `with a pen seen a finger pans (gesture ${fingerPanned.gesture}, pan ${p0.panX} -> ${fingerPanned.panX}) and paints nothing (${fingerPaint} px)`);

	// ---- 5. the setting off: fingers paint again ----------------------------------------------------------------
	await page.click('#uv-pen-only');
	await wait(page, 150);
	await ev(page, 'pointerdown', 0.6, 0.6, F1);
	await wait(page, 200);
	for (let i = 1; i <= 6; i++) {
		await ev(page, 'pointermove', 0.6 + i * 0.03, 0.6, F1);
		await wait(page, 30);
	}
	await ev(page, 'pointerup', 0.78, 0.6, F1);
	await wait(page, 700);
	const fingerAgain = await blueIn(page, uuid, 0.55, 0.85, 0.5, 0.7);
	h.check(fingerAgain > 300, `with "Pen only draws" off a finger paints again (${fingerAgain} blue px)`);
	await page.click('#uv-pen-only');

	// ---- 6. a palm while the pen paints: ignored, the pen's stroke runs to its end -------------------------------
	const PALM = { id: 41, type: 'touch' };
	await ev(page, 'pointerdown', 0.1, 0.45, PEN);
	await wait(page, 200);
	for (let i = 1; i <= 12; i++) {
		await ev(page, 'pointermove', 0.1 + i * 0.03, 0.45, PEN);
		if (i === 4) await ev(page, 'pointerdown', 0.9, 0.9, PALM);
		if (i === 6) await ev(page, 'pointerup', 0.9, 0.9, PALM);
		await wait(page, 30);
	}
	const midPalm = await dbg(page);
	await ev(page, 'pointerup', 0.46, 0.45, PEN);
	await wait(page, 700);
	const tail = await blueIn(page, uuid, 0.36, 0.46, 0.4, 0.5);
	h.check(midPalm.gesture === 'paint' && tail > 100, `a palm landing and lifting under the pen does not end its stroke (gesture ${midPalm.gesture}, the stroke's tail has ${tail} blue px)`);

	// ---- 7. the image preview: the wheel and a pinch zoom toward the pointer / the fingers' centre ---------------
	await page.evaluate(() => {
		const c = document.createElement('canvas');
		c.width = 200;
		c.height = 100;
		const x = c.getContext('2d');
		x.fillStyle = '#336699';
		x.fillRect(0, 0, 200, 100);
		window.__tp.test.v1.fileWindows.openFilePreview({ title: 'touch.png', kind: 'image', url: c.toDataURL('image/png') });
	});
	await page.waitForSelector('#preview-body img', { timeout: 10000 });
	await wait(page, 500);
	const frac = (x, y) => page.evaluate(({ x, y }) => { const r = document.querySelector('#preview-body img').getBoundingClientRect(); return { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, w: r.width }; }, { x, y });
	const body = await page.evaluate(() => { const r = document.querySelector('#preview-body').getBoundingClientRect(); const i = document.querySelector('#preview-body img').getBoundingClientRect(); return { x: i.left + i.width * 0.25, y: i.top + i.height * 0.3, bx: r.left + r.width / 2, by: r.top + r.height / 2 }; });
	const f0 = await frac(body.x, body.y);
	await page.evaluate(({ x, y }) => document.querySelector('#preview-body').dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: -100, bubbles: true, cancelable: true })), body);
	await wait(page, 150);
	const f1 = await frac(body.x, body.y);
	h.check(f1.w > f0.w * 1.05 && Math.abs(f1.fx - f0.fx) < 0.01 && Math.abs(f1.fy - f0.fy) < 0.01, `image preview: the wheel zooms toward the pointer (width ${Math.round(f0.w)} -> ${Math.round(f1.w)}, the image point under it ${f0.fx.toFixed(3)},${f0.fy.toFixed(3)} -> ${f1.fx.toFixed(3)},${f1.fy.toFixed(3)})`);
	const tp = (type, id, x, y) => page.evaluate(({ type, id, x, y }) => document.querySelector('#preview-body').dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: id, pointerType: 'touch', buttons: type === 'pointerup' ? 0 : 1 })), { type, id, x, y });
	const pc = { x: body.bx + 30, y: body.by - 10 };
	const g0 = await frac(pc.x, pc.y);
	await tp('pointerdown', 51, pc.x - 30, pc.y);
	await tp('pointerdown', 52, pc.x + 30, pc.y);
	for (let k = 1; k <= 3; k++) {
		await tp('pointermove', 51, pc.x - 30 - k * 10, pc.y);
		await tp('pointermove', 52, pc.x + 30 + k * 10, pc.y);
	}
	await tp('pointerup', 51, pc.x - 60, pc.y);
	await tp('pointerup', 52, pc.x + 60, pc.y);
	await wait(page, 150);
	const g1 = await frac(pc.x, pc.y);
	h.check(Math.abs(g1.w / g0.w - 2) < 0.05 && Math.abs(g1.fx - g0.fx) < 0.01 && Math.abs(g1.fy - g0.fy) < 0.01, `image preview: a pinch to twice the spread doubles the zoom about the fingers' centre (x${(g1.w / g0.w).toFixed(3)}, point ${g0.fx.toFixed(3)} -> ${g1.fx.toFixed(3)})`);

	await h.finish(browser);
});
