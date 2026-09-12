// 24-F1: pen pressure in the UV editor. `paintMove` drew every segment at one width;
// points were `[u, v]` and the component never read `pressure` or `pointerType`. Now a
// pen's pressure rides each point as an OPTIONAL third number (absent = 1, so a mouse
// stroke's wire is byte-identical), the segment takes its width (or, in opacity mode,
// its alpha) from its end point, every coalesced sample becomes a dab, and peers draw
// the same widths from the same numbers.
const h = require('./helpers.cjs');

const openOnBox = async (page) => {
	const uuid = await page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'painted';
		w.objectActions.selectObject(box.uuid);
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
		w.uvEditor.uvTool.set('paint');
		w.uvEditor.uvBrushSize.set(40);
		w.uvEditor.uvBrushColor.set('#ff3b30');
		return box.uuid;
	});
	await page.waitForTimeout(800);
	return uuid;
};

/** a synthetic stroke on the UV canvas: `pointerType`, a pressure ramp, `n` samples */
const stroke = (page, { v, from, to, n, pointerType, p0, p1 }) =>
	page.evaluate(
		async ({ v, from, to, n, pointerType, p0, p1 }) => {
			const el = document.getElementById('uv-canvas');
			const r = el.getBoundingClientRect();
			const P = (u, vv) => window.__uvDebug().project(u, vv);
			const at = (i) => P(from + ((to - from) * i) / n, v);
			const opt = (pt, pressure) => ({ clientX: r.left + pt.x, clientY: r.top + pt.y, bubbles: true, pointerId: 7, pointerType, pressure, buttons: 1 });
			el.dispatchEvent(new PointerEvent('pointerdown', opt(at(0), p0)));
			await new Promise((res) => setTimeout(res, 160)); // the stroke opens async
			const dbg = window.__uvDebug?.();
			window.__strokeState = { gesture: dbg?.gesture, tool: dbg?.tool, painting: window.__stores.uvEditor.painting(), hasEl: !!el };
			for (let i = 1; i <= n; i++) {
				window.dispatchEvent(new PointerEvent('pointermove', opt(at(i), p0 + ((p1 - p0) * i) / n)));
				await new Promise((res) => setTimeout(res, 60)); // slower than the wire throttle: peers see it live
			}
			await new Promise((res) => setTimeout(res, 400)); // let the throttled tail flush
			return true;
		},
		{ v, from, to, n, pointerType, p0, p1 }
	);
const release = (page, u, v) =>
	page.evaluate(({ u, v }) => {
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		const pt = window.__uvDebug().project(u, v);
		window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + pt.x, clientY: r.top + pt.y, bubbles: true, pointerId: 7 }));
	}, { u, v });

/** painted run height (px) at a column, on the live paint canvas */
const runAt = (page, uuid, u, v, tint = false) =>
	page.evaluate(
		({ uuid, u, v, tint }) => {
			// the live paint canvas — on a peer it is the CanvasTexture installed as the map
			let c = window.__stores.uvEditor.paintPreviewCanvas(uuid, 0);
			if (!c) {
				let g;
				window.__stores.objectsGroup.subscribe((x) => (g = x))();
				const o = g?.getObjectByProperty('uuid', uuid);
				const m = Array.isArray(o?.material) ? o.material[0] : o?.material;
				const img = m?.map?.image;
				if (img && typeof img.getContext === 'function') c = img;
				else if (img && img.naturalWidth) {
					// a committed texture (an Image): decode it onto a canvas of its own size
					c = document.createElement('canvas');
					c.width = img.naturalWidth;
					c.height = img.naturalHeight;
					c.getContext('2d').drawImage(img, 0, 0);
				}
			}
			if (!c) return null;
			const ctx = c.getContext('2d', { willReadFrequently: true });
			const x = Math.round(u * c.width);
			const data = ctx.getImageData(x, 0, 1, c.height).data;
			// `tint`: anything painted at all (an opacity stroke's edges are pale), else
			// the brush's red
			const red = (y) => {
				const rr = data[y * 4];
				const gg = data[y * 4 + 1];
				return tint ? gg < 245 && rr >= gg : rr > 150 && gg < 140 && rr - gg > 60;
			};
			// count ONLY in a band around this stroke's row (other strokes share the
			// column); the canvas may or may not flip V, so take the better of the two rows
			const band = 70;
			const countAround = (yy) => {
				let n = 0;
				for (let y = Math.max(0, yy - band); y < Math.min(c.height, yy + band); y++) if (red(y)) n++;
				return n;
			};
			const rows = [Math.round((1 - v) * c.height), Math.round(v * c.height)];
			const counts = rows.map(countAround);
			const best = counts[0] >= counts[1] ? 0 : 1;
			const yy = rows[best];
			const px = ctx.getImageData(x, Math.max(0, Math.min(c.height - 1, yy)), 1, 1).data;
			return { count: counts[best], row: yy, height: c.height, width: c.width, px: [px[0], px[1], px[2]] };
		},
		{ uuid, u, v, tint }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const uuid = await openOnBox(A.page);
	h.check(!!uuid, 'premise: a box is open in the UV editor with Paint armed');
	// spy on the wire: every uvpaint message A sends
	await A.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		window.__sent = [];
		const raw = p.send.bind(p);
		p.send = (d) => { if (d?.type === 'uvpaint') window.__sent.push(JSON.parse(JSON.stringify(d))); return raw(d); };
	});
	const sent = () => A.page.evaluate(() => { const s = window.__sent; window.__sent = []; return s; });

	// ---- 1. a PEN stroke, pressure 0.1 -> 0.9: wider at the end ------------------------
	await stroke(A.page, { v: 0.7, from: 0.15, to: 0.85, n: 12, pointerType: 'pen', p0: 0.1, p1: 0.9 });
	const opened = await A.page.evaluate(() => window.__strokeState);
	h.check(opened?.gesture === 'paint' && opened?.painting === true, `premise: the pen's pointerdown opened a paint stroke (${JSON.stringify(opened)})`);
	// B draws the live segments as they arrive over the wire — before A commits
	let bStart = null;
	let bEnd = null;
	await h.eventually(
		async () => {
			bStart = await runAt(B.page, uuid, 0.25, 0.7);
			bEnd = await runAt(B.page, uuid, 0.75, 0.7);
			const aSent = await A.page.evaluate(() => window.__sent.length);
			const bbox = (page) => page.evaluate((u) => { const w = window.__stores; let g; w.objectsGroup.subscribe((x) => (g = x))(); const o = g.getObjectByProperty('uuid', u); const m = o && (Array.isArray(o.material) ? o.material[0] : o.material); let c = w.uvEditor.paintPreviewCanvas(u, 0); const img = m?.map?.image; if (!c && img && typeof img.getContext === 'function') c = img; if (!c) return { live: w.uvEditor.liveStrokeCount(), canvas: null }; const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; for (let i = 0; i < d.length; i += 4) { if (d[i] > 150 && d[i + 1] < 140) { n++; const p = i / 4; const x = p % c.width; const y = (p - x) / c.width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return { live: w.uvEditor.liveStrokeCount(), canvas: c.width + 'x' + c.height, red: n, box: n ? [x0, y0, x1, y1] : null, mapImg: img ? (img.tagName || img.constructor?.name) : null, previewNull: !w.uvEditor.paintPreviewCanvas(u, 0) }; }, uuid);
			const bState = await bbox(B.page);
			const aState = await bbox(A.page);
			return { s: bStart?.count ?? 0, e: bEnd?.count ?? 0, aSent, bState, aState };
		},
		(r) => r.s > 0 && r.e > r.s * 1.5,
		'peer B is drawing the live stroke with the same widening',
		12000
	);
	await release(A.page, 0.85, 0.7);
	await A.page.waitForTimeout(900);
	const start = await runAt(A.page, uuid, 0.25, 0.7);
	const end = await runAt(A.page, uuid, 0.75, 0.7);
	h.check(!!start && start.count > 0 && !!end && end.count > start.count * 1.5, `the pen stroke is wider where the pressure was higher (${start?.count}px -> ${end?.count}px of a ${start?.height}px canvas)`);
	const penWire = await sent();
	const penPoints = penWire.flatMap((m) => m.seg);
	h.check(penWire.length > 0 && penPoints.some((pt) => pt.length === 3 && pt[2] < 1), `the wire carries the pressure as an optional third number (${penPoints.filter((pt) => pt.length === 3).length}/${penPoints.length} points)`);
	h.check(penWire.every((m) => m.pmode === undefined), 'size mode sends no pmode (absent = the default)');
	console.log(`  (B live widths ${bStart?.count}px -> ${bEnd?.count}px)`);

	// ---- 2. a MOUSE stroke is uniform, and its wire has no third number --------------
	await stroke(A.page, { v: 0.3, from: 0.15, to: 0.85, n: 12, pointerType: 'mouse', p0: 0.5, p1: 0.5 });
	await release(A.page, 0.85, 0.3);
	await A.page.waitForTimeout(900);
	const mStart = await runAt(A.page, uuid, 0.25, 0.3);
	const mEnd = await runAt(A.page, uuid, 0.75, 0.3);
	h.check(!!mStart && mStart.count > 0 && Math.abs(mStart.count - mEnd.count) <= Math.max(2, mStart.count * 0.15), `a mouse stroke is uniform (${mStart?.count}px / ${mEnd?.count}px)`);
	h.check(Math.abs(mStart.count - 40) <= 6, `...at the brush size in texture pixels (${mStart?.count} ~ 40)`);
	const mouseWire = await sent();
	h.check(mouseWire.length > 0 && mouseWire.flatMap((m) => m.seg).every((pt) => pt.length === 2) && mouseWire.every((m) => m.pmode === undefined), 'a mouse stroke sends plain [u, v] points — byte-identical to before');

	// ---- 3. opacity mode: the alpha varies instead, and the mode rides the wire --------
	await A.page.evaluate(() => window.__stores.uvEditor.uvPenPressure.set('opacity'));
	await stroke(A.page, { v: 0.5, from: 0.15, to: 0.85, n: 12, pointerType: 'pen', p0: 0.25, p1: 0.25 });
	await release(A.page, 0.85, 0.5);
	await A.page.waitForTimeout(900);
	const oStart = await runAt(A.page, uuid, 0.25, 0.5, true);
	const oEnd = await runAt(A.page, uuid, 0.75, 0.5, true);
	const opacityWire = await sent();
	h.check(opacityWire.length > 0 && opacityWire.every((m) => m.pmode === 'opacity'), 'opacity mode sends pmode: "opacity"');
	h.check(!!oStart && oStart.px[1] > 110 && oStart.px[0] > oStart.px[1], `a light touch in opacity mode paints a TINT, not the full colour (rgb ${oStart?.px.join(',')})`);
	h.check(!!oStart && !!oEnd && Math.abs(oStart.count - 40) <= 8 && Math.abs(oStart.count - oEnd.count) <= Math.max(2, oStart.count * 0.15), `...at the full brush width (${oStart?.count}px / ${oEnd?.count}px ~ 40)`);

	// ---- 4. off: a pen paints like a mouse ---------------------------------------------
	await A.page.evaluate(() => window.__stores.uvEditor.uvPenPressure.set('off'));
	await stroke(A.page, { v: 0.9, from: 0.15, to: 0.85, n: 8, pointerType: 'pen', p0: 0.1, p1: 0.9 });
	await release(A.page, 0.85, 0.9);
	await A.page.waitForTimeout(700);
	const offWire = await sent();
	h.check(offWire.length > 0 && offWire.flatMap((m) => m.seg).every((pt) => pt.length === 2), 'with pressure off a pen sends plain points');

	// ---- 5. the tool panel's three-way ---------------------------------------------------
	const panel = await A.page.evaluate(() => {
		const group = document.querySelector('#uv-pen-pressure');
		return group ? [...group.querySelectorAll('[role="radio"]')].map((b) => b.dataset.value + (b.getAttribute('aria-checked') === 'true' ? '✓' : '')) : null;
	});
	h.check(!!panel && panel.includes('off✓') && panel.length === 3, `the Brush panel offers Size / Opacity / Off (${JSON.stringify(panel)})`);
	await A.page.click('#uv-pen-pressure [data-value="size"]');
	await A.page.waitForTimeout(150);
	h.check((await A.page.evaluate(() => { let v; window.__stores.uvEditor.uvPenPressure.subscribe((x) => (v = x))(); return v; })) === 'size', 'clicking Size sets the pref back');

	// ---- 6. the committed texture matches on both peers (the uv-paint comparison) ------
	await h.eventually(
		() => Promise.all([A.page, B.page].map((page) => page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); const o = g.getObjectByProperty('uuid', u); const m = Array.isArray(o.material) ? o.material[0] : o.material; return m?.userData?.mapDataUrl?.length ?? 0; }, uuid))),
		([a, b]) => a > 0 && a === b,
		"peer B's committed texture is A's (same data URL length)",
		15000
	);

	await h.finish(browser);
});
