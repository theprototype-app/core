// L1/L2 — the scene POST-PROCESSING STACK.
//
// This is a PIXEL feature, so the assertions are pixel measurements: the
// screenshot -> back-into-the-page -> 2D-canvas -> RGBA helpers in helpers.cjs
// are the only way this repo has to read real composited output. The metric is
// the CHANGED PIXEL COUNT, not a mean — a mean is blind to a thin edge, which is
// exactly what the outline-ordering check turns on.
//
// Two checks carry their own proof:
//  - the MERGE rule computes its counterfactual in-test (drop a Pass into the
//    middle of a run of Effects and the run must split), so it cannot pass with
//    the merging ripped out;
//  - the OUTLINE ORDERING is measured, not asserted structurally: a flat-fill
//    effect repaints every scene pixel, so anything left over is what was
//    composited AFTER it. Move the stack behind the outlines and the count of
//    surviving outline pixels goes to zero.

const h = require('./helpers.cjs');

// a plain green fill, far from every outline colour, applied with BlendFunction.SET
// so it REPLACES the frame rather than blending into it
const FILL_RGB = [0, 255, 0];

/** Register the test effect kinds through the real registry seam. */
async function registerTestEffects(page) {
	return page.evaluate(() => {
		const { Effect, BlendFunction } = window.__stores.postprocessing;
		const shader = (body) =>
			'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { ' + body + ' }';
		// an Effect: merges with its neighbours
		window.__stores.scenePost.registerPostEffect('test-fill', {
			label: 'Test fill',
			group: 'test',
			make: () =>
				new Effect('TestFill', shader('outputColor = vec4(0.0, 1.0, 0.0, 1.0);'), {
					blendFunction: BlendFunction.SET
				})
		});
		// a second Effect, visually a no-op, purely to prove the merge
		window.__stores.scenePost.registerPostEffect('test-noop', {
			label: 'Test noop',
			group: 'test',
			make: () => new Effect('TestNoop', shader('outputColor = inputColor;'), { blendFunction: BlendFunction.SET })
		});
		return window.__stores.scenePost.postEffectKinds().map((def) => def.kind);
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	// the planner: pure, no GL, so the whole view-mode matrix is a table test
	console.log('\n=== 1. normalize + the view-mode matrix ===');

	const kinds = await registerTestEffects(page);
	h.check(kinds.includes('ao'), '1.1 the built-in AO kind is registered (postEffects.js)');
	h.check(
		kinds.includes('test-fill') && kinds.includes('test-noop'),
		'1.2 a kind can be registered through the public registry seam'
	);

	const normalized = await page.evaluate(() => {
		const { normalizeScenePost } = window.__stores.scenePost;
		// an old save with missing fields, a duplicate id, and an effect kind from a
		// NEWER peer that this build has never heard of
		const raw = {
			effects: [
				{ id: 'dup', kind: 'ao' },
				{ id: 'dup', kind: 'test-fill', enabled: false },
				{ id: 'x', kind: 'from-the-future', params: { mystery: 7 }, extraField: 'keep me' }
			]
		};
		const out = normalizeScenePost(raw);
		return {
			enabled: out.enabled,
			ids: out.effects.map((e) => e.id),
			kinds: out.effects.map((e) => e.kind),
			aoParams: out.effects[0].params,
			fillEnabled: out.effects[1].enabled,
			futureParams: out.effects[2].params,
			futureExtra: out.effects[2].extraField,
			changedAt: out.changedAt
		};
	});
	h.check(normalized.enabled === true, '1.3 `enabled` defaults to true on a save that omits it');
	h.check(
		normalized.ids[0] !== normalized.ids[1] && normalized.ids.length === 3,
		'1.4 a duplicate id is re-keyed (ids key the L3 {#each}, and a repeat THROWS)'
	);
	h.check(
		normalized.aoParams.aoRadius === 1.5 &&
			normalized.aoParams.intensity === 2.5 &&
			normalized.aoParams.distanceFalloff === 1.0,
		'1.5 a known kind gets its registry defaults filled in'
	);
	h.check(normalized.fillEnabled === false, '1.6 an explicit `enabled: false` survives normalize');
	// THE rule: we cannot render it, but deleting a peer's work is not an option
	h.check(
		normalized.kinds.includes('from-the-future') && normalized.futureParams.mystery === 7,
		'1.7 an UNKNOWN kind from a newer peer is preserved, params and all'
	);
	h.check(normalized.futureExtra === 'keep me', '1.8 unknown per-entry FIELDS survive too (the base record is spread)');
	h.check(normalized.changedAt === 0, '1.9 a stampless save normalizes to changedAt 0');

	const matrix = await page.evaluate(() => {
		const { effectivePostStack, normalizeScenePost } = window.__stores.scenePost;
		const stack = normalizeScenePost({
			enabled: true,
			effects: [
				{ id: 'a', kind: 'test-fill' },
				{ id: 'b', kind: 'ao' }
			]
		});
		const kindsOf = (options) => effectivePostStack({ stack, ...options }).map((e) => e.kind);
		return {
			shaded: kindsOf({ mode: 'shaded' }),
			shadedAo: effectivePostStack({ stack, mode: 'shaded-ao' }),
			wireframe: kindsOf({ mode: 'wireframe' }),
			custom: kindsOf({ mode: 'custom' }),
			customLocalOff: kindsOf({ mode: 'custom', localEnabled: false }),
			customStackOff: effectivePostStack({
				stack: normalizeScenePost({ enabled: false, effects: [{ id: 'a', kind: 'test-fill' }] }),
				mode: 'custom'
			}).map((e) => e.kind),
			customAoGated: kindsOf({ mode: 'custom', aoOk: false }),
			customNotWarm: kindsOf({ mode: 'custom', aoWarm: false }),
			// a disabled entry is skipped but a disabled AO is not the same thing as a gate
			customEntryOff: effectivePostStack({
				stack: normalizeScenePost({ effects: [{ id: 'a', kind: 'test-fill', enabled: false }, { id: 'b', kind: 'ao' }] }),
				mode: 'custom'
			}).map((e) => e.kind)
		};
	});
	h.check(matrix.shaded.length === 0, '1.10 `shaded` runs no stack passes at all');
	h.check(
		matrix.shadedAo.length === 1 &&
			matrix.shadedAo[0].kind === 'ao' &&
			matrix.shadedAo[0].params.aoRadius === 1.5 &&
			matrix.shadedAo[0].params.intensity === 2.5 &&
			matrix.shadedAo[0].params.distanceFalloff === 1.0,
		'1.11 `shaded-ao` runs ONLY the built-in AO, at the numbers Outline.svelte used to hardcode'
	);
	h.check(matrix.wireframe.length === 0, '1.12 `wireframe` skips the stack (a diagnostic view owning overrideMaterial)');
	h.check(
		matrix.custom.join(',') === 'test-fill,ao',
		'1.13 `custom` runs the scene stack IN STACK ORDER (the order is the user\'s, not the pipeline\'s)'
	);
	h.check(matrix.customLocalOff.length === 0, '1.14 the LOCAL kill switch empties the stack in `custom`');
	h.check(matrix.customStackOff.length === 0, '1.15 the scene-level `enabled: false` empties the stack');
	h.check(
		matrix.customAoGated.join(',') === 'test-fill' && matrix.customNotWarm.join(',') === 'test-fill',
		'1.16 the AO capability gate + warm-up drop only AO, leaving the rest of the stack'
	);
	h.check(matrix.customEntryOff.join(',') === 'ao', '1.17 a per-entry disable drops just that entry');

	// ---------------------------------------------------------------- section 2
	// the MERGE rule, with its counterfactual computed in-test
	console.log('\n=== 2. the Effect-merging rule (with counterfactual) ===');

	const merge = await page.evaluate(() => {
		const { planPostStack, normalizeScenePost } = window.__stores.scenePost;
		const plan = (list) => {
			const stack = normalizeScenePost({ effects: list.map((kind, i) => ({ id: 'e' + i, kind })) });
			const out = planPostStack(stack.effects);
			return {
				passCount: out.passCount,
				groups: out.groups.map((g) => g.type + ':' + g.entries.map((e) => e.kind).join('+')),
				skipped: out.skipped.map((e) => e.kind)
			};
		};
		return {
			// four consecutive Effects
			merged: plan(['test-noop', 'test-noop', 'test-fill', 'test-noop']),
			// THE COUNTERFACTUAL: the same four with a Pass dropped in the middle. If
			// merging were not happening, `merged` would already be 4 passes and this
			// number would be 5 — the gap between them is what proves the rule.
			split: plan(['test-noop', 'test-noop', 'ao', 'test-fill', 'test-noop']),
			// an unknown kind contributes no shader, so it must not break a run either
			withUnknown: plan(['test-noop', 'from-the-future', 'test-noop']),
			onlyPasses: plan(['ao', 'ao'])
		};
	});
	h.check(
		merge.merged.passCount === 1 && merge.merged.groups[0] === 'effects:test-noop+test-noop+test-fill+test-noop',
		'2.1 four consecutive Effects merge into ONE EffectPass'
	);
	h.check(
		merge.split.passCount === 3 &&
			merge.split.groups.join(' | ') === 'effects:test-noop+test-noop | pass:ao | effects:test-fill+test-noop',
		'2.2 counterfactual: a Pass in the middle SPLITS the run (1 -> 3, not 4 -> 5)'
	);
	h.check(
		merge.merged.passCount < merge.split.passCount && merge.split.passCount < 5,
		'2.3 the gap is real: merged(' + merge.merged.passCount + ') < split(' + merge.split.passCount + ') < unmerged(5)'
	);
	h.check(
		merge.withUnknown.passCount === 1 && merge.withUnknown.skipped.join(',') === 'from-the-future',
		'2.4 an unknown kind is SKIPPED and does not break the merge either side of it'
	);
	h.check(merge.onlyPasses.passCount === 2, '2.5 two Passes never merge with each other');

	// ---------------------------------------------------------------- section 3
	// the COMPILED chain in the live composer, and the ordering invariant
	console.log('\n=== 3. the compiled chain + outlines pinned last ===');

	h.check(
		await page.evaluate(() => typeof window.__postDebug === 'function'),
		'3.1 the __postDebug hook is published (debugStores)'
	);
	// AO deliberately skips the first composer frames (the boot-compile window)
	await h.eventually(
		() => page.evaluate(() => window.__postDebug().aoWarm),
		(warm) => warm === true,
		'3.2 the AO warm-up completes',
		20000
	);

	await page.evaluate(() => window.__stores.viewMode.set('shaded-ao'));
	await page.waitForTimeout(800);
	let chain = await page.evaluate(() => window.__postDebug());
	h.check(
		chain.chain.join(' -> ') === 'render -> stack:ao -> outline-locked -> outline-selected',
		'3.3 shaded-ao chain is render -> AO -> the two outlines (today\'s chain, unchanged)'
	);
	h.check(chain.outlinesLast === true, '3.4 the outline passes are the last two passes');

	await page.evaluate(() => window.__stores.viewMode.set('shaded'));
	await page.waitForTimeout(600);
	chain = await page.evaluate(() => window.__postDebug());
	h.check(
		chain.stackPasses === 0 && chain.chain.join(' -> ') === 'render -> outline-locked -> outline-selected',
		'3.5 `shaded` leaves render + the outlines only'
	);
	h.check(chain.outlinesLast === true, '3.6 ...and the outlines are still last with an empty stack');

	// author a stack: two Effects, an unknown kind, and AO
	await page.evaluate(() => {
		const post = window.__stores.scenePost;
		post.addPostEffect('test-noop');
		post.addPostEffect('test-noop');
		post.addPostEffect('ao');
		post.addPostEffect('test-noop');
	});
	await page.evaluate(() => window.__stores.viewMode.set('custom'));
	await page.waitForTimeout(900);
	chain = await page.evaluate(() => window.__postDebug());
	h.check(
		chain.chain.join(' -> ') ===
			'render -> stack:test-noop+test-noop -> stack:ao -> stack:test-noop -> outline-locked -> outline-selected',
		'3.7 `custom` compiles the authored stack with the merge applied: ' + chain.chain.join(' -> ')
	);
	h.check(
		chain.stackPasses === 3 && chain.kinds.length === 4,
		'3.8 four effects compile to THREE passes (the merge is real in the composer, not just the plan)'
	);
	// THE INVARIANT. Editor gizmos are not part of the authored look.
	h.check(chain.outlinesLast === true, '3.9 the outlines stay last with a four-entry stack between them and render');

	await page.evaluate(() => window.__stores.viewMode.set('wireframe'));
	await page.waitForTimeout(600);
	chain = await page.evaluate(() => window.__postDebug());
	h.check(
		chain.stackPasses === 0 && chain.outlinesLast === true,
		'3.10 wireframe drops every stack pass even with a stack authored'
	);

	// ---------------------------------------------------------------- section 4
	// PIXELS: does any of this reach the screen?
	console.log('\n=== 4. pixels ===');

	await page.evaluate(() => {
		// a fresh stack for the pixel work, and something to shade
		window.__stores.scenePost.scenePost.set({ enabled: true, effects: [], changedAt: 1 });
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.viewMode.set('shaded');
	});
	await page.waitForTimeout(2500);

	// Every colour metric below reads a chrome-free square centred on the box: the
	// Connect bar and the Controls HUD are composited over the canvas, so they
	// would land in an "is this pixel the fill colour" count and swamp the outline
	// this section is trying to measure.
	const clip = await h.centeredClip(A, [0, 0, 0], 360);
	const overClip = await page.evaluate(
		(rect) => {
			const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
			return element ? element.tagName + (element.id ? '#' + element.id : '') : 'none';
		},
		clip
	);
	h.check(overClip === 'CANVAS', '4.0 premise: the measured region is canvas, not chrome (found ' + overClip + ')');

	// PREMISE: the screenshot must actually capture rendered WebGL, or every
	// delta below is measuring an empty buffer and passes vacuously.
	const frameShaded = await h.grabFrame(A, clip);
	const frameShadedAgain = await h.grabFrame(A, clip);
	const stable = await h.frameDelta(page, frameShaded, frameShadedAgain);
	h.check(!stable.error && stable.total > 50000, '4.1 premise: a canvas frame decodes to real pixels (' + stable.total + ')');
	const spread = await h.framePixelsOffColor(page, frameShaded, [0, 0, 0], 10);
	h.check(
		spread.off > stable.total * 0.05,
		'4.2 premise: the frame is a rendered scene, not a blank buffer (' + Math.round(spread.fraction * 100) + '% non-black)'
	);

	await page.evaluate(() => window.__stores.viewMode.set('shaded-ao'));
	await page.waitForTimeout(1800);
	const frameAo = await h.grabFrame(A, clip);
	const aoDelta = await h.frameDelta(page, frameShaded, frameAo);
	// AO on a lone convex box is a small CONTACT BAND with a large delta — the
	// count alone would read as failure, which is why both metrics are asserted
	h.check(
		aoDelta.changed > 500 && aoDelta.max > 20,
		'4.3 AO changes the frame: ' + aoDelta.changed + ' px changed, max delta ' + aoDelta.max
	);

	// a full-frame effect through the stack in `custom`
	await page.evaluate(() => {
		window.__stores.scenePost.scenePost.set({ enabled: true, effects: [], changedAt: 2 });
		window.__stores.scenePost.addPostEffect('test-fill');
		window.__stores.viewMode.set('custom');
	});
	await page.waitForTimeout(1500);
	const frameFill = await h.grabFrame(A, clip);
	const fillDelta = await h.frameDelta(page, frameShaded, frameFill);
	h.check(
		fillDelta.fraction > 0.9,
		'4.4 a full-frame stack effect repaints the viewport (' + Math.round(fillDelta.fraction * 100) + '% of pixels)'
	);

	// CONTROL for the ordering metric: with nothing selected there is no outline,
	// so essentially every pixel must BE the fill colour. Without this control,
	// "some pixels are not the fill colour" could be measuring anything.
	//
	// The deselect is LOAD-BEARING: the creation paths populate the selection set
	// (15-K), so the box was still selected here and the "control" frame carried
	// the very outline it is supposed to be the baseline for — the two counts came
	// out identical and the check read as a broken feature.
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await h.eventually(
		() => page.evaluate(() => window.__outlineDebug().selected),
		(count) => count === 0,
		'4.5 premise: the control frame really has NO outline to draw',
		8000
	);
	await page.waitForTimeout(1000);
	const frameBare = await h.grabFrame(A, clip);
	const noSelection = await h.framePixelsOffColor(page, frameBare, FILL_RGB);
	h.check(
		noSelection.off < noSelection.total * 0.02,
		'4.5b control: nothing selected -> ' + noSelection.off + ' px survive the fill (of ' + noSelection.total + ')'
	);

	// THE ORDERING PROOF. Select the box so the selection outline renders, and
	// demand that it SURVIVES a stack effect that repaints every scene pixel.
	// Compile the stack after the outlines instead and this count goes to zero.
	const selected = await page.evaluate(() => {
		const group = window.__stores.objectsGroup;
		let uuid = '';
		group.subscribe((g) => (uuid = g?.children?.[0]?.uuid ?? ''))();
		window.__stores.objectActions.selectObject(uuid);
		return uuid;
	});
	await h.eventually(
		() => page.evaluate(() => window.__outlineDebug().selected),
		(count) => count > 0,
		'4.6 premise: the selection outline has meshes to draw',
		8000
	);
	await page.waitForTimeout(1200);
	const frameOutlined = await h.grabFrame(A, clip);
	const survived = await h.framePixelsOffColor(page, frameOutlined, FILL_RGB);
	h.check(
		survived.off > 300 && survived.off > noSelection.off * 3,
		'4.7 ORDERING: the selection outline survives a full-frame effect — ' +
			survived.off +
			' px vs ' +
			noSelection.off +
			' with nothing selected'
	);
	h.check(!!selected, '4.8 premise: an object was selected for 4.7');

	// ---------------------------------------------------------------- section 5
	// the 'custom' promotion rule
	console.log('\n=== 5. adopting `custom` when a scene arrives with a look ===');

	const adopt = await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		const viewMode = window.__stores.viewMode;
		const read = () => {
			let value = '';
			viewMode.subscribe((v) => (value = v))();
			return value;
		};
		// a viewer who has never PICKED a mode
		localStorage.removeItem('viewModeChosen');
		viewMode.set('shaded');
		post.scenePostRestore({ enabled: true, effects: [{ id: 'a', kind: 'test-fill' }], changedAt: 10 });
		const promoted = read();

		// a viewer who HAS picked: their choice must stand
		window.__stores.viewModeCtl.chooseViewMode('shaded');
		post.scenePostRestore({ enabled: true, effects: [{ id: 'b', kind: 'test-fill' }], changedAt: 11 });
		const respected = read();

		// wireframe is a diagnostic view someone is actively using
		localStorage.removeItem('viewModeChosen');
		viewMode.set('wireframe');
		post.scenePostRestore({ enabled: true, effects: [{ id: 'c', kind: 'test-fill' }], changedAt: 12 });
		const wireKept = read();

		// an EMPTY look is not a look
		localStorage.removeItem('viewModeChosen');
		viewMode.set('shaded');
		post.scenePostRestore({ enabled: true, effects: [], changedAt: 13 });
		const emptyKept = read();
		return { promoted, respected, wireKept, emptyKept };
	});
	h.check(adopt.promoted === 'custom', '5.1 a scene arriving with a look promotes an unchosen viewer to `custom`');
	h.check(adopt.respected === 'shaded', '5.2 a viewer who PICKED a mode is never overridden');
	h.check(adopt.wireKept === 'wireframe', '5.3 wireframe is never overridden (an active diagnostic view)');
	h.check(adopt.emptyKept === 'shaded', '5.4 an empty stack promotes nobody');

	h.check(
		h.pageErrors(A).filter((m) => /scenePost|postEffects|Outline/.test(m)).length === 0,
		'5.5 no page errors from the post stack'
	);

	await h.finish(browser);
});
