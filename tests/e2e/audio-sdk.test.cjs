// #23 A5 — the SDK seam: api.registerAudioDevice and api.audio.*.
//
// A module supplies a device KIND; core supplies the object, the replication, undo,
// saving, the cables, the clock. What has to be proven: a module-registered kind is
// namespaced, appears in the viewport Add menu, builds and SOUNDS through the engine
// seams (voice / bus / cable / schedule / transport / note / sample); disabling the
// module swaps its devices for placeholders with their documents intact and cancels
// what it scheduled; a dev reload (initModules again) rebuilds them; and a teardown
// that lands right after a registration leaves nothing behind.
const h = require('./helpers.cjs');

const inPage = (page, body, arg) =>
	page.evaluate(
		([src, a]) =>
			Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'ap', 'eng', 'mc', 'arg', src)(
				window.__stores,
				window.__stores.audioDevices,
				window.__stores.audioPatch,
				window.__stores.audioEngine,
				window.__stores.musicClock,
				a
			),
		[body, arg ?? null]
	);

/** the strongest FFT bin (the audio-devices suite's peakHz) */
const peakHz = (page) =>
	page.evaluate(async () => {
		const t = window.__audioTap.all()[0];
		const freq = new Float32Array(t.analyser.frequencyBinCount);
		const binHz = t.context.sampleRate / t.analyser.fftSize;
		let best = -Infinity, bestBin = 0;
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 20));
			t.analyser.getFloatFrequencyData(freq);
			for (let b = 1; b < freq.length; b++) if (freq[b] > best) { best = freq[b]; bestBin = b; }
		}
		return bestBin * binHz;
	});

/** the test module, built IN the page — exactly what a zip's register(api) would do */
const MODULE =
	'window.__sdkEvents = [];' +
	'return {' +
	"  id: 'sdktest', name: 'SDK test', version: '1.0.0', description: 'registers two devices'," +
	'  register(api) {' +
	'    window.__sdkApi = api;' +
	'    window.__sdkKindPromise = api.registerAudioDevice({' +
	"      kind: 'osc', label: 'SDK osc', ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }," +
	"      params: [{ key: 'freq', kind: 'range', min: 100, max: 2000, step: 1, default: 330 }, { key: 'gain', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.3 }]," +
	'      build(ctx, node, p) { const osc = ctx.createOscillator(); osc.frequency.value = p.freq; const amp = ctx.createGain(); amp.gain.value = p.gain; osc.connect(amp); osc.start(); return { output: amp, osc, amp, dispose() { osc.stop(); osc.disconnect(); amp.disconnect(); } }; },' +
	"      onParam(hd, k, v) { if (k === 'freq') hd.osc.frequency.value = v; if (k === 'gain') hd.amp.gain.value = v; }," +
	"      onNote(hd, ev) { window.__sdkEvents.push(['note', ev.note]); }" +
	'    });' +
	"    api.registerAudioDevice({ kind: 'speaker', label: 'SDK speaker', ports: { in: [{ id: 'in', kind: 'audio' }], out: [] }, params: []," +
	"      build(ctx) { const g = ctx.createGain(); g.connect(api.audio.bus('instruments')); return { input: g, dispose() { g.disconnect(); } }; } });" +
	"    api.audio.schedule(0, (e) => window.__sdkEvents.push(['beat', e.beat]), { every: 1 });" +
	'  }' +
	'};';
const INIT = 'const mod = (function () { ' + MODULE + ' })(); window.__sdkMod = mod; s.moduleSDK.initModules([mod]); return true';

const kindsOn = (page) => inPage(page, 'return ad.devicesDebug().kinds');
const builtOn = (page) => inPage(page, 'return ad.devicesDebug().built');

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. a module registers a device kind ===');
	await inPage(page, INIT);
	await h.eventually(() => kindsOn(page), (k) => k.includes('mod-sdktest-osc') && k.includes('mod-sdktest-speaker'), '1.1 both kinds land in the registry, NAMESPACED mod-<module>-<kind>');
	const reg = await inPage(page, "const k = await window.__sdkKindPromise; const spec = ad.deviceSpec(k); return { k, group: spec?.group, label: spec?.label, loaded: s.moduleSDK.loadedModules.some((m) => m.id === 'sdktest') }");
	h.check(reg.k === 'mod-sdktest-osc' && reg.label === 'SDK osc', '1.2 registerAudioDevice resolves to the namespaced kind (' + reg.k + ')');
	h.check(reg.group === 'SDK test' && reg.loaded, '1.3 the group defaults to the module NAME, and the module is listed as loaded');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. it appears in the Add menu ===');
	const menu = await inPage(page, "const items = s.addObjects.buildAddChildren(() => [0, 0, 0]); const groups = items.filter((i) => typeof i.label === 'string' && i.label.startsWith('Devices')); return groups.map((g) => ({ label: g.label, children: g.children.map((c) => ({ label: c.label, kind: c.kind })) }))");
	const devGroup = menu.find((g) => g.children.some((c) => c.kind === 'mod-sdktest-osc'));
	h.check(!!devGroup && devGroup.label === 'Devices: SDK test', '2.1 a Devices group named for the module (' + (devGroup ? devGroup.label : 'none') + ')');
	h.check(!!devGroup && devGroup.children.map((c) => c.label).sort().join(',') === 'SDK osc,SDK speaker', '2.2 with both kinds as entries');
	const viaMenu = await inPage(page, "const items = s.addObjects.buildAddChildren(() => [3, 0, 0]); const entry = items.flatMap((i) => i.children ?? []).find((c) => c.kind === 'mod-sdktest-speaker'); const before = ad.listDeviceObjects().length; entry.action(); await new Promise((r) => setTimeout(r, 200)); const after = ad.listDeviceObjects(); return { before, after: after.length, kind: after[after.length - 1]?.userData.device.kind, uuid: after[after.length - 1]?.uuid }");
	h.check(viaMenu.after === viaMenu.before + 1 && viaMenu.kind === 'mod-sdktest-speaker', '2.3 the menu entry\'s action creates a device object of that kind');
	await inPage(page, 's.objectActions.deleteObjectsByUuid([arg])', viaMenu.uuid);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. api.audio: devices, cables, sound ===');
	const made = await inPage(page, "const api = window.__sdkApi; const osc = api.audio.addDevice('osc', { position: [0, 0, 0] }); const spk = api.audio.addDevice('speaker', { position: [2, 0, 0] }); return { osc: osc?.uuid ?? null, spk: spk?.uuid ?? null, kind: osc?.userData.device.kind, doc: api.audio.device(osc?.uuid) }");
	h.check(made.osc && made.spk && made.kind === 'mod-sdktest-osc', "3.1 api.audio.addDevice('osc') resolves the short name to the module's kind");
	h.check(made.doc && made.doc.params.freq === 330 && made.doc.params.gain === 0.3, '3.2 api.audio.device(uuid) reads the document with defaults (' + JSON.stringify(made.doc.params) + ')');
	await h.eventually(() => builtOn(page), (b) => b.filter((x) => x.builtAs.startsWith('mod-sdktest')).length === 2, '3.3 both build as the real kinds');
	await page.waitForTimeout(200);
	h.check((await h.audioMetrics(A, 400)).silent, '3.4 (premise) uncabled, silent');
	const cableId = await inPage(page, "return window.__sdkApi.audio.cable({ from: { uuid: arg.osc, port: 'out' }, to: { uuid: arg.spk, port: 'in' } })", made);
	h.check(typeof cableId === 'string', '3.5 api.audio.cable plugs one in');
	await page.waitForTimeout(300);
	const cabled = await h.audioMetrics(A, 500);
	const hz = await peakHz(page);
	h.check(!cabled.silent && Math.abs(hz - 330) < 50, '3.6 and the module\'s oscillator is HEARD through the module\'s speaker (peak ' + cabled.peak.toFixed(3) + ', ' + Math.round(hz) + ' Hz)');
	const set = await inPage(page, 'return window.__sdkApi.audio.setParams(arg, { freq: 660 })', made.osc);
	await page.waitForTimeout(200);
	const hz2 = await peakHz(page);
	h.check(set && set.params.freq === 660 && Math.abs(hz2 - 660) < 50, '3.7 api.audio.setParams moves the pitch (' + Math.round(hz2) + ' Hz)');
	const seams = await inPage(page, 'const api = window.__sdkApi; return { bus: api.audio.bus("instruments") === eng.bus("instruments"), ctx: api.audio.context() === eng.ensureAudioContext(), timeFor: Math.abs(api.audio.timeFor(Date.now() + 1000) - eng.audioTimeFor(Date.now() + 1000)) < 0.01 }');
	h.check(seams.bus && seams.ctx && seams.timeFor, '3.8 bus / context / timeFor are the engine\'s own');

	// a voice from the seam
	await inPage(page, 'window.__sdkApi.audio.setParams(arg, { gain: 0 })', made.osc);
	await page.waitForTimeout(200);
	h.check((await h.audioMetrics(A, 400)).silent, '3.9 (premise) drone muted');
	await inPage(page, 'const v = window.__sdkApi.audio.voice({ freq: 550, gain: 0.4 }); v.start(); window.__sdkVoice = v;');
	const voiced = await h.audioMetrics(A, 400);
	const hzV = await peakHz(page);
	await inPage(page, 'window.__sdkVoice.stop(); setTimeout(() => window.__sdkVoice.dispose(), 400);');
	h.check(!voiced.silent && Math.abs(hzV - 550) < 50, '3.10 api.audio.voice makes an engine voice that sounds at its pitch (' + Math.round(hzV) + ' Hz)');
	await page.waitForTimeout(500);
	await inPage(page, 'window.__sdkApi.audio.setParams(arg, { gain: 0.3 })', made.osc);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. api.audio: the transport, schedule, note ===');
	const t0 = await inPage(page, 'return window.__sdkApi.audio.transport()');
	h.check(t0.bpm === 120 && t0.playing === false && t0.beat === 0, '4.1 transport() reads the shared clock (' + JSON.stringify(t0) + ')');
	await inPage(page, "window.__sdkEvents.length = 0; window.__sdkApi.audio.play();");
	await h.eventually(() => inPage(page, "return window.__sdkEvents.filter((e) => e[0] === 'beat').map((e) => e[1])"), (b) => b.length >= 2 && b[0] === 0 && b[1] === 1, '4.2 the metronome the module scheduled at register time fires beat 0, 1, ... once the transport plays');
	await inPage(page, 'window.__sdkApi.audio.setBpm(90)');
	const t1 = await inPage(page, 'return window.__sdkApi.audio.transport()');
	h.check(t1.bpm === 90 && t1.playing === true && t1.beat > 0, '4.3 setBpm / play write the SHARED transport (' + t1.bpm + ' bpm, beat ' + t1.beat.toFixed(2) + ')');
	await inPage(page, 'window.__sdkApi.audio.play(false)');
	const noted = await inPage(page, "window.__sdkApi.audio.note(arg, { note: 64, velocity: 0.8 }); await new Promise((r) => setTimeout(r, 100)); return window.__sdkEvents.filter((e) => e[0] === 'note').map((e) => e[1])", made.osc);
	h.check(noted.length === 1 && noted[0] === 64, '4.4 api.audio.note reaches the device\'s onNote');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. api.audio.sample: an Explorer content hash, decoded ===');
	const sample = await inPage(
		page,
		// a 0.1 s mono 8 kHz PCM16 WAV, made here so the bytes are real audio
		'const rate = 8000, n = 800; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);' +
			'const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };' +
			"w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);" +
			"v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);" +
			'for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), true);' +
			"const item = await s.explorer.addItemFromBytes(buf, 'blip.wav');" +
			'const a = await window.__sdkApi.audio.sample(item.hash); const b = await window.__sdkApi.audio.sample(item.hash);' +
			"const missing = await window.__sdkApi.audio.sample('0000000000000000000000000000000000000000000000000000000000000000', { timeoutMs: 700 });" +
			'return { hash: item.hash, duration: a?.duration ?? null, channels: a?.numberOfChannels ?? null, cached: a === b, missing }'
	);
	h.check(typeof sample.hash === 'string' && sample.duration !== null && Math.abs(sample.duration - 0.1) < 0.01 && sample.channels === 1, '5.1 a seeded Explorer item decodes to an AudioBuffer of the right length (' + (sample.duration ?? 'null') + ' s)');
	h.check(sample.cached === true, '5.2 a second call returns the cached buffer');
	h.check(sample.missing === null, '5.3 a hash nobody has resolves null after its timeout — a pending pull is not a failure');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. disable: placeholders, silence, the metronome stops ===');
	await inPage(page, "s.moduleSDK.deactivateModule('sdktest')");
	await h.eventually(() => kindsOn(page), (k) => !k.some((x) => x.startsWith('mod-sdktest')), '6.1 deactivating the module removes its kinds from the registry');
	await h.eventually(() => builtOn(page), (b) => b.filter((x) => x.fellBackFrom && x.fellBackFrom.startsWith('mod-sdktest')).length === 2, '6.2 its two devices are now placeholders, stamped with what they fell back from');
	const docs = await inPage(page, 'return ad.listDeviceObjects().map((o) => o.userData.device)');
	h.check(docs.length === 2 && docs.every((d) => d.kind.startsWith('mod-sdktest')) && docs.some((d) => d.params.freq === 660), '6.3 the documents are untouched (kind and params kept)');
	await page.waitForTimeout(200);
	h.check((await h.audioMetrics(A, 400)).silent, '6.4 and the drone is gone with its subgraph');
	const afterDisable = await inPage(page, "window.__sdkEvents.length = 0; mc.playTransport(); await new Promise((r) => setTimeout(r, 1200)); mc.stopTransport(); return window.__sdkEvents.filter((e) => e[0] === 'beat').length");
	h.check(afterDisable === 0, '6.5 the metronome the module scheduled was cancelled at teardown (0 beats in 1.2 s of Play)');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. dev reload: initModules again ===');
	await inPage(page, 's.moduleSDK.initModules([window.__sdkMod])');
	await h.eventually(() => builtOn(page), (b) => b.filter((x) => x.builtAs.startsWith('mod-sdktest')).length === 2, '7.1 re-registering rebuilds both devices as the real kinds');
	await page.waitForTimeout(300);
	const reloaded = await h.audioMetrics(A, 500);
	const hzR = await peakHz(page);
	h.check(!reloaded.silent && Math.abs(hzR - 660) < 50, '7.2 the cable still routes them: sound at the authored pitch (' + Math.round(hzR) + ' Hz)');

	// a teardown landing right after a registration must leave nothing behind
	const race = await inPage(page, "const m = { id: 'sdkrace', name: 'Race', version: '1', register(api) { api.registerAudioDevice({ kind: 'x', label: 'X', build: () => ({ dispose() {} }) }); } }; s.moduleSDK.initModules([m]); s.moduleSDK.deactivateModule('sdkrace'); await new Promise((r) => setTimeout(r, 500)); return ad.devicesDebug().kinds.includes('mod-sdkrace-x')");
	h.check(race === false, '7.3 a registration followed by an immediate teardown leaves no kind behind (the late-registration guard)');

	console.log('\n=== 8. Explorer drops onto a module object (23-C2 registerDropHandler) ===');
	// a module takes an AUDIO item dropped on its mesh; core has no placement for those, so
	// without a handler the drop is the old toast. The handler sees the exact mesh under the
	// drop and the item's content hash (what api.audio.sample wants).
	await inPage(page, "window.__drops = []; window.__sdkApi.registerDropHandler((hit, item, target) => { window.__drops.push({ hit: hit?.uuid ?? null, name: hit?.name ?? '', kind: item.kind, hash: item.hash, top: target?.object?.uuid ?? null }); return item.kind === 'audio'; }); s.explorer.explorerItems.update((list) => [...list, { id: 'drop-audio', name: 'kick.wav', kind: 'audio', folderId: null, size: 3, hash: 'hash-kick', thumbnail: null }, { id: 'drop-text', name: 'notes.txt', kind: 'text', folderId: null, size: 3, hash: 'hash-text', thumbnail: null }]); return true");
	const dropDev = await inPage(page, "const o = await window.__sdkApi.audio.addDevice('osc', { position: [0, 0.6, 0] }); await new Promise((r) => setTimeout(r, 300)); return { uuid: o.uuid, world: o.getWorldPosition(new s.THREE.Vector3()).toArray() }");
	const at = await h.projectPoint(page, dropDev.world);
	const toastsBefore = await inPage(page, 'let t; s.toastStore.subscribe((v) => (t = v))(); return t.length');
	await inPage(page, "await s.explorerDrop.dropExplorerItem({ id: 'drop-audio', kind: 'audio', name: 'kick.wav' }, arg.x, arg.y); return true", at);
	await page.waitForTimeout(200);
	const took = await inPage(page, 'return { drops: window.__drops, toast: (() => { let t; s.toastStore.subscribe((v) => (t = v))(); return t.slice(arg).map((x) => String(x?.message ?? x)).join(" | "); })() }', toastsBefore);
	h.check(took.drops.length === 1 && took.drops[0].kind === 'audio' && took.drops[0].hash === 'hash-kick', '8.1 the handler got the audio item with its content hash (' + JSON.stringify(took.drops[0] ?? null) + ')');
	h.check(took.drops[0]?.top === dropDev.uuid && !!took.drops[0]?.hit, '8.2 and the exact mesh under the drop, with the device as the top-level target');
	h.check(!/where they plug in/.test(took.toast), '8.3 a consumed drop shows no \'used where they plug in\' toast (' + JSON.stringify(took.toast) + ')');
	await inPage(page, "await s.explorerDrop.dropExplorerItem({ id: 'drop-text', kind: 'text', name: 'notes.txt' }, arg.x, arg.y); return true", at);
	await page.waitForTimeout(200);
	const declined = await inPage(page, 'return { drops: window.__drops.length, toast: (() => { let t; s.toastStore.subscribe((v) => (t = v))(); return t.slice(arg).map((x) => String(x?.message ?? x)).join(" | "); })() }', toastsBefore);
	h.check(declined.drops === 2 && /where they plug in/.test(declined.toast), '8.4 a drop the handler declines falls through to the old toast (' + JSON.stringify(declined.toast) + ')');
	console.log('\n=== 9. api.audio.previewParams: a live gesture, replicated, no history (23-C4) ===');
	const undoLen = (/** @type {any} */ p) => p.evaluate(() => { let n = 0; window.__stores.history.undoStack.subscribe((v) => (n = v.length))(); return n; });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await h.eventually(() => inPage(B.page, 'return !!ad.findDeviceObject(arg)', dropDev.uuid), (v) => v === true, '9.0 (premise) B holds the device object from the handshake');
	const undoP = await undoLen(page);
	await inPage(page, "window.__sdkApi.audio.previewParams(arg, { freq: 777 }); return true", dropDev.uuid);
	await page.waitForTimeout(150);
	const previewed = await inPage(page, 'return { freq: ad.deviceOf(ad.findDeviceObject(arg))?.params.freq, undo: (() => { let n = 0; s.history.undoStack.subscribe((v) => (n = v.length))(); return n; })() }', dropDev.uuid);
	h.check(previewed.freq === 777 && previewed.undo === undoP, '9.1 a preview applies locally with NO undo entry (' + previewed.freq + ', undo ' + undoP + ' -> ' + previewed.undo + ')');
	await h.eventually(() => inPage(B.page, 'return ad.deviceOf(ad.findDeviceObject(arg))?.params.freq ?? null', dropDev.uuid), (v) => v === 777, '9.2 and it replicated to B');
	await inPage(page, "window.__sdkApi.audio.setParams(arg, { freq: 780 }); return true", dropDev.uuid);
	await page.waitForTimeout(150);
	const committed = await undoLen(page);
	h.check(committed === undoP + 1, '9.3 the commit after the scrub is ONE undo entry (' + undoP + ' -> ' + committed + ')');
	// a gesture whose LAST preview already equals the commit: without  the commit is a
	// no-op and nothing enters history - the undo would then revert some earlier edit
	const before = await inPage(page, 'return window.__sdkApi.audio.device(arg)', dropDev.uuid);
	await inPage(page, "window.__sdkApi.audio.previewParams(arg, { freq: 555 }); return true", dropDev.uuid);
	await page.waitForTimeout(100);
	await inPage(page, "window.__sdkApi.audio.setParams(arg.uuid, { freq: 555 }, { before: arg.before }); return true", { uuid: dropDev.uuid, before });
	await page.waitForTimeout(150);
	const withBefore = await undoLen(page);
	h.check(withBefore === committed + 1, '9.4 a commit equal to its last preview still records ONE entry when it carries the gesture\'s start document (' + committed + ' -> ' + withBefore + ')');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(150);
	const restored = await inPage(page, 'return ad.deviceOf(ad.findDeviceObject(arg))?.params.freq', dropDev.uuid);
	h.check(restored === 780, '9.5 and undo restores the value from BEFORE the gesture, not the last preview (' + restored + ')');

	await inPage(page, "s.moduleSDK.deactivateModule('sdktest')");
	await inPage(page, "await s.explorerDrop.dropExplorerItem({ id: 'drop-audio', kind: 'audio', name: 'kick.wav' }, arg.x, arg.y); return true", at);
	await page.waitForTimeout(200);
	const gone = await inPage(page, 'return window.__drops.length');
	h.check(gone === 2, '8.5 the handler is gone with its module (' + gone + ')');

	await h.finish(browser);
});
