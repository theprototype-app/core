// R-2 → 36 (U3): VR settings immediacy. Turning is ONE setting shared by the radial (Settings ▸ Comfort),
// the in-headset panel and desktop Settings ▸ VR — they all render the same row of the settings table —
// and a row's value line follows the store live. Snap / Smooth / Off is its own choice; the snap angle
// (15/30/45/90) another; `vrSnapAngle` 0 still means "snap turning off" (older saves keep working). The
// in-headset feel is the user's check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const m = s.vrRadialMenu;
		const S = s.vrSettingsSchema;
		const g1 = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const value = (id) => m.findMenuEntry(id)?.value?.() ?? null;
		s.vrSnapAngle.set(0);
		const offText = value('set:turning');
		s.vrSnapAngle.set(45);
		const snapText = value('set:turning');
		const angleText = value('set:snapAngle');
		// a radial press cycles Turning: Snap -> Smooth -> Off -> Snap
		const seq = [];
		for (let i = 0; i < 3; i++) {
			m.findMenuEntry('set:turning').action();
			seq.push(S.vrSettingRow('turning').get() + '/' + g1(s.vrSnapAngle) + '/' + g1(s.vrPrefs.vrSmoothTurn));
		}
		// the panel row and the radial sector are the SAME row: the panel's action reads what the radial wrote
		s.vrControls.executeVRMenuAction('vrset:snapAngle');
		const viaPanel = g1(s.vrSnapAngle);
		const turning = s.vrControls.turningInForce();
		// the legacy panel id still flips teleport (back-compat for anything that dispatches it)
		const tele0 = g1(s.vrTeleportEnabled);
		s.vrControls.executeVRMenuAction('settings:teleport');
		const tele1 = g1(s.vrTeleportEnabled);
		return { offText, snapText, angleText, seq, viaPanel, turning, tele0, tele1 };
	});
	h.check(res.offText === 'Off' && res.snapText === 'Snap', `the Turning sector's value is live (${res.offText} → ${res.snapText})`);
	h.check(res.angleText === '45°', `Snap angle shows the stored angle (${res.angleText})`);
	h.check(
		res.seq.join(' ') === 'smooth/45/true off/0/false snap/45/false',
		`a press cycles Snap → Smooth → Off → Snap, Off is vrSnapAngle 0 (${res.seq.join(' ')})`
	);
	h.check(res.viaPanel === 90, `the panel's Snap angle press moves the same store the radial shows (45 → ${res.viaPanel})`);
	h.check(res.turning.mode === 'snap' && res.turning.angle === 90, `vrControls turns by it at once (${JSON.stringify(res.turning)})`);
	h.check(res.tele0 !== res.tele1, `settings:teleport flips the live-read store (${res.tele0} -> ${res.tele1})`);

	await h.finish(browser);
});
