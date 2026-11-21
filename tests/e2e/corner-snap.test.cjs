// 102b-arrange row 3 — CORNER SNAP: hold B while moving an object with the gizmo, and its nearest
// corner lands exactly on a corner (or an edge middle) of another object. Driven through the REAL
// Scene gizmo handlers (synthetic dragging-changed + change, the snap-advanced recipe) with the real
// keyboard for B.
//   1. element snapping OFF in the stored targets: without B nothing snaps (the premise);
//   2. B held: A's +X top front corner lands ON B's -X top front corner (A moves to x = 2);
//   3. B held over the middle of B's top front edge: the candidate is the edge MIDDLE (4, 2, 1);
//   4. B typed into a text field does not arm it; releasing B disarms it; the stored targets never changed.
// Counterfactual on v1.71.0: no cornerSnapHeld, nothing snaps in 2 (A stays at x = 0.5).
// Run: APP_URL=https://localhost:7090/ npm run e2e -- corner-snap
const h = require('./helpers.cjs');

/** one synthetic drag of A by +0.5 on X with the pointer aimed at `aim` (world) */
const drag = (page, ids, aim) =>
	page.evaluate(
		({ a, aim }) => {
			const w = window.__tp.test.v1;
			let controls, camera, g;
			w.TControls.subscribe((v) => (controls = v))();
			w.globalCamera.subscribe((v) => (camera = v))();
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			if (!controls || controls.object !== boxA) return { attached: false };
			boxA.position.set(0.5, 1, 0);
			boxA.updateMatrixWorld(true);
			const p = new w.THREE.Vector3(...aim).project(camera);
			let renderer;
			w.globalRenderer.subscribe((v) => (renderer = v))();
			const rect = renderer.domElement.getBoundingClientRect();
			w.snapEngine.setSnapPointer(rect.left + (p.x * 0.5 + 0.5) * rect.width, rect.top + (-p.y * 0.5 + 0.5) * rect.height);
			controls.dragging = true;
			controls.dispatchEvent({ type: 'dragging-changed', value: true });
			boxA.position.x = 0.5;
			boxA.updateMatrixWorld(true);
			controls.dispatchEvent({ type: 'change' }); // Scene's onchange = three's 'change' (threlte maps it)
			let candidate = null;
			w.snapEngine.activeSnapCandidate.subscribe((v) => (candidate = v))();
			const box = new w.THREE.Box3().setFromObject(boxA);
			// diagnosis: the same search called directly
			const ndc = [p.x, p.y];
			const probe = w.snapEngine.findSnapCandidate(camera, ndc, [a], { targets: { enabled: true, vertex: true, edge: true, edgeMid: true, boxCorners: true } });
			const out = {
				probe: probe ? probe.type + '@' + probe.point.toArray().map((n) => n.toFixed(2)).join(',') : null,
				ndc: ndc.map((n) => n.toFixed(3)),
				live: {
					mode: controls.mode,
					dragging: controls.dragging,
					sameCanvas: document.querySelector('canvas') === renderer.domElement,
					rect: [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n))
				},
				attached: true,
				type: candidate?.type ?? null,
				point: candidate ? candidate.point.toArray().map((n) => Math.round(n * 1000) / 1000) : null,
				pos: boxA.position.toArray().map((n) => Math.round(n * 1000) / 1000),
				max: box.max.toArray().map((n) => Math.round(n * 1000) / 1000)
			};
			controls.dragging = false;
			controls.dispatchEvent({ type: 'dragging-changed', value: false });
			return out;
		},
		{ a: ids.a, aim }
	);
const held = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.snapEngine.cornerSnapHeld.subscribe((v) => r(v))()));
const near3 = (a, b) => !!a && a.every((v, i) => Math.abs(v - b[i]) < 2e-3);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });

	const ids = await A.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 600));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const boxes = g.children.filter((c) => c.name?.startsWith('Box'));
		const [a, b] = boxes;
		a.position.set(0.5, 1, 0);
		b.position.set(4, 1, 0); // B spans x 3..5, y 0..2, z -1..1
		a.updateMatrixWorld(true);
		b.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
		// the stored element snapping is OFF: only the held key may snap
		w.snapping.snapTargets.update((v) => ({ ...v, enabled: false, vertex: false, edge: false, face: false, surface: false, object: false, radiusPx: 40 }));
		// look at the pair from the front, a little above
		let cam;
		w.globalCamera.subscribe((v) => (cam = v))();
		cam.position.set(2, 4, 9);
		cam.lookAt(2.5, 1, 0);
		cam.updateMatrixWorld(true);
		return { a: a.uuid, b: b.uuid };
	});
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(800);
	const stored0 = await A.page.evaluate(() => new Promise((r) => window.__tp.test.v1.snapping.snapTargets.subscribe((v) => r(JSON.stringify(v)))()));

	console.log('\n=== 1. without B: nothing snaps ===');
	const AIM_CORNER = [3.03, 1.97, 1]; // just inside B's front face, at its top -X corner (3, 2, 1)
	const r1 = await drag(A.page, ids, AIM_CORNER);
	h.check(r1.attached, 'the gizmo is on box A');
	h.check(r1.type === null && near3(r1.pos, [0.5, 1, 0]), 'no candidate, A stays at x = 0.5' + ' | ' + JSON.stringify(r1));

	console.log('\n=== 2. hold B: the nearest corner lands on the corner ===');
	await A.page.mouse.move(20, 450);
	await A.page.keyboard.down('b');
	h.check((await held(A.page)) === true, 'B down arms corner snap');
	const r2 = await drag(A.page, ids, AIM_CORNER);
	h.check(r2.type === 'vertex' && near3(r2.point, [3, 2, 1]), "the candidate is B's corner (3, 2, 1)" + ' | ' + JSON.stringify(r2));
	h.check(near3(r2.max, [3, 2, 1]), "A's +X top front corner sits ON it" + ' | ' + JSON.stringify(r2.max));
	h.check(near3(r2.pos, [2, 1, 0]), 'A moved to x = 2' + ' | ' + JSON.stringify(r2.pos));

	console.log('\n=== 3. hold B over an edge middle ===');
	const r3 = await drag(A.page, ids, [4.0, 1.97, 1]);
	h.check(near3(r3.point, [4, 2, 1]), "the candidate is the middle of B's top front edge (4, 2, 1)" + ' | ' + JSON.stringify(r3));
	h.check(near3(r3.max, [4, 2, 1]), "A's nearest corner sits on the edge middle" + ' | ' + JSON.stringify(r3.max));
	await A.page.keyboard.up('b');
	h.check((await held(A.page)) === false, 'releasing B disarms it');
	const r4 = await drag(A.page, ids, AIM_CORNER);
	h.check(r4.type === null, 'after release nothing snaps again' + ' | ' + JSON.stringify(r4));

	console.log('\n=== 4. B in a text field; stored targets untouched ===');
	await A.page.evaluate(() => {
		const i = document.createElement('input');
		i.id = 'corner-snap-probe';
		document.body.appendChild(i);
		i.focus();
	});
	await A.page.keyboard.down('b');
	h.check((await held(A.page)) === false, 'typing B into a text field does not arm corner snap');
	await A.page.keyboard.up('b');
	await A.page.evaluate(() => document.getElementById('corner-snap-probe')?.remove());
	const stored1 = await A.page.evaluate(() => new Promise((r) => window.__tp.test.v1.snapping.snapTargets.subscribe((v) => r(JSON.stringify(v)))()));
	h.check(stored0 === stored1, 'the stored snap targets never changed');
	const listed = await A.page.evaluate(() => window.__tp.test.v1.shortcuts?.shortcuts?.some?.((s) => s.id === 'scene.cornerSnap'));
	if (listed !== undefined) h.check(listed === true, 'Settings > Shortcuts lists "B (hold)"');

	await h.finish(browser);
});
