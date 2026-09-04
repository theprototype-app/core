// 23-D1 - sampling infrastructure: a RAW mic capture separate from voice chat, a take
// recorded into the Explorer and shared by hash, the recorded container importable, the
// over-cap take refused BEFORE it starts, and device sample references in the Scene
// manifest. Runs on Chrome's fake media device (a generated signal), so the mic reads
// real bytes with no hardware.
const h = require('./helpers.cjs');
const inPage = (page, body, arg) =>
	page.evaluate(([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'mc', 'ad', 'arg', src)(window.__stores, window.__stores.micCapture, window.__stores.audioDevices, a), [body, arg ?? null]);
const MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

h.run(async () => {
	const browser = await h.launch({ args: [...h.AUDIO_ARGS, ...MEDIA_ARGS] });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const B = await h.setupPage(browser, 'B', { audio: true });
	await h.connect(B, A);
	const page = A.page;

	console.log('\n=== 1. the raw capture is its own stream, live with the mic toggle OFF ===');
	const cap = await inPage(page, "const stream = await mc.captureMicStream(); const track = stream.getAudioTracks()[0]; const st = track.getSettings(); let micOn; s.voiceChat.micActive.subscribe((v) => (micOn = v))(); return { tracks: stream.getAudioTracks().length, enabled: track.enabled, state: track.readyState, aec: st.echoCancellation, ns: st.noiseSuppression, agc: st.autoGainControl, micOn }");
	h.check(cap.tracks === 1 && cap.enabled === true && cap.state === 'live' && cap.micOn === false, '1.1 captureMicStream opens a live, ENABLED track while voice chat\'s mic toggle is off (' + JSON.stringify(cap) + ')');
	h.check(cap.aec === false && cap.ns === false && cap.agc === false, '1.2 with echo cancellation, noise suppression and auto gain OFF (raw)');
	const level = await inPage(page, "const ctx = s.audioEngine.ensureAudioContext(); const stream = await mc.captureMicStream(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an); const buf = new Float32Array(an.fftSize); let peak = 0; for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 20)); an.getFloatTimeDomainData(buf); let sum = 0; for (let k = 0; k < buf.length; k++) sum += buf[k] * buf[k]; peak = Math.max(peak, Math.sqrt(sum / buf.length)); } src.disconnect(); return peak");
	h.check(level > 0.001, '1.3 the captured stream carries SIGNAL with the mic toggle off (rms ' + level.toFixed(4) + ') - a node on the voice stream would read silence here');
	const again = await inPage(page, 'const a = await mc.captureMicStream(); const b = await mc.captureMicStream(); return a === b');
	h.check(again === true, '1.4 a second taker gets the same stream, not a second capture');

	console.log('\n=== 2. a take lands in the Explorer with the right kind and reaches B by hash ===');
	const fmt = await inPage(page, "return { webm: s.explorer.kindOf('take.webm'), ogg: s.explorer.kindOf('take.ogg'), m4a: s.explorer.kindOf('take.m4a'), mime: mc.RECORD_MIME }");
	h.check(fmt.webm === 'audio' && fmt.ogg === 'audio' && fmt.m4a === 'audio', '2.1 the recorded containers are audio to the Explorer (' + fmt.mime + ')');
	const t0 = Date.now();
	const item = await inPage(page, "const p = mc.startRecording({ maxSeconds: 2, name: 'take-a' }); await new Promise((r) => setTimeout(r, 150)); let st; mc.recording.subscribe((v) => (st = v))(); const active = st.active && st.maxSeconds === 2; const it = await p; return { active, item: it ? { name: it.name, kind: it.kind, hash: it.hash, size: it.size } : null }");
	const took = Date.now() - t0;
	h.check(item.active === true, '2.2 while it runs, the recording store says so with its cap (a face can show it)');
	h.check(!!item.item && item.item.kind === 'audio' && /^take-a\.(webm|ogg|m4a)$/.test(item.item.name) && item.item.size > 1000, '2.3 the take ends at the cap and lands as an audio item (' + JSON.stringify(item.item) + ', ' + took + ' ms)');
	h.check(took >= 1900 && took < 4500, '2.4 the cap is a real length (' + took + ' ms for a 2 s take)');
	const decoded = await inPage(page, "const b = await s.moduleSDK.moduleAudioSample ? null : (await s.soundRuntime.sampleBuffer(arg, { timeoutMs: 8000 })); return b ? { seconds: b.duration, ch: b.numberOfChannels } : null", item.item.hash);
	h.check(!!decoded && decoded.seconds > 1.5 && decoded.seconds < 3, '2.5 and decodes through the engine\'s own sample path (' + (decoded ? decoded.seconds.toFixed(2) + ' s' : 'null') + ')');
	await h.eventually(() => B.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), item.item.hash), (v) => v === true, '2.6 B received the bytes by content hash (assetShare)', 20000);

	const bounced = await inPage(page, "const ctx = s.audioEngine.ensureAudioContext(); const osc = ctx.createOscillator(); osc.frequency.value = 440; const dest = ctx.createMediaStreamDestination(); osc.connect(dest); osc.start(); const it = await mc.startRecording({ maxSeconds: 1, name: 'bounce', stream: dest.stream }); osc.stop(); osc.disconnect(); if (!it) return null; const b = await s.soundRuntime.sampleBuffer(it.hash, { timeoutMs: 8000 }); const d = b.getChannelData(0); let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); return { name: it.name, seconds: b.duration, peak }");
	h.check(!!bounced && bounced.seconds > 0.7 && bounced.seconds < 1.6 && bounced.peak > 0.2, '2.7 a take of a NODE (opts.stream, the looper\'s path) lands too, with the node\'s signal in it (' + JSON.stringify(bounced) + ')');

	console.log('\n=== 3. the over-cap take is refused BEFORE recording ===');
	const refused = await inPage(page, "const toasts0 = (() => { let t; s.toastStore.subscribe((v) => (t = v))(); return t.length; })(); const r = await mc.startRecording({ maxSeconds: mc.MAX_RECORD_SECONDS + 1 }); let st; mc.recording.subscribe((v) => (st = v))(); const toasts = (() => { let t; s.toastStore.subscribe((v) => (t = v))(); return t.slice(toasts0).map((x) => String(x?.message ?? x)); })(); return { r, active: st.active, toasts }");
	h.check(refused.r === null && refused.active === false && refused.toasts.some((t) => /at most/.test(t)), '3.1 a take over the visible cap returns null at once, nothing starts, and the toast says the cap (' + refused.toasts.join(' | ') + ')');
	const twice = await inPage(page, "const p = mc.startRecording({ maxSeconds: 1, name: 'take-b' }); await new Promise((r) => setTimeout(r, 100)); const second = await mc.startRecording({ maxSeconds: 1 }); const stopped = mc.stopRecording(); const it = await p; return { second, stopped, got: !!it }");
	h.check(twice.second === null && twice.stopped === true && twice.got === true, '3.2 a second take while one runs is refused; stopRecording ends the running one early and it still lands');

	console.log('\n=== 4. a device\'s sample references enter the Scene manifest ===');
	await inPage(page, "ad.registerAudioDevice({ kind: 'smp-pad', label: 'Pad', ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }, params: [], assets: (p) => (p.sample ? [{ hash: p.sample, name: p.sampleName || 'pad' }] : []), build(ctx) { const g = ctx.createGain(); return { output: g, dispose() {} }; } }); return 1");
	const pad = await inPage(page, "const o = ad.addDevice('smp-pad', { position: [0, 0, 0] }); ad.setDeviceFor(o.uuid, { params: { sample: arg, sampleName: 'take-a' } }); return o.uuid", item.item.hash);
	// the STORE carries itemId; the public sceneAssetList() is the trimmed SDK shape
	const audioList = () => inPage(page, "let list; s.sceneAssets.sceneAssets.subscribe((v) => (list = v))(); return list.filter((e) => e.group === 'audio').map((e) => ({ hash: e.hash, name: e.name, item: !!e.itemId }))");
	// the manifest is a debounced VIEW (400 ms), so it is polled, not read once
	await h.eventually(audioList, (list) => list.some((e) => e.hash === item.item.hash && e.name === 'take-a' && e.item), '4.1 the pad\'s sample is in the manifest by hash, named, with its Explorer item', 5000);
	await inPage(page, "ad.setDeviceFor(arg, { params: { sample: '', sampleName: '' } }); return 1", pad);
	await h.eventually(audioList, (list) => list.length === 0, '4.2 and leaves it the moment nothing references it', 5000);

	await inPage(page, 'mc.releaseMicStream(); return 1');
	await h.finish(browser);
});
