// 53 (A7) — VR COMFORT, on IWER (48 G2: the app's own XR path, a Quest 3 emulated). The user
// (2026-10-21): a comfort vignette while moving/turning smoothly (off / low / high), seated mode
// (height offset + recenter) and one-handed use — every VR menu and locomotion reachable from
// either single controller. Snap turn, teleport, flying, menu hand already existed (audited).
//
//  1 Settings ▸ VR: Comfort vignette is Off / Low / High; a stored "true" reads High
//  2 the vignette rings while the stick moves you: Low closes about half as far as High; Off never
//  3 Recenter faces the scene's forward again; seated, it re-measures the head where you sit now
//  4 one-handed (Right only): the radial moves to the right hand; that ONE stick walks forward/back
//    (no turn) and turns sideways (no walk); the left stick no longer moves you
//  5 one-handed: holding the stick press aims a teleport (engaged), letting go ends it
//  6 one-handed: B opens the radial, whose root offers Edit / Interact; picking it with the stick +
//    stick press switches the mode — no left controller touched
//  7 one-handed Left only mirrors it; Off gives the menu hand back
//  8 the game menu's Accessibility page in a headset repeats the comfort rows (shell:vrset:*), and
//    a board press steps one
// A real-Quest check of the same rows goes on 53-int's checklist (comfort is felt, not measured).
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const g = (page, fn, arg) => page.evaluate(fn, arg);

// IWER's offset reference spaces do not reach the XR camera it reports (measured: a 0.45 m seated
// lift and 40 frames of walking left the camera where IWER's head is), so the locomotion rows read
// WHAT THE APP APPLIED: every XRRigidTransform the rig moves by is recorded (the rig is the only
// thing building them while these rows run) — translation summed, yaw of each rotation.
const SPY = () => {
	if (window.__rigSpy) return;
	const Orig = window.XRRigidTransform;
	window.__rigSpy = [];
	window.XRRigidTransform = class extends Orig {
		constructor(p, o) {
			super(p, o);
			window.__rigSpy.push({ p: p ? [p.x || 0, p.y || 0, p.z || 0] : [0, 0, 0], yaw: o ? 2 * Math.atan2(o.y || 0, o.w ?? 1) : 0 });
		}
	};
};
/** the offsets applied since the last call: {move (m, horizontal), lift (m), turns: [yaw…]} */
const applied = (page) =>
	page.evaluate(() => {
		const list = window.__rigSpy.splice(0);
		let x = 0, y = 0, z = 0;
		const turns = [];
		for (const r of list) {
			if (Math.abs(r.yaw) > 1e-4) turns.push(+r.yaw.toFixed(3));
			else {
				x += r.p[0];
				y += r.p[1];
				z += r.p[2];
			}
		}
		return { move: Math.hypot(x, z), lift: -y, turns };
	});


h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } }, storage: { vrComfortVignette: 'true' } });
	const page = A.page;

	console.log('\n=== 1. the vignette setting ===');
	const row = await g(page, () => {
		const s = window.__tp?.test.v1;
		const r = s.vrSettingsSchema.vrSettingRow('vignette');
		return { kind: r.kind, options: r.options.map((o) => o.value), value: r.get() };
	});
	h.check(row.kind === 'choice' && row.options.join(',') === 'off,low,high', '1.1 Comfort vignette is Off / Low / High (' + row.options + ')');
	h.check(row.value === 'high', '1.2 an older stored "true" reads High (' + row.value + ')');

	await iwer.enter(page);
	await g(page, SPY);
	await g(page, () => window.__tp.test.v1.vrSettingsSchema.vrSettingRow('turning').set('snap'));

	console.log('\n=== 2. the vignette rings while the stick moves you ===');
	/** push the move stick for ~60 frames and read the ring's strength */
	const ring = async (level) => {
		await g(page, (lv) => window.__tp.test.v1.vrPrefs.vrComfortVignette.set(lv), level);
		await iwer.stick(page, 'left', 0, -1);
		await iwer.frames(page, 70);
		const on = await g(page, () => window.__tp.test.v1.gameKit.comfortVignette.vignetteDebug());
		await iwer.stick(page, 'left', 0, 0);
		await iwer.frames(page, 90);
		const after = await g(page, () => window.__tp.test.v1.gameKit.comfortVignette.vignetteDebug());
		return { on, after };
	};
	const high = await ring('high');
	const low = await ring('low');
	const off = await ring('off');
	h.check(high.on.strength > 0.8 && high.on.level === 'high', '2.1 High: the ring closes in while the stick walks you (' + high.on.strength.toFixed(2) + ')');
	h.check(low.on.strength > 0.3 && low.on.strength < 0.6, '2.2 Low: about half as far (' + low.on.strength.toFixed(2) + ')');
	h.check(off.on.strength === 0 && !off.on.visible, '2.3 Off: no ring');
	h.check(high.after.strength < 0.05, '2.4 the stick let go: the ring opens again (' + high.after.strength.toFixed(3) + ')');

	console.log('\n=== 3. recenter + seated ===');
	await iwer.pose(page, 'head', [0, 1.6, 0], { yaw: 1.1 });
	await iwer.frames(page, 4);
	await applied(page);
	const r0 = (await g(page, () => window.__tp.test.v1.vrLocomotion.heightLiftDebug())).recenters.menu;
	await g(page, () => window.__tp.test.v1.vrSettingsSchema.activateVRSetting('recenter'));
	await iwer.frames(page, 4);
	const rc = await applied(page);
	const r1 = (await g(page, () => window.__tp.test.v1.vrLocomotion.heightLiftDebug())).recenters.menu;
	h.check(r1 === r0 + 1, '3.1 Recenter pressed outside a frame runs on the next XR frame (' + r0 + ' → ' + r1 + ')');
	h.check(rc.turns.length === 1 && Math.abs(rc.turns[0] - 1.1) < 0.05, '3.2 …and turns the rig by the head yaw, so you face forward (' + rc.turns + ')');
	await iwer.pose(page, 'head', [0, 1.15, 0]);
	await g(page, () => window.__tp.test.v1.vrSettingsSchema.vrSettingRow('stance').set('seated'));
	await iwer.frames(page, 6);
	const seat1 = await g(page, () => window.__tp.test.v1.vrLocomotion.heightLiftDebug());
	await iwer.pose(page, 'head', [0, 0.95, 0]); // slumped lower in the chair
	await g(page, () => window.__tp.test.v1.vrSettingsSchema.activateVRSetting('recenter'));
	await iwer.frames(page, 6);
	const seat2 = await g(page, () => window.__tp.test.v1.vrLocomotion.heightLiftDebug());
	h.check(Math.abs(seat1.applied - 0.45) < 0.03, '3.3 seated lifts a 1.15 m head to a standing eye height (lift ' + seat1.applied + ')');
	h.check(Math.abs(seat2.seatedHead - 0.95) < 0.03 && Math.abs(seat2.applied - 0.65) < 0.03, '3.4 recenter re-measures where you sit now (head ' + seat2.seatedHead + ' m, lift ' + seat2.applied + ')');
	await g(page, () => window.__tp.test.v1.vrSettingsSchema.vrSettingRow('stance').set('standing'));
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	await iwer.frames(page, 4);

	console.log('\n=== 4. one-handed (Right only): one stick walks and turns ===');
	const one = await g(page, () => {
		const s = window.__tp?.test.v1;
		s.vrSettingsSchema.vrSettingRow('oneHanded').set('right');
		let mh;
		s.vrMenuHand.subscribe((v) => (mh = v))();
		const b = s.vrBindings;
		return { menuHand: mh, move: b.bindingOf('move'), turn: b.bindingOf('turn'), menu: b.bindingOf('menu'), ptt: b.bindingOf('ptt'), pointer: b.pointerHand() };
	});
	h.check(one.menuHand === 'right' && one.menu.hand === 'right' && one.menu.control === 'secondary', '4.1 the radial moves to the right hand (B)');
	h.check(one.move.hand === 'right' && one.turn.hand === 'right' && one.ptt.hand === 'right' && one.pointer === 'right', '4.2 move, turn, talk and the laser are all on the right controller');
	await applied(page);
	await iwer.stick(page, 'right', 0.15, -1); // forward with a little drift
	await iwer.frames(page, 40);
	await iwer.stick(page, 'right', 0, 0);
	await iwer.frames(page, 4);
	const a1 = await applied(page);
	h.check(a1.move > 0.3 && a1.turns.length === 0, '4.3 forward on the right stick walks, no turn (' + a1.move.toFixed(2) + ' m, turns ' + a1.turns + ')');
	await iwer.stick(page, 'right', 1, 0);
	await iwer.frames(page, 8);
	await iwer.stick(page, 'right', 0, 0);
	await iwer.frames(page, 4);
	const a2 = await applied(page);
	h.check(a2.turns.length === 1 && Math.abs(Math.abs(a2.turns[0]) - Math.PI / 4) < 0.02 && a2.move < 0.01, '4.4 sideways on the right stick snap-turns 45°, no walk (' + a2.turns + ', ' + a2.move.toFixed(3) + ' m)');
	await iwer.stick(page, 'left', 0, -1);
	await iwer.frames(page, 30);
	await iwer.stick(page, 'left', 0, 0);
	await iwer.frames(page, 4);
	const a3 = await applied(page);
	h.check(a3.move < 0.01 && a3.turns.length === 0, '4.5 the left stick no longer moves you (' + a3.move.toFixed(3) + ' m)');

	console.log('\n=== 5. one-handed teleport: hold the stick press ===');
	await iwer.pose(page, 'right', [0.2, 1.2, -0.3], { pitch: -0.6 });
	await iwer.button(page, 'right', 'thumbstick', true);
	await iwer.frames(page, 8);
	const aiming = await g(page, () => window.__tp.test.v1.vrControls.teleportState());
	await iwer.button(page, 'right', 'thumbstick', false);
	await iwer.frames(page, 6);
	const released = await g(page, () => window.__tp.test.v1.vrControls.teleportState());
	h.check(aiming.engaged === true, '5.1 holding the right stick press aims a teleport');
	h.check(released.engaged === false, '5.2 letting go ends the aim (and jumps where it was valid)');

	console.log('\n=== 6. one-handed menus: B opens the radial, its stick picks Edit / Interact ===');
	await iwer.tap(page, 'right', 'b-button');
	await iwer.frames(page, 4);
	const radial = await g(page, () => {
		const s = window.__tp?.test.v1;
		let open;
		s.vrMenuOpen.subscribe((v) => (open = v))();
		const ids = s.vrRadialMenu.ringEntries('root').map((e) => e.id);
		return { open, ids };
	});
	h.check(radial.open === true, '6.1 B on the right hand opens the radial');
	h.check(radial.ids.includes('onehand:mode'), '6.2 its root offers Edit / Interact (' + radial.ids.join(',') + ')');
	const modeBefore = await g(page, () => { let m; window.__tp.test.v1.editorMode.subscribe((v) => (m = v))(); return m; });
	// aim the stick at that sector (sectors run clockwise from 12 o'clock), then press the stick
	const dir = await g(page, () => {
		const ids = window.__tp.test.v1.vrRadialMenu.ringEntries('root').map((e) => e.id);
		const i = ids.indexOf('onehand:mode');
		const a = (i / ids.length) * Math.PI * 2;
		return [Math.sin(a), -Math.cos(a)];
	});
	await iwer.stick(page, 'right', dir[0], dir[1]);
	await iwer.frames(page, 6);
	const hovered = await g(page, () => { let v; window.__tp.test.v1.vrControls.vrHovered.subscribe((x) => (v = x))(); return v; });
	await iwer.tap(page, 'right', 'thumbstick');
	await iwer.stick(page, 'right', 0, 0);
	await iwer.frames(page, 6);
	const modeAfter = await g(page, () => { let m; window.__tp.test.v1.editorMode.subscribe((v) => (m = v))(); return m; });
	h.check(hovered === 'onehand:mode', '6.3 the right stick highlights the sector (' + hovered + ')');
	h.check(modeBefore !== modeAfter, '6.4 the stick press switches Edit / Interact (' + modeBefore + ' → ' + modeAfter + ')');
	await g(page, () => window.__tp.test.v1.editorMode.set('edit'));
	await iwer.frames(page, 4);

	console.log('\n=== 7. Left only mirrors; Off gives the menu hand back ===');
	const left = await g(page, () => {
		const s = window.__tp?.test.v1;
		s.vrSettingsSchema.vrSettingRow('oneHanded').set('left');
		const b = s.vrBindings;
		let mh;
		s.vrMenuHand.subscribe((v) => (mh = v))();
		const onLeft = { menuHand: mh, move: b.bindingOf('move').hand, turn: b.bindingOf('turn').hand, menu: b.bindingOf('menu').hand, pointer: b.pointerHand() };
		s.vrSettingsSchema.vrSettingRow('oneHanded').set('off');
		s.vrMenuHand.subscribe((v) => (mh = v))();
		return { onLeft, offMenuHand: mh, offMove: b.bindingOf('move').hand, offTurn: b.bindingOf('turn').hand };
	});
	h.check(Object.values(left.onLeft).every((v) => v === 'left'), '7.1 Left only: everything on the left controller (' + JSON.stringify(left.onLeft) + ')');
	h.check(left.offMenuHand === 'right' && left.offMove === 'left' && left.offTurn === 'right', '7.2 Off: the menu hand goes back to where it was, move left / turn right again');

	console.log('\n=== 8. the game menu Accessibility page in the headset ===');
	const board = await g(page, () => {
		const s = window.__tp?.test.v1;
		s.gameKit.gameShell.markShellGame(true);
		s.editorMode.set('interact');
		s.gameKit.gameShell.openShellMenu('access');
		const T = s.THREE;
		const hd = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
		s.gameKit.vrGamePanel.vrGamePanelFrame({ head: hd, hands: [null, null], force: true });
		const surf = s.gameKit.vrGamePanel.vrGameSurface('vr-game-panel');
		const hits = surf.hits.map((r) => r.id);
		const target = { hit: surf.hits.find((r) => r.id === 'shell:vrset:oneHanded:next'), point: null };
		const pressed = s.gameKit.vrGamePanel.pressPanelTarget(target);
		let one;
		s.vrPrefs.vrOneHanded.subscribe((v) => (one = v))();
		s.vrSettingsSchema.vrSettingRow('oneHanded').set('off');
		const url = surf.canvas.toDataURL('image/png');
		s.gameKit.gameShell.closeShellMenu();
		s.editorMode.set('edit');
		return { hits: hits.filter((x) => x.includes('vrset') || x.includes(':acc:')), pressed, one, url };
	});
	h.check(['shell:vrset:vignette:next', 'shell:vrset:stance:next', 'shell:vrset:oneHanded:next', 'shell:vrset:recenter:next'].every((id) => board.hits.includes(id)), '8.1 the page carries Comfort vignette · Stance · One-handed · Recenter (' + board.hits.length + ' hits)');
	h.check(board.pressed && board.one === 'left', '8.2 a board press steps One-handed (Off → ' + board.one + ')');
	if (process.env.EVIDENCE_DIR) require('fs').writeFileSync(require('path').join(process.env.EVIDENCE_DIR, '20-vr-board-access-comfort.png'), Buffer.from(board.url.split(',')[1], 'base64'));

	await iwer.exit(page);
	await h.finish(browser);
});
