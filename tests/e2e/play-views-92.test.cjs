// 92-input GC4a + GC4 — the play views. A Character Controller's `camera` = third person, side-scroller or
// top-down: the PLAYER stays the play camera (every game rule reads it as before) and only the DRAW moves.
//   0. feature unused: a controller with no camera (and no controller at all) loads nothing, draws from the eye
//   1. third: the frame is drawn ~4 m behind and 0.5 m above the eye; W walks forward as in first person;
//      your own avatar is drawn; a wall behind pulls the camera in; the wheel zooms
//   2. side: D walks +X, W does nothing, the plane holds; the frame looks along -Z from 12 m off the plane
//   3. top: S walks +Z (toward the bottom of the screen); the frame is above and behind at the angle
//   4. the node card shows only the rows of the chosen view
// Red on v1.74.0: there is no `camera` on a Character Controller (no playView chunk, the frame = the eye).
//
// Run: APP_URL=https://localhost:5922/ npm run e2e -- play-views-92
const h = require('./helpers.cjs');

const E = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);

/** the controller node, with `extra` data @param {any} p @param {Record<string, any> | null} extra */
const controller = (p, extra) =>
	E(
		p,
		(x) => {
			const s = /** @type {any} */ (window).__tp.test.v1;
			s.setActiveGraph(s.SCENE_GRAPH);
			s.flowNodes.set(x ? [{ id: 'cc', type: 'charcontroller', position: { x: 0, y: 0 }, data: { type: 'charcontroller', mode: 'walk', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7, gravity: true, ...x } }] : []);
			s.flowEdges.set([]);
		},
		extra
	);

/** put the player at (x, 1.7, z) facing -Z; record the pose the NEXT frames are drawn from @param {any} p */
const home = (p, x = 0, z = 0) =>
	E(
		p,
		([x, z]) => {
			const s = /** @type {any} */ (window).__tp.test.v1;
			/** @type {any} */ let cam;
			s.playerCam.subscribe((/** @type {any} */ c) => (cam = c))();
			cam.rotation.set(0, 0, 0);
			const v = new s.THREE.Vector3(x, 1.7, z);
			if (cam.parent) cam.parent.worldToLocal(v);
			cam.position.copy(v);
			cam.updateMatrixWorld(true);
			/** @type {any} */ let scene;
			s.globalScene.subscribe((/** @type {any} */ g) => (scene = g))();
			const w = /** @type {any} */ (window);
			if (!w.__drawn) {
				w.__drawn = { n: 0 };
				const prev = scene.onBeforeRender;
				scene.onBeforeRender = (/** @type {any[]} */ ...a) => {
					const c = a[2];
					if (c === cam) {
						const q = c.getWorldQuaternion(new s.THREE.Quaternion());
						const f = new s.THREE.Vector3(0, 0, -1).applyQuaternion(q);
						w.__drawn = { n: w.__drawn.n + 1, pos: c.getWorldPosition(new s.THREE.Vector3()).toArray(), fwd: f.toArray() };
					}
					prev?.apply(scene, a);
				};
			}
		},
		[x, z]
	);

/** the player (the play camera, outside a draw) and the last drawn frame's pose @param {any} p */
const poses = (p) =>
	E(p, () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		/** @type {any} */ let cam;
		s.playerCam.subscribe((/** @type {any} */ c) => (cam = c))();
		/** @type {any} */ let scene;
		s.globalScene.subscribe((/** @type {any} */ g) => (scene = g))();
		const d = /** @type {any} */ (window).__drawn ?? {};
		return {
			eye: cam.getWorldPosition(new s.THREE.Vector3()).toArray(),
			drawn: d.pos ?? null,
			fwd: d.fwd ?? null,
			frames: d.n ?? 0,
			self: !!scene.getObjectByName('self-view'),
			view: s.playView.playViewDebug()
		};
	});

/** hold a key for `ms` and let the frame settle @param {any} p @param {string} key @param {number} ms */
async function hold(p, key, ms) {
	await p.page.keyboard.down(key);
	await p.page.waitForTimeout(ms);
	await p.page.keyboard.up(key);
	await p.page.waitForTimeout(400);
}
const near = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ tol) => Math.abs(a - b) <= tol;
const fmt = (/** @type {any} */ v) => (v ? v.map((/** @type {number} */ n) => n.toFixed(2)).join(', ') : 'none');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.isLocked.set(true));
	await A.page.waitForTimeout(800);

	console.log('\n=== 0. feature unused = zero change ===');
	await controller(A, {});
	await home(A);
	await A.page.waitForTimeout(1500);
	let q = await poses(A);
	h.check(q.view.kind === 'first' && q.view.loaded === false, `0. a controller with no camera is first person and loads no view chunk (${JSON.stringify(q.view)})`);
	h.check(q.frames > 0 && !!q.drawn && Math.hypot(q.drawn[0] - q.eye[0], q.drawn[1] - q.eye[1], q.drawn[2] - q.eye[2]) < 1e-3, `0. the frame is drawn from the eye (${fmt(q.drawn)} vs ${fmt(q.eye)})`);
	h.check(!q.self, '0. no self body in first person');

	console.log('\n=== 1. third person ===');
	await controller(A, { camera: 'third' });
	await home(A);
	await h.eventually(() => poses(A), (r) => r.view.kind === 'third' && r.view.loaded && r.frames > 0, '1. the third-person view is in force', 15000);
	await A.page.waitForTimeout(1200);
	q = await poses(A);
	console.log(`  eye ${fmt(q.eye)}, drawn ${fmt(q.drawn)}, forward ${fmt(q.fwd)}`);
	h.check(!!q.drawn && near(q.drawn[2] - q.eye[2], 4, 0.15) && near(q.drawn[1] - q.eye[1], 0.5, 0.15) && near(q.drawn[0], q.eye[0], 0.05), '1. the frame is drawn 4 m behind and 0.5 m above the eye (red on v1.74.0: no view)');
	h.check(!!q.fwd && q.fwd[2] < -0.99, '1. ...looking the way the player looks');
	h.check(near(q.eye[2], 0, 0.01) && near(q.eye[1], 1.7, 0.15), `1. the player itself has not moved (${fmt(q.eye)})`);
	h.check(q.self, '1. your own avatar is drawn (self-view)');
	const z0 = q.eye[2];
	await hold(A, 'KeyW', 1500);
	q = await poses(A);
	h.check(q.eye[2] < z0 - 2, `1. W walks forward as in first person (z ${z0.toFixed(2)} -> ${q.eye[2].toFixed(2)})`);
	// the wheel zooms out between the limits
	const zoomBefore = q.view.zoom;
	for (let i = 0; i < 5; i++) await A.page.mouse.wheel(0, 120);
	await A.page.waitForTimeout(500);
	q = await poses(A);
	h.check(q.view.zoom > zoomBefore + 1 && q.view.zoom <= 10, `1. the wheel zooms out (${zoomBefore} -> ${Number(q.view.zoom).toFixed(2)}, max 10)`);
	// a wall right behind pulls the camera in
	await E(A, () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const wall = new s.THREE.Mesh(new s.THREE.BoxGeometry(20, 20, 0.3), new s.THREE.MeshBasicMaterial());
		wall.name = 'pv-wall';
		wall.position.set(0, 2, 1.5);
		g.add(wall);
		wall.updateMatrixWorld(true);
	});
	await home(A);
	await A.page.waitForTimeout(1200);
	q = await poses(A);
	h.check(!!q.drawn && q.drawn[2] < 1.35 && q.drawn[2] > 0.2, `1. a wall 1.5 m behind pulls the camera in front of it (drawn z ${q.drawn?.[2]?.toFixed(2)})`);
	await E(A, () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const w = g.getObjectByName('pv-wall');
		if (w) g.remove(w);
	});

	console.log('\n=== 2. side-scroller ===');
	await controller(A, { camera: 'side' });
	await home(A, 0, -3);
	await h.eventually(() => poses(A), (r) => r.view.kind === 'side', '2. the side view is in force', 15000);
	await A.page.waitForTimeout(800);
	let s0 = await poses(A);
	await hold(A, 'KeyD', 1500);
	let s1 = await poses(A);
	console.log(`  D: ${fmt(s0.eye)} -> ${fmt(s1.eye)}; drawn ${fmt(s1.drawn)}`);
	h.check(s1.eye[0] > s0.eye[0] + 2 && near(s1.eye[2], -3, 0.02), '2. D walks +X and the plane (z = -3) holds');
	h.check(!!s1.drawn && near(s1.drawn[2], -3 + 12, 0.2) && !!s1.fwd && s1.fwd[2] < -0.99, '2. the frame looks along -Z from 12 m off the plane');
	h.check(!!s1.drawn && s1.drawn[0] > s1.eye[0] + 0.5, `2. ...leading the way the player faces (drawn x ${s1.drawn?.[0]?.toFixed(2)} vs ${s1.eye[0].toFixed(2)})`);
	s0 = s1;
	await hold(A, 'KeyW', 1000);
	s1 = await poses(A);
	h.check(near(s1.eye[0], s0.eye[0], 0.05) && near(s1.eye[2], s0.eye[2], 0.02), `2. W does not leave the plane (${fmt(s0.eye)} -> ${fmt(s1.eye)})`);
	h.check(s1.self, '2. your own avatar is drawn');

	console.log('\n=== 3. top-down ===');
	await controller(A, { camera: 'top', angle: 60, distance: 16 });
	await home(A);
	await h.eventually(() => poses(A), (r) => r.view.kind === 'top', '3. the top view is in force', 15000);
	await A.page.waitForTimeout(1500);
	const t0 = await poses(A);
	await hold(A, 'KeyS', 1500);
	await A.page.waitForTimeout(800);
	const t1 = await poses(A);
	console.log(`  S: ${fmt(t0.eye)} -> ${fmt(t1.eye)}; drawn ${fmt(t1.drawn)} forward ${fmt(t1.fwd)}`);
	h.check(t1.eye[2] > t0.eye[2] + 2 && near(t1.eye[0], t0.eye[0], 0.1), '3. S walks +Z (down the screen)');
	const elev = t1.fwd ? (Math.asin(-t1.fwd[1]) * 180) / Math.PI : 0;
	h.check(near(elev, 60, 3), `3. the frame looks down at 60 degrees (${elev.toFixed(1)})`);
	h.check(!!t1.drawn && t1.drawn[1] > t1.eye[1] + 10 && t1.drawn[2] > t1.eye[2] + 5, '3. ...from above and behind the player');

	console.log('\n=== 4. the card shows the chosen view\'s rows ===');
	const rows = await E(A, () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		const spec = s.nodeCatalog.findNodeSpec('charcontroller');
		return spec.params.filter((/** @type {any} */ p) => p.showIf).map((/** @type {any} */ p) => p.key + ':' + p.showIf.camera.join('/'));
	});
	h.check(rows.includes('angle:top') && rows.includes('lookAhead:side') && rows.includes('collide:third'), '4. view rows declare their view: ' + rows.join(' '));

	await E(A, () => /** @type {any} */ (window).__tp.test.v1.isLocked.set(false));
	await browser.close();
});
