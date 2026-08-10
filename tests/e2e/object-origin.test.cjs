// Roadmap #17 batch D follow-up 4 — per-object transform ORIGIN.
//
// A single object's origin is its local (0,0,0): the point its position refers to
// and the point rotate/scale happen around. It is stored as a LOCAL offset on
// `userData.origin`, which makes it scene data — replicated, saved, undoable, and
// remembered per object when the selection changes.
//
// Not baked into vertices on purpose: that route goes through meshgeo, which
// stamps faceEdited and would LOCK a primitive's width/height sliders forever.
// The trade is that a GLTF export has to bake it (bakeOriginForExport), since
// glTF nodes carry only TRS.
const h = require('./helpers.cjs');

/** read what the app knows about an object's origin */
const originOf = (page, key) =>
	page.evaluate((key) => {
		const w = window.__stores;
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo[key]);
		return {
			local: object?.userData?.origin ?? null,
			world: w.objectOrigin.originWorld(object).toArray().map((n) => +n.toFixed(4)),
			pos: object.position.toArray().map((n) => +n.toFixed(4))
		};
	}, key);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.objectOrigin, { timeout: 20000 });

	// a 2x1x1 box at a known place, plus a second object to switch to
	await A.page.evaluate(async () => {
		const w = window.__stores;
		localStorage.setItem('inspector:sec:Transform', 'open');
		w.commandsHandler.sceneCommand('/create Box 2 1 1');
		await new Promise((r) => setTimeout(r, 300));
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		await new Promise((r) => setTimeout(r, 300));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const [box, sphere] = group.children.slice(-2);
		box.position.set(0, 0, 0);
		sphere.position.set(4, 0, 0);
		window.__oo = { group, box: box.uuid, sphere: sphere.uuid };
		w.objectActions.selectObject(box.uuid, true);
	});
	await A.page.waitForTimeout(800);

	// ---------- the panel offers it, and it starts at the default ----------
	const ui = await A.page.evaluate(() => ({
		block: !!document.querySelector('#object-origin'),
		rows: document.querySelectorAll('#inspector-origin .dn-input').length,
		presets: ['#origin-bottom', '#origin-center', '#origin-median', '#origin-world'].filter(
			(id) => !!document.querySelector(id)
		).length,
		mode: !!document.querySelector('#origin-mode-single')
	}));
	h.check(ui.block, 'the Transform section offers an Origin block for a single object');
	h.check(ui.rows === 3, `with X/Y/Z rows (${ui.rows})`);
	h.check(ui.presets === 4, `and the presets (${ui.presets}/4)`);
	h.check(ui.mode, 'plus a Move origin toggle');
	const start = await originOf(A.page, 'box');
	h.check(start.local === null, `no offset by default (${JSON.stringify(start.local)})`);

	// ---------- Bottom: the pivot lands on the footprint ----------
	await A.page.locator('#origin-bottom').click();
	await A.page.waitForTimeout(400);
	const bottom = await originOf(A.page, 'box');
	h.check(
		Math.abs(bottom.local?.[1] + 0.5) < 0.001,
		`Bottom puts the origin on the base (local y ${bottom.local?.[1]})`
	);
	h.check(
		Math.abs(bottom.world[1] + 0.5) < 0.001 && Math.abs(bottom.world[0]) < 0.001,
		`and the world readout agrees (${bottom.world.join(', ')})`
	);
	// PREMISE: the mesh itself must NOT have moved — this is a pivot, not a nudge
	h.check(
		bottom.pos.every((n) => Math.abs(n) < 0.001),
		`the object stayed exactly where it was (${bottom.pos.join(', ')})`
	);

	// ---------- rotate/scale now happen ABOUT the origin ----------
	// with the pivot on the bottom face, a 90-degree turn about Z must swing the
	// box up around that edge instead of spinning in place
	const swung = await A.page.evaluate(async () => {
		const w = window.__stores;
		const before = window.__oo.group.getObjectByProperty('uuid', window.__oo.box).position.toArray();
		const moved = w.multiTransform.applyPivotTransform((pivot) => {
			pivot.rotation.z = Math.PI / 2;
		});
		await new Promise((r) => setTimeout(r, 250));
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		return { moved, before, after: object.position.toArray().map((n) => +n.toFixed(4)) };
	});
	h.check(swung.moved === true, 'a single object with an origin gets the pivot gizmo path');
	// pivot at (0,-0.5,0); the centre sits 0.5 above it, so a +90d turn about Z
	// sends the centre to (-0.5, -0.5, 0)
	h.check(
		Math.abs(swung.after[0] + 0.5) < 0.05 && Math.abs(swung.after[1] + 0.5) < 0.05,
		`the object swings around the origin, not its centre (${swung.after.join(', ')})`
	);

	// ---------- each object keeps its OWN origin across a selection switch ----------
	await A.page.evaluate(() => {
		const w = window.__stores;
		w.objectActions.selectObject(window.__oo.sphere, false);
	});
	await A.page.waitForTimeout(600);
	const sphereOrigin = await originOf(A.page, 'sphere');
	h.check(sphereOrigin.local === null, 'the other object still has its default origin');
	await A.page.locator('#origin-world').click();
	await A.page.waitForTimeout(400);
	const sphereWorld = await originOf(A.page, 'sphere');
	h.check(
		Math.abs(sphereWorld.world[0]) < 0.001,
		`World 0 puts the sphere's origin at the scene origin (${sphereWorld.world.join(', ')})`
	);
	// back to the box: its bottom origin must still be there
	await A.page.evaluate(() => window.__stores.objectActions.selectObject(window.__oo.box, false));
	await A.page.waitForTimeout(600);
	const boxAgain = await originOf(A.page, 'box');
	h.check(
		Math.abs(boxAgain.local?.[1] + 0.5) < 0.001,
		`switching objects brings each one's own origin back (box local y ${boxAgain.local?.[1]})`
	);
	const sphereKept = await originOf(A.page, 'sphere');
	h.check(sphereKept.local !== null, 'and the sphere kept its own, independently');

	// ---------- replicated + undoable, like any other userData write ----------
	const wire = await A.page.evaluate(async () => {
		const w = window.__stores;
		const peer = await new Promise((r) => w.peers.subscribe(r)());
		window.__sent = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			if (m?.parameter === 'origin') window.__sent.push(m.origin);
			return orig(m);
		};
		w.objectOrigin.originPreset(window.__oo.box, 'center');
		await new Promise((r) => setTimeout(r, 200));
		const afterPreset = window.__oo.group.getObjectByProperty('uuid', window.__oo.box).userData.origin;
		w.history.undo();
		await new Promise((r) => setTimeout(r, 300));
		const afterUndo = window.__oo.group.getObjectByProperty('uuid', window.__oo.box).userData.origin;
		return { sent: window.__sent.length, afterPreset, afterUndo };
	});
	h.check(wire.sent >= 1, `an origin change replicates (${wire.sent} message(s))`);
	h.check(
		Math.abs(wire.afterUndo?.[1] + 0.5) < 0.001,
		`and undo restores the previous origin (${JSON.stringify(wire.afterUndo)})`
	);

	// ---------- the Spin flow node turns about the origin (the hinge case) ----------
	// asserts the runtime's OWN exported math (the computeMoveOffset pattern), so a
	// regression in flowRuntime shows up here rather than in a hand-rolled formula
	const hinged = await A.page.evaluate(async () => {
		const w = window.__stores;
		// origin on the box's -x face: spinning about Y swings it like a door
		w.objectOrigin.setOriginFor(window.__oo.box, [-1, 0, 0]);
		await new Promise((r) => setTimeout(r, 200));
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		object.position.set(0, 0, 0);
		object.rotation.set(0, 0, 0);
		const base = { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
		const pivot = w.flowRuntime.originPivotOf(object, base).toArray().map((n) => +n.toFixed(3));
		const quarter = w.flowRuntime
			.spinPositionAbout(base.pos, w.flowRuntime.originPivotOf(object, base), 'y', Math.PI / 2)
			.map((n) => +n.toFixed(3));
		// and with NO origin the body must not travel at all
		w.objectOrigin.resetOrigin(window.__oo.sphere);
		const plain = window.__oo.group.getObjectByProperty('uuid', window.__oo.sphere);
		const plainSpin = w.flowRuntime
			.spinPositionAbout([4, 0, 0], w.flowRuntime.originPivotOf(plain, { pos: [4, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }), 'y', Math.PI / 2)
			.map((n) => +n.toFixed(3));
		return { pivot, quarter, plainSpin };
	});
	h.check(
		Math.abs(hinged.pivot[0] + 1) < 0.01,
		`the runtime places the spin pivot on the origin (${hinged.pivot.join(', ')})`
	);
	h.check(
		Math.abs(hinged.quarter[0] + 1) < 0.01 && Math.abs(hinged.quarter[2] + 1) < 0.01,
		`a 90d spin swings the body a quarter circle around it (${hinged.quarter.join(', ')})`
	);
	h.check(
		Math.abs(hinged.plainSpin[0] - 4) < 0.01 && Math.abs(hinged.plainSpin[2]) < 0.01,
		`an object with NO origin still spins in place, unchanged (${hinged.plainSpin.join(', ')})`
	);
	// and the joint anchor follows the origin (the "hinge it" half)
	const anchored = await A.page.evaluate(async () => {
		const w = window.__stores;
		const joint = w.joints.createJoint('revolute', window.__oo.sphere, window.__oo.box, 'y');
		return joint ? { anchorB: joint.anchorB.map((n) => +n.toFixed(3)) } : null;
	});
	h.check(
		!!anchored && Math.abs(anchored.anchorB[0] + 1) < 0.01,
		`a hinge anchors on the origin, not the centre (anchorB ${anchored?.anchorB?.join(', ')})`
	);

	// ---------- Reset goes back to the default ----------
	await A.page.evaluate(() => window.__stores.objectOrigin.resetOrigin(window.__oo.box));
	await A.page.waitForTimeout(300);
	const reset = await originOf(A.page, 'box');
	h.check(reset.local === null, `Reset clears the origin (${JSON.stringify(reset.local)})`);

	await h.finish(browser);
});
