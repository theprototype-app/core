// Per-CAMERA looks: a post document keyed by a camera's uuid, composed on top of
// the scene's while you are looking through that camera.
//
// The point of the feature is "switch camera, the grade switches with it", so the
// checks drive the REAL switch (startCameraPreview, which is what the Set Active
// Camera node calls) and measure PIXELS, not just the store.

const h = require('./helpers.cjs');

const SCENE = 'scene';

/** register a visible test effect through the public registry seam */
async function registerFills(page) {
	return page.evaluate(() => {
		const { Effect, BlendFunction } = window.__stores.postprocessing;
		const fill = (name, rgb) =>
			new Effect(
				name,
				'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(' +
					rgb +
					', 1.0); }',
				{ blendFunction: BlendFunction.SET }
			);
		window.__stores.scenePost.registerPostEffect('fill-red', {
			label: 'Fill red',
			group: 'test',
			make: () => fill('FillRed', '1.0, 0.0, 0.0')
		});
		window.__stores.scenePost.registerPostEffect('fill-blue', {
			label: 'Fill blue',
			group: 'test',
			make: () => fill('FillBlue', '0.0, 0.0, 1.0')
		});
		return window.__stores.scenePost.postEffectKinds().map((d) => d.kind);
	});
}

const docs = (page) =>
	page.evaluate(() => {
		let map = null;
		window.__stores.scenePost.postStacks.subscribe((m) => (map = m))();
		return Object.fromEntries(
			Object.entries(map).map(([key, doc]) => [
				key,
				{ kinds: doc.effects.map((e) => e.kind), enabled: doc.enabled, mode: doc.mode ?? null }
			])
		);
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	const kinds = await registerFills(page);
	h.check(kinds.includes('fill-red') && kinds.includes('fill-blue'), '0.1 premise: two test effects registered');

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. keyed documents ===');

	const camUuid = await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		window.__stores.commandsHandler.sceneCommand('/create camera');
		await new Promise((r) => setTimeout(r, 1200));
		const cams = window.__stores.cameraObjects.listCameraObjects();
		return cams[0]?.uuid ?? '';
	});
	h.check(!!camUuid, '1.1 premise: a camera object exists (' + camUuid.slice(0, 8) + ')');

  const keyed = await page.evaluate(
		async ({ cam }) => {
			const post = window.__stores.scenePost;
			post.postStacks.set({});
			post.addPostEffect('fill-red'); // no key -> the scene document
			post.addPostEffect('fill-blue', undefined, cam); // keyed to the camera
			await new Promise((r) => setTimeout(r, 400));
			return true;
		},
		{ cam: camUuid }
	);
	h.check(keyed, '1.2 premise: one effect authored per document');
	let map = await docs(page);
	h.check(
		map[SCENE]?.kinds.join(',') === 'fill-red',
		'1.3 an unkeyed edit lands on the SCENE document (' + JSON.stringify(map[SCENE]?.kinds) + ')'
	);
	h.check(
		map[camUuid]?.kinds.join(',') === 'fill-blue',
		'1.4 a keyed edit lands on that CAMERA document only'
	);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. composition follows the camera you look through ===');

	const chainOf = () => page.evaluate(() => window.__postDebug().kinds);
	await page.evaluate(async () => {
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
		await new Promise((r) => setTimeout(r, 1200));
	});
	h.check(
		(await chainOf()).join(',') === 'fill-red',
		'2.1 the editor camera renders the SCENE look only'
	);

	const entered = await page.evaluate(
		async (cam) => {
			const ok = window.__stores.cameraPreview.startCameraPreview(cam);
			await new Promise((r) => setTimeout(r, 1600));
			return ok !== false;
		},
		camUuid
	);
	h.check(entered, '2.2 premise: the camera preview started (what Set Active Camera calls)');
	h.check(
		(await chainOf()).join(',') === 'fill-red,fill-blue',
		'2.3 looking THROUGH the camera composes its look after the scene\'s: ' + (await chainOf()).join(',')
	);

	// replace mode
	await page.evaluate(
		async (cam) => {
			window.__stores.scenePost.setCameraLookMode(cam, 'replace');
			await new Promise((r) => setTimeout(r, 1200));
		},
		camUuid
	);
	h.check(
		(await chainOf()).join(',') === 'fill-blue',
		'2.4 `replace` drops the scene look for that camera: ' + (await chainOf()).join(',')
	);
	await page.evaluate(
		async (cam) => {
			window.__stores.scenePost.setCameraLookMode(cam, 'append');
			await new Promise((r) => setTimeout(r, 1200));
		},
		camUuid
	);
	h.check((await chainOf()).join(',') === 'fill-red,fill-blue', '2.5 back to `append`');

	// PIXELS: the grade really changes when you switch
	const clip = await h.centeredClip(A, [0, 0, 0], 300);
	const framePreview = await h.grabFrame(A, clip);
	await page.evaluate(async () => {
		window.__stores.cameraPreview.stopCameraPreview();
		await new Promise((r) => setTimeout(r, 1600));
	});
	h.check(
		(await chainOf()).join(',') === 'fill-red',
		'2.6 leaving the camera drops its look again'
	);
	const frameEditor = await h.grabFrame(A, clip);
	const delta = await h.frameDelta(page, framePreview, frameEditor);
	h.check(
		delta.changed > 20000 && delta.max > 60,
		'2.7 PIXELS: the frame really regrades on the switch — ' + delta.changed + ' px, max ' + delta.max
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. undo, persistence, replication ===');

	const undo2 = await page.evaluate(
		async (cam) => {
			const post = window.__stores.scenePost;
			const read = () => {
				let m = null;
				post.postStacks.subscribe((x) => (m = x))();
				return m;
			};
			const sceneBefore = read()['scene'].effects.length;
			post.addPostEffect('fill-blue', undefined, cam);
			const camAfter = read()[cam].effects.length;
			window.__stores.history.undo();
			await new Promise((r) => setTimeout(r, 400));
			const after = read();
			return {
				sceneBefore,
				camAfter,
				camAfterUndo: after[cam].effects.length,
				sceneAfterUndo: after['scene'].effects.length
			};
		},
		camUuid
	);
	h.check(
		undo2.camAfter === undo2.camAfterUndo + 1,
		'3.1 undo reverts the CAMERA document it was recorded against (' + undo2.camAfter + ' -> ' + undo2.camAfterUndo + ')'
	);
	h.check(
		undo2.sceneAfterUndo === undo2.sceneBefore,
		'3.2 ...and leaves the scene document alone (the key rides the history entry)'
	);

	// persistence: both documents survive a session round trip
	const session = await page.evaluate(async (cam) => {
		const post = window.__stores.scenePost;
		const payload = window.__stores.sessions.buildSessionPayload('camera looks');
		post.postStacks.set({});
		post.scenePostRestore(payload.post);
		await new Promise((r) => setTimeout(r, 300));
		let m = null;
		post.postStacks.subscribe((x) => (m = x))();
		return {
			savedKeys: Object.keys(payload.post?.stacks ?? {}).sort(),
			legacyTop: (payload.post?.effects ?? []).map((e) => e.kind),
			restored: Object.keys(m).sort(),
			cameraKinds: (m[cam]?.effects ?? []).map((e) => e.kind)
		};
	}, camUuid);
	h.check(
		session.savedKeys.includes('scene') && session.savedKeys.includes(camUuid),
		'3.3 a session saves BOTH documents: ' + JSON.stringify(session.savedKeys.map((k) => k.slice(0, 8)))
	);
	h.check(
		session.legacyTop.join(',') === 'fill-red',
		'3.4 ...with the SCENE document still at the top level, so an older build reads it (' + session.legacyTop + ')'
	);
	h.check(
		session.restored.includes(camUuid) && session.cameraKinds.length > 0,
		'3.5 a restore brings the camera document back'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. two peers ===');

	const B = await h.setupPage(browser, 'B');
	await registerFills(B.page);
	await h.connect(B, A);

	await h.eventually(
		() => docs(B.page),
		(m) => m[camUuid]?.kinds?.length > 0 && m[SCENE]?.kinds?.length > 0,
		'4.1 the handshake carries BOTH documents to a joiner',
		25000
	);
	const bMap = await docs(B.page);
	h.check(
		bMap[SCENE].kinds.includes('fill-red') && bMap[camUuid].kinds.includes('fill-blue'),
		'4.2 ...each with its own effects: ' + JSON.stringify(bMap[camUuid].kinds)
	);

	// a live camera-document edit reaches B and does not touch its scene document
	await page.evaluate((cam) => window.__stores.scenePost.setCameraLookMode(cam, 'replace'), camUuid);
	await h.eventually(
		() => docs(B.page),
		(m) => m[camUuid]?.mode === 'replace',
		'4.3 a live edit to a camera document replicates',
		15000
	);
	h.check(
		(await docs(B.page))[SCENE].kinds.join(',') === 'fill-red',
		'4.4 ...without disturbing the scene document'
	);

	// B renders the camera look when B looks through that camera
	const bChain = await B.page.evaluate(
		async (cam) => {
			window.__stores.objectActions.deselectObject();
			window.__stores.viewMode.set('shaded');
			await new Promise((r) => setTimeout(r, 800));
			const before = window.__postDebug().kinds;
			window.__stores.cameraPreview.startCameraPreview(cam);
			await new Promise((r) => setTimeout(r, 1800));
			return { before, after: window.__postDebug().kinds };
		},
		camUuid
	);
	h.check(
		bChain.before.join(',') === 'fill-red' && bChain.after.join(',') === 'fill-blue',
		'4.5 B gets the camera look too, on ITS own switch: ' +
			bChain.before.join(',') +
			' -> ' +
			bChain.after.join(',')
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. the Set Look node ===');

	// The node is a TRIGGER action, like Set Active Camera: it flips a per-peer runtime
	// OVERRIDE rather than editing the authored document, so a game can turn a look on
	// without that ending up in what the next edit broadcasts.
	const nodeRun = await page.evaluate(async (cam) => {
		const post = window.__stores.scenePost;
		const read = () => window.__postDebug().kinds;
		const docEnabled = () => {
			let m = null;
			post.postStacks.subscribe((x) => (m = x))();
			return m[cam].enabled;
		};
		post.clearLookOverride(cam);
		post.setCameraLookMode(cam, 'append');
		window.__stores.cameraPreview.startCameraPreview(cam);
		await new Promise((r) => setTimeout(r, 1600));
		const on = read();
		post.setLookOverride(cam, false);
		await new Promise((r) => setTimeout(r, 1200));
		const off = read();
		const docStillOn = docEnabled();
		post.setLookOverride(cam, true);
		await new Promise((r) => setTimeout(r, 1200));
		const backOn = read();
		post.clearLookOverride(cam);
		await new Promise((r) => setTimeout(r, 1000));
		return { on, off, backOn, docStillOn, cleared: read() };
	}, camUuid);
	h.check(nodeRun.on.join(',') === 'fill-red,fill-blue', '5.1 premise: the camera look is rendering');
	h.check(
		nodeRun.off.join(',') === 'fill-red',
		'5.2 the override switches that look off and leaves the scene look: ' + nodeRun.off.join(',')
	);
	h.check(
		nodeRun.docStillOn === true,
		'5.3 ...WITHOUT touching the authored document — a runtime state never becomes authored state'
	);
	h.check(nodeRun.backOn.join(',') === 'fill-red,fill-blue', '5.4 and back on again');
	h.check(nodeRun.cleared.join(',') === 'fill-red,fill-blue', '5.5 clearing hands the document back its own say');

	// the node is REGISTERED, and drives the same seam the runtime calls
	const nodeDef = await page.evaluate(() => {
		const groups = window.__stores.nodeCatalog.nodeCatalog ?? [];
		const all = groups.flatMap((g) => g.items ?? []);
		const def = all.find((n) => n.type === 'setlook');
		return { found: !!def, defaults: def?.defaults ?? null };
	});
	h.check(nodeDef.found, '5.6 the Set Look node is in the catalog: ' + JSON.stringify(nodeDef.defaults));

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. the node renders as a real card ===');

	// It was added to nodeCatalog (so the palette offered it) but NOT to
	// Nodes.svelte's CORE_NODE_TYPES, whose fallback is UnknownNode — so a node dragged
	// out of the CORE palette announced "This node comes from a module that isn't
	// installed". The whole-catalog version of this guard lives in `flow-unknown-node`,
	// which is the suite about that map; this is just the node this branch added.
	// The dock is opened through the REAL opener, not a store.
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1400);
	const lookCard = await page.evaluate(() => {
		const hook = window.__flowNodeTypes;
		if (!hook) return { hook: false };
		return { hook: true, renderable: hook.live().includes('setlook'), unknown: hook.unknown().includes('setlook') };
	});
	h.check(lookCard.hook === true, '6.1 premise: the Flow pane mounted and published its type map');
	h.check(
		lookCard.renderable === true && lookCard.unknown === false,
		'6.2 Set Look resolves to a real card, NOT a missing-module node'
	);

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. the reported scenario: two keys, two camera looks ===');

	// THE BUG REPORT, as a test. "Key Press R -> Set Look (Object Selector -> camera A),
	// Key Press U -> Set Look (Object Selector -> camera B), press play, hit R/U —
	// nothing happens." The nodes fired perfectly; nothing changed because a camera look
	// only composes while its camera is the ACTIVE one, and in play mode nothing was.
	// `activate` (default on) is the fix, so this section drives the WHOLE chain through
	// real key presses and asserts the picture actually changes.
	const scenario = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 900));
		const cams = s.cameraObjects.listCameraObjects();
		const c1 = cams[0].uuid;
		const c2 = cams[cams.length - 1].uuid;
		if (c1 === c2) return { distinct: false };

		const post = s.scenePost;
		post.postStacks.set({});
		post.addPostEffect('fill-red'); // the scene look
		post.addPostEffect('fill-blue', undefined, c1);
		post.addPostEffect('fill-blue', undefined, c2);
		post.setCameraLookMode(c1, 'replace');
		post.setCameraLookMode(c2, 'replace');
		s.cameraPreview.stopCameraPreview();
		s.objectActions.deselectObject();

		s.updateGraph(s.SCENE_GRAPH, () => ({
			nodes: [
				{ id: 'kR', type: 'keypress', position: { x: 0, y: 0 }, data: { type: 'keypress', label: 'Key Press', code: 'KeyR', pulse: 0.3 } },
				{ id: 'kU', type: 'keypress', position: { x: 0, y: 120 }, data: { type: 'keypress', label: 'Key Press', code: 'KeyU', pulse: 0.3 } },
				{ id: 'oR', type: 'objectselector', position: { x: 0, y: 240 }, data: { type: 'objectselector', label: 'Object Selector', selected: c1 } },
				{ id: 'oU', type: 'objectselector', position: { x: 0, y: 360 }, data: { type: 'objectselector', label: 'Object Selector', selected: c2 } },
				{ id: 'sR', type: 'setlook', position: { x: 300, y: 0 }, data: { type: 'setlook', label: 'Set Look', camera: '', on: true, activate: true } },
				{ id: 'sU', type: 'setlook', position: { x: 300, y: 200 }, data: { type: 'setlook', label: 'Set Look', camera: '', on: true, activate: true } }
			],
			edges: [
				{ id: 'e1', source: 'kR', target: 'sR', targetHandle: 'trigger' },
				{ id: 'e2', source: 'oR', target: 'sR', targetHandle: 'camera' },
				{ id: 'e3', source: 'kU', target: 'sU', targetHandle: 'trigger' },
				{ id: 'e4', source: 'oU', target: 'sU', targetHandle: 'camera' }
			]
		}));
		await new Promise((r) => setTimeout(r, 1400));
		return { distinct: true, c1, c2, chain: window.__postDebug().kinds };
	});
	h.check(scenario.distinct === true, '7.1 premise: two distinct cameras to switch between');
	h.check(
		scenario.chain.join(',') === 'fill-red',
		'7.2 premise: before any key, the editor view shows the SCENE look (' + scenario.chain.join(',') + ')'
	);

	const through = () =>
		page.evaluate(() => {
			let p = null;
			window.__stores.cameraPreview.cameraPreview.subscribe((x) => (p = x))();
			return { uuid: p?.uuid ?? null, chain: window.__postDebug().kinds };
		});

	// press play, then the keys — exactly the reported sequence
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(900);
	await page.keyboard.press('r');
	await page.waitForTimeout(1800);
	const afterR = await through();
	h.check(
		afterR.uuid === scenario.c1,
		'7.3 R looks through the first camera (' + String(afterR.uuid).slice(0, 8) + ')'
	);
	h.check(
		afterR.chain.join(',') === 'fill-blue',
		'7.4 ...and ITS look is what renders, replacing the scene look: ' + afterR.chain.join(',')
	);

	await page.keyboard.press('u');
	await page.waitForTimeout(1800);
	const afterU = await through();
	h.check(
		afterU.uuid === scenario.c2 && afterU.uuid !== afterR.uuid,
		'7.5 U switches to the OTHER camera (' + String(afterU.uuid).slice(0, 8) + ')'
	);

	// and the silent case still explains itself rather than doing nothing quietly
	const silent = await page.evaluate(async (c1) => {
		const s = window.__stores;
		s.cameraPreview.stopCameraPreview();
		s.updateGraph(s.SCENE_GRAPH, (g) => ({
			...g,
			nodes: g.nodes.map((n) =>
				n.id === 'sR' ? { ...n, data: { ...n.data, activate: false } } : n
			)
		}));
		await new Promise((r) => setTimeout(r, 900));
		let before = null;
		s.toastStore.subscribe((t) => (before = t.length))();
		return { before };
	}, scenario.c1);
	await page.keyboard.press('r');
	await page.waitForTimeout(1500);
	const explained = await page.evaluate(() => {
		let list = [];
		window.__stores.toastStore.subscribe((t) => (list = t))();
		return {
			said: list.some((t) => /looking through that camera/i.test(typeof t === 'string' ? t : (t?.text ?? ''))),
			chain: window.__postDebug().kinds
		};
	});
	h.check(
		explained.chain.join(',') === 'fill-red',
		'7.6 premise: with "look through it too" off and no active camera, the picture is unchanged'
	);
	h.check(
		explained.said === true,
		'7.7 ...and the node EXPLAINS that instead of failing silently (the reported experience)'
	);

	h.check(
		h.pageErrors(A).concat(h.pageErrors(B)).filter((m) => /scenePost|postEffects/.test(m)).length === 0,
		'4.6 no page errors'
	);

	await h.finish(browser);
});
