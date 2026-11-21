// 102 M3 — DECALS: an image projected onto the surface under it, a CHILD of the object it was put
// on, rebuilt from its record on every peer (the clipped surface never travels).
//
//   §1 place a decal on a wall on A: a carrier under the wall with a clipped surface, drawn after
//      the wall (renderOrder, polygonOffset) with a plain MeshStandardMaterial (Cinematic view
//      draws it); B builds the same surface from the record
//   §2 move: the decal's box moved against the wall rebuilds there (both peers); the WALL moved
//      carries the decal with no rebuild
//   §3 the record (opacity, tint) and the size (= scale) replicate; a toJSON writes the small
//      placeholder, never the built surface
//   §4 undo / redo of the placement, on both peers; refusals (a decal on a decal)
//   §5 create_objects {kind: 'decal'} (the agent's path)
//   §6 the Inspector's Decal section
//   §7 play mode: a ball rolled into the wall stamps a mark where it touched (On Impact -> Stamp
//      Decal); B draws the same mark from the one message; stopping the run clears both
//   §8 (LAST) save -> reload: the decal is back, rebuilt from its record
//
// Counterfactual: v1.70.0 has no decals — `decalEdit` does not exist, every row is red.
// Run: e2e-slot --dev <lane> 7072 -- env APP_URL=https://theprototype.app:7072/ npm run e2e -- decals
const h = require('./helpers.cjs');

const OUT = process.env.E2E_OUT ?? 'test-results/102-decals';

/** @param {any} page */
const dbg = (page) => page.evaluate(async () => (await window.__tp.test.v1.decal).decalDebug());
/** @param {any} page @param {string} uuid */
const one = async (page, uuid) => (await dbg(page)).carriers.find((/** @type {any} */ c) => c.uuid === uuid) ?? null;
/** the carrier's built surface in world space: its bounding-box centre + its triangle count @param {any} page @param {string} uuid */
const surface = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		o.updateWorldMatrix(true, false);
		const geo = o.geometry;
		geo.computeBoundingBox();
		const c = geo.boundingBox.getCenter(new window.__tp.test.v1.THREE.Vector3()).applyMatrix4(o.matrixWorld);
		return {
			centre: c.toArray().map((v) => +v.toFixed(3)),
			tris: geo.userData?.decalTris ?? 0,
			parent: o.parent?.uuid ?? null,
			record: JSON.parse(JSON.stringify(o.userData.decal ?? null)),
			scale: o.scale.toArray().map((v) => +v.toFixed(3))
		};
	}, uuid);
/** @param {any} page @param {string} uuid */
const exists = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		return !!g?.getObjectByProperty('uuid', u);
	}, uuid);
/** a replicated raw move (the alignToGround shape) @param {any} page @param {string} uuid @param {number[]} pos */
const moveTo = (page, uuid, pos) =>
	page.evaluate(
		([u, p]) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			o.position.set(p[0], p[1], p[2]);
			o.updateMatrix();
			let peer;
			window.__tp.test.v1.peers.subscribe((v) => (peer = v))();
			peer?.send({ type: 'move', uuid: u, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
			// the renderer draws on demand: a gizmo drag (or the move applier on B) pokes it, a bare position write does not
			window.__tp.test.v1.pokeScene();
		},
		[uuid, pos]
	);
const near = (/** @type {number[]} */ a, /** @type {number[]} */ b, tol = 0.02) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await A.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));

	// ---- §1 ------------------------------------------------------------------------------
	// a wall 0.2 thick, 2 high, 3 wide, its -X face at x = 2.9
	const wall = await A.page.evaluate(() => {
		const o = window.__tp.test.v1.addObjects.spawnAtPoint('/create Box 0.2 2 3', [3, 1, 0]);
		o.name = 'Wall';
		return o.uuid;
	});
	await moveTo(A.page, wall, [3, 1, 0]);
	console.log('  §1 wall', JSON.stringify(await A.page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		return o && { type: o.type, mesh: !!o.isMesh, params: o.geometry?.parameters ?? null, pos: o.position.toArray() };
	}, wall)));
	await h.eventually(() => B.page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', u)?.position.x ?? null;
	}, wall), (x) => x === 3, '§1 premise: B has the wall at x = 3');
	const decal = await A.page.evaluate(async (w) => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const e = await s.decalEdit;
		const made = e.placeDecalOn(g.getObjectByProperty('uuid', w), [2.9, 1, 0], [-1, 0, 0], { size: [0.6, 0.4, 0.25], quiet: true });
		return made ? made.uuid : 'refused: ' + e.lastDecalRefusal();
	}, wall);
	h.check(!!decal && !decal.startsWith('refused'), `§1 placeDecalOn made a carrier (${decal})`);
	await h.eventually(() => one(A.page, decal), (d) => !!d && d.tris > 0, '§1 A built the decal surface', 20000);
	const a1 = await one(A.page, decal);
	const s1 = await surface(A.page, decal);
	console.log('  §1 A', JSON.stringify(a1), JSON.stringify(s1));
	h.check(a1.target === wall && s1.parent === wall, `§1 the decal is a child of the wall (${a1.target})`);
	h.check(a1.tris >= 2 && a1.tris <= 16 && !a1.capped, `§1 the clipped surface is a few triangles of the wall's face (${a1.tris})`);
	h.check(near(s1.centre, [2.899, 1, 0], 0.01), `§1 ...centred on the point clicked, 1 mm off the face (${s1.centre})`);
	h.check(a1.visible && a1.polygonOffset && a1.renderOrder >= 1, `§1 drawn after the wall with polygonOffset (renderOrder ${a1.renderOrder})`);
	h.check(a1.materialType === 'MeshStandardMaterial' && !a1.patched, `§1 a plain ${a1.materialType}, no onBeforeCompile (the Cinematic view draws it)`);
	await h.eventually(() => one(B.page, decal), (d) => !!d && d.tris === a1.tris && d.target === wall, '§1 B built the same surface under its wall', 20000);
	const b1 = await surface(B.page, decal);
	h.check(near(b1.centre, s1.centre, 0.002), `§1 ...in the same place (${b1.centre})`);
	await A.page.screenshot({ path: `${OUT}/decal-placed.png` });

	// ---- §2 ------------------------------------------------------------------------------
	const builds0 = (await dbg(A.page)).builds;
	await moveTo(A.page, decal, [-0.1, 0.5, 0.8]); // wall-local: up 0.5, along 0.8 (still on the face)
	await h.eventually(() => surface(A.page, decal), (s) => !!s && near(s.centre, [2.899, 1.5, 0.8], 0.02), '§2 A rebuilt the decal where its box moved', 15000);
	await h.eventually(() => surface(B.page, decal), (s) => !!s && near(s.centre, [2.899, 1.5, 0.8], 0.02), '§2 ...and B', 15000);
	await h.eventually(() => dbg(A.page), (d) => d.builds > builds0, '§2 the move was a rebuild', 10000);
	const builds1 = (await dbg(A.page)).builds;
	await moveTo(A.page, wall, [3, 1, -2]);
	await h.eventually(() => surface(A.page, decal), (s) => !!s && near(s.centre, [2.899, 1.5, -1.2], 0.02), '§2 the wall moved 2 m: the decal went with it', 15000);
	await h.eventually(() => surface(B.page, decal), (s) => !!s && near(s.centre, [2.899, 1.5, -1.2], 0.02), '§2 ...on B too', 15000);
	await A.page.waitForTimeout(800);
	h.check((await dbg(A.page)).builds === builds1, `§2 a rigid move of the target costs no rebuild (${(await dbg(A.page)).builds - builds1})`);

	// ---- §3 ------------------------------------------------------------------------------
	await A.page.evaluate(async (u) => (await window.__tp.test.v1.decalEdit).setDecalFor(u, { opacity: 0.5, tint: '#ff8800' }), decal);
	await A.page.evaluate(async (u) => (await window.__tp.test.v1.decalEdit).setDecalSize(u, [1, 0.5, 0.2]), decal);
	await h.eventually(() => surface(B.page, decal), (s) => !!s && s.record?.opacity === 0.5 && s.record?.tint === '#ff8800' && near(s.scale, [1, 0.5, 0.2], 0.001), '§3 B has the new opacity, tint and size', 15000);
	const json = await A.page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		const j = o.toJSON();
		return { verts: (j.geometries?.[0]?.data?.attributes?.position?.array?.length ?? 0) / 3, built: o.geometry.attributes.position.count, bytes: JSON.stringify(j).length };
	}, decal);
	h.check(json.verts === 4 && json.built > 4, `§3 a toJSON writes the 4-vertex placeholder, not the ${json.built}-vertex surface (${json.bytes} bytes)`);

	// ---- §4 ------------------------------------------------------------------------------
	const undo = (/** @type {any} */ P) => P.page.evaluate(() => window.__tp.test.v1.history.undo());
	const redo = (/** @type {any} */ P) => P.page.evaluate(() => window.__tp.test.v1.history.redo());
	await undo(A); // the size
	await undo(A); // the record
	await h.eventually(() => surface(B.page, decal), (s) => !!s && s.record?.opacity === 1 && near(s.scale, [0.6, 0.4, 0.25], 0.001), '§4 two undos: the record and the size are back on B', 15000);
	await undo(A); // the placement (the raw moves are not in history)
	await h.eventually(() => exists(A.page, decal), (v) => v === false, '§4 one more undo removes the decal on A');
	await h.eventually(() => exists(B.page, decal), (v) => v === false, '§4 ...and on B');
	await h.eventually(() => dbg(A.page), (d) => !d.carriers.some((/** @type {any} */ c) => c.uuid === decal), '§4 A dropped its visual');
	await redo(A);
	await h.eventually(() => one(A.page, decal), (d) => !!d && d.tris > 0 && d.target === wall, '§4 redo brings it back on the wall (A)', 15000);
	await h.eventually(() => one(B.page, decal), (d) => !!d && d.tris > 0 && d.target === wall, '§4 ...and on B', 15000);
	const refused = await A.page.evaluate(async (u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const e = await window.__tp.test.v1.decalEdit;
		const out = e.placeDecalOn(g.getObjectByProperty('uuid', u), [2.9, 1.5, -1.2], [-1, 0, 0], { quiet: true });
		return { made: !!out, why: e.lastDecalRefusal() };
	}, decal);
	h.check(!refused.made && /another decal/.test(refused.why ?? ''), `§4 a decal on a decal is refused: "${refused.why}"`);

	// ---- §5 ------------------------------------------------------------------------------
	const agent = await A.page.evaluate(
		(w) => window.__tp.test.v1.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'decal', on: w, normal: [-1, 0, 0], size: 0.5, name: 'Arrow' }] }),
		wall
	);
	const agentUuid = agent?.created?.[0]?.uuid;
	h.check(!!agentUuid && agent.created[0].kind === 'decal', `§5 create_objects {kind: 'decal'} made one (${JSON.stringify(agent).slice(0, 200)})`);
	await h.eventually(() => surface(A.page, agentUuid), (s) => !!s && s.tris > 0 && s.parent === wall && Math.abs(s.centre[0] - 2.899) < 0.01, '§5 ...on the wall\'s -X face, aimed from that side', 15000);
	await h.eventually(() => one(B.page, agentUuid), (d) => !!d && d.tris > 0, '§5 B has it');
	const bad = await A.page.evaluate(() => window.__tp.test.v1.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'decal', normal: [0, 1, 0] }] }));
	h.check(!!bad?.error && /needs on/.test(bad.error), `§5 a decal without "on" is an error the agent can read (${bad?.error})`);

	// ---- §6 ------------------------------------------------------------------------------
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), decal);
	const opacity = A.page.locator('#decal-opacity');
	await opacity.waitFor({ timeout: 15000 });
	for (const id of ['#decal-image', '#decal-width', '#decal-height', '#decal-depth', '#decal-roughness', '#decal-angle', '#decal-tint']) {
		h.check((await A.page.locator(id).count()) === 1, `§6 the Decal section has ${id}`);
	}
	await A.page.locator('#decal-tint').evaluate((el) => {
		/** @type {HTMLInputElement} */ (el).value = '#00ff00';
		el.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await h.eventually(() => surface(B.page, decal), (s) => !!s && s.record?.tint === '#00ff00', '§6 the Inspector tint reached B', 15000);
	await A.page.screenshot({ path: `${OUT}/decal-inspector.png` });

	// ---- §7 ------------------------------------------------------------------------------
	const ball = await A.page.evaluate(() => {
		const s = window.__tp.test.v1;
		const o = s.addObjects.spawnAtPoint('/create Sphere 0.2', [0, 0.2, -1.5]);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		o.name = 'Ball';
		o.updateMatrixWorld(true);
		s.physics.setPhysicsFor(o.uuid, { mode: 'dynamic', mass: 1, collider: 'sphere', restitution: 0 });
		const wallObj = g.children.find((c) => c.name === 'Wall');
		s.physics.setPhysicsFor(wallObj.uuid, { mode: 'static', restitution: 0 });
		return o.uuid;
	});
	await A.page.evaluate((u) => {
		window.__tp.test.v1.flowNodes.set([
			{ id: 'imp', type: 'onimpact', position: { x: 0, y: 0 }, data: { label: 'On Impact', pulse: 0.3, minStrength: 0.5, direction: 'any' } },
			{ id: 'sel', type: 'objectselector', position: { x: 300, y: 0 }, data: { label: 'Object', selected: u } },
			{ id: 'stamp', type: 'decalstamp', position: { x: 300, y: 160 }, data: { label: 'Stamp Decal', size: 0.4, depth: 0.3, lifetime: 0, cap: 64 } }
		]);
		window.__tp.test.v1.flowEdges.set([
			{ id: 'e-imp-sel', source: 'imp', target: 'sel' },
			{ id: 'e-imp-stamp', source: 'imp', target: 'stamp', targetHandle: 'trigger' }
		]);
	}, ball);
	await A.page.waitForTimeout(600);
	await A.page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
	await A.page.waitForTimeout(1200); // the ball settles on the ground
	const stampsBefore = (await dbg(A.page)).stamps.length;
	await A.page.evaluate((u) => window.__tp.test.v1.physics.setBodyVelocity(u, [6, 0, 0], null), ball);
	await h.eventually(() => dbg(A.page), (d) => d.stamps.length > stampsBefore && d.stamps.every((/** @type {any} */ s) => s.built), '§7 the ball hitting the wall stamped a mark on A', 15000);
	const a7 = await dbg(A.page);
	const mark = a7.stamps[a7.stamps.length - 1];
	console.log('  §7 A stamps', JSON.stringify(a7.stamps));
	h.check(stampsBefore === 0 && mark.target === wall && mark.tris > 0, `§7 the mark is on the wall (${mark.target === wall}), ${mark.tris} triangles`);
	const markWorld = await A.page.evaluate(async () => {
		const g = window.__tp.test.v1.globalScene ?? null;
		let root;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (root = v))();
		const v = root.parent.children.find((c) => c.name === 'Decal stamp (visual)');
		if (!v) return null;
		v.geometry.computeBoundingBox();
		void g;
		return v.geometry.boundingBox.getCenter(new window.__tp.test.v1.THREE.Vector3()).applyMatrix4(v.matrixWorld).toArray().map((x) => +x.toFixed(2));
	});
	h.check(!!markWorld && Math.abs(markWorld[0] - 2.9) < 0.02 && Math.abs(markWorld[2] + 1.5) < 0.35 && markWorld[1] < 0.6, `§7 ...where the ball touched the wall's face (${markWorld})`);
	await h.eventually(() => dbg(B.page), (d) => d.stamps.some((/** @type {any} */ s) => s.id === mark.id && s.built && s.tris === mark.tris), '§7 B draws the same mark from the one message', 15000);
	await A.page.screenshot({ path: `${OUT}/decal-stamp.png` });
	await A.page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
	await h.eventually(() => dbg(A.page), (d) => d.stamps.length === 0, '§7 stopping the run clears the marks on A');
	await h.eventually(() => dbg(B.page), (d) => d.stamps.length === 0, '§7 ...and on B');
	await A.page.evaluate(() => {
		window.__tp.test.v1.flowNodes.set([]);
		window.__tp.test.v1.flowEdges.set([]);
	});

	for (const P of [A, B]) h.check(h.pageErrors(P).length === 0, `no page errors on ${P === A ? 'A' : 'B'} (${h.pageErrors(P).join(' | ')})`);

	// ---- §8 (LAST: a reload gives A a new peer id) ------------------------------------------
	const before = (await surface(A.page, decal))?.record;
	await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	// a remote slot boots the dev app in ~110 s: freshReload's 30 s wait is too short there
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 180000 });
	await h.answerRestore(A, 'restore');
	await h.eventually(() => one(A.page, decal).catch(() => null), (d) => !!d && d.tris > 0 && d.target === wall, '§8 after save + reload the decal is back on the wall, rebuilt', 60000);
	const after = (await surface(A.page, decal))?.record;
	h.check(JSON.stringify(after) === JSON.stringify(before), `§8 the record is identical (${JSON.stringify(after)})`);
	h.check(h.pageErrors(A).length === 0, `no page errors on A after the reload (${h.pageErrors(A).join(' | ')})`);
	// the scene as a .tpscene, for decal-compat (a file saved by this build opens in the newest release)
	const b64 = await A.page.evaluate(async () => {
		const s = await window.__tp.test.v1.sessions;
		const blob = await s.exportSessionZip(s.buildSessionPayload('Decal wall'), { assets: true, packs: false, flow: true });
		const u = new Uint8Array(await new Response(blob).arrayBuffer());
		let bin = '';
		for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
		return btoa(bin);
	});
	require('fs').writeFileSync(`${OUT}/decal-wall.tpscene`, Buffer.from(b64, 'base64'));
	h.check(b64.length > 100, `§8 the scene exported as a .tpscene (${Math.round((b64.length * 3) / 4)} bytes)`);
	await h.finish(browser);
});
