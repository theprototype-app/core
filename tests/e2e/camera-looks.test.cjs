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

	h.check(
		h.pageErrors(A).concat(h.pageErrors(B)).filter((m) => /scenePost|postEffects/.test(m)).length === 0,
		'4.6 no page errors'
	);

	await h.finish(browser);
});
