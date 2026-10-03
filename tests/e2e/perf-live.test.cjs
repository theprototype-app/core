// 34 PF (profiler-xr) — profile the headset from the desktop. Two peers in one room:
//   H = the "headset" (a Quest user agent, the fake XR session, the VR menu and the REC pill)
//   D = the desktop watching it in the Live profiler window
//
//   1. VR menu: System ▸ Profile ▸ Record / Record detailed / Report moment; Record starts a
//      light recording, Stop replaces Record while one runs; the head-locked pill says REC
//   2. the mesh hears "H is recording" (one `state` message) — D's peer row shows REC
//   3. D watches (light): hello (the headset's device), the 10-s backfill, then batches 2x a
//      second; the pill on H says LIVE 1; the live document is a valid T1 recording
//   4. bandwidth: light mode stays under ~20 KB/s (measured on D over 10 s)
//   5. "Capture now" from a LIGHT watch: a one-shot capture while H's light recording keeps
//      running (the heaviest planted object is in its top rows)
//   6. Detailed: H stops its light recording from the VR menu, D asks for Detailed -> H runs a
//      detailed recording (pill: REC DETAILED), its CPU phases ride the stream and its
//      per-second captures arrive
//   7. Save: the stream becomes one of D's recordings (valid T1, captures, H's device)
//   8. the wire validator refuses a malformed batch on the live path (counted invalid:perflive);
//      Stop -> H's source goes idle and the LIVE pill goes away
//
// Run: APP_URL=https://theprototype.app:5301/ npm run e2e -- perf-live
const h = require('./helpers.cjs');
const fakeXR = require('./fakeXR.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const QUEST_UA =
	'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0.0.0 SamsungBrowser/4.0 Chrome/132.0.0.0 VR Safari/537.36';
const EVIDENCE = process.env.EVIDENCE_DIR || '';

h.run(async () => {
	const tp = await import(pathToFileURL(path.join(__dirname, '../../src/lib/perf/tpprof.js')).href);
	const browser = await h.launch({ args: h.GPU_ARGS });
	const H = await h.setupPage(browser, 'H', { context: { userAgent: QUEST_UA } });
	const D = await h.setupPage(browser, 'D');
	await h.connect(D, H);
	const hp = H.page;
	const dp = D.page;
	await fakeXR.install(hp);

	/** the REC pill on H for a synthetic head pose, read past its 4 Hz throttle */
	const pill = () =>
		hp.evaluate(() => {
			const s = window.__stores;
			const THREE = s.THREE;
			const head = { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() };
			s.vrRecIndicator.vrRecIndicatorFrame(head, performance.now() + 1e6);
			const d = s.vrRecIndicator.vrRecIndicatorDebug();
			return { visible: d.visible, text: d.visible ? d.segments.map((x) => x.text).join(' | ') : '' };
		});
	const menu = (/** @type {string} */ id) =>
		hp.evaluate((id) => {
			const e = window.__stores.vrRadialMenu.findMenuEntry(id);
			e.action();
			return true;
		}, id);
	const ring = (/** @type {string} */ g) => hp.evaluate((g) => window.__stores.vrRadialMenu.ringEntries(g).map((e) => e.id), g);
	const hRec = () => hp.evaluate(() => window.__stores.perf.recordingInfo());
	const sess = () =>
		dp.evaluate((id) => {
			let st;
			window.__stores.perfLiveSink.perfLive.subscribe((v) => (st = v))();
			return { s: st.sessions[id] ?? null, recording: st.recording[id] ?? null };
		}, H.id);

	// ---- 1. the VR menu on the headset
	const sys = await ring('system');
	const prof = await ring('profile');
	h.check(sys.includes('nav:profile') && !sys.includes('moment'), `1.1 System has "Profile ▸" (${sys.join(', ')})`);
	h.check(prof.join(',') === 'perf:record,perf:detailed,moment', `1.2 Profile = Record, Record detailed, Report moment (${prof.join(', ')})`);
	h.check(!(await pill()).visible, '1.3 no pill while nothing records and nobody watches');
	await menu('perf:record');
	await hp.waitForTimeout(600);
	const rec1 = await hRec();
	h.check(rec1?.mode === 'light', `1.4 Record started a light recording on the headset (${JSON.stringify(rec1)})`);
	h.check((await ring('profile')).join(',') === 'perf:stop,moment', '1.5 while recording, Stop replaces Record / Record detailed');
	await hp.waitForTimeout(1200);
	const p1 = await pill();
	h.check(p1.visible && /^● REC 0:0[1-9]$/.test(p1.text), `1.6 the pill says REC and the clock ("${p1.text}")`);

	// ---- 2. the mesh hears it
	await h.eventually(() => sess(), (x) => !!x.recording, '2.1 the desktop heard "recording" (one state message)');

	// ---- 3. the Live profiler on the desktop
	await dp.locator('#logo-menu').click();
	await dp.waitForTimeout(400);
	await dp.locator('#open-profiler-live').click();
	await dp.locator('#profiler-live').waitFor({ state: 'visible', timeout: 8000 });
	const row = dp.locator(`#profiler-live-peers [data-peer="${H.id}"]`);
	h.check((await row.count()) === 1, '3.1 the headset is listed in the room');
	h.check(/REC/.test(await row.innerText()), '3.2 ...with its REC chip');
	// plant a heavy object on the headset for the capture checks: a box (replicated) whose LOCAL
	// geometry is swapped for 40 000 triangles (the perf-detailed fixture)
	await hp.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let o;
		s.selectedObject.subscribe((x) => (o = x))();
		o.name = 'Heavy';
		const pos = new Float32Array(40000 * 9);
		for (let i = 0; i < pos.length; i++) pos[i] = Math.random() - 0.5;
		const g = new s.THREE.BufferGeometry();
		g.setAttribute('position', new s.THREE.BufferAttribute(pos, 3));
		o.geometry = g;
	});
	await row.locator('[data-act="watch"]').click();
	await h.eventually(() => sess(), (x) => !!x.s && !x.s.waiting && x.s.frames > 30, '3.3 hello + the backfill land (graph starts full)', 8000);
	const a = await sess();
	h.check(/Quest/.test(a.s.device), `3.4 the hello carries the headset's device ("${a.s.device.slice(0, 40)}…")`);
	const f1 = a.s.frames;
	await dp.waitForTimeout(2600);
	const b = await sess();
	h.check(b.s.frames > f1 + 30, `3.5 batches keep arriving (${f1} -> ${b.s.frames} frames in 2.6 s)`);
	h.check(b.s.latest && b.s.latest.fps > 5 && Number.isFinite(b.s.latest.ms), `3.6 live numbers (${b.s.latest?.fps} fps, ${b.s.latest?.ms} ms, ${b.s.latest?.calls} calls)`);
	const src = await hp.evaluate(() => window.__stores.perfLiveSource.liveSourceDebug());
	h.check(src.running && src.watchers.length === 1 && src.watchers[0].id === D.id && src.watchers[0].mode === 'light', `3.7 the headset streams to exactly the desktop (${JSON.stringify(src.watchers)})`);
	const p3 = await pill();
	h.check(/◉ LIVE 1/.test(p3.text) && /● REC/.test(p3.text), `3.8 the pill says REC and LIVE 1 ("${p3.text}")`);
	const doc3 = await dp.evaluate((id) => structuredClone(window.__stores.perfLiveSink.liveDoc(id)), H.id);
	const v3 = tp.validateTpprof(doc3);
	h.check(v3.ok, '3.9 the live document is a valid T1 recording ' + v3.errors.slice(0, 2).join('; '));
	const mono = doc3.frames.every((f, i) => i === 0 || f.t > doc3.frames[i - 1].t);
	const wallEnd = doc3.meta.startedAt + doc3.frames.at(-1).t;
	h.check(mono && Math.abs(Date.now() - wallEnd) < 5000, `3.10 frames in order and on the wall clock (last frame ${Math.round(Date.now() - wallEnd)} ms ago)`);
	h.check((await dp.locator(`#profiler-live .live-session[data-peer="${H.id}"] canvas.live-graph`).count()) === 2, '3.11 the frame-time and draw-call graphs are drawn');

	// ---- 4. bandwidth, light
	await dp.waitForTimeout(8000);
	const c = await sess();
	const kbs = c.s.bytesPerSec / 1024;
	h.check(c.s.mode === 'light' && c.s.bytesPerSec > 0 && c.s.bytesPerSec <= 20 * 1024, `4.1 light stream ${kbs.toFixed(2)} KB/s over 10 s (budget 20 KB/s; JSON-measured)`);
	const shown = await dp.locator(`#profiler-live .live-session[data-peer="${H.id}"] .live-bw`).innerText();
	h.check(/KB\/s/.test(shown), `4.2 the window shows it ("${shown}")`);

	// ---- 5. a one-shot capture from a LIGHT watch, the light recording untouched
	await dp.locator(`#profiler-live .live-session[data-peer="${H.id}"] [data-act="capture"]`).click();
	await h.eventually(() => sess(), (x) => !!x.s.lastCapture && x.s.lastCapture.objects > 0, '5.1 "Capture now" brings a detailed capture back', 8000);
	const d5 = await sess();
	// the window's list ranks by draw calls (the gizmo's axis meshes win that); by TRIANGLES the
	// planted 40k mesh is the heaviest object of the capture that arrived
	const cap5 = await dp.evaluate((id) => {
		const caps = window.__stores.perfLiveSink.liveDoc(id).captures ?? [];
		const objs = caps.at(-1)?.objects ?? [];
		const top = [...objs].sort((a, b) => b.tris - a.tris)[0];
		const heavy = objs.find((o) => o.name === 'Heavy' && !o.shadow);
		return { n: objs.length, frames: caps.at(-1)?.frames, heavyCalls: heavy?.calls, top: top ? { name: top.name, tris: top.tris, path: top.path } : null };
	}, H.id);
	// (auto-LOD may draw a decimated level of a 40k mesh: a capture counts what was DRAWN)
	h.check(cap5.top?.name === 'Heavy' && cap5.top.tris >= 5000, `5.2 by triangles its heaviest object is the planted mesh (${JSON.stringify(cap5.top)} of ${cap5.n})`);
	// a one-shot has no detailed recording draining the probe's frame clock: it must still
	// measure its frames, or two seconds of draws get divided by one (240 "calls" for 2)
	h.check(cap5.frames >= 3 && cap5.heavyCalls > 0 && cap5.heavyCalls <= 4, `5.2b the one-shot measured ${cap5.frames} frames: ${cap5.heavyCalls} calls per frame for the mesh`);
	h.check((await hRec())?.id === rec1.id, '5.3 the headset light recording kept running (a one-shot records nothing)');

	// ---- 6. Detailed on request
	await menu('perf:stop');
	await hp.waitForTimeout(800);
	h.check(!(await hRec()), '6.1 Stop (VR menu) ended the headset recording');
	await dp.locator(`#profiler-live-peers [data-peer="${H.id}"] [data-act="stop"]`).click();
	await dp.waitForTimeout(300);
	await dp.locator(`#profiler-live-peers [data-peer="${H.id}"] [data-act="detailed"]`).click();
	await h.eventually(() => hRec(), (r) => r?.mode === 'detailed', '6.2 Detailed asked the headset for a detailed recording', 5000);
	const p6 = await pill();
	h.check(/● REC DETAILED/.test(p6.text) && /LIVE 1/.test(p6.text), `6.3 the pill says so ("${p6.text}")`);
	await h.eventually(() => sess(), (x) => x.s.mode === 'detailed' && !!x.s.cpu && x.s.captures >= 2, '6.4 CPU phases ride the stream and the per-second captures arrive', 9000);
	const e6 = await sess();
	h.check(e6.s.cpu && ['input', 'physics', 'modules', 'flow', 'render', 'other'].every((k) => k in e6.s.cpu), `6.5 all six phases (${JSON.stringify(e6.s.cpu)})`);
	const kbsD = e6.s.bytesPerSec / 1024;

	// ---- 7. Save
	await dp.locator(`#profiler-live .live-session[data-peer="${H.id}"] [data-act="save"]`).click();
	await dp.waitForTimeout(800);
	const saved = await dp.evaluate(async () => {
		const p = window.__stores.perf;
		const row = (await p.listRecordings()).find((r) => r.kind === 'live');
		return row ? { row, doc: await p.getRecording(row.id) } : null;
	});
	h.check(!!saved && /^Live · /.test(saved.row.name), `7.1 a recording "${saved?.row.name}" on the desktop`);
	const v7 = saved ? tp.validateTpprof(saved.doc) : { ok: false, errors: ['none'] };
	h.check(v7.ok, '7.2 valid T1 ' + v7.errors.slice(0, 2).join('; '));
	h.check(saved && saved.doc.captures?.length >= 2 && /Quest/.test(saved.doc.meta.device) && saved.doc.frames.some((f) => f.cpu), `7.3 with the captures (${saved?.doc.captures?.length}), CPU phases and the headset's device`);
	if (EVIDENCE && saved) fs.writeFileSync(path.join(EVIDENCE, 'live-saved.tpprof.json'), JSON.stringify(saved.doc).slice(0, 2_000_000));

	// ---- 8. the validator on the live path; Stop
	const before = await hp.evaluate(() => window.__stores.wireErrors.wireErrors().filter((e) => e.type === 'invalid:perflive').reduce((a, e) => a + e.count, 0));
	await dp.evaluate((id) => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		p.connections[id].send({ type: 'perflive', op: 'frames', base: 1, t0: 0, f: [1, 2, 3] });
	}, H.id);
	await hp.waitForTimeout(600);
	const after = await hp.evaluate(() => window.__stores.wireErrors.wireErrors().filter((e) => e.type === 'invalid:perflive').reduce((a, e) => a + e.count, 0));
	h.check(after === before + 1, `8.1 a batch of broken frames is refused on arrival (invalid:perflive ${before} -> ${after})`);
	await dp.locator(`#profiler-live-peers [data-peer="${H.id}"] [data-act="stop"]`).click();
	await h.eventually(() => hp.evaluate(() => window.__stores.perfLiveSource.liveSourceDebug()), (x) => !x.running && x.watchers.length === 0, '8.2 Stop: the headset stops streaming');
	await hp.evaluate(() => window.__stores.perf.stopRecording());
	await hp.waitForTimeout(300);
	h.check(!(await pill()).visible, '8.3 ...and the pill goes away once nothing records');

	if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'bandwidth.txt'), `light ${kbs.toFixed(2)} KB/s, detailed ${kbsD.toFixed(2)} KB/s (JSON-measured on the desktop, 10-s window, headless ~60 Hz)\n`);
	await h.finish(browser);
});
