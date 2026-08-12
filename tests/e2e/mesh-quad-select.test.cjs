// 15-G: QUAD pick granularity — select the two triangles that form a quad,
// which is the unit a modeler thinks in. Sits between `triangle` and `face`:
// a box side is one quad either way, but an extrusion wall stays its own quad
// instead of merging into the coplanar side beneath it (which is what `face`
// does, by design).
const h = require('./helpers.cjs');

/** the selection, sorted */
const sel = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.faceEdit.faceEditSelectedTris.subscribe((v) => r([...v].sort((a, b) => a - b)))()
			)
	);

/** triangle centroid + normal, mesh-local. Honours the INDEX: a raw BoxGeometry
 * is indexed (24 positions / 36 indices), so reading positions by ti*3+k reads
 * unrelated corners and invents diagonal normals. */
const triInfo = (page, uuid, indices) =>
	page.evaluate(
		async ({ uuid, indices }) => {
			const w = window.__stores;
			const T = w.THREE;
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const geo = g.getObjectByProperty('uuid', uuid).geometry;
			const pos = geo.attributes.position;
			const idx = geo.index;
			return indices.map((ti) => {
				const p = [0, 1, 2].map((k) => {
					const j = idx ? idx.getX(ti * 3 + k) : ti * 3 + k;
					return new T.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j));
				});
				const n = new T.Vector3()
					.subVectors(p[1], p[0])
					.cross(new T.Vector3().subVectors(p[2], p[0]))
					.normalize();
				return {
					c: p[0].clone().add(p[1]).add(p[2]).multiplyScalar(1 / 3).toArray().map((x) => +x.toFixed(3)),
					n: n.toArray().map((x) => +x.toFixed(2))
				};
			});
		},
		{ uuid, indices }
	);

/** a plain box in face-edit mode */
const editBox = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ------------------------------------------------------- 1. the default
	const startMode = await A.page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.faceEditGranularity.subscribe(r)())
	);
	h.check(startMode === 'quad', 'Edit Mesh opens in Quad granularity (' + startMode + ')');

	// ------------------------------------------- 2. a box: 12 tris -> 6 quads
	const uuid = await editBox(A.page);
	const pairing = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const tris = w.faceEdit.readTriangles(geo);
		const partner = w.faceEdit.pairQuads(tris);
		const paired = [...partner].filter((p) => p >= 0).length;
		// mutual and never self-paired?
		let mutual = true;
		for (let i = 0; i < partner.length; i++) {
			if (partner[i] === i) mutual = false;
			if (partner[i] >= 0 && partner[partner[i]] !== i) mutual = false;
		}
		return { count: tris.length, paired, mutual, partner: [...partner] };
	}, uuid);
	h.check(pairing.count === 12, 'a box is 12 triangles (premise)');
	h.check(pairing.paired === 12, 'every triangle of a box finds a quad mate (6 quads)');
	h.check(pairing.mutual, 'the pairing is mutual and never self-paired');

	// a quad pick returns exactly 2 coplanar, co-facing triangles
	const unit = await A.page.evaluate(() => window.__stores.faceEdit.quadOfTriangle(0));
	h.check(unit.length === 2, 'picking a triangle selects its quad (2 tris)');
	const info = await triInfo(A.page, uuid, unit);
	h.check(
		info[0].n.join(',') === info[1].n.join(','),
		'the two triangles of a quad face the same way (' + info.map((i) => i.n.join(',')).join(' vs ') + ')'
	);

	// clicking through the real pick path selects the quad, not the triangle
	await A.page.evaluate(() => window.__stores.faceEdit.pickFaceUnit(0));
	h.check((await sel(A.page)).length === 2, 'a click in Quad mode selects 2 triangles');
	await A.page.evaluate(() => {
		window.__stores.faceEdit.setFaceGranularity('triangle');
		window.__stores.faceEdit.pickFaceUnit(0);
	});
	h.check((await sel(A.page)).length === 1, '...where Triangle mode selects 1');
	await A.page.evaluate(() => {
		window.__stores.faceEdit.setFaceGranularity('face');
		window.__stores.faceEdit.pickFaceUnit(0);
	});
	h.check((await sel(A.page)).length === 2, '...and on a plain box Face mode matches Quad (2)');

	// ------------------- 3. THE POINT: an extrusion wall is its own quad
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const ex = await editBox(A.page);
	await A.page.evaluate(() => {
		const w = window.__stores;
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.setFaceGranularity('face');
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.faceEdit.commitFaceOp('extrude', 0.4);
	});

	// find a triangle in the +X WALL band (y above the original top)
	const wallTri = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const T = w.THREE;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const pos = g.getObjectByProperty('uuid', uuid).geometry.attributes.position;
		for (let ti = 0; ti < pos.count / 3; ti++) {
			const p = [0, 1, 2].map((k) => new T.Vector3(pos.getX(ti * 3 + k), pos.getY(ti * 3 + k), pos.getZ(ti * 3 + k)));
			const c = p[0].clone().add(p[1]).add(p[2]).multiplyScalar(1 / 3);
			const n = new T.Vector3().subVectors(p[1], p[0]).cross(new T.Vector3().subVectors(p[2], p[0])).normalize();
			if (n.x > 0.99 && c.y > 0.5) return ti;
		}
		return -1;
	}, ex);
	h.check(wallTri >= 0, 'found a triangle in the extruded wall band (premise)');

	await A.page.evaluate((ti) => {
		window.__stores.faceEdit.setFaceGranularity('quad');
		window.__stores.faceEdit.pickFaceUnit(ti);
	}, wallTri);
	const quadSel = await sel(A.page);
	const quadInfo = await triInfo(A.page, ex, quadSel);
	h.check(quadSel.length === 2, 'Quad mode picks the wall band alone (2 tris)');
	h.check(
		quadInfo.every((t) => t.c[1] > 0.5),
		'...both of them ABOVE the original top — the flat side below is not swept in'
	);

	await A.page.evaluate((ti) => {
		window.__stores.faceEdit.setFaceGranularity('face');
		window.__stores.faceEdit.pickFaceUnit(ti);
	}, wallTri);
	const faceSel = await sel(A.page);
	h.check(
		faceSel.length === 4,
		'Face mode on the same click still takes the WHOLE coplanar side (4 tris) — the modes differ'
	);

	// ------------------------------- 4. an unpaired triangle picks alone
	const lone = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		// a single free-standing TRIANGLE has no possible mate
		w.faceEdit.applyMeshGeo(box.uuid, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
		w.faceEdit.enterFaceEdit(box.uuid);
		w.faceEdit.setFaceGranularity('quad');
		return w.faceEdit.quadOfTriangle(0);
	});
	h.check(lone.length === 1 && lone[0] === 0, 'a triangle with no mate picks alone, not as a face');

	// a coplanar FAN (odd triangle count) still pairs what it can
	const fan = await A.page.evaluate(async () => {
		const w = window.__stores;
		// three coplanar tris in a strip: 2 pair into a quad, 1 is left over
		const strip = [
			0, 0, 0, 1, 0, 0, 0, 1, 0,
			1, 0, 0, 1, 1, 0, 0, 1, 0,
			1, 0, 0, 2, 0, 0, 1, 1, 0
		];
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		let box;
		g.children.forEach((c) => (box = c));
		w.faceEdit.applyMeshGeo(box.uuid, strip);
		const tris = w.faceEdit.readTriangles(
			g.getObjectByProperty('uuid', box.uuid).geometry
		);
		const partner = w.faceEdit.pairQuads(tris);
		return { count: tris.length, partner: [...partner] };
	});
	const fanPaired = fan.partner.filter((p) => p >= 0).length;
	h.check(fan.count === 3, 'a 3-triangle coplanar strip (premise)');
	h.check(
		fanPaired === 2 && fan.partner.filter((p) => p === -1).length === 1,
		'a fan pairs what it can and leaves the odd triangle alone (' + JSON.stringify(fan.partner) + ')'
	);

	// -------------------------------------------- 5. quads drive the OPS too
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const opUuid = await editBox(A.page);
	const opResult = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const mesh = g.getObjectByProperty('uuid', uuid);
		// an indexed source counts triangles from the INDEX, not the positions
		const triCount = () =>
			(mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
		const before = triCount();
		w.faceEdit.setFaceGranularity('quad');
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const ok = w.faceEdit.commitFaceOp('extrude', 0.3);
		return { ok, before, after: triCount() };
	}, opUuid);
	// extruding one quad: +4 wall quads = +8 triangles
	h.check(opResult.ok === true, 'extrude commits on a quad selection');
	h.check(
		opResult.after === opResult.before + 8,
		'extruding a quad stitches four walls (' + opResult.before + ' -> ' + opResult.after + ')'
	);

	// ----------------------------------- 6. the granularity cycle + legacy alias
	const cycle = await A.page.evaluate(() => {
		const w = window.__stores;
		const seen = [];
		const read = () => {
			let v;
			w.faceEdit.faceEditGranularity.subscribe((x) => (v = x))();
			return v;
		};
		w.faceEdit.setFaceGranularity('quad');
		for (let i = 0; i < 5; i++) {
			w.faceEdit.toggleFaceGranularity();
			seen.push(read());
		}
		// the RETIRED alias must still mean triangle, never quad
		w.faceEdit.setFaceGranularity('polygon');
		const legacy = read();
		return { seen, legacy };
	});
	h.check(
		cycle.seen.join('>') === 'face>triangle>shell>object>quad',
		'the cycle is quad > face > triangle > shell > object (' + cycle.seen.join('>') + ')'
	);
	h.check(cycle.legacy === 'triangle', 'the retired "polygon" alias still means triangle, not quad');

	// ---------------- 7. hovering across a quad's diagonal is not a new unit
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const hoverUuid = await editBox(A.page);
	void hoverUuid;
	const hover = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		f.setFaceGranularity('quad');
		const mate = f.quadOfTriangle(0).find((t) => t !== 0);
		const other = [0, 1, 2, 3, 4, 5].find((t) => !f.quadOfTriangle(0).includes(t));
		return {
			mate,
			first: f.highlightFaceByTriangle(0), // -1 -> quad: change
			sibling: f.highlightFaceByTriangle(mate), // same quad: NO change
			nextQuad: f.highlightFaceByTriangle(other) // different quad: change
		};
	});
	h.check(hover.mate !== undefined, 'triangle 0 has a quad mate (premise)');
	h.check(hover.first === true, 'the first hover reports a change');
	h.check(
		hover.sibling === false,
		'crossing a quad\'s internal diagonal is NOT a new unit (no overlay rebuild)'
	);
	h.check(hover.nextQuad === true, 'hovering a different quad does report a change');

	await h.finish(browser);
});
