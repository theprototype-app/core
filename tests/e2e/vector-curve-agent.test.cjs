// 64-vector rows 2, 4, 5, 6 in the app, two peers:
//   §1 create_vector (the connector's create_shape {action: 'vector'}): a star, a rounded rect and a closed
//      smooth path on A; B holds each with the same record; one undo each
//   §2 one curve: Shape > Make Path object on the star -> a 78 Path (linear, its 10 corners) on both peers;
//      Shape > Make vector shape on that Path -> a pen path whose corners are the star's; one undo each
//   §3 SVG untrusted: create_vector {kind: 'svg'} with a script, an onload, a foreignObject and an outside
//      image: the shapes import, nothing ran (a canary global stays unset), no request left for the outside
//      host; an SVG with an entity declaration is refused with a sentence
// (Lazy loading is not checked here: debug stores load every module eagerly. The boot proof is the build's
// boot-size diff, and the before-the-chunk path is a unit row in vectorShapes.test.js.)
const h = require('./helpers.cjs');

const tool = (peer, name, args) => peer.page.evaluate(({ name, args }) => window.__tp.test.v1.aiTools.executeAiTool(name, args), { name, args });
const record = (peer, uuid) =>
	peer.page.evaluate((uuid) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		return { gp: o.userData?.geometryParams ?? null, spline: o.userData?.spline ?? null, verts: o.geometry?.attributes?.position?.count ?? 0, name: o.name };
	}, uuid);
const undoDepth = (peer) => peer.page.evaluate(() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((s) => r(s.length))()));
const undo = (peer) => peer.page.evaluate(() => window.__tp.test.v1.history.undo());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	await h.connect(B, A);

	// §1 create_vector ------------------------------------------------------------------------------------
	const d0 = await undoDepth(A);
	const star = await tool(A, 'create_vector', { kind: 'star', count: 5, radius: 0.6, corner: 0, fill: '#ffcc00', position: [-2, 1, 0], name: 'Agent star' });
	h.check(star?.ok === true && typeof star.uuid === 'string', '§1 create_vector made a star ' + JSON.stringify(star).slice(0, 160));
	const rrect = await tool(A, 'create_vector', { kind: 'rect', width: 1.6, height: 0.8, corner: 0.2, fill: '#3366ff', stroke: '#000000', strokeWidth: 0.03, position: [0, 1, 0] });
	const blob = await tool(A, 'create_vector', { kind: 'path', vertices: [[0, 0], [1, 0], [1, 1], [0, 1]], closed: true, smooth: true, fill: '#22aa66', position: [2, 1, 0] });
	h.check(rrect?.ok && blob?.ok, '§1 a rounded rect and a closed smooth path too');
	h.check((await undoDepth(A)) === d0 + 3, '§1 one undo entry per shape');
	for (const [label, made] of [['star', star], ['rounded rect', rrect], ['path', blob]]) {
		const a = await record(A, made.uuid);
		await h.eventually(() => record(B, made.uuid), (b) => !!b && JSON.stringify(b.gp) === JSON.stringify(a.gp) && b.verts === a.verts, `§1 B holds the ${label} with the same record and ${a.verts} vertices`, 20000);
	}
	const bad = await tool(A, 'create_vector', { kind: 'star', count: 99 });
	h.check(typeof bad?.error === 'string' && /count/.test(bad.error), '§1 a wrong field is one plain error: ' + bad?.error);

	// §2 one curve ----------------------------------------------------------------------------------------
	const d1 = await undoDepth(A);
	const pathUuid = await A.page.evaluate((u) => window.__tp.test.v1.vectorCurveActions.vectorToPath(u), star.uuid);
	h.check(typeof pathUuid === 'string', '§2 Make Path object made a Path from the star');
	const p = await record(A, pathUuid);
	h.check(!!p?.spline?.path && p.spline.points.length === 10 && p.spline.closed === true && p.spline.path.smooth === false, `§2 ...a closed LINEAR Path through the star's 10 corners (${p?.spline?.points?.length} points)`);
	h.check(!!(await record(A, star.uuid)), '§2 ...and the star stays');
	h.check((await undoDepth(A)) === d1 + 1, '§2 one undo step');
	await h.eventually(() => record(B, pathUuid), (r) => !!r?.spline?.path && r.spline.points.length === 10, '§2 B has the Path', 20000);
	const back = await A.page.evaluate((u) => window.__tp.test.v1.vectorCurveActions.pathToVector(u), pathUuid);
	const br = await record(A, back);
	const pp = br?.gp?.params;
	h.check(pp?.kind === 'path' && pp.paths[0].nodes.length === 10 && pp.paths[0].closed, '§2 Make vector shape drew the Path as a pen path through its 10 points (the loop kept)');
	h.check(pp?.fillType === 'none' && pp.strokeWidth > 0 && pp.paths[0].nodes.every((n) => n.smooth && (n.ox !== 0 || n.oy !== 0)), '§2 ...an open stroke (not filled) with smooth points (ruling Q1)');
	// the corners land on the star's corners, in the world
	const sameCorners = await A.page.evaluate(
		({ s, b }) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			const S = g.getObjectByProperty('uuid', s);
			const P = g.getObjectByProperty('uuid', b);
			S.updateMatrixWorld(true);
			P.updateMatrixWorld(true);
			const V = S.position.constructor;
			const star = window.__tp.test.v1.vectorRecord.vectorSubpaths(S.userData.geometryParams.params)[0].nodes.map((n) => new V(n.x, n.y, 0).applyMatrix4(S.matrixWorld));
			const pen = P.userData.geometryParams.params.paths[0].nodes.map((n) => new V(n.x, n.y, 0).applyMatrix4(P.matrixWorld));
			return pen.every((q) => star.some((c) => c.distanceTo(q) < 1e-3));
		},
		{ s: star.uuid, b: back }
	);
	h.check(sameCorners, '§2 ...its points sit on the star\'s corners in the world (round trip)');
	await h.eventually(() => record(B, back), (r) => r?.gp?.params?.paths?.[0]?.nodes?.length === 10, '§2 B has the pen path', 20000);
	await undo(A);
	await h.eventually(() => record(B, back), (r) => r === null, '§2 one undo takes the pen path away on both', 20000);

	// §2b ruling Q1: a curved outline is LOSSY — sampled under the 200 cap, said in a toast; a big circle drops points
	const big = await tool(A, 'create_vector', { kind: 'ellipse', width: 20, height: 20, position: [0, 1, -6] });
	const circlePath = await A.page.evaluate((u) => window.__tp.test.v1.vectorCurveActions.vectorToPath(u), big.uuid);
	const cp = await record(A, circlePath);
	h.check(!!cp && cp.spline.points.length <= 200 && cp.spline.points.length > 16 && cp.spline.path.smooth === true, `§2b a 20 m circle becomes a smooth Path of ${cp?.spline?.points?.length} points (<= 200)`);
	h.check(
		await A.page.locator('.tp-toast').filter({ hasText: 'simplified to' }).last().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false),
		'§2b ...and a toast says its curves were simplified (points dropped)'
	);

	// §3 SVG untrusted ------------------------------------------------------------------------------------
	const outside = [];
	A.page.on('request', (r) => {
		if (/evil\.example/.test(r.url())) outside.push(r.url());
	});
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" onload="window.__vecCanary = 1">' +
		'<script>window.__vecCanary = 2</script>' +
		'<foreignObject width="50" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://evil.example/a.png" onerror="window.__vecCanary = 3"/></div></foreignObject>' +
		'<image href="https://evil.example/b.png" width="10" height="10"/>' +
		'<rect x="0" y="0" width="80" height="80" fill="#ff0000" onclick="window.__vecCanary = 4"/>' +
		'<circle cx="150" cy="50" r="40" fill="url(https://evil.example/c.svg#g)"/>' +
		'</svg>';
	const imp = await tool(A, 'create_vector', { kind: 'svg', svg, position: [0, 1, -2] });
	h.check(imp?.ok === true && Array.isArray(imp.uuids) && imp.uuids.length === 2, `§3 the SVG's two shapes imported (${JSON.stringify(imp).slice(0, 200)})`);
	h.check(/script/.test(imp?.note ?? '') && /foreignObject/.test(imp?.note ?? ''), '§3 ...and the answer says what was taken out: ' + imp?.note);
	await A.page.waitForTimeout(1500);
	h.check((await A.page.evaluate(() => window.__vecCanary ?? null)) === null, '§3 nothing in the file ran (the canary is unset)');
	h.check(outside.length === 0, `§3 no request left for the outside host (${outside.length})`);
	const ent = await tool(A, 'create_vector', { kind: 'svg', svg: '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg"><text>&a;</text></svg>' });
	h.check(typeof ent?.error === 'string' && /entit/i.test(ent.error), '§3 an SVG with an entity declaration is refused: ' + ent?.error);

	h.check(A.page.__errors.length === 0 && B.page.__errors.length === 0, `no page errors (${[...A.page.__errors, ...B.page.__errors].join(' | ') || 'none'})`);
	await browser.close();
});
