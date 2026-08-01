// CL-A A1/A7: colliderSpecOf (one source of truth for shapes) + the collider
// visualization — global toggle, per-object union, proxy follow, sensor amber,
// hidden in wireframe view mode.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// 1) colliderSpecOf: box / rotated box / sphere
	const spec = await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 2 1 4');
		cmd('/create Sphere 0.5');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 2];
		const ball = g.children[g.children.length - 1];
		box.rotation.z = 0.6;
		box.updateMatrixWorld(true);
		ball.userData.physics = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		window.__box = box;
		window.__ball = ball;
		const specOf = window.__stores.colliderSpec.colliderSpecOf;
		const boxSpec = specOf(box);
		const ballSpec = specOf(ball, 'sphere');
		return {
			boxKind: boxSpec.kind,
			// rotation must NOT inflate the local measure (the oriented-collider rule)
			boxHe: [boxSpec.halfExtents.x, boxSpec.halfExtents.y, boxSpec.halfExtents.z],
			boxQuatZ: boxSpec.quat.z,
			ballKind: ballSpec.kind,
			ballHe: ballSpec.halfExtents.x
		};
	});
	h.check(spec.boxKind === 'box', `box spec kind (${spec.boxKind})`);
	h.check(
		Math.abs(spec.boxHe[0] - 1) < 0.01 && Math.abs(spec.boxHe[1] - 0.5) < 0.01 && Math.abs(spec.boxHe[2] - 2) < 0.01,
		`rotated box keeps LOCAL half extents (${spec.boxHe.map((v) => v.toFixed(2))})`
	);
	h.check(Math.abs(spec.boxQuatZ) > 0.05, 'spec carries the rotation on quat');
	h.check(spec.ballKind === 'sphere' && Math.abs(spec.ballHe - 0.5) < 0.01, 'sphere spec');

	// 2) hull spec produces pieces
	const hull = await A.page.evaluate(() => {
		const s = window.__stores.colliderSpec.colliderSpecOf(window.__ball, 'hull');
		return { kind: s.kind, pieces: s.pieces?.length ?? 0, verts: s.pieces?.[0]?.verts?.length ?? 0 };
	});
	h.check(hull.kind === 'hull' && hull.pieces === 1 && hull.verts > 30, `hull spec pieces (${JSON.stringify(hull)})`);

	// 3) global toggle shows proxies for physics-carrying objects, off hides
	await A.page.evaluate(() => window.__stores.colliderHelpers.showColliders.set(true));
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.colliderHelpers.colliderHelpersDebug().length),
		(n) => n >= 1,
		'global toggle builds proxies'
	);
	const proxyGroup = await A.page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const root = scene.getObjectByName('collider-proxies');
		return { exists: !!root, children: root?.children.length ?? 0 };
	});
	h.check(proxyGroup.exists && proxyGroup.children >= 1, `scene-root proxy group (${JSON.stringify(proxyGroup)})`);
	await A.page.evaluate(() => window.__stores.colliderHelpers.showColliders.set(false));
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.colliderHelpers.colliderHelpersDebug().length),
		(n) => n === 0,
		'toggle off reaps proxies'
	);

	// 4) per-object union: viz set keeps one proxy while global is off
	await A.page.evaluate(() => window.__stores.colliderHelpers.setColliderViz(window.__ball.uuid, true));
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.colliderHelpers.colliderHelpersDebug().map((e) => e.uuid)),
		(list) => list.length === 1,
		'per-object viz union'
	);

	// 5) proxy follows a moved object (per-frame follow)
	const follow = await A.page.evaluate(async () => {
		window.__ball.position.set(5, 2, -3);
		window.__ball.updateMatrixWorld(true);
		await new Promise((r) => setTimeout(r, 300)); // a few frames
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const root = scene.getObjectByName('collider-proxies');
		const proxy = root?.children[0];
		return proxy ? { x: proxy.position.x, y: proxy.position.y, z: proxy.position.z } : null;
	});
	h.check(
		follow && Math.abs(follow.x - 5) < 0.1 && Math.abs(follow.y - 2) < 0.1 && Math.abs(follow.z + 3) < 0.1,
		`proxy follows the object (${JSON.stringify(follow)})`
	);

	// 6) sensor flag rebuilds the proxy amber (0xf59e0b)
	const sensorColor = await A.page.evaluate(async () => {
		window.__ball.userData.physics = { ...window.__ball.userData.physics, sensor: true };
		window.__stores.objectsGroup.update((v) => v);
		await new Promise((r) => setTimeout(r, 400)); // debounced sync
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const proxy = scene.getObjectByName('collider-proxies')?.children[0];
		return proxy?.children[0]?.material.color.getHex() ?? 0;
	});
	h.check(sensorColor === 0xf59e0b, `sensor proxy is amber (#${sensorColor.toString(16)})`);

	// 7) hidden in wireframe view mode
	const wire = await A.page.evaluate(async () => {
		window.__stores.viewMode.set('wireframe');
		await new Promise((r) => setTimeout(r, 300));
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const rootHidden = !scene.getObjectByName('collider-proxies').visible;
		window.__stores.viewMode.set('shaded');
		await new Promise((r) => setTimeout(r, 300));
		const rootBack = scene.getObjectByName('collider-proxies').visible;
		return { rootHidden, rootBack };
	});
	h.check(wire.rootHidden && wire.rootBack, `wireframe mode hides proxies (${JSON.stringify(wire)})`);

	// 8) custom spec: stored colliderVerts split into pieces
	const custom = await A.page.evaluate(() => {
		const tri = (ox) => [ox, 0, 0, ox + 0.5, 0, 0, ox, 0.5, 0, ox, 0, 0, ox + 0.5, 0, 0, ox, 0, 0.5];
		window.__ball.userData.physics = {
			mode: 'dynamic',
			mass: 1,
			collider: 'custom',
			colliderVerts: [...tri(0), ...tri(3)],
			colliderPieces: [
				[0, 18],
				[18, 18]
			]
		};
		const s = window.__stores.colliderSpec.colliderSpecOf(window.__ball);
		return { kind: s.kind, pieces: s.pieces?.length ?? 0 };
	});
	h.check(custom.kind === 'custom' && custom.pieces === 2, `custom spec pieces (${JSON.stringify(custom)})`);

	await h.finish(browser);
});
