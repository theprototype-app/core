// 103 H1 — UV paint: pen pressure -> OPACITY works. The owner's N6 report: pressure -> size worked, pressure ->
// opacity did not — a light touch still painted the full colour. The shipped painter stroked every segment at its
// own alpha with round caps, so overlapping segments (a real pen sends many short ones) stacked to opaque; 102's
// stroke layer multiplied the pressure into the flow, which sums the same way. Now a pen stroke whose pressure
// drives opacity paints through ONE stroke layer whose pixels move toward each dab's pressure and never past it
// (max, not sum), composited once. Also: the new Size + opacity mode, the mode on the wire, a second peer's live
// preview and committed texture, and a reload.
//
// COUNTERFACTUAL (§1): on the base (v1.72.0 + 102-paint) the dense light stroke's centre reads green ~90 (opaque
// red); the check below asks for > 150 (a tint).
const h = require('./helpers.cjs');

const openOnBox = async (page) => {
	const uuid = await page.evaluate(async () => {
		const w = window.__tp?.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'pressure-box';
		w.objectActions.selectObject(box.uuid);
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
		w.uvEditor.uvTool.set('paint');
		w.uvEditor.uvBrushSize.set(40);
		w.uvEditor.uvBrushColor.set('#ff3b30');
		return box.uuid;
	});
	// Paint armed loads the painter chunk; give it a moment so §1 also covers the loaded path
	await page.waitForTimeout(1500);
	return uuid;
};

/** a synthetic stroke on the UV canvas: `n` short moves, a pressure ramp p0 -> p1 */
const stroke = (page, { v, from, to, n, pointerType, p0, p1, gap = 30 }) =>
	page.evaluate(
		async ({ v, from, to, n, pointerType, p0, p1, gap }) => {
			const el = document.getElementById('uv-canvas');
			const r = el.getBoundingClientRect();
			const P = (u, vv) => window.__uvDebug().project(u, vv);
			const at = (i) => P(from + ((to - from) * i) / n, v);
			const opt = (pt, pressure) => ({ clientX: r.left + pt.x, clientY: r.top + pt.y, bubbles: true, pointerId: 7, pointerType, pressure, buttons: 1, isPrimary: true });
			el.dispatchEvent(new PointerEvent('pointerdown', opt(at(0), p0)));
			await new Promise((res) => setTimeout(res, 160));
			for (let i = 1; i <= n; i++) {
				window.dispatchEvent(new PointerEvent('pointermove', opt(at(i), p0 + ((p1 - p0) * i) / n)));
				await new Promise((res) => setTimeout(res, gap));
			}
			await new Promise((res) => setTimeout(res, 300));
			const last = at(n);
			window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + last.x, clientY: r.top + last.y, bubbles: true, pointerId: 7, pointerType }));
			return true;
		},
		{ v, from, to, n, pointerType, p0, p1, gap }
	);

/** the pixel at (u, v) and the painted run height in its column: live paint canvas, else the committed map */
const sample = (page, uuid, u, v) =>
	page.evaluate(
		async ({ uuid, u, v }) => {
			const w = window.__tp.test.v1;
			let g;
			w.objectsGroup.subscribe((x) => (g = x))();
			const o = g?.getObjectByProperty('uuid', uuid);
			const m = Array.isArray(o?.material) ? o.material[0] : o?.material;
			let c = w.uvEditor.paintPreviewCanvas(uuid, 0);
			const img = m?.map?.image;
			if (!c && img && typeof img.getContext === 'function') c = img;
			if (!c && img) {
				if (!img.complete) await new Promise((r) => (img.onload = r));
				c = document.createElement('canvas');
				c.width = img.naturalWidth || img.width;
				c.height = img.naturalHeight || img.height;
				c.getContext('2d').drawImage(img, 0, 0);
			}
			if (!c) return null;
			const ctx = c.getContext('2d', { willReadFrequently: true });
			const x = Math.round(u * c.width);
			const y = Math.round((1 - v) * c.height); // a Box map is flipY: v = 1 is the image top
			const col = ctx.getImageData(x, 0, 1, c.height).data;
			let run = 0;
			for (let yy = Math.max(0, y - 70); yy < Math.min(c.height, y + 70); yy++) if (col[yy * 4 + 1] < 245) run++;
			const px = ctx.getImageData(x, y, 1, 1).data;
			return { px: [px[0], px[1], px[2]], run, w: c.width, h: c.height };
		},
		{ uuid, u, v }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const uuid = await openOnBox(A.page);
	h.check(!!uuid, 'premise: a box is open in the UV editor with Paint armed');
	await A.page.evaluate(() => {
		let p;
		window.__tp.test.v1.peers.subscribe((x) => (p = x))();
		window.__sent = [];
		const raw = p.send.bind(p);
		p.send = (d) => {
			if (d?.type === 'uvpaint' || d?.type === 'meshpaint') window.__sent.push(JSON.parse(JSON.stringify(d)));
			return raw(d);
		};
	});
	const sent = () => A.page.evaluate(() => { const s = window.__sent; window.__sent = []; return s; });

	// ---- 1. opacity mode, a LIGHT dense pen stroke: a tint, however many dabs overlap --------------------------------
	await A.page.evaluate(() => window.__tp.test.v1.uvEditor.uvPenPressure.set('opacity'));
	await stroke(A.page, { v: 0.75, from: 0.2, to: 0.8, n: 50, pointerType: 'pen', p0: 0.25, p1: 0.25 });
	await A.page.waitForTimeout(600);
	const light = await sample(A.page, uuid, 0.5, 0.75);
	// expected: white toward #ff3b30 by the pressure factor 0.15 + 0.85 * 0.25 = 0.36 -> green ~184
	h.check(!!light && light.px[1] > 150 && light.px[1] < 225 && light.px[0] > 240, `a light pen touch in opacity mode paints a tint, not the full colour (rgb ${light?.px.join(',')}; ~255,184,175 expected, base ~255,90,80)`);
	h.check(!!light && Math.abs(light.run - 40) <= 8, `...at the full brush width (${light?.run}px ~ 40)`);
	const wire1 = await sent();
	h.check(wire1.length > 0 && wire1.every((m) => m.type === 'meshpaint' && m.pm === 'opacity'), `the stroke rides the stroke-layer wire with its mode (${[...new Set(wire1.map((m) => m.type + ':' + m.pm))].join(' ')})`);
	await h.eventually(
		() => sample(B.page, uuid, 0.5, 0.75),
		(s) => !!s && s.px[1] > 150 && s.px[1] < 225,
		"peer B's copy of the light stroke is the same tint",
		15000
	);

	// ---- 2. a heavy stroke over the light one: it raises it; going back over with a light touch adds nothing ----------
	await stroke(A.page, { v: 0.75, from: 0.45, to: 0.55, n: 10, pointerType: 'pen', p0: 1, p1: 1 });
	await A.page.waitForTimeout(500);
	const heavy = await sample(A.page, uuid, 0.5, 0.75);
	h.check(!!heavy && heavy.px[1] < 90, `a full-pressure stroke paints the full colour (rgb ${heavy?.px.join(',')})`);
	await stroke(A.page, { v: 0.6, from: 0.2, to: 0.8, n: 50, pointerType: 'pen', p0: 0.25, p1: 0.25 });
	await stroke(A.page, { v: 0.6, from: 0.2, to: 0.8, n: 50, pointerType: 'pen', p0: 0.25, p1: 0.25 });
	await A.page.waitForTimeout(500);
	const twice = await sample(A.page, uuid, 0.5, 0.6);
	// two strokes are two layers (each its own undo step), so they DO combine: 1 - (1 - 0.36)^2 = 0.59 -> green ~139
	h.check(!!twice && twice.px[1] > 110 && twice.px[1] < 175, `two separate light strokes combine as two layers, not as 100 dabs (rgb ${twice?.px.join(',')}; ~139 expected)`);

	// ---- 3. Size + opacity: wider AND stronger where the pen presses harder --------------------------------------------
	await sent();
	await A.page.evaluate(() => window.__tp.test.v1.uvEditor.uvPenPressure.set('both'));
	await stroke(A.page, { v: 0.4, from: 0.15, to: 0.85, n: 50, pointerType: 'pen', p0: 0.1, p1: 0.95 });
	await A.page.waitForTimeout(600);
	const bStart = await sample(A.page, uuid, 0.25, 0.4);
	const bEnd = await sample(A.page, uuid, 0.78, 0.4);
	h.check(!!bStart && !!bEnd && bEnd.run > bStart.run * 1.5, `Size + opacity: wider where the pressure is higher (${bStart?.run}px -> ${bEnd?.run}px)`);
	h.check(!!bStart && !!bEnd && bStart.px[1] > bEnd.px[1] + 40, `...and stronger (green ${bStart?.px[1]} -> ${bEnd?.px[1]})`);
	const wire3 = await sent();
	h.check(wire3.length > 0 && wire3.every((m) => m.type === 'meshpaint' && m.pm === 'both'), 'Size + opacity sends pm: "both" (a 102 peer reads it as size: width varies, full opacity, until the commit)');

	// ---- 4. a MOUSE in opacity mode is unchanged: the shipped painter, plain points, full colour ---------------------
	await A.page.evaluate(() => window.__tp.test.v1.uvEditor.uvPenPressure.set('opacity'));
	await stroke(A.page, { v: 0.2, from: 0.2, to: 0.8, n: 12, pointerType: 'mouse', p0: 0.5, p1: 0.5, gap: 60 });
	await A.page.waitForTimeout(600);
	const mouse = await sample(A.page, uuid, 0.5, 0.2);
	h.check(!!mouse && mouse.px[1] < 90, `a mouse stroke paints the full colour (rgb ${mouse?.px.join(',')})`);
	const wire4 = await sent();
	h.check(wire4.length > 0 && wire4.every((m) => m.type === 'uvpaint' && m.seg.every((p) => p.length === 2)), 'a mouse stroke stays on the shipped uvpaint wire with plain [u, v] points (byte-identical)');

	// ---- 5. the panel's four modes -----------------------------------------------------------------------------------
	const panel = await A.page.evaluate(() => [...document.querySelectorAll('#uv-pen-pressure [role="radio"]')].map((b) => b.dataset.value + ':' + b.textContent.trim()));
	h.check(JSON.stringify(panel) === JSON.stringify(['size:Size', 'opacity:Opacity', 'both:Size + opacity', 'off:Off']), `the Brush panel offers Size / Opacity / Size + opacity / Off (${JSON.stringify(panel)})`);
	await A.page.click('#uv-pen-pressure [data-value="both"]');
	h.check((await A.page.evaluate(() => { let v; window.__tp.test.v1.uvEditor.uvPenPressure.subscribe((x) => (v = x))(); return v; })) === 'both', 'clicking Size + opacity sets the pref');
	await A.page.evaluate(() => window.__tp.test.v1.uvEditor.uvPenPressure.set('size'));

	// ---- 6. the committed texture matches on both peers, and survives B reloading ------------------------------------
	const urlLen = (page) => page.evaluate((u) => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); const o = g.getObjectByProperty('uuid', u); const m = o && (Array.isArray(o.material) ? o.material[0] : o.material); return m?.userData?.mapDataUrl?.length ?? 0; }, uuid);
	await h.eventually(() => Promise.all([urlLen(A.page), urlLen(B.page)]), ([a, b]) => a > 0 && a === b, "peer B's committed texture is A's", 15000);
	const aLen = await urlLen(A.page);
	await h.freshReload(B);
	await h.eventually(() => urlLen(B.page), (b) => b === aLen, `after B reloads and rejoins it has A's painted texture (${aLen} chars)`, 60000);
	const afterReload = await sample(B.page, uuid, 0.5, 0.75);
	h.check(!!afterReload && afterReload.px[1] < 120, `...with the strokes in it (rgb ${afterReload?.px.join(',')} where the heavy stroke went)`);

	await h.finish(browser);
});
