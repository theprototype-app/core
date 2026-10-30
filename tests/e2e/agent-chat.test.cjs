// Roadmap 56 — TALK TO YOUR AGENT, the agent half of the release proof (56-bridge). A REAL MCP stdio client
// spawns `tools/agent/src/cli.js mcp <link>` and plays the agent's loop (wait_for_message → exec → reply),
// while the HOST page (A) and a second peer (C) type to it over the replicated `{type:'agentchat'}` message.
// The window UI is 56-chat's: here the pages send and read the raw messages.
//   1. a request from the host reaches wait_for_message with role editor; the agent builds via exec; the
//      A8 lines (with the chatId) and the streamed reply reach the host AND the second peer
//   2. the badge: listening while the agent waits, working once a message is delivered, mode mcp
//   3. Stop mid-request: the next exec returns cancelled, until the next message
//   4. a viewer's message is delivered with role viewer, an edit is refused, its image is dropped
//   5. a terminal-originated turn shows via cli; ask → buttons → the answer comes back as a message
//   6. an editor's image: an MCP image block + a temp file with the same bytes
//   7. a chat switch carries the chat's history; get_thread pages further back; mute stops delivery
//   8. REPL mode against a stub OpenAI-compatible endpoint: an app message is answered with no terminal
//      input, the reply streams, a stdin line shows via cli
// The agent page gets roles through the bridge's TP_AGENT_INIT_SCRIPT seam (C = viewer): roles are a cloud
// build's, and this runs on a plain dev server.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** read a store off window.__stores; 'mod.store' reaches into a lazily imported module (agentLog.agentLog) */
const read = (page, expr) =>
	page.evaluate(
		(e) => new Promise((r) => e.split('.').reduce((o, k) => o[k], window.__stores).subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))()),
		expr
	);
const sceneNames = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g ? g.children.map((c) => c.name) : []))()));

/** send an agentchat message from a page (what 56-chat's window does) */
const sendChat = (page, msg) =>
	page.evaluate(
		(m) =>
			new Promise((r) =>
				window.__stores.peers.subscribe((p) => {
					p.send({ type: 'agentchat', from: p.peer.id, ...m });
					r(true);
				})()
			),
		msg
	);

/** every agentchat this page received from `agentId`. Taps DataConnection.prototype.emit once, so a
 * connection opened later (a re-dial, the adopted inbound channel) is heard from its first message. */
const seen = (page, agentId) =>
	page.evaluate((id) => {
		const w = /** @type {any} */ (window);
		w.__ac = w.__ac || [];
		let P;
		w.__stores.peers.subscribe((p) => (P = p))();
		if (!w.__acTapped) {
			const conn = Object.values(P?.peer?.connections ?? {}).flat()[0];
			const proto = conn && Object.getPrototypeOf(conn);
			if (proto) {
				const emit = proto.emit;
				proto.emit = function (ev, d, ...rest) {
					if (ev === 'data' && d && d.type === 'agentchat') w.__ac.push({ ...d, __via: this.peer });
					return emit.call(this, ev, d, ...rest);
				};
				w.__acTapped = 1;
			}
		}
		if (!w.__acTapped) return null; // no connection yet to find the class by
		return JSON.parse(JSON.stringify(w.__ac.filter((d) => d.__via === id)));
	}, agentId);

async function startMcp(link, env) {
	const { Client } = await sdk('client/index.js');
	const { StdioClientTransport } = await sdk('client/stdio.js');
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(agentDir, 'src/cli.js'), 'mcp', link, '--verbose'],
		env: { ...process.env, ...env },
		stderr: 'pipe'
	});
	/** @type {string[]} */
	const log = [];
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	transport.stderr.on('data', (d) => log.push(...String(d).split('\n').filter(Boolean)));
	await client.connect(transport);
	return { client, transport, log, pid: transport.pid };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 700000 });
const text = (r) => r.content.find((c) => c.type === 'text').text;
const json = (r) => JSON.parse(text(r));

async function waitJoined(client, ms = 120000) {
	const t0 = Date.now();
	let st = null;
	while (Date.now() - t0 < ms) {
		st = json(await call(client, 'status'));
		if (st.joined) return st;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return st;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	const C = await h.setupPageQuiet(browser, 'peer', [A]);
	await h.connect(C, A);
	const link = BASE + '/#' + A.id;

	// the agent page's roles (a cloud build's plugin would publish these): C is a viewer, everyone else edits
	const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-e2e-'));
	const initScript = path.join(initDir, 'roles.js');
	fs.writeFileSync(
		initScript,
		`localStorage.setItem('debugStores', 'true');
		 (function poll() {
		   const h = window.__stores && window.__stores.cloudHooks;
		   if (!h || !h.rolesInfo) return setTimeout(poll, 200);
		   const roles = ${JSON.stringify({ [C.id]: 'viewer' })};
		   h.rolesInfo.set({ myId: null, myRole: 'editor', amAdmin: false, order: [], roleOf: (id) => roles[id] || 'editor', setRole: () => {} });
		 })();`
	);

	const B = await startMcp(link, { TP_AGENT_INIT_SCRIPT: initScript });
	let agentId = '';
	try {
		const listed = (await B.client.listTools()).tools.map((t) => t.name);
		h.check(['wait_for_message', 'reply', 'ask', 'get_thread'].every((n) => listed.includes(n)), 'the chat tools are listed at once');
		await h.approveButton(A.page).click({ timeout: 120000 });
		const st = await waitJoined(B.client);
		h.check(st && st.joined === true, 'the agent joined after Approve');
		agentId = st?.session?.peerId;
		h.check(st?.session?.version === '1.3.0', 'tpAgent 1.3.0 (the chat contract): ' + st?.session?.version);
		for (const P of [A, C]) await h.eventually(() => seen(P.page, agentId), (l) => Array.isArray(l), 'the ' + (P === A ? 'host' : 'second peer') + ' is tapping the agent', 30000);
		await h.eventually(() => openedPeersOf(C.page), (p) => p.includes(agentId), 'the agent is in the mesh with the second peer', 60000);

		// ---- 1 + 2: the host types; the agent's wait returns it; builds; replies
		const chatA = 'chat-a-' + Date.now().toString(36);
		const waiting = call(B.client, 'wait_for_message', { timeoutS: 120 });
		await h.eventually(() => seen(A.page, agentId), (l) => (l || []).some((m) => m.status === 'listening' && m.mode === 'mcp'), 'the badge says listening (mode mcp) while the agent waits', 30000);
		await sendChat(A.page, { id: 'r1', chatId: chatA, to: agentId, text: 'add three trees around the fire', role: 'admin' });
		const m1 = json(await waiting);
		h.check(m1.text === 'add three trees around the fire' && m1.from === A.id.toLowerCase() && m1.chatId === chatA, 'wait_for_message returned the host\'s message');
		h.check(m1.role === 'editor', 'with the sender\'s role from the agent page (editor — the forged "admin" ignored)');
		await h.eventually(() => seen(A.page, agentId), (l) => (l || []).some((m) => m.status === 'working'), 'the badge says working once the message is delivered', 15000);
		const made = json(
			await call(B.client, 'create_objects', {
				objects: [0, 1, 2].map((i) => ({ kind: 'primitive', primitive: 'Cone', name: 'ChatTree' + i, position: [Math.cos(i * 2.1) * 3, 1, Math.sin(i * 2.1) * 3] }))
			})
		);
		h.check(made?.created?.length === 3, 'exec built three trees');
		await call(B.client, 'reply', { text: 'Planting three trees…' });
		await call(B.client, 'reply', { text: 'Done: three trees around the fire.', final: true });
		for (const [who, P] of [['host', A], ['second peer', C]]) {
			await h.eventually(() => sceneNames(P.page), (n) => ['ChatTree0', 'ChatTree1', 'ChatTree2'].every((x) => n.includes(x)), 'the trees are in the ' + who + '\'s scene', 20000);
			await h.eventually(
				() => read(P.page, 'agentLog.agentLog'),
				(log) => (log || []).some((e) => e.tool === 'create_objects' && e.chatId === chatA),
				'the A8 line reached the ' + who + ', tagged with the chatId',
				20000
			);
			await h.eventually(
				() => seen(P.page, agentId),
				(l) => {
					const r = (l || []).filter((m) => m.replyTo === 'r1');
					return r.some((m) => m.partial) && r.some((m) => !m.partial && m.text === 'Planting three trees…\n\nDone: three trees around the fire.');
				},
				'the streamed reply (partial, then final) reached the ' + who,
				20000
			);
		}

		// ---- 3: Stop
		let w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await sendChat(A.page, { id: 'r2', chatId: chatA, to: agentId, text: 'build a tall tower, slowly' });
		h.check(json(await w).id === 'r2', 'the next request arrived');
		const step1 = json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Tower1', position: [6, 0.5, 0] }] }));
		h.check(step1?.created?.length === 1, 'the first floor ran');
		await sendChat(A.page, { cancel: 'r2', chatId: chatA, to: agentId });
		// the agent page (software GL, busy after a build) can take a few seconds to read the Stop: wait for it
		await h.eventually(
			async () => json(await call(B.client, 'status'))?.session?.chat,
			(c) => c?.current?.id === 'r2' && c.current.cancelled === true,
			'the agent page marked the request cancelled',
			20000
		);
		const step2 = await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Tower2', position: [6, 1.5, 0] }] });
		h.check(step2.isError === true && json(step2).cancelled === true, 'after Stop the next exec returns cancelled');
		await new Promise((r) => setTimeout(r, 800));
		h.check(!(await sceneNames(A.page)).includes('Tower2'), 'nothing from the cancelled call reached the host');
		await call(B.client, 'reply', { text: 'Stopped.', final: true });

		// ---- 4: a viewer
		w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await sendChat(C.page, { id: 'r3', chatId: chatA, to: agentId, text: 'delete all the trees', images: [{ mimeType: 'image/png', data: PNG }] });
		const m3r = await w;
		const m3 = json(m3r);
		h.check(m3.role === 'viewer' && /VIEWER/.test(m3.note || ''), 'the viewer\'s message is delivered with role viewer');
		h.check(m3.imagesDropped === true && !m3r.content.some((c) => c.type === 'image'), 'the viewer\'s image was dropped before the agent saw it');
		const del = await call(B.client, 'delete_objects', { uuids: made.created.map((c) => c.uuid) });
		h.check(del.isError === true && json(del).refused === true, 'an edit during the viewer\'s request is refused');
		await new Promise((r) => setTimeout(r, 800));
		h.check((await sceneNames(A.page)).includes('ChatTree0'), 'the trees are still there');
		await call(B.client, 'reply', { text: 'Viewers cannot change the scene.', final: true });

		// ---- 5: a terminal turn + ask
		await call(B.client, 'reply', { prompt: 'make the fire bigger', text: 'Made the fire twice as big.', final: true });
		await h.eventually(
			() => seen(A.page, agentId),
			(l) => (l || []).some((m) => m.role === 'user' && m.via === 'cli' && m.text === 'make the fire bigger') && l.some((m) => m.via === 'cli' && !m.partial && m.text === 'Made the fire twice as big.'),
			'a terminal-originated turn and its reply reach the host "via terminal"',
			15000
		);
		w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await sendChat(A.page, { id: 'r4', chatId: chatA, to: agentId, text: 'plant a tree by the door' });
		await w;
		const askId = json(await call(B.client, 'ask', { question: 'Pine or oak?', options: ['Pine', 'Oak'] })).id;
		await h.eventually(() => seen(A.page, agentId), (l) => (l || []).some((m) => m.id === askId && m.ask?.options?.join() === 'Pine,Oak'), 'the ask reached the host with its buttons', 15000);
		w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await sendChat(A.page, { id: 'r5', chatId: chatA, to: agentId, text: 'Oak', answers: askId });
		const m5 = json(await w);
		h.check(m5.answers === askId && m5.text === 'Oak', 'the click came back as a message answering the ask');
		await call(B.client, 'reply', { text: 'An oak it is.', final: true });

		// ---- 6: an editor's image
		w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await sendChat(A.page, { id: 'r6', chatId: chatA, to: agentId, text: 'build this', images: [{ mimeType: 'image/png', data: PNG, name: 'sketch.png', w: 1, h: 1 }] });
		const m6r = await w;
		const m6 = json(m6r);
		const block = m6r.content.find((c) => c.type === 'image');
		h.check(block && block.mimeType === 'image/png' && block.data === PNG, 'the image arrives as an MCP image block');
		const p6 = m6.images?.[0]?.path;
		h.check(!!p6 && fs.existsSync(p6) && fs.readFileSync(p6).equals(Buffer.from(PNG, 'base64')), 'and as a temp file with the same bytes (' + p6 + ')');
		h.check(!text(m6r).includes(PNG.slice(0, 30)), 'the message JSON carries the path, not the base64');
		await call(B.client, 'reply', { text: 'Got the sketch.', final: true });

		// ---- 6b (roadmap 66 S4b): a file from the agent's own disk, through the real bridge — the Pixling
		// fixture by local `path` + `spec_path` (the bridge reads both; the page never sees a path)
		const pix = path.join(__dirname, 'fixtures', 'pixling');
		const imp = await call(B.client, 'import_file', { path: path.join(pix, 'knight_walk.png'), spec_path: path.join(pix, 'knight.pixling.json'), frame: { w: 64, h: 48, col: 0, row: 0 }, position: [8, 0.5, 0] });
		const impJ = json(imp);
		h.check(!imp.isError && impJ.file?.name === 'knight_walk.png' && impJ.spec?.name === 'knight_walk.pixling.json' && !!impJ.uuid, `import_file by local path through the MCP bridge (${text(imp).slice(0, 160)})`);
		await h.eventually(() => sceneNames(A.page), (n) => n.includes('knight_walk'), 'the imported card reached the host', 20000);
		const bad = await call(B.client, 'import_file', { path: path.join(pix, 'README.md') });
		h.check(bad.isError === true && /not a PNG, WebP, JSON or \.tpanim/.test(text(bad)), `a non-image is refused by the bridge before sending (${text(bad).slice(0, 100)})`);

		// ---- 7: a chat switch, get_thread, mute
		const chatB = 'chat-b-' + Date.now().toString(36);
		w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await sendChat(A.page, { id: 'r7', chatId: chatB, to: agentId, text: 'a new chat' });
		h.check(json(await w).chatId === chatB, 'New chat: the message carries the new chatId');
		await call(B.client, 'reply', { text: 'Hello in the new chat.', final: true });
		w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await sendChat(A.page, { id: 'r8', chatId: chatA, to: agentId, text: 'back to the trees' });
		const m8 = json(await w);
		h.check(m8.chatId === chatA && Array.isArray(m8.history) && m8.history.length >= 10, 'reopening the first chat: the message carries its history (' + (m8.history || []).length + ')');
		h.check(m8.history.some((x) => x.text === 'add three trees around the fire') && /earlier message/.test(m8.summary || ''), 'with the first request in it and a summary');
		const page1 = json(await call(B.client, 'get_thread', { chatId: chatA, limit: 3 }));
		h.check(page1.messages.length === 3 && page1.more === true, 'get_thread: the newest 3, more = true');
		const page2 = json(await call(B.client, 'get_thread', { chatId: chatA, before: page1.messages[0].id, limit: 100 }));
		h.check(page2.messages.length >= 5 && page2.messages[0].text === 'add three trees around the fire', 'get_thread pages back to the first message');
		await call(B.client, 'reply', { text: 'Back to the trees.', final: true });
		await sendChat(A.page, { to: agentId, mute: true });
		await h.eventually(() => seen(A.page, agentId), (l) => (l || []).some((m) => m.status && m.muted === true), 'the host muted the agent: its status says muted', 15000);
		w = call(B.client, 'wait_for_message', { timeoutS: 4 });
		await sendChat(A.page, { id: 'r9', chatId: chatA, to: agentId, text: 'are you there?' });
		h.check(text(await w) === 'null', 'muted: nothing is delivered (the wait times out with null)');
		await sendChat(A.page, { to: agentId, mute: false });
		await new Promise((r) => setTimeout(r, 1000));
		w = call(B.client, 'wait_for_message', { timeoutS: 30 });
		await sendChat(A.page, { id: 'r10', chatId: chatA, to: agentId, text: 'and now?' });
		h.check(json(await w).id === 'r10', 'unmuted: delivery resumes');
		await call(B.client, 'reply', { text: 'Here.', final: true });
	} catch (e) {
		console.log('--- bridge stderr ---\n' + B.log.slice(-60).join('\n'));
		throw e;
	} finally {
		await B.client.close().catch(() => {});
		await new Promise((r) => setTimeout(r, 3000));
		try {
			process.kill(B.pid);
		} catch {}
	}
	await h.eventually(() => openedPeersOf(A.page), (p) => !p.includes(agentId), 'the MCP agent left', 20000);

	// ---- 8: REPL mode with a stub OpenAI-compatible endpoint
	const { startStubLlm } = await import(pathToFileURL(path.join(agentDir, 'test/fixtures/stubLlm.mjs')).href);
	const llm = await startStubLlm();
	const R = spawn(process.execPath, [path.join(agentDir, 'src/cli.js'), 'repl', link, '--api-url', llm.url, '--model', 'stub-1', '--name', 'stubbot'], {
		env: { ...process.env },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	let rout = '';
	R.stdout.on('data', (d) => (rout += d));
	R.stderr.on('data', (d) => (rout += d));
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(() => Promise.resolve(rout), (o) => /in the session/.test(o), 'the REPL agent joined', 120000);
		const replId = await h
			.eventually(() => read(A.page, 'userdata'), (rows) => (rows || []).some((u) => u[1] === 'stubbot'), 'the REPL agent is in Users', 20000)
			.then(async () => (await read(A.page, 'userdata')).find((u) => u[1] === 'stubbot')[0]);
		await h.eventually(() => seen(A.page, replId), (l) => (l || []).some((m) => m.status && m.mode === 'repl' && m.model === 'stub-1'), 'the REPL badge says repl + the model', 30000);
		await sendChat(A.page, { id: 'q1', chatId: 'chat-repl', to: replId, text: 'add three trees around the fire' });
		await h.eventually(
			() => seen(A.page, replId),
			(l) => (l || []).some((m) => m.replyTo === 'q1' && !m.partial && /Planted three trees around the fire/.test(m.text)),
			'an app message is answered by the REPL model with no terminal input (streamed, final)',
			60000
		);
		await h.eventually(() => sceneNames(A.page), (n) => n.filter((x) => /^Tree [123]$/.test(x)).length === 3, 'the REPL model built through the host\'s tools', 20000);
		R.stdin.write('hello from the terminal\n');
		await h.eventually(
			() => seen(A.page, replId),
			(l) => (l || []).some((m) => m.role === 'user' && m.via === 'cli' && m.text === 'hello from the terminal') && l.some((m) => m.via === 'cli' && !m.partial && /You said: hello from the terminal/.test(m.text)),
			'a terminal line shows "via terminal" in the app, with its streamed answer',
			60000
		);
		h.check(llm.requests.some((q) => q.stream === true), 'the REPL streamed from the endpoint');
	} catch (e) {
		console.log('--- repl output ---\n' + rout.slice(-4000));
		throw e;
	} finally {
		R.kill('SIGTERM');
		await new Promise((r) => setTimeout(r, 2000));
		await llm.close();
		fs.rmSync(initDir, { recursive: true, force: true });
	}

	await h.finish(browser);
});

function openedPeersOf(page) {
	return page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.openedPeers ? [...p.openedPeers] : []))()));
}
