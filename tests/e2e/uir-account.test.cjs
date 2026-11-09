// uir-account (owner F1 YES 2026-11-09) — Account into Settings: core's half. The cloud plugin's rows (Sign-in methods,
// Devices) are proven against a real PocketBase by the cloud smokes (client-plugin/scripts/smoke-account-settings.cjs);
// here a FAKE plugin mount and a FAKE connector provider stand in, so the suite needs no server.
//
//   1. no plugin, no provider: Settings has no Account page and no Connected apps page (the OSS build)
//   2. a connector provider alone: the Account page exists and holds Connected apps; the old "Connected apps" page is
//      gone from the sidebar; the old deep link ('connectedapps') opens Account at the Connected apps group
//   3. the plugin mount: its groups come first, Connected apps under them; search finds each moved row by its words
//   4. cloudApi.openSettings(section, anchor): reaches an element the plugin renders LATE, flashes it; refuses junk
//   5. Connect Claude's "Connected apps" link (connected tab) opens the new place; Revoke there reaches the provider
//   6. requests: opening Settings ▸ Account asks the provider for the list ONCE; a search after asks nothing
//   7. axe on the page; desktop 1280 + 1920 shots, dark + light, and the N6 folded / unfolded page
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { default: AxeBuilder } = require('@axe-core/playwright');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

const OUT = path.join(__dirname, '..', '..', 'test-results', 'uir-account', 'shots');
fs.mkdirSync(OUT, { recursive: true });

/** @param {any} page @param {string} include @param {string} label */
async function axe(page, include, label) {
	const res = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	for (const v of res.violations) console.log(`  [${label}] ${v.impact} ${v.id} (${v.nodes.length}) — ${v.help}`);
	h.check(gated.length === 0, `${label}: no serious/critical axe violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
}

/** the fake plugin section: the shape the real one draws (kit card + rows), one row arriving after an await */
const FAKE_MOUNT = `(el) => {
	const card = (title, id, rows) => {
		const s = document.createElement('section');
		s.className = 'tp-ui sec-card-wrap';
		s.id = id;
		const h3 = document.createElement('h3');
		h3.setAttribute('data-section-label', '');
		h3.textContent = title;
		s.append(h3);
		for (const [rid, name, kw] of rows) {
			const r = document.createElement('div');
			r.className = 'tp-ui setting-row';
			r.id = rid;
			r.dataset.keywords = kw;
			const n = document.createElement('span');
			n.className = 'sr-name';
			n.textContent = name;
			r.append(n);
			s.append(r);
		}
		return s;
	};
	el.append(
		card('Email', 'fake-email', [['row-fake-updates', 'Product updates', 'email newsletter']]),
		card('Sign-in methods', 'fake-signin', [['row-fake-github', 'GitHub', 'sign in login oauth link unlink provider']]),
		card('Devices', 'fake-devices', [['row-fake-device', 'This device', 'devices sessions sign out everywhere']])
	);
	const t = setTimeout(() => el.append(card('Late', 'fake-late', [['row-fake-late', 'Arrives late', 'late']])), 900);
	return () => { clearTimeout(t); el.replaceChildren(); };
}`;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const P = A.page;
	const openSettings = (/** @type {string | null} */ section) =>
		P.evaluate((s) => {
			const S = /** @type {any} */ (window).__stores;
			S.settingsSection.set(s);
			S.settingsOpen.set(true);
		}, section);
	const closeSettings = () => P.evaluate(() => /** @type {any} */ (window).__stores.settingsOpen.set(false));
	const search = (/** @type {string} */ q) => P.locator('input#settings-search').first().fill(q);
	const navLabels = () => P.evaluate(() => [...document.querySelectorAll('#settings-nav .sn-row')].map((n) => (n.textContent || '').trim()).filter(Boolean));
	/** where an element sits in the content column: on screen (top inside the column) or not */
	const inView = (/** @type {string} */ sel) =>
		P.evaluate((s) => {
			const el = document.querySelector(s);
			const main = document.getElementById('settings-main');
			if (!el || !main) return false;
			const r = el.getBoundingClientRect();
			const m = main.getBoundingClientRect();
			return r.height > 0 && r.top >= m.top - 2 && r.top < m.bottom - 20;
		}, sel);

	// ---- 1. the OSS build ---------------------------------------------------------------------------------------
	await openSettings(null);
	await P.waitForSelector('#settings-main', { timeout: 15000 });
	await P.waitForTimeout(400);
	const oss = await navLabels();
	h.check((await P.locator('#settings-account').count()) === 0 && !oss.some((l) => /^Account$|^Connected apps$/.test(l)), `no plugin, no provider: no Account and no Connected apps page (${oss.join('|').slice(0, 300)})`);
	await closeSettings();

	// ---- 2. a provider alone: Connected apps lives in Settings ▸ Account -----------------------------------------
	await installProvider(P);
	await openSettings('connectedapps'); // the old deep link
	await P.waitForSelector('#settings-account #connected-apps-settings [data-app="g_1"]', { timeout: 15000 });
	const nav2 = await navLabels();
	h.check(nav2.includes('Account') && !nav2.includes('Connected apps'), `the sidebar has Account and no separate Connected apps page (${nav2.join('|').slice(0, 300)})`);
	const title2 = await P.locator('#settings-sections .ss-page[data-section="account"] .ss-title').first().textContent();
	h.check((title2 || '').trim() === 'Account', `the old 'connectedapps' deep link opens the Account page (${title2})`);
	await closeSettings();

	// ---- 3. the plugin's groups first, then Connected apps; search ---------------------------------------------------
	const mounted = await P.evaluate((src) => {
		const api = /** @type {any} */ (window).__stores.cloudPlugin.makeCloudApi();
		// eslint-disable-next-line no-new-func
		return api.mountSettingsSection('account', new Function('return ' + src)());
	}, FAKE_MOUNT);
	h.check(mounted === true, 'the plugin mounts into Settings ▸ Account');
	await openSettings('account');
	await P.waitForSelector('#settings-account #fake-signin', { timeout: 15000 });
	await P.waitForSelector('#settings-account #connected-apps-settings [data-app="g_1"]', { timeout: 15000 });
	const order = await P.evaluate(() => [...document.querySelectorAll('#settings-account [data-section-label]')].map((n) => (n.textContent || '').trim()).filter(Boolean));
	const iSign = order.findIndex((t) => /Sign-in methods/.test(t));
	const iDev = order.findIndex((t) => /^Devices/.test(t));
	const iApps = order.findIndex((t) => /^Connected apps/.test(t));
	h.check(order[0]?.startsWith('Email') && iSign > 0 && iDev > iSign && iApps > iDev, `Account page order: Email · Sign-in methods · Devices (plugin) · then Connected apps (core) (${order.join(' | ')})`);
	for (const [q, want, hidden] of [
		['sign-in methods', '#row-fake-github', '#row-fake-device'],
		['devices', '#row-fake-device', '#row-fake-github'],
		['sign out everywhere', '#row-fake-device', '#row-fake-updates'],
		['connected apps', '#row-connected-app-g_1', '#row-fake-device'],
		['revoke', '#row-connected-app-g_1', '#row-fake-github'],
		['claude', '#row-connector-tab', '#row-fake-github']
	]) {
		await search(q);
		await P.waitForTimeout(600);
		const shown = await P.locator(want).first().isVisible();
		const gone = !(await P.locator(hidden).first().isVisible());
		h.check(shown && gone, `search "${q}" finds ${want} and filters ${hidden} out`);
	}
	await search('');
	await P.waitForTimeout(400);
	await closeSettings();

	// ---- 4. cloudApi.openSettings: a late element, and junk refused ----------------------------------------------------
	const junk = await P.evaluate(() => {
		const api = /** @type {any} */ (window).__stores.cloudPlugin.makeCloudApi();
		return [api.openSettings('', 'x'), api.openSettings('account', 'bad id"]'), api.openSettings('account', '<img>')];
	});
	h.check(junk.every((r) => r === false), `openSettings refuses an empty page or a malformed id (${JSON.stringify(junk)})`);
	h.check(!(await P.evaluate(() => { let o; /** @type {any} */ (window).__stores.settingsOpen.subscribe((v) => (o = v))(); return o; })), '…and opens nothing for it');
	await P.evaluate(() => /** @type {any} */ (window).__stores.cloudPlugin.makeCloudApi().openSettings('account', 'row-fake-late'));
	await P.waitForSelector('#row-fake-late', { timeout: 6000 });
	await P.waitForTimeout(300);
	const late = await P.evaluate(() => document.getElementById('row-fake-late')?.classList.contains('sr-flash'));
	h.check(late === true && (await inView('#row-fake-late')), 'openSettings(account, id) waits for a row the plugin renders after an await, brings it into view and flashes it');
	await closeSettings();

	// ---- 5. Connect Claude's link + Revoke ---------------------------------------------------------------------------
	await P.evaluate(() => /** @type {any} */ (window).__stores.aiAssistantHidden.set(''));
	await fakeRelay(P);
	await P.waitForSelector('#connect-claude-button', { state: 'visible', timeout: 20000 });
	await P.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 20000);
	await P.locator('#connect-claude-keep-open .cc-link').click();
	await P.waitForSelector('#settings-account #connected-apps-settings [data-app="g_1"]', { timeout: 15000 });
	await P.waitForTimeout(400);
	h.check(await inView('#connected-apps-settings > *'), 'Connect Claude ▸ "Connected apps" opens Settings ▸ Account at the Connected apps groups');
	await P.locator('#connected-apps-settings [data-app="g_1"]').getByRole('button', { name: 'Revoke Claude' }).click();
	await P.getByRole('button', { name: 'Revoke', exact: true }).last().click();
	await h.eventually(() => P.evaluate(() => /** @type {any} */ (window).__connectorFake.revoked), (r) => r.includes('g_1'), 'revoked', 6000);
	h.check((await P.evaluate(() => /** @type {any} */ (window).__connectorFake.revoked)).includes('g_1'), 'Revoke in Settings ▸ Account ▸ Connected apps reaches the provider');
	await closeSettings();
	await P.evaluate(() => /** @type {any} */ (window).__stores.aiAssistantHidden.set('1'));

	// ---- 6. requests: one list per open, nothing on search -------------------------------------------------------------
	await P.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__lists = 0;
		const p = w.__stores.cloudHooks;
		let cur;
		p.connectorProvider.subscribe((/** @type {any} */ v) => (cur = v))();
		const orig = cur.connections;
		cur.connections = async () => {
			w.__lists++;
			return orig();
		};
	});
	await openSettings('account');
	await P.waitForSelector('#settings-account #connected-apps-settings', { timeout: 15000 });
	await P.waitForTimeout(800);
	const afterOpen = await P.evaluate(() => /** @type {any} */ (window).__lists);
	await search('revoke');
	await P.waitForTimeout(600);
	await search('');
	await P.waitForTimeout(600);
	const afterSearch = await P.evaluate(() => /** @type {any} */ (window).__lists);
	h.check(afterOpen === 1, `opening Settings ▸ Account asks for the connected apps once (${afterOpen})`);
	h.check(afterSearch === afterOpen, `a search on the open page asks nothing more (${afterSearch - afterOpen} more)`);

	// ---- 7. axe + shots ----------------------------------------------------------------------------------------------
	await axe(P, '#settings-account', 'Settings ▸ Account');
	for (const [w, hgt] of [[1280, 800], [1920, 1080]]) {
		for (const theme of ['dark', 'light']) {
			await P.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
			await P.setViewportSize({ width: w, height: hgt });
			await P.waitForTimeout(500);
			await P.locator('dialog.settings-dialog, #settings-main').first().screenshot({ path: path.join(OUT, `core-account-${w}-${theme}.png`) }).catch(() => {});
		}
	}
	await P.evaluate(() => document.documentElement.removeAttribute('data-theme'));
	await closeSettings();
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);

	// N6 folded / unfolded (device-lab sizes): the page as a phone shows it
	for (const [name, viewport, dpr] of [
		['folded', { width: 390, height: 860 }, 3],
		['unfolded', { width: 691, height: 634 }, 3.25]
	]) {
		const Q = await h.setupPage(browser, 'N6-' + name, { context: { viewport, deviceScaleFactor: dpr, isMobile: true, hasTouch: true } });
		await installProvider(Q.page);
		await Q.page.evaluate((src) => /** @type {any} */ (window).__stores.cloudPlugin.makeCloudApi().mountSettingsSection('account', new Function('return ' + src)()), FAKE_MOUNT);
		await Q.page.evaluate(() => {
			const S = /** @type {any} */ (window).__stores;
			S.settingsSection.set('account');
			S.settingsOpen.set(true);
		});
		await Q.page.waitForSelector('#settings-account #connected-apps-settings [data-app="g_1"]', { timeout: 20000 });
		await Q.page.waitForTimeout(600);
		const fits = await Q.page.evaluate(() => {
			const main = document.getElementById('settings-main');
			return !!main && main.scrollWidth <= main.clientWidth + 1;
		});
		h.check(fits, `N6 ${name}: the Account page has no sideways scroll`);
		await Q.page.screenshot({ path: path.join(OUT, `core-account-n6-${name}.png`) }).catch(() => {});
		h.check(h.pageErrors(Q).length === 0, `N6 ${name}: no page errors`);
		await h.closePeer(Q);
	}
	await browser.close();
});
