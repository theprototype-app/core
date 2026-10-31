// 86 B1-B5 — THE CLAUDE CONNECTOR in a person's own tab, against a FAKE RELAY: Playwright's
// routeWebSocket plays the Durable Object (cloud worker-mcp/PROTOCOL.md § 1), so no server and no
// Worker are needed and the suite runs on any slot. A is the person (hosts, "signed in": the test
// installs a connector provider the way the cloud plugin does); B is a second person in A's session.
//
//   connect → relayed create_objects → A8 "Claude (connector)" line → B sees the object → Undo (from B,
//   and from A itself) removes it everywhere → bad args / blocked tools never run → a viewer's relayed
//   edit is refused → Disconnect stops an in-flight call → tab hidden → no screenshot → axe on the new
//   UI → the button on the N6 folded / unfolded.
//
// Run: APP_URL='https://theprototype.app:5882/' npm run e2e -- connector-relay
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const RELAY = 'wss://relay.connector.test/mcp/tab/R1';

/** install a fake connector provider (the cloud plugin's half) on a page */
async function installProvider(page, grants = [{ id: 'g_1', client: 'Claude', scopes: ['session:read', 'session:edit'], lastUsed: Date.now() }]) {
	await page.evaluate(
		({ relay, grants }) => {
			window.__connectorFake = { revoked: [], pairs: [] };
			window.__stores.cloudHooks.setConnectorProvider({
				pair: async ({ resume }) => {
					window.__connectorFake.pairs.push(resume ?? null);
					return { wsUrl: relay, pairingToken: 'tpp_e2e_' + window.__connectorFake.pairs.length, expiresAt: Date.now() + 60000, replaces: false, connections: grants };
				},
				connections: async () => ({ connections: grants.filter((g) => !window.__connectorFake.revoked.includes(g.id)), tab: { linked: true } }),
				revoke: async (id) => void window.__connectorFake.revoked.push(id),
				revokeAll: async () => void window.__connectorFake.revoked.push('*'),
				account: () => ({ signedIn: true, name: 'ann' })
			});
		},
		{ relay: RELAY, grants }
	);
}

/** the fake DO: records every frame the tab sends, answers hello with ready, lets the test send calls */
async function fakeRelay(page) {
	/** @type {any} */
	const relay = { frames: [], sockets: 0, ws: null, closed: [] };
	await page.routeWebSocket(RELAY, (ws) => {
		relay.sockets++;
		relay.ws = ws;
		ws.onMessage((msg) => {
			const text = String(msg);
			let f;
			try {
				f = JSON.parse(text);
			} catch {
				f = { raw: text };
			}
			relay.frames.push({ text, f });
			if (f.type === 'hello') ws.send(JSON.stringify({ type: 'ready', connection: { id: 'L1', client: 'Claude', account: 'ann' }, connections: [{ id: 'g_1', client: 'Claude', scopes: ['session:read', 'session:edit'] }] }));
			if (text === '{"type":"ping"}') ws.send('{"type":"pong"}');
		});
		ws.onClose((code) => relay.closed.push(code));
	});
	relay.call = (id, tool, args = {}, scope = 'edit') => relay.ws.send(JSON.stringify({ type: 'call', id, tool, args, scope, connection: 'g_1', timeoutMs: 120000 }));
	relay.cancel = (id) => relay.ws.send(JSON.stringify({ type: 'cancel', id }));
	/** the tab's answer to one call (or null when none came) */
	relay.answer = async (id, timeout = 20000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < timeout) {
			const a = relay.frames.find((x) => x.f.id === id && (x.f.type === 'result' || x.f.type === 'error'));
			if (a) return a.f;
			await new Promise((r) => setTimeout(r, 150));
		}
		return null;
	};
	return relay;
}

const objectThere = (peer, uuid) =>
	peer.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return !!g?.getObjectByProperty('uuid', u);
	}, uuid);

const connectorPhase = (peer) =>
	peer.page.evaluate(() => {
		let s;
		window.__stores.connectorStore.connectorState.subscribe((v) => (s = v))();
		return s.phase;
	});

async function axe(page, include, label) {
	const res = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	for (const v of res.violations) console.log(`  [${label}] ${v.impact} ${v.id} (${v.nodes.length}) — ${v.help}`);
	h.check(gated.length === 0, `${label}: no serious/critical axe violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await A.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));

	// ---- B1: the OSS build (no provider) shows nothing, and nothing is loaded -------------------------
	await A.page.waitForSelector('#ai-assistant-window', { state: 'visible', timeout: 20000 });
	h.check((await A.page.locator('#connect-claude').count()) === 0, 'no connector provider (the OSS build): no Connect Claude anywhere');
	h.check(
		!(await A.page.evaluate(() => performance.getEntriesByType('resource').some((r) => /connector\/connector\.js|agent\/tpAgent/.test(r.name)))),
		'the connector and tpAgent are not loaded before a press'
	);

	await h.connect(B, A);
	const relay = await fakeRelay(A.page);
	await installProvider(A.page);
	const button = A.page.locator('#connect-claude-button');
	await button.waitFor({ state: 'visible', timeout: 10000 });
	h.check(true, 'a signed-in cloud build shows Connect Claude in the AI window');

	// ---- B1/B2: connect → indicator ----------------------------------------------------------------
	await button.click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'the tab is connected', 15000);
	const hello = relay.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(!!hello && hello.token === 'tpp_e2e_1' && hello.v === 1, 'hello carries the single-use pairing token in the FIRST FRAME');
	h.check(Array.isArray(hello?.tools) && hello.tools.includes('create_objects') && !hello.tools.includes('install_modules') && !hello.tools.includes('accept_offer'), `hello lists the tab's tools without the agent-page ones (${hello?.tools?.length})`);
	const chip = await A.page.locator('#connect-claude-chip').textContent().catch(() => '');
	h.check(/Claude connected · this tab/.test(chip ?? ''), `the top bar says so (${chip})`);
	h.check(await A.page.locator('#connect-claude-keep-open').isVisible(), 'the keep-this-tab-open hint shows');
	h.check((await B.page.locator('#connect-claude, #connect-claude-chip').count()) === 0, 'B (no connector) shows nothing');

	// ---- B3: a relayed create runs with A's rights, one A8 line, B sees it -------------------------------
	relay.call('c1', 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Relay_Box', position: [0, 0.5, 0] }] });
	const r1 = await relay.answer('c1');
	const uuid1 = r1?.result?.created?.[0]?.uuid;
	h.check(r1?.type === 'result' && !!uuid1, `the relayed create_objects answered with a uuid (${JSON.stringify(r1)?.slice(0, 160)})`);
	h.check(await objectThere(A, uuid1), 'the object is in A’s scene');
	await h.eventually(() => objectThere(B, uuid1), (x) => x, 'B sees the relayed object', 15000);
	h.check(await objectThere(B, uuid1), 'the second peer sees it');
	const lineA = A.page.locator('#agent-log .alog-line').filter({ hasText: 'created 1 object' }).first();
	await lineA.waitFor({ state: 'visible', timeout: 10000 });
	const who = await A.page.locator('#agent-log .alog-who').first().textContent();
	h.check(/Claude \(connector\)/.test(who ?? ''), `the A8 line is labelled "Claude (connector)" (${who?.trim()})`);
	const undoLabel = await A.page.evaluate(() => {
		let st;
		window.__stores.undoStack?.subscribe((v) => (st = v))();
		return JSON.stringify(st?.at?.(-1) ?? null).slice(0, 300);
	});
	console.log('  undo top:', undoLabel);

	// ---- B3: Undo from B (the cross-peer request) removes it everywhere ---------------------------------
	await B.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	const lineB = B.page.locator('#agent-log .alog-line').filter({ hasText: 'created 1 object' }).first();
	await lineB.waitFor({ state: 'visible', timeout: 15000 });
	await lineB.locator('.alog-undo').click();
	await h.eventually(() => objectThere(A, uuid1), (x) => !x, 'Undo from B removes it on A', 15000);
	await h.eventually(() => objectThere(B, uuid1), (x) => !x, 'and on B', 15000);
	h.check(!(await objectThere(A, uuid1)) && !(await objectThere(B, uuid1)), 'Undo of the connector’s line (pressed on B) removed it on both peers');

	// ---- B3: Undo on A itself (the line this tab holds) --------------------------------------------------
	relay.call('c2', 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'Relay_Ball' }] });
	const uuid2 = (await relay.answer('c2'))?.result?.created?.[0]?.uuid;
	await A.page.locator('#agent-log .alog-line').filter({ hasText: 'Relay Ball' }).first().waitFor({ state: 'visible', timeout: 10000 });
	await A.page.locator('#agent-log .alog-line').filter({ hasText: 'Relay Ball' }).first().locator('.alog-undo').click();
	await h.eventually(() => objectThere(B, uuid2), (x) => !x, 'Undo on A removes it on B', 15000);
	h.check(!!uuid2 && !(await objectThere(A, uuid2)) && !(await objectThere(B, uuid2)), 'Undo pressed in the tab that holds the line works too');

	// ---- B5: schema validation + the allow-list ----------------------------------------------------------
	const countBefore = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	relay.call('bad1', 'create_objects', { objects: [{ kind: 'primitive', position: 'here' }] });
	relay.call('bad2', 'install_modules', {});
	relay.call('bad3', 'accept_offer', { id: 'o1' });
	relay.call('bad4', 'Create Objects', { objects: [] });
	const bads = await Promise.all(['bad1', 'bad2', 'bad3', 'bad4'].map((id) => relay.answer(id)));
	h.check(bads[0]?.error?.code === 'invalid_args' && /position/.test(bads[0].error.message), `invalid args are refused before they run (${bads[0]?.error?.message?.slice(0, 120)})`);
	h.check(bads.slice(1).every((b) => b?.error?.code === 'unknown_tool'), `agent-page tools and alias names are refused (${bads.slice(1).map((b) => b?.error?.code)})`);
	relay.call('ro', 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box' }] }, 'read');
	h.check((await relay.answer('ro'))?.error?.code === 'refused', 'a read-scoped grant cannot edit');
	const countAfter = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	h.check(countAfter === countBefore, `nothing ran (objects ${countBefore} → ${countAfter})`);

	// ---- B3: a viewer's connector cannot edit ----------------------------------------------------------
	await A.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set({ myId: 'x', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {}, synced: () => true }));
	relay.call('v1', 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Viewer_Box' }] });
	const v1 = await relay.answer('v1');
	h.check(v1?.error?.code === 'refused' && /View-only/i.test(v1.error.message), `a viewer's relayed edit is refused (${v1?.error?.message?.slice(0, 80)})`);
	relay.call('v2', 'list_scene', {});
	h.check((await relay.answer('v2'))?.type === 'result', 'a viewer may still read');
	await A.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	// ---- B4: no screenshot while hidden; one when visible ------------------------------------------------
	await A.page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await h.eventually(() => Promise.resolve(relay.frames.some((x) => x.f.type === 'state' && x.f.visible === false)), (x) => x, 'the DO hears the tab is hidden', 5000);
	h.check(relay.frames.some((x) => x.f.type === 'state' && x.f.visible === false), 'the DO is told the tab is hidden');
	relay.call('s1', 'screenshot', { view: 'iso' }, 'read');
	const s1 = await relay.answer('s1');
	h.check(s1?.error?.code === 'hidden', `hidden tab: no screenshot (${s1?.error?.code})`);
	await A.page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	relay.call('s2', 'screenshot', { view: 'iso', size: 4000 }, 'read');
	const s2 = await relay.answer('s2', 30000);
	h.check(
		s2?.type === 'result' && s2.result?.image?.mimeType === 'image/jpeg' && s2.result.width <= 1024 && s2.result.image.data.length > 1000,
		`visible tab: a downscaled JPEG from the tab's canvas (${s2?.result?.width}×${s2?.result?.height}, ${s2?.result?.image?.data?.length} b64 chars)`
	);

	// ---- B5: Disconnect stops an in-flight call -------------------------------------------------------
	relay.call('w1', 'wait_for_edit', { timeout_ms: 60000 });
	await A.page.waitForTimeout(500);
	await A.page.locator('#connect-claude-disconnect').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'idle', 'Disconnect → idle', 10000);
	const bye = relay.frames.some((x) => x.f.type === 'bye');
	h.check(bye, 'Disconnect says bye to the DO');
	h.check((await relay.answer('w1', 3000)) === null, 'the in-flight wait_for_edit never answers after Disconnect');
	h.check((await A.page.locator('#connect-claude-chip').count()) === 0, 'the indicator is gone');

	// ---- B2: a blip reconnects with resume; a revoke is final -------------------------------------------
	await button.click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected again', 15000);
	const socketsBefore = relay.sockets;
	await relay.ws.close({ code: 1011, reason: 'blip' });
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected' && relay.sockets > socketsBefore, 'reconnected after a blip', 20000);
	const pairs = await A.page.evaluate(() => window.__connectorFake.pairs);
	h.check(relay.sockets > socketsBefore && pairs.at(-1) === 'L1', `a blip re-pairs with resume = the tab link (${JSON.stringify(pairs)})`);
	await relay.ws.close({ code: 4001, reason: 'revoked' });
	await h.eventually(() => connectorPhase(A), (p) => p === 'closed', 'revoked → closed', 10000);
	await A.page.waitForTimeout(3000);
	h.check((await connectorPhase(A)) === 'closed' && (await A.page.evaluate(() => window.__connectorFake.pairs.length)) === pairs.length, 'a revoke (4001) is final: no reconnect');
	h.check(/revoked/i.test((await A.page.locator('#connect-claude .cc-text').textContent()) ?? ''), 'the AI window says it was revoked');

	// ---- B5: Settings ▸ Connected apps lists the grants, Revoke calls the provider ---------------------
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('connectedapps');
		window.__stores.settingsOpen.set(true);
	});
	const appRow = A.page.locator('#connected-apps-settings [data-app="g_1"]');
	await appRow.waitFor({ state: 'visible', timeout: 10000 });
	h.check(true, 'Settings ▸ Connected apps lists the connected app');
	await axe(A.page, '#connected-apps-settings', 'Connected apps');
	await appRow.getByRole('button', { name: 'Revoke Claude' }).click();
	await A.page.getByRole('button', { name: 'Revoke', exact: true }).last().click();
	await h.eventually(() => A.page.evaluate(() => window.__connectorFake.revoked), (r) => r.includes('g_1'), 'Revoke reaches the provider', 5000);
	h.check((await A.page.evaluate(() => window.__connectorFake.revoked)).includes('g_1'), 'Revoke went to the connector service (the provider)');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await axe(A.page, '#connect-claude', 'Connect Claude row');
	h.check(h.pageErrors(A).length === 0, `no page errors on A (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.closePeer(B);

	// ---- the button on the OPPO Find N6, folded and unfolded --------------------------------------------
	for (const [name, viewport, theme] of [
		['folded', { width: 390, height: 896 }, 'dark'],
		['unfolded', { width: 770, height: 850 }, 'dark'],
		['unfolded-light', { width: 770, height: 850 }, 'light']
	]) {
		const P = await h.setupPage(browser, name, { context: { viewport, deviceScaleFactor: 2.9, isMobile: true, hasTouch: true }, storage: { theme } });
		await installProvider(P.page);
		// the auto-quality toast lands over the top of a fresh page (it is not this feature's)
		await P.page.evaluate(() => {
			window.__stores.toastsInDrawerOnly.set(true);
			window.__stores.aiAssistantHidden.set('');
		});
		const b = P.page.locator('#connect-claude-button');
		await b.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
		const box = await b.boundingBox();
		// pressable = the button itself is what a tap at its centre reaches (nothing parked over it)
		const hit = box
			? await P.page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#connect-claude-button'), [box.x + box.width / 2, box.y + box.height / 2])
			: false;
		h.check(!!box && box.x >= 0 && box.x + box.width <= viewport.width && box.height >= 32 && hit, `N6 ${name}: Connect Claude is on screen and pressable (${JSON.stringify(box)}, hit ${hit})`);
		await P.page.screenshot({ path: require('path').join(process.env.E2E_OUT || 'test-results/86-b', `n6-${name}.png`) }).catch(() => {});
		await h.closePeer(P);
	}

	await h.finish(browser);
});
