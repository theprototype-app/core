// 21-A A8 — the post stack renders in PLAY mode.
//
// Until now <Outline /> lived inside Scene.svelte's `{#if !$isLocked &&
// !$isVRMode}` block, so entering play mode threw the scene's authored look away
// along with the outlines — for a game, the one mode where the look matters most.
//
// This is a PIXEL feature, so the assertions are pixel measurements through the
// helpers: screenshot in node, push the PNG back into the page, decode on a 2D
// canvas, compare IN the page. The metric is the CHANGED PIXEL COUNT, never a
// mean: a mean is blind to a thin edge, and it is also blind to a strong effect
// over a small object.
//
// palette.js derives an object's colour from its uuid, so a threshold measured
// against "the base" is a bet on which cube the run produced. The fixture paints
// the object explicitly before measuring anything.

const h = require('./helpers.cjs');

const FILL_RGB = [0, 255, 0];

/** a flat-fill test effect through the real registry seam */
async function registerFill(page) {
	return page.evaluate(() => {
		const { Effect, BlendFunction } = window.__stores.postprocessing;
		window.__stores.scenePost.registerPostEffect('test-play-fill', {
			label: 'Play fill',
			group: 'test',
			make: () =>
				new Effect(
					'PlayFill',
					'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(0.0, 1.0, 0.0, 1.0); }',
					{ blendFunction: BlendFunction.SET }
				)
		});
		return window.__stores.scenePost
			.postEffectKinds()
			.map((def) => def.kind)
			.includes('test-play-fill');
	});
}

const postDebug = (page) => page.evaluate(() => window.__postDebug?.() ?? null);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// one neutral-grey box, so no measurement depends on the palette's uuid colour
	await page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const box = group.children[group.children.length - 1];
		box.position.set(0, 1, 0);
		box.scale.set(3, 3, 3);
		box.material.color.setHex(0x808080);
		window.__stores.objectsGroup.update((v) => v);
	});
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(1200);

	const registered = await registerFill(page);
	h.check(registered, '1.1 (premise) the test effect is registered through the real seam');

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the composer mounts at all in play mode ===');

	const editorDebug = await postDebug(page);
	h.check(!!editorDebug, '1.2 (premise) the composer is live in the editor');

	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(1200);
	const playDebug = await postDebug(page);
	h.check(
		!!playDebug,
		'1.3 the composer is STILL mounted in play mode (it used to unmount with the gizmo)'
	);
	h.check(
		playDebug?.outlinesLast === true,
		'1.4 ...with the chain intact — the outline passes still present last'
	);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. an authored look reaches the play-mode frame ===');

	const before = await h.grabFrame(A);
	// enable the stack FIRST, then add: both writes go through the same latest-wins
	// singleton, and issuing them back to back in one tick lets the enable land on a
	// copy taken before the add (measured: 0 compiled passes, effects list empty)
	await page.evaluate(() => window.__stores.scenePost.setScenePostEnabled(true));
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.scenePost.addPostEffect('test-play-fill'));
	await page.waitForTimeout(1500);
	const after = await h.grabFrame(A);
	const delta = await h.frameDelta(page, before, after);
	h.check(
		!delta.error && delta.changed > 10000,
		'2.1 the scene look repaints the play-mode frame (' +
			(delta.changed ?? -1) +
			' changed pixels)'
	);
	const off = await h.framePixelsOffColor(page, after, FILL_RGB);
	h.check(
		off.fraction < 0.02,
		'2.2 ...and it is the effect that painted it (' +
			off.off +
			' pixels off the fill colour of ' +
			off.total +
			')'
	);
	const withStack = await postDebug(page);
	h.check(
		(withStack?.stackPasses ?? 0) > 0,
		'2.3 (premise) the stack really compiled a pass (' + withStack?.stackPasses + ')'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. the editor outlines stand down while playing ===');

	// select the box: in the EDITOR that outlines it, in play mode it must not
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.evaluate(() => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		window.__stores.objectActions.selectObject(group.children[group.children.length - 1].uuid);
	});
	await page.waitForTimeout(900);
	const selectedInEditor = await postDebug(page);
	h.check(
		(selectedInEditor?.outlinedSelected ?? 0) > 0,
		'3.1 (premise) the editor outlines the selection (' + selectedInEditor?.outlinedSelected + ' meshes)'
	);

	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(900);
	const selectedInPlay = await postDebug(page);
	h.check(
		(selectedInPlay?.outlinedSelected ?? -1) === 0,
		'3.2 play mode stands the selection outline down — it is editor information, ' +
			'and glare over the thing you are playing with (' +
			selectedInPlay?.outlinedSelected +
			')'
	);
	h.check(
		(selectedInPlay?.outlinedLocked ?? -1) === 0,
		'3.3 ...and the peer-lock outline with it'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. nothing to compose = no composer ===');

	await page.evaluate(() => {
		const state = window.__stores.scenePost.scenePostDebug();
		for (const entry of state.effects) window.__stores.scenePost.removePostEffect(entry.id);
	});
	// plain 'shaded' so the personal AO pass is not in the chain either
	await page.evaluate(() => window.__stores.viewMode.set('shaded'));
	await page.waitForTimeout(1200);
	const empty = await postDebug(page);
	h.check(
		(empty?.stackPasses ?? -1) === 0 && (empty?.outlinedSelected ?? -1) === 0,
		'4.1 (premise) play mode with no look and no outlines has nothing to composite (' +
			JSON.stringify({ stack: empty?.stackPasses, sel: empty?.outlinedSelected }) +
			')'
	);
	// it must still be RENDERING — the direct path has to draw the same picture
	const frame = await h.grabFrame(A);
	const black = (await h.framePixelsOffColor(page, frame, [0, 0, 0], 12)).off;
	h.check(
		black > 5000,
		'4.2 ...and the viewport still draws the scene through the direct path (' +
			black +
			' non-black pixels)'
	);

	// and putting the look back brings the composer back
	await page.evaluate(() => window.__stores.scenePost.addPostEffect('test-play-fill'));
	await page.waitForTimeout(1200);
	const restored = await h.grabFrame(A);
	const restoredOff = await h.framePixelsOffColor(page, restored, FILL_RGB);
	h.check(
		restoredOff.fraction < 0.02,
		'4.3 re-adding the effect brings the composer back in the same mode (' +
			restoredOff.off +
			' pixels off the fill)'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. VR stays direct-render behind an opt-in ===');

	const vrFlag = await page.evaluate(() => {
		let value = null;
		window.__stores.viewportOverrides.vrPostEnabled.subscribe((v) => (value = v))();
		return value;
	});
	h.check(
		vrFlag === false,
		'5.1 the VR post flag ships OFF — the composer targets canvas-sized buffers, ' +
			'not the XR framebuffer, and a headset gets a dark viewport'
	);
	const persisted = await page.evaluate(() => {
		window.__stores.viewportOverrides.vrPostEnabled.set(true);
		return localStorage.getItem('vrPostEnabled');
	});
	h.check(persisted === 'true', '5.2 ...and it is a LOCAL pref, like every other override');
	await page.evaluate(() => window.__stores.viewportOverrides.vrPostEnabled.set(false));

	await page.evaluate(() => window.__stores.isLocked.set(false));
	await h.finish(browser);
});
