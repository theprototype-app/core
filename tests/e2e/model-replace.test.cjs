// 59 T1 / T2 / T7 — Replace model from a file, Edit in Blender, reimport like a DCC pipeline.
// The release-proof rows this lane owns, on the host (A), a connected peer (B) and a late joiner (C):
//  T1  an animated import wired to a flow (On Click -> Play Animation "Idle") is replaced through the
//      object menu's "Replace model…" (a real file chooser) by a re-rigged GLB of the SAME skeleton
//      that lacks "Idle": uuid, name, pose, physics, the flow wiring and the old clip (kept by bone
//      name, F2) survive on A, B and C; the flow still plays the kept clip; ONE undo puts the old
//      model back everywhere.
//  T2  "Edit in Blender…" downloads <name>.glb (a real download) that re-imports byte-identical in
//      geometry and carries extras.theprototype; the guide card opens.
//  T7b that file dropped with NOTHING selected asks "Update <name>?" and updates in place (the
//      parts keep their uuids — same shape).
//  F1  a model file dropped ONTO the selected object asks Replace / Add (+ remember for the session).
//  T7a a watched file saved again offers Reload (the File System Access handle is stubbed — the
//      picker is native UI), and Reload replaces.
//  T7c a 100× FBX (hand-written ASCII FBX: three has no FBX exporter) gets the scale fix; the fixed
//      size reaches B.
const h = require('./helpers.cjs');
/** evidence shots, only when SHOTS_DIR is set @param {any} page @param {string} name */
const shot = (page, name) => (process.env.SHOTS_DIR ? page.screenshot({ path: require('path').join(process.env.SHOTS_DIR, name) }).catch(() => {}) : Promise.resolve());

/** in-page: the object at uuid, as plain facts */
const factsOf = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		let anim;
		s.animatedImports.animatedObjects.subscribe((m) => (anim = m[uuid] ?? null))();
		let graphs;
		s.flowGraphs.subscribe((x) => (graphs = x))();
		const graph = graphs?.[uuid];
		const size = s.modelReplace ? s.modelReplace.contentSize(o) : null;
		return {
			name: o.name,
			parent: o.parent === g ? 'root' : o.parent?.uuid,
			pos: o.position.toArray().map((v) => +v.toFixed(4)),
			rot: o.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(4)),
			scale: o.scale.toArray().map((v) => +v.toFixed(4)),
			physics: o.userData.physics ?? null,
			clips: [...(anim?.clips ?? [])].sort(),
			clip: anim?.clip ?? null,
			playing: !!anim?.playing,
			animated: s.animatedImports.hasAnimatedImport(uuid),
			graphNodes: (graph?.nodes ?? []).map((n) => n.type).sort(),
			childUuids: o.children.map((c) => c.uuid),
			size: size ? size.map((v) => +v.toFixed(3)) : null
		};
	}, uuid);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await A.page.evaluate(() => window.__stores.modelDrop.forgetDropChoice());

	// ---------- fixtures: the shipped knight (a skinned mesh) + its clip library ----------
	// v1 = knight + Idle + Cheer; v2 ("re-rigged" elsewhere) = knight + Interact only — the SAME
	// skeleton, so Idle and Cheer must survive the replace by bone name
	const fixtures = await A.page.evaluate(async () => {
		const s = window.__stores;
		const fetchBytes = async (u) => (await fetch(u)).arrayBuffer();
		const parse = (bytes) => new Promise((res, rej) => s.animatedImports.createGltfLoader().parse(bytes, '', res, rej));
		const knight = await fetchBytes('/avatars/knight.glb');
		const lib = await parse(await fetchBytes('/avatars/clips.glb'));
		const k = await parse(knight);
		const index = s.modelClips.nodeIndexOf(k.scene, k.parser);
		const enc = (names) => lib.animations.filter((c) => names.includes(c.name)).map((c) => s.modelClips.clipToGlbAnimation(c, index).animation);
		const v1 = s.glbEdit.appendAnimations(knight, enc(['Idle', 'Cheer']));
		const v2 = s.glbEdit.appendAnimations(knight, enc(['Interact']));
		return { v1: Array.from(new Uint8Array(v1)), v2: Array.from(new Uint8Array(v2)) };
	});
	h.check(fixtures.v1.length > 100000 && fixtures.v2.length > 100000, `fixtures built (v1 ${fixtures.v1.length} B, v2 ${fixtures.v2.length} B)`);

	// ---------- T1 setup: the animated import, posed, with physics and a flow ----------
	const uuid = await A.page.evaluate(async (v1) => {
		const s = window.__stores;
		const id = await s.fileHandler.importFile(new File([new Uint8Array(v1)], 'knight.glb'), 'Knight');
		return id;
	}, fixtures.v1);
	await h.eventually(() => factsOf(B.page, uuid), (f) => f?.animated, 'B received the knight (objectfile)', 20000);
	await A.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', id);
		o.position.set(2, 0, 1);
		o.rotation.set(0, 0.5, 0);
		o.scale.set(1.5, 1.5, 1.5);
		o.updateMatrix();
		let peer;
		s.peers.subscribe((p) => (peer = p))();
		peer.send({ type: 'move', uuid: id, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
		o.userData.physics = { mode: 'dynamic', mass: 2 };
		peer.send({ type: 'objectParameters', parameter: 'physics', uuid: id, physics: o.userData.physics });
		s.flowGraphsCtl.createObjectGraph(id);
		s.nodesHandler.createFlowNode({ id: 'k-click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } }, id);
		s.nodesHandler.createFlowNode(
			{ id: 'k-play', type: 'playanim', position: { x: 220, y: 0 }, data: { type: 'playanim', clip: 'Idle', action: 'restart', speed: 1 } },
			id
		);
		s.nodesHandler.createFlowEdge({ id: 'e-k', source: 'k-click', target: 'k-play', targetHandle: 'trigger' }, id);
	}, uuid);
	await h.eventually(() => factsOf(B.page, uuid), (f) => f?.clips?.includes('Idle') && f.physics?.mass === 2 && f.pos[0] === 2, 'B holds the posed knight (objectfile) with physics', 20000);
	await h.eventually(() => factsOf(B.page, uuid), (f) => f?.graphNodes?.join() === 'onclick,playanim', 'B holds the knight\'s flow before the replace', 20000);
	const before = await factsOf(A.page, uuid);
	h.check(before.animated && before.clips.join() === 'Cheer,Idle', `A: the knight is an animated import with Idle, Cheer (${before.clips})`);

	// ---------- the Inspector shows the Model row for it ----------
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuid);
	await h.eventually(() => A.page.locator('#model-source-replace').isVisible().catch(() => false), (v) => v, 'Inspector ▸ Model shows Replace model…', 15000);
	h.check(await A.page.locator('#model-source-blender').isVisible(), 'Inspector ▸ Model shows Edit in Blender…');
	await shot(A.page, '01-inspector-model-section.png');

	// the object menu carries both rows too (single object, not locked)
	const menuRows = await A.page.evaluate((u) => {
		const s = window.__stores;
		const items = s.objectMenu.buildObjectMenuItems(u, { selection: [u] });
		return ['Replace model…', 'Edit in Blender…'].map((l) => !!s.objectMenu.findMenuItem(items, l) && !s.objectMenu.findMenuItem(items, l).disabled);
	}, uuid);
	h.check(menuRows.every(Boolean), 'the object menu offers Replace model… and Edit in Blender…');

	// ---------- T1: Inspector ▸ Replace model… through a REAL click + file chooser ----------
	// (a file chooser needs a user activation: a programmatic input.click() from evaluate is refused)
	const undoDepth = () => A.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
	const depth0 = await undoDepth();
	const chooser = A.page.waitForEvent('filechooser', { timeout: 15000 });
	await A.page.locator('#model-source-replace').click();
	await (await chooser).setFiles({ name: 'knight-rerig.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(fixtures.v2) });
	await h.eventually(() => factsOf(A.page, uuid), (f) => f?.clips?.includes('Interact'), 'A: the knight was replaced (Interact arrived)', 20000);
	const after = await factsOf(A.page, uuid);
	h.check(after.clips.join() === 'Cheer,Idle,Interact', `F2: the new file's clip + the old clips kept by bone name (${after.clips})`);
	h.check(after.name === 'Knight' && after.parent === 'root', `T1: name and parent kept (${after.name}, ${after.parent})`);
	h.check(JSON.stringify([after.pos, after.rot, after.scale]) === JSON.stringify([before.pos, before.rot, before.scale]), `T1: pose kept (${after.pos} / ${after.rot} / ${after.scale})`);
	h.check(after.physics?.mode === 'dynamic' && after.physics?.mass === 2, 'T1: physics kept');
	h.check(after.graphNodes.join() === 'onclick,playanim', `T1: the flow wiring kept (${after.graphNodes})`);
	h.check((await undoDepth()) === depth0 + 1, 'T1: ONE undo step');
	const report = await A.page.evaluate(() => window.__stores.modelReplace.lastReplaceReport());
	h.check([...(report?.kept ?? [])].sort().join() === 'Cheer,Idle' && report.dropped.length === 0, `the report names the kept clips (${report?.kept})`);
	const toast = await A.page.evaluate(() => new Promise((r) => window.__stores.toastStore.subscribe((t) => r(JSON.stringify(t)))()));
	h.check(/Replaced \\"Knight\\" from knight-rerig\.glb — kept clips (Idle, Cheer|Cheer, Idle)/.test(toast), 'the toast lists the kept clips');

	await h.eventually(() => factsOf(B.page, uuid), (f) => f?.clips?.join() === 'Cheer,Idle,Interact', 'B: the replaced model arrived with the kept clips (bytes)', 20000);
	const onB = await factsOf(B.page, uuid);
	h.check(JSON.stringify([onB.pos, onB.rot, onB.scale]) === JSON.stringify([before.pos, before.rot, before.scale]) && onB.physics?.mass === 2, `B: pose + physics kept (${onB.pos} / ${onB.rot} / ${onB.scale}, ${JSON.stringify(onB.physics)})`);
	h.check(onB.graphNodes.join() === 'onclick,playanim', `B: the flow wiring kept (${onB.graphNodes})`);

	// the flow still plays the KEPT clip, on every peer
	await A.page.evaluate((u) => window.__stores.flowRuntime.fireObjectClick(u), uuid);
	await h.eventually(() => factsOf(A.page, uuid), (f) => f?.playing && f.clip === 'Idle', 'A: On Click -> Play Animation plays the kept "Idle"', 10000);
	await h.eventually(() => factsOf(B.page, uuid), (f) => f?.playing && f.clip === 'Idle', 'B: ...and so does B', 10000);

	// ---------- the late joiner ----------
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	await h.answerRestore(C, 'dismiss', 3000).catch(() => {});
	await h.eventually(() => factsOf(C.page, uuid), (f) => f?.clips?.join() === 'Cheer,Idle,Interact', 'C (late joiner): the replaced model with the kept clips', 30000);
	const onC = await factsOf(C.page, uuid);
	h.check(JSON.stringify([onC.pos, onC.rot, onC.scale]) === JSON.stringify([before.pos, before.rot, before.scale]) && onC.physics?.mass === 2, `C: pose + physics kept (${onC.pos} / ${onC.rot} / ${onC.scale}, ${JSON.stringify(onC.physics)})`);
	h.check(onC.graphNodes.join() === 'onclick,playanim', 'C: the flow wiring kept');
	await h.closePeer(C);

	// ---------- ONE undo puts the old model back everywhere; redo the new ----------
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => factsOf(A.page, uuid), (f) => f?.clips?.join() === 'Cheer,Idle', 'undo: A has the old model back', 10000);
	await h.eventually(() => factsOf(B.page, uuid), (f) => f?.clips?.join() === 'Cheer,Idle', 'undo: B has the old model back', 20000);
	const undone = await factsOf(A.page, uuid);
	h.check(JSON.stringify([undone.pos, undone.rot, undone.scale]) === JSON.stringify([before.pos, before.rot, before.scale]) && undone.graphNodes.length === 2, 'undo: pose and flow intact');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => factsOf(B.page, uuid), (f) => f?.clips?.includes('Interact'), 'redo: B has the replacement again', 20000);

	// ---------- T2: Edit in Blender on a STATIC model (two named parts) ----------
	const crate = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const root = new THREE.Group();
		const body = new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 1), new THREE.MeshStandardMaterial({ color: 0x996633 }));
		body.name = 'Body';
		const lid = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1), new THREE.MeshStandardMaterial({ color: 0x664422 }));
		lid.name = 'Lid';
		lid.position.set(0, 0.5, 0);
		root.add(body, lid);
		// two scene ROOT nodes (Body, Lid), the shape a file exported from Blender has
		const bytes = await new Promise((r) => new s.GLTFExporterModule.GLTFExporter().parse([body, lid], r, () => r(null), { binary: true }));
		const id = await s.fileHandler.importFile(new File([bytes], 'crate.glb'), 'Crate');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', id);
		o.position.set(-2, 0.5, 0);
		o.updateMatrix();
		let peer;
		s.peers.subscribe((p) => (peer = p))();
		peer.send({ type: 'move', uuid: id, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
		return id;
	});
	await h.eventually(() => factsOf(B.page, crate), (f) => f?.pos?.[0] === -2, 'B holds the crate', 20000);
	const download = A.page.waitForEvent('download', { timeout: 15000 });
	await A.page.evaluate((u) => {
		const s = window.__stores;
		s.objectMenu.findMenuItem(s.objectMenu.buildObjectMenuItems(u, { selection: [u] }), 'Edit in Blender…').action();
	}, crate);
	const dl = await download;
	h.check(dl.suggestedFilename() === 'Crate.glb', `T2: the download is <name>.glb (${dl.suggestedFilename()})`);
	const dlPath = await dl.path();
	const exported = Array.from(require('fs').readFileSync(dlPath));
	await h.eventually(() => A.page.locator('#edit-in-blender').isVisible().catch(() => false), (v) => v, 'T2: the guide card opens', 10000);
	await shot(A.page, '02-edit-in-blender-card.png');
	const settings = await A.page.locator('#edit-in-blender-settings li').allInnerTexts();
	h.check(settings.some((t) => /\+Y Up/.test(t)) && settings.some((t) => /Custom Properties/.test(t)), `the card lists the export settings (${settings.length})`);
	const roundTrip = await A.page.evaluate(
		async ({ bytes, uuid }) => {
			const s = window.__stores;
			const buf = new Uint8Array(bytes).buffer;
			const stamp = s.glbEdit.readTpExtras(buf);
			const g2 = await new Promise((res, rej) => s.animatedImports.createGltfLoader().parse(buf, '', res, rej));
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const live = g.getObjectByProperty('uuid', uuid);
			const same = ['Body', 'Lid'].map((n) => {
				const a = live.getObjectByName(n).geometry.attributes.position.array;
				const b = g2.scene.getObjectByName(n).geometry.attributes.position.array;
				return a.length === b.length && a.every((v, i) => v === b[i]);
			});
			const rootTransform = g2.scene.children.map((c) => c.position.toArray().join(','));
			return { stamp, same, rootTransform, names: g2.scene.children.map((c) => c.name) };
		},
		{ bytes: exported, uuid: crate }
	);
	h.check(roundTrip.stamp?.uuid === crate && roundTrip.stamp.name === 'Crate', 'T2/T7b: the file carries extras.theprototype {uuid, name}');
	h.check(roundTrip.same.every(Boolean), 'T2: it re-imports byte-identical in geometry (every position)');
	h.check(roundTrip.names.join() === 'Body,Lid' && roundTrip.rootTransform[0] === '0,0,0', `T2: the file is the model, not the object's transform (${roundTrip.names} at ${roundTrip.rootTransform})`);
	await A.page.locator('#edit-in-blender-close').click();

	// ---------- T7b: drop that file with NOTHING selected -> "Update Crate?" ----------
	/** drop a file on the viewport at (x, y) through the app's real window drop handler */
	const dropFile = (page, bytes, name, x = 400, y = 300) =>
		page.evaluate(
			({ bytes, name, x, y }) => {
				const dt = new DataTransfer();
				dt.items.add(new File([new Uint8Array(bytes)], name));
				const target = document.elementFromPoint(x, y) ?? document.body;
				target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
			},
			{ bytes, name, x, y }
		);
	const crateChildren = (await factsOf(A.page, crate)).childUuids;
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.selectedObject.set(null);
		s.selectedObjects.set([]);
	});
	await dropFile(A.page, exported, 'Crate.glb');
	await h.eventually(() => A.page.locator('#confirm-model-drop-update').isVisible().catch(() => false), (v) => v, 'T7b: a stamped file dropped anywhere asks "Update Crate?"', 10000);
	await shot(A.page, '03-update-crate-ask.png');
	h.check(await A.page.getByText('Update "Crate"?', { exact: true }).first().isVisible().catch(() => false), 'the ask names the object');
	await A.page.locator('#confirm-dialog-update').click();
	await h.eventually(() => A.page.evaluate(() => window.__stores.modelReplace.lastReplaceReport()), (r) => r?.uuid === crate, 'T7b: Update replaced the crate in place', 10000);
	const updated = await factsOf(A.page, crate);
	h.check(updated.childUuids.join() === crateChildren.join(), 'T7b: same shape, so the parts keep their uuids');
	h.check(updated.pos[0] === -2, 'T7b: the crate stays where it stood');

	// ---------- F1: a file dropped ONTO the selected object asks Replace / Add ----------
	const plainBox = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial());
		m.name = 'Plain';
		const bytes = await new Promise((r) => new s.GLTFExporterModule.GLTFExporter().parse(m, r, () => r(null), { binary: true }));
		return Array.from(new Uint8Array(bytes));
	});
	await A.page.evaluate((u) => {
		window.__stores.objectActions.selectObject(u);
		window.__stores.objectActions.focusObject(u);
	}, crate);
	await A.page.waitForTimeout(1500); // the focus glide
	const at = await h.projectPoint(A.page, [-2, 0.5, 0]);
	const count = () => A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	const n0 = await count();
	await dropFile(A.page, plainBox, 'plain.glb', at.x, at.y);
	await h.eventually(() => A.page.locator('#confirm-model-drop-replace').isVisible().catch(() => false), (v) => v, 'F1: dropping onto the selected object asks Replace or add', 10000);
	h.check(await A.page.locator('#confirm-dialog-check').isVisible(), 'F1: with "Remember for this session"');
	await shot(A.page, '04-replace-or-add.png');
	await A.page.locator('#confirm-dialog-add').click();
	await h.eventually(count, (n) => n === n0 + 1, 'F1: Add imports a new object', 10000);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), crate);
	await dropFile(A.page, plainBox, 'plain.glb', at.x, at.y);
	await h.eventually(() => A.page.locator('#confirm-model-drop-replace').isVisible().catch(() => false), (v) => v, 'F1: asked again (nothing remembered)', 10000);
	await A.page.locator('#confirm-dialog-replace').click();
	await h.eventually(() => factsOf(A.page, crate), (f) => f?.childUuids?.length === 1, 'F1: Replace swapped the crate for the plain box', 10000);
	h.check((await count()) === n0 + 1, 'F1: ...in place (no new object)');

	// ---------- T7a: a watched file saved again offers Reload ----------
	await A.page.evaluate(
		({ bytes }) => {
			const file = (stamp) => new File([new Uint8Array(bytes)], 'Crate.glb', { lastModified: stamp });
			window.__watchFile = file(1000);
			const handle = { name: 'Crate.glb', getFile: async () => window.__watchFile };
			window.showOpenFilePicker = async () => [handle];
			window.__saveAgain = () => (window.__watchFile = file(2000));
		},
		{ bytes: exported }
	);
	await A.page.evaluate((u) => window.__stores.editInBlender.editInBlender(u), crate);
	await h.eventually(() => A.page.locator('#edit-in-blender-watch').isVisible().catch(() => false), (v) => v, 'T7a: Chromium desktop offers "Watch the exported file…"', 10000);
	await A.page.locator('#edit-in-blender-watch').click();
	await h.eventually(() => A.page.evaluate(() => new Promise((r) => window.__stores.modelWatch.watchedModels.subscribe((m) => r(Object.keys(m)))())), (k) => k.length === 1, 'T7a: the file is watched');
	await A.page.evaluate(async () => {
		window.__saveAgain();
		await window.__stores.modelWatch.pollAll();
	});
	// the toast store is rendered twice (the stack + the Connect drawer's Toasts tab): scope to one card
	const reloadToast = A.page.locator('.tp-toast', { hasText: 'Crate.glb changed — reload "Crate"?' }).first();
	await h.eventually(() => reloadToast.isVisible().catch(() => false), (v) => v, 'T7a: saving it again offers Reload', 10000);
	await shot(A.page, '05-watch-reload-toast.png');
	await reloadToast.getByRole('button', { name: 'Reload', exact: true }).click();
	await h.eventually(() => factsOf(A.page, crate), (f) => f?.childUuids?.length === 2, 'T7a: Reload put the exported crate back (two parts)', 10000);
	await A.page.evaluate((u) => window.__stores.modelWatch.stopWatching(u), crate);

	// ---------- T7c: a 100× FBX gets the scale fix ----------
	const fbx = (() => {
		const hs = 50; // a 100-unit cube: a 1 m crate exported in centimetres
		const v = [-hs, -hs, -hs, hs, -hs, -hs, hs, hs, -hs, -hs, hs, -hs, -hs, -hs, hs, hs, -hs, hs, hs, hs, hs, -hs, hs, hs];
		const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
		const idx = quads.flatMap((q) => [q[0], q[1], q[2], -q[3] - 1]);
		return `; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXHeaderVersion: 1003\n\tFBXVersion: 7400\n}\nGlobalSettings:  {\n\tVersion: 1000\n\tProperties70:  {\n\t\tP: "UpAxis", "int", "Integer", "",1\n\t\tP: "UnitScaleFactor", "double", "Number", "",1\n\t}\n}\nObjects:  {\n\tGeometry: 1000, "Geometry::Cube", "Mesh" {\n\t\tVertices: *${v.length} {\n\t\t\ta: ${v.join(',')}\n\t\t}\n\t\tPolygonVertexIndex: *${idx.length} {\n\t\t\ta: ${idx.join(',')}\n\t\t}\n\t\tGeometryVersion: 124\n\t}\n\tModel: 2000, "Model::Cube", "Mesh" {\n\t\tVersion: 232\n\t\tProperties70:  {\n\t\t}\n\t}\n}\nConnections:  {\n\tC: "OO",1000,2000\n\tC: "OO",2000,0\n}\n`;
	})();
	const sizeBefore = (await factsOf(A.page, crate)).size;
	const fixing = A.page.evaluate(
		({ u, text }) => window.__stores.modelReplace.replaceModelFromFile(u, new File([text], 'crate-cm.fbx'), { source: 'menu' }),
		{ u: crate, text: fbx }
	);
	await h.eventually(() => A.page.locator('#confirm-replace-model-sanity').isVisible().catch(() => false), (v) => v, 'T7c: the 100× FBX is flagged before it is placed', 10000);
	await shot(A.page, '06-sanity-100x.png');
	const items = await A.page.locator('#confirm-dialog-items li').allInnerTexts();
	h.check(items.some((t) => /about 100× larger/.test(t)), `T7c: "about 100× larger" (${items[0]})`);
	await A.page.locator('#confirm-dialog-fix').click();
	const fixed = await fixing;
	h.check(fixed?.fixed && fixed.issues.some((i) => i.kind === 'scale'), 'T7c: the scale fix was applied');
	const sizeAfter = (await factsOf(A.page, crate)).size;
	h.check(sizeAfter.every((v) => Math.abs(v - 1) < 0.01), `T7c: the FBX crate is back to metres (${sizeAfter}; was ${sizeBefore})`);
	await h.eventually(() => factsOf(B.page, crate), (f) => f?.size && f.size.every((v) => Math.abs(v - 1) < 0.01), 'T7c: the fixed size reached B (mesh sync)', 20000);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors on A or B');
	await h.finish(browser);
});
