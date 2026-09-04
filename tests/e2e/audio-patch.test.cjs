// #23 A4 — the patch: cables between device ports, replicated, undoable, saved, drawn.
//
// The routing document is its own latest-wins singleton (fork 3). What has to be
// proven: a cable ROUTES (a device that is silent alone sounds once cabled into a
// speaker, within a frame), it replicates and undoes on both peers, an object's
// cables survive its deletion until a SAVE prunes them (undo finds them), a
// duplicated pair keeps its internal cable, and the cable mesh lives at the scene
// root — never in objectsGroup, never in a GLTF export (the editOverlays
// counterfactual is run INSIDE the suite by parenting the cable root under
// objectsGroup for one export).
const h = require('./helpers.cjs');

const ap = (page, body, arg) =>
	page.evaluate(
		([src, a]) =>
			Object.getPrototypeOf(async function () {}).constructor('ap', 'ad', 'eng', 's', 'arg', src)(
				window.__stores.audioPatch,
				window.__stores.audioDevices,
				window.__stores.audioEngine,
				window.__stores,
				a
			),
		[body, arg ?? null]
	);

/** two test kinds: a drone whose OUTPUT goes nowhere by itself, and a speaker whose INPUT
 * feeds the instruments bus. Sound needs a cable. */
const KINDS =
	"ad.registerAudioDevice({ kind: 'test-drone', label: 'Drone', ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }," +
	"  params: [{ key: 'freq', kind: 'range', min: 100, max: 2000, step: 1, default: 440 }, { key: 'gain', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.3 }]," +
	'  build(ctx, node, p) { const osc = ctx.createOscillator(); osc.frequency.value = p.freq; const amp = ctx.createGain(); amp.gain.value = p.gain; osc.connect(amp); osc.start(); return { output: amp, osc, amp, dispose() { osc.stop(); osc.disconnect(); amp.disconnect(); } }; },' +
	"  onParam(hd, k, v) { if (k === 'freq') hd.osc.frequency.value = v; if (k === 'gain') hd.amp.gain.value = v; } });" +
	"ad.registerAudioDevice({ kind: 'test-speaker', label: 'Speaker', ports: { in: [{ id: 'in', kind: 'audio' }], out: [] }, params: []," +
	"  build(ctx) { const g = ctx.createGain(); g.connect(eng.bus('instruments')); return { input: g, dispose() { g.disconnect(); } }; } });" +
	'return ad.devicesDebug().kinds';

const dbg = (page) => ap(page, 'return ap.patchDebug()');
const groupOf = async (page) => page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe(r)()));

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;
	await ap(page, KINDS);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the document ===');
	const norm = await ap(
		page,
		"const a = ap.normalizePatch({ cables: [ { id: 'x', from: { uuid: 'u1' }, to: { uuid: 'u2', port: 'in' }, gain: 9, future: 'keep' }, { id: 'x', from: { uuid: 'u1', port: 'out' }, to: { uuid: 'u3' } }, { from: { uuid: 'u1' } } ], extra: 1 });" +
			'const b = ap.normalizePatch(a); return { a, same: JSON.stringify(a) === JSON.stringify(b) }'
	);
	h.check(norm.a.cables.length === 2, '1.1 a cable without both endpoints is dropped (' + norm.a.cables.length + ' kept of 3)');
	h.check(norm.a.cables[0].from.port === 'main' && norm.a.cables[0].gain === 2 && norm.a.cables[0].future === 'keep', "1.2 a missing port is 'main', gain clamps to 2, an unknown field survives");
	h.check(norm.a.cables[0].id !== norm.a.cables[1].id && norm.a.extra === 1, '1.3 a duplicate id is re-minted; unknown top-level fields survive');
	h.check(norm.same, '1.4 normalizing twice is idempotent');
	h.check((await ap(page, 'return ap.patchSnapshot()')) === null, '1.5 an empty patch snapshots to null — no `patch` key in a save');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. a cable ROUTES ===');
	const ids = await ap(page, "const d = ad.addDevice('test-drone', { position: [0, 0, 0] }); const s2 = ad.addDevice('test-speaker', { position: [2, 0, 0] }); return { drone: d.uuid, speaker: s2.uuid }");
	await page.waitForTimeout(300);
	const alone = await h.audioMetrics(A, 400);
	h.check(alone.silent, '2.1 (premise) a drone with no cable into a speaker is silent (peak ' + alone.peak.toFixed(4) + ')');
	const cableId = await ap(page, "return ap.addCable({ from: { uuid: arg.drone, port: 'out' }, to: { uuid: arg.speaker, port: 'in' } })", ids);
	h.check(typeof cableId === 'string' && cableId.length > 2, '2.2 addCable returns an id');
	await h.eventually(() => dbg(page), (d) => d.cables.length === 1 && d.cables[0].live === true, '2.3 the routing diff connected it (live)');
	const routed = await h.audioMetrics(A, 500);
	h.check(!routed.silent, '2.4 and the drone is HEARD through the speaker (peak ' + routed.peak.toFixed(3) + ')');
	await h.eventually(() => dbg(page), (d) => d.cables[0].drawn === true && d.meshes === 1, '2.5 a cable mesh is drawn');
	const where = await ap(page, 'const root = ap.cableRoot(); const g = await new Promise((r) => s.objectsGroup.subscribe(r)()); let scene; s.globalScene.subscribe((v) => (scene = v))(); return { parentIsScene: root.parent === scene, underObjects: g.getObjectByName("audio-cables") !== undefined && g.getObjectByName("audio-cables") !== null, name: root.name }');
	h.check(where.parentIsScene && !where.underObjects, '2.6 the cable root lives at the SCENE ROOT, not in objectsGroup (golden rule 5)');

	const same = await ap(page, "return ap.addCable({ from: { uuid: arg.drone, port: 'out' }, to: { uuid: arg.speaker, port: 'in' } })", ids);
	h.check(same === cableId, '2.7 plugging the same cable twice returns the same cable, not a duplicate');
	const selfLoop = await ap(page, "return ap.addCable({ from: { uuid: arg.drone, port: 'out' }, to: { uuid: arg.drone, port: 'out' } })", ids);
	h.check(selfLoop === null, '2.8 a port into itself is refused');

	await ap(page, 'ap.setCableGain(arg, 0)', cableId);
	await page.waitForTimeout(200);
	const muted = await h.audioMetrics(A, 400);
	h.check(muted.silent, '2.9 a cable gain of 0 silences the route (peak ' + muted.peak.toFixed(4) + ')');
	await ap(page, 'ap.setCableGain(arg, 1)', cableId);
	await page.waitForTimeout(200);
	h.check(!(await h.audioMetrics(A, 400)).silent, '2.10 and 1 brings it back');

	await ap(page, 'ap.removeCable(arg)', cableId);
	await h.eventually(() => dbg(page), (d) => d.cables.length === 0 && d.meshes === 0, '2.11 removing the cable removes its mesh');
	await page.waitForTimeout(200);
	h.check((await h.audioMetrics(A, 400)).silent, '2.12 and the route is gone (silent)');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. undo / redo ===');
	const cable2 = await ap(page, "return ap.addCable({ from: { uuid: arg.drone, port: 'out' }, to: { uuid: arg.speaker, port: 'in' } })", ids);
	await h.eventually(() => dbg(page), (d) => d.cables.length === 1 && d.cables[0].live, '3.1 (premise) cabled again');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => dbg(page), (d) => d.cables.length === 0 && d.meshes === 0, '3.2 undo unplugs it — document, routing and mesh');
	await page.waitForTimeout(200);
	h.check((await h.audioMetrics(A, 400)).silent, '3.3 silent after the undo');
	await page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => dbg(page), (d) => d.cables.length === 1 && d.cables[0].id === cable2 && d.cables[0].live, '3.4 redo plugs the same cable back in');
	await page.waitForTimeout(200);
	h.check(!(await h.audioMetrics(A, 400)).silent, '3.5 and it sounds again');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. an object leaves: prune at serialization only ===');
	await ap(page, 's.objectActions.deleteObjectsByUuid([arg])', ids.speaker);
	await h.eventually(() => dbg(page), (d) => d.cables.length === 1 && d.cables[0].live === false && d.cables[0].drawn === false, '4.1 deleting the speaker leaves the cable in the document, unrouted and undrawn');
	await page.waitForTimeout(200);
	h.check((await h.audioMetrics(A, 400)).silent, '4.2 silent without its speaker');
	h.check((await ap(page, 'return ap.patchSnapshot()')) === null, '4.3 a SAVE prunes the orphan (the snapshot is null)');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => dbg(page), (d) => d.cables.length === 1 && d.cables[0].live === true && d.cables[0].drawn === true, '4.4 undoing the delete finds the cable waiting and routes it again');
	await page.waitForTimeout(200);
	h.check(!(await h.audioMetrics(A, 400)).silent, '4.5 and the sound is back');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. duplicate parity ===');
	// a GROUP holding both devices duplicates as ONE object with ONE create entry
	const groupUuid = await ap(page, 's.objectActions.applySelectionSet([arg.drone, arg.speaker]); const gu = s.objectActions.groupSelection(); return gu', ids);
	h.check(typeof groupUuid === 'string', '5.1 (premise) the pair is grouped (' + groupUuid + ')');
	await h.eventually(() => dbg(page), (d) => d.cables.length === 1 && d.cables[0].live, '5.2 (premise) grouping kept the cable routed');
	const dup = await ap(page, 'const before = ap.patchDebug().cables.map((c) => c.id); const clone = s.objectActions.duplicateObject(arg); await new Promise((r) => setTimeout(r, 400)); const d = ap.patchDebug(); return { cloneUuid: clone?.uuid ?? null, cables: d.cables.length, live: d.cables.filter((c) => c.live).length, newIds: d.cables.map((c) => c.id).filter((id) => !before.includes(id)) }', groupUuid);
	h.check(dup.cloneUuid && dup.cables === 2 && dup.live === 2, '5.3 duplicating the group copies its internal cable, remapped and routed (' + dup.cables + ' cables, ' + dup.live + ' live)');
	const remapped = await ap(page, 'const g = await new Promise((r) => s.objectsGroup.subscribe(r)()); const clone = g.getObjectByProperty("uuid", arg.clone); const inside = new Set(); clone.traverse((n) => inside.add(n.uuid)); const c = ap.patchDebug().cables.find((x) => x.id === arg.id); return c && inside.has(c.from.uuid) && inside.has(c.to.uuid) && c.from.uuid !== c.to.uuid', { clone: dup.cloneUuid, id: dup.newIds[0] });
	h.check(remapped === true, '5.4 the copied cable joins the COPY\'s children, not the originals');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => dbg(page), (d) => d.cables.filter((c) => c.live).length === 1 && d.cables.filter((c) => c.drawn).length === 1, '5.5 ONE undo removes the whole copy — its cable is an orphan (unrouted, undrawn), the original still routes');
	const snapAfter = await ap(page, 'return ap.patchSnapshot().cables.length');
	h.check(snapAfter === 1, '5.6 and a save would carry only the original\'s cable (' + snapAfter + ')');
	await page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => dbg(page), (d) => d.cables.filter((c) => c.live).length === 2, '5.7 redo brings the copy back with its cable routed again');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => dbg(page), (d) => d.cables.filter((c) => c.live).length === 1, '5.8 (cleanup) the copy is undone');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. never in a GLTF export ===');
	const gltf = await ap(page, 'const { GLTFExporter } = s.GLTFExporterModule; const g = await new Promise((r) => s.objectsGroup.subscribe(r)()); const out = await new GLTFExporter().parseAsync(g); const names = (out.nodes ?? []).map((n) => n.name ?? ""); return { total: names.length, cables: names.filter((n) => n === "audio-cable" || n === "audio-cables").length }');
	h.check(gltf.total > 0 && gltf.cables === 0, '6.1 a GLTF export of objectsGroup carries no cable mesh (' + gltf.total + ' nodes, ' + gltf.cables + ' cables)');
	// the counterfactual, in place: parent the cable root under objectsGroup and export again
	const cf = await ap(page, 'const { GLTFExporter } = s.GLTFExporterModule; const g = await new Promise((r) => s.objectsGroup.subscribe(r)()); const root = ap.cableRoot(); const scene = root.parent; g.add(root); const out = await new GLTFExporter().parseAsync(g); scene.add(root); const names = (out.nodes ?? []).map((n) => n.name ?? ""); return names.filter((n) => n === "audio-cable" || n === "audio-cables").length');
	h.check(cf > 0, '6.2 (counterfactual) parented under objectsGroup the same export DOES carry them (' + cf + ') — the check can fail');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. two peers: replicate, late join, undo on both ===');
	const B = await h.setupPage(browser, 'B', { audio: true });
	await ap(B.page, KINDS);
	await h.connect(B, A);
	await h.eventually(() => dbg(B.page), (d) => d.cables.filter((c) => c.live).length === 1, '7.1 the late joiner gets the patch from the handshake push, and routes it (both devices real on B; the orphan from section 5 rides along unrouted)', 15000);
	await page.waitForTimeout(300);
	h.check(!(await h.audioMetrics(B, 500)).silent, '7.2 B HEARS the cabled drone — synthesized on B from the same document');
	// a second cable made on B (drone -> a new speaker on B) reaches A
	const bSpeaker = await ap(B.page, "const sp = ad.addDevice('test-speaker', { position: [4, 0, 0] }); const id = ap.addCable({ from: { uuid: arg, port: 'out' }, to: { uuid: sp.uuid, port: 'in' } }); return { sp: sp.uuid, id }", ids.drone);
	await h.eventually(() => dbg(page), (d) => d.cables.filter((c) => c.live).length === 2, '7.3 a cable plugged on B appears on A and routes there (the object came first, the cable after)', 15000);
	// the cable was B's edit, so B's history holds it
	await B.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => dbg(page), (d) => d.cables.filter((c) => c.live).length === 1, '7.4 an undo on B removes B\'s cable on A too', 15000);
	await h.eventually(() => dbg(B.page), (d) => d.cables.filter((c) => c.live).length === 1, '7.5 and on B itself');
	const stale = await ap(B.page, 'const cur = ap.patchDebug(); const took = ap.applyRemotePatch({ cables: [], changedAt: cur.changedAt - 1 }); return { took, before: cur.cables.length, after: ap.patchDebug().cables.length }');
	h.check(stale.took === false && stale.before === stale.after, '7.6 a strictly OLDER document is refused');

	// ---------------------------------------------------------------- section 8
	console.log('\n=== 8. the autosave round trip ===');
	await page.evaluate(() => window.__stores.autosave.saveNow());
	await h.freshReload(A);
	A.id = await page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	await h.eventually(
		() => page.evaluate(() => new Promise((r) => window.__stores.autosave.restoreAvailable.subscribe((v) => r(!!v))())),
		(v) => v === true,
		'8.1 the restore offer appears after the reload'
	);
	await page.evaluate(() => window.__stores.autosave.restoreSnapshot());
	await h.eventually(() => dbg(page), (d) => d.cables.length === 1 && d.cables[0].endpointsPresent === true, '8.2 the cable comes back naming the restored objects (their uuids survived)', 8000);
	await ap(page, KINDS);
	await h.eventually(() => dbg(page), (d) => d.cables[0].live === true, '8.3 once the kinds register the devices build and the cable routes');
	await page.waitForTimeout(300);
	h.check(!(await h.audioMetrics(A, 500)).silent, '8.4 and it sounds');

	await h.finish(browser);
});
