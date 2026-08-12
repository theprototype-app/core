// The face GIZMO GRAB must not destroy the grabbed face's texture mapping.
//
// Reported as "select one face, click it again in move mode, the texture for that
// face disappears completely". The second click never reaches pick code - it lands
// on the SEATED gizmo (Scene.svelte returns early while TControls.axis is set) and
// TransformControls fires objectChange on virtually any real click, so the grab
// path runs with a ~zero delta.
//
// Why every existing uv check missed it: applyFaceGrab rebuilt the grabbed
// triangles with Array.prototype.map, dropping the .uv/.mi properties withSlot
// hangs on the triangle arrays. trisToUVs then ZERO-PADS just those corners, so the
// attribute stays full length, count === position.count, and the global spread is
// still 1 - every aggregate assertion in mesh-uv-preserve stays green while six
// corners of the picked face sit on texel (0,0).
const h = require('./helpers.cjs');

/** a textured box in face-edit mode, with per-face uv bookkeeping */
const setup = (page, multiMaterial = false) =>
	page.evaluate(async (multiMaterial) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		const tex = (hex) => {
			const c = document.createElement('canvas');
			c.width = c.height = 8;
			const ctx = c.getContext('2d');
			ctx.fillStyle = hex;
			ctx.fillRect(0, 0, 8, 8);
			return new w.THREE.CanvasTexture(c);
		};
		if (multiMaterial) {
			// six real slots, the shape the UV editor works with - BoxGeometry already
			// ships six groups (materialIndex 0..5)
			box.material = ['#f00', '#0f0', '#00f', '#ff0', '#0ff', '#f0f'].map(
				(hex, i) => new w.THREE.MeshStandardMaterial({ name: 'slot' + i, map: tex(hex) })
			);
		} else {
			box.material.map = tex('#f00');
		}
		box.material.needsUpdate ??= true;
		w.objectActions.selectObject(box.uuid);
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	}, multiMaterial);

/** the uvs + material slot of specific TRIANGLES, index-expanded and keyed by tri.
 * Aggregate stats cannot see a few zeroed corners; this can. */
const triState = (page, uuid, tris) =>
	page.evaluate(
		async ({ uuid, tris }) => {
			const w = window.__stores;
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const geo = g.getObjectByProperty('uuid', uuid).geometry;
			const uv = geo.attributes.uv;
			const index = geo.index;
			const slotAt = (element) => {
				let slot = 0;
				for (const grp of geo.groups ?? [])
					if (element >= grp.start && element < grp.start + grp.count) slot = grp.materialIndex || 0;
				return slot;
			};
			return tris.map((tri) => {
				const corners = [0, 1, 2].map((o) => {
					const j = index ? index.getX(tri * 3 + o) : tri * 3 + o;
					return [+uv.getX(j).toFixed(4), +uv.getY(j).toFixed(4)];
				});
				return {
					tri,
					corners,
					allZero: corners.every((c) => c[0] === 0 && c[1] === 0),
					slot: slotAt(tri * 3)
				};
			});
		},
		{ uuid, tris }
	);

/** drive the gizmo exactly as a click on the seated gizmo does */
const grabWithDelta = (page, dx) =>
	page.evaluate(async (dx) => {
		const w = window.__stores;
		w.faceEdit.attachFaceGizmo();
		w.faceEdit.onFaceGizmoDragChanged(true);
		const controls = await new Promise((r) => w.TControls.subscribe(r)());
		// TransformControls dispatches objectChange on essentially every real click
		if (controls?.object) {
			controls.object.position.x += dx;
			w.faceEdit.onFaceGizmoMoved();
		}
		w.faceEdit.onFaceGizmoDragChanged(false);
		await new Promise((r) => setTimeout(r, 250));
		return !!controls?.object;
	}, dx);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- single material: the reported case ----------
	const uuid = await setup(A.page);
	const picked = await A.page.evaluate(async () => {
		const w = window.__stores;
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		return top.triIndices;
	});
	h.check(picked.length >= 1, `premise: a face is picked (${picked.length} tris)`);
	const before = await triState(A.page, uuid, picked);
	h.check(
		before.every((t) => !t.allZero),
		'premise: the picked face has real uvs before the grab'
	);

	const drove = await grabWithDelta(A.page, 1e-6); // a click, not a drag
	h.check(drove, 'the gizmo drag path ran (proxy present)');
	const after = await triState(A.page, uuid, picked);
	h.check(
		after.every((t) => !t.allZero),
		`THE BUG: the grabbed face's uvs are not collapsed to (0,0) (${after.map((t) => (t.allZero ? 'ZERO' : 'ok')).join(',')})`
	);
	h.check(
		JSON.stringify(after.map((t) => t.corners)) === JSON.stringify(before.map((t) => t.corners)),
		'a ~zero-delta grab leaves the picked face mapping byte-identical'
	);

	// aggregate health must ALSO still hold (this is what used to pass alone)
	const aggregate = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		return { covers: geo.attributes.uv.count === geo.attributes.position.count };
	}, uuid);
	h.check(aggregate.covers, 'uv.count still equals position.count (the old aggregate check)');

	// undo must restore, which needs the commit to carry uvs (it stored bare
	// positions before, so undo could not heal the damage)
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	const undone = await triState(A.page, uuid, picked);
	h.check(
		undone.every((t) => !t.allZero),
		'after undo the face still has real uvs (the commit carries uvs, so undo can heal)'
	);

	// ---------- six materials: the mi half of the same defect ----------
	await A.page.evaluate(() => {
		window.__stores.faceEdit.exitFaceEdit();
		window.__stores.commandsHandler.sceneCommand('/clear all');
	});
	await A.page.waitForTimeout(400);
	const multiUuid = await setup(A.page, true);
	const multiPicked = await A.page.evaluate(async () => {
		const w = window.__stores;
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		return top.triIndices;
	});
	const slotsBefore = await triState(A.page, multiUuid, multiPicked);
	h.check(
		slotsBefore.every((t) => t.slot === slotsBefore[0].slot),
		`premise: the picked face sits in one material slot (${slotsBefore[0]?.slot})`
	);
	await grabWithDelta(A.page, 1e-6);
	const slotsAfter = await triState(A.page, multiUuid, multiPicked);
	h.check(
		slotsAfter.every((t, i) => t.slot === slotsBefore[i].slot),
		`THE BUG (mi half): the grab keeps the face in ITS material slot, not slot 0 (${slotsBefore.map((t) => t.slot).join(',')} -> ${slotsAfter.map((t) => t.slot).join(',')})`
	);
	h.check(
		slotsAfter.every((t) => !t.allZero),
		'...and keeps its uvs on a six-material mesh too'
	);

	await h.finish(browser);
});
