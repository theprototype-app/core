// 101 F3 + F5 — THE RENDERER SEAM AND THE TEST FACADE, in a real page.
//
//   1. the facade: `window.__tp.test.v1` answers what `__stores` answers (same objects), is
//      read-only, lists `v1`, and `h.t(page)` reaches it from the runner;
//   2. the seam made the main renderer: threlte's renderer IS `renderSeam.mainRenderer()`, with
//      threlte's own defaults (antialias, alpha, high-performance) and PCF shadows;
//   3. the shared thumbnail renderer: one WebGL context for every thumbnail, released after idle;
//   4. DISPOSE AND RECREATE: `recycleMainRenderer()` releases everything the seam made, loses the
//      main context on purpose and restores it — the path roadmap 100's switch runs — and the next
//      frame is the SAME frame (pixel diff against the frame before; the before/before pair is the
//      noise floor), GPU memory counts not above +5 % (a leak bound), no "3D view has
//      stopped" overlay, and the JS heap not above +5 %.
//   3b. L1a GUARD: the real main renderer's compileAsync shimmed to three r186 WebGPU's shape (opens
//      scene.onBeforeRender, never closes it). Raw, lod.js's bracket depth is stuck at 1 between
//      frames (the counterfactual: frozen LOD); through `renderSeam.compileAsync` it is back to 0.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: [...h.GPU_ARGS, '--js-flags=--expose-gc'] });
	const A = await h.setupPage(browser, 'A');
	const p = A.page;
	const T = h.t(p);
	await T.ready();

	// ---- 1. the facade ------------------------------------------------------------------
	const facade = await p.evaluate(() => {
		const w = /** @type {any} */ (window);
		const t = w.__tp.test.v1;
		let threw = '';
		try {
			t.isLocked = 1;
		} catch (e) {
			threw = String(/** @type {any} */ (e).message);
		}
		return {
			versions: w.__tp.test.versions,
			same: t.isLocked === w.__tp.test.v1.isLocked && t.history === w.__tp.test.v1.history && t.renderSeam === w.__tp.test.v1.renderSeam,
			keys: Object.keys(t).length,
			storeKeys: Object.keys(w.__tp?.test.v1).length,
			frozenRoot: Object.isFrozen(w.__tp) && Object.isFrozen(w.__tp.test),
			threw
		};
	});
	h.check(facade.versions?.includes('v1'), `__tp.test lists v1 (${JSON.stringify(facade.versions)})`);
	h.check(facade.same, 'the facade hands out the very objects __stores does (an alias, not a copy)');
	h.check(facade.keys >= facade.storeKeys && facade.storeKeys > 400, `the facade lists every hook (${facade.keys} >= ${facade.storeKeys})`);
	h.check(facade.frozenRoot && /read-only/.test(facade.threw), `read-only: a write throws (${facade.threw})`);
	h.check((await T.get('isLocked')) === (await p.evaluate(() => { let v; /** @type {any} */ (window).__tp.test.v1.isLocked.subscribe((/** @type {any} */ x) => (v = x))(); return v; })), 'h.t(page).get reads a store through the facade');
	h.check((await T.run((t) => typeof t.renderSeam.disposeRenderer)) === 'function', 'h.t(page).run hands the facade to page code');

	// ---- 2. the seam made the main renderer ------------------------------------------------
	const main = await T.run((t) => {
		let r;
		t.globalRenderer.subscribe((/** @type {any} */ x) => (r = x))();
		const gl = r.getContext();
		const attrs = gl.getContextAttributes();
		return {
			same: r === t.renderSeam.mainRenderer(),
			antialias: attrs.antialias,
			alpha: attrs.alpha,
			power: attrs.powerPreference,
			pcf: r.shadowMap.type === 1, // THREE.PCFShadowMap
			webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
		};
	});
	h.check(main.same, 'threlte draws with the renderer the seam made (createMainRenderer)');
	h.check(main.antialias && main.alpha && main.power === 'high-performance' && main.webgl2, `threlte's defaults, verbatim (${JSON.stringify(main)})`);
	h.check(main.pcf, 'PCF shadows (MAIN_SHADOW_MAP)');

	// ---- 3. one shared thumbnail renderer ------------------------------------------------------
	const shared = await T.run((t) => {
		const S = t.renderSeam;
		const made0 = S.offscreenState().made;
		const sizes = [];
		for (let i = 0; i < 3; i++) sizes.push(S.renderOffscreen(64 + i, 48, (/** @type {any} */ r) => r.domElement.width + 'x' + r.domElement.height));
		return { made: S.offscreenState().made - made0, alive: S.offscreenState().alive, sizes };
	});
	h.check(shared.made <= 1 && shared.alive && shared.sizes.join() === '64x48,65x48,66x48', `three thumbnails, one renderer (${JSON.stringify(shared)})`);

	// ---- 3b. L1a: an unclosed compile bracket is closed by the seam ----------------------------
	const l1a = await T.run(async (t) => {
		const rd = (/** @type {any} */ s) => { let v; s.subscribe((/** @type {any} */ x) => (v = x))(); return v; };
		const scene = rd(t.globalScene);
		const camera = rd(t.globalCamera);
		const r = t.renderSeam.mainRenderer();
		const depth = () => t.lod.lodForTest.depth();
		const between = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => res(depth()), 0))));
		const orig = r.compileAsync;
		const hook = scene.onBeforeRender;
		// three r186 WebGPURenderer.compileAsync: targetScene.onBeforeRender, no onAfterRender
		r.compileAsync = function (/** @type {any} */ o, /** @type {any} */ c, /** @type {any} */ ts) {
			(ts ?? o).onBeforeRender(this, o, c, null);
			return orig.call(this, o, c, ts);
		};
		try {
			const idle = await between();
			await r.compileAsync(scene, camera, scene); // raw: the counterfactual
			const raw = await between();
			for (let i = 0; i < raw; i++) scene.onAfterRender(r, scene, camera, null); // close it by hand
			const repaired = await between();
			const res = await t.renderSeam.compileAsync(r, scene, camera, scene);
			const seam = await between();
			return { idle, raw, repaired, closed: res.closed, seam, hookBack: scene.onBeforeRender === hook };
		} finally {
			r.compileAsync = orig;
		}
	});
	h.check(l1a.idle === 0, `lod.js bracket depth is 0 between frames (${l1a.idle})`);
	h.check(l1a.raw >= 1, `COUNTERFACTUAL: a raw WebGPU-shaped compileAsync leaves the bracket open between frames (depth ${l1a.raw})`);
	h.check(l1a.repaired === 0, `closing it by hand brings the depth back to 0 (${l1a.repaired})`);
	h.check(l1a.closed === 1 && l1a.seam === 0, `through renderSeam.compileAsync the bracket is closed: closed ${l1a.closed}, depth ${l1a.seam} between frames`);
	h.check(l1a.hookBack === true, 'the scene keeps the very render hook it had (the guard unwraps itself)');

	// ---- 4. dispose and recreate: the same frame ----------------------------------------------
	await p.evaluate(async () => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		S.toasts?.set?.([]);
		S.commandsHandler.sceneCommand('/clear all');
		await new Promise((r) => setTimeout(r, 300));
		S.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 300));
		S.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 700));
		let g;
		S.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		g.children.forEach((/** @type {any} */ o, /** @type {number} */ i) => {
			o.position.set(i * 1.6 - 0.8, 0.6, 0);
			o.userData.physics = { ...(o.userData.physics ?? {}), mode: 'static' };
			o.updateMatrixWorld(true);
		});
		S.selectedObjects?.set?.([]);
		S.selectedObject?.set?.(null);
		S.objectsGroup.update((/** @type {any} */ v) => v);
	});
	await p.mouse.move(2, 2);
	await p.waitForTimeout(2500);
	const counts = () =>
		T.run(async (t) => {
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			/** @type {any} */ (window).gc?.();
			const s = t.renderSeam.seamState();
			return { ...s.memory, heap: /** @type {any} */ (performance).memory?.usedJSHeapSize ?? 0 };
		});
	const frame1 = await h.grabFrame(A);
	await p.waitForTimeout(400);
	const frame2 = await h.grabFrame(A);
	const memBefore = await counts();
	// threshold 0: ANY channel change counts (the strict reading of "the same frame")
	const noise = await h.frameDelta(p, frame1, frame2, 0);

	const recycled = await T.run((t) => t.renderSeam.recycleMainRenderer());
	h.check(recycled?.lost && recycled?.restored, `recycleMainRenderer lost and restored the context (${JSON.stringify(recycled)})`);
	await p.waitForTimeout(2500);
	const frame3 = await h.grabFrame(A);
	const memAfter = await counts();
	const delta = await h.frameDelta(p, frame2, frame3, 0);
	console.log(`frames: noise ${JSON.stringify(noise)} · after recycle ${JSON.stringify(delta)}`);
	// "the same frame" = no pixel moves further than two grabs of the untouched view already do. The
	// strict COUNT at threshold 0 is not a bound: one noise pair is a single sample of a jittery number
	// (u2 2026-11-14: noise 176 px, after recycle 250 px, both max delta 6 of 765, green on the retry).
	// A real change (AA off, another colour space, a missing object) moves pixels far past that.
	const floor = Math.max(noise.max ?? 0, 6);
	h.check(!delta.error && delta.max <= floor, `the frame after dispose + recreate is the same frame (max delta ${delta.max} <= ${floor}; ${delta.changed} px changed, noise ${noise.changed})`);
	// "memory within 5 %" is a LEAK bound: nothing may GROW past +5 %. Fewer is expected — a restore
	// rebuilds three's `info` and it counts only what the frames since have uploaded (measured 20 -> 6
	// geometries with the frame pixel-identical), while everything the scene still draws is back.
	const noGrowth = (/** @type {number} */ a, /** @type {number} */ b) => b <= a + Math.max(1, 0.05 * a);
	console.log(`memory before ${JSON.stringify(memBefore)} after ${JSON.stringify(memAfter)}`);
	h.check(noGrowth(memBefore.geometries, memAfter.geometries) && noGrowth(memBefore.textures, memAfter.textures) && noGrowth(memBefore.programs, memAfter.programs), `GPU memory not above +5 % after dispose + recreate (geometries ${memBefore.geometries} -> ${memAfter.geometries}, textures ${memBefore.textures} -> ${memAfter.textures}, programs ${memBefore.programs} -> ${memAfter.programs})`);
	h.check(!memBefore.heap || memAfter.heap <= 1.05 * memBefore.heap, `JS heap not above +5 % (${(memBefore.heap / 1e6).toFixed(1)} -> ${(memAfter.heap / 1e6).toFixed(1)} MB)`);
	const after = await T.run((t) => {
		const rd = (/** @type {any} */ s) => { let v; s.subscribe((/** @type {any} */ x) => (v = x))(); return v; };
		return { lost: rd(t.contextLost), shown: rd(t.contextLossShown), main: t.renderSeam.seamState().main };
	});
	h.check(after.lost === false && after.shown === false && after.main, `no lost-view overlay, the view is live (${JSON.stringify(after)})`);

	const errors = h.pageErrors?.(A) ?? [];
	h.check(!errors.length, `no page errors (${JSON.stringify(errors).slice(0, 300)})`);
	await h.finish(browser);
});
