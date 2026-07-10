// Phase 88: serializers park animated objects at their base pose — a session
// saved mid-swing stores the BASE (not the swung pose) and the live animation
// carries on untouched afterwards. Peer-join base capture is covered by the
// module-sdk suite (absolute residual check).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// box + wave graph
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
	await A.page.waitForTimeout(500);

	const rotZ = () =>
		A.page.evaluate(
			(uuid) =>
				new Promise((resolve) => {
					window.__stores.objectsGroup.subscribe((g) =>
						resolve(g?.getObjectByProperty('uuid', uuid)?.rotation.z ?? null)
					)();
				}),
			uuid
		);

	const z1 = await rotZ();
	await A.page.waitForTimeout(300);
	const z2 = await rotZ();
	h.check(z1 !== null && z1 !== z2, 'wave animates the box');

	// the park primitive: park -> exactly at base (0), restore -> swings again
	const parked = await A.page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				const restore = window.__stores.flowRuntime.parkAnimatedAtBase();
				window.__stores.objectsGroup.subscribe((g) => {
					const at = g?.getObjectByProperty('uuid', uuid)?.rotation.z;
					restore();
					resolve(at);
				})();
			}),
		uuid
	);
	h.check(Math.abs(parked) < 0.001, `park puts the object at its base (rot ${parked?.toFixed(3)})`);
	await A.page.waitForTimeout(400);
	const z3 = await rotZ();
	await A.page.waitForTimeout(300);
	const z4 = await rotZ();
	h.check(z3 !== z4, 'animation resumes after restore');

	// a session saved mid-swing stores the BASE pose
	const saved = await A.page.evaluate(async (uuid) => {
		const read = () =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g?.getObjectByProperty('uuid', uuid)?.rotation.z ?? 0)
				)()
			);
		// wait for a moment where the swing is clearly away from the base
		let live = 0;
		for (let i = 0; i < 20; i++) {
			live = await read();
			if (Math.abs(live) > 0.3) break;
			await new Promise((r) => setTimeout(r, 120));
		}
		const payload = await window.__stores.sessions.saveSession('animated-base-test');
		// ObjectLoader json stores the composed matrix; a pure z-rotation puts
		// sin(z) at matrix[1]
		const sinZ = payload.objects[0].object.matrix[1];
		await window.__stores.sessions.deleteSession(payload.id);
		return { live, sinZ };
	}, uuid);
	h.check(Math.abs(saved.live) > 0.3, `scene was mid-swing at save time (rot ${saved.live.toFixed(2)})`);
	h.check(
		Math.abs(saved.sinZ) < 0.05,
		`saved session stores the base pose (sin(z) ${saved.sinZ.toFixed(3)})`
	);

	await h.finish(browser);
});
