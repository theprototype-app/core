// Phase 195: two-grip world-grab moves the local worldRig (the group wrapping the
// replicated content), NOT the camera — so presence broadcast in scene-root coords
// left peers seeing the grabber frozen. Fix: broadcast head + hands in the shared
// CONTENT frame (worldRig-local) via worldToContentPose, and render peer avatars
// back through the viewer's own rig (Player's peerFrame). Here we verify the frame
// math is INVERTIBLE (content-local round-trips back to the original world pose, so
// all peers agree) and that an unbent/absent rig is a NO-OP (desktop + normal VR
// presence path is byte-unchanged). Live two-peer world-grab feel is on-device.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const w2c = s.vrControls.worldToContentPose;
		if (!THREE || !w2c) return { missing: true };

		// a BENT rig: translate + rotate + non-unit scale (a full world-grab)
		const rig = new THREE.Group();
		rig.position.set(3, 1, -2);
		rig.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0.3));
		rig.scale.setScalar(2);
		rig.updateWorldMatrix(true, false);

		// where the sender's head/hand actually is, in world (scene-root) space
		const worldPos = new THREE.Vector3(5, 2, 1);
		const worldQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.6, -0.2));

		// -> content frame (mutates the copies in place, as the broadcast path does)
		const cPos = worldPos.clone();
		const cQuat = worldQuat.clone();
		w2c(rig, cPos, cQuat);

		// a receiver recovers the world pose by rendering the content-local pose
		// UNDER its own rig (peerFrame == rig): localToWorld + rigWorldQuat * cQuat
		const backPos = rig.localToWorld(cPos.clone());
		const rigWQ = rig.getWorldQuaternion(new THREE.Quaternion());
		const backQuat = rigWQ.clone().multiply(cQuat);
		const posErr = backPos.distanceTo(worldPos);
		const quatErr = backQuat.angleTo(worldQuat);

		// content-local must actually DIFFER from world under a bent rig (else the
		// grab still wouldn't move you) — sanity that the transform did something
		const movedIntoFrame = cPos.distanceTo(worldPos);

		// identity rig => byte no-op (desktop + normal VR unchanged)
		const idRig = new THREE.Group();
		idRig.updateWorldMatrix(true, false);
		const iPos = new THREE.Vector3(7, 8, 9);
		const iQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0.3));
		const iPos0 = iPos.clone(), iQuat0 = iQuat.clone();
		w2c(idRig, iPos, iQuat);
		const idPosErr = iPos.distanceTo(iPos0);
		const idQuatErr = iQuat.angleTo(iQuat0);

		// null rig => no throw, no mutation (guard for pre-mount / non-VR)
		let nullOk = true;
		try {
			const np = new THREE.Vector3(1, 2, 3);
			w2c(null, np, new THREE.Quaternion());
			nullOk = np.x === 1 && np.y === 2 && np.z === 3;
		} catch {
			nullOk = false;
		}

		return { posErr, quatErr, movedIntoFrame, idPosErr, idQuatErr, nullOk };
	});

	h.check(!res.missing, 'THREE + worldToContentPose are exposed');
	h.check(res.posErr < 1e-4, 'content-frame position round-trips back to the world pose (peers agree)');
	h.check(res.quatErr < 1e-4, 'content-frame orientation round-trips back to the world pose');
	h.check(res.movedIntoFrame > 0.5, 'a bent rig actually moves the pose into content frame (grab has an effect)');
	// (angleTo uses acos, whose float noise floors ~1e-8 even for an exact no-op)
	h.check(res.idPosErr < 1e-6 && res.idQuatErr < 1e-6, 'identity rig is a no-op (desktop + normal VR unchanged)');
	h.check(res.nullOk, 'null rig is a safe no-op');

	await h.finish(browser);
});
