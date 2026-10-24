// Roadmap 64 D3 + D1 SVG — booleans (union / subtract / intersect / exclude), outline stroke,
// inset / outset, SVG export -> import identical, a foreign SVG through SVGLoader — and a peer
// sees every step with ONE undo entry each. Areas are the property that matters: a boolean off
// by a ring is off by an area.
const h = require('./helpers.cjs');

const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
/** record + world pose of a shape, null when it is gone */
const shape = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					if (!o) return resolve(null);
					o.updateMatrixWorld(true);
					const p = o.userData.geometryParams?.params;
					resolve({
						params: p,
						area: p ? window.__stores.vectorBoolean.recordArea(p) : 0,
						world: o.matrixWorld.toArray(),
						name: o.name
					});
				})();
			}),
		uuid
	);
const add = (page, params, position) =>
	page.evaluate(([params, position]) => window.__stores.vectorActions.addVectorShape({ ...window.__stores.vectorRecord.vectorDefaults(params.kind), ...params }, { position, select: false })?.uuid, [params, position]);
const close = (a, b, tol) => Math.abs(a - b) <= tol;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- booleans: two unit squares overlapping by half ----------------------
	const cases = [
		['union', 1.5],
		['subtract', 0.5],
		['intersect', 0.5],
		['exclude', 1.0]
	];
	for (const [op, area] of cases) {
		const left = await add(A.page, { kind: 'rect', width: 1, height: 1, fill: '#3366ff' }, [0, 1, -1]);
		const right = await add(A.page, { kind: 'rect', width: 1, height: 1, fill: '#ff3366' }, [0.5, 1, -1]);
		await h.eventually(() => shape(B.page, right), (s) => !!s, `${op}: both squares reach B`);
		const depth = await undoDepth(A.page);
		const result = await A.page.evaluate(([op, uuids]) => window.__stores.vectorOps.combineShapes(op, uuids), [op, [left, right]]);
		h.check(result === left, `${op}: the first shape is the subject (it survives)`);
		const after = await shape(A.page, left);
		h.check(close(after?.area ?? 0, area, 0.01), `${op}: area ${area} (got ${after?.area?.toFixed(4)})`);
		h.check(after?.params.fill === '#3366ff', `${op}: the result keeps the subject's look`);
		h.check(!(await shape(A.page, right)), `${op}: the other shape is consumed`);
		h.check((await undoDepth(A.page)) === depth + 1, `${op}: exactly one undo entry`);
		await h.eventually(
			() => Promise.all([shape(B.page, left), shape(B.page, right)]),
			([l, r]) => !!l && !r && close(l.area, area, 0.01) && l.world.every((v, i) => close(v, after.world[i], 1e-5)),
			`${op}: B sees the result in the same place and the other shape gone`
		);
		await A.page.evaluate(() => window.__stores.history.undo());
		await h.eventually(
			() => Promise.all([shape(B.page, left), shape(B.page, right)]),
			([l, r]) => !!l && !!r && close(l.area, 1, 0.01) && close(r.area, 1, 0.01),
			`${op}: one undo brings both squares back on B`
		);
		await A.page.evaluate((uuids) => window.__stores.objectActions.deleteObjectsByUuid(uuids), [left, right]);
	}

	// out of plane is refused
	const flat = await add(A.page, { kind: 'rect' }, [3, 1, 0]);
	const tilted = await A.page.evaluate(() => {
		const { addVectorShape } = window.__stores.vectorActions;
		const m = addVectorShape({ kind: 'ellipse' }, { position: [3.2, 1, 0], quaternion: [0, 0.3826834, 0, 0.9238795], select: false });
		return m?.uuid;
	});
	const refused = await A.page.evaluate(([a, b]) => window.__stores.vectorOps.combineShapes('union', [a, b]), [flat, tilted]);
	h.check(refused === null && !!(await shape(A.page, tilted)), 'a shape tilted out of the subject\'s plane is refused (nothing consumed)');
	await A.page.evaluate((uuids) => window.__stores.objectActions.deleteObjectsByUuid(uuids), [flat, tilted]);

	// ---- outline stroke ------------------------------------------------------
	const stroked = await add(A.page, { kind: 'rect', width: 1, height: 1, strokeWidth: 0.1, stroke: '#112233', join: 'miter' }, [-2, 1, -1]);
	let depth = await undoDepth(A.page);
	const outline = await A.page.evaluate((uuid) => window.__stores.vectorOps.outlineShape(uuid), stroked);
	const o = await shape(A.page, outline);
	const src = await shape(A.page, stroked);
	// a centred 0.1 stroke on a unit square: (1.1)^2 - (0.9)^2 = 0.4
	h.check(close(o?.area ?? 0, 0.4, 0.01) && o.params.fill === '#112233' && o.params.strokeWidth === 0, `outline stroke: a filled ring of the stroke colour (area ${o?.area?.toFixed(3)})`);
	h.check(src?.params.strokeWidth === 0 && close(src.area, 1, 1e-6), 'the source keeps its fill and loses its stroke');
	h.check((await undoDepth(A.page)) === depth + 1, 'outline stroke is one undo entry');
	await h.eventually(() => shape(B.page, outline), (s) => !!s && close(s.area, 0.4, 0.01), 'B sees the outline');

	// ---- inset / outset ------------------------------------------------------
	const square = await add(A.page, { kind: 'rect', width: 1, height: 1, join: 'miter' }, [-4, 1, -1]);
	depth = await undoDepth(A.page);
	await A.page.evaluate((uuid) => window.__stores.vectorOps.offsetVector(uuid, 0.05), square);
	const out = await shape(A.page, square);
	h.check(close(out?.area ?? 0, 1.21, 0.005), `outset 5 cm (miter): 1.1 x 1.1 (area ${out?.area?.toFixed(4)})`);
	await A.page.evaluate((uuid) => window.__stores.vectorOps.offsetVector(uuid, -0.1), square);
	const ins = await shape(A.page, square);
	h.check(close(ins?.area ?? 0, 0.81, 0.005), `then inset 10 cm: 0.9 x 0.9 (area ${ins?.area?.toFixed(4)})`);
	h.check((await undoDepth(A.page)) === depth + 2, 'each offset is one undo entry');
	await h.eventually(() => shape(B.page, square), (s) => close(s?.area ?? 0, 0.81, 0.005), 'B sees the inset');

	// ---- SVG: export -> import identical ------------------------------------
	const star = await add(A.page, { kind: 'star', radius: 0.6, points: 7, corner: 0.05, fill: '#ffaa00', strokeWidth: 0.02, dash: 0.05, gap: 0.03 }, [0, 2, -3]);
	const ell = await add(A.page, { kind: 'ellipse', width: 1.4, height: 0.7, fillType: 'radial', fill: '#ffffff', fill2: '#0044ff' }, [1.2, 2.3, -3]);
	const pen = await A.page.evaluate(() => {
		const { addVectorShape } = window.__stores.vectorActions;
		const { vectorDefaults } = window.__stores.vectorRecord;
		const paths = [{ closed: true, nodes: [{ x: -0.5, y: 0, ix: 0, iy: 0, ox: 0.2, oy: 0.4, smooth: false }, { x: 0.5, y: 0, ix: 0.1, iy: 0.3, ox: 0, oy: 0, smooth: false }, { x: 0, y: -0.6, ix: 0, iy: 0, ox: 0, oy: 0, smooth: false }] }];
		return addVectorShape({ ...vectorDefaults('path'), paths, fillType: 'linear', gradAngle: 30, fill: '#00ff88', fill2: '#8800ff' }, { position: [-1.1, 1.8, -3], quaternion: [0, 0, 0.2588190, 0.9659258], select: false })?.uuid;
	});
	const originals = [star, ell, pen];
	const svg = await A.page.evaluate((uuids) => window.__stores.vectorSvgActions.exportShapesSvg(uuids), originals);
	h.check(typeof svg === 'string' && svg.includes('<svg') && (svg.match(/<path\b/g) ?? []).length === 3, 'export writes one <path> per shape');
	h.check(/linearGradient/.test(svg) && /radialGradient/.test(svg) && /stroke-dasharray/.test(svg), 'the SVG carries both gradients and the dash');
	depth = await undoDepth(A.page);
	const imported = await A.page.evaluate((text) => window.__stores.vectorSvgActions.placeSvg(text, { frame: { origin: [0, 1, 3], quat: [0, 0, 0, 1] } }), svg);
	h.check(imported.length === 3, 'importing our own SVG makes three shapes');
	h.check((await undoDepth(A.page)) === depth + 1, 'the whole import is ONE undo entry');
	const before = await Promise.all(originals.map((u) => shape(A.page, u)));
	const again = await Promise.all(imported.map((u) => shape(A.page, u)));
	h.check(
		again.every((s, i) => JSON.stringify(s?.params) === JSON.stringify(before[i]?.params)),
		'export -> import: every record is IDENTICAL'
	);
	// relative placement: shape k in shape 0's frame, before and after
	const relative = (list) =>
		A.page.evaluate((mats) => {
			let Matrix4;
			window.__stores.globalScene.subscribe((s) => (Matrix4 = s.matrix.constructor))();
			const inv = new Matrix4().fromArray(mats[0]).invert();
			return mats.slice(1).map((m) => new Matrix4().multiplyMatrices(inv, new Matrix4().fromArray(m)).toArray());
		}, list.map((s) => s.world));
	const relBefore = await relative(before);
	const relAfter = await relative(again);
	h.check(
		relBefore.every((m, k) => m.every((v, i) => close(v, relAfter[k][i], 1e-4))),
		'export -> import: the shapes sit in the same places relative to each other'
	);
	await h.eventually(() => Promise.all(imported.map((u) => shape(B.page, u))), (list) => list.every((s, i) => JSON.stringify(s?.params) === JSON.stringify(before[i]?.params)), 'B sees the imported shapes with the same records');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => Promise.all(imported.map((u) => shape(B.page, u))), (list) => list.every((s) => !s), 'one undo removes the whole import on B');

	// ---- a foreign SVG through SVGLoader --------------------------------------
	const foreign =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect x="0" y="0" width="100" height="50" fill="#ff0000"/>' +
		'<circle cx="200" cy="50" r="50" fill="#00ff00" stroke="#000000" stroke-width="4"/>' +
		'<path d="M 250 0 L 300 0 L 300 100 Z" fill="none" stroke="#0000ff" stroke-width="2" stroke-linejoin="round"/></svg>';
	const fromForeign = await A.page.evaluate((text) => window.__stores.vectorSvgActions.placeSvg(text, { frame: { origin: [0, 1, 5], quat: [0, 0, 0, 1] } }), foreign);
	h.check(fromForeign.length === 3, 'a foreign SVG imports three shapes (rect, circle, path)');
	const fs = await Promise.all(fromForeign.map((u) => shape(A.page, u)));
	const red = fs.find((s) => s?.params.fill === '#ff0000');
	const green = fs.find((s) => s?.params.fill === '#00ff00');
	const blue = fs.find((s) => s?.params.stroke === '#0000ff' && s.params.fillType === 'none');
	h.check(close(red?.area ?? 0, 0.5, 0.002), `the rect is 1 m x 0.5 m (100 px = 1 m; area ${red?.area?.toFixed(4)})`);
	h.check(close(green?.area ?? 0, Math.PI * 0.25, 0.01) && green.params.strokeWidth === 0.04, `the circle keeps its area and its 4 px stroke (area ${green?.area?.toFixed(4)})`);
	h.check(!!blue && blue.params.join === 'round' && close(blue.params.strokeWidth, 0.02, 1e-6), 'an unfilled path imports as a stroked line with its join');
	await h.eventually(() => Promise.all(fromForeign.map((u) => shape(B.page, u))), (list) => list.every((s) => !!s), 'B sees the foreign import');

	await h.finish(browser);
});
