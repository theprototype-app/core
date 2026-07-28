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

	// 3) + Box piece = a second shell
	const shells = await A.page.evaluate(() => {
		window.__stores.colliderEdit.addColliderPiece('box');
		return window.__stores.colliderEdit.colliderShellCount();
	});
	h.check(shells === 2, `+ Box piece adds a shell (${shells})`);

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

	await h.finish(browser);
});
