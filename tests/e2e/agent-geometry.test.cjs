// Roadmap 85 G1-G7 — the geometry tools END TO END through the agent bridge: a REAL MCP stdio client
// spawns `tools/agent/src/cli.js mcp <link>`, the host approves, and every tool's result is read back on
// the HOST page (a second peer), where it has to be true:
//   1  the six tools are listed, schemas verbatim from the host app's shared registry
//   2  create_lathe / create_tube / extrude_shape / create_mesh land on the host (same uuid, the shape's
//      own data: a lathe's profile, a tube's radii, an extrusion's depth, a mesh's triangles)
//   3  set_geometry turns a box into a cylinder in place (same uuid) and resizes it
//   4  edit_mesh extrudes a box's top on the host; set_geometry then refuses it without force (G7)
//   5  the host's A8 log has one line per call, and its per-line Undo takes the call back on the host
//   6  a viewer's page refuses every geometry tool (OSS has no roles plugin: the viewer row stubs
//      rolesInfo on a tpAgent page — the gate under test is the agent page's own)
// Run: e2e-slot --dev <tree> 5874 -- node tests/e2e/agent-geometry.test.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const TOOLS = ['set_geometry', 'create_lathe', 'create_tube', 'extrude_shape', 'edit_mesh', 'create_mesh'];

const read = (page, expr) =>
	page.evaluate(
		(e) => new Promise((r) => e.split('.').reduce((o, k) => o[k], window.__stores).subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))()),
		expr
	);

/** what the HOST holds for one object: its geometry's facts @param {any} page @param {string} uuid */
const onHost = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o?.geometry) return null;
		const pos = o.geometry.attributes.position;
		let maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
		for (let i = 0; i < pos.count; i++) {
			maxY = Math.max(maxY, pos.getY(i));
			minZ = Math.min(minZ, pos.getZ(i));
			maxZ = Math.max(maxZ, pos.getZ(i));
		}
		return {
			name: o.name,
			type: o.geometry.type,
			gp: JSON.parse(JSON.stringify(o.userData.geometryParams ?? null)),
			spline: o.userData.spline ? o.userData.spline.points.map((/** @type {any} */ p) => p.radius) : null,
			verts: pos.count,
			maxY,
			minZ,
			maxZ,
			faceEdited: !!o.userData.faceEdited
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
const short = (v) => JSON.stringify(v ?? null).slice(0, 200);

// a hard cap: whatever hangs, the slot is freed (the suite runs ~4 min)
const CAP_MS = 15 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-geometry passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
/** a promise that gives up after `ms` @param {Promise<any>} p @param {number} ms */
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
		h.check(TOOLS.every((n) => tools.some((t) => t.name === n)), '1. the six geometry tools are listed');
		const hostSchema = await A.page.evaluate(() => {
			const t = window.__stores.aiTools.getAiTools().find((x) => (x.function || x).name === 'edit_mesh');
			return JSON.stringify((t.function || t).parameters);
		});
		h.check(JSON.stringify(tools.find((t) => t.name === 'edit_mesh')?.inputSchema) === hostSchema, '1. edit_mesh schema = the host registry, verbatim');
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		console.log('\n=== 2. the four makers ===');
		const profile = [[0, 0], [0.35, 0.05], [0.45, 0.4], [0.2, 0.9], [0.28, 1.1], [0, 1.1]];
		const vase = json(await call(B.client, 'create_lathe', { profile, segments: 32, name: 'Vase', position: [-2, 0, 0], color: '#c06030' }));
		const vaseId = vase.created?.[0]?.uuid;
		h.check(!!vaseId, 'create_lathe returned a uuid: ' + short(vase));
		await h.eventually(() => onHost(A.page, vaseId), (o) => o?.gp?.gtype === 'Lathe' && o.gp.params.points?.length === 6 && o.gp.params.segments === 32, '2. the host has the Vase lathed from the 6-point profile', 20000);

		const rail = json(await call(B.client, 'create_tube', { path: [[0, 1, -2], [1, 1.2, -2], [2, 1, -1], [3, 1, 0]], radii: [0.04, 0.06, 0.06, 0.03], name: 'Rail' }));
		const railId = rail.created?.[0]?.uuid;
		h.check(!!railId, 'create_tube returned a uuid: ' + short(rail));
		await h.eventually(() => onHost(A.page, railId), (o) => o?.spline?.join() === '0.04,0.06,0.06,0.03' && o.verts > 100, '2. the host has the Rail with its per-point radii (built from the record)', 20000);

		const sign = json(await call(B.client, 'extrude_shape', {
			points: [[-1, -0.4], [1, -0.4], [1, 0.4], [-1, 0.4]],
			holes: [[[-0.8, -0.2], [-0.5, -0.2], [-0.5, 0.2], [-0.8, 0.2]]],
			depth: 0.1,
			name: 'Sign',
			position: [2, 1.2, 2]
		}));
		const signId = sign.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, signId), (o) => o?.gp?.gtype === 'Extrude' && Math.abs(o.minZ + 0.05) < 0.002 && Math.abs(o.maxZ - 0.05) < 0.002, '2. the host has the Sign: 0.1 deep, centred on its depth', 20000);

		const cube = {
			vertices: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5], [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]],
			faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]
		};
		const crate = json(await call(B.client, 'create_mesh', { ...cube, name: 'Crate', position: [0, 0, 3] }));
		const crateId = crate.created?.[0]?.uuid;
		h.check(crate.created?.[0]?.triangles === 12, 'create_mesh: 12 triangles from 6 quads');
		await h.eventually(() => onHost(A.page, crateId), (o) => o?.verts === 36, '2. the host has the Crate (36 corners on the meshgeo channel)', 20000);

		console.log('\n=== 3. set_geometry: a box becomes a cylinder in place ===');
		const made = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Post', position: [4, 0.5, 0] }] }));
		const postId = made.created?.[0]?.uuid;
		const turned = json(await call(B.client, 'set_geometry', { updates: [{ uuid: postId, type: 'Cylinder', params: { radiusTop: 0.2, radiusBottom: 0.3, height: 3 } }] }));
		h.check(turned.updated?.[0]?.ok === true && turned.updated[0].from === 'Box', 'set_geometry answers ok, from Box: ' + short(turned));
		await h.eventually(() => onHost(A.page, postId), (o) => o?.type === 'CylinderGeometry' && o.gp?.params?.height === 3 && o.name === 'Post', '3. the host has the SAME uuid as a 3 m cylinder', 20000);

		console.log('\n=== 4. edit_mesh, then G7 ===');
		const tower = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [1, 1, 1], name: 'Tower', position: [-4, 0.5, 0] }] }));
		const towerId = tower.created?.[0]?.uuid;
		const preview = json(await call(B.client, 'edit_mesh', { object: towerId, select: { normal: 'up' }, ops: [] }));
		h.check(preview.selected?.faces?.length === 1 && preview.faceCount === 6, 'edit_mesh ops: [] previews the top face of 6: ' + short(preview.selected?.faces));
		const ext = json(await call(B.client, 'edit_mesh', { object: towerId, select: { normal: 'up' }, ops: [{ op: 'extrude', distance: 1 }, { op: 'inset', amount: 0.3 }, { op: 'extrude', distance: 0.5 }] }));
		h.check(ext.updated?.[0]?.ok === true && ext.updated[0].ops?.[2]?.faces === 1, 'edit_mesh ran 3 ops, the last on the inset\'s inner face only: ' + short(ext.updated?.[0]?.ops));
		await h.eventually(() => onHost(A.page, towerId), (o) => o && Math.abs(o.maxY - 2) < 0.001 && o.faceEdited, '4. the host\'s Tower is 1.5 m taller (top at local y = 2)', 20000);
		const g7 = json(await call(B.client, 'set_geometry', { updates: [{ uuid: towerId, params: { width: 2 } }] }));
		h.check(/force: true/.test(g7.error || ''), '4. G7: the hand-edited Tower refuses a rebuild without force: ' + String(g7.error).slice(0, 90));

		console.log('\n=== 5. the A8 log + Undo from the host ===');
		await h.eventually(
			() => read(A.page, 'agentLog.agentLog'),
			(l) => TOOLS.every((t) => (l || []).some((e) => e.tool === t)),
			'5. the host\'s A8 log has a line for each geometry tool',
			20000
		);
		const log = await read(A.page, 'agentLog.agentLog'); // h.eventually returns nothing
		for (const e of (log || []).filter((x) => TOOLS.includes(x.tool))) console.log('   · ' + e.tool + ': ' + e.text);
		h.check((log || []).filter((e) => e.tool === 'edit_mesh').length === 1, '5. the ops: [] preview wrote no line');
		const lineOf = (tool) => {
			const line = (log || []).filter((e) => e.tool === tool && e.ok !== false).pop();
			if (!line) throw new Error('no A8 line for ' + tool);
			return line;
		};
		// the newest line first (a plain undo), then a deep one (out of order)
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lineOf('edit_mesh'));
		await h.eventually(() => onHost(A.page, towerId), (o) => o && Math.abs(o.maxY - 0.5) < 0.001, '5. Undo on the edit_mesh line: the host\'s Tower is a plain box again', 20000);
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lineOf('create_lathe'));
		await h.eventually(() => onHost(A.page, vaseId), (o) => o === null, '5. Undo on the create_lathe line: the Vase is gone from the host', 20000);
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lineOf('set_geometry'));
		await h.eventually(() => onHost(A.page, postId), (o) => o?.type === 'BoxGeometry', '5. Undo on the set_geometry line: the Post is a box again', 20000);
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}

	console.log('\n=== 6. a viewer is refused ===');
	const V = await h.setupPage(browser, 'V', { storage: { agentApi: '1' } });
	await V.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(V, A);
	await V.page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: '', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole: () => {}, synced: () => true })
	);
	const before = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	for (const [tool, args] of [
		['create_lathe', { profile: [[0, 0], [1, 1]] }],
		['create_mesh', { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] }],
		['set_geometry', { updates: [{ uuid: 'x', params: { width: 2 } }] }],
		['edit_mesh', { object: 'x', ops: [] }]
	]) {
		const r = await V.page.evaluate(([t, a]) => window.tpAgent.exec(t, a), [tool, args]);
		h.check(r?.refused === true || r?.viewOnly === true, '6. a viewer\'s ' + tool + ' is refused: ' + String(r?.error).slice(0, 70));
	}
	await new Promise((r) => setTimeout(r, 1500));
	const after = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	h.check(after === before, '6. nothing reached the host from the viewer (' + before + ' → ' + after + ')');

	await bounded(h.finish(browser), 30000);
	process.exit(2); // finish exits; reaching here means it hung
});
