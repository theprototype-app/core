// Roadmap #9 B2: VR target refresh rate (auto/90/120, gated on supportedFrameRates),
// the hands<->controllers switch-broadcast fix (shouldSendHands rep-flip), cuboid
// hand-bone math, and the pinch-HOLD radial opener. On-device feel = user's check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- 2.1 frame-rate picker (fake session over the real renderer.xr) ---
	const hz = await A.page.evaluate(async () => {
		const s = window.__stores;
		let r;
		s.globalRenderer.subscribe((x) => (r = x))();
		const calls = [];
		const orig = r.xr.getSession;
		const fake = (rates) => ({ supportedFrameRates: rates, updateTargetFrameRate: (v) => (calls.push(v), Promise.resolve()) });
		r.xr.getSession = () => fake([72, 90, 120]);
		s.vrTargetHz.set('auto');
		const auto = s.vrControls.applyVRFrameRate();
		s.vrTargetHz.set('90');
		const ninety = s.vrControls.applyVRFrameRate();
		r.xr.getSession = () => fake([72, 90]); // device without 120
		s.vrTargetHz.set('120');
		const fallback = s.vrControls.applyVRFrameRate();
		r.xr.getSession = orig;
		return { auto, ninety, fallback, calls };
	});
	h.check(hz.auto === 120 && hz.ninety === 90, `auto picks max, 90 honored (${hz.auto}/${hz.ninety})`);
	h.check(hz.fallback === 90, `unsupported 120 falls back to the device max (${hz.fallback})`);
	h.check(hz.calls.join(',') === '120,90,90', `updateTargetFrameRate called with supported rates only (${hz.calls})`);
	const persisted = await A.page.evaluate(() => localStorage.getItem('vrTargetHz'));
	h.check(persisted === '120', 'vrTargetHz persists');

	// --- 2.2 rep-flip send decision (the hands->controllers fix) ---
	const send = await A.page.evaluate(() => {
		const f = window.__stores.vrControls.shouldSendHands;
		return {
			stuckBefore: f({ moved: false, hasJoints: false, prevLens: [75, 75], lens: [0, 0] }), // the old bug: must be true now
			idleController: f({ moved: false, hasJoints: false, prevLens: [0, 0], lens: [0, 0] }),
			handsAlways: f({ moved: false, hasJoints: true, prevLens: [75, 75], lens: [75, 75] })
		};
	});
	h.check(send.stuckBefore === true, 'hands->controllers flip forces a send (regression)');
	h.check(send.idleController === false, 'idle controllers still gated (no spam)');
	h.check(send.handsAlways === true, 'hand-tracking keeps streaming');

	// --- 2.3 cuboid bone math ---
	const bones = await A.page.evaluate(() => {
		const joints = [];
		for (let i = 0; i < 25; i++) joints.push(i * 0.01, 0, 0); // a straight line hand
		const segs = window.__stores.vrControls.handBoneSegments(joints);
		return { count: segs.length, allPositive: segs.every((b) => b.len > 0), first: segs[0] };
	});
	h.check(bones.count === 24, `24 bone segments (${bones.count})`);
	h.check(bones.allPositive, 'all bone lengths positive');

	// --- 2.4 pinch-HOLD toggles the radial on the menu hand ---
	const pinch = await A.page.evaluate(async () => {
		const s = window.__stores;
		let hand;
		s.vrMenuHand.subscribe((x) => (hand = x))();
		const read = () => {
			let v;
			s.vrMenuOpen.subscribe((x) => (v = x))();
			return v;
		};
		s.vrMenuOpen.set(false);
		// quick pinch: no toggle (native select handles it)
		s.vrControls.onHandPinchStart(hand);
		const quick = s.vrControls.onHandPinchEnd(hand);
		const afterQuick = read();
		// held pinch: toggles
		s.vrControls.onHandPinchStart(hand);
		await new Promise((r) => setTimeout(r, 600));
		const held = s.vrControls.onHandPinchEnd(hand);
		const afterHeld = read();
		// wrong hand: never toggles
		const other = hand === 'left' ? 'right' : 'left';
		s.vrControls.onHandPinchStart(other);
		await new Promise((r) => setTimeout(r, 600));
		const wrong = s.vrControls.onHandPinchEnd(other);
		return { quick, afterQuick, held, afterHeld, wrong };
	});
	h.check(pinch.quick === false && pinch.afterQuick === false, 'quick pinch does not toggle the radial');
	h.check(pinch.held === true && pinch.afterHeld === true, 'pinch-hold >=500ms toggles the radial');
	h.check(pinch.wrong === false, 'the pointer hand pinch never opens the menu');
	await A.page.evaluate(() => window.__stores.vrMenuOpen.set(false));

	await h.finish(browser);
});
