// 86-fix N2 — join_session THROUGH THE CONNECTOR, against the fake relay (connectorFake.cjs). Claude asks; the
// person decides on a Join / Cancel card in their own tab; never silent.
//
//   B (the person, connector connected) is asked to join A's session:
//   a link to another site / a look-only grant → refused, no card · Cancel → nothing dialled · another
//   question already open → busy, the person's dialog stays · Join → B dials A, A approves, B is in.
//   The card names who asks (the fixed "Claude (connector)") and the session; axe on it.
//
// Run: APP_URL='https://theprototype.app:5890/' npm run e2e -- connector-join
const path = require('path');
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

const OUT = process.env.E2E_OUT || 'test-results/86-fix';
const CARD = '#confirm-connector-join';

const sessionHostOf = (peer) => peer.page.evaluate(() => new Promise((r) => window.__stores.connectionState.sessionHost.subscribe((v) => r(v))()));
const waitingOf = (peer) => peer.page.evaluate(() => new Promise((r) => window.__stores.waitingForApproval.subscribe((v) => r(JSON.parse(JSON.stringify(v ?? []))))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await B.page.evaluate(() => {
		window.__stores.toastsInDrawerOnly.set(true);
		window.__stores.aiAssistantHidden.set('');
	});
	const relay = await fakeRelay(B.page);
	await installProvider(B.page);
	await B.page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(B), (p) => p === 'connected', 'B connected to Claude', 15000);
	const hello = relay.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(hello?.tools?.includes('join_session') && !hello.tools.includes('connect'), `the tab answers join_session, not the CLI connect (${hello?.tools?.length} tools)`);
	// A's id as the page holds it once its signaling link is open
	await A.page.waitForFunction(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return !!p?.peer?.open; }, undefined, { timeout: 30000 });
	const aId = await A.page.evaluate(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return p.peer.id; });
	const origin = new URL(B.page.url()).origin;
	const link = origin + '/#' + aId.toUpperCase();

	// ---- refused before any card ------------------------------------------------------------------------
	relay.call('x1', 'join_session', { link: 'https://evil.example/#' + aId });
	relay.call('x2', 'join_session', { link }, 'read');
	relay.call('x3', 'join_session', {});
	const [x1, x2, x3] = await Promise.all(['x1', 'x2', 'x3'].map((id) => relay.answer(id)));
	h.check(x1?.error?.code === 'invalid_args' && /not a theprototype session link/.test(x1.error.message), `a link to another site is refused (${x1?.error?.message})`);
	h.check(x2?.error?.code === 'refused', 'a look-only grant cannot ask to join');
	h.check(x3?.error?.code === 'invalid_args', 'no link → invalid args');
	h.check((await B.page.locator(CARD).count()) === 0, 'no card was shown for any of them');

	// ---- another question already open → busy, and the person's dialog stays -----------------------------
	await B.page.evaluate(() => window.__stores.confirmDialog?.confirmDialog?.set?.({ title: 'Mine', message: 'the person’s own question', resolve() {} }) ?? null);
	const mineUp = await B.page.evaluate(() => { let d; window.__stores.confirmDialog?.confirmDialog?.subscribe((v) => (d = v))(); return d?.title ?? null; });
	if (mineUp === 'Mine') {
		relay.call('b1', 'join_session', { link });
		const b1 = await relay.answer('b1');
		const still = await B.page.evaluate(() => { let d; window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))(); return d?.title ?? null; });
		h.check(b1?.error?.code === 'busy' && still === 'Mine', `another open question → busy; the person's dialog stays (${b1?.error?.code}, ${still})`);
		await B.page.evaluate(() => window.__stores.confirmDialog.confirmDialog.set(null));
	} else console.log('  (confirmDialog not on the debug hooks: busy case covered by the unit tests)');

	// ---- Cancel → nothing dialled -------------------------------------------------------------------------
	relay.call('c1', 'join_session', { link });
	const card = B.page.locator(CARD);
	await card.waitFor({ state: 'visible', timeout: 10000 });
	const text = (await card.textContent()) ?? '';
	h.check(/Claude \(connector\)/.test(text) && text.includes(aId.toUpperCase()), `the card names who asks and the session (${text.trim().slice(0, 160)})`);
	const res = await new AxeBuilder({ page: B.page }).include(CARD).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	h.check(gated.length === 0, `the card: no serious/critical axe violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
	await B.page.screenshot({ path: path.join(OUT, 'n2-join-card.png') }).catch(() => {});
	await B.page.locator('#confirm-dialog-cancel').click();
	const c1 = await relay.answer('c1');
	h.check(c1?.error?.code === 'refused' && /did not join/.test(c1.error.message), `Cancel → refused (${c1?.error?.message?.slice(0, 80)})`);
	await B.page.waitForTimeout(1500);
	h.check((await waitingOf(B)).length === 0 && !(await sessionHostOf(B)), 'Cancel dialled nothing');

	// ---- Join → B dials A; A approves; B is in A's session --------------------------------------------------
	relay.call('j1', 'join_session', { link });
	await card.waitFor({ state: 'visible', timeout: 10000 });
	await B.page.locator('#confirm-dialog-join').click();
	const j1 = await relay.answer('j1', 30000);
	h.check(j1?.type === 'result' && j1.result?.joining === true, `Join → the tab dials (${JSON.stringify(j1).slice(0, 200)})`);
	await h.approveButton(A.page).click({ timeout: 30000 });
	await h.eventually(() => sessionHostOf(B), (host) => String(host || '').toLowerCase() === aId.toLowerCase(), 'B joined A', 30000);
	h.check(String((await sessionHostOf(B)) || '').toLowerCase() === aId.toLowerCase(), 'B is in A’s session after A approved');
	relay.call('st', 'status', {}, 'read');
	const st = (await relay.answer('st'))?.result;
	h.check(!!st, `status answers after the join (${JSON.stringify(st ?? null).slice(0, 160)})`);

	h.check(h.pageErrors(B).length === 0, `no page errors on B (${h.pageErrors(B).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
