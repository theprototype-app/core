// Roadmap 85 L1-L5 — the look tools END TO END through the agent bridge: a REAL MCP stdio client spawns
// `tools/agent/src/cli.js mcp <link>`, the host approves, and every result is read back on the HOST page:
//   1  the tools are listed, schemas verbatim from the host registry
//   2  set_material: fields replicate; a raw-string map and a local URL are refused; list/get read it back
//   3  create_shader: compile errors come back and write nothing; a good graph's uniform name, driven by
//      a real setuniform flow node, moves on the host; edit_shader; assign_shader off
//   4  uv_unwrap and per-face set_uv reach the host's geometry
//   5  set_post: nothing changes until the HOST presses Allow in its real toast; the re-call applies it;
//      Deny leaves it as it was; create_post_graph asks too
//   6  the host's A8 log has one line per call, none for a question; per-line Undo takes each back
//   6b + 3b the docs' cookbook: a glassy floor, a glowing sign, a warm film look
//   7  textures (an editor agent page with a routed CDN, because the MCP page cannot be routed): an https
//      URL becomes a library item and a normal + albedo map on the HOST; tiling reaches the host; an SVG
//      called a PNG and a response with no CORS header are refused
//   8  a viewer's page refuses every writer and may read
// Run: e2e-slot --dev <tree> 5872 -- node tests/e2e/agent-look.test.cjs
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const TOOLS = ['set_material', 'list_materials', 'get_material', 'create_shader', 'edit_shader', 'assign_shader', 'describe_shader_nodes', 'set_post', 'get_post', 'create_post_graph', 'uv_unwrap', 'set_uv'];
const WRITERS = ['set_material', 'create_shader', 'edit_shader', 'assign_shader', 'set_post', 'create_post_graph', 'uv_unwrap', 'set_uv'];
const GLOW = 'glow = float {value: 2}\nout = surface\nglow -> out.emissive';

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
		const m = Array.isArray(o.material) ? o.material[0] : o.material;
		const uv = o.geometry?.attributes?.uv;
		let maxU = 0;
		if (uv) for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i));
		return {
			color: m?.color?.getHexString?.() ?? null,
			roughness: m?.roughness ?? null,
			emissive: m?.emissive?.getHexString?.() ?? null,
			opacity: m?.opacity ?? null,
			hasMap: !!m?.map,
			hasNormal: !!m?.normalMap,
			repeat: m?.map ? [m.map.repeat.x, m.map.repeat.y] : null,
			normalRepeat: m?.normalMap ? [m.normalMap.repeat.x, m.normalMap.repeat.y] : null,
			corners: uv?.count ?? 0,
			maxU,
			uvs: uv ? Array.from(uv.array).slice(0, 12) : null,
			driven: !!window.__stores.shaderGraph.isShaderDriven(u)
		};
	}, uuid);
const uniformOnHost = (page, uuid, name) =>
	page.evaluate(([u, n]) => window.__stores.shaderGraph.shaderUniform(u, n)?.value ?? null, [uuid, name]);
const postOnHost = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__stores.scenePost.postStackFor('scene').effects.map((e) => ({ kind: e.kind, params: e.params })))));

/** the host's real prompt, a real click @param {any} page @param {RegExp} text @param {'Allow'|'Deny'} word */
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
const short = (v) => JSON.stringify(v ?? null).slice(0, 220);

/** a real PNG of one colour, so the app's decode + re-encode has something to chew on */
function png(rgb, size = 8) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b) => {
		let c = 0xffffffff;
		for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const head = Buffer.alloc(13);
	head.writeUInt32BE(size, 0);
	head.writeUInt32BE(size, 4);
	head[8] = 8;
	head[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(size).fill(Buffer.from(rgb)))]);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

const CAP_MS = 15 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-look passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let changed = 0;
	const B = await startBridge([BASE + '/#' + A.id], () => changed++);
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
		const tools = (await B.client.listTools()).tools;
		h.check(TOOLS.every((n) => tools.some((t) => t.name === n)), '1. every look tool is listed');
		const hostSchema = await A.page.evaluate(() => {
			const t = window.__stores.aiTools.getAiTools().find((x) => (x.function || x).name === 'set_material');
			return JSON.stringify((t.function || t).parameters);
		});
		h.check(JSON.stringify(tools.find((t) => t.name === 'set_material')?.inputSchema) === hostSchema, '1. set_material schema = the host registry, verbatim');
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		const make = async (name, position) => {
			const r = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [1, 1, 1], name, position }] }));
			const id = r.created?.[0]?.uuid;
			if (!id) throw new Error('create_objects: ' + short(r));
			await h.eventually(() => onHost(A.page, id), (o) => !!o, 'premise: the host has ' + name, 20000);
			return id;
		};

		console.log('\n=== 2. set_material ===');
		const crate = await make('Crate', [0, 0.5, 0]);
		const painted = json(await call(B.client, 'set_material', { objects: [crate], color: '#ff0000', roughness: 0.25, emissive: 'orange', opacity: 0.5 }));
		h.check(painted.updated?.[0]?.uuid === crate, 'set_material answers the uuid: ' + short(painted));
		await h.eventually(() => onHost(A.page, crate), (o) => o?.color === 'ff0000' && o.roughness === 0.25 && o.emissive === 'ffa500' && o.opacity === 0.5, '2. the host\'s Crate is red, rough 0.25, orange glow, half see-through', 20000);
		const raw = json(await call(B.client, 'set_material', { objects: [crate], maps: { albedo: 'wood.png' } }));
		h.check(/neither a library image hash/.test(raw.error || ''), '2. a raw-string map is refused: ' + String(raw.error).slice(0, 90));
		const local = json(await call(B.client, 'set_material', { objects: [crate], maps: { albedo: 'https://localhost/a.png' } }));
		h.check(/local or private/.test(local.error || ''), '2. a local URL is refused: ' + String(local.error).slice(0, 90));
		const http = json(await call(B.client, 'set_material', { objects: [crate], maps: { albedo: 'http://example.com/a.png' } }));
		h.check(!!http.error, '2. a plain http URL is refused: ' + String(http.error).slice(0, 90));
		const got = json(await call(B.client, 'get_material', { object: crate }));
		h.check(got.slots?.[0]?.color === '#ff0000' && got.slots[0].roughness === 0.25, '2. get_material reads it back: ' + short(got.slots?.[0]));
		const list = json(await call(B.client, 'list_materials'));
		h.check(list.objects?.some((o) => o.uuid === crate), '2. list_materials has it');

		console.log('\n=== 3. shaders ===');
		const sign = await make('Sign', [3, 0.5, 0]);
		const bad = json(await call(B.client, 'create_shader', { objects: [sign], text: 'c = colour\nout = surface\nc -> out.emissive' }));
		h.check(/unknown type "colour"/.test((bad.errors || [])[0] || ''), '3. a bad node type comes back named: ' + short(bad.errors));
		const broken = json(await call(B.client, 'create_shader', { objects: [sign], text: 'c = color\nout = surface\nc -> out.albedoo' }));
		h.check(/albedoo/.test((broken.errors || [])[0] || ''), '3. a bad socket comes back named: ' + short(broken.errors));
		h.check((await onHost(A.page, sign)).driven === false, '3. neither wrote a shader on the host');
		const made = json(await call(B.client, 'create_shader', { objects: [sign], text: GLOW }));
		const facts = made.created?.[0];
		h.check(facts?.uniforms?.some((u) => u.uniform === 'u_glow_value' && u.drivable), '3. create_shader names its uniform: ' + short(facts?.uniforms));
		await h.eventually(() => onHost(A.page, sign), (o) => o?.driven === true, '3. the host\'s Sign wears the shader', 20000);
		await h.eventually(() => uniformOnHost(A.page, sign, 'u_glow_value'), (v) => v === 2, '3. the host compiled it: u_glow_value = 2', 30000);

		const flow = json(await call(B.client, 'create_flow_nodes', { graph: sign, nodes: [{ type: 'setuniform', data: { uniform: 'u_glow_value', value: 7 } }] }));
		h.check(!flow.error && !flow.partial, '3. a setuniform node in the Sign\'s flow: ' + short(flow));
		await h.eventually(() => uniformOnHost(A.page, sign, 'u_glow_value'), (v) => v === 7, '3. the flow node DRIVES the uniform on the host (2 → 7)', 30000);

		const edited = json(await call(B.client, 'edit_shader', { shader: sign, add: 'r = float {value: 0.1}\nr -> out.roughness' }));
		h.check(edited.updated?.[0]?.nodes?.includes('r'), '3. edit_shader adds a node: ' + short(edited.updated?.[0]?.nodes));
		const wrong = json(await call(B.client, 'edit_shader', { shader: sign, params: [{ node: 'glow', param: 'nope', value: 1 }] }));
		h.check(/no param "nope"/.test((wrong.errors || [])[0] || ''), '3. edit_shader names a bad param');
		await h.eventually(() => uniformOnHost(A.page, sign, 'u_r_value'), (v) => v === 0.1, '3. the host recompiled: u_r_value = 0.1', 30000);
		const doc = json(await call(B.client, 'describe_shader_nodes', { types: ['fresnel'] }));
		h.check(doc.nodes?.[0]?.type === 'fresnel', '3. describe_shader_nodes answers');
		const refused = json(await call(B.client, 'set_material', { objects: [sign], roughness: 0.2 }));
		h.check(/wears a shader graph/.test(refused.error || ''), '3. set_material refuses a shader-driven object');

		const driver = await make('Driver', [7, 0.5, 0]);
		const noGlsl = json(await call(B.client, 'create_shader', { objects: [driver], text: 'x = glsl {expression: "not glsl ("}\nout = surface\nx -> out.emissive' }));
		console.log('   compile answer: ' + short(noGlsl));
		h.check(/undeclared identifier|syntax error/.test(noGlsl.skipped?.[0]?.errors?.[0] || ''), '3. broken GLSL: the compiler\'s own error comes back');
		await h.eventually(() => onHost(A.page, driver), (o) => o?.driven === false, '3. and the host\'s object wears no shader', 8000);

		console.log('\n=== 3b. the cookbook ===');
		const lit = await make('Lit sign', [9, 0.5, 0]);
		const glowing = json(await call(B.client, 'create_shader', { objects: [lit], text: 'c = color {value: "#ff8800"}\npower = float {value: 4}\nglow = multiply\nc -> glow.a\npower -> glow.b\nout = surface\nglow -> out.emissive' }));
		h.check(glowing.created?.[0]?.uniforms?.some((u) => u.uniform === 'u_power_value' && u.drivable) && !glowing.created?.[0]?.errors?.length, 'glowing sign: compiles in a real GL context, names u_power_value: ' + short(glowing.created?.[0]));
		const pane = await make('Glass floor', [11, 0.5, 0]);
		const glassy = json(await call(B.client, 'set_material', { objects: [pane], type: 'MeshPhysicalMaterial', color: '#dfeaf5', roughness: 0.05, metalness: 0, params: { transmission: 0.9, ior: 1.5, clearcoat: 1 } }));
		h.check(glassy.updated?.[0]?.uuid === pane, 'glassy floor: answered ok: ' + short(glassy));
		await h.eventually(() => A.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); const m = g.getObjectByProperty('uuid', u)?.material; return m?.type + ':' + m?.transmission; }, pane), (v) => v === 'MeshPhysicalMaterial:0.9', 'glassy floor: the host has a physical material with transmission 0.9', 20000);

		const copy = await make('Copy', [5, 0.5, 0]);
		const assigned = json(await call(B.client, 'assign_shader', { objects: [copy], shader: sign }));
		h.check(assigned.updated?.[0]?.uuid === copy, '3. assign_shader copies: ' + short(assigned));
		await h.eventually(() => onHost(A.page, copy), (o) => o?.driven === true, '3. the host\'s Copy wears it', 20000);
		const off = json(await call(B.client, 'assign_shader', { objects: [copy], shader: null }));
		h.check(off.updated?.[0]?.shader === null, '3. assign_shader null takes it off');
		await h.eventually(() => onHost(A.page, copy), (o) => o?.driven === false, '3. the host\'s Copy is plain again', 20000);

		console.log('\n=== 4. UVs ===');
		const block = await make('Block', [-3, 0.5, 0]);
		const before = await onHost(A.page, block);
		const un = json(await call(B.client, 'uv_unwrap', { objects: [block], method: 'smart' }));
		h.check(un.updated?.[0]?.ok === true, '4. uv_unwrap smart answers ok: ' + short(un));
		await h.eventually(() => onHost(A.page, block), (o) => o?.corners === 36 && JSON.stringify(o.uvs) !== JSON.stringify(before.uvs), '4. the host has the unwrapped UVs', 20000);
		const tiled = json(await call(B.client, 'set_uv', { objects: [block], faces: { normal: 'up' }, tiling: 3 }));
		h.check(tiled.updated?.[0]?.triangles === 2, '4. set_uv faces picks the top two triangles: ' + short(tiled));
		await h.eventually(() => onHost(A.page, block), (o) => o?.maxU > 2.5, '4. the host\'s top face is tiled three times', 20000);
		const noTex = json(await call(B.client, 'set_uv', { objects: [block], tiling: 2 }));
		h.check(/no texture/.test(noTex.error || (noTex.skipped || [])[0]?.reason || ''), '4. tiling a slot with no texture says so: ' + short(noTex));

		console.log('\n=== 5. scene-wide: the host decides ===');
		const asked = json(await call(B.client, 'set_post', { effects: [{ kind: 'bloom', params: { intensity: 2 } }] }));
		h.check(asked.needsConfirm === true && !!asked.confirmId, '5. set_post returns needsConfirm: ' + short(asked));
		h.check((await postOnHost(A.page)).length === 0, '5. nothing changed on the host yet');
		const pending = json(await call(B.client, 'set_post', { confirmId: asked.confirmId }));
		h.check(pending.needsConfirm === true, '5. still pending before an answer');
		await answer(A.page, /add bloom/, 'Allow');
		const applied = json(await call(B.client, 'set_post', { confirmId: asked.confirmId, wait: 30 }));
		h.check(applied.effects?.[0]?.kind === 'bloom' && !!applied.effects[0].id, '5. Allow: the re-call applied it and returns ids: ' + short(applied));
		await h.eventually(() => postOnHost(A.page), (e) => e.length === 1 && e[0].kind === 'bloom' && e[0].params?.intensity === 2, '5. the host has bloom', 20000);
		const twice = json(await call(B.client, 'set_post', { confirmId: asked.confirmId }));
		h.check(twice.alreadyApplied === true, '5. a repeat does not apply it twice');
		const read1 = json(await call(B.client, 'get_post'));
		h.check(read1.effects?.length === 1 && Array.isArray(read1.kinds || read1.available || []), '5. get_post reads the stack');

		const asked2 = json(await call(B.client, 'set_post', { effects: [{ kind: 'vignette' }] }));
		await answer(A.page, /add vignette/, 'Deny');
		const denied = json(await call(B.client, 'set_post', { confirmId: asked2.confirmId, wait: 30 }));
		h.check(denied.denied === true, '5. Deny comes back: ' + short(denied));
		h.check((await postOnHost(A.page)).length === 1, '5. Deny: the host still has only bloom');

		const asked3 = json(await call(B.client, 'create_post_graph', { preset: 'posterise' }));
		h.check(asked3.needsConfirm === true, '5. create_post_graph asks too: ' + short(asked3));
		await answer(A.page, new RegExp(String(asked3.summary).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40)), 'Allow');
		const graph = json(await call(B.client, 'create_post_graph', { confirmId: asked3.confirmId, wait: 30 }));
		h.check(!graph.error && !graph.errors, '5. Allow: create_post_graph applied: ' + short(graph));
		await h.eventually(() => postOnHost(A.page), (e) => e.length === 2, '5. the host has a second post effect', 20000);

		console.log('\n=== 6. the A8 log + Undo from the host ===');
		const want = ['set_material', 'create_shader', 'edit_shader', 'assign_shader', 'set_post', 'create_post_graph', 'uv_unwrap', 'set_uv'];
		await h.eventually(() => read(A.page, 'agentLog.agentLog'), (l) => want.every((t) => (l || []).some((e) => e.tool === t)), '6. the host\'s A8 log has a line for each writer', 20000);
		const log = await read(A.page, 'agentLog.agentLog');
		for (const e of (log || []).filter((x) => TOOLS.includes(x.tool))) console.log('   · ' + e.tool + ': ' + e.text);
		const postLines = (log || []).filter((e) => e.tool === 'set_post');
		h.check(postLines.filter((e) => e.ok !== false).length === 1, '6. one applied set_post line: the questions and the repeat wrote none');
		h.check(postLines.filter((e) => e.ok === false).length === 1 && /said no/.test(postLines.find((e) => e.ok === false)?.text || ''), '6. the Deny is on the log as a line that changed nothing');
		h.check(!(log || []).some((e) => ['list_materials', 'get_material', 'get_post', 'describe_shader_nodes'].includes(e.tool)), '6. a read writes no line');
		const lineOf = (tool) => {
			// the log is oldest first: each object's first line, so these are deep undos, out of order
			const line = (log || []).find((e) => e.tool === tool && e.ok !== false);
			if (!line) throw new Error('no A8 line for ' + tool);
			return line;
		};
		const undo = (tool) => A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lineOf(tool));
		await undo('create_post_graph');
		await h.eventually(() => postOnHost(A.page), (e) => e.length === 1, '6. Undo create_post_graph: the host is back to bloom', 20000);
		await undo('set_post');
		await h.eventually(() => postOnHost(A.page), (e) => e.length === 0, '6. Undo set_post: the host\'s stack is empty', 20000);
		await undo('set_material');
		await h.eventually(() => onHost(A.page, crate), (o) => o?.roughness !== 0.25 && o?.color !== 'ff0000', '6. Undo set_material: the Crate is back', 20000);
		await undo('set_uv');
		await h.eventually(() => onHost(A.page, block), (o) => o?.maxU <= 1.001, '6. Undo set_uv: the top face is no longer tiled', 20000);
		await undo('create_shader');
		await h.eventually(() => onHost(A.page, sign), (o) => o?.driven === false, '6. Undo create_shader: the Sign is plain', 20000);

		console.log('\n=== 6b. the warm film look ===');
		const film = json(await call(B.client, 'set_post', { effects: [
			{ kind: 'huesaturation', params: { hue: 0.05, saturation: -0.1 } },
			{ kind: 'brightnesscontrast', params: { contrast: 0.1 } },
			{ kind: 'bloom', params: { intensity: 0.6 } },
			{ kind: 'vignette', params: { darkness: 0.5 } },
			{ kind: 'grain', params: { opacity: 0.15 } }
		] }));
		h.check(film.needsConfirm === true, 'warm film look: asks first');
		await answer(A.page, /huesaturation/, 'Allow');
		const filmed = json(await call(B.client, 'set_post', { confirmId: film.confirmId, wait: 30 }));
		h.check(filmed.effects?.length === 5, 'warm film look: five effects: ' + short(filmed.effects?.map((e) => e.kind)));
		await h.eventually(() => postOnHost(A.page), (e) => e.map((x) => x.kind).join() === 'huesaturation,brightnesscontrast,bloom,vignette,grain', 'warm film look: the host has them in that order', 20000);
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}

	console.log('\n=== 7. textures from a URL (an editor agent page, its CDN routed) ===');
	const E = await h.setupPage(browser, 'E', { storage: { agentApi: '1' } });
	await E.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await E.page.route('https://cdn.example.test/**', (route) => {
		const u = route.request().url();
		const cors = { 'access-control-allow-origin': '*' };
		if (u.endsWith('wood.png')) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/png' }, body: png([140, 90, 40]) });
		if (u.endsWith('wood_n.png')) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/png' }, body: png([128, 128, 255]) });
		if (u.endsWith('svg.png')) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/png' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' });
		// route.fulfill adds a CORS header of its own, so a real refusal is out of reach here; the browser hands a
		// CORS failure to fetch as this same network error, and the unit test covers the rest
		if (u.endsWith('nocors.png')) return route.abort('failed');
		return route.fulfill({ status: 404 });
	});
	await h.connect(E, A);
	const exec = (page, t, a) => page.evaluate(([x, y]) => window.tpAgent.exec(x, y), [t, a]);
	const floor = (await exec(E.page, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [2, 0.1, 2], name: 'Floor', position: [0, 0, 4] }] })).created?.[0]?.uuid;
	h.check(!!floor, 'premise: an editor agent made the Floor');
	await h.eventually(() => onHost(A.page, floor), (o) => !!o, 'premise: the host has the Floor', 20000);
	const svg = await exec(E.page, 'set_material', { objects: [floor], maps: { albedo: 'https://cdn.example.test/svg.png' } });
	h.check(/not an image/.test(svg.error || ''), '7. an SVG called a PNG is refused: ' + String(svg.error).slice(0, 80));
	const nocors = await exec(E.page, 'set_material', { objects: [floor], maps: { albedo: 'https://cdn.example.test/nocors.png' } });
	h.check(/CORS/.test(nocors.error || ''), '7. a fetch the browser blocks is refused and names CORS: ' + String(nocors.error).slice(0, 80));
	const tex = await exec(E.page, 'set_material', { objects: [floor], roughness: 0.1, maps: { albedo: 'https://cdn.example.test/wood.png', normal: 'https://cdn.example.test/wood_n.png' } });
	h.check(tex.updated?.[0]?.maps?.includes('albedo') && tex.updated[0].maps.includes('normal'), '7. both maps set: ' + short(tex.updated));
	h.check(tex.assets?.length === 2 && !!tex.assets[0].hash, '7. they came back as library items: ' + short(tex.assets));
	await h.eventually(() => onHost(A.page, floor), (o) => o?.hasMap && o.hasNormal && o.roughness === 0.1, '7. the HOST\'s Floor has the albedo and the normal map', 30000);
	const uvd = await exec(E.page, 'set_uv', { objects: [floor], tiling: [4, 4] });
	h.check(uvd.updated?.[0]?.maps?.includes('albedo'), '7. set_uv tiles the slot: ' + short(uvd.updated));
	await h.eventually(() => onHost(A.page, floor), (o) => o?.repeat?.[0] === 4 && o.normalRepeat?.[0] === 4, '7. the HOST\'s textures repeat four times', 20000);
	const byHash = await exec(E.page, 'set_material', { objects: [floor], maps: { ao: tex.assets[0].hash } });
	h.check(byHash.updated?.[0]?.maps?.includes('ao'), '7. a library hash works as a map: ' + short(byHash));
	await E.page.close().catch(() => {});

	console.log('\n=== 8. a viewer ===');
	const V = await h.setupPage(browser, 'V', { storage: { agentApi: '1' } });
	await V.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(V, A);
	await V.page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: '', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole: () => {}, synced: () => true })
	);
	const stack0 = await postOnHost(A.page);
	for (const [tool, args] of [
		['set_material', { objects: ['x'], roughness: 0.1 }],
		['create_shader', { objects: ['x'], text: GLOW }],
		['edit_shader', { shader: 'x', text: GLOW }],
		['assign_shader', { objects: ['x'], shader: null }],
		['set_post', { enabled: false }],
		['create_post_graph', { preset: 'posterise' }],
		['uv_unwrap', { objects: ['x'] }],
		['set_uv', { objects: ['x'], tiling: 2 }]
	]) {
		const r = await exec(V.page, tool, args);
		h.check(r?.refused === true || r?.viewOnly === true, '8. a viewer\'s ' + tool + ' is refused: ' + String(r?.error).slice(0, 70));
	}
	const vl = await exec(V.page, 'list_materials', {});
	h.check(Array.isArray(vl?.objects), '8. a viewer may read list_materials');
	await new Promise((r) => setTimeout(r, 1500));
	h.check(JSON.stringify(await postOnHost(A.page)) === JSON.stringify(stack0), '8. nothing reached the host from the viewer');
	h.check(WRITERS.length === 8, 'every writer was tried');

	await bounded(h.finish(browser), 30000);
	process.exit(2);
});
