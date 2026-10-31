// fix-live (roadmap 55 "Fixes for 54"): three live production bugs, each on real peers.
//  §1 F-1  a VIEWER's AI tool call is refused, never `created`, and nothing reaches the host
//  §1b     a viewer's getproject / getasset / getmatpreset pass the capability floor (plans review #5)
//  §1c F-4  AI-made objects are static unless asked for physics; a dynamic one falls, a static one stays
//  §2c F-2  an action toast kept for later ({keep}) has a working Accept in Notifications
//  §1d      deleting a never-shared file does not announce it through the deleted log
//  §2 F-5  an AUTOMATIC admission gives the host a toast + a history entry with Turn off /
//          Remove, and the Connect pill shows the standing setting's badge
//  §3 F-3  a graceful leave prunes the peer at once and toasts no "Connection error"
//  §5      a plugin's Users peer-menu item (the cloud's Report…) runs with the peer id
//  §4 F-3  a peer whose renderer CRASHES (no goodbye, no SCTP close — the T5 wire agent that
//          exited) leaves Users within seconds, again with no "Connection error"
const h = require('./helpers.cjs');

const EVIDENCE = process.env.FIX_LIVE_EVIDENCE || '';

/** @param {any} page */
const childCount = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children.length ?? -1))()));
/** @param {any} page @param {string} id */
const inRoster = (page, id) =>
	page.evaluate((pid) => new Promise((r) => window.__stores.userdata.subscribe((u) => r(u.some((e) => e[0] === pid)))()), id);
/** @param {any} page @param {string} id */
const opened = (page, id) =>
	page.evaluate((pid) => new Promise((r) => window.__stores.peers.subscribe((p) => r(!!p?.openedPeers?.has(pid)))()), id);
/** every notification text on the page @param {any} page @returns {Promise<string[]>} */
const notes = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.notifications.subscribe((n) => r(n.map((x) => x.text)))()));
const NOISE = /Connection error|Peer is unreachable/;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPage(browser, 'C');
	await h.connect(B, A);
	await h.eventually(() => opened(A.page, B.id), (v) => v === true, 'B joined A');

	// ── §1 F-1: B is a viewer (what a cloud build's Approve gives) ─────────────────────────
	// a cloud build's roles plugin RE-PUBLISHES rolesInfo (B really holds Editor access there), so the
	// viewer role is asserted again inside every call's own evaluate, not once up front
	await B.page.evaluate(() => {
		const p = window.__stores.peers;
		/** @type {any} */ let me = null;
		p.subscribe((v) => (me = v))();
		/** @type {any} */ (window).__asViewer = () =>
			window.__stores.cloudHooks.rolesInfo.set({
				myId: me?.peer?.id || 'me', myRole: 'viewer', amAdmin: false,
				order: ['viewer', 'editor', 'admin'], roleOf: () => 'viewer', setRole: () => {}
			});
	});
	const before = await childCount(A.page);
	const created = await B.page.evaluate(() => {
		/** @type {any} */ (window).__asViewer();
		return window.__stores.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'viewer-box' }] });
	});
	h.check(!!created?.error && created.viewOnly === true && !('created' in created), 'F-1: a viewer create_objects is refused, not `created` (' + JSON.stringify(created).slice(0, 120) + ')');
	h.check(/view-only/.test(created?.error ?? ''), 'F-1: the refusal says view-only');
	const upd = await B.page.evaluate(() => {
		/** @type {any} */ (window).__asViewer();
		return window.__stores.aiTools.executeAiTool('update_objects', { updates: [{ uuid: 'x', color: '#f00' }] });
	});
	h.check(upd?.viewOnly === true, 'F-1: update_objects refused too');
	const list = await B.page.evaluate(() => {
		/** @type {any} */ (window).__asViewer();
		return window.__stores.aiTools.executeAiTool('list_scene', {});
	});
	h.check(!list?.error, 'F-1: list_scene still works for a viewer');
	h.check((await childCount(B.page)) === before && (await childCount(A.page)) === before, 'F-1: nothing was made, here or on the host');
	await B.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));
	const edited = await B.page.evaluate(() =>
		window.__stores.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'editor-box' }] })
	);
	h.check(Array.isArray(edited?.created), 'F-1 counterfactual: the same call as an editor creates');
	await h.eventually(() => childCount(A.page), (n) => n === before + 1, 'F-1 counterfactual: and it reaches the host');

	// ── §1c F-4: AI-made objects stay put unless asked for physics ──────────────────────
	const made = await A.page.evaluate(() =>
		window.__stores.aiTools.executeAiTool('create_objects', {
			objects: [
				{ kind: 'primitive', primitive: 'Box', name: 'ai-wall', position: [3, 2, 0] },
				{ kind: 'primitive', primitive: 'Box', name: 'ai-ball', position: [-3, 2, 0], physics: 'dynamic', mass: 3 }
			]
		})
	);
	const [wallId, ballId] = (made?.created ?? []).map((/** @type {any} */ c) => c.uuid);
	/** @param {any} page @param {string} uuid */
	const physOf = (page, uuid) =>
		page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => {
			const o = g?.getObjectByProperty('uuid', u);
			r(o ? { mode: o.userData.physics?.mode ?? null, mass: o.userData.physics?.mass ?? null, y: o.position.y } : null);
		})()), uuid);
	h.check((await physOf(A.page, wallId))?.mode === 'static', 'F-4: an AI-made box is static by default (not dynamic, mass 1)');
	h.check((await physOf(A.page, ballId))?.mode === 'dynamic' && (await physOf(A.page, ballId))?.mass === 3, 'F-4: asked for physics, it is dynamic with the asked mass');
	await h.eventually(() => physOf(B.page, wallId), (p) => p?.mode === 'static', 'F-4: the static default replicates to the other peer');
	await h.eventually(() => physOf(B.page, ballId), (p) => p?.mode === 'dynamic', 'F-4: and the dynamic one too');
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation()); // rapier warms up inside
	await h.eventually(() => physOf(A.page, ballId), (p) => p && p.y < 1.2, 'F-4: in a sim the dynamic one falls', 20000);
	h.check(Math.abs(((await physOf(A.page, wallId))?.y ?? 0) - 2) < 0.01, 'F-4: …while the static wall stays where it was built');
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await A.page.waitForTimeout(500);

	// ── §1b floor: a VIEWER's read-only requests reach the host (plans review #5) ─────────
	// A gates B as a cloud roles plugin would for a viewer (every non-floor type from B dropped)
	await A.page.evaluate((bid) => {
		const w = /** @type {any} */ (window);
		w.__asked = [];
		w.__stores.cloudHooks.setCapabilityProvider((pid, t) => { if (pid !== bid) return true; w.__asked.push(t); return false; });
		w.__stores.projectManifest.setProjectName('Floor project');
	}, B.id);
	await B.page.evaluate((aid) => {
		const w = /** @type {any} */ (window);
		w.__got = [];
		const note = (d) => { if (d?.type === 'batch' && Array.isArray(d.items)) d.items.forEach(note); else if (d?.type) w.__got.push(d.type); };
		/** @type {any} */ let p = null;
		w.__stores.peers.subscribe((v) => (p = v))();
		for (const list of Object.values(p.peer.connections || {})) for (const c of /** @type {any[]} */ (list)) c.on('data', note);
		const conn = p.connections[aid];
		conn.send({ type: 'getproject', sender: p.peer.id });
		conn.send({ type: 'getasset', hash: '0'.repeat(64) });
		conn.send({ type: 'getmatpreset', ref: 'no-such-preset' });
		conn.send({ type: 'color', uuid: 'no-such-object', color: '#ff0000' }); // a mutation: must stay dropped
	}, A.id);
	await h.eventually(() => B.page.evaluate(() => (/** @type {any} */ (window)).__got), (g) => g.includes('manifest') && g.includes('assetmissing'), 'floor: a viewer\'s getproject and getasset are answered (manifest, assetmissing)');
	const asked = await A.page.evaluate(() => (/** @type {any} */ (window)).__asked);
	h.check(!asked.includes('getproject') && !asked.includes('getasset') && !asked.includes('getmatpreset'), 'floor: getproject / getasset / getmatpreset never reach the viewer gate (' + JSON.stringify(asked) + ')');
	h.check(asked.includes('color'), 'floor counterfactual: the viewer\'s mutation is still gated');
	await A.page.evaluate(() => window.__stores.cloudHooks.setCapabilityProvider(null));

	// ── §1d private deletions: a never-shared file's deletion stays on B (plans review #6) ──
	/** @param {any} page @returns {Promise<any[]>} */
	const deletedLog = (page) => page.evaluate(() => new Promise((r) => window.__stores.projectManifest.projectManifest.subscribe((m) => r(m.deleted ?? []))()));
	const privId = await B.page.evaluate(async () => {
		const s = /** @type {any} */ (window).__stores;
		const item = await s.explorer.addItemFromBytes(new TextEncoder().encode('my secret notes').buffer, 'diary-secret.txt');
		s.sharedLibrary.deleteItemsToBin([item.id]);
		return item.id;
	});
	await h.eventually(() => deletedLog(B.page), (rows) => rows.some((r) => r.name === 'diary-secret.txt' && r.localOnly), 'private delete: B\'s own bin keeps the row (localOnly)');
	await A.page.waitForTimeout(2500);
	h.check(!(await deletedLog(A.page)).some((r) => r.name === 'diary-secret.txt' || r.id === privId), 'private delete: the host never hears the private file\'s name, folder or thumbnail');
	// a NEWER document from the host must not strand B's bin
	await A.page.evaluate(() => window.__stores.projectManifest.setProjectName('Floor project 2'));
	await h.eventually(() => B.page.evaluate(() => new Promise((r) => window.__stores.projectManifest.projectManifest.subscribe((m) => r(m.name))())), (n) => n === 'Floor project 2', 'private delete: (setup) the host\'s newer manifest reached B');
	h.check((await deletedLog(B.page)).some((r) => r.name === 'diary-secret.txt'), 'private delete: …and B still has its private row (the bin can restore it)');
	h.check(!(await deletedLog(A.page)).some((r) => r.name === 'diary-secret.txt'), 'private delete: …while the host still does not');

	// ── §2 F-5: A's session auto-admits (the cloud rooms plugin's "Allow guests") ─────────
	await A.page.evaluate((cid) => {
		const w = /** @type {any} */ (window);
		w.__turnedOff = 0;
		w.__stores.cloudHooks.setAuthProvider({
			decide: (/** @type {string} */ pid) => (pid === cid ? 'admit' : undefined),
			admitNotice: (/** @type {string} */ pid) => ({
				text: pid.toUpperCase() + ' joined as a guest (view-only) because Allow guests to join automatically is on.',
				turnOff: () => { w.__turnedOff++; w.__stores.cloudHooks.setConnectBadge(null); }
			})
		});
		w.__stores.cloudHooks.setConnectBadge({ text: 'Public · guests join', title: 'Your listed room lets guests in without approval' });
	}, C.id);
	h.check(await A.page.locator('#connect-setting-badge').isVisible(), 'F-5: the Connect pill shows the badge');
	h.check(((await A.page.locator('#connect-setting-badge').textContent()) || '').includes('Public · guests join'), 'F-5: badge text');
	// C dials; no approval card is pressed
	await C.page.locator('input[placeholder="Enter peer ID to connect"]').fill(A.id);
	await C.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await h.eventually(() => opened(A.page, C.id), (v) => v === true, 'F-5: C was admitted automatically', 30000);
	const admitText = C.id.toUpperCase() + ' joined as a guest';
	await h.eventually(() => notes(A.page), (n) => n.some((t) => t.includes(admitText)), 'F-5: a notification-history entry on the host');
	h.check(await A.page.getByText(admitText).first().isVisible(), 'F-5: and a toast on the host');
	h.check((await A.page.evaluate(() => new Promise((r) => window.__stores.pendingApprovals.subscribe((v) => r(v.length))()))) === 0, 'F-5: no approval card was needed');
	// the bell keeps the buttons
	await A.page.evaluate(() => window.__stores.toastStore.set([]));
	await A.page.locator('#notif-bell').click();
	const row = A.page.locator('.notif-row', { hasText: admitText });
	h.check(await row.getByRole('button', { name: 'Turn off' }).isVisible(), 'F-5: the history entry keeps Turn off');
	h.check(await row.getByRole('button', { name: 'Remove' }).isVisible(), 'F-5: and Remove');
	await row.getByRole('button', { name: 'Turn off' }).click();
	h.check((await A.page.evaluate(() => (/** @type {any} */ (window)).__turnedOff)) === 1, 'F-5: Turn off ran the provider switch');
	await h.eventually(() => A.page.locator('#connect-setting-badge').count(), (n) => n === 0, 'F-5: the badge goes with the setting');
	h.check((await row.getByRole('button').count()) === 0, 'F-5: an answered entry loses its buttons');
	await A.page.evaluate(() => window.__stores.notificationCenterOpen.set(false));

	// ── §2c F-2: an offer seen later keeps a working Accept in Notifications ─────────────
	await A.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__offerAccepted = 0;
		w.__stores.showToast('You have been offered the ADMIN role by AB12C. Accept?', [
			{ label: 'Accept', action: () => w.__offerAccepted++ },
			{ label: 'Decline', action: () => {} }
		], { keep: true });
		w.__stores.toastStore.set([]); // the toast expired; only the bell is left
	});
	await A.page.locator('#notif-bell').click();
	const offer = A.page.locator('.notif-row', { hasText: 'offered the ADMIN role' });
	// a DOM click (the button's own handler): an overlay toast that lands over the bell panel on a
	// loaded run (the auto-quality notice) must not make the row "not clickable"
	await offer.getByRole('button', { name: 'Accept' }).dispatchEvent('click', {}, { timeout: 5000 });
	h.check((await A.page.evaluate(() => (/** @type {any} */ (window)).__offerAccepted)) === 1, 'F-2: Accept in Notifications runs the offer\'s action');
	h.check((await offer.getByRole('button').count()) === 0, 'F-2: and the answered offer loses its buttons');
	await A.page.evaluate(() => window.__stores.notificationCenterOpen.set(false));

	// ── §3 F-3: C leaves gracefully ───────────────────────────────────────────────────────
	const noiseBefore = (await notes(A.page)).filter((t) => NOISE.test(t)).length;
	let t0 = Date.now();
	// read the instance FIRST: leaveSession updates `peers`, so calling it inside the subscribe
	// callback re-enters that callback forever (a store ping-pong that filled 700 MB of log)
	await C.page.evaluate(() => {
		/** @type {any} */ let p = null;
		window.__stores.peers.subscribe((v) => (p = v))();
		p.leaveSession();
	});
	await h.eventually(() => inRoster(A.page, C.id), (v) => v === false, 'F-3: a graceful leave leaves Users', 8000);
	const graceMs = Date.now() - t0;
	await A.page.waitForTimeout(3000);
	h.check((await notes(A.page)).filter((t) => NOISE.test(t)).length === noiseBefore, 'F-3: a graceful leave toasts no Connection error');

	// ── §2b F-5 Remove: C comes back (still admitted), the host removes them ─────────────
	// the pill goes back to idle after the leave; a narrow window squeezes it to its dot (helpers.connect's rule)
	const dial = C.page.locator('input[placeholder="Enter peer ID to connect"]');
	const pillState = () =>
		C.page.evaluate(() => document.querySelector('.connect-pill[data-state]')?.getAttribute('data-state') ?? null);
	await h.eventually(pillState, (v) => v === 'idle', 'F-5: (setup) C is idle again after the leave', 15000);
	const dot = C.page.locator('#connect-squeeze-dot');
	if (!(await dial.isVisible().catch(() => false)) && (await dot.isVisible().catch(() => false))) await dot.click();
	if (!(await dial.isVisible().catch(() => false))) {
		await C.page.screenshot({ path: (process.env.OUT || 'test-results') + '/fix-live-C-dial.png' }).catch(() => {});
		console.log('  (C dial missing: pill ' + (await pillState()) + ')');
	}
	await dial.fill(A.id);
	await C.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await h.eventually(() => opened(A.page, C.id), (v) => v === true, 'F-5: C admitted again', 30000);
	// the admission TOAST's own Remove (a DOM click: an overlay toast can sit on it; scoped, because
	// a bare "Remove" also matches hidden buttons elsewhere in the app)
	await A.page.locator('.tp-toast', { hasText: admitText }).last().getByRole('button', { name: 'Remove' }).dispatchEvent('click', {}, { timeout: 10000 });
	await h.eventually(() => inRoster(A.page, C.id), (v) => v === false, 'F-5: Remove drops C from Users', 8000);
	await h.eventually(() => opened(A.page, C.id), (v) => v === false, 'F-5: and closes the link');
	await C.page.waitForTimeout(16000); // past C's own reconnect window
	await C.page.locator('input[placeholder="Enter peer ID to connect"]').fill(A.id).catch(() => {});
	await C.page.getByRole('button', { name: 'Connect', exact: true }).click().catch(() => {});
	await A.page.waitForTimeout(8000);
	h.check((await opened(A.page, C.id)) === false && (await inRoster(A.page, C.id)) === false, 'F-5: a removed peer cannot dial back in');

	// ── §5 reports seam: a plugin's "Report…" in the Users peer menu ─────────────────────
	await A.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__reported = null;
		w.__stores.cloudHooks.setPeerMenuItems([{ id: 'report', label: 'Report…', run: (pid, info) => (w.__reported = { pid, name: info?.name ?? null }) }]);
		w.__stores.peersPanelOpen.set(true);
	});
	await A.page.locator('.peer-watch').first().dispatchEvent('contextmenu', { clientX: 400, clientY: 120, button: 2 }, { timeout: 10000 });
	// DOM events, not the mouse: a loaded remote browser stalled Playwright's right-click twice in
	// four runs. pointerdown first — the menu ignores a click it did not see pressed (guardLift)
	const item = A.page.getByRole('menuitem', { name: 'Report…' });
	await item.dispatchEvent('pointerdown', {}, { timeout: 5000 });
	await item.dispatchEvent('click');
	const reported = await A.page.evaluate(() => (/** @type {any} */ (window)).__reported);
	h.check(reported?.pid === B.id && typeof reported?.name === 'string', 'reports: the peer menu runs the plugin item with the peer id + roster name (' + JSON.stringify(reported) + ')');
	await A.page.evaluate(() => window.__stores.peersPanelOpen.set(false));

	// ── §4 F-3: B's renderer crashes — no goodbye, no channel close ──────────────────────
	h.check(await inRoster(A.page, B.id), 'F-3: B is still in Users before the crash');
	const noise2 = (await notes(A.page)).filter((t) => NOISE.test(t)).length;
	const cdp = await B.ctx.newCDPSession(B.page);
	t0 = Date.now();
	// NOT awaited: the target dies before it can answer, so the promise never settles (a 35 min hang)
	cdp.send('Page.crash').catch(() => {});
	// only the LOWER id redials (B5: two redials are glare), and only a redial can hear "not on the
	// server" — so the bound depends on which side A is (base vs fix: crash-probe in the evidence)
	// measured on a local slot: 17.7 s when A redials, 27.2 s when it waits out the window; the base
	// never pruned it (90 s probe). Silence is seen at ~9 s; the rest is the B5 reconnect window.
	const bound = A.id < B.id ? 25000 : 35000;
	await h.eventually(() => inRoster(A.page, B.id), (v) => v === false, `F-3: a crashed peer leaves Users within ${bound / 1000} s`, bound);
	const crashMs = Date.now() - t0;
	await A.page.waitForTimeout(3000);
	const tail = (await notes(A.page)).filter((t) => NOISE.test(t));
	h.check(tail.length === noise2, 'F-3: the drop toasts no Connection error (' + tail.slice(noise2).join(' | ') + ')');
	console.log(`  measured: graceful leave pruned in ${graceMs} ms, crashed peer pruned in ${crashMs} ms (A ${A.id} vs B ${B.id}: ${A.id < B.id ? 'A redials' : 'B would redial'})`);
	if (EVIDENCE) require('fs').writeFileSync(EVIDENCE, JSON.stringify({ graceMs, crashMs, aId: A.id, bId: B.id, aRedials: A.id < B.id }, null, 2));

	await h.finish(browser);
});
