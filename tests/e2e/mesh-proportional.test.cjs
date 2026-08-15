// M8 PROPORTIONAL EDITING: drag one vertex and its neighbourhood follows, weighted by
// distance. Without it a single-vertex drag creases the surface; with it you get a bulge.
//
// The checks are numeric, because the whole feature IS its falloff curve: a vertex at the
// radius must not move at all, one halfway must move by the smoothstep weight (0.5), and a
// long drag must not DRIFT — the write is absolute from the drag start, so the neighbour's
// final position depends only on the total delta, never on how many frames it took.
const h = require('./helpers.cjs');

/** a flat grid (PlaneGeometry lies in XY), so distances and weights are easy to reason about */
const editPlane = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__mesh = g.children[g.children.length - 1];
		window.__box = window.__mesh; // shared helper name
		s.meshEdit.enterEditMode(window.__mesh.uuid);
		return window.__mesh.uuid;
	});

/** select the handle nearest a local point; returns its index and position */
const selectNear = (page, point) =>
	page.evaluate((point) => {
		const s = window.__stores;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		let best = -1;
		let bestDistance = 1e9;
		let at = null;
		for (let i = 0; i < 81; i++) {
			me.selectHandle(i);
			const p = controls.object?.position;
			if (!p) break;
			const d = Math.hypot(p.x - point[0], p.y - point[1], p.z - point[2]);
			if (d < bestDistance) {
				bestDistance = d;
				best = i;
				at = [p.x, p.y, p.z];
			}
		}
		if (best >= 0) me.selectHandle(best);
		return { index: best, at, distance: bestDistance };
	}, point);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const uuid = await editPlane(A.page);
	const centre = await selectNear(A.page, [0, 0, 0]);
	h.check(centre.index >= 0 && centre.distance < 0.3, `selected a middle vertex of the grid (${JSON.stringify(centre.at)})`);

	// --- OFF: a single-vertex drag creases (only that vertex moves) ----------
	const off = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		me.proportionalEdit.set(false);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const before = [];
		const position = window.__mesh.geometry.attributes.position;
		for (let i = 0; i < position.count; i++) before.push(position.getZ(i));
		me.onProxyDragChanged(true);
		controls.object.position.z += 1;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		let moved = 0;
		for (let i = 0; i < position.count; i++) if (Math.abs(position.getZ(i) - before[i]) > 1e-6) moved++;
		return { moved, count: position.count };
	});
	h.check(off.moved > 0, 'the dragged vertex moved (premise)');
	h.check(
		off.moved <= 6,
		`with proportional OFF only that vertex's own entries move (${off.moved} of ${off.count}) — this is the crease`
	);

	// --- ON: the neighbourhood follows, with the right weights ---------------
	const on = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		// a fresh plane so the previous drag does not pollute the measurement
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__mesh = g.children[g.children.length - 1];
		me.exitEditMode();
		me.enterEditMode(window.__mesh.uuid);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		// select the vertex at the origin
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
		const position = window.__mesh.geometry.attributes.position;
		/** the Z of the first entry at a given (x, y) — the grid plane */
		const zAt = (x, y) => {
			for (let i = 0; i < position.count; i++)
				if (Math.abs(position.getX(i) - x) < 1e-4 && Math.abs(position.getY(i) - y) < 1e-4)
					return position.getZ(i);
			return null;
		};
		// a PlaneGeometry lies in XY, so the grid spans x/y and the drag goes along Z; the step is 4/8 = 0.5, so these are at 0, 0.5 and 1.0 from the anchor
		const step = 0.5;
		me.onProxyDragChanged(true);
		controls.object.position.z += 1;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		return {
			anchorZ: zAt(0, 0),
			halfZ: zAt(step, 0),
			rimZ: zAt(step * 2, 0),
			beyondZ: zAt(step * 3, 0)
		};
	});
	h.check(!on.missing, 'found the origin vertex on a fresh grid (premise)');
	h.check(Math.abs(on.anchorZ - 1) < 1e-6, `the dragged vertex moved the full amount (${on.anchorZ?.toFixed(4)})`);
	// smoothstep at t = 0.5 is 0.5, so the halfway ring moves by half
	h.check(
		Math.abs(on.halfZ - 0.5) < 1e-3,
		`the ring halfway to the radius moved by the smoothstep weight 0.5 (${on.halfZ?.toFixed(4)})`
	);
	h.check(
		Math.abs(on.rimZ) < 1e-6,
		`a vertex AT the radius did not move at all — the falloff reaches zero with zero slope (${on.rimZ?.toFixed(6)})`
	);
	h.check(Math.abs(on.beyondZ) < 1e-6, 'nothing beyond the radius moved');

	// --- no DRIFT: many small frames must equal one big one ------------------
	const drift = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const run = (steps) => {
			s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			window.__mesh = g.children[g.children.length - 1];
			me.exitEditMode();
			me.enterEditMode(window.__mesh.uuid);
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			for (let i = 0; i < 81; i++) {
				me.selectHandle(i);
				const p = controls.object?.position;
				if (!p) break;
				if (Math.hypot(p.x, p.y) < 1e-6) break;
			}
			me.proportionalEdit.set(true);
			me.proportionalRadius.set(1);
			me.onProxyDragChanged(true);
			for (let k = 0; k < steps; k++) {
				controls.object.position.z += 1 / steps;
				me.onProxyMoved();
			}
			me.onProxyDragChanged(false);
			const position = window.__mesh.geometry.attributes.position;
			for (let i = 0; i < position.count; i++)
				if (Math.abs(position.getX(i) - 0.5) < 1e-4 && Math.abs(position.getY(i)) < 1e-4)
					return position.getZ(i);
			return null;
		};
		return { once: run(1), many: run(20) };
	});
	h.check(
		drift.once !== null && Math.abs(drift.once - drift.many) < 1e-6,
		`20 small frames land exactly where one big one does (${drift.once?.toFixed(5)} vs ${drift.many?.toFixed(5)}) — the write is absolute, not accumulated`
	);

	// --- ONE undo for the whole bulge, and the tool disarms with the session --
	const rest = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const me = s.meshEdit;
		const position = () => window.__mesh.geometry.attributes.position;
		const spread = () => {
			let min = 1e9;
			let max = -1e9;
			const p = position();
			for (let i = 0; i < p.count; i++) {
				min = Math.min(min, p.getZ(i));
				max = Math.max(max, p.getZ(i));
			}
			return max - min;
		};
		const bulged = spread();
		s.history.undo();
		const undone = spread();
		s.history.redo();
		const redone = spread();
		me.proportionalEdit.set(true);
		me.exitEditMode();
		let armed;
		me.proportionalEdit.subscribe((v) => (armed = v))();
		me.enterEditMode(window.__mesh.uuid);
		return { bulged, undone, redone, armed };
	}, uuid);
	h.check(rest.bulged > 0.9, `the bulge is there to undo (${rest.bulged.toFixed(3)})`);
	h.check(rest.undone < 1e-6, `ONE undo flattens the whole bulge (${rest.undone.toFixed(6)})`);
	h.check(Math.abs(rest.redone - rest.bulged) < 1e-6, 'redo restores it exactly');
	h.check(rest.armed === false, 'leaving the session disarms Proportional (an armed tool must not outlive it)');

	// ==== 19-A P4: proportional FACE/EDGE grabs + the radius ring ==============
	// beginFaceGrab's neighbour capture widens when proportional is on: every
	// corner within the radius of the NEAREST grabbed corner follows with the
	// smoothstep weight (object-local units — the vertex path's semantics), and
	// applyFaceGrab blends absolutely from originals. Expected weights are
	// DERIVED from the same smoothstep here, not pinned: on the 0.5-step grid
	// with radius 0.8, the first ring sits at d = 0.5 -> w = smooth(0.625), the
	// diagonal at d = sqrt(0.5) -> w = smooth(0.8839), the second ring at
	// d = 1.0 >= radius -> 0.
	const smooth = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t));
	const RADIUS = 0.8;
	const wRing1 = smooth(0.5 / RADIUS);
	const wDiag = smooth(Math.sqrt(0.5) / RADIUS);

	/** grab the plane's CENTER QUAD (corners (0,0)..(0.5,0.5)), move it +1 in Z, commit */
	const faceGrabRun = (proportional) =>
		A.page.evaluate(
			({ proportional, RADIUS }) => {
				const s = window.__stores;
				const fe = s.faceEdit;
				const THREE = s.THREE;
				s.meshEdit.exitEditMode();
				fe.exitFaceEdit();
				s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				window.__mesh = g.children[g.children.length - 1];
				fe.enterFaceEdit(window.__mesh.uuid);
				s.meshEdit.proportionalEdit.set(proportional);
				s.meshEdit.proportionalRadius.set(RADIUS);
				const tris = fe.readTriangles(window.__mesh.geometry);
				const inQuad = [];
				tris.forEach((t, ti) => {
					if (t.every((v) => v.x > -1e-4 && v.x < 0.5 + 1e-4 && v.y > -1e-4 && v.y < 0.5 + 1e-4))
						inQuad.push(ti);
				});
				const target = {
					triIndices: inQuad,
					centroid: new THREE.Vector3(0.25, 0.25, 0),
					normal: new THREE.Vector3(0, 0, 1)
				};
				const began = fe.beginFaceGrab(target);
				let scene;
				s.globalScene.subscribe((v) => (scene = v))();
				const ring = scene.getObjectByName('proportional-ring');
				let underObjects = false;
				for (let p = ring; p; p = p.parent) if (p === g) underObjects = true;
				const ringMid = ring ? { visible: ring.visible, scale: ring.scale.x, underObjects } : null;
				fe.applyFaceGrab({ dPos: new THREE.Vector3(0, 0, 1) });
				fe.commitFaceGrab();
				const ringAfter = scene.getObjectByName('proportional-ring')?.visible ?? false;
				const position = window.__mesh.geometry.attributes.position;
				const zAt = (x, y) => {
					for (let i = 0; i < position.count; i++)
						if (Math.abs(position.getX(i) - x) < 1e-4 && Math.abs(position.getY(i) - y) < 1e-4)
							return position.getZ(i);
					return null;
				};
				const out = {
					began,
					quadTris: inQuad.length,
					ringMid,
					ringAfter,
					grabZ: zAt(0, 0),
					ring1Z: zAt(-0.5, 0),
					diagZ: zAt(-0.5, -0.5),
					ring2Z: zAt(-1, 0)
				};
				fe.exitFaceEdit();
				return out;
			},
			{ proportional, RADIUS }
		);

	// --- (e) OFF first: today's rigid weld behaviour, byte-identical ----------
	const faceOff = await faceGrabRun(false);
	h.check(faceOff.began && faceOff.quadTris === 2, `grabbed the center quad (${faceOff.quadTris} tris, premise)`);
	// the ring mesh may exist from the earlier vertex drags — OFF must not SHOW it
	h.check(!faceOff.ringMid || !faceOff.ringMid.visible, 'proportional OFF: no radius ring shows during the grab');
	h.check(
		Math.abs(faceOff.grabZ - 1) < 1e-6,
		`OFF: a welded neighbour corner moves the FULL delta (${faceOff.grabZ?.toFixed(4)}) — the rigid weld`
	);
	h.check(
		Math.abs(faceOff.ring1Z) < 1e-6 && Math.abs(faceOff.ring2Z) < 1e-6,
		'OFF: nothing beyond the welded corners moved'
	);

	// --- (b) FACE falloff ------------------------------------------------------
	const faceOn = await faceGrabRun(true);
	h.check(faceOn.began && faceOn.quadTris === 2, 'grabbed the center quad with proportional ON (premise)');
	h.check(
		!!faceOn.ringMid && faceOn.ringMid.visible,
		'the radius ring shows during a proportional face grab'
	);
	h.check(
		!!faceOn.ringMid && Math.abs(faceOn.ringMid.scale - RADIUS) < 1e-6,
		`...scaled by radius x world scale (${faceOn.ringMid?.scale} vs ${RADIUS})`
	);
	h.check(!!faceOn.ringMid && !faceOn.ringMid.underObjects, '...and it lives at the scene root, NOT under objectsGroup');
	h.check(faceOn.ringAfter === false, 'commit hides the ring');
	h.check(Math.abs(faceOn.grabZ - 1) < 1e-6, `the grabbed quad moved the full delta (${faceOn.grabZ?.toFixed(4)})`);
	h.check(
		faceOn.ring1Z > 1e-4 && faceOn.ring1Z < 1 - 1e-4,
		`ring-1 moved a fraction STRICTLY between 0 and the delta (${faceOn.ring1Z?.toFixed(4)})`
	);
	h.check(
		Math.abs(faceOn.ring1Z - wRing1) < 1e-3,
		`ring-1 weight matches the smoothstep (${faceOn.ring1Z?.toFixed(4)} vs ${wRing1.toFixed(4)})`
	);
	h.check(
		Math.abs(faceOn.diagZ - wDiag) < 1e-3,
		`the diagonal neighbour matches its own (nearest-corner) weight (${faceOn.diagZ?.toFixed(4)} vs ${wDiag.toFixed(4)})`
	);
	h.check(Math.abs(faceOn.ring2Z) < 1e-6, 'ring-2 (outside the radius) did not move');

	// --- (c) EDGE falloff via edgeGrabTarget -----------------------------------
	const edge = await A.page.evaluate(
		({ RADIUS }) => {
			const s = window.__stores;
			const fe = s.faceEdit;
			const THREE = s.THREE;
			s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			window.__mesh = g.children[g.children.length - 1];
			fe.enterFaceEdit(window.__mesh.uuid);
			fe.setFaceSubmode('edges');
			s.meshEdit.proportionalEdit.set(true);
			s.meshEdit.proportionalRadius.set(RADIUS);
			// pick the real (non-diagonal) edge (0,0)-(0.5,0)
			const tris = fe.readTriangles(window.__mesh.geometry);
			const isAt = (v, x, y) => Math.abs(v.x - x) < 1e-4 && Math.abs(v.y - y) < 1e-4;
			let picked = null;
			for (let ti = 0; ti < tris.length && !picked; ti++) {
				const t = tris[ti];
				if (!t.some((v) => isAt(v, 0, 0)) || !t.some((v) => isAt(v, 0.5, 0))) continue;
				const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
				const mid = new THREE.Vector3(0.25, 0, 0);
				const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
				if (!key) continue;
				fe.pickEdge(key, false);
				if (fe.edgeSelectionSize() === 1) picked = key;
			}
			if (!picked) return { missing: true };
			const target = fe.edgeGrabTarget();
			const began = fe.beginFaceGrab(target);
			let scene;
			s.globalScene.subscribe((v) => (scene = v))();
			const ringMid = scene.getObjectByName('proportional-ring')?.visible ?? false;
			fe.applyFaceGrab({ dPos: new THREE.Vector3(0, 0, 1) });
			fe.commitFaceGrab();
			const ringAfter = scene.getObjectByName('proportional-ring')?.visible ?? false;
			const position = window.__mesh.geometry.attributes.position;
			const zAt = (x, y) => {
				for (let i = 0; i < position.count; i++)
					if (Math.abs(position.getX(i) - x) < 1e-4 && Math.abs(position.getY(i) - y) < 1e-4)
						return position.getZ(i);
				return null;
			};
			const out = {
				began,
				keys: target.vertexKeys.size,
				ringMid,
				ringAfter,
				endA: zAt(0, 0),
				endB: zAt(0.5, 0),
				ring1Z: zAt(1, 0),
				sideZ: zAt(0, 0.5),
				ring2Z: zAt(1.5, 0)
			};
			fe.exitFaceEdit();
			return out;
		},
		{ RADIUS }
	);
	h.check(!edge.missing && edge.began && edge.keys === 2, 'picked + grabbed one real edge (premise)');
	h.check(edge.ringMid && edge.ringAfter === false, 'the ring shows during the proportional edge grab and hides on commit');
	h.check(
		Math.abs(edge.endA - 1) < 1e-6 && Math.abs(edge.endB - 1) < 1e-6,
		`both edge endpoints moved the full delta (${edge.endA?.toFixed(4)}, ${edge.endB?.toFixed(4)})`
	);
	h.check(
		edge.ring1Z > 1e-4 && edge.ring1Z < 1 - 1e-4 && Math.abs(edge.ring1Z - wRing1) < 1e-3,
		`the next vertex along follows at the smoothstep weight (${edge.ring1Z?.toFixed(4)} vs ${wRing1.toFixed(4)})`
	);
	h.check(
		Math.abs(edge.sideZ - wRing1) < 1e-3,
		`...and so does the vertex beside the edge (${edge.sideZ?.toFixed(4)})`
	);
	h.check(Math.abs(edge.ring2Z) < 1e-6, 'outside the radius nothing moved (edge grab)');

	// --- (d) the ring on the VERTEX drag path + the radius-scrub preview -------
	const vertexRing = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__mesh = g.children[g.children.length - 1];
		me.exitEditMode();
		me.enterEditMode(window.__mesh.uuid);
		me.selectHandle(0);
		me.proportionalEdit.set(true);
		me.proportionalRadius.set(1);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		me.onProxyDragChanged(true);
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const mid = scene.getObjectByName('proportional-ring')?.visible ?? false;
		controls.object.position.z += 0.5;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		const after = scene.getObjectByName('proportional-ring')?.visible ?? false;
		me.exitEditMode();
		return { mid, after };
	});
	h.check(vertexRing.mid, 'the ring shows during a proportional VERTEX drag');
	h.check(vertexRing.after === false, 'and hides at drag end');

	const scrub = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const pr = s.proportionalRing;
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__mesh = g.children[g.children.length - 1];
		me.enterEditMode(window.__mesh.uuid);
		me.selectHandle(0);
		me.proportionalRadius.set(1.2);
		// what the radius DragRow's onscrubstart/onscrubend call
		pr.showRadiusPreview('vertices');
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const ring = scene.getObjectByName('proportional-ring');
		const shown = ring ? { visible: ring.visible, scale: ring.scale.x } : null;
		me.proportionalRadius.set(2.4); // the live update mid-scrub (onchange writes the store)
		const rescaled = ring ? ring.scale.x : 0;
		pr.hideProportionalRing();
		const hidden = ring ? !ring.visible : false;
		me.exitEditMode();
		pr.showRadiusPreview('vertices'); // no selection anywhere -> must stay hidden
		const noAnchor = ring ? !ring.visible : false;
		return { shown, rescaled, hidden, noAnchor };
	});
	h.check(!!scrub.shown && scrub.shown.visible, 'scrubbing the radius row shows the ring at the vertex anchor');
	h.check(
		!!scrub.shown && Math.abs(scrub.shown.scale - 1.2) < 1e-6,
		`...scaled by the radius (${scrub.shown?.scale})`
	);
	h.check(
		Math.abs(scrub.rescaled - 2.4) < 1e-6,
		`...and it re-scales LIVE as the store changes mid-scrub (${scrub.rescaled})`
	);
	h.check(scrub.hidden, 'scrub end hides the ring');
	h.check(scrub.noAnchor, 'no selection -> the preview stays hidden instead of showing a stale ring');

	// --- and a peer sees the whole neighbourhood, not just the anchor --------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__mesh = g.children[g.children.length - 1];
		s.meshEdit.exitEditMode();
		s.meshEdit.enterEditMode(window.__mesh.uuid);
		return window.__mesh.uuid;
	});
	const spreadOn = (page, uuid) =>
		page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			const p = object?.geometry?.attributes?.position;
			if (!p) return null;
			let min = 1e9;
			let max = -1e9;
			for (let i = 0; i < p.count; i++) {
				min = Math.min(min, p.getZ(i));
				max = Math.max(max, p.getZ(i));
			}
			return max - min;
		}, uuid);
	await h.eventually(
		() => spreadOn(B.page, netUuid),
		(v) => v !== null && v < 1e-6,
		'B received the flat grid (premise)',
		20000
	);
	await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		for (let i = 0; i < 81; i++) {
			me.selectHandle(i);
			const p = controls.object?.position;
			if (!p) break;
			if (Math.hypot(p.x, p.y) < 1e-6) break;
		}
		me.proportionalEdit.set(true);
		me.proportionalRadius.set(1);
		me.onProxyDragChanged(true);
		controls.object.position.z += 1;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
	});
	await h.eventually(
		() => spreadOn(B.page, netUuid),
		(v) => v !== null && v > 0.9,
		'B receives the whole bulge, not just the dragged vertex',
		20000
	);

	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await h.finish(browser);
});
