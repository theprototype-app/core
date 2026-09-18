// F3 (v1.13): a PROPORTIONAL vertex drag replicates its falloff NEIGHBOURS.
//
// Before this, only the gesture's own handles went over the `verts` channel, so a peer
// watched the selected vertex rise and the bulge around it never arrive — until some
// unrelated full-geometry sync (a topology op, a reload, a late join) happened to carry
// it. Option A of the plan: stream nothing extra during the drag, commit ONE `meshgeo`
// on drag end (the same snapshot the undo entry already held), applied on BOTH sides so
// the geometry representation stays the same on each.
//
// The checks read NEIGHBOUR positions specifically, corner for corner — an aggregate
// health check (max/min/spread) passes with the neighbours unmoved, which is exactly how
// this gap survived 19-A P4. Counterfactual (proven at commit time): with the end-of-drag
// commit removed, B's halfway vertex reads 0 while A's reads 0.5 → red.
const h = require('./helpers.cjs');

/** z of the first position entry at grid (x, y) on the object with this uuid */
const Z_AT = ({ uuid, x, y }) => {
	let g;
	window.__stores.objectsGroup.subscribe((v) => (g = v))();
	const object = g?.getObjectByProperty('uuid', uuid);
	const position = object?.geometry?.attributes?.position;
	if (!position) return null;
	for (let i = 0; i < position.count; i++)
		if (Math.abs(position.getX(i) - x) < 1e-4 && Math.abs(position.getY(i) - y) < 1e-4) return position.getZ(i);
	return null;
};
const zAt = (page, uuid, x, y) => page.evaluate(Z_AT, { uuid, x, y });
const smooth = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// A makes the grid (a PlaneGeometry lies in XY, so the drag goes along Z; 4/8 = 0.5 step)
	const uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(
		() => zAt(B.page, uuid, 0, 0),
		(z) => z !== null,
		'B holds the plane (premise)',
		20000
	);

	// A: edit mode, pick the origin vertex, proportional on, drag it +1 in Z, release
	const drag = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const me = s.meshEdit;
		me.enterEditMode(uuid);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		let anchor = -1;
		for (let i = 0; i < 81; i++) {
			me.selectHandle(i);
			const p = controls.object?.position;
			if (!p) break;
			if (Math.hypot(p.x, p.y) < 1e-6) {
				anchor = i;
				break;
			}
		}
		if (anchor < 0) return { missing: true };
		me.selectHandle(anchor);
		me.proportionalEdit.set(true);
		me.proportionalRadius.set(1);
		me.onProxyDragChanged(true);
		controls.object.position.z += 0.4;
		me.onProxyMoved();
		controls.object.position.z += 0.6;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		// the gizmo must still sit on the vertex that was dragged (the selection was
		// re-found by POSITION after the geometry swap re-ordered the handles)
		const seat = controls.object?.position?.clone();
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const local = seat ? object.worldToLocal(seat.clone()) : null;
		return {
			seat: local ? [local.x, local.y, local.z] : null,
			indexed: !!object.geometry.index,
			count: object.geometry.attributes.position.count
		};
	}, uuid);
	h.check(!drag.missing, 'A found the origin vertex (premise)');

	// --- A's own picture, corner for corner -----------------------------------
	const pts = [
		['anchor', 0, 0, 1],
		['+x half', 0.5, 0, smooth(0.5)],
		['-x half', -0.5, 0, smooth(0.5)],
		['+y half', 0, 0.5, smooth(0.5)],
		['diagonal', 0.5, 0.5, smooth(Math.SQRT1_2)],
		['rim', 1, 0, 0],
		['beyond', 1.5, 0, 0]
	];
	for (const [label, x, y, expect] of pts) {
		const z = await zAt(A.page, uuid, x, y);
		h.check(z !== null && Math.abs(z - expect) < 1e-3, `A: ${label} sits at z=${expect.toFixed(3)} (${z?.toFixed(4)})`);
	}
	h.check(
		drag.seat && Math.abs(drag.seat[0]) < 1e-4 && Math.abs(drag.seat[1]) < 1e-4 && Math.abs(drag.seat[2] - 1) < 1e-3,
		`A's gizmo still sits on the dragged vertex after the swap (${JSON.stringify(drag.seat?.map((n) => +n.toFixed(3)))})`
	);
	h.check(!drag.indexed, 'A swapped to the same NON-indexed representation the peer will hold');

	// --- B receives the NEIGHBOURS, not just the selection ---------------------
	await h.eventually(
		() => zAt(B.page, uuid, 0.5, 0),
		(z) => z !== null && Math.abs(z - smooth(0.5)) < 1e-3,
		`B's halfway neighbour rose by the smoothstep weight (${smooth(0.5)})`,
		15000
	);
	for (const [label, x, y] of pts) {
		const a = await zAt(A.page, uuid, x, y);
		const b = await zAt(B.page, uuid, x, y);
		h.check(a !== null && b !== null && Math.abs(a - b) < 1e-5, `B matches A corner for corner: ${label} (${a?.toFixed(4)} vs ${b?.toFixed(4)})`);
	}
	const bCount = await B.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const object = g?.getObjectByProperty('uuid', uuid);
		return { count: object?.geometry?.attributes?.position?.count, indexed: !!object?.geometry?.index };
	}, uuid);
	h.check(bCount.count === drag.count && !bCount.indexed, `both peers hold the same layout (${drag.count} / ${bCount.count} entries)`);

	// --- a FOLLOW-UP plain drag still addresses the right vertices on the peer ----
	// (the representation agreement above is what makes this true: the sender's verts
	// indices must mean the same corners on the receiver)
	await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		me.proportionalEdit.set(false);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		me.onProxyDragChanged(true);
		controls.object.position.z += 0.5;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
	});
	await h.eventually(
		() => zAt(B.page, uuid, 0, 0),
		(z) => z !== null && Math.abs(z - 1.5) < 1e-3,
		'a later plain vertex drag lands on the same corner for B (indices agree)',
		15000
	);
	const stillHalf = await zAt(B.page, uuid, 0.5, 0);
	h.check(Math.abs(stillHalf - smooth(0.5)) < 1e-3, `...and touched no neighbour on B (${stillHalf?.toFixed(4)})`);

	// --- ONE undo flattens the bulge on A and reaches B --------------------------
	await A.page.evaluate(() => {
		window.__stores.history.undo(); // the plain drag
		window.__stores.history.undo(); // the whole bulge
	});
	const undone = await zAt(A.page, uuid, 0.5, 0);
	h.check(Math.abs(undone) < 1e-6, `one undo flattens the whole bulge on A (${undone?.toFixed(6)})`);
	await h.eventually(
		() => zAt(B.page, uuid, 0.5, 0),
		(z) => z !== null && Math.abs(z) < 1e-6,
		'the undo replicates to B',
		15000
	);

	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await h.finish(browser);
});
