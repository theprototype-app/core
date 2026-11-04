// Roadmap 85b (lane 85-runtime) — the runtime + spatial tools END TO END through the agent bridge: a REAL MCP stdio
// client spawns `tools/agent/src/cli.js mcp <link>`, the host approves, and every result is read back on the HOST
// page (a second peer), where it has to be true. THE GEM ARENA PROOF (78-nodes' scene, mocked with core nodes until
// feat/78 lands: On Click → Latch → Not → Visibility per gem):
//   1  inspect_runtime / validate_scene / logs / playtest are listed; undo_last carries checkpoint / restore
//   2  validate_scene finds the deliberately broken gate (an Object Selector wired INTO an On Click) and says how
//      to fix it; inspect_runtime explains why that gate never fires; after the fix validate is clean
//   3  playtest clicks every gem in the agent's own Play: each gem's On Click fired, and the HOST sees every gem
//      gone (the trigger log replicates); a button whose Visibility names its door directly (R10) hides the door
//   4  list_scene {name, bounds, limit, cursor} pages through the gems (R7)
//   5  R6b: checkpoint, add a junk box, restore — with a person present the host is asked (Allow), then ONE call
//      takes the box away on the host
//   6  S2: the host PINGS the table top; create_objects at: {ping: "latest"} stands a lamp ON the table on the
//      host; a wall ping + align: "surface" backs a painting onto the wall
//   7  the host's A8 log has the lines; Undo on the lamp's line takes it away on the host
//   8  a viewer's page refuses playtest and placement (it may still ping)
// Run: e2e-slot --dev <tree> 5875 -- node tests/e2e/agent-runtime.test.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const TOOLS = ['inspect_runtime', 'validate_scene', 'logs', 'playtest'];

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
		o.updateWorldMatrix(true, true);
		const THREE = window.__stores.THREE;
		const box = THREE ? new THREE.Box3().setFromObject(o) : null;
		return {
			name: o.name,
			visible: o.visible,
			position: o.position.toArray().map((v) => Math.round(v * 1000) / 1000),
			rotation: [o.rotation.x, o.rotation.y, o.rotation.z].map((v) => Math.round(v * 1000) / 1000),
			minY: box ? Math.round(box.min.y * 1000) / 1000 : null,
			maxZ: box ? Math.round(box.max.z * 1000) / 1000 : null,
			minZ: box ? Math.round(box.min.z * 1000) / 1000 : null
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

const CAP_MS = 15 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-runtime passed its ' + CAP_MS / 60000 + ' min cap');
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
		h.check(TOOLS.every((n) => tools.some((t) => t.name === n)), '1. the four runtime tools are listed');
		const undo = tools.find((t) => t.name === 'undo_last');
		h.check(!!undo?.inputSchema?.properties?.checkpoint && !!undo.inputSchema.properties.restore, '1. undo_last takes checkpoint / restore');
		const create = tools.find((t) => t.name === 'create_objects');
		h.check(JSON.stringify(create?.inputSchema ?? {}).includes('"face_user"'), '1. create_objects takes at / align / snap / face_user');
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		console.log('\n=== 2. build the arena, validate, inspect the broken gate ===');
		const made = json(
			await call(B.client, 'create_objects', {
				objects: [
					{ kind: 'primitive', primitive: 'Box', name: 'Floor', params: [12, 0.2, 12], position: [0, -0.1, 0] },
					{ kind: 'primitive', primitive: 'Sphere', name: 'Gem_1', params: [0.25], position: [-2, 0.5, -2], color: '#30d0ff' },
					{ kind: 'primitive', primitive: 'Sphere', name: 'Gem_2', params: [0.25], position: [0, 0.5, -3], color: '#30d0ff' },
					{ kind: 'primitive', primitive: 'Sphere', name: 'Gem_3', params: [0.25], position: [2, 0.5, -2], color: '#30d0ff' },
					{ kind: 'primitive', primitive: 'Box', name: 'Gate', params: [2, 2, 0.2], position: [0, 1, 4] },
					{ kind: 'primitive', primitive: 'Box', name: 'Button', params: [0.4, 0.4, 0.4], position: [3, 0.2, 0] },
					{ kind: 'primitive', primitive: 'Box', name: 'Door', params: [1, 2, 0.1], position: [4, 1, 0] },
					{ kind: 'light', light: 'directional', name: 'Sun', position: [3, 6, 2] }
				]
			})
		);
		const id = Object.fromEntries((made.created ?? []).map((c) => [c.name, c.uuid]));
		h.check(['Gem_1', 'Gem_2', 'Gem_3', 'Gate', 'Button', 'Door'].every((n) => !!id[n]), 'the arena is built: ' + short(Object.keys(id)));
		for (const g of ['Gem_1', 'Gem_2', 'Gem_3']) {
			const f = json(
				await call(B.client, 'create_flow_nodes', {
					graph: id[g],
					nodes: [{ ref: 'c', type: 'onclick' }, { ref: 'l', type: 'latch' }, { ref: 'n', type: 'gate', data: { op: 'not' } }, { ref: 'v', type: 'visibility' }],
					edges: [{ from: 'c', to: 'l', toHandle: 'set' }, { from: 'l', to: 'n', toHandle: 'a' }, { from: 'n', to: 'v', toHandle: 'on' }]
				})
			);
			h.check(!f.error && !f.partial, g + ': collect chain wired: ' + short(f.errors ?? f.error));
		}
		// the broken gate: a selector wired INTO the click (R8's reversed edge)
		const gate = json(
			await call(B.client, 'create_flow_nodes', {
				graph: 'scene',
				nodes: [{ ref: 's', type: 'objectselector', data: { selected: id.Gate } }, { ref: 'c', type: 'onclick', data: { label: 'Gate click' } }],
				edges: [{ from: 's', to: 'c' }]
			})
		);
		const gateClick = (gate.created ?? []).find((n) => n.type === 'onclick')?.id;
		const gateSel = (gate.created ?? []).find((n) => n.type === 'objectselector')?.id;
		h.check(!!gateClick && !!gateSel, 'premise: the broken gate is wired: ' + short(gate.created));
		// R10: the button's Visibility names the DOOR directly
		const btn = json(
			await call(B.client, 'create_flow_nodes', {
				graph: id.Button,
				nodes: [{ ref: 'c', type: 'onclick' }, { ref: 'l', type: 'latch' }, { ref: 'n', type: 'gate', data: { op: 'not' } }, { ref: 'v', type: 'visibility', data: { target: id.Door } }],
				edges: [{ from: 'c', to: 'l', toHandle: 'set' }, { from: 'l', to: 'n', toHandle: 'a' }, { from: 'n', to: 'v', toHandle: 'on' }]
			})
		);
		h.check(!btn.error && !btn.partial, 'R10: a Visibility with a direct target is accepted: ' + short(btn.errors ?? btn.error));

		const v1 = json(await call(B.client, 'validate_scene'));
		const rev = (v1.issues ?? []).find((i) => i.code === 'reversed-selector');
		h.check(v1.ok === false && !!rev, '2. validate_scene finds the reversed selector: ' + short(rev));
		h.check(!!rev?.fix, '2. …and says how to fix it: ' + short(rev?.fix));
		h.check(!(v1.issues ?? []).some((i) => /Gem_/.test(String(i.message)) && i.level === 'error'), '2. the gems are clean');
		const why = json(await call(B.client, 'inspect_runtime', { node: gateClick }));
		h.check(Array.isArray(why.why) && why.why.join(' ').length > 10, '2. inspect_runtime explains the gate: ' + short(why.why));
		// the fix: the wrong-way selector goes
		const fixed = json(await call(B.client, 'update_flow_nodes', { graph: 'scene', remove: [gateSel] }));
		h.check(!fixed.error, 'the selector is removed: ' + short(fixed));
		const v2 = json(await call(B.client, 'validate_scene'));
		h.check(!(v2.issues ?? []).some((i) => i.code === 'reversed-selector'), '2. after the fix the reversed edge is gone: ' + short((v2.issues ?? []).map((i) => i.code)));

		console.log('\n=== 3. playtest collects every gem ===');
		const pt = json(
			await call(B.client, 'playtest', {
				steps: [{ walk: [0, 0, 2] }, { click: id.Gem_1 }, { click: id.Gem_2 }, { click: id.Gem_3 }, { click: id.Button }, { wait: 0.5 }]
			})
		);
		h.check(!pt.error, '3. playtest ran: ' + short(pt.error ?? pt.steps));
		const firedOn = (pt.fired ?? []).filter((f) => f.type === 'onclick').map((f) => f.on);
		h.check(['Gem_1', 'Gem_2', 'Gem_3'].every((g) => firedOn.includes(g)), '3. each gem\'s On Click fired: ' + short(firedOn));
		for (const g of ['Gem_1', 'Gem_2', 'Gem_3'])
			await h.eventually(() => onHost(A.page, id[g]), (o) => o && o.visible === false, '3. the host sees ' + g + ' collected', 20000);
		await h.eventually(() => onHost(A.page, id.Door), (o) => o && o.visible === false, '3. R10: the button hid the Door it names (on the host)', 20000);
		const logs = json(await call(B.client, 'logs', { count: 5 }));
		h.check(Array.isArray(logs.lines), '3. logs answers its lines: ' + short(logs).slice(0, 80));

		console.log('\n=== 4. list_scene paging (R7) ===');
		const p1 = json(await call(B.client, 'list_scene', { name: 'Gem_*', limit: 2 }));
		h.check(p1.objects?.length === 2 && p1.matched === 3 && typeof p1.nextCursor === 'string', '4. page 1 = 2 of 3 gems + nextCursor: ' + short({ n: p1.objects?.length, m: p1.matched, c: p1.nextCursor }));
		const p2 = json(await call(B.client, 'list_scene', { name: 'Gem_*', limit: 2, cursor: p1.nextCursor }));
		h.check(p2.objects?.length === 1 && !p2.nextCursor, '4. page 2 = the last gem');
		const inBox = json(await call(B.client, 'list_scene', { bounds: { min: [-3, 0, -4], max: [3, 1, -1] }, brief: true }));
		h.check(inBox.matched === 3, '4. bounds finds the three gems: ' + short(inBox.objects?.map((o) => o.name)));

		console.log('\n=== 5. named checkpoints (R6b) ===');
		const cp = json(await call(B.client, 'undo_last', { checkpoint: 'arena' }));
		h.check(!cp.error, '5. checkpoint saved: ' + short(cp));
		const junk = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Junk', position: [0, 0.5, 6] }] }));
		const junkId = junk.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, junkId), (o) => !!o, '5. the junk box reached the host', 20000);
		const ask = json(await call(B.client, 'undo_last', { restore: 'arena' }));
		h.check(ask.needsConfirm === true && !!ask.confirmId, '5. with a person here, restore asks the host first: ' + short(ask));
		const allow = A.page.locator('.tp-toast', { hasText: 'wants to change the whole scene' }).getByText('Allow', { exact: true });
		await allow.first().click({ timeout: 30000 });
		const done = json(await call(B.client, 'undo_last', { restore: 'arena', confirmId: ask.confirmId, wait: 10 }));
		h.check(!done.error, '5. allowed: restored in one call: ' + short(done));
		await h.eventually(() => onHost(A.page, junkId), (o) => o === null, '5. the junk box is gone on the host', 20000);

		console.log('\n=== 6. pings (S2) ===');
		const table = json(
			await call(B.client, 'create_objects', {
				objects: [
					{ kind: 'primitive', primitive: 'Box', name: 'Table', params: [1.6, 0.8, 1], position: [-3, 0.4, 2] },
					{ kind: 'primitive', primitive: 'Box', name: 'Wall', params: [4, 2.5, 0.2], position: [0, 1.25, -5] }
				]
			})
		);
		const tid = Object.fromEntries((table.created ?? []).map((c) => [c.name, c.uuid]));
		await h.eventually(() => onHost(A.page, tid.Wall), (o) => !!o, 'premise: table + wall on the host', 20000);
		/** the host pings straight down onto an object @param {string} uuid @param {number[]} from @param {number[]} dir */
		const hostPing = (uuid, from, dir) =>
			A.page.evaluate(
				([u, f, d]) => {
					/** @type {any} */ let g;
					window.__stores.objectsGroup.subscribe((x) => (g = x))();
					const o = g.getObjectByProperty('uuid', u);
					const THREE = window.__stores.THREE;
					const ray = new THREE.Raycaster(new THREE.Vector3().fromArray(f), new THREE.Vector3().fromArray(d).normalize());
					const hit = ray.intersectObject(o, true)[0];
					if (!hit) return null;
					window.__stores.ping.sendPing(hit.point, undefined, hit);
					return hit.point.toArray();
				},
				[uuid, from, dir]
			);
		const tableHit = await hostPing(tid.Table, [-3, 5, 2], [0, -1, 0]);
		h.check(Array.isArray(tableHit), '6. premise: the host pinged the table top ' + short(tableHit));
		await new Promise((r) => setTimeout(r, 1500));
		const lamp = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Cylinder', name: 'Lamp', params: [0.1, 0.15, 0.5], at: { ping: 'latest' } }] }));
		const lampId = lamp.created?.[0]?.uuid;
		h.check(!!lampId && !!lamp.created[0].placed?.at, '6. at: {ping: "latest"} placed the lamp: ' + short(lamp.created?.[0]));
		await h.eventually(() => onHost(A.page, lampId), (o) => o && Math.abs(o.minY - 0.8) < 0.02 && Math.abs(o.position[0] + 3) < 0.05, '6. the host sees the lamp standing ON the table', 20000);
		await new Promise((r) => setTimeout(r, 400)); // the ping throttle
		const wallHit = await hostPing(tid.Wall, [0, 1.4, 0], [0, 0, -1]);
		h.check(Array.isArray(wallHit), '6. premise: the host pinged the wall ' + short(wallHit));
		await new Promise((r) => setTimeout(r, 1500));
		const art = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Painting', params: [1, 0.7, 0.05], at: { ping: 'latest' }, align: 'surface' }] }));
		const artId = art.created?.[0]?.uuid;
		await h.eventually(() => onHost(A.page, artId), (o) => o && Math.abs(o.minZ + 4.9) < 0.02 && Math.abs(o.maxZ + 4.85) < 0.02, '6. the painting is backed onto the wall face (z -4.9 … -4.85)', 20000);

		console.log('\n=== 7. the A8 log + Undo from the host ===');
		await h.eventually(() => read(A.page, 'agentLog.agentLog'), (l) => (l || []).some((e) => e.tool === 'playtest'), '7. the host\'s A8 log has the playtest line', 20000);
		const log = await read(A.page, 'agentLog.agentLog');
		for (const e of (log || []).slice(-8)) console.log('   · ' + e.tool + ': ' + e.text);
		const lampLine = (log || []).filter((e) => e.tool === 'create_objects' && (e.uuids ?? []).includes(lampId)).pop();
		h.check(!!lampLine, '7. a line for the lamp');
		if (lampLine) {
			await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lampLine);
			await h.eventually(() => onHost(A.page, lampId), (o) => o === null, '7. Undo on the lamp\'s line: gone on the host', 20000);
		}
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}

	console.log('\n=== 8. a viewer is refused ===');
	const V = await h.setupPage(browser, 'V', { storage: { agentApi: '1' } });
	await V.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(V, A);
	await V.page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: '', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole: () => {}, synced: () => true })
	);
	const before = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	for (const [tool, args] of [
		['playtest', { steps: [{ wait: 0.1 }] }],
		['create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', at: { ping: 'latest' } }] }],
		['undo_last', { checkpoint: 'x' }]
	]) {
		const r = await V.page.evaluate(([t, a]) => window.tpAgent.exec(t, a), [tool, args]);
		h.check(r?.refused === true || r?.viewOnly === true || /viewer|view only|look/i.test(String(r?.error)), '8. a viewer\'s ' + tool + ' is refused: ' + String(r?.error).slice(0, 70));
	}
	const read1 = await V.page.evaluate(() => window.tpAgent.exec('validate_scene', {}));
	h.check(!read1?.refused && Array.isArray(read1?.issues), '8. …but a viewer may validate (read-only)');
	await new Promise((r) => setTimeout(r, 1500));
	const after = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	h.check(after === before, '8. nothing reached the host from the viewer (' + before + ' → ' + after + ')');

	await bounded(h.finish(browser), 30000);
	process.exit(2);
});
