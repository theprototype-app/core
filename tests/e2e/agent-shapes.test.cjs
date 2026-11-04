// mcp-shapes — the agent's Fox & Portal report, END TO END through the agent bridge: a REAL MCP stdio client
// spawns `tools/agent/src/cli.js mcp <link>`, the host approves, and every result is read back on the HOST page:
//   1  the repro: a group at [-0.9, 0, 0.9] turned -90 deg; create_mesh with parentUuid and no position lands at the
//      group's origin (LOCAL identity), a second one at local [1, 0, 0]; turning the group carries both
//   2  create_shapes: three shapes in one call — uuids in order, a mesh coloured per vertex, one with a material
//      per face; ONE A8 line, and its Undo takes all three back on the host
//   3  list_scene: the mesh's local pose and its mesh {vertexCount, faceCount, bounds}
//   4  create_pivot local (in the group's space)
//   5  create_objects from: copies in a row; lookAt; castShadow off reaches the host
//   6  status carries sceneBudget; set_material names the presets
// Run: e2e-slot --dev <tree> 5968 -- node tests/e2e/agent-shapes.test.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');

const read = (page, expr) =>
	page.evaluate(
		(e) => new Promise((r) => e.split('.').reduce((o, k) => o[k], window.__stores).subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))()),
		expr
	);

/** what the HOST holds for one object: parent, local pose, world position, shading facts @param {any} page @param {string} uuid */
const onHost = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		g.updateMatrixWorld(true);
		const r3 = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;
		const w = o.getWorldPosition(new o.position.constructor());
		const m = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
		return {
			name: o.name,
			parent: o.parent === g ? 'root' : o.parent?.uuid,
			pos: o.position.toArray().map(r3),
			rotY: r3(o.rotation.y),
			world: w.toArray().map(r3),
			verts: o.geometry?.attributes?.position?.count ?? 0,
			colors: o.geometry?.attributes?.color?.count ?? 0,
			groups: o.geometry?.groups?.length ?? 0,
			slots: m.length,
			vertexColors: m.some((x) => x.vertexColors),
			flat: m.some((x) => x.flatShading),
			castShadow: !!o.castShadow
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
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChanged && onChanged());
	await client.connect(transport);
	return { client, transport };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
const short = (v) => JSON.stringify(v ?? null).slice(0, 240);
const near = (a, b, eps = 0.01) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

const CAP_MS = 15 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-shapes passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

const CUBE = {
	vertices: [[-0.2, 0, -0.2], [0.2, 0, -0.2], [0.2, 0.4, -0.2], [-0.2, 0.4, -0.2], [-0.2, 0, 0.2], [0.2, 0, 0.2], [0.2, 0.4, 0.2], [-0.2, 0.4, 0.2]],
	faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let changed = 0;
	const B = await startBridge([BASE + '/#' + A.id], () => changed++);
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
		const tools = (await B.client.listTools()).tools;
		h.check(tools.some((t) => t.name === 'create_shapes'), '0. create_shapes is listed');
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		console.log('\n=== 1. the repro: a mesh in a group turned -90 deg ===');
		const made = json(await call(B.client, 'create_objects', { objects: [{ kind: 'group', name: 'Fox' }] }));
		const foxId = made.created?.[0]?.uuid;
		json(await call(B.client, 'update_objects', { updates: [{ uuid: foxId, position: [-0.9, 0, 0.9], rotation: [0, -1.5708, 0] }] }));
		await h.eventually(() => onHost(A.page, foxId), (o) => o && near(o.pos, [-0.9, 0, 0.9]) && Math.abs(o.rotY + 1.571) < 0.01, '1. premise: the host has Fox at [-0.9, 0, 0.9] turned -90 deg', 20000);
		const body = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Body', parentUuid: foxId }));
		const bodyId = body.created?.[0]?.uuid;
		h.check(!!bodyId && !body.created[0].warnings, 'create_mesh in the group: ' + short(body));
		await h.eventually(
			() => onHost(A.page, bodyId),
			(o) => o?.parent === foxId && near(o.pos, [0, 0, 0]) && Math.abs(o.rotY) < 0.001 && near(o.world, [-0.9, 0, 0.9]),
			'1. the host has Body INSIDE Fox at local [0, 0, 0], rotation 0 — at the group origin (was [-0.9, 0, -0.9] rot 1.571)',
			20000
		);
		const tail = json(await call(B.client, 'create_mesh', { ...CUBE, name: 'Tail', parentUuid: foxId, position: [1, 0, 0] }));
		const tailId = tail.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, tailId), (o) => o?.parent === foxId && near(o.pos, [1, 0, 0]) && near(o.world, [-0.9, 0, 1.9]), '1. Tail at local [1, 0, 0] = world [-0.9, 0, 1.9] (the group\'s +x turned to world +z)', 20000);
		json(await call(B.client, 'update_objects', { updates: [{ uuid: foxId, rotation: [0, 0, 0] }] }));
		await h.eventually(() => onHost(A.page, tailId), (o) => o && near(o.pos, [1, 0, 0]) && near(o.world, [0.1, 0, 0.9]), '1. turning the group carries Tail: world [0.1, 0, 0.9], still local [1, 0, 0]', 20000);
		const lathe = json(await call(B.client, 'create_lathe', { profile: [[0, 0], [0.1, 0.1], [0, 0.2]], name: 'Ear', parentUuid: foxId }));
		await h.eventually(() => onHost(A.page, lathe.created?.[0]?.uuid), (o) => o?.parent === foxId && near(o.pos, [0, 0, 0]), '1. a lathe in the group with no position sits at its origin too', 20000);

		console.log('\n=== 2. create_shapes: three in one call, coloured ===');
		const batch = json(
			await call(B.client, 'create_shapes', {
				shapes: [
					{ action: 'mesh', mesh: { ...CUBE, name: 'Painted', position: [3, 0, 0], colors: CUBE.vertices.map((v) => [v[0] + 0.5, v[1] * 2, 0.2]), flatShading: true } },
					{ action: 'mesh', mesh: { ...CUBE, name: 'Two-tone', position: [4, 0, 0], materials: [{ color: '#d04020' }, { color: '#20a040', roughness: 0.3 }], faceMaterials: [0, 0, 1, 1, 0, 1] } },
					{ action: 'tube', tube: { path: [[5, 0, 0], [5, 1, 0]], name: 'Pole', castShadow: false } }
				]
			})
		);
		h.check(batch.uuids?.length === 3 && batch.created.map((c) => c.name).join() === 'Painted,Two-tone,Pole', '2. three uuids in order: ' + short(batch.created?.map((c) => c.name)));
		const [paintedId, twoId, poleId] = batch.uuids ?? [];
		await h.eventually(() => onHost(A.page, paintedId), (o) => o?.colors === 36 && o.vertexColors && o.flat, '2. the host has Painted with 36 vertex colours, flat shaded', 20000);
		await h.eventually(() => onHost(A.page, twoId), (o) => o?.slots === 2 && o.groups === 4, '2. the host has Two-tone with 2 material slots in 4 groups', 20000);
		await h.eventually(() => onHost(A.page, poleId), (o) => o && o.castShadow === false, '2. the host has Pole with castShadow off', 20000);
		const bad = json(await call(B.client, 'create_shapes', { shapes: [{ action: 'mesh', mesh: CUBE }, { action: 'mesh', mesh: { ...CUBE, colors: [[1, 1, 1]] } }] }));
		h.check(/shapes\[1\] \(mesh\): colors/.test(bad.error || ''), '2. a wrong entry names its index, nothing made: ' + String(bad.error).slice(0, 90));

		console.log('\n=== 3. list_scene ===');
		const scene = json(await call(B.client, 'list_scene', { name: 'Tail' }));
		const row = scene.objects?.find((o) => o.uuid === tailId);
		h.check(row && near(row.position, [1, 0, 0]) && row.parentUuid === foxId, '3. list_scene: Tail at local [1, 0, 0] in Fox: ' + short(row?.position));
		h.check(row?.mesh?.vertexCount === 36 && row.mesh.faceCount === 12 && near(row.mesh.bounds.local[1], [0.2, 0.4, 0.2]) && near(row.mesh.bounds.world[0], [-0.1, 0, 0.7]), '3. list_scene: mesh {vertexCount 36, faceCount 12, bounds local + world}: ' + short(row?.mesh));

		console.log('\n=== 4. create_pivot local ===');
		json(await call(B.client, 'update_objects', { updates: [{ uuid: foxId, rotation: [0, -1.5708, 0] }] }));
		const piv = json(await call(B.client, 'create_pivot', { objects: [tailId], local: [0.8, 0, 0], name: 'TailRoot' }));
		h.check(!!piv.groupUuid && near(piv.local, [0.8, 0, 0]) && near(piv.at, [-0.9, 0, 1.7]), '4. create_pivot local [0.8, 0, 0] in Fox = world [-0.9, 0, 1.7]: ' + short(piv));
		await h.eventually(() => onHost(A.page, tailId), (o) => o?.parent === piv.groupUuid && near(o.world, [-0.9, 0, 1.9]), '4. the host: Tail inside TailRoot, where it was', 20000);

		console.log('\n=== 5. copies, lookAt, shadows ===');
		const post = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [0.2, 1, 0.2], name: 'Post', position: [-3, 0.5, -3], castShadow: false }] }));
		const postId = post.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, postId), (o) => o && o.castShadow === false, '5. the host has Post with castShadow off', 20000);
		const copies = json(await call(B.client, 'create_objects', { from: postId, count: 3, offset: [1, 0, 0], randomRot: 0.2, seed: 4, name: 'Fence' }));
		h.check(copies.uuids?.length === 3 && copies.created.map((c) => c.name).join() === 'Fence 1,Fence 2,Fence 3', '5. three copies, named in order: ' + short(copies.created?.map((c) => c.name)));
		await h.eventually(() => onHost(A.page, copies.uuids?.[2]), (o) => o && near(o.pos, [0, 0.5, -3]), '5. the host has Fence 3 at the source + 3 x offset', 20000);
		const look = json(await call(B.client, 'update_objects', { updates: [{ uuid: postId, lookAt: [-3, 0.5, 0] }] }));
		h.check(look.updated?.[0]?.ok === true, '5. lookAt answers ok: ' + short(look));
		await h.eventually(() => onHost(A.page, postId), (o) => o && Math.abs(o.rotY) < 0.01, '5. the host: Post faces +z (the target is straight ahead), rotation y 0', 20000);
		json(await call(B.client, 'update_objects', { updates: [{ uuid: postId, lookAt: [0, 0.5, -3] }] }));
		await h.eventually(() => onHost(A.page, postId), (o) => o && Math.abs(o.rotY - 1.571) < 0.01, '5. the host: Post turned to face +x (rotation y +90 deg)', 20000);

		console.log('\n=== 6. status and the material text ===');
		const st2 = json(await call(B.client, 'status'));
		const sb = st2.sceneBudget ?? st2.session?.sceneBudget;
		h.check(sb && typeof sb.tier === 'string' && (sb.profile === 'desktop' || sb.profile === 'vr') && sb.objects > 5 && sb.triangles > 0, '6. status carries sceneBudget: ' + short(sb));
		const setMat = (await B.client.listTools()).tools.find((t) => t.name === 'set_material');
		h.check(/Wood, Metal, Plastic, Glass/.test(setMat?.description || ''), '6. set_material names the starter presets');

		console.log('\n=== 7. the A8 log: one line for the batch; its Undo takes all three back ===');
		await h.eventually(() => read(A.page, 'agentLog.agentLog'), (l) => (l || []).some((e) => e.tool === 'create_shapes' && /made 3 shapes/.test(e.text || '')), '7. the host has a create_shapes line', 20000);
		const log = await read(A.page, 'agentLog.agentLog');
		const lines = (log || []).filter((e) => e.tool === 'create_shapes' && /made \d+ shapes/.test(e.text || ''));
		h.check(lines.length === 1 && /made 3 shapes/.test(lines[0].text), '7. one line: ' + lines[0]?.text);
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lines[0]);
		await h.eventually(
			async () => [await onHost(A.page, paintedId), await onHost(A.page, twoId), await onHost(A.page, poleId)],
			(r) => r.every((o) => o === null),
			'7. Undo on the line: all three shapes are gone from the host',
			20000
		);
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}
	await browser.close();
});
