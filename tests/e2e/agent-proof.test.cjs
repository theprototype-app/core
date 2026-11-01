// Roadmap 55 — THE RELEASE PROOF, end to end, in one session (55-int). Everything the roadmap's
// "Release proof" lists, in order, against whatever APP_URL points at (the preview = a cloud build
// with the roles plugin; a dev server = the OSS build, where the role rows are skipped and say so):
//   1  a fresh MCP client spawns `tools/agent/src/cli.js mcp <INVITE link>` (the browser engine);
//      the host minted the link in the Request AI sheet → the agent is IN with no approval card,
//      with Edit, and Users shows the robot + AI
//   2  it builds "a campfire with 6 rocks, a flickering light and a spinning sign" — objects AND
//      flow nodes — in ONE create_objects call plus create_flow_nodes
//   3  the HOST's scene matches: the same uuids, names, transforms, and the flow graphs
//   4  screenshot → a non-empty PNG image block
//   5  a late joiner C (plain link, approved) sees all of it
//   6  the host revokes the invite → the agent's next create is refused with a clear message
//      (cloud: the invite's Edit is taken back; OSS has no roles, so the row says so)
//   7  a Person invite (View) admits a second human D with no card, as a viewer; Users says "used"
//   8  a kick sent by a non-admin (C) is ignored by every receiver
//   9  the host removes and blocks D from the peer menu: every peer drops D, D's re-dial is
//      refused with "You were removed", Allow back lets D in again
//  10  a plain link (no token) for an agent → the card; on a cloud build "View only" leaves it
//      view-only and its create is refused (the view-only trap, named)
// The token never appears in this suite's output (links are printed with `invite=…`).
// Run: APP_URL=https://preview-55.theprototype.pages.dev/ node tests/e2e/agent-proof.test.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const redact = (s) => String(s).replace(/invite=[A-Za-z0-9_-]+/g, 'invite=…');

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
const opened = (peer) => inPage(peer, 'return [...pc.openedPeers];');
const roleOf = (peer, id) => inPage(peer, 'let r; s.cloudHooks.rolesInfo.subscribe((x) => (r = x))(); return r ? r.roleOf(arg) : null;', id);
const cards = (peer) => read(peer, 'pendingApprovals').then((p) => (p || []).map((c) => c.peerId ?? c[0]));

async function until(fn, ok, timeout = 15000) {
	const t0 = Date.now();
	let v;
	while (Date.now() - t0 < timeout) {
		try {
			v = await fn();
			if (ok(v)) return v;
		} catch {}
		await new Promise((r) => setTimeout(r, 400));
	}
	return v;
}

/** the host's view of the scene: uuid -> {name, pos, rot, scale} + flow graphs (node types) */
const sceneOf = (peer, uuids) =>
	inPage(
		peer,
		`let g, f; s.objectsGroup.subscribe((x) => (g = x))(); s.flowGraphs.subscribe((x) => (f = x))();
		 const r = (v) => v.toArray().slice(0, 3).map((n) => Math.round(n * 1000) / 1000);
		 const out = {};
		 for (const u of arg) { const o = g?.getObjectByProperty('uuid', u); out[u] = o ? { name: o.name, pos: r(o.position), rot: r(o.rotation), scale: r(o.scale), flow: (f?.[u]?.nodes || []).map((n) => n.type).sort() } : null; }
		 return out;`,
		uuids
	);

async function startBridge(args) {
	const { Client } = await sdk('client/index.js');
	const { StdioClientTransport } = await sdk('client/stdio.js');
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(agentDir, 'src/cli.js'), 'mcp', ...args, '--verbose'],
		env: { ...process.env },
		stderr: 'pipe'
	});
	/** @type {string[]} */
	const log = [];
	const client = new Client({ name: 'claude-code', version: 'proof' });
	transport.stderr.on('data', (d) => log.push(...redact(d).split('\n').filter(Boolean)));
	await client.connect(transport);
	return { client, log, pid: transport.pid };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
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

/** open the Request AI sheet, pick the tab (+ role on cloud), create, return the link; closes the sheet */
async function mintInSheet(A, tab, role) {
	// connected, the bar is the compact chip: a click on it shows the full bar (where Request AI lives)
	if (!(await A.page.locator('#connect-request-ai').count()) && (await A.page.locator('.connect-pill button.cx-chip').count()))
		await A.page.locator('.connect-pill button.cx-chip').click({ timeout: 5000 });
	await A.page.locator('#connect-request-ai').click({ timeout: 10000 });
	await A.page.locator('#invite-sheet').waitFor({ timeout: 5000 });
	if ((await A.page.locator('#invite-sheet').getAttribute('data-tab')) !== tab)
		await A.page.getByRole('tab', { name: tab === 'agent' ? 'AI agent' : 'Person' }).click({ timeout: 5000 });
	await A.page.waitForFunction((t) => document.querySelector('#invite-sheet')?.getAttribute('data-tab') === t, tab, { timeout: 5000 });
	const hasRole = (await A.page.locator('#invite-role-view').count()) > 0;
	const pre = hasRole ? await A.page.locator('[id^="invite-role-"][aria-checked="true"]').first().getAttribute('data-value') : '';
	if (hasRole && role) await A.page.locator('#invite-role-' + role).click({ timeout: 3000 });
	await A.page.locator('#invite-create').click();
	const link = await A.page.locator('#invite-link').inputValue({ timeout: 5000 });
	const mcp = tab === 'agent' ? await A.page.locator('#invite-mcp').inputValue() : '';
	await A.page.locator('dialog[open] button.wc-close').first().click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
	await A.page.waitForTimeout(300);
	if (await A.page.locator('#invite-sheet').count()) await inPage(A, 's.inviteStore.inviteSheet.set(null)');
	return { link, mcp, hasRole, preselected: pre };
}

async function openPanel(peer) {
	if (!(await read(peer, 'peersPanelOpen'))) await peer.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await peer.page.locator('#peers-popover').waitFor({ timeout: 8000 });
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A-host');
	await A.page.waitForFunction(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return !!p?.peer?.open; }, null, { timeout: 60000 });
	const cloud = (await read(A, 'cloudHooks.rolesInfo')) != null;
	console.log('build: ' + (cloud ? 'CLOUD (roles plugin)' : 'OSS (no roles)') + ' at ' + BASE);

	// =========================================================== 1. the invite → in, with Edit
	console.log('\n=== 1. a fresh MCP client joins from an invite link ===');
	const inv = await mintInSheet(A, 'agent', 'edit');
	console.log('agent link: ' + redact(inv.link));
	h.check(/&agent&invite=/.test(inv.link) && inv.mcp.includes(inv.link) && inv.mcp.startsWith('claude mcp add theprototype -- npx -y @theprototype/agent mcp'), 'the sheet hands over the link and the MCP command');
	if (cloud) h.check(inv.hasRole && /edit/.test(inv.preselected), `cloud: the AI agent tab preselects Edit (${inv.preselected})`);
	const t0 = Date.now();
	const B = await startBridge([inv.link]);
	let agentId = '';
	try {
		const st = await waitJoined(B.client);
		console.log('joined after ' + Math.round((Date.now() - t0) / 1000) + ' s');
		h.check(st && st.joined === true, 'the agent is IN from the link alone');
		agentId = st?.session?.peerId;
		h.check(!(await cards(A)).includes(agentId), 'the host saw no approval card');
		h.check(st?.session?.canEdit === true, `status: canEdit (role ${st?.session?.role})`);
		if (cloud) h.check((await until(() => roleOf(A, agentId), (r) => r === 'editor', 15000)) === 'editor', 'cloud: the host lists the agent as an editor');
		h.check(!JSON.stringify(st).includes(inv.link.split('invite=')[1]), 'the token is nowhere in status');
		h.check(!B.log.join('\n').includes(inv.link.split('invite=')[1]), 'nor in the bridge log');
		const row = await until(() => read(A, 'userdata').then((r) => r.find((u) => u[0] === agentId)), (r) => r?.[6]?.kind === 'agent', 20000);
		h.check(row?.[6]?.kind === 'agent', 'the host marks the row kind: agent');
		await openPanel(A);
		h.check((await A.page.locator(`#peers-popover .peers-row[data-peer-id="${agentId}"] .peer-ai`).count()) === 1, 'Users shows the robot + AI on its row');
		h.check((await A.page.locator('#peers-invites .peers-inv-row[data-state="used"]').count()) >= 1, 'Users lists the invite as used');
		await inPage(A, 's.peersPanelOpen.set(false)');

		// =========================================================== 2. the campfire
		console.log('\n=== 2. "a campfire with 6 rocks, a flickering light and a spinning sign" ===');
		const rocks = [...Array(6)].map((_, i) => {
			const a = (i / 6) * Math.PI * 2;
			return { kind: 'primitive', primitive: 'Dodecahedron', name: 'Rock' + (i + 1), position: [+(Math.cos(a) * 1.2).toFixed(3), 0.15, +(Math.sin(a) * 1.2).toFixed(3)], scale: [0.3, 0.25, 0.3], color: '#7a7570' };
		});
		const built = json(
			await call(B.client, 'create_objects', {
				objects: [
					...rocks,
					{ kind: 'primitive', primitive: 'Cone', name: 'Flame', position: [0, 0.35, 0], scale: [0.4, 0.7, 0.4], color: '#ff8a1f' },
					{ kind: 'light', light: 'point', name: 'FireLight', position: [0, 0.9, 0] },
					{ kind: 'primitive', primitive: 'Box', name: 'Sign', position: [2.5, 1, 0], scale: [1, 0.5, 0.06], color: '#c49a5a' }
				]
			})
		);
		const created = built?.created || [];
		h.check(created.length === 9, `one create_objects call made 9 objects (${created.length}${built?.error ? ': ' + built.error : ''})`);
		// created[i] answers objects[i]: 0-5 rocks, 6 flame, 7 light, 8 sign
		const lightU = created[7]?.uuid;
		const signU = created[8]?.uuid;
		const fl = json(await call(B.client, 'create_flow_nodes', { graph: lightU, nodes: [{ type: 'pulse', data: { amount: 0.6, speed: 6 } }] }));
		h.check(!fl.error, 'a pulse node makes the light flicker: ' + JSON.stringify(fl).slice(0, 100));
		const sp = json(await call(B.client, 'create_flow_nodes', { graph: signU, nodes: [{ type: 'spin' }] }));
		h.check(!sp.error, 'a spin node turns the sign: ' + JSON.stringify(sp).slice(0, 100));
		const st2 = json(await call(B.client, 'set_physics', { updates: created.filter((c, i) => i !== 7).map((c) => ({ uuid: c.uuid, mode: 'static' })) })).error;
		h.check(!st2, 'set_physics static on the scenery (A6: physics tools offered to an agent)' + (st2 ? ': ' + st2 : ''));

		// =========================================================== 3. the host matches
		console.log('\n=== 3. the host scene matches ===');
		const uuids = created.map((c) => c.uuid);
		const snap = json(await call(B.client, 'list_scene'));
		const agentView = await until(() => sceneOf(A, uuids), (m) => Object.values(m).every((o) => o) && m[lightU]?.flow.includes('pulse') && m[signU]?.flow.includes('spin'), 30000);
		h.check(Object.values(agentView).every((o) => o), 'every uuid the agent made is in the HOST scene');
		h.check(agentView[lightU]?.flow.includes('pulse') && agentView[signU]?.flow.includes('spin'), "the light's pulse and the sign's spin are in the host's flow graphs");
		const snapObjs = (snap?.objects || snap?.scene?.objects || []).filter((o) => uuids.includes(o.uuid));
		let same = snapObjs.length === uuids.length;
		for (const o of snapObjs) {
			const hv = agentView[o.uuid];
			const ap = (o.position || o.transform?.position || []).map((n) => Math.round(n * 1000) / 1000);
			if (!hv || hv.name !== o.name || JSON.stringify(hv.pos) !== JSON.stringify(ap)) {
				same = false;
				console.log('  mismatch ' + o.name + ' agent ' + JSON.stringify(ap) + ' host ' + JSON.stringify(hv?.pos));
			}
		}
		h.check(same, `names + positions agree between the agent's list_scene and the host (${snapObjs.length} objects)`);
		const r1 = agentView[created[0]?.uuid];
		h.check(r1 && Math.abs(r1.pos[0] - 1.2) < 0.01 && Math.abs(r1.scale[1] - 0.25) < 0.01, `transforms landed as asked (Rock 1 ${JSON.stringify(r1?.pos)} scale ${JSON.stringify(r1?.scale)})`);

		// =========================================================== 4. eyes
		console.log('\n=== 4. screenshot ===');
		const shot = await call(B.client, 'screenshot', { view: 'iso' });
		const img = shot.content.find((c) => c.type === 'image');
		const bytes = img ? Buffer.from(img.data, 'base64') : Buffer.alloc(0);
		h.check(img && img.mimeType === 'image/png' && bytes.slice(1, 4).toString() === 'PNG' && bytes.length > 2000, `screenshot → a PNG (${bytes.length} bytes)`);
		const outDir = process.env.PROOF_OUT || process.env.OUT;
		if (outDir) require('fs').writeFileSync(path.join(outDir, 'agent-campfire.png'), bytes);

		// =========================================================== 5. a late joiner
		console.log('\n=== 5. a late joiner sees it all ===');
		const C = await h.setupPageQuiet(browser, 'C-late', [A]);
		await h.connect(C, A);
		const cView = await until(() => sceneOf(C, uuids), (m) => Object.values(m).every((o) => o) && m[signU]?.flow.includes('spin') && m[lightU]?.flow.includes('pulse'), 45000);
		h.check(Object.values(cView).every((o) => o), 'C has every object');
		// the sign SPINS and the light PULSES (rotation / scale move every frame on every peer), so those are left out
		const stillOf = (m) => Object.fromEntries(Object.entries(m).map(([u, o]) => [u, u === signU ? { ...o, rot: null } : u === lightU && o ? { ...o, scale: null } : o]));
		const cStill = stillOf(cView);
		const aStill = stillOf(await sceneOf(A, uuids));
		const differ = uuids.filter((u) => JSON.stringify(cStill[u]) !== JSON.stringify(aStill[u]));
		for (const u of differ) console.log('  differs ' + JSON.stringify(cStill[u]) + ' host ' + JSON.stringify(aStill[u]));
		h.check(!differ.length, "C's objects, transforms and flow graphs equal the host's");
		h.check(!!(await until(() => read(C, 'agentLog.agentLog'), (l) => (l || []).some((e) => /created 9 objects/.test(e.text)), 20000))?.length, "C's AI window lists the agent's build");

		// =========================================================== 6. revoke
		console.log('\n=== 6. the host revokes the invite ===');
		await openPanel(A);
		await A.page.locator('#peers-revoke-all-invites').click({ timeout: 5000 });
		await A.page.waitForTimeout(500);
		await inPage(A, 's.peersPanelOpen.set(false)');
		const live = await inPage(A, "return s.inviteStore.listInvites().filter((r) => r.state === 'active' || r.state === 'used').length");
		h.check(live === 0, 'no invite is usable any more');
		if (cloud) {
			h.check((await until(() => roleOf(A, agentId), (r) => r === 'viewer', 15000)) === 'viewer', "cloud: revoking took the invite's Edit back");
			const after = await until(async () => json(await call(B.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'AfterRevoke', position: [5, 0.5, 5] }] })), (r) => r?.refused === true, 20000);
			h.check(after?.refused === true && /view-only/i.test(after.error || ''), `the agent's next create is refused, clearly: "${String(after?.error).slice(0, 90)}"`);
			await A.page.waitForTimeout(1500);
			h.check(!(await inPage(A, "let g; s.objectsGroup.subscribe((x) => (g = x))(); return !!g?.getObjectByName('AfterRevoke');")), 'nothing reached the host');
		} else console.log('  OSS: no roles — a revoke stops the link; a connected agent keeps editing (remove it from the peer menu). Row 6b runs on the preview.');
		await B.client.close();
		await until(() => opened(A), (p) => !p.includes(agentId), 20000);
		h.check(!(await opened(A)).includes(agentId), 'the agent left cleanly when its client closed');

		// =========================================================== 7. a Person invite (View)
		console.log('\n=== 7. a Person invite admits D with no card, as a viewer ===');
		const pinv = await mintInSheet(A, 'person', 'view');
		console.log('person link: ' + redact(pinv.link));
		if (cloud) h.check(pinv.hasRole && /view/.test(pinv.preselected), `cloud: the Person tab preselects View (${pinv.preselected})`);
		const D = await h.setupPage(browser, 'D-person', { hash: new URL(pinv.link).hash });
		const inD = await until(() => read(D, 'connectionState.sessionHost'), (v) => v === A.id, 60000);
		h.check(inD === A.id, 'D is in by the link alone');
		h.check(!(await cards(A)).includes(D.id), 'the host saw no approval card for D');
		const dRow = (await read(A, 'userdata')).find((u) => u[0] === D.id);
		h.check(dRow && dRow?.[6]?.kind !== 'agent', 'D is a person (no agent mark)');
		if (cloud) h.check((await until(() => roleOf(A, D.id), (r) => r === 'viewer', 15000)) === 'viewer', 'cloud: D joined as a viewer');
		await openPanel(A);
		h.check((await A.page.locator('#peers-invites .peers-inv-row[data-state="used"]').count()) >= 1, 'Users shows the Person invite as used');
		await inPage(A, 's.peersPanelOpen.set(false)');
		await until(() => opened(C), (p) => p.includes(D.id), 30000);

		// =========================================================== 8. a non-admin kick
		console.log('\n=== 8. C (not the host / not an admin) sends a kick for D ===');
		await inPage(C, 'pc.broadcast({ type: "kick", peer: arg, block: true });', D.id);
		await A.page.waitForTimeout(2500);
		h.check((await opened(A)).includes(D.id), 'A ignored it');
		h.check((await opened(D)).includes(A.id), 'D ignored it');
		h.check((await read(D, 'connectionState.joinRefusal')) == null, 'D was not told it was removed');

		// =========================================================== 9. remove and block, allow back
		console.log('\n=== 9. the host removes and blocks D from the peer menu ===');
		await openPanel(A);
		await A.page.locator(`#peers-popover .peers-row[data-peer-id="${D.id}"]`).first().click({ button: 'right', timeout: 8000 });
		await A.page.locator('[data-testid="peer-menu-block"]').click({ timeout: 5000 });
		await A.page.locator('#confirm-dialog-ok').click({ timeout: 5000 });
		await until(async () => !(await opened(A)).includes(D.id) && !(await opened(C)).includes(D.id), 15000);
		h.check(!(await opened(A)).includes(D.id), 'A dropped D');
		h.check(!(await opened(C)).includes(D.id), 'C dropped D');
		h.check(!!(await until(() => read(D, 'notifications'), (n) => (n || []).some((x) => /You were removed from this session/.test(x.text)), 10000))?.length, 'D was told "You were removed from this session"');
		await inPage(D, 's.connectionState.clearJoinRefusal();');
		await D.page.waitForTimeout(1500);
		await inPage(D, 'return s.peerApproval.requestConnect(arg);', A.id);
		const ref = await until(() => read(D, 'connectionState.joinRefusal'), (r) => r?.result === 'removed', 20000);
		h.check(ref?.result === 'removed', "D's re-dial is refused with `removed`");
		h.check(!(await cards(A)).includes(D.id) && !(await opened(A)).includes(D.id), 'no card, still out');
		await openPanel(A);
		await A.page.locator(`#peers-blocked .peer-allow-back[data-peer-id="${D.id}"]`).click({ timeout: 8000 });
		await A.page.waitForTimeout(1500);
		await inPage(A, 's.peersPanelOpen.set(false)');
		await inPage(D, 's.connectionState.clearJoinRefusal();');
		await h.connect(D, A);
		h.check(!!(await until(() => opened(A), (p) => p.includes(D.id), 20000))?.includes(D.id), 'Allow back: D asked again and was let in');

		// =========================================================== 10. a plain link → the card, view-only
		console.log('\n=== 10. a plain agent link: the card, and (cloud) View only ===');
		const P = await startBridge([BASE + '/#' + A.id]);
		try {
			const card = A.page.locator('.tp-toast--req').filter({ has: A.page.locator('[data-kind="agent"]') }).first();
			const knocked = await card.waitFor({ timeout: 120000 }).then(() => true, () => false);
			h.check(knocked, 'the agent knocks: an "AI agent wants to join" card on the host (a plain link never skips it)');
			if (cloud) await card.getByRole('button', { name: /^View only$/ }).click({ timeout: 10000 });
			else await h.approveButton(card).click({ timeout: 10000 });
			const ps = await waitJoined(P.client);
			h.check(ps && ps.joined === true, 'joined after the host answered');
			if (cloud) {
				h.check(ps?.session?.canEdit === false && ps?.session?.role === 'viewer', `cloud: status says view-only (role ${ps?.session?.role})`);
				const r = json(await call(P.client, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'ViewerBox', position: [-5, 0.5, 5] }] }));
				h.check(r?.refused === true && /view-only/i.test(r.error || ''), `a viewer's create is refused, not "created": "${String(r?.error).slice(0, 80)}"`);
			} else h.check(ps?.session?.canEdit === true, 'OSS: Approve = everyone edits');
			await P.client.close();
		} finally {
			try {
				process.kill(P.pid);
			} catch {}
		}
	} catch (e) {
		console.log('--- bridge stderr ---\n' + B.log.slice(-60).join('\n'));
		throw e;
	} finally {
		try {
			process.kill(B.pid);
		} catch {}
	}
	await h.finish(browser);
});
