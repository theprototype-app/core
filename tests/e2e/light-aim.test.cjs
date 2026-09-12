// 24-E1: ROTATION DRIVES DIRECTION for directional + spot lights. A directional light's
// `target` sat detached at the world origin forever, so every sun pointed at (0,0,0)
// and rotating it changed nothing visible (reported); spots had the opposite model, a
// persisted aim point enforced per frame. Now `lightHelpers` places `light.target`
// along the light's own forward every frame (so the rotate gizmo, the rotation rows
// and shadows agree), "Aim at" is a one-shot lookAt that WRITES the rotation
// (replicating as the ordinary `move`), an old `userData.spotTarget` migrates once
// into a rotation on every peer, and lights get an Origin so a sun can orbit a point.
const h = require('./helpers.cjs');

/** the light's world forward, its target's world position and a few facts */
const lightInfo = (page, name) =>
	page.evaluate((name) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const l = g?.children.find((c) => c.name === name);
		if (!l) return null;
		const T = window.__stores.THREE;
		l.updateMatrixWorld(true);
		const q = new T.Quaternion();
		l.getWorldQuaternion(q);
		const f = new T.Vector3(0, 0, -1).applyQuaternion(q);
		const p = new T.Vector3();
		l.getWorldPosition(p);
		const t = new T.Vector3();
		l.target?.getWorldPosition?.(t);
		return {
			uuid: l.uuid,
			pos: p.toArray(),
			forward: f.toArray(),
			target: t.toArray(),
			targetParented: !!l.target?.parent,
			spotTarget: l.userData?.spotTarget ?? null,
			rot: [l.rotation.x, l.rotation.y, l.rotation.z],
			shadowCam: l.shadow?.camera?.matrixWorld?.elements?.slice() ?? null
		};
	}, name);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const fmt = (v) => '[' + v.map((n) => n.toFixed(2)).join(', ') + ']';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS }); // the target rides the FRAME loop
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- 1. a directional light: rotate it via the rotation rows' path, the target follows
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/light directional'));
	// the target is placed by the per-frame helper hook (after the 100ms helper sync)
	await h.eventually(() => lightInfo(A.page, 'Directional'), (x) => !!x && x.targetParented, "premise: the directional light's target is in the scene", 8000);
	let a = await lightInfo(A.page, 'Directional');
	h.check(Math.abs(dot(a.forward, [0, 0, -1]) - 1) < 1e-3, `a fresh light looks down its -Z (${fmt(a.forward)})`);
	// the Inspector rows write rotation + send the ordinary `move`; do the same here
	await A.page.evaluate((uuid) => {
		let g, p;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		window.__stores.peers.subscribe((x) => (p = x))();
		const l = g.getObjectByProperty('uuid', uuid);
		l.position.set(0, 4, 0);
		l.rotation.set(0, Math.PI / 2, 0);
		p.send({ type: 'move', uuid, pos: l.position.toArray(), rot: l.rotation.toArray(), scale: l.scale.toArray() });
		window.__stores.objectsGroup.update((v) => v);
	}, a.uuid);
	await A.page.waitForTimeout(400);
	a = await lightInfo(A.page, 'Directional');
	h.check(Math.abs(dot(a.forward, [-1, 0, 0]) - 1) < 1e-3, `rotating 90° about Y aims the light along -X (${fmt(a.forward)})`);
	const toTarget = norm(sub(a.target, a.pos));
	h.check(Math.abs(dot(toTarget, a.forward) - 1) < 1e-3, `light.target sits along the forward (${fmt(toTarget)})`);
	await h.eventually(
		() => lightInfo(B.page, 'Directional'),
		(b) => !!b && Math.abs(dot(b.forward, [-1, 0, 0]) - 1) < 1e-3 && Math.abs(dot(norm(sub(b.target, b.pos)), b.forward) - 1) < 1e-3,
		"peer B's copy aims the same way, target along the forward",
		15000
	);

	// ---- 2. "Aim at" is a one-shot lookAt: forward points at the point, shadows follow --
	const shadowBefore = a.shadowCam;
	await A.page.evaluate((uuid) => {
		let g, p;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		window.__stores.peers.subscribe((x) => (p = x))();
		const l = g.getObjectByProperty('uuid', uuid);
		window.__stores.lightParams.aimLight(l, [3, 0, 0]);
		p.send({ type: 'move', uuid, pos: l.position.toArray(), rot: l.rotation.toArray(), scale: l.scale.toArray() });
		window.__stores.objectsGroup.update((v) => v);
	}, a.uuid);
	await A.page.waitForTimeout(500);
	a = await lightInfo(A.page, 'Directional');
	const want = norm(sub([3, 0, 0], a.pos));
	h.check(Math.abs(dot(a.forward, want) - 1) < 1e-3, `Aim at (3,0,0): the forward points at it (${fmt(a.forward)} vs ${fmt(want)})`);
	const shadowMoved = await A.page.evaluate(() => { let r; window.__stores.globalRenderer.subscribe((x) => (r = x))(); return !!r?.shadowMap?.enabled; });
	if (shadowMoved && shadowBefore && a.shadowCam)
		h.check(shadowBefore.some((n, i) => Math.abs(n - a.shadowCam[i]) > 1e-4), 'the shadow camera followed the aim');
	else console.log('  (shadow map disabled in this renderer — shadow camera check skipped)');
	await h.eventually(
		() => lightInfo(B.page, 'Directional'),
		(b) => !!b && Math.abs(dot(b.forward, norm(sub([3, 0, 0], b.pos))) - 1) < 1e-3,
		'peer B aims at the same point',
		15000
	);

	// ---- 3. the old spot model migrates: userData.spotTarget → a rotation, key gone ----
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/light spot'));
	await A.page.waitForTimeout(500);
	let s = await lightInfo(A.page, 'Spot');
	h.check(!!s, 'premise: a spot exists');
	// (a) a 1.8.0 object arriving with the key (session/prefab/.tpscene/old peer): the
	//     helper sync migrates it on the next objectsGroup poke
	await A.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const l = g.getObjectByProperty('uuid', uuid);
		l.position.set(2, 3, 2);
		l.rotation.set(0, 0, 0);
		l.userData.spotTarget = [2, 0, -2];
		window.__stores.objectsGroup.update((v) => v);
	}, s.uuid);
	await A.page.waitForTimeout(600);
	s = await lightInfo(A.page, 'Spot');
	h.check(s.spotTarget === null, 'userData.spotTarget is gone after the migration');
	h.check(Math.abs(dot(s.forward, norm(sub([2, 0, -2], s.pos))) - 1) < 1e-3, `...and the spot aims where the old point was (${fmt(s.forward)})`);
	// (b) an OLD peer's `lighttarget` message lands as the same one-shot lookAt
	await B.page.evaluate((uuid) => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		p.send({ type: 'lighttarget', uuid, pos: [-4, 0, 2] });
	}, s.uuid);
	await h.eventually(
		() => lightInfo(A.page, 'Spot'),
		(x) => !!x && x.spotTarget === null && Math.abs(dot(x.forward, norm(sub([-4, 0, 2], x.pos))) - 1) < 1e-3,
		"an old peer's lighttarget aims the spot by rotation, no userData",
		15000
	);

	// ---- 4. a light gets an Origin: with it at world zero, Rotate orbits the light ----
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.objectActions.deselectObject();
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const l = g.getObjectByProperty('uuid', uuid);
		l.position.set(5, 4, 0);
		l.rotation.set(0, 0, 0);
		s.objectOrigin.originPreset(uuid, 'world');
		s.objectActions.selectObject(uuid);
	}, a.uuid);
	await A.page.waitForTimeout(400);
	const seated = await A.page.evaluate(() => { let c; window.__stores.TControls.subscribe((x) => (c = x))(); const o = c?.object; return { pivot: !!o?.userData?.isMultiPivot, at: o?.position?.toArray() ?? null }; });
	h.check(seated.pivot && seated.at && Math.hypot(seated.at[0], seated.at[1], seated.at[2]) < 1e-3, `selecting the light seats the pivot on its origin at world zero (${JSON.stringify(seated)})`);
	await A.page.evaluate(() => window.__stores.multiTransform.applyPivotTransform((p) => { p.rotation.y = Math.PI / 2; }));
	await A.page.waitForTimeout(400);
	a = await lightInfo(A.page, 'Directional');
	h.check(Math.abs(a.pos[0]) < 1e-3 && Math.abs(a.pos[1] - 4) < 1e-3 && Math.abs(a.pos[2] + 5) < 1e-3, `rotating 90° about the origin moves the sun on a circle: (5,4,0) -> ${fmt(a.pos)}`);
	h.check(Math.abs(dot(a.forward, [-1, 0, 0]) - 1) < 1e-3, `...and turns it with the orbit (${fmt(a.forward)})`);
	await h.eventually(
		() => lightInfo(B.page, 'Directional'),
		(b) => !!b && Math.abs(b.pos[0]) < 1e-3 && Math.abs(b.pos[2] + 5) < 1e-3,
		'peer B sees the orbited position',
		15000
	);

	// ---- 5. the Inspector: Aim rows for both light types, Origin section for a light --
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), a.uuid);
	await A.page.waitForTimeout(600);
	const ui = await A.page.evaluate(() => ({
		aim: !!document.querySelector('#inspector-light-aim'),
		pick: !!document.querySelector('#light-aim-pick'),
		origin: !!document.querySelector('#object-origin'),
		world0: !!document.querySelector('#origin-world'),
		bottom: !!document.querySelector('#origin-bottom'),
		meshPick: !!document.querySelector('#origin-pick'),
		oldSpotRows: !!document.querySelector('#inspector-spot-target')
	}));
	h.check(ui.aim && ui.pick, `a directional light shows Aim at rows + Pick in viewport (${JSON.stringify(ui)})`);
	h.check(ui.origin && ui.world0 && !ui.bottom && !ui.meshPick, 'a light has an Origin section without the geometry presets');
	h.check(!ui.oldSpotRows, 'the old spot-target rows are gone');
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), s.uuid);
	await A.page.waitForTimeout(500);
	h.check(await A.page.evaluate(() => !!document.querySelector('#inspector-light-aim')), 'a spot shows the same Aim at rows');

	await h.finish(browser);
});
