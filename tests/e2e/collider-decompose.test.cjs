// 36 X3: Decompose in the real app — Inspector ▸ Physics ▸ Decompose runs V-HACD in a
// WORKER on a dynamic Arch, writes a custom compound collider (several convex pieces,
// under the replicated cap) that a peer receives, one Ctrl+Z puts the old collider
// back, and in a running sim a ball rolls THROUGH the decomposed dynamic arch while its
// hull (the counterfactual) stops it — the dynamic half of the A6 backlog row.
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
	await h.connect(B, A);

	await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Arch');
		cmd('/create Sphere 0.15');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__arch = g.children.find((c) => c.name === 'Arch');
		window.__ball = g.children.find((c) => c.name === 'Sphere');
		window.__park = () => {
			window.__ball.position.set(0, 0.2, -3);
			window.__ball.quaternion.set(0, 0, 0, 1);
			window.__ball.updateMatrixWorld(true);
			window.__arch.position.set(0, 0, 0);
			window.__arch.quaternion.set(0, 0, 0, 1);
			window.__arch.updateMatrixWorld(true);
		};
		window.__park();
		// a heavy DYNAMIC arch: X2's exact mesh is static-only, so its default is the hull
		window.__stores.physics.setPhysicsFor(window.__arch.uuid, { mode: 'dynamic', mass: 500 });
		window.__stores.physics.setPhysicsFor(window.__ball.uuid, { mode: 'dynamic', mass: 0.2, collider: 'sphere' });
	});

	// --- 1) the Inspector button runs it (in a worker) and writes a custom collider
	await A.page.evaluate(() => window.__stores.objectActions.selectObject(window.__arch.uuid, true));
	await h.eventually(
		() => A.page.evaluate(() => !!document.querySelector('#physics-decompose')),
		(v) => v,
		'the Decompose row renders in Inspector > Physics',
		15000
	);
	const before = await A.page.evaluate(() => window.__arch.userData.physics.collider ?? null);
	await A.page.locator('#physics-decompose').click();
	await h.eventually(
		() => A.page.evaluate(() => window.__arch.userData.physics?.collider ?? null),
		(c) => c === 'custom',
		'clicking Run writes a custom collider',
		60000
	);
	const result = await A.page.evaluate(() => {
		const p = window.__arch.userData.physics;
		let toasts;
		window.__stores.toastStore.subscribe((v) => (toasts = v))();
		return {
			pieces: p.colliderPieces.length,
			floats: p.colliderVerts.length,
			toast: toasts.map((t) => (typeof t === 'string' ? t : t.text)).find((t) => /decomposed/.test(t)) ?? null
		};
	});
	h.check(result.pieces >= 3 && result.floats <= 1200, `the arch became ${result.pieces} convex pieces in ${result.floats} floats (<= 1200)`);
	h.check(/convex piece/.test(result.toast ?? ''), `a toast says so (${result.toast})`);
	const direct = await A.page.evaluate(() => window.__stores.colliderDecompose.decomposeCollider(window.__arch.uuid, 6));
	h.check(direct?.where === 'worker', `the decomposition ran in a Worker (${JSON.stringify(direct)})`);

	// --- 2) a peer receives the result (it never runs V-HACD itself)
	const uuid = await A.page.evaluate(() => window.__arch.uuid);
	const aPieces = await A.page.evaluate(() => window.__arch.userData.physics.colliderPieces.length);
	await h.eventually(
		() =>
			B.page.evaluate((u) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const p = g?.getObjectByProperty('uuid', u)?.userData.physics;
				return p ? { c: p.collider, n: p.colliderPieces?.length ?? 0 } : null;
			}, uuid),
		(v) => !!v && v.c === 'custom' && v.n === aPieces,
		'the peer receives the same custom pieces'
	);

	// --- 3) one undo puts the previous collider back (props history)
	await A.page.evaluate(() => {
		window.__stores.history.undo(); // the direct 6-piece run
		window.__stores.history.undo(); // the button's run
	});
	const undone = await A.page.evaluate(() => window.__arch.userData.physics.collider ?? null);
	h.check(undone === before, `undo restores the collider it had (${undone} vs ${before})`);
	await A.page.evaluate(() => {
		window.__stores.history.redo();
		window.__stores.objectActions.deselectObject();
		window.__stores.closeSelectionInspector?.();
	});

	// --- 4) physics: the decomposed DYNAMIC arch keeps its opening; the hull seals it
	const roll = () =>
		A.page.evaluate(async () => {
			const p = window.__stores.physics;
			p.toggleSimulation();
			// the start is async (rapier warm-up + body build): push only once it runs
			const t00 = Date.now();
			while (!(await new Promise((r) => p.simulating.subscribe(r)())) && Date.now() - t00 < 10000)
				await new Promise((r) => setTimeout(r, 100));
			await new Promise((r) => setTimeout(r, 400));
			p.setBodyVelocity(window.__ball.uuid, [0, 0, 4], [0, 0, 0]);
			const t0 = Date.now();
			let still = 0;
			let out = null;
			while (Date.now() - t0 < 20000) {
				await new Promise((r) => setTimeout(r, 200));
				const z = window.__ball.position.z;
				if (z > 2) {
					out = { z, rest: false };
					break;
				}
				const v = p.physicsDebug().find((b) => b.uuid === window.__ball.uuid)?.linvel;
				const speed = v ? Math.hypot(v.x, v.y, v.z) : 0;
				still = Date.now() - t0 > 800 && speed < 0.05 ? still + 1 : 0;
				if (still >= 3) {
					out = { z, rest: true };
					break;
				}
			}
			const arch = p.physicsDebug().find((b) => b.uuid === window.__arch.uuid);
			out = { ...(out ?? { z: window.__ball.position.z, rest: false }), shapes: arch?.shapes ?? null };
			p.toggleSimulation();
			await new Promise((r) => setTimeout(r, 400));
			window.__park();
			return out;
		});
	const through = await roll();
	h.check(
		(through.shapes?.length ?? 0) >= 3 && through.shapes.every((s) => s === 'ConvexPolyhedron'),
		`the dynamic arch is a compound of convex pieces in rapier (${JSON.stringify(through.shapes)})`
	);
	h.check(through.z > 2, `the ball rolls through the decomposed DYNAMIC arch (z ${through.z.toFixed(2)})`);
	await A.page.evaluate(() => window.__stores.physics.setPhysicsFor(window.__arch.uuid, { collider: 'hull' }));
	const sealed = await roll();
	h.check(sealed.rest && sealed.z < 0, `COUNTERFACTUAL: the hull stops the ball (${JSON.stringify({ z: sealed.z, rest: sealed.rest })})`);

	// --- evidence: the decomposed pieces as the collider viz draws them
	try {
		fs.mkdirSync(EVIDENCE, { recursive: true });
		// re-decompose (an undo here would undo the run's layout entry, not the collider)
		await A.page.evaluate(() => window.__stores.colliderDecompose.decomposeCollider(window.__arch.uuid, 8));
		await A.page.evaluate(() => {
			window.__stores.toastStore.set([]);
			window.__stores.colliderHelpers.showColliders.set(true);
			window.__arch.visible = false;
			window.__ball.visible = false;
			window.__stores.objectActions.flyTo([1.6, 1.6, -4.2], [0, 0.9, 0], 0);
		});
		await A.page.waitForTimeout(1200);
		await A.page.screenshot({ path: path.join(EVIDENCE, '05-decomposed-arch-viz.png') });
	} catch (e) {
		console.log('screenshot skipped: ' + e.message);
	}

	await h.finish(browser);
});
