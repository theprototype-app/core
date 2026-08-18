// SH6b: the SCENE DEFAULT graph (layer 2) driving many objects at once.
//
// The plan's SH6b asks for "compile once per distinct graph and clone per object so
// three's program cache dedupes, copying each object's own base colour into its uniforms
// so palette.js's per-object colours are not flattened". This suite MEASURES the thing
// that optimisation would buy before anything is built for it — the chunked-meshgeo
// lesson, where a protocol was nearly written for a phantom limit.
//
// It also guards the correctness half, which matters whichever way the compile goes:
// palette.js derives every object's colour from its uuid, so a scene-wide graph must
// leave each object looking like itself rather than flattening the scene to one colour.
//
// Run: $env:APP_URL='https://localhost:5197/'; npm run e2e -- shader-scene-default
const h = require('./helpers.cjs');

const COUNT = 24;

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
	});
	const peer = await h.setupPage(browser, 'shader-scene-default');
	const page = peer.page;
	const glsl = [];
	page.on('console', (msg) => {
		const t = msg.text();
		if (/peer error|peerjs|Lost connection/i.test(t)) return;
		if (/Shader Error|ERROR: \d|VALIDATE_STATUS/i.test(t)) glsl.push(t.slice(0, 400));
	});
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });

	// a row of boxes, each given a DISTINCT base colour by hand so the flattening check
	// does not depend on which uuids palette.js happened to produce
	const built = await page.evaluate(async (count) => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		for (let i = 0; i < count; i++) S.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 2500));
		const group = await read(S.objectsGroup);
		/** @type {any[]} */
		const meshes = [];
		group.traverse((n) => {
			if (n.isMesh) meshes.push(n);
		});
		meshes.forEach((m, i) => {
			m.position.set((i % 8) * 1.4 - 5, 0.5 + Math.floor(i / 8) * 1.4, 0);
			m.updateMatrixWorld(true);
			// alternate red / blue bases: a scene graph must keep them distinguishable
			if (m.material?.color?.setRGB) {
				if (i % 2 === 0) m.material.color.setRGB(1, 0.08, 0.08);
				else m.material.color.setRGB(0.08, 0.08, 1);
			}
		});
		return { meshes: meshes.length, uuids: meshes.map((m) => m.uuid) };
	}, COUNT);
	h.check(built.meshes >= COUNT, 'premise — ' + built.meshes + ' meshes in the scene');

	// ---- 1. one scene graph drives all of them ------------------------------
	const applied = await page.evaluate(async () => {
		const S = window.__stores.shaderGraph;
		const renderer = await new Promise((r) => window.__stores.globalRenderer.subscribe((v) => r(v))());
		const scene = await new Promise((r) => window.__stores.globalScene.subscribe((v) => r(v))());
		const camera = await new Promise((r) => window.__stores.globalCamera.subscribe((v) => r(v))());
		// render once so the renderer's program list reflects the pre-shader state
		renderer.render(scene, camera);
		const programsBefore = renderer.info.programs?.length ?? -1;

		const targets = S.defaultTargetsFor('scene').length;
		const t0 = performance.now();
		S.setShaderGraphFor('scene', {
			nodes: [
				{ id: 'f', type: 'fresnel', position: { x: 60, y: 60 }, data: { power: 2 } },
				{ id: 's', type: 'surface', position: { x: 380, y: 80 }, data: {} }
			],
			edges: [{ id: 'e', source: 'f', sourceHandle: 'out', target: 's', targetHandle: 'emissive' }]
		});
		const res = await S.compileAndApply('scene');
		const compileMs = performance.now() - t0;

		// two renders: the first is where three builds each program
		renderer.render(scene, camera);
		renderer.render(scene, camera);
		const programsAfter = renderer.info.programs?.length ?? -1;
		return {
			targets,
			ok: res.ok,
			errors: res.errors ?? [],
			compileMs,
			driven: S.shaderDrivenCount(),
			programsBefore,
			programsAfter
		};
	});
	h.check(
		applied.targets >= COUNT,
		'the scene key resolves to every mesh with no graph of its own: ' + applied.targets
	);
	h.check(applied.ok && !applied.errors.length, 'it compiles: ' + JSON.stringify(applied.errors));
	h.check(
		applied.driven >= COUNT,
		'and all ' + applied.driven + ' objects end up shader-driven from ONE document'
	);

	// ---- 2. the MEASUREMENT SH6b's optimisation would be for ----------------
	// Per-object compile is what ships today. If that is already fast at a realistic
	// object count, compile-once-and-clone buys nothing and must not be built.
	const perObject = applied.compileMs / Math.max(1, applied.targets);
	console.log(
		'      MEASURED: ' + applied.compileMs.toFixed(1) + ' ms for ' + applied.targets +
			' objects = ' + perObject.toFixed(2) + ' ms each'
	);
	h.check(
		applied.compileMs < 600,
		'compiling a scene graph onto ' + applied.targets + ' objects takes ' +
			applied.compileMs.toFixed(1) + ' ms (' + perObject.toFixed(2) + ' ms each) — the ceiling this records is 600'
	);

	// three caches PROGRAMS by customProgramCacheKey, which hashes the injected code — so
	// N identically-injected materials must share ONE program, and the compile-once
	// optimisation would not change that either
	h.check(
		applied.programsAfter - applied.programsBefore <= 3,
		'and they share GPU programs rather than one each: ' + applied.programsBefore +
			' -> ' + applied.programsAfter + ' programs for ' + applied.targets + ' objects'
	);

	// ---- 3. per-object base colours are NOT flattened -----------------------
	// This is the correctness half, and the reason compile-once needs care: cloning ONE
	// compiled material would give every object the same base colour.
	const colours = await page.evaluate(async (uuids) => {
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		const group = await read(window.__stores.objectsGroup);
		const pick = (i) => {
			const o = group.getObjectByProperty('uuid', uuids[i]);
			return o?.material?.color ? o.material.color.getHexString() : null;
		};
		const mats = uuids.map((u) => group.getObjectByProperty('uuid', u)?.material);
		return {
			first: pick(0),
			second: pick(1),
			third: pick(2),
			// distinct material INSTANCES: a shared one could not hold two colours
			distinctMaterials: new Set(mats.filter(Boolean)).size,
			// but the same injected source, which is what lets three share the program
			sameCacheKey:
				new Set(mats.filter(Boolean).map((m) => m.customProgramCacheKey?.() ?? '?')).size
		};
	}, built.uuids);
	h.check(
		colours.first !== colours.second,
		'a scene-wide graph keeps each object its OWN colour rather than flattening the scene: ' +
			colours.first + ' vs ' + colours.second
	);
	h.check(
		colours.first === colours.third,
		'consistently (the alternating bases survive): ' + colours.third
	);
	h.check(
		colours.distinctMaterials >= COUNT,
		'each object holds its own material instance: ' + colours.distinctMaterials
	);
	h.check(
		colours.sameCacheKey === 1,
		'while all of them report ONE program cache key, so the GPU work is shared: ' +
			colours.sameCacheKey + ' distinct key(s)'
	);

	// ---- 4. an own graph still wins, at scale ------------------------------
	const optOut = await page.evaluate(async (uuids) => {
		const S = window.__stores.shaderGraph;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		S.setShaderGraphFor(uuids[0], {
			nodes: [
				{ id: 'c', type: 'color', position: { x: 60, y: 60 }, data: { value: '#10ff40' } },
				{ id: 's', type: 'surface', position: { x: 380, y: 80 }, data: {} }
			],
			edges: [{ id: 'e', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' }]
		});
		await S.compileAndApply(uuids[0]);
		const group = await read(window.__stores.objectsGroup);
		const own = group.getObjectByProperty('uuid', uuids[0]);
		return {
			key: S.graphKeyFor(uuids[0]),
			sceneTargets: S.defaultTargetsFor('scene').map((o) => o.uuid),
			ownCacheKey: own?.material?.customProgramCacheKey?.() ?? null,
			otherCacheKey:
				group.getObjectByProperty('uuid', uuids[1])?.material?.customProgramCacheKey?.() ?? null
		};
	}, built.uuids);
	h.check(optOut.key === built.uuids[0], 'an object with its own graph resolves to itself: ' + optOut.key);
	h.check(
		!optOut.sceneTargets.includes(built.uuids[0]),
		'and the scene default stops claiming it (' + optOut.sceneTargets.length + ' targets left)'
	);
	h.check(
		optOut.ownCacheKey !== optOut.otherCacheKey,
		'its DIFFERENT injected code gets its own program key, so the cache cannot hand it the wrong program: ' +
			optOut.ownCacheKey + ' vs ' + optOut.otherCacheKey
	);

	// ---- 5. removing the scene graph puts everything back ------------------
	const cleared = await page.evaluate(async () => {
		const S = window.__stores.shaderGraph;
		S.setShaderGraphFor('scene', null);
		await S.compileAndApply('scene');
		await new Promise((r) => setTimeout(r, 400));
		return S.shaderDrivenCount();
	});
	h.check(
		cleared <= 1,
		'deleting the scene graph detaches every object it drove, leaving only the one with its own: ' + cleared
	);

	h.check(glsl.length === 0, 'no GLSL errors at ' + COUNT + ' objects: ' + JSON.stringify(glsl.slice(0, 2)));
	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
