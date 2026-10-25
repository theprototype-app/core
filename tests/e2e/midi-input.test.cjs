// 75 MU1 — Web MIDI input: a hardware keyboard plays the music devices.
//
// The browser's MIDI layer is FAKED by an init script (no real device exists headless): one
// input whose messages the suite injects, a permission state that remembers a grant the way a
// browser does, and a counter of every requestMIDIAccess call — the thing the permission rule
// is about. Two peers: a key on A sounds on B through the ordinary device-note path (nothing
// new on the wire), a held key holds on B and its release releases on B, a device that cannot
// hold gets plain notes and no offs, the pedal defers the offs, an off follows its note to the
// device it started on, a reload reconnects only when the permission is already granted, a
// refusal says what to do, and the row works on the N6 folded and unfolded.
const h = require('./helpers.cjs');
const fs = require('node:fs');

const EVIDENCE = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-75/75-music';

const FAKE_MIDI = () => {
	const cfg = () => {
		try {
			return JSON.parse(localStorage.getItem('__fakeMidi') || '{}');
		} catch {
			return {};
		}
	};
	const input = { id: 'fake-in-1', name: 'Fake Keys 49', manufacturer: 'E2E', state: 'connected', type: 'input', onmidimessage: null };
	const access = { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null, sysexEnabled: false };
	const fake = {
		requests: 0,
		calls: [],
		input,
		send(bytes) {
			input.onmidimessage?.({ data: new Uint8Array(bytes), target: input });
		},
		plug(name) {
			const extra = { id: 'fake-in-2', name, manufacturer: 'E2E', state: 'connected', type: 'input', onmidimessage: null };
			access.inputs.set(extra.id, extra);
			access.onstatechange?.({ port: extra });
		}
	};
	Object.defineProperty(window, '__fakeMidi', { value: fake });
	Object.defineProperty(navigator, 'requestMIDIAccess', {
		configurable: true,
		value: async (opts) => {
			fake.requests++;
			fake.calls.push(opts);
			if (cfg().deny) throw new DOMException('The user denied MIDI', 'NotAllowedError');
			localStorage.setItem('__fakeMidiGranted', '1'); // the browser remembers a grant
			return access;
		}
	});
	const query = navigator.permissions.query.bind(navigator.permissions);
	navigator.permissions.query = async (d) =>
		d && d.name === 'midi' ? { state: localStorage.getItem('__fakeMidiGranted') === '1' ? 'granted' : 'prompt' } : query(d);
};

const inPage = (page, body, arg) =>
	page.evaluate(
		([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'mi', 'arg', src)(window.__stores, window.__stores.audioDevices, window.__stores.midiInput, a),
		[body, arg ?? null]
	);

// a device that HOLDS (an oscillator per key until its off) and one that does not
const KINDS =
	"window.__notes = [];" +
	"ad.registerAudioDevice({ kind: 'mi-hold', label: 'MI hold', heldNotes: true, ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }, params: []," +
	"  build(ctx) { const out = ctx.createGain(); out.connect(window.__stores.audioEngine.bus('instruments')); return { output: out, out, ctx, voices: new Map(), dispose() { for (const o of this.voices.values()) o.stop(); out.disconnect(); } }; }," +
	"  onNote(hd, e) { window.__notes.push({ kind: 'hold', note: e.note, velocity: e.velocity, gate: e.gate, off: !!e.off });" +
	"    if (e.off) { const v = hd.voices.get(e.note); if (v) { v.stop(); hd.voices.delete(e.note); } return; }" +
	"    const o = hd.ctx.createOscillator(); o.frequency.value = 440 * 2 ** ((e.note - 69) / 12); const g = hd.ctx.createGain(); g.gain.value = 0.3 * e.velocity; o.connect(g); g.connect(hd.out); o.start(); hd.voices.set(e.note, o); } });" +
	"ad.registerAudioDevice({ kind: 'mi-plain', label: 'MI plain', ports: { in: [], out: [] }, params: []," +
	"  build() { return { dispose() {} }; }," +
	"  onNote(hd, e) { window.__notes.push({ kind: 'plain', note: e.note, velocity: e.velocity, gate: e.gate, off: !!e.off }); } });" +
	'return ad.devicesDebug().kinds';

const notesOf = (page) => page.evaluate(() => window.__notes.slice());
const clearNotes = (page) => page.evaluate(() => (window.__notes.length = 0));
const send = (page, bytes) => page.evaluate((b) => window.__fakeMidi.send(b), bytes);
const openToolbox = async (page) => {
	await page.evaluate(() => window.__stores.moduleToolboxes.openModuleToolbox('mod-core-music'));
	await page.waitForSelector('#music-midi', { timeout: 8000 });
};
const midiOf = (page) => page.evaluate(() => ({ state: (() => { let v; window.__stores.midiInput.midiState.subscribe((x) => (v = x))(); return v; })(), debug: window.__stores.midiInput.midiDebug(), fake: { requests: window.__fakeMidi.requests, calls: window.__fakeMidi.calls } }));

h.run(async () => {
	fs.mkdirSync(EVIDENCE, { recursive: true });
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true, init: FAKE_MIDI });
	const page = A.page;
	await inPage(page, KINDS);
	const B = await h.setupPage(browser, 'B', { audio: true, init: FAKE_MIDI });
	await inPage(B.page, KINDS);
	await h.connect(B, A);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. nothing is asked at boot ===');
	await page.waitForTimeout(1500);
	const boot = await midiOf(page);
	h.check(boot.fake.requests === 0, '1.1 a fresh boot never calls requestMIDIAccess (' + boot.fake.requests + ')');
	h.check(boot.state.status === 'off', '1.2 the status is off (' + boot.state.status + ')');
	await openToolbox(page);
	h.check(await page.locator('#midi-connect').isVisible(), "1.3 the Music toolbox offers 'Connect MIDI keyboard'");

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the first use explains, then asks the browser once ===');
	await page.locator('#midi-connect').click();
	await page.waitForSelector('#midi-explain', { timeout: 3000 });
	const explain = (await page.locator('#midi-explain').textContent()) ?? '';
	h.check(/browser will ask/i.test(explain) && /everyone in the session/i.test(explain), '2.1 the first press explains the prompt and that the session hears the notes');
	h.check((await midiOf(page)).fake.requests === 0, '2.2 ...and has not asked the browser yet');
	await page.locator('#midi-not-now').click();
	h.check((await midiOf(page)).fake.requests === 0 && (await page.locator('#midi-connect').isVisible()), '2.3 Not now asks nothing and goes back to the button');
	await page.locator('#midi-connect').click();
	await page.locator('#midi-allow').click();
	await h.eventually(() => midiOf(page), (m) => m.state.status === 'on', '2.4 Allow MIDI connects (status on)');
	const asked = await midiOf(page);
	h.check(asked.fake.requests === 1 && asked.fake.calls[0]?.sysex === false, '2.5 the browser was asked ONCE, sysex off (' + JSON.stringify(asked.fake.calls) + ')');
	h.check(((await page.locator('#midi-inputs').textContent()) ?? '').includes('Fake Keys 49'), '2.6 the row names the input');
	await page.evaluate(() => window.__fakeMidi.plug('Fake Pads'));
	await h.eventually(() => page.locator('#midi-inputs').textContent(), (t) => (t ?? '').includes('Fake Pads'), '2.7 a hot-plugged input appears in the row');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. a held key on A holds on B, its release releases on B ===');
	const ids = await inPage(page, "const hold = ad.addDevice('mi-hold', { position: [0, 0, 0], name: 'Hold synth' }); const plain = ad.addDevice('mi-plain', { position: [2, 0, 0], name: 'Plain keys' }); return { hold: hold.uuid, plain: plain.uuid }");
	await h.eventually(() => inPage(B.page, 'return ad.devicesDebug().built.map((b) => b.uuid)'), (u) => u.includes(ids.hold) && u.includes(ids.plain), '3.0 both devices are built on B');
	await inPage(page, 's.objectActions.selectObject(arg)', ids.hold);
	await page.waitForTimeout(300);
	h.check((await midiOf(page)).debug.target === ids.hold, '3.1 with nothing picked, MIDI follows the selected device');
	await inPage(page, 's.objectActions.deselectObject()');
	await page.waitForTimeout(200);
	h.check((await midiOf(page)).debug.target === ids.hold, '3.2 deselecting keeps playing the last selected device');
	await clearNotes(page);
	await clearNotes(B.page);
	await page.waitForTimeout(400);
	h.check((await h.audioMetrics(B, 400)).silent, '3.3 B is silent before the key');
	await send(page, [0x90, 60, 100]);
	await h.eventually(() => notesOf(B.page), (n) => n.some((e) => e.kind === 'hold' && e.note === 60 && !e.off), '3.4 the key-down reaches B as a note on the hold device');
	const on = (await notesOf(B.page)).find((e) => e.note === 60 && !e.off);
	h.check(on.gate === 0 && Math.abs(on.velocity - 100 / 127) < 1e-6, '3.5 a HELD note: gate 0, velocity 100/127 (' + JSON.stringify(on) + ')');
	h.check(((await page.locator('#midi-last').textContent()) ?? '').includes('C4'), '3.6 the row shows the note that arrived (C4)');
	await page.waitForTimeout(1500);
	const held = await h.audioMetrics(B, 500);
	h.check(!held.silent, '3.7 B still sounds 1.5 s into the hold (peak ' + held.peak.toFixed(3) + ')');
	await send(page, [0x80, 60, 0]);
	await h.eventually(() => notesOf(B.page), (n) => n.some((e) => e.note === 60 && e.off), '3.8 the key-up reaches B as an off');
	await page.waitForTimeout(300);
	h.check((await h.audioMetrics(B, 400)).silent, '3.9 and B is silent again');
	h.check((await notesOf(page)).filter((e) => e.note === 60).length === 2, '3.10 A played the same two events locally');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. a device that cannot hold gets plain notes and NO offs ===');
	await page.selectOption('#midi-target', ids.plain);
	await clearNotes(page);
	await clearNotes(B.page);
	await send(page, [0x90, 64, 127]);
	await send(page, [0x90, 64, 0]); // a note-on at velocity 0 is the running-status off
	await h.eventually(() => notesOf(B.page), (n) => n.some((e) => e.kind === 'plain' && e.note === 64), '4.1 the note reaches B on the picked device');
	await page.waitForTimeout(600);
	const plain = await notesOf(B.page);
	h.check(plain.length === 1 && plain[0].gate === undefined && !plain[0].off, '4.2 one plain note, no gate, no off (' + JSON.stringify(plain) + ')');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. the sustain pedal defers the offs ===');
	await page.selectOption('#midi-target', ids.hold);
	await clearNotes(B.page);
	await send(page, [0x90, 62, 90]);
	await send(page, [0xb0, 64, 127]);
	await send(page, [0x80, 62, 0]);
	await page.waitForTimeout(700);
	h.check(!(await notesOf(B.page)).some((e) => e.off), '5.1 a key released under the pedal sends no off');
	h.check(!(await h.audioMetrics(B, 300)).silent, '5.2 and keeps sounding on B');
	await send(page, [0xb0, 64, 0]);
	await h.eventually(() => notesOf(B.page), (n) => n.some((e) => e.note === 62 && e.off), '5.3 lifting the pedal sends the off');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. an off follows its note to the device it started on ===');
	await clearNotes(B.page);
	await send(page, [0x90, 67, 90]);
	await h.eventually(() => notesOf(B.page), (n) => n.some((e) => e.note === 67), '6.0 the note started on the hold device');
	await page.selectOption('#midi-target', ids.plain);
	await send(page, [0x80, 67, 0]);
	await h.eventually(() => notesOf(B.page), (n) => n.some((e) => e.kind === 'hold' && e.note === 67 && e.off), '6.1 the off went to the HOLD device after the target moved');
	h.check(!(await notesOf(B.page)).some((e) => e.kind === 'plain'), '6.2 and nothing reached the new target');
	await page.selectOption('#midi-target', '');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. a reload reconnects only when the permission is already granted ===');
	await h.freshReload(A);
	await h.answerRestore(A);
	await h.eventually(() => midiOf(page), (m) => m.state.status === 'on', '7.1 granted + connected before: back on after the reload with no click');
	h.check((await midiOf(page)).fake.requests === 1, '7.2 the silent resume asked the browser once (a granted permission shows no prompt)');
	await page.evaluate(() => localStorage.removeItem('__fakeMidiGranted')); // the user reset the site permission
	await h.freshReload(A);
	await h.answerRestore(A);
	await page.waitForTimeout(1500);
	const reset = await midiOf(page);
	h.check(reset.fake.requests === 0 && reset.state.status === 'off', '7.3 permission back at prompt: the reload asks NOTHING and waits for the button (' + reset.fake.requests + ', ' + reset.state.status + ')');

	// ---------------------------------------------------------------- section 8
	console.log('\n=== 8. a refusal says what to do ===');
	await inPage(page, KINDS);
	await page.evaluate(() => localStorage.setItem('__fakeMidi', JSON.stringify({ deny: true })));
	await openToolbox(page);
	await page.locator('#midi-connect').click(); // connected here before: no explanation this time
	await page.waitForSelector('#midi-status', { timeout: 3000 });
	const denied = (await page.locator('#midi-status').textContent()) ?? '';
	h.check(/blocked/i.test(denied) && /site settings/i.test(denied), '8.1 denied: "' + denied.trim() + '"');
	h.check(await page.locator('#midi-retry').isVisible(), '8.2 with a Try again');
	await page.evaluate(() => localStorage.removeItem('__fakeMidi'));
	await page.locator('#midi-retry').click();
	await h.eventually(() => midiOf(page), (m) => m.state.status === 'on', '8.3 allowed afterwards, Try again connects');
	await page.locator('#music-midi').screenshot({ path: EVIDENCE + '/01-midi-row-dark.png' });
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(300);
	await page.locator('#music-midi').screenshot({ path: EVIDENCE + '/02-midi-row-light.png' });
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await page.locator('#midi-disconnect').click();
	h.check((await midiOf(page)).state.status === 'off' && (await page.evaluate(() => localStorage.getItem('midiInput'))) === '0', '8.4 Disconnect stops and remembers it');

	// ---------------------------------------------------------------- section 9
	console.log('\n=== 9. the N6, folded and unfolded ===');
	const UA = 'Mozilla/5.0 (Linux; Android 16; CPH2765) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
	for (const [name, vp] of [['folded', { width: 380, height: 792 }], ['unfolded', { width: 749, height: 747 }]]) {
		const P = await h.setupPage(browser, 'n6-' + name, { init: FAKE_MIDI, context: { viewport: vp, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA } });
		await inPage(P.page, KINDS);
		await inPage(P.page, "ad.addDevice('mi-hold', { position: [0, 0, 0], name: 'Hold synth' })");
		await openToolbox(P.page);
		await P.page.locator('#music-midi').scrollIntoViewIfNeeded();
		const box = await P.page.locator('#midi-connect').boundingBox();
		h.check(!!box && box.x >= 0 && box.x + box.width <= vp.width && box.height >= 24, '9.1 ' + name + ': the Connect button is on screen and tappable (' + JSON.stringify(box && { x: Math.round(box.x), w: Math.round(box.width), h: Math.round(box.height) }) + ')');
		await P.page.locator('#midi-connect').tap();
		await P.page.locator('#midi-allow').tap();
		await h.eventually(() => midiOf(P.page), (m) => m.state.status === 'on', '9.2 ' + name + ': tap, Allow, connected');
		const wide = await P.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
		h.check(wide, '9.3 ' + name + ': no sideways page scroll');
		await P.page.screenshot({ path: EVIDENCE + '/0' + (name === 'folded' ? 3 : 4) + '-n6-' + name + '.png' });
		await P.ctx.close();
	}

	await h.finish(browser);
});
