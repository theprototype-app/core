// 77 C2 — THE IN-BROWSER CAPTIONS MODULE (modules repo `captions`: Moonshine via transformers.js 4).
//
//   1. installing captions.zip registers a LOCAL English engine through api.captions.registerEngine
//      (namespaced `mod-captions-moonshine`); Settings ▸ Accessibility ▸ Caption engine offers
//      "On this device"
//   2. the install-time download: the three pinned runtime files land in Cache Storage
//      `tp-ml-runtime` (checksums verified by the module), the model in `transformers-cache`;
//      the bytes are recorded (download size)
//   3. transcription of a real speech clip (the public-domain JFK inaugural excerpt the
//      transformers.js docs use, fetched at run time, never committed): the words come out, and the
//      REAL-TIME FACTOR is recorded; no request leaves for a speech server
//   4. Timeline ▸ Caption the speech, engine Auto → the module (no server configured): cues on an
//      "Auto captions" track inside the clip's window
//   5. ONE cached copy: a second runtime load (a reload of the app) fetches NOTHING from jsDelivr
//   6. unloading the module takes the engine away (lifecycle-tracked registration)
// Downloads ~40 MB from jsDelivr + huggingface.co on a fresh profile, so it is NOT in the battery.
// Needs MODULES_REPO=<modules checkout with captions.zip packed>.
// Run: e2e-slot --dev <lane> 5661 -- env APP_URL=https://localhost:5661/ MODULES_REPO=<modules> npm run e2e -- captions-module
// Evidence: CAPTIONS_EVIDENCE=<dir> writes measurements.json.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const EVIDENCE = process.env.CAPTIONS_EVIDENCE || '';
const JFK = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';

async function until(fn, timeout = 10000, every = 500) {
	const t0 = Date.now();
	let v = null;
	while (Date.now() - t0 < timeout) {
		v = await fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, every));
	}
	return v;
}

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	/** @type {string[]} */
	const net = [];
	page.on('request', (r) => {
		const u = r.url();
		if (/jsdelivr|huggingface|stt\.|openai|groq/.test(u)) net.push(u);
	});

	// ---------- 1. install ----------
	const installed = await h.installModule(A, 'captions');
	h.check(installed, '1.0 captions.zip installs (MODULES_REPO=' + (process.env.MODULES_REPO || '(default)') + ')');
	if (!installed) return h.finish(browser);
	const eng = await until(() => page.evaluate(() => {
		let v;
		window.__stores.captionEngines.captionEngines.subscribe((x) => (v = x))();
		const e = v.find((x) => x.id === 'mod-captions-moonshine');
		return e ? { id: e.id, local: e.local, languages: e.languages, label: e.label, owner: e.owner } : null;
	}), 10000);
	h.check(!!eng && eng.local === true && JSON.stringify(eng.languages) === '["en"]' && eng.owner === 'captions', `1.1 a local English engine is registered (${JSON.stringify(eng)})`);

	// ---------- 2. the install-time download ----------
	const t0 = Date.now();
	const dl = await until(() => page.evaluate(() => {
		const m = globalThis.__captionsModule;
		return m && (m.status.state === 'idle' || m.status.state === 'ready') && m.status.pct === 100 ? { ...m.status } : m?.status.state === 'error' ? { ...m.status } : null;
	}), 300000, 1000);
	const downloadS = (Date.now() - t0) / 1000;
	h.check(!!dl && dl.state !== 'error', `2.1 the runtime + model download completes after install (${downloadS.toFixed(1)} s, ${JSON.stringify(dl && { state: dl.state, error: dl.error })})`);
	const caches = await page.evaluate(async () => {
		const rt = await (await caches.open('tp-ml-runtime')).keys();
		const tc = await (await caches.open('transformers-cache')).keys();
		return { runtime: rt.map((r) => r.url), model: tc.map((r) => r.url) };
	});
	h.check(caches.runtime.length === 3 && caches.runtime.every((u) => u.startsWith('https://cdn.jsdelivr.net/npm/')), `2.2 the three pinned runtime files are in Cache Storage tp-ml-runtime (${caches.runtime.length})`);
	h.check(caches.model.some((u) => /moonshine-tiny-ONNX.*encoder_model_quantized\.onnx/.test(u)) && caches.model.some((u) => /decoder_model_merged_quantized\.onnx/.test(u)), `2.3 the 8-bit Moonshine tiny model is in transformers-cache (${caches.model.length} files)`);
	const modelBytes = Object.values(dl?.modelFiles ?? {}).reduce((a, b) => a + b, 0);
	console.log(`  download: runtime ${(dl?.runtimeBytes / 1e6).toFixed(1)} MB (uncompressed), model ${(modelBytes / 1e6).toFixed(1)} MB, ${downloadS.toFixed(1)} s, load ${dl?.loadMs} ms`);

	// ---------- 3. a real speech clip ----------
	const run = await page.evaluate(async (url) => {
		const S = window.__stores;
		const jobs = S.captionJobs;
		const bytes = await (await fetch(url)).arrayBuffer();
		const ctx = new AudioContext();
		const buffer = await ctx.decodeAudioData(bytes);
		const pcm = await jobs.toCaptionPcm(buffer);
		const t0 = performance.now();
		const out = await jobs.transcribePcm(pcm, { engine: 'auto' });
		const ms = performance.now() - t0;
		return { engine: out.engine, text: out.segments.map((s) => s.text).join(' '), segments: out.segments.length, seconds: pcm.length / 16000, ms, rtf: ms / 1000 / (pcm.length / 16000), moduleRtf: globalThis.__captionsModule.status.rtf };
	}, JFK);
	const words = run.text.toLowerCase();
	h.check(run.engine === 'mod-captions-moonshine' && /ask not/.test(words) && /country/.test(words), `3.1 Auto picks the module and the words come out ("${run.text.slice(0, 90)}…")`);
	h.check(run.rtf > 0 && run.rtf < 1, `3.2 faster than real time on this desktop: RTF ${run.rtf.toFixed(3)} (${run.seconds.toFixed(1)} s of speech in ${(run.ms / 1000).toFixed(2)} s, first run incl. model load)`);
	const warm = await page.evaluate(async (url) => {
		const jobs = window.__stores.captionJobs;
		const ctx = new AudioContext();
		const pcm = await jobs.toCaptionPcm(await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()));
		const t0 = performance.now();
		await jobs.transcribePcm(pcm, { engine: 'auto' });
		return (performance.now() - t0) / 1000 / (pcm.length / 16000);
	}, JFK);
	console.log(`  RTF warm: ${warm.toFixed(3)}`);
	h.check(!net.some((u) => /audio\/transcriptions/.test(u)), '3.3 no audio went to a speech server');

	// ---------- 4. Timeline auto-caption through the module ----------
	const auto = await page.evaluate(async (url) => {
		const S = window.__stores;
		const bytes = await (await fetch(url)).arrayBuffer();
		const item = await S.explorer.addItemFromBytes(bytes, 'jfk.wav');
		const id = S.sequences.createSequence('Speech');
		S.sequences.updateSequence(id, { duration: 20 });
		const tr = S.sequences.addTrack(id, 'audio');
		S.sequences.addItem(id, tr, { t: 2, dur: 11, sound: item.hash, name: 'jfk.wav' });
		const res = await S.captionJobs.autoCaption(id);
		let all;
		S.sequences.sequences.subscribe((v) => (all = v))();
		const cap = all[id].tracks.find((t) => t.kind === 'caption');
		return { res, items: cap?.items?.map((i) => ({ t: i.t, dur: i.dur, text: i.text })) ?? [] };
	}, JFK);
	h.check(auto.res.engine === 'mod-captions-moonshine' && auto.items.length >= 2 && auto.items.every((i) => i.t >= 2 && i.t + i.dur <= 13.01) && auto.items.map((i) => i.text).join(' ').toLowerCase().includes('country'), `4.1 Caption the speech → ${auto.items.length} cues inside the clip window (${JSON.stringify(auto.items.slice(0, 3))})`);

	// ---------- 5. one cached copy ----------
	net.length = 0;
	await h.freshReload(A);
	await h.answerRestore(A).catch(() => false);
	await until(() => page.evaluate(() => !!globalThis.__captionsModule), 30000);
	await page.evaluate(() => globalThis.__captionsModule.ensureReady());
	const again = net.filter((u) => /jsdelivr/.test(u));
	const hf = net.filter((u) => /huggingface\.co\/onnx-community/.test(u) && /\.onnx/.test(u));
	h.check(again.length === 0, `5.1 a reload loads the runtime from tp-ml-runtime: 0 jsDelivr requests (${again.length})`);
	h.check(hf.length === 0, `5.2 … and the model from transformers-cache: 0 model downloads (${hf.length})`);
	const st2 = await page.evaluate(() => ({ ...globalThis.__captionsModule.status }));
	h.check(st2.runtimeCached === 3 && st2.runtimeBytes === 0, `5.3 the module counted 3 cache hits, 0 bytes fetched (${st2.runtimeCached}, ${st2.runtimeBytes})`);

	// ---------- 6. unload ----------
	const gone = await page.evaluate(async () => {
		const S = window.__stores;
		await S.moduleSDK.unloadModule?.('captions');
		let v;
		S.captionEngines.captionEngines.subscribe((x) => (v = x))();
		return { engines: v.map((e) => e.id), global: !!globalThis.__captionsModule };
	});
	h.check(!gone.engines.includes('mod-captions-moonshine') && !gone.global, `6.1 unloading the module removes its engine (${JSON.stringify(gone)})`);

	if (EVIDENCE) {
		fs.mkdirSync(EVIDENCE, { recursive: true });
		fs.writeFileSync(
			path.join(EVIDENCE, 'measurements.json'),
			JSON.stringify({ when: new Date().toISOString(), profile: 'desktop (Deck, headless Chromium, WASM, 1 thread)', downloadSeconds: downloadS, runtimeBytesUncompressed: dl?.runtimeBytes, modelBytes, modelFiles: dl?.modelFiles, loadMs: dl?.loadMs, speechSeconds: run.seconds, rtfFirst: run.rtf, rtfWarm: warm, text: run.text }, null, 2)
		);
	}
	await h.finish(browser);
});
