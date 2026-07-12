// Phase 155: VR snap-turn can be mirrored (flip the flick direction) or turned
// off. The pure snapTurnRadians helper flips sign when mirrored and returns 0
// when off; both settings persist across reload. On-device feel is manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const Q = Math.PI / 4; // degToRad(45)

	// --- pure snap-turn helper ---
	const pure = await A.page.evaluate(() => {
		const f = window.__stores.vrControls.snapTurnRadians;
		return {
			normalRight: f(45, 1, false),
			mirroredRight: f(45, 1, true),
			normalLeft: f(45, -1, false),
			off: f(0, 1, false),
			offMirror: f(0, 1, true)
		};
	});
	h.check(Math.abs(pure.normalRight + Q) < 1e-6, `a right flick turns one way (${pure.normalRight.toFixed(3)})`);
	h.check(Math.abs(pure.mirroredRight - Q) < 1e-6, 'mirror flips the turn direction');
	h.check(Math.abs(pure.normalRight + pure.mirroredRight) < 1e-9, 'mirrored is the exact opposite sign');
	h.check(Math.abs(pure.normalLeft - Q) < 1e-6, 'a left flick turns the other way');
	h.check(pure.off === 0 && pure.offMirror === 0, 'Off returns zero turn (snap-turn disabled)');

	// --- both settings persist across reload ---
	await A.page.evaluate(() => {
		localStorage.setItem('vrSnapAngle', '0');
		localStorage.setItem('vrMirrorSnapTurn', 'true');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => !!window.__stores && !!window.__stores.vrControls, { timeout: 30000 });
	await A.page.waitForTimeout(400);
	const persisted = await A.page.evaluate(() => {
		let a, m;
		window.__stores.vrSnapAngle.subscribe((v) => (a = v))();
		window.__stores.vrMirrorSnapTurn.subscribe((v) => (m = v))();
		return { a, m };
	});
	h.check(persisted.a === 0, 'snap-turn Off (angle 0) persists across reload');
	h.check(persisted.m === true, 'mirror snap-turn persists across reload');

	await h.finish(browser);
});
