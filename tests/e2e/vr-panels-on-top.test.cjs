// 31 K2 (U4) — VR PANELS ARE NEVER HIDDEN. The user, on a Quest 3: "menu buttons during game
// covered by scene objects below untangle (like base/floor objects)". A panel was a mesh like
// any other, so whatever stood between the eyes and it covered its buttons — while the laser,
// which prefers a panel, still pressed them.
//
// vrPanelOverlay: every open panel joins the transparent list at PANEL_ORDER after ONE depth
// clear (a sentinel's onBeforeRender), so it draws over the finished scene and still
// depth-tests against other panels. Read with PIXELS (the metric the bug changes), with a
// RED unlit box parked between the camera and each panel:
// 1 the radial ring (a svelte panel) shows through the box · 2 the VR game board does, and
// the laser — aimed THROUGH the box — ends on the board and its trigger presses Start ·
// 3 a module's own panel made with api.vrPanel does, and ends the beam · 4 the sentinel ran,
// and leaves the scene when no panel is open.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(async () => {
		const s = window.__stores;
		s.viewModeCtl?.viewMode?.set?.('shaded');
		await s.moduleSDK.initModules([
			{ id: 'ontop31', name: 'On top', version: '1.0.0', description: '31 K2', register(api) { window.__api = api; } }
		]);
	});
	await xr.install(page);
	// park both controllers far off, aiming up: a ray on the ring would HOVER it, and the hover
	// orange (#ff4000) sits inside the red tolerance this suite reads
	await xr.pose(page, 'left', [-20, 30, 20], { pitch: 1.4 });
	await xr.pose(page, 'right', [20, 30, 20], { pitch: 1.4 });
	const settle = (ms = 400) => page.waitForTimeout(ms);

	// a RED unlit box and the camera looking through it at `at`
	const blocker = (at, from, size) =>
		page.evaluate(
			async ({ at, from, size }) => {
				const s = window.__stores;
				const THREE = s.THREE;
				// in objectsGroup: real scene content, so the BEAM meets it too (a scene-root helper
				// is no beam target, and the panel-priority guard would go unexercised)
				let scene;
				s.objectsGroup.subscribe((v) => (scene = v))();
				let box = scene.getObjectByName('k2-blocker');
				if (!box) {
					box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false }));
					box.name = 'k2-blocker';
					scene.add(box);
				}
				box.scale.setScalar(size);
				// halfway between the camera and the target
				box.position.set((at[0] + from[0]) / 2, (at[1] + from[1]) / 2, (at[2] + from[2]) / 2);
				box.updateMatrixWorld(true);
				s.objectActions.flyTo(from, at, 0);
				return box.position.toArray();
			},
			{ at, from, size }
		);
	// fraction of a small square around `at` that is NOT the blocker's red
	const notRed = async (at) => {
		await settle(500);
		const p = await h.projectPoint(page, at);
		const frame = await page.screenshot({ clip: { x: Math.round(p.x - 6), y: Math.round(p.y - 6), width: 12, height: 12 } });
		return (await h.framePixelsOffColor(page, frame, [255, 0, 0], 70)).fraction;
	};

	console.log('\n=== 1 the radial ring over a box ===');
	// the ring sits at the origin facing +z when no real session poses it
	await page.evaluate(() => window.__stores.vrMenuOpen.set(true));
	await settle();
	// counter-premise: the same box hides a plain mesh at the same place
	await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const plain = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
		plain.name = 'k2-plain';
		plain.position.set(3, 0, 0);
		scene.add(plain);
	});
	await blocker([3, 0, 0], [3, 0, 0.8], 0.05);
	const plainOff = await notRed([3, 0, 0]);
	h.check(plainOff < 0.2, `premise: the box hides an ordinary mesh behind it (${plainOff.toFixed(2)} not red)`);
	await blocker([0, 0, 0], [0, 0, 0.8], 0.05);
	const ringOff = await notRed([0, 0, 0]);
	const hov = await page.evaluate(() => { let v; window.__stores.vrControls.vrHovered.subscribe((x) => (v = x))(); return v; });
	h.check(hov === null, `premise: nothing on the ring is hovered (${hov})`);
	h.check(ringOff > 0.8, `the radial ring draws OVER the box in front of it (${ringOff.toFixed(2)} not red)`);
	await page.evaluate(() => window.__stores.vrMenuOpen.set(false));

	console.log('\n=== 2 the VR game board over a box, and the laser presses through it ===');
	await page.evaluate(() => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor('scene', {
			active: '',
			screens: [
				{
					id: 'menu', name: 'Menu', showWhile: 'menu', input: 'menu',
					elements: [{ id: 'start', kind: 'button', anchor: 'center', x: 0, y: 0, w: 420, h: 160, label: 'Start', style: { bg: '#2563eb', size: 40 } }]
				}
			]
		});
		s.gameState.setGameState('menu');
		s.hudActions.addBinding('start', 'start');
		s.objectActions.setEditorMode('interact');
	});
	const board = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const k = s.gameKit.vrGamePanel;
		k.vrGamePanelFrame({ head: { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() }, hands: [null, null] });
		const surf = k.vrGameSurface('vr-game-panel');
		const rect = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === 'start');
		const g = surf.mesh.geometry.parameters;
		const at = surf.mesh.localToWorld(new THREE.Vector3(((rect.x + rect.w / 2) / surf.canvas.width - 0.5) * g.width, (0.5 - (rect.y + rect.h / 2) / surf.canvas.height) * g.height, 0));
		return { at: at.toArray(), order: surf.mesh.renderOrder };
	});
	await blocker(board.at, [board.at[0], board.at[1], board.at[2] + 1.4], 0.08);
	const boardOff = await notRed(board.at);
	h.check(boardOff > 0.8, `the game board's Start draws OVER the box (${boardOff.toFixed(2)} not red, order ${board.order})`);
	// the laser from behind the box: the beam ends on the board, and the trigger presses Start
	const press = await page.evaluate(async (at) => {
		const s = window.__stores;
		const THREE = s.THREE;
		const r = window.__fakeXR.renderer;
		const c = r.xr.getController(1);
		const from = new THREE.Vector3(at[0], at[1], at[2] + 1.4);
		const m = new THREE.Matrix4().lookAt(from, new THREE.Vector3(...at), new THREE.Vector3(0, 1, 0));
		c.matrix.compose(from, new THREE.Quaternion().setFromRotationMatrix(m), new THREE.Vector3(1, 1, 1));
		c.updateMatrixWorld(true);
		await new Promise((res) => setTimeout(res, 250));
		let beam = null;
		c.traverse((o) => { if (o.name === 'vr-ray') beam = o; });
		const length = beam.scale.z;
		const order = beam.renderOrder;
		s.vrControls.vrModuleTriggerStart(1);
		s.vrControls.vrModuleSelectSwallowed();
		s.vrControls.vrModuleTriggerEnd(1);
		await new Promise((res) => setTimeout(res, 300));
		let state;
		s.gameState.gameState.subscribe((v) => (state = v.state))();
		return { length, order, state };
	}, board.at);
	h.check(Math.abs(press.length - 1.4) < 0.03, `the beam passes the box and ends on the board (${press.length.toFixed(3)} m)`);
	h.check(press.order > board.order, `on a panel the beam draws after it (order ${press.order})`);
	h.check(press.state === 'playing', `the trigger presses Start through the box (${press.state})`);
	await page.evaluate(() => {
		const s = window.__stores;
		s.gameKit.vrGamePanel.hideVrGamePanel();
		s.objectActions.setEditorMode('edit');
		s.gameState.setGameState('menu');
	});

	console.log('\n=== 3 a module panel made with api.vrPanel ===');
	const mod = await page.evaluate(() => {
		const s = window.__stores;
		const api = window.__api;
		const THREE = api.THREE;
		const g = new THREE.Group();
		g.name = 'k2-module-bar';
		const m = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.12), new THREE.MeshBasicMaterial({ color: 0x00ff66 }));
		g.add(m);
		g.position.set(-3, 1, 0);
		api.scene().add(g);
		const off = api.vrPanel(g);
		return { has: typeof api.vrPanel, off: typeof off, order: m.renderOrder };
	});
	h.check(mod.has === 'function' && mod.off === 'function', 'api.vrPanel exists and returns an undo');
	await blocker([-3, 1, 0], [-3, 1, 0.8], 0.05);
	const modOff = await notRed([-3, 1, 0]);
	h.check(modOff > 0.8, `the module's panel draws OVER the box (${modOff.toFixed(2)} not red, order ${mod.order})`);
	const modBeam = await page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const c = window.__fakeXR.renderer.xr.getController(1);
		const from = new THREE.Vector3(-3, 1, 0.9);
		const m = new THREE.Matrix4().lookAt(from, new THREE.Vector3(-3, 1, 0), new THREE.Vector3(0, 1, 0));
		c.matrix.compose(from, new THREE.Quaternion().setFromRotationMatrix(m), new THREE.Vector3(1, 1, 1));
		c.updateMatrixWorld(true);
		await new Promise((res) => setTimeout(res, 250));
		let beam = null;
		c.traverse((o) => { if (o.name === 'vr-ray') beam = o; });
		return beam.scale.z;
	});
	h.check(Math.abs(modBeam - 0.9) < 0.03, `the beam passes the box and ends on the module panel (${modBeam.toFixed(3)} m)`);

	console.log('\n=== 4 the sentinel ===');
	const sent = await page.evaluate(() => window.__stores.vrControls.panelOverlayDebug());
	h.check(sent.clears > 0 && sent.visible, `the depth clear ran while panels were open (${sent.clears} clears)`);
	await page.evaluate(() => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		scene.remove(scene.getObjectByName('k2-module-bar'));
	});
	await settle();
	const after = await page.evaluate(() => window.__stores.vrControls.panelOverlayDebug());
	h.check(!after.visible, 'no panel open: the sentinel stands down (the frame is the old frame)');

	await xr.uninstall(page);
	await h.finish(browser);
});
