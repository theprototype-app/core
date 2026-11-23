// 89 I2 + ADD — Settings ▸ AI (it was "Tools & connections") and the tab's words for an AI app that is not Claude.
// FAKE connector provider + FAKE relay (connectorFake.cjs), so no server and no Worker are needed.
//
//   1. OSS build (no provider): the page is "AI" with two cards — "AI inside the app (your key)" (chat / mesh rows) and
//      "AI apps that work in your scene" (Coding agents) — and Other tools (Desktop tools) under them; no Connected apps
//   2. a provider with three grants: Claude (app 'Claude'), ChatGPT (app 'ChatGPT'), a loopback CLI (app '', client
//      "Claude Code"): Connected apps sits in card 2, each row named by the TRUSTED app, the CLI's marked as its own name
//   3. every old way in lands on the right card: 'connectedapps', 'tools', 'toolsconnections', cloudApi.openSettings(
//      'account', 'connected-apps-settings'), Account's link row; Account keeps the link, not the list
//   4. search: "chatgpt" → the ChatGPT row; "gemini" → Chat providers; "blender" → Other tools only (the AI cards hide,
//      headings and all); "connected apps" → the list and Account's link
//   5. the command palette's "AI apps that work in your scene" lands on card 2
//   6. the tab's words: a Worker that names ChatGPT → the chip reads "ChatGPT connected · this tab" and a relayed edit's
//      line is "ChatGPT (connector)"; ZERO CHANGE: a ready frame without `app` (a Worker before 89) reads "Claude …"
//   7. axe on the page; shots dark + light at 1280, and the N6 folded page
// Run: APP_URL=https://theprototype.app:5896/ npm run e2e -- settings-ai
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { default: AxeBuilder } = require('@axe-core/playwright');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

const OUT = path.join(__dirname, '..', '..', 'test-results', 'settings-ai', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const NOW = Date.now();
const GRANTS = [
	{ id: 'g_1', client: 'Claude', app: 'Claude', redirectHost: 'claude.ai', scopes: ['session:read', 'session:edit'], lastUsed: NOW - 60000 },
	{ id: 'g_2', client: 'ChatGPT', app: 'ChatGPT', redirectHost: 'chatgpt.com', scopes: ['session:read', 'session:edit'], lastUsed: NOW - 1000 },
	{ id: 'g_3', client: 'Claude Code', app: '', redirectHost: 'this computer', scopes: ['session:read'], lastUsed: 0 }
];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 860 } } });
	const P = A.page;
	const S = (/** @type {string} */ fn, /** @type {any} */ arg) => P.evaluate(new Function('arg', 'const S = window.__tp.test.v1; ' + fn), arg);
	const openSettings = (/** @type {string | null} */ section) => S('S.settingsSection.set(arg); S.settingsOpen.set(true);', section);
	const closeSettings = () => S('S.settingsOpen.set(false);');
	const search = (/** @type {string} */ q) => P.locator('input#settings-search').first().fill(q);
	const pageTitle = () =>
		P.evaluate(() =>
			[...document.querySelectorAll('#settings-sections .ss-page')]
				.filter((p) => /** @type {HTMLElement} */ (p).offsetParent !== null)
				.map((p) => (p.querySelector('.ss-title')?.textContent || '').replace(/›\s*$/, '').trim())
				.join('|')
		);
	const shown = (/** @type {string} */ sel) => P.locator(sel).first().isVisible().catch(() => false);
	const inView = (/** @type {string} */ sel) =>
		P.evaluate((s) => {
			const el = document.querySelector(s);
			const main = document.getElementById('settings-main');
			if (!el || !main) return false;
			const r = el.getBoundingClientRect();
			const m = main.getBoundingClientRect();
			return r.height > 0 && r.top >= m.top - 2 && r.top < m.bottom - 20;
		}, sel);

	// ---- 1. OSS: the two cards + Other tools, no Connected apps -------------------------------------------------
	await openSettings('ai');
	await P.waitForSelector('#ai-card-in-app [data-tool-section="chat"]', { timeout: 15000 });
	h.check((await pageTitle()) === 'AI', `the page is called AI (${await pageTitle()})`);
	const heads = await P.evaluate(() => [...document.querySelectorAll('#settings-main .ai-card-title')].map((n) => (n.textContent || '').trim()));
	h.check(JSON.stringify(heads) === JSON.stringify(['AI inside the app (your key)', 'AI apps that work in your scene', 'Other tools']), `two cards, then Other tools (${heads.join(' | ')})`);
	const where = await P.evaluate(() => {
		const of = (/** @type {string} */ s) => document.querySelector(`#settings-main [data-tool-section="${s}"]`)?.closest('[data-ai-card]')?.getAttribute('data-ai-card') ?? null;
		return { chat: of('chat'), mesh: of('mesh'), agents: of('agents'), desktop: of('desktop') };
	});
	h.check(where.chat === 'in-app' && where.mesh === 'in-app' && where.agents === 'in-scene' && where.desktop === 'other', `rows sit in their card (${JSON.stringify(where)})`);
	h.check((await P.locator('#connected-apps-settings').count()) === 0 && (await P.locator('#settings-account').count()) === 0, 'no provider (OSS): no Connected apps and no Account page');
	const docs = await P.locator('#ai-card-in-scene .ai-card-link').getAttribute('href');
	h.check(docs === 'https://docs.theprototype.app/ai/use-any-ai/', `card 2 links the "Use any AI" page (${docs})`);
	await P.locator('#ai-jump-in-scene').click();
	await P.waitForTimeout(500);
	h.check(await inView('#ai-card-in-scene'), 'the "On this page" line brings card 2 to the top (the page is long: find-it)');
	await search('gemini');
	await P.waitForTimeout(600);
	h.check(!(await shown('#ai-jump')), 'the jump line stands down while searching');
	await search('');
	await P.waitForTimeout(300);
	h.check((await P.locator('#ai-card-in-app .settings-footnote').count()) === 1 && (await P.locator('#settings-main .settings-footnote').count()) === 1, 'the API-key footnote sits once, in the key card');
	await closeSettings();

	// ---- 2. Connected apps in card 2, named by the trusted app ----------------------------------------------------
	await installProvider(P, GRANTS);
	await openSettings('ai');
	await P.waitForSelector('#ai-card-in-scene #connected-apps-settings [data-app="g_2"]', { timeout: 15000 });
	const rows = await P.evaluate(() =>
		['g_1', 'g_2', 'g_3'].map((id) => {
			const r = document.querySelector(`[data-app="${id}"]`);
			return { label: (r?.querySelector('.sr-name')?.textContent || '').trim(), text: (r?.textContent || '').replace(/\s+/g, ' ').trim(), revoke: r?.querySelector('button')?.getAttribute('aria-label') ?? '' };
		})
	);
	console.log('  rows:', JSON.stringify(rows));
	h.check(rows[0].label === 'Claude' && rows[1].label === 'ChatGPT' && rows[2].label === 'Claude Code', `each connection says which app it is (${rows.map((r) => r.label).join(', ')})`);
	h.check(/chatgpt\.com/.test(rows[1].text) && !/name chosen by the app/.test(rows[1].text), 'the ChatGPT row names where it returns, and no unchecked-name note');
	h.check(/name chosen by the app/.test(rows[2].text) && /this computer/.test(rows[2].text) && /can look/.test(rows[2].text), 'the loopback CLI is marked as its own name, on this computer, look-only');
	h.check(rows[1].revoke === 'Revoke ChatGPT', `a Revoke per row, named (${rows[1].revoke})`);
	await P.locator('[data-app="g_2"]').getByRole('button', { name: 'Revoke ChatGPT' }).click();
	const confirm = await P.locator('dialog, [role="dialog"], [role="alertdialog"]').filter({ hasText: 'Revoke ChatGPT?' }).first().textContent().catch(() => '');
	h.check(/Adding theprototype again in ChatGPT/.test(confirm ?? ''), `the confirm speaks of ChatGPT, not claude.ai (${(confirm || '').replace(/\s+/g, ' ').slice(0, 160)})`);
	await P.getByRole('button', { name: 'Revoke', exact: true }).last().click();
	await h.eventually(() => P.evaluate(() => /** @type {any} */ (window).__connectorFake.revoked), (r) => r.includes('g_2'), 'revoked', 6000);
	h.check((await P.evaluate(() => /** @type {any} */ (window).__connectorFake.revoked)).includes('g_2'), 'Revoke reaches the provider for that app only');
	await P.waitForTimeout(500);
	await closeSettings();
	await installProvider(P, GRANTS); // back to three for the rest

	// ---- 3. the old ways in -----------------------------------------------------------------------------------------
	for (const key of ['connectedapps', 'tools', 'toolsconnections']) {
		await openSettings(key);
		await P.waitForSelector('#ai-card-in-scene', { timeout: 15000 });
		await P.waitForTimeout(700);
		const t = await pageTitle();
		const apps = key === 'connectedapps' ? await inView('#connected-apps-settings > *') : true;
		h.check(t === 'AI' && apps, `the old '${key}' deep link lands on AI${key === 'connectedapps' ? ' at Connected apps' : ''} (${t})`);
		await closeSettings();
	}
	await P.evaluate(() => /** @type {any} */ (window).__tp.test.v1.cloudPlugin.makeCloudApi().openSettings('account', 'connected-apps-settings'));
	await P.waitForSelector('#ai-card-in-scene #connected-apps-settings [data-app="g_1"]', { timeout: 15000 });
	await P.waitForTimeout(500);
	h.check((await pageTitle()) === 'AI' && (await inView('#connected-apps-settings > *')), "cloudApi.openSettings('account', 'connected-apps-settings') — the old anchor — lands on AI's card");
	await closeSettings();
	await openSettings('account');
	await P.waitForSelector('#settings-account #row-account-connected-apps', { timeout: 15000 });
	h.check((await P.locator('#settings-account #connected-apps-settings').count()) === 0, 'Account keeps a link row, not the list');
	await P.locator('#row-account-connected-apps').click();
	await P.waitForSelector('#ai-card-in-scene #connected-apps-settings [data-app="g_1"]', { timeout: 15000 });
	await P.waitForTimeout(500);
	h.check((await pageTitle()) === 'AI' && (await inView('#connected-apps-settings > *')), "Account's Connected apps row opens AI at the list");

	// ---- 4. search ---------------------------------------------------------------------------------------------------
	for (const [q, want, gone] of [
		['chatgpt', '#row-connected-app-g_2', '#ai-card-in-app'],
		['gemini', '#ai-card-in-app [data-tool-section="chat"]', '#ai-card-other'],
		['blender', '#ai-card-other [data-tool-section="desktop"]', '#ai-card-in-app'],
		['connected apps', '#row-account-connected-apps', '#ai-card-in-app'],
		['revoke', '#row-connected-app-g_1', '#ai-card-other']
	]) {
		await search(q);
		await P.waitForTimeout(700);
		const ok = (await shown(want)) && !(await shown(gone));
		h.check(ok, `search "${q}" finds ${want} and hides ${gone} (a card with no row left goes, heading and all)`);
	}
	await search('');
	await P.waitForTimeout(400);
	await closeSettings();

	// ---- 4b. the invite sheet's AI agent tab points an AI app in its own window at card 2 (find-it round 2) -------------
	await P.getByRole('button', { name: 'Invite a person or an AI agent' }).first().click();
	await P.getByRole('tab', { name: 'AI agent' }).first().click();
	await P.waitForSelector('#invite-ai-apps button', { timeout: 10000 });
	await P.locator('#invite-ai-apps button').click();
	await P.waitForSelector('#ai-card-in-scene', { timeout: 15000 });
	await P.waitForTimeout(700);
	h.check((await pageTitle()) === 'AI' && (await inView('#ai-card-in-scene')) && !(await shown('#invite-sheet')), 'Invite ▸ AI agent: "connect it in Settings ▸ AI" closes the sheet and lands on card 2');
	await closeSettings();

	// ---- 5. the command palette's card row -------------------------------------------------------------------------------
	await P.keyboard.press('Control+k');
	const input = P.locator('#command-palette-input');
	if (await input.isVisible({ timeout: 4000 }).catch(() => false)) {
		await input.fill('AI apps that work in your scene');
		await P.waitForTimeout(300);
		await P.locator('#command-palette-list .cp-item[data-command="setting:AI:AI apps that work in your scene"]').first().click();
		await P.waitForSelector('#ai-card-in-scene', { timeout: 15000 });
		await P.waitForTimeout(700);
		h.check((await pageTitle()) === 'AI' && (await inView('#ai-card-in-scene')), 'the palette row "AI apps that work in your scene" lands on that card');
		await closeSettings();
	} else h.check(false, 'Ctrl+K opens the command palette');

	// ---- 6. the tab's words -------------------------------------------------------------------------------------------
	// 6a ZERO CHANGE: a Worker before 89 (no `app` anywhere) — the words are Claude's, exactly as before
	const old = await fakeRelay(P);
	await S('S.aiAssistantHidden.set("");');
	await P.waitForSelector('#connect-claude-button', { state: 'visible', timeout: 20000 });
	// the AI window's Connect card points other AI apps at card 2 (find-it: the window said only "Claude")
	await P.locator('#connect-claude-other').click();
	await P.waitForSelector('#ai-card-in-scene', { timeout: 15000 });
	await P.waitForTimeout(700);
	h.check((await pageTitle()) === 'AI' && (await inView('#ai-card-in-scene')), 'the Connect card\'s "ChatGPT or another AI app?" link lands on card 2');
	await closeSettings();
	await S('S.aiAssistantHidden.set("");');
	await P.waitForSelector('#connect-claude-button', { state: 'visible', timeout: 20000 });
	await P.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 20000);
	const chipOld = await P.locator('#connect-claude-chip').textContent().catch(() => '');
	h.check(/^\s*Claude connected · this tab\s*$/.test(chipOld ?? ''), `no app from the Worker: the chip reads as before (${chipOld?.trim()})`);
	old.call('o1', 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Old_Box', position: [0, 0.5, 0] }] });
	const r0 = await old.answer('o1');
	h.check(r0?.type === 'result', 'the relayed call answered');
	await P.locator('#agent-log .alog-line').filter({ hasText: 'created 1 object' }).first().waitFor({ state: 'visible', timeout: 10000 });
	const who0 = await P.locator('#agent-log .alog-who').first().textContent();
	h.check(/Claude \(connector\)/.test(who0 ?? ''), `…and its line is "Claude (connector)" (${who0?.trim()})`);
	await P.locator('#connect-claude-disconnect').click().catch(() => {});
	await h.eventually(() => connectorPhase(A), (p) => p === 'idle', 'disconnected', 10000);
	await P.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});

	// 6b a Worker that names ChatGPT
	const gpt = await fakeRelay(P, undefined, {
		connection: { id: 'L2', client: 'ChatGPT', app: 'ChatGPT', account: 'ann' },
		connections: [{ id: 'g_2', client: 'ChatGPT', app: 'ChatGPT', scopes: ['session:read', 'session:edit'], lastUsed: NOW }]
	});
	await P.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 20000);
	const chip = await P.locator('#connect-claude-chip').textContent().catch(() => '');
	h.check(/ChatGPT connected · this tab/.test(chip ?? ''), `the chip names the app (${chip?.trim()})`);
	const title = await P.locator('#connect-claude-chip').getAttribute('title');
	h.check(/^ChatGPT uses theprototype through this tab/.test(title ?? ''), `…and so does its tooltip (${title})`);
	gpt.call('n1', 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Gpt_Box', position: [1, 0.5, 0] }] }, 'edit', 'g_2');
	const r1 = await gpt.answer('n1');
	h.check(r1?.type === 'result', 'the relayed call from ChatGPT answered');
	await h.eventually(
		() => P.evaluate(() => [...document.querySelectorAll('#agent-log .alog-who')].map((n) => (n.textContent || '').trim()).join('|')),
		(t) => /ChatGPT \(connector\)/.test(t),
		'ChatGPT line',
		10000
	);
	const whoN = await P.evaluate(() => [...document.querySelectorAll('#agent-log .alog-who')].map((n) => (n.textContent || '').trim()).join(' | '));
	h.check(/ChatGPT \(connector\)/.test(whoN), `ChatGPT's line is "ChatGPT (connector)" (${whoN})`);
	// 104-int: the person's own tools (104 files / show / scene) name the app too ("ChatGPT opened Explorer · Back")
	await S('S.safeStorage.setItem("show:allow:panel", "always"); S.explorerClose?.set?.(true);');
	gpt.call('n2', 'show', { action: 'panel', name: 'Explorer' }, 'edit', 'g_2');
	const r2 = await gpt.answer('n2');
	h.check(r2?.type === 'result' && r2.result?.panel === 'Explorer', `show from ChatGPT answered (${JSON.stringify(r2?.result ?? r2).slice(0, 120)})`);
	const toastLines = () => S('let t = []; S.toastStore.subscribe((v) => (t = v))(); return t.map((e) => (typeof e === "string" ? e : e.text)).join(" | ");');
	await h.eventually(toastLines, (t) => /ChatGPT opened Explorer/.test(t), 'ChatGPT show line', 10000);
	const showLines = await toastLines(); // h.eventually returns nothing
	h.check(/ChatGPT opened Explorer/.test(showLines ?? '') && !/Claude opened Explorer/.test(showLines ?? ''), `the show line names ChatGPT, not Claude (${showLines})`);
	await S('S.safeStorage.removeItem("show:allow:panel"); S.showTool?.showToolResetForTest?.();');
	await P.locator('#connect-claude-disconnect').click().catch(() => {});
	await h.eventually(() => connectorPhase(A), (p) => p === 'idle', 'disconnected', 10000);
	await S('S.aiAssistantHidden.set("1");');

	// ---- 7. axe + shots ---------------------------------------------------------------------------------------------
	await openSettings('ai');
	await P.waitForSelector('#ai-card-in-scene #connected-apps-settings [data-app="g_1"]', { timeout: 15000 });
	await P.waitForTimeout(500);
	const res = await new AxeBuilder({ page: P }).include('#settings-main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
	for (const v of res.violations) console.log(`  [axe] ${v.impact} ${v.id} (${v.nodes.length}) — ${v.help}`);
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	h.check(gated.length === 0, `axe: no serious/critical violation on Settings ▸ AI (${gated.map((v) => v.id).join(', ') || 'none'})`);
	for (const theme of ['dark', 'light']) {
		await P.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
		await P.waitForTimeout(400);
		await P.locator('#settings-main').scrollIntoViewIfNeeded().catch(() => {});
		await P.evaluate(() => document.getElementById('settings-main')?.scrollTo(0, 0));
		await P.locator('dialog.settings-dialog, #settings-main').first().screenshot({ path: path.join(OUT, `ai-1280-${theme}-top.png`) }).catch(() => {});
		await P.evaluate(() => document.getElementById('ai-card-in-scene')?.scrollIntoView({ block: 'start' }));
		await P.waitForTimeout(300);
		await P.locator('dialog.settings-dialog, #settings-main').first().screenshot({ path: path.join(OUT, `ai-1280-${theme}-apps.png`) }).catch(() => {});
	}
	await P.evaluate(() => document.documentElement.removeAttribute('data-theme'));
	await closeSettings();
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);

	const Q = await h.setupPage(browser, 'N6-folded', { context: { viewport: { width: 390, height: 860 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } });
	await installProvider(Q.page, GRANTS);
	await Q.page.evaluate(() => {
		const T = /** @type {any} */ (window).__tp.test.v1;
		T.settingsSection.set('connectedapps');
		T.settingsOpen.set(true);
	});
	await Q.page.waitForSelector('#ai-card-in-scene #connected-apps-settings [data-app="g_2"]', { timeout: 20000 });
	await Q.page.waitForTimeout(700);
	const fits = await Q.page.evaluate(() => {
		const main = document.getElementById('settings-main');
		return !!main && main.scrollWidth <= main.clientWidth + 1;
	});
	h.check(fits, 'N6 folded: Settings ▸ AI has no sideways scroll');
	await Q.page.screenshot({ path: path.join(OUT, 'ai-n6-folded.png') }).catch(() => {});
	h.check(h.pageErrors(Q).length === 0, 'N6 folded: no page errors');
	await h.closePeer(Q);
	await browser.close();
});
