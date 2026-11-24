// Roadmap 64 D5 (lane 64-vector-edit) rows 2 + 3 — LAYER ORDER and ALIGN IN PLANE, two peers:
//  1 three overlapping flat shapes on one plane (red, green, blue): reorder them three times (to front,
//    forward, to back — the last by its real Ctrl+Alt+[ key). After each, a ray straight down onto the
//    spot all three cover hits the shape the order puts on top — on A and on B; one undo entry each
//    (one entry for every layer a move rewrote), and one undo puts the previous order back on B
//  2 drawing a rectangle ON the stack lands on its plane, one layer above the top (no 4 mm stacking)
//  3 Align left / Distribute across in the plane: the left edges meet, the gaps are equal; one undo each
//  4 two peers + reload: B reloads, rejoins, and has the same layers; a saved file opens with them;
//    a shape nobody reordered carries no `layer` key at all (feature unused = byte-identical record)
const h = require('./helpers.cjs');

const RED = '#e15759';
const GREEN = '#59a14f';
const BLUE = '#4e79a7';
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const params = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					r(o ? JSON.parse(JSON.stringify(o.userData.geometryParams.params)) : null);
				})()
			),
		uuid
	);
const layersOf = async (page, uuids) => {
	const out = {};
	for (const u of uuids) out[u] = (await params(page, u))?.layer ?? 0;
	return out;
};
h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	/** which flat shape is on top at (x, z): the highest triangle of any Vector mesh over that spot */
	const hit = (page, x, z) =>
		page.evaluate(
			([x, z]) =>
				new Promise((r) =>
					window.__stores.objectsGroup.subscribe((g) => {
						g.updateMatrixWorld(true);
						const V = g.position.constructor;
						let best = null;
						g.traverse((o) => {
							if (o.userData?.geometryParams?.gtype !== 'Vector' || !o.geometry?.attributes?.position) return;
							const pos = o.geometry.attributes.position;
							const m = o.matrixWorld;
							for (let i = 0; i < pos.count; i += 3) {
								const a = new V().fromBufferAttribute(pos, i).applyMatrix4(m);
								const b = new V().fromBufferAttribute(pos, i + 1).applyMatrix4(m);
								const c = new V().fromBufferAttribute(pos, i + 2).applyMatrix4(m);
								// point-in-triangle on XZ, then the height of the plane through a, b, c at (x, z)
								const s = (p, q, w) => (p.x - w.x) * (q.z - w.z) - (q.x - w.x) * (p.z - w.z);
								const P = { x, z };
								const d1 = s(P, a, b);
								const d2 = s(P, b, c);
								const d3 = s(P, c, a);
								if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
								const n = new V().subVectors(b, a).cross(new V().subVectors(c, a));
								if (Math.abs(n.y) < 1e-9) continue;
								const y = a.y - (n.x * (x - a.x) + n.z * (z - a.z)) / n.y;
								if (!best || y > best.y) best = { y, uuid: o.uuid };
							}
						});
						r(best);
					})()
				),
			[x, z]
		);

	// ---- three overlapping squares on the floor ------------------------------------------------------
	const made = await A.page.evaluate(
		([RED, GREEN, BLUE]) => {
			const v = window.__stores.vectorActions;
			const d = window.__stores.vectorRecord.vectorDefaults('rect');
			const flat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
			const put = (fill, x, z) => v.addVectorShape({ ...d, fill }, { position: [x, 0.004, z], quaternion: flat, select: false }).uuid;
			return { red: put(RED, 0, 0), green: put(GREEN, 0.3, 0.2), blue: put(BLUE, 0.6, -0.1) };
		},
		[RED, GREEN, BLUE]
	);
	const all = [made.red, made.green, made.blue];
	const spot = [0.3, 0.05]; // inside all three
	await h.eventually(() => layersOf(B.page, all), (l) => Object.keys(l).length === 3 && all.every((u) => l[u] === 0), 'B has the three squares');
	const unordered = await params(A.page, made.red);
	h.check(!('layer' in unordered), '4. feature unused: the record carries no `layer` key');

	const stack = () => A.page.evaluate((u) => window.__stores.vectorArrange.stackDebug(u).map((s) => s.uuid), made.red);
	const order = async (op, uuid) => {
		await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), uuid);
		return A.page.evaluate(([op, u]) => window.__stores.vectorArrange.orderShapes(op, [u]), [op, uuid]);
	};
	const expectTop = async (uuid, label) => {
		const a = await hit(A.page, spot[0], spot[1]);
		h.check(a?.uuid === uuid, `${label}: on A the ray down meets the ${uuid === made.red ? 'red' : uuid === made.green ? 'green' : 'blue'} square first`);
		await h.eventually(() => hit(B.page, spot[0], spot[1]), (b) => b?.uuid === uuid, `${label}: ...and on B`);
	};

	// ---- 1 reorder three times ---------------------------------------------------------------------------
	// a known start: red at the bottom, then green, then blue (each sent to the front in turn)
	for (const u of all) await order('front', u);
	h.check(JSON.stringify(await stack()) === JSON.stringify(all), `the stack bottom-up is red, green, blue (${(await stack()).length} shapes)`);
	await expectTop(made.blue, 'start');

	let depth = await undoDepth(A.page);
	h.check((await order('front', made.red)) >= 1, '1a. Bring to front moves red');
	h.check((await undoDepth(A.page)) === depth + 1, '1a. ...one undo entry');
	await expectTop(made.red, '1a. red to front');

	depth = await undoDepth(A.page);
	await order('forward', made.green); // [green, blue, red] -> [blue, green, red]
	h.check(JSON.stringify(await stack()) === JSON.stringify([made.blue, made.green, made.red]), '1b. Bring forward trades green with blue');
	h.check((await undoDepth(A.page)) === depth + 1, '1b. ...one undo entry');
	await h.eventually(() => layersOf(B.page, all), async (l) => JSON.stringify(l) === JSON.stringify(await layersOf(A.page, all)), '1b. B has the same layers');

	// 1c by the real key: red selected, Ctrl+Alt+[ = Send to back
	depth = await undoDepth(A.page);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), made.red);
	await A.page.locator('canvas').first().focus().catch(() => {});
	await A.page.keyboard.press('Control+Alt+BracketLeft');
	await h.eventually(() => stack(), (s) => s[0] === made.red, '1c. Ctrl+Alt+[ sends red to the back');
	h.check((await undoDepth(A.page)) === depth + 1, '1c. ...one undo entry');
	const top = (await stack())[2];
	await expectTop(top, '1c. after send to back');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => hit(B.page, spot[0], spot[1]), (b) => b?.uuid === made.red, '1c. one undo puts red back on top, on B too');

	// ---- 2 draw on the stack ------------------------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.vectorTool.armVectorTool('rect'));
	await A.page.locator('#vector-toolbar').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
	const p0 = await h.projectPoint(A.page, [0.15, 0.01, -0.05]);
	const p1 = await h.projectPoint(A.page, [0.45, 0.01, 0.25]);
	const before = (await stack()).length;
	await A.page.mouse.move(p0.x, p0.y);
	await A.page.mouse.down();
	await A.page.mouse.move(p1.x, p1.y, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.vectorTool.disarmVectorTool());
	const after = await A.page.evaluate((u) => window.__stores.vectorArrange.stackDebug(u), made.red);
	const drawn = after.find((s) => !all.includes(s.uuid));
	h.check(after.length === before + 1 && !!drawn, '2. the rectangle drawn on the stack joins it (same plane)');
	h.check(after[after.length - 1].uuid === drawn?.uuid && Math.abs(drawn.base - after[0].base) < 1e-6, `2. ...on top, one layer up, on the stack's own plane (layer ${drawn?.layer})`);
	await expectTop(drawn.uuid, '2. drawn on top');

	// ---- 3 align and distribute in the plane --------------------------------------------------------------
	const edges = (page) =>
		page.evaluate(
			(uuids) =>
				new Promise((r) =>
					window.__stores.objectsGroup.subscribe((g) => {
						r(
							uuids.map((u) => {
								const o = g.getObjectByProperty('uuid', u);
								o.updateMatrixWorld(true);
								o.geometry.computeBoundingBox();
								const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
								return [b.min.x, b.max.x];
							})
						);
					})()
				),
			uuids
		);
	depth = await undoDepth(A.page);
	h.check((await A.page.evaluate((u) => window.__stores.vectorArrange.alignInPlane('left', u), all)) >= 1, '3a. Align left moves shapes');
	const left = await edges(A.page);
	h.check(Math.max(...left.map((e) => e[0])) - Math.min(...left.map((e) => e[0])) < 1e-4, `3a. the left edges meet (${left.map((e) => e[0].toFixed(3)).join(', ')})`);
	h.check((await undoDepth(A.page)) === depth + 1, '3a. ...one undo entry');
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await A.page.evaluate((u) => window.__stores.vectorArrange.distributeInPlane('h', u), all)) >= 0, '3b. Distribute across runs');
	const spread = (await edges(A.page)).sort((a, b) => a[0] - b[0]);
	const gaps = [spread[1][0] - spread[0][1], spread[2][0] - spread[1][1]];
	h.check(Math.abs(gaps[0] - gaps[1]) < 1e-4, `3b. equal gaps (${gaps.map((g) => g.toFixed(3)).join(', ')})`);

	// ---- 4 reload and a file ---------------------------------------------------------------------------
	const want = await layersOf(A.page, [...all, drawn.uuid]);
	h.check(Object.values(want).some((l) => l > 0), '4. premise: some shapes carry layers');
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await B.page.waitForFunction(() => !!window.__tp?.test?.v1?.peers, null, { timeout: 150000 });
	await h.eventually(() => layersOf(B.page, Object.keys(want)), (l) => JSON.stringify(l) === JSON.stringify(want), '4. B reloads, rejoins and has every layer', 90000);
	const saved = await A.page.evaluate(() => JSON.parse(JSON.stringify(window.__stores.sessions.buildSessionPayload('vector-layers', { thumbnail: false }))));
	await B.page.context().close();
	const C = await h.setupPage(browser, 'C'); // on its own
	await C.page.evaluate(async (payload) => window.__stores.sessions.applySession(payload, { backup: false, replicate: false, quiet: true }), saved);
	await h.eventually(() => layersOf(C.page, Object.keys(want)), (l) => JSON.stringify(l) === JSON.stringify(want), '4. the saved file opens with the same layers', 30000);
	await h.eventually(() => hit(C.page, spot[0], spot[1]), (c) => c?.uuid === drawn.uuid, '4. ...and the same shape on top');

	await h.finish(browser);
});
