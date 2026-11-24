// Roadmap 64 D5 (lane 64-vector-edit) row 4 — THE PEN BY FINGER, on a phone-sized touch page (the N6 UA,
// real CDP touches; the HONOR / N6 device rows are the owner's Release checks):
//  1 a tap places a CORNER, a one-finger drag a SMOOTH point whose handle follows the finger
//  2 a two-finger PINCH and a two-finger PAN place nothing (and the camera moves: the gesture went to it)
//  3 a tap on the first point closes the path: ONE create entry, the desktop peer B sees it
//  4 Edit points by finger: a drag moves an anchor (one undo entry, B sees it); a pinch while editing
//    changes nothing in the record
const h = require('./helpers.cjs');

const N6 = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true, userAgent: h.N6_UA };
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const pen = (page) => page.evaluate(() => window.__stores.vectorTool.vectorToolDebug().pen ?? []);
const camPos = (page) => page.evaluate(() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c.position.toArray()))()));
const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const vectorParams = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const out = {};
					g.traverse((o) => {
						if (o.userData?.geometryParams?.gtype === 'Vector') out[o.uuid] = JSON.parse(JSON.stringify(o.userData.geometryParams.params));
					});
					r(out);
				})()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: N6 });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const cdp = await A.ctx.newCDPSession(A.page);
	const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0 })) });
	/** one finger: press, optional travel, lift */
	const finger = async (from, to = null, steps = 6) => {
		await touch('touchStart', [{ ...from, id: 1 }]);
		await A.page.waitForTimeout(60);
		if (to)
			for (let i = 1; i <= steps; i++) {
				await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 }]);
				await A.page.waitForTimeout(30);
			}
		await touch('touchEnd', []);
		await A.page.waitForTimeout(200);
	};
	/** two fingers: the first lands, then the second, both travel (apart = pinch, together = pan), both lift */
	const twoFingers = async (a, b, da, db, steps = 8) => {
		await touch('touchStart', [{ ...a, id: 1 }]);
		await A.page.waitForTimeout(80); // the first finger alone first: the hard case (a tool already holds it)
		await touch('touchStart', [{ ...a, id: 1 }, { ...b, id: 2 }]);
		for (let i = 1; i <= steps; i++) {
			await touch('touchMove', [
				{ x: a.x + (da.x * i) / steps, y: a.y + (da.y * i) / steps, id: 1 },
				{ x: b.x + (db.x * i) / steps, y: b.y + (db.y * i) / steps, id: 2 }
			]);
			await A.page.waitForTimeout(30);
		}
		await touch('touchEnd', []);
		await A.page.waitForTimeout(250);
	};

	await A.page.evaluate(() => window.__stores.vectorTool.armVectorTool('pen'));
	h.check(await A.page.evaluate(() => window.__stores.vectorTool.vectorToolDebug().armed), 'the pen is armed on the phone page');

	// ---- 1 tap = corner, drag = smooth -------------------------------------------------------------
	const w = [[-0.8, 0, 0.4], [0, 0, -0.4], [0.8, 0, 0.4]];
	const s0 = await h.projectPoint(A.page, w[0]);
	await finger(s0);
	let p = await pen(A.page);
	h.check(p.length === 1 && !p[0].smooth && !p[0].ox && !p[0].oy, 'a tap places one corner point (on lift)');
	const s1 = await h.projectPoint(A.page, w[1]);
	await finger(s1, { x: s1.x + 60, y: s1.y });
	p = await pen(A.page);
	h.check(p.length === 2 && p[1].smooth && Math.hypot(p[1].ox, p[1].oy) > 0.05, `a one-finger drag places a smooth point whose handle follows the finger (${p[1] && Math.hypot(p[1].ox, p[1].oy).toFixed(2)} m)`);
	h.check(p.length === 2 && Math.abs(p[1].ix + p[1].ox) < 1e-9 && Math.abs(p[1].iy + p[1].oy) < 1e-9, '...its in-handle mirrors the out-handle');

	// ---- 2 pinch and two-finger pan place nothing ------------------------------------------------
	const cam0 = await camPos(A.page);
	const mid = { x: 206, y: 520 };
	await twoFingers({ x: mid.x - 30, y: mid.y }, { x: mid.x + 30, y: mid.y }, { x: -70, y: 0 }, { x: 70, y: 0 });
	p = await pen(A.page);
	h.check(p.length === 2, `a pinch places no point (still ${p.length})`);
	const cam1 = await camPos(A.page);
	h.check(moved(cam0, cam1) > 0.01, `...the camera took the pinch (moved ${moved(cam0, cam1).toFixed(3)} m)`);
	await twoFingers({ x: mid.x - 25, y: mid.y }, { x: mid.x + 25, y: mid.y }, { x: 0, y: 80 }, { x: 0, y: 80 });
	p = await pen(A.page);
	h.check(p.length === 2, `a two-finger pan places no point (still ${p.length})`);
	h.check(moved(cam1, await camPos(A.page)) > 0.01, '...the camera took the pan');
	h.check(!(await A.page.locator('#viewport-menu, [data-testid="viewport-menu"]').first().isVisible().catch(() => false)), 'no long-press menu opened');

	// ---- 3 a third point, then a tap on the first closes ------------------------------------------
	const s2 = await h.projectPoint(A.page, w[2]);
	await finger(s2);
	h.check((await pen(A.page)).length === 3, 'a third tap: three points');
	const before = Object.keys(await vectorParams(A.page));
	const depth = await undoDepth(A.page);
	const first = await h.projectPoint(A.page, w[0]);
	await finger({ x: first.x + 6, y: first.y - 5 });
	const now = await vectorParams(A.page);
	const made = Object.keys(now).find((u) => !before.includes(u));
	h.check(!!made && now[made].paths[0].closed && now[made].paths[0].nodes.length === 3, 'a tap on the first point closes the path into a shape');
	h.check((await undoDepth(A.page)) === depth + 1, 'the finished path is ONE create entry');
	await h.eventually(() => vectorParams(B.page), (m) => m[made]?.paths?.[0]?.closed === true, 'B sees the finger-drawn shape');
	await A.page.evaluate(() => window.__stores.vectorTool.disarmVectorTool());

	// ---- 4 Edit points by finger --------------------------------------------------------------------
	await A.page.evaluate((u) => window.__stores.vectorEdit.enterVectorEdit(u), made);
	await A.page.waitForTimeout(400);
	let d = await A.page.evaluate(() => window.__stores.vectorEdit.vectorEditDebug());
	const a0 = d.paths[0].nodes[0];
	const at = d.screen[0][0];
	const editDepth = await undoDepth(A.page);
	await finger({ x: at[0] + 8, y: at[1] + 6 }, { x: at[0] + 70, y: at[1] - 40 }); // 22 px finger reach: 10 px off still picks
	d = await A.page.evaluate(() => window.__stores.vectorEdit.vectorEditDebug());
	h.check(Math.hypot(d.paths[0].nodes[0].x - a0.x, d.paths[0].nodes[0].y - a0.y) > 0.05, 'a finger drag moves the anchor it lands near');
	h.check((await undoDepth(A.page)) === editDepth + 1, '...one undo entry');
	await h.eventually(() => vectorParams(B.page), (m) => Math.abs(m[made].paths[0].nodes[0].x - d.paths[0].nodes[0].x) < 1e-6, 'B sees the moved anchor');
	const recBefore = JSON.stringify((await vectorParams(A.page))[made]);
	const s = d.screen[0][1];
	await twoFingers({ x: s[0], y: s[1] }, { x: s[0] + 50, y: s[1] + 50 }, { x: -40, y: -40 }, { x: 40, y: 40 });
	h.check(JSON.stringify((await vectorParams(A.page))[made]) === recBefore, 'a pinch that starts on an anchor changes nothing in the shape');
	h.check((await undoDepth(A.page)) === editDepth + 1, '...and records nothing');

	await h.finish(browser);
});
