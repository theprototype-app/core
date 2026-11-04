// mcp-diorama2 — an agent's diorama build report, END TO END through the agent bridge (a REAL MCP stdio client
// spawns `tools/agent/src/cli.js mcp <link>`, the host approves; results are read back on the HOST page):
//   1  restore + reconnect: a group with a mesh in it, autosaved, the host reloads and restores — the group is a
//      Group again, list_scene names the child's parentUuid, a new bridge builds INTO it; a missing parent = error
//   2  vertex colours: sRGB by default, hex per vertex, a white material under them
//   3  one minimum size: an octahedron of 2 mm
//   4  duplicate: a row of copies; mirror x in a group (world x negated, triangles re-wound)
//   5  scatter source + avoid: real copies on a floor, none on the rock
//   6  import_shape: OBJ with named parts (addressable), glTF JSON, a private / http address refused
//   7  shaders: glsl with vector inputs + polarCoordinates / twirl / rotateUV compile on the host GPU
//   8  set_post + screenshot {postEffects: true}: applied, or unavailable WITH the reason
//   9  status: sceneBudget.top, no family-rewritten keys
//  part 2: 27 callsBySource, 24 sound upload + pack sounds, 22 terrain peak + paintBy, 23 scatter circles + id,
//      25 front axis, 28 list_scene by touches, 26 screenshot view camera / hud / avatars, 21 confirm status
//  10  the Oppo N6, folded 390x896 and unfolded 770x850 @2.9: post drawn or the reason named; set_quality's card
//      on the person's own screen (Allow), then restore
// Run: e2e-slot --dev <tree> 5971 -- node tests/e2e/agent-diorama2.test.cjs
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const outDir = path.join(root, 'test-results/mcp-diorama2');
fs.mkdirSync(outDir, { recursive: true });
let bridgeSeq = 0;

/** what the HOST holds for one object @param {any} page @param {string} uuid */
const onHost = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		g.updateMatrixWorld(true);
		const r3 = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;
		const w = o.getWorldPosition(new o.position.constructor());
		const m = Array.isArray(o.material) ? o.material[0] : o.material;
		const col = o.geometry?.attributes?.color;
		return {
			name: o.name,
			type: o.type,
			isGroup: !!o.isGroup,
			parent: o.parent === g ? 'root' : o.parent?.uuid,
			children: o.children.map((c) => c.name),
			pos: o.position.toArray().map(r3),
			scale: o.scale.toArray().map(r3),
			world: w.toArray().map(r3),
			verts: o.geometry?.attributes?.position?.count ?? 0,
			color0: col ? r3(col.array[0]) : null,
			matColor: m?.color?.getHexString?.() ?? null,
			radius: o.geometry?.parameters?.radius ?? null
		};
	}, uuid);

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
	const logFile = path.join(outDir, 'bridge-' + ++bridgeSeq + '.log');
	transport.stderr?.on('data', (d) => fs.appendFileSync(logFile, d));
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChanged && onChanged());
	await client.connect(transport);
	return { client, transport };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
const short = (v) => JSON.stringify(v ?? null).slice(0, 260);
const near = (a, b, eps = 0.01) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
const b64 = (s) => Buffer.from(s).toString('base64');

const CAP_MS = 25 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-diorama2 passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

/** the host's real prompt, a real click @param {any} page @param {RegExp} text @param {string} word */
async function answer(page, text, word) {
	const toast = page.locator('.tp-toast').filter({ hasText: text }).last();
	await toast.waitFor({ timeout: 30000 });
	await toast.getByRole('button', { name: word, exact: true }).click({ timeout: 30000 });
}

const CUBE = {
	vertices: [[-0.2, 0, -0.2], [0.2, 0, -0.2], [0.2, 0.4, -0.2], [-0.2, 0.4, -0.2], [-0.2, 0, 0.2], [0.2, 0, 0.2], [0.2, 0.4, 0.2], [-0.2, 0.4, 0.2]],
	faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]
};
const EAR = { vertices: [[0.2, 0, 0], [0.6, 0, 0], [0.3, 0.5, 0.2]], faces: [[0, 1, 2]] };

/** join a bridge to `page`'s session and wait until it is in @param {any} A */
async function joinBridge(A) {
	let changed = 0;
	const id = await A.page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	const B = await startBridge([BASE + '/#' + id], () => changed++);
	await h.approveButton(A.page).click({ timeout: 120000 });
	await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
	let st = null;
	for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
		st = json(await call(B.client, 'status'));
		if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
	}
	if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));
	return B;
}
async function closeBridge(B) {
	await bounded(B.client.close().catch(() => {}), 10000);
	try {
		if (B.transport.pid) process.kill(B.transport.pid);
	} catch {}
}

/** the phone checks on one N6 posture @param {any} browser @param {string} name @param {{width: number, height: number}} viewport */
async function phone(browser, name, viewport, askQuality) {
	const P = await h.setupPage(browser, name, { context: { viewport, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true } });
	await h.answerRestore(P);
	const added = await P.page.evaluate(() => {
		const sp = /** @type {any} */ (window).__stores.scenePost;
		sp.addPostEffect('bloom');
		return sp.postStackFor('scene').effects.map((/** @type {any} */ e) => e.kind);
	});
	console.log('[' + name + '] scene post stack: ' + JSON.stringify(added));
	await P.page.waitForTimeout(4000);
	const state = await P.page.evaluate(async () => {
		const ps = await import('/src/lib/agent/postShot.js');
		const q = await import('/src/lib/qualityGovernor.js');
		/** @type {any} */ let level = null;
		q.qualityState.subscribe((v) => (level = v?.level ?? null))();
		const s = ps.postState();
		return { authored: s.authored, live: s.live, reason: s.reason, detail: s.detail, how: s.how, n: s.entries.length, level, chain: /** @type {any} */ (window).__postDebug?.().chain ?? null, ua: navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? null };
	});
	console.log('[' + name + '] post state: ' + JSON.stringify(state));
	h.check(
		state.live ? state.n > 0 && (!state.chain || state.chain.some((c) => /bloom/.test(c))) : !!state.reason && !!(state.how || state.detail),
		'10. ' + name + ': the bloom is drawn, or the reason is named with where to change it (' + (state.live ? 'drawn, governor level ' + state.level : state.reason) + ')'
	);
	if (askQuality) {
		const asked = await P.page.evaluate(async () => (await import('/src/lib/ai/lookTools.js')).lookTool('set_quality', { level: 'high' }));
		h.check(asked.needsConfirm === true && /^d/.test(String(asked.confirmId)), '10. ' + name + ': set_quality asks on the person\'s own screen: ' + short(asked));
		await answer(P.page, /quality on this device/, 'Allow');
		const done = await P.page.evaluate(async (id) => (await import('/src/lib/ai/lookTools.js')).lookTool('set_quality', { confirmId: id, wait: 15 }), asked.confirmId);
		h.check(done.quality === 'high' && done.updated?.[0]?.ok === true, '10. ' + name + ': Allow applied High on this device: ' + short(done));
		const back = await P.page.evaluate(async () => (await import('/src/lib/ai/lookTools.js')).lookTool('set_quality', { level: 'restore' }));
		h.check(back.restored === true && back.quality === done.was, '10. ' + name + ': restore puts the preset back (' + back.quality + ')');
	}
	await P.ctx.close();
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let B = await joinBridge(A);
	try {
		console.log('\n=== 1. restore + reconnect ===');
		const fox = json(await call(B.client, 'create_objects', { objects: [{ kind: 'group', name: 'Fox', position: [1, 0, 0] }] }));
		const foxId = fox.created?.[0]?.uuid;
		const body = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Body', parentUuid: foxId }));
		const bodyId = body.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, bodyId), (o) => o?.parent === foxId, '1. premise: the host has Body inside Fox', 20000);
		await closeBridge(B);
		await A.page.waitForTimeout(3000);
		await A.page.evaluate(() => window.__stores.autosave.saveNow());
		await A.page.waitForTimeout(1500);
		await h.freshReload(A);
		h.check(await h.answerRestore(A, 'restore', 60000), '1. the host was offered its session back and restored it');
		await h.eventually(() => onHost(A.page, foxId), (o) => o?.isGroup === true && o.type === 'Group', '1. after the restore Fox is a Group again (was a plain Object3D)', 30000);
		await h.eventually(() => onHost(A.page, bodyId), (o) => o?.parent === foxId, '1. Body is still inside Fox', 10000);
		B = await joinBridge(A);
		const scene = json(await call(B.client, 'list_scene', {}));
		const foxRow = scene.objects?.find((o) => o.uuid === foxId);
		const bodyRow = scene.objects?.find((o) => o.uuid === bodyId);
		h.check(/group/i.test(String(foxRow?.type ?? foxRow?.kind)), '1. list_scene: Fox reads as a group: ' + short(foxRow));
		h.check(bodyRow?.parentUuid === foxId, '1. list_scene: Body.parentUuid = Fox (was null): ' + short(bodyRow?.parentUuid));
		const tail = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Tail', parentUuid: foxId, position: [0.5, 0, 0] }));
		const tailId = tail.created?.[0]?.uuid;
		h.check(!!tailId && !tail.created[0].warnings, '1. a new mesh goes INTO the restored group: ' + short(tail));
		await h.eventually(() => onHost(A.page, tailId), (o) => o?.parent === foxId && near(o.pos, [0.5, 0, 0]), '1. the host: Tail in Fox at local [0.5, 0, 0]', 20000);
		const count = async () => (await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))())));
		const before = await count();
		const lost = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Lost', parentUuid: '00000000-0000-4000-8000-000000000000' }));
		h.check(/nothing was made/.test(lost.error || ''), '1. a missing parent is an error: ' + short(lost.error));
		h.check((await count()) === before, '1. ... and nothing was made at the root');

		console.log('\n=== 2. vertex colours ===');
		const paint = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Painted', position: [3, 0, 0], colors: ['#808080', [0.5, 0.5, 0.5], '#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#808080'] }));
		const paintId = paint.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, paintId), (o) => o && o.matColor === 'ffffff' && o.color0 !== null && Math.abs(o.color0 - 0.216) < 0.01, '2. white material, sRGB #808080 = linear 0.216 per vertex', 20000);
		const lin = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Linear', position: [4, 0, 0], colors: CUBE.vertices.map(() => [0.5, 0.5, 0.5]), colorSpace: 'linear' }));
		await h.eventually(() => onHost(A.page, lin.created?.[0]?.uuid), (o) => o && Math.abs(o.color0 - 0.5) < 0.01, '2. colorSpace linear passes 0.5 through', 20000);
		const badList = json(await call(B.client, 'create_mesh', { ...CUBE, colors: [[1, 1, 1], [1, 1, 1], [9, 0, 0]] }));
		h.check(/arrived|entries/.test(badList.error || ''), '2. a wrong colour list says how many arrived: ' + short(badList.error));

		console.log('\n=== 3. one minimum size ===');
		const tiny = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Octahedron', params: [0.002], name: 'Bead', position: [0, 1, 3] }] }));
		await h.eventually(() => onHost(A.page, tiny.created?.[0]?.uuid), (o) => o && Math.abs(o.radius - 0.002) < 1e-6, '3. an octahedron of 2 mm (it stopped at 10 cm)', 20000);

		console.log('\n=== 4. duplicate ===');
		const ear = json(await call(B.client, 'create_mesh', { ...EAR, name: 'Ear', parentUuid: foxId, position: [0.3, 0.4, 0] }));
		const earId = ear.created?.[0]?.uuid;
		const earHost = await h.eventually(() => onHost(A.page, earId), (o) => o?.parent === foxId, '4. premise: Ear in Fox', 20000);
		const twin = json(await call(B.client, 'duplicate', { uuid: earId, mirror: 'x' }));
		const twinId = twin.created?.[0]?.uuid;
		h.check(twin.mirror === 'x' && twin.rewound === 1, '4. mirror x re-wound one mesh: ' + short(twin));
		await h.eventually(() => onHost(A.page, twinId), (o) => o?.parent === foxId && near(o.pos, [-0.3, 0.4, 0]) && o.scale.every((s) => s > 0) && o.verts === 3, '4. the host: the mirrored Ear in Fox at local [-0.3, 0.4, 0], positive scale', 20000);
		void earHost;
		const post = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [0.2, 1, 0.2], name: 'Post', position: [-6, 0.5, -6] }] }));
		const postId = post.created?.[0]?.uuid;
		const row = json(await call(B.client, 'duplicate', { uuid: postId, count: 3, offset: [1, 0, 0] }));
		h.check(row.created?.length === 3, '4. three copies: ' + short(row.created?.map((c) => c.name)));
		await h.eventually(() => onHost(A.page, row.created?.[2]?.uuid), (o) => o && near(o.pos, [-3, 0.5, -6]), '4. the host: copy 3 at the source + 3 x offset', 20000);

		console.log('\n=== 5. scatter source + avoid ===');
		const floor = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [10, 0.2, 10], name: 'Floor', position: [20, 0, 0] }] }));
		const rock = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [4, 1, 4], name: 'Rock', position: [20, 0.5, 0] }] }));
		const sc = json(await call(B.client, 'scatter', { surface: floor.created?.[0]?.uuid, source: postId, count: 12, seed: 7, avoid: [rock.created?.[0]?.uuid] }));
		h.check(sc.copies > 0 && sc.copies <= 12 && sc.avoided === 1, '5. scatter source made real copies, avoiding one object: ' + short({ copies: sc.copies, avoided: sc.avoided, error: sc.error }));
		const spots = await Promise.all((sc.uuids ?? []).map((u) => onHost(A.page, u)));
		h.check(spots.length > 0 && spots.every((o) => o && o.world[0] >= 14.9 && o.world[0] <= 25.1 && o.world[2] >= -5.1 && o.world[2] <= 5.1), '5. every copy is on the floor');
		h.check(spots.every((o) => !(Math.abs(o.world[0] - 20) < 1.95 && Math.abs(o.world[2]) < 1.95)), '5. none on the rock\'s footprint');

		console.log('\n=== 6. import_shape ===');
		const obj = 'o Base\nv 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\nf 1 2 3 4\no Lid\nv 0 0.5 0\nv 1 0.5 0\nv 1 0.5 1\nv 0 0.5 1\nf 5 6 7 8\n';
		const chest = json(await call(B.client, 'import_shape', { data: b64(obj), name: 'Chest', position: [0, 0, -4] }));
		h.check(chest.format === 'obj' && !!chest.uuid, '6. an OBJ came in: ' + short({ format: chest.format, error: chest.error, file: chest.file }));
		const lidPart = chest.parts?.find((p) => p.name === 'Lid');
		h.check(!!lidPart && chest.parts.some((p) => p.name === 'Base'), '6. its named parts come back with uuids: ' + short(chest.parts?.map((p) => p.name)));
		await h.eventually(() => onHost(A.page, chest.uuid), (o) => o && o.children.includes('Lid') && o.children.includes('Base'), '6. the host has Chest with Base and Lid children', 30000);
		if (lidPart) {
			json(await call(B.client, 'update_objects', { updates: [{ uuid: lidPart.uuid, position: [0, 0.3, 0] }] }));
			await h.eventually(() => onHost(A.page, lidPart.uuid), (o) => o && near(o.pos, [0, 0.3, 0]), '6. the Lid part is addressable (moved by its uuid)', 20000);
		}
		const lib = await A.page.evaluate((hash) => new Promise((r) => window.__stores.explorer.explorerItems.subscribe((items) => r(items.some((i) => i.hash === hash)))()), chest.file?.hash);
		h.check(lib === true, '6. the file was copied into the library first: ' + short(chest.file));
		const pos = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
		const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Wing', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36, uri: 'data:application/octet-stream;base64,' + pos }] };
		const wing = json(await call(B.client, 'import_shape', { data: b64(JSON.stringify(gltf)), name: 'Glider', position: [2, 0, -4] }));
		h.check(wing.format === 'gltf' && wing.parts?.some((p) => p.name === 'Wing'), '6. a glTF JSON came in with its Wing: ' + short({ format: wing.format, error: wing.error, parts: wing.parts?.map((p) => p.name) }));
		const priv = json(await call(B.client, 'import_shape', { url: 'https://192.168.1.5/a.glb' }));
		h.check(/private|local/.test(priv.error || ''), '6. a private address is refused: ' + short(priv.error));
		const http = json(await call(B.client, 'import_shape', { url: 'http://example.com/a.glb' }));
		h.check(/https/.test(http.error || ''), '6. http is refused: ' + short(http.error));
		const ext = json(await call(B.client, 'import_shape', { data: b64(JSON.stringify({ ...gltf, buffers: [{ byteLength: 36, uri: 'https://example.com/a.bin' }] })) }));
		h.check(/self-contained/.test(ext.error || ''), '6. a file that points outside itself is refused: ' + short(ext.error));

		console.log('\n=== 7. shaders ===');
		const text = ['p = polarCoordinates', 't = twirl {strength: 5}', 'r = rotateUV {rotation: 0.3}', 'n = noise', 'c1 = color {value: "#ff8800"}', 'g = glsl {expression: "a * b", type: "vec3"}', 'out = surface', 'r -> t.uv', 't -> n.uv', 'c1 -> g.a', 'n -> g.b', 'g -> out.albedo', 'p.angle -> out.roughness'].join('\n');
		const marks = A.page.__console.length;
		const sh = json(await call(B.client, 'create_shader', { objects: [paintId], text, name: 'Swirl' }));
		h.check(!sh.error && !sh.errors, '7. the graph compiled: ' + short(sh.error || sh.errors || sh.shader || sh.key));
		await A.page.waitForTimeout(4000);
		const shaderErrors = A.page.__console.slice(marks).filter((m) => /Shader Error|ERROR: \d+:\d+/.test(m.text));
		h.check(shaderErrors.length === 0, '7. the host GPU compiled it (no shader errors): ' + short(shaderErrors.map((m) => m.text.slice(0, 120))));

		console.log('\n=== 8. post effects in a screenshot ===');
		const asked = json(await call(B.client, 'set_post', { effects: [{ kind: 'bloom', params: { intensity: 2 } }] }));
		if (asked.needsConfirm) {
			await answer(A.page, /bloom/, 'Allow');
			const applied = json(await call(B.client, 'set_post', { confirmId: asked.confirmId, wait: 30 }));
			h.check(asked.status === 'pending', '8. (21) a confirm ask says status pending: ' + short({ status: asked.status }));
			h.check(applied.effects?.[0]?.kind === 'bloom', '8. the host allowed a bloom: ' + short(applied));
			h.check(typeof applied.shownHere === 'boolean', '8. set_post says whether it shows on this screen: ' + short({ shownHere: applied.shownHere, reason: applied.reason }));
		}
		const shot = json(await call(B.client, 'screenshot', { postEffects: true, width: 320, height: 200 }));
		h.check(shot.postEffects === 'applied' || (shot.postEffects === 'unavailable' && !!shot.reason), '8. screenshot postEffects: ' + short({ postEffects: shot.postEffects, reason: shot.reason, detail: shot.detail }));

		console.log('\n=== 9. status ===');
		const st = json(await call(B.client, 'status'));
		const sb = st.sceneBudget ?? st.session?.sceneBudget;
		h.check(sb?.top?.byTriangles?.length > 0 && sb.top.byTriangles.every((r) => r.uuid && r.triangles >= 0), '9. sceneBudget.top names the heaviest objects: ' + short(sb?.top?.byTriangles?.slice(0, 2)));
		const keys = [];
		const walk = (v) => v && typeof v === 'object' && Object.entries(v).forEach(([k, x]) => (keys.push(k), walk(x)));
		walk(st);
		h.check(!keys.some((k) => /\{action/.test(k)), '9. no status key was rewritten into a tool call');

		// ---------------- part 2 (items 22-28) ----------------
		const cb = sb?.callsBySource;
		// an idle view (render on demand) leaves the draw calls out on purpose (calls null) rather than report 0
		const idleView = sb && sb.calls == null;
		h.check(idleView ? cb === undefined : !!cb && ['objects', 'otherInView', 'shadows', 'post', 'otherViews'].every((k) => typeof cb[k] === 'number'), '27. sceneBudget.callsBySource splits the draw calls (or the idle view leaves them out): ' + short(idleView ? { idle: true, calls: sb.calls } : cb));

		console.log('\n=== 24b. sound upload -> place_sound ===');
		const rate = 8000;
		const n = 800;
		const wav = Buffer.alloc(44 + n * 2);
		wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
		wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
		wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
		for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin((i * 2 * Math.PI * 440) / rate)), 44 + i * 2);
		const up = json(await call(B.client, 'upload_asset', { data: wav.toString('base64'), name: 'beep' }));
		h.check(up.kind === 'sound' && !!up.hash, '24b. a WAV upload lands in the library: ' + short({ kind: up.kind, hash: up.hash, error: up.error }));
		if (up.hash) {
			const snd = json(await call(B.client, 'place_sound', { asset: up.hash, position: [0, 1, 2], radius: 6 }));
			h.check(!snd.error && (snd.created?.length || snd.updated?.length), '24b. place_sound takes the uploaded hash: ' + short(snd.error || snd.created));
		}
		const bad = json(await call(B.client, 'upload_asset', { data: b64('<html>not a sound</html>xxxxxxxx') }));
		h.check(!!bad.error, '24b. junk bytes are refused: ' + short(bad.error));

		console.log('\n=== 24a. pack sounds in search_assets ===');
		const found = json(await call(B.client, 'search_assets', { kinds: ['sound'], sources: ['packs'] }));
		const packRow = (found.results ?? []).find((r) => String(r.id).startsWith('pack:'));
		if (!packRow) console.log('  SKIP 24a: no pack sound listed (CDN unreachable?) ' + short(found.error || found.note));
		else {
			h.check(packRow.kind === 'sound' && /music/.test(packRow.use ?? ''), '24a. a pack sound row with its use line: ' + short(packRow));
			const ps = json(await call(B.client, 'place_sound', { asset: packRow.id, position: [2, 1, 2] }));
			h.check(!ps.error, '24a. place_sound takes the pack id (copied into the library): ' + short(ps.error || ps.created));
		}

		console.log('\n=== 22. terrain height / edges / layers / paintBy ===');
		const ter = json(await call(B.client, 'terrain', { size: 30, position: [60, 0, 0], height: 5, edges: 'island', seed: 3, layers: [{ color: '#c2b280' }, { color: '#3a7d2c' }, { color: '#888888' }], paintBy: 'height' }));
		const tRow = ter.created?.[0];
		h.check(!!tRow?.uuid && Math.abs((tRow.peak ?? 0) - 5) < 0.6, '22. height = the highest peak: ' + short(tRow ?? ter.error));
		h.check(/height/.test(tRow?.paintedBy ?? ''), '22. paintBy height painted the layers: ' + short(tRow?.paintedBy));
		if (tRow?.uuid) {
			await h.eventually(
				() => A.page.evaluate((u) => { const d = window.__stores.terrainPaint?.splatDigest?.(u); return typeof d === 'string' ? d.length : 0; }, tRow.uuid),
				(len) => len > 0,
				'22. the host has the splat (layers draw)',
				30000
			);
		}

		console.log('\n=== 23. scatter avoid circle + rules.avoid + id ===');
		const pad = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [12, 0.2, 12], name: 'Meadow', position: [40, 0, 30] }] }));
		const padId = pad.created?.[0]?.uuid;
		const sc2 = json(await call(B.client, 'scatter', { surface: padId, assets: ['Cone', 'Sphere'], count: 60, seed: 11, id: 'meadow mix', avoid: [{ position: [40, 0, 30], radius: 3 }], rules: { avoid: [{ position: [44, 0, 34], radius: 1.5 }] } }));
		const setRow = sc2.updated?.[0];
		h.check(setRow?.set === 'meadow mix' && setRow.assets === 2, '23. one named set for both assets: ' + short(setRow ?? sc2.error));
		if (setRow?.set) {
			// the set reaches the host over the wire: wait for it before reading where the instances landed
			let inst = [];
			for (let i = 0; i < 60 && !inst.length; i++) {
				inst = await A.page.evaluate(({ u, id }) => (window.__stores.terrainPaint.scatterInstancesOf(u, id) ?? []).map((p) => [p.x, p.z]), { u: padId, id: setRow.set });
				if (!inst.length) await A.page.waitForTimeout(500);
			}
			h.check(inst.length > 0, '23. the host drew the set: ' + inst.length);
			h.check(inst.every(([x, z]) => x * x + z * z > 2.9 * 2.9), '23. none inside the 3 m circle at the centre');
			h.check(inst.every(([x, z]) => (x - 4) ** 2 + (z - 4) ** 2 > 1.4 * 1.4), '23. none inside the rules.avoid circle');
		}

		console.log('\n=== 25. front axis ===');
		const aimed = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Arrow', position: [0, 1, 10], lookAt: [5, 1, 10], front: '+x' }] }));
		const arrowId = aimed.created?.[0]?.uuid;
		const axisOut = await A.page.evaluate((u) => {
			let g; window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const o = g?.getObjectByProperty('uuid', u);
			if (!o) return null;
			o.updateMatrixWorld(true);
			const e = o.matrixWorld.elements;
			return [e[0], e[1], e[2]].map((v) => Math.round(v * 100) / 100);
		}, arrowId);
		h.check(!!axisOut && axisOut[0] > 0.95, '25. front +x points at the target (local +x -> world +x): ' + short(axisOut));

		console.log('\n=== 28. list_scene bounds by touches ===');
		const wall = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [20, 2, 0.3], name: 'Long wall', position: [0, 1, -30] }] }));
		const wallId = wall.created?.[0]?.uuid;
		const byOrigin = json(await call(B.client, 'list_scene', { bounds: { min: [8, 0, -31], max: [12, 3, -29] } }));
		const byTouch = json(await call(B.client, 'list_scene', { bounds: { min: [8, 0, -31], max: [12, 3, -29], by: 'touches' } }));
		const has = (r) => JSON.stringify(r).includes(wallId);
		h.check(!has(byOrigin) && has(byTouch), '28. a box at the wall\'s end finds it by touches, not by origin: ' + short({ origin: has(byOrigin), touches: has(byTouch) }));

		console.log('\n=== 26. screenshot camera / hud / avatars ===');
		await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create Camera'));
		// no agent tool makes a camera: the person does (the camera-objects suite's way), and the agent finds it
		let camRow = null;
		for (let i = 0; i < 40 && !camRow; i++) {
			camRow = await A.page.evaluate(() => {
				let g; window.__stores.objectsGroup.subscribe((x) => (g = x))();
				let found = null;
				g?.traverse((o) => { if (!found && o.userData?.camera) found = o.uuid; });
				return found;
			});
			if (!camRow) await A.page.waitForTimeout(250);
		}
		h.check(!!camRow, '26. the person made a camera object');
		if (camRow) {
			const ls = json(await call(B.client, 'list_scene', {}));
			let seen = JSON.stringify(ls).includes(camRow);
			for (let i = 0; i < 20 && !seen; i++) {
				await A.page.waitForTimeout(500);
				seen = JSON.stringify(json(await call(B.client, 'list_scene', {}))).includes(camRow);
			}
			h.check(seen, '26. the camera reached the agent');
		}
		const shotText = (r) => {
			const t = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).find((x) => x.includes('"camera"'));
			return t ? JSON.parse(t).camera : null;
		};
		if (camRow) {
			const viaCam = await call(B.client, 'screenshot', { view: 'camera', uuid: camRow, size: 256 });
			const cam = shotText(viaCam);
			h.check(cam?.subject?.kind === 'camera' && cam.subject.uuids?.[0] === camRow, '26. view camera looks through the camera object: ' + short(cam?.subject));
		}
		const noUuid = (await call(B.client, 'screenshot', { view: 'camera' })).content?.filter((c) => c.type === 'text').map((c) => c.text).join(' ') ?? '';
		h.check(/uuid/.test(noUuid) && /camera/.test(noUuid), '26. view camera without uuid explains itself: ' + short(noUuid));
		json(await call(B.client, 'create_hud', { screens: [{ name: 'Play', elements: [{ kind: 'text', text: 'Score 0', anchor: 'top-left' }, { kind: 'bar', value: 0.6, anchor: 'top-right' }] }] }));
		const withHud = shotText(await call(B.client, 'screenshot', { hud: true, size: 256 }));
		h.check((withHud?.hud?.drawn ?? 0) >= 1, '26. hud: true draws the HUD over the picture: ' + short(withHud?.hud));
		const clean = shotText(await call(B.client, 'screenshot', { size: 256 }));
		const keep = shotText(await call(B.client, 'screenshot', { size: 256, avatars: true }));
		h.check(clean?.avatars === false && keep?.avatars === true, '26. avatars are out by default and in on request: ' + short({ clean: clean?.avatars, keep: keep?.avatars }));
	} finally {
		await closeBridge(B);
	}
	await A.ctx.close();

	console.log('\n=== 10. the Oppo N6 ===');
	await phone(browser, 'n6-folded', { width: 390, height: 896 }, true);
	await phone(browser, 'n6-unfolded', { width: 770, height: 850 }, false);
	await browser.close();
});
