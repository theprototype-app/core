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
