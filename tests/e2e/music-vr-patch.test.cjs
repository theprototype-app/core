// #23 B1 — VR patching: plugs, the cable trigger-drag, knobs, registerVRWindow.
//
// No XR session runs headless, so this drives the exported seams with synthetic
// controller rays and poses — the vr-sleeve recipe. What has to be proven: a hit on
// a plug's nested mesh resolves to the plug and its device / side / port / kind; the
// navigation-suppression and trailing-select swallow predicates; a full pull writes
// exactly ONE cable and ONE undo entry; the wrong hand's release is ignored; a drop on
// nothing, on the same side, or on an incompatible kind writes nothing; picking a
// cable up off an IN plug re-plugs it as ONE undo entry (or unplugs it when dropped);
// a knob drives a param with throttled replicated previews and ONE exact commit whose
// undo goes back to where the gesture STARTED; registerVRWindow makes a module window
// grip-targetable; and two peers see the cable a pull made. On-device feel is the
// user's check, and the plan says so.
const h = require('./helpers.cjs');

const vp = (page, body, arg) =>
	page.evaluate(
		([src, a]) =>
			Object.getPrototypeOf(async function () {}).constructor('vp', 'ad', 'ap', 's', 'THREE', 'arg', src)(
				window.__stores.vrPatch,
				window.__stores.audioDevices,
				window.__stores.audioPatch,
				window.__stores,
				window.__stores.THREE,
				a
			),
		[body, arg ?? null]
	);

/** in-page helpers the snippets share: a ray aimed straight down at a node, a pose */
const HELPERS =
	'const rayAt = (node) => { node.updateWorldMatrix(true, false); const p = node.getWorldPosition(new THREE.Vector3()); const r = new THREE.Raycaster(p.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, -1, 0)); r.far = 5; return r; };' +
	'const poseAt = (x, y, z, hand) => ({ position: new THREE.Vector3(x, y, z), quaternion: new THREE.Quaternion(), hand: hand ?? "right" });' +
	'const g = await new Promise((r) => s.objectsGroup.subscribe(r)());' +
	'const obj = (uuid) => g.getObjectByProperty("uuid", uuid);' +
	'const undoLen = () => { let n = 0; s.history.undoStack.subscribe((v) => (n = v.length))(); return n; };';

const KINDS =
	"ad.registerAudioDevice({ kind: 'vp-osc', label: 'VP osc', ports: { in: [], out: [{ id: 'out', kind: 'audio' }, { id: 'cv', kind: 'cv' }] }," +
	"  params: [{ key: 'freq', kind: 'range', min: 100, max: 1100, step: 10, default: 400 }, { key: 'gain', kind: 'range', min: 0, max: 1, step: 0.01, default: 0 }]," +
	'  build(ctx, node, p) { const osc = ctx.createOscillator(); osc.frequency.value = p.freq; const amp = ctx.createGain(); amp.gain.value = p.gain; osc.connect(amp); osc.start(); return { output: amp, osc, amp, dispose() { osc.stop(); osc.disconnect(); amp.disconnect(); } }; },' +
	"  onParam(hd, k, v) { window.__vpParams = (window.__vpParams || []); window.__vpParams.push([k, v]); if (k === 'freq') hd.osc.frequency.value = v; if (k === 'gain') hd.amp.gain.value = v; } });" +
	"ad.registerAudioDevice({ kind: 'vp-spk', label: 'VP speaker', ports: { in: [{ id: 'in', kind: 'audio' }], out: [] }, params: []," +
	"  build(ctx) { const gn = ctx.createGain(); gn.connect(window.__stores.audioEngine.bus('instruments')); return { input: gn, dispose() { gn.disconnect(); } }; } });" +
	"ad.registerAudioDevice({ kind: 'vp-cvin', label: 'VP cv in', ports: { in: [{ id: 'in', kind: 'cv' }], out: [] }, params: [], build() { return { input: null, dispose() {} }; } });" +
	'return ad.devicesDebug().kinds';

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;
	await vp(page, KINDS);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. plugs ===');
	const ids = await vp(page, "const o = ad.addDevice('vp-osc', { position: [0, 0, 0] }); const sp = ad.addDevice('vp-spk', { position: [3, 0, 0] }); const cv = ad.addDevice('vp-cvin', { position: [0, 0, 3] }); return { osc: o.uuid, spk: sp.uuid, cv: cv.uuid, oscPlugs: o.children.filter((c) => c.name.startsWith('vrpatch-')).map((c) => c.name).sort(), spkPlugs: sp.children.filter((c) => c.name.startsWith('vrpatch-')).map((c) => c.name) }");
	h.check(ids.oscPlugs.join(',') === 'vrpatch-out:cv,vrpatch-out:out' && ids.spkPlugs.join(',') === 'vrpatch-in:in', '1.1 addDevice adds a plug mesh per declared port (' + ids.oscPlugs.join(',') + ' | ' + ids.spkPlugs.join(',') + ')');
	const resolved = await vp(page, HELPERS + "const plug = obj(arg.osc).getObjectByName('vrpatch-out:out'); const info = vp.plugInfo(vp.plugNodeOf(plug)); const viaRay = vp.plugAt(rayAt(plug)); const cvInfo = vp.plugAt(rayAt(obj(arg.osc).getObjectByName('vrpatch-out:cv'))); return { info: info && { uuid: info.uuid, side: info.side, port: info.port, kind: info.kind }, viaRay: viaRay && { uuid: viaRay.uuid, port: viaRay.port }, cvKind: cvInfo?.kind, nothing: vp.plugAt(rayAt(obj(arg.spk))) === null || vp.plugAt(rayAt(obj(arg.spk)))?.side === 'in' }", ids);
	h.check(resolved.info && resolved.info.uuid === ids.osc && resolved.info.side === 'out' && resolved.info.port === 'out' && resolved.info.kind === 'audio', '1.2 a plug node resolves to its device, side, port and KIND (' + JSON.stringify(resolved.info) + ')');
	h.check(resolved.viaRay && resolved.viaRay.uuid === ids.osc && resolved.viaRay.port === 'out', '1.3 plugAt(ray) finds the plug under a ray');
	h.check(resolved.cvKind === 'cv', "1.4 the second port carries its own kind ('cv')");

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the pull ===');
	const pull = await vp(page, HELPERS + "const out = obj(arg.osc).getObjectByName('vrpatch-out:out'); const inn = obj(arg.spk).getObjectByName('vrpatch-in:in');" +
		'const before = undoLen(); const suppressedBefore = vp.vrPatchSuppressed();' +
		"const began = vp.beginCableDrag(vp.plugAt(rayAt(out)), poseAt(0.5, 1, 0, 'right'), { index: 0, hand: 'right' });" +
		'const during = vp.vrPatchState(); const suppressedDuring = vp.vrPatchSuppressed();' +
		'vp.updateCableDrag(poseAt(2, 1, 0));' +
		'let scene; s.globalScene.subscribe((v) => (scene = v))(); const preview = scene.getObjectByName("vr-patch-preview"); const inObjects = !!g.getObjectByName("vr-patch-preview");' +
		'const wrongHand = vp.endCableDrag(rayAt(inn), { index: 1 }); const stillHolding = !!vp.vrPatchState().holding;' +
		'const done = vp.endCableDrag(rayAt(inn), { index: 0 });' +
		'const after = undoLen(); const swallowNow = vp.vrPatchSwallowSelect(); const suppressedAfter = vp.vrPatchSuppressed();' +
		'await new Promise((r) => setTimeout(r, 350)); const swallowLater = vp.vrPatchSwallowSelect();' +
		'const doc = ap.patchDebug(); const previewGone = (preview?.children.length ?? 0) === 0;' +
		'return { began, during, suppressedBefore, suppressedDuring, previewAtRoot: preview?.parent === scene, inObjects, wrongHand, stillHolding, done, entries: after - before, swallowNow, swallowLater, suppressedAfter, cables: doc.cables.map((c) => ({ from: c.from, to: c.to, live: c.live })), previewGone }', ids);
	h.check(pull.began && pull.during.holding && pull.during.holding.from.side === 'out' && !pull.suppressedBefore && pull.suppressedDuring, '2.1 a trigger press on a plug begins a hold, and navigation is suppressed while it lasts');
	h.check(pull.previewAtRoot && !pull.inObjects, '2.2 the dangling preview lives at the SCENE ROOT, never in objectsGroup');
	h.check(pull.wrongHand === null && pull.stillHolding, "2.3 the OTHER hand's release is ignored — the hold survives");
	h.check(pull.done && pull.done.cable && pull.cables.length === 1 && pull.cables[0].from.uuid === ids.osc && pull.cables[0].to.uuid === ids.spk && pull.cables[0].live, '2.4 the right hand releasing on the speaker plug writes exactly ONE cable, routed');
	h.check(pull.entries === 1, '2.5 and exactly ONE undo entry (' + pull.entries + ')');
	h.check(pull.swallowNow && !pull.swallowLater && !pull.suppressedAfter, '2.6 the trailing select is swallowed for 300 ms, then not; suppression is released');
	h.check(pull.previewGone, '2.7 the preview is gone');
	await page.waitForTimeout(200);
	await vp(page, "ad.setDeviceParam(arg.osc, 'gain', 0.3)", ids);
	await page.waitForTimeout(200);
	h.check(!(await h.audioMetrics(A, 400)).silent, '2.8 and the pulled cable carries sound (the oscillator is heard through the speaker)');
	const cableId = pull.done.cable;

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. drops that write nothing ===');
	const nothing = await vp(page, HELPERS + "const out = obj(arg.osc).getObjectByName('vrpatch-out:out'); const cvIn = obj(arg.cv).getObjectByName('vrpatch-in:in');" +
		'const before = undoLen(); const n0 = ap.patchDebug().cables.length;' +
		"vp.beginCableDrag(vp.plugAt(rayAt(out)), poseAt(0, 1, 0), { index: 0 }); const dropped = vp.endCableDrag(null, { index: 0 });" +
		"vp.beginCableDrag(vp.plugAt(rayAt(out)), poseAt(0, 1, 0), { index: 0 }); const sameSide = vp.endCableDrag(rayAt(obj(arg.osc).getObjectByName('vrpatch-out:cv')), { index: 0 });" +
		"vp.beginCableDrag(vp.plugAt(rayAt(out)), poseAt(0, 1, 0), { index: 0 }); const wrongKind = vp.endCableDrag(rayAt(cvIn), { index: 0 });" +
		'return { dropped, sameSide, wrongKind, entries: undoLen() - before, cables: ap.patchDebug().cables.length - n0, holding: !!vp.vrPatchState().holding }', ids);
	h.check(nothing.dropped === null && nothing.sameSide === null && nothing.wrongKind === null, '3.1 a drop on nothing, on the same side, or on an incompatible kind writes no cable');
	h.check(nothing.entries === 0 && nothing.cables === 0 && !nothing.holding, '3.2 no undo entry, no cable, nothing left held');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. picking a cable up: re-plug and unplug ===');
	const replug = await vp(page, HELPERS + "const sp2 = ad.addDevice('vp-spk', { position: [3, 0, -3] }); await new Promise((r) => setTimeout(r, 250));" +
		"const inn = obj(arg.spk).getObjectByName('vrpatch-in:in'); const inn2 = sp2.getObjectByName('vrpatch-in:in');" +
		'const before = undoLen();' +
		"const began = vp.beginCableDrag(vp.plugAt(rayAt(inn)), poseAt(3, 1, 0), { index: 0 }); const st = vp.vrPatchState();" +
		'await new Promise((r) => setTimeout(r, 150)); const hiddenWhileHeld = ap.patchDebug().cables.find((c) => c.id === arg.cable)?.drawn === false;' +
		'const routedWhileHeld = ap.patchDebug().cables.find((c) => c.id === arg.cable)?.live === true;' +
		'const done = vp.endCableDrag(rayAt(inn2), { index: 0 });' +
		'const doc = ap.patchDebug().cables.map((c) => ({ id: c.id, to: c.to.uuid })); const entries = undoLen() - before;' +
		's.history.undo(); await new Promise((r) => setTimeout(r, 200)); const afterUndo = ap.patchDebug().cables.map((c) => ({ id: c.id, to: c.to.uuid }));' +
		's.history.redo(); await new Promise((r) => setTimeout(r, 200)); const afterRedo = ap.patchDebug().cables.map((c) => c.to.uuid);' +
		'return { began, picked: st.holding?.picked, fromSide: st.holding?.from.side, hiddenWhileHeld, routedWhileHeld, done, doc, entries, afterUndo, afterRedo, sp2: sp2.uuid }', { ...ids, cable: cableId });
	h.check(replug.began && replug.picked === cableId && replug.fromSide === 'out', '4.1 pressing an IN plug that holds a cable picks THAT cable up by its OUT end');
	h.check(replug.hiddenWhileHeld && replug.routedWhileHeld, '4.2 while held the cable is hidden but still ROUTED (the document is untouched until release)');
	h.check(replug.done && replug.done.cable && replug.doc.length === 1 && replug.doc[0].to === replug.sp2, '4.3 dropping it on another speaker re-plugs it there (one cable, the new target)');
	h.check(replug.entries === 1, '4.4 the whole re-plug is ONE undo entry (' + replug.entries + ')');
	h.check(replug.afterUndo.length === 1 && replug.afterUndo[0].to === ids.spk && replug.afterUndo[0].id === cableId, '4.5 one undo puts the original cable back where it was');
	h.check(replug.afterRedo.length === 1 && replug.afterRedo[0] === replug.sp2, '4.6 redo re-plugs it again');
	const unplug = await vp(page, HELPERS + "const inn2 = obj(arg.sp2).getObjectByName('vrpatch-in:in'); const before = undoLen();" +
		'vp.beginCableDrag(vp.plugAt(rayAt(inn2)), poseAt(3, 1, -3), { index: 0 }); const done = vp.endCableDrag(null, { index: 0 });' +
		'const n = ap.patchDebug().cables.length; const entries = undoLen() - before; s.history.undo(); await new Promise((r) => setTimeout(r, 200));' +
		'return { done, n, entries, back: ap.patchDebug().cables.length }', { sp2: replug.sp2 });
	h.check(unplug.done && unplug.done.unplugged && unplug.n === 0 && unplug.entries === 1, '4.7 picking a cable up and dropping it nowhere UNPLUGS it, one undo entry');
	h.check(unplug.back === 1, '4.8 and undo plugs it back');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. knobs ===');
	const knob = await vp(page, HELPERS + "const o = obj(arg.osc); const k = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), new THREE.MeshStandardMaterial({ color: '#ccc' })); k.name = 'vrknob:freq'; k.position.set(0, 0.2, 0); o.add(k);" +
		'window.__sent = 0; let peerRef; s.peers.subscribe((p) => (peerRef = p))(); const orig = peerRef.send.bind(peerRef); peerRef.send = (d) => { if (d?.type === "objectParameters" && d.parameter === "device") window.__sent++; return orig(d); };' +
		'const info = vp.knobAt(rayAt(k)); const before = undoLen(); const start = ad.deviceOf(o).params.freq;' +
		'const began = vp.beginKnobDrag(info, poseAt(0, 1, 0), { index: 0 }); const suppressed = vp.vrPatchSuppressed();' +
		'const values = []; for (let i = 1; i <= 20; i++) { vp.updateKnobDrag(poseAt(0, 1 + i * 0.005, 0)); values.push(vp.vrPatchState().knob.value); await new Promise((r) => setTimeout(r, 20)); }' +
		'const live = ad.deviceOf(o).params.freq; const sentDuring = window.__sent;' +
		'const done = vp.endKnobDrag(); const entries = undoLen() - before; const committed = ad.deviceOf(o).params.freq; const sentTotal = window.__sent;' +
		's.history.undo(); await new Promise((r) => setTimeout(r, 150)); const undone = ad.deviceOf(o).params.freq;' +
		's.history.redo(); await new Promise((r) => setTimeout(r, 150)); const redone = ad.deviceOf(o).params.freq;' +
		'peerRef.send = orig;' +
		'return { key: info?.key, param: info?.param?.key, began, suppressed, start, values, live, sentDuring, done, entries, committed, sentTotal, undone, redone }', ids);
	h.check(knob.key === 'freq' && knob.param === 'freq', "5.1 a `vrknob:freq` child resolves to the device's freq param");
	h.check(knob.began && knob.suppressed, '5.2 grabbing it begins a knob drag (navigation suppressed)');
	const monotone = knob.values.every((v, i) => i === 0 || v >= knob.values[i - 1]);
	h.check(monotone && knob.values[knob.values.length - 1] > knob.start && knob.values.every((v) => v >= 100 && v <= 1100 && Math.abs(v / 10 - Math.round(v / 10)) < 1e-6), '5.3 lifting the controller raises the value monotonically, on the step grid, inside the range (' + knob.start + ' -> ' + knob.values[knob.values.length - 1] + ')');
	h.check(knob.live === knob.values[knob.values.length - 1], '5.4 the document previews the live value while held');
	h.check(knob.sentDuring >= 1 && knob.sentDuring <= 8, '5.5 replicated previews are THROTTLED (' + knob.sentDuring + ' sends for 20 frames over 400 ms)');
	h.check(knob.done && knob.done.value === knob.committed && knob.entries === 1 && knob.sentTotal === knob.sentDuring + 1, '5.6 release commits ONE exact write and ONE undo entry');
	h.check(knob.undone === knob.start && knob.redone === knob.committed, '5.7 undo goes back to where the gesture STARTED (' + knob.undone + '), redo to where it ended (' + knob.redone + ')');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. registerVRWindow (finding 13) ===');
	const win = await page.evaluate(() => {
		const vc = window.__stores.vrControls;
		const { writable } = { writable: (v) => { let value = v; const subs = new Set(); return { subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn); }, set(x) { value = x; subs.forEach((f) => f(x)); } }; } };
		const group = new window.__stores.THREE.Group();
		group.name = 'mod-test-window';
		const store = writable(group);
		const off = vc.registerVRWindow('mod-test-window', store);
		const listed = vc.vrWindowIds().includes('mod-test-window');
		const resolved = vc.windowGroupFor('mod-test-window') === group;
		const builtIn = vc.windowGroupFor('menu') !== group;
		off();
		const gone = !vc.vrWindowIds().includes('mod-test-window');
		return { listed, resolved, builtIn, gone };
	});
	h.check(win.listed && win.resolved, '6.1 a registered module window is listed and resolves to its group');
	h.check(win.builtIn && win.gone, '6.2 the built-ins are untouched, and the disposer removes it');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. two peers see the cable a pull made ===');
	const B = await h.setupPage(browser, 'B', { audio: true });
	await vp(B.page, KINDS);
	await h.connect(B, A);
	await h.eventually(() => vp(B.page, 'return ap.patchDebug().cables.filter((c) => c.live).length'), (n) => n === 1, '7.1 (premise) B holds the rig with its cable routed', 15000);
	const pulled = await vp(page, HELPERS + "const cv = obj(arg.osc).getObjectByName('vrpatch-out:cv'); const cvIn = obj(arg.cv).getObjectByName('vrpatch-in:in'); vp.beginCableDrag(vp.plugAt(rayAt(cv)), poseAt(0, 1, 0), { index: 0 }); return vp.endCableDrag(rayAt(cvIn), { index: 0 })", ids);
	h.check(pulled && pulled.cable, '7.2 a cv pull on A (kinds agree: cv -> cv) writes a cable');
	await h.eventually(() => vp(B.page, 'return ap.patchDebug().cables.length'), (n) => n === 2, '7.3 and B sees it', 15000);

	// ---------------------------------------------------------------- section 8
	console.log('\n=== 8. desktop: Play mode and the editor ===');
	// Play mode's press is crosshair-aimed from the pointer-locked look, which a headless
	// page cannot turn — so Play is proven at its seam: the dispatch Play's tap calls
	// (moduleClickHandlers, first entry) is driven with the plug mesh while isLocked. The
	// EDITOR path is driven through a real mouse click on the plug's pixel. Aiming the look
	// at a plug in Play mode is the user's on-device check.
	await vp(page, HELPERS + "for (const u of [arg.osc, arg.spk]) obj(u).traverse((n) => { if (n.name.startsWith('vrpatch-')) n.scale.multiplyScalar(3); });", ids);
	await page.locator('#play-button').click();
	await page.waitForTimeout(600);
	h.check((await page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))()))) === true, '8.1 (premise) Play mode is on');
	const tap = (uuid, name) => vp(page, HELPERS + 'const n = obj(arg.u).getObjectByName(arg.n); const consumed = s.moduleSDK.moduleClickHandlers[0](n); const st = vp.vrPatchState(); return { consumed, armed: st.desktopArmed, side: st.holding?.from.side ?? null, picked: st.holding?.picked ?? null, preview: st.holding?.previewVisible ?? false, n: ap.patchDebug().cables.length }', { u: uuid, n: name });
	const cablesBefore = await vp(page, 'return ap.patchDebug().cables.length');
	const first = await tap(ids.osc, 'vrpatch-out:out');
	h.check(first.consumed && first.armed && first.side === 'out' && first.preview, '8.2 in Play, a tap on an output plug (through the tap dispatch) arms a wire and consumes the click');
	const second = await tap(ids.spk, 'vrpatch-in:in');
	const wiredLast = await vp(page, 'const d = ap.patchDebug(); return d.cables[d.cables.length - 1]');
	h.check(second.consumed && !second.armed && second.n === cablesBefore + 1 && wiredLast.from.uuid === ids.osc && wiredLast.to.uuid === ids.spk, '8.3 a tap on the speaker input connects the wire (' + cablesBefore + ' -> ' + second.n + ')');
	await h.eventually(() => vp(page, 'const d = ap.patchDebug(); return d.cables[d.cables.length - 1].live'), (v) => v === true, '8.4 and it routes');
	await tap(ids.osc, 'vrpatch-out:out');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	const escaped = await vp(page, 'return { armed: vp.vrPatchState().desktopArmed, n: ap.patchDebug().cables.length }');
	h.check(!escaped.armed && escaped.n === second.n, '8.5 Escape drops a held wire and writes nothing');
	await tap(ids.osc, 'vrpatch-out:out');
	const same = await tap(ids.osc, 'vrpatch-out:cv');
	h.check(!same.armed && same.n === second.n, '8.6 a tap on an incompatible plug drops the wire, nothing written');
	const picked = await tap(ids.spk, 'vrpatch-in:in');
	h.check(picked.armed && picked.picked === wiredLast.id, '8.7 a tap on a plugged input picks that cable up');
	const unplugged = await tap(ids.spk, 'vrpatch-in:in');
	h.check(!unplugged.armed && unplugged.n === second.n - 1, '8.8 a second tap on the same input unplugs it');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => vp(page, 'return ap.patchDebug().cables.length'), (n) => n === second.n, '8.9 undo plugs it back');
	await page.evaluate(() => window.__stores.playMode.exitPlay());
	await page.waitForTimeout(900);
	// the editor: a REAL mouse click on the plug's pixel, and no selection change
	await vp(page, HELPERS + 'const n = obj(arg.u).getObjectByName(arg.n); n.updateWorldMatrix(true, false); const p = n.getWorldPosition(new THREE.Vector3()); await s.objectActions.flyTo([p.x - 0.6, p.y + 0.35, p.z + 1.2], p.toArray(), 250);', { u: ids.spk, n: 'vrpatch-in:in' }); // an IN plug sits on the -X face: look from that side
	await page.waitForTimeout(600);
	const selBefore = await page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((v) => r(v?.uuid ?? null))()));
	const px = await h.projectPoint(page, await vp(page, HELPERS + 'const n = obj(arg.u).getObjectByName(arg.n); n.updateWorldMatrix(true, false); return n.getWorldPosition(new THREE.Vector3()).toArray()', { u: ids.spk, n: 'vrpatch-in:in' }));
	await page.mouse.click(px.x, px.y);
	await page.waitForTimeout(300);
	const editor = await vp(page, 'const st = vp.vrPatchState(); let sel; s.selectedObject.subscribe((v) => (sel = v))(); return { armed: st.desktopArmed, picked: st.holding?.picked ?? null, selected: sel?.uuid ?? null }');
	h.check(editor.armed && editor.picked === wiredLast.id && editor.selected === selBefore, '8.10 in the editor a real click ON the plug picks the cable up and does not change the selection');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check(!(await vp(page, 'return vp.vrPatchState().desktopArmed')), '8.11 Escape drops it');

	await h.finish(browser);
});
