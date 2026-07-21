// D5 (roadmap 13): reticle v2 — beams terminate on OPEN floating panels
// (nearest hit wins over scene objects; panels never highlight the object
// behind them) and the reticle ring lays onto the hit surface via the world
// normal (flipped toward the viewer, nudged off the surface), beam-aligned
// when the hit has no normal. In-headset feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure reticle pose math ---
	const pose = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const identity = new THREE.Quaternion();
		// no normal -> beam-aligned ring at the tip
		const flat = s.vrControls.reticlePose(THREE, identity, 2);
		// floor normal, beam straight ahead -> ring lies flat (+Z maps to +Y)
		const floor = s.vrControls.reticlePose(THREE, identity, 2, new THREE.Vector3(0, 1, 0));
		const floorZ = new THREE.Vector3(0, 0, 1).applyQuaternion(
			identity.clone().multiply(floor.quaternion)
		);
		// a backface normal pointing AWAY from the viewer flips toward them
		const away = s.vrControls.reticlePose(THREE, identity, 2, new THREE.Vector3(0, 0, -1));
		const awayZ = new THREE.Vector3(0, 0, 1).applyQuaternion(away.quaternion);
		return {
			flat: {
				q: [flat.quaternion.x, flat.quaternion.y, flat.quaternion.z, flat.quaternion.w],
				pos: [flat.position.x, flat.position.y, flat.position.z],
				scale: flat.scale
			},
			floorZ: [floorZ.x, floorZ.y, floorZ.z],
			floorOffsetY: floor.position.y,
			awayZ: [awayZ.x, awayZ.y, awayZ.z],
			minScale: s.vrControls.reticlePose(THREE, identity, 0.05).scale
		};
	});
	h.check(
		pose.flat.q.join(',') === '0,0,0,1' &&
			pose.flat.pos.join(',') === '0,0,-2' &&
			pose.flat.scale === 2,
		`no normal -> beam-aligned ring at the tip (${pose.flat.q.join(',')})`
	);
	h.check(
		Math.abs(pose.floorZ[1] - 1) < 1e-6,
		`floor hit lays the ring flat: ring +Z maps to world +Y (${pose.floorZ.map((v) => v.toFixed(3))})`
	);
	h.check(
		pose.floorOffsetY > 0.004,
		`ring nudges off the surface along the normal (y offset ${pose.floorOffsetY.toFixed(4)})`
	);
	h.check(
		Math.abs(pose.awayZ[2] - 1) < 1e-6,
		'a normal facing away flips toward the viewer'
	);
	h.check(pose.minScale === 0.2, 'reticle keeps a minimum scale up close');

	// --- beams terminate on open panels, nearest wins ---
	const beam = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		s.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.position.set(0, 1.6, -3);
		box.updateMatrixWorld(true);

		const ray = new THREE.Raycaster();
		ray.ray.origin.set(0, 1.6, 0);
		ray.ray.direction.set(0, 0, -1);

		// fake chat panel 1m ahead (a control mesh like the real vrchat-* ones)
		const panel = new THREE.Group();
		const control = new THREE.Mesh(
			new THREE.PlaneGeometry(0.6, 0.4),
			new THREE.MeshBasicMaterial()
		);
		control.name = 'vrchat-input';
		control.position.set(0, 1.6, -1);
		control.updateMatrixWorld(true);
		panel.add(control);
		panel.updateMatrixWorld(true);

		const closed = s.vrControls.beamTarget(ray);
		s.vrControls.vrChatGroup.set(panel);
		s.vrChatPanelOpen.set(true);
		const open = s.vrControls.beamTarget(ray);
		s.vrChatPanelOpen.set(false);
		s.vrControls.vrChatGroup.set(null);
		const closedAgain = s.vrControls.beamTarget(ray);

		return {
			closed: { d: closed.distance, obj: closed.object?.uuid === box.uuid },
			open: { d: open.distance, obj: open.object, name: open.info?.object?.name },
			closedAgain: { d: closedAgain.distance }
		};
	});
	h.check(
		beam.closed.obj && Math.abs(beam.closed.d - 2.5) < 0.01,
		`panel closed: the beam lands on the box face (d ${beam.closed.d.toFixed(2)})`
	);
	h.check(
		Math.abs(beam.open.d - 1) < 0.01 &&
			beam.open.obj === null &&
			beam.open.name === 'vrchat-input',
		`panel open: the NEARER panel control wins and clears the object hover (d ${beam.open.d.toFixed(2)}, ${beam.open.name})`
	);
	h.check(
		Math.abs(beam.closedAgain.d - 2.5) < 0.01,
		'closing the panel hands the beam back to the scene'
	);

	await h.finish(browser);
});
