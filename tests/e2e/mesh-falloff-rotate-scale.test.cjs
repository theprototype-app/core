// F1 (v1.13): PROPORTIONAL falloff for ROTATE and SCALE — the weighted transform blend.
//
// Before this, `applyPivotTransform` turned/scaled the SELECTED set only and left the
// falloff neighbourhood exactly where it was (documented, deliberate). Now each vertex
// in the radius gets the gesture's rotation SLERPED and its scale LERPED toward identity
// by its smoothstep weight. For a pure rotation that is the conventional weighted ANGLE:
// a vertex halfway out turns half way, so a straight row of vertices through the falloff
// becomes a spiral — which is the reading every check below measures as a swept ANGLE
// about the pivot, never as a distance (every invariant a rotation preserves is also
// preserved by a WRONG rotation). Counterfactual (proven at commit time): with the weight
// forced to 1 every vertex in range turns the full 90°, the row stays a straight line and
// the collinearity check goes red.
//
// FIXTURE TRAP THIS SUITE PAID FOR, twice over. (1) An attribute INDEX recorded before a
// meshgeo commit addresses a DIFFERENT vertex after it: F3 made a proportional gesture end
// in a whole-geometry commit, and `applyMeshGeo` rebuilds the mesh index-EXPANDED (a
// 13x13 plane's 169 entries become 864 in triangle order). Every tracked vertex is
// therefore recorded TWICE — its indexed entry and its expanded one — and read back
// through whichever matches the live count. (2) A `/create Plane 4 4` spans -2..2, so
// "beyond the radius" named a vertex that does not exist and the script crashed on
// `undefined.every`; the grid is 6 wide here, with the same 0.5 step.
const h = require('./helpers.cjs');

const smooth = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t));
const RADIUS = 2; // grid step is 0.5, so +x holds vertices at t = .25 / .5 / .75 / 1
/** the +x row this suite measures: weighted, at the rim, and outside it */
const XS = [0, 0.5, 1, 1.5, 2, 2.5];

/** fresh plane, edit mode, origin vertex selected, proportional armed at RADIUS */
const arm = (page) =>
	page.evaluate(
		({ RADIUS, XS }) => {
			const s = window.__stores;
			const me = s.meshEdit;
			me.exitEditMode();
			s.commandsHandler.sceneCommand('/create Plane 6 6 12 12');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			window.__mesh = g.children[g.children.length - 1];
			me.enterEditMode(window.__mesh.uuid);
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			let anchor = -1;
			for (let i = 0; i < 400; i++) {
				me.selectHandle(i);
				const p = controls.object?.position;
				if (!p) break;
				if (Math.hypot(p.x, p.y) < 1e-6) {
					anchor = i;
					break;
				}
			}
			if (anchor < 0) return null;
			me.selectHandle(anchor);
			me.proportionalEdit.set(true);
			me.proportionalRadius.set(RADIUS);
			// Remember each +x grid vertex TWICE: its attribute index in the geometry as
			// it stands now, and its index in the EXPANDED (index-walked) layout a
			// meshgeo commit will swap in. `trisToPositions(readTriangles(...))` walks
			// `geometry.index` in order, so expanded slot j holds original vertex
			// index.array[j] — hence the plain indexOf.
			const geometry = window.__mesh.geometry;
			const position = geometry.attributes.position;
			const indexArray = geometry.index ? geometry.index.array : null;
			const track = {};
			const trackExp = {};
			for (const x of XS)
				for (let i = 0; i < position.count; i++)
					if (Math.abs(position.getX(i) - x) < 1e-4 && Math.abs(position.getY(i)) < 1e-4) {
						track[x] = i;
						trackExp[x] = indexArray ? Array.prototype.indexOf.call(indexArray, i) : i;
						break;
					}
			window.__track = track;
			window.__trackExp = trackExp;
			window.__origCount = position.count;
			window.__beforeExpanded = s.faceEdit.trisToPositions(s.faceEdit.readTriangles(geometry));
			return { track, trackExp, count: position.count };
		},
		{ RADIUS, XS }
	);

/** one exact gizmo gesture through the real drag lifecycle (mesh-pivot-gizmo's recipe) */
const gesture = (page, spec) =>
	page.evaluate((spec) => {
		const s = window.__stores;
		const THREE = s.THREE;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		s.objectActions.setTransformMode(spec.mode);
		me.onProxyDragChanged(true);
		if (!controls.object) return false;
		if (spec.mode === 'rotate')
			controls.object.quaternion.setFromAxisAngle(new THREE.Vector3(...spec.axis), (spec.degrees * Math.PI) / 180);
		else controls.object.scale.set(...spec.scale);
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		s.objectActions.setTransformMode('translate');
		return true;
	}, spec);

/** the tracked +x vertices' current positions, keyed by their ORIGINAL x — read through
 * the indexed map while the geometry is still the one `arm` saw, and through the
 * expanded map once a commit has swapped it (see the fixture note at the top) */
const readTracked = (page) =>
	page.evaluate(() => {
		const position = window.__mesh.geometry.attributes.position;
		const map = position.count === window.__origCount ? window.__track : window.__trackExp;
		const out = { __expanded: map === window.__trackExp };
		for (const [x, i] of Object.entries(map)) out[x] = [position.getX(i), position.getY(i), position.getZ(i)];
		return out;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ==== ROTATE 90° about Z, pivot = the anchor at the origin ==================
	const armed = await arm(A.page);
	h.check(
		armed && Object.keys(armed.track).length === XS.length && Object.values(armed.trackExp).every((i) => i >= 0),
		`tracked the six +x grid vertices in both layouts (premise: ${JSON.stringify(armed?.track)} / ${JSON.stringify(armed?.trackExp)})`
	);
	const ran = await gesture(A.page, { mode: 'rotate', axis: [0, 0, 1], degrees: 90 });
	h.check(ran, 'the rotate gesture found a seated gizmo to drive (premise)');
	const rot = await readTracked(A.page);
	h.check(rot.__expanded, 'the proportional gesture committed a whole-geometry snapshot (premise: F3)');
	const deg = (p) => (Math.atan2(p[1], p[0]) * 180) / Math.PI;
	h.check(Math.hypot(...rot['0']) < 1e-6, `the anchor (on the axis) stays put (${JSON.stringify(rot['0'].map((n) => +n.toFixed(4)))})`);
	for (const x of [0.5, 1, 1.5]) {
		const expect = smooth(x / RADIUS) * 90;
		const got = deg(rot[String(x)]);
		h.check(
			Math.abs(got - expect) < 0.05,
			`the vertex at x=${x} swept ${expect.toFixed(2)}° about the pivot — the smoothstep weight times 90° (${got.toFixed(2)}°)`
		);
		h.check(
			Math.abs(Math.hypot(rot[String(x)][0], rot[String(x)][1]) - x) < 1e-6,
			`...and kept its distance from the pivot (${x})`
		);
	}
	h.check(
		Math.abs(deg(rot['2'])) < 1e-6 && Math.abs(rot['2'][0] - 2) < 1e-6,
		`the vertex AT the radius did not turn at all (${deg(rot['2']).toFixed(4)}°)`
	);
	const beyondBefore = await A.page.evaluate(() => {
		const i = window.__trackExp['2.5'];
		return [window.__beforeExpanded[i * 3], window.__beforeExpanded[i * 3 + 1], window.__beforeExpanded[i * 3 + 2]];
	});
	h.check(
		rot['2.5'].every((n, k) => n === beyondBefore[k]),
		`a vertex beyond the radius is byte-identical to before (${JSON.stringify(rot['2.5'])})`
	);
	// THE COUNTERFACTUAL'S READING: the three weighted vertices are NOT collinear with
	// the pivot (76° / 45° / 14° is a spiral); with w forced to 1 they all sit on the
	// rotated +y axis and this reads zero
	const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
	const twist = Math.abs(cross(rot['0.5'], rot['1'])) + Math.abs(cross(rot['1'], rot['1.5']));
	h.check(twist > 0.2, `the row through the falloff curves into a spiral (twist ${twist.toFixed(3)}) — a straight edge no longer stays straight`);

	// ONE undo restores the whole neighbourhood exactly (the meshgeo snapshot covers it)
	const undo = await A.page.evaluate(() => {
		window.__stores.history.undo();
		const now = window.__mesh.geometry.attributes.position.array;
		let gap = 0;
		for (let i = 0; i < Math.min(now.length, window.__beforeExpanded.length); i++)
			gap = Math.max(gap, Math.abs(now[i] - window.__beforeExpanded[i]));
		return { gap, same: now.length === window.__beforeExpanded.length };
	});
	h.check(undo.same && undo.gap < 1e-6, `ONE undo restores the pre-rotate geometry exactly (max gap ${undo.gap.toExponential(1)})`);

	// ==== SCALE x2 about the anchor: the factor lerps toward 1 by the weight ======
	const armed2 = await arm(A.page);
	h.check(!!armed2, 'armed a fresh plane for the scale gesture (premise)');
	const ran2 = await gesture(A.page, { mode: 'scale', scale: [2, 2, 2] });
	h.check(ran2, 'the scale gesture found a seated gizmo (premise)');
	const sc = await readTracked(A.page);
	for (const x of [0.5, 1, 1.5]) {
		const factor = 1 + (2 - 1) * smooth(x / RADIUS);
		h.check(
			Math.abs(sc[String(x)][0] - x * factor) < 1e-5 && Math.abs(sc[String(x)][1]) < 1e-9,
			`the vertex at x=${x} scaled by lerp(1, 2, w) = ${factor.toFixed(4)} along +x (${sc[String(x)][0].toFixed(4)})`
		);
	}
	h.check(Math.abs(sc['2'][0] - 2) < 1e-6, `the rim vertex did not scale (${sc['2'][0].toFixed(6)})`);
	h.check(Math.hypot(...sc['0']) < 1e-6, 'the anchor at the pivot stays put under scale');

	// ==== OFF: with proportional disarmed a rotate turns the selection only ======
	await A.page.evaluate(() => window.__stores.meshEdit.proportionalEdit.set(false));
	await gesture(A.page, { mode: 'rotate', axis: [0, 0, 1], degrees: 90 });
	const offRead = await readTracked(A.page);
	h.check(
		Math.abs(offRead['1'][0] - sc['1'][0]) < 1e-9 && Math.abs(offRead['1'][1] - sc['1'][1]) < 1e-9,
		`with proportional OFF a neighbour does not turn — the pre-F1 behaviour survives (${JSON.stringify(offRead['1'].map((n) => +n.toFixed(4)))})`
	);

	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await h.finish(browser);
});
