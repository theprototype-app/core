// 64-int (orchestrator row, 24 Nov 18:45): an imported SVG with ONE path of about 12 000 points, two peers + a reload
// + a late joiner, so 64-vector's wire caps are tested AT SIZE (WIRE_ARRAY_CAP = 4 000 numbers per array: the solid's
// triangles stay home and every peer rebuilds them from the record) — and the record cap (MAX_NODES = 4 000 nodes per
// shape) with it: before the int an oversized path was cut to its first 4 000 nodes and closed by a straight chord
// (QUESTIONS-64-int Q1); now the import simplifies it to fit and says so.
//  1 A imports the file: one shape, a "Simplified ... from 12,000 to ..." toast, at most 4 000 nodes, the outline's
//    area within 1 % of the drawn one; premise: its triangles are past the per-array cap (the heavy path is exercised)
//  2 B (live) sees the shape: same record, same vertex count, same area
//  3 an edit on A (fill colour) reaches B at size
//  4 B reloads and rejoins: the shape again, same vertex count; a late joiner C gets it too
//  5 no binarypack overflow / call-stack error / dropped broadcast anywhere: page errors, console, wireErrors
const h = require('./helpers.cjs');

const N = 12000;
// a closed wavy ring in SVG units (viewBox 0..100): 60 lobes, so simplification has real detail to keep
const ring = [];
for (let i = 0; i < N; i++) {
	const a = (i / N) * Math.PI * 2;
	const r = 40 + 6 * Math.sin(a * 60);
	ring.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
}
const shoelace = (pts) => {
	let s = 0;
	for (let i = 0; i < pts.length; i++) {
		const [ax, ay] = pts[i];
		const [bx, by] = pts[(i + 1) % pts.length];
		s += ax * by - bx * ay;
	}
	return Math.abs(s) / 2;
};
// in the record's units: 1 m = 100 SVG user units (vectorSvg PX_PER_M)
const svgArea = shoelace(ring) / 1e4;
const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
	`<path id="blob" d="M${ring[0][0].toFixed(3)} ${ring[0][1].toFixed(3)} ` +
	ring
		.slice(1)
		.map(([x, y]) => `L${x.toFixed(3)} ${y.toFixed(3)}`)
		.join(' ') +
	' Z" fill="#3366ff" stroke="#112244" stroke-width="0.4"/></svg>';

/** the shape as a peer holds it, null when absent */
const shapeOn = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					if (!o) return resolve(null);
					const p = o.userData.geometryParams?.params;
					const attrs = o.geometry?.attributes ?? {};
					resolve({
						nodes: (p?.paths ?? []).reduce((n, s) => n + (s.nodes?.length ?? 0), 0),
						fill: p?.fill,
						area: p ? window.__stores.vectorBoolean.recordArea(p) : 0,
						verts: attrs.position?.count ?? 0,
						longestArray: Math.max(0, ...Object.values(attrs).map((a) => a.array.length), o.geometry?.index?.array.length ?? 0),
						scale: o.scale.toArray()
					});
				})();
			}),
		uuid
	);
const OVERFLOW = /Maximum call stack|RangeError|binarypack|too much recursion/i;
const problems = async (peer) => {
	const wire = await peer.page.evaluate(() => {
		const w = window.__stores.wireErrors;
		// a reload closes links (ice-* / conn-error): churn, not a lost message — every other row is a failed or dropped message
		return w ? w.wireErrors().filter((r) => !/^ice-|^conn-error$/.test(r.type)).map((r) => `${r.type}:${r.sample}`) : ['no wireErrors hook'];
	});
	const consoleHits = (peer.page.__console ?? []).filter((m) => OVERFLOW.test(m.text)).map((m) => m.text.slice(0, 160));
	return { errors: peer.page.__errors ?? [], console: consoleHits, wire };
};
const clean = (p) => !p.errors.length && !p.console.length && !p.wire.length;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	h.check(SVG.length > 150000 && SVG.length < 2 * 1024 * 1024, `premise: the file is ${(SVG.length / 1024).toFixed(0)} KB, one path of ${N} points (under the 2 MB import cap)`);

	// ---- 1 the import -------------------------------------------------------------------------
	const t0 = Date.now();
	const made = await A.page.evaluate((text) => window.__stores.vectorSvgActions.placeSvg(text, { frame: { origin: [0, 1.2, -2], quat: [0, 0, 0, 1] } }), SVG);
	const importMs = Date.now() - t0;
	h.check(Array.isArray(made) && made.length === 1, `1. the file imports as ONE shape (${JSON.stringify(made)}) in ${importMs} ms`);
	const uuid = made[0];
	const a = await shapeOn(A.page, uuid);
	h.check(!!a && a.nodes <= 4000 && a.nodes > 3600, `1. the path keeps at most 4 000 nodes, simplified, not cut (${a?.nodes})`);
	const sx = a?.scale[0] ?? 1;
	const sy = a?.scale[1] ?? 1;
	const ratio = (a?.area ?? 0) / svgArea;
	h.check(Math.abs(ratio - 1) < 0.01, `1. the outline keeps its area: record ${a?.area.toFixed(2)} vs drawn ${svgArea.toFixed(2)} (ratio ${ratio.toFixed(4)}; a cut path is < 0.5; scale ${sx.toFixed(3)} x ${sy.toFixed(3)})`);
	await h.eventually(
		() => A.page.evaluate(() => document.body.textContent ?? ''),
		(t) => /Simplified .* from 12,000 to [\d,]+ points/.test(t),
		'1. a toast says the path was simplified and to how many points',
		10000
	);
	h.check((a?.longestArray ?? 0) > 4000, `1. premise: one geometry array is past WIRE_ARRAY_CAP (${a?.longestArray} > 4 000), so the triangles stay home and peers rebuild`);

	// ---- 2 the live peer --------------------------------------------------------------------
	await h.eventually(() => shapeOn(B.page, uuid), (b) => !!b && b.nodes === a.nodes && b.verts === a.verts, `2. B sees the shape: ${a?.nodes} nodes, ${a?.verts} vertices`, 60000);
	const b = await shapeOn(B.page, uuid);
	h.check(!!b && Math.abs(b.area - a.area) < 1e-6, `2. ...the same outline on B (area ${b?.area.toFixed(4)})`);

	// ---- 3 an edit at size --------------------------------------------------------------------
	await A.page.evaluate((uuid) => window.__stores.vectorActions.setVectorParams(uuid, { fill: '#ff8800' }), uuid);
	await h.eventually(() => shapeOn(B.page, uuid), (s) => s?.fill === '#ff8800' && s.verts === a.verts, '3. a fill change on the 4 000-node record reaches B', 60000);

	// ---- 4 reload + a late joiner -------------------------------------------------------------
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await B.page.waitForFunction(() => !!window.__tp?.test?.v1?.peers, null, { timeout: 150000 });
	await h.eventually(() => shapeOn(B.page, uuid), (s) => !!s && s.nodes === a.nodes && s.verts === a.verts && s.fill === '#ff8800', '4. B reloads, rejoins and has the shape again', 120000);
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	await h.eventually(() => shapeOn(C.page, uuid), (s) => !!s && s.nodes === a.nodes && s.verts === a.verts, '4. a late joiner gets it too', 120000);

	// ---- 5 nothing overflowed or dropped ----------------------------------------------------------
	for (const [name, peer] of [['A', A], ['B', B], ['C', C]]) {
		const p = await problems(peer);
		h.check(clean(p), `5. ${name}: no page error, no overflow in the console, no wire error (${JSON.stringify(p).slice(0, 400)})`);
	}

	await h.finish(browser);
});
