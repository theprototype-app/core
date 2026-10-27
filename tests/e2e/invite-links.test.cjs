// 55 A4 + A7 + A8 — INVITE LINKS FOR PEOPLE AND AI AGENTS, AGENT PRESENCE, THE AGENT LOG.
//
// An invite is a 128-bit token in the link's hash; the host keeps a key derived from it, the
// joiner's dial carries a proof bound to BOTH peer ids (never the token), and only the host
// checks it. A valid proof admits through the auto-approve path with the role the link carries;
// anything else is the ordinary approval card, saying why — never an automatic way in.
//
// What this suite pins:
//   1  the HOST against a stubbed peer: a valid agent invite admits with no card, says
//      `invited: edit` on the dial-back, marks the roster row `kind: agent` and counts the use;
//      the COUNTERFACTUALS — reused, replayed from another peer id, wrong token, expired,
//      revoked, a multi-use link past its count — each land on the card with the reason and
//      admit nobody; a Person link carries View; an agent dial that a plugin would admit as a
//      guest gets the card unless "Let AI agents join as guests"; Users lists the invites and
//      Revoke all ends them
//   2  the JOINER: a captured invite rides the dial as {v, i, p} for that host only, with
//      kind: agent, and the token is nowhere in the dial
//   3  two real peers (+ a late joiner): the host mints the link in the Request AI sheet, the
//      agent page opens it and is IN with no card; the token is gone from its URL; the host
//      shows the robot + AI and builds no avatar for it; the agent's tool call lands as a
//      line in the host's AI window, a click selects it, Undo undoes it for everyone; the
//      camera marker appears where the agent looked; a late joiner (plain link: the card,
//      as today) sees the log lines in its handshake
//
// Run: APP_URL=https://theprototype.app:5457/ PEER_CONFIG=... npm run e2e -- invite-links
const h = require('./helpers.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
const read = (peer, store) => inPage(peer, `let v; s.${store}.subscribe((x) => (v = x))(); return v;`);

const EMIT = `
	const fake = { peer: arg.peer, metadata: arg.metadata, open: false, closed: false, handlers: {},
		on(ev, fn) { this.handlers[ev] = fn; }, close() { this.closed = true; }, send() {} };
	pc.peer.emit('connection', fake);
	return { closed: fake.closed };`;

const DIAL_STUB = `
	window.__dials = [];
	Object.defineProperty(pc.peer, 'open', { value: true, configurable: true });
	pc.peer.connect = (id, opts) => {
		const conn = { peer: id, open: false, sent: [], handlers: {}, on(ev, fn) { (this.handlers[ev] ??= []).push(fn); }, close() { this.closed = true; }, send(m) { this.sent.push(m); } };
		window.__dials.push({ id, opts: JSON.parse(JSON.stringify(opts ?? null)) });
		return conn;
	};`;
const lastDial = async (peer, id) => (await inPage(peer, 'return window.__dials')).filter((d) => d.id === id).pop() ?? null;
const cards = (peer) => read(peer, 'pendingApprovals');
/** h.eventually that hands back the value it saw (and checks the label) */
async function until(fn, predicate, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last));
	h.check(false, label);
	return null;
}
const roster = (peer) => read(peer, 'userdata');

h.run(async () => {
	const core = await import(pathToFileURL(path.join(__dirname, '../../src/lib/inviteCore.js')).href);
	const browser = await h.launch();

	// ==================================================================== 1. the host
	console.log('\n=== 1. the host checks every invite dial ===');
	const H = await h.setupPage(browser, 'host');
	await H.page.waitForFunction(() => !!window.__stores?.inviteStore?.createInvite, null, { timeout: 30000 });
	await inPage(H, DIAL_STUB);
	const mint = (opts) => inPage(H, 'const r = s.inviteStore.createInvite({ hostId: pc.peer.id, ...arg }); return { id: r.record.id, link: r.link, mcp: r.mcp, sentence: r.sentence, record: r.record };', opts);
	const tokenOfLink = (link) => core.parseHashParams(new URL(link).hash).invite;
	const dial = (peer, metadata) => inPage(H, EMIT, { peer, metadata: { jr: 1, ...metadata } });

	const agent = await mint({ kind: 'agent' });
	const tok = tokenOfLink(agent.link);
	h.check(core.isToken(tok) && agent.record.role === 'edit' && agent.record.maxUses === 1, `an agent invite: Edit, single use (${agent.record.role}, ${agent.record.maxUses})`);
	h.check(new URL(agent.link).hash === '#' + H.id.toUpperCase() + '&agent&invite=' + tok, `the link is #<HOST>&agent&invite=<token> (${new URL(agent.link).hash.replace(tok, '…')})`);
	h.check(agent.mcp.startsWith("claude mcp add theprototype -- npx -y @theprototype/agent mcp '") && agent.sentence.includes(agent.link), 'the MCP command and the chat sentence carry the link');
	const stored = await inPage(H, "return localStorage.getItem('tp:invites')");
	h.check(stored.includes(agent.id) && !stored.includes(tok), 'the host stores the key, never the token');

	await dial('aaaa1', { kind: 'agent', invite: core.dialInvite(tok, 'aaaa1', H.id) });
	await H.page.waitForTimeout(150);
	const row1 = (await roster(H)).find((u) => u[0] === 'aaaa1');
	h.check(!!row1, 'a valid invite proof admits the agent');
	h.check(row1?.[6]?.kind === 'agent', `…its roster row says kind: agent (${JSON.stringify(row1?.[6])})`);
	h.check(!(await cards(H)).some((c) => c.peerId === 'aaaa1'), '…with NO approval card');
	const back = await lastDial(H, 'aaaa1');
	h.check(back?.opts?.metadata?.joinresult === 'approved' && back?.opts?.metadata?.invited === 'edit', `…dialled back as approved, invited: edit (${JSON.stringify(back?.opts?.metadata)})`);
	h.check((await inPage(H, "return s.inviteStore.joinedVia('aaaa1')")) === 'invite', 'how they joined: invite');
	const grant = await inPage(H, "return s.cloudPlugin.makeCloudApi().invites.grantFor('aaaa1')");
	h.check(grant?.role === 'edit' && grant?.record?.id === agent.id && grant?.meta?.p, 'cloudApi.invites.grantFor hands the roles plugin the proof + the record');
	const used = await inPage(H, 'return s.inviteStore.listInvites().find((r) => r.id === arg)', agent.id);
	h.check(used?.state === 'used' && used.uses.length === 1, `the use is counted (${used?.state}, ${used?.uses?.length})`);

	const refused = async (peerId, metadata, reasonRe, label) => {
		await dial(peerId, metadata);
		await H.page.waitForTimeout(120);
		const card = (await cards(H)).find((c) => c.peerId === peerId);
		const inRoster = (await roster(H)).some((u) => u[0] === peerId);
		h.check(!!card && !inRoster && reasonRe.test(card.label ?? ''), `COUNTERFACTUAL ${label} → the card, nobody admitted (${card?.label ?? 'no card'}${inRoster ? ', ADMITTED' : ''})`);
	};
	await refused('aaaa2', { kind: 'agent', invite: core.dialInvite(tok, 'aaaa2', H.id) }, /already used/, 'a reused single-use token');
	await refused('aaaa3', { kind: 'agent', invite: core.dialInvite(tok, 'aaaa1', H.id) }, /cannot confirm/, "a proof replayed from another peer id");
	await refused('aaaa4', { invite: core.dialInvite(core.newToken(), 'aaaa4', H.id) }, /cannot confirm/, 'a wrong token');
	const old = await mint({ kind: 'person', now: Date.now() - 31 * 60_000 });
	await refused('aaaa5', { invite: core.dialInvite(tokenOfLink(old.link), 'aaaa5', H.id) }, /expired/, 'an expired invite');
	const rv = await mint({ kind: 'agent' });
	await inPage(H, 's.inviteStore.revokeInvite(arg)', rv.id);
	await refused('aaaa6', { kind: 'agent', invite: core.dialInvite(tokenOfLink(rv.link), 'aaaa6', H.id) }, /revoked/, 'a revoked invite');
	const five = await mint({ kind: 'person', maxUses: 5 });
	const t5 = tokenOfLink(five.link);
	for (const id of ['bbbb1', 'bbbb2', 'bbbb3', 'bbbb4', 'bbbb5']) await dial(id, { invite: core.dialInvite(t5, id, H.id) });
	await H.page.waitForTimeout(150);
	const r5 = await roster(H);
	h.check(['bbbb1', 'bbbb2', 'bbbb3', 'bbbb4', 'bbbb5'].every((id) => r5.some((u) => u[0] === id)), 'a five-use link admits five people');
	await refused('bbbb6', { invite: core.dialInvite(t5, 'bbbb6', H.id) }, /already used/, 'a multi-use link past its count');
	h.check((await inPage(H, "return s.cloudPlugin.makeCloudApi().invites.grantFor('bbbb1')"))?.role === 'view', 'a Person link carries View, never Edit');
	// a re-dial by a peer that already used it costs nothing and still works (a reload, a drop)
	await inPage(H, "let u; s.userdata.subscribe((x) => (u = x))(); s.userdata.set(u.filter((r) => r[0] !== 'bbbb1'));");
	await dial('bbbb1', { invite: core.dialInvite(t5, 'bbbb1', H.id) });
	await H.page.waitForTimeout(120);
	h.check((await roster(H)).some((u) => u[0] === 'bbbb1'), 'the same peer re-dialling with its proof is let back in');

	console.log('\n=== 1b. agents never ride the guest auto-admit ===');
	// clear the counterfactual cards first: the toast stack shows three requests at most
	await inPage(H, "let c; s.pendingApprovals.subscribe((v) => (c = v))(); for (const a of c) s.peerApproval.denyPeer(a.peerId);");
	await inPage(H, "s.cloudHooks.setAuthProvider({ decide() { return 'admit'; } })");
	await dial('cccc1', { kind: 'agent' });
	await H.page.waitForTimeout(120);
	const agentCard = (await cards(H)).find((c) => c.peerId === 'cccc1');
	h.check(!!agentCard && agentCard.kind === 'agent' && !(await roster(H)).some((u) => u[0] === 'cccc1'), `a guest-admitting room still shows an agent the card (${JSON.stringify(agentCard)})`);
	const cardEl = H.page.locator('.tp-toast--req', { hasText: 'CCCC1' });
	await cardEl.waitFor({ timeout: 5000 }).catch(() => {});
	h.check(/AI agent wants to join/.test((await cardEl.textContent().catch(() => '')) ?? ''), 'the card says "AI agent wants to join"');
	await dial('cccc2', {});
	await H.page.waitForTimeout(120);
	h.check((await roster(H)).some((u) => u[0] === 'cccc2'), 'a person still joins as a guest there (unchanged)');
	await inPage(H, 's.inviteStore.agentsAsGuests.set(true)');
	await dial('cccc3', { kind: 'agent' });
	await H.page.waitForTimeout(120);
	h.check((await roster(H)).some((u) => u[0] === 'cccc3'), 'with "Let AI agents join as guests" on, the agent is admitted');
	await inPage(H, 's.inviteStore.agentsAsGuests.set(false); s.cloudHooks.setAuthProvider(null)');
	// approving the agent's card by hand gives it a kind:agent row too
	await inPage(H, "s.peerApproval.approvePeer('cccc1')");
	h.check((await roster(H)).find((u) => u[0] === 'cccc1')?.[6]?.kind === 'agent', 'a hand-approved agent card keeps kind: agent on its row');

	console.log('\n=== 1c. Users lists the invites; Revoke all ===');
	await H.page.click('#peers-trigger', { timeout: 10000 }).catch(() => {});
	await H.page.waitForTimeout(400);
	const invRows = await H.page.locator('#peers-invites .peers-inv-row').count();
	h.check(invRows >= 2, `Users lists the live invites (${invRows})`);
	await H.page.locator('#peers-revoke-all-invites').click({ timeout: 5000 }).catch(() => {});
	await H.page.waitForTimeout(200);
	const left = await inPage(H, "return s.inviteStore.listInvites().filter((r) => r.state === 'active' || r.state === 'used').length");
	h.check(left === 0, `Revoke all ends every invite (${left} left)`);
	await H.ctx.close();

	// ==================================================================== 2. the joiner
	console.log('\n=== 2. the joiner proves, never sends the token ===');
	const J = await h.setupPage(browser, 'joiner');
	await J.page.waitForFunction(() => !!window.__stores?.inviteStore, null, { timeout: 30000 });
	await inPage(J, DIAL_STUB);
	const jt = core.newToken();
	await inPage(J, "s.inviteStore.captureInviteHash('#XQ7ZZ&agent&invite=' + arg); return s.peerApproval.requestConnect('xq7zz');", jt);
	const jd = await lastDial(J, 'xq7zz');
	const want = core.dialInvite(jt, J.id, 'xq7zz');
	h.check(JSON.stringify(jd?.opts?.metadata?.invite) === JSON.stringify(want), `the dial carries {v, i, p} for that host (${JSON.stringify(jd?.opts?.metadata?.invite)})`);
	h.check(jd?.opts?.metadata?.kind === 'agent', 'and kind: agent');
	h.check(!JSON.stringify(jd).includes(jt), 'the token is nowhere in the dial');
	await inPage(J, "s.peerApproval.cancelOutboundRequest('xq7zz'); return s.peerApproval.requestConnect('yy111');");
	h.check(!(await lastDial(J, 'yy111'))?.opts?.metadata?.invite, 'a dial to any other peer carries no invite');
	await J.ctx.close();

	// ==================================================================== 3. real peers
	console.log('\n=== 3. two real peers: the link → in, no card ===');
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => window.__stores?.peers && (() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return !!p?.peer?.open; })(), null, { timeout: 30000 }).catch(() => {});
	await A.page.locator('#connect-request-ai').click({ timeout: 10000 });
	await A.page.locator('#invite-sheet').waitFor({ timeout: 5000 });
	h.check((await A.page.locator('#invite-sheet').getAttribute('data-tab')) === 'agent', 'Request AI opens the sheet on the AI agent tab');
	const rolesOn = await A.page.evaluate(() => { let r; window.__stores.cloudHooks.rolesInfo.subscribe((v) => (r = v))(); return !!r; });
	if (rolesOn) h.check((await A.page.locator('#invite-role-edit[aria-checked="true"]').count()) === 1, 'a cloud build offers the role, Edit preselected for an agent');
	else h.check((await A.page.locator('#invite-role-view').count()) === 0, 'no role choice in the OSS build (everyone edits)');
	await A.page.locator('#invite-create').click();
	const link = await A.page.locator('#invite-link').inputValue({ timeout: 5000 });
	h.check(/#[A-Z0-9]+&agent&invite=[A-Za-z0-9_-]{22}(~srv=[^&]*)?$/.test(link), `the sheet shows the agent link (${link.replace(/invite=.*/, 'invite=…')})`);
	h.check((await A.page.locator('#invite-mcp').inputValue()).includes(link), 'and the MCP command');
	const linkTok = tokenOfLink(link);
	await A.page.locator('dialog[open] button.wc-close').first().click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
	await A.page.waitForTimeout(300);
	if (await A.page.locator('#invite-sheet').count()) await inPage(A, 's.inviteStore.inviteSheet.set(null)');
	h.check((await A.page.locator('#invite-sheet').count()) === 0, 'the sheet closes');

	const B = await h.setupPage(browser, 'B', { hash: new URL(link).hash });
	const inB = await until(() => read(B, 'connectionState.sessionHost'), (v) => v === A.id, 'the agent page is IN — sessionHost is A', 45000);
	h.check(!!inB, 'joined by the link alone');
	h.check(!(await cards(A)).some((c) => c.peerId === B.id), 'A saw no approval card');
	const bUrl = await B.page.evaluate(() => location.href);
	h.check(!bUrl.includes(linkTok), `the token is gone from the agent's URL (${bUrl.replace(linkTok, '<TOKEN>')})`);
	h.check(await B.page.evaluate((t) => !String(history.state ?? '').includes(t), linkTok), '…and from its history state');
	const aRow = await until(() => roster(A).then((r) => r.find((u) => u[0] === B.id)), (r) => r?.[6]?.kind === 'agent', "A's roster row for B says kind: agent", 15000);
	h.check(!!aRow, 'the agent is marked on the host');
	await A.page.waitForTimeout(1500);
	const avatars = await A.page.evaluate((ids) => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		return { agent: !!scene?.getObjectByName(ids.b), marker: !!scene?.getObjectByName('agent-marker-' + ids.b) };
	}, { b: B.id });
	h.check(!avatars.agent, 'A builds NO avatar body for the agent (A7)');
	const bSeesA = await until(
		() => B.page.evaluate((a) => { let s; window.__stores.globalScene.subscribe((v) => (s = v))(); return !!s?.getObjectByName(a); }, A.id),
		(v) => v === true,
		'premise: the agent page DOES build the human host an avatar',
		15000
	);
	h.check(!!bSeesA, 'counterfactual holds: a person still gets a body');
	await A.page.click('#peers-trigger', { timeout: 10000 }).catch(() => {});
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('.peer-ai').count()) >= 1, 'Users shows the robot + AI on the agent row');
	h.check((await A.page.locator('#peers-invites .peers-inv-row[data-state="used"]').count()) === 1, 'Users lists the invite as used');
	await inPage(A, 's.peersPanelOpen.set(false)');
	await A.page.waitForTimeout(300);

	console.log('\n=== 3b. the agent builds: the host sees the line ===');
	const made = await inPage(
		B,
		"s.history.beginHistoryBatch(); const r = await s.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Rock', position: [2, 0.5, 0] }] }); s.history.endHistoryBatch('AI agent'); return r;"
	);
	const rockUuid = made?.created?.[0]?.uuid;
	h.check(!!rockUuid, `premise: the agent's tool call created an object (${JSON.stringify(made)})`);
	const line = await until(() => read(A, 'agentLog.agentLog'), (log) => log?.some((e) => /created 1 object \(Rock\)/.test(e.text)), "A's log has the agent's line", 20000);
	h.check(!!line, 'one line per tool call reaches the host');
	h.check(await until(() => A.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !!g?.getObjectByProperty('uuid', u); }, rockUuid), (v) => v, 'the Rock replicated to A', 15000), 'the edit itself came over the ordinary ops');
	await inPage(A, "s.aiAssistantHidden.set('')");
	const lineEl = A.page.locator('#agent-log .alog-line', { hasText: 'created 1 object (Rock)' });
	await lineEl.waitFor({ timeout: 5000 }).catch(() => {});
	h.check((await lineEl.count()) === 1, 'the AI assistant window shows it under Agent activity');
	await lineEl.locator('.alog-text').click();
	await A.page.waitForTimeout(300);
	const sel = await A.page.evaluate(() => { let v; window.__stores.selectedObjects.subscribe((x) => (v = x))(); return [...(v ?? [])].map((o) => o?.uuid ?? o); });
	h.check(sel.includes(rockUuid), `clicking the line selects the object (${JSON.stringify(sel)})`);
	// (selecting the Rock opens its properties, which keeps the window reflowing under a pointer
	// click — the line's own click is proven above; the press is dispatched on the button)
	await lineEl.locator('.alog-undo').dispatchEvent('click');
	const gone = await until(() => A.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !g?.getObjectByProperty('uuid', u); }, rockUuid), (v) => v, 'Undo removes the Rock on A', 15000);
	h.check(!!gone, "the line's Undo undid the call for everyone (A)");
	h.check(await B.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !g?.getObjectByProperty('uuid', u); }, rockUuid), '…and on the agent page');
	h.check(!!(await until(() => read(A, 'agentLog.agentLog'), (log) => log?.some((e) => e.undone), 'the line reads undone', 10000)), 'the line is marked undone');
	// a second call stays, for the late joiner
	await inPage(B, "s.history.beginHistoryBatch(); await s.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'Flame', position: [0, 0.5, 0] }] }); s.history.endHistoryBatch('AI agent');");
	await until(() => read(A, 'agentLog.agentLog'), (log) => log?.some((e) => /Flame/.test(e.text)), 'the second line reaches A', 15000);

	console.log('\n=== 3c. where the agent looked (A7) ===');
	h.check(await inPage(B, 'return s.agentLog.noteAgentView({ position: [1, 2, 3], quaternion: [0, 0, 0, 1] })'), 'the agent page says where it looked');
	const view = await until(() => read(A, 'agentLog.agentViews'), (m) => !!m?.[B.id], "A knows the agent's view", 10000);
	h.check(JSON.stringify(view?.[B.id]?.pos) === '[1,2,3]', 'the pose arrived');
	const marker = await until(
		() => A.page.evaluate((b) => { let s; window.__stores.globalScene.subscribe((v) => (s = v))(); const m = s?.getObjectByName('agent-marker-' + b); return m ? m.getWorldPosition(new m.position.constructor()).toArray().map((x) => Math.round(x)) : null; }, B.id),
		(p) => !!p,
		'the AI camera marker is drawn',
		10000
	);
	h.check(JSON.stringify(marker) === '[1,2,3]', `…at the agent's camera (${JSON.stringify(marker)})`);
	await inPage(A, 's.agentLog.showAgentMarkers.set(false)');
	await A.page.waitForTimeout(400);
	h.check(!(await A.page.evaluate((b) => { let s; window.__stores.globalScene.subscribe((v) => (s = v))(); return !!s?.getObjectByName('agent-marker-' + b); }, B.id)), 'the setting turns the marker off');
	await inPage(A, 's.agentLog.showAgentMarkers.set(true)');

	console.log('\n=== 3d. a late joiner (plain link: the card, as today) sees the log ===');
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	const cLog = await until(() => read(C, 'agentLog.agentLog'), (log) => log?.some((e) => /Flame/.test(e.text)) && log?.some((e) => e.undone), "the late joiner's AI window has the agent's lines (and the undone one)", 30000);
	h.check(!!cLog, 'recent lines ride the handshake');
	await C.page.waitForTimeout(1500);
	const cBody = await C.page.evaluate((b) => { let s; window.__stores.globalScene.subscribe((v) => (s = v))(); return !!s?.getObjectByName(b); }, B.id);
	h.check(!cBody, 'the late joiner draws no avatar for the agent either');

	await h.finish(browser);
});
