// 15-A3: type-inferred default collider shapes — colliderSpecOf falls back to
// the primitive's natural shape (sphere -> ball, wedge/ramp -> hull, cone ->
// the new cone kind) when nothing explicit is stored. Deterministic across
// peers: inference reads only replicated object data (colliderHint stamp,
// geometryParams.gtype, block NAME for legacy scenes).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const specOf = (name) =>
		A.page.evaluate((name) => {
			window.__stores.commandsHandler.sceneCommand('/create ' + name);
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.children[g.children.length - 1];
			const s = window.__stores.colliderSpec.colliderSpecOf(o);
			return { kind: s.kind, pieces: s.pieces?.length ?? 0, fallback: !!s.fallback };
		}, name);

	const cases = [
		['Box', 'box'],
		['Sphere', 'sphere'],
		['Cylinder', 'cylinder'],
		['Capsule', 'capsule'],
		['Cone', 'cone'],
		['Torus', 'hull'],
		['Icosahedron', 'hull'],
		['Plane', 'box'],
		['Wedge', 'hull'],
		['Stairs', 'hull'],
		['Arch', 'hull'],
		['Corner', 'hull']
	];
	for (const [name, kind] of cases) {
		const s = await specOf(name);
		h.check(s.kind === kind && !s.fallback, `${name} infers ${kind} (got ${s.kind}${s.fallback ? ', fallback' : ''})`);
	}

	// an explicit Inspector pick always wins over inference
	const explicit = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const sphere = g.children.find((c) => c.name === 'Sphere');
		sphere.userData.physics = { ...(sphere.userData.physics ?? {}), collider: 'box' };
		return window.__stores.colliderSpec.colliderSpecOf(sphere).kind;
	});
	h.check(explicit === 'box', `explicit collider beats inference (${explicit})`);

	// building blocks stamp userData.colliderHint at creation, so a RENAME
	// cannot flip their inferred hull back to a box
	const renamed = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const wedge = g.children.find((c) => c.name === 'Wedge');
		const hint = wedge.userData.colliderHint ?? null;
		wedge.name = 'MyRamp';
		return { hint, kind: window.__stores.colliderSpec.colliderSpecOf(wedge).kind };
	});
	h.check(renamed.hint === 'hull', `blocks stamp colliderHint (${renamed.hint})`);
	h.check(renamed.kind === 'hull', `renamed block keeps its hull (${renamed.kind})`);

	// LEGACY block (a pre-15-A3 scene: no hint, no geometryParams) — the
	// replicated NAME still infers the hull
	const legacy = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const stairs = g.children.find((c) => c.name === 'Stairs');
		delete stairs.userData.colliderHint;
		delete stairs.userData.geometryParams;
		return window.__stores.colliderSpec.colliderSpecOf(stairs).kind;
	});
	h.check(legacy === 'hull', `legacy block name infers hull (${legacy})`);

	// the new cone kind: sane spec dims on a scaled cone (physics desc + viz
	// wireframe both consume this same spec)
	const cone = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const c = g.children.find((o) => o.name === 'Cone');
		c.scale.set(2, 3, 2);
		c.updateMatrixWorld(true);
		const s = window.__stores.colliderSpec.colliderSpecOf(c);
		return { kind: s.kind, hx: s.halfExtents.x, hy: s.halfExtents.y, hz: s.halfExtents.z };
	});
	h.check(
		cone.kind === 'cone' && cone.hx > 0 && cone.hy > 0 && cone.hz > 0,
		`scaled cone spec sane (${JSON.stringify(cone)})`
	);

	// imports/unstamped meshes keep the universal box fallback byte-identical
	const unstamped = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children.find((c) => c.name === 'Box');
		delete box.userData.geometryParams;
		box.name = 'imported-thing';
		return window.__stores.colliderSpec.colliderSpecOf(box).kind;
	});
	h.check(unstamped === 'box', `unstamped mesh stays box (${unstamped})`);

	await h.finish(browser);
});
