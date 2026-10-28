// The agent bridge v2 end to end (roadmap 55 A3): a REAL MCP stdio client spawns
// `tools/agent/src/cli.js mcp <link>`, the bridge opens the link in its own headless Chromium,
// and a Playwright HOST page approves it — then the agent builds through the host's own tools.
//   1. the tool list is the host app's (schemas verbatim), learned at connect
//   2. a plain link waits for Approve; scene tools refuse until then
//   3. create_objects + create_flow_nodes land in the HOST scene (uuids, a spin node)
//   4. list_scene reads the whole scene (an object the host made before the agent came)
//   5. screenshot returns a PNG image block; wait_for_edit wakes on a host edit
//   6. closing the client = a graceful leave: the host drops the agent, no ghost in Users,
//      no "Connection error" toast
//   7. --engine=wire through the same server: the link's signaling (never the public cloud),
//      and the same graceful leave (test flight 2 T3/T5)
// The bridge uses `--compat` (the debug-hook tpAgent) until 55-page's window.tpAgent is on the
// branch (src/lib/agent/ present); AGENT_MCP_COMPAT=0|1 forces either.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const COMPAT = process.env.AGENT_MCP_COMPAT ? process.env.AGENT_MCP_COMPAT === '1' : !fs.existsSync(path.join(root, 'src/lib/agent'));
const BASE = h.URL.replace(/\/+$/, '');

const read = (page, expr) =>
	page.evaluate((e) => new Promise((r) => window.__stores[e].subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))()), expr);
const openedPeers = (page) => page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.openedPeers ? [...p.openedPeers] : []))()));
const objectByUuid = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g && g.getObjectByProperty('uuid', u);
					r(o ? { name: o.name, y: o.position.y } : null);
				})()
			),
		uuid
	);

/** Spawn the bridge over stdio. @returns {Promise<{client: any, transport: any, log: string[], exited: Promise<number|null>}>} */
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
	/** @type {string[]} */
	const log = [];
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChanged && onChanged());
	transport.stderr.on('data', (d) => log.push(...String(d).split('\n').filter(Boolean)));
	await client.connect(transport);
	const pid = transport.pid;
	const exited = new Promise((resolve) => {
		const t = setInterval(() => {
			try {
				process.kill(pid, 0);
			} catch {
				clearInterval(t);
				resolve(0);
			}
		}, 200);
	});
	return { client, transport, log, exited, pid };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

async function waitJoined(client, ms = 90000) {
	const t0 = Date.now();
	let st = null;
	while (Date.now() - t0 < ms) {
		st = json(await call(client, 'status'));
		if (st.joined) return st;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return st;
}

/** The host page counted every "Connection error" toast since `since`. */
const connectionErrors = async (page, since) =>
	(await read(page, 'notifications')).filter((n) => n.ts >= since && /Connection error/i.test(n.text)).map((n) => n.text);

h.run(async () => {
	console.log('bridge mode: ' + (COMPAT ? '--compat (no src/lib/agent on this branch)' : 'window.tpAgent'));
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	const hostId = A.id;
	const link = BASE + '/#' + hostId;

	// the host's world before the agent comes: one named object the agent must be able to read
	const pre = await A.page.evaluate(() =>
		window.__stores.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'HostBall', position: [2, 0.5, 0] }] })
	);
	const preUuid = pre?.created?.[0]?.uuid;
	h.check(!!preUuid, 'premise: the host made an object before the agent came');

	// ---------------------------------------------------------------- browser engine
	let changed = 0;
	const t0 = Date.now();
	const B = await startBridge([link, ...(COMPAT ? ['--compat'] : [])], () => changed++);
	try {
		const listed0 = (await B.client.listTools()).tools.map((t) => t.name);
		h.check(listed0.includes('connect') && listed0.includes('screenshot') && listed0.includes('wait_for_edit'), 'the bridge tools are listed at once');

		// the agent's page boots and dials: the host gets the ordinary approval card
		await h.approveButton(A.page).click({ timeout: 120000 });
		console.log('approved after ' + Math.round((Date.now() - t0) / 1000) + ' s');

		await h.eventually(async () => changed, (n) => n > 0, 'tools/list_changed arrived once the host tools were known', 60000);
		const tools = (await B.client.listTools()).tools;
		const names = tools.map((t) => t.name);
		h.check(names.includes('create_objects') && names.includes('list_scene') && names.includes('create_flow_nodes'), 'host tools listed: ' + names.length);
		const hostSchema = await A.page.evaluate(() => {
			const t = window.__stores.aiTools.getAiTools().find((x) => (x.function || x).name === 'create_objects');
			return JSON.stringify((t.function || t).parameters);
		});
		h.check(JSON.stringify(tools.find((t) => t.name === 'create_objects').inputSchema) === hostSchema, 'create_objects schema is the host app\'s, verbatim');

		const st = await waitJoined(B.client);
		h.check(st && st.joined === true, 'status: joined after Approve');
		const agentId = st?.session?.peerId;
		h.check(!!agentId, 'status names the agent peer id: ' + agentId);
		await h.eventually(
			() => read(A.page, 'userdata'),
			(rows) => (rows || []).some((u) => u[0] === agentId && u[1] === 'Claude'),
			'the agent shows in the host Users list as "Claude" (from the MCP client name)',
			20000
		);

		// --- build through the host's own tools
		const made = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'McpBox', position: [0, 0.5, 0], color: '#22aaff' }] }));
		const uuid = made?.created?.[0]?.uuid;
		h.check(!!uuid, 'create_objects returned a uuid');
		await h.eventually(() => objectByUuid(A.page, uuid), (o) => o && o.name === 'McpBox', 'the agent\'s box is in the HOST scene, same uuid', 20000);
		const flow = json(await call(B.client, 'create_flow_nodes', { graph: uuid, nodes: [{ type: 'spin' }] }));
		h.check(!flow.error, 'create_flow_nodes accepted: ' + JSON.stringify(flow).slice(0, 120));
		await h.eventually(
			() => read(A.page, 'flowGraphs'),
			(g) => g && g[uuid] && (g[uuid].nodes || []).some((n) => n.type === 'spin'),
			'the spin node is in the box\'s flow graph on the HOST',
			20000
		);
		// 55 owner findings 2+3: a kit node by its exact type; a mixed call says it was partial
		const kit = json(await call(B.client, 'create_flow_nodes', { graph: 'scene', nodes: [{ type: 'kit-rules-setJump' }] }));
		h.check(!kit.error && kit.created?.[0]?.type === 'kit-rules-setJump', 'a kit-* node is created by its exact type: ' + JSON.stringify(kit).slice(0, 120));
		// in the SCENE graph: in the box's own graph the bounce would move the box (an unwired behaviour node drives
		// its graph's object) and the move check below would read a bounce phase
		const mixed = await call(B.client, 'create_flow_nodes', { graph: 'scene', nodes: [{ type: 'bounce' }, { type: 'no-such-node' }] });
		const mixedBody = json(mixed);
		h.check(
			mixed.isError !== true && mixedBody.partial === true && /1 of 2 nodes/.test(mixedBody.warning || '') && mixedBody.created?.length === 1,
			'a half-valid create_flow_nodes says partial at the top level: ' + JSON.stringify(mixedBody).slice(0, 160)
		);
		// 55 owner finding 6: a hinge at an explicit world anchor, the pair not colliding
		const jointed = json(await call(B.client, 'create_joints', { joints: [{ kind: 'revolute', a: preUuid, b: uuid, axis: 'z', anchor: [0, 1.5, 0], contacts: false }] }));
		h.check(!jointed.error && jointed.joints?.[0]?.contacts === false, 'create_joints takes anchor + contacts:false: ' + JSON.stringify(jointed).slice(0, 120));
		await h.eventually(
			() => A.page.evaluate(() => new Promise((r) => window.__stores.joints.sceneJoints.subscribe((j) => r(JSON.parse(JSON.stringify(j))))())),
			// HostBall (a) stands at [2, 0.5, 0], so the world anchor [0, 1.5, 0] is [-2, 1, 0] in its frame
			(j) => (j || []).some((d) => d.b === uuid && d.contacts === false && Math.abs(d.anchorA[0] + 2) < 0.01 && Math.abs(d.anchorA[1] - 1) < 0.01),
			'the host\'s joint sits at the world anchor (a\'s frame: [-2, 1, 0]) with contacts off',
			20000
		);
		const moved = json(await call(B.client, 'update_objects', { updates: [{ uuid, position: [0, 2, 0] }] }));
		h.check(!moved.error, 'update_objects accepted');
		await h.eventually(() => objectByUuid(A.page, uuid), (o) => o && Math.abs(o.y - 2) < 0.01, 'the move reached the host', 20000);

		const scene = JSON.stringify(json(await call(B.client, 'list_scene')));
		h.check(scene.includes(preUuid) && scene.includes('HostBall'), 'list_scene reads the whole scene (the host\'s own object included)');

		const bad = await call(B.client, 'create_objects', { objects: [] });
		h.check(bad.isError === true, 'a tool-level error comes back as isError');

		// --- eyes
		const shot = await call(B.client, 'screenshot', { view: 'iso' });
		const img = shot.content.find((c) => c.type === 'image');
		const bytes = img ? Buffer.from(img.data, 'base64') : Buffer.alloc(0);
		h.check(img && img.mimeType === 'image/png' && bytes.slice(1, 4).toString() === 'PNG' && bytes.length > 2000, 'screenshot → a non-empty PNG image block (' + bytes.length + ' bytes)');

		// --- wait_for_edit wakes on a human's edit
		const waiting = call(B.client, 'wait_for_edit', { timeout_ms: 30000 });
		await new Promise((r) => setTimeout(r, 1500));
		await A.page.evaluate(() =>
			window.__stores.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Cone', name: 'HostCone', position: [-2, 0.5, 0] }] })
		);
		const w = json(await waiting);
		h.check(w && w.changed === true, 'wait_for_edit woke on the host\'s edit');

		// --- graceful leave: the client goes away
		const since = Date.now();
		await B.client.close();
		const gone = await Promise.race([B.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 15000))]);
		h.check(gone, 'the bridge exits when the MCP client closes');
		await h.eventually(() => openedPeers(A.page), (p) => !p.includes(agentId), 'the host dropped the agent (no ghost connection)', 15000);
		await h.eventually(
			() => read(A.page, 'userdata'),
			(rows) => !(rows || []).some((u) => u[0] === agentId),
			'the agent left the host Users list',
			15000
		);
		const errs = await connectionErrors(A.page, since);
		h.check(errs.length === 0, 'no "Connection error" toast on the host' + (errs.length ? ': ' + errs.join(' | ') : ''));
		const still = await objectByUuid(A.page, uuid);
		h.check(!!still, 'what the agent built stays after it leaves');
	} catch (e) {
		console.log('--- bridge stderr ---\n' + B.log.slice(-60).join('\n'));
		throw e;
	} finally {
		try {
			process.kill(B.pid);
		} catch {}
	}
	if (process.env.AGENT_MCP_LOG === '1') console.log(B.log.join('\n'));

	// ---------------------------------------------------------------- wire engine
	const W = await startBridge([link, '--engine', 'wire', '--name', 'wirebot']);
	try {
		const wn = (await W.client.listTools()).tools.map((t) => t.name);
		h.check(wn.includes('create_objects') && !wn.includes('screenshot'), 'wire: its catalog, no screenshot');
		await h.approveButton(A.page).click({ timeout: 90000 });
		const ws = await waitJoined(W.client);
		h.check(ws && ws.joined === true, 'wire: joined after Approve');
		h.check(ws && ws.signaling === 'peerjs.theprototype.app:443/peerjs' && ws.signalingFrom === 'origin', 'wire: signaling came from the link (' + (ws && ws.signaling) + ')');
		h.check(ws && ws.session && typeof ws.session.turn === 'string', 'wire: TURN state reported: ' + (ws && ws.session && ws.session.turn));
		const wireId = ws?.session?.agentId;
		const made = json(await call(W.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'WireBox', position: [3, 0.5, 3] }] }));
		const wu = made?.created?.[0]?.uuid ?? made?.created?.[0];
		h.check(!!wu, 'wire: create_objects returned a uuid');
		await h.eventually(() => objectByUuid(A.page, wu), (o) => !!o, 'wire: the box reached the host', 20000);
		const since = Date.now();
		await W.client.close();
		const gone = await Promise.race([W.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 15000))]);
		h.check(gone, 'wire: the bridge exits when the client closes');
		await h.eventually(() => openedPeers(A.page), (p) => !p.includes(wireId), 'wire: the host dropped the agent at once (the goodbye)', 8000);
		await h.eventually(() => read(A.page, 'userdata'), (rows) => !(rows || []).some((u) => u[0] === wireId), 'wire: no ghost in Users', 8000);
		const errs = await connectionErrors(A.page, since);
		h.check(errs.length === 0, 'wire: no "Connection error" toast' + (errs.length ? ': ' + errs.join(' | ') : ''));
	} catch (e) {
		console.log('--- wire bridge stderr ---\n' + W.log.slice(-60).join('\n'));
		throw e;
	} finally {
		try {
			process.kill(W.pid);
		} catch {}
	}

	await h.finish(browser);
});
