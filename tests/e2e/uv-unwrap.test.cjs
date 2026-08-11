// UV unwrap + island/selection ops.
//
// Unwrap is a REGISTRY (`unwrap(faces, options) -> {uvs, islands}`) so a module can
// add a heavier automatic backend later without the core carrying it; the built-ins
// are projections plus a shelf packer, pure JS and deterministic.
//
// The assertions below are about PROPERTIES, not exact numbers: a projection is
// "in 0..1, aspect preserved, one island per cube side", and a pack is "nothing
// overlaps". Pinning exact float output would make the suite a change-detector that
// breaks on any harmless reordering.
const h = require('./helpers.cjs');

const openOnObject = async (page, command, name) => {
	const uuid = await page.evaluate(
		async ({ command, name }) => {
			const w = window.__stores;
			w.commandsHandler.sceneCommand(command);
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const object = g.children[g.children.length - 1];
			object.name = name;
			w.objectActions.selectObject(object.uuid);
			w.uvEditorClose.set(false);
			w.bottomDock.activateDock('uv');
			return object.uuid;
		},
		{ command, name }
	);
	await page.waitForTimeout(600);
	return uuid;
};

/** per-triangle uvs, index-expanded (a commit rebuilds the geometry non-indexed) */
const uvTris = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const uv = geo.attributes.uv;
		const index = geo.index;
		const count = index ? index.count : uv.count;
		const out = [];
		for (let i = 0; i < count; i += 3)
			out.push(
				[0, 1, 2].map((o) => {
					const j = index ? index.getX(i + o) : i + o;
					return [uv.getX(j), uv.getY(j)];
				})
			);
		return out;
	}, uuid);

/** do any two triangles' bounding boxes overlap? (a cheap packing check) */
const overlaps = (tris, groupsOf) => {
	const boxes = groupsOf.map((group) => {
		let uMin = Infinity, vMin = Infinity, uMax = -Infinity, vMax = -Infinity;
		for (const t of group)
			for (const [u, v] of tris[t]) {
				uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
				vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
			}
		return { uMin, vMin, uMax, vMax };
	});
	let hits = 0;
	for (let i = 0; i < boxes.length; i++)
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i], b = boxes[j];
			const gap = 1e-6;
			if (a.uMin < b.uMax - gap && b.uMin < a.uMax - gap && a.vMin < b.vMax - gap && b.vMin < a.vMax - gap)
				hits++;
		}
	return hits;
};

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- the registry ----------
	const registry = await A.page.evaluate(() =>
		window.__stores.uvUnwrap.unwrapBackends().map((b) => b.key)
	);
	h.check(
		['box', 'planar', 'cylindrical', 'spherical'].every((k) => registry.includes(k)),
		`the four built-in backends are registered (${registry.join(',')})`
	);
	const pluggable = await A.page.evaluate(() => {
		const u = window.__stores.uvUnwrap;
		u.registerUnwrapBackend('zzz-test', 'Test backend', (faces) => ({
			uvs: faces.map(() => [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75]]),
			islands: [faces.map((_, i) => i)]
		}));
		return u.unwrapBackends().some((b) => b.key === 'zzz-test');
	});
	h.check(pluggable, 'a backend can be REGISTERED at runtime (the module seam)');

	// ---------- a cube's six sides stop sharing one UV square ----------
	const uuid = await openOnObject(A.page, '/create Box 1 1 1', 'unwrapBox');
	const before = await uvTris(A.page, uuid);
	const distinctBefore = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const uv = g.getObjectByProperty('uuid', uuid).geometry.attributes.uv;
		const seen = new Set();
		for (let i = 0; i < uv.count; i++) seen.add(uv.getX(i).toFixed(3) + ',' + uv.getY(i).toFixed(3));
		return seen.size;
	}, uuid);
	h.check(distinctBefore === 4, `premise: the cube starts with 4 distinct uv coords - all sides stacked (${distinctBefore})`);
	h.check(before.length === 12, `premise: 12 triangles (${before.length})`);

	const depth0 = await undoDepth(A.page);
	const ran = await A.page.evaluate(
		(uuid) => window.__stores.uvEditor.unwrapObject(uuid, 'box', { margin: 0.02 }),
		uuid
	);
	await A.page.waitForTimeout(600);
	h.check(ran, 'box unwrap commits');
	const after = await uvTris(A.page, uuid);
	const flat = after.flat().flat();
	h.check(
		flat.every((n) => n >= -1e-6 && n <= 1 + 1e-6),
		`THE FEATURE: every uv lands inside 0..1 (min ${Math.min(...flat).toFixed(3)}, max ${Math.max(...flat).toFixed(3)})`
	);
	const distinctAfter = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const uv = g.getObjectByProperty('uuid', uuid).geometry.attributes.uv;
		const seen = new Set();
		for (let i = 0; i < uv.count; i++) seen.add(uv.getX(i).toFixed(3) + ',' + uv.getY(i).toFixed(3));
		return seen.size;
	}, uuid);
	h.check(
		distinctAfter > 4,
		`THE FEATURE: the six sides no longer share one square (${distinctBefore} -> ${distinctAfter} distinct coords)`
	);
	// each cube side is 2 triangles; a box unwrap must give 6 non-overlapping islands
	const sides = [];
	for (let i = 0; i < 12; i += 2) sides.push([i, i + 1]);
	h.check(overlaps(after, sides) === 0, `THE FEATURE: packed islands do not overlap (${overlaps(after, sides)} overlaps)`);
	const depth1 = await undoDepth(A.page);
	h.check(depth1 === depth0 + 1, `an unwrap records ONE undo entry (${depth0}->${depth1})`);

	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	const undone = await uvTris(A.page, uuid);
	const same =
		undone.length === before.length &&
		undone.every((tri, t) => tri.every((c, k) => Math.abs(c[0] - before[t][k][0]) < 1e-4 && Math.abs(c[1] - before[t][k][1]) < 1e-4));
	h.check(same, 'ONE undo restores the original mapping exactly');

	// ---------- a SCOPED unwrap leaves everything else alone ----------
	const scoped = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.faceEdit.enterFaceEdit(uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		const only = new Set(top.triIndices);
		const ok = w.uvEditor.unwrapObject(uuid, 'planar', { axis: 1, margin: 0.05 }, only);
		w.faceEdit.exitFaceEdit();
		return { ok, tris: [...only] };
	}, uuid);
	await A.page.waitForTimeout(600);
	h.check(scoped.ok, 'a scoped unwrap commits');
	const afterScoped = await uvTris(A.page, uuid);
	const changed = afterScoped
		.map((tri, t) => (tri.some((c, k) => Math.abs(c[0] - before[t][k][0]) > 1e-4 || Math.abs(c[1] - before[t][k][1]) > 1e-4) ? t : -1))
		.filter((t) => t >= 0);
	h.check(
		changed.length > 0 && changed.every((t) => scoped.tris.includes(t)),
		`THE FEATURE: only the picked faces were unwrapped (${changed.length} changed, all in scope)`
	);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);

	// ---------- cylindrical on a sphere: no triangle smears across the seam ----------
	const sphereUuid = await openOnObject(A.page, '/create Sphere 1 24 16', 'unwrapSphere');
	const cyl = await A.page.evaluate(
		(uuid) => window.__stores.uvEditor.unwrapObject(uuid, 'cylindrical', { axis: 1 }),
		sphereUuid
	);
	await A.page.waitForTimeout(700);
	h.check(cyl, 'cylindrical unwrap commits on a sphere');
	const sphereTris = await uvTris(A.page, sphereUuid);
	const widest = Math.max(...sphereTris.map((tri) => {
		const us = tri.map((c) => c[0]);
		return Math.max(...us) - Math.min(...us);
	}));
	h.check(
		widest <= 0.5 + 1e-6,
		`THE SEAM: no triangle stretches across the wrap (widest u span ${widest.toFixed(3)})`
	);

	// ---------- islands + selection transforms ----------
	// Re-unwrap the box first: the checks above deliberately UNDID theirs, and an
	// un-unwrapped box is one island by definition (all six sides share four corners),
	// which would make every assertion below vacuous.
	await A.page.evaluate((uuid) => window.__stores.uvEditor.unwrapObject(uuid, 'box', { margin: 0.02 }), uuid);
	await A.page.waitForTimeout(600);

	const islands = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const tris = w.uvEditor.uvTriangles(box, 0);
		const found = w.uvEditor.uvIslandsOf(tris);
		// select one corner, then grow to its island
		const seed = tris[0].indices[0];
		const grown = w.uvEditor.expandToIslands(box, 0, [seed]);
		return { count: found.length, sizes: found.map((i) => i.length).sort((a, b) => b - a), grown: grown.length };
	}, uuid);
	h.check(islands.count > 1, `uvIslandsOf splits an unwrapped box into islands (${islands.count})`);
	h.check(islands.grown > 1, `select-linked grows one corner to its whole island (${islands.grown} indices)`);

	const transformed = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const tris = w.uvEditor.uvTriangles(box, 0);
		const island = w.uvEditor.expandToIslands(box, 0, [tris[0].indices[0]]);
		const b0 = w.uvEditor.uvBounds(box, island);
		await w.uvEditor.beginUvDrag(uuid);
		w.uvEditor.transformUvCluster(box, island, { rotate: Math.PI / 2 });
		const b1 = w.uvEditor.uvBounds(box, island);
		w.uvEditor.endUvDrag(uuid);
		return {
			w0: +(b0.uMax - b0.uMin).toFixed(4),
			h0: +(b0.vMax - b0.vMin).toFixed(4),
			w1: +(b1.uMax - b1.uMin).toFixed(4),
			h1: +(b1.vMax - b1.vMin).toFixed(4),
			cu: Math.abs(b1.cu - b0.cu) < 1e-4,
			cv: Math.abs(b1.cv - b0.cv) < 1e-4
		};
	}, uuid);
	h.check(
		Math.abs(transformed.w1 - transformed.h0) < 1e-3 && Math.abs(transformed.h1 - transformed.w0) < 1e-3,
		`a 90-degree rotate SWAPS the island's width and height (${transformed.w0}x${transformed.h0} -> ${transformed.w1}x${transformed.h1})`
	);
	h.check(transformed.cu && transformed.cv, 'and rotates about its own centre, so it does not drift');

	const fitted = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const tris = w.uvEditor.uvTriangles(box, 0);
		const island = w.uvEditor.expandToIslands(box, 0, [tris[0].indices[0]]);
		const b0 = w.uvEditor.uvBounds(box, island);
		await w.uvEditor.beginUvDrag(uuid);
		w.uvEditor.fitUvToSquare(box, island, 0.02);
		const b1 = w.uvEditor.uvBounds(box, island);
		w.uvEditor.endUvDrag(uuid);
		const aspect0 = (b0.uMax - b0.uMin) / (b0.vMax - b0.vMin || 1e-9);
		const aspect1 = (b1.uMax - b1.uMin) / (b1.vMax - b1.vMin || 1e-9);
		return {
			grew: b1.uMax - b1.uMin > b0.uMax - b0.uMin,
			inside: b1.uMin >= -1e-6 && b1.vMin >= -1e-6 && b1.uMax <= 1 + 1e-6 && b1.vMax <= 1 + 1e-6,
			aspectKept: Math.abs(aspect0 - aspect1) < 1e-3
		};
	}, uuid);
	h.check(fitted.grew && fitted.inside, 'fit-to-square fills the 0..1 square');
	h.check(fitted.aspectKept, '...WITHOUT shearing the texture (aspect preserved)');

	await h.finish(browser);
});
