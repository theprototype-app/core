// 55 (41's 3-peer test on preview-55, 09:52): the HOST LEAVES. The mobile host left; the agent went to host:null,
// joined:false, peers:[PC] — stranded beside a live person, and with nobody to answer to it would have built alone.
// A = the host (a person), C = a second person (joins A), B = an agent's page (agentApi, joins A).
//   1  three in one room; the agent meshes to C
//   2  A CLOSES ITS TAB: the agent continues with C (the successor, a person) — status().host = C, withHost, an edit reaches C
//   3  C LEAVES too: nobody is here — paused: status().hostAway, withHost false, an edit is REFUSED, nothing built
//   4  C is back and lets it in (the agent knocks; C answers the card): hostAway clears, host = C again
// Run: APP_URL=... node tests/e2e/agent-host-leaves.test.cjs
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
const status = (p) => p.page.evaluate(() => window.tpAgent.status());
const exec = (p, name, args) => p.page.evaluate(([n, a]) => window.tpAgent.exec(n, a), [name, args]);
const objects = (p) => inPage(p, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); return (g?.children ?? []).map((o) => o.name).sort();');
const open = (p) => inPage(p, 'return [...(pc?.openedPeers ?? [])];');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
	const C = await h.setupPage(browser, 'C-person');
	const B = await h.setupPage(browser, 'B-agent', { storage: { agentApi: '1' } });
	await B.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });

	console.log('\n=== 1. three in one room ===');
	await h.connect(C, A);
	await h.connect(B, A);
	const cloud = await inPage(A, 'let r; s.cloudHooks.rolesInfo.subscribe((x) => (r = x))(); if (r) { r.setRole(arg[0], "editor"); r.setRole(arg[1], "editor"); } return !!r;', [B.id, C.id]);
	console.log('build: ' + (cloud ? 'CLOUD' : 'OSS'));
	const st0 = await until(() => status(B), (st) => st.joined && st.canEdit && st.host === A.id);
	h.check(st0?.joined === true && st0.host === A.id, `the agent joined A (${JSON.stringify({ host: st0?.host, joined: st0?.joined })})`);
	const meshed = await until(() => open(B), (o) => o.includes(C.id), 40000);
	h.check(meshed.includes(C.id), `the agent is linked to C too (the mesh): ${JSON.stringify(meshed)}`);

	console.log('\n=== 2. the host CLOSES ITS TAB (no goodbye): the agent continues with C ===');
	// 41's round 5: a closed tab nulls nothing — the agent sat at joined:false while its edits still landed
	await A.page.close();
	const st1 = await until(() => status(B), (st) => st.host === C.id && st.joined === true && st.withHost !== false, 60000);
	h.check(st1?.host === C.id, `status().host is C, the person who remains (${JSON.stringify({ host: st1?.host, joined: st1?.joined, withHost: st1?.withHost, hostAway: st1?.hostAway })})`);
	h.check(st1?.joined === true && !st1?.hostAway, 'joined, and not paused (status matches: its edits reach C)');
	h.check((st1?.notices || []).some((n) => /host left — continuing with/.test(n)), 'and it was told why: ' + JSON.stringify((st1?.notices || []).slice(-2)));
	const made = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'AfterHostLeft', position: [0, 0.5, 0] }] });
	h.check(!!made?.created?.length, 'it builds: ' + JSON.stringify(made).slice(0, 120));
	const onC = await until(() => objects(C), (o) => o.includes('AfterHostLeft'));
	h.check(onC.includes('AfterHostLeft'), 'and C sees the edit');

	console.log('\n=== 3. C LEAVES too: nobody is here — the agent pauses ===');
	await inPage(C, 'pc.leaveSession();');
	const st2 = await until(() => status(B), (st) => !!st.hostAway, 30000);
	h.check(!!st2?.hostAway && st2.withHost === false && st2.hostAway.host === C.id, `status().hostAway names C and says until when (${JSON.stringify({ hostAway: st2?.hostAway, withHost: st2?.withHost, host: st2?.host })})`);
	h.check(st2?.hostAway && st2.hostAway.until - st2.hostAway.since >= 9 * 60000, 'it waits about 10 minutes');
	const refused = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Alone' }] });
	h.check(refused?.refused === true && /paused/.test(refused?.error || ''), 'an edit while paused is REFUSED: ' + String(refused?.error).slice(0, 140));
	h.check(!(await objects(B)).includes('Alone'), 'and nothing was built');
	const read = await exec(B, 'list_scene', {});
	h.check(Array.isArray(read?.objects), 'reading still works while paused');

	console.log('\n=== 4. C is back: the agent knocks, C lets it in ===');
	// the agent knocks every 30 s; C answers the ordinary card
	const knocked = await until(() => inPage(C, 'let w; s.pendingApprovals.subscribe((x) => (w = x))(); return (w ?? []).map((r) => (Array.isArray(r) ? r[0] : r?.peerId ?? r?.id));'), (ids) => (ids || []).includes(B.id), 50000);
	h.check((knocked || []).includes(B.id), `the agent knocked on C's door (pending ${JSON.stringify(knocked)})`);
	if ((knocked || []).includes(B.id)) {
		await inPage(C, 's.peerApproval.approvePeer(arg);', B.id);
		const st3 = await until(() => status(B), (st) => !st.hostAway && st.host === C.id && st.joined, 30000);
		h.check(!st3?.hostAway && st3?.host === C.id && st3?.joined === true, `back with C: hostAway cleared, joined (${JSON.stringify({ host: st3?.host, joined: st3?.joined, hostAway: st3?.hostAway })})`);
	}

	h.check((await h.pageErrors(B)).length === 0 && (await h.pageErrors(C)).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(B), ...h.pageErrors(C)])})`);
	await h.finish(browser);
});
