// 34 PF/R1 — the perf recorder on a live page (contract T1).
//
//   1. the always-on LIGHT RING fills from real frames: ms, draw calls, triangles, quality
//   2. markers land in it: scene-load (start/end), mode, quality, a real STALL with what was happening
//   3. a light RECORDING: record -> mark -> stop -> list / get, the document is valid T1
//   4. rename / pin / delete, and the pinned one survives the unpinned cap
//   5. EXPORT -> `.tpprof` bytes decoded IN NODE by the same module (gzip round trip) -> IMPORT
//   6. recordings survive a reload (IndexedDB)
//   7. a failed IndexedDB write falls back to memory for the session (the safeStorage rule) —
//      the counterfactual: with the fallback removed the save throws and nothing is listed
//   8. the hot-path overhead, measured by the recorder itself
//
// Run: APP_URL=https://theprototype.app:5292/ npm run e2e -- perf-recorder
const h = require('./helpers.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

h.run(async () => {
	const tp = await import(pathToFileURL(path.join(__dirname, '../../src/lib/perf/tpprof.js')).href);
	// the GPU backend: on software GL this page draws ~4 fps and every count below is noise
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---- 1. the light ring
	await page.waitForFunction(() => window.__stores.perf?.recorderDebug().ringFrames > 30, null, { timeout: 15000 });
	const ring = await page.evaluate(() => {
		const w = window.__stores.perf.lightWindow(2000);
		return { n: w.frames.length, frame: w.frames[w.frames.length - 1], meta: w.meta, calls: w.frames.filter((f) => f.calls > 0).length };
	});
	h.check(ring.n > 10, `the light ring holds the last 2 s of frames (${ring.n})`);
	h.check(Number.isFinite(ring.frame.ms) && ring.frame.ms > 0, `a frame carries its ms (${ring.frame.ms})`);
	h.check(ring.calls > 0, `frames carry the draw calls every render pass made (${ring.calls}/${ring.n} with calls > 0)`);
	h.check(ring.frame.quality === 0, 'a frame carries the quality level');
	h.check(ring.meta.mode === 'light' && /^[0-9a-f]{7,}|unknown/.test(ring.meta.build) && typeof ring.meta.version === 'string', `meta: mode light, build ${ring.meta.build}, version ${ring.meta.version}`);
	h.check(ring.meta.modules && Object.keys(ring.meta.modules).length > 0, `meta.modules lists the loaded modules (${Object.keys(ring.meta.modules).join(', ')})`);
	h.check(/Chrome|Headless/.test(ring.meta.device), 'meta.device is the user agent');
	h.check(tp.validateTpprof(await page.evaluate(() => window.__stores.perf.lightWindow(2000))).ok, 'a light window is valid T1');

	// ---- 2. markers
	await page.evaluate(async () => {
		const s = window.__stores;
		const job = s.sceneLoader.beginLoad('Perf Fixture', 3);
		await new Promise((r) => setTimeout(r, 120));
		s.sceneLoader.endLoad(job);
		s.editorMode.set('interact');
		await new Promise((r) => setTimeout(r, 50));
		s.editorMode.set('edit');
		s.qualityGovernor.applyGameQuality(3, 'medium');
		await new Promise((r) => setTimeout(r, 50));
		s.qualityGovernor.applyGameQuality(null);
		// a REAL stall: block the main thread inside a frame
		await new Promise((r) =>
			requestAnimationFrame(() => {
				const until = performance.now() + 180;
				while (performance.now() < until) {
					/* busy */
				}
				r(null);
			})
		);
		await new Promise((r) => setTimeout(r, 300));
	});
	const ev = await page.evaluate(() => window.__stores.perf.lightWindow(5000).events);
	const kinds = ev.map((e) => e.kind);
	const loads = ev.filter((e) => e.kind === 'scene-load');
	h.check(loads.length === 2 && loads[0].detail.phase === 'start' && loads[1].detail.phase === 'end' && loads[1].detail.scene === 'Perf Fixture' && loads[1].detail.ms >= 100, `scene-load start + end with the scene and its ms (${JSON.stringify(loads.map((e) => e.detail))})`);
	h.check(ev.some((e) => e.kind === 'mode' && e.detail.mode === 'interact'), 'a mode change is a marker');
	h.check(ev.some((e) => e.kind === 'quality' && e.detail.level === 3), 'a quality change is a marker with its level');
	const stall = ev.find((e) => e.kind === 'stall' && e.detail.ms >= 150);
	h.check(!!stall, `a 180 ms frame is a STALL event (${JSON.stringify(stall?.detail)})`);
	h.check(Array.isArray(stall?.detail?.doing) && stall.detail.doing.some((d) => d.startsWith('mode:')), 'the stall says what was happening');
	h.check(!kinds.includes('gap'), 'no gap events on a visible page');

	// ---- 3. a light recording
	const recId = await page.evaluate(async () => {
		const p = window.__stores.perf;
		const id = p.startRecording({ mode: 'light', name: 'Suite light' });
		await new Promise((r) => setTimeout(r, 1500));
		p.mark('halfway');
		await new Promise((r) => setTimeout(r, 500));
		return { id, again: p.startRecording(), info: p.recordingInfo(), stopped: await p.stopRecording() };
	});
	h.check(recId.again === recId.id, 'a second record() while one runs returns the running id');
	h.check(recId.info.frames > 10 && recId.info.mode === 'light', `the running recording counts frames (${recId.info.frames})`);
	h.check(recId.stopped === recId.id, 'stop() resolves the saved id');
	const doc = await page.evaluate((id) => window.__stores.perf.getRecording(id), recId.id);
	const v = tp.validateTpprof(doc);
	h.check(v.ok, 'the saved recording is valid T1 ' + v.errors.slice(0, 3).join('; '));
	h.check(doc.meta.name === 'Suite light' && doc.meta.mode === 'light' && doc.meta.durationMs >= 1900, `meta name/mode/duration (${doc.meta.durationMs} ms)`);
	h.check(doc.frames[0].t < 300 && doc.frames.length > 10, `frames start near t=0 (${doc.frames[0].t}) — ${doc.frames.length} of them`);
	const half = doc.events.find((e) => e.kind === 'mark' && e.detail.text === 'halfway');
	h.check(half && half.t > 1300 && half.t < 1900, `the mark sits at its time in the recording (${half?.t})`);
	h.check(!doc.captures && !doc.notes, 'a light recording has no captures or notes');
	const rows = await page.evaluate(() => window.__stores.perf.listRecordings());
	h.check(rows[0].id === recId.id && rows[0].frames === doc.frames.length && rows[0].summary.fpsP50 > 0, `list() has it first with its summary (fps p50 ${rows[0].summary.fpsP50})`);

	// ---- 4. rename / pin / delete
	await page.evaluate(async (id) => {
		const p = window.__stores.perf;
		await p.renameRecording(id, 'Renamed');
		await p.pinRecording(id, true);
	}, recId.id);
	const row = (await page.evaluate(() => window.__stores.perf.listRecordings()))[0];
	h.check(row.name === 'Renamed' && row.pinned === true, 'rename + pin reach the row');
	const capped = await page.evaluate(async (pinned) => {
		const p = window.__stores.perf;
		const ids = [];
		for (let i = 0; i < p.MAX_SAVED + 2; i++) ids.push(await p.saveDocument(p.lightWindow(200, { name: 'filler ' + i })));
		const list = await p.listRecordings();
		return { n: list.length, max: p.MAX_SAVED, hasPinned: list.some((r) => r.id === pinned), firstFillerGone: !list.some((r) => r.id === ids[0]), lastFiller: list.some((r) => r.id === ids[ids.length - 1]), ids };
	}, recId.id);
	h.check(capped.n === capped.max + 1 && capped.hasPinned && capped.firstFillerGone && capped.lastFiller, `past ${capped.max} unpinned the oldest goes, the pinned one stays (${capped.n} kept)`);
	const del = await page.evaluate(async (ids) => {
		const p = window.__stores.perf;
		for (const id of ids) await p.deleteRecording(id);
		return { list: (await p.listRecordings()).length, gone: await p.getRecording(ids[ids.length - 1]) };
	}, capped.ids);
	h.check(del.list === 1 && del.gone === null, 'delete removes the row and the document');

	// ---- 5. export -> node decode -> import
	const exported = await page.evaluate(async (id) => {
		const blob = await window.__stores.perf.exportRecording(id);
		return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
	}, recId.id);
	const bytes = Uint8Array.from(exported.bytes);
	h.check(bytes[0] === 0x1f && bytes[1] === 0x8b && exported.type === 'application/x-tpprof', `export is gzip (.tpprof, ${bytes.length} bytes)`);
	const decoded = tp.decodeTpprof(bytes);
	h.check(decoded.frames.length === doc.frames.length && decoded.summary.frames === doc.frames.length && decoded.meta.name === 'Renamed', 'the file decodes outside the app with the same frames + a summary');
	const imp = await page.evaluate(async (arr) => {
		const p = window.__stores.perf;
		const id = await p.importRecording(new Blob([new Uint8Array(arr)]));
		let refused = '';
		try {
			await p.importRecording(new Blob([new TextEncoder().encode('{"tpprof":1}')]));
		} catch (e) {
			refused = String(e.message);
		}
		return { id, doc: await p.getRecording(id), refused, n: (await p.listRecordings()).length };
	}, exported.bytes);
	h.check(imp.doc && imp.doc.frames.length === doc.frames.length && !imp.doc.summary && imp.n === 2, 'import brings the file in as a new saved recording (summary recomputed, not stored)');
	h.check(/Not a valid performance recording/.test(imp.refused), `a bad file is refused with a reason (${imp.refused})`);
	// a beacon export is plain JSON
	const jsonId = await page.evaluate(async () => {
		const p = window.__stores.perf;
		return p.importRecording(new Blob([JSON.stringify(p.lightWindow(500, { kind: 'sample', session: 'suite1234' }))]));
	});
	h.check(typeof jsonId === 'string', 'a plain-JSON beacon window imports too');

	// ---- 6. survives a reload
	await h.freshReload(A);
	await page.waitForFunction(() => window.__stores?.perf, null, { timeout: 30000 });
	const after = await page.evaluate(async (id) => ({ list: await window.__stores.perf.listRecordings(), doc: await window.__stores.perf.getRecording(id) }), recId.id);
	h.check(after.list.length === 3 && after.doc?.frames?.length === doc.frames.length, `recordings survive a reload (${after.list.length})`);

	// ---- 7. a failed write falls back to memory
	const fb = await page.evaluate(async () => {
		const s = window.__stores;
		s.idb.debugForceNextTx('quota');
		const id = await s.perf.saveDocument(s.perf.lightWindow(300, { name: 'quota victim' }));
		const dbg = s.perf.recorderDebug();
		return { id, got: !!(await s.perf.getRecording(id)), failures: dbg.storeFailures, mem: dbg.memoryKeys };
	});
	h.check(fb.got && fb.failures >= 1 && fb.mem.includes('perf:rec:' + fb.id), `a quota failure keeps the recording for the session (failures ${fb.failures})`);

	// ---- 8. overhead (desktop; the Quest number is owed on device / via the beacon)
	const oh = await page.evaluate(async () => {
		const p = window.__stores.perf;
		p.measureOverhead(true);
		p.startRecording({ mode: 'light', name: 'overhead' });
		await new Promise((r) => setTimeout(r, 3000));
		const o = p.perfOverhead();
		p.measureOverhead(false);
		await p.stopRecording();
		return o;
	});
	console.log(`OVERHEAD light (recording on): ${oh.frames} frames, mean ${oh.meanMs.toFixed(4)} ms, max ${oh.maxMs.toFixed(3)} ms`);
	h.check(oh.frames > 20 && oh.meanMs < 0.3, `light-mode hot path costs < 0.3 ms/frame (mean ${oh.meanMs.toFixed(4)} ms)`);

	await h.finish(browser);
});
