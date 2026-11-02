// Whose roster rows a peer may change, three real peers.
//
// H hosts; G and K joined with H's approval. Each probe is a raw message from G to H, because the point is what
// H does with whatever a connected guest sends:
//   1. G sends rows for K and for H with another name, picture, look and kind: H keeps its own values;
//   2. G's own row still updates (same message order, so 1 has been applied when 2 shows);
//   3. G says an id H holds but has no link to has gone: H keeps the row;
//   3b. G chats, sets per-player numbers and reports a scene as K: none of it is K's on H, and G still chats as itself;
// and the host still speaks for the session:
//   4. H's rows about K update G's copy;
//   5. H's word that an id G has no link to has gone removes it on G.
//
// Run: APP_URL='https://localhost:5980/' npm run e2e -- roster-rows
const h = require('./helpers.cjs');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			const read = (store) => {
				let v;
				window.__stores[store].subscribe((x) => (v = x))();
				return v;
			};
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'read', 'arg', src)(window.__stores, pc, read, a);
		},
		[body, arg ?? null]
	);
const rowOf = (p, id) => inPage(p, `const r = read('userdata').find((u) => u[0] === arg); return r ? JSON.parse(JSON.stringify(r)) : null;`, id);
const raw = (p, to, msg) => inPage(p, `pc.connections[arg.to].send(arg.msg);`, { to, msg });
const plant = (p, id) => inPage(p, `const u = read('userdata'); if (!u.some((r) => r[0] === arg)) u.push([arg, '', '']); s.userdata.set(u);`, id);
const nameOf = async (p, id) => (await rowOf(p, id))?.[1];

const until = async (p, fn, ms = 40000) => {
	for (const t = Date.now() + ms; Date.now() < t; await p.page.waitForTimeout(500)) if (await fn()) return true;
	return false;
};

const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const LOOK = { character: 'probe-look' };
const forged = (id) => [id, 'Probe ' + id.slice(0, 4), PIC, null, null, LOOK, { kind: 'agent' }];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPageQuiet(browser, 'G', [H]);
	await h.connect(G, H);
	const K = await h.setupPageQuiet(browser, 'K', [H, G]);
	await h.connect(K, H);
	h.check(await until(G, async () => !!(await rowOf(G, K.id))), 'the guest holds a row for the other guest');

	// K and H name themselves the ordinary way, so every copy has a value to keep
	await inPage(K, `s.username.set('Kay'); const u = read('userdata'); u.forEach((r) => { if (r[0] === pc.peer.id) r[1] = 'Kay'; }); s.userdata.set(u); pc.send({ type: 'userdata', userdata: u });`);
	await inPage(H, `s.username.set('Host'); const u = read('userdata'); u.forEach((r) => { if (r[0] === pc.peer.id) r[1] = 'Host'; }); s.userdata.set(u); pc.send({ type: 'userdata', userdata: u });`);
	h.check(await until(H, async () => (await nameOf(H, K.id)) === 'Kay'), 'the host holds the guest’s own name');
	h.check(await until(G, async () => (await nameOf(G, K.id)) === 'Kay' && (await nameOf(G, H.id)) === 'Host'), 'the other guest holds both names');
	const kBefore = await rowOf(H, K.id);
	const hBefore = await rowOf(H, H.id);

	// 1 + 2. Rows for others, then the sender's own row, in order on one link
	await raw(G, H.id, { type: 'userdata', userdata: [forged(K.id), forged(H.id)] });
	await raw(G, H.id, { type: 'userdata', userdata: [[G.id, 'Gee', '']] });
	h.check(await until(H, async () => (await nameOf(H, G.id)) === 'Gee', 15000), 'a guest can still update its own row');
	const kAfter = await rowOf(H, K.id);
	h.check(same(kAfter, kBefore), 'a guest cannot change another guest’s row on the host (' + JSON.stringify(kAfter?.slice(1, 2)) + ')');
	h.check(kAfter?.[6]?.kind !== 'agent', 'nor its kind');
	h.check(kAfter?.[2] !== PIC && !same(kAfter?.[5], LOOK), 'nor its picture and look');
	h.check(same(await rowOf(H, H.id), hBefore), 'nor the host’s own row');

	// 3. A rumour about an id the host holds but has no link to
	const P = 'probe-' + Math.random().toString(36).slice(2, 10);
	await plant(H, P);
	await raw(G, H.id, { type: 'disconnected', peerId: P });
	await raw(G, H.id, { type: 'userdata', userdata: [[G.id, 'Gee2', '']] });
	h.check(await until(H, async () => (await nameOf(H, G.id)) === 'Gee2', 15000), 'the rumour has been read');
	h.check(!!(await rowOf(H, P)), 'a guest cannot remove a row the host has no link to');

	// 3b. Chat, per-player numbers and scene presence that name the other guest, then G's own line.
	// Each is read as G's own (G may say anything about itself), never as K's.
	const t = Date.now();
	const sceneRow = (p, id) => inPage(p, `let m; s.peerScenes.peerScenes.subscribe((v) => (m = v))(); return m[arg] ? JSON.parse(JSON.stringify(m[arg])) : null;`, id);
	const gScene = await sceneRow(H, G.id);
	await raw(G, H.id, { type: 'sent', sender: K.id, message: 'probe-forged', id: K.id + '-probe', at: t });
	await raw(G, H.id, { type: 'peervars', peerId: K.id, vars: { probe: 999 }, at: t + 1e12 });
	await raw(G, H.id, { type: 'atscene', peerId: K.id, scene: 'Probe elsewhere', hash: '', at: t + 1e12 });
	await raw(G, H.id, { type: 'sent', sender: G.id, message: 'probe-own', id: G.id + '-probe', at: t });
	const line = (p, text) => inPage(p, `const m = read('messages').find((m) => m.text === arg); return m ? m.sender : null;`, text);
	h.check(await until(H, async () => (await line(H, 'probe-own')) === G.id, 15000), 'a guest can still chat as itself');
	const forgedBy = await line(H, 'probe-forged');
	h.check(forgedBy !== K.id, 'a guest cannot chat as another guest (shown as ' + forgedBy + ')');
	const kVars = await inPage(H, `return s.peerVars.peerVarsDebug().remote[arg] ?? null;`, K.id);
	h.check(kVars?.probe !== 999, 'nor set its per-player numbers (' + JSON.stringify(kVars) + ')');
	h.check((await sceneRow(H, K.id))?.scene !== 'Probe elsewhere', 'nor say which scene it is in');
	// put G back where it really stands (the probe spoke for G itself, with a far stamp)
	await raw(G, H.id, { type: 'atscene', peerId: G.id, scene: gScene?.scene ?? '', hash: gScene?.hash ?? '', at: t + 2e12 });

	// 4. The host still speaks for the session
	await raw(H, G.id, { type: 'userdata', userdata: [[K.id, 'Kay by host', '']] });
	h.check(await until(G, async () => (await nameOf(G, K.id)) === 'Kay by host', 15000), 'the host’s rows still update a guest');

	// 5. …and its word that somebody has gone still counts
	const Q = 'probe-' + Math.random().toString(36).slice(2, 10);
	await plant(G, Q);
	await raw(H, G.id, { type: 'disconnected', peerId: Q });
	h.check(await until(G, async () => !(await rowOf(G, Q)), 15000), 'the host can still remove a row the guest has no link to');

	await h.finish(browser);
});
