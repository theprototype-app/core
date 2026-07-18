// Phase 187: System > Settings (replacing Passthru) opens a VR settings panel
// replicating the desktop VR settings; its controls dispatch to the same stores
// and Reset panel positions clears the saved VR window poses. On-device layout
// is the user's check; here we verify the radial entry, dispatch + panel mount.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const vc = s.vrControls;
		const rm = s.vrRadialMenu;
		const W = s.vrWindowPoses;
		const g1 = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};

		// radial System ring now offers Settings, not Passthru
		const hasSettings = !!rm.findMenuEntry('settings');
		const noPassthru = !rm.findMenuEntry('passthru');

		vc.executeVRMenuAction('settings');
		const opened = g1(s.vrSettingsPanelOpen);

		const tele0 = g1(s.vrTeleportEnabled);
		vc.executeVRMenuAction('settings:teleport');
		const teleToggled = g1(s.vrTeleportEnabled) !== tele0;

		const hold0 = g1(s.vrVertexHold);
		vc.executeVRMenuAction('settings:vertexhold');
		const holdToggled = g1(s.vrVertexHold) !== hold0;

		const ang0 = g1(s.vrSnapAngle);
		vc.executeVRMenuAction('settings:angle');
		const angChanged = g1(s.vrSnapAngle) !== ang0;

		const pt0 = g1(s.vrPassthrough);
		vc.executeVRMenuAction('settings:passthrough');
		const ptToggled = g1(s.vrPassthrough) !== pt0;

		// Reset panel positions clears a saved VR window pose
		W.saveWindowPose('settingspanel', { pos: [0.3, 0, 0], quat: [0, 0, 0, 1], scale: 1 });
		vc.executeVRMenuAction('settings:resetpanels');
		const THREE = s.THREE;
		const grp = new THREE.Group();
		const anchor = { position: new THREE.Vector3(1, 1, -2), quaternion: new THREE.Quaternion() };
		W.applyWindowPose(grp, 'settingspanel', anchor);
		const poseReset = grp.position.distanceTo(anchor.position) < 1e-6;

		return { hasSettings, noPassthru, opened, teleToggled, holdToggled, angChanged, ptToggled, poseReset };
	});

	h.check(res.hasSettings && res.noPassthru, 'System ring offers Settings, not Passthru');
	h.check(res.opened === true, 'the Settings action opens the VR settings panel');
	h.check(res.teleToggled, 'settings:teleport toggles the teleport store');
	h.check(res.holdToggled, 'settings:vertexhold toggles the vertex-hold store');
	h.check(res.angChanged, 'settings:angle cycles the snap angle');
	h.check(res.ptToggled, 'settings:passthrough toggles passthrough (moved into the panel)');
	h.check(res.poseReset, 'Reset panel positions clears the saved VR window pose');

	// the panel mounts its control meshes
	await A.page.waitForTimeout(400);
	const meshes = await A.page.evaluate(() => {
		let g;
		window.__stores.vrControls.vrSettingsGroup.subscribe((v) => (g = v))();
		if (!g) return [];
		const names = [];
		g.traverse((o) => {
			if (o.name && o.name.startsWith('vrsettings-')) names.push(o.name);
		});
		return names;
	});
	h.check(meshes.includes('vrsettings-settings:teleport') && meshes.includes('vrsettings-settings:close'), `the panel mounts its control meshes (${meshes.length})`);

	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('settings:close'));
	await A.page.waitForTimeout(150);
	const closed = await A.page.evaluate(() => {
		let v;
		window.__stores.vrSettingsPanelOpen.subscribe((x) => (v = x))();
		return v === false;
	});
	h.check(closed, 'settings:close closes the panel');

	await h.finish(browser);
});
