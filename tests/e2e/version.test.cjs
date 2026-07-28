// RV (versioning V2-V8): About shows the baked version, .tpscene payloads carry
// format + appVersion, a NEWER format asks via the confirm dialog (cancel -> null),
// and the peer app-version check toasts once per session.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// 1) Settings -> About shows `x.y.z(-dev) (sha|unknown)`
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(600);
	await A.page.getByRole('button', { name: 'About' }).click();
	await A.page.waitForTimeout(400);
	const aboutText = await A.page.evaluate(() => document.body.innerText);
	h.check(
		/\d+\.\d+\.\d+(-dev)? \(([0-9a-f]{7,}|unknown)\)/.test(aboutText),
		'About shows the baked version string'
	);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(300);

	// 2) session payloads carry format + appVersion
	const payload = await A.page.evaluate(() => {
		const p = window.__stores.sessions.buildSessionPayload('e2e');
		return { format: p.format, appVersion: p.appVersion };
	});
	h.check(payload.format === 1, `buildSessionPayload stamps format 1 (${payload.format})`);
	h.check(/^\d+\.\d+\.\d+/.test(payload.appVersion || ''), `payload carries a semver appVersion (${payload.appVersion})`);

	// 3) a NEWER format asks; cancel resolves null and stores nothing
	const doctored = JSON.stringify({ objects: [], format: 99, appVersion: '9.9.9' });
	const cancelled = A.page.evaluate(
		(json) => window.__stores.sessions.importSession(json).then((r) => (r === null ? 'null' : 'payload')),
		doctored
	);
	await A.page.locator('#confirm-dialog-ok').waitFor({ state: 'visible', timeout: 10000 });
	h.check(true, 'newer format opens the Load-anyway confirm');
	await A.page.locator('#confirm-dialog-cancel').click();
	h.check((await cancelled) === 'null', 'cancel resolves null (silent no-op)');

	// ...and Load anyway imports it
	const loaded = A.page.evaluate(
		(json) => window.__stores.sessions.importSession(json).then((r) => (r ? 'payload' : 'null')),
		doctored
	);
	await A.page.locator('#confirm-dialog-ok').waitFor({ state: 'visible', timeout: 10000 });
	await A.page.locator('#confirm-dialog-ok').click();
	h.check((await loaded) === 'payload', 'Load anyway imports the session');

	// 4) peer app-version toast fires once per session
	const toastCounts = await A.page.evaluate(async () => {
		const s = window.__stores;
		const count = () =>
			new Promise((r) =>
				s.toastStore.subscribe((t) =>
					r(t.filter((x) => String(typeof x === 'string' ? x : x.text).includes('Peer runs app 9.9.9')).length)
				)()
			);
		s.moduleSDK.checkPeerAppVersion('9.9.9');
		await new Promise((r) => setTimeout(r, 200));
		const first = await count();
		s.moduleSDK.checkPeerAppVersion('9.9.9');
		await new Promise((r) => setTimeout(r, 200));
		return { first, second: await count() };
	});
	h.check(toastCounts.first === 1, `version-mismatch toast shown (${toastCounts.first})`);
	h.check(toastCounts.second === 1, 'second handshake adds no duplicate toast');

	await h.finish(browser);
});
