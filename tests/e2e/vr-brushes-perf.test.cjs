// 52 (V3) PERF — a paint stroke and a scatter stroke on a terrain carrying 2 000 scattered instances, in the
// headset (IWER, a Quest 3), with the budget meter on the Quest target ("the Quest profile"). Run it with
// `e2e-slot --local` (or --exclusive): a remote slot renders on a desktop GPU.
//
// What is GATED is the work the brush adds on the main thread per XR frame — what a Quest has to fit
// inside 13.9 ms at 72 Hz beside everything else: the stroke frames' XR-frame callback time minus the
// same scene's idle frames (median and p95), plus the instancing (2 000 instances must stay a handful of
// draw calls). The whole frame on this box is PRINTED, never gated: it is not a Quest number (headless
// ANGLE on the Deck's GPU). A real-Quest row (stroke at 72 Hz, no dropped frames) goes on the device checklist.
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const g = (page, fn, arg) => page.evaluate(fn, arg);
const BUDGET_MS = 1000 / 72; // 13.9
const BRUSH_SHARE_MS = 4; // the brush's own share of a 72 Hz frame (median); p95 may reach 7

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } }, storage: { budgetTarget: 'quest' } });
	const page = A.page;
	// time every XR frame callback, summed PER FRAME (the frame's timestamp keys it: several callbacks — three's
	// loop, IWER's, the app's — share one XR frame; most are empty, so timing them one by one reads 0 ms)
	await g(page, () => {
		const proto = window.XRSession?.prototype;
		if (!proto || proto.__timed) return;
		const raf = proto.requestAnimationFrame;
		window.__xrFrames = new Map();
		proto.requestAnimationFrame = function (cb) {
			return raf.call(this, (t, f) => {
				const t0 = performance.now();
				try {
					cb(t, f);
				} finally {
					const m = window.__xrFrames;
					m.set(t, (m.get(t) ?? 0) + performance.now() - t0);
				}
			});
		};
		proto.__timed = true;
	});
	const uuid = await g(page, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Terrain 24 64');
		await new Promise((r) => setTimeout(r, 300));
		let sel;
		s.selectedObject.subscribe((x) => (sel = x))();
		sel.position.set(0, 0, -8);
		sel.updateMatrixWorld(true);
		s.terrainPaint.addScatterSet(sel.uuid, { source: { kind: 'primitive', type: 'Cone' }, seed: 7, gen: { count: 2000, scaleMin: 0.2, scaleMax: 0.4 } });
		await new Promise((r) => setTimeout(r, 500));
		return sel.uuid;
	});
	const count = await g(page, (u) => {
		let grp;
		window.__stores.objectsGroup.subscribe((x) => (grp = x))();
		return Object.values(window.__stores.terrainSurface.scatterCounts(grp.getObjectByProperty('uuid', u))).reduce((a, b) => a + b, 0);
	}, uuid);
	h.check(count >= 2000, `premise: the terrain draws 2 000 scattered instances (${count})`);
	const target = await g(page, () => {
		let v;
		window.__stores.budgetMeter?.budgetTarget?.subscribe((x) => (v = x))();
		return v ?? localStorage.getItem('budgetTarget');
	});
	h.check(target === 'quest', `premise: the budget meter judges for the Quest (${target})`);

	await iwer.enter(page);
	const menuHand = await g(page, () => {
		let v;
		window.__stores.vrMenuHand.subscribe((x) => (v = x))();
		return v;
	});
	const pointer = menuHand === 'right' ? 'left' : 'right';
	await g(page, (u) => window.__stores.vrSculpt.startVRSculpt(u), uuid);
	const aim = (x = 0) => iwer.pose(page, pointer, [x, 1.3, -2], { pitch: -0.9 });
	await aim();
	await iwer.frames(page, 30);

	const drawCalls = await g(page, () => {
		const s = window.__stores;
		let r, scene, cam;
		s.globalRenderer.subscribe((x) => (r = x))();
		s.globalScene.subscribe((x) => (scene = x))();
		s.globalCamera.subscribe((x) => (cam = x))();
		const auto = r.info.autoReset;
		r.info.autoReset = false;
		r.info.reset();
		const xr = r.xr.enabled;
		r.xr.enabled = false; // one mono render, the instancing count
		r.render(scene, cam);
		r.xr.enabled = xr;
		const out = { calls: r.info.render.calls, tris: r.info.render.triangles };
		r.info.autoReset = auto;
		return out;
	});
	console.log(`  draw calls (mono, whole scene): ${drawCalls.calls}, triangles ${drawCalls.tris}`);
	h.check(drawCalls.calls < 40, `2 000 instances stay instanced (${drawCalls.calls} draw calls for the whole scene)`);

	/** XR frame times over n frames, optionally with a trigger stroke sweeping the hand */
	const sample = async (n, stroking) => {
		await g(page, () => window.__xrFrames.clear());
		if (stroking) await iwer.button(page, pointer, 'trigger', true);
		for (let i = 0; i < n; i++) {
			if (stroking) await aim(-1 + (2 * i) / n);
			await iwer.frames(page, 1);
		}
		if (stroking) await iwer.button(page, pointer, 'trigger', false);
		await iwer.frames(page, 4);
		const list = await g(page, () => [...window.__xrFrames.values()]);
		const sorted = [...list].sort((a, b) => a - b);
		const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
		return { n: list.length, med: q(0.5), p95: q(0.95) };
	};
	const fmt = (x) => `median ${x.med.toFixed(2)} ms, p95 ${x.p95.toFixed(2)} ms over ${x.n} frames`;

	const idle = await sample(90, false);
	console.log('  idle (brush up, 2 000 instances):', fmt(idle));
	await g(page, () => window.__stores.vrControls.executeVRMenuAction('sculpt:layer:1'));
	const paint = await sample(120, true);
	console.log('  paint stroke:', fmt(paint));
	await g(page, () => window.__stores.vrControls.executeVRMenuAction('sculpt:tool:paint'));
	const scatter = await sample(120, true);
	console.log('  scatter stroke:', fmt(scatter));
	await g(page, () => window.__stores.vrControls.executeVRMenuAction('sculpt:tool:rotate'));
	const rotate = await sample(120, true);
	console.log('  rotate stroke (51 edit brush over the 2 000):', fmt(rotate));
	for (const [name, x] of [['paint', paint], ['scatter', scatter], ['rotate', rotate]]) {
		const added = x.med - idle.med;
		h.check(added < BRUSH_SHARE_MS, `the ${name} stroke adds ${added.toFixed(2)} ms per XR frame (median; budget share ${BRUSH_SHARE_MS} of ${BUDGET_MS.toFixed(1)} ms)`);
		h.check(x.p95 - idle.med < 7, `the ${name} stroke's p95 frame stays within 7 ms of idle (${(x.p95 - idle.med).toFixed(2)} ms)`);
	}
	console.log(`  (this box's whole XR frame is printed only — not a Quest number; the 72 Hz budget is ${BUDGET_MS.toFixed(1)} ms)`);

	await iwer.exit(page);
	await h.finish(browser);
});
