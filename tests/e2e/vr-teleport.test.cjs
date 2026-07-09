// Phase 53: teleport arc math (headless): ballistic landings on the ground and
// on object tops; steeper aim lands closer. Blink/stick feel is on-device.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const arc = (originArr, dirArr, withBox) =>
		A.page.evaluate(
			({ originArr, dirArr, withBox }) =>
				new Promise((resolve) => {
					const THREE = window.__stores.THREE;
					window.__stores.objectsGroup.subscribe((group) => {
						const result = window.__stores.vrControls.computeTeleportArc(
							new THREE.Vector3(...originArr),
							new THREE.Vector3(...dirArr),
							withBox ? group : null
						);
						resolve({
							points: result.points.length,
							target: result.target ? [result.target.x, result.target.y, result.target.z] : null
						});
					})();
				}),
			{ originArr, dirArr, withBox }
		);

	// slightly downward forward aim lands ahead on the ground
	let r = await arc([0, 1.6, 0], [0, -0.2, -1], false);
	h.check(
		r.target && Math.abs(r.target[1]) < 0.01 && r.target[2] < -2,
		`forward aim lands ahead on the ground (${JSON.stringify(r.target)})`
	);
	h.check(r.points >= 3, `arc has a visible curve (${r.points} samples)`);

	// steeper aim lands closer
	const far = r.target[2];
	r = await arc([0, 1.6, 0], [0, -0.9, -0.6], false);
	h.check(
		r.target && r.target[2] > far,
		`steeper aim lands closer (${r.target?.[2].toFixed(2)} vs ${far.toFixed(2)})`
	);

	// a wide platform catches the arc on its top face
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.scale.set(6, 1, 6);
		box.position.set(0, 0.5, -4);
		box.updateMatrixWorld(true);
	});
	r = await arc([0, 1.6, 0], [0, -0.05, -1], true);
	h.check(
		r.target && Math.abs(r.target[1] - 1) < 0.05,
		`arc lands on the platform top (y ${r.target?.[1].toFixed(2)})`
	);

	// straight up comes back down to your own feet (still a valid landing)
	r = await arc([0, 1.6, 0], [0, 1, 0], false);
	h.check(
		r.target && Math.abs(r.target[0]) < 0.01 && Math.abs(r.target[2]) < 0.01,
		'straight up lands at your feet'
	);

	await h.finish(browser);
});
