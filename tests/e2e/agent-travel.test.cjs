// 55 owner finding 1 — SCENE TRAVEL with an agent in the session. A = the host (a person), B = an agent's
// page (agentApi). The owner's report: the host's Save as moved the HOST to a new room, the agent stayed in
// the old one, status() still said joined, its edits never reached the host, and Go to later merged them.
//   1  one world: the agent builds, status says withHost, both in the unnamed world
//   2  a NAMING save (unnamed → Run1) keeps everybody in one room
//   3  a SAVE AS (Run1 → Run2): status reports the host's new scene, the agent FOLLOWS, is told why, its
//      next edit reaches the host, and both hold the same objects (no merge, no strays)
//   4  the host opens a scene PRIVATELY: the agent cannot follow, says so, and an edit is REFUSED
//   5  a stranger dialing the agent directly is not let in (an agent page is nobody's host)
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
		 return { scene: lv?.name ?? null, private: !!lv?.private, rows: ps, host: sh, objects: (g?.children ?? []).map((o) => o.name).sort(), open: [...pc.openedPeers] };`
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
	h.check((await h.pageErrors(A)).length === 0 && (await h.pageErrors(B)).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)])})`);
	await h.finish(browser);
});
