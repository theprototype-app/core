// 52-browser — V4 on an EMULATED QUEST (IWER, iwer.cjs): the Asset Browser on the wrist, the drag-to-place
// ghost on the laser, and light hand tracking. Every row starts from the person's own gesture (Play, a real
// trigger / grip / stick on IWER's Touch Plus controllers, a real pinch on IWER's hands).
//   G. the laser ghost (absorbs f-vr-place): a prefab tile arms placeDrag's RAY mode — the ghost rides the
//      pointer hand's laser to the floor, the stick turns it 15° a flick, the TRIGGER places it as ONE
//      replicated undo step and it stays armed, a GRIP cancels with nothing spawned; in MINIATURE (the
//      world rig shrunk to 1:10 and moved) the ghost draws in the shrunk frame and the object lands at the
//      scene-unit spot under the laser
//   B. the wrist Asset Browser: Add ▸ Assets puts the panel on the OFF hand's wrist facing you; the laser
//      hovers its controls and the TRIGGER presses them (tabs, a pack, the search box -> the VR keyboard
//      filters as you type); a trigger-DRAG from a card drops the item where you let go (one object, one
//      undo); a trigger CLICK on a card arms it (the next trigger places, the grip stops); a GRIP lifts the
//      panel off the wrist and lets go of it PINNED and 1.6x bigger, a grip near the wrist puts it back
//      (the Pin / To wrist button too); Free CC0: a card downloads (progress on the card), lands in the
//      Library and rides the laser; My library lists it; one draw call for the whole panel
//   H. light hand tracking (IWER's tracked hands): a PINCH is the trigger — it presses a panel card, a
//      pinch held while the hand moves drops the item where the pinch lets go, a pinch-click arms it and the
//      next pinch places; a PRECISE tool (the sculpt brush) answers a pinch with "Pick up a controller" at
//      that hand and does nothing
//   P. the cost on the Quest 3 profile (IWER metaQuest3, CPU x4 like perf-games): the panel's frame hook,
//      its repaints while the laser sweeps the cards, and the laser ghost's frame hook, per XR frame — and
//      the meshes they add (the panel 1, a box ghost 3, the hand note 1). Headless says nothing about the
//      Quest GPU; the ms are the CPU side, which is what these hooks add.
// Run: APP_URL=https://theprototype.app:5484/ node tests/e2e/vr-asset-browser-iwer.test.cjs   (ONLY=G,… to pick rows)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const fs = require('fs');
const path = require('path');
const { makeCc0Network } = require('./cc0Fixtures.cjs');
const STATIC = path.join(__dirname, '../../static/library');
const SHOTS = process.env.SHOTS_DIR || '';
/** save the panel canvas as evidence (SHOTS_DIR=…) @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	const url = await page.evaluate(() => window.__stores.vrAssetBrowser.assetPanelImage());
	if (url) fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
}

/** the packs CDN answered from static/library (the place-drag recipe): the starter pack, Duck with dims */
async function routeStarterPack(page) {
	await page.route(/cdn\.jsdelivr\.net\/gh\/theprototype-app\/packs@[^/]+\/(.*)$/, (route) => {
		const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*packs@[^/]+\//, ''));
		if (rel === 'index.json')
			return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ name: 'default', title: 'The Prototype', value: 'default/default.json', attribution: 'default/attribution.html', copyright: '', license: '', source: 'https://github.com/theprototype-app/packs' }]) });
		const file = path.join(STATIC, rel);
		if (!file.startsWith(STATIC) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
		const type = /\.json$/.test(file) ? 'application/json' : /\.glb$/.test(file) ? 'model/gltf-binary' : /\.png$/.test(file) ? 'image/png' : 'text/html';
		return route.fulfill({ contentType: type, headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file) });
	});
}

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(row);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await routeStarterPack(page);
	const cc0 = makeCc0Network();
	await cc0.routes(page);
	const g = (fn, arg) => page.evaluate(fn, arg);
	const read = (name) => g((n) => { let v; window.__stores[n].subscribe((x) => (v = x))(); return v; }, name);
	const settle = (n = 6) => iwer.frames(page, n);
	const near = (a, b, tol = 0.02) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
	const count = () => g(() => new Promise((r) => window.__stores.objectsGroup.subscribe((grp) => r(grp.children.length))()));

	console.log('\n=== 0. enter VR on IWER ===');
	h.check(await iwer.installed(page), 'IWER owns navigator.xr before the app boots');
	const st0 = await iwer.enter(page);
	h.check(st0.presenting && st0.same, `Play presents the IWER session (${JSON.stringify(st0)})`);
	const menuHand = await read('vrMenuHand');
	const pointer = menuHand === 'right' ? 'left' : 'right';
	console.log(`menu hand ${menuHand}, pointer ${pointer}`);
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	await iwer.pose(page, menuHand, [menuHand === 'left' ? -0.25 : 0.25, 1.1, -0.2]);

	/** where the pointer hand's laser meets the objectsGroup frame's ground (y = 0), in that frame */
	const laserGround = () =>
		g((hand) => {
			const T = window.__stores.THREE;
			let r, grp;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			window.__stores.objectsGroup.subscribe((v) => (grp = v))();
			const c = [0, 1].map((i) => r.xr.getController(i)).find((x) => x.userData.handedness === hand);
			c.updateMatrixWorld(true);
			grp.updateWorldMatrix(true, false);
			const inv = grp.matrixWorld.clone().invert();
			const o = new T.Vector3().setFromMatrixPosition(c.matrixWorld);
			const d = new T.Vector3(0, 0, -1).applyMatrix4(new T.Matrix4().extractRotation(c.matrixWorld)).normalize();
			const local = new T.Ray(o, d).applyMatrix4(inv);
			const p = local.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), new T.Vector3());
			return p ? p.toArray() : null;
		}, pointer);

	// ---- G. the laser ghost ------------------------------------------------------------------------
	if (want('G')) {
		console.log('\n=== G. the drag-to-place ghost on the laser ===');
		// a prefab to place (Edit ▸ Save prefab), the scene emptied after so the laser meets the floor
		await g(async () => {
			window.__stores.commandsHandler.sceneCommand('/create box');
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const box = group.children[group.children.length - 1];
			box.name = 'GhostCrate';
			window.__stores.objectActions.selectObject(box);
			window.__stores.vrControls.executeVRMenuAction('obj:prefab');
		});
		await h.eventually(() => g(() => { let l; window.__stores.prefabs.prefabs.subscribe((x) => (l = x))(); return l.length; }), (n) => n >= 1, 'premise: a prefab in the library', 8000);
		await g(async () => {
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const box = group.children.find((c) => c.name === 'GhostCrate');
			window.__stores.objectActions.selectObject(box);
			window.__stores.objectActions.deleteSelection?.();
		});
		await settle();
		const n0 = await count();
		// open Add ▸ Prefabs and pick the tile (the panel's own action)
		await g(() => {
			window.__stores.vrMenuOpen.set(true);
			window.__stores.vrControls.executeVRMenuAction('prefabs');
			let l;
			window.__stores.prefabs.prefabs.subscribe((x) => (l = x))();
			window.__stores.vrControls.executeVRMenuAction('prefabs:select:' + l[0].id);
		});
		// the pointer hand aims down at the floor ~1.4 m ahead
		await iwer.pose(page, pointer, [pointer === 'left' ? -0.15 : 0.15, 1.2, -0.3], { pitch: -0.7 });
		await settle(8);
		const aim = await laserGround();
		const gh = await g(() => window.__stores.placeGhost.ghostInfo());
		const st = await g(() => window.__stores.placeDrag.state());
		h.check(st?.mode === 'ray' && gh.visible, `a prefab tile arms the laser ghost (mode ${st?.mode}, visible ${gh.visible})`);
		h.check(!!aim && near([gh.items[0].position[0], gh.items[0].position[2]], [aim[0], aim[2]], 0.03), `the ghost rides the laser to the floor (${gh.items[0]?.position.map((v) => v.toFixed(2))} vs ${aim?.map((v) => v.toFixed(2))})`);
		const lift = -(st?.items?.[0]?.dims?.box?.[1] ?? NaN);
		h.check(!!st?.items?.[0]?.dims?.known && Math.abs(gh.items[0].position[1] - lift) < 0.01, `it rests ON the floor: the measured prefab's bottom on y 0 (centre ${gh.items[0].position[1].toFixed(3)}, lift ${lift})`);

		// the stick turns it: a flick right = -15°
		await iwer.stick(page, pointer, 0.9, 0);
		await settle(4);
		await iwer.stick(page, pointer, 0, 0);
		await settle(4);
		const rot = (await g(() => window.__stores.placeDrag.state()))?.rotation;
		h.check(rot === 345, `a stick flick right turns the ghost 15° clockwise (rotation ${rot})`);
		const turnsDuring = await g(() => window.__stores.vrPlace.vrPlaceDebug().rotations);
		h.check(turnsDuring === 1, `one flick is one step (${turnsDuring})`);

		// the TRIGGER places it (the session's own selectstart), ONE undo step, and it stays armed
		const undo0 = await g(() => window.__stores.history.undoStack?.length ?? window.__stores.history.historyDepth?.() ?? null);
		await iwer.tap(page, pointer, 'trigger');
		await h.eventually(count, (n) => n === n0 + 1, 'the trigger places the prefab through the replicated path', 6000);
		const placed = await g(async () => {
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const o = group.children[group.children.length - 1];
			return { name: o.name, pos: o.position.toArray(), yaw: o.rotation.y };
		});
		h.check(placed.name === 'GhostCrate', `the placed object is the prefab (${placed.name})`);
		h.check(near([placed.pos[0], placed.pos[2]], [gh.items[0].position[0], gh.items[0].position[2]], 0.05), `it lands at the ghost spot (${placed.pos.map((v) => v.toFixed(2))})`);
		h.check(Math.abs(Math.abs(placed.yaw) - Math.PI / 12) < 0.01, `it lands turned as the ghost was (${((placed.yaw * 180) / Math.PI).toFixed(1)}°)`);
		const still = await g(() => window.__stores.vrPlace.vrPlaceDebug());
		h.check(still.active && still.placed === 1, `still armed for the next one (${JSON.stringify(still)})`);
		await g(() => window.__stores.history.undo());
		h.check((await count()) === n0, 'ONE undo removes the placement');
		if (undo0 != null) console.log('undo depth before', undo0);

		// MINIATURE: shrink the world rig to 1:10 and move it — the ghost draws in the shrunk frame and the
		// object lands at the scene-unit spot under the laser
		await g(() => {
			let rig;
			window.__stores.worldRig.subscribe((v) => (rig = v))();
			rig.scale.setScalar(0.1);
			rig.position.set(0.1, 0.8, -0.6);
			rig.updateMatrixWorld(true);
		});
		await iwer.pose(page, pointer, [pointer === 'left' ? -0.15 : 0.15, 1.2, -0.3], { pitch: -0.9 });
		await settle(8);
		const aimMini = await laserGround();
		const ghMini = await g(() => window.__stores.placeGhost.ghostInfo());
		const frameScale = ghMini.frame ? Math.hypot(ghMini.frame[0], ghMini.frame[1], ghMini.frame[2]) : 1;
		h.check(Math.abs(frameScale - 0.1) < 1e-3, `in miniature the ghost draws in the 1:10 frame (scale ${frameScale.toFixed(3)})`);
		h.check(!!aimMini && near([ghMini.items[0].position[0], ghMini.items[0].position[2]], [aimMini[0], aimMini[2]], 0.3), `the ghost sits under the laser in scene units (${ghMini.items[0]?.position.map((v) => v.toFixed(2))} vs ${aimMini?.map((v) => v.toFixed(2))})`);
		await iwer.tap(page, pointer, 'trigger');
		await h.eventually(count, (n) => n === n0 + 1, 'the trigger places in miniature too', 6000);
		const mini = await g(async () => {
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const o = group.children[group.children.length - 1];
			return { pos: o.position.toArray(), scale: o.scale.toArray() };
		});
		h.check(near([mini.pos[0], mini.pos[2]], [ghMini.items[0].position[0], ghMini.items[0].position[2]], 0.05), `the miniature placement lands at the ghost's scene-unit spot (${mini.pos.map((v) => v.toFixed(2))})`);
		h.check(near(mini.scale, [1, 1, 1], 1e-6), 'and at full scene size (the rig, not the object, is small)');
		await g(() => {
			let rig;
			window.__stores.worldRig.subscribe((v) => (rig = v))();
			rig.scale.setScalar(1);
			rig.position.set(0, 0, 0);
			rig.updateMatrixWorld(true);
		});

		// a GRIP cancels: nothing spawns, the ghost goes
		const before = await count();
		await iwer.tap(page, menuHand, 'squeeze');
		await settle(4);
		const after = await g(() => ({ active: window.__stores.vrPlace.vrPlaceDebug().active, ghost: !!window.__stores.placeGhost.ghostRoot(), last: window.__stores.vrPlace.vrPlaceDebug().lastEnd }));
		h.check(!after.active && !after.ghost && after.last === 'grip', `a grip cancels the ghost (${JSON.stringify(after)})`);
		h.check((await count()) === before, 'and nothing spawned');
		h.check((await g(() => { let v; window.__stores.vrControls.vrPrefabGhost.subscribe((x) => (v = x))(); return v; })) === null, 'the prefab window is no longer armed');
	}


	// ---- B. the wrist Asset Browser ----------------------------------------------------------------
	if (want('B')) {
		console.log('\n=== B. the Asset Browser on the wrist ===');
		const dbg = () => g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug());
		/** aim the pointer controller (from where it is) at a panel control, then let a few frames pass */
		const aimAt = async (id, from = [pointer === 'left' ? -0.12 : 0.12, 1.3, -0.15]) => {
			const pt = await g((cid) => window.__stores.vrAssetBrowser.assetControlPoint(cid), id);
			if (!pt) throw new Error('no control ' + id + ' on the panel: ' + JSON.stringify(await dbg()));
			const d = [pt[0] - from[0], pt[1] - from[1], pt[2] - from[2]];
			const yaw = Math.atan2(-d[0], -d[2]);
			const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
			await iwer.pose(page, pointer, from, { yaw, pitch });
			await settle(4);
			return { yaw, pitch };
		};
		const press = async (id) => {
			await aimAt(id);
			await iwer.tap(page, pointer, 'trigger');
			await settle(3);
		};
		await iwer.pose(page, 'head', [0, 1.6, 0]);
		await iwer.pose(page, menuHand, [menuHand === 'left' ? -0.18 : 0.18, 1.25, -0.3], { pitch: 0.3 });
		await iwer.pose(page, pointer, [pointer === 'left' ? -0.12 : 0.12, 1.3, -0.15]);
		// Add ▸ Assets (the sector's own action)
		await g(() => window.__stores.vrControls.executeVRMenuAction('assets'));
		await settle(8);
		let d = await dbg();
		h.check(d.open && d.visible && d.mode === 'wrist' && d.wristHand === menuHand, `Add ▸ Assets opens the panel on the ${menuHand} wrist (${JSON.stringify({ open: d.open, visible: d.visible, mode: d.mode, wrist: d.wristHand })})`);
		const geo = await g((hand) => {
			let r;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const T = window.__stores.THREE;
			const i = [0, 1].find((k) => r.xr.getController(k).userData.handedness === hand);
			const grip = r.xr.getControllerGrip(i).getWorldPosition(new T.Vector3());
			const head = r.xr.getCamera().getWorldPosition(new T.Vector3());
			let mesh;
			window.__stores.globalScene.subscribe((sc) => (mesh = sc.getObjectByName('vr-asset-browser')))();
			const p = mesh.getWorldPosition(new T.Vector3());
			const n = new T.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new T.Quaternion()));
			const toHead = head.clone().sub(p).normalize();
			let meshes = 0;
			mesh.traverse((o) => (o.isMesh ? meshes++ : 0));
			return { dist: p.distanceTo(grip), facing: n.dot(toHead), meshes };
		}, menuHand);
		h.check(geo.dist < 0.15, `it rides the wrist (${geo.dist.toFixed(3)} m from the grip)`);
		h.check(geo.facing > 0.8, `and faces the head (${geo.facing.toFixed(2)})`);
		h.check(geo.meshes === 1, `one mesh, one draw call for the whole panel (${geo.meshes})`);
		await h.eventually(async () => (await dbg()).cards.length, (n) => n >= 1, 'the Packs tab lists the packs', 10000);
		h.check((await dbg()).cards.includes('pack:default'), 'the starter pack is a card');
		await shot(page, '01-panel-packs');

		// hover + trigger: open the pack
		await aimAt('card:pack:default');
		await g(() => window.__stores.selectedObjects.set([]));
		d = await dbg();
		h.check(d.hover.includes('card:pack:default'), `the laser hovers the pack card (${d.hover})`);
		await iwer.tap(page, pointer, 'trigger');
		await h.eventually(async () => (await dbg()).cards, (c) => c.includes('item:default/Duck'), 'the trigger opens the pack: its items are cards', 10000);
		await settle(10);
		await shot(page, '02-panel-pack-items');
		const nSel = await g(() => new Promise((r) => window.__stores.selectedObjects.subscribe((v) => r(v.length))()));
		h.check(nSel === 0, `a press on the panel selects nothing behind it (${nSel})`);

		// search through the VR keyboard, filtering as you type
		await press('search');
		const kb = await g(() => { let v; window.__stores.vrKeyboard?.vrKeyboardTarget?.subscribe((x) => (v = x))(); return v ? v.title : null; });
		h.check(!!kb, `the search box opens the VR keyboard (${kb})`);
		await g(() => { for (const k of ['l', 'o', 'g']) window.__stores.vrControls.executeVRMenuAction('kbd:' + k); });
		await settle(3);
		d = await dbg();
		h.check(d.query === 'log' && d.cards.length === 1 && d.cards[0] === 'item:default/ThePrototypeLogo', `typing filters the cards as you type (${d.query}: ${d.cards})`);
		await g(() => window.__stores.vrControls.executeVRMenuAction('kbd:clear'));
		await g(() => window.__stores.vrControls.executeVRMenuAction('kbd:enter'));
		await settle(3);
		d = await dbg();
		h.check(d.query === '' && d.cards.includes('item:default/Duck'), `Enter commits (cleared: ${d.cards.length} cards)`);

		// a trigger-DRAG from the Duck card drops it where the trigger lets go
		const nB = await count();
		await aimAt('card:item:default/Duck');
		await iwer.button(page, pointer, 'trigger', 1);
		await settle(4);
		const drag = await g(() => window.__stores.vrPlace.vrPlaceDebug());
		h.check(drag.active && drag.current?.dragging, `pressing a card puts it on the laser, the trigger still down (${JSON.stringify(drag.current)})`);
		await iwer.pose(page, pointer, [pointer === 'left' ? -0.15 : 0.15, 1.2, -0.3], { pitch: -0.75 });
		await settle(6);
		const ghostAt = (await g(() => window.__stores.placeGhost.ghostInfo())).items[0]?.position;
		await iwer.button(page, pointer, 'trigger', 0);
		await settle(4);
		await h.eventually(count, (n) => n === nB + 1, 'letting go over the floor drops ONE Duck there', 8000);
		const duck = await g(async () => {
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const o = group.children[group.children.length - 1];
			return { pos: o.position.toArray(), ref: o.userData?.packRef?.item ?? null };
		});
		h.check(duck.ref === 'Duck' && near([duck.pos[0], duck.pos[2]], [ghostAt[0], ghostAt[2]], 0.05), `the Duck is the pack item, at the ghost (${duck.ref} ${duck.pos.map((v) => v.toFixed(2))})`);
		h.check(!(await g(() => window.__stores.vrPlace.vrPlaceDebug().active)), 'a drag places once (nothing still on the laser)');
		await g(() => window.__stores.history.undo());
		h.check((await count()) === nB, 'ONE undo takes the drop back');

		// a trigger CLICK on a card arms it: the next trigger places, it stays armed, the grip stops
		await press('card:item:default/Duck');
		const armed = await g(() => window.__stores.vrPlace.vrPlaceDebug());
		h.check(armed.active && !armed.current?.dragging, 'a click on a card arms it on the laser');
		d = await dbg();
		h.check(/trigger places/.test(d.status), `the panel says what the trigger does now (${d.status})`);
		await shot(page, '03-panel-placing');
		await iwer.pose(page, pointer, [pointer === 'left' ? -0.15 : 0.15, 1.2, -0.3], { pitch: -0.75 });
		await settle(6);
		await iwer.tap(page, pointer, 'trigger');
		await h.eventually(count, (n) => n === nB + 1, 'the next trigger places it', 8000);
		h.check((await g(() => window.__stores.vrPlace.vrPlaceDebug().active)), 'and it stays armed for another');
		await iwer.tap(page, menuHand, 'squeeze');
		await settle(3);
		h.check(!(await g(() => window.__stores.vrPlace.vrPlaceDebug().active)), 'a grip stops placing');

		// the GRIP lifts the panel off the wrist; let go away from it = pinned, bigger
		await aimAt('tab:packs');
		await iwer.button(page, pointer, 'squeeze', 1);
		await settle(3);
		h.check((await dbg()).mode === 'held', 'a grip with the laser on the panel takes it off the wrist');
		await iwer.pose(page, pointer, [pointer === 'left' ? -0.3 : 0.3, 1.45, -0.55]);
		await settle(10);
		await iwer.button(page, pointer, 'squeeze', 0);
		await settle(4);
		d = await dbg();
		h.check(d.mode === 'pinned' && Math.abs(d.scale - 1.6) < 0.05, `let go in the air: pinned, ${d.scale?.toFixed(2)}x`);
		const pinnedAt = d.position;
		await iwer.pose(page, menuHand, [menuHand === 'left' ? -0.18 : 0.18, 1.0, -0.1], { pitch: 0.3 });
		await settle(6);
		h.check(near((await dbg()).position, pinnedAt, 1e-6), 'a pinned panel stays put when the wrist moves');
		// carry it back to the wrist
		const carryAim = await aimAt('tab:packs', [pointer === 'left' ? -0.3 : 0.3, 1.2, 0.05]);
		await iwer.button(page, pointer, 'squeeze', 1);
		await settle(3);
		const wristNow = await g((hand) => {
			let r;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const T = window.__stores.THREE;
			const i = [0, 1].find((k) => r.xr.getController(k).userData.handedness === hand);
			return r.xr.getControllerGrip(i).localToWorld(new T.Vector3(0, 0.085, 0.05)).toArray();
		}, menuHand);
		const heldNow = await dbg();
		// the carrying controller in IWER's own space (a world displacement is the same there: no turn yet)
		const ctrl = await g((hand) => window.__iwer.device.controllers[hand].position.toArray?.() ?? [window.__iwer.device.controllers[hand].position.x, window.__iwer.device.controllers[hand].position.y, window.__iwer.device.controllers[hand].position.z], pointer);
		// move the carrying controller so the panel lands on the wrist spot
		const delta = wristNow.map((v, i) => v - heldNow.position[i]);
		await iwer.pose(page, pointer, ctrl.map((v, i) => v + delta[i]), carryAim);
		await settle(10);
		await iwer.button(page, pointer, 'squeeze', 0);
		await settle(4);
		d = await dbg();
		h.check(d.mode === 'wrist' && Math.abs(d.scale - 1) < 1e-6, `let go near the wrist: back on it (${d.mode}, ${d.scale})`);
		// the Pin / To wrist button
		await iwer.pose(page, menuHand, [menuHand === 'left' ? -0.18 : 0.18, 1.25, -0.3], { pitch: 0.3 });
		await settle(4);
		await press('pin');
		h.check((await dbg()).mode === 'pinned', 'Pin pins it in front of you');
		await press('pin');
		h.check((await dbg()).mode === 'wrist', 'To wrist puts it back');

		// Free CC0: download -> Library -> the laser
		await press('tab:free');
		await h.eventually(async () => (await dbg()).cards, (c) => c.some((k) => k.startsWith('cc0:')), 'the Free CC0 tab lists Poly Haven models', 10000);
		d = await dbg();
		const freeKey = d.cards.find((k) => k.startsWith('cc0:'));
		const nF = await count();
		await press('card:' + freeKey);
		await settle(10);
		await shot(page, '04-panel-free');
		await h.eventually(() => g(() => window.__stores.vrPlace.vrPlaceDebug().active), (v) => v === true, `a free model downloads into the Library and rides the laser (${freeKey})`, 20000);
		await iwer.pose(page, pointer, [pointer === 'left' ? -0.15 : 0.15, 1.2, -0.3], { pitch: -0.75 });
		await settle(6);
		await iwer.tap(page, pointer, 'trigger');
		await h.eventually(count, (n) => n === nF + 1, 'the trigger places the downloaded model', 15000);
		await iwer.tap(page, menuHand, 'squeeze');
		await settle(3);
		await press('tab:library');
		await h.eventually(async () => (await dbg()).cards, (c) => c.some((k) => k.startsWith('lib:')) && c.some((k) => k.startsWith('prefab:')), 'My library lists the downloaded model and the prefab', 8000);
		await settle(10);
		await shot(page, '05-panel-library');
		await press('close');
		h.check(!(await dbg()).open, '✕ closes the panel');
	}


	// ---- H. light hand tracking ----------------------------------------------------------------------
	if (want('H')) {
		console.log('\n=== H. hands: pinch = trigger, pinch-drag = the ghost, precise tools ask for a controller ===');
		const hdbg = () => g(() => window.__stores.vrHands.handInputDebug());
		await g(() => (window.__iwer.device.primaryInputMode = 'hand'));
		await settle(10);
		await h.eventually(async () => (await hdbg()).sources.join(), (v) => /left:hand/.test(v) && /right:hand/.test(v), 'IWER switches to tracked hands (no controllers)', 8000);
		const handPose = async (hand, pos, aim = {}) =>
			g(({ hand, pos, aim }) => {
				const t = window.__iwer.device.hands[hand];
				t.position.set(pos[0], pos[1], pos[2]);
				const cy = Math.cos((aim.yaw ?? 0) / 2), sy = Math.sin((aim.yaw ?? 0) / 2);
				const cp = Math.cos((aim.pitch ?? 0) / 2), sp = Math.sin((aim.pitch ?? 0) / 2);
				t.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
			}, { hand, pos, aim });
		const pinch = (hand, v) => g(({ hand, v }) => window.__iwer.device.hands[hand].updatePinchValue(v), { hand, v });
		/** the app's ray of a hand (where three put the target-ray group) */
		const appRay = (hand) =>
			g((hand) => {
				let r;
				window.__stores.globalRenderer.subscribe((v) => (r = v))();
				const T = window.__stores.THREE;
				const c = [0, 1].map((i) => r.xr.getController(i)).find((x) => x.userData.handedness === hand);
				c.updateMatrixWorld(true);
				const o = new T.Vector3().setFromMatrixPosition(c.matrixWorld);
				const d = new T.Vector3(0, 0, -1).applyMatrix4(new T.Matrix4().extractRotation(c.matrixWorld));
				return { o: o.toArray(), d: d.toArray() };
			}, hand);
		/** aim the pointing hand's RAY at a world point: pose, read the ray three derived, correct the aim */
		const aimHandAt = async (target, from) => {
			let yaw = Math.atan2(-(target[0] - from[0]), -(target[2] - from[2]));
			let pitch = Math.atan2(target[1] - from[1], Math.hypot(target[0] - from[0], target[2] - from[2]));
			for (let k = 0; k < 4; k++) {
				await handPose(pointer, from, { yaw, pitch });
				await settle(3);
				const ray = await appRay(pointer);
				const want = target.map((v, i) => v - ray.o[i]);
				const wy = Math.atan2(-want[0], -want[2]);
				const wp = Math.atan2(want[1], Math.hypot(want[0], want[2]));
				const hy = Math.atan2(-ray.d[0], -ray.d[2]);
				const hp = Math.atan2(ray.d[1], Math.hypot(ray.d[0], ray.d[2]));
				yaw += wy - hy;
				pitch += wp - hp;
			}
			await handPose(pointer, from, { yaw, pitch });
			await settle(3);
		};
		const dbg = () => g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug());
		await handPose(menuHand, [menuHand === 'left' ? -0.18 : 0.18, 1.25, -0.3], { pitch: 0.3 });
		const fromH = [pointer === 'left' ? -0.12 : 0.12, 1.3, -0.12];
		await handPose(pointer, fromH);
		await g(() => window.__stores.vrControls.executeVRMenuAction('assets'));
		await settle(8);
		const aimCtl = async (id) => {
			const pt = await g((cid) => window.__stores.vrAssetBrowser.assetControlPoint(cid), id);
			if (!pt) throw new Error('no control ' + id + ': ' + JSON.stringify(await dbg()));
			await aimHandAt(pt, fromH);
		};
		const pinchTap = async () => {
			await pinch(pointer, 1);
			await settle(4);
			await pinch(pointer, 0);
			await settle(4);
		};
		let d = await dbg();
		h.check(d.open && d.visible, `the panel opens with hands too (${d.mode}, wrist ${d.wristHand})`);
		await aimCtl('tab:packs');
		await pinchTap();
		await h.eventually(async () => (await dbg()).cards, (c) => c.includes('pack:default') || c.includes('item:default/Duck'), 'a PINCH presses a tab (pinch = trigger)', 8000);
		d = await dbg();
		if (!d.cards.includes('item:default/Duck')) {
			await aimCtl('card:pack:default');
			await pinchTap();
			await h.eventually(async () => (await dbg()).cards, (c) => c.includes('item:default/Duck'), 'a pinch opens the pack', 8000);
		}
		// pinch-DRAG: pinch the Duck, move the hand to the floor, let go
		const n0 = await count();
		await aimCtl('card:item:default/Duck');
		await pinch(pointer, 1);
		await settle(4);
		const held = await g(() => window.__stores.vrPlace.vrPlaceDebug());
		h.check(held.active && held.current?.dragging, `a pinch on a card puts it on the hand's ray, the pinch still held (${JSON.stringify(held.current)})`);
		d = await dbg();
		h.check(/let go over the world/.test(d.status), `the panel speaks hands (${d.status})`);
		// a clear stretch of floor on the pointing hand's own side (the wrist panel is on the other; the
		// earlier rows left their placements straight ahead)
		const side = pointer === 'left' ? -1 : 1;
		await aimHandAt([0.9 * side, 0, -0.9], fromH);
		await settle(4);
		const ghostH = (await g(() => window.__stores.placeGhost.ghostInfo())).items[0]?.position;
		await pinch(pointer, 0);
		await settle(4);
		await h.eventually(count, (n) => n === n0 + 1, 'releasing the pinch over the floor drops ONE Duck', 8000);
		const where = await g(async () => {
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			return group.children[group.children.length - 1].position.toArray();
		});
		h.check(!!ghostH && near(where, ghostH, 0.02), `it lands at the ghost the hand's ray showed (${where.map((v) => v.toFixed(2))} vs ${ghostH?.map((v) => v.toFixed(2))})`);
		// pinch-click arms; the next pinch places
		await aimCtl('card:item:default/Duck');
		await pinchTap();
		h.check((await g(() => window.__stores.vrPlace.vrPlaceDebug())).active, 'a pinch-click arms the card');
		d = await dbg();
		h.check(/pinch to place/.test(d.status), `and says so for a hand (${d.status})`);
		await aimHandAt([0.6 * side, 0, -1.4], fromH);
		await pinchTap();
		await h.eventually(count, (n) => n === n0 + 2, 'the next pinch places it', 8000);
		await g(() => window.__stores.vrPlace.cancelVRPlace('test'));
		await g(() => window.__stores.vrAssetBrowser.closeVRAssetBrowser());

		// a precise tool: the sculpt brush asks for a controller
		const sc = () => g(() => window.__stores.vrSculpt.vrSculptDebug());
		await g(() => {
			const s = window.__stores;
			s.vrMenuOpen.set(true);
			s.vrControls.executeVRMenuAction('nav:add');
			s.vrControls.executeVRMenuAction('terrain');
		});
		await h.eventually(sc, (x) => x.active && !!x.uuid, 'premise: Add ▸ Terrain starts a VR sculpt session', 8000);
		await g(() => window.__stores.vrMenuOpen.set(false));
		const terr = await g(() => {
			let grp;
			window.__stores.objectsGroup.subscribe((x) => (grp = x))();
			const t = grp.children.find((c) => c.userData?.terrain);
			t.updateMatrixWorld(true);
			const e = t.matrixWorld.elements;
			return [e[12], e[13], e[14]];
		});
		await aimHandAt(terr, fromH);
		const strokes0 = (await sc()).strokes ?? null;
		await pinchTap();
		const note = await hdbg();
		const strokes1 = (await sc()).strokes ?? null;
		h.check(note.note?.text === 'Pick up a controller to sculpt' && note.note?.hand === pointer, `a pinch on the brush says "Pick up a controller" at that hand (${JSON.stringify(note.note)})`);
		h.check(note.chipVisible, 'the note is drawn by the hand');
		h.check(strokes0 != null && strokes0 === strokes1, `and no stroke ran (${strokes0} -> ${strokes1})`);
		await g(() => window.__stores.vrControls.executeVRMenuAction('sculpt:done'));
		await g(() => (window.__iwer.device.primaryInputMode = 'controller'));
		await settle(10);
	}


	// ---- P. the cost on the Quest 3 profile -------------------------------------------------------------
	if (want('P')) {
		console.log('\n=== P. frame cost (IWER Quest 3 profile, CPU x4) ===');
		await iwer.pose(page, 'head', [0, 1.6, 0]);
		await iwer.pose(page, menuHand, [menuHand === 'left' ? -0.18 : 0.18, 1.25, -0.3], { pitch: 0.3 });
		const from = [pointer === 'left' ? -0.12 : 0.12, 1.3, -0.15];
		await iwer.pose(page, pointer, from);
		await g(() => {
			const ab = window.__stores.vrAssetBrowser;
			if (!ab.vrAssetBrowserDebug().open) ab.openVRAssetBrowser();
		});
		await settle(6);
		await g(() => window.__stores.vrAssetBrowser.pressAssetButton('tab:free'));
		await h.eventually(() => g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug().cards.length), (n) => n > 0, 'premise: the Free tab lists models', 10000);
		const aimAtCtl = async (id) => {
			const pt = await g((cid) => window.__stores.vrAssetBrowser.assetControlPoint(cid), id);
			const dd = [pt[0] - from[0], pt[1] - from[1], pt[2] - from[2]];
			await iwer.pose(page, pointer, from, { yaw: Math.atan2(-dd[0], -dd[2]), pitch: Math.atan2(dd[1], Math.hypot(dd[0], dd[2])) });
		};
		const cards = (await g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug())).cards;
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
		const p0 = await g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug().perf);
		const t0 = Date.now();
		const draws0 = (await g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug())).draws;
		// the laser sweeps the cards: every hop is a hover change = a repaint + a texture upload
		for (let k = 0; k < 12; k++) {
			await aimAtCtl('card:' + cards[k % cards.length]);
			await settle(5);
		}
		const p1 = await g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug().perf);
		const draws1 = (await g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug())).draws;
		// the ghost on the laser (a library model armed), the laser on the floor
		await g(() => window.__stores.vrAssetBrowser.pressAssetButton('tab:library'));
		await settle(4);
		const lib = (await g(() => window.__stores.vrAssetBrowser.vrAssetBrowserDebug())).cards.find((k) => k.startsWith('lib:') || k.startsWith('prefab:'));
		await g((k) => window.__stores.vrAssetBrowser.pressAssetButton('card:' + k), lib);
		await iwer.pose(page, pointer, [from[0], 1.2, -0.3], { pitch: -0.75 });
		const r0 = await g(() => window.__stores.vrPlace.vrPlaceDebug());
		await settle(60);
		const r1 = await g(() => window.__stores.vrPlace.vrPlaceDebug());
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		const meshes = await g(() => {
			let sc;
			window.__stores.globalScene.subscribe((v) => (sc = v))();
			const count = (o) => {
				let n = 0;
				o?.traverse((x) => ((x.isMesh || x.isLineSegments) && x.visible ? n++ : 0));
				return n;
			};
			return { panel: count(sc.getObjectByName('vr-asset-browser')), ghost: count(window.__stores.placeGhost.ghostRoot()) };
		});
		await g(() => window.__stores.vrPlace.cancelVRPlace('test'));
		const panelMs = (p1.frameMs - p0.frameMs) / Math.max(1, p1.frames - p0.frames);
		const paintMs = (p1.paintMs - p0.paintMs) / Math.max(1, draws1 - draws0);
		const ghostMs = (r1.frameMs - r0.frameMs) / Math.max(1, r1.frames - r0.frames);
		const result = {
			profile: 'IWER metaQuest3, CPU x4 (Emulation.setCPUThrottlingRate)',
			panelFrameMs: +panelMs.toFixed(3),
			panelFrames: p1.frames - p0.frames,
			repaints: draws1 - draws0,
			paintMsPerRepaint: +paintMs.toFixed(3),
			ghostFrameMs: +ghostMs.toFixed(3),
			ghostFrames: r1.frames - r0.frames,
			meshes,
			wallSeconds: (Date.now() - t0) / 1000
		};
		console.log('PERF ' + JSON.stringify(result));
		if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'perf-quest3-cpu4.json'), JSON.stringify(result, null, 2));
		h.check(result.panelFrames > 20 && panelMs < 1.5, `the panel's frame hook costs ${panelMs.toFixed(3)} ms/frame at CPU x4 (budget 13.9 / 11.1 ms per frame at 72 / 90 Hz)`);
		h.check(result.repaints >= 6 && paintMs < 8, `a repaint (the laser moving card to card) costs ${paintMs.toFixed(2)} ms at CPU x4, only when the view changes (${result.repaints} repaints)`);
		h.check(result.ghostFrames > 20 && ghostMs < 3, `the laser ghost costs ${ghostMs.toFixed(3)} ms/frame at CPU x4`);
		h.check(meshes.panel === 1 && meshes.ghost <= 4, `draw calls added: the panel ${meshes.panel}, the ghost ${meshes.ghost}`);
	}

	await iwer.exit(page);
	await h.finish(browser);
});
