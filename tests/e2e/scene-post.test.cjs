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
		// read defensively: if a regression DROPS the unknown entry, these checks
		// must report a clean red rather than crashing the whole suite on an
		// undefined index and taking every later section down with it
		const at = (index) => out.effects[index] ?? {};
		return {
			enabled: out.enabled,
			ids: out.effects.map((e) => e.id),
			kinds: out.effects.map((e) => e.kind),
			aoParams: at(0).params ?? {},
			fillEnabled: at(1).enabled,
			futureParams: at(2).params ?? {},
			futureExtra: at(2).extraField,
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

	// ---------------------------------------------------------------- section 6
	// undo: ONE entry and ONE message per gesture
	console.log('\n=== 6. the `look` history kind ===');

	const undoResult = await page.evaluate(() => {
		const post = window.__stores.scenePost;
		const history = window.__stores.history;
		const peers = window.__stores.peers;
		// "did it broadcast?" through a capture stub — the public cloud is the
		// slowest, flakiest layer and a message COUNT needs neither peer
		let original = null;
		peers.subscribe((p) => (original = p))();
		const sent = [];
		peers.set({ ...original, send: (message) => sent.push(message) });
		try {
			post.scenePost.set({ enabled: true, effects: [], changedAt: 1 });
			const id = post.addPostEffect('ao');
			const intensity = () => {
				let value = -1;
				post.scenePost.subscribe((s) => (value = s.effects.find((e) => e.id === id)?.params?.intensity ?? -1))();
				return value;
			};

			// ONE discrete edit
			sent.length = 0;
			post.setPostEffectParams(id, { intensity: 5 });
			const discreteSends = sent.filter((m) => m.type === 'scenepost').length;
			const beforeGesture = intensity();

			// a GESTURE (a DragRow scrub): many store writes, one entry, one message
			sent.length = 0;
			post.beginLookGesture();
			for (let step = 0; step < 12; step++) post.setPostEffectParams(id, { intensity: 1 + step * 0.25 });
			const midGestureSends = sent.filter((m) => m.type === 'scenepost').length;
			post.endLookGesture();
			const gestureSends = sent.filter((m) => m.type === 'scenepost').length;
			const afterGesture = intensity();

			// assert one-undo as a PROPERTY, never as a stack depth: recordEntry's
			// LIMIT trim means a correct gesture can leave the depth unchanged
			sent.length = 0;
			history.undo();
			const afterUndo = intensity();
			const undoSends = sent.filter((m) => m.type === 'scenepost').length;
			// ...and a SECOND undo must skip past the whole drag to what came before
			// the discrete edit. Without this, "one undo reverts the drag" passes even
			// when every pointermove recorded its own entry, because the gesture's
			// entry still sits on top of them (measured: it does).
			history.undo();
			const afterSecondUndo = intensity();
			history.redo();
			history.redo();
			const afterRedo = intensity();
			return {
				discreteSends,
				beforeGesture,
				midGestureSends,
				gestureSends,
				afterGesture,
				afterUndo,
				afterSecondUndo,
				undoSends,
				afterRedo
			};
		} finally {
			peers.set(original);
		}
	});
	h.check(undoResult.discreteSends === 1, '6.1 a discrete edit broadcasts exactly once (' + undoResult.discreteSends + ')');
	h.check(
		undoResult.midGestureSends === 0,
		'6.2 a gesture puts NOTHING on the wire mid-drag (' + undoResult.midGestureSends + ' messages over 12 writes)'
	);
	h.check(undoResult.gestureSends === 1, '6.3 ...and exactly one on gesture end (' + undoResult.gestureSends + ')');
	h.check(
		Math.abs(undoResult.afterGesture - 3.75) < 1e-6,
		'6.4 premise: the drag really moved the value (' + undoResult.afterGesture + ')'
	);
	h.check(
		Math.abs(undoResult.afterUndo - undoResult.beforeGesture) < 1e-6,
		'6.5 ONE undo reverts the WHOLE drag: ' + undoResult.afterGesture + ' -> ' + undoResult.afterUndo
	);
	h.check(
		Math.abs(undoResult.afterSecondUndo - 2.5) < 1e-6,
		'6.6 a SECOND undo skips the whole drag to the AO default, not into it (' + undoResult.afterSecondUndo + ')'
	);
	h.check(undoResult.undoSends === 1, '6.7 an undo replicates, so peers follow it like any edit');
	h.check(
		Math.abs(undoResult.afterRedo - 3.75) < 1e-6,
		'6.8 redo re-applies the gesture (' + undoResult.afterRedo + ')'
	);

	// ---------------------------------------------------------------- section 7
	// replication: the handshake, live edits, latest-wins, and the unknown kind
	console.log('\n=== 7. two peers ===');

	// author BEFORE connecting, so B receives the stack through the HANDSHAKE —
	// which is the late-joiner path, exercised without a third browser context
	// (three pages is the practical ceiling on a loaded box)
	await page.evaluate(() => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: 1 });
		const id = post.addPostEffect('ao');
		post.setPostEffectParams(id, { intensity: 3.75, aoRadius: 2.25 });
	});
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const readStack = (peer) =>
		peer.page.evaluate(() => {
			let state = null;
			window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
			return {
				enabled: state.enabled,
				changedAt: state.changedAt,
				effects: state.effects.map((e) => ({ kind: e.kind, params: e.params, enabled: e.enabled }))
			};
		});

	await h.eventually(
		() => readStack(B),
		(stack) => stack.effects.length === 1 && Math.abs(stack.effects[0].params.intensity - 3.75) < 1e-6,
		'7.1 the handshake carries the authored stack to a joining peer, params and all',
		20000
	);
	let stackB = await readStack(B);
	h.check(
		stackB.effects[0].kind === 'ao' && Math.abs(stackB.effects[0].params.aoRadius - 2.25) < 1e-6,
		'7.2 ...every param, not just the first (aoRadius ' + stackB.effects[0]?.params?.aoRadius + ')'
	);

	// B RENDERS it: switching B to `custom` runs A's authored AO and the pixels move
	const clipB = await h.centeredClip(B, [0, 0, 0], 360);
	await B.page.evaluate(() => window.__stores.viewMode.set('shaded'));
	await B.page.waitForTimeout(1500);
	const bShaded = await h.grabFrame(B, clipB);
	await B.page.evaluate(() => window.__stores.viewMode.set('custom'));
	await B.page.waitForTimeout(1800);
	const bCustom = await h.grabFrame(B, clipB);
	const bDelta = await h.frameDelta(B.page, bShaded, bCustom);
	h.check(
		bDelta.changed > 300 && bDelta.max > 15,
		'7.3 B RENDERS the stack it received: ' + bDelta.changed + ' px changed, max delta ' + bDelta.max
	);

	// a live edit on A follows to B
	await page.evaluate(() => {
		const post = window.__stores.scenePost;
		let state = null;
		post.scenePost.subscribe((s) => (state = s))();
		post.setPostEffectParams(state.effects[0].id, { intensity: 7.5 });
	});
	await h.eventually(
		() => readStack(B),
		(stack) => Math.abs(stack.effects[0]?.params?.intensity - 7.5) < 1e-6,
		'7.4 a live param edit on A reaches B',
		15000
	);

	// AN UNKNOWN KIND, arriving from a peer on a newer build, must survive a round
	// trip THROUGH A'S EDITOR — this is the check that a spread-the-base-record
	// normalize buys, and the one a "drop what we cannot render" normalize fails
	await B.page.evaluate(() => {
		let peer = null;
		window.__stores.peers.subscribe((p) => (peer = p))();
		peer.send({
			type: 'scenepost',
			enabled: true,
			changedAt: Date.now() + 200,
			effects: [
				{ id: 'u1', kind: 'from-the-future', params: { mystery: 42 } },
				{ id: 'a1', kind: 'ao', params: { intensity: 2.5 } }
			]
		});
	});
	await h.eventually(
		() => readStack(A),
		(stack) => stack.effects.some((e) => e.kind === 'from-the-future'),
		'7.5 A keeps an effect kind it cannot render',
		15000
	);
	const skippedOnA = await page.evaluate(() => window.__postDebug());
	h.check(
		skippedOnA.skipped.includes('from-the-future') && skippedOnA.kinds.includes('ao'),
		'7.6 ...and SKIPS it at render time while still compiling the rest: skipped ' +
			JSON.stringify(skippedOnA.skipped) +
			' built ' +
			JSON.stringify(skippedOnA.kinds)
	);

	// now A edits the stack — the unknown entry must come back out on the wire
	await page.evaluate(() => window.__stores.scenePost.addPostEffect('test-noop'));
	await h.eventually(
		() => readStack(B),
		(stack) => stack.effects.some((e) => e.kind === 'from-the-future') && stack.effects.length === 3,
		'7.7 the unknown kind survives a round trip through A\'s editor and comes back to B',
		15000
	);
	stackB = await readStack(B);
	h.check(
		stackB.effects.find((e) => e.kind === 'from-the-future')?.params?.mystery === 42,
		'7.8 ...with its params intact'
	);

	// latest-wins: an older stamp is ignored, or two drifted peers swap forever
	const beforeStale = await readStack(A);
	await B.page.evaluate(() => {
		let peer = null;
		window.__stores.peers.subscribe((p) => (peer = p))();
		peer.send({ type: 'scenepost', enabled: true, changedAt: 1, effects: [] });
	});
	await page.waitForTimeout(3000);
	const afterStale = await readStack(A);
	h.check(
		afterStale.effects.length === beforeStale.effects.length && afterStale.changedAt === beforeStale.changedAt,
		'7.9 an OLDER changedAt is ignored (latest-wins, golden rule 7)'
	);

	// the explicit full-state request path
	const answered = await B.page.evaluate(async () => {
		let peer = null;
		window.__stores.peers.subscribe((p) => (peer = p))();
		window.__stores.scenePost.scenePost.set({ enabled: true, effects: [], changedAt: 1 });
		let id = '';
		window.__stores.peers.subscribe((p) => (id = p?.peer?.id))();
		peer.send({ type: 'getscenepost', sender: id });
		return true;
	});
	h.check(answered, '7.10 premise: B issued a getscenepost request');
	await h.eventually(
		() => readStack(B),
		(stack) => stack.effects.length === 3,
		'7.11 `getscenepost` is answered with the full stack (the explicit re-pull path)',
		15000
	);

	// ---------------------------------------------------------------- section 8
	// persistence: sessions/.tpscene and autosave across a real reload
	console.log('\n=== 8. persistence ===');

	const sessionRound = await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		const sessions = window.__stores.sessions;
		post.scenePost.set({ enabled: true, effects: [], changedAt: 5 });
		const id = post.addPostEffect('ao');
		post.setPostEffectParams(id, { intensity: 6.25 });
		post.addPostEffect('from-the-future'); // an unknown kind must be SAVED too
		const payload = sessions.buildSessionPayload('post-stack test');
		// wipe the live stack, then restore from the payload
		post.scenePost.set({ enabled: true, effects: [], changedAt: 6 });
		post.scenePostRestore(payload.post);
		let state = null;
		post.scenePost.subscribe((s) => (state = s))();
		return {
			payloadKinds: (payload.post?.effects ?? []).map((e) => e.kind),
			payloadIntensity: payload.post?.effects?.[0]?.params?.intensity,
			restoredKinds: state.effects.map((e) => e.kind),
			restoredIntensity: state.effects[0]?.params?.intensity
		};
	});
	h.check(
		sessionRound.payloadKinds.join(',') === 'ao,from-the-future' && sessionRound.payloadIntensity === 6.25,
		'8.1 a session payload carries the stack (.tpscene rides the same payload)'
	);
	h.check(
		sessionRound.restoredKinds.join(',') === 'ao,from-the-future' && sessionRound.restoredIntensity === 6.25,
		'8.2 a session restore brings it back, unknown kind included'
	);

	const emptyPayload = await page.evaluate(() => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: 7 });
		return window.__stores.sessions.buildSessionPayload('no look').post;
	});
	h.check(emptyPayload === null, '8.3 a scene with no look adds no field (an older build sees nothing new)');

	// AUTOSAVE across a real reload. "It still looks right" is not "it survived",
	// so assert the SHAPE: the exact kinds, and the params, off a restored snapshot.
	await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: 8 });
		const id = post.addPostEffect('ao');
		post.setPostEffectParams(id, { intensity: 4.5, aoRadius: 3.5 });
		post.addPostEffect('test-fill'); // becomes UNKNOWN after the reload
		// only sceneStore/appStore/flowStore are SPREAD into __stores; a lib's own
		// exports live under its module key
		window.__stores.autosave.autosaveEnabled.set(true);
		window.__stores.commandsHandler.sceneCommand('/create box');
		await window.__stores.autosave.saveNow();
	});
	await page.waitForTimeout(1200);
	await h.freshReload(A);
	await page.waitForTimeout(2500);
	const restored = await page.evaluate(async () => {
		// the restore is offered as a sticky prompt, never applied automatically
		let offer = null;
		window.__stores.autosave.restoreAvailable.subscribe((value) => (offer = value))();
		if (!offer) return { offered: false };
		await window.__stores.autosave.restoreSnapshot();
		let state = null;
		window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
		return {
			offered: true,
			kinds: state.effects.map((e) => e.kind),
			intensity: state.effects[0]?.params?.intensity,
			radius: state.effects[0]?.params?.aoRadius,
			enabled: state.enabled
		};
	});
	h.check(restored.offered === true, '8.4 premise: the autosave snapshot was offered after the reload');
	h.check(
		restored.kinds?.join(',') === 'ao,test-fill',
		'8.5 the stack survives a reload with its kinds and ORDER: ' + JSON.stringify(restored.kinds)
	);
	h.check(
		restored.intensity === 4.5 && restored.radius === 3.5,
		'8.6 ...and its params (intensity ' + restored.intensity + ', radius ' + restored.radius + ')'
	);
	// `test-fill` was registered by this suite in the OLD page, so after the reload
	// it is a genuinely unknown kind — the preservation rule again, this time across
	// persistence rather than across the wire. viewMode must be set explicitly:
	// `skipped` is only populated for the EFFECTIVE stack, which is empty in
	// `shaded`, so reading it in any other mode would report nothing skipped and
	// pass whatever happened.
	const afterReload = await page.evaluate(async () => {
		window.__stores.viewMode.set('custom');
		await new Promise((r) => setTimeout(r, 900));
		return window.__postDebug();
	});
	h.check(
		afterReload.skipped.includes('test-fill') && afterReload.kinds.includes('ao'),
		'8.7 an unknown kind is kept and SKIPPED while the rest of the restored stack builds: skipped ' +
			JSON.stringify(afterReload.skipped) +
			' built ' +
			JSON.stringify(afterReload.kinds)
	);
	const reRegistered = await page.evaluate(async () => {
		const { Effect, BlendFunction } = window.__stores.postprocessing;
		window.__stores.scenePost.registerPostEffect('test-fill', {
			label: 'Test fill',
			make: () =>
				new Effect(
					'TestFill',
					'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(0.0, 1.0, 0.0, 1.0); }',
					{ blendFunction: BlendFunction.SET }
				)
		});
		window.__stores.viewMode.set('custom');
		await new Promise((r) => setTimeout(r, 900));
		return window.__postDebug();
	});
	h.check(
		reRegistered.kinds.includes('test-fill') && !reRegistered.skipped.includes('test-fill'),
		'8.8 registering that kind afterwards makes the preserved entry render (the signature folds in registry state)'
	);

	h.check(
		h.pageErrors(A).concat(h.pageErrors(B)).filter((m) => /scenePost|postEffects|Outline/.test(m)).length === 0,
		'8.9 no page errors from the post stack on either peer'
	);

	await h.finish(browser);
});
