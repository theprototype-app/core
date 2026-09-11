// Phase 79: light catalog — spot + rect area addable, all params replicate
// through the full-object resend, spot aim replicates, shadow map size rides
// userData under the local quality cap.
const h = require('./helpers.cjs');

const lightOf = (page, name) =>
	page.evaluate(
		(name) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const l = g?.children.find((c) => c.name === name);
					r(
						l
							? {
									type: l.type,
									intensity: l.intensity,
									angle: l.angle ?? null,
									penumbra: l.penumbra ?? null,
									distance: l.distance ?? null,
									width: l.width ?? null,
									height: l.height ?? null,
									castShadow: l.castShadow,
									bias: l.shadow?.bias ?? null,
									mapWish: l.userData?.shadowMapSize ?? null,
									mapReal: l.shadow?.mapSize.x ?? null,
									// 24-E1: rotation drives direction — the old userData.spotTarget is
									// migrated into a rotation; report the forward and the position instead
									target: l.userData?.spotTarget ?? null,
									forward: (() => {
										const T = window.__stores.THREE;
										l.updateMatrixWorld(true);
										const q = new T.Quaternion();
										l.getWorldQuaternion(q);
										return new T.Vector3(0, 0, -1).applyQuaternion(q).toArray();
									})(),
									pos: l.getWorldPosition(new window.__stores.THREE.Vector3()).toArray()
								}
							: null
					);
				})()
			),
		name
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// spot + rect area exist and replicate
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/light spot');
		window.__stores.commandsHandler.sceneCommand('/light rectarea');
	});
	await h.eventually(
		() => Promise.all([lightOf(B.page, 'Spot'), lightOf(B.page, 'RectArea')]),
		([spot, rect]) => spot?.type === 'SpotLight' && rect?.type === 'RectAreaLight',
		'spot + rect area replicated to B'
	);

	// edit spot params + aim + shadow settings on A
	await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const spot = g.children.find((c) => c.name === 'Spot');
		spot.angle = 0.4;
		spot.penumbra = 0.5;
		spot.distance = 25;
		spot.castShadow = true;
		spot.shadow.bias = -0.002;
		// 24-E1: "Aim at" is a one-shot lookAt that writes the ROTATION; the old
		// `lighttarget` message still lands on a peer as the same lookAt
		window.__stores.lightParams.aimLight(spot, [3, 0, -2]);
		window.__stores.lightParams.setShadowMapSize(spot, 2048);
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'lighttarget', uuid: spot.uuid, pos: [3, 0, -2] });
		peer.send({ type: 'object', element: spot.toJSON(), override: true });
	});
	/** does the light's forward point at `p` from its position? */
	const aimsAt = (light, p) => {
		if (!light?.forward || !light?.pos) return false;
		const d = [p[0] - light.pos[0], p[1] - light.pos[1], p[2] - light.pos[2]];
		const n = Math.hypot(...d) || 1;
		const f = light.forward;
		return Math.abs((f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / n - 1) < 1e-3;
	};
	await h.eventually(
		() => lightOf(B.page, 'Spot'),
		(spot) =>
			spot &&
			Math.abs(spot.angle - 0.4) < 0.01 &&
			Math.abs(spot.penumbra - 0.5) < 0.01 &&
			spot.distance === 25 &&
			spot.castShadow === true &&
			Math.abs(spot.bias + 0.002) < 0.0005 &&
			spot.mapWish === 2048 &&
			spot.target === null &&
			aimsAt(spot, [3, 0, -2]),
		'spot params, shadow settings and aim replicated (as a rotation, no userData.spotTarget)'
	);

	// rect area width/height replicate
	await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const rect = g.children.find((c) => c.name === 'RectArea');
		rect.width = 7;
		rect.height = 3;
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'object', element: rect.toJSON(), override: true });
	});
	await h.eventually(
		() => lightOf(B.page, 'RectArea'),
		(rect) => rect && rect.width === 7 && rect.height === 3,
		'rect area size replicated'
	);

	// local shadow quality cap: low caps the applied map size, wish stays
	await A.page.evaluate(() => window.__stores.lightParams.shadowQuality.set('low'));
	await A.page.waitForTimeout(200);
	const capped = await lightOf(A.page, 'Spot');
	h.check(capped.mapWish === 2048 && capped.mapReal === 512, `low quality caps 2048 → 512 locally (${capped.mapReal})`);
	await A.page.evaluate(() => window.__stores.lightParams.shadowQuality.set('high'));
	await A.page.waitForTimeout(200);
	const uncapped = await lightOf(A.page, 'Spot');
	h.check(uncapped.mapReal === 2048, 'high quality restores the wished size');

	// 24-E1: the helpers tick keeps `light.target` in the scene ALONG THE FORWARD (the
	// shadow camera reads it), one helper length away — not at the old aim point
	const aimed = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const spot = g?.children.find((c) => c.name === 'Spot');
					if (!spot) return r(null);
					const T = window.__stores.THREE;
					spot.updateMatrixWorld(true);
					const q = new T.Quaternion();
					spot.getWorldQuaternion(q);
					const f = new T.Vector3(0, 0, -1).applyQuaternion(q);
					const p = spot.getWorldPosition(new T.Vector3());
					const t = spot.target.getWorldPosition(new T.Vector3());
					const d = t.clone().sub(p);
					r({ parented: !!spot.target.parent, along: d.length() > 0.1 && Math.abs(d.normalize().dot(f) - 1) < 1e-3 });
				})()
			)
	);
	h.check(aimed?.parented && aimed.along, `spot target is in the scene along the light's forward (${JSON.stringify(aimed)})`);

	await h.finish(browser);
});
