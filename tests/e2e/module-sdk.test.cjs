// Phase 30: module SDK — hello wave in palette + runtime, version mismatch toast, peer sync.
const h = require('./helpers.cjs');

const rotationZ = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					resolve(g?.getObjectByProperty('uuid', uuid)?.rotation.z ?? null);
				})();
			}),
		uuid
	);

// Phase-lock check: sampling inside requestAnimationFrame reads the rotation
// the runtime wrote THIS frame, so rot - sin(time*3) is the animation base
// plus at most one frame of lag. That residual must stay constant over time
// on a page that tracks the synced wall clock. A constant offset is expected:
// a peer receiving the object mid-swing bakes the pose into its animation
// base (known artifact, see backlog). Graph uses {amplitude:1, speed:3};
// flowRuntime time = (Date.now() % 86400000) / 1000.
const phaseDrift = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				const sample = () =>
					new Promise((r) =>
						requestAnimationFrame(() => {
							window.__stores.objectsGroup.subscribe((g) => {
								const object = g?.getObjectByProperty('uuid', uuid);
								const time = (Date.now() % 86400000) / 1000;
								r(object ? object.rotation.z - Math.sin(time * 3) : null);
							})();
						})
					);
				sample().then((first) =>
					setTimeout(async () => {
						const second = await sample();
						resolve(first === null || second === null ? null : Math.abs(second - first));
					}, 400)
				);
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const loaded = await A.page.evaluate(() => window.__stores.moduleSDK.loadedModules);
	h.check(loaded.some((m) => m.id === 'hello'), 'hello module loaded');

	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(800);
	const waveVisible = await A.page.getByText('Wave (hello)').first().isVisible().catch(() => false);
	h.check(waveVisible, 'Wave (hello) listed in the flow palette');
	await A.page.locator('p[title="Node editor (N)"]').click();

	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))()
		);
	});
	await A.page.evaluate((uuid) => {
		window.__stores.flowNodes.set([
			{ id: 'w1', type: 'wave', position: { x: 0, y: 0 }, data: { amplitude: 1, speed: 3 } },
			{ id: 's1', type: 'objectselector', position: { x: 250, y: 0 }, data: { selected: uuid } }
		]);
		window.__stores.flowEdges.set([{ id: 'e1', source: 'w1', target: 's1' }]);
	}, uuid);
	await A.page.waitForTimeout(400);
	const z1 = await rotationZ(A.page, uuid);
	await A.page.waitForTimeout(350);
	const z2 = await rotationZ(A.page, uuid);
	h.check(z1 !== z2 && z1 !== null, 'wave effect animates locally');

	await A.page.evaluate(() =>
		window.__stores.moduleSDK.checkModuleVersions([{ id: 'hello', version: '9.9.9' }])
	);
	const toastShown = await A.page.getByText(/version differs/).first().isVisible().catch(() => false);
	h.check(toastShown, 'version mismatch toast shown');

	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 14000); // object sync + nodesync round

	const bz1 = await rotationZ(B.page, uuid);
	await B.page.waitForTimeout(350);
	const bz2 = await rotationZ(B.page, uuid);
	h.check(bz1 !== null, 'box synced to B');
	h.check(bz1 !== bz2, 'wave animates on B too');
	const [da, db] = await Promise.all([phaseDrift(A.page, uuid), phaseDrift(B.page, uuid)]);
	h.check(
		da !== null && db !== null && da < 0.25 && db < 0.25,
		`both peers phase-lock to the synced clock (drift A ${da?.toFixed(3)}, B ${db?.toFixed(3)})`
	);

	await h.finish(browser);
});
