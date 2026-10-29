// 52 (V3) — TERRAIN PAINT + SCATTER BRUSHES ON THE CONTROLLER, on IWER (48 G2: the app's own XR path, a
// Quest 3 emulated). The desktop toolbar's Paint (four layers) and Scatter (+ 51's Erase / Rotate / Scale /
// Relax) in the headset: trigger strokes, the stick sizes (x) and sets strength / density (y), the Sculpt
// ring's Paint ▸ and Scatter ▸ wheels (+ Source ▸), the brush ring on the surface, a tick on stroke start.
// And all of it in a MINIATURE (52 V5: the world scaled down to a table) — plus placement there.
//
//  1 the Sculpt ring grows Paint ▸ and Scatter ▸; Paint ▸ lists Layer 1-4; Scatter ▸ the five tools + Source ▸
//  2 Paint: Layer 3 from the wheel, a trigger stroke paints the splat map (ONE undo entry), a tick in the
//    painting hand, the ring on the terrain at the brush radius; the label says "Paint 3 · …"
//  3 the stick: x sizes the brush, y the strength — and the DENSITY while scatter-painting
//  4 Scatter: Source ▸ lists the primitives (+ what is in use); Sphere from it; a stroke adds instances;
//    Erase removes them; Rotate turns them (each ONE undo entry)
//  5 the miniature (the world at 1:10): the ring is drawn at a tenth; a paint and a scatter stroke land at
//    the terrain-local spot under the ray; Add ▸ Cube lands 2 m ahead in REAL space, a tenth in the model
// Red on the base (origin/feat/51): no Paint ▸ / Scatter ▸ in the headset at all.
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const g = (page, fn, arg) => page.evaluate(fn, arg);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const sc = () => g(page, () => window.__stores.vrSculpt.vrSculptDebug());
	const menu = (id) => g(page, (id) => window.__stores.vrControls.executeVRMenuAction(id), id);
	const ring = (r) => g(page, (r) => window.__stores.vrRadialMenu.ringEntries(r).map((e) => e.id), r);
	const undoLen = () =>
		g(page, () => {
			let v;
			window.__stores.history.undoStack.subscribe((x) => (v = x))();
			return v.length;
		});
	const terrain = () =>
		g(page, () => {
			let sel;
			window.__stores.selectedObject.subscribe((x) => (sel = x))();
			return sel?.uuid ?? null;
		});
	const digest = (uuid) => g(page, (uuid) => window.__stores.terrainPaint.splatDigest(uuid), uuid);
	const instances = (uuid) =>
		g(page, (uuid) => {
			let grp;
			window.__stores.objectsGroup.subscribe((x) => (grp = x))();
			const o = grp.getObjectByProperty('uuid', uuid);
			const counts = window.__stores.terrainSurface.scatterCounts(o);
			return Object.values(counts).reduce((a, b) => a + b, 0);
		}, uuid);
	const scatterYaws = (uuid) =>
		g(page, (uuid) => {
			const block = window.__stores.terrainPaint.scatterBlockNow(uuid);
			const out = [];
			for (const set of block?.sets ?? []) for (const i of window.__stores.terrainPaint.scatterInstancesOf(uuid, set.id)) out.push(+(+i.yaw).toFixed(4));
			return out;
		}, uuid);

	// ---- a 12 m terrain 5 m ahead, and the session on it ------------------------------------------------
	const uuid = await g(page, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Terrain 12 48');
		await new Promise((r) => setTimeout(r, 300));
		let sel;
		s.selectedObject.subscribe((x) => (sel = x))();
		sel.position.set(0, 0, -5);
		sel.updateMatrixWorld(true);
		return sel.uuid;
	});
	h.check(!!uuid, 'premise: a terrain');
	await iwer.enter(page);
	const menuHand = await g(page, () => {
		let v;
		window.__stores.vrMenuHand.subscribe((x) => (v = x))();
		return v;
	});
	const pointer = menuHand === 'right' ? 'left' : 'right';
	console.log(`menu hand ${menuHand}, pointer ${pointer}`);
	h.check(await g(page, (u) => window.__stores.vrSculpt.startVRSculpt(u), uuid), 'premise: a VR sculpt session on it');
	// the pointer hand aims down at the terrain ~2.5 m ahead (local (0, -2.5) on the terrain)
	const aim = (z = -2.5, x = 0) => iwer.pose(page, pointer, [x, 1.3, z + 0.75], { pitch: -1.05 });
	await aim();
	await iwer.frames(page, 4);
	/** a held trigger stroke over `frames`, the hand sweeping 40 cm sideways */
	const stroke = async (n = 24, z = -2.5) => {
		await aim(z, -0.2);
		await iwer.frames(page, 2);
		await iwer.button(page, pointer, 'trigger', true);
		for (let i = 0; i < n; i++) {
			await aim(z, -0.2 + (0.4 * i) / n);
			await iwer.frames(page, 1);
		}
		await iwer.button(page, pointer, 'trigger', false);
		await iwer.frames(page, 4);
	};

	console.log('\n=== 1. the wheels ===');
	const sculptRing = await ring('sculpt');
	h.check(sculptRing.join() === 'sculpt:raise,sculpt:lower,sculpt:smooth,sculpt:flatten,nav:sculpt-paint,nav:sculpt-scatter,sculpt:done', `1.1 the Sculpt ring: Raise · Lower · Smooth · Flatten · Paint ▸ · Scatter ▸ · Done (${sculptRing.join(' ')})`);
	const paintRing = await ring('sculpt-paint');
	h.check(paintRing.join() === 'sculpt:layer:0,sculpt:layer:1,sculpt:layer:2,sculpt:layer:3', `1.2 Paint ▸ = the four layers (${paintRing.join(' ')})`);
	const scatterRing = await ring('sculpt-scatter');
	h.check(scatterRing.join() === 'sculpt:tool:paint,sculpt:tool:erase,sculpt:tool:rotate,sculpt:tool:scale,sculpt:tool:relax,nav:sculpt-source', `1.3 Scatter ▸ = Paint · Erase · Rotate · Scale · Relax · Source ▸ (${scatterRing.join(' ')})`);

	console.log('\n=== 2. Paint ===');
	await menu('sculpt:layer:2');
	await iwer.frames(page, 3);
	let s = await sc();
	h.check(s.op === 'paint' && s.layer === 2, `2.1 Layer 3 from the wheel arms Paint on layer 3 (op ${s.op}, layer ${s.layer})`);
	const cur = await g(page, () => window.__stores.terrainSculpt.cursorDebug());
	h.check(cur?.visible && Math.abs(cur.radius - s.radius) < 1e-6 && Math.abs(cur.pos[2] - -2.5) < 0.3, `2.2 the ring sits on the terrain under the ray at the brush radius (r ${cur?.radius}, z ${cur?.pos?.[2]?.toFixed(2)})`);
	h.check(/^Paint 3 · \d/.test(s.label) && s.labelHand === pointer, `2.3 the hand label reads "${s.label}"`);
	let d0 = await digest(uuid);
	let u0 = await undoLen();
	const ticks0 = s.strokeTicks;
	await stroke();
	s = await sc();
	let d1 = await digest(uuid);
	h.check(d1 !== d0, '2.4 a trigger stroke paints the splat map');
	h.check((await undoLen()) === u0 + 1, `2.5 ONE undo entry for the stroke (${u0} -> ${await undoLen()})`);
	h.check(s.strokeTicks === ticks0 + 1, `2.6 the stroke started with a tick in the hand (${ticks0} -> ${s.strokeTicks})`);

	console.log('\n=== 3. the stick ===');
	await aim(); // off the stroke
	const r0 = s.radius;
	const st0 = s.strength;
	await iwer.stick(page, pointer, 1, 0);
	await iwer.frames(page, 40);
	await iwer.stick(page, pointer, 0, -1);
	await iwer.frames(page, 40);
	await iwer.stick(page, pointer, 0, 0);
	await iwer.frames(page, 3);
	s = await sc();
	h.check(s.radius > r0 + 0.3 && s.strength > st0 + 0.1, `3.1 stick right grows the brush, up raises the strength (r ${r0} -> ${s.radius}, ${st0} -> ${s.strength})`);

	console.log('\n=== 4. Scatter ===');
	await menu('sculpt:tool:paint');
	await iwer.frames(page, 3);
	const sources = await g(page, () => window.__stores.vrSculpt.vrSourceSlots().map((x) => x.label));
	h.check(['Sphere', 'Cone', 'Box'].every((p) => sources.includes(p)), `4.1 Source ▸ lists the primitives (${sources.join(', ')})`);
	await menu('sculpt:src:' + sources.indexOf('Sphere'));
	await iwer.frames(page, 4);
	s = await sc();
	h.check(s.op === 'scatter' && s.tool === 'paint' && s.source === 'Sphere', `4.2 Sphere from the wheel: scatter-painting spheres (${s.op}/${s.tool}/${s.source})`);
	h.check(/^Sphere · .*\/m²$/.test(s.label), `4.3 the label shows the density (${s.label})`);
	const den0 = s.density;
	await iwer.stick(page, pointer, 0, -1);
	await iwer.frames(page, 30);
	await iwer.stick(page, pointer, 0, 0);
	await iwer.frames(page, 3);
	s = await sc();
	h.check(s.density > den0 + 0.2, `4.4 while scatter-painting the stick's y is the density (${den0} -> ${s.density})`);
	let n0 = await instances(uuid);
	u0 = await undoLen();
	await stroke();
	let n1 = await instances(uuid);
	h.check(n1 > n0 + 3, `4.5 a stroke scatters spheres (${n0} -> ${n1})`);
	h.check((await undoLen()) === u0 + 1, '4.6 ONE undo entry');
	const y0 = await scatterYaws(uuid);
	await menu('sculpt:tool:rotate');
	await iwer.frames(page, 3);
	u0 = await undoLen();
	await stroke();
	const y1 = await scatterYaws(uuid);
	h.check(y1.length === y0.length && y1.some((v, i) => Math.abs(v - y0[i]) > 1e-3), '4.7 Rotate turns the instances under the brush');
	h.check((await undoLen()) === u0 + 1, '4.8 ONE undo entry');
	await menu('sculpt:tool:erase');
	await iwer.frames(page, 3);
	await stroke(40);
	const n2 = await instances(uuid);
	h.check(n2 < n1, `4.9 Erase removes them (${n1} -> ${n2})`);

	console.log('\n=== 5. in a miniature (the world at 1:10) ===');
	// the rig at 1:10 with the terrain's centre on a table 1 m ahead, 0.9 m up: local (0,0,-5) -> world (0, 0.9, -1)
	await g(page, () => {
		let rig;
		window.__stores.worldRig.subscribe((x) => (rig = x))();
		rig.scale.setScalar(0.1);
		rig.position.set(0, 0.9, -0.5);
		rig.updateMatrixWorld(true);
	});
	await menu('sculpt:layer:1');
	// the pointer over the table: world (0.1, 0.9, -1.1) -> terrain-local (1, 0, -1)
	await iwer.pose(page, pointer, [0.1, 1.25, -0.95], { pitch: -1.2 });
	await iwer.frames(page, 4);
	s = await sc();
	const mini = await g(page, () => window.__stores.terrainSculpt.cursorDebug());
	h.check(mini?.visible && Math.abs(mini.radius - s.radius * 0.1) < 1e-4, `5.1 the ring is drawn at a tenth (world r ${mini?.radius?.toFixed(3)} for a ${s.radius} m brush)`);
	// where the pointer's ray meets the terrain (world), and the ring's place in the terrain's own frame
	const probe = await g(page, (u) => {
		const st = window.__stores;
		const T = st.THREE;
		let grp, sc, r;
		st.objectsGroup.subscribe((x) => (grp = x))();
		st.globalScene.subscribe((x) => (sc = x))();
		st.globalRenderer.subscribe((x) => (r = x))();
		const o = grp.getObjectByProperty('uuid', u);
		let menuHand;
		st.vrMenuHand.subscribe((x) => (menuHand = x))();
		const want = menuHand === 'right' ? 'left' : 'right';
		const c = [r.xr.getController(0), r.xr.getController(1)].find((x) => x.userData.handedness === want);
		const origin = c.getWorldPosition(new T.Vector3());
		const dir = new T.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new T.Quaternion()));
		const hit = new T.Raycaster(origin, dir).intersectObject(o, false)[0];
		const ring = sc.getObjectByName('sculpt-cursor');
		return { hit: hit ? hit.point.toArray() : null, ring: ring.position.toArray(), local: o.worldToLocal(ring.position.clone()).toArray() };
	}, uuid);
	const local = probe.local;
	const off = probe.hit ? Math.hypot(probe.hit[0] - probe.ring[0], probe.hit[2] - probe.ring[2]) : 9;
	h.check(off < 0.01 && Math.abs(local[0] - 1) < 0.3, `5.2 the ring is where the ray meets the MODEL (${off.toFixed(4)} m off; terrain-local ${local.map((v) => v.toFixed(2))})`);
	d0 = await digest(uuid);
	u0 = await undoLen();
	await iwer.button(page, pointer, 'trigger', true);
	await iwer.frames(page, 12);
	await iwer.button(page, pointer, 'trigger', false);
	await iwer.frames(page, 4);
	d1 = await digest(uuid);
	h.check(d1 !== d0 && (await undoLen()) === u0 + 1, '5.3 a paint stroke in the miniature paints (one undo entry)');
	await menu('sculpt:tool:paint');
	n0 = await instances(uuid);
	await iwer.button(page, pointer, 'trigger', true);
	await iwer.frames(page, 16);
	await iwer.button(page, pointer, 'trigger', false);
	await iwer.frames(page, 4);
	n1 = await instances(uuid);
	const near = await g(page, (u) => {
		const out = [];
		const block = window.__stores.terrainPaint.scatterBlockNow(u);
		for (const set of block?.sets ?? []) for (const i of window.__stores.terrainPaint.scatterInstancesOf(u, set.id)) out.push([i.x, i.z]);
		return out;
	}, uuid);
	const fresh = near.filter(([x, z]) => Math.hypot(x - local[0], z - local[2]) <= s.radius + 0.5).length;
	h.check(n1 > n0 && fresh >= n1 - n0, `5.4 a scatter stroke in the miniature lands under the ray (${n1 - n0} new, ${fresh} within the brush of the ring)`);
	await menu('sculpt:done');
	await iwer.frames(page, 3);
	// placement: Add ▸ Cube 2 m ahead in REAL space
	const placed = await g(page, async () => {
		const s = window.__stores;
		s.vrControls.executeVRMenuAction('box');
		await new Promise((r) => setTimeout(r, 300));
		let sel, cam;
		s.selectedObject.subscribe((x) => (sel = x))();
		s.globalCamera.subscribe((x) => (cam = x))();
		const T = s.THREE;
		const w = sel.getWorldPosition(new T.Vector3());
		const c = cam.getWorldPosition(new T.Vector3());
		return { world: w.toArray(), cam: c.toArray(), local: sel.position.toArray(), worldScale: sel.getWorldScale(new T.Vector3()).x };
	});
	const dist = Math.hypot(placed.world[0] - placed.cam[0], placed.world[2] - placed.cam[2]);
	h.check(Math.abs(dist - 2) < 0.1 && Math.abs(placed.worldScale - 0.1) < 1e-6, `5.5 Add ▸ Cube in the miniature lands 2 m ahead, model-sized (${dist.toFixed(2)} m, world scale ${placed.worldScale})`);
	// objectsGroup rides the rig: local = (world - rig position) / 0.1
	const want = [placed.world[0] * 10, (placed.world[2] + 0.5) * 10];
	h.check(Math.hypot(placed.local[0] - want[0], placed.local[2] - want[1]) < 0.2, `5.6 ...at the model's own coordinates (local ${placed.local.map((v) => v.toFixed(1))})`);

	await iwer.exit(page);
	await h.finish(browser);
});
