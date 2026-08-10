// Roadmap #17 batch D follow-up — "save then load kills object animations".
//
// Two separate systems were both lost by a save:
//  * IMPORTED clips (animatedImports): a session serialized the object with
//    toJSON and the autosave with the GLTF exporter. Neither can carry an
//    AnimationClip — clips live beside the scene, not on the object — so the
//    model came back as a static, dead mesh. Saves now carry the ORIGINAL file
//    bytes, exactly like the `objectfile` wire message.
//  * AUTHORED tracks (animationPreview, the Animation window): never persisted
//    at all, so every movement built there vanished on load.
//
// This suite saves a scene holding an animated import plus an authored track,
// wipes the scene, loads the save back, and demands both survive.
const h = require('./helpers.cjs');

/** build a tiny animated glb in-page (a box sliding on x, clip "slide") */
const buildGlb = (page) =>
	page.evaluate(
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

/** what the scene currently knows about animations */
const animState = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		const imported = await new Promise((r) => w.animatedImports.animatedObjects.subscribe(r)());
		const authored = await new Promise((r) => w.animationPreview.animations.subscribe(r)());
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const entries = Object.entries(imported);
		return {
			importedCount: entries.length,
			clips: entries[0]?.[1]?.clips ?? [],
			clip: entries[0]?.[1]?.clip ?? null,
			uuid: entries[0]?.[0] ?? null,
			// the live mixer is what actually poses the model
			mover: entries[0]
				? (group.getObjectByProperty('uuid', entries[0][0])?.getObjectByName('mover')?.position.x ?? null)
				: null,
			authoredUuids: Object.keys(authored),
			authoredTracks: Object.values(authored)[0]?.tracks?.length ?? 0,
			children: group.children.length
		};
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.animationPreview, { timeout: 20000 });

	const glb = await buildGlb(A.page);
	h.check(Array.isArray(glb) && glb.length > 500, `built an animated glb (${glb?.length} bytes)`);

	// import it, and author a movement track on a second object
	await A.page.evaluate(async (bytes) => {
		const w = window.__stores;
		await w.fileHandler.importFile(new File([new Uint8Array(bytes)], 'rig.glb'), 'Rig');
		await new Promise((r) => setTimeout(r, 600));
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 300));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = group.children.find((c) => c.name !== 'Rig' && c.type === 'Mesh');
		window.__ap = { box: box.uuid };
		w.animationPreview.addTrack(box.uuid, 'pos.y');
		w.animationPreview.updateAnim(box.uuid, { duration: 3, loop: 'pingpong' });
	}, glb);
	await A.page.waitForTimeout(700);

	const before = await animState(A.page);
	h.check(before.importedCount === 1, `the rig registered its clips (${before.importedCount})`);
	h.check(before.clips.includes('slide'), `clip list has "slide" (${before.clips.join(', ')})`);
	h.check(before.authoredTracks === 1, `an authored track exists (${before.authoredTracks})`);

	// the mixer really poses the model (so "dead after load" is measurable)
	const m1 = before.mover;
	await A.page.waitForTimeout(400);
	const m2 = (await animState(A.page)).mover;
	h.check(m1 !== null && m1 !== m2, `the clip animates before saving (${m1?.toFixed(2)} -> ${m2?.toFixed(2)})`);

	// ---------- save, wipe, load ----------
	const saved = await A.page.evaluate(async () => {
		const w = window.__stores;
		const payload = await w.sessions.saveSession('anim-roundtrip');
		return {
			id: payload?.id ?? null,
			animated: payload?.animated?.length ?? 0,
			bytes: payload?.animated?.[0]?.bytes?.length ?? 0,
			kind: payload?.animated?.[0]?.kind ?? null,
			authored: Object.keys(payload?.animations ?? {}).length,
			// the rig must NOT also be serialized the lossy way
			objects: payload?.objects?.length ?? 0
		};
	});
	h.check(saved.animated === 1, `the save carries the rig's own bytes (${saved.animated} entr(y/ies))`);
	h.check(saved.bytes > 500, `and they are real (${saved.bytes} base64 chars)`);
	h.check(saved.kind === 'gltf', `tagged with its parser (${saved.kind})`);
	h.check(saved.authored === 1, `the save carries the authored track (${saved.authored})`);
	h.check(saved.objects === 1, `the rig is not ALSO saved as a static twin (objects: ${saved.objects})`);

	// wipe: nothing animated must be left, so a stale mixer cannot fake a pass
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(600);
	const wiped = await animState(A.page);
	h.check(wiped.children === 0, `the scene is empty before loading (${wiped.children} children)`);
	h.check(wiped.importedCount === 0, 'and no imported clips linger');

	await A.page.evaluate(async (id) => {
		const w = window.__stores;
		const payload = await w.sessions.getSession(id);
		await w.sessions.applySession(payload);
	}, saved.id);
	await A.page.waitForTimeout(1500);

	const after = await animState(A.page);
	h.check(after.children === 2, `both objects came back (${after.children})`);
	h.check(after.importedCount === 1, `the rig's clips are registered again (${after.importedCount})`);
	h.check(after.clips.includes('slide'), `the clip list survived (${after.clips.join(', ')})`);
	h.check(after.authoredTracks === 1, `the authored track survived (${after.authoredTracks})`);

	// the real test: it MOVES again. A static twin would sit still forever.
	const p1 = after.mover;
	await A.page.waitForTimeout(400);
	const p2 = (await animState(A.page)).mover;
	h.check(
		p1 !== null && p2 !== null && p1 !== p2,
		`the clip animates AFTER the round trip (${p1?.toFixed(2)} -> ${p2?.toFixed(2)})`
	);

	// ---------- the Animation window lists those clips ----------
	// it read only the authored-track store before, so a rigged model showed
	// "no movements yet" and its real clips were reachable only in the Inspector
	await A.page.evaluate(async () => {
		const w = window.__stores;
		const imported = await new Promise((r) => w.animatedImports.animatedObjects.subscribe(r)());
		w.objectActions.selectObject(Object.keys(imported)[0], false);
		w.animationClose.set(false);
		w.bottomDock.activateDock('animation');
	});
	await A.page.waitForTimeout(900);
	const listed = await A.page.evaluate(() => {
		const panel = document.querySelector('#animation-clips');
		return {
			present: !!panel,
			rows: [...(panel?.querySelectorAll('button') ?? [])]
				.map((b) => b.textContent?.replace(/\s+/g, ' ').trim() ?? '')
				.filter((t) => /slide/.test(t)),
			hasTransport: !!document.querySelector('#clip-play')
		};
	});
	h.check(listed.present, 'the Animation window shows a clip list for an imported model');
	h.check(listed.rows.length === 1, `it lists the clip with its length (${listed.rows.join(' | ')})`);
	h.check(listed.hasTransport, 'and offers play/pause + speed for it');

	// clicking a clip row drives the REAL replicated state, not local UI
	const picked = await A.page.evaluate(async () => {
		const w = window.__stores;
		const peer = await new Promise((r) => w.peers.subscribe(r)());
		window.__sent = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			if (m?.parameter === 'animation') window.__sent.push(m.playing);
			return orig(m);
		};
		document.querySelector('#clip-play')?.click();
		await new Promise((r) => setTimeout(r, 400));
		const imported = await new Promise((r) => w.animatedImports.animatedObjects.subscribe(r)());
		return { sent: window.__sent.slice(), playing: Object.values(imported)[0]?.playing };
	});
	h.check(picked.sent.length >= 1, `the clip transport replicates (${picked.sent.length} message(s))`);
	h.check(picked.playing === false, `and pausing actually paused it (playing ${picked.playing})`);

	await h.finish(browser);
});
