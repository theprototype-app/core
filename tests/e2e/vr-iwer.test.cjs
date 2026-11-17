// 48 G2 — THE VR ROWS ON A REAL (EMULATED) HEADSET: IWER (Meta's Immersive Web Emulation Runtime, iwer.cjs).
// The vr-* suites before this drove fakeXR (renderer.xr.getSession patched, controller MATRICES written by
// hand): three never presented, the XR camera never followed a head, a trigger never became a session
// `select`. Here navigator.xr IS a Quest 3 and every row starts with the person's own gesture — Play.
//   0. the harness: Play asks IWER for immersive-vr, three presents THAT session, the XR camera follows the
//      emulated head and the controller groups follow the emulated controllers
//   R. radial menu: the menu button (B on the menu hand) opens the ring by the menu controller; the stick
//      picks a sector, the stick press runs it (a ▸ sector opens its ring); the button closes it
//   S. VR sculpt: Add > Terrain starts a sculpt session; the pointer controller aimed down at it puts the
//      brush ring there; HOLDING THE TRIGGER (the session's own selectstart/selectend) raises it as ONE
//      undo entry
//   H. VR HUD: a game in play draws its HUD band in front of the emulated head; turning the head brings
//      the band round (it follows the real XR camera, not a synthetic pose)
//   P. passthrough: the Settings tile aims immersive-ar; the next Play asks IWER for immersive-ar, the
//      session blends (alpha-blend) and the local sky lifts; leaving brings the sky back, and off again
//      the next session is immersive-vr with the sky on
// Race VR shadows (needs the Race scene) is its own suite: race-vr-shadows-iwer.
// What stays MANUAL on a Quest: feel (haptics, ring follow damping, brush weight), frame rate, real hands,
// the passthrough camera image, text sharpness at the real eye-buffer resolution.
// Run: APP_URL=https://localhost:5486/ node tests/e2e/vr-iwer.test.cjs   (ONLY=R,S to pick rows)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(row);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const g = (fn, arg) => page.evaluate(fn, arg);
	const read = (name) => g((n) => { let v; window.__tp.test.v1[n].subscribe((x) => (v = x))(); return v; }, name);
	const settle = (n = 6) => iwer.frames(page, n);

	// ---- 0. the harness ----------------------------------------------------------------------------
	console.log('\n=== 0. IWER is the headset ===');
	h.check(await iwer.installed(page), 'IWER owns navigator.xr before the app boots');
	await h.eventually(() => g(() => { const s = window.__tp?.test.v1; let a, b; s.playMode.vrSupported.subscribe((x) => (a = x))(); s.playMode.arSupported.subscribe((x) => (b = x))(); return a && b; }), (v) => v === true, "the app's probes say immersive-vr AND immersive-ar are supported", 10000);
	const st0 = await iwer.enter(page);
	h.check(st0.presenting && st0.same && st0.mode === 'immersive-vr', `Play -> requestSession('immersive-vr') -> three presents that very session (${JSON.stringify(st0)})`);
	h.check(st0.inputs.join() === 'left:pad,right:pad' || st0.inputs.join() === 'right:pad,left:pad', `two tracked controllers with gamepads (${st0.inputs.join()})`);
	h.check((await read('isVRMode')) === true, 'sessionstart arms VR mode');
	const menuHand = await read('vrMenuHand');
	const pointer = menuHand === 'right' ? 'left' : 'right';
	console.log(`menu hand ${menuHand}, pointer ${pointer}`);
	// the head and both hands follow the emulated device (deltas: the rig may sit anywhere in the world)
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	await iwer.pose(page, 'left', [-0.2, 1.3, -0.35]);
	await iwer.pose(page, 'right', [0.2, 1.3, -0.35]);
	await settle();
	const w0 = await iwer.controllerWorld(page);
	await iwer.pose(page, 'head', [0.5, 1.6, -0.3]);
	await iwer.pose(page, 'right', [0.6, 1.2, -0.75]);
	await settle();
	const w1 = await iwer.controllerWorld(page);
	const d = (a, b) => a.map((v, i) => +(v - b[i]).toFixed(3));
	const near = (a, b, tol = 0.02) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
	h.check(near(d(w1.head.pos, w0.head.pos), [0.5, 0, -0.3]), `the XR camera follows the emulated head (moved ${d(w1.head.pos, w0.head.pos)})`);
	h.check(near(d(w1.right.pos, w0.right.pos), [0.4, -0.1, -0.4]), `the right controller group follows the emulated controller (moved ${d(w1.right.pos, w0.right.pos)})`);
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	await iwer.pose(page, 'right', [0.2, 1.3, -0.35]);
	await settle();

	// ---- R. the radial menu ----------------------------------------------------------------------
	if (want('R')) {
		console.log('\n=== R. radial menu ===');
		const menuButton = menuHand === 'left' ? 'y-button' : 'b-button';
		h.check((await read('vrMenuOpen')) === false, 'premise: the ring is closed');
		await iwer.tap(page, menuHand, menuButton);
		await settle();
		h.check((await read('vrMenuOpen')) === true, `the menu button (${menuButton} on the ${menuHand} controller) opens the ring`);
		const ringPose = await g(() => {
			const s = window.__tp?.test.v1;
			let grp;
			s.vrControls.vrMenuGroup.subscribe((v) => (grp = v))();
			if (!grp) return null;
			grp.updateMatrixWorld(true);
			const e = grp.matrixWorld.elements;
			let vis = grp.visible;
			for (let p = grp.parent; p; p = p.parent) vis = vis && p.visible;
			return { pos: [e[12], e[13], e[14]], visible: vis, sectors: (() => { let n = 0; grp.traverse((o) => o.name?.startsWith?.('vrmenu-') && n++); return n; })() };
		});
		const handAt = (await iwer.controllerWorld(page))[menuHand].pos;
		const gap = ringPose ? Math.hypot(...ringPose.pos.map((v, i) => v - handAt[i])) : Infinity;
		h.check(!!ringPose?.visible && ringPose.sectors > 0, `the ring is drawn (${ringPose?.sectors} control meshes)`);
		h.check(gap < 0.3, `…by the menu controller (${gap.toFixed(3)} m from it)`);
		// the stick picks a sector: aim it at the first ▸ (navigating) entry of the root ring
		const pick = await g(() => {
			const m = window.__tp.test.v1.vrRadialMenu;
			const ents = m.ringEntries('root');
			const k = ents.findIndex((e) => String(e.id).startsWith('nav:'));
			if (k < 0) return null;
			const a = (k * 2 * Math.PI) / ents.length;
			const x = Math.sin(a);
			const y = -Math.cos(a);
			return { k, id: ents[k].id, x, y, check: m.sectorFromStick(x, y, ents.length) };
		});
		h.check(!!pick && pick.check === pick.k, `premise: the root ring has a ▸ sector the stick can aim at (${JSON.stringify(pick)})`);
		await iwer.stick(page, menuHand, pick.x, pick.y);
		await settle(8);
		const hovered = await g(() => { let v; window.__tp.test.v1.vrControls.vrHovered.subscribe((x) => (v = x))(); return v; });
		h.check(hovered === pick.id, `the stick lights that sector (${hovered} = ${pick.id})`);
		await iwer.tap(page, menuHand, 'thumbstick');
		await iwer.stick(page, menuHand, 0, 0);
		await settle();
		const ring = await g(() => { let v; window.__tp.test.v1.vrRadialMenu.activeRing.subscribe((x) => (v = x))(); return v; });
		h.check(ring === pick.id.slice(4), `the stick PRESS runs it: the "${pick.id}" ring opens (${ring})`);
		await iwer.tap(page, menuHand, menuButton);
		await settle();
		h.check((await read('vrMenuOpen')) === false, 'the menu button closes the ring');
	}

	// ---- S. VR sculpt ----------------------------------------------------------------------------
	if (want('S')) {
		console.log('\n=== S. VR sculpt ===');
		const sc = () => g(() => window.__tp.test.v1.vrSculpt.vrSculptDebug());
		const terrain = () =>
			g(() => {
				const s = window.__tp?.test.v1;
				let grp;
				s.objectsGroup.subscribe((v) => (grp = v))();
				const t = grp.children.find((c) => c.userData?.terrain);
				if (!t) return null;
				const p = t.geometry.attributes.position;
				let maxY = -Infinity;
				for (let i = 0; i < p.count; i++) maxY = Math.max(maxY, p.getY(i));
				let undo = null;
				s.history.undoStack?.subscribe?.((v) => (undo = v.length))();
				t.updateMatrixWorld(true);
				const e = t.matrixWorld.elements;
				return { uuid: t.uuid, at: [e[12], e[13], e[14]], maxY, undo };
			});
		await g(() => {
			const s = window.__tp?.test.v1;
			s.vrMenuOpen.set(true);
			s.vrControls.executeVRMenuAction('nav:add');
			s.vrControls.executeVRMenuAction('terrain');
		});
		await h.eventually(sc, (x) => x.active && !!x.uuid, 'Add > Terrain starts a VR sculpt session');
		await g(() => window.__tp.test.v1.vrControls.executeVRMenuAction('sculpt:raise'));
		await g(() => window.__tp.test.v1.vrMenuOpen.set(false));
		const t0 = await terrain();
		const ctrl = (await iwer.controllerWorld(page))[pointer].pos;
		// the terrain landed 6 m ahead of the head: aim the pointer controller straight down at a point 3 m in,
		// in the controller's own space (the rig offset between IWER's floor and the world is the delta)
		const rig = d(ctrl, pointer === 'left' ? [-0.2, 1.3, -0.35] : [0.2, 1.3, -0.35]);
		const aimAt = [t0.at[0] - rig[0], 1.2, t0.at[2] - rig[2] + 1.5];
		await iwer.pose(page, pointer, aimAt, { pitch: -Math.PI / 2 });
		await settle(10);
		const cursor = await g(() => {
			let s;
			window.__tp.test.v1.globalScene.subscribe((v) => (s = v))();
			const c = s.getObjectByName('sculpt-cursor');
			return c ? { visible: c.visible, pos: c.position.toArray() } : null;
		});
		h.check(!!cursor?.visible, `the brush ring sits on the terrain under the aimed controller (${JSON.stringify(cursor?.pos?.map((v) => +v.toFixed(2)))})`);
		const before = await terrain();
		// the TRIGGER: IWER fires selectstart on the session, which Scene hands to the sculpt hook
		await iwer.button(page, pointer, 'trigger', 1);
		await settle(30);
		const mid = await sc();
		await iwer.button(page, pointer, 'trigger', 0);
		await settle(10);
		const after = await terrain();
		h.check(mid.stroking === true, 'holding the trigger is a stroke (the session select, not a test call)');
		h.check(after.maxY > before.maxY + 0.02, `the stroke raised the terrain (max y ${before.maxY.toFixed(3)} -> ${after.maxY.toFixed(3)})`);
		h.check(after.undo === before.undo + 1, `ONE undo entry for the stroke (${before.undo} -> ${after.undo})`);
		await g(() => window.__tp.test.v1.vrControls.executeVRMenuAction('sculpt:done'));
		await settle();
		h.check(!(await sc()).active, 'Done ends the sculpt session');
	}

	// ---- H. the VR HUD ---------------------------------------------------------------------------
	if (want('H')) {
		console.log('\n=== H. VR HUD ===');
		await g(() => {
			const s = window.__tp?.test.v1;
			s.gameKit.vrHudPrefs.setVrHudPlacement('head');
			s.hudDocs.setHudDocFor('scene', {
				active: '',
				screens: [
					{ id: 'menu', name: 'Menu', showWhile: 'menu', input: 'menu', elements: [{ id: 'start', kind: 'button', anchor: 'center', x: 0, y: 0, w: 320, h: 80, label: 'Start' }] },
					{ id: 'hud', name: 'HUD', showWhile: 'playing', elements: [{ id: 'score', kind: 'text', anchor: 'top-left', x: 28, y: 22, w: 230, h: 34, label: 'Score 120', style: { size: 26, weight: '800' } }] }
				]
			});
			s.gameState.setGameState('playing');
			s.objectActions.setEditorMode('interact');
		});
		await iwer.pose(page, 'head', [0, 1.6, 0]);
		await settle(20);
		const band = () =>
			g(() => {
				const s = window.__tp?.test.v1;
				const m = s.gameKit.vrHud.vrHudSurface()?.mesh;
				let r;
				s.globalRenderer.subscribe((v) => (r = v))();
				const cam = r.xr.getCamera();
				if (!m) return null;
				m.updateMatrixWorld(true);
				const THREE = s.THREE;
				// the band is a curved strip CENTRED on the head (its origin is the head), so where it faces is its
				// rotation: compare the band's forward with the XR camera's, both flattened to the floor
				const mp = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
				const cp = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
				const fwd = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
				const bandFwd = new THREE.Vector3(0, 0, -1).transformDirection(m.matrixWorld);
				fwd.y = 0;
				bandFwd.y = 0;
				return { visible: s.gameKit.vrHud.vrHudDebug().visible, angle: Math.round((bandFwd.angleTo(fwd) * 180) / Math.PI), centre: +mp.distanceTo(cp).toFixed(2) };
			});
		const b0 = await band();
		h.check(b0?.visible === true, `a game in play draws its HUD band in the headset (${JSON.stringify(b0)})`);
		h.check(b0 && b0.angle < 15 && b0.centre < 0.15, `…around the emulated head, facing where it looks (${b0?.angle} deg off forward, centred ${b0?.centre} m from the XR camera)`);
		// turn the head 90 degrees: right after, the band is still where it was (it lags) — then it comes round
		await iwer.pose(page, 'head', [0, 1.6, 0], { yaw: Math.PI / 2 });
		await settle(2);
		const b1 = await band();
		await settle(120);
		const b2 = await band();
		h.check(b1 && b1.angle > 30, `turning the head leaves the band behind for a moment (${b1?.angle} deg)`);
		h.check(b2 && b2.angle < 15, `…then it follows the real head round (${b2?.angle} deg after ~120 XR frames)`);
		await g(() => {
			const s = window.__tp?.test.v1;
			s.gameState.setGameState('menu');
			s.objectActions.setEditorMode('edit');
		});
		await iwer.pose(page, 'head', [0, 1.6, 0]);
	}

	// ---- P. passthrough --------------------------------------------------------------------------
	if (want('P')) {
		console.log('\n=== P. passthrough ===');
		await iwer.exit(page);
		const out = await iwer.state(page);
		h.check(!out.presenting && out.ended === true && (await read('isVRMode')) === false, 'premise: the session is over (back in the editor)');
		const sky = () => g(() => { let s; window.__tp.test.v1.globalScene.subscribe((v) => (s = v))(); return { background: s.background ? (s.background.isColor ? '#' + s.background.getHexString() : 'texture') : null, fog: !!s.fog }; });
		const skyBefore = await sky();
		h.check(skyBefore.background !== null, `premise: the editor has a sky (${skyBefore.background})`);
		// the person's path: the Settings tile (VR settings panel), which only aims the NEXT session
		await g(() => window.__tp.test.v1.vrControls.executeVRMenuAction('settings:passthrough'));
		await page.waitForTimeout(300);
		h.check((await page.evaluate(() => document.getElementById('vrButton')?.dataset.aim)) === 'ar', 'the tile aims immersive-ar');
		const st1 = await iwer.enter(page);
		h.check(st1.mode === 'immersive-ar' && st1.same, `Play now asks IWER for immersive-ar (${st1.mode})`);
		h.check(st1.blend === 'alpha-blend', `the session composites over the room (environmentBlendMode ${st1.blend})`);
		await settle(6);
		h.check((await read('passthroughActive')) === true, 'passthroughActive is on for the session');
		const skyAr = await sky();
		h.check(skyAr.background === null && skyAr.fog === false, `the local sky lifts (background ${skyAr.background}, fog ${skyAr.fog})`);
		await iwer.exit(page);
		await page.waitForTimeout(300);
		const skyBack = await sky();
		h.check((await read('passthroughActive')) === false && skyBack.background === skyBefore.background, `leaving brings the sky back (${skyBack.background})`);
		await g(() => window.__tp.test.v1.vrControls.executeVRMenuAction('settings:passthrough'));
		await page.waitForTimeout(300);
		const st2 = await iwer.enter(page);
		h.check(st2.mode === 'immersive-vr' && st2.blend === 'opaque', `off again, the next Play is immersive-vr, opaque (${st2.mode}, ${st2.blend})`);
		h.check((await sky()).background !== null, 'and the sky stays on in VR');
	}

	await iwer.exit(page);
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ').slice(0, 300)})`);
	await h.finish(browser);
});
