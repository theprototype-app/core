// M9 (first half) VERTEX SLIDE: constrain a vertex drag to one of its own edges.
//
// Sliding along an edge is how you adjust a profile without changing the surface the
// vertex lies in — a free drag pulls it off both adjacent faces and dents the silhouette.
// The claims worth checking are geometric: the vertex ends up ON the edge it was dragged
// toward, it cannot pass either END of that edge, the edge is chosen from the drag
// DIRECTION, and a normal (unarmed) drag is completely unaffected.
const h = require('./helpers.cjs');

const editBox = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.meshEdit.enterEditMode(window.__box.uuid);
		return window.__box.uuid;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await editBox(A.page);

	// the +X+Y+Z corner of a 2-cube is (1,1,1); its three edges run to (-1,1,1),
	// (1,-1,1) and (1,1,-1) — the block below finds that handle through the public API
	// (select each and watch where the proxy lands) rather than guessing an index.
	const slide = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const positionsOf = () => {
			const p = window.__box.geometry.attributes.position;
			const out = [];
			for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
			return out;
		};
		const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
		// find the handle index sitting at (1,1,1) by selecting each and watching the proxy
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		let handle = -1;
		for (let i = 0; i < 8; i++) {
			me.selectHandle(i);
			const at = controls.object?.position;
			if (at && near([at.x, at.y, at.z], [1, 1, 1])) {
				handle = i;
				break;
			}
		}
		if (handle < 0) return { missing: true };
		// ARM the slide and drag mostly along -X (toward the (-1,1,1) edge), with a big
		// bogus Y component the constraint must throw away
		me.vertexSlide.set(true);
		me.selectHandle(handle);
		me.onProxyDragChanged(true);
		controls.object.position.x -= 0.6;
		controls.object.position.y -= 0.35;
		me.onProxyMoved();
		const edge = me.slideEdgeDebug();
		me.onProxyDragChanged(false);
		const after = positionsOf().filter((p) => near(p, [0.4, 1, 1]));
		const offEdge = positionsOf().filter((p) => Math.abs(p[1] - 1) > 1e-6 && p[1] > 0);
		return {
			handle,
			edge,
			landed: after.length,
			strayedInY: offEdge.length,
			corners: positionsOf().filter((p) => near(p, [1, 1, 1])).length
		};
	});
	h.check(!slide.missing, 'found the (1,1,1) corner handle (premise)');
	h.check(
		!!slide.edge && Math.abs(slide.edge.b[0] + 1) < 1e-6,
		`the slide chose the edge running toward -X, the way the drag went (${JSON.stringify(slide.edge?.b)})`
	);
	h.check(slide.landed > 0, 'the vertex landed exactly on that edge at the projected point (0.4, 1, 1)');
	h.check(
		slide.strayedInY === 0,
		`the Y component of the drag was DISCARDED — nothing left the y = 1 plane (${slide.strayedInY} strays)`
	);
	h.check(slide.corners === 0, 'the old corner position is gone (the vertex really moved)');

	// --- the clamp: a huge drag stops at the far END of the edge -------------
	const clamped = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		me.vertexSlide.set(true);
		// the vertex is at (0.4, 1, 1) now; drag 10 units along -X, far past (-1,1,1)
		me.onProxyDragChanged(true);
		controls.object.position.x -= 10;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		const p = window.__box.geometry.attributes.position;
		let minX = 1e9;
		let strayed = 0;
		for (let i = 0; i < p.count; i++) {
			minX = Math.min(minX, p.getX(i));
			if (p.getY(i) > 0 && Math.abs(p.getY(i) - 1) > 1e-6) strayed++;
		}
		return { minX, strayed };
	});
	h.check(
		Math.abs(clamped.minX + 1) < 1e-6,
		`the slide CLAMPED at the edge's far end instead of running away (min x ${clamped.minX})`
	);
	h.check(clamped.strayed === 0, 'and still nothing left the plane');

	// --- disarming restores a free drag -------------------------------------
	const disarmed = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		me.vertexSlide.set(false);
		me.onProxyDragChanged(true);
		controls.object.position.y += 0.7;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		const p = window.__box.geometry.attributes.position;
		let maxY = -1e9;
		for (let i = 0; i < p.count; i++) maxY = Math.max(maxY, p.getY(i));
		return { maxY, edge: me.slideEdgeDebug() };
	});
	h.check(disarmed.maxY > 1.6, `an unarmed drag moves freely again (max y ${disarmed.maxY.toFixed(2)})`);
	h.check(disarmed.edge === null, 'no slide edge is held between gestures');

	// --- the tool disarms itself when the session ends -----------------------
	const reset = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const me = s.meshEdit;
		me.vertexSlide.set(true);
		me.exitEditMode();
		let armed;
		me.vertexSlide.subscribe((v) => (armed = v))();
		me.enterEditMode(uuid);
		return armed;
	}, await A.page.evaluate(() => window.__box.uuid));
	h.check(reset === false, 'leaving the session disarms Slide (an armed tool must not outlive it)');

	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await h.finish(browser);
});
