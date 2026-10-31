// 57 M1 — `.tpanim` clip ASSETS on a model, host + peer + late joiner, with real assets:
// the avatars' shared clips file (an animation-only GLB, KayKit rig) imports into the Explorer as one
// `.tpanim` per clip; a rig with NO clips of its own (knight.glb) places as an animated import; a
// clip assigned to it plays on every peer, bound identically; the MODEL'S BYTES NEVER CHANGE; a late
// joiner gets the model and pulls the clip once; undo/redo of the assignment replicate; the save
// entry and the scene-asset manifest carry the clip.
const h = require('./helpers.cjs');

/** read a store once */
const storeValue = (page, path) =>
	page.evaluate((path) => {
		let v;
		const store = path.split('.').reduce((o, k) => o?.[k], window.__stores);
		store.subscribe((x) => (v = x))();
		return v;
	}, path);

/** the knight's uuid (the one animated import), its clip list and its transport */
const animOf = (page) =>
	page.evaluate(() => {
		let map;
		window.__stores.animatedImports.animatedObjects.subscribe((m) => (map = m))();
		const [uuid, state] = Object.entries(map ?? {})[0] ?? [];
		if (!uuid) return null;
		return { uuid, ...state, info: window.__stores.animatedImports.clipInfo(uuid) };
	});

/** pose a bone of the model at a FIXED clip time (same time on every page) and read its world quaternion */
const poseAtFixedTime = (page, uuid, t) =>
	page.evaluate(
		({ uuid, t }) => {
			const s = window.__stores;
			const rec = s.animatedImports.animatedRecordOf(uuid);
			if (!rec) return null;
			rec.mixer.setTime(t);
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const root = g.getObjectByProperty('uuid', uuid);
			root.updateMatrixWorld(true);
			const bone = root.getObjectByName(s.THREE.PropertyBinding.sanitizeNodeName('upperarm.l'));
			if (!bone) return null;
			const q = new s.THREE.Quaternion();
			bone.matrixWorld.decompose(new s.THREE.Vector3(), q, new s.THREE.Vector3());
			return q.toArray();
		},
		{ uuid, t }
	);

const modelHash = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const bytes = window.__stores.animatedImports.animatedImportPayload(uuid);
		return bytes ? window.__stores.explorer.hashBytes(bytes) : null;
	}, uuid);

const clipItems = (page) =>
	page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((x) => (items = x))();
		return items.filter((i) => i.kind === 'anim').map((i) => ({ id: i.id, name: i.name, hash: i.hash }));
	});

const dot = (a, b) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// a rig with no clips of its own places as an ANIMATED import (57 M1: rigs ride the bytes path)
	const uuid = await A.page.evaluate(async () => {
		const r = await fetch('/avatars/knight.glb');
		const f = new File([await r.arrayBuffer()], 'knight.glb');
		return window.__stores.fileHandler.importFile(f, 'Knight');
	});
	await h.eventually(() => animOf(A.page), (s) => s?.uuid === uuid, 'M1: a rig with no clips registers as an animated import');
	h.check((await animOf(A.page)).clips.length === 0, 'M1: ...with no clips of its own');
	const bytesBefore = await modelHash(A.page, uuid);

	// the animation-only GLB becomes one .tpanim per clip in the Explorer
	await A.page.evaluate(async () => {
		const r = await fetch('/avatars/clips.glb');
		await window.__stores.explorer.importFiles([new File([await r.arrayBuffer()], 'clips.glb')], null);
	});
	await h.eventually(() => clipItems(A.page), (l) => l.length >= 10, 'M1: clips.glb imported as clip assets', 30000);
	const items = await clipItems(A.page);
	const walk = items.find((i) => /Walking_A\.tpanim$/.test(i.name));
	h.check(!!walk && items.every((i) => i.name.endsWith('.tpanim')), `M1: one .tpanim per clip (${items.length}: ${items.map((i) => i.name).slice(0, 3).join(', ')} …)`);
	h.check(!(await clipItems(A.page)).some((i) => /clips\.glb$/.test(i.name)), 'M1: the source GLB is not stored as a model');

	// the stored file is a real .tpanim: our extras, a skeleton clip, the knight's signature
	const facts = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const blob = await s.explorer.itemBlob(id);
		const tp = s.tpanim.decodeTpanim(await blob.arrayBuffer());
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const root = g.children.find((c) => c.name === 'Knight');
		return { extras: tp.tpExtras, humanoid: !!tp.humanoid, fps: tp.fps, frames: tp.frames, fit: s.tpanim.clipFit(tp, root).fit };
	}, walk.id);
	h.check(facts.extras && !facts.humanoid && facts.fps > 0 && facts.frames > 0, `M1: extras.theprototype written (fps ${facts.fps}, ${facts.frames} frames, skeleton clip)`);
	h.check(facts.fit === 'exact', `M1: the clip fits the knight's skeleton (${facts.fit})`);

	// assign + play: ONE ref, the clip plays on A
	await A.page.evaluate(({ uuid, walk }) => window.__stores.clipAssets.assignClipAsset(uuid, walk, { play: true }), { uuid, walk });
	await h.eventually(() => animOf(A.page), (s) => s?.info?.some((c) => c.asset === walk.hash) && s.playing, 'M1: the clip is bound and playing on A');
	const onA = await animOf(A.page);
	const clipName = onA.info.find((c) => c.asset === walk.hash).name;
	h.check(clipName === 'clips - Walking_A', `M1: the clip takes the item's name on the model ("${clipName}")`);
	const qa1 = await poseAtFixedTime(A.page, uuid, 0.1);
	const qa2 = await poseAtFixedTime(A.page, uuid, 0.5);
	h.check(qa1 && qa2 && dot(qa1, qa2) < 0.9999, 'M1: the clip moves the arm on A');

	// B: the model arrives as before, the clip bytes are pulled by hash, bound the same way
	await h.eventually(() => animOf(B.page), (s) => s?.uuid === uuid, 'M1: the model replicated to B', 20000);
	await h.eventually(() => animOf(B.page), (s) => s?.info?.some((c) => c.asset === walk.hash && c.name === clipName), 'M1: B pulled and bound the clip', 20000);
	await h.eventually(() => animOf(B.page), (s) => s?.playing && s.clip === clipName, 'M1: B plays it');
	const [pa, pb] = [await poseAtFixedTime(A.page, uuid, 0.37), await poseAtFixedTime(B.page, uuid, 0.37)];
	h.check(pa && pb && dot(pa, pb) > 0.99999, 'M1: A and B pose the same at the same clip time');
	h.check((await modelHash(A.page, uuid)) === bytesBefore, 'M1: the model bytes never changed on A');
	h.check((await modelHash(B.page, uuid)) === bytesBefore, 'M1: ...nor on B');
	h.check((await clipItems(B.page)).filter((i) => i.hash === walk.hash).length === 1, 'M1: B holds the clip once in its Explorer');

	// a late joiner gets the model + the clip
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	await h.eventually(() => animOf(C.page), (s) => s?.info?.some((c) => c.asset === walk.hash), 'M1: the late joiner pulled and bound the clip', 30000);
	const pc = await poseAtFixedTime(C.page, uuid, 0.37);
	h.check(pc && dot(pa, pc) > 0.99999, 'M1: the late joiner poses the same');
	const ins = await C.page.evaluate((hash) => {
		let rows;
		window.__stores.transferLedger.transfers.subscribe((x) => (rows = x))();
		return (Array.isArray(rows) ? rows : Object.values(rows ?? {})).filter((r) => r?.hash === hash && r?.dir === 'in').length;
	}, walk.hash);
	h.check(ins <= 1, `M1: the clip travelled to the late joiner at most once (${ins} transfer)`);
	await h.closePeer(C);

	// undo/redo of the assignment replicate (one step each)
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => animOf(B.page), (s) => s && !s.info.some((c) => c.asset === walk.hash), 'M1: undo removes the clip on B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => animOf(B.page), (s) => s?.info?.some((c) => c.asset === walk.hash), 'M1: redo brings it back on B', 15000);

	// saves: the entry names the clip by hash (and still carries the model's own bytes); the scene
	// asset manifest lists it, so a .tpscene bundles it
	const saved = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return s.animatedImports.animatedImportsSnapshot(g).find((e) => e.uuid === uuid);
	}, uuid);
	h.check(saved?.clipRefs?.length === 1 && saved.clipRefs[0].hash === walk.hash && !!saved.bytes, 'M1: the save entry carries clipRefs beside the model bytes');
	await A.page.waitForTimeout(700); // the manifest recomputes on a 400 ms debounce
	const manifest = await A.page.evaluate(() => window.__stores.sceneAssets.sceneAssetList());
	h.check(manifest.some((a) => a.hash === walk.hash && a.kind === 'anim'), 'M1: the scene asset manifest lists the clip (bundled in a .tpscene)');

	// restore from that entry on B (a reload stand-in): the clip is bound again from its hash
	await B.page.evaluate(async (entry) => {
		const s = window.__stores;
		await s.animatedImports.animatedImportsRestore([entry], false);
	}, saved);
	await h.eventually(() => animOf(B.page), (s) => s?.info?.some((c) => c.asset === walk.hash), 'M1: a restored save binds the clip again', 15000);

	await h.finish(browser);
});
