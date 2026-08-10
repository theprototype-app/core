// UV3: painting on a material's texture from the UV editor.
//
// A stroke draws onto an offscreen canvas that becomes the material's live map,
// streams throttled `uvpaint` segments so peers watch it happen, and COMMITS the
// finished image through the existing replicated `objectParameters`/`map` path —
// so persistence and undo come free and there is no new history kind.
const h = require('./helpers.cjs');

/** a selected box with a real uv attribute, UV editor open */
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
		return box.uuid;
	});
	await page.waitForTimeout(700);
	return uuid;
};

/** the slot's texture state */
const mapState = (page, uuid, slot = 0) =>
	page.evaluate(
		async ({ uuid, slot }) => {
			const w = window.__stores;
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const o = g.getObjectByProperty('uuid', uuid);
			if (!o) return null;
			const mats = Array.isArray(o.material) ? o.material : [o.material];
			const m = mats[slot];
			const url = m?.userData?.mapDataUrl ?? null;
			return { hasUrl: !!url, kind: url ? url.slice(5, 14) : null, len: url ? url.length : 0, hasMap: !!m?.map };
		},
		{ uuid, slot }
	);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));

/** paint a horizontal stroke across UV space at height `v`, through the lib.
 * `v` matters: two strokes at the SAME height cover each other exactly, which
 * would make "the earlier paint survived" untestable. */
const paintStroke = (page, uuid, slot, color, size, v = 0.5) =>
	page.evaluate(
		async ({ uuid, slot, color, size, v }) => {
			const w = window.__stores;
			const opened = await w.uvEditor.beginPaintStroke(uuid, slot);
			if (!opened) return { opened: false };
			for (let i = 0; i <= 10; i++) w.uvEditor.paintMove(0.1 + i * 0.08, v, color, size);
			const committed = w.uvEditor.endPaintStroke(color, size);
			return { opened, committed };
		},
		{ uuid, slot, color, size, v }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const uuid = await openOnBox(A.page);

	// ---------- the tool exists and is armed ----------
	const toolBtn = await A.page.evaluate(async () => {
		const btn = document.getElementById('uv-tool-paint');
		if (!btn) return { present: false };
		btn.click();
		await new Promise((r) => setTimeout(r, 200));
		return {
			present: true,
			pressed: btn.getAttribute('aria-pressed'),
			tool: window.__uvDebug().tool,
			hasColor: !!document.getElementById('uv-brush-color'),
			hasSize: !!document.getElementById('uv-brush-size')
		};
	});
	h.check(toolBtn.present, 'the topbar offers a Paint tool');
	h.check(toolBtn.pressed === 'true' && toolBtn.tool === 'paint', 'clicking it arms the paint tool');
	h.check(toolBtn.hasColor && toolBtn.hasSize, 'arming paint reveals the brush colour + size controls');

	// ---------- a stroke paints and commits as ONE undo entry ----------
	const before = await mapState(A.page, uuid);
	h.check(!before.hasUrl, 'premise: the box has no texture yet');
	const depth0 = await undoDepth(A.page);
	const stroke = await paintStroke(A.page, uuid, 0, '#ff0000', 40);
	h.check(stroke.opened, 'beginPaintStroke opens a stroke on a material with a map slot');
	h.check(stroke.committed, 'endPaintStroke commits the canvas');
	await A.page.waitForTimeout(700);
	const after = await mapState(A.page, uuid);
	h.check(after.hasUrl, `painting gives the material a texture (${after.kind}, ${after.len} chars)`);
	h.check(after.hasMap, 'the committed texture is loaded onto the material');
	const depth1 = await undoDepth(A.page);
	h.check(depth1 === depth0 + 1, `a whole stroke records exactly ONE undo entry (${depth0}->${depth1})`);
	const entry = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.history.undoStack.subscribe((v) => {
					const e = v[v.length - 1];
					r({ kind: e?.kind, param: e?.param });
				})()
			)
	);
	h.check(
		entry.kind === 'material' && entry.param === 'map',
		`the stroke rides the existing material/map kind — no new history kind (${JSON.stringify(entry)})`
	);

	// the paint is really IN the image: decode it and look for the brush colour
	const pixels = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		const url = o.material.userData.mapDataUrl;
		const img = await new Promise((res, rej) => {
			const i = new Image();
			i.onload = () => res(i);
			i.onerror = rej;
			i.src = url;
		});
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		c.getContext('2d').drawImage(img, 0, 0);
		const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
		let reddish = 0;
		let whiteish = 0;
		for (let i = 0; i < data.length; i += 4) {
			const [r, g2, b] = [data[i], data[i + 1], data[i + 2]];
			if (r > 150 && g2 < 90 && b < 90) reddish++;
			else if (r > 220 && g2 > 220 && b > 220) whiteish++;
		}
		return { w: c.width, h: c.height, reddish, whiteish };
	}, uuid);
	h.check(pixels.reddish > 200, `the stroke is really in the image (${pixels.reddish} red px of ${pixels.w}x${pixels.h})`);
	h.check(pixels.whiteish > pixels.reddish, 'the rest of the texture stays the white base, not a full repaint');

	// ---------- undo restores the previous texture (here: none) ----------
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(600);
	const undone = await mapState(A.page, uuid);
	h.check(!undone.hasUrl && !undone.hasMap, 'ONE undo removes the whole stroke (back to no texture)');
	await A.page.evaluate(() => window.__stores.history.redo());
	await A.page.waitForTimeout(600);
	const redone = await mapState(A.page, uuid);
	h.check(redone.hasUrl, 'redo puts the painted texture back');

	// ---------- a second stroke EDITS the image, it does not replace it ----------
	const firstLen = (await mapState(A.page, uuid)).len;
	await paintStroke(A.page, uuid, 0, '#0000ff', 40, 0.25); // its OWN row
	await A.page.waitForTimeout(800);
	const twoColours = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		const img = await new Promise((res, rej) => {
			const i = new Image();
			i.onload = () => res(i);
			i.onerror = rej;
			i.src = o.material.userData.mapDataUrl;
		});
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		c.getContext('2d').drawImage(img, 0, 0);
		const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
		let red = 0;
		let blue = 0;
		for (let i = 0; i < data.length; i += 4) {
			const [r, g2, b] = [data[i], data[i + 1], data[i + 2]];
			if (r > 150 && g2 < 90 && b < 90) red++;
			if (b > 150 && r < 90 && g2 < 90) blue++;
		}
		return { red, blue };
	}, uuid);
	h.check(
		twoColours.blue > 200,
		`a second stroke paints its own colour (${twoColours.blue} blue px)`
	);
	h.check(
		twoColours.red > 200,
		`...ON TOP of the first, which survives the re-seed (${twoColours.red} red px still there)`
	);
	h.check(firstLen > 0, 'premise: the first commit produced an image to re-seed from');

	// ---------- a real pointer stroke on the canvas ----------
	const pointerPaint = await A.page.evaluate(async () => {
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		const P = (u, v) => window.__uvDebug().project(u, v);
		const a = P(0.2, 0.8);
		const b = P(0.8, 0.8);
		const opt = (p) => ({ clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true, pointerId: 21, pointerType: 'mouse' });
		el.dispatchEvent(new PointerEvent('pointerdown', opt(a)));
		const mid = window.__uvDebug();
		window.dispatchEvent(new PointerEvent('pointermove', opt({ x: (a.x + b.x) / 2, y: a.y })));
		window.dispatchEvent(new PointerEvent('pointermove', opt(b)));
		window.dispatchEvent(new PointerEvent('pointerup', opt(b)));
		await new Promise((res) => setTimeout(res, 900));
		return { gesture: mid.gesture, selected: mid.selected };
	});
	h.check(pointerPaint.gesture === 'paint', `a canvas drag in paint mode starts a STROKE, not a vertex drag (${pointerPaint.gesture})`);
	h.check(pointerPaint.selected === 0, 'painting never picks up a vertex selection');

	// ---------- two peers: live segments, then the committed image ----------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await openOnBox(A.page);
	await h.eventually(
		() => mapState(B.page, netUuid),
		(s) => !!s,
		'B received the box (premise)',
		25000
	);

	// watch B mid-stroke: it must be drawing the live segments before any commit
	const live = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		await w.uvEditor.beginPaintStroke(uuid, 0);
		for (let i = 0; i <= 6; i++) {
			w.uvEditor.paintMove(0.15 + i * 0.1, 0.35, '#00cc00', 48);
			await new Promise((r) => setTimeout(r, 90)); // outrun the 66ms throttle
		}
		return true;
	}, netUuid);
	h.check(live, 'A streamed a stroke without committing it');
	await h.eventually(
		() => B.page.evaluate(() => window.__stores.uvEditor.liveStrokeCount()),
		(n) => n > 0,
		'THE WIRE: B is tracking A’s live stroke before the commit',
		15000
	);
	await A.page.evaluate((uuid) => {
		void uuid;
		window.__stores.uvEditor.endPaintStroke('#00cc00', 48);
	}, netUuid);
	await h.eventually(
		() => mapState(B.page, netUuid),
		(s) => !!s && s.hasUrl,
		'B ends up with the committed texture',
		25000
	);
	await h.eventually(
		() => B.page.evaluate(() => window.__stores.uvEditor.liveStrokeCount()),
		(n) => n === 0,
		'the uvpaintend message clears B’s live-stroke entry',
		15000
	);

	// a peer that vanishes mid-stroke must not leak a live entry forever
	const swept = await B.page.evaluate(async () => {
		const w = window.__stores;
		w.uvEditor.applyUvPaint({
			id: 'ghost-stroke',
			uuid: 'nope',
			seg: [
				[0.1, 0.1],
				[0.2, 0.2]
			],
			color: '#000000',
			size: 4
		});
		return w.uvEditor.liveStrokeCount();
	});
	h.check(swept === 0, 'a live stroke for an unknown object is not tracked at all (no leak)');

	await h.finish(browser);
});
