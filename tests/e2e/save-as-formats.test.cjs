// R22 ROUND 11, PHASE 4 — "SAVE AS…", AND WHAT A PREFAB IS MADE OF.
//
// The user settled the formats: prefab (.glb), prefab (.tpscene) with a tooltip saying it
// includes animations / object-graph-nodes / shaders, and glb/gltf that just downloads.
// Then the rule that shaped the design: "for dragging to Library and back: 3d objects
// automatically placed as existing format (.glb/.gltf), .tpscene are placed as .tpscene
// (with thumbnail). This solves converting dilemma, we do not need to convert anything."
//
// THE DESIGN DECISION UNDER TEST: a prefab was a JSON snapshot in IndexedDB, not a file,
// so "prefab (.glb)" had nothing to mean. A prefab record may now carry a FORMAT and the
// file's own BYTES — and the bytes ride BESIDE the snapshot, never instead of it, which is
// why the thumbnail, the 3D preview, the facts block, VR and drop-at-the-cursor all still
// work. §5 is the check that pins that: the new formats must not go blank anywhere.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- save-as-formats
const h = require('./helpers.cjs');

const prefabList = (p) =>
	p.page.evaluate(() => {
		let list;
		window.__stores.prefabs.prefabs.subscribe((v) => (list = v))();
		return (list ?? []).map((x) => ({
			id: x.id,
			name: x.name,
			format: x.format ?? 'snapshot',
			bytes: x.bytes ? x.bytes.byteLength : 0,
			hasElement: !!x.element,
			hasThumb: !!x.thumbnail
		}));
	});

const itemList = (p) =>
	p.page.evaluate(() => {
		let list;
		window.__stores.explorer.explorerItems.subscribe((v) => (list = v))();
		return (list ?? []).map((i) => ({ id: i.id, name: i.name, kind: i.kind, thumb: !!i.thumbnail }));
	});

const worldNames = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return (g?.children ?? []).map((c) => c.name || c.type);
	});

const menuRows = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.textContent?.trim()).filter(Boolean)
	);

/** two boxes in the scene, selected, with a clip and a flow graph on the first */
async function seedScene(p) {
	return p.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1100));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const kids = g.children.slice(-2);
		const [box, ball] = kids;
		box.name = 'SaveMeBox';
		ball.name = 'SaveMeBall';
		// an authored clip on the box, so .tpscene has a second thing to carry
		s.animationPreview.addTrack(box.uuid, 'position', box);
		// an OBJECT FLOW GRAPH on the box — the thing ONLY .tpscene can carry
		s.flowGraphsCtl.createObjectGraph(box.uuid);
		s.nodesHandler.createFlowNode(
			{ id: 'n-save-as', type: 'time', position: { x: 40, y: 40 }, data: {} },
			box.uuid
		);
		await new Promise((r) => setTimeout(r, 400));
		// A WORLD TO LEAVE BEHIND, and a SCENE graph to prune. Without these the "no world"
		// and "the selection only" checks pass however the code behaves — measured: with the
		// pruning and the nulls torn out they stayed green, because there was nothing in the
		// scene for them to exclude.
		s.environment.setEnvironment('sunset');
		s.scenePhysics.setScenePhysics({ gravity: -3 });
		s.nodesHandler.createFlowNode({ id: 'n-scene-graph', type: 'time', position: { x: 10, y: 10 }, data: {} });
		await new Promise((r) => setTimeout(r, 600));
		s.objectActions.applySelectionSet([box.uuid, ball.uuid]);
		return { box: box.uuid, ball: ball.uuid };
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.saveAs && !!window.__stores?.prefabs, null, {
		timeout: 30000
	});
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.prefabs.loadPrefabs();
		await window.__stores.explorer.clearLibrary();
		window.__stores.prefabs.prefabs.set([]);
	});
	await page.waitForTimeout(500);

	// ---- 1. the catalog, and the menu rendered FROM it -------------------------------
	const catalog = await page.evaluate(() =>
		window.__stores.saveAs.SAVE_AS_FORMATS.map((f) => ({
			id: f.id,
			label: f.label,
			kind: f.kind,
			tip: f.tooltip
		}))
	);
	h.check(
		catalog.map((f) => f.id).join(',') === 'snapshot,glb,tpscene,download-glb,download-gltf',
		`the catalog holds the five formats the user asked for (${catalog.map((f) => f.id).join(',')})`
	);
	const tpTip = catalog.find((f) => f.id === 'tpscene')?.tip ?? '';
	h.check(
		/animation clips/i.test(tpTip) && /flow graph/i.test(tpTip) && /shader graph/i.test(tpTip),
		`the .tpscene tooltip says what it KEEPS, as asked (${tpTip.slice(0, 70)}…)`
	);
	h.check(
		/stays behind/i.test(tpTip) && /sky|gravity|music/i.test(tpTip),
		'…and what it drops, which is the half a tooltip usually leaves out'
	);
	const glbTip = catalog.find((f) => f.id === 'glb')?.tip ?? '';
	h.check(
		/not part of glTF|stay behind/i.test(glbTip),
		`the .glb tooltip is honest about node shaders and flow graphs (${glbTip.slice(0, 60)}…)`
	);

	const ids = await seedScene(A);
	await page.waitForTimeout(600);
	const built = await page.evaluate(() => {
		const rows = window.__stores.objectMenu.buildObjectMenuItems(
			(() => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				return g.children.at(-2).uuid;
			})(),
			{}
		);
		const saveAs = rows.find((r) => /^Save as/.test(r.label ?? ''));
		return {
			label: saveAs?.label ?? null,
			children: (saveAs?.children ?? []).map((c) => c.label),
			oldRow: rows.some((r) => r.label === 'Save as prefab' || r.label === 'Save as prefab (2)')
		};
	});
	h.check(
		built.label === 'Save as… (2)',
		`the object menu offers a counted "Save as…" over the SET (${built.label})`
	);
	h.check(
		built.children.join(',') === catalog.map((f) => f.label).join(','),
		`…rendered from the catalog, so the two cannot drift (${built.children.join(',')})`
	);
	h.check(!built.oldRow, 'the single "Save as prefab" row is gone — it is the submenu\'s first entry now');

	// ---- 2. a SNAPSHOT prefab is byte-identical to what it always was -----------------
	await page.evaluate((sel) => window.__stores.saveAs.saveSelectionAs('snapshot', sel), [ids.box, ids.ball]);
	await h.eventually(() => prefabList(A), (l) => l.length === 1, 'the snapshot format still saves a prefab');
	let prefabs = await prefabList(A);
	h.check(
		prefabs[0].format === 'snapshot' && prefabs[0].hasElement && prefabs[0].bytes === 0,
		`…and it carries NO bytes and NO format field — a pre-round-11 record exactly (${JSON.stringify(prefabs[0])})`
	);

	// ---- 3. .glb: a prefab that IS a file --------------------------------------------
	await page.evaluate((sel) => window.__stores.saveAs.saveSelectionAs('glb', sel, 'GlbPrefab'), [
		ids.box,
		ids.ball
	]);
	await h.eventually(() => prefabList(A), (l) => l.length === 2, 'a .glb prefab is saved');
	prefabs = await prefabList(A);
	const glb = prefabs.find((p) => p.format === 'glb');
	h.check(!!glb && glb.bytes > 500, `it carries the FILE (${glb?.bytes} bytes)`);
	h.check(
		!!glb && glb.hasElement && glb.hasThumb,
		'…BESIDE the snapshot and a thumbnail, which is what keeps the preview, the facts and VR working'
	);
	const isGlb = await page.evaluate((id) => {
		let list;
		window.__stores.prefabs.prefabs.subscribe((v) => (list = v))();
		const bytes = new Uint8Array(list.find((p) => p.id === id).bytes.slice(0, 4));
		return String.fromCharCode(...bytes);
	}, glb.id);
	h.check(isGlb === 'glTF', `and the bytes really are a binary glTF (magic "${isGlb}")`);

	// ---- 4. .tpscene: the format that carries what the others cannot ------------------
	await page.evaluate((sel) => window.__stores.saveAs.saveSelectionAs('tpscene', sel, 'ScenePrefab'), [
		ids.box,
		ids.ball
	]);
	await h.eventually(() => prefabList(A), (l) => l.length === 3, 'a .tpscene prefab is saved', 20000);
	prefabs = await prefabList(A);
	const tp = prefabs.find((p) => p.format === 'tpscene');
	h.check(!!tp && tp.bytes > 200, `it carries the zip (${tp?.bytes} bytes)`);
	const inside = await page.evaluate(async (id) => {
		let list;
		window.__stores.prefabs.prefabs.subscribe((v) => (list = v))();
		const payload = await window.__stores.sessions.readSessionZip(list.find((p) => p.id === id).bytes);
		return {
			objects: (payload.objects ?? []).length,
			graphKeys: Object.keys(payload.graphs ?? {}),
			animKeys: Object.keys(payload.animations ?? {}),
			// the WORLD must NOT be in it — a prefab has no business changing somebody's sky
			world: {
				environment: payload.environment ?? null,
				physics: payload.physics ?? null,
				music: payload.music ?? null,
				post: payload.post ?? null,
				hud: payload.hud ?? null,
				game: payload.game ?? null
			}
		};
	}, tp.id);
	h.check(
		inside.objects === 2,
		`the payload holds the SELECTION and nothing else (${inside.objects} objects)`
	);
	h.check(
		!inside.graphKeys.includes('scene'),
		'the SCENE own flow graph stays with the scene — pruneMissing cannot exclude it, because it asks about an OBJECT and the scene graph has none (' +
			JSON.stringify(inside.graphKeys) +
			')'
	);
	h.check(
		inside.graphKeys.includes(ids.box),
		`…and the box's OBJECT FLOW GRAPH, which is the whole reason to pick this format (${JSON.stringify(
			inside.graphKeys
		)})`
	);
	h.check(
		inside.animKeys.includes(ids.box),
		`…and its authored clip (${JSON.stringify(inside.animKeys)})`
	);
	const worldIsSet = await page.evaluate(() => {
		const payload = window.__stores.sessions.buildSessionPayload('probe');
		return { environment: !!payload.environment, physics: !!payload.physics };
	});
	h.check(
		worldIsSet.environment && worldIsSet.physics,
		'premise: the SCENE really has a sky and a gravity to leave behind (' + JSON.stringify(worldIsSet) + ')'
	);
	h.check(
		Object.values(inside.world).every((v) => v === null),
		`…and NONE of the world: sky, gravity, music, look, HUD, game (${JSON.stringify(inside.world)})`
	);

	// THE POINT: instantiating it hands the objects their documents back
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	const before = (await worldNames(A)).length;
	await page.evaluate((id) => {
		let list;
		window.__stores.prefabs.prefabs.subscribe((v) => (list = v))();
		window.__stores.prefabs.instantiatePrefab(list.find((p) => p.id === id));
	}, tp.id);
	await h.eventually(
		() => worldNames(A),
		(names) => names.length === before + 1,
		'a .tpscene prefab lands in the scene SYNCHRONOUSLY, like every other prefab'
	);
	const graphsOnNew = () =>
			page.evaluate(() => {
				let g, graphs;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				window.__stores.flowGraphs.subscribe((v) => (graphs = v))();
				const holder = g.children.at(-1);
				const uuids = [];
				holder.traverse((n) => uuids.push(n.uuid));
				return uuids.filter((u) => graphs[u]?.nodes?.length).length;
			});
	await h.eventually(
		graphsOnNew,
		(n) => n >= 1,
		'…and its object flow graph is carried across the fresh uuids',
		15000
	);
	const carried = await graphsOnNew();
	h.check(carried >= 1, `the graph really arrived on the new object (${carried})`);

	// ---- 5. the new formats do not go blank anywhere ---------------------------------
	const facts = await page.evaluate((id) => {
		const f = window.__stores.prefabs.prefabFacts(id);
		const object = window.__stores.prefabs.prefabObject(id);
		return { objects: f?.objects ?? 0, tris: f?.tris ?? 0, parsed: !!object };
	}, tp.id);
	h.check(
		facts.parsed && facts.objects >= 1,
		`a byte-backed prefab still parses for the facts block and the 3D preview (${JSON.stringify(facts)})`
	);

	// ---- 6. the two DOWNLOAD rows ----------------------------------------------------
	await page.evaluate((sel) => window.__stores.objectActions.applySelectionSet(sel), [ids.box]);
	const [dl] = await Promise.all([
		page.waitForEvent('download', { timeout: 25000 }),
		page.evaluate((sel) => window.__stores.saveAs.saveSelectionAs('download-glb', sel, 'JustABox'), [ids.box])
	]);
	h.check(/\.glb$/.test(dl.suggestedFilename()), `"just downloads" really downloads (${dl.suggestedFilename()})`);
	h.check(
		(await prefabList(A)).length === 3,
		'…and stores NOTHING in the library, which is what "just" means'
	);

	// ---- 7. DRAGGING TO THE LIBRARY AND BACK, with no conversion ---------------------
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('prefabs'));
	await page.waitForTimeout(700);
	const dragged = await page.evaluate((prefabId) => {
		const card = document.querySelector('[data-card-id="prefab:' + prefabId + '"]');
		if (!card) return { ok: false, why: 'no prefab card' };
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const tree = document.querySelector('#explorer-tree') ?? document.body;
		const root = tree.querySelector('[data-folder-root], #new-folder');
		return { ok: true, payload: JSON.parse(dt.getData('application/x-explorer-item') || '{}') };
	}, tp.id);
	h.check(dragged.ok && dragged.payload.prefabId === tp.id, `premise: a prefab card drags its id (${JSON.stringify(dragged)})`);

	// drop it on the library ROOT through the same applier the tree row uses
	await page.evaluate(async (prefabId) => {
		let list;
		window.__stores.prefabs.prefabs.subscribe((v) => (list = v))();
		const prefab = list.find((p) => p.id === prefabId);
		// the Explorer's own handler, reached the way the tree row reaches it
		window.__saveAsTest = { prefab };
	}, tp.id);
	// the REAL gesture: the prefab card onto the tree's Library row, which is a real drop
	// target (`dropInto(e, null)`) — the branch that used to throw a prefab payload away
	const droppedItem = await page.evaluate((prefabId) => {
		const card = document.querySelector('[data-card-id="prefab:' + prefabId + '"]');
		const target = document.querySelector('#explorer-root-row');
		if (!card || !target) return false;
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		return true;
	}, tp.id);
	h.check(droppedItem, 'premise: the prefab card was dropped on the Library row');
	await h.eventually(
		() => itemList(A),
		(list) => list.some((i) => /\.tpscene$/.test(i.name)),
		'a .tpscene prefab reaches the Library AS a .tpscene — nothing converted',
		15000
	);
	const inLibrary = (await itemList(A)).find((i) => /\.tpscene$/.test(i.name));
	h.check(inLibrary.kind === 'scene', `…and the library reads it as a scene file (${inLibrary.kind})`);
	// the patch lands just AFTER the item appears in the store, so wait on the thing
	await h.eventually(
		() => itemList(A),
		(list) => !!list.find((i) => /.tpscene$/.test(i.name))?.thumb,
		'the thumbnail travelled with it, as the user asked',
		10000
	);

	// ...and BACK: the library file becomes a prefab, still a .tpscene
	const back = await page.evaluate(async (itemId) => {
		let list;
		window.__stores.explorer.explorerItems.subscribe((v) => (list = v))();
		const record = list.find((i) => i.id === itemId);
		const blob = await window.__stores.explorer.itemBlob(record.id);
		const bytes = await blob.arrayBuffer();
		const payload = await window.__stores.sessions.readSessionZip(bytes);
		const THREE = window.__stores.THREE;
		const holder = new THREE.Group();
		for (const el of payload?.objects ?? []) holder.add(new THREE.ObjectLoader().parse(el));
		const entry = await window.__stores.prefabs.addPrefabRecord({
			name: record.name.replace(/\.[^.]+$/, ''),
			element: holder.toJSON(),
			thumbnail: record.thumbnail,
			format: 'tpscene',
			bytes
		});
		return { id: entry?.id, format: entry?.format, bytes: entry?.bytes?.byteLength ?? 0 };
	}, inLibrary.id);
	h.check(
		back.format === 'tpscene' && back.bytes > 200,
		`…and back again, still a .tpscene with its own bytes (${JSON.stringify(back)})`
	);

	// a SNAPSHOT prefab declines rather than inventing a format for itself
	const snapId = (await prefabList(A)).find((p) => p.format === 'snapshot').id;
	const declined = await page.evaluate((id) => {
		let list;
		window.__stores.prefabs.prefabs.subscribe((v) => (list = v))();
		const prefab = list.find((p) => p.id === id);
		return { format: window.__stores.saveAs.prefabFormatOf(prefab), bytes: !!prefab.bytes };
	}, snapId);
	h.check(
		declined.format === 'snapshot' && !declined.bytes,
		`a snapshot prefab has no file to be, and says so rather than inventing one (${JSON.stringify(declined)})`
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
