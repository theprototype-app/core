// Roadmap 85 (owner's 85a additions) — undo_last, set_pivot, create_pivot, add_image END TO END: a REAL MCP
// stdio client spawns `tools/agent/src/cli.js mcp <link>`, the host approves, and every result is read back
// on the HOST page (a second peer), where it has to be true:
//   1  the four tools are listed, schemas verbatim from the host app's shared registry
//   2  set_pivot: the host holds the origin; update_objects rotation then swings about it (the neck stays put)
//   3  create_pivot: a group at the point on the host, its members in it, world poses kept; turning it swings them
//   4  add_image: a canvas, base64 in chunks, a URL (a JPEG with a planted EXIF block comes back as pixels
//      only), each in the host's library by hash; the hash goes on a material; SVG / http / a web page refused
//   5  undo_last: takes back the last call on the host, count takes several, a person's later edit of the same
//      object refuses with their name, one A8 line, per-line Undo works on the new tools
//   6  the connector's shape (the agent in a PERSON's tab): Ctrl+Z-able edits by the person refuse it too
//   7  a viewer's page refuses all four
// Run: e2e-slot --dev <tree> 5880 -- node tests/e2e/agent-assist.test.cjs
const fs = require('fs');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const TOOLS = ['undo_last', 'set_pivot', 'create_pivot', 'add_image'];

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
		o.updateMatrixWorld(true);
		const e = o.matrixWorld.elements;
		return {
			name: o.name,
			type: o.type,
			parent: o.parent === g ? 'root' : o.parent?.uuid,
			pos: o.position.toArray(),
			rotX: o.rotation.x,
			world: [e[12], e[13], e[14]],
			origin: o.userData.origin ?? null,
			map: !!o.material?.map,
			mapSource: o.material?.userData?.mapSource ?? null
		};
	}, uuid);

/** does the host's library hold this file, unhidden? @param {any} page @param {string} hash */
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
const short = (v) => JSON.stringify(v ?? null).slice(0, 200);
const near = (a, b, eps = 1e-3) => a && a.every((n, i) => Math.abs(n - b[i]) < eps);

const CAP_MS = 15 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-assist passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let changed = 0;
	const B = await startBridge([BASE + '/#' + A.id], () => changed++);
	const make = async (name, position, extra = {}) => {
		const r = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [1, 1, 1], name, position, ...extra }] }));
		const id = r.created?.[0]?.uuid;
		if (!id) throw new Error('create failed: ' + short(r));
		await h.eventually(() => onHost(A.page, id), (o) => !!o, 'the host has ' + name, 20000);
		return id;
	};
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
		const tools = (await B.client.listTools()).tools;
		h.check(TOOLS.every((n) => tools.some((t) => t.name === n)), '1. the four tools are listed');
		const hostSchema = await A.page.evaluate(() => {
			const t = window.__stores.aiTools.getAiTools().find((x) => (x.function || x).name === 'add_image');
			return JSON.stringify((t.function || t).parameters);
		});
		h.check(JSON.stringify(tools.find((t) => t.name === 'add_image')?.inputSchema) === hostSchema, '1. add_image schema = the host registry, verbatim');
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		console.log('\n=== 2. set_pivot: a head nods at the neck ===');
		const head = await make('Head', [0, 2, 0]);
		const set = json(await call(B.client, 'set_pivot', { updates: [{ uuid: head, at: [0, 1.5, 0] }] }));
		h.check(set.updated?.[0]?.ok === true && near(set.updated[0].pivot, [0, 1.5, 0]), 'set_pivot answers the world point: ' + short(set.updated));
		await h.eventually(() => onHost(A.page, head), (o) => near(o?.origin, [0, -0.5, 0]) && near(o.pos, [0, 2, 0]), '2. the host has the origin, and the head did not move', 20000);
		await call(B.client, 'update_objects', { updates: [{ uuid: head, rotation: [Math.PI / 2, 0, 0] }] });
		// about the neck (0, 1.5, 0), the centre 0.5 above it swings to 0.5 along +z
		await h.eventually(() => onHost(A.page, head), (o) => near(o?.pos, [0, 1.5, 0.5]) && Math.abs(o.rotX - Math.PI / 2) < 1e-3, '2. COUNTERFACTUAL: rotating swung it about the neck on the host (the centre moved to [0, 1.5, 0.5])', 20000);
		const listed = json(await call(B.client, 'list_scene', { name: 'Head' }));
		h.check(listed.objects?.find((o) => o.uuid === head)?.pivot?.length === 3, '2. list_scene reports the pivot: ' + short(listed.objects?.find((o) => o.uuid === head)?.pivot));

		console.log('\n=== 3. create_pivot: two parts about one shoulder ===');
		const upper = await make('Upper', [3, 2, 0]);
		const lower = await make('Lower', [3, 1, 0]);
		const piv = json(await call(B.client, 'create_pivot', { objects: [upper, lower], at: [3, 2.5, 0], name: 'Shoulder' }));
		h.check(!!piv.groupUuid && piv.members?.length === 2, 'create_pivot returns the group and members: ' + short(piv));
		await h.eventually(() => onHost(A.page, piv.groupUuid), (o) => o?.name === 'Shoulder' && near(o.pos, [3, 2.5, 0]), '3. the host has the Shoulder group at the point', 20000);
		await h.eventually(() => onHost(A.page, upper), (o) => o?.parent === piv.groupUuid && near(o.world, [3, 2, 0]), '3. the host has Upper inside it, same place in the world', 20000);
		await call(B.client, 'update_objects', { updates: [{ uuid: piv.groupUuid, rotation: [0, 0, Math.PI] }] });
		await h.eventually(() => onHost(A.page, upper), (o) => near(o?.world, [3, 3, 0]), '3. turning the group swings Upper over the shoulder on the host', 20000);
		await h.eventually(() => onHost(A.page, lower), (o) => near(o?.world, [3, 4, 0]), '3. and Lower with it', 20000);

		console.log('\n=== 4. add_image: canvas, base64, URL ===');
		const canvas = json(await call(B.client, 'add_image', {
			name: 'floor',
			canvas: { width: 64, height: 64, background: '#334455', ops: [{ op: 'noise', scale: 4, opacity: 0.5, colors: ['#222222', '#dddddd'] }, { op: 'checker', cols: 2, rows: 2, colors: ['#ff000040', '#00000000'] }, { op: 'text', text: 'Hi', x: 4, y: 4, size: 16, fill: 'white' }] }
		}));
		h.check(/^[0-9a-f]+$/i.test(canvas.hash || '') && canvas.pixels?.w === 64, 'canvas: a hash and 64 px: ' + short(canvas));
		await h.eventually(() => inLibrary(A.page, canvas.hash), (x) => x === true, '4. the drawn image is in the HOST\'s library by hash', 40000);
		const crate = await make('Crate', [-3, 0.5, 0]);
		const textured = json(await call(B.client, 'update_objects', { updates: [{ uuid: crate, materialParams: { map: canvas.hash } }] }));
		h.check(!textured.warning, 'the hash goes into a texture slot: ' + short(textured));
		await h.eventually(() => onHost(A.page, crate), (o) => o?.map === true, '4. the host\'s Crate wears it', 40000);

		// a real JPEG with a planted EXIF block, from the host page's own canvas
		const jpeg = await A.page.evaluate(() => {
			const c = document.createElement('canvas');
			c.width = c.height = 32;
			const x = c.getContext('2d');
			x.fillStyle = '#c06030';
			x.fillRect(0, 0, 32, 32);
			const b = atob(c.toDataURL('image/jpeg').split(',')[1]);
			const marker = 'Exif\0\0SECRET-GPS-48.85N';
			const len = marker.length + 2;
			return btoa(b.slice(0, 2) + '\xff\xe1' + String.fromCharCode(len >> 8, len & 255) + marker + b.slice(2));
		});
		h.check(atob(jpeg).includes('SECRET-GPS'), 'premise: the JPEG carries the planted block');
		const mid = Math.floor(jpeg.length / 8) * 4;
		const part1 = json(await call(B.client, 'add_image', { data: jpeg.slice(0, mid), chunk: { id: 'j1', index: 0, total: 2 }, name: 'made', prompt: 'a terracotta swatch' }));
		h.check(part1.partial === true && part1.of === 2, 'base64 in parts: the first is kept: ' + short(part1));
		const part2 = json(await call(B.client, 'add_image', { data: jpeg.slice(mid), chunk: { id: 'j1', index: 1, total: 2 }, name: 'made', prompt: 'a terracotta swatch' }));
		h.check(/\.webp$/.test(part2.name || '') && part2.pixels?.w === 32, 'the last part: a JPEG comes back re-encoded: ' + short(part2));
		await h.eventually(() => inLibrary(A.page, part2.hash), (x) => x === true, '4. the generated image is in the host\'s library', 40000);

		// the URL path needs a route the test controls, so it runs in the host page's own assistant path
		await A.page.route('https://images.example.test/**', (route) =>
			route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/jpeg' }, body: Buffer.from(jpeg, 'base64') })
		);
		// a REAL other origin with no CORS header: Playwright's route.fulfill does not produce the browser's refusal
		const noCors = https.createServer({ key: fs.readFileSync(path.join(root, 'certs/localhost.key')), cert: fs.readFileSync(path.join(root, 'certs/localhost.crt')) }, (_req, res) => {
			res.writeHead(200, { 'content-type': 'image/jpeg' });
			res.end(Buffer.from(jpeg, 'base64'));
		});
		await new Promise((r) => noCors.listen(0, r));
		const blockedUrl = 'https://' + new URL(BASE).hostname + ':' + noCors.address().port + '/a.jpg';
		const reachable = await A.page.evaluate((u) => fetch(u, { mode: 'no-cors' }).then(() => true, () => false), blockedUrl);
		await A.page.route('https://html.example.test/**', (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: '<!doctype html><html>log in</html>' }));
		const exec = (tool, args) => A.page.evaluate(([t, a]) => window.__stores.aiTools.executeAiTool(t, a), [tool, args]);
		const fromUrl = await exec('add_image', { url: 'https://images.example.test/swatch.jpg?token=SECRET', name: 'fetched', licence: 'CC0' });
		h.check(/\.webp$/.test(fromUrl.name || ''), 'a URL: fetched and re-encoded: ' + short(fromUrl));
		const held = await A.page.evaluate(async (hash) => {
			const ex = window.__stores.explorer;
			const item = ex.itemByHash(hash);
			const blob = await ex.itemBlob(item.id);
			return { text: new TextDecoder('latin1').decode(await blob.arrayBuffer()), provenance: JSON.stringify(item) };
		}, fromUrl.hash);
		h.check(!held.text.includes('SECRET-GPS') && !held.text.includes('Exif'), '4. COUNTERFACTUAL: the planted EXIF did not survive (only pixels are kept)');
		for (const [args, re, what] of [
			[{ url: 'http://images.example.test/a.png' }, /https/, 'an http address'],
			[{ url: 'https://127.0.0.1/a.png' }, /local network/, 'this machine'],
			...(reachable ? [[{ url: blockedUrl }, /CORS/, 'a real other origin with no CORS header']] : []),
			[{ url: 'https://html.example.test/a.png' }, /web page/, 'a web page named .png'],
			[{ data: btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, /SVG/, 'an SVG'],
			[{ url: 'https://images.example.test/a.jpg', data: jpeg }, /exactly one/, 'two sources'],
			[{ canvas: { width: 8, height: 8, ops: [{ op: 'script', code: 'alert(1)' }] } }, /unknown op/, 'a canvas op that is not one']
		]) {
			const r = await exec('add_image', args);
			h.check(re.test(r.error || ''), '4. refused: ' + what + ': ' + String(r.error).slice(0, 80));
		}

		noCors.close();
		if (!reachable) console.log('NOTE the no-CORS row did not run: the browser cannot reach this machine on a free port (remote slot)');

		console.log('\n=== 5. undo_last ===');
		const a = await make('UndoMe', [6, 0.5, 0]);
		const u1 = json(await call(B.client, 'undo_last', {}));
		h.check(u1.undone?.length === 1 && /UndoMe/.test(u1.undone[0].text), 'undo_last names what it took back: ' + short(u1));
		await h.eventually(() => onHost(A.page, a), (o) => o === null, '5. the object is gone from the host', 20000);

		// a canvas add is one step too: its file goes to the bin on the host
		const temp = json(await call(B.client, 'add_image', { name: 'temp', canvas: { width: 8, height: 8, background: '#123456' } }));
		await h.eventually(() => inLibrary(A.page, temp.hash), (x) => x === true, '5. premise: the temp image reached the host', 40000);
		const u2 = json(await call(B.client, 'undo_last', {}));
		h.check(u2.undone?.length === 1, 'undo_last takes an image back: ' + short(u2));
		await h.eventually(() => inLibrary(A.page, temp.hash), (x) => x === false, '5. the image left the host\'s library', 40000);

		const c1 = await make('One', [7, 0.5, 0]);
		const c2 = await make('Two', [8, 0.5, 0]);
		const u3 = json(await call(B.client, 'undo_last', { count: 2 }));
		h.check(u3.count === 2, 'count: 2 takes back two: ' + short(u3));
		await h.eventually(() => onHost(A.page, c1), (o) => o === null, '5. count: the first object is gone', 20000);
		await h.eventually(() => onHost(A.page, c2), (o) => o === null, '5. count: the second too', 20000);

		const shared = await make('Shared', [9, 0.5, 0]);
		await new Promise((r) => setTimeout(r, 200));
		await exec('update_objects', { updates: [{ uuid: shared, position: [9, 3, 0] }] }); // the PERSON moves it
		await new Promise((r) => setTimeout(r, 1500));
		const u4 = json(await call(B.client, 'undo_last', {}));
		h.check(u4.refused === true && u4.conflicts?.[0]?.uuid === shared && /Shared/.test(u4.error) && !u4.error.includes(shared), '5. COUNTERFACTUAL: a person\'s later edit refuses it, in words: ' + String(u4.error).slice(0, 110));
		h.check(!!(await onHost(A.page, shared)), '5. the object stayed');
		h.check(near((await onHost(A.page, shared)).pos, [9, 3, 0]), '5. and the person\'s edit stands');

		await h.eventually(
			() => read(A.page, 'agentLog.agentLog'),
			(l) => ['set_pivot', 'create_pivot', 'add_image', 'undo_last'].every((t) => (l || []).some((e) => e.tool === t)),
			'5. the host\'s A8 log has a line for each tool',
			20000
		);
		const log = await read(A.page, 'agentLog.agentLog');
		for (const e of (log || []).filter((x) => TOOLS.includes(x.tool))) console.log('   · ' + e.tool + ': ' + e.text);
		const pivotLine = log.find((e) => e.tool === 'set_pivot');
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), pivotLine);
		await h.eventually(() => onHost(A.page, head), (o) => o && o.origin === null, '5. per-line Undo on the set_pivot line clears it on the host', 20000);
		const groupLine = log.find((e) => e.tool === 'create_pivot');
		await A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), groupLine);
		await h.eventually(() => onHost(A.page, piv.groupUuid), (o) => o === null, '5. per-line Undo on the create_pivot line removes the group on the host', 20000);
		await h.eventually(() => onHost(A.page, upper), (o) => o?.parent === 'root', '5. and Upper is back at the root', 20000);
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}

	console.log('\n=== 6. the connector\'s shape: the agent in a person\'s own tab ===');
	// the page's own modules, wired the way connector.js wires them (the relay itself is connector-relay's subject)
	const tab = await h.setupPage(browser, 'tab');
	const tabResult = await tab.page.evaluate(async () => {
		const { createConnectorAgent } = await import('/src/lib/agent/tpAgent.js');
		const { startAgentRecorder } = await import('/src/lib/agentLogRecorder.js');
		let relaying = 0;
		startAgentRecorder({ name: 'Claude (connector)', accept: () => relaying > 0 });
		const core = createConnectorAgent();
		const relayed = async (t, a) => {
			relaying++;
			try {
				return await core.agent.exec(t, a);
			} finally {
				relaying--;
			}
		};
		const tools = window.__stores.aiTools;
		const made = await relayed('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Mine' }] });
		const uuid = made.created[0].uuid;
		await new Promise((r) => setTimeout(r, 100));
		await tools.executeAiTool('update_objects', { updates: [{ uuid, position: [0, 4, 0] }] }); // the person, by hand
		const refused = await relayed('undo_last', {});
		window.__stores.history.undo(); // their own step off the stack
		const undone = await relayed('undo_last', {});
		await new Promise((r) => setTimeout(r, 500)); // the line lands a beat after the result
		/** @type {any} */ let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		/** @type {any} */ let log;
		window.__stores.agentLog.agentLog.subscribe((l) => (log = l))();
		return { refused, undone, gone: !group.getObjectByProperty('uuid', uuid), names: log.map((l) => l.name + ': ' + l.text) };
	});
	h.check(tabResult.refused.refused === true && /this tab/.test(tabResult.refused.error), '6. the person\'s own edit at the tab refuses it: ' + String(tabResult.refused.error).slice(0, 100));
	h.check(tabResult.undone.undone?.length === 1 && tabResult.gone, '6. once they took it back, "undo that" removes the object: ' + JSON.stringify(tabResult.undone).slice(0, 100));
	h.check(tabResult.names.some((n) => n.startsWith('Claude (connector): undid')), '6. the A8 line is the connector\'s: ' + tabResult.names.join(' | ').slice(0, 160));

	console.log('\n=== 7. a viewer is refused ===');
	const V = await h.setupPage(browser, 'V', { storage: { agentApi: '1' } });
	await V.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(V, A);
	await V.page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: '', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole: () => {}, synced: () => true })
	);
	const before = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	for (const [tool, args] of [
		['undo_last', {}],
		['set_pivot', { updates: [{ uuid: 'x', at: [0, 0, 0] }] }],
		['create_pivot', { objects: ['x'], at: [0, 0, 0] }],
		['add_image', { canvas: { width: 4, height: 4, background: 'red' } }]
	]) {
		const r = await V.page.evaluate(([t, a]) => window.tpAgent.exec(t, a), [tool, args]);
		h.check(r?.refused === true || r?.viewOnly === true, '7. a viewer\'s ' + tool + ' is refused: ' + String(r?.error).slice(0, 70));
		// the page's own executor too (the in-app assistant's way in)
		const direct = await V.page.evaluate(([t, a]) => window.__stores.aiTools.executeAiTool(t, a), [tool, args]);
		h.check(direct?.viewOnly === true, '7. and through the assistant\'s executor: ' + tool);
	}
	await new Promise((r) => setTimeout(r, 1500));
	const after = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
	h.check(after === before, '7. nothing reached the host from the viewer (' + before + ' → ' + after + ')');

	await bounded(h.finish(browser), 30000);
	process.exit(2); // finish exits; reaching here means it hung
});
