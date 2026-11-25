// Lane 99-scrub: the loop-cut SCRUB is a PREVIEW. A real pointer scrub on the options pane's position / cuts rows
// of a live loop-cut adjust (the DragRow's own onscrubstart -> onchange per step -> onscrubend), two peers:
//   1. while the pointer is held: the geometry on A is the SAME object with the SAME bytes as at scrub start (no kernel
//      op, no rebuild), a preview line is up with one segment per ring quad per cut at the scrubbed position, and A
//      sends NO meshgeo (peers see the result, not the scrub)
//   2. on release: the cut is ONE run at the final position (the vertex planes of K4 section 4b), the preview is gone,
//      B receives that one result, and ONE undo removes the cut (on both peers)
//   3. a cuts scrub re-uses the ring: the preview grows to 3 segments a quad, the release cuts 3 loops
//   4. a typed change (no scrub bracket) still cuts live, and the debounce settles it (the pre-lane path)
//   5. the K4 premise: a direct reapplyOpAdjust (VR, the old suites) still cuts immediately
// Run with mesh-loop-cut, mesh-live-edit and mesh-adjust for a change to the adjust engine or the options pane.
const h = require('./helpers.cjs');

/** the object's distinct vertex planes on one axis (mesh-loop-cut's `planes`) */
const planes = (page, uuid, axisName) =>
	page.evaluate(
		({ uuid, axisName }) => {
			const w = window.__tp?.test.v1;
			let group;
			w.objectsGroup.subscribe((v) => (group = v))();
			const geo = group.getObjectByProperty('uuid', uuid)?.geometry;
			if (!geo) return null;
			const pos = geo.attributes.position;
			const vals = new Set();
			for (let i = 0; i < pos.count; i++) {
				const v = axisName === 'y' ? pos.getY(i) : axisName === 'x' ? pos.getX(i) : pos.getZ(i);
				vals.add(+v.toFixed(3));
			}
			return [...vals].sort((a, b) => a - b);
		},
		{ uuid, axisName }
	);

const triCount = (page, uuid) =>
	page.evaluate((uuid) => {
		const w = window.__tp?.test.v1;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const geo = g.getObjectByProperty('uuid', uuid)?.geometry;
		return geo ? geo.attributes.position.count / 3 : -1;
	}, uuid);

/** A: a box in face mode, top face picked, the loop-cut pane focused, a live loop-cut adjust begun (cuts 1, 0.5) */
const beginCut = (page) =>
	page.evaluate(async () => {
		const w = window.__tp?.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.meshToolParams.focusTool('loopcut');
		w.meshToolParams.loopCuts.set(1);
		w.meshToolParams.loopCutPosition.set(0.5);
		let began = false;
		for (let i = 0; i < 100 && !began; i++) {
			began = w.faceEdit.beginOpAdjust('loopcut', { cuts: 1, position: 0.5 }) !== false;
			if (!began) await new Promise((r) => setTimeout(r, 50));
		}
		// the toolbox is a lazy chunk: wait for the pane to mount (a loaded host takes seconds)
		// (and the popup's focus effect follows the ARMED op on mount, which can clear a focus set before it: re-assert)
		for (let i = 0; i < 150 && !document.querySelector('#loopcut-position'); i++) {
			w.meshToolParams.focusTool('loopcut');
			await new Promise((r) => setTimeout(r, 200));
		}
		await new Promise((r) => setTimeout(r, 300));
		return { uuid: box.uuid, began, pane: !!document.querySelector('#loopcut-position') };
	});

/** spy every message A sends to B (batch items unpacked) */
const spySends = (page, toId) =>
	page.evaluate((to) => {
		let pc;
		window.__tp.test.v1.peers.subscribe((x) => (pc = x))();
		const conn = pc.connections[to];
		window.__sent = [];
		if (conn && !conn.__spied) {
			const orig = conn.send.bind(conn);
			conn.send = (payload) => {
				try {
					const t = payload?.type ?? typeof payload;
					window.__sent.push(t);
					if (t === 'batch' && Array.isArray(payload.items))
						for (const it of payload.items) window.__sent.push('batch:' + (it?.type ?? typeof it));
				} catch {}
				return orig(payload);
			};
			conn.__spied = true;
		}
		return !!conn;
	}, toId);
const sentGeo = (page) =>
	page.evaluate(
		() => (window.__sent ?? []).filter((t) => /meshgeo|geometry/.test(String(t))).length
	);
const resetSent = (page) => page.evaluate(() => (window.__sent = []));

/** the geometry identity + a bytes hash on A, to tell "nothing touched it" from "rewritten to the same values" */
const geoMark = (page, uuid) =>
	page.evaluate((uuid) => {
		const w = window.__tp?.test.v1;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		window.__markGeo ??= new WeakMap();
		if (!window.__markGeo.has(geo)) window.__markGeo.set(geo, Math.random());
		const a = geo.attributes.position.array;
		let x = 0x811c9dc5;
		const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
		for (let i = 0; i < u8.length; i++) x = Math.imul(x ^ u8[i], 0x01000193) >>> 0;
		return { id: window.__markGeo.get(geo), version: geo.attributes.position.version, hash: x };
	}, uuid);

const preview = (page) => page.evaluate(() => window.__tp.test.v1.faceEdit.loopCutPreviewDebug());

/** a pointer scrub on a DragRow: press, move `dx` px in `steps` moves, run `during`, release */
async function scrub(page, id, dx, steps, during) {
	const box = await page.evaluate((id) => {
		const wrap = document.querySelector('#' + id)?.closest('.dn-wrap');
		if (!wrap) return null;
		wrap.scrollIntoView({ block: 'center' });
		const r = wrap.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}, id);
	if (!box) return null;
	await page.mouse.move(box.x, box.y);
	await page.mouse.down();
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(box.x + (dx * i) / steps, box.y);
		await page.waitForTimeout(30);
	}
	const seen = during ? await during() : null;
	await page.mouse.up();
	await page.waitForTimeout(300);
	return seen;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const start = await beginCut(A.page);
	h.check(start.began === true, 'a loop-cut adjust begins on the box (premise)');
	h.check(start.pane === true, 'the options pane shows the position row (premise)');
	const uuid = start.uuid;
	h.check(
		(await triCount(A.page, uuid)) === 20,
		'the begin cut one loop: 12 -> 20 triangles (premise)'
	);
	await h.eventually(
		() => triCount(B.page, uuid),
		(n) => n === 20,
		'B holds the begin cut (premise: the apply is replicated)',
		20000
	);
	h.check(await spySends(A.page, B.id), 'A has a link to B to watch (premise)');

	// ------------------------------------------------ 1-2. a position scrub
	await resetSent(A.page);
	const mark0 = await geoMark(A.page, uuid);
	// step 0.005 a px: +40 px = position 0.7, so the side quads' cut lands at y = +-0.2
	const during = await scrub(A.page, 'loopcut-position', 40, 8, async () => ({
		mark: await geoMark(A.page, uuid),
		preview: await preview(A.page),
		sent: await sentGeo(A.page),
		pos: await A.page.evaluate(() => {
			let st;
			window.__tp.test.v1.faceEdit.opAdjustState.subscribe((v) => (st = v))();
			return st?.params?.position;
		})
	}));
	h.check(!!during, 'the scrub ran on the position row (premise)');
	h.check(
		Math.abs((during?.pos ?? 0) - 0.7) < 0.011,
		`the engine follows the hand: position ${during?.pos} after +40 px`
	);
	h.check(
		during?.mark.id === mark0.id &&
			during?.mark.hash === mark0.hash &&
			during?.mark.version === mark0.version,
		"1. while scrubbing, A's geometry is the SAME object, bytes and version as at scrub start (no cut, no rebuild)"
	);
	h.check(
		during?.preview?.segments === 4,
		`1. a preview line is up: one segment per ring quad (${during?.preview?.segments})`
	);
	const ys = new Set();
	for (let i = 1; i < (during?.preview?.points?.length ?? 0); i += 3)
		ys.add(Math.abs(+during.preview.points[i].toFixed(3)));
	h.check(
		[...ys].some((y) => Math.abs(y - 0.2) < 0.011),
		`1. ...at the scrubbed position (side quads at |y| = 0.2: ${JSON.stringify([...ys])})`
	);
	h.check(during?.sent === 0, `1. A sent NO geometry while scrubbing (${during?.sent})`);

	const pAfter = await planes(A.page, uuid, 'y');
	h.check((await preview(A.page)) === null, '2. the release takes the preview down');
	h.check((await triCount(A.page, uuid)) === 20, '2. the release cut ONE loop (20 triangles)');
	h.check(
		pAfter.length === 4 &&
			pAfter.some((y) => Math.abs(y - 0.2) < 0.011) &&
			pAfter.some((y) => Math.abs(y + 0.2) < 0.011),
		`2. ...at the final position: planes ${JSON.stringify(pAfter)}`
	);
	const sentAfter = await sentGeo(A.page);
	h.check(
		sentAfter >= 1 && sentAfter <= 2,
		`2. the release sent the result (${sentAfter} geometry message(s))`
	);
	await h.eventually(
		() => planes(B.page, uuid, 'y'),
		(p) => JSON.stringify(p) === JSON.stringify(pAfter),
		'2. B holds the released cut, plane for plane',
		15000
	);

	// ------------------------------------------------ 3. a cuts scrub re-uses the ring
	await resetSent(A.page);
	const mark1 = await geoMark(A.page, uuid);
	// cuts step 0.05 a px: +40 px = 1 + 2 = 3 cuts
	const duringCuts = await scrub(A.page, 'mesh-loop-cuts', 40, 8, async () => ({
		mark: await geoMark(A.page, uuid),
		preview: await preview(A.page),
		sent: await sentGeo(A.page)
	}));
	h.check(
		duringCuts?.mark.id === mark1.id && duringCuts?.mark.hash === mark1.hash,
		'3. a cuts scrub leaves the geometry alone too'
	);
	h.check(
		duringCuts?.preview?.segments === 12,
		`3. ...and previews 3 cuts on the same 4-quad ring (${duringCuts?.preview?.segments} segments)`
	);
	h.check(duringCuts?.sent === 0, '3. ...sending nothing');
	h.check(
		(await triCount(A.page, uuid)) === 4 + 4 * 8,
		'3. the release cuts 3 loops (36 triangles)'
	);
	const p3 = await planes(A.page, uuid, 'y');
	h.check(p3.length === 5, `3. ...evenly spaced: ${JSON.stringify(p3)}`);
	await h.eventually(
		() => triCount(B.page, uuid),
		(n) => n === 36,
		'3. B holds the 3-loop cut',
		15000
	);

	// ------------------------------------------------ 4. typed input keeps the live path
	const typed = await A.page.evaluate(async () => {
		const input = document.querySelector('#mesh-loop-cuts');
		input.focus();
		input.value = '2';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		input.blur();
		await new Promise((r) => setTimeout(r, 600));
		return window.__tp.test.v1.faceEdit.loopCutPreviewDebug();
	});
	h.check(typed === null, '4. typing a value draws no preview');
	h.check(
		(await triCount(A.page, uuid)) === 4 + 4 * 6,
		`4. ...and cuts live (2 loops: ${await triCount(A.page, uuid)} triangles)`
	);

	// ------------------------------------------------ 5. a direct reapply cuts at once (VR, the K4 suites)
	const direct = await A.page.evaluate(() => {
		const fe = window.__tp.test.v1.faceEdit;
		const ok = fe.reapplyOpAdjust({ cuts: 1, position: 0.3 });
		return { ok, preview: fe.loopCutPreviewDebug() };
	});
	h.check(
		direct.ok === true && direct.preview === null,
		'5. a direct reapplyOpAdjust takes no bracket (no preview)'
	);
	h.check((await triCount(A.page, uuid)) === 20, '5. ...and cuts immediately (one loop again)');
	await A.page.evaluate(() => window.__tp.test.v1.faceEdit.settleOpAdjust());

	// ------------------------------------------------ 2b. ONE undo removes the whole adjust
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	h.check(
		(await triCount(A.page, uuid)) === 12,
		'2b. ONE undo removes the cut, scrubs and all (12 triangles)'
	);
	await h.eventually(
		() => triCount(B.page, uuid),
		(n) => n === 12,
		'2b. ...on B too',
		15000
	);

	h.check(
		h.pageErrors(A).length === 0,
		`no page errors on A (${JSON.stringify(h.pageErrors(A).slice(0, 3))})`
	);
	await h.finish(browser);
});
