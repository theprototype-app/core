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
									target: l.userData?.spotTarget ?? null
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
		spot.userData.spotTarget = [3, 0, -2];
		window.__stores.lightParams.setShadowMapSize(spot, 2048);
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'lighttarget', uuid: spot.uuid, pos: [3, 0, -2] });
		peer.send({ type: 'object', element: spot.toJSON(), override: true });
	});
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
			spot.target?.[0] === 3,
		'spot params, shadow settings and aim replicated'
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

	// spot aim enforcement puts the target into the scene (helpers tick)
	const aimed = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const spot = g?.children.find((c) => c.name === 'Spot');
					r(spot ? { parented: !!spot.target.parent, pos: spot.target.position.toArray() } : null);
				})()
			)
	);
	h.check(aimed?.parented && aimed.pos[0] === 3 && aimed.pos[2] === -2, 'spot target enforced in the scene');

	await h.finish(browser);
});
