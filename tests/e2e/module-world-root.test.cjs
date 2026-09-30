// 30b P5: MODULE CONTENT FOLLOWS THE WORLD. The Quest report: "When I spin the world
// around, the untangled dots do not spin around." The VR world gestures transform the
// `world-grab-rig` group; module viewport content lived at the SCENE ROOT (golden rule 5
// keeps it out of objectsGroup), outside the rig, so it stayed pinned to the room. Every
// REGISTERED module group is now re-homed under `module-world-root` inside the rig — for
// every module at once — while staying out of objectsGroup (nothing replicates or saves),
// and the module's own `scene.remove(group)` / `getObjectByName` keep working.
// Driven with an INLINE module through the real SDK (moduleSDK.initModules).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// a module that builds a board (registered BEFORE it is added) and a late board
	// (added first, registered after), plus a stray group it never registers
	await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const mod = {
			id: 'worldroottest',
			name: 'World root test',
			version: '1',
			register(api) {
				window.__wrApi = api;
				api.registerInteractiveGroup('wr-board');
				const scene = api.scene();
				const board = new THREE.Group();
				board.name = 'wr-board';
				board.userData.play = { grounded: true };
				const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshBasicMaterial());
				dot.name = 'wr-dot';
				dot.position.set(1, 1, 0);
				board.add(dot);
				scene.add(board);
				const late = new THREE.Group();
				late.name = 'wr-late';
				scene.add(late);
				api.registerListedGroup('wr-late', { label: 'Late board' });
				const stray = new THREE.Group();
				stray.name = 'wr-stray';
				scene.add(stray);
			}
		};
		s.moduleSDK.initModules([mod]);
	});
	await A.page.waitForTimeout(300);

	const read = () =>
		A.page.evaluate(() => {
			const s = window.__stores;
			const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
			const scene = get(s.globalScene);
			const THREE = s.THREE;
			const board = scene.getObjectByName('wr-board');
			const late = scene.getObjectByName('wr-late');
			const stray = scene.getObjectByName('wr-stray');
			const dot = scene.getObjectByName('wr-dot');
			let inObjects = false;
			get(s.objectsGroup).traverse((n) => { if (n.name === 'wr-board') inObjects = true; });
			return {
				board: board?.parent?.name ?? null,
				late: late?.parent?.name ?? null,
				stray: stray?.parent === scene ? 'scene' : stray?.parent?.name ?? null,
				dotWorld: dot ? dot.getWorldPosition(new THREE.Vector3()).toArray() : null,
				inObjects,
				publishers: s.playSettings.playPublishers(scene).map((p) => p.name)
			};
		});

	// ---- 1. registered groups are re-homed inside the rig; the stray one is not -------------------
	let r = await read();
	h.check(r.board === 'module-world-root', `a registered group lands under the world rig's module root (${r.board})`);
	h.check(r.late === 'module-world-root', `...also when it was added BEFORE its name was registered (${r.late})`);
	h.check(r.stray === 'scene', `an UNREGISTERED scene-root group stays where it was put (${r.stray})`);
	h.check(!r.inObjects, 'golden rule 5: module content never enters objectsGroup');
	const rigParent = await A.page.evaluate(() => {
		let v;
		window.__stores.globalScene.subscribe((x) => (v = x))();
		return v.getObjectByName('module-world-root')?.parent?.name ?? null;
	});
	h.check(rigParent === 'world-grab-rig', `the module root is a child of the world rig (${rigParent})`);
	h.check(r.dotWorld && Math.abs(r.dotWorld[0] - 1) < 1e-6 && Math.abs(r.dotWorld[1] - 1) < 1e-6, `at 1:1 nothing moved (dot at ${r.dotWorld})`);
	h.check(r.publishers.includes('wr-board'), `a re-homed group still publishes the play contract (${r.publishers})`);

	// ---- 2. spin + scale the world: the dot goes with it --------------------------------------------
	await A.page.evaluate(() => {
		const s = window.__stores;
		let rig;
		s.worldRig.subscribe((x) => (rig = x))();
		rig.quaternion.setFromAxisAngle(new s.THREE.Vector3(0, 1, 0), Math.PI / 2);
		rig.scale.setScalar(2);
		rig.updateMatrixWorld(true);
	});
	r = await read();
	// R(90deg about +Y) maps (1,1,0) to (0,1,-1); scale 2 -> (0,2,-2)
	h.check(
		r.dotWorld && Math.abs(r.dotWorld[0]) < 1e-6 && Math.abs(r.dotWorld[1] - 2) < 1e-6 && Math.abs(r.dotWorld[2] + 2) < 1e-6,
		`the world spun and scaled: the module's dot followed (${r.dotWorld.map((v) => v.toFixed(3))})`
	);
	await A.page.evaluate(() => window.__stores.vrControls.resetWorldRig());

	// ---- 3. the Module content list still lists it ------------------------------------------------------
	const rows = await A.page.evaluate(() => window.__stores.moduleWorld.moduleWorldDebug().rows);
	h.check(rows.includes('wr-board') && rows.includes('wr-late'), `the object list's Module content rows still find both (${rows})`);

	// ---- 4. the module's own scene.remove(group) still takes it out ---------------------------------
	const removed = await A.page.evaluate(() => {
		const scene = window.__wrApi.scene();
		const late = scene.getObjectByName('wr-late');
		scene.remove(late);
		return { gone: !scene.getObjectByName('wr-late'), parent: late.parent };
	});
	h.check(removed.gone && removed.parent === null, 'api.scene().remove(group) removes a re-homed group');

	// ---- 5. disabling the module takes its content away ---------------------------------------------------
	await A.page.evaluate(() => {
		window.__stores.moduleSDK.deactivateModule('worldroottest');
		const scene = window.__wrApi.scene();
		scene.remove(scene.getObjectByName('wr-stray'));
	});
	await A.page.waitForTimeout(200);
	r = await read();
	h.check(r.board === null, `deactivating the module removes its re-homed group (${r.board})`);

	await h.finish(browser);
});
