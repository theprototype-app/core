// #23 B3 — the flow param nodes: Device Param, Device Level, Transport, Note Trigger.
// Two peers: automation routes through the replicated graph and every peer evaluates it
// locally — an LFO drives a cutoff identically on both with NO param message on the wire;
// a Note Trigger fires once per peer per pulse (never once per peer per peer); Device
// Level reads non-zero while a note sounds and zero after; Transport is pure of the
// flow clock (the same (data, time) twice gives the same number).
const h = require('./helpers.cjs');
const inPage = (page, body, arg) =>
	page.evaluate(([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'ap', 'mc', 'fr', 'nh', 'arg', src)(window.__stores, window.__stores.audioDevices, window.__stores.audioPatch, window.__stores.musicClock, window.__stores.flowRuntime, window.__stores.nodesHandler, a), [body, arg ?? null]);
const KINDS =
	"window.__flParams = {}; window.__flNotes = [];" +
	"ad.registerAudioDevice({ kind: 'fl-osc', label: 'FL osc', ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }," +
	"  params: [{ key: 'cutoff', kind: 'range', min: 0, max: 1, step: 0.001, default: 0.5 }, { key: 'level', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.3 }]," +
	"  build(ctx, node, p) { const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 220; const f = ctx.createBiquadFilter(); f.frequency.value = 200 + p.cutoff * 4000; const amp = ctx.createGain(); amp.gain.value = p.level; osc.connect(f); f.connect(amp); osc.start(); return { output: amp, f, amp, osc, dispose() { osc.stop(); osc.disconnect(); amp.disconnect(); } }; }," +
	"  onParam(hd, k, v) { window.__flParams[k] = v; if (k === 'cutoff') hd.f.frequency.value = 200 + v * 4000; if (k === 'level') hd.amp.gain.value = v; }," +
	"  onNote(hd, ev) { window.__flNotes.push(ev.note); } });" +
	"ad.registerAudioDevice({ kind: 'fl-spk', label: 'FL speaker', ports: { in: [{ id: 'in', kind: 'audio' }], out: [] }, params: [], build(ctx) { const g = ctx.createGain(); g.connect(window.__stores.audioEngine.bus('instruments')); return { input: g, dispose() { g.disconnect(); } }; } });" +
	"window.__mk = (node, g) => { nh.createFlowNode(node, g); let p; s.peers.subscribe((x) => (p = x))(); if (p) p.send({ type: 'nodecreate', node: nh.serializeNode(node), graphId: g }); }; window.__wire = (edge, g) => { nh.createFlowEdge(edge, g); let p; s.peers.subscribe((x) => (p = x))(); if (p) p.send({ type: 'edgecreate', edge: nh.serializeEdge(edge), graphId: g }); };" +
	'return ad.devicesDebug().kinds';
const cutoffOn = (page, uuid) => inPage(page, 'return ad.deviceOf(ad.findDeviceObject(arg))?.params.cutoff ?? null', uuid);
const notesOn = (page) => inPage(page, 'return window.__flNotes.length');

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const B = await h.setupPage(browser, 'B', { audio: true });
	await inPage(A.page, KINDS);
	await inPage(B.page, KINDS);
	await h.connect(B, A);

	console.log('\n=== 0. the sockets know the nodes ===');
	const sockets = await inPage(A.page, "return { trig: s.flowSockets.inputType('notetrigger', 'trigger'), val: s.flowSockets.inputType('deviceparam', 'value'), lvl: s.flowSockets.outputType('devicelevel'), tb: s.flowSockets.outputType('transportbeat') }");
	h.check(sockets.trig === 'event' && sockets.val === 'number' && sockets.lvl === 'number' && sockets.tb === 'number', '0.1 event in for Note Trigger, number in for Device Param, number out for Level and Transport (' + JSON.stringify(sockets) + ')');

	console.log('\n=== 1. an LFO drives a cutoff identically on both peers, with no message ===');
	const ids = await inPage(A.page, "const o = ad.addDevice('fl-osc', { position: [0, 0, 0] }); const sp = ad.addDevice('fl-spk', { position: [2, 0, 0] }); ap.addCable({ from: { uuid: o.uuid, port: 'out' }, to: { uuid: sp.uuid, port: 'in' } }); s.flowGraphsCtl.createObjectGraph(o.uuid); window.__mk({ id: 'lfo', type: 'time', position: { x: 0, y: 0 }, data: { type: 'time', mode: 'sin', rate: 5 } }, o.uuid); window.__mk({ id: 'dp', type: 'deviceparam', position: { x: 240, y: 0 }, data: { type: 'deviceparam', key: 'cutoff', value: 0 } }, o.uuid); window.__wire({ id: 'e1', source: 'lfo', target: 'dp', targetHandle: 'value' }, o.uuid); window.__sent = 0; let peerRef; s.peers.subscribe((p) => (peerRef = p))(); const orig = peerRef.send.bind(peerRef); peerRef.send = (d) => { if (d?.type === 'objectParameters' && d.parameter === 'device') window.__sent++; return orig(d); }; return { osc: o.uuid, spk: sp.uuid }");
	await A.page.waitForTimeout(600);
	// one 2.4 s series (~2 periods of a rate-5 sine) answers 1.1 and 1.6 without depending on phase
	const reads = await inPage(A.page, 'const out = []; for (let i = 0; i < 24; i++) { out.push(ad.deviceOf(ad.findDeviceObject(arg)).params.cutoff); await new Promise((r) => setTimeout(r, 100)); } return out', ids.osc);
	const distinct = new Set(reads.map((v) => v.toFixed(3))).size;
	h.check(distinct >= 6, '1.1 the LFO moves the cutoff on A (' + distinct + ' distinct values over 2.4 s)');
	const applied = await inPage(A.page, 'return window.__flParams.cutoff');
	h.check(typeof applied === 'number', '1.2 and the device heard it through onParam (' + applied + ')');
	const sent = await inPage(A.page, 'return window.__sent');
	h.check(sent === 0, '1.3 NO device param message went on the wire (' + sent + ') — the value already travels as the graph');
	await h.eventually(() => cutoffOn(B.page, ids.osc), (v) => typeof v === 'number' && v !== 0.5, '1.4 B evaluates its own copy of the graph: its cutoff moves too', 8000);
	const pair = await Promise.all([cutoffOn(A.page, ids.osc), cutoffOn(B.page, ids.osc)]);
	h.check(Math.abs(pair[0] - pair[1]) < 0.35, '1.5 and the two peers read the same LFO within a few frames of skew (' + pair[0].toFixed(3) + ' vs ' + pair[1].toFixed(3) + ')');

	h.check(Math.min(...reads) === 0 && Math.max(...reads) <= 1 && reads.some((v) => v > 0 && v < 1), '1.6 a +-1 LFO into a 0..1 param pins at the rail (0) for its negative half instead of leaving the range (' + reads.map((v) => v.toFixed(2)).join(' ') + ')');

	console.log('\n=== 2. a Note Trigger fires once per peer per pulse ===');
	await inPage(A.page, "window.__mk({ id: 'kp', type: 'keypress', position: { x: 0, y: 160 }, data: { type: 'keypress', key: 'k' } }, arg); window.__mk({ id: 'nt', type: 'notetrigger', position: { x: 240, y: 160 }, data: { type: 'notetrigger', note: 64, velocity: 0.8 } }, arg); window.__wire({ id: 'e2', source: 'kp', target: 'nt', targetHandle: 'trigger' }, arg);", ids.osc);
	await A.page.waitForTimeout(700);
	await h.eventually(() => inPage(B.page, 'return ad.devicesDebug().built.some((b) => b.uuid === arg && b.builtAs === \'fl-osc\')', ids.osc), (v) => v === true, '2.0 (premise) B built its copy of the oscillator', 8000);
	const zero = await Promise.all([notesOn(A.page), notesOn(B.page)]);
	h.check(zero[0] === 0 && zero[1] === 0, '2.1 (premise) wiring the node fires nothing (' + zero.join('/') + ')');
	await inPage(A.page, "fr.applyNodeTrigger('kp', (Date.now() % 86400000) / 1000, true)");
	await h.eventually(() => notesOn(A.page), (n) => n === 1, '2.2 one pulse on A plays ONE note on A');
	await h.eventually(() => notesOn(B.page), (n) => n === 1, '2.3 and ONE on B — B synthesizes it from the replicated pulse, not from a note message', 8000);
	await A.page.waitForTimeout(400);
	const still = await Promise.all([notesOn(A.page), notesOn(B.page)]);
	h.check(still[0] === 1 && still[1] === 1, '2.4 and not again on later frames (' + still.join('/') + ')');
	await inPage(A.page, "fr.applyNodeTrigger('kp', (Date.now() % 86400000) / 1000, true)");
	await h.eventually(() => notesOn(B.page), (n) => n === 2, '2.5 a second pulse is a second note on both', 8000);
	const noteVal = await inPage(A.page, 'return window.__flNotes[0]');
	h.check(noteVal === 64, '2.6 with the note the node holds (' + noteVal + ')');

	console.log('\n=== 3. Device Level reads the live output ===');
	const loud = await inPage(A.page, "return s.moduleNodeIO.evalModuleValueNode('devicelevel', {}, 0, { id: 'dl', graphId: arg })", ids.osc);
	h.check(typeof loud === 'number' && loud > 0.01, '3.1 non-zero while the drone sounds (' + loud.toFixed(3) + ')');
	await inPage(A.page, "ad.setDeviceParam(arg, 'level', 0)", ids.osc);
	await A.page.waitForTimeout(300);
	const quiet = await inPage(A.page, "return s.moduleNodeIO.evalModuleValueNode('devicelevel', {}, 0, { id: 'dl', graphId: arg })", ids.osc);
	h.check(quiet < 0.002, '3.2 and ~zero after the level is pulled (' + quiet.toFixed(4) + ')');

	console.log('\n=== 4. Transport is pure of the flow clock ===');
	const tb = await inPage(A.page, "mc.setBpm(120); mc.playTransport(); await new Promise((r) => setTimeout(r, 300)); const T = (Date.now() % 86400000) / 1000; const ev = (read) => s.moduleNodeIO.evalModuleValueNode('transportbeat', { read }, T, { id: 'tb', graphId: 'scene' }); const a = ev('beat'); await new Promise((r) => setTimeout(r, 120)); const b = ev('beat'); const doc = mc.clockDebug().transport; const expected = mc.beatAt(doc, Math.floor(Date.now() / 86400000) * 86400000 + T * 1000); const out = { a, b, expected, bpm: ev('bpm'), playing: ev('playing'), bar: ev('bar'), phase: ev('phase') }; mc.stopTransport(); return out");
	h.check(tb.a === tb.b && tb.a > 0, '4.1 the same (data, time) twice gives the SAME beat (' + tb.a.toFixed(4) + ') — pure, so every peer agrees');
	h.check(Math.abs(tb.a - tb.expected) < 1e-6, '4.2 and it is the transport\'s own beat at that clock time');
	h.check(tb.bpm === 120 && tb.playing === 1 && tb.bar === Math.floor(tb.a / 4) && tb.phase >= 0 && tb.phase < 1, '4.3 bpm / playing / bar / phase read as documented');

	await h.finish(browser);
});
