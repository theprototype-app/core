// 77 L1 — the film look in the HEADSET (IWER, the emulated Quest 3): depth of field and the
// letterbox matte are OFF in VR by construction — the composer does not run in XR (Outline renders
// straight through the XR cameras), so a scene and a camera carrying a film look cost the headset
// NOTHING: the same draw calls per XR frame as with no look at all, and no offscreen (post) render.
// Quest budget: ≤ 150 draw calls / ≤ 300k triangles per frame.
//
// Counterfactual: none in the code (L1 adds nothing to the XR path) — this pins that it stays so
// (a future "DOF in VR" must come through 72 LK3's cheap path, and this probe would show its cost).

const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

/** draw calls, triangles and OFFSCREEN renders per XR frame, over `ms` @param {any} page */
function xrCost(page, ms = 1500) {
	return page.evaluate(async (ms) => {
		const s = window.__stores;
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		const perFrame = new Map();
		const original = r.render;
		r.render = function (scene, camera) {
			const target = r.getRenderTarget();
			const out = original.call(this, scene, camera);
			if (r.xr.isPresenting) {
				const f = r.info.render.frame;
				const row = perFrame.get(f) ?? { calls: 0, tris: 0, offscreen: 0 };
				row.calls += r.info.render.calls;
				row.tris += r.info.render.triangles;
				// a post pass renders into one of the composer's targets, never the XR framebuffer
				if (target && !target.isXRRenderTarget) row.offscreen++;
				perFrame.set(f, row);
			}
			return out;
		};
		await new Promise((res) => setTimeout(res, ms));
		r.render = original;
		const rows = [...perFrame.values()];
		const avg = (k) => (rows.length ? rows.reduce((a, x) => a + x[k], 0) / rows.length : NaN);
		return { frames: rows.length, calls: Math.round(avg('calls')), tris: Math.round(avg('tris')), offscreen: rows.reduce((a, x) => a + x.offscreen, 0) };
	}, ms);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'quest', { init: iwer.initScript() });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});
	h.check(await iwer.installed(page), '0.1 premise: IWER owns navigator.xr');

	const cam = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create camera');
		await new Promise((r) => setTimeout(r, 2000));
		return s.cameraObjects.listCameraObjects().at(-1)?.uuid ?? '';
	});
	h.check(!!cam, '0.2 premise: a scene with a camera');

	// 1. baseline: no look anywhere
	await iwer.enter(page, { timeout: 30000 });
	await iwer.frames(page, 10);
	const bare = await xrCost(page);
	h.check(bare.frames > 3, '1.1 premise: XR frames render (' + bare.frames + ' frames, ' + bare.calls + ' calls)');
	await iwer.exit(page);

	// 2. the film look on the camera AND the scene: DOF + letterbox + a vignette
	const built = await page.evaluate(async (cam) => {
		const s = window.__stores;
		for (const key of [cam, 'scene']) {
			s.scenePost.addPostEffect('dof', undefined, key);
			s.scenePost.addPostEffect('letterbox', undefined, key);
		}
		s.scenePost.addPostEffect('vignette', undefined, 'scene');
		s.cameraObjects.setCameraFor(cam, { focus: 3, aperture: 1.4 });
		s.cameraPreview.startCameraPreview(cam);
		await new Promise((r) => setTimeout(r, 2500));
		const dbg = window.__postDebug();
		return { kinds: dbg.kinds, stackPasses: dbg.stackPasses };
	}, cam);
	h.check(built.kinds.includes('dof') && built.kinds.includes('letterbox'), '2.1 premise: on the desktop the chain carries the film look (' + built.kinds.join(',') + ')');
	await iwer.enter(page, { timeout: 30000 });
	await iwer.frames(page, 10);
	const look = await xrCost(page);
	h.check(look.frames > 3, '2.2 premise: XR frames render with the look authored (' + look.frames + ')');
	h.check(look.offscreen === 0, '2.3 no post pass runs in the headset: 0 offscreen renders (' + look.offscreen + ')');
	h.check(Math.abs(look.calls - bare.calls) <= 2, '2.4 the film look costs the headset no draw calls (' + bare.calls + ' -> ' + look.calls + ' per XR frame)');
	h.check(look.calls <= 150 && look.tris <= 300000, '2.5 within the Quest budget: ' + look.calls + ' calls / ' + look.tris + ' tris per frame (≤ 150 / ≤ 300k)');
	await iwer.exit(page);

	// 3. back on the desktop the look returns
	await h.eventually(
		() => page.evaluate(() => window.__postDebug().kinds),
		(k) => k.includes('dof'),
		'3.1 leaving the headset, the desktop chain renders the film look again',
		15000
	);
	console.log(JSON.stringify({ bare, look }));
	await h.finish(browser);
});
