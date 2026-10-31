// fix-batch-1 (docs-1 CORE BUGS): two nodes counted from the CLOCK's origin instead of from when they
// started — and the synced clock is seconds since midnight, so the start was always long past:
//   · Rotate / Motor's spin-up ramp: every wheel turned at full speed from the first frame;
//   · HUD Timer with Autostart: `duration - time` read 0 the moment it appeared.
// Measured: a 60 rpm rotor with a 3 s spin-up turns well under its post-ramp speed in its first
// half-second; an autostart 60 s timer starts near 60 and counts down.
// COUNTERFACTUAL (4cd3dafc): the rotor is at full speed at once; the timer reads 0.
// Run: APP_URL=https://theprototype.app:5591/ node tests/e2e/flow-clock-origin.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const p = A.page;

	const uuid = await p.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.name = 'Wheel';
		window.__wheel = box;
		return box.uuid;
	});
	await p.waitForTimeout(600);

	/** the wheel's angle about +y (rad, unwrapped by the caller) */
	const angle = () =>
		p.evaluate(() => {
			const q = window.__wheel.quaternion;
			return 2 * Math.atan2(q.y, q.w);
		});
	/** angular speed over `ms`, unwrapped for one turn at most */
	const speed = async (ms) => {
		const a = await angle();
		const t0 = Date.now();
		await p.waitForTimeout(ms);
		const b = await angle();
		const dt = (Date.now() - t0) / 1000;
		let d = b - a;
		while (d < -Math.PI) d += 2 * Math.PI;
		while (d > Math.PI) d -= 2 * Math.PI;
		return Math.abs(d) / dt;
	};
	const FULL = 2 * Math.PI; // 60 rpm in rad/s

	await p.evaluate((u) => {
		const s = window.__stores;
		s.flowNodes.set([
			{
				id: 'rot',
				type: 'rotor',
				position: { x: 0, y: 0 },
				data: { label: 'Rotate / Motor', axis: 'y', rpm: 60, torque: 50, spinUp: 3, on: true }
			},
			{
				id: 'sel',
				type: 'objectselector',
				position: { x: 300, y: 0 },
				data: { label: 'Object', selected: u }
			},
			{
				id: 'tmr',
				type: 'hudtimer',
				position: { x: 0, y: 200 },
				data: {
					label: 'HUD Timer',
					element: 'fb1auto',
					duration: 60,
					format: '{v}',
					decimals: 0,
					autostart: true
				}
			}
		]);
		s.flowEdges.set([{ id: 'e-rot-sel', source: 'rot', target: 'sel' }]);
	}, uuid);
	await p.waitForTimeout(150);
	const early = await speed(350);
	const timerEarly = await p.evaluate(
		() =>
			new Promise((r) => window.__stores.hudDocs.hudRuntime.subscribe((v) => r(v.fb1auto?.text))())
	);
	await p.waitForTimeout(3200);
	const late = await speed(400);
	const timerLate = await p.evaluate(
		() =>
			new Promise((r) => window.__stores.hudDocs.hudRuntime.subscribe((v) => r(v.fb1auto?.text))())
	);
	console.log('rotor', JSON.stringify({ early, late, full: FULL }), 'timer', timerEarly, timerLate);

	// the page samples the pose per FRAME while the window is wall-clock (round-trips included), so an
	// absolute rad/s reads ~20 % low on a headless page — the claims are a RATIO against the same
	// wheel after its ramp, plus a floor that a stopped or crawling wheel cannot pass
	h.check(
		late > 0.6 * FULL,
		`premise: after the 3 s ramp the wheel turns near 60 rpm (${late.toFixed(2)} of ${FULL.toFixed(2)} rad/s)`
	);
	h.check(
		early < 0.4 * late,
		`Rotate / Motor spins UP: its first half-second is well under its speed after the ramp (${early.toFixed(2)} vs ${late.toFixed(2)} rad/s)`
	);
	h.check(
		Number(timerEarly) >= 58 && Number(timerEarly) <= 60,
		`HUD Timer with Autostart starts at its duration, not 0 (${timerEarly})`
	);
	h.check(
		Number(timerLate) < Number(timerEarly) && Number(timerLate) >= 54,
		`…and counts down (${timerEarly} -> ${timerLate})`
	);

	h.check(
		h.pageErrors(A).length === 0,
		`no page errors (${JSON.stringify(h.pageErrors(A)).slice(0, 200)})`
	);
	await h.finish(browser);
});
