// M3: loop cut — insert edge loops across the quad ring a face lies on.
// The most-used modelling operation, and it stacks directly on M2's ring walk.
const h = require('./helpers.cjs');

/** triangle count, index-aware */
const triCount = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
	}, uuid);

/** distinct Y planes of the +X side's vertices — a loop cut around the vertical
 * ring adds one horizontal plane per cut */
const planes = (page, uuid, axisName) =>
	page.evaluate(
		({ uuid, axisName }) => {
			const w = window.__stores;
			let group;
			w.objectsGroup.subscribe((v) => (group = v))();
			const geo = group.getObjectByProperty('uuid', uuid).geometry;
			const pos = geo.attributes.position;
			const vals = new Set();
			for (let i = 0; i < pos.count; i++) {
				const v = axisName === 'y' ? pos.getY(i) : axisName === 'x' ? pos.getX(i) : pos.getZ(i);
				vals.add(+v.toFixed(3));
			}
			return [...vals].sort((a, b) => a - b);
		},
		{ uuid, axisName }
	);

/** a box in face-edit mode with the top face picked */
const setup = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		return box.uuid;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ------------------------------------------------------ 1. one cut
	const uuid = await setup(A.page);
	const before = await triCount(A.page, uuid);
	h.check(before === 12, 'a box is 12 triangles (premise)');

	const ok = await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('loopcut', 1));
	const after = await triCount(A.page, uuid);
	h.check(ok === true, 'loop cut commits');
	// the ring is 4 quads; each becomes 2 quads = 4 tris, so 8 tris replace 8
	// and the 4 untouched tris stay: 4 + 4*4 = 20
	h.check(after === 20, 'one cut across a 4-quad ring: 12 -> 20 triangles (' + after + ')');

	// geometrically it really is a LOOP: a new plane appears midway
	const p = await planes(A.page, uuid, 'y');
	h.check(
		p.length === 3 && Math.abs(p[1]) < 0.001,
		'a new vertex plane appears exactly midway (' + JSON.stringify(p) + ')'
	);

	// ------------------------------------------------------ 2. N cuts
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const uuid3 = await setup(A.page);
	const ok3 = await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('loopcut', 3));
	const after3 = await triCount(A.page, uuid3);
	const p3 = await planes(A.page, uuid3, 'y');
	h.check(ok3 === true, '3 cuts commit');
	h.check(after3 === 4 + 4 * 8, '3 cuts across a 4-quad ring: 12 -> 36 triangles (' + after3 + ')');
	h.check(p3.length === 5, '...adding 3 evenly spaced planes (' + JSON.stringify(p3) + ')');
	const gaps = p3.slice(1).map((v, i) => +(v - p3[i]).toFixed(3));
	h.check(new Set(gaps).size === 1, '...evenly spaced (' + JSON.stringify(gaps) + ')');

	// ------------------------------------------------- 3. undo is ONE step
	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await triCount(A.page, uuid3);
	h.check(undone === 12, 'ONE undo removes all 3 loops (' + undone + ')');
	await A.page.evaluate(() => window.__stores.history.redo());
	h.check((await triCount(A.page, uuid3)) === 36, 'redo re-cuts in one step');

	// ------------------------------- 4. the cut is watertight (no stray verts)
	const solid = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const tris = w.faceEdit.readTriangles(geo);
		// one connected shell, and the bounding box is unchanged (a cut adds
		// vertices ON the surface, it never moves the silhouette)
		const shells = w.faceEdit.shellsOfTris(tris).length;
		const box = new w.THREE.Box3().setFromBufferAttribute(geo.attributes.position);
		return { shells, min: box.min.toArray().map((v) => +v.toFixed(3)), max: box.max.toArray().map((v) => +v.toFixed(3)) };
	}, uuid3);
	h.check(solid.shells === 1, 'the cut mesh is still ONE connected shell');
	h.check(
		solid.min.every((v) => Math.abs(v + 0.5) < 0.001) && solid.max.every((v) => Math.abs(v - 0.5) < 0.001),
		'...and the silhouette is unchanged (' + JSON.stringify(solid.min) + ' ' + JSON.stringify(solid.max) + ')'
	);

	// -------------------------------------- 4b. 19-A P3: cut POSITION
	// One cut at 0.25 lands at the 1/4 parameter along each ring quad, measured
	// from that quad's ENTRY edge — the walk circulates one way around a closed
	// ring, so the two SIDE quads of a box enter from opposite edges and their
	// cuts land at y = +0.25 and y = -0.25 (position 0.5 degenerates to the one
	// symmetric y=0 plane the sections above pin). Vertex POSITIONS, not counts.
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const uuidQ = await setup(A.page);
	const okQ = await A.page.evaluate(() => window.__stores.faceEdit.commitLoopCut(1, 0.25));
	h.check(okQ === true, 'a single cut at position 0.25 commits');
	h.check((await triCount(A.page, uuidQ)) === 20, 'it is still one loop: 12 -> 20 triangles');
	const pQ = await planes(A.page, uuidQ, 'y');
	h.check(
		pQ.length === 4 &&
			Math.abs(pQ[1] + 0.25) < 0.001 &&
			Math.abs(pQ[2] - 0.25) < 0.001,
		'the cut sits at the 1/4 parameter of each side quad, walk-oriented (' + JSON.stringify(pQ) + ')'
	);

	// with cuts > 1 the position is IGNORED — the schedule stays even (the
	// Blender rule; the pane's position row disables to say so)
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const uuidE = await setup(A.page);
	await A.page.evaluate(() => window.__stores.faceEdit.commitLoopCut(2, 0.2));
	const pE = await planes(A.page, uuidE, 'y');
	// even 2-cut schedule: t = 1/3 and 2/3 across each side quad = y ±1/6
	h.check(
		pE.length === 4 &&
			Math.abs(pE[1] + 1 / 6) < 0.001 &&
			Math.abs(pE[2] - 1 / 6) < 0.001,
		'cuts=2 ignores the position and stays evenly spaced at y ±1/6 (' + JSON.stringify(pE) + ')'
	);
	// ...and the pane's position row is DISABLED at cuts > 1, saying why
	const rowDisabled = await A.page.evaluate(async () => {
		const mt = window.__stores.meshToolParams;
		mt.focusTool('loopcut');
		mt.loopCuts.set(2);
		await new Promise((r) => setTimeout(r, 250));
		const at2 = document.querySelector('#loopcut-position');
		const state2 = at2 ? at2.disabled : null;
		mt.loopCuts.set(1);
		await new Promise((r) => setTimeout(r, 250));
		const at1 = document.querySelector('#loopcut-position');
		return { at2: state2, at1: at1 ? at1.disabled : null };
	});
	h.check(rowDisabled.at2 === true, 'the position row disables at cuts > 1');
	h.check(rowDisabled.at1 === false, '...and re-enables at cuts = 1');

	// ---------------------------------------- 5. UVs + material slots survive
	const merged = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		const mk = async (x) => {
			w.commandsHandler.sceneCommand('/create Box 1 1 1');
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const b = g.children[g.children.length - 1];
			b.position.set(x, 0, 0);
			return b.uuid;
		};
		const uuid = await w.objectActions.convertToMesh([await mk(0), await mk(3)]);
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const mesh = g.getObjectByProperty('uuid', uuid);
		// give it real UVs so the cut has something to interpolate
		const n = mesh.geometry.attributes.position.count;
		const uv = new Float32Array(n * 2);
		for (let i = 0; i < n; i++) {
			uv[i * 2] = (mesh.geometry.attributes.position.getX(i) + 2) / 6;
			uv[i * 2 + 1] = mesh.geometry.attributes.position.getY(i) + 0.5;
		}
		mesh.geometry.setAttribute('uv', new w.THREE.BufferAttribute(uv, 2));
		w.faceEdit.enterFaceEdit(uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const ok = w.faceEdit.commitFaceOp('loopcut', 2);
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const slots = [...new Set(geo.groups.map((x) => x.materialIndex))].sort();
		return {
			ok,
			uvCovers: !!geo.attributes.uv && geo.attributes.uv.count === geo.attributes.position.count,
			slots,
			mats: Array.isArray(mesh.material) ? mesh.material.length : 1
		};
	});
	h.check(merged.ok === true, 'loop cut commits on a merged, textured mesh');
	h.check(merged.uvCovers, '...keeping a complete uv attribute (M1 contract)');
	h.check(
		merged.mats === 2 && merged.slots.length === 2,
		'...and both material slots (' + JSON.stringify(merged.slots) + ')'
	);

	// ------------------------------------------------------ 6. guards
	const guards = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.applyMeshGeo(box.uuid, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
		w.faceEdit.enterFaceEdit(box.uuid);
		w.faceEdit.pickFaceUnit(0);
		const lone = w.faceEdit.commitFaceOp('loopcut', 1);
		w.faceEdit.clearFaceSelection();
		w.faceEdit.faceEditHoverTri.set(-1);
		const nothing = w.faceEdit.commitFaceOp('loopcut', 1);
		return { lone, nothing };
	});
	h.check(guards.lone === false, 'a triangle with no quad mate refuses loop cut');
	h.check(guards.nothing === false, 'no pick at all refuses loop cut');

	// ------------------------------------- 7. 19-A P7b: the AXIS toggle
	// A quad lies on TWO rings and the begin-time selection pick can be the
	// wrong one. The adjust captured BOTH rings, so `axis: 1` re-runs the cut
	// across the perpendicular ring — measured by WHICH vertex plane appears:
	// the top-face pick cuts around Y (a new y = 0 plane); the perpendicular
	// ring adds a mid plane on x or z instead, and the y one goes away.
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const uuidA = await setup(A.page);
	const midOf = async (axisName) => {
		const list = await planes(A.page, uuidA, axisName);
		return list.some((v) => Math.abs(v) < 0.001);
	};
	const axisBegin = await A.page.evaluate(() => {
		const w = window.__stores;
		w.meshToolParams.focusTool('loopcut'); // the pane shows the live adjust
		const ok = w.faceEdit.beginOpAdjust('loopcut', { cuts: 1, position: 0.5 });
		let st;
		w.faceEdit.opAdjustState.subscribe((v) => (st = v))();
		return { ok, axis: st?.params?.axis, axisAlt: st?.axisAlt };
	});
	h.check(axisBegin.ok === true, 'loop cut begins as a live adjust (premise)');
	h.check(axisBegin.axis === 0, 'the adjust starts on the picked ring (axis 0)');
	h.check(axisBegin.axisAlt === true, 'the state mirror reports a PERPENDICULAR ring exists on a box');
	// The distinguisher: BOTH rings through the top quad are vertical belts (one
	// walks in x, one in z), and each cut adds a y-mid line on its side quads —
	// so y = 0 tells them apart not at all. What differs is which HORIZONTAL
	// axis gains a mid plane from the top/bottom quads: x for one ring, z for
	// the other, never both.
	h.check(await midOf('y'), 'axis 0: the cut adds a y = 0 line on the belt sides (premise)');
	const x0 = await midOf('x');
	const z0 = await midOf('z');
	h.check(x0 !== z0, `axis 0: EXACTLY one horizontal mid plane exists (x: ${x0}, z: ${z0})`);
	const flipped = await A.page.evaluate(() => window.__stores.faceEdit.reapplyOpAdjust({ axis: 1 }));
	h.check(flipped === true, 'reapply with axis 1 re-runs the cut');
	const x1 = await midOf('x');
	const z1 = await midOf('z');
	h.check(
		x1 === !x0 && z1 === !z0,
		`axis 1: the cut SWAPPED onto the perpendicular belt (x: ${x0}->${x1}, z: ${z0}->${z1})`
	);
	// flip back — the toggle is reversible because both rings were captured at begin
	await A.page.evaluate(() => window.__stores.faceEdit.reapplyOpAdjust({ axis: 0 }));
	h.check(
		(await midOf('x')) === x0 && (await midOf('z')) === z0,
		'axis 0 again restores the original ring (both rings live on the adjust)'
	);
	h.check(
		(await triCount(A.page, uuidA)) === 20,
		'still exactly ONE loop after all the flipping (12 -> 20 tris)'
	);

	// the toggle in the PANE drives the same path (the real button)
	const xBefore = await midOf('x');
	const dom = await A.page.evaluate(async () => {
		const seg = document.querySelector('#loopcut-axis');
		const across = document.querySelector('#loopcut-axis-across');
		if (!seg || !across) return { seg: !!seg, across: !!across };
		const disabled = across.disabled;
		across.click();
		await new Promise((r) => setTimeout(r, 400)); // the typed-change debounce settles
		let st;
		window.__stores.faceEdit.opAdjustState.subscribe((v) => (st = v))();
		return { seg: true, across: true, disabled, axisAfter: st?.params?.axis };
	});
	h.check(dom.seg && dom.across, 'the axis seg control renders while the adjust is live (#loopcut-axis)');
	h.check(dom.disabled === false, '...with Across ENABLED (a perpendicular ring exists)');
	h.check(dom.axisAfter === 1, 'clicking Across flips the engine to axis 1');
	h.check(
		(await midOf('x')) === !xBefore,
		'...and the geometry followed the button (the horizontal mid plane swapped axes)'
	);
	// settle happened via the debounce; ONE undo returns the uncut box
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await triCount(A.page, uuidA)) === 12, 'ONE undo removes the axis-flipped cut entirely');
	// ...and once the adjust ENDS the toggle leaves the pane (undo drops the
	// adjust lazily via the identity guard, so end it the way a pick would)
	const segGone = await A.page.evaluate(async () => {
		window.__stores.faceEdit.endOpAdjust();
		await new Promise((r) => setTimeout(r, 120));
		return !document.querySelector('#loopcut-axis');
	});
	h.check(segGone, 'the axis toggle only exists while the adjust is live');

	await h.finish(browser);
});
