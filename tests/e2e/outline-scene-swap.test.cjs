// The selection outline must not ride into a saved scene.
//
// REPORTED: load a project, open a scene, select an object, open a second scene — its
// object "becomes selected" for no reason — then open a third, and an outline of the
// second scene's object hangs in the viewport as a ghost while you navigate around.
//
// THE MECHANISM, and why no store read can see it. postprocessing's `Selection` marks a
// selected object by ENABLING A RENDER LAYER on it; THREE's `toJSON` writes the layer
// mask and `ObjectLoader` restores it, so a scene SAVED WHILE SOMETHING WAS SELECTED
// bakes the outline layer into the file (measured in the reporter's own project:
// `layers: 5` = bits 0 and 2, where 2 is the selection pass's layer). The object comes
// back wearing the layer while sitting in NOBODY's selection — unreachable state, since
// `Selection.clear()` only disables the layer on its own members. So it is outlined
// without being selected ("Box becomes selected"), and because the OutlineEffect
// re-renders its target only while its set is non-empty PLUS one `forceUpdate` frame
// after it empties, that clearing frame draws the tainted object and then freezes. The
// frozen SCREEN-SPACE image is blended into every later frame: it survives deselecting,
// a whole scene replace, and the camera moving.
//
// Every selection store reads correct throughout — `selectedObjects` is empty, and
// `__outlineDebug().selected` is 0 — which is exactly why this suite asserts the LAYER
// OCCUPANCY (the mechanism) and the PIXELS (the symptom), and not the stores.
const h = require('./helpers.cjs');

// where each fixture scene puts its single object. B's spot is where the ghost appears.
const AT_A = [0, 1, 0];
const AT_B = [-5, 1, -5];
const AT_C = [5, 1, 3];

h.run(async () => {
	// GPU args: the outline is a composited pass, so the frame has to be real.
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const p = A.page;

	const quiet = () => p.evaluate(() => window.__stores.toasts?.set([]));

	/** every object in the scene that wears an outline pass's render layer */
	const tainted = () =>
		p.evaluate(() => {
			const S = window.__stores;
			const rd = (s) => { let v; s.subscribe((x) => (v = x))(); return v; };
			const layers = S.editOverlays.outlineLayerList();
			const out = [];
			rd(S.objectsGroup)?.traverse((n) => {
				if (!n?.layers) return;
				const on = layers.filter((L) => n.layers.isEnabled(L));
				if (on.length) out.push({ name: n.name || n.type, on });
			});
			return { layers, out };
		});

	const state = () =>
		p.evaluate(() => {
			const S = window.__stores;
			const rd = (s) => { let v; s.subscribe((x) => (v = x))(); return v; };
			return {
				outline: window.__outlineDebug?.() ?? null,
				selected: rd(S.selectedObjects).length,
				children: rd(S.objectsGroup)?.children.map((c) => c.name) ?? []
			};
		});

	const makeScene = (kind, at, name) =>
		p.evaluate(async ([kind, at, name]) => {
			const S = window.__stores;
			S.commandsHandler.sceneCommand('/clear all');
			await new Promise((r) => setTimeout(r, 350));
			S.commandsHandler.sceneCommand('/create ' + kind);
			// `/create` re-seats the object after the call returns — let it settle before moving it
			await new Promise((r) => setTimeout(r, 700));
			let g; S.objectsGroup.subscribe((v) => (g = v))();
			const object = g.children[0];
			object.position.set(at[0], at[1], at[2]);
			// a dynamic body would fall the moment anything simulates; park it
			object.userData.physics = { ...(object.userData.physics ?? {}), mode: 'static' };
			object.updateMatrixWorld(true);
			S.objectsGroup.update((v) => v);
			// SAVED WHILE SELECTED, deliberately — that is what the reporter did, and it is
			// the only state that can bake the layer into the file. Four of the seven scenes
			// in their project carry it. A fixture that deselects first would be clean
			// whatever this code does, and every check below it would pass vacuously.
			S.objectActions.selectObject(object.uuid);
			await new Promise((r) => setTimeout(r, 500));
			const item = await S.levels.saveSceneAsLevel(name);
			await new Promise((r) => setTimeout(r, 500));
			return item?.hash ?? null;
		}, [kind, at, name]);

	const travel = (hash) =>
		p.evaluate(async ([hash]) => {
			await window.__stores.levels.travelToLevel(hash, '');
			await new Promise((r) => setTimeout(r, 1200));
		}, [hash]);

	const selectFirst = () =>
		p.evaluate(async () => {
			const S = window.__stores;
			let g; S.objectsGroup.subscribe((v) => (g = v))();
			S.objectActions.selectObject(g.children[0].uuid);
			await new Promise((r) => setTimeout(r, 700));
		});

	// ---- fixture: a project of three scenes ---------------------------------
	const hashA = await makeScene('sphere', AT_A, 'OutlineA');
	const hashB = await makeScene('box', AT_B, 'OutlineB');
	const hashC = await makeScene('Cylinder', AT_C, 'OutlineC');
	h.check(!!hashA && !!hashB && !!hashC, 'premise: three fixture scenes saved into the library');
	const layers = (await tainted()).layers;
	h.check(
		layers.length === 2 && layers.every((L) => Number.isInteger(L) && L > 0),
		'premise: Outline.svelte published its two selection layers (' + layers.join(',') + ')'
	);

	// ---- 1. the PARK half: a save taken while something is selected ----------
	await travel(hashA);
	await selectFirst();
	const live = await tainted();
	h.check(
		live.out.length === 1 && live.out[0].name === 'Sphere',
		'premise: a genuinely selected object DOES wear the outline layer while selected'
	);
	const written = await p.evaluate(async () => {
		const S = window.__stores;
		const payload = S.sessions.buildSessionPayload('parked');
		return (payload.objects ?? []).map((o) => ({ name: o.object?.name, layers: o.object?.layers }));
	});
	h.check(written.length === 1, 'premise: the payload holds the one selected object');
	h.check(
		written.every((o) => (o.layers & ((1 << layers[0]) | (1 << layers[1]))) === 0),
		'park: a scene saved while an object is selected writes no outline layer (layers=' +
			written.map((o) => o.layers).join(',') + ')'
	);
	const stillLive = await tainted();
	h.check(
		stillLive.out.length === 1,
		'park restores the mask verbatim — the selection keeps its outline across a save'
	);

	// ---- 2. the STRIP half: a file that ALREADY carries the taint ------------
	// New saves are clean now, so the only way to cover the heal is to craft the tainted
	// payload the reporter's project actually contains.
	//
	// THE SELECTION MUST BE EMPTY FIRST, and the first version of this check was vacuous
	// for want of it: `clearSceneLocal` does not clear `selectedObjects`, and a re-saved
	// scene keeps its uuids — so the stale uuid still matched the reloaded object, the
	// outline adopted it as a real selection member, and the following deselect took the
	// layer off through the legitimate path. It passed with the strip removed.
	const healed = await p.evaluate(async ([layers]) => {
		const S = window.__stores;
		S.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 700));
		const payload = JSON.parse(JSON.stringify(S.sessions.buildSessionPayload('tainted')));
		const bit = 1 << layers[0];
		for (const entry of payload.objects) entry.object.layers = (entry.object.layers | bit) >>> 0;
		const before = payload.objects.map((o) => o.object.layers);
		await S.sessions.applySession(payload, { backup: false, replicate: false, game: false, workspace: false });
		await new Promise((r) => setTimeout(r, 1100));
		let sel; S.selectedObjects.subscribe((v) => (sel = v))();
		let g; S.objectsGroup.subscribe((v) => (g = v))();
		return { before, selected: sel.length, after: g.children.map((c) => c.layers.mask) };
	}, [layers]);
	h.check(
		healed.selected === 0,
		'premise: nothing is selected, so only the strip can clear the layer (' + healed.selected + ' selected)'
	);
	h.check(
		healed.before.every((m) => (m & (1 << layers[0])) !== 0),
		'premise: the crafted payload really carries the outline layer (' + healed.before.join(',') + ')'
	);
	h.check(
		healed.after.every((m) => (m & (1 << layers[0])) === 0),
		'strip: loading a tainted scene clears the outline layer (' + healed.after.join(',') + ')'
	);

	// ---- 3. the reported sequence -------------------------------------------
	await travel(hashA);
	await selectFirst();
	h.check((await state()).outline.selected === 1, 'premise: scene A object is outlined while selected');

	await travel(hashB);
	const atB = await tainted();
	const stateB = await state();
	h.check(stateB.children.length === 1 && stateB.children[0] === 'Box', 'premise: scene B is open');
	h.check(
		atB.out.length === 0,
		"opening the next scene does not leave its object outlined (the reported 'Box becomes selected'): " +
			JSON.stringify(atB.out)
	);
	h.check(stateB.outline.selected === 0, 'the outline pass holds nothing after the swap');

	await travel(hashC);
	const atC = await tainted();
	h.check(atC.out.length === 0, 'a third scene open leaves nothing wearing the outline layer');

	// ---- 4. THE PIXELS ------------------------------------------------------
	// The stores read correct in both worlds — that IS the bug — so the guard has to be a
	// frame. It is deliberately NOT "run the same sequence without selecting and diff the
	// two": a control RUN can be ghosted itself (the taint is in the FILE, so merely
	// opening scene A with a stale target already frozen reproduces it), and a control
	// that carries the same ghost as the subject passes while the bug is present.
	//
	// So the question is asked directly instead: IS WHAT IS ON SCREEN STALE? Forcing the
	// outline to re-render its target flushes anything frozen there. An honest frame does
	// not move; a ghosted one loses the ghost. Measured on the reporter's own project:
	// 65585 px before the fix, 0 after.
	await p.evaluate(() => {
		const P = window.__stores.postprocessing;
		const original = P.OutlineEffect.prototype.update;
		P.OutlineEffect.prototype.update = function (renderer, input, delta) {
			if (window.__forceOutline) this.forceUpdate = true;
			return original.call(this, renderer, input, delta);
		};
	});
	const clipAt = await h.centeredClip(A, AT_B, 360);
	await quiet();
	await p.waitForTimeout(800);
	const asRendered = await h.grabFrame(A, clipAt);
	await p.evaluate(async () => {
		window.__forceOutline = true;
		await new Promise((r) => setTimeout(r, 900));
	});
	const refreshed = await h.grabFrame(A, clipAt);
	await p.evaluate(async () => {
		window.__forceOutline = false;
		await new Promise((r) => setTimeout(r, 400));
	});

	const delta = await h.frameDelta(p, asRendered, refreshed);
	h.check(!delta.error, 'premise: the two frames are comparable (' + (delta.error ?? 'ok') + ')');
	h.check(
		delta.changed < 200,
		'PIXELS: nothing stale is being composited where scene B\'s object stood — forcing the ' +
			'outline to re-render changes the frame by ' + delta.changed + ' px'
	);

	// ---- 5. the outline still WORKS -----------------------------------------
	await selectFirst();
	const on = await Promise.all([tainted(), state()]);
	h.check(on[1].outline.selected > 0, 'the selection outline still renders after the fix');
	h.check(on[0].out.length === 1, 'the selected object wears the outline layer');
	await p.evaluate(async () => {
		window.__stores.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 700));
	});
	const off = await Promise.all([tainted(), state()]);
	h.check(off[1].outline.selected === 0, 'deselect clears the outline pass');
	h.check(off[0].out.length === 0, 'deselect takes the layer back off the object');

	// ---- 6. a clone must not inherit it -------------------------------------
	// `clone()` copies the layer mask, so duplicating a SELECTED object handed the copy a
	// layer nothing would ever clear — the same ghost by another route.
	const dup = await p.evaluate(async () => {
		const S = window.__stores;
		let g; S.objectsGroup.subscribe((v) => (g = v))();
		const source = g.children[0];
		S.objectActions.selectObject(source.uuid);
		await new Promise((r) => setTimeout(r, 600));
		S.objectActions.duplicateSelection?.() ?? S.objectActions.duplicateObject?.(source.uuid);
		await new Promise((r) => setTimeout(r, 900));
		S.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 700));
		S.objectsGroup.subscribe((v) => (g = v))();
		return g.children.map((c) => ({ name: c.name, mask: c.layers.mask }));
	});
	h.check(dup.length > 1, 'premise: duplicating a selected object produced a copy (' + dup.length + ')');
	const bits = (1 << layers[0]) | (1 << layers[1]);
	h.check(
		dup.every((c) => (c.mask & bits) === 0),
		'a duplicate of a selected object carries no outline layer (' +
			dup.map((c) => c.mask).join(',') + ')'
	);

	await h.finish(browser);
});
