// 36 X2: exact (trimesh) colliders for STATIC bodies, in the real app — the
// Inspector offers "Exact mesh (static)" only when the body is not dynamic, a
// static Arch infers it, a ball rolls THROUGH the arch opening (the hull, the
// counterfactual, stops it), a mid-sim switch rebuilds live, a dynamic body is
// downgraded to its hull with a toast, the viz draws the mesh, and the pick
// replicates to a peer. Evidence screenshots land in the lane folder.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.env.HOME || '', '.code/lanes-30/after-36/36-colliders');

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	// B joins FIRST (the suites' convention): every later edit must reach it
	await h.connect(B, A);

	// scene: an Arch across the z axis, a small ball 3 m in front of its opening
	await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Arch');
		cmd('/create Sphere 0.2');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__arch = g.children.find((c) => c.name === 'Arch');
		window.__ball = g.children.find((c) => c.name === 'Sphere');
		window.__park = () => {
			window.__ball.position.set(0, 0.25, -3);
			window.__ball.quaternion.set(0, 0, 0, 1);
			window.__ball.updateMatrixWorld(true);
		};
		window.__park();
		window.__stores.physics.setPhysicsFor(window.__arch.uuid, { mode: 'static' });
		window.__stores.physics.setPhysicsFor(window.__ball.uuid, { mode: 'dynamic', mass: 1, collider: 'sphere' });
	});

	const hint = await A.page.evaluate(() => window.__arch.userData.colliderHint);
	h.check(hint === 'trimesh', `a new Arch stamps the exact-mesh hint (${hint})`);

	// --- 1) the Inspector offers the exact mesh for a static body, not a dynamic one
	await A.page.evaluate(() => window.__stores.objectActions.selectObject(window.__arch.uuid, true));
	await h.eventually(
		() => A.page.evaluate(() => !!document.querySelector('#physics-collider')),
		(v) => v,
		'the Inspector opens on the Arch',
		15000
	);
	/** @param {any} page */
	const colliderOptions = (page) =>
		page.evaluate(async () => {
			const sel = document.querySelector('#physics-collider');
			if (!sel) return null;
			const label = sel.textContent.trim();
			sel.click();
			await new Promise((r) => setTimeout(r, 250));
			const opts = [...document.querySelectorAll('.ts-list .ts-opt')].map((o) => o.textContent.trim());
			sel.click();
			return { label, opts };
		});
	const staticOpts = await colliderOptions(A.page);
	h.check(!!staticOpts, 'the collider select renders');
	h.check(staticOpts.opts.includes('Exact mesh (static)'), `static body offers Exact mesh (${JSON.stringify(staticOpts.opts)})`);
	h.check(/Exact mesh/.test(staticOpts.label), `a static Arch shows the inferred Exact mesh (${staticOpts.label})`);
	await A.page.evaluate(() => {
		window.__stores.physics.setPhysicsFor(window.__arch.uuid, { mode: 'dynamic', mass: 1 });
		window.__stores.selectedObject.update((v) => v);
	});
	await A.page.waitForTimeout(400);
	const dynOpts = await colliderOptions(A.page);
	h.check(!dynOpts.opts.includes('Exact mesh (static)'), `a dynamic body is not offered Exact mesh (${JSON.stringify(dynOpts.opts)})`);
	await A.page.evaluate(() => {
		window.__stores.physics.setPhysicsFor(window.__arch.uuid, { mode: 'static', mass: undefined });
		window.__stores.objectActions.deselectObject();
	});

	// --- sim helpers
	const start = async () => {
		await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
		await h.eventually(
			() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
			(v) => v === true,
			'simulation started'
		);
	};
	const stop = async () => {
		await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
		await A.page.waitForTimeout(400);
		await A.page.evaluate(() => window.__park());
	};
	// push the ball at the opening, then wait until it is THROUGH (z > 2) or has
	// STOPPED — a fixed wait lies on a loaded box, where the sim steps slowly
	const roll = () =>
		A.page.evaluate(async () => {
			const p = window.__stores.physics;
			await new Promise((r) => setTimeout(r, 300)); // let it settle on the ground
			p.setBodyVelocity(window.__ball.uuid, [0, 0, 4], [0, 0, 0]);
			const t0 = Date.now();
			let still = 0;
			while (Date.now() - t0 < 20000) {
				await new Promise((r) => setTimeout(r, 200));
				const z = window.__ball.position.z;
				if (z > 2) return { z, rest: false };
				const v = p.physicsDebug().find((b) => b.uuid === window.__ball.uuid)?.linvel;
				const speed = v ? Math.hypot(v.x, v.y, v.z) : 0;
				still = Date.now() - t0 > 800 && speed < 0.05 ? still + 1 : 0;
				if (still >= 3) return { z, rest: true };
			}
			return { z: window.__ball.position.z, rest: false };
		});
	const archShapes = () =>
		A.page.evaluate(() => {
			const fixed = window.__stores.physics.physicsWorldDebug().fixed.find((f) => f.name === 'Arch');
			const body = window.__stores.physics.physicsDebug().find((b) => b.name === 'Arch');
			return fixed?.shapes ?? body?.shapes ?? null;
		});

	// --- 2) static Arch: the exact mesh, and the ball rolls THROUGH the opening
	await start();
	const shapes2 = await archShapes();
	h.check(JSON.stringify(shapes2) === '["TriMesh"]', `a static Arch is ONE rapier TriMesh (${JSON.stringify(shapes2)})`);
	const through = await roll();
	h.check(through.z > 2, `the ball rolls through the arch opening (z ${through.z.toFixed(2)})`);
	await stop();

	// --- 3) counterfactual: the hull seals the opening
	await A.page.evaluate(() => window.__stores.physics.setPhysicsFor(window.__arch.uuid, { collider: 'hull' }));
	await start();
	const shapes3 = await archShapes();
	h.check(JSON.stringify(shapes3) === '["ConvexPolyhedron"]', `the hull pick is a convex polyhedron (${JSON.stringify(shapes3)})`);
	const blocked = await roll();
	// at REST against the hull's face (z = -0.25 - r 0.2), not merely slow
	h.check(
		blocked.rest && blocked.z < -0.3 && blocked.z > -0.8,
		`COUNTERFACTUAL: the hull stops the ball at the sealed opening (${JSON.stringify(blocked)})`
	);

	// --- 4) live rebuild: switch to the exact mesh MID-SIM, no restart
	await A.page.evaluate(() => window.__stores.physics.setPhysicsFor(window.__arch.uuid, { collider: 'trimesh' }));
	await A.page.waitForTimeout(200);
	const shapes4 = await archShapes();
	h.check(JSON.stringify(shapes4) === '["TriMesh"]', `mid-sim switch rebuilds the arch as a TriMesh (${JSON.stringify(shapes4)})`);
	const sim4 = await A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)()));
	h.check(sim4 === true, 'the simulation kept running through the rebuild');
	const after = await roll();
	h.check(after.z > 2, `after the live switch the ball passes (z ${after.z.toFixed(2)})`);
	await stop();

	// --- 5) a dynamic body with an exact pick gets its hull, and says so
	await A.page.evaluate(() => {
		window.__stores.toastStore.set([]);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.commandsHandler.sceneCommand('/create Corner');
		window.__corner = g.children[g.children.length - 1];
		window.__corner.position.set(6, 3, 6);
		window.__corner.updateMatrixWorld(true);
		window.__stores.physics.setPhysicsFor(window.__corner.uuid, { mode: 'dynamic', mass: 1, collider: 'trimesh' });
	});
	await start();
	const dyn = await A.page.evaluate(() => {
		const body = window.__stores.physics.physicsDebug().find((b) => b.uuid === window.__corner.uuid);
		let toasts;
		window.__stores.toastStore.subscribe((v) => (toasts = v))();
		return {
			shapes: body?.shapes ?? null,
			mode: body?.mode ?? null,
			toast: toasts.map((t) => (typeof t === 'string' ? t : t.text)).find((t) => /Exact mesh/.test(t)) ?? null
		};
	});
	h.check(dyn.mode === 'dynamic' && JSON.stringify(dyn.shapes) === '["ConvexPolyhedron"]', `a dynamic exact pick falls back to its hull (${JSON.stringify(dyn)})`);
	h.check(/static bodies/.test(dyn.toast ?? ''), `the fallback says why (${dyn.toast})`);
	await stop();
	await A.page.evaluate(() => {
		window.__stores.objectActions.selectObject(window.__corner.uuid, true);
		window.__stores.objectActions.deleteSelection();
	});

	// --- 6) the viz draws the exact mesh (and a dynamic body's hull)
	await A.page.evaluate(() => window.__stores.colliderHelpers.showColliders.set(true));
	await h.eventually(
		() =>
			A.page.evaluate(() =>
				window.__stores.colliderHelpers.colliderHelpersDebug().find((e) => e.uuid === window.__arch.uuid) ?? null
			),
		(e) => !!e && e.key.startsWith('trimesh'),
		'the collider viz builds the exact mesh'
	);
	const viz = await A.page.evaluate(() =>
		window.__stores.colliderHelpers.colliderHelpersDebug().find((e) => e.uuid === window.__arch.uuid) ?? null
	);
	h.check(!!viz && viz.key.startsWith('trimesh') && viz.pieces === 1, `viz entry is the trimesh (${viz?.key?.slice(0, 20)})`);
	fs.mkdirSync(EVIDENCE, { recursive: true });
	// evidence frames: the arch MESH hidden locally so the green collider proxy
	// is what the picture shows (exact = the arch with its opening, hull = a slab)
	await A.page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.closeSelectionInspector?.();
		window.__ball.visible = false;
		window.__arch.visible = false;
		window.__stores.objectActions.flyTo([1.6, 1.6, -4.2], [0, 0.9, 0], 0);
	});
	await A.page.waitForTimeout(1000);
	await A.page.screenshot({ path: path.join(EVIDENCE, '01-trimesh-arch-viz-dark.png') });
	await A.page.evaluate(() => window.__stores.themes.theme.set('light'));
	await A.page.waitForTimeout(500);
	await A.page.screenshot({ path: path.join(EVIDENCE, '02-trimesh-arch-viz-light.png') });
	await A.page.evaluate(() => {
		window.__stores.physics.setPhysicsFor(window.__arch.uuid, { collider: 'hull' });
	});
	await A.page.waitForTimeout(600);
	await A.page.screenshot({ path: path.join(EVIDENCE, '03-hull-arch-viz-before.png') });
	await A.page.evaluate(() => {
		window.__stores.themes.theme.set('dark');
		window.__arch.visible = true;
		window.__ball.visible = true;
		window.__stores.physics.setPhysicsFor(window.__arch.uuid, { collider: 'trimesh' });
	});

	// --- 7) two peers: the pick replicates and B builds the same exact mesh
	const archUuid = await A.page.evaluate(() => window.__arch.uuid);
	const aTris = await A.page.evaluate(
		() => window.__stores.colliderSpec.colliderSpecOf(window.__arch).pieces[0].indices.length
	);
	await A.page.evaluate(() => window.__stores.physics.setPhysicsFor(window.__arch.uuid, { collider: 'trimesh', friction: 0.4 }));
	/** @param {string} uuid */
	const bRead = (uuid) =>
			B.page.evaluate((uuid) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const arch = g?.getObjectByProperty('uuid', uuid);
				if (!arch) return null;
				const spec = window.__stores.colliderSpec.colliderSpecOf(arch, arch.userData.physics?.collider);
				return {
					collider: arch.userData.physics?.collider ?? null,
					friction: arch.userData.physics?.friction ?? null,
					kind: spec?.kind,
					tris: spec?.pieces?.[0]?.indices?.length ?? 0
				};
			}, uuid);
	await h.eventually(
		() => bRead(archUuid),
		(v) => !!v && v.collider === 'trimesh' && v.friction === 0.4,
		'B receives the exact-mesh pick',
		20000
	);
	const bView = await bRead(archUuid);
	h.check(bView?.kind === 'trimesh' && bView.tris === aTris, `B builds the same trimesh (${bView?.tris} vs ${aTris} indices)`);

	await h.finish(browser);
});
