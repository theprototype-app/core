// Round-3 fixes from real use.
const h = require('./helpers.cjs');

const editBox = (page, segs = 0) =>
	page.evaluate(async (segs) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		if (segs > 0) {
			box.geometry.dispose();
			box.geometry = new w.THREE.BoxGeometry(1, 1, 1, segs, segs, segs);
		}
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	}, segs);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- REPORT: clicking a face should not extrude it ---------------------
	const uuid = await editBox(A.page);
	const armed = await A.page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.faceEditOp.subscribe(r)())
	);
	h.check(armed === 'move', 'a session opens with MOVE armed, not extrude (' + armed + ')');
	const clicked = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = () => g.getObjectByProperty('uuid', uuid).geometry;
		const count = () => {
			const x = geo();
			return (x.index ? x.index.count : x.attributes.position.count) / 3;
		};
		const before = count();
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		// exactly what Scene.svelte does on a plain click, three times over
		for (let i = 0; i < 3; i++) {
			w.faceEdit.highlightFaceByTriangle(top.triIndices[0], true);
			w.faceEdit.pickFaceUnit(top.triIndices[0]);
			w.faceEdit.autoApplyFaceOp();
		}
		return { before, after: count() };
	}, uuid);
	h.check(
		clicked.after === clicked.before,
		'THE BUG: clicking a face repeatedly no longer extrudes it (' + clicked.before + ' -> ' + clicked.after + ')'
	);

	// ---- REPORT: deselected face keeps its highlight -----------------------
	const overlays = await A.page.evaluate(async () => {
		const w = window.__stores;
		const scene = await new Promise((r) => w.globalScene.subscribe(r)());
		const find = (name) => {
			let hit = null;
			scene.traverse((n) => {
				if (n.name === name) hit = n;
			});
			return hit;
		};
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		// pick it, and leave the cursor hovering the SAME face
		w.faceEdit.highlightFaceByTriangle(top.triIndices[0], true);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const selWhilePicked = find('face-edit-overlay')?.material.opacity ?? -1;
		// now DESELECT it while the cursor stays put — the report is that it
		// stayed lit exactly as if it were still selected
		w.faceEdit.clearFaceSelection();
		const selAfter = find('face-edit-overlay');
		const hoverAfter = find('face-edit-hover');
		return {
			selWhilePicked,
			stillSelected: !!selAfter,
			hoverShown: !!hoverAfter,
			hoverOpacity: hoverAfter?.material.opacity ?? -1
		};
	});
	h.check(overlays.selWhilePicked > 0.3, 'a picked face gets the solid selection tint (premise)');
	h.check(
		!overlays.stillSelected,
		'THE BUG: deselecting drops the SELECTION tint even with the cursor still on it'
	);
	h.check(
		overlays.hoverShown && overlays.hoverOpacity < 0.2,
		'...and only a faint HOVER wash remains, visibly different (' + overlays.hoverOpacity + ')'
	);

	// ---- REPORT: Ctrl+A / Ctrl+I dead in edges and vertices ---------------
	const perMode = await A.page.evaluate(async () => {
		const w = window.__stores;
		const readE = () => {
			let v;
			w.faceEdit.edgeEditSelected.subscribe((x) => (v = [...x]))();
			return v.length;
		};
		const readV = () => {
			let v;
			w.meshEdit.vertexSelectionSize.subscribe((x) => (v = x))();
			return v;
		};
		// EDGES
		w.faceEdit.faceEditSubmode.set('edges');
		const eAll = w.faceEdit.selectAllEdges();
		const eCount = readE();
		w.faceEdit.invertEdgeSelection();
		const eInv = readE();
		// VERTICES — its own session
		w.faceEdit.exitFaceEdit();
		let uuid;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		uuid = g.children[g.children.length - 1].uuid;
		w.meshEdit.enterEditMode(uuid);
		const vAll = w.meshEdit.selectAllVerts();
		const vCount = readV();
		w.meshEdit.invertVertexSelection();
		const vInv = readV();
		w.meshEdit.exitEditMode();
		return { eAll, eCount, eInv, vAll, vCount, vInv };
	});
	h.check(perMode.eAll === true && perMode.eCount === 12, 'Select all works in EDGES — a box has 12 real edges (' + perMode.eCount + ')');
	h.check(perMode.eInv === 0, '...and invert clears it');
	h.check(perMode.vAll === true && perMode.vCount === 8, 'Select all works in VERTICES — a box has 8 (' + perMode.vCount + ')');
	h.check(perMode.vInv === 0, '...and invert clears it');

	// ---- REPORT: edge loop on a SUBDIVIDED face picked the inner edges -----
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const gridUuid = await editBox(A.page, 3);
	const loop = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		w.faceEdit.faceEditSubmode.set('edges');
		const tris = w.faceEdit.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		// an edge on the TOP face's outer border: both endpoints at y=+0.5 AND on
		// the outer rim (|x| or |z| == 0.5)
		const onRim = (v) => Math.abs(Math.abs(v.x) - 0.5) < 1e-4 || Math.abs(Math.abs(v.z) - 0.5) < 1e-4;
		let border = '';
		let inner = '';
		for (let ti = 0; ti < tris.length && (!border || !inner); ti++) {
			const t = tris[ti];
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			if (Math.abs(c.y - 0.5) > 1e-4) continue; // top face only
			for (let e = 0; e < 3; e++) {
				const a = t[e];
				const b = t[(e + 1) % 3];
				const key = w.faceEdit.pickEdgeAt(ti, a.clone().add(b).multiplyScalar(0.5).lerp(c, 0.05));
				if (!key) continue;
				if (onRim(a) && onRim(b) && !border) border = key;
				if (!onRim(a) && !onRim(b) && !inner) inner = key;
			}
		}
		w.faceEdit.pickEdge(border, false);
		const ok = w.faceEdit.selectEdgeLoop();
		let sel;
		w.faceEdit.edgeEditSelected.subscribe((v) => (sel = [...v]))();
		// how many of the chosen edges lie on the top face's OUTER rim?
		const decode = (k) => k.split('|').map((p) => p.split(',').map((n) => +n / 1e4));
		const onTopRim = sel.filter((k) =>
			decode(k).every(([x, y, z]) => Math.abs(y - 0.5) < 1e-3 && (Math.abs(Math.abs(x) - 0.5) < 1e-3 || Math.abs(Math.abs(z) - 0.5) < 1e-3))
		);
		return { ok, border: !!border, count: sel.length, onTopRim: onTopRim.length };
	}, gridUuid);
	h.check(loop.border, 'found an outer border edge on the subdivided top (premise)');
	h.check(loop.ok === true, 'edge loop commits on the subdivided box');
	// EVERY chosen edge is on the outer rim — the report was that it took the
	// inner grid edges instead. It walks the 3 segments along one side and stops
	// at the box CORNER, which is a valence-3 pole: the standard loop rule, and
	// what Blender does too.
	h.check(
		loop.onTopRim === loop.count && loop.count === 3,
		'THE BUG: the loop follows the OUTER border, not the inner grid edges, and stops at the corner pole (' +
			loop.onTopRim + '/' + loop.count + ' on the rim)'
	);

	// ---- Cancel reverts the whole session ---------------------------------
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const cancelUuid = await editBox(A.page);
	const cancel = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const count = () => {
			const x = g.getObjectByProperty('uuid', uuid).geometry;
			return (x.index ? x.index.count : x.attributes.position.count) / 3;
		};
		const clean = w.faceEdit.sessionHasChanges();
		const before = count();
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.faceEdit.commitFaceOp('extrude', 0.4);
		w.faceEdit.commitFaceOp('subdivide', 0);
		const dirty = w.faceEdit.sessionHasChanges();
		const edited = count();
		const ok = w.faceEdit.cancelEditSession();
		return { clean, dirty, before, edited, ok, after: count() };
	}, cancelUuid);
	h.check(cancel.clean === false, 'a fresh session reports no changes to revert');
	h.check(cancel.dirty === true && cancel.edited > cancel.before, 'edits mark the session dirty (' + cancel.before + ' -> ' + cancel.edited + ')');
	h.check(cancel.ok === true && cancel.after === cancel.before, 'Cancel reverts EVERY edit in one step (' + cancel.after + ')');

	// the button + its inline confirmation exist
	const ui = await A.page.evaluate(() => {
		const btn = document.querySelector('#mesh-edit-cancel');
		btn?.click();
		return {
			hasButton: !!btn,
			iconOnly: !!btn && !btn.textContent.trim() && !!btn.querySelector('svg'),
			label: btn?.getAttribute('aria-label') ?? ''
		};
	});
	h.check(ui.hasButton && ui.iconOnly, 'Cancel is an ICON button in the header, beside Done');
	h.check(/revert/i.test(ui.label), '...with an aria-label saying what it does');

	// ---- the cheat sheet is sectioned, and marks the ACTIVE mode ----------
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await editBox(A.page);
	await A.page.evaluate(() => document.querySelector('#mesh-keys-help').click());
	await A.page.waitForSelector('#mesh-keys-popover');
	const sheet = await A.page.evaluate(() => {
		const el = document.querySelector('#mesh-keys-popover');
		// innerText reflects CSS `text-transform: uppercase`, so compare lowercased
		const text = el.innerText.toLowerCase();
		return {
			sections: ['any mode', 'faces', 'edges', 'vertices'].filter((t) => text.includes(t)).length,
			marksActive: text.includes('active'),
			hasModeKeys: text.includes('1 / 2 / 3')
		};
	});
	h.check(sheet.sections === 4, 'the cheat sheet is split into 4 mode sections (' + sheet.sections + ')');
	h.check(sheet.marksActive, '...marking the section for the mode you are in');
	h.check(sheet.hasModeKeys, '...and documents 1/2/3 for switching mode');

	// 1/2/3 really switch mode
	const modeKeys = await A.page.evaluate(() => {
		const read = () => {
			let f, v;
			window.__stores.faceEdit.faceEditObject.subscribe((x) => (f = x))();
			window.__stores.meshEdit.editingObject.subscribe((x) => (v = x))();
			let sub;
			window.__stores.faceEdit.faceEditSubmode.subscribe((x) => (sub = x))();
			return v ? 'vertices' : f ? sub : 'none';
		};
		const press = (k) =>
			window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
		const start = read();
		press('2');
		const after2 = read();
		press('1');
		const after1 = read();
		press('3');
		return { start, after2, after1, after3: read() };
	});
	h.check(modeKeys.after2 === 'edges', '2 switches to Edges (' + modeKeys.after2 + ')');
	h.check(modeKeys.after1 === 'vertices', '1 switches to Vertices (' + modeKeys.after1 + ')');
	h.check(modeKeys.after3 === 'faces', '3 switches to Faces (' + modeKeys.after3 + ')');

	await h.finish(browser);
});
