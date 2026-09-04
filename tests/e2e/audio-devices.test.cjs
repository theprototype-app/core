// #23 A3 — audio devices: the registry, the userData.device contract, the placeholder.
//
// A device is an OBJECT whose whole configuration rides userData.device, so what has
// to be proven is that the existing carriers carry it — duplicate, undo, a session
// round trip, the GLTF autosave — and that a peer WITHOUT the kind gets an inert
// placeholder whose data survives a round trip back through them. The test kind is
// a drone oscillator whose params are AUDIBLE (gain, frequency), so every carrier is
// asserted through the tap and not only through the document.
const h = require('./helpers.cjs');

const ad = (page, body, arg) =>
	page.evaluate(
		([src, a]) =>
			Object.getPrototypeOf(async function () {}).constructor('ad', 'eng', 's', 'arg', src)(
				window.__stores.audioDevices,
				window.__stores.audioEngine,
				window.__stores,
				a
			),
		[body, arg ?? null]
	);

/** the test kind, registered IN the page (a module would do exactly this through A5) */
const TEST_KIND =
	"window.__devCalls = window.__devCalls || []; window.__devNotes = window.__devNotes || [];" +
	'return {' +
	"  kind: 'test-osc', label: 'Test oscillator', group: 'test'," +
	"  ports: { in: [], out: [{ id: 'out', label: 'Out', kind: 'audio' }] }," +
	'  params: [' +
	"    { key: 'freq', label: 'Frequency', kind: 'range', min: 100, max: 2000, step: 1, default: 440, unit: 'Hz' }," +
	"    { key: 'gain', label: 'Level', kind: 'range', min: 0, max: 1, step: 0.01, default: 0 }" +
	'  ],' +
	'  build(ctx, node, params) {' +
	"    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = params.freq;" +
	'    const amp = ctx.createGain(); amp.gain.value = params.gain;' +
	"    osc.connect(amp); amp.connect(eng.bus('instruments')); osc.start();" +
	'    return { output: amp, input: null, osc, amp, dispose() { osc.stop(); osc.disconnect(); amp.disconnect(); } };' +
	'  },' +
	"  onParam(hd, key, value) { window.__devCalls.push([key, value]); if (key === 'freq') hd.osc.frequency.value = value; if (key === 'gain') hd.amp.gain.value = value; }," +
	'  onNote(hd, ev) { window.__devNotes.push(ev); const v = eng.oscVoice({ freq: 440 * Math.pow(2, (ev.note - 69) / 12), gain: 0.5 * ev.velocity, attack: 0.005, decay: 0.05, sustain: 0.3, release: 0.1 }); const at = eng.audioTimeFor(ev.at); v.start(at); v.stop(at + 0.25); setTimeout(() => v.dispose(), 900); }' +
	'};';
const REGISTER = 'window.__unregTest = ad.registerAudioDevice((function () { ' + TEST_KIND + ' })()); return ad.devicesDebug().kinds';

const builtOn = (page) => ad(page, 'return ad.devicesDebug().built');
/** the pitch of a steady tone: the strongest FFT bin, sampled 20x and taken at the loudest
 * moment. The harness's centroid is a magnitude-weighted MEAN, which a quiet sine drone
 * lets the noise floor pull around (measured 465 and 2095 Hz for 880 and 550) - a
 * dominant bin is what a sine actually has. Resolution is one bin, ~23 Hz at 48 kHz. */
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
const docOn = (page, uuid) => ad(page, 'const o = s.objectsGroup && (await new Promise((r) => s.objectsGroup.subscribe(r)())).getObjectByProperty("uuid", arg); return o ? { name: o.name, device: o.userData.device ?? null, physics: o.userData.physics ?? null, castShadow: o.castShadow } : null', uuid);

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the registry ===');
	const before = await ad(page, 'return ad.devicesDebug().kinds');
	h.check(!before.includes('test-osc'), '1.1 (premise) the test kind is not registered yet');
	const kinds = await ad(page, REGISTER);
	h.check(kinds.includes('test-osc'), '1.2 registerAudioDevice adds the kind (' + kinds.join(',') + ')');
	const cat = await ad(page, "return { entry: ad.deviceCatalog().find((k) => k.kind === 'test-osc'), defaults: ad.defaultDeviceParams('test-osc'), unknown: ad.deviceSpec('nope'), unknownDefaults: ad.defaultDeviceParams('nope') }");
	h.check(cat.entry && cat.entry.label === 'Test oscillator' && cat.entry.params.length === 2 && cat.entry.ports.out.length === 1, '1.3 the catalogue carries label, params and ports');
	h.check(cat.defaults.freq === 440 && cat.defaults.gain === 0, '1.4 defaults come from the params list');
	h.check(cat.unknown === null && Object.keys(cat.unknownDefaults).length === 0, '1.5 an unknown kind has no spec and no defaults we could invent');
	const rejects = await ad(page, "try { ad.registerAudioDevice({ kind: 'no-build' }); return false; } catch (e) { return String(e.message).includes('build'); }");
	h.check(rejects, '1.6 a spec without build() is refused at registration, not at first use');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. a device is an object ===');
	const uuid = await ad(page, "const o = ad.addDevice('test-osc', { position: [1, 0, 0] }); return o.uuid");
	h.check(typeof uuid === 'string' && uuid.length > 10, '2.1 addDevice returns an object in the scene');
	let doc = await docOn(page, uuid);
	h.check(doc && doc.device.kind === 'test-osc' && doc.device.params.freq === 440 && doc.device.params.gain === 0, '2.2 userData.device carries {kind, params} with defaults filled (' + JSON.stringify(doc.device) + ')');
	h.check(doc.name === 'Test oscillator' && doc.physics === null && doc.castShadow === false, '2.3 named after the kind, no physics body, no shadow — an instrument is not scenery');
	let built = await builtOn(page);
	h.check(built.length === 1 && built[0].uuid === uuid && built[0].builtAs === 'test-osc' && built[0].fellBackFrom === null && built[0].hasOutput, '2.4 the runtime built its subgraph as the real kind, with an output');

	const quiet = await h.audioMetrics(A, 400);
	h.check(quiet.silent, '2.5 at gain 0 the device is silent (peak ' + quiet.peak.toFixed(4) + ')');
	const snap = await ad(page, "return ad.setDeviceParam(arg, 'gain', 0.3)", uuid);
	h.check(snap && snap.params.gain === 0.3 && snap.params.freq === 440, '2.6 setDeviceParam returns a fresh snapshot with the merge applied');
	const loud = await h.audioMetrics(A, 500);
	const hz440 = await peakHz(page);
	h.check(!loud.silent && Math.abs(hz440 - 440) < 50, '2.7 and it is HEARD at the default pitch (peak ' + loud.peak.toFixed(3) + ', strongest bin ' + Math.round(hz440) + ' Hz)');
	const calls = await ad(page, "ad.setDeviceParam(arg, 'freq', 880); return window.__devCalls.slice(-1)[0]", uuid);
	h.check(calls && calls[0] === 'freq' && calls[1] === 880, '2.8 onParam runs SYNCHRONOUSLY on the local write — a knob needs its sound now');
	const hz880 = await peakHz(page);
	h.check(Math.abs(hz880 - 880) < 50, '2.9 the pitch moved to 880 (strongest bin ' + Math.round(hz880) + ' Hz)');
	const fresh = await ad(page, 'const o = (await new Promise((r) => s.objectsGroup.subscribe(r)())).getObjectByProperty("uuid", arg); const snap = ad.setDeviceParam(arg, "freq", 880); return snap !== o.userData.device && JSON.stringify(snap) === JSON.stringify(o.userData.device)', uuid);
	h.check(fresh, '2.10 the returned snapshot is a copy, never the mutated userData object (a $derived on it would not propagate)');

	// undo / redo through the props history kind
	await page.evaluate(() => window.__stores.history.undo());
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => docOn(page, uuid), (d) => d?.device?.params?.freq === 440, '2.11 two undos take the document back to 440');
	await h.eventually(() => ad(page, 'return window.__devCalls.slice(-1)[0]'), (c) => c && c[0] === 'freq' && c[1] === 440, '2.12 the reconcile re-applied the undone param to the subgraph (onParam freq 440)');
	await page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => docOn(page, uuid), (d) => d?.device?.params?.freq === 880, '2.13 redo brings 880 back');

	// remove the device from the object, and undo that
	await ad(page, 'ad.setDeviceFor(arg, null)', uuid);
	await h.eventually(() => builtOn(page), (b) => b.length === 0, '2.14 setDeviceFor(uuid, null) removes the device and the runtime disposes its subgraph');
	const gone = await h.audioMetrics(A, 400);
	h.check(gone.silent, '2.15 the drone stopped with it (peak ' + gone.peak.toFixed(4) + ')');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => builtOn(page), (b) => b.length === 1 && b[0].params.freq === 880 && b[0].params.gain === 0.3, '2.16 undo restores the device AND rebuilds it with its params');
	const back = await h.audioMetrics(A, 500);
	h.check(!back.silent, '2.17 and it sounds again (peak ' + back.peak.toFixed(3) + ')');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. duplicate, delete, undo ===');
	const cloneUuid = await ad(page, 'const before = ad.listDeviceObjects().map((o) => o.uuid); s.objectActions.duplicateObject(arg); await new Promise((r) => setTimeout(r, 300)); return ad.listDeviceObjects().map((o) => o.uuid).find((u) => !before.includes(u)) ?? null', uuid);
	h.check(!!cloneUuid, '3.1 duplicating a device yields a second device object');
	const cloneDoc = await docOn(page, cloneUuid);
	h.check(cloneDoc && cloneDoc.device.kind === 'test-osc' && cloneDoc.device.params.freq === 880, '3.2 the copy carries the document verbatim (userData is deep-copied by three)');
	await h.eventually(() => builtOn(page), (b) => b.length === 2, '3.3 the runtime built the copy too');
	await ad(page, 's.objectActions.deleteObjectsByUuid([arg])', cloneUuid);
	await h.eventually(() => builtOn(page), (b) => b.length === 1, '3.4 deleting the copy disposes its subgraph');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => builtOn(page), (b) => b.length === 2, '3.5 undoing the delete rebuilds it (the reconcile covers an undone delete)');
	await ad(page, 's.objectActions.deleteObjectsByUuid([arg])', cloneUuid);
	await h.eventually(() => builtOn(page), (b) => b.length === 1, '3.6 (cleanup) deleted again');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. persistence: session and autosave round trips ===');
	await ad(page, "ad.setDeviceParam(arg, 'freq', 660)", uuid);
	const payloadHas = await page.evaluate(() => {
		const p = window.__stores.sessions.buildSessionPayload('devices');
		const obj = p.objects.find((o) => o.object?.userData?.device);
		window.__devPayload = p;
		return obj ? obj.object.userData.device : null;
	});
	h.check(payloadHas && payloadHas.kind === 'test-osc' && payloadHas.params.freq === 660, '4.1 a session payload carries the device on its object (' + JSON.stringify(payloadHas) + ')');
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await h.eventually(() => builtOn(page), (b) => b.length === 0, '4.2 (premise) the scene is cleared and nothing is built');
	await page.evaluate(async () => {
		await window.__stores.sessions.applySession(window.__devPayload);
	});
	await h.eventually(() => builtOn(page), (b) => b.length === 1 && b[0].builtAs === 'test-osc' && b[0].params.freq === 660, '4.3 applying the session brings the device back, built with its params');
	const afterSession = await h.audioMetrics(A, 500);
	const hz660 = await peakHz(page);
	h.check(!afterSession.silent && Math.abs(hz660 - 660) < 50, '4.4 and it sounds at 660 (peak ' + afterSession.peak.toFixed(3) + ', strongest bin ' + Math.round(hz660) + ' Hz)');
	const sessionUuid = (await builtOn(page))[0].uuid;

	// the GLTF autosave: userData rides `extras`; after a reload the kind is NOT registered
	await page.evaluate(() => window.__stores.autosave.saveNow());
	await h.freshReload(A);
	// a reload is a NEW peer: re-read the id or the connect below dials a dead one
	A.id = await page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	await h.eventually(
		() => page.evaluate(() => new Promise((r) => window.__stores.autosave.restoreAvailable.subscribe((v) => r(!!v))())),
		(v) => v === true,
		'4.5 the restore offer appears after the reload'
	);
	await page.evaluate(() => window.__stores.autosave.restoreSnapshot());
	await h.eventually(() => builtOn(page), (b) => b.length === 1, '4.6 the restored object is picked up by the runtime', 8000);
	const restored = await builtOn(page);
	const restoredDoc = await docOn(page, restored[0].uuid);
	h.check(restored[0].builtAs === '__placeholder' && restored[0].fellBackFrom === 'test-osc', '4.7 with the kind unknown after the reload it is built as the PLACEHOLDER, stamped with what it fell back from');
	h.check(restoredDoc.device.kind === 'test-osc' && restoredDoc.device.params.freq === 660 && restoredDoc.device.params.gain === 0.3, '4.8 the document survived the GLTF round trip VERBATIM (' + JSON.stringify(restoredDoc.device) + ')');
	h.check(restored[0].uuid === sessionUuid, '4.9 and the uuid too (the __uuid stamp)');
	await ad(page, REGISTER);
	await h.eventually(() => builtOn(page), (b) => b.length === 1 && b[0].builtAs === 'test-osc' && b[0].fellBackFrom === null, '4.10 registering the kind late REBUILDS it from the placeholder');
	const lateSound = await h.audioMetrics(A, 500);
	const hzLate = await peakHz(page);
	h.check(!lateSound.silent && Math.abs(hzLate - 660) < 50, '4.11 and it sounds as authored (peak ' + lateSound.peak.toFixed(3) + ', strongest bin ' + Math.round(hzLate) + ' Hz)');
	const liveUuid = restored[0].uuid;

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. two peers: a peer WITHOUT the kind ===');
	const B = await h.setupPage(browser, 'B', { audio: true });
	await h.connect(B, A);
	await h.eventually(() => builtOn(B.page), (b) => b.length === 1 && b[0].builtAs === '__placeholder' && b[0].fellBackFrom === 'test-osc', '5.1 B, which never registered the kind, holds the object as a placeholder', 15000);
	const bDoc = await docOn(B.page, liveUuid);
	h.check(bDoc && bDoc.device.kind === 'test-osc' && bDoc.device.params.freq === 660, '5.2 with the document verbatim');
	await ad(page, "ad.setDeviceParam(arg, 'gain', 0.2)", liveUuid);
	await h.eventually(() => docOn(B.page, liveUuid), (d) => d?.device?.params?.gain === 0.2, '5.3 a param written on A lands in B\'s document');
	// B edits the placeholder's document: the data must come BACK to A intact
	await ad(B.page, "ad.setDeviceParam(arg, 'freq', 550)", liveUuid);
	await h.eventually(() => docOn(page, liveUuid), (d) => d?.device?.params?.freq === 550 && d?.device?.params?.gain === 0.2, '5.4 a param written on B through the placeholder reaches A with the rest of the document intact');
	await h.eventually(() => ad(page, 'return window.__devCalls.slice(-1)[0]'), (c) => c && c[0] === 'freq' && c[1] === 550, '5.5 and A\'s real device got onParam for it');
	// the subgraph's OWN frequency is the deterministic read (a centroid at this moment can
	// catch the click of the gain step two writes ago as the loudest sample)
	const aOsc = await ad(page, 'return { freq: ad.deviceHandle(arg).osc.frequency.value, sound: null }', liveUuid);
	const aPitch = await h.audioMetrics(A, 500);
	h.check(aOsc.freq === 550 && !aPitch.silent, '5.6 A\'s oscillator now runs at 550 and is audible (osc ' + aOsc.freq + ' Hz, centroid ' + Math.round(aPitch.centroid) + ', peak ' + aPitch.peak.toFixed(3) + ')');

	// notes: A plays, B (placeholder) stays silent and does not crash; then B learns the kind
	const noteA = await ad(page, "const ev = ad.noteDevice(arg, { note: 69, velocity: 1 }); await new Promise((r) => setTimeout(r, 400)); return { ev, notes: window.__devNotes.length }", liveUuid);
	h.check(noteA.notes === 1 && typeof noteA.ev.at === 'number', '5.7 noteDevice reaches the local onNote with a wall-clock stamp');
	const bIgnored = await ad(B.page, 'return { notes: (window.__devNotes || []).length, errors: 0 }');
	h.check(bIgnored.notes === 0, '5.8 the placeholder on B ignores the note silently');
	const noThrow = await ad(B.page, "return { d: ad.applyRemoteDevice({ uuid: 'nope', device: { kind: 'x', params: {} } }), n: ad.applyRemoteDeviceNote({ uuid: 'nope', note: 60, velocity: 1, at: Date.now() }) }");
	h.check(noThrow.d === false && noThrow.n === false, '5.9 a write or a note for an object that has not arrived is dropped, not thrown (the late-object race)');
	await ad(B.page, REGISTER);
	await h.eventually(() => builtOn(B.page), (b) => b.length === 1 && b[0].builtAs === 'test-osc', '5.10 B registers the kind and its placeholder is rebuilt as the real device');
	const heardOnB = await (async () => {
		const play = ad(page, "ad.noteDevice(arg, { note: 81, velocity: 1 })", liveUuid);
		const read = await h.audioMetrics(B, 700);
		await play;
		const notes = await ad(B.page, 'return window.__devNotes');
		return { read, notes };
	})();
	h.check(heardOnB.notes.length === 1 && heardOnB.notes[0].note === 81, '5.11 a note played on A arrives at B\'s onNote through devicenote');
	h.check(!heardOnB.read.silent, '5.12 and B synthesizes it itself — sound on B (peak ' + heardOnB.read.peak.toFixed(3) + ')');

	// two bugs C1's flight found on the late-joiner path, guarded here
	const placed = await ad(page, "const o = ad.addDevice('test-osc', { position: [3, 4, 5], params: { gain: 0 } }); return o.uuid");
	await h.eventually(() => docOn(B.page, placed).then(async (d) => (d ? await B.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); const o = g.getObjectByProperty('uuid', u); return o ? o.position.toArray() : null; }, placed) : null)), (p) => !!p && Math.abs(p[0] - 3) < 1e-6 && Math.abs(p[1] - 4) < 1e-6 && Math.abs(p[2] - 5) < 1e-6, '5.13 a device added at a position lands at that position on the peer (the matrix is updated before the broadcast)');
	// a device whose mesh() is a GROUP must survive the late-joiner path with its document
	await ad(page, "window.__unregGroup = ad.registerAudioDevice({ kind: 'test-group', label: 'Group device', ports: { in: [], out: [] }, params: [], build() { return { dispose() {} }; }, mesh(THREE) { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: '#8f8' }))); return g; } });");
	const grouped = await ad(page, "const o = ad.addDevice('test-group', { position: [1, 1, 1] }); return { uuid: o.uuid, type: o.type }");
	h.check(grouped.type === 'Group', '5.14 (premise) the device root is a Group');
	const C = await h.setupPage(browser, 'C');
	await ad(C.page, "ad.registerAudioDevice({ kind: 'test-group', label: 'Group device', ports: { in: [], out: [] }, params: [], build() { return { dispose() {} }; } });");
	await h.connect(C, A);
	await h.eventually(() => docOn(C.page, grouped.uuid), (d) => !!d && d.device?.kind === 'test-group', '5.15 a late joiner receives the Group-rooted device WITH its document (the group message carries userData)', 20000);
	await h.eventually(() => builtOn(C.page), (b) => b.some((x) => x.uuid === grouped.uuid && x.builtAs === 'test-group'), '5.16 and builds it');
	await C.ctx.close();
	await ad(page, 's.objectActions.deleteObjectsByUuid([arg.a, arg.b]); window.__unregGroup();', { a: placed, b: grouped.uuid });
	await h.eventually(() => builtOn(page), (b) => b.length === 1, '5.17 (cleanup) the two extra devices are gone');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. the module goes away, and comes back ===');
	await ad(page, 'window.__unregTest()');
	await h.eventually(() => builtOn(page), (b) => b.length === 1 && b[0].builtAs === '__placeholder' && b[0].fellBackFrom === 'test-osc', '6.1 unregistering the kind swaps the device for the placeholder');
	const afterUnreg = await docOn(page, liveUuid);
	h.check(afterUnreg.device.kind === 'test-osc' && afterUnreg.device.params.freq === 550, '6.2 the document is untouched — the intent is kept');
	const silentNow = await h.audioMetrics(A, 400);
	h.check(silentNow.silent, '6.3 and the drone was disposed with the subgraph (peak ' + silentNow.peak.toFixed(4) + ')');
	await ad(page, REGISTER);
	await h.eventually(() => builtOn(page), (b) => b[0]?.builtAs === 'test-osc', '6.4 re-registering restores the real device');
	const guard = await ad(page, "const old = window.__unregTest; ad.registerAudioDevice((function () { " + TEST_KIND + " })()); old(); return ad.devicesDebug().kinds.includes('test-osc')");
	h.check(guard, '6.5 an OLD registration\'s disposer does not remove a NEW registration (the dev-reload guard)');

	await h.finish(browser);
});
