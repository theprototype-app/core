// CL-A A8: custom COMPOUND collider edit session — scene-root proxy, + Box
// piece adds a shell, Done writes userData.physics (replicated + undoable),
// the spec reads the pieces back.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// target object
	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__target = box;
		return box.uuid;
	});

	// 1) enter the session: proxy at the scene root + face edit runs ON it
	const session = await A.page.evaluate((uuid) => {
		const ok = window.__stores.colliderEdit.enterColliderEdit(uuid);
		let scene, faceUuid;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		window.__stores.faceEdit.faceEditObject.subscribe((v) => (faceUuid = v))();
		const proxy = scene.children.find((c) => c.name === 'collider-edit-proxy');
		let inGroup;
		window.__stores.objectsGroup.subscribe((v) => (inGroup = v))();
		return {
			ok,
			proxyExists: !!proxy,
			proxyInObjectsGroup: proxy ? inGroup.children.includes(proxy) : null,
			faceEditOnProxy: !!proxy && faceUuid === proxy.uuid,
			shells: window.__stores.colliderEdit.colliderShellCount()
		};
	}, uuid);
	h.check(session.ok && session.proxyExists, 'session builds a proxy at the scene root');
	h.check(session.proxyInObjectsGroup === false, 'proxy never enters objectsGroup (no GLTF/peer sync)');
	h.check(session.faceEditOnProxy, 'the regular face-edit tool runs on the proxy');
	h.check(session.shells === 1, `box seed is one shell (${session.shells})`);

	// 2) toolbar shows the collider banner state
	await A.page.waitForTimeout(400);
	const banner = await A.page.evaluate(() => ({
		done: !!document.querySelector('#collider-edit-done'),
		cancel: !!document.querySelector('#collider-edit-cancel'),
		addBox: !!document.querySelector('#collider-add-box'),
		normalDone: !!document.querySelector('#mesh-edit-done')
	}));
	h.check(
		banner.done && banner.cancel && banner.addBox && !banner.normalDone,
		`collider banner replaces the normal Done (${JSON.stringify(banner)})`
	);

	// 3) + Box piece = a second shell, seated OUTSIDE the seed (15-A2: it used
	// to spawn buried inside the seed — invisible through the 0.35 material)
	const shells = await A.page.evaluate(() => {
		window.__stores.colliderEdit.addColliderPiece('box');
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const proxy = scene.children.find((c) => c.name === 'collider-edit-proxy');
		const pos = proxy.geometry.attributes.position;
		// merged order: seed soup first (box = 36 verts), the new piece after
		let seedMaxX = -Infinity;
		let pieceMinX = Infinity;
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i);
			if (i < 36) seedMaxX = Math.max(seedMaxX, x);
			else pieceMinX = Math.min(pieceMinX, x);
		}
		return { count: window.__stores.colliderEdit.colliderShellCount(), separated: pieceMinX > seedMaxX };
	});
	h.check(shells.count === 2, `+ Box piece adds a shell (${shells.count})`);
	h.check(shells.separated, 'new piece seats outside the seed shell (visible)');
	await A.page.waitForTimeout(300);
	const chip = await A.page.evaluate(
		() => document.querySelector('#collider-shell-count')?.textContent ?? ''
	);
	h.check(chip.includes('2'), `shell chip shows the live count ("${chip.trim()}")`);

	// 4) Done writes the compound custom collider + replicates + records undo
	const done = await A.page.evaluate((uuid) => {
		window.__sent = [];
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		const original = peer.send;
		peer.send = (m) => window.__sent.push({ type: m.type, parameter: m.parameter });
		const ok = window.__stores.colliderEdit.commitColliderEdit();
		peer.send = original;
		const p = window.__target.userData.physics;
		const spec = window.__stores.colliderSpec.colliderSpecOf(window.__target);
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		return {
			ok,
			collider: p?.collider,
			verts: p?.colliderVerts?.length ?? 0,
			pieces: p?.colliderPieces?.length ?? 0,
			specKind: spec.kind,
			specPieces: spec.pieces?.length ?? 0,
			sent: window.__sent,
			proxyGone: !scene.children.find((c) => c.name === 'collider-edit-proxy')
		};
	}, uuid);
	h.check(done.ok && done.collider === 'custom', 'Done sets collider=custom');
	h.check(done.pieces === 2 && done.verts > 0 && done.verts % 3 === 0, `stored 2 pieces (${done.verts} floats)`);
	h.check(done.specKind === 'custom' && done.specPieces === 2, 'spec reads the compound back');
	h.check(
		done.sent.some((m) => m.type === 'objectParameters' && m.parameter === 'physics'),
		`Done replicates via objectParameters (${JSON.stringify(done.sent)})`
	);
	h.check(done.proxyGone, 'proxy disposed on Done');

	// 5) undo restores the previous collider config
	const undone = await A.page.evaluate(() => {
		window.__stores.history.undo();
		const p = window.__target.userData.physics;
		return { collider: p?.collider ?? null, verts: p?.colliderVerts ?? null };
	});
	h.check(undone.collider !== 'custom' || undone.verts === null, `undo restores the pre-custom collider (${JSON.stringify(undone.collider)})`);

	// 6) cancel path: enter again, cancel — nothing written, proxy gone
	const cancelled = await A.page.evaluate((uuid) => {
		window.__stores.colliderEdit.enterColliderEdit(uuid);
		window.__stores.colliderEdit.exitColliderEdit();
		let scene, faceUuid;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		window.__stores.faceEdit.faceEditObject.subscribe((v) => (faceUuid = v))();
		return {
			proxyGone: !scene.children.find((c) => c.name === 'collider-edit-proxy'),
			faceEditClosed: faceUuid === null,
			collider: window.__target.userData.physics?.collider ?? null
		};
	}, uuid);
	h.check(
		cancelled.proxyGone && cancelled.faceEditClosed && cancelled.collider !== 'custom',
		`cancel leaves no trace (${JSON.stringify(cancelled)})`
	);

	// 7) 15-A1: a count-PRESERVING collider change refreshes the viz wireframe.
	// keyOf used to hash only vert COUNTS, so a vertex move (the common edit)
	// left the green proxy stale until Show collider was toggled off/on.
	const vizRefresh = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.colliderEdit.enterColliderEdit(uuid);
		w.colliderEdit.commitColliderEdit(); // seed verts stored as custom
		w.colliderHelpers.setColliderViz(uuid, true);
		await new Promise((r) => setTimeout(r, 300)); // debounced sync
		const checksum = () => {
			let scene;
			w.globalScene.subscribe((v) => (scene = v))();
			const root = scene.children.find((c) => c.name === 'collider-proxies');
			let sum = 0;
			root?.children.forEach((g) =>
				g.children.forEach((l) => {
					const a = l.geometry.attributes.position.array;
					for (let i = 0; i < a.length; i++) sum += a[i];
				})
			);
			return sum;
		};
		const before = checksum();
		// count-preserving content change — exactly what a vertex move + Done writes
		const p = window.__target.userData.physics;
		p.colliderVerts = p.colliderVerts.map((v, i) => (i % 3 === 0 ? v + 0.5 : v));
		w.objectsGroup.update((v) => v);
		await new Promise((r) => setTimeout(r, 300));
		const after = checksum();
		return { before, after, changed: Math.abs(after - before) > 0.01 };
	}, uuid);
	h.check(
		vizRefresh.changed,
		`count-preserving collider edit refreshes the viz (${vizRefresh.before.toFixed(1)} -> ${vizRefresh.after.toFixed(1)})`
	);

	await h.finish(browser);
});
