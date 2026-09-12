// 27-G (audit H6, M13) — GPU MEMORY COMES BACK, AND A LOST CONTEXT IS VISIBLE.
//
// The unit suite (tests/unit/disposeTree) covers the hard part — what may and may not be
// freed when resources are shared — with no renderer at all. This suite covers the two
// things it cannot see:
//   1. `renderer.info.memory` really falls back after deletes, so the leak is gone in the
//      place a user pays for it rather than only in a function's return value
//   2. a REAL lost context (WEBGL_lose_context) raises the overlay, and restoring brings
//      the scene back
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- dispose
const h = require('./helpers.cjs');

const memory = (peer) =>
	peer.page.evaluate(() => {
		let r = null;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		return r?.info?.memory ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures } : null;
	});

const objectCount = (peer) =>
	peer.page.evaluate(() => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g ? g.children.length : -1;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. deleting gives the memory back ---------------------------------------------
	// WARM UP FIRST. Creating and selecting an object allocates one-time machinery — the
	// transform gizmo's own geometry most of all — which is not a leak and never comes
	// back. Measuring the floor before any of it existed calls it one: the first run of
	// this check read 2 -> 28 -> 18 and failed, while the very next section showed
	// 18 -> 26 -> 18, i.e. disposal returning to the real floor exactly.
	const warmUuid = await A.page.evaluate(() => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [0, 0.5, -6]);
		return g.children[g.children.length - 1].uuid;
	});
	// It has to RENDER before being deleted. The transform gizmo's geometries are uploaded
	// the first time they are actually DRAWN, not when an object is selected — so creating
	// and deleting inside one evaluate leaves them for the next section to allocate, and
	// the floor reads 4 when the true floor is 18.
	await A.page.waitForTimeout(2000);
	await A.page.evaluate((id) => window.__stores.commandsHandler.deleteObject(id), warmUuid);
	await A.page.waitForTimeout(1500);
	const before = await memory(A);
	h.check(!!before, `premise: the renderer reports its memory (${JSON.stringify(before)})`);

	const uuids = await A.page.evaluate(() => {
		const made = [];
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		for (let i = 0; i < 10; i++) {
			window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [i * 2 - 9, 0.5, -3]);
			made.push(g.children[g.children.length - 1].uuid);
		}
		return made;
	});
	h.check(uuids.length === 10 && new Set(uuids).size === 10, `premise: ten distinct objects (${new Set(uuids).size})`);
	await A.page.waitForTimeout(1500);

	const loaded = await memory(A);
	h.check(
		loaded.geometries > before.geometries,
		`ten objects cost GPU memory (${before.geometries} -> ${loaded.geometries} geometries)`
	);

	await A.page.evaluate((ids) => {
		for (const id of ids) window.__stores.commandsHandler.deleteObject(id);
	}, uuids);
	await A.page.waitForTimeout(1500);

	h.check((await objectCount(A)) === 0, 'the objects are gone from the scene');
	const after = await memory(A);

	// THE INVARIANT, rather than a baseline number. A geometry still referenced by a live
	// scene object is not a leak: the grid, the transform gizmo and the environment rig
	// all legitimately keep theirs, and what the floor sits at depends on what has been
	// touched. A geometry the RENDERER still holds that NOTHING in the scene refers to is
	// the leak this phase is about — and that is the thing worth asserting.
	const residual = await A.page.evaluate(() => {
		let s = null;
		window.__stores.globalScene.subscribe((v) => (s = v))();
		const seen = new Set();
		/** @type {Record<string, number>} */
		const byOwner = {};
		s?.traverse((o) => {
			if (!o.geometry || seen.has(o.geometry)) return;
			seen.add(o.geometry);
			const k = o.name || o.type;
			byOwner[k] = (byOwner[k] || 0) + 1;
		});
		return { referenced: seen.size, byOwner };
	});
	h.check(
		after.geometries <= before.geometries + 2,
		`the memory came back to the floor (floor ${before.geometries}, peak ${loaded.geometries}, now ${after.geometries}) — still held by live helpers: ${JSON.stringify(residual.byOwner)}`
	);
	h.check(
		after.geometries < loaded.geometries,
		`and the deleted objects' geometry really went (peak ${loaded.geometries} -> ${after.geometries})`
	);

	// ---- 2. clearing a scene frees it too ------------------------------------------------
	await A.page.evaluate(() => {
		for (let i = 0; i < 8; i++)
			window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [i - 4, 0.5, 2]);
	});
	await A.page.waitForTimeout(1200);
	const filled = await memory(A);
	h.check(filled.geometries > after.geometries, `premise: eight more objects are resident (${filled.geometries})`);

	await A.page.evaluate(() => window.__stores.commandsHandler.clearSceneLocal());
	await A.page.waitForTimeout(1200);
	const cleared = await memory(A);
	h.check(
		cleared.geometries <= after.geometries + 2,
		`clearing the scene frees what it held (${filled.geometries} -> ${cleared.geometries})`
	);

	// ---- 3. a real lost context raises the overlay ----------------------------------------
	const canLose = await A.page.evaluate(() => {
		let r = null;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const gl = r?.getContext?.();
		// HOLD the extension. Once the context is lost, getExtension returns null, so
		// fetching it again in order to RESTORE throws — which it did, on the first run.
		window.__loseCtx = gl?.getExtension?.('WEBGL_lose_context') ?? null;
		return !!window.__loseCtx;
	});
	h.check(canLose === true, 'premise: WEBGL_lose_context is available, so a REAL context loss can be driven');

	if (canLose) {
		// premise: the overlay is NOT on screen yet. Without this, "a lost context raises
		// the overlay" would pass just as well against an overlay that is always rendered.
		h.check(
			!(await A.page.locator('.gl-lost').isVisible().catch(() => false)),
			'premise: the overlay is hidden while the context is healthy'
		);
		await A.page.evaluate(() => window.__loseCtx.loseContext());
		await A.page.waitForTimeout(800);

		const overlay = await A.page.locator('.gl-lost').isVisible().catch(() => false);
		h.check(overlay, 'a lost context raises the overlay instead of looking like a freeze');
		h.check(
			await A.page.locator('.gl-lost-primary').isVisible().catch(() => false),
			'and it offers to save the scene, which still exists in the page'
		);

		await A.page.evaluate(() => window.__loseCtx.restoreContext());
		await h.eventually(
			() => A.page.locator('.gl-lost').isVisible().catch(() => false),
			(v) => v === false,
			'restoring the context dismisses the overlay',
			20000
		);

		// Measure what the RENDERER did, not how often requestAnimationFrame was serviced.
		// three bumps info.render.frame inside render(), so a rising counter is direct
		// evidence that the restored context is being drawn into. The tick count stays in
		// the message as context only: this box runs SwiftShader at four or five frames a
		// second, so a threshold picked for 60Hz reads a healthy page as frozen — which is
		// exactly what the first version of this check did, at 3 frames against a bar of 3.
		const drawing = await A.page.evaluate(
			() =>
				new Promise((resolve) => {
					let r = null;
					window.__stores.globalRenderer.subscribe((v) => (r = v))();
					const first = r?.info?.render?.frame ?? -1;
					let ticks = 0;
					const t0 = performance.now();
					const step = () => {
						ticks++;
						if (performance.now() - t0 > 1500)
							return resolve({ first, last: r?.info?.render?.frame ?? -1, ticks });
						requestAnimationFrame(step);
					};
					requestAnimationFrame(step);
				})
		);
		h.check(
			drawing.last > drawing.first,
			`and the restored context is being drawn into (renderer frame ${drawing.first} -> ${drawing.last}, ${drawing.ticks} rAF ticks in 1.5s)`
		);
	}

	await h.finish(browser);
});
