// 23-D3 - the object-device requirements gap (finding 12). moduleRequirements derived what
// a scene needs from its FLOW; a music room is authored as objects (userData.device on
// meshes, cables in the patch document) and may hold no module node at all, so it asked for
// nothing and loaded as a piano-shaped object that makes no sound. A device KIND is now
// the second derivation signal, resolved kind -> module through the A3 registry, emitting
// the same {id, version} shape into the same prompt.
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');
const inPage = (page, body, arg) =>
	page.evaluate(([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'mr', 'arg', src)(window.__stores, window.__stores.audioDevices, window.__stores.moduleRequirements, a), [body, arg ?? null]);

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;

	console.log('\n=== 1. a device KIND is a requirement signal ===');
	const none = await inPage(page, 'return mr.moduleRequirements()');
	h.check(none.length === 0, '1.0 (premise) an empty scene requires nothing');
	await inPage(page, "await s.moduleSDK.initModules([{ id: 'tonemod', name: 'Tone Module', version: '3.2.0', register(api) { window.__toneKind = api.registerAudioDevice({ kind: 'tone', label: 'Tone', ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }, params: [], build(ctx) { const g = ctx.createGain(); return { output: g, dispose() {} }; } }); } }]); await window.__toneKind; return 1");
	const installed = await inPage(page, "return { req: mr.moduleRequirements(), kind: await window.__toneKind, spec: ad.deviceSpec(await window.__toneKind)?.moduleId ?? null }");
	h.check(installed.req.length === 0 && installed.kind === 'mod-tonemod-tone' && installed.spec === 'tonemod', '1.1 an installed but UNUSED device kind is not a requirement; the registry knows its module (' + JSON.stringify(installed) + ')');
	const used = await inPage(page, "const o = ad.addDevice('mod-tonemod-tone', { position: [0, 0, 0] }); return { uuid: o.uuid, req: mr.moduleRequirements(), payload: s.sessions.buildSessionPayload('room').modules ?? null }");
	h.check(used.req.length === 1 && used.req[0].id === 'tonemod' && used.req[0].version === '3.2.0', '1.2 a device OBJECT of that kind makes the module a requirement, with its version (' + JSON.stringify(used.req) + ')');
	h.check(Array.isArray(used.payload) && used.payload.length === 1 && used.payload[0].id === 'tonemod', '1.3 and the session payload carries it in the same shape (' + JSON.stringify(used.payload) + ')');
	const nested = await inPage(page, "const grp = new s.THREE.Group(); grp.name = 'Rack'; let g; s.objectsGroup.subscribe((v) => (g = v))(); const o = ad.findDeviceObject(arg); g.remove(o); grp.add(o); g.add(grp); s.objectsGroup.update((v) => v); return mr.moduleRequirements().map((r) => r.id)", used.uuid);
	h.check(nested.length === 1 && nested[0] === 'tonemod', '1.4 a device NESTED in a group still counts (the traverse, not the top level)');
	const gone = await inPage(page, "let g; s.objectsGroup.subscribe((v) => (g = v))(); const rack = g.getObjectByName('Rack'); g.remove(rack); s.objectsGroup.update((v) => v); return mr.moduleRequirements().length");
	h.check(gone === 0, '1.5 remove the device and the requirement is gone - derived from USE, never remembered');

	console.log('\n=== 2. a kind the registry has never seen still resolves through a known module id ===');
	// a scene saved on a newer build carries a kind string this build's registry never
	// registered - the longest-known-id parse resolves it exactly like a custom node def, and
	// an unknowable one contributes nothing (not a wrong id)
	const parsed = await inPage(page, "return { unregisteredKind: mr.moduleOfDeviceKind('mod-tonemod-newer-thing'), unknown: mr.moduleOfDeviceKind('mod-nobody-ever-thing'), core: mr.moduleOfDeviceKind('speaker'), registry: ad.deviceSpec('mod-tonemod-newer-thing') ?? null }");
	h.check(parsed.registry === null && parsed.unregisteredKind === 'tonemod', '2.1 a kind the registry does not hold resolves by the known module id (' + parsed.unregisteredKind + ')');
	h.check(parsed.unknown === null && parsed.core === null, '2.2 an unknowable kind and a core kind contribute nothing rather than a wrong id');

	console.log('\n=== 3. the prompt: a room with only DEVICES asks for its module ===');
	const tpscene = Buffer.from(zipSync({ 'session.json': strToU8(JSON.stringify({ format: 1, name: 'Jam', count: 1, objects: [], graphs: {}, nodes: [], edges: [], annotations: [], joints: [], camera: null, modules: [{ id: 'ghostmusic', version: '1.0.0' }] })) }));
	await page.evaluate((bytes) => { window.__importResult = 'pending'; window.__stores.sessions.importSessionZip(new Uint8Array(bytes).buffer).then((p) => (window.__importResult = p ? 'applied' : 'cancelled')); }, Array.from(tpscene));
	await h.eventually(() => page.locator('#confirm-dialog-install').count(), (n) => n === 1, '3.1 a saved room whose derived list names an absent module prompts before anything is touched');
	const text = await page.evaluate(() => new Promise((r) => window.__stores.confirmDialog.confirmDialog.subscribe((d) => r(d?.message ?? ''))()));
	h.check(/ghostmusic/.test(text), '3.2 and names it (' + JSON.stringify(text.slice(0, 80)) + ')');
	await page.locator('#confirm-dialog-cancel').click();
	await h.eventually(() => page.evaluate(() => window.__importResult), (v) => v === 'cancelled', '3.3 Cancel is a silent no-op');

	await h.finish(browser);
});
