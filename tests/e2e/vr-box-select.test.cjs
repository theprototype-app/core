// Phase 214: VR radial 'Tools' submenu (Select / Box Select / Draw) + the 3D
// drag-box marquee. Picking a tool sets the trigger mode; selectObjectsInBox
// selects every top-level object whose world origin lands inside the box. The
// drag gesture + scene-root visual need an XR session, so the marquee feel is
// the user's manual check.
const h = require('./helpers.cjs');

const read = (A, path) =>
	A.page.evaluate((p) => {
		let v;
		p.split('.').reduce((o, k) => o[k], window.__stores).subscribe((x) => (v = x))();
		return v;
	}, path);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// the base ring's Draw sector became a Tools submenu
	const ring = await A.page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		return { root: m.ringEntries('root').map((e) => e.id), tools: m.ringEntries('tools').map((e) => e.id) };
	});
	h.check(ring.root.includes('nav:tools') && !ring.root.includes('draw'), 'the Draw sector became a Tools submenu');
	// U-1 later appended Ping to this ring — assert the tool prefix, not an exact list
	h.check(ring.tools.slice(0, 3).join(',') === 'tool:select,tool:box,tool:draw', `Tools lists Select / Box Select / Draw (${ring.tools.join(',')})`);

	// picking a tool sets the mode, closes the ring, and Draw drives draw mode
	const modes = await A.page.evaluate(() => {
		const s = window.__stores;
		const rdr = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const out = {};
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('tool:box');
		out.box = rdr(s.vrToolMode);
		out.ringClosed = rdr(s.vrMenuOpen) === false;
		s.vrControls.executeVRMenuAction('tool:draw');
		out.draw = rdr(s.vrToolMode);
		out.drawOn = rdr(s.drawMode.drawMode);
		s.vrControls.executeVRMenuAction('tool:select');
		out.select = rdr(s.vrToolMode);
		out.drawOff = rdr(s.drawMode.drawMode) === false;
		return out;
	});
	h.check(modes.box === 'box' && modes.ringClosed, 'Box Select sets tool=box and closes the ring');
	h.check(modes.draw === 'draw' && modes.drawOn, 'Draw sets tool=draw and turns on draw mode');
	h.check(modes.select === 'select' && modes.drawOff, 'Select sets tool=select and turns off draw mode');

	// box-select math: origin-inside-AABB selects, and it replicates via the set
	const box = await A.page.evaluate(() => {
		const s = window.__stores;
		const root = () => {
			let v;
			s.objectsGroup.subscribe((x) => (v = x))();
			return v;
		};
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		const r = root();
		const a = r.children[r.children.length - 3];
		const b = r.children[r.children.length - 2];
		const c = r.children[r.children.length - 1];
		a.position.set(0, 0, 0);
		b.position.set(1, 0, 0);
		c.position.set(10, 0, 0); // far outside
		// a box spanning x in [-0.5, 2] catches a + b, not c
		const uuids = s.vrControls.selectObjectsInBox([-0.5, -1, -1], [2, 1, 1]);
		let sel;
		s.selectedObjects.subscribe((x) => (sel = x))();
		return { uuids: uuids.slice().sort(), a: a.uuid, b: b.uuid, c: c.uuid, sel: sel.slice().sort() };
	});
	const expected = [box.a, box.b].sort();
	h.check(
		box.uuids.length === 2 && box.uuids.includes(box.a) && box.uuids.includes(box.b) && !box.uuids.includes(box.c),
		`box selects the two objects whose origin is inside, not the far one (${box.uuids.length})`
	);
	h.check(box.sel.join(',') === expected.join(','), 'the marquee result becomes the (replicated) multi-selection');

	// the gesture start is gated: no XR session / not in box mode -> no-op
	const gated = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrToolMode.set('select');
		const started = s.vrControls.boxSelectStart(0); // not box mode + not presenting
		return { started, active: s.vrControls.boxSelectActive() };
	});
	h.check(gated.started === false && gated.active === false, 'box-select start is a no-op outside box mode / a session');

	await h.finish(browser);
});
