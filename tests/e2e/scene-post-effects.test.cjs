// L5 — the built-in effect library: colour grading, camera FX and SMAA.
//
// Every one of these is wiring over an effect postprocessing already ships, so the
// question is never "is the shader right" but "does OUR chain actually put it on
// screen with the authored parameters". So each entry is measured as PIXELS, with a
// threshold appropriate to that effect: a vignette darkens a wide border (large
// count, modest delta) while pixelation rewrites nearly everything.
//
// The LUT gets far more attention than the rest put together, because it is the one
// with a second failure mode: the grade lives in an Explorer FILE, so a peer that
// has the stack but not the bytes must pull them and then actually apply them.

const h = require('./helpers.cjs');

/** a 2x2x2 .cube that maps every colour to pure red — maximally visible */
const RED_CUBE = ['TITLE "test-red"', 'LUT_3D_SIZE 2', ...Array(8).fill('1.0 0.0 0.0')].join('\n') + '\n';

/** the live stack */
const readStack = (page) =>
	page.evaluate(() => {
		let state = null;
		window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
		return state.effects.map((e) => ({ id: e.id, kind: e.kind, params: e.params }));
	});

/** Put ONE effect on the stack in `custom` mode and return its id. */
async function onlyEffect(page, kind, params) {
	return page.evaluate(
		async ({ kind, params }) => {
			const post = window.__stores.scenePost;
			post.scenePost.set({ enabled: true, effects: [], changedAt: Date.now() });
			const id = post.addPostEffect(kind);
			if (params) post.setPostEffectParams(id, params);
			window.__stores.viewMode.set('custom');
			await new Promise((r) => setTimeout(r, 1300));
			return id;
		},
		{ kind, params }
	);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the library is registered ===');

	const kinds = await page.evaluate(() =>
		window.__stores.scenePost.postEffectKinds().map((def) => def.kind + ':' + def.group)
	);
	const expected = [
		'ao:ao',
		'tonemapping:grading',
		'huesaturation:grading',
		'brightnesscontrast:grading',
		'lut:grading',
		'bloom:camera',
		'vignette:camera',
		'grain:camera',
		'chromaticaberration:camera',
		'pixelation:camera',
		'scanlines:camera',
		'dotscreen:stylize',
		'smaa:aa'
	];
	for (const want of expected)
		h.check(kinds.includes(want), '1.x ' + want + ' is registered in the right group');
	h.check(
		kinds.length === expected.length,
		'1.y the library is exactly these ' + expected.length + ' kinds (got ' + kinds.length + ')'
	);

	// ---------------------------------------------------------------- section 2
	// pixels, one effect at a time
	console.log('\n=== 2. every effect reaches the screen ===');

	await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		window.__stores.commandsHandler.sceneCommand('/create box');
		// nothing selected, so no outline pollutes a colour measurement
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
		await new Promise((r) => setTimeout(r, 2500));
	});
	const clip = await h.centeredClip(A, [0, 0, 0], 360);
	const overClip = await page.evaluate((rect) => {
		const el = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
		return el ? el.tagName : 'none';
	}, clip);
	h.check(overClip === 'CANVAS', '2.0 premise: the measured region is canvas (' + overClip + ')');
	const base = await h.grabFrame(A, clip);
	const spread = await h.framePixelsOffColor(page, base, [0, 0, 0], 10);
	h.check(
		spread.off > spread.total * 0.05,
		'2.0b premise: there is a rendered scene to affect (' + Math.round(spread.fraction * 100) + '% non-black)'
	);

	// each row: [kind, params, minimum changed pixels, minimum max-delta]
	// The thresholds differ per effect ON PURPOSE — a vignette is a wide, gentle
	// darkening while pixelation rewrites the frame, and one shared number would
	// either pass vacuously for the strong ones or fail the subtle ones.
	const CASES = [
		['huesaturation', { hue: 2.0, saturation: 0.8 }, 5000, 40],
		['brightnesscontrast', { brightness: 0.4, contrast: 0.5 }, 5000, 30],
		['tonemapping', { mode: 'REINHARD' }, 2000, 10],
		['bloom', { intensity: 4, luminanceThreshold: 0.05 }, 2000, 10],
		['vignette', { offset: 0.1, darkness: 1 }, 20000, 30],
		['grain', { opacity: 1 }, 20000, 20],
		['chromaticaberration', { offsetX: 0.015, offsetY: 0.015 }, 500, 20],
		['pixelation', { granularity: 40 }, 3000, 30],
		['scanlines', { density: 2, opacity: 1 }, 20000, 20],
		['dotscreen', { scale: 1, opacity: 1 }, 20000, 30],
		['smaa', { preset: 'ULTRA' }, 50, 5]
	];
	for (const [kind, params, minChanged, minMax] of CASES) {
		await onlyEffect(page, kind, params);
		const built = await page.evaluate(() => window.__postDebug());
		if (!built.kinds.includes(kind)) {
			h.check(false, '2.' + kind + ' PREMISE FAILED: the effect did not compile');
			continue;
		}
		const frame = await h.grabFrame(A, clip);
		const delta = await h.frameDelta(page, base, frame);
		h.check(
			delta.changed >= minChanged && delta.max >= minMax,
			'2.' +
				kind +
				' changes the frame: ' +
				delta.changed +
				' px (>=' +
				minChanged +
				'), max ' +
				delta.max +
				' (>=' +
				minMax +
				')'
		);
	}

	// ---------------------------------------------------------------- section 3
	// the merge, on the REAL library rather than test stubs
	console.log('\n=== 3. the merge over the real library ===');

	const merged = await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: Date.now() });
		for (const kind of [
			'huesaturation',
			'brightnesscontrast',
			'vignette',
			'grain',
			'chromaticaberration',
			'scanlines'
		])
			post.addPostEffect(kind);
		window.__stores.viewMode.set('custom');
		await new Promise((r) => setTimeout(r, 1600));
		return window.__postDebug();
	});
	h.check(
		merged.kinds.length === 6,
		'3.1 premise: all six grading/camera effects compiled (' + merged.kinds.length + ')'
	);
	h.check(
		merged.stackPasses === 1,
		'3.2 six real Effects cost ONE fullscreen pass, not six: ' + merged.stackPasses + ' — ' + JSON.stringify(merged.plan)
	);

	// where the AO Pass sits decides how many groups there are
	const split = await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		post.addPostEffect('ao', 3);
		await new Promise((r) => setTimeout(r, 1600));
		return window.__postDebug();
	});
	h.check(
		split.stackPasses === 3,
		'3.3 dropping the AO Pass into the middle splits it into three: ' + split.stackPasses
	);

	// SMAA is measured, not predicted: whether it merges is a property of the
	// library's own effect attributes, so record what it actually does.
	const withSmaa = await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: Date.now() });
		post.addPostEffect('huesaturation');
		post.addPostEffect('smaa');
		post.addPostEffect('vignette');
		await new Promise((r) => setTimeout(r, 1600));
		return window.__postDebug();
	});
	h.check(
		withSmaa.kinds.length === 3 && withSmaa.stackPasses >= 1,
		'3.4 SMAA compiles alongside the others (' +
			withSmaa.stackPasses +
			' pass(es): ' +
			JSON.stringify(withSmaa.plan) +
			')'
	);

	// ---------------------------------------------------------------- section 4
	// the LUT: an Explorer asset that has to travel
	console.log('\n=== 4. the LUT and its asset ===');

	const seeded = await page.evaluate(async (cube) => {
		const bytes = new TextEncoder().encode(cube);
		const item = await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'test-red.cube', null);
		return { hash: item?.hash ?? '', name: item?.name ?? '' };
	}, RED_CUBE);
	h.check(!!seeded.hash, '4.1 premise: a .cube landed in the Explorer (hash ' + seeded.hash.slice(0, 8) + ')');

	// drive the real UI picker, which is also what PUSHES the bytes
	await page.evaluate(async () => {
		const post = window.__stores.scenePost;
		post.scenePost.set({ enabled: true, effects: [], changedAt: Date.now() });
		post.addPostEffect('lut');
		window.__stores.viewMode.set('custom');
		window.__stores.inspectorKind.set('scene');
		window.__stores.inspectorClose.set(false);
		localStorage.setItem('inspector:sec:Post-processing', 'open');
		await new Promise((r) => setTimeout(r, 900));
	});
	let stack = await readStack(page);
	const lutId = stack[0].id;
	await page.evaluate(async (id) => {
		document.querySelector('#post-open-' + id)?.click();
		await new Promise((r) => setTimeout(r, 400));
	}, lutId);
	const pickerVisible = await page.evaluate(
		(id) => !!document.querySelector('#post-param-' + id + '-lut'),
		lutId
	);
	h.check(pickerVisible, '4.2 the LUT param renders an asset picker');

	const pushed = await page.evaluate(
		async ({ id, name }) => {
			// spy the wire PASS-THROUGH style so delivery and loss are not identical
			const peers = window.__stores.peers;
			let original = null;
			peers.subscribe((p) => (original = p))();
			const sent = [];
			peers.set({ ...original, send: (m) => sent.push(m) });
			document.querySelector('#post-param-' + id + '-lut').click();
			await new Promise((r) => setTimeout(r, 300));
			const rows = [...document.querySelectorAll('.ts-list [role="option"]')];
			const row = rows.find((r) => (r.textContent ?? '').includes(name));
			row?.click();
			await new Promise((r) => setTimeout(r, 1500));
			peers.set(original);
			return { picked: !!row, types: sent.map((m) => m.type) };
		},
		{ id: lutId, name: seeded.name }
	);
	h.check(pushed.picked, '4.3 the picker lists the .cube and it can be chosen');
	stack = await readStack(page);
	h.check(stack[0].params.lut === seeded.hash, '4.4 choosing it stores the content HASH, not a local id');
	h.check(
		pushed.types.includes('assetfile'),
		'4.5 assigning a LUT PUSHES its bytes to the mesh (golden rule 9): ' + JSON.stringify(pushed.types)
	);

	// and it actually grades: an all-red LUT is unmissable
	await page.waitForTimeout(1500);
	const lutFrame = await h.grabFrame(A, clip);
	const lutDelta = await h.frameDelta(page, base, lutFrame);
	h.check(
		lutDelta.changed > 20000 && lutDelta.max > 60,
		'4.6 the LUT is applied to the frame: ' + lutDelta.changed + ' px, max ' + lutDelta.max
	);

	// ---------------------------------------------------------------- section 5
	// a peer with the stack but NOT the bytes
	console.log('\n=== 5. a peer pulls the LUT it is missing ===');

	const B = await h.setupPage(browser, 'B');

	// ORDER IS LOAD-BEARING HERE. B goes into `custom` and takes its baseline frame
	// BEFORE the stack arrives, and its view mode is never touched again — because a
	// mode switch REBUILDS the chain, which re-runs `make`, which finds the file and
	// loads it regardless of any retry logic. Measured: with the library watch
	// removed, a version of this section that flipped B's view mode after the pull
	// still passed. The real scenario is a peer already watching the scene when the
	// look arrives, and nothing but the pull to prompt a second attempt.
	await B.page.evaluate(async () => {
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('custom');
		await new Promise((r) => setTimeout(r, 2000));
	});
	const clipB = await h.centeredClip(B, [0, 0, 0], 360);
	const bPlain = await h.grabFrame(B, clipB);

	await h.connect(B, A);

	// B must have received the stack, WITHOUT the file
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let state = null;
				window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
				return state.effects.map((e) => e.kind).join(',');
			}),
		(kinds) => kinds === 'lut',
		'5.1 B receives the LUT entry through the handshake',
		20000
	);
	// THE check: B asked for the bytes and got them. Without the library WATCH in
	// loadLutInto, B would sit on the neutral identity LUT forever — arriving bytes
	// do not change the stack, so nothing would rebuild the chain to retry.
	await h.eventually(
		() =>
			B.page.evaluate(
				(hash) => !!window.__stores.explorer.itemByHash(hash),
				seeded.hash
			),
		(has) => has === true,
		'5.2 B PULLS the LUT bytes it was missing (assetfile/getasset)',
		30000
	);

	// ...and APPLIES them, with no view-mode change to rebuild the chain for it.
	// This is the difference between "the bytes arrived" and "the grade happened":
	// arriving bytes do not alter the stack, so without the library watch in
	// loadLutInto this peer sits on the neutral identity LUT while its stack, its
	// Explorer and its pass count all look perfectly correct.
	const bPremise = await B.page.evaluate(() => {
		const debug = window.__postDebug();
		return { mode: (() => { let m = ''; window.__stores.viewMode.subscribe((v) => (m = v))(); return m; })(), kinds: debug.kinds };
	});
	h.check(
		bPremise.mode === 'custom' && bPremise.kinds.includes('lut'),
		'5.3 premise: B is still in `custom` with the LUT compiled, never re-switched (' + bPremise.mode + ')'
	);
	let bDelta = { changed: 0, max: 0 };
	for (let attempt = 0; attempt < 12; attempt++) {
		await B.page.waitForTimeout(1000);
		const bGraded = await h.grabFrame(B, clipB);
		bDelta = await h.frameDelta(B.page, bPlain, bGraded);
		if (bDelta.changed > 20000 && bDelta.max > 60) break;
	}
	h.check(
		bDelta.changed > 20000 && bDelta.max > 60,
		'5.3b B GRADES with the pulled LUT rather than the neutral fallback, without a rebuild: ' +
			bDelta.changed +
			' px, max ' +
			bDelta.max
	);

	h.check(
		h.pageErrors(A).concat(h.pageErrors(B)).filter((m) => /scenePost|postEffects|LUT/.test(m)).length === 0,
		'5.4 no page errors from the effect library'
	);

	await h.finish(browser);
});
