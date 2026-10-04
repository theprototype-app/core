// 36-vr — the gap audit's EMULATED probe (a tool, not a suite): drives the real per-frame VR path
// through fakeXR and prints what each suspected-broken row actually does. Run on the unchanged
// code it records the BEFORE state; vr-settings-36 asserts the fixed behaviour.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await xr.install(page);
	await xr.pose(page, 'left', [-0.3, 1.1, 0.6], { pitch: -1.3 });
	await xr.pose(page, 'right', [0.3, 1.1, 0.6], { pitch: -1.3 });
	const settle = () => page.waitForTimeout(180);
	const read = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g = (st) => {
				let v;
				st?.subscribe?.((x) => (v = x))();
				return v;
			};
			return {
				open: g(s.vrMenuOpen),
				ring: g(s.vrRadialMenu.activeRing),
				hand: g(s.vrMenuHand),
				settings: g(s.vrSettingsPanelOpen),
				hov: g(s.vrControls.vrHovered)
			};
		});
	const out = {};
	const hand = (await read()).hand;

	// B1: hold-to-menu, release over a NAV sector
	await page.evaluate(() => window.__stores.vrMenuHold.set(true));
	await xr.button(page, hand, 5, true);
	await settle();
	// stick toward sector 1 (Add ▸, 1 o'clock)
	const a = (1 * Math.PI * 2) / 8;
	await xr.stick(page, hand, Math.sin(a), -Math.cos(a));
	await settle();
	const held = await read();
	await xr.button(page, hand, 5, false);
	await xr.stick(page, hand, 0, 0);
	await settle();
	const released = await read();
	out.B1_holdReleaseOverNav = { hoveredWhileHeld: held.hov, afterRelease: released };
	await page.evaluate(() => window.__stores.vrMenuHold.set(false));
	await page.evaluate(() => window.__stores.vrRadialMenu.resetRings());

	// B2: System ▸ Settings, then can the settings panel be reached while the radial stays up?
	await page.evaluate(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('nav:system');
		s.vrControls.executeVRMenuAction('settings');
	});
	await settle();
	out.B2_settingsFromRadial = await read();
	await page.evaluate(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(false);
		s.vrSettingsPanelOpen.set(false);
	});

	// B3/B4: comfort vignette + smooth turning OUTSIDE a game (Edit, plain scene)
	out.B3_B4 = await page.evaluate(() => {
		const s = window.__stores;
		const v = s.vrControls;
		return {
			turning: v.turningInForce(),
			hasDeviceVignette: Object.keys(s).filter((k) => /vignette/i.test(k)),
			hasDeviceTurnMode: Object.keys(s).filter((k) => /turnmode|smoothturn/i.test(k))
		};
	});

	// B6: the settings panel has no stick navigation (objects/props panels do)
	await page.evaluate(() => window.__stores.vrSettingsPanelOpen.set(true));
	await settle();
	await xr.stick(page, hand === 'left' ? 'right' : 'left', 0, 1);
	await settle();
	await xr.stick(page, hand === 'left' ? 'right' : 'left', 0, 0);
	out.B6_settingsStick = await read();
	await page.evaluate(() => window.__stores.vrSettingsPanelOpen.set(false));

	console.log('PROBE ' + JSON.stringify(out, null, 1));
	await h.finish(browser);
});
