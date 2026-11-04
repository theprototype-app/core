// Roadmap 85b RELEASE PROOF (85b-int) — ONE scripted agent session builds a small finished level END TO END through
// the real agent bridge (a REAL MCP stdio client spawns `tools/agent/src/cli.js mcp <link>`, the host approves), and
// every step is read back on the HOST page (a second peer):
//   1  terrain with scatter and water (effects)
//   2  sky + fog and a sun (set_sky / set_light: scene-wide → the host is asked, Allow), a sun light object
//   3  a textured floor (an L7 pattern) and a node shader on one object
//   4  a race HUD with a timer and a score text
//   5  spawn + play camera (FIRST person: no third-person Play camera exists yet — 85-scene QUESTIONS 4) + opening view
//   6  a campfire with particles and a crackle (an https sound copied into the library)
//   7  a lathed vase, a tube rail along a path, an extruded sign
//   8  four gems with collect chains; validate_scene has no error; playtest collects every gem (the host sees it)
//   9  undo_last reverts the last call; the host's A8 log has a line per writing call
//  10  a viewer is refused (and may still read)
// Not here (85-away moved to roadmap 90): the host-leaves / draft / accept-half flow.
// Run: e2e-slot --dev <tree> 5870 -- node tests/e2e/agent-level-proof.test.cjs
// PROOF_SOUND_URL overrides the crackle (default: a CC0 sound from the packs CDN; real network).
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const SOUND_URL = process.env.PROOF_SOUND_URL || 'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1/audio-essentials/assets/chop.ogg';
const WRITERS = ['terrain', 'scatter', 'water', 'set_sky', 'set_light', 'set_material', 'create_shader', 'create_hud', 'place_spawn', 'set_play_camera', 'create_particles', 'place_sound', 'create_lathe', 'create_tube', 'extrude_shape', 'create_objects', 'create_flow_nodes'];

const read = (page, expr) =>
	page.evaluate(
		(e) => new Promise((r) => e.split('.').reduce((o, k) => o[k], window.__stores).subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))()),
		expr
	);

/** the HOST's view of one object @param {any} page @param {string} uuid */
const onHost = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		const m = Array.isArray(o.material) ? o.material[0] : o.material;
		return {
			name: o.name,
			visible: o.visible,
			terrain: !!o.userData.terrain,
			scatterSets: o.userData.terrainScatter?.sets?.length ?? 0,
			water: o.userData.water?.preset ?? null,
			particles: o.userData.particles?.preset ?? null,
			map: !!m?.map,
			driven: !!window.__stores.shaderGraph.isShaderDriven(u)
		};
	}, uuid);

const envOnHost = (page) => read(page, 'environment.environment').catch(() => null);
const hudOnHost = (page) => read(page, 'hudDocs.hudDocs').catch(() => null);
const playOnHost = async (page) => {
	const st = await read(page, 'scenePhysics.scenePhysicsState_');
	return { spawn: st?.play?.spawn ?? null, startView: st?.startView ?? null };
};

async function answer(page, text, word) {
	const toast = page.locator('.tp-toast').filter({ hasText: text }).last();
	await toast.waitFor({ timeout: 30000 });
	await toast.getByRole('button', { name: word, exact: true }).click({ timeout: 30000 });
}

async function startBridge(args, onChanged) {
	const { Client } = await sdk('client/index.js');
	const { StdioClientTransport } = await sdk('client/stdio.js');
	const { ToolListChangedNotificationSchema } = await sdk('types.js');
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(agentDir, 'src/cli.js'), 'mcp', ...args, '--verbose'],
		env: { ...process.env },
		stderr: 'pipe'
	});
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChanged && onChanged());
	await client.connect(transport);
	return { client, transport };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
const short = (v) => JSON.stringify(v ?? null).slice(0, 240);
const uuidOf = (r) => r?.created?.[0]?.uuid ?? r?.created?.[0]?.id ?? r?.updated?.[0]?.uuid ?? null;

const CAP_MS = 20 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-level-proof passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let changed = 0;
	const B = await startBridge([BASE + '/#' + A.id], () => changed++);
	/** @type {Record<string, string>} */
	const id = {};
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));
		console.log('   agent contract ' + (st?.session?.version ?? st?.version));

		console.log('\n=== 1. terrain with scatter and water ===');
		const t = json(await call(B.client, 'terrain', { size: 60, height: 2, seed: 7, ops: [{ op: 'raise', at: [-15, -15], radius: 10, height: 4 }] }));
		id.terrain = uuidOf(t);
		h.check(!!id.terrain, '1. terrain made: ' + short(t));
		await h.eventually(() => onHost(A.page, id.terrain), (o) => o?.terrain === true, '1. the host has the terrain', 30000);
		const s = json(await call(B.client, 'scatter', { surface: id.terrain, asset: 'Cone', count: 40, scale: [0.6, 1.4], rules: { slope: [0, 35] }, seed: 3 }));
		h.check(!s.error, '1. scatter: ' + short(s));
		await h.eventually(() => onHost(A.page, id.terrain), (o) => o?.scatterSets >= 1, '1. the host\'s terrain carries the scatter set', 30000);
		const w = json(await call(B.client, 'water', { kind: 'lake', position: [18, 0, -18], level: 0.6 }));
		id.water = uuidOf(w);
		h.check(!!id.water, '1. water made: ' + short(w));
		if (!id.water) console.log('   status after water: ' + short(json(await call(B.client, 'status'))).slice(0, 400));
		await h.eventually(() => onHost(A.page, id.water), (o) => !!o?.water, '1. the host has the lake', 30000);

		console.log('\n=== 2. sky + fog, sun ===');
		const asked = json(await call(B.client, 'set_sky', { background: '#1a2238', fog: { color: '#1a2238', near: 20, far: 90 }, exposure: 0.8 }));
		h.check(asked.needsConfirm === true && !!asked.confirmId, '2. set_sky asks the host first: ' + short(asked));
		await answer(A.page, /the sky/, 'Allow');
		const sky = json(await call(B.client, 'set_sky', { confirmId: asked.confirmId, wait: 30 }));
		h.check(!sky.error && !sky.needsConfirm, '2. Allow: sky + fog applied: ' + short(sky));
		await h.eventually(() => envOnHost(A.page), (e) => e?.exposure === 0.8 && !!e?.customPreset?.fog, '2. the host has the fog and exposure', 20000);
		const askedL = json(await call(B.client, 'set_light', { sun: { intensity: 2.5, color: '#ffe8c8' } }));
		await answer(A.page, /the scene light/, 'Allow');
		const lit = json(await call(B.client, 'set_light', { confirmId: askedL.confirmId, wait: 30 }));
		h.check(!lit.error, '2. set_light (the sun): ' + short(lit));
		await h.eventually(() => envOnHost(A.page), (e) => e?.customPreset?.sun?.intensity === 2.5, '2. the host\'s sun is set', 20000);
		const sunObj = json(await call(B.client, 'create_objects', { objects: [{ kind: 'light', light: 'directional', name: 'Sun', position: [10, 20, 8], castShadow: true }] }));
		id.sun = uuidOf(sunObj);
		h.check(!!id.sun, '2. a sun light object: ' + short(sunObj));

		console.log('\n=== 3. textured floor + a shader ===');
		const floor = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Plaza', params: [10, 0.2, 10], position: [0, 2.1, 0] }] }));
		id.floor = uuidOf(floor);
		const mat = json(await call(B.client, 'set_material', { objects: [id.floor], pattern: 'planks', patternScale: 2 }));
		h.check(!mat.error && (mat.patterns?.length ?? 0) === 1, '3. set_material {pattern: planks}: ' + short(mat));
		await h.eventually(() => onHost(A.page, id.floor), (o) => o?.map === true, '3. the host\'s plaza wears the planks', 40000);
		const orb = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'Beacon', params: [0.5], position: [0, 3.5, -4] }] }));
		id.beacon = uuidOf(orb);
		const sh = json(await call(B.client, 'create_shader', { objects: [id.beacon], text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' }));
		h.check(!sh.error && !(sh.errors || []).length, '3. create_shader on the beacon: ' + short(sh.errors ?? sh.error));
		await h.eventually(() => onHost(A.page, id.beacon), (o) => o?.driven === true, '3. the host\'s beacon wears the shader', 30000);

		console.log('\n=== 4. race HUD ===');
		const hud = json(
			await call(B.client, 'create_hud', {
				screens: [
					{
						name: 'Race',
						showWhile: 'playing',
						elements: [
							{ kind: 'timer', anchor: 'top-right', duration: 120, countDown: true },
							{ kind: 'text', text: 'Gems 0/4', anchor: 'top-left', x: 16, y: 16 }
						]
					}
				]
			})
		);
		h.check(!hud.error && (hud.created?.[0]?.elements?.length ?? hud.elements?.length ?? 0) >= 2, '4. create_hud returns the element ids: ' + short(hud));
		await h.eventually(() => hudOnHost(A.page), (d) => JSON.stringify(d ?? {}).includes('Gems 0/4') && JSON.stringify(d).includes('"timer"'), '4. the host has the Race HUD (timer + score)', 20000);

		console.log('\n=== 5. spawn + play camera + opening view ===');
		const spawn = json(await call(B.client, 'place_spawn', { position: [0, 2.3, 4], facing: [0, 2.3, -4] }));
		h.check(!spawn.error, '5. place_spawn: ' + short(spawn));
		await h.eventually(() => playOnHost(A.page), (p) => !!p.spawn, '5. the host\'s scene has the spawn', 20000);
		const cam = json(await call(B.client, 'set_play_camera', { mode: 'first', openingView: 'spawn' }));
		h.check(!cam.error && !!cam.playCamera, '5. first-person play camera + opening view: ' + short(cam));
		await h.eventually(() => playOnHost(A.page), (p) => Array.isArray(p.startView?.position), '5. the host has the opening view', 20000);
		const third = json(await call(B.client, 'set_play_camera', { mode: 'third' }));
		h.check(third.unavailable === true, '5. GAP (listed): third person answers unavailable with the route: ' + String(third.error).slice(0, 80));

		console.log('\n=== 6. campfire: particles + sound ===');
		const fire = json(await call(B.client, 'create_particles', { preset: 'fire', position: [4, 2.2, 2], name: 'Campfire' }));
		id.fire = uuidOf(fire);
		await h.eventually(() => onHost(A.page, id.fire), (o) => o?.particles === 'fire', '6. the host has the fire', 30000);
		const snd = json(await call(B.client, 'place_sound', { object: id.fire, asset: SOUND_URL, radius: 8, loop: true }));
		h.check(!snd.error && !!snd.updated?.[0]?.sound, '6. place_sound from https (copied into the library): ' + short(snd));

		console.log('\n=== 7. vase, rail, sign ===');
		const vase = json(await call(B.client, 'create_lathe', { profile: [[0, 0], [0.35, 0.05], [0.45, 0.4], [0.2, 0.9], [0.28, 1.1], [0, 1.1]], segments: 32, name: 'Vase', position: [-3, 2.2, 2], color: '#c06030' }));
		id.vase = uuidOf(vase);
		const rail = json(await call(B.client, 'create_tube', { path: [[-5, 2.8, -5], [-2, 3, -5.2], [2, 3, -5.2], [5, 2.8, -5]], radius: 0.05, name: 'Rail' }));
		id.rail = uuidOf(rail);
		const sign = json(await call(B.client, 'extrude_shape', { points: [[-1, -0.4], [1, -0.4], [1, 0.4], [-1, 0.4]], depth: 0.1, name: 'Sign', position: [0, 3.2, 5] }));
		id.sign = uuidOf(sign);
		for (const k of ['vase', 'rail', 'sign']) await h.eventually(() => onHost(A.page, id[k]), (o) => !!o, '7. the host has the ' + k, 20000);

		console.log('\n=== 8. gems, validate, playtest ===');
		const gems = json(
			await call(B.client, 'create_objects', {
				objects: [1, 2, 3, 4].map((i) => ({ kind: 'primitive', primitive: 'Icosahedron', name: 'Gem_' + i, params: [0.25], position: [-3 + i * 1.5, 2.8, -1], color: '#37c6e6' }))
			})
		);
		for (const c of gems.created ?? []) id[c.name] = c.uuid;
		const GEMS = ['Gem_1', 'Gem_2', 'Gem_3', 'Gem_4'];
		h.check(GEMS.every((g) => !!id[g]), '8. four gems: ' + short(Object.keys(id)));
		for (const g of GEMS) {
			const f = json(
				await call(B.client, 'create_flow_nodes', {
					graph: id[g],
					nodes: [{ ref: 'c', type: 'onclick' }, { ref: 'l', type: 'latch' }, { ref: 'n', type: 'gate', data: { op: 'not' } }, { ref: 'v', type: 'visibility' }],
					edges: [{ from: 'c', to: 'l', toHandle: 'set' }, { from: 'l', to: 'n', toHandle: 'a' }, { from: 'n', to: 'v', toHandle: 'on' }]
				})
			);
			h.check(!f.error && !f.partial, '8. ' + g + ' collect chain: ' + short(f.errors ?? f.error));
		}
		const v = json(await call(B.client, 'validate_scene'));
		const errs = (v.issues ?? []).filter((i) => i.level === 'error');
		for (const i of v.issues ?? []) console.log('   · validate ' + i.level + ' ' + i.code + ': ' + String(i.message).slice(0, 120));
		h.check(errs.length === 0, '8. validate_scene: no error (' + (v.issues ?? []).length + ' notes): ' + short(errs));
		const pt = json(await call(B.client, 'playtest', { steps: [{ walk: [0, 2.3, 1] }, ...GEMS.map((g) => ({ click: id[g] })), { wait: 0.5 }] }));
		h.check(!pt.error, '8. playtest ran: ' + short(pt.error ?? pt.steps));
		const firedOn = (pt.fired ?? []).filter((f) => f.type === 'onclick').map((f) => f.on);
		h.check(GEMS.every((g) => firedOn.includes(g)), '8. each gem\'s On Click fired: ' + short(firedOn));
		for (const g of GEMS) await h.eventually(() => onHost(A.page, id[g]), (o) => o && o.visible === false, '8. the host sees ' + g + ' collected', 20000);

		console.log('\n=== 9. undo_last + the A8 log ===');
		const tower = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Cylinder', name: 'Tower', params: [1, 1, 6], position: [8, 5, -8] }] }));
		id.tower = uuidOf(tower);
		await h.eventually(() => onHost(A.page, id.tower), (o) => !!o, '9. premise: the host has the tower', 20000);
		const u = json(await call(B.client, 'undo_last', {}));
		h.check(!u.error, '9. undo_last: ' + short(u));
		await h.eventually(() => onHost(A.page, id.tower), (o) => o === null, '9. undo_last took the tower away on the host', 20000);
		h.check((await onHost(A.page, id.sign)) !== null, '9. …and only the tower (the sign stays)');
		await h.eventually(() => read(A.page, 'agentLog.agentLog'), (l) => WRITERS.every((tl) => (l || []).some((e) => e.tool === tl && e.ok !== false)), '9. the host\'s A8 log has a line for each writing tool', 30000);
		const log = await read(A.page, 'agentLog.agentLog');
		console.log('   A8 lines: ' + (log || []).length);
		for (const e of (log || []).slice(-40)) console.log('   · ' + e.tool + ': ' + String(e.text).slice(0, 110));
		h.check(!(log || []).some((e) => ['validate_scene', 'list_scene', 'status'].includes(e.tool)), '9. reads write no line');
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}

	console.log('\n=== 10. a viewer ===');
	const V = await h.setupPage(browser, 'V', { storage: { agentApi: '1' } });
	await V.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(V, A);
	await V.page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: '', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole: () => {}, synced: () => true })
	);
	const exec = (page, t, a) => page.evaluate(([x, y]) => window.tpAgent.exec(x, y), [t, a]);
	for (const [tool, args] of [
		['terrain', { size: 10 }],
		['create_particles', { preset: 'fire' }],
		['create_hud', { screens: [{ name: 'X', elements: [{ kind: 'text', text: 'hi' }] }] }],
		['place_spawn', { position: [1, 0, 1] }],
		['set_sky', { preset: 'night' }],
		['playtest', { steps: [{ wait: 0.1 }] }]
	]) {
		const r = await exec(V.page, tool, args);
		h.check(r?.refused === true || r?.viewOnly === true || /viewer|view only|view-only/i.test(String(r?.error)), '10. a viewer\'s ' + tool + ' is refused: ' + String(r?.error).slice(0, 70));
	}
	const vr = await exec(V.page, 'validate_scene', {});
	h.check(Array.isArray(vr?.issues), '10. a viewer may still validate (read-only)');
	await browser.close();
});
