// Roadmap 85b (lane 85-world) — the world tools END TO END: a REAL MCP stdio client spawns
// `tools/agent/src/cli.js mcp <link>`, the host approves, and every result is read back on the HOST page:
//   1  the new tools are listed, schemas verbatim from the host app's shared registry
//   2  "forest on hills": terrain (made, raised) + scatter on it — the host has the terrain and the set
//   3  "lake with a jetty": water {lake} — the host has the water blob; a pattern (planks) on the jetty's material
//   4  "campfire with sound": fire + fireflies particles; place_sound from an https WAV (host page's own executor,
//      the route is the test's) — the host's library holds the sound and a sound node targets the fire
//   5  G9 / G6b: create_mesh {subdivide: 1} and update_mesh {patch} — the host's mesh is rounded, then moved
//   6  undo_last takes each back on the host (one step per call), and the host's A8 log has a line per tool
//   7  a viewer's page refuses the writing tools; search_assets stays open
// Run: e2e-slot --dev <tree> 5873 -- node tests/e2e/agent-world.test.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const TOOLS = ['search_assets', 'place_asset', 'prefab', 'create_particles', 'scatter', 'terrain', 'water', 'place_sound', 'set_music', 'update_mesh'];

const read = (page, expr) =>
	page.evaluate(
		(e) => new Promise((r) => e.split('.').reduce((o, k) => o[k], window.__stores).subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))()),
		expr
	);

/** what the HOST holds for one object @param {any} page @param {string} uuid */
const onHost = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		const geo = o.geometry;
		let maxY = null;
		let far = null;
		if (geo?.attributes?.position) {
			geo.computeBoundingBox();
			maxY = geo.boundingBox.max.y;
			const p = geo.attributes.position;
			far = 0;
			for (let i = 0; i < p.count; i++) far = Math.max(far, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)));
		}
		return {
			name: o.name,
			terrain: !!o.userData.terrain,
			scatterSets: o.userData.terrainScatter?.sets?.length ?? 0,
			water: o.userData.water?.preset ?? null,
			particles: o.userData.particles?.preset ?? null,
			map: !!(Array.isArray(o.material) ? o.material[0] : o.material)?.map,
			tris: geo?.attributes?.position ? geo.attributes.position.count / 3 : 0,
			maxY,
			far
		};
	}, uuid);

const inLibrary = (page, hash) =>
	page.evaluate(
		(x) => new Promise((r) => window.__stores.explorer.explorerItems.subscribe((items) => r(items.some((i) => i.hash === x)))()),
		hash
	);

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
const short = (v) => JSON.stringify(v ?? null).slice(0, 220);

const CAP_MS = 15 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-world passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

/** a short silent WAV (44-byte header + 0.1 s of 8 kHz mono 16-bit) */
function wavBytes() {
	const n = 800;
	const b = Buffer.alloc(44 + n * 2);
	b.write('RIFF', 0);
	b.writeUInt32LE(36 + n * 2, 4);
	b.write('WAVE', 8);
	b.write('fmt ', 12);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(8000, 24);
	b.writeUInt32LE(16000, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write('data', 36);
	b.writeUInt32LE(n * 2, 40);
	return b;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let changed = 0;
	const B = await startBridge([BASE + '/#' + A.id], () => changed++);
	const ids = {};
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
		const tools = (await B.client.listTools()).tools;
		h.check(TOOLS.every((n) => tools.some((t) => t.name === n)), '1. the world tools are listed: ' + TOOLS.filter((n) => !tools.some((t) => t.name === n)).join(', '));
		const hostSchema = await A.page.evaluate(() => {
			const t = window.__stores.aiTools.getAiTools().find((x) => (x.function || x).name === 'scatter');
			return JSON.stringify((t.function || t).parameters);
		});
		h.check(JSON.stringify(tools.find((t) => t.name === 'scatter')?.inputSchema) === hostSchema, '1. scatter schema = the host registry, verbatim');
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		console.log('\n=== 2. forest on hills ===');
		const t = json(await call(B.client, 'terrain', { size: 30, height: 2, seed: 4, ops: [{ op: 'raise', at: [0, 0], radius: 6, height: 3 }] }));
		ids.terrain = t.created?.[0]?.uuid;
		h.check(!!ids.terrain && t.created[0].sculpted === 1, 'terrain: made and raised: ' + short(t));
		await h.eventually(() => onHost(A.page, ids.terrain), (o) => o?.terrain === true && o.maxY > 2.5, '2. the host has the terrain, with the hill', 30000);
		const s = json(await call(B.client, 'scatter', { surface: ids.terrain, asset: 'Cone', count: 40, scale: [0.6, 1.4], rules: { slope: [0, 35] }, seed: 9 }));
		h.check(s.updated?.[0]?.ok === true && !!s.updated[0].set, 'scatter: a set id: ' + short(s));
		await h.eventually(() => onHost(A.page, ids.terrain), (o) => o?.scatterSets === 1, '2. the host has the scatter set on the terrain', 30000);

		console.log('\n=== 3. lake with a jetty ===');
		const w = json(await call(B.client, 'water', { kind: 'lake', position: [40, 0, 0], level: 0.6 }));
		ids.lake = w.created?.[0]?.uuid;
		h.check(!!ids.lake, 'water: a lake: ' + short(w));
		await h.eventually(() => onHost(A.page, ids.lake), (o) => o?.water === 'lake', '3. the host has the lake water', 30000);
		const jetty = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [2, 0.2, 8], name: 'Jetty', position: [40, 1, 6] }] }));
		ids.jetty = jetty.created?.[0]?.uuid;
		const mat = json(await call(B.client, 'set_material', { objects: [ids.jetty], pattern: 'planks', patternScale: 2 }));
		h.check(!mat.error && (mat.patterns?.length ?? 0) === 1, 'set_material {pattern: planks}: ' + short(mat));
		await h.eventually(() => onHost(A.page, ids.jetty), (o) => o?.map === true, '3. the host\'s jetty wears the planks', 40000);
		await h.eventually(() => A.page.evaluate(() => new Promise((r) => window.__stores.explorer.explorerItems.subscribe((items) => r(items.some((i) => /planks/i.test(i.name))))())), (x) => x === true, '3. the planks texture is in the host\'s library', 40000);

		console.log('\n=== 4. campfire with sound ===');
		const fire = json(await call(B.client, 'create_particles', { preset: 'fire', position: [-6, 0, 0], name: 'Campfire' }));
		ids.fire = fire.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, ids.fire), (o) => o?.particles === 'fire', '4. the host has the fire emitter', 30000);
		const ff = json(await call(B.client, 'create_particles', { preset: 'fireflies', position: [-6, 1, 0] }));
		ids.flies = ff.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, ids.flies), (o) => o?.particles === 'fireflies', '4. W5b: the host has the fireflies', 30000);
		// the sound URL path runs in the host page's own executor, where the route is the test's
		await A.page.route('https://sounds.example.test/**', (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: wavBytes() }));
		await A.page.route('https://fake.example.test/**', (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: '<script>alert(1)</script>'.padEnd(64, ' ') }));
		const exec = (tool, args) => A.page.evaluate(([x, a]) => window.__stores.aiTools.executeAiTool(x, a), [tool, args]);
		// the host makes its own fire: the bridge's emitter replicates, and a sound node goes in the HOST's graph of it
		const snd = await exec('place_sound', { object: ids.fire, asset: 'https://sounds.example.test/crackle.wav', radius: 8, loop: true });
		const sndHash = snd.updated?.[0]?.sound;
		h.check(!snd.error && !!sndHash && snd.updated[0].addedToLibrary === true, 'place_sound: a library sound from https + a node: ' + short(snd));
		if (sndHash) await h.eventually(() => inLibrary(A.page, sndHash), (x) => x === true, '4. the sound is in the host\'s library by hash', 30000);
		const graph = await A.page.evaluate((u) => {
			/** @type {any} */ let g;
			window.__stores.flowGraphs.subscribe((x) => (g = x))();
			return (g?.[u]?.nodes ?? []).map((n) => n.type);
		}, ids.fire);
		h.check(graph.includes('sound'), '4. a sound node in the fire\'s own graph: ' + graph.join(','));
		const bad = await exec('place_sound', { object: ids.fire, asset: 'https://fake.example.test/x.wav' });
		h.check(/audio|sound|WAV|bytes/i.test(bad.error || ''), '4. COUNTERFACTUAL: a web page named .wav is refused: ' + String(bad.error).slice(0, 80));
		const http = await exec('place_sound', { object: ids.fire, asset: 'http://sounds.example.test/a.wav' });
		h.check(/https/.test(http.error || ''), '4. an http address is refused');

		console.log('\n=== 5. G9 subdivide + G6b update_mesh ===');
		const CUBE = {
			vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
			faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]
		};
		const peb = json(await call(B.client, 'create_mesh', { ...CUBE, subdivide: 2, name: 'Pebble', position: [0, 1, 8] }));
		ids.pebble = peb.created?.[0]?.uuid;
		h.check(peb.created?.[0]?.subdivided === 2 && peb.created[0].triangles === 192, 'create_mesh {subdivide: 2}: 192 triangles: ' + short(peb));
		await h.eventually(() => onHost(A.page, ids.pebble), (o) => o?.tris === 192 && o.far < 0.8, '5. the host\'s mesh is the rounded one', 30000);
		const box = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Wedge', position: [3, 1, 8] }));
		ids.wedge = box.created?.[0]?.uuid;
		const up = json(await call(B.client, 'update_mesh', { uuid: ids.wedge, mode: 'patch', offset: 2, vertices: [[0.5, 2, -0.5], [-0.5, 2, -0.5]] }));
		h.check(up.updated?.[0]?.ok === true, 'update_mesh {patch}: ' + short(up));
		await h.eventually(() => onHost(A.page, ids.wedge), (o) => Math.abs((o?.maxY ?? 0) - 2) < 1e-3, '5. the host\'s mesh has the moved corners', 30000);

		console.log('\n=== 6. undo_last, one step per call, and the A8 log ===');
		const u1 = json(await call(B.client, 'undo_last', {}));
		h.check(u1.undone?.length === 1, 'undo_last: ' + short(u1));
		await h.eventually(() => onHost(A.page, ids.wedge), (o) => Math.abs((o?.maxY ?? 0) - 0.5) < 1e-3, '6. the patch is taken back on the host (one step)', 30000);
		h.check(!!(await onHost(A.page, ids.wedge)), '6. and the mesh itself stays (the create is its own step)');
		await call(B.client, 'undo_last', { count: 2 }); // the wedge, the pebble
		await h.eventually(() => onHost(A.page, ids.pebble), (o) => o === null, '6. the pebble is gone from the host', 30000);
		// the fireflies, then the fire (the host's own place_sound sits on the HOST's stack, not the agent's)
		await call(B.client, 'undo_last', {});
		await h.eventually(() => onHost(A.page, ids.flies), (o) => o === null, '6. the fireflies are gone from the host', 30000);
		await h.eventually(
			() => read(A.page, 'agentLog.agentLog'),
			(l) => ['terrain', 'scatter', 'water', 'create_particles', 'create_mesh', 'update_mesh', 'set_material'].every((x) => (l || []).some((e) => e.tool === x)),
			'6. the host\'s A8 log has a line for each tool',
			20000
		);
		const log = await read(A.page, 'agentLog.agentLog');
		for (const e of (log || []).filter((x) => [...TOOLS, 'create_mesh', 'set_material'].includes(x.tool))) console.log('   · ' + e.tool + ': ' + e.text);
		const scatterLine = log.find((e) => e.tool === 'scatter');
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), scatterLine);
		await h.eventually(() => onHost(A.page, ids.terrain), (o) => o?.scatterSets === 0, '6. per-line Undo on the scatter line takes the forest off the host\'s terrain', 30000);
		const lakeLine = log.find((e) => e.tool === 'water');
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lakeLine);
		await h.eventually(() => onHost(A.page, ids.lake), (o) => o === null, '6. per-line Undo on the water line removes the lake', 30000);
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}

	console.log('\n=== 7. a viewer is refused ===');
	const V = await h.setupPage(browser, 'V', { storage: { agentApi: '1' } });
	await V.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(V, A);
	await V.page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: '', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole: () => {}, synced: () => true })
	);
	const before = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	for (const [tool, args] of [
		['terrain', {}],
		['water', { kind: 'pool' }],
		['create_particles', { preset: 'sparkles' }],
		['scatter', { surface: 'x', asset: 'Cone' }],
		['update_mesh', { uuid: 'x', vertices: [] }],
		['set_music', { stop: true }]
	]) {
		const r = await V.page.evaluate(([x, a]) => window.tpAgent.exec(x, a), [tool, args]);
		h.check(r?.refused === true || r?.viewOnly === true, '7. a viewer\'s ' + tool + ' is refused: ' + String(r?.error).slice(0, 70));
		const direct = await V.page.evaluate(([x, a]) => window.__stores.aiTools.executeAiTool(x, a), [tool, args]);
		h.check(direct?.viewOnly === true, '7. and through the assistant\'s executor: ' + tool);
	}
	const search = await V.page.evaluate(() => window.__stores.aiTools.executeAiTool('search_assets', { query: 'box', kinds: ['prefab'] }));
	h.check(!search?.viewOnly && Array.isArray(search?.results), '7. search_assets stays open to a viewer: ' + short(search).slice(0, 100));
	await new Promise((r) => setTimeout(r, 1500));
	const after = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	h.check(after === before, '7. nothing reached the host from the viewer (' + before + ' → ' + after + ')');

	await bounded(h.finish(browser), 30000);
	process.exit(2);
});
