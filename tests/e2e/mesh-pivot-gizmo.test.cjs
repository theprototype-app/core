// The mesh editor's TRANSFORM PIVOT, from a user report:
//
//   "selecting multiple vertices does not put gizmo into the center of selected
//    (so I cannot apply scale to few selected vertices as it just attaches to
//    the last one selected, neither rotate them), also I want to have a button
//    to adjust gizmo place and save it so I can rotate/scale around it"
//
// Two defects and one feature:
//   1. `setAnchor` seated the gizmo on `handleWorldPosition(index)` — ONE handle
//      — so a ctrl-built multi-selection put it on the last vertex clicked.
//   2. the same function then called `controls.setMode('translate')`
//      UNCONDITIONALLY on every re-seat, so vertex mode never offered rotate or
//      scale at all: 1/2/3 reach the proxy through setTransformMode, and the
//      next selection change put it straight back.
//   3. a placeable, remembered pivot (LOCAL pref, per object uuid) honoured by
//      vertices, edges and faces.
//
// A ROTATION guard needs an ANGLE. Every invariant a rotation preserves —
// distance from the pivot, the pivot itself not moving — is ALSO preserved by a
// rotation about the WRONG centre, so those checks pass with the feature absent.
// What separates them is the swept angle of the selection's CENTROID about an
// OFF-CENTRE pivot: 90 degrees when the pivot is honoured, exactly 0 when the
// rotation happens about the selection's own middle (the centroid is then a
// fixed point). Every angle here is measured from the MEAN of the moved points,
// never a bounding-box centre — the box of a rotated point set has a different
// SHAPE, so its centre is not the rotated image of the old centre.
//
// TEST TRAP worth keeping: `applyMeshGeo` rebuilds a NON-INDEXED geometry, so an
// undo of a mesh edit renumbers every handle (24 indexed entries -> 36 soup
// entries, grouped in a different order). Handle indices captured before one are
// meaningless after it — the first run of this suite silently rotated three
// arbitrary corners while every angle it measured stayed correct. So the handle
// map is re-probed before every selection is built, and the counts below are of
// UNIQUE welded positions, never of attribute entries.
const h = require('./helpers.cjs');

/** the seated gizmo proxy's world position + mode, or null */
const gizmo = (page) =>
	page.evaluate(() => {
		let controls;
		window.__stores.TControls.subscribe((c) => (controls = c))();
		const object = controls?.object;
		if (!object) return null;
		return {
			position: object.position.toArray(),
			mode: controls.mode,
			kind: object.userData?.isVertexProxy ? 'vertex' : object.userData?.isFaceProxy ? 'face' : 'object'
		};
	});

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Re-derive index -> LOCAL position for every welded handle of the live session.
 * A search that calls `selectHandle` REPLACES the selection on every step, so
 * this runs to completion BEFORE anything is built — and it has to run again
 * after any geometry rebuild (see the header note).
 */
const probeHandles = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const found = [];
		for (let i = 0; i < 64; i++) {
			s.meshEdit.selectHandle(i);
			// `vertexSelectionWorldPoint()` and NOT the gizmo's position: once a
			// pivot is placed the gizmo stops sitting on the handle (that IS the
			// feature), so reading the proxy reported the same point for all eight
			// and every index collapsed onto handle 0 — which then toggled itself
			// in and out and left the suite with no gizmo at all
			const p = s.meshEdit.vertexSelectionWorldPoint();
			if (!p) break; // out of range selects nothing — the handle list ended
			found.push([i, p.x, p.y, p.z]);
		}
		s.meshEdit.clearVertexSelection();
		return found;
	});

/** handle index of the corner nearest (x, y, z) in a probe result */
const nearest = (rows, x, y, z) =>
	rows.reduce((best, cur) =>
		Math.hypot(cur[1] - x, cur[2] - y, cur[3] - z) < Math.hypot(best[1] - x, best[2] - y, best[3] - z)
			? cur
			: best
	)[0];

/** the four TOP corner handle indices of a 2x2x2 box, from a fresh probe */
const topFour = (rows) => [
	nearest(rows, -1, 1, -1),
	nearest(rows, 1, 1, -1),
	nearest(rows, 1, 1, 1),
	nearest(rows, -1, 1, 1)
];

/**
 * A screen point that really grips the named gizmo handle. Projecting a handle
 * mesh's world position lands on the gizmo CENTRE (its origin), and a bbox
 * centre can overlap a neighbouring handle — the only trustworthy grip is one
 * the gizmo itself confirms, so every candidate is hovered and `controls.axis`
 * read back (the snap-advanced recipe).
 * @returns {Promise<number[]|null>}
 */
async function findGrip(page, axis) {
	const candidates = await page.evaluate((axis) => {
		const THREE = window.__stores.THREE;
		let controls = null;
		let cam = null;
		window.__stores.TControls.subscribe((v) => (controls = v))();
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		const helper = controls?.getHelper?.() ?? controls;
		if (!helper || !cam) return null;
		// VISIBLE meshes only: every mode's handles live in the same helper with
		// their visibility toggled, so an unfiltered traverse unions the translate
		// arrow, the scale box AND the rotate ring into one meaningless bbox — the
		// reason the ring grip could not be found at all.
		const visible = (n) => {
			for (let node = n; node && node !== helper; node = node.parent) if (!node.visible) return false;
			return true;
		};
		/** @type {any[]} */
		const picks = [];
		helper.updateMatrixWorld(true);
		helper.traverse((n) => {
			if (n.isMesh && n.name === axis && visible(n)) picks.push(n);
		});
		if (!picks.length) return null;
		// sample the handle's OWN geometry: a point on the mesh is on the handle
		// whatever shape it is (a shaft, a torus, a corner box)
		const centre = new THREE.Vector3().setFromMatrixPosition(helper.matrixWorld);
		/** @type {any[]} */
		const points = [];
		for (const pick of picks) {
			const attr = pick.geometry?.attributes?.position;
			if (!attr) continue;
			const stride = Math.max(1, Math.floor(attr.count / 24));
			for (let i = 0; i < attr.count; i += stride)
				points.push(new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4(pick.matrixWorld));
		}
		// outermost first: a point near the gizmo origin is ambiguous between handles
		points.sort((a, b) => b.distanceTo(centre) - a.distanceTo(centre));
		return points
			.slice(0, 30)
			.map((v) => v.project(cam))
			.map((v) => [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight]);
	}, axis);
	if (!candidates) return null;
	for (const px of candidates) {
		if (!Number.isFinite(px[0]) || !Number.isFinite(px[1])) continue;
		await page.mouse.move(px[0], px[1]);
		await page.waitForTimeout(60);
		const live = await page.evaluate(
			() => new Promise((r) => window.__stores.TControls.subscribe((c) => r(c?.axis))())
		);
		if (live === axis) return px;
	}
	return null;
}

/** read the live position attribute of the edited box */
const readPositions = (page, ref = '__box') =>
	page.evaluate((ref) => {
		const p = window[ref].geometry.attributes.position;
		const out = [];
		for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
		return out;
	}, ref);

/** the before/after pairs of the UNIQUE welded positions that moved — the
 * representation-independent view (a soup repeats a corner 3-6 times, and the
 * repeat count differs per corner) */
function movedPairs(before, after) {
	/** @type {Map<string, {from: number[], to: number[]}>} */
	const seen = new Map();
	for (let i = 0; i < after.length; i++) {
		if (i >= before.length || dist(before[i], after[i]) < 1e-6) continue;
		seen.set(before[i].map((n) => Math.round(n * 1e4)).join(','), { from: before[i], to: after[i] });
	}
	return [...seen.values()];
}
/** distinct welded positions that did NOT move */
function stillCount(before, after) {
	const seen = new Set();
	for (let i = 0; i < after.length; i++) {
		if (i < before.length && dist(before[i], after[i]) < 1e-6)
			seen.add(before[i].map((n) => Math.round(n * 1e4)).join(','));
	}
	return seen.size;
}
/** mean of a list of points — the CENTROID, which is rotation EQUIVARIANT. A
 * bounding-box centre is not (the box of a rotated point set has a different
 * shape), and reading one measured a 1-degree rotate as 1.51 last time. */
const mean = (points) => {
	const sum = [0, 0, 0];
	points.forEach((p) => {
		sum[0] += p[0];
		sum[1] += p[1];
		sum[2] += p[2];
	});
	return sum.map((v) => v / points.length);
};
/** swept angle (degrees) of a -> b about `pivot`, in the plane perpendicular to Y */
const sweptAboutY = (a, b, pivot) => {
	const v1 = [a[0] - pivot[0], a[2] - pivot[2]];
	const v2 = [b[0] - pivot[0], b[2] - pivot[2]];
	return (
		(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]) * 180) / Math.PI
	);
};
/** +90 degrees about Y through `pivot` */
const rotY90 = (p, pivot, sign) => {
	const x = p[0] - pivot[0];
	const z = p[2] - pivot[2];
	return [pivot[0] + sign * z, p[1], pivot[2] - sign * x];
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a 2x2x2 box at the origin, unrotated: LOCAL == WORLD, so every number below
	// is readable, and its position entries weld into 8 corner handles
	const uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(0, 0, 0);
		box.updateMatrixWorld(true);
		window.__box = box;
		return box.uuid;
	});
	await A.page.evaluate((uuid) => window.__stores.meshEdit.enterEditMode(uuid), uuid);

	let rows = await probeHandles(A.page);
	h.check(rows.length === 8, `a 2x2x2 box welds to 8 vertex handles (${rows.length})`);
	let TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `found the four TOP corners (${JSON.stringify(TOP)})`);

	// ======================================================================
	// 1. the gizmo sits at the CENTROID of a multi-selection
	// ======================================================================
	await A.page.evaluate((i) => window.__stores.meshEdit.selectHandle(i), TOP[0]);
	let seat = await gizmo(A.page);
	const p0 = rows.find((entry) => entry[0] === TOP[0]).slice(1);
	h.check(seat?.kind === 'vertex', 'a single pick seats the vertex gizmo');
	h.check(
		dist(seat.position, p0) < 1e-6,
		`ONE vertex: the gizmo is on that handle, unchanged (off by ${dist(seat.position, p0).toFixed(6)})`
	);

	await A.page.evaluate(
		(rest) => rest.forEach((i) => window.__stores.meshEdit.toggleVertexSelection(i)),
		TOP.slice(1)
	);
	seat = await gizmo(A.page);
	h.check(
		dist(seat.position, [0, 1, 0]) < 1e-6,
		`FOUR vertices: the gizmo sits at their CENTROID ${JSON.stringify(seat.position.map((n) => +n.toFixed(4)))}, not on the last one clicked`
	);
	const lastClicked = rows.find((entry) => entry[0] === TOP[3]).slice(1);
	h.check(
		dist(seat.position, lastClicked) > 0.9,
		`...which is ${dist(seat.position, lastClicked).toFixed(3)} away from the LAST-CLICKED handle — the reported defect`
	);

	// dropping a member moves it again: removals never went through setAnchor, so
	// the gizmo used to stay at the stale centroid
	await A.page.evaluate((i) => window.__stores.meshEdit.toggleVertexSelection(i), TOP[2]);
	seat = await gizmo(A.page);
	h.check(
		dist(seat.position, [(-1 + 1 - 1) / 3, 1, (-1 - 1 + 1) / 3]) < 1e-6,
		`removing a member RE-SEATS it on the new centroid ${JSON.stringify(seat.position.map((n) => +n.toFixed(4)))}`
	);

	// ======================================================================
	// 2. the transform MODE reaches the vertex gizmo (it forced translate)
	// ======================================================================
	const modes = await A.page.evaluate((i) => {
		const s = window.__stores;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		s.objectActions.setTransformMode('rotate');
		const armed = controls.mode;
		// the killer: ANY re-seat used to slam it back to translate
		s.meshEdit.toggleVertexSelection(i);
		const afterReselect = controls.mode;
		s.objectActions.setTransformMode('scale');
		const scaled = controls.mode;
		s.objectActions.setTransformMode('translate');
		return { armed, afterReselect, scaled, back: controls.mode };
	}, TOP[2]);
	h.check(modes.armed === 'rotate', `2 arms ROTATE on the vertex gizmo (${modes.armed})`);
	h.check(
		modes.afterReselect === 'rotate',
		`...and it SURVIVES a selection change (${modes.afterReselect}) — the re-seat used to force translate`
	);
	h.check(modes.scaled === 'scale', `3 arms SCALE (${modes.scaled})`);
	h.check(modes.back === 'translate', '1 goes back to Move');

	// ======================================================================
	// 3. a REAL mouse drag of the centroid-seated gizmo moves the whole set
	// ======================================================================
	const grip = await findGrip(A.page, 'X');
	h.check(!!grip, `found a confirmed grip on the translate X arrow (${JSON.stringify(grip)})`);
	if (grip) {
		const selSize = await A.page.evaluate(
			() => new Promise((r) => window.__stores.meshEdit.vertexSelectionSize.subscribe((v) => r(v))())
		);
		h.check(selSize === 4, `four vertices are selected for the real drag (${selSize})`);
		const before = await readPositions(A.page);
		await A.page.mouse.move(grip[0], grip[1]);
		await A.page.mouse.down();
		await A.page.mouse.move(grip[0] + 90, grip[1], { steps: 12 });
		await A.page.mouse.move(grip[0] + 91, grip[1]);
		await A.page.mouse.up();
		await A.page.waitForTimeout(300);
		const after = await readPositions(A.page);
		const pairs = movedPairs(before, after);
		h.check(pairs.length === 4, `exactly the FOUR selected corners moved (${pairs.length})`);
		h.check(stillCount(before, after) === 4, `the other four stayed put (${stillCount(before, after)})`);
		if (pairs.length) {
			const d0 = [0, 1, 2].map((k) => pairs[0].to[k] - pairs[0].from[k]);
			const spread = Math.max(
				...pairs.map((p) => dist([0, 1, 2].map((k) => p.to[k] - p.from[k]), d0))
			);
			h.check(
				Math.hypot(...d0) > 0.2,
				`the real drag actually moved them (${Math.hypot(...d0).toFixed(3)} world units)`
			);
			h.check(
				spread < 1e-5,
				`...all by the SAME delta ${JSON.stringify(d0.map((n) => +n.toFixed(4)))} (spread ${spread.toExponential(1)}) — a rigid translate from a centroid-seated gizmo`
			);
		}
		await A.page.evaluate(() => window.__stores.history.undo());
		await A.page.waitForTimeout(400);
	}

	// ======================================================================
	// 3b. GRID SNAP reaches the mesh element gizmo
	// ======================================================================
	// `snapping.apply()` writes setTranslationSnap onto the SHARED TControls
	// instance, and the element gizmo attaches its proxy to that very instance —
	// so a vertex drag has ALWAYS obeyed the app-wide snap setting. That is why
	// the toolbox's Gizmo section surfaces `snapEnabled`/`snapSettings` rather
	// than inventing a mesh-only twin, and this is the measurement behind that
	// decision, so it must keep holding: a real drag lands on a step multiple
	// with snapping on and off-grid with it off.
	//
	// A SINGLE-vertex pick, deliberately: the vertex is written straight from the
	// proxy's position (`worldToLocal(proxy.position)`), and the box is unrotated
	// at the origin, so "landed on a multiple" reads directly off the geometry. A
	// multi-selection moves by the proxy's DELTA instead, which says nothing
	// about where any one vertex ends up.
	const snapWas = await A.page.evaluate(() => {
		const s = window.__stores;
		let on;
		let cfg;
		s.snapping.snapEnabled.subscribe((v) => (on = v))();
		s.snapping.snapSettings.subscribe((v) => (cfg = { ...v }))();
		return { on, cfg };
	});
	const STEP = 0.5;
	/** set the snap, drag the X arrow of a single-vertex gizmo, undo, report */
	async function snapDrag(on) {
		await A.page.evaluate(
			({ on, step }) => {
				const s = window.__stores;
				s.snapping.snapSettings.update((v) => ({ ...v, translate: step }));
				s.snapping.snapEnabled.set(on);
				s.meshEdit.selectHandle(0);
			},
			{ on, step: STEP }
		);
		await A.page.waitForTimeout(300);
		const wired = await A.page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.TControls.subscribe((c) => r(c?.translationSnap ?? null))()
				)
		);
		const g = await findGrip(A.page, 'X');
		if (!g) return { wired, grip: false, pairs: [] };
		const before = await readPositions(A.page);
		await A.page.mouse.move(g[0], g[1]);
		await A.page.mouse.down();
		await A.page.mouse.move(g[0] + 83, g[1] + 11, { steps: 12 });
		await A.page.mouse.move(g[0] + 84, g[1] + 11);
		await A.page.mouse.up();
		await A.page.waitForTimeout(320);
		const pairs = movedPairs(before, await readPositions(A.page));
		await A.page.evaluate(() => window.__stores.history.undo());
		await A.page.waitForTimeout(400);
		return { wired, grip: true, pairs };
	}
	const snapOff = await snapDrag(false);
	const snapOn = await snapDrag(true);
	h.check(
		snapOff.wired === null,
		`snapping OFF leaves the shared gizmo unsnapped (translationSnap ${snapOff.wired})`
	);
	h.check(
		snapOn.wired === STEP,
		`snapping ON writes the step onto the SAME TControls the element gizmo uses (${snapOn.wired})`
	);
	h.check(snapOff.grip && snapOn.grip, 'found a confirmed X grip for both snap drags (premise)');
	h.check(
		snapOff.pairs.length === 1 && snapOn.pairs.length === 1,
		`each drag moved exactly one welded vertex (${snapOff.pairs.length} / ${snapOn.pairs.length})`
	);
	if (snapOff.pairs.length === 1 && snapOn.pairs.length === 1) {
		const onGrid = (p) => p.every((v) => Math.abs(v / STEP - Math.round(v / STEP)) < 1e-6);
		const travelled = (p) => dist(p.from, p.to);
		// the corners of a 2x2x2 box are ALREADY on a 0.5 grid, so a drag that did
		// nothing would satisfy the snapped case by accident
		h.check(
			travelled(snapOff.pairs[0]) > 0.2 && travelled(snapOn.pairs[0]) > 0.2,
			`both drags actually moved the vertex (${travelled(snapOff.pairs[0]).toFixed(3)} / ${travelled(snapOn.pairs[0]).toFixed(3)} world units)`
		);
		h.check(
			onGrid(snapOn.pairs[0].to),
			`snap ON: the vertex lands on a ${STEP} multiple — ${JSON.stringify(snapOn.pairs[0].to.map((n) => +n.toFixed(4)))}`
		);
		h.check(
			!onGrid(snapOff.pairs[0].to),
			`snap OFF: the same drag lands off-grid — ${JSON.stringify(snapOff.pairs[0].to.map((n) => +n.toFixed(4)))}`
		);
	}
	// restore: snapping is a PERSISTED app-wide pref, and a live rotation snap
	// would quantize every gizmo drag the sections below measure
	await A.page.evaluate((was) => {
		const s = window.__stores;
		s.snapping.snapSettings.set(was.cfg);
		s.snapping.snapEnabled.set(was.on);
	}, snapWas);
	await A.page.waitForTimeout(250);

	// ======================================================================
	// 4. the PIVOT: placed, honoured, and the rotation measured as an ANGLE
	// ======================================================================
	// pivot on the box's (1, -1, 1) corner — deliberately OFF the selection's own
	// centre (0, 1, 0), which is the only arrangement that can tell the two apart
	const PIVOT = [1, -1, 0];
	rows = await probeHandles(A.page); // the undo above renumbered every handle
	TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `...resolving to four DISTINCT top corners (${JSON.stringify(TOP)})`);
	const placed = await A.page.evaluate(
		({ uuid, PIVOT, TOP }) => {
			const s = window.__stores;
			s.meshEdit.selectHandle(TOP[0]);
			TOP.slice(1).forEach((i) => s.meshEdit.toggleVertexSelection(i));
			const ok = s.meshPivot.setMeshPivotLocal(uuid, new s.THREE.Vector3(...PIVOT));
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			let size;
			s.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
			return { ok, gizmo: controls.object.position.toArray(), size };
		},
		{ uuid, PIVOT, TOP }
	);
	h.check(placed.size === 4, `re-built the four-corner selection after the undo (${placed.size})`);
	h.check(placed.ok, 'placed a pivot on the (1, -1, 1) corner');
	h.check(
		dist(placed.gizmo, PIVOT) < 1e-6,
		`the gizmo MOVED to it immediately, with no re-pick (${JSON.stringify(placed.gizmo.map((n) => +n.toFixed(3)))})`
	);

	/** run one exact gizmo gesture through the REAL drag lifecycle */
	const gesture = async (page, spec) => {
		const before = await readPositions(page);
		const ran = await page.evaluate((spec) => {
			const s = window.__stores;
			const THREE = s.THREE;
			const me = s.meshEdit;
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			s.objectActions.setTransformMode(spec.mode);
			me.onProxyDragChanged(true);
			if (!controls.object) return false;
			if (spec.mode === 'rotate')
				controls.object.quaternion.setFromAxisAngle(
					new THREE.Vector3(...spec.axis),
					(spec.degrees * Math.PI) / 180
				);
			else if (spec.mode === 'scale') controls.object.scale.set(...spec.scale);
			else controls.object.position.add(new THREE.Vector3(...spec.move));
			me.onProxyMoved();
			me.onProxyDragChanged(false);
			s.objectActions.setTransformMode('translate');
			return true;
		}, spec);
		await page.waitForTimeout(150);
		return { ran, before, after: await readPositions(page) };
	};

	const rot = await gesture(A.page, { mode: 'rotate', axis: [0, 1, 0], degrees: 90 });
	h.check(rot.ran, 'the rotate gesture found a seated gizmo to drive (premise)');
	const rotPairs = movedPairs(rot.before, rot.after);
	h.check(rotPairs.length === 4, `the rotate moved the four selected corners (${rotPairs.length})`);
	h.check(
		stillCount(rot.before, rot.after) === 4,
		`the four BOTTOM corners did not move (${stillCount(rot.before, rot.after)})`
	);
	const cBefore = mean(rotPairs.map((p) => p.from));
	const cAfter = mean(rotPairs.map((p) => p.to));
	const swept = sweptAboutY(cBefore, cAfter, PIVOT);
	h.check(
		dist(cBefore, [0, 1, 0]) < 1e-6,
		`the moved set really is the top face (centroid ${JSON.stringify(cBefore.map((n) => +n.toFixed(3)))})`
	);
	h.check(
		Math.abs(Math.abs(swept) - 90) < 0.01,
		`the selection's CENTROID swept ${Math.abs(swept).toFixed(3)} degrees about the PIVOT — a rotation about the selection's own centre sweeps exactly 0, which is what the old code did`
	);
	h.check(
		Math.abs(cBefore[1] - cAfter[1]) < 1e-6,
		`...in the plane perpendicular to the axis (y unchanged: ${cBefore[1].toFixed(4)} -> ${cAfter[1].toFixed(4)})`
	);
	// exact landing, derived rather than pinned: the centroid (0,1,0) turned +-90
	// about (1,-1,0) lands on (1,1,1) or (1,1,-1)
	h.check(
		dist(cAfter, rotY90(cBefore, PIVOT, 1)) < 1e-6 || dist(cAfter, rotY90(cBefore, PIVOT, -1)) < 1e-6,
		`...landing exactly where the maths says (${JSON.stringify(cAfter.map((n) => +n.toFixed(4)))} vs ${JSON.stringify(rotY90(cBefore, PIVOT, 1).map((n) => +n.toFixed(4)))} / ${JSON.stringify(rotY90(cBefore, PIVOT, -1).map((n) => +n.toFixed(4)))})`
	);
	const sign = dist(cAfter, rotY90(cBefore, PIVOT, 1)) < 1e-6 ? 1 : -1;
	const perVertex = Math.max(...rotPairs.map((p) => dist(p.to, rotY90(p.from, PIVOT, sign))));
	h.check(
		perVertex < 1e-6,
		`every selected vertex landed on pivot + R90(v - pivot) (max error ${perVertex.toExponential(1)})`
	);

	// ONE undo reverts the whole gesture — the PROPERTY, never a stack depth
	// (recordEntry's LIMIT trim can evict the oldest, so a correct gesture may
	// leave the depth unchanged)
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	const undoneRows = await readPositions(A.page);
	const undoGap = Math.max(...rot.before.map((b, i) => dist(b, undoneRows[i] ?? [9, 9, 9])));
	h.check(
		undoneRows.length === rot.before.length && undoGap < 1e-6,
		`ONE undo restores the pre-rotate geometry exactly (max gap ${undoGap.toExponential(1)})`
	);
	await A.page.evaluate(() => window.__stores.history.redo());
	await A.page.waitForTimeout(400);
	const redoneRows = await readPositions(A.page);
	const redoGap = Math.max(...rot.after.map((a, i) => dist(a, redoneRows[i] ?? [9, 9, 9])));
	h.check(redoGap < 1e-6, `...and redo puts the rotation back (max gap ${redoGap.toExponential(1)})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);

	// SCALE about the pivot: every selected vertex lands on pivot + 2*(v - pivot)
	rows = await probeHandles(A.page);
	h.check(rows.length === 8, `re-probed 8 handles after the undo/redo (${rows.length})`);
	TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `...resolving to four DISTINCT top corners (${JSON.stringify(TOP)})`);
	await A.page.evaluate((TOP) => {
		const s = window.__stores;
		s.meshEdit.selectHandle(TOP[0]);
		TOP.slice(1).forEach((i) => s.meshEdit.toggleVertexSelection(i));
	}, TOP);
	const scaled = await gesture(A.page, { mode: 'scale', scale: [2, 2, 2] });
	h.check(scaled.ran, 'the scale gesture found a seated gizmo to drive (premise)');
	const scalePairs = movedPairs(scaled.before, scaled.after);
	h.check(scalePairs.length === 4, `the scale moved the four selected corners (${scalePairs.length})`);
	h.check(
		stillCount(scaled.before, scaled.after) === 4,
		`the unselected corners are byte-unchanged (${stillCount(scaled.before, scaled.after)})`
	);
	const scaleErr = Math.max(
		...scalePairs.map((p) => dist(p.to, [0, 1, 2].map((k) => PIVOT[k] + 2 * (p.from[k] - PIVOT[k]))))
	);
	h.check(
		scaleErr < 1e-6,
		`every one landed on pivot + 2*(v - pivot) (max error ${scaleErr.toExponential(1)}) — scaling about the SELECTION centre would put them somewhere else entirely`
	);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);

	// a REAL mouse rotate on the confirmed Y ring reaches the same code
	rows = await probeHandles(A.page);
	TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `...resolving to four DISTINCT top corners (${JSON.stringify(TOP)})`);
	await A.page.evaluate((TOP) => {
		const s = window.__stores;
		s.meshEdit.selectHandle(TOP[0]);
		TOP.slice(1).forEach((i) => s.meshEdit.toggleVertexSelection(i));
		s.objectActions.setTransformMode('rotate');
	}, TOP);
	const ring = await findGrip(A.page, 'Y');
	h.check(!!ring, `found a confirmed grip on the ROTATE Y ring (${JSON.stringify(ring)})`);
	if (ring) {
		const before = await readPositions(A.page);
		await A.page.mouse.move(ring[0], ring[1]);
		await A.page.mouse.down();
		await A.page.mouse.move(ring[0] + 70, ring[1] + 40, { steps: 14 });
		await A.page.mouse.move(ring[0] + 71, ring[1] + 40);
		await A.page.mouse.up();
		await A.page.waitForTimeout(350);
		const after = await readPositions(A.page);
		const pairs = movedPairs(before, after);
		h.check(pairs.length === 4, `the real ring drag turned the 4-vertex selection (${pairs.length} corners)`);
		if (pairs.length === 4) {
			const realSwept = Math.abs(
				sweptAboutY(mean(pairs.map((p) => p.from)), mean(pairs.map((p) => p.to)), PIVOT)
			);
			h.check(
				realSwept > 3,
				`...about the PIVOT, sweeping ${realSwept.toFixed(2)} degrees (0 would mean it turned about the selection centre)`
			);
			const radiusErr = Math.max(
				...pairs.map((p) =>
					Math.abs(
						Math.hypot(p.to[0] - PIVOT[0], p.to[2] - PIVOT[2]) -
							Math.hypot(p.from[0] - PIVOT[0], p.from[2] - PIVOT[2])
					)
				)
			);
			h.check(
				radiusErr < 1e-4,
				`...keeping every vertex's distance to the pivot (max drift ${radiusErr.toExponential(1)})`
			);
		}
		await A.page.evaluate(() => {
			window.__stores.history.undo();
			window.__stores.objectActions.setTransformMode('translate');
		});
		await A.page.waitForTimeout(400);
	}

	// ======================================================================
	// 5. the pivot is LOCAL: no wire traffic, nothing in the scene payload
	// ======================================================================
	const localOnly = await A.page.evaluate(({ uuid, PIVOT }) => {
		const s = window.__stores;
		const THREE = s.THREE;
		let original;
		s.peers.subscribe((v) => (original = v))();
		const sent = [];
		s.peers.set({ ...original, send: (m) => sent.push(m) });
		s.meshPivot.setMeshPivotLocal(uuid, new THREE.Vector3(0.5, 0.25, -0.5));
		s.meshPivot.clearMeshPivot(uuid);
		s.meshPivot.setMeshPivotLocal(uuid, new THREE.Vector3(...PIVOT));
		s.peers.set(original);
		const json = JSON.stringify(window.__box.toJSON());
		return {
			sent: sent.length,
			inJson: json.includes('meshPivot') || json.includes('pivot'),
			origin: window.__box.userData?.origin ?? null,
			stored: localStorage.getItem('meshPivots')
		};
	}, { uuid, PIVOT });
	h.check(
		localOnly.sent === 0,
		`placing and clearing a pivot sends NOTHING over the wire (${localOnly.sent} messages)`
	);
	h.check(!localOnly.inJson, 'the pivot is not in the object toJSON payload — it never reaches a save');
	h.check(
		localOnly.origin === null,
		'...and it did not touch userData.origin (17-D REPLICATED pivot: joints, flow Spin and the export bake read that one)'
	);
	h.check(
		!!localOnly.stored && localOnly.stored.includes(uuid),
		'it lives in the localStorage `meshPivots` map instead (a LOCAL pref, like viewPrefs)'
	);

	// ======================================================================
	// 6. the MARKER is a scene-root helper, never a child of the mesh
	// ======================================================================
	const marker = await A.page.evaluate(() => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		let node = null;
		scene.traverse((n) => {
			if (n.name === 'mesh-pivot-marker') node = n;
		});
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		let insideReplicated = false;
		group.traverse((n) => {
			if (n.name === 'mesh-pivot-marker') insideReplicated = true;
		});
		return {
			exists: !!node,
			visible: !!node?.visible,
			atRoot: node?.parent === scene,
			insideReplicated,
			unpickable: !!node && [node, ...node.children].every((c) => c.raycast() === undefined),
			debug: s.meshPivot.meshPivotMarkerDebug()
		};
	});
	h.check(marker.exists && marker.visible, 'a marker is drawn at the placed pivot');
	h.check(marker.atRoot, 'it hangs off the SCENE ROOT');
	h.check(
		!marker.insideReplicated,
		'...and NOT off objectsGroup — an editor helper inside the replicated tree gets written into every save (the edit-overlay leak)'
	);
	h.check(marker.unpickable, '...with raycast stubbed, so it can never swallow a pick');
	h.check(
		marker.debug && dist(marker.debug.position, PIVOT) < 1e-6,
		`the marker is at the pivot (${JSON.stringify(marker.debug?.position)})`
	);

	// ======================================================================
	// 7. PICK MODE — Esc leaves the session alone; a real click places the pivot
	// ======================================================================
	const armed = await A.page.evaluate(() => {
		const s = window.__stores;
		s.meshPivot.clearMeshPivot(window.__box.uuid);
		s.meshPivot.startMeshPivotPick();
		let on;
		s.meshPivot.meshPivotPicking.subscribe((v) => (on = v))();
		return on;
	});
	h.check(armed === true, 'the Pick button arms pick mode');
	// Escape drops the PICK, not the session. THREE window handlers see that key
	// (meshEdit, faceEdit and the toolbox), so the verdict rides the EVENT — a
	// one-shot store flag would be eaten by whichever ran first and the others
	// would tear the session down anyway (the knife rule).
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	const afterEsc = await A.page.evaluate(() => {
		const s = window.__stores;
		let on;
		let session;
		s.meshPivot.meshPivotPicking.subscribe((v) => (on = v))();
		s.meshEdit.editingObject.subscribe((v) => (session = v))();
		return { on, session };
	});
	h.check(afterEsc.on === false, 'Escape leaves pick mode');
	h.check(
		!!afterEsc.session,
		'...and the edit session SURVIVES it — a SECOND Escape is what ends that'
	);

	// aim at a real corner of the box and click it for real
	const cornerPx = await h.projectPoint(A.page, [-1, -1, 1]);
	await A.page.evaluate(() => window.__stores.meshPivot.startMeshPivotPick());
	await A.page.mouse.click(Math.round(cornerPx.x), Math.round(cornerPx.y));
	await A.page.waitForTimeout(400);
	const picked = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		let map;
		s.meshPivot.meshPivots.subscribe((v) => (map = v))();
		let on;
		s.meshPivot.meshPivotPicking.subscribe((v) => (on = v))();
		return { pivot: map[uuid] ?? null, on };
	}, uuid);
	h.check(picked.on === false, 'the click ends pick mode');
	h.check(
		!!picked.pivot && dist(picked.pivot, [-1, -1, 1]) < 0.05,
		`a real viewport click on the (-1,-1,1) corner snapped the pivot ONTO it (${JSON.stringify(picked.pivot?.map((n) => +n.toFixed(3)))})`
	);

	// ======================================================================
	// 8. "Set here" from the current selection
	// ======================================================================
	rows = await probeHandles(A.page);
	TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `...resolving to four DISTINCT top corners (${JSON.stringify(TOP)})`);
	const setHere = await A.page.evaluate(
		({ uuid, TOP }) => {
			const s = window.__stores;
			s.meshPivot.clearMeshPivot(uuid);
			s.meshEdit.selectHandle(TOP[0]);
			TOP.slice(1).forEach((i) => s.meshEdit.toggleVertexSelection(i));
			const ok = s.meshPivot.setMeshPivotFromSelection('vertices');
			let map;
			s.meshPivot.meshPivots.subscribe((v) => (map = v))();
			return { ok, pivot: map[uuid] ?? null };
		},
		{ uuid, TOP }
	);
	h.check(setHere.ok, 'Set here places a pivot from the current vertex selection');
	h.check(
		!!setHere.pivot && dist(setHere.pivot, [0, 1, 0]) < 1e-6,
		`...at its centroid (${JSON.stringify(setHere.pivot)})`
	);

	// ======================================================================
	// 9. it survives leaving/re-entering the session, and ALL THREE element
	//    modes honour it
	// ======================================================================
	const reenter = await A.page.evaluate(
		({ uuid, PIVOT }) => {
			const s = window.__stores;
			s.meshPivot.setMeshPivotLocal(uuid, new s.THREE.Vector3(...PIVOT));
			s.meshEdit.exitEditMode();
			s.meshEdit.enterEditMode(uuid);
			s.meshEdit.selectHandle(0);
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			const vertices = controls.object?.position.toArray() ?? null;

			// FACES
			s.meshEdit.exitEditMode();
			s.faceEdit.enterFaceEdit(uuid);
			s.faceEdit.setFaceSubmode('faces');
			s.faceEdit.setFaceGranularity('face');
			const faces = s.faceEdit.currentFaces();
			const top = faces.findIndex((f) => f.normal.y > 0.9);
			s.faceEdit.highlightFaceByTriangle(faces[top].triIndices[0]);
			s.faceEdit.setFaceOp('move');
			s.faceEdit.attachFaceGizmo();
			const facePos = controls.object?.position.toArray() ?? null;
			const faceCentroid = window.__box.localToWorld(faces[top].centroid.clone()).toArray();

			// EDGES
			s.faceEdit.setFaceSubmode('edges');
			const tris = s.faceEdit.readTriangles(window.__box.geometry);
			let got = 0;
			for (let ti = 0; ti < tris.length && !got; ti++) {
				const t = tris[ti];
				const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
				for (let e = 0; e < 3 && !got; e++) {
					const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
					const key = s.faceEdit.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
					if (!key) continue;
					s.faceEdit.pickEdge(key, false);
					got = s.faceEdit.edgeSelectionSize();
				}
			}
			s.faceEdit.attachFaceGizmo();
			const edgePos = controls.object?.position.toArray() ?? null;
			const edgeCentroid = window.__box
				.localToWorld(s.faceEdit.edgeGrabTarget().centroid.clone())
				.toArray();
			return { vertices, facePos, faceCentroid, edgePos, edgeCentroid, edges: got };
		},
		{ uuid, PIVOT }
	);
	h.check(
		!!reenter.vertices && dist(reenter.vertices, PIVOT) < 1e-6,
		`VERTICES: the pivot survived leaving and re-entering the session (${JSON.stringify(reenter.vertices)})`
	);
	h.check(
		!!reenter.facePos && dist(reenter.facePos, PIVOT) < 1e-6,
		`FACES: the gizmo seats on the pivot, not the face centroid ${JSON.stringify(reenter.faceCentroid.map((n) => +n.toFixed(2)))}`
	);
	h.check(reenter.edges === 1, `picked one edge (premise, ${reenter.edges})`);
	h.check(
		!!reenter.edgePos && dist(reenter.edgePos, PIVOT) < 1e-6,
		`EDGES: the gizmo seats on the pivot, not the edge centroid ${JSON.stringify(reenter.edgeCentroid.map((n) => +n.toFixed(2)))}`
	);

	// a FACE rotate really turns about it — the seating and the maths must agree,
	// or the handles lie about what the drag will do. The delta is PREMULTIPLIED
	// so it is a rotation in OBJECT space: the face proxy carries the face BASIS
	// (top face: local Y maps to world X), so post-multiplying rotates about the
	// wrong axis — which is exactly what the first run of this suite measured.
	const faceBefore = await readPositions(A.page);
	await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		s.faceEdit.setFaceSubmode('faces');
		s.faceEdit.setFaceGranularity('face');
		const faces = s.faceEdit.currentFaces();
		const top = faces.findIndex((f) => f.normal.y > 0.9);
		s.faceEdit.highlightFaceByTriangle(faces[top].triIndices[0]);
		s.faceEdit.setFaceOp('move');
		s.faceEdit.attachFaceGizmo();
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		s.faceEdit.onFaceGizmoDragChanged(true);
		controls.object.quaternion.premultiply(
			new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
		);
		s.faceEdit.onFaceGizmoMoved();
		s.faceEdit.onFaceGizmoDragChanged(false);
	});
	await A.page.waitForTimeout(250);
	const faceAfter = await readPositions(A.page);
	const facePairs = movedPairs(faceBefore, faceAfter);
	h.check(facePairs.length === 4, `the face rotate moved the top face's four corners (${facePairs.length})`);
	if (facePairs.length) {
		const fSwept = Math.abs(
			sweptAboutY(mean(facePairs.map((p) => p.from)), mean(facePairs.map((p) => p.to)), PIVOT)
		);
		h.check(
			Math.abs(fSwept - 90) < 0.01,
			`FACES: the face's centroid swept ${fSwept.toFixed(3)} degrees about the PIVOT (about the face's own centre it is exactly 0)`
		);
		const fErr = Math.min(
			Math.max(...facePairs.map((p) => dist(p.to, rotY90(p.from, PIVOT, 1)))),
			Math.max(...facePairs.map((p) => dist(p.to, rotY90(p.from, PIVOT, -1))))
		);
		h.check(fErr < 1e-5, `...every corner landing on pivot + R90(v - pivot) (max error ${fErr.toExponential(1)})`);
	}
	await A.page.evaluate(() => {
		window.__stores.history.undo();
		window.__stores.faceEdit.exitFaceEdit();
	});
	await A.page.waitForTimeout(400);

	// clearing goes back to the selection's own centre
	await A.page.evaluate((uuid) => window.__stores.meshEdit.enterEditMode(uuid), uuid);
	rows = await probeHandles(A.page);
	TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `...resolving to four DISTINCT top corners (${JSON.stringify(TOP)})`);
	const cleared = await A.page.evaluate(
		({ uuid, TOP }) => {
			const s = window.__stores;
			s.meshEdit.selectHandle(TOP[0]);
			TOP.slice(1).forEach((i) => s.meshEdit.toggleVertexSelection(i));
			const ok = s.meshPivot.clearMeshPivot(uuid);
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			let node = null;
			let scene;
			s.globalScene.subscribe((v) => (scene = v))();
			scene.traverse((n) => {
				if (n.name === 'mesh-pivot-marker') node = n;
			});
			return { ok, position: controls.object?.position.toArray() ?? null, markerVisible: !!node?.visible };
		},
		{ uuid, TOP }
	);
	h.check(cleared.ok, 'Clear removes the pivot');
	h.check(
		!!cleared.position && dist(cleared.position, [0, 1, 0]) < 1e-6,
		`...and the gizmo falls back to the selection centroid (${JSON.stringify(cleared.position)})`
	);
	h.check(!cleared.markerVisible, '...and the marker goes away with it');

	// ======================================================================
	// 10. MOVE PIVOT — place it by DRAGGING THE GIZMO ITSELF
	// ======================================================================
	// The third placement route ("additionally I want also to have free move of
	// pivot by moving gizmo to set it"), modelled on 17-D's `pivotOnly`: while
	// the mode is armed the gizmo re-points the PIVOT and the mesh does not move.
	//
	// The load-bearing assertion is the NEGATIVE one. Everything else here could
	// be satisfied by a drag that ALSO deformed the mesh, so each drag compares
	// the FULL position array before and after — an aggregate "nothing moved" is
	// exactly right for an op whose whole contract is that it touches no vertex.

	/** capture the top of the undo stack BY REFERENCE — the property the spec
	 * cares about ("no entry was recorded"), and immune to recordEntry's LIMIT
	 * trim, which can leave a raw depth unchanged after a real entry lands */
	const historyMark = (page) =>
		page.evaluate(() => {
			let stack;
			window.__stores.history.undoStack.subscribe((v) => (stack = v))();
			window.__histTop = stack[stack.length - 1] ?? null;
			window.__histLen = stack.length;
			return { len: stack.length, kind: window.__histTop?.kind ?? null };
		});
	const historySame = (page) =>
		page.evaluate(() => {
			let stack;
			window.__stores.history.undoStack.subscribe((v) => (stack = v))();
			return {
				same: (stack[stack.length - 1] ?? null) === window.__histTop,
				len: stack.length,
				was: window.__histLen,
				kind: stack[stack.length - 1]?.kind ?? null
			};
		});
	/** install a PASS-THROUGH send spy (a swallowing spy makes delivery and loss
	 * look identical — the documented rule). Patched as an OWN property on the
	 * live PeerConnection rather than swapping the store for a spread copy: a
	 * spread loses every prototype method, and this spy has to survive a real
	 * mouse drag with the whole app reacting around it. */
	const spyOn = (page) =>
		page.evaluate(() => {
			let original;
			window.__stores.peers.subscribe((v) => (original = v))();
			window.__peersOriginal = original;
			window.__sent = [];
			const through = original.send.bind(original);
			original.send = (m) => {
				window.__sent.push(m?.type ?? '?');
				return through(m);
			};
		});
	const spyOff = (page) =>
		page.evaluate(() => {
			delete window.__peersOriginal.send; // back to the prototype method
			return window.__sent;
		});
	/** the whole live position attribute, plus the pivot / gizmo / marker */
	const pivotState = (page, uuid) =>
		page.evaluate((uuid) => {
			const s = window.__stores;
			let map;
			s.meshPivot.meshPivots.subscribe((v) => (map = v))();
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			let moving;
			s.meshPivot.meshPivotMoving.subscribe((v) => (moving = v))();
			let mode;
			s.transformMode.subscribe((v) => (mode = v))();
			let session;
			s.meshEdit.editingObject.subscribe((v) => (session = v))();
			return {
				pivot: map[uuid] ?? null,
				gizmo: controls?.object?.position?.toArray() ?? null,
				controlMode: controls?.mode ?? null,
				storeMode: mode,
				moving,
				session,
				marker: s.meshPivot.meshPivotMarkerDebug()?.position ?? null
			};
		}, uuid);

	// (a) ARMING. The mode the user was in is remembered and translate is forced:
	// a pivot is a POINT, so rotate/scale handles on it could not mean anything.
	const armMove = await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.setTransformMode('rotate'); // something to restore later
		const ok = s.meshPivot.startMeshPivotMove();
		return ok;
	});
	h.check(armMove === true, 'the Move button arms move-pivot mode');
	let mv = await pivotState(A.page, uuid);
	h.check(mv.moving === true, 'meshPivotMoving is set');
	h.check(
		mv.controlMode === 'translate' && mv.storeMode === 'translate',
		`...and it FORCES translate for its duration (controls ${mv.controlMode} / store ${mv.storeMode}) — a point has no rotation or scale`
	);
	h.check(
		!!mv.gizmo && dist(mv.gizmo, [0, 1, 0]) < 1e-6,
		`with no pivot placed the gizmo sits at the seat it would otherwise use — the selection centroid ${JSON.stringify(mv.gizmo?.map((n) => +n.toFixed(4)))} — so arming and dragging is a complete way to place the FIRST one`
	);

	// (b) a REAL mouse drag of the X arrow moves the PIVOT and NOTHING else
	let dragPivot = null;
	const moveGrip = await findGrip(A.page, 'X');
	h.check(!!moveGrip, `found a confirmed grip on the translate X arrow (${JSON.stringify(moveGrip)})`);
	if (moveGrip) {
		const before = await readPositions(A.page);
		const histBefore = await historyMark(A.page);
		h.check(histBefore.len > 0, `the undo stack has something on it to protect (${histBefore.len} entries, top '${histBefore.kind}')`);
		await spyOn(A.page);
		await A.page.mouse.move(moveGrip[0], moveGrip[1]);
		await A.page.mouse.down();
		await A.page.mouse.move(moveGrip[0] + 100, moveGrip[1], { steps: 12 });
		await A.page.mouse.move(moveGrip[0] + 101, moveGrip[1]);
		await A.page.mouse.up();
		await A.page.waitForTimeout(350);
		const sent = await spyOff(A.page);
		const after = await readPositions(A.page);
		const hist = await historySame(A.page);
		mv = await pivotState(A.page, uuid);
		dragPivot = mv.pivot;

		// THE negative check: not one vertex of the mesh may have moved
		const worst = Math.max(...after.map((p, i) => (i < before.length ? dist(before[i], p) : 9)));
		h.check(
			after.length === before.length && worst < 1e-9,
			`the drag moved NO vertex at all — the whole position array is byte-identical (${after.length} entries, worst delta ${worst.toExponential(1)})`
		);
		h.check(
			movedPairs(before, after).length === 0,
			`...and no welded position moved either (${movedPairs(before, after).length})`
		);
		// ...while the pivot really did move (or the check above is vacuous)
		h.check(
			!!dragPivot && Math.abs(dragPivot[0]) > 0.2,
			`the PIVOT moved along X to ${JSON.stringify(dragPivot?.map((n) => +n.toFixed(4)))} (premise: the gesture did something)`
		);
		h.check(
			!!dragPivot && Math.abs(dragPivot[1] - 1) < 1e-6 && Math.abs(dragPivot[2]) < 1e-6,
			`...along the X arrow only, from the (0,1,0) seat (y ${dragPivot?.[1].toFixed(4)}, z ${dragPivot?.[2].toFixed(4)})`
		);
		h.check(
			hist.same && hist.len === hist.was,
			`the drag recorded NO history entry — the stack's top object is the SAME one (${hist.was} -> ${hist.len}, top '${hist.kind}')`
		);
		h.check(
			sent.length === 0,
			`...and sent NOTHING over the wire: the pivot is a LOCAL working preference (${sent.length} messages${sent.length ? ': ' + JSON.stringify(sent) : ''})`
		);
		h.check(
			!!mv.gizmo && !!dragPivot && dist(mv.gizmo, dragPivot) < 1e-6,
			`the gizmo re-seated exactly on the placed pivot (${JSON.stringify(mv.gizmo?.map((n) => +n.toFixed(4)))})`
		);
		h.check(
			!!mv.marker && !!dragPivot && dist(mv.marker, dragPivot) < 1e-6,
			`...and the marker followed it (${JSON.stringify(mv.marker?.map((n) => +n.toFixed(4)))})`
		);
		h.check(
			mv.moving === true,
			'the mode STAYS armed after the drag — one press, many placements (17-D: a re-seat is not a new selection, so committing must not cancel the mode)'
		);
	}

	// (c) a RE-SEAT must not disarm it (the 17-D rule that cost the most to learn:
	// resetting the armed state on a re-seat made the button cancel itself)
	const reseat = await A.page.evaluate((i) => {
		const s = window.__stores;
		s.meshEdit.toggleVertexSelection(i); // the selection changes -> setAnchor runs
		let moving;
		s.meshPivot.meshPivotMoving.subscribe((v) => (moving = v))();
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		s.meshEdit.toggleVertexSelection(i); // put it back
		return { moving, gizmo: controls?.object?.position?.toArray() ?? null };
	}, TOP[2]);
	h.check(reseat.moving === true, 'changing the selection while armed does NOT disarm it');
	h.check(
		!!reseat.gizmo && !!dragPivot && dist(reseat.gizmo, dragPivot) < 1e-6,
		`...and the re-seat put the gizmo back on the pivot, not on the new centroid (${JSON.stringify(reseat.gizmo?.map((n) => +n.toFixed(4)))})`
	);

	// (d) a pivot placed this way is a pivot like any other: it survives leaving
	// and re-entering the session (the reload is section 11)
	const afterReenter = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.meshEdit.exitEditMode(); // also disarms — an armed tool never outlives the session
		s.meshEdit.enterEditMode(uuid);
		s.meshEdit.selectHandle(0);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		let moving;
		s.meshPivot.meshPivotMoving.subscribe((v) => (moving = v))();
		return { gizmo: controls?.object?.position?.toArray() ?? null, moving };
	}, uuid);
	h.check(
		!!afterReenter.gizmo && !!dragPivot && dist(afterReenter.gizmo, dragPivot) < 1e-6,
		`the drag-placed pivot survives leaving and re-entering the session (${JSON.stringify(afterReenter.gizmo?.map((n) => +n.toFixed(4)))})`
	);
	h.check(
		afterReenter.moving === false,
		'...and leaving the session DISARMED the mode (an armed tool never outlives it — the vertexSlide/pick rule)'
	);

	// (e) disarming puts the transform mode back where it was
	const restored = await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.setTransformMode('rotate');
		s.meshPivot.startMeshPivotMove();
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const forced = controls?.mode;
		s.meshPivot.cancelMeshPivotMove();
		// read the live controls BEFORE tidying up: `controls.mode` in the return
		// literal is evaluated last, so the tidy-up below would be what it reports
		const back = controls?.mode;
		let mode;
		s.transformMode.subscribe((v) => (mode = v))();
		let moving;
		s.meshPivot.meshPivotMoving.subscribe((v) => (moving = v))();
		s.objectActions.setTransformMode('translate'); // leave the suite in Move
		return { forced, back, store: mode, moving };
	});
	h.check(restored.forced === 'translate', `arming from ROTATE forces translate (${restored.forced})`);
	h.check(restored.moving === false, 'the button again disarms');
	h.check(
		restored.back === 'rotate' && restored.store === 'rotate',
		`...and disarming restores the mode the user had (controls ${restored.back} / store ${restored.store})`
	);

	// (f) the point of the whole feature: a rotate now turns about the pivot the
	// GIZMO DRAG placed. Measured as the swept ANGLE of the selection's centroid
	// about it — every invariant a rotation preserves survives a rotation about
	// the WRONG centre, so only an angle separates them.
	rows = await probeHandles(A.page);
	TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `...resolving to four DISTINCT top corners (${JSON.stringify(TOP)})`);
	await A.page.evaluate((TOP) => {
		const s = window.__stores;
		s.meshEdit.selectHandle(TOP[0]);
		TOP.slice(1).forEach((i) => s.meshEdit.toggleVertexSelection(i));
	}, TOP);
	const aboutDragged = await gesture(A.page, { mode: 'rotate', axis: [0, 1, 0], degrees: 90 });
	h.check(aboutDragged.ran, 'the rotate gesture found a seated gizmo to drive (premise)');
	const dragPairs = movedPairs(aboutDragged.before, aboutDragged.after);
	h.check(dragPairs.length === 4, `it turned the four selected corners (${dragPairs.length})`);
	if (dragPairs.length === 4 && dragPivot) {
		const cFrom = mean(dragPairs.map((p) => p.from));
		const cTo = mean(dragPairs.map((p) => p.to));
		const sweptDrag = Math.abs(sweptAboutY(cFrom, cTo, dragPivot));
		h.check(
			Math.abs(sweptDrag - 90) < 0.01,
			`the centroid swept ${sweptDrag.toFixed(3)} degrees about the DRAG-PLACED pivot (about the selection's own centre it sweeps exactly 0)`
		);
		const sgn = dist(cTo, rotY90(cFrom, dragPivot, 1)) < 1e-5 ? 1 : -1;
		const err = Math.max(...dragPairs.map((p) => dist(p.to, rotY90(p.from, dragPivot, sgn))));
		h.check(
			err < 1e-5,
			`...every corner landing on dragPivot + R90(v - dragPivot) (max error ${err.toExponential(1)})`
		);
	}
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);

	// (g) ESCAPE disarms and KEEPS the session (three window handlers see that
	// key, so the verdict rides the event — the same contract as the pick)
	await A.page.evaluate(() => window.__stores.meshPivot.startMeshPivotMove());
	const armedSeat = await pivotState(A.page, uuid);
	h.check(
		!!armedSeat.gizmo && !!dragPivot && dist(armedSeat.gizmo, dragPivot) < 1e-6,
		`arming with a pivot ALREADY placed seats the gizmo on IT (${JSON.stringify(armedSeat.gizmo?.map((n) => +n.toFixed(4)))})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	const escaped = await pivotState(A.page, uuid);
	h.check(escaped.moving === false, 'Escape leaves move-pivot mode');
	h.check(!!escaped.session, '...and the edit session SURVIVES it — a later Escape is what ends that');
	h.check(
		escaped.storeMode === 'translate',
		`...restoring the transform mode on the way out (${escaped.storeMode})`
	);

	// (h) the two placement modes are MUTUALLY EXCLUSIVE
	const exclusive = await A.page.evaluate(() => {
		const s = window.__stores;
		const read = () => {
			let moving;
			let picking;
			s.meshPivot.meshPivotMoving.subscribe((v) => (moving = v))();
			s.meshPivot.meshPivotPicking.subscribe((v) => (picking = v))();
			return { moving, picking };
		};
		s.meshPivot.startMeshPivotMove();
		s.meshPivot.startMeshPivotPick();
		const pickWins = read();
		s.meshPivot.startMeshPivotMove();
		const moveWins = read();
		s.meshPivot.cancelMeshPivotMove();
		return { pickWins, moveWins, off: read() };
	});
	h.check(
		exclusive.pickWins.picking === true && exclusive.pickWins.moving === false,
		`arming Pick cancels an armed Move (${JSON.stringify(exclusive.pickWins)})`
	);
	h.check(
		exclusive.moveWins.moving === true && exclusive.moveWins.picking === false,
		`...and arming Move cancels an armed Pick (${JSON.stringify(exclusive.moveWins)})`
	);
	h.check(!exclusive.off.moving && !exclusive.off.picking, 'both end up off');

	// (i) CLEARING the pivot while armed leaves the mode usable — it falls back
	// to the seat it would otherwise use
	const clearedArmed = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.meshPivot.startMeshPivotMove();
		s.meshPivot.clearMeshPivot(uuid);
		let moving;
		s.meshPivot.meshPivotMoving.subscribe((v) => (moving = v))();
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const gizmo = controls?.object?.position?.toArray() ?? null;
		s.meshPivot.cancelMeshPivotMove();
		return { moving, gizmo };
	}, uuid);
	h.check(clearedArmed.moving === true, 'clearing the pivot while armed keeps the mode armed');
	h.check(
		!!clearedArmed.gizmo && dist(clearedArmed.gizmo, [0, 1, 0]) < 1e-6,
		`...with the gizmo back on the selection centroid, ready to place a new one (${JSON.stringify(clearedArmed.gizmo?.map((n) => +n.toFixed(4)))})`
	);

	// (j) FACES: the same divert on the OTHER gizmo hook pair, driven end to end
	// with a real mouse. Faces and edges share this proxy, so covering faces
	// covers the sub-mode too (the seat is asserted for both in section 9).
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.meshEdit.exitEditMode();
		s.faceEdit.enterFaceEdit(uuid);
		s.faceEdit.setFaceSubmode('faces');
		s.faceEdit.setFaceGranularity('face');
		const faces = s.faceEdit.currentFaces();
		const top = faces.findIndex((f) => f.normal.y > 0.9);
		s.faceEdit.highlightFaceByTriangle(faces[top].triIndices[0]);
		s.faceEdit.setFaceOp('move');
		s.faceEdit.attachFaceGizmo();
		s.meshPivot.startMeshPivotMove();
	}, uuid);
	await A.page.waitForTimeout(200);
	const faceArmed = await gizmo(A.page);
	h.check(faceArmed?.kind === 'face', `FACES: the face gizmo is the one seated (${faceArmed?.kind})`);
	h.check(
		!!faceArmed && dist(faceArmed.position, [0, 1, 0]) < 1e-6,
		`...at the top face's centroid, the pivot having just been cleared (${JSON.stringify(faceArmed?.position.map((n) => +n.toFixed(4)))})`
	);
	const faceGrip = await findGrip(A.page, 'X');
	h.check(!!faceGrip, `found a confirmed grip on the FACE gizmo's X arrow (${JSON.stringify(faceGrip)})`);
	let facePivot = null;
	if (faceGrip) {
		const before = await readPositions(A.page);
		await historyMark(A.page);
		await spyOn(A.page);
		await A.page.mouse.move(faceGrip[0], faceGrip[1]);
		await A.page.mouse.down();
		await A.page.mouse.move(faceGrip[0] + 80, faceGrip[1] - 30, { steps: 12 });
		await A.page.mouse.move(faceGrip[0] + 81, faceGrip[1] - 30);
		await A.page.mouse.up();
		await A.page.waitForTimeout(350);
		const sent = await spyOff(A.page);
		const after = await readPositions(A.page);
		const hist = await historySame(A.page);
		const state = await pivotState(A.page, uuid);
		facePivot = state.pivot;
		const worst = Math.max(...after.map((p, i) => (i < before.length ? dist(before[i], p) : 9)));
		h.check(
			after.length === before.length && worst < 1e-9,
			`FACES: the drag moved NO vertex — the position array is byte-identical (worst delta ${worst.toExponential(1)}); without the divert this is a rigid FACE GRAB`
		);
		h.check(
			!!facePivot && dist(facePivot, [0, 1, 0]) > 0.2,
			`...while the pivot moved off the face centroid to ${JSON.stringify(facePivot?.map((n) => +n.toFixed(4)))} (premise)`
		);
		h.check(
			hist.same && hist.len === hist.was,
			`...recording no history entry (${hist.was} -> ${hist.len}, same top object: ${hist.same})`
		);
		h.check(
			sent.length === 0,
			`...and sending nothing (${sent.length} messages${sent.length ? ': ' + JSON.stringify(sent) : ''})`
		);
		h.check(
			!!state.gizmo && !!facePivot && dist(state.gizmo, facePivot) < 1e-6,
			`...with the face gizmo re-seated on the new pivot (${JSON.stringify(state.gizmo?.map((n) => +n.toFixed(4)))})`
		);
	}
	// Escape in the FACE session disarms without ending it either
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	const faceEsc = await A.page.evaluate(() => {
		const s = window.__stores;
		let moving;
		let session;
		s.meshPivot.meshPivotMoving.subscribe((v) => (moving = v))();
		s.faceEdit.faceEditObject.subscribe((v) => (session = v))();
		return { moving, session };
	});
	h.check(faceEsc.moving === false, 'FACES: Escape disarms move-pivot');
	h.check(!!faceEsc.session, '...and the FACE session survives it (the second Escape ends that)');

	// ======================================================================
	// 11. it PERSISTS across a reload (a local pref, not session state)
	// ======================================================================
	// carrying the pivot the FACE gizmo drag placed, so the reload proves the
	// real thing rather than a value the test wrote through the store
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.waitForTimeout(500);
	await h.freshReload(A);
	await A.page.waitForTimeout(1200);
	// a reload gives the page a NEW peer id — re-read it before any connect below
	A.id = await A.page.evaluate(
		() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))())
	);
	const survived = await A.page.evaluate((uuid) => {
		let map;
		window.__stores.meshPivot.meshPivots.subscribe((v) => (map = v))();
		return map[uuid] ?? null;
	}, uuid);
	h.check(
		!!survived && !!facePivot && dist(survived, facePivot) < 1e-6,
		`the GIZMO-PLACED pivot survives a page RELOAD, keyed by object uuid (${JSON.stringify(survived)} vs ${JSON.stringify(facePivot?.map((n) => +n.toFixed(4)))})`
	);

	// ======================================================================
	// 12. two peers: a rotate about the pivot lands on the peer
	// ======================================================================
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(0, 0, 0);
		box.updateMatrixWorld(true);
		window.__box = box;
		return box.uuid;
	});
	await A.page.waitForTimeout(3000);
	const onB = await B.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return !!g.getObjectByProperty('uuid', uuid);
	}, netUuid);
	h.check(onB, 'the box reached peer B (premise)');

	await A.page.evaluate((uuid) => window.__stores.meshEdit.enterEditMode(uuid), netUuid);
	rows = await probeHandles(A.page);
	TOP = topFour(rows);
	h.check(new Set(TOP).size === 4, `...resolving to four DISTINCT top corners (${JSON.stringify(TOP)})`);
	const netSize = await A.page.evaluate(
		({ uuid, TOP, PIVOT }) => {
			const s = window.__stores;
			const me = s.meshEdit;
			me.selectHandle(TOP[0]);
			TOP.slice(1).forEach((i) => me.toggleVertexSelection(i));
			s.meshPivot.setMeshPivotLocal(uuid, new s.THREE.Vector3(...PIVOT));
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			s.objectActions.setTransformMode('rotate');
			me.onProxyDragChanged(true);
			controls.object.quaternion.setFromAxisAngle(new s.THREE.Vector3(0, 1, 0), Math.PI / 2);
			me.onProxyMoved();
			me.onProxyDragChanged(false);
			s.objectActions.setTransformMode('translate');
			let size;
			me.vertexSelectionSize.subscribe((v) => (size = v))();
			return size;
		},
		{ uuid: netUuid, TOP, PIVOT }
	);
	h.check(netSize === 4, `selected the four top corners on the networked box (${netSize})`);
	await A.page.waitForTimeout(3000);

	/** representation-independent signature: the SORTED set of unique welded
	 * positions. A peer's copy may be indexed or a soup depending on how it
	 * arrived, so comparing raw attribute arrays would compare packaging. */
	const signature = (peer, uuid) =>
		peer.page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			const p = object?.geometry?.attributes?.position;
			if (!p) return null;
			const seen = new Set();
			for (let i = 0; i < p.count; i++)
				seen.add([p.getX(i), p.getY(i), p.getZ(i)].map((n) => Math.round(n * 1e3) / 1e3).join(','));
			return [...seen].sort();
		}, uuid);
	const sigA = await signature(A, netUuid);
	const sigB = await signature(B, netUuid);
	h.check(!!sigA && sigA.length === 8, `A's rotated box has 8 distinct corners (${sigA?.length})`);
	h.check(
		!!sigA && sigA.some((row) => row.startsWith('0,1,2')),
		`...including the rotated top corners (A: ${JSON.stringify(sigA)})`
	);
	h.check(
		JSON.stringify(sigA) === JSON.stringify(sigB),
		`B's copy matches A's rotated geometry exactly (B: ${JSON.stringify(sigB)})`
	);
	const bPivot = await B.page.evaluate((uuid) => {
		let map;
		window.__stores.meshPivot.meshPivots.subscribe((v) => (map = v))();
		return map[uuid] ?? null;
	}, netUuid);
	h.check(
		bPivot === null,
		`B never received the pivot itself — it is a LOCAL working preference (${JSON.stringify(bPivot)})`
	);

	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await h.finish(browser);
});
