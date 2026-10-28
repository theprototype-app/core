// 55 owner finding 1 — SCENE TRAVEL with an agent in the session. A = the host (a person), B = an agent's
// page (agentApi). The owner's report: the host's Save as moved the HOST to a new room, the agent stayed in
// the old one, status() still said joined, its edits never reached the host, and Go to later merged them.
//   1  one world: the agent builds, status says withHost, both in the unnamed world
//   2  a NAMING save (unnamed → Run1) keeps everybody in one room
//   3  a SAVE AS (Run1 → Run2): status reports the host's new scene, the agent FOLLOWS, is told why, its
//      next edit reaches the host, and both hold the same objects (no merge, no strays)
//   4  the host opens a scene PRIVATELY: the agent cannot follow, says so, and an edit is REFUSED
//   5  a stranger dialing the agent directly is not let in (an agent page is nobody's host)
//   6  41's P0 (preview 08:19): host + agent in a built scene (objects + flows), the host opens a NEW EMPTY scene, the
//      agent follows — the host's new scene must stay EMPTY (no objects, no flow nodes): an agent page never offers
//      its world, it only takes the host's. Then the host opens the EXISTING built scene again: both hold exactly it.
// Run: APP_URL=... node tests/e2e/agent-travel.test.cjs
const h = require('./helpers.cjs');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
const where = (p) =>
	inPage(
		p,
		`let lv, ps, g, sh; s.levels.currentLevel.subscribe((x) => (lv = x))(); s.peerScenes.peerScenes.subscribe((x) => (ps = x))();
		 s.objectsGroup.subscribe((x) => (g = x))(); s.connectionState.sessionHost.subscribe((x) => (sh = x))();
		 let fg; s.flowGraphs.subscribe((x) => (fg = x))();
		 const flowNodes = Object.values(fg ?? {}).reduce((n, d) => n + (d?.nodes?.length ?? 0), 0);
		 return { scene: lv?.name ?? null, private: !!lv?.private, rows: ps, host: sh, objects: (g?.children ?? []).map((o) => o.name).sort(), flowNodes, open: [...pc.openedPeers] };`
	);
const status = (p) => p.page.evaluate(() => window.tpAgent.status());
const exec = (p, name, args) => p.page.evaluate(([n, a]) => window.tpAgent.exec(n, a), [name, args]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 41's retest note: the agent page logs "received new approved host : <its own id>" — that line is the ROSTER
// applier (entry [0] of every roster is SELF), not a host change. Pin the facts it seemed to contradict: the
// agent's session host is A, A hosts (null), and on a cloud build the agent is no admin and never the authority.
const roles = (p, arg) =>
	inPage(p, 'let r; s.cloudHooks.rolesInfo.subscribe((x) => (r = x))(); return r ? { myRole: r.myRole, amAdmin: !!r.amAdmin, first: (r.order || [])[0] ?? null, agentRole: r.roleOf?.(arg) ?? null } : null;', arg);
async function hostTruth(A, B, when) {
	const [aw, bw] = [await where(A), await where(B)];
	h.check(bw.host === A.id && aw.host === null, `${when}: the agent's session host is A and A hosts (agent → ${bw.host}, A → ${aw.host})`);
	const [ar, br] = [await roles(A, B.id), await roles(B, B.id)];
	if (ar && br) h.check(br.amAdmin === false && ar.first !== B.id && br.first !== B.id && ar.agentRole !== 'admin', `${when}: the agent is no admin and never first in the authority order (A ${JSON.stringify(ar)} agent ${JSON.stringify(br)})`);
}

async function until(fn, ok, timeout = 20000) {
	const t0 = Date.now();
	let v;
	while (Date.now() - t0 < timeout) {
		try {
			v = await fn();
			if (ok(v)) return v;
		} catch {}
		await wait(400);
	}
	return v;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A-host');
	const B = await h.setupPage(browser, 'B-agent', { storage: { agentApi: '1' } });
	await B.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(B, A);
	const cloud = await inPage(A, 'let r; s.cloudHooks.rolesInfo.subscribe((x) => (r = x))(); if (r) r.setRole(arg, "editor"); return !!r;', B.id);
	console.log('build: ' + (cloud ? 'CLOUD' : 'OSS'));
	await until(() => status(B), (st) => st.joined && st.canEdit);
	await hostTruth(A, B, 'after the join');

	console.log('\n=== 1. one world: the agent builds, the host sees it ===');
	const made = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Before', position: [0, 0.5, 0] }] });
	h.check(!!made?.created?.length, 'the agent builds');
	await until(() => where(A), (w) => w.objects.includes('Before'));
	const st0 = await status(B);
	h.check(st0.withHost === true && st0.scene === '' && st0.hostScene === '', `status says it is with the host, both in the unnamed world (${JSON.stringify({ scene: st0.scene, hostScene: st0.hostScene, withHost: st0.withHost })})`);

	console.log('\n=== 2. the host NAMES the world (unnamed → Run1): everybody is still in one room ===');
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Run1'));
	const st1 = await until(() => status(B), (st) => st.hostScene === 'Run1', 15000);
	h.check(st1?.hostScene === 'Run1' && st1?.withHost === true, `after a naming save the agent is still with the host (${JSON.stringify({ scene: st1?.scene, hostScene: st1?.hostScene, withHost: st1?.withHost })})`);

	console.log('\n=== 3. the host SAVES AS another scene (Run1 → Run2): the agent follows ===');
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Run2'));
	const gap = await until(() => status(B), (st) => st.hostScene === 'Run2', 15000);
	h.check(gap?.hostScene === 'Run2', `status() reports the host's new scene (${gap?.hostScene})`);
	await hostTruth(A, B, 'right after the Save as');
	const followed = await until(() => status(B), (st) => st.withHost === true && st.scene === 'Run2', 45000);
	h.check(followed?.scene === 'Run2' && followed?.withHost === true, `THE AGENT FOLLOWED the host into Run2 (${JSON.stringify({ scene: followed?.scene, withHost: followed?.withHost, following: followed?.following })})`);
	if (followed?.withHost !== true) {
		const [da, db] = [await where(A), await where(B)];
		console.log('  DIAG notices ' + JSON.stringify(followed?.notices) + '\n  DIAG rows A ' + JSON.stringify(da.rows) + ' B ' + JSON.stringify(db.rows) + '\n  DIAG A level ' + JSON.stringify(await inPage(A, 'let lv; s.levels.currentLevel.subscribe((x) => (lv = x))(); return lv;')) + ' B level ' + JSON.stringify(await inPage(B, 'let lv; s.levels.currentLevel.subscribe((x) => (lv = x))(); return lv?.name + " " + lv?.hash;')));
		const tx = 'let t; s.transferLedger.transfers.subscribe((x) => (t = x))(); let u; s.assetShare.unavailableHashes?.subscribe((x) => (u = x))(); return {tx: (t ?? []).map((r) => [r.dir, String(r.hash).slice(0, 8), r.state ?? r.status, r.error ?? ""]), un: [...(u ?? [])].map((h) => h.slice(0, 8)), has: !!s.explorer.itemByHash?.(arg) };';
		const hash = da.rows ? Object.values(db.rows)[0]?.hash : '';
		console.log('  DIAG transfers A ' + JSON.stringify(await inPage(A, tx, hash).catch((e) => String(e))) + ' B ' + JSON.stringify(await inPage(B, tx, hash).catch((e) => String(e))));
	}
	h.check((followed?.notices || []).some((n) => /following them/.test(n)), 'and was told why it moved: ' + JSON.stringify((followed?.notices || []).slice(-3)));
	const after = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'AfterSave', position: [2, 0.5, 0] }] });
	h.check(!!after?.created?.length, 'it builds again once there: ' + JSON.stringify(after).slice(0, 120));
	const aw = await until(() => where(A), (w) => w.objects.includes('AfterSave'));
	h.check(aw.objects.includes('AfterSave'), 'and the HOST sees that edit (it reached the room the host is in)');
	const bw = await where(B);
	h.check(JSON.stringify(aw.objects) === JSON.stringify(bw.objects), `no merge, no strays: host and agent hold the same objects (A ${JSON.stringify(aw.objects)} B ${JSON.stringify(bw.objects)})`);

	await hostTruth(A, B, 'after following into Run2');

	console.log('\n=== 4. a PRIVATE host cannot be followed: the agent says so and refuses edits ===');
	// the host re-opens Run1 PRIVATELY (R22 round 35): its row says private, nobody may follow
	await A.page.evaluate(() => {
		const hash = window.__stores.projectManifest.latestSceneHash('Run1');
		return window.__stores.levels.travelToLevel(hash, 'Run1', { private: true });
	}).catch((e) => console.log('private open threw: ' + e.message));
	const priv = await until(() => status(B), (st) => st.withHost === false, 15000);
	if (priv?.withHost === false) {
		const refused = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Stray' }] });
		h.check(refused?.refused === true && refused?.withHost === false && /host is now in/.test(refused?.error || ''), 'an edit while apart is REFUSED with the reason: ' + String(refused?.error).slice(0, 140));
		await wait(2000);
		h.check(!(await where(A)).objects.includes('Stray') && !(await where(B)).objects.includes('Stray'), 'and nothing was built anywhere');
	} else h.check(false, 'a private host reads as apart (' + JSON.stringify(priv && { scene: priv.scene, hostScene: priv.hostScene, withHost: priv.withHost }) + ')');

	console.log('\n=== 5. an agent page never admits a stranger (it is nobody\'s host) ===');
	const C = await h.setupPage(browser, 'C-stranger');
	await C.page.evaluate((id) => { let p; window.__stores.peers.subscribe((v) => (p = v))(); p.connectToPeer(id, true); }, B.id).catch((e) => console.log('dial threw: ' + e.message));
	await wait(6000);
	h.check(!(await where(B)).open.includes(C.id), 'a peer that dials the agent directly is not let in by it');

	console.log('\n=== 6. the host opens a NEW EMPTY scene: the agent follows and brings NOTHING with it ===');
	// back to a shared built room: Run2 (A + B both hold AfterSave there); add objects and a flow so there is a world to leak
	await A.page.evaluate(() => window.__stores.levels.travelToLevel(window.__stores.projectManifest.latestSceneHash('Run2'), 'Run2'));
	const back = await until(() => status(B), (st) => st.withHost === true && st.hostScene === 'Run2' && st.scene === 'Run2', 30000);
	h.check(back?.withHost === true, `host and agent together in Run2 again (${JSON.stringify(back && { scene: back.scene, hostScene: back.hostScene, withHost: back.withHost })})`);
	const built = await exec(B, 'create_objects', { objects: [1, 2, 3, 4, 5, 6].map((i) => ({ kind: 'primitive', primitive: 'Box', name: 'Gem' + i, position: [i, 0.5, -2] })) });
	const uuid = built?.created?.[0]?.uuid;
	const flow = uuid ? await exec(B, 'create_flow_nodes', { graph: uuid, nodes: [{ type: 'spin' }] }) : null;
	h.check(built?.created?.length === 6 && !!flow && !flow.error, 'the agent built 6 gems + a spin flow in Run2: ' + JSON.stringify(flow).slice(0, 100));
	await until(() => where(A), (w) => w.objects.filter((n) => /^Gem\d$/.test(n)).length === 6 && w.flowNodes > 0);
	await wait(1500); // every node the spin brought along has landed
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Run2'));
	const full = await where(A);
	console.log(`  host in Run2: ${full.objects.length} objects, ${full.flowNodes} flow nodes`);
	// the owner's steps: Explorer ▸ New scene "Gem test" (empty), then open it
	await A.page.evaluate(async () => {
		const item = await window.__stores.levels.newLevel('Gem test');
		return window.__stores.levels.travelToLevel(item.hash, '', { freshGame: true });
	});
	const fresh = await where(A);
	h.check(fresh.scene === 'Gem test' && fresh.objects.length === 0 && fresh.flowNodes === 0, `the host stands in the empty "Gem test" (${fresh.objects.length} objects, ${fresh.flowNodes} flow nodes)`);
	const gem = await until(() => status(B), (st) => st.withHost === true && st.scene === 'Gem test', 45000);
	h.check(gem?.scene === 'Gem test' && gem?.withHost === true, `the agent followed into "Gem test" (${JSON.stringify(gem && { scene: gem.scene, withHost: gem.withHost, following: gem.following })})`);
	await wait(5000); // the arrival re-sync and every late reply have landed
	const [ga, gb] = [await where(A), await where(B)];
	h.check(ga.objects.length === 0 && ga.flowNodes === 0, `THE HOST'S NEW SCENE IS STILL EMPTY: no merge (${ga.objects.length} objects ${JSON.stringify(ga.objects.slice(0, 8))}, ${ga.flowNodes} flow nodes)`);
	h.check(gb.objects.length === 0 && gb.flowNodes === 0, `and the agent holds the host's empty scene, not its old world (${gb.objects.length} objects, ${gb.flowNodes} flow nodes)`);
	const gemEdit = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'InGem', position: [0, 0.5, 0] }] });
	const gaw = await until(() => where(A), (w) => w.objects.includes('InGem'));
	h.check(!!gemEdit?.created?.length && JSON.stringify(gaw.objects) === '["InGem"]', `an edit there reaches the host and is all it holds (${JSON.stringify(gaw.objects)})`);

	console.log('\n=== 7. the host opens an EXISTING other scene (Run2): both hold exactly that scene ===');
	await A.page.evaluate(() => window.__stores.levels.travelToLevel(window.__stores.projectManifest.latestSceneHash('Run2'), 'Run2'));
	const r2 = await until(() => status(B), (st) => st.withHost === true && st.scene === 'Run2', 45000);
	h.check(r2?.scene === 'Run2' && r2?.withHost === true, 'the agent followed into Run2');
	await wait(5000);
	const [ra, rb] = [await where(A), await where(B)];
	h.check(JSON.stringify(ra.objects) === JSON.stringify(full.objects) && ra.flowNodes === full.flowNodes, `the host's Run2 is exactly what it saved: no InGem, nothing extra (${JSON.stringify(ra.objects)} ${ra.flowNodes} flow nodes)`);
	h.check(JSON.stringify(rb.objects) === JSON.stringify(ra.objects), `and the agent holds the same (${JSON.stringify(rb.objects)})`);

	h.check((await h.pageErrors(A)).length === 0 && (await h.pageErrors(B)).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)])})`);
	await h.finish(browser);
});
