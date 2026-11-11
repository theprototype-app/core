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
//      noise floor) with the GPU memory counts back where they were (within 5 %), no "3D view has
//      stopped" overlay, and the JS heap within 5 %.
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
			same: t.isLocked === w.__stores.isLocked && t.history === w.__stores.history && t.renderSeam === w.__stores.renderSeam,
			keys: Object.keys(t).length,
			storeKeys: Object.keys(w.__stores).length,
			frozenRoot: Object.isFrozen(w.__tp) && Object.isFrozen(w.__tp.test),
			threw
		};
	});
	h.check(facade.versions?.includes('v1'), `__tp.test lists v1 (${JSON.stringify(facade.versions)})`);
	h.check(facade.same, 'the facade hands out the very objects __stores does (an alias, not a copy)');
	h.check(facade.keys >= facade.storeKeys && facade.storeKeys > 400, `the facade lists every hook (${facade.keys} >= ${facade.storeKeys})`);
	h.check(facade.frozenRoot && /read-only/.test(facade.threw), `read-only: a write throws (${facade.threw})`);
	h.check((await T.get('isLocked')) === (await p.evaluate(() => { let v; /** @type {any} */ (window).__stores.isLocked.subscribe((/** @type {any} */ x) => (v = x))(); return v; })), 'h.t(page).get reads a store through the facade');
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
	h.check(!delta.error && delta.changed <= Math.max(noise.changed ?? 0, 0), `the frame after dispose + recreate is the same frame (${delta.changed} px changed, noise floor ${noise.changed})`);
	const within = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) <= Math.max(1, 0.05 * Math.max(a, b));
	console.log(`memory before ${JSON.stringify(memBefore)} after ${JSON.stringify(memAfter)}`);
	h.check(within(memBefore.geometries, memAfter.geometries) && within(memBefore.textures, memAfter.textures), `GPU memory back within 5 % (geometries ${memBefore.geometries} -> ${memAfter.geometries}, textures ${memBefore.textures} -> ${memAfter.textures})`);
	h.check(!memBefore.heap || Math.abs(memAfter.heap - memBefore.heap) <= 0.05 * memBefore.heap, `JS heap within 5 % (${(memBefore.heap / 1e6).toFixed(1)} -> ${(memAfter.heap / 1e6).toFixed(1)} MB)`);
	const after = await T.run((t) => {
		const rd = (/** @type {any} */ s) => { let v; s.subscribe((/** @type {any} */ x) => (v = x))(); return v; };
		return { lost: rd(t.contextLost), shown: rd(t.contextLossShown), main: t.renderSeam.seamState().main };
	});
	h.check(after.lost === false && after.shown === false && after.main, `no lost-view overlay, the view is live (${JSON.stringify(after)})`);

	const errors = h.pageErrors?.(A) ?? [];
	h.check(!errors.length, `no page errors (${JSON.stringify(errors).slice(0, 300)})`);
	await h.finish(browser);
});
