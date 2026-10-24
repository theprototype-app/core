// 64 D2 — TEXT ON A PATH (the static half): text that follows a curve, styled letter by letter.
//
// A text object is a carrier mesh holding `userData.textPath`; troika typesets the string and
// the runtime sits every glyph on the path through three instanced rows in the vertex shader.
// The letters are measured, not looked at: `textPathDebug()` reports each glyph's BASELINE point
// (where its advance centre meets the baseline, world space), its scale, its reading direction
// and its colour, from the same rows the GPU draws with.
//
//   §1 /create Text on two peers: the letters sit on the arc (each baseline point at the
//      radius), read left to right over the crown, and B lays out the same letters as A
//   §2 the path changes (line, wave, circle, side, align): the letters follow
//   §3 per-letter colour / size / rotation: the GPU attributes say so, on both peers
//   §4 undo / redo of a letter edit, on both peers; a text edit carries the styles along
//   §5 "Put text on this path" on a spline: the baseline hugs the tube, follows when the
//      spline moves, is ONE undo step
//   §6 the Inspector: typing is ONE undo step, a letter cell styles that letter
//   §7 a save round trip (toJSON -> ObjectLoader) keeps the record
//   §8 VR (IWER Quest 3): the controller's beam ends on the text (the hit proxy)
//
// Counterfactual: v1.42.0 has no Text kind — `/create Text` makes nothing, every row is red.
// Run: e2e-slot --dev <lane> 5418 -- env APP_URL=https://localhost:5418/ npm run e2e -- text-path
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const OUT = process.env.E2E_OUT ?? 'test-results/64-text';

/** @param {any} page */
const dbg = (page) => page.evaluate(() => window.__stores.textPath.textPathDebug());
/** @param {any} page @param {string} uuid */
const one = async (page, uuid) => (await dbg(page)).find((d) => d.uuid === uuid);
/** @param {any} page @param {string} uuid @param {any} patch */
const set = (page, uuid, patch) => page.evaluate(([u, p]) => !!window.__stores.textPathEdit.setTextPathFor(u, p), [uuid, patch]);
/** @param {any} page @param {string} uuid */
const record = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return JSON.parse(JSON.stringify(g.getObjectByProperty('uuid', u)?.userData?.textPath ?? null));
	}, uuid);
/** wait until a text has laid out with `pred` true @param {any} page @param {string} uuid @param {(d: any) => boolean} pred @param {string} label */
async function until(page, uuid, pred, label, timeout = 20000) {
	await h.eventually(async () => (await one(page, uuid)) ?? null, (d) => !!d && d.synced && pred(d), label, timeout);
	return one(page, uuid);
}
/** visible glyphs' baseline points @param {any} d */
const pts = (d) => d.baseline.filter((/** @type {any} */ _, /** @type {number} */ i) => !d.off[i]);
const dist = (/** @type {number[]} */ a, /** @type {number[]} */ b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const r3 = (/** @type {number[]} */ p) => p.map((v) => +v.toFixed(3));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- §1 ------------------------------------------------------------------------------
	const uuid = await A.page.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Text', [0, 0, 0]).uuid);
	const a1 = await until(A.page, uuid, (d) => d.glyphs > 0, '§1 premise: A laid the default text out');
	const b1 = await until(B.page, uuid, (d) => d.glyphs > 0, '§1 premise: B received the /create and laid it out too');
	const rec = await record(A.page, uuid);
	console.log(`  record path ${JSON.stringify(rec.path)}, ${a1.glyphs} glyphs, baseline[0] ${r3(a1.baseline[0])}`);
	h.check(a1.glyphs === 11 && a1.hidden === 0, `"Text on a path" is 11 visible glyphs (${a1.glyphs}, ${a1.hidden} off the path)`);
	const radii = pts(a1).map((p) => Math.hypot(p[0], p[1]));
	h.check(
		radii.every((r) => Math.abs(r - 2) < 0.06) && pts(a1).every((p) => Math.abs(p[2]) < 1e-3),
		`§1 every baseline point is on the radius-2 arc in the XY plane (${radii.map((r) => r.toFixed(3)).join(' ')})`
	);
	const xs = pts(a1).map((p) => p[0]);
	h.check(
		xs.every((x, i) => i === 0 || x > xs[i - 1]),
		'§1 the letters read left to right over the crown (x increases glyph by glyph)'
	);
	const mid = pts(a1)[5];
	h.check(Math.abs(mid[0]) < 0.6 && mid[1] > 1.9, `§1 a centred text sits on the crown (glyph 6 at ${r3(mid)})`);
	h.check(a1.proxyTris === a1.glyphs * 2, `§1 the hit proxy is one quad per glyph (${a1.proxyTris} triangles)`);
	h.check(
		b1.glyphs === a1.glyphs && b1.baseline.every((p, i) => dist(p, a1.baseline[i]) < 1e-3),
		'§1 B lays out the same letters at the same places'
	);

	// ---- §2 ------------------------------------------------------------------------------
	await set(A.page, uuid, { path: { kind: 'line', length: 6 } });
	const a2 = await until(A.page, uuid, (d) => pts(d).every((p) => Math.abs(p[1]) < 1e-3), '§2 a straight line: every baseline point at y = 0');
	h.check(Math.abs((pts(a2)[0][0] + pts(a2).at(-1)[0]) / 2) < 0.3, `§2 centred on the line (first ${r3(pts(a2)[0])}, last ${r3(pts(a2).at(-1))})`);
	await set(A.page, uuid, { align: 'start' });
	const a2s = await until(A.page, uuid, (d) => pts(d)[0][0] < -2.8, '§2 align start: the text begins at the line\'s start (x = -3)');
	h.check(pts(a2s)[0][0] > -3.01, `§2 ...and not before it (${r3(pts(a2s)[0])})`);
	await set(A.page, uuid, { path: { kind: 'wave', length: 6, amplitude: 0.5, wavelength: 3 }, align: 'center' });
	const a2w = await until(A.page, uuid, (d) => Math.max(...pts(d).map((p) => Math.abs(p[1]))) > 0.3, '§2 a wave: the baseline rises and falls');
	h.check(
		pts(a2w).every((p) => Math.abs(p[1] - 0.5 * Math.sin((2 * Math.PI * (p[0] + 3)) / 3)) < 0.05),
		'§2 every baseline point is on y = 0.5·sin(2π(x+3)/3)'
	);
	await set(A.page, uuid, { path: { kind: 'circle', radius: 1.5 }, align: 'fit' });
	const a2c = await until(A.page, uuid, (d) => pts(d).every((p) => Math.abs(Math.hypot(p[0], p[1]) - 1.5) < 0.06), '§2 a circle of radius 1.5');
	const ang = pts(a2c).map((p) => Math.atan2(p[1], p[0]));
	const gaps = ang.map((a, i) => (i ? ((ang[i - 1] - a + 4 * Math.PI) % (2 * Math.PI)) : 0)).slice(1);
	h.check(Math.max(...gaps) < 1.2, `§2 'fit' spreads the letters round the whole circle (largest gap ${Math.max(...gaps).toFixed(2)} rad)`);
	await set(A.page, uuid, { path: { kind: 'arc', radius: 2 }, align: 'center', side: 'right' });
	const a2r = await until(A.page, uuid, (d) => pts(d)[0][0] > pts(d).at(-1)[0], '§2 side "right": the arc runs backwards (the text reads right to left along x)');
	h.check(pts(a2r).every((p) => Math.abs(Math.hypot(p[0], p[1]) - 2) < 0.06), '§2 ...still on the same arc');
	await set(A.page, uuid, { side: 'left', path: { kind: 'arc', radius: 2 } });
	await until(A.page, uuid, (d) => pts(d)[0][0] < pts(d).at(-1)[0], '§2 back to the default side');
	const b2 = await until(B.page, uuid, (d) => pts(d)[0][0] < pts(d).at(-1)[0] && pts(d).every((p) => Math.abs(Math.hypot(p[0], p[1]) - 2) < 0.06), '§2 B followed every path edit');
	h.check(!!b2, '§2 B is on the same arc');

	// ---- §3 ------------------------------------------------------------------------------
	const before3 = await one(A.page, uuid);
	await A.page.evaluate((u) => {
		const e = window.__stores.textPathEdit;
		e.setLetterStyle(u, [0], { color: '#ff0000', size: 2 });
		e.setLetterStyle(u, [1], { rot: 90 });
	}, uuid);
	const a3 = await until(A.page, uuid, (d) => d.colors[0] === 255 && d.colors[1] === 0, '§3 letter 1 is red in the GPU colour attribute');
	h.check(a3.colors.slice(3).every((c) => c === 255), '§3 ...and only letter 1');
	h.check(Math.abs(a3.scales[0] - 2) < 1e-3 && Math.abs(a3.scales[2] - 1) < 1e-3, `§3 letter 1 is twice the size (${a3.scales[0].toFixed(3)}), letter 3 unchanged`);
	const turn = (/** @type {any} */ d, /** @type {number} */ g) =>
		(Math.acos(Math.max(-1, Math.min(1, d.axes[g].reduce((s, v, i) => s + v * d.axes[g + 1][i], 0)))) * 180) / Math.PI;
	h.check(Math.abs(turn(a3, 1) - 90) < 8, `§3 letter 2 is turned 90° against its neighbour (${turn(a3, 1).toFixed(1)}°)`);
	h.check(dist(a3.baseline[1], a3.baseline[0]) > dist(before3.baseline[1], before3.baseline[0]) + 0.05, '§3 the bigger letter pushes its neighbours along the path');
	const b3 = await until(B.page, uuid, (d) => d.colors[0] === 255 && d.colors[1] === 0 && Math.abs(d.scales[0] - 2) < 1e-3, '§3 B shows the red, doubled letter');
	h.check(b3.baseline.every((p, i) => dist(p, a3.baseline[i]) < 1e-3), '§3 B lays the styled letters out exactly like A');

	// ---- §4 ------------------------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.history.undo()); // the rotation
	await A.page.evaluate(() => window.__stores.history.undo()); // the colour + size
	await until(A.page, uuid, (d) => d.colors[0] === 255 && d.colors[1] === 255 && Math.abs(d.scales[0] - 1) < 1e-3, '§4 two undos: letter 1 white and normal size on A');
	await until(B.page, uuid, (d) => d.colors[1] === 255 && Math.abs(d.scales[0] - 1) < 1e-3, '§4 ...and on B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await until(B.page, uuid, (d) => d.colors[1] === 0 && Math.abs(d.scales[0] - 2) < 1e-3, '§4 redo brings the red letter back on B');
	await set(A.page, uuid, { text: 'My Text on a path' });
	const r4 = await record(A.page, uuid);
	h.check(JSON.stringify(Object.keys(r4.letters)) === '["3"]' && r4.letters['3'].color === '#ff0000', `§4 the style moved with its letter when text was typed in front (${JSON.stringify(r4.letters)})`);
	await until(B.page, uuid, (d) => d.text === 'My Text on a path' && d.glyphs === 13 && d.colors[2 * 3] === 255 && d.colors[2 * 3 + 1] === 0, '§4 B shows the new text with the red T');

	// ---- §5 ------------------------------------------------------------------------------
	const spline = await A.page.evaluate(() => {
		const s = window.__stores.splineTool;
		for (const p of [[-3, 0.3, 4], [-1, 0.3, 5], [1, 0.3, 4], [3, 0.3, 5]]) s.addSplinePoint({ x: p[0], y: p[1], z: p[2] }, 0.1);
		return s.finishSpline()?.uuid;
	});
	h.check(!!spline, '§5 premise: a spline exists');
	const linked = await A.page.evaluate((u) => window.__stores.textPathEdit.putTextOnPath(u, 'Along the road')?.uuid, spline);
	const a5 = await until(A.page, linked, (d) => d.linked && d.glyphs === 12, '§5 the text is linked to the spline and laid out');
	const samples = await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		o.updateWorldMatrix(true, false);
		const curve = window.__stores.splineTube.splineCurve(o.userData.spline);
		const out = [];
		for (let i = 0; i <= 400; i++) out.push(curve.getPoint(i / 400).applyMatrix4(o.matrixWorld).toArray());
		return out;
	}, spline);
	const offCurve = (/** @type {number[]} */ p) => Math.min(...samples.map((s) => dist(p, s)));
	const lift = (await record(A.page, linked)).shift;
	h.check(
		pts(a5).every((p) => Math.abs(offCurve(p) - lift) < 0.05),
		`§5 every baseline point is ${lift.toFixed(2)} m (the tube's radius + a gap) off the spline (${pts(a5).map((p) => offCurve(p).toFixed(3)).join(' ')})`
	);
	h.check(pts(a5).every((p) => p[1] > 0.3), '§5 ...above it: the letters stand on the road');
	const poses = (/** @type {any} */ page) =>
		page.evaluate(([s, t]) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return [s, t].map((u) => g.getObjectByProperty('uuid', u)?.position.toArray().map((v) => +v.toFixed(3)));
		}, [spline, linked]);
	console.log(`  spline / text positions: A ${JSON.stringify(await poses(A.page))}, B ${JSON.stringify(await poses(B.page))}`);
	await until(B.page, linked, (d) => d.linked && d.baseline.every((p, i) => dist(p, a5.baseline[i]) < 1e-3), '§5 B links the same text to its copy of the spline');
	// move the spline on A (a real replicated move): the text follows on both
	await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		o.position.x += 2;
		let peer;
		window.__stores.peers.subscribe((v) => (peer = v))();
		peer.send({ type: 'move', uuid: u, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
	}, spline);
	await until(A.page, linked, (d) => Math.abs(d.baseline[0][0] - a5.baseline[0][0] - 2) < 1e-3, '§5 moving the spline 2 m carries the text 2 m on A');
	await until(B.page, linked, (d) => Math.abs(d.baseline[0][0] - a5.baseline[0][0] - 2) < 1e-3, '§5 ...and on B (no pose of its own was sent)');
	await A.page.evaluate(() => window.__stores.history.undo()); // the move is not in history (raw send) — this undoes the put
	await h.eventually(async () => (await dbg(A.page)).some((d) => d.uuid === linked), (v) => v === false, '§5 ONE undo removes the linked text on A');
	await h.eventually(async () => (await dbg(B.page)).some((d) => d.uuid === linked), (v) => v === false, '§5 ...and on B');

	// ---- §6 ------------------------------------------------------------------------------
	await A.page.evaluate((u) => {
		window.__stores.objectActions.selectObject(u, true);
	}, uuid);
	const field = A.page.locator('#text-path-text');
	await field.waitFor({ timeout: 15000 });
	const undoDepth = () => A.page.evaluate(() => {
		let s;
		window.__stores.history.undoStack.subscribe((v) => (s = v))();
		return s.length;
	});
	const depth0 = await undoDepth();
	await field.click();
	await A.page.keyboard.press('End');
	await A.page.keyboard.type('!!!', { delay: 40 });
	await field.blur();
	await until(A.page, uuid, (d) => d.text === 'My Text on a path!!!', '§6 typing in the Inspector edits the text');
	await until(B.page, uuid, (d) => d.text === 'My Text on a path!!!', '§6 ...on B as well');
	h.check((await undoDepth()) === depth0 + 1, `§6 three keystrokes are ONE undo step (${(await undoDepth()) - depth0})`);
	await A.page.locator('[data-letter="4"]').click();
	await A.page.locator('#text-path-letter-color').fill('#00ff00');
	const a6 = await until(A.page, uuid, (d) => d.colors[3 * 3] === 0 && d.colors[3 * 3 + 1] === 255, '§6 the letter cell "e" styled green from the Inspector');
	h.check(a6.colors[2 * 3] === 255 && a6.colors[2 * 3 + 1] === 0, '§6 ...the red T beside it untouched');
	await A.page.screenshot({ path: `${OUT}/text-path-inspector.png` });
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.evaluate(() => window.__stores.history.undo());
	await until(B.page, uuid, (d) => d.text === 'My Text on a path' && d.colors[3 * 3] === 255, '§6 two undos take back the colour and the whole typed word (on B)');

	// ---- §7 ------------------------------------------------------------------------------
	const round = await A.page.evaluate(async (u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		const THREE = window.__stores.THREE;
		const copy = new THREE.ObjectLoader().parse(JSON.parse(JSON.stringify(o.toJSON())));
		return { before: JSON.stringify(o.userData.textPath), after: JSON.stringify(copy.userData.textPath) };
	}, uuid);
	h.check(round.before === round.after, '§7 the record survives a toJSON -> ObjectLoader round trip unchanged');

	for (const P of [A, B]) h.check(h.pageErrors(P).length === 0, `no page errors on ${P === A ? 'A' : 'B'} (${h.pageErrors(P).join(' | ')})`);
	// the headset gets the machine to itself (a third page beside two live peers boots slowly)
	await h.closePeer(A);
	await h.closePeer(B);

	// ---- §8 ------------------------------------------------------------------------------
	const C = await h.setupPage(browser, 'C', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const vr = await C.page.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Text', [0, 0, -3]).uuid);
	await until(C.page, vr, (d) => d.glyphs > 0, '§8 premise: a text in front of the headset');
	await iwer.enter(C.page);
	await iwer.pose(C.page, 'right', [0.2, 1.2, 0], { yaw: 0, pitch: 0.29 });
	await iwer.frames(C.page, 10);
	const beam = await C.page.evaluate(() => {
		const v = window.__stores.vrControls;
		/** @type {any} */
		const out = [];
		for (const i of [0, 1]) {
			const ray = v.controllerRay(i);
			const t = ray ? v.beamTarget(ray) : null;
			out.push(t?.object?.uuid ?? null);
		}
		return out;
	});
	const c8 = await one(C.page, vr);
	h.check(beam.includes(vr), `§8 the right controller's beam ends on the text (${JSON.stringify(beam)})`);
	h.check(!!c8?.visible, '§8 the letters are drawn while presenting');
	await C.page.screenshot({ path: `${OUT}/text-path-vr.png` });
	await iwer.exit(C.page);

	h.check(h.pageErrors(C).length === 0, `no page errors on C (${h.pageErrors(C).join(' | ')})`);
	await h.finish(browser);
});
