// 31-integrate (the owner's Quest report on preview-1-18): "Waves: as soon as I hit an enemy, ALL
// enemies return to their start position". That is the 1.17 Waves bug (2.1.0: any hit in wave 2+
// moved the running wave's start, so every walker snapped back to its portal) — fixed in 2.2.0
// and NOT reproducible on it (modules flight waves-hit-reset). The headset kept running 2.1.0:
// a user module is installed once per device and never updates itself, and a scene that asked
// for a NEWER version than the one installed only got an advisory "(you have 2.1.0)" on its card.
//
// This suite: a device with Waves 2.1.0 installed imports the 1.18 Waves scene (it asks 2.2.0).
// The load prompt must name the older version and offer the update; pressing it installs the
// gallery's Waves over the old one (live), so the game runs the version it was built against.
//   MODULES_REPO=<modules checkout with waves-before.zip (2.1.0) + modules/waves> WAVES_TPSCENE=<scene>
// Counterfactual (classifyRequirements without `outdated`): no prompt at all, Waves stays 2.1.0.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const REPO = process.env.MODULES_REPO ? path.resolve(process.env.MODULES_REPO) : null;
const OLD_ZIP = REPO && path.join(REPO, 'waves-before.zip');
const SCENE = process.env.WAVES_TPSCENE;

h.run(async () => {
	if (!REPO || !fs.existsSync(OLD_ZIP) || !SCENE || !fs.existsSync(SCENE) || !fs.existsSync(path.join(REPO, 'modules/waves/manifest.json'))) {
		console.log('SKIP: needs MODULES_REPO (with waves-before.zip = Waves 2.1.0 and modules/waves) and WAVES_TPSCENE');
		return;
	}
	const wantVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'modules/waves/manifest.json'), 'utf8')).version;
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	// the module gallery (any modules@<ref> on the CDN) is served from the modules checkout
	await page.route('**/cdn.jsdelivr.net/gh/theprototype-app/modules@*/**', (route) => {
		const url = new URL(route.request().url());
		const rel = decodeURIComponent(url.pathname.replace(/^.*\/modules@[^/]+\//, ''));
		const file = path.join(REPO, rel);
		if (!file.startsWith(REPO) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
		return route.fulfill({ body: fs.readFileSync(file) });
	});

	// ---- the device: Waves 2.1.0 installed (the 1.17 preview's copy) ----------------------------
	await h.installModule(A, 'health');
	await page.evaluate(() => window.__stores.modulesOpen.set(true));
	await page.waitForTimeout(400);
	await page.getByRole('tab', { name: /^User/ }).click();
	await page.locator('#install-module-zip').setInputFiles({ name: 'waves.zip', mimeType: 'application/zip', buffer: fs.readFileSync(OLD_ZIP) });
	const version = () => page.evaluate(() => window.__stores.moduleSDK.loadedModules.find((m) => m.id === 'waves')?.version ?? null);
	await h.eventually(version, (v) => v === '2.1.0', '(premise) Waves 2.1.0 is installed on this device');
	await page.evaluate(() => window.__stores.modulesOpen.set(false));
	await page.waitForTimeout(300);
	const asks = await page.evaluate(async (arr) => {
		const payload = await window.__stores.sessions.readSessionZip(new Uint8Array(arr).buffer);
		return (payload.modules ?? []).find((m) => m.id === 'waves')?.version ?? null;
	}, Array.from(fs.readFileSync(SCENE)));
	h.check(asks === wantVersion, `(premise) the scene asks for Waves ${asks} — the gallery's (${wantVersion})`);

	// ---- the load prompt ---------------------------------------------------------------------
	await page.evaluate((arr) => {
		window.__importDone = false;
		window.__stores.sessions.importSessionZip(new Uint8Array(arr).buffer).then(() => (window.__importDone = true));
	}, Array.from(fs.readFileSync(SCENE)));
	const button = page.locator('#confirm-dialog-install');
	const offered = await button.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
	const text = offered ? await page.evaluate(() => document.querySelector('dialog[open]')?.textContent ?? '') : '';
	h.check(offered && /Update \(1\)/.test(await button.textContent()), 'loading a scene that needs a NEWER Waves offers Update (' + (offered ? (await button.textContent()).trim() : 'no prompt') + ')');
	h.check(/Older version installed: waves v2\.1\.0 \(this scene needs v/.test(text), 'the prompt names the installed and the needed version');
	if (offered) await button.click();
	await h.eventually(version, (v) => v === wantVersion, `Update installs the gallery's Waves over 2.1.0 (now ${wantVersion})`, 30000);
	await h.eventually(() => page.evaluate(() => window.__importDone), (v) => v === true, 'the scene then loads');
	await h.finish(browser);
});
