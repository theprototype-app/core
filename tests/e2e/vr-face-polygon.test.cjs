// Phase 212: face polygon-select + multiselect. A granularity toggle picks the
// whole coplanar FACE (today) vs the single POLYGON under the ray, and a Multi
// toggle accumulates picks. This isolates an inset cap (coplanar with its frame,
// so FACE mode grabs the whole thing). Core is shared VR + desktop; on-device
// feel is manual.
const h = require('./helpers.cjs');

const rd = (A, path) =>
	A.page.evaluate((p) => {
		let v;
		p.split('.').reduce((o, k) => o[k], window.__stores).subscribe((x) => (v = x))();
		return v;
	}, path);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- granularity changes what a single pick selects ---
	const gran = await A.page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.commandsHandler.sceneCommand('/create box');
		const box = g.children[g.children.length - 1];
		window.__pbox = box;
		s.faceEdit.enterFaceEdit(box.uuid);
		s.faceEdit.faceEditGranularity.set('face');
		s.faceEdit.highlightFaceByTriangle(0);
		const faceSize = s.faceEdit.currentTargetFace().triIndices.length;
		s.faceEdit.faceEditGranularity.set('polygon');
		s.faceEdit.highlightFaceByTriangle(0);
		const polySize = s.faceEdit.currentTargetFace().triIndices.length;
		return { faceSize, polySize };
	});
	h.check(gran.faceSize === 2 && gran.polySize === 1, `FACE selects the coplanar quad (${gran.faceSize}), POLYGON one tri (${gran.polySize})`);

	// --- Multi accumulates picks; a repeat trigger removes one ---
	const multi = await A.page.evaluate(() => {
		const s = window.__stores;
		const read = () => {
			let v;
			s.faceEdit.faceEditSelectedTris.subscribe((x) => (v = x))();
			return v;
		};
		s.faceEdit.faceEditGranularity.set('polygon');
		s.faceEdit.faceEditMulti.set(true);
		s.faceEdit.faceEditSelectedTris.set([]);
		s.faceEdit.toggleFaceSelection(0);
		s.faceEdit.toggleFaceSelection(1);
		const added = read().slice().sort((a, b) => a - b);
		const target = s.faceEdit.currentTargetFace().triIndices.length;
		s.faceEdit.toggleFaceSelection(0); // remove 0
		const afterRemove = read().slice();
		return { added, target, afterRemove };
	});
	h.check(multi.added.join(',') === '0,1', `Multi accumulates polygon picks (${multi.added.join(',')})`);
	h.check(multi.target === 2, 'ops target the whole accumulated set');
	h.check(multi.afterRemove.length === 1 && multi.afterRemove[0] === 1, 'a repeat trigger removes that pick');

	// --- the inset-cap problem: after a FACE inset the top is ONE coplanar group;
	//     POLYGON isolates a single tri where FACE can only grab all of it ---
	const iso = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__pbox;
		const topGroup = () => {
			const tris = s.faceEdit.readTriangles(box.geometry);
			const groups = s.faceEdit.groupFaces(tris);
			return groups.find((gr) => gr.normal.y > 0.9);
		};
		// reset + FACE-inset the top face
		s.faceEdit.faceEditMulti.set(false);
		s.faceEdit.faceEditSelectedTris.set([]);
		s.faceEdit.faceEditGranularity.set('face');
		const before = topGroup();
		s.faceEdit.highlightFaceByTriangle(before.triIndices[0]);
		s.faceEdit.commitFaceOp('inset', 0.3);
		const after = topGroup(); // now cap + frame ring, all coplanar
		// FACE grabs the whole merged top; POLYGON grabs one tri of it
		s.faceEdit.faceEditGranularity.set('face');
		s.faceEdit.highlightFaceByTriangle(after.triIndices[0]);
		const faceTarget = s.faceEdit.currentTargetFace().triIndices.length;
		s.faceEdit.faceEditGranularity.set('polygon');
		s.faceEdit.highlightFaceByTriangle(after.triIndices[0]);
		const polyTarget = s.faceEdit.currentTargetFace().triIndices.length;
		return { beforeSize: before.triIndices.length, afterSize: after.triIndices.length, faceTarget, polyTarget };
	});
	h.check(iso.afterSize > iso.beforeSize, `inset merges cap+frame into one coplanar top group (${iso.beforeSize}->${iso.afterSize} tris)`);
	h.check(
		iso.faceTarget === iso.afterSize && iso.polyTarget === 1,
		`POLYGON isolates one tri where FACE grabs all ${iso.faceTarget}`
	);

	// --- a polygon op commits + is undoable ---
	const op = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__pbox;
		const tris = () => s.faceEdit.readTriangles(box.geometry).length;
		s.faceEdit.faceEditMulti.set(false);
		s.faceEdit.faceEditSelectedTris.set([]);
		s.faceEdit.faceEditGranularity.set('polygon');
		s.faceEdit.highlightFaceByTriangle(0);
		const t0 = tris();
		const ok = s.faceEdit.commitFaceOp('extrude', 0.4);
		const t1 = tris();
		s.history.undo();
		const t2 = tris();
		return { ok, t0, t1, t2 };
	});
	h.check(op.ok && op.t1 > op.t0, `a POLYGON extrude commits and grows the mesh (${op.t0}->${op.t1})`);
	h.check(op.t2 === op.t0, `undo reverts the polygon extrude (${op.t2})`);

	await h.finish(browser);
});
