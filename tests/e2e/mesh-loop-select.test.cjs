// M2: loop select + grow/shrink (and M6's select all / invert / linked).
//
// A face LOOP is the quad-strip walk — enter a quad through one edge, leave
// through the OPPOSITE one, repeat. It only exists because 15-G derives quads
// from the triangle soup, which is why quad granularity landed first.
const h = require('./helpers.cjs');

const sel = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.faceEdit.faceEditSelectedTris.subscribe((v) => r([...v].sort((a, b) => a - b)))()
			)
	);

/** a box subdivided into a grid on every side, in face-edit mode */
const editBox = (page, subdivisions = 0) =>
	page.evaluate(async (n) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		if (n > 0) {
			// a real quad GRID: BoxGeometry with segments, so loops are non-trivial
			const geo = new w.THREE.BoxGeometry(1, 1, 1, n, n, n);
			box.geometry.dispose();
			box.geometry = geo;
		}
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	}, subdivisions);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ------------------------------------------- 1. a plain box: loop = 4 quads
	await editBox(A.page, 0);
	const plain = await A.page.evaluate(() => {
		const w = window.__stores;
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const ok = w.faceEdit.selectFaceLoop();
		let picked;
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (picked = [...v]))();
		// which SIDES does the loop touch? a box loop is a band of 4 quads
		const normals = new Set(
			picked.map((ti) => {
				const f = w.faceEdit.currentFaces().find((x) => x.triIndices.includes(ti));
				return f ? f.normal.toArray().map((n) => Math.round(n)).join(',') : '?';
			})
		);
		return { ok, count: picked.length, sides: [...normals].sort() };
	});
	h.check(plain.ok === true, 'loop select commits on a box');
	h.check(plain.count === 8, 'a box loop is 4 quads = 8 triangles (' + plain.count + ')');
	h.check(plain.sides.length === 4, '...spanning 4 different sides — a closed band (' + plain.sides.join(' ') + ')');

	// pressing again walks the PERPENDICULAR loop through the same quad
	const second = await A.page.evaluate(() => {
		const w = window.__stores;
		let before;
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (before = [...v]))();
		w.faceEdit.selectFaceLoop();
		let after;
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (after = [...v]))();
		return { before: before.sort((a, b) => a - b), after: after.sort((a, b) => a - b) };
	});
	h.check(
		second.after.length === 8 && second.after.join() !== second.before.join(),
		'pressing Loop again walks the OTHER loop through that quad'
	);

	// ---------------------------------- 2. a subdivided box: a real quad ring
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await editBox(A.page, 3); // 3x3 quads per side
	const grid = await A.page.evaluate(() => {
		const w = window.__stores;
		const tris = w.faceEdit.currentFaces().reduce((n, f) => n + f.triIndices.length, 0);
		// a middle quad on the +Y face
		const faces = w.faceEdit.currentFaces();
		const top = faces.find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const ok = w.faceEdit.selectFaceLoop();
		let picked;
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (picked = [...v]))();
		return { tris, ok, count: picked.length };
	});
	h.check(grid.tris === 3 * 3 * 6 * 2, 'a 3x3-segment box is 108 triangles (premise, ' + grid.tris + ')');
	// the ring runs 3 quads across the top, 3 down a side, 3 under, 3 up = 12 quads
	h.check(grid.ok === true, 'loop select commits on the grid');
	h.check(grid.count === 24, 'the ring is 12 quads = 24 triangles all the way round (' + grid.count + ')');

	// ------------------------------------------------- 3. grow / shrink
	const growth = await A.page.evaluate(() => {
		const w = window.__stores;
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const read = () => {
			let v;
			w.faceEdit.faceEditSelectedTris.subscribe((x) => (v = [...x]))();
			return v;
		};
		const one = read().length;
		w.faceEdit.growSelection();
		const grown = read().length;
		w.faceEdit.growSelection();
		const grown2 = read().length;
		w.faceEdit.shrinkSelection();
		const shrunk = read().length;
		return { one, grown, grown2, shrunk };
	});
	h.check(growth.one === 2, 'start from one quad (premise)');
	h.check(growth.grown > growth.one, 'Grow adds the neighbouring ring (' + growth.one + ' -> ' + growth.grown + ')');
	h.check(growth.grown2 > growth.grown, '...and again (' + growth.grown + ' -> ' + growth.grown2 + ')');
	h.check(
		growth.shrunk < growth.grown2 && growth.shrunk >= growth.grown - 2,
		'Shrink drops the border ring (' + growth.grown2 + ' -> ' + growth.shrunk + ')'
	);
	// every grown selection stays whole quads (never half a quad)
	const wholeQuads = await A.page.evaluate(() => {
		const w = window.__stores;
		let picked;
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (picked = [...v]))();
		const set = new Set(picked);
		return picked.every((ti) => w.faceEdit.quadOfTriangle(ti).every((t) => set.has(t)));
	});
	h.check(wholeQuads, 'grow/shrink never leave half a quad selected');

	// -------------------------------------- 4. select all / invert / linked
	const setOps = await A.page.evaluate(() => {
		const w = window.__stores;
		const read = () => {
			let v;
			w.faceEdit.faceEditSelectedTris.subscribe((x) => (v = [...x]))();
			return v;
		};
		w.faceEdit.selectAllFaces();
		const all = read().length;
		w.faceEdit.invertFaceSelection();
		const invertedAll = read().length;
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const one = read().length;
		w.faceEdit.invertFaceSelection();
		const inverted = read().length;
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.faceEdit.selectLinkedFaces();
		const linked = read().length;
		return { all, invertedAll, one, inverted, linked };
	});
	h.check(setOps.all === 108, 'Select all picks every triangle (' + setOps.all + ')');
	h.check(setOps.invertedAll === 0, 'inverting everything selects nothing');
	h.check(
		setOps.inverted === setOps.all - setOps.one,
		'invert swaps picked and unpicked (' + setOps.one + ' -> ' + setOps.inverted + ')'
	);
	h.check(setOps.linked === 108, 'Select linked takes the whole connected island (' + setOps.linked + ')');

	// linked stops at a SHELL boundary
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const twoShell = await A.page.evaluate(async () => {
		const w = window.__stores;
		const mk = async (x) => {
			w.commandsHandler.sceneCommand('/create Box 1 1 1');
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const b = g.children[g.children.length - 1];
			b.position.set(x, 0, 0);
			return b.uuid;
		};
		const uuid = await w.objectActions.convertToMesh([await mk(0), await mk(3)]);
		w.faceEdit.enterFaceEdit(uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.faceEdit.selectLinkedFaces();
		let picked;
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (picked = [...v]))();
		return picked.length;
	});
	h.check(twoShell === 12, 'Select linked stops at the shell boundary — one cube, not both (' + twoShell + ')');

	// ------------------------------------ 5. a lone triangle has no loop
	const lone = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.applyMeshGeo(box.uuid, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
		w.faceEdit.enterFaceEdit(box.uuid);
		w.faceEdit.pickFaceUnit(0);
		return w.faceEdit.selectFaceLoop();
	});
	h.check(lone === false, 'a triangle with no quad mate refuses loop select (with a toast)');

	await h.finish(browser);
});
