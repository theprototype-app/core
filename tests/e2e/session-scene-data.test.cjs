// A6.1/A6.3: a .tpscene carries the scene's LOOK and RULES, not only its objects.
//
// The verified gap this covers: buildSessionPayload carried objects/animated/
// animations/graphs/shaderGraphs/annotations/joints/post/camera and NO environment
// preset, NO fog, NO scene gravity, NO music - so a game template loaded into
// whatever sky and gravity the room happened to have, and a physics scene is
// unplayable at a peer's edited gravity.
//
// Two bugs ride along: exportSessionZip's `flow:false` stripped nodes/edges but left
// `graphs` untouched, and importObjects re-uuids every object it parses, which
// silently dropped that object's flow graph / shader graph / clips on a MERGE import.
//
// Two peers, because a restore must REPLICATE (the jointsRestore precedent): loading
// a scene into a live room has to bring its sky and gravity to everyone.
const h = require('./helpers.cjs');
const { unzipSync, strFromU8 } = require('fflate');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	// ---------------------------------------------------------------- 1: the shape
	// A DEFAULT scene must not grow the new fields at all. A snapshot that returns
	// null is OMITTED rather than written as `"environment":null`, which is what makes
	// "a default scene saves byte-identical to what a pre-A6 build wrote" true rather
	// than merely nearly true - assert the KEYS, since a null value would pass a
	// truthiness check while changing every file this build writes.
	const bare = await A.page.evaluate(() => {
		const payload = window.__stores.sessions.buildSessionPayload('bare');
		return { keys: Object.keys(payload), json: JSON.stringify(payload) };
	});
	h.check(!bare.keys.includes('environment'), 'a default scene writes NO environment key');
	h.check(!bare.keys.includes('physics'), 'a default scene writes NO physics key');
	h.check(!bare.keys.includes('music'), 'a default scene writes NO music key');
	h.check(!bare.keys.includes('modules'), 'a default scene writes NO modules key');
	h.check(!/"environment":null/.test(bare.json), 'no explicit null lands in the json either');

	// ---------------------------------------------------------- 2: it carries them
	// Author a look and a rule, then read the payload back. Gravity is the one that
	// makes a game unplayable, so it is the one asserted by value.
	const authored = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		mesh.name = 'sceneDataBox';
		mesh.updateMatrix();
		/** @type {any} */ let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		group.add(mesh);
		s.objectsGroup.update((v) => v);
		s.environment.setEnvironment('night', 1.4);
		s.scenePhysics.setSceneGravity(-3.25);
		// music references an Explorer CONTENT HASH - put real bytes in the library so
		// the hash resolves and the zip has something to bundle
		const bytes = new Uint8Array(2048).map((_, i) => (i * 7) % 251);
		const item = await s.explorer.addItemFromBytes(bytes.buffer, 'theme.mp3');
		s.sceneMusic.setMusicTrack(item.hash, 'theme.mp3');
		// POLL rather than sleep: sceneAssets recomputes on a 400ms debounce that every
		// objectsGroup write RESTARTS, so a fixed wait races whatever else the app is
		// doing (it read empty once with a peer connected)
		for (let i = 0; i < 30; i++) {
			if (s.sceneAssets.sceneAssetList().some((/** @type {any} */ a) => a.hash === item.hash)) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		const payload = s.sessions.buildSessionPayload('authored');
		return {
			env: payload.environment,
			physics: payload.physics,
			music: payload.music,
			hash: item.hash,
			assets: s.sceneAssets.sceneAssetList().map((/** @type {any} */ a) => a.hash)
		};
	});
	h.check(authored.env?.preset === 'night', 'payload carries the sky preset (' + authored.env?.preset + ')');
	h.check(authored.env?.exposure === 1.4, 'payload carries the exposure (' + authored.env?.exposure + ')');
	h.check(authored.physics?.gravity === -3.25, 'payload carries scene gravity (' + authored.physics?.gravity + ')');
	h.check(authored.music?.hash === authored.hash, 'payload carries the music track by content hash');
	// the trap the plan names: without the sceneAssets entry the hash sits in
	// session.json with no bytes in assets/, so a loaded scene is silent until some
	// peer happens to already have the file
	h.check(
		authored.assets.includes(authored.hash),
		'the music hash is listed as a scene ASSET, so exportSessionZip bundles its bytes'
	);

	// ------------------------------------------------- 3: a real zip carries them
	// Round-trip through the ACTUAL .tpscene path, not just the payload object,
	// because that is the path a template travels.
	// NOTE: the unzip happens in NODE. A bare `import('fflate')` inside page.evaluate
	// does not resolve — vite rewrites that specifier at build time for app code only.
	const zipBytes = await A.page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('zip me');
		const bytes = await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		return Array.from(bytes);
	});
	const zipEntries = unzipSync(new Uint8Array(zipBytes));
	const zipInner = JSON.parse(strFromU8(zipEntries['session.json']));
	h.check(
		zipInner.environment?.preset === 'night' && zipInner.physics?.gravity === -3.25,
		'the zip session.json carries sky + gravity'
	);
	h.check(
		Object.keys(zipEntries).some((f) => f.startsWith('assets/') && f.includes(authored.hash)),
		'the zip carries the music BYTES under assets/'
	);

	// ------------------------------------------- 4: restore applies AND replicates
	// Stash the authored payload, reset the live state, then load it back and watch
	// BOTH peers converge. A solo check would pass with the `replicate` argument
	// removed, which is the whole reason it is passed.
	await A.page.evaluate(() => {
		const s = window.__stores;
		window.__sceneDataPayload = s.sessions.buildSessionPayload('restore me');
		s.environment.setEnvironment('studio', 1);
		s.scenePhysics.setSceneGravity(-9.81);
	});
	await A.page.waitForTimeout(400);
	await A.page.evaluate(async () => {
		await window.__stores.sessions.applySession(window.__sceneDataPayload);
	});
	await h.eventually(
		() =>
			A.page.evaluate(() => ({
				preset: window.__stores.environment.environmentState().preset,
				gravity: window.__stores.scenePhysics.scenePhysicsDebug().gravity
			})),
		(v) => v.preset === 'night' && Math.abs(v.gravity + 3.25) < 1e-6,
		'loading the scene restores its sky and gravity locally',
		15000
	);
	await h.eventually(
		() =>
			B.page.evaluate(() => ({
				preset: window.__stores.environment.environmentState().preset,
				gravity: window.__stores.scenePhysics.scenePhysicsDebug().gravity
			})),
		(v) => v.preset === 'night' && Math.abs(v.gravity + 3.25) < 1e-6,
		'and the PEER gets them too (the restore replicates)',
		18000
	);

	// -------------------------------- 5: ABSENT means the author's default, not yours
	// The fork that actually makes a game deterministic: a scene load is a whole-world
	// replace, so a file that says nothing about gravity must RESET it. Leaving the
	// room's value is exactly "Towers is unplayable at a peer's edited gravity".
	await A.page.evaluate(() => window.__stores.scenePhysics.setSceneGravity(-1.5));
	await A.page.waitForTimeout(300);
	const beforeReset = await A.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug().gravity);
	h.check(Math.abs(beforeReset + 1.5) < 1e-6, 'premise: the room sits at an edited gravity (' + beforeReset + ')');
	await A.page.evaluate(async () => {
		const s = window.__stores;
		// a pre-A6 payload: no environment, no physics, no music at all
		const legacy = { ...window.__sceneDataPayload, name: 'legacy' };
		delete legacy.environment;
		delete legacy.physics;
		delete legacy.music;
		await s.sessions.applySession(legacy);
	});
	await h.eventually(
		() =>
			A.page.evaluate(() => ({
				gravity: window.__stores.scenePhysics.scenePhysicsDebug().gravity,
				preset: window.__stores.environment.environmentState().preset,
				music: window.__stores.sceneMusic.musicDebug().hash
			})),
		(v) => Math.abs(v.gravity + 9.81) < 1e-6 && v.preset === 'studio' && !v.music,
		'a scene with no look/rules resets sky, gravity and music to the defaults',
		15000
	);

	// ------------------------------------------- 6: flow:false really strips the flow
	// The bug: `graphs` survived, so "don't include the flow" exported every graph
	// document anyway - including per-object ones the legacy nodes/edges never carried.
	// Asserted as an A/B so a broken export path cannot read as a pass.
	const flowZips = await A.page.evaluate(async () => {
		const s = window.__stores;
		/** @type {any} */ let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const target = group.children[0];
		s.flowGraphsCtl.createObjectGraph(target.uuid);
		s.updateGraph(target.uuid, () => ({
			nodes: [{ id: 'strip1', type: 'spin', position: { x: 10, y: 10 }, data: { type: 'spin', speed: 1 } }],
			edges: []
		}));
		await new Promise((r) => setTimeout(r, 250));
		const read = async (/** @type {boolean} */ flow) => {
			const payload = s.sessions.buildSessionPayload('flow ' + flow);
			const bytes = await s.sessions.exportSessionZip(payload, { assets: false, packs: false, flow });
			return Array.from(bytes);
		};
		return { on: await read(true), off: await read(false) };
	});
	const readFlow = (/** @type {number[]} */ bytes) => {
		const inner = JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))['session.json']));
		return {
			graphNodes: Object.values(inner.graphs ?? {}).reduce(
				(/** @type {number} */ sum, /** @type {any} */ g) => sum + (g.nodes ?? []).length,
				0
			),
			hasModules: 'modules' in inner
		};
	};
	const flowOn = readFlow(flowZips.on);
	const flowOff = readFlow(flowZips.off);
	h.check(flowOn.graphNodes > 0, 'premise: with flow ON the export has graph nodes (' + flowOn.graphNodes + ')');
	h.check(
		flowOff.graphNodes === 0,
		'flow:false strips GRAPHS too, not only nodes/edges (' + flowOff.graphNodes + ' left)'
	);
	h.check(!flowOff.hasModules, 'and drops the derived module requirement with them');

	// ----------------------- 7: a MERGE import carries per-object documents across
	// importObjects reassigns every uuid (a merge must not collide with what is
	// already there), and the payload's per-object documents are keyed by the OLD
	// uuid - so they used to be dropped in silence. Assert against the NEW uuid, which
	// is the only assertion the bug can fail.
	const merged = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/clear all');
		await new Promise((r) => setTimeout(r, 400));
		/** @type {any} */ let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		mesh.name = 'flowOwner';
		mesh.updateMatrix();
		group.add(mesh);
		s.objectsGroup.update((v) => v);
		const oldUuid = mesh.uuid;
		s.flowGraphsCtl.createObjectGraph(oldUuid);
		s.updateGraph(oldUuid, () => ({
			nodes: [{ id: 'n1', type: 'spin', position: { x: 20, y: 20 }, data: { type: 'spin', speed: 1 } }],
			edges: []
		}));
		s.animationPreview.createClip(oldUuid, 'Wiggle');
		await new Promise((r) => setTimeout(r, 250));
		const payload = s.sessions.buildSessionPayload('merge source');
		// wipe the world, so anything that survives can only have come from the import
		s.commandsHandler.sceneCommand('/clear all');
		await new Promise((r) => setTimeout(r, 500));
		/** @type {any} */ let clearedGraphs;
		s.flowGraphs.subscribe((g) => (clearedGraphs = g))();
		const graphKeysBefore = Object.keys(clearedGraphs).length;
		/** @type {any} */ let clearedClips;
		s.animationPreview.animations.subscribe((a) => (clearedClips = a))();
		const clipsClearedFirst = Object.keys(clearedClips).length;
		const added = s.sessions.importObjects(payload, [0]);
		await new Promise((r) => setTimeout(r, 400));
		const fresh = group.children.find((/** @type {any} */ c) => c.name === 'flowOwner');
		/** @type {any} */ let graphs;
		s.flowGraphs.subscribe((g) => (graphs = g))();
		/** @type {any} */ let clips;
		s.animationPreview.animations.subscribe((a) => (clips = a))();
		return {
			added,
			reuuided: !!fresh && fresh.uuid !== oldUuid,
			graphOnNew: (graphs[fresh?.uuid]?.nodes ?? []).length,
			graphKeys: Object.keys(graphs).length,
			graphKeysBefore,
			// PREMISE for the clip half: '/clear all' DOES drop animations, so anything
			// found under the new uuid can only have come from the import. (It does NOT
			// drop object flow DOCUMENTS — serializeGraphs prunes orphans at output only,
			// so undoing an object delete still finds its flow — which is why the graph
			// half is asserted by count and by node identity rather than by absence.)
			clipsClearedFirst,
			nodeIdReused: (graphs[fresh?.uuid]?.nodes ?? []).some((/** @type {any} */ n) => n.id === 'n1'),
			clipNamesOnNew: Object.values(clips[fresh?.uuid]?.clips ?? {}).map((/** @type {any} */ c) => c.name)
		};
	});
	h.check(merged.added === 1 && merged.reuuided, 'premise: the merge import gave the object a FRESH uuid');
	h.check(merged.graphOnNew === 1, 'the flow graph followed it to the new uuid (' + merged.graphOnNew + ' node)');
	h.check(
		merged.graphKeys === merged.graphKeysBefore + 1,
		'exactly ONE new graph document appeared (' + merged.graphKeysBefore + ' -> ' + merged.graphKeys + ')'
	);
	// a node id is global to the app, not scoped to its graph - reusing it would break
	// peer dedupe, which is why copyGraphFrom regenerates them
	h.check(!merged.nodeIdReused, 'and its node ids were regenerated, not reused');
	h.check(merged.clipsClearedFirst === 0, 'premise: the clear wiped every animation, so nothing can leak in');
	// an object always owns a 'Movement' clip, so the authored one is checked BY NAME
	h.check(
		merged.clipNamesOnNew.includes('Wiggle'),
		'its authored clips came across too (' + JSON.stringify(merged.clipNamesOnNew) + ')'
	);

	h.check(h.pageErrors(A).length === 0, 'no page errors on A: ' + h.pageErrors(A).join(' | '));
	h.check(h.pageErrors(B).length === 0, 'no page errors on B: ' + h.pageErrors(B).join(' | '));
	await h.finish(browser);
});
