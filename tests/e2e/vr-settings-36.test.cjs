// 36-vr (U3 + plan 55) — every audit row that was BROKEN in 1.20.0, driven through the real per-frame VR
// path (fakeXR), plus the plan-55 acceptance: remap through desktop Settings ▸ VR ▸ Controls, reload, and
// the moved controls drive the headset. The 1.20.0 behaviour of each row is recorded by
// tests/e2e/vr-audit-probe.cjs (evidence: lanes-30/after-36/36-vr/probe-before.log).
//   R8  hold-to-menu: releasing over a ▸ sector navigates and keeps the ring up (was: ring closed, sub-ring leaked)
//   R9  Settings ▸ All settings closes the ring, so the panel's rows take the pointer (was: ring stayed, rows dead)
//   S3  smooth turning outside a game (was: game-only)
//   S5  the comfort vignette outside a game (was: game-only)
//   S23 the Settings panel's stick cursor (was: the stick did nothing)
//   Body: seated lifts the eye to a standing height; Height adds on top; Interact keeps the feet on the floor
//   R1/T1: sectors carry icons and stable tour ids; the panels resolve by id
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const settle = (ms = 200) => page.waitForTimeout(ms);
	const g = (expr) => page.evaluate(expr);
	const read = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g1 = (st) => {
				let v;
				st?.subscribe?.((x) => (v = x))();
				return v;
			};
			return {
				open: g1(s.vrMenuOpen),
				ring: g1(s.vrRadialMenu.activeRing),
				hand: g1(s.vrMenuHand),
				settings: g1(s.vrSettingsPanelOpen),
				hov: g1(s.vrControls.vrHovered),
				page: g1(s.vrSettingsSchema.vrSettingsPage),
				cursor: g1(s.vrSettingsSchema.vrSettingsCursor),
				chat: g1(s.vrChatPanelOpen)
			};
		});
	await xr.install(page);
	await xr.pose(page, 'left', [-0.3, 1.1, 0.6], { pitch: -1.3 });
	await xr.pose(page, 'right', [0.3, 1.1, 0.6], { pitch: -1.3 });
	const hand = (await read()).hand;
	const other = hand === 'left' ? 'right' : 'left';
	const stickTo = async (who, sector, of = 8) => {
		const a = (sector * Math.PI * 2) / of;
		await xr.stick(page, who, Math.sin(a), -Math.cos(a));
	};

	console.log('\n=== R8 hold-to-menu: release over a ring sector ===');
	await g(() => window.__stores.vrMenuHold.set(true));
	await xr.button(page, hand, 5, true);
	await settle();
	await stickTo(hand, 1); // Add ▸
	await settle();
	let st = await read();
	h.check(st.open && st.hov === 'nav:add', `premise: held open, the stick lights Add (${st.hov})`);
	await xr.button(page, hand, 5, false);
	await xr.stick(page, hand, 0, 0);
	await settle();
	st = await read();
	h.check(st.open && st.ring === 'add', `release over Add ▸ opens the Add ring and keeps it up (open ${st.open}, ring ${st.ring})`);
	// a leaf under the released stick acts and closes: Chat (sector 6 of the root)
	await g(() => window.__stores.vrRadialMenu.resetRings());
	await xr.button(page, hand, 5, true);
	await settle();
	await stickTo(hand, 6);
	await settle();
	await xr.button(page, hand, 5, false);
	await xr.stick(page, hand, 0, 0);
	await settle();
	st = await read();
	h.check(!st.open && st.chat && st.ring === 'root', `release over a leaf acts and closes (chat ${st.chat}, open ${st.open}, ring ${st.ring})`);
	await g(() => {
		const s = window.__stores;
		s.vrChatPanelOpen.set(false);
		s.vrMenuHold.set(false);
	});

	console.log('\n=== R9 Settings ▸ All settings: the panel takes the pointer ===');
	await g(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('nav:settings');
		s.vrControls.executeVRMenuAction('settings');
	});
	await settle(400);
	st = await read();
	h.check(st.settings && !st.open, `All settings opens the panel and closes the ring (panel ${st.settings}, ring open ${st.open})`);
	// aim the pointer hand straight at the Teleport row (the panel sits where it mounted: no real session)
	const row = await g(() => {
		const s = window.__stores;
		let grp;
		s.vrControls.vrSettingsGroup.subscribe((v) => (grp = v))();
		const mesh = grp?.getObjectByName('vrsettings-vrset:teleport');
		if (!mesh) return null;
		mesh.updateWorldMatrix(true, false);
		const p = new s.THREE.Vector3();
		mesh.getWorldPosition(p);
		return p.toArray();
	});
	h.check(!!row, 'premise: the panel draws a Teleport row');
	if (row) {
		await xr.pose(page, other, [row[0], row[1], row[2] + 0.3], {});
		await settle(300);
		st = await read();
		h.check(st.hov === 'vrset:teleport', `the pointer hovers the panel row (${st.hov})`);
		const before = await g(() => window.__stores.vrSettingsSchema.vrSettingRow('teleport').get());
		await xr.button(page, other, 3, true); // a stick press presses what the ray holds
		await settle();
		await xr.button(page, other, 3, false);
		await settle();
		const after = await g(() => window.__stores.vrSettingsSchema.vrSettingRow('teleport').get());
		h.check(before !== after, `pressing it flips Teleport (${before} → ${after})`);
		await xr.pose(page, other, [0.3, 1.1, 0.6], { pitch: -1.3 });
		await settle();
	}

	console.log('\n=== S23 the panel stick cursor ===');
	await g(() => {
		const s = window.__stores.vrSettingsSchema;
		s.vrSettingsPage.set('comfort');
		s.vrSettingsCursor.set(0);
	});
	await xr.stick(page, hand, 1, 0); // on the tab strip: right = next page
	await settle(260);
	await xr.stick(page, hand, 0, 0);
	await settle(260);
	st = await read();
	h.check(st.page === 'body', `left/right on the tab strip changes page (comfort → ${st.page})`);
	await xr.stick(page, hand, 0, 1); // down to the first row (Stance)
	await settle(260);
	await xr.stick(page, hand, 0, 0);
	await settle(260);
	st = await read();
	h.check(st.cursor === 1, `down moves the cursor onto the first row (${st.cursor})`);
	const stance0 = await g(() => window.__stores.vrSettingsSchema.vrSettingRow('stance').get());
	await xr.stick(page, hand, 1, 0); // right on a choice: next value
	await settle(260);
	await xr.stick(page, hand, 0, 0);
	await settle(260);
	const stance1 = await g(() => window.__stores.vrSettingsSchema.vrSettingRow('stance').get());
	h.check(stance0 === 'standing' && stance1 === 'seated', `right on Stance cycles it (${stance0} → ${stance1})`);
	await g(() => window.__stores.vrPrefs.vrStance.set('standing'));
	await g(() => window.__stores.vrSettingsPanelOpen.set(false));
	await settle();

	console.log('\n=== S3 smooth turning, S5 the vignette — outside any game ===');
	await xr.installSpace(page, { head: [0, 1.6, 0] });
	await g(() => {
		const s = window.__stores;
		s.vrSettingsSchema.vrSettingRow('turning').set('smooth');
		s.vrPrefs.vrComfortVignette.set(true);
	});
	const y0 = (await xr.head(page)).yaw;
	await xr.stick(page, 'right', 1, 0); // the TURN stick, held
	await settle(500);
	const y1 = (await xr.head(page)).yaw;
	await settle(300);
	const y2 = (await xr.head(page)).yaw;
	await xr.stick(page, 'right', 0, 0);
	const turned1 = Math.abs(y1 - y0);
	const turned2 = Math.abs(y2 - y1);
	h.check(turned1 > 0.15 && turned2 > 0.1 && turned2 < Math.PI / 2, `smooth turning turns continuously in Edit (${turned1.toFixed(2)} then ${turned2.toFixed(2)} rad)`);
	await xr.stick(page, 'left', 0, -1); // the MOVE stick pushed: the vignette closes in
	await settle(200);
	const vig = await g(() => {
		const s = window.__stores;
		const k = s.gameKit.comfortVignette;
		const T = s.THREE;
		const head = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
		for (let i = 0; i < 30; i++) k.vignetteFrame(head, 1 / 72);
		const on = k.vignetteDebug();
		s.vrPrefs.vrComfortVignette.set(false);
		for (let i = 0; i < 30; i++) k.vignetteFrame(head, 1 / 72);
		const off = k.vignetteDebug();
		return { on, off, game: s.gameKit.gameFeel?.gameFeelActive?.() ?? null };
	});
	await xr.stick(page, 'left', 0, 0);
	h.check(vig.on.visible && vig.on.strength > 0.5, `the device vignette rings while the move stick moves you, in Edit (${vig.on.strength.toFixed(2)})`);
	h.check(!vig.off.visible && vig.off.strength === 0, 'switched off: no ring');
	await g(() => window.__stores.vrSettingsSchema.vrSettingRow('turning').set('snap'));

	console.log('\n=== Body: seated + height ===');
	await xr.installSpace(page, { head: [0, 1.15, 0] }); // a seated player's head
	await settle(200);
	const seated0 = await xr.head(page);
	await g(() => window.__stores.vrPrefs.vrStance.set('seated'));
	await settle(300);
	const seated1 = await xr.head(page);
	h.check(Math.abs(seated0.y - 1.15) < 0.01 && Math.abs(seated1.y - 1.6) < 0.02, `seated lifts the eye to a standing height (${seated0.y.toFixed(2)} → ${seated1.y.toFixed(2)} m)`);
	await g(() => window.__stores.vrSettingsSchema.activateVRSetting('height', 1));
	await g(() => window.__stores.vrSettingsSchema.activateVRSetting('height', 1));
	await settle(300);
	const seated2 = await xr.head(page);
	h.check(Math.abs(seated2.y - 1.7) < 0.02, `Height +10 cm on top (${seated2.y.toFixed(2)} m)`);
	// Interact: the walker keeps the FEET on the floor (the lift counts as height, gravity does not undo it)
	await g(() => window.__stores.objectActions.setEditorMode('interact'));
	await xr.stick(page, 'left', 0, -1);
	await settle(500);
	await xr.stick(page, 'left', 0, 0);
	await settle(300);
	const walked = await xr.head(page);
	h.check(Math.abs(walked.y - 1.7) < 0.03 && walked.z < -0.2, `walking in Interact keeps the lifted eye (y ${walked.y.toFixed(2)}, moved z ${walked.z.toFixed(2)})`);
	await g(() => {
		const s = window.__stores;
		s.objectActions.setEditorMode('edit');
		s.vrPrefs.vrStance.set('standing');
		s.vrPrefs.vrHeightOffset.set(0);
	});
	await settle(300);
	const standing = await xr.head(page);
	h.check(Math.abs(standing.y - 1.15) < 0.03, `Standing + 0 cm puts the eye back on the real head (${standing.y.toFixed(2)} m)`);

	console.log('\n=== R1 + T1: icons, tour ids ===');
	await g(() => window.__stores.vrSettingsPanelOpen.set(false));
	await g(() => window.__stores.vrTourTargets.openRadialAt('settings:comfort'));
	await settle(500);
	const tour = await g(() => {
		const t = window.__stores.vrTourTargets;
		const s = window.__stores;
		let menu;
		s.globalScene.subscribe((v) => (menu = v?.getObjectByName('vr-quick-menu')))();
		let icons = 0;
		menu?.traverse((o) => {
			if (o.name?.startsWith('vricon-') && o.material?.map) icons++;
		});
		return {
			ids: t.vrTourIds(),
			turning: !!t.vrTourTarget('radial:set:turning'),
			hub: !!t.vrTourTarget('radial:hub'),
			icons,
			ring: (() => {
				let r;
				s.vrRadialMenu.activeRing.subscribe((v) => (r = v))();
				return r;
			})()
		};
	});
	h.check(tour.ring === 'settings:comfort' && tour.turning && tour.hub, `openRadialAt lands on Comfort and its sectors resolve by tour id (${tour.ids.length} ids)`);
	h.check(tour.icons >= 7, `every Comfort sector draws its icon (${tour.icons} textured icons)`);
	await g(() => window.__stores.vrMenuOpen.set(false));
	await settle(300);
	const gone = await g(() => window.__stores.vrTourTargets.vrTourTarget('radial:set:turning'));
	h.check(gone === null, 'a closed ring has no tour targets');

	console.log('\n=== plan 55: remap in desktop Settings ▸ VR ▸ Controls, reload, the headset follows ===');
	await xr.uninstall(page);
	await g(() => window.__stores.settingsOpen.set(true));
	await settle(500);
	await page.getByText('VR', { exact: true }).first().click();
	await settle(500);
	h.check((await page.locator('[data-tour="settings-vr-controls"]').count()) === 1, 'the Controls table is in Settings ▸ VR');
	await page.locator('#vr-bind-move-hand').scrollIntoViewIfNeeded();
	await page.locator('#vr-bind-move-hand').click();
	await settle(200);
	await page.locator('.ts-list [role="option"]', { hasText: 'Right' }).click();
	await settle(300);
	h.check((await page.locator('#vr-bind-conflict').count()) === 1, 'moving Move onto the right stick warns: Turn + Teleport are there');
	const refused = await g(() => window.__stores.vrBindings.bindingOf('move').hand);
	h.check(refused === 'left', `nothing changes until you choose (move still ${refused})`);
	await page.locator('#vr-bind-swap').click();
	await settle(300);
	const swapped = await g(() => ({ move: window.__stores.vrBindings.handOf('move'), turn: window.__stores.vrBindings.handOf('turn'), teleport: window.__stores.vrBindings.handOf('teleport') }));
	h.check(swapped.move === 'right' && swapped.turn === 'left' && swapped.teleport === 'left', `Swap: move → right, turn + teleport → left (${JSON.stringify(swapped)})`);
	await h.freshReload(A);
	await settle(1500);
	const afterReload = await g(() => ({ move: window.__stores.vrBindings.handOf('move'), turn: window.__stores.vrBindings.handOf('turn') }));
	h.check(afterReload.move === 'right' && afterReload.turn === 'left', `the remap survives a reload (${JSON.stringify(afterReload)})`);
	// …and the headset follows it: the RIGHT stick walks, the LEFT stick turns
	await xr.install(page);
	await xr.pose(page, 'left', [-0.3, 1.1, 0.6], { pitch: -1.3 });
	await xr.pose(page, 'right', [0.3, 1.1, 0.6], { pitch: -1.3 });
	await xr.installSpace(page, { head: [0, 1.6, 0] });
	await g(() => window.__stores.objectActions.setEditorMode('interact'));
	await xr.stick(page, 'right', 0, -1);
	await settle(500);
	await xr.stick(page, 'right', 0, 0);
	const moved = await xr.head(page);
	h.check(moved.z < -0.3, `in the headset the RIGHT stick now walks (z ${moved.z.toFixed(2)})`);
	const yawA = (await xr.head(page)).yaw;
	await xr.stick(page, 'left', 1, 0); // snap turn on the LEFT stick now
	await settle(250);
	await xr.stick(page, 'left', 0, 0);
	await settle(200);
	const yawB = (await xr.head(page)).yaw;
	h.check(Math.abs(yawB - yawA) > 0.5, `…and the LEFT stick turns (yaw ${yawA.toFixed(2)} → ${yawB.toFixed(2)})`);
	// menu → A (swap with talk): the right A opens the radial
	await g(() => window.__stores.vrBindings.setBinding('menu', { control: 'primary' }, { swap: true }));
	await xr.button(page, 'right', 4, true);
	await settle();
	await xr.button(page, 'right', 4, false);
	await settle();
	st = await read();
	h.check(st.open, `menu on A: the right A opens the radial (${st.open})`);
	await g(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(false);
		s.vrBindings.resetBindings();
		s.objectActions.setEditorMode('edit');
	});

	await h.finish(browser);
});
