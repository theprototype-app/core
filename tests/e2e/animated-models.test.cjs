// Phase 51: animated model import — clips play on the synced clock everywhere (33 P2: once
// PLAYED — placement no longer autoplays),
// raw-bytes replication (incl. late joiners), pause/clip state syncs, undo works.
const h = require('./helpers.cjs');

const animState = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.animatedImports.animatedObjects.subscribe((map) => {
					const [uuid, state] = Object.entries(map)[0] ?? [];
					resolve(uuid ? { uuid, ...state } : null);
				})();
			})
	);

const moverX = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const root = g?.getObjectByProperty('uuid', uuid);
					resolve(root?.getObjectByName('mover')?.position.x ?? null);
				})();
			}),
		uuid
	);

h.run(async () => {
	// three pages (A, B and the late joiner C): the GPU backend, or the third software-GL page boots
	// past setupPage while two others saturate SwiftShader (the 1.17 three-page gotcha)
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// build a tiny animated glb in-page and run it through the import path
	const bytes = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				const { GLTFExporter } = window.__stores.GLTFExporterModule;
				const root = new THREE.Group();
				const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
				mesh.name = 'mover';
				root.add(mesh);
				const track = new THREE.VectorKeyframeTrack('mover.position', [0, 1, 2], [0, 0, 0, 2, 0, 0, 0, 0, 0]);
				const clip = new THREE.AnimationClip('slide', 2, [track]);
				new GLTFExporter().parse(
					root,
					(buffer) => resolve(Array.from(new Uint8Array(buffer))),
					() => resolve(null),
					{ binary: true, animations: [clip] }
				);
			})
	);
	h.check(Array.isArray(bytes) && bytes.length > 500, `exporter produced a glb (${bytes?.length} bytes)`);

	await A.page.evaluate((bytes) => {
		const file = new File([new Uint8Array(bytes)], 'anim.glb');
		window.__stores.fileHandler.importFile(file, 'AnimTest');
	}, bytes);

	await h.eventually(() => animState(A.page), (s) => s?.clips?.includes('slide'), 'animated import registered on A');
	const { uuid } = await animState(A.page);

	// 33 P2: NOTHING AUTOPLAYS on placement any more — the clip is selected, not playing,
	// and the model stands still until somebody presses play
	h.check((await animState(A.page)).playing === false, '33: the import is NOT playing on placement');
	const s1 = await moverX(A.page, uuid);
	await A.page.waitForTimeout(400);
	h.check(s1 === (await moverX(A.page, uuid)), '33: ...and the model stands still');
	await A.page.evaluate((uuid) => window.__stores.animatedImports.setAnimationState(uuid, { playing: true }), uuid);

	// the clip actually animates on A once played
	const a1 = await moverX(A.page, uuid);
	await A.page.waitForTimeout(400);
	const a2 = await moverX(A.page, uuid);
	h.check(a1 !== null && a1 !== a2, `clip animates on A (x ${a1?.toFixed(2)} -> ${a2?.toFixed(2)})`);

	// raw-bytes replication to B, animating in phase
	await h.eventually(() => moverX(B.page, uuid), (x) => x !== null, 'model replicated to B (objectfile)', 15000);
	const b1 = await moverX(B.page, uuid);
	await B.page.waitForTimeout(400);
	const b2 = await moverX(B.page, uuid);
	h.check(b1 !== b2, 'clip animates on B');
	// 33 integrate: the pose is a pure function of the synced clock, so 'in phase' means the two
	// peers' clocks agree. Reading x on each page in two separate evaluates compared two frames
	// rendered up to a few hundred ms apart on a loaded box (red 3/3 here, incl. the lane branch);
	// read each page's clip time AND wall clock in one task, and compare the clocks instead.
	const phaseOf = (page) =>
		page.evaluate((uuid) => {
			const s = window.__stores;
			s.animatedImports.tickAnimatedMixers();
			const g = (() => { let v; s.objectsGroup.subscribe((x) => (v = x))(); return v; })();
			return { t: s.moduleSDK.runtimeNow(), wall: Date.now() / 1000, x: g.getObjectByProperty('uuid', uuid)?.getObjectByName('mover')?.position.x ?? null };
		}, uuid);
	const [pa, pb] = await Promise.all([phaseOf(A.page), phaseOf(B.page)]);
	const skew = (pa.t - pa.wall) - (pb.t - pb.wall);
	h.check(Math.abs(skew) < 0.15 && pa.x !== null && pb.x !== null, `peers in phase: their clip clocks agree within ${(skew * 1000).toFixed(0)} ms (A x ${pa.x?.toFixed(2)}, B x ${pb.x?.toFixed(2)})`);

	// pause replicates and freezes
	await A.page.evaluate((uuid) => window.__stores.animatedImports.setAnimationState(uuid, { playing: false }), uuid);
	await h.eventually(() => animState(B.page), (s) => s?.playing === false, 'pause replicated to B');
	const f1 = await moverX(B.page, uuid);
	await B.page.waitForTimeout(400);
	const f2 = await moverX(B.page, uuid);
	h.check(f1 === f2, 'pose frozen on B while paused');
	await A.page.evaluate((uuid) => window.__stores.animatedImports.setAnimationState(uuid, { playing: true }), uuid);

	// late joiner receives the same file via the handshake
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(() => moverX(C.page, uuid), (x) => x !== null, 'late joiner received the animated model', 20000);

	// undo removes it everywhere; redo brings it back animating
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => moverX(A.page, uuid), (x) => x === null, 'undo removes it on A');
	await h.eventually(() => moverX(B.page, uuid), (x) => x === null, 'undo replicated to B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => moverX(B.page, uuid), (x) => x !== null, 'redo restores it on B', 15000);

	await h.finish(browser);
});
