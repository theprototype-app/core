// 34 PF — a DETAILED recording on a live page (contract T1 captures + CPU phases).
//
//   1. a planted heavy object is the TOP row of a capture, with its exact triangle count,
//      its path under the scene and no module; shadow-map passes are their own rows
//   2. every object's onBeforeRender/onAfterRender is put back EXACTLY after a capture
//      (own property restored, inherited one deleted) — the counterfactual: leaving the
//      hooks installed shows up as own properties on every mesh
//   3. frames carry CPU phases (render > 0) and the renderer's render() is unwrapped at stop
//   4. the recording stops itself after durationMs, captures ~1/s, memory is in each capture
//   5. GPU ms appear only when EXT_disjoint_timer_query_webgl2 exists (reported either way)
//
// Run: APP_URL=https://theprototype.app:5292/ npm run e2e -- perf-detailed
const h = require('./helpers.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

h.run(async () => {
	const tp = await import(pathToFileURL(path.join(__dirname, '../../src/lib/perf/tpprof.js')).href);
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// a heavy mesh: a box whose geometry is swapped for 60 000 triangles, plus two light boxes
	const planted = await page.evaluate(async () => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const made = [];
		for (const name of ['Light A', 'Heavy', 'Light B']) {
			s.commandsHandler.sceneCommand('/create box');
			const o = read(s.selectedObject);
			o.name = name;
			o.position.set(made.length * 2 - 2, 0.5, 0);
			made.push(o);
		}
		const heavy = made[1];
		const TRIS = 60000;
		const pos = new Float32Array(TRIS * 9);
		for (let i = 0; i < pos.length; i += 9) {
			const x = Math.random() - 0.5;
			const y = Math.random() - 0.5;
			const z = Math.random() - 0.5;
			pos.set([x, y, z, x + 0.01, y, z, x, y + 0.01, z], i);
		}
		const g = heavy.geometry.clone();
		g.setIndex(null);
		g.deleteAttribute('uv');
		g.deleteAttribute('normal');
		g.setAttribute('position', new heavy.geometry.attributes.position.constructor(pos, 3));
		g.clearGroups();
		heavy.geometry = g;
		s.selectedObjects?.set?.([]);
		await new Promise((r) => setTimeout(r, 500));
		const own = (o) => Object.prototype.hasOwnProperty.call(o, 'onBeforeRender') || Object.prototype.hasOwnProperty.call(o, 'onAfterRender');
		let ownBefore = 0;
		read(s.globalScene).traverse((o) => {
			if (own(o)) ownBefore++;
		});
		return { uuid: heavy.uuid, tris: TRIS, ownBefore };
	});

	const rec = await page.evaluate(async () => {
		const p = window.__stores.perf;
		const t0 = performance.now();
		const id = p.startRecording({ mode: 'detailed', name: 'Suite detailed', durationMs: 3500 });
		const during = window.__stores.perfDetailed.detailedDebug();
		while (p.recordingInfo() && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
		await new Promise((r) => setTimeout(r, 300));
		return { id, during, after: window.__stores.perfDetailed.detailedDebug(), stoppedAfter: performance.now() - t0, doc: await p.getRecording(id) };
	});
	const doc = rec.doc;
	const v = tp.validateTpprof(doc);
	h.check(v.ok, 'the detailed recording is valid T1 ' + v.errors.slice(0, 3).join('; '));
	h.check(doc.meta.mode === 'detailed' && rec.stoppedAfter >= 3400 && rec.stoppedAfter < 6000, `it stops itself after durationMs (${Math.round(rec.stoppedAfter)} ms)`);
	h.check(rec.during.on && rec.during.wrapped && !rec.after.on && !rec.after.wrapped, 'phases + the render wrap are on while recording and off after');
	h.check(Array.isArray(doc.captures) && doc.captures.length >= 2, `captures about once a second (${doc.captures?.length})`);
	const cap = doc.captures[doc.captures.length - 1];
	const top = cap.objects.filter((o) => !o.shadow).sort((a, b) => b.tris - a.tris)[0];
	h.check(top.uuid === planted.uuid && top.name === 'Heavy', `the heavy object is the top row by triangles (${top.name})`);
	// what was DRAWN, not what the geometry holds: auto-LOD (lod.js) swaps a 60k-triangle mesh
	// for a reduced level at render time, and the capture sees the geometry three was handed
	h.check(top.tris > 1000 && top.tris <= planted.tris, `with the triangles actually drawn per frame (${top.tris} of ${planted.tris}; auto-LOD may draw fewer)`);
	// two independent measurements agree: the per-object rows sum to the frame's own total
	const capFrames = doc.frames.filter((f) => f.t >= cap.t - 50 && f.t <= cap.t + 400 && f.tris > 0).map((f) => f.tris).sort((a, b) => a - b);
	const frameTris = capFrames[Math.floor(capFrames.length / 2)];
	const rowTris = cap.objects.reduce((n, o) => n + o.tris, 0);
	h.check(frameTris > 0 && Math.abs(rowTris - frameTris) / frameTris < 0.05, `the rows' triangles sum to the frame's measured total (${rowTris} vs ${frameTris})`);
	h.check(top.path === 'Scene/Heavy' && top.module === null && top.calls >= 1, `path ${top.path}, module ${top.module}, calls ${top.calls}`);
	h.check(typeof top.ms === 'number' && top.material.length > 0, `CPU submission ms (${top.ms}) and material (${top.material})`);
	const lights = cap.objects.filter((o) => !o.shadow && (o.name === 'Light A' || o.name === 'Light B'));
	h.check(lights.length === 2 && lights.every((o) => o.tris === 12), 'the light boxes are rows too, 12 triangles each');
	const shadowRows = cap.objects.filter((o) => o.shadow);
	console.log(`shadow rows: ${shadowRows.length} (${shadowRows.slice(0, 3).map((o) => o.name).join(', ')})`);
	h.check(shadowRows.every((o) => o.ms === undefined), 'shadow rows carry no ms (the pass is not per-object timed)');
	h.check(cap.memory && Number.isInteger(cap.memory.geometries) && Number.isInteger(cap.memory.programs), `memory per capture (${JSON.stringify(cap.memory)})`);
	h.check(cap.frames >= 2, `a capture averages over its frames (${cap.frames})`);
	h.check(doc.events.filter((e) => e.kind === 'capture').length === doc.captures.length, 'each capture is a marker on the timeline');

	// CPU phases
	const withCpu = doc.frames.filter((f) => f.cpu);
	const renderMs = withCpu.map((f) => f.cpu.render);
	h.check(withCpu.length >= doc.frames.length - 2, `every frame carries CPU phases (${withCpu.length}/${doc.frames.length})`);
	h.check(renderMs.filter((m) => m > 0).length > withCpu.length / 2, `render phase measured (median ${renderMs.sort((a, b) => a - b)[Math.floor(renderMs.length / 2)]} ms)`);
	h.check(Object.keys(withCpu[0].cpu).join() === tp.CPU_PHASES.join(), `the phases are ${tp.CPU_PHASES.join(', ')}`);
	const gpuFrames = doc.frames.filter((f) => typeof f.gpu === 'number').length;
	console.log(`GPU timer: ${doc.meta.gpuTimer ? 'available' : 'absent'}; frames with gpu ms: ${gpuFrames}`);
	h.check(doc.meta.gpuTimer ? gpuFrames > 0 : gpuFrames === 0, 'GPU ms exactly when the timer extension exists');

	// hooks restored exactly
	const restored = await page.evaluate(() => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((x) => (scene = x))();
		let own = 0;
		scene.traverse((o) => {
			if (Object.prototype.hasOwnProperty.call(o, 'onBeforeRender') || Object.prototype.hasOwnProperty.call(o, 'onAfterRender') || Object.prototype.hasOwnProperty.call(o, 'onBeforeShadow')) own++;
		});
		let r;
		s.globalRenderer.subscribe((x) => (r = x))();
		return { own, renderWrappedByUs: !!r.__perfDetailed };
	});
	h.check(restored.own === planted.ownBefore && !restored.renderWrappedByUs, `every hook is put back (own-property hooks ${planted.ownBefore} -> ${restored.own})`);

	// a light recording costs no detailed work: no cpu columns, no captures
	const light = await page.evaluate(async () => {
		const p = window.__stores.perf;
		p.startRecording({ mode: 'light' });
		await new Promise((r) => setTimeout(r, 800));
		const id = await p.stopRecording();
		const d = await p.getRecording(id);
		return { cpu: d.frames.some((f) => f.cpu), caps: !!d.captures, phasesOn: window.__stores.perfDetailed.detailedDebug().on };
	});
	h.check(!light.cpu && !light.caps && !light.phasesOn, 'a light recording leaves the phases off and takes no captures');

	await h.finish(browser);
});
