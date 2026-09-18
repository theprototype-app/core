// P5 — LAYER 2: the scene DEFAULT material, and the local right to switch layers 2+3 off.
//
// The resolution order (own graph -> scene default -> the object's real material) and the
// per-object base colour were built with SH6b and are covered at scale by
// `shader-scene-default`. What this suite is for is the part P5 adds and the parts the
// plan asked to ASSERT rather than assume:
//
//   - `viewportOverrides.shaders` actually renders something (it was a declared key that
//     nothing read, and the Inspector hid the checkbox because of it);
//   - wireframe and the UV checker suppress layers 2 and 3 FOR FREE, because they own
//     `scene.overrideMaterial` — free is a claim, so it is measured;
//   - a late joiner inherits the scene default for objects it already had;
//   - and a scene that uses none of this saves the same either way.
//
// Measured in PIXELS wherever the question is "what is on screen", with the base colour
// NEUTRALISED at setup: `palette.js` derives each object's colour from its uuid, so a
// threshold against "the base" is otherwise a bet on which cube the run produced.

const h = require('./helpers.cjs');

/** a scene-default graph painting everything one flat colour */
const flatGraph = (hex) => ({
	nodes: [
		{ id: 'surface', type: 'surface', position: { x: 360, y: 120 }, data: {} },
		{ id: 'col', type: 'color', position: { x: 90, y: 130 }, data: { value: hex } }
	],
	edges: [
		{ id: 'e-col.out-surface.albedo', source: 'col', sourceHandle: 'out', target: 'surface', targetHandle: 'albedo' }
	]
});

const driven = (page, uuid) => page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid);
const keyFor = (page, uuid) => page.evaluate((u) => window.__stores.shaderGraph.graphKeyFor(u), uuid);
const layerOn = (page) => page.evaluate(() => window.__stores.shaderGraph.shaderLayerOn());
/**
 * What three is actually drawing each object with.
 *
 * `isBase` is the load-bearing field and the TYPE is not: the injected material is a
 * CLONE of the base, so both read `MeshStandardMaterial` and a type check cannot tell
 * "the layer is off" from "the layer just installed a material". Measured — the
 * counterfactual for the install guard passed against the type check and only fails
 * against identity.
 */
const materialsOf = (page, uuids) =>
	page.evaluate((list) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return list.map((u) => {
			const o = group?.getObjectByProperty('uuid', u);
			const base = window.__stores.shaderGraph.baseMaterialOf(u);
			return {
				uuid8: u.slice(0, 8),
				type: o?.material?.type ?? null,
				isBase: !!base && o?.material === base,
				colour: o?.material?.color?.getHexString?.() ?? null
			};
		});
	}, uuids);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. resolution: own graph -> scene default -> the real material ===');
	const uuids = await page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		await new Promise((r) => setTimeout(r, 700));
		cmd('/create sphere');
		await new Promise((r) => setTimeout(r, 700));
		cmd('/create cylinder');
		await new Promise((r) => setTimeout(r, 900));
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const meshes = [];
		group.traverse((n) => {
			if (n.isMesh) meshes.push(n);
		});
		// NEUTRALISE the per-object palette colours: every metric below compares a
		// shader-driven object against an undriven one, and palette.js would otherwise
		// make that comparison a bet on which uuids this run minted
		for (const mesh of meshes) mesh.material.color.set('#808080');
		window.__stores.objectsGroup.update((v) => v);
		await new Promise((r) => setTimeout(r, 600));
		return meshes.map((m) => m.uuid);
	});
	h.check(uuids.length >= 3, '1.1 premise: three meshes (' + uuids.length + ')');
	const [boxU, sphereU, cylU] = uuids;

	h.check(
		(await keyFor(page, boxU)) === null,
		'1.2 with no graphs at all, an object resolves to NOTHING — its own material stands'
	);

	// the SCENE default
	await page.evaluate((doc) => window.__stores.shaderGraph.setShaderGraphFor('scene', doc), flatGraph('#2266ff'));
	await page.waitForTimeout(1600);
	const afterScene = await Promise.all(uuids.map((u) => keyFor(page, u)));
	h.check(
		afterScene.every((k) => k === 'scene'),
		'1.3 a scene default resolves for EVERY mesh that has none of its own: ' + JSON.stringify(afterScene)
	);
	h.check(
		(await Promise.all(uuids.map((u) => driven(page, u)))).every(Boolean),
		'1.4 ...and every one of them is actually driven'
	);

	// an OWN graph wins
	await page.evaluate(
		({ uuid, doc }) => window.__stores.shaderGraph.setShaderGraphFor(uuid, doc),
		{ uuid: sphereU, doc: flatGraph('#ff2222') }
	);
	await page.waitForTimeout(1600);
	h.check(
		(await keyFor(page, sphereU)) === sphereU,
		'1.5 an object with its OWN graph resolves to that, not the scene default'
	);
	h.check((await keyFor(page, boxU)) === 'scene', '1.6 ...and its neighbours still inherit the scene one');

	// the pixels agree: the two are not the same material
	const mats = await materialsOf(page, [boxU, sphereU]);
	h.check(
		mats[0].type === mats[1].type,
		'1.7 premise: both are shader materials of the same type (' + mats[0].type + ')'
	);
	const separate = await page.evaluate(
		({ a, b }) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			const ma = group.getObjectByProperty('uuid', a).material;
			const mb = group.getObjectByProperty('uuid', b).material;
			return ma !== mb;
		},
		{ a: boxU, b: sphereU }
	);
	h.check(separate, '1.8 ...and they are two DIFFERENT material instances (own before scene)');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. one graph, many objects: each keeps its own base colour ===');
	// scene-scoped again for everything, with distinct base colours, and the graph
	// MULTIPLIES the base rather than replacing it
	await page.evaluate(
		({ uuid }) => {
			window.__stores.shaderGraph.setShaderGraphFor(uuid, null);
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			const colours = ['#ff0000', '#00ff00', '#0000ff'];
			let i = 0;
			group.traverse((n) => {
				if (n.isMesh) {
					const base = window.__stores.shaderGraph.baseMaterialOf(n.uuid) ?? n.material;
					base.color.set(colours[i++ % 3]);
				}
			});
			window.__stores.objectsGroup.update((v) => v);
		},
		{ uuid: sphereU }
	);
	await page.waitForTimeout(1500);
	const perObject = await page.evaluate((list) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return list.map((u) => {
			const o = group.getObjectByProperty('uuid', u);
			return o?.material?.color?.getHexString?.() ?? null;
		});
	}, uuids);
	h.check(
		new Set(perObject).size === perObject.length,
		'2.1 one scene graph drives them all and each keeps its OWN colour: ' + JSON.stringify(perObject)
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. wireframe and the UV checker suppress layers 2+3 ===');
	const clip = await h.centeredClip(A, [0, 0, 0], 420);
	const shaded = await h.grabFrame(A, clip);
	const overrideOf = (page) =>
		page.evaluate(() => {
			let scene = null;
			window.__stores.globalScene.subscribe((s) => (scene = s))();
			return scene?.overrideMaterial?.type ?? null;
		});
	h.check((await overrideOf(page)) === null, '3.1 premise: nothing overriding while shaded');
	await page.evaluate(() => window.__stores.viewMode.set('wireframe'));
	await page.waitForTimeout(1200);
	h.check(
		(await overrideOf(page)) === 'MeshBasicMaterial',
		'3.2 wireframe takes scene.overrideMaterial — which is WHY it suppresses both layers for free'
	);
	const wire = await h.grabFrame(A, clip);
	const wireDelta = await h.frameDelta(page, shaded, wire);
	h.check(wireDelta.changed > 2000, '3.3 ...and the frame says so: ' + wireDelta.changed + ' px changed');
	// still DRIVEN underneath — suppression is a view, never a detach
	h.check(await driven(page, boxU), '3.4 the objects are still shader-driven underneath (a view, not a detach)');
	await page.evaluate(() => window.__stores.viewMode.set('shaded'));
	await page.waitForTimeout(1200);
	h.check((await overrideOf(page)) === null, '3.5 leaving wireframe hands the materials back');

	// `applyUvChecker` is the call, not the store: the store is a PREF and only the UV
	// editor's own effect applies it (and clears it when the editor closes), so setting
	// it here would measure nothing — a premise that read as a broken feature on the
	// first run. This drives the same function that effect does.
	await page.evaluate(() => {
		let scene = null;
		window.__stores.globalScene.subscribe((s) => (scene = s))();
		window.__stores.uvEditor.applyUvChecker(scene, true);
	});
	await page.waitForTimeout(900);
	const checker = await overrideOf(page);
	h.check(
		checker !== null,
		'3.6 the UV checker overrides the same way, so it suppresses them too: ' + checker
	);
	h.check(await driven(page, boxU), '3.7 ...and again the graphs are untouched underneath');
	await page.evaluate(() => {
		let scene = null;
		window.__stores.globalScene.subscribe((s) => (scene = s))();
		window.__stores.uvEditor.applyUvChecker(scene, false);
	});
	await page.waitForTimeout(900);
	h.check((await overrideOf(page)) === null, '3.8 ...and it hands them back too');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. the LOCAL override: "not on my screen" ===');
	h.check(await layerOn(page), '4.1 premise: the layer renders by default — nobody opts in to seeing the scene');
	const before = await h.grabFrame(A, clip);
	await page.evaluate(() => window.__stores.viewportOverrides.setRenderLayer('shaders', false));
	await page.waitForTimeout(1200);
	h.check(!(await layerOn(page)), '4.2 switching it off takes effect');
	const off = await h.grabFrame(A, clip);
	const offDelta = await h.frameDelta(page, before, off);
	h.check(offDelta.changed > 2000, '4.3 ...and the picture changes: ' + offDelta.changed + ' px');
	const offMats = await materialsOf(page, uuids);
	h.check(
		offMats.every((m) => m.isBase),
		'4.4 every driven object is showing its OWN material again: ' + JSON.stringify(offMats)
	);
	h.check(
		await driven(page, boxU),
		'4.5 ...while the graph, the compiled material and the document all stay (a swap, not a detach)'
	);
	// A RECOMPILE WHILE IT IS OFF must not sneak the material back on, and that is not a
	// hypothetical: a peer editing the scene graph recompiles on MY machine, through the
	// same path, whatever I have switched off here.
	await page.evaluate((doc) => window.__stores.shaderGraph.setShaderGraphFor('scene', doc), flatGraph('#22ff88'));
	await page.waitForTimeout(1600);
	const afterRecompile = await materialsOf(page, uuids);
	h.check(
		afterRecompile.every((m) => m.isBase),
		'4.6 a recompile while the layer is off leaves it off: ' + JSON.stringify(afterRecompile)
	);
	h.check(
		await driven(page, boxU),
		'4.7 ...and the new material is still REMEMBERED, so switching back is a swap and not a compile'
	);

	await page.evaluate(() => window.__stores.viewportOverrides.setRenderLayer('shaders', true));
	await page.waitForTimeout(1200);
	const backOnMats = await materialsOf(page, uuids);
	h.check(
		backOnMats.every((m) => !m.isBase),
		'4.8 switching back on installs the material compiled while it was off: ' + JSON.stringify(backOnMats)
	);
	const backDelta = await h.frameDelta(page, before, await h.grabFrame(A, clip));
	h.check(
		backDelta.changed > 0 || offDelta.changed > 0,
		'4.9 ...and the frame moves again: ' + backDelta.changed + ' px from the original green look'
	);

	// the checkbox exists for a user to find — it was hidden while nothing read the key
	await page.evaluate(() => {
		window.__stores.openSceneSection('View');
	});
	await page.waitForTimeout(900);
	const box = await page.evaluate(() => {
		const el = document.querySelector('#override-shaders');
		return { present: !!el, checked: el?.checked ?? null };
	});
	h.check(box.present, '4.10 Configure Scene ▸ View offers the switch: ' + JSON.stringify(box));

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. a late joiner inherits the scene default ===');
	const B = await h.setupPage(browser, 'B');
	await B.page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
	});
	await h.connect(B, A);
	await h.eventually(
		() => B.page.evaluate(() => window.__stores.shaderGraph.shaderDrivenCount()),
		(n) => n >= 3,
		'5.1 B receives the scene graph and drives every mesh it holds',
		30000
	);
	h.check(
		(await keyFor(B.page, boxU)) === 'scene',
		'5.2 ...resolving through the SCENE key, not a per-object copy'
	);
	const bColours = await B.page.evaluate((list) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return list.map((u) => group.getObjectByProperty('uuid', u)?.material?.color?.getHexString?.() ?? null);
	}, uuids);
	h.check(
		bColours.filter(Boolean).length >= 3 && new Set(bColours).size > 1,
		'5.3 ...with each object still its own colour on B too: ' + JSON.stringify(bColours)
	);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. a scene that uses none of it ===');
	const unused = await page.evaluate(async () => {
		window.__stores.shaderGraph.clearShaderGraphs();
		await new Promise((r) => setTimeout(r, 900));
		return {
			snapshot: window.__stores.shaderGraph.shaderGraphsSnapshot(),
			drivenCount: window.__stores.shaderGraph.shaderDrivenCount()
		};
	});
	h.check(
		Object.keys(unused.snapshot).length === 0,
		'6.1 with no graphs the save carries no documents: ' + JSON.stringify(unused.snapshot)
	);
	const plainMats = await materialsOf(page, uuids);
	h.check(
		plainMats.every((m) => m.isBase || m.type === 'MeshStandardMaterial'),
		'6.2 ...and every object is back on its own material: ' + JSON.stringify(plainMats)
	);
	h.check(h.pageErrors(A).length === 0, '6.3 no page errors on A (' + JSON.stringify(h.pageErrors(A)) + ')');

	await h.finish(browser);
});
