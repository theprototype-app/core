// 23-D2 - prefab arrangements carry their CABLES. `instantiatePrefab` replicated the full
// toJSON with `userData.device` intact, but the cables live in the patch document, so a
// captured DJ booth came back configured and nothing plugged in. Now the cables internal
// to the selection ride the element's root userData and come back under the instance's
// fresh uuids, in one history batch with the objects. Cables crossing the selection's
// boundary are dropped: half a cable is not a thing.
const h = require('./helpers.cjs');
const inPage = (page, body, arg) =>
	page.evaluate(([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'ap', 'pf', 'arg', src)(window.__stores, window.__stores.audioDevices, window.__stores.audioPatch, window.__stores.prefabs, a), [body, arg ?? null]);
const KINDS =
	"ad.registerAudioDevice({ kind: 'pf-osc', label: 'PF osc', ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }, params: [{ key: 'freq', kind: 'range', min: 100, max: 2000, step: 1, default: 330 }]," +
	"  build(ctx, node, p) { const osc = ctx.createOscillator(); osc.frequency.value = p.freq; const amp = ctx.createGain(); amp.gain.value = 0.3; osc.connect(amp); osc.start(); return { output: amp, osc, dispose() { osc.stop(); osc.disconnect(); amp.disconnect(); } }; }," +
	"  onParam(hd, k, v) { if (k === 'freq') hd.osc.frequency.value = v; } });" +
	"ad.registerAudioDevice({ kind: 'pf-spk', label: 'PF speaker', ports: { in: [{ id: 'in', kind: 'audio' }], out: [] }, params: [], build(ctx) { const g = ctx.createGain(); g.connect(window.__stores.audioEngine.bus('instruments')); return { input: g, dispose() { g.disconnect(); } }; } });" +
	'await pf.loadPrefabs(); return ad.devicesDebug().kinds';
const cablesOn = (page) => inPage(page, 'let p; ap.patch.subscribe((v) => (p = v))(); return p.cables.map((c) => ({ id: c.id, from: c.from.uuid, to: c.to.uuid, port: c.from.port + ">" + c.to.port }))');
const undoLen = (page) => page.evaluate(() => { let n = 0; window.__stores.history.undoStack.subscribe((v) => (n = v.length))(); return n; });
const SILENT = 0.001;

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const B = await h.setupPage(browser, 'B', { audio: true });
	await inPage(A.page, KINDS);
	await inPage(B.page, KINDS);
	await h.connect(B, A);
	const page = A.page;

	console.log('\n=== 1. a two-device rig saved as a prefab carries its cable ===');
	const rig = await inPage(page, "const o = ad.addDevice('pf-osc', { position: [0, 0, 0] }); const sp = ad.addDevice('pf-spk', { position: [2, 0, 0] }); ap.addCable({ from: { uuid: o.uuid, port: 'out' }, to: { uuid: sp.uuid, port: 'in' } }); ad.setDeviceFor(o.uuid, { params: { freq: 440 } }); return { osc: o.uuid, spk: sp.uuid }");
	await page.waitForTimeout(400);
	const loud = await h.audioMetrics(A, 500);
	h.check(loud.peak > SILENT * 5, '1.0 (premise) the original rig sounds (peak ' + loud.peak.toFixed(4) + ')');
	const saved = await inPage(page, "const p = await pf.savePrefabSelection([arg.osc, arg.spk], 'Rig'); return { cables: p.element.object.userData?.cables ?? null, kids: p.element.object.children?.length ?? 0, id: p.id }", rig);
	h.check(saved.kids === 2 && Array.isArray(saved.cables) && saved.cables.length === 1 && saved.cables[0].from.port === 'out' && saved.cables[0].to.port === 'in', '1.1 the element carries the ONE internal cable, ends rewritten to the element\'s own uuids (' + JSON.stringify(saved.cables) + ')');
	const elementUuids = await inPage(page, "let list; pf.prefabs.subscribe((v) => (list = v))(); const el = list.find((p) => p.id === arg).element; const ids = new Set(); const walk = (o) => { ids.add(o.uuid); (o.children ?? []).forEach(walk); }; walk(el.object); return [...ids]", saved.id);
	h.check(elementUuids.includes(saved.cables[0].from.uuid) && elementUuids.includes(saved.cables[0].to.uuid) && !elementUuids.includes(rig.osc), '1.2 those ends are the CLONE uuids inside the element, not the scene\'s');

	console.log('\n=== 2. instantiated, it comes back cabled and AUDIBLE, as one undo ===');
	const original = await cablesOn(page);
	await inPage(page, 'ap.removeCable(arg); return 1', original[0].id);
	await page.waitForTimeout(300);
	const quiet = await h.audioMetrics(A, 400);
	h.check(quiet.peak < SILENT * 3, '2.0 (premise) the original unplugged is silent (peak ' + quiet.peak.toFixed(4) + ')');
	const undo0 = await undoLen(page);
	const inst = await inPage(page, "let list; pf.prefabs.subscribe((v) => (list = v))(); const p = list.find((x) => x.id === arg); const o = pf.instantiatePrefab(p, new s.THREE.Vector3(0, 0, -3)); const ids = []; o.traverse((n) => { if (n.userData?.device?.kind) ids.push({ uuid: n.uuid, kind: n.userData.device.kind, freq: n.userData.device.params?.freq }); }); return { root: o.uuid, ids, snapshotLeft: !!o.userData.cables }", saved.id);
	h.check(inst.ids.length === 2 && inst.ids.some((d) => d.kind === 'pf-osc' && d.freq === 440) && !inst.snapshotLeft, '2.1 the instance holds two devices with their configuration, and no snapshot on its userData (' + JSON.stringify(inst.ids) + ')');
	const cables2 = await cablesOn(page);
	const instOsc = inst.ids.find((d) => d.kind === 'pf-osc').uuid, instSpk = inst.ids.find((d) => d.kind === 'pf-spk').uuid;
	h.check(cables2.length === 1 && cables2[0].from === instOsc && cables2[0].to === instSpk && cables2[0].port === 'out>in', '2.2 ONE cable between the instance\'s fresh uuids (' + JSON.stringify(cables2.map((c) => c.port)) + ')');
	await page.waitForTimeout(500);
	const heard = await h.audioMetrics(A, 500);
	h.check(heard.peak > SILENT * 5, '2.3 and the instance is AUDIBLE - the sound only travels through that cable (peak ' + heard.peak.toFixed(4) + ')');
	const undo1 = await undoLen(page);
	h.check(undo1 === undo0 + 1, '2.4 objects + cable are ONE undo entry (' + undo0 + ' -> ' + undo1 + ')');
	await h.eventually(() => cablesOn(B.page), (list) => list.some((c) => c.from === instOsc && c.to === instSpk), '2.5 B holds the instance\'s cable (the patch replicated)');
	await h.eventually(() => inPage(B.page, "return ad.devicesDebug().built.filter((b) => b.builtAs === 'pf-osc' || b.builtAs === 'pf-spk').length"), (n) => n >= 4, '2.6 and built the instance\'s devices');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(400);
	const after = await inPage(page, 'let p; ap.patch.subscribe((v) => (p = v))(); return { cables: p.cables.length, obj: !!ad.findDeviceObject(arg) }', instOsc);
	h.check(after.cables === 0 && after.obj === false, '2.7 one undo takes the whole rig back: no instance, no cable (' + JSON.stringify(after) + ')');

	console.log('\n=== 3. twice makes two independent rigs; a boundary-crossing cable is dropped ===');
	const two = await inPage(page, "let list; pf.prefabs.subscribe((v) => (list = v))(); const p = list.find((x) => x.id === arg); const a = pf.instantiatePrefab(p, new s.THREE.Vector3(0, 0, -3)); const b = pf.instantiatePrefab(p, new s.THREE.Vector3(3, 0, -3)); const devs = (o) => { const ids = []; o.traverse((n) => { if (n.userData?.device?.kind) ids.push(n.uuid); }); return ids; }; let pt; ap.patch.subscribe((v) => (pt = v))(); return { a: devs(a), b: devs(b), cables: pt.cables.map((c) => [c.from.uuid, c.to.uuid]) }", saved.id);
	const within = (ids, c) => ids.includes(c[0]) && ids.includes(c[1]);
	h.check(two.cables.length === 2 && two.cables.some((c) => within(two.a, c)) && two.cables.some((c) => within(two.b, c)) && !two.a.some((u) => two.b.includes(u)), '3.1 two instances, two cables, each inside its own rig, no shared uuid (' + JSON.stringify({ a: two.a.map((u) => u.slice(0, 4)), b: two.b.map((u) => u.slice(0, 4)), cables: two.cables.map((c) => c.map((u) => u.slice(0, 4))) }) + ')');
	const boundary = await inPage(page, "const o = ad.addDevice('pf-osc', { position: [5, 0, 0] }); const spOut = ad.addDevice('pf-spk', { position: [7, 0, 0] }); ap.addCable({ from: { uuid: o.uuid, port: 'out' }, to: { uuid: spOut.uuid, port: 'in' } }); const extra = ad.addDevice('pf-osc', { position: [6, 0, 0] }); const p = await pf.savePrefabSelection([o.uuid, extra.uuid], 'Half'); return { cables: p.element.object.userData?.cables ?? [], kids: p.element.object.children?.length ?? 0 }");
	h.check(boundary.kids === 2 && boundary.cables.length === 0, '3.2 a cable to a speaker OUTSIDE the selection is not captured (' + boundary.cables.length + ' cables in the element)');
	const dangling = await inPage(page, "let list; pf.prefabs.subscribe((v) => (list = v))(); const p = list.find((x) => x.name === 'Half'); const count = () => { let pt; ap.patch.subscribe((v) => (pt = v))(); return pt.cables.length; }; const before = count(); pf.instantiatePrefab(p, new s.THREE.Vector3(0, 0, -6)); return { before, after: count() }");
	h.check(dangling.after === dangling.before, '3.3 instantiating it adds NO cable - nothing dangles, nothing re-attaches by luck (' + dangling.before + ' -> ' + dangling.after + ')');

	await h.finish(browser);
});
