// 34 R1 — the stale-module warning: an installed user module OLDER than the version this
// build was released with (src/lib/moduleVersions.json, written by scripts/module-versions.cjs).
//
//   1. a current module installs quietly (no toast, no row)
//   2. an older one: a sticky toast naming it with Update + Open Modules, a `stale-module`
//      marker {id, installed, expected} in the perf ring (beacon reports carry it)
//   3. Open Modules lands on the User tab, where its row has an Update button
//   4. Update pulls the gallery's copy (a mocked modules CDN) -> the row and the toast go
//   5. a third-party module this build does not know is never stale
//
// Run: APP_URL=https://theprototype.app:5292/ npm run e2e -- perf-stale-modules
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');
const expected = require('../../src/lib/moduleVersions.json').modules;

/** a self-contained user module as a zip @param {string} id @param {string} version */
function moduleZip(id, version) {
	const manifest = { id, name: id === 'waves' ? 'Waves' : id, version, entry: 'module.js' };
	const code = `export default { id: ${JSON.stringify(id)}, name: ${JSON.stringify(manifest.name)}, version: ${JSON.stringify(version)}, register(api) {} };\n`;
	return { manifest, code, zip: zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'module.js': strToU8(code) }) };
}

h.run(async () => {
	const want = expected.waves;
	h.check(typeof want === 'string', `premise: this build expects waves ${want}`);
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// the gallery CDN, mocked: index.json lists waves at the expected version, its folder serves it
	const current = moduleZip('waves', want);
	await A.ctx.route(/\/index\.json(\?|$)/, (route) =>
		route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ id: 'waves', name: 'Waves', version: want, source: 'modules/waves', zip: 'waves.zip', category: 'game' }]) })
	);
	await A.ctx.route(/\/modules\/waves\/manifest\.json/, (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(current.manifest) }));
	await A.ctx.route(/\/modules\/waves\/module\.js/, (route) => route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: current.code }));

	const install = (id, version) =>
		page.evaluate(
			async ({ bytes, name }) => window.__stores.userModules.installZip(new File([new Uint8Array(bytes)], name)),
			{ bytes: Array.from(moduleZip(id, version).zip), name: `${id}-${version}.zip` }
		);
	const toast = () =>
		page.evaluate(() => {
			let list = [];
			window.__stores.toastStore.subscribe((x) => (list = x))();
			return list.find((t) => t && t.id === 'stale-modules') ?? null;
		});
	const staleEvents = () => page.evaluate(() => window.__stores.perf.lightWindow(30000).events.filter((e) => e.kind === 'stale-module'));

	// 1. current: quiet
	h.check(await install('waves', want), 'install waves at the expected version');
	await page.waitForTimeout(500);
	h.check((await toast()) === null, '1.1 a current module raises no toast');
	h.check((await staleEvents()).length === 0, '1.2 ...and no stale-module marker');

	// 2. older: the toast + the marker
	const older = want.split('.').map((n, i) => (i === 0 ? String(Math.max(0, Number(n) - 1)) : n)).join('.');
	h.check(await install('waves', older), `install waves ${older} (older than ${want})`);
	await page.waitForTimeout(500);
	const t = await toast();
	h.check(!!t && t.text.includes(`Waves ${older} (this app expects ${want})`), `2.1 a sticky toast names it (${t?.text?.slice(0, 90)})`);
	h.check(t && t.actions.map((a) => a.label).join() === 'Update,Open Modules', '2.2 with Update and Open Modules');
	const ev = await staleEvents();
	h.check(ev.length === 1 && ev[0].detail.id === 'waves' && ev[0].detail.installed === older && ev[0].detail.expected === want, `2.3 a stale-module marker in the perf ring (${JSON.stringify(ev[0]?.detail)})`);

	// 3. Open Modules -> the User tab row
	await page.evaluate(() => {
		let list = [];
		window.__stores.toastStore.subscribe((x) => (list = x))();
		list.find((t) => t && t.id === 'stale-modules').actions.find((a) => a.label === 'Open Modules').action();
	});
	await page.locator('#stale-modules').waitFor({ state: 'visible', timeout: 5000 });
	h.check((await page.locator('#modules-tab-user').getAttribute('aria-selected')) === 'true', '3.1 Open Modules lands on the User tab');
	h.check((await page.locator('#stale-modules [data-stale="waves"]').innerText()).includes(`v${older} → v${want}`), '3.2 the row says installed -> expected');
	h.check(await page.locator('#update-stale-waves').isVisible(), '3.3 with an Update button');
	h.check((await toast()) === null, '3.4 the toast went away when it was answered');

	// 4. Update pulls the gallery's copy
	await page.locator('#update-stale-waves').click();
	await page.locator('#stale-modules').waitFor({ state: 'detached', timeout: 15000 });
	const after = await page.evaluate(() => {
		let recs = [];
		window.__stores.userModules.userModules.subscribe((x) => (recs = x))();
		return recs.find((r) => r.id === 'waves');
	});
	h.check(after && after.version === want && /modules\/waves$/.test(after.source), `4.1 Update installed waves ${after?.version} from the gallery (${after?.source})`);
	h.check((await toast()) === null, '4.2 no toast once nothing is stale');

	// 5. a module this build does not know
	h.check(await install('my-own-thing', '0.0.1'), 'install an unknown third-party module');
	await page.waitForTimeout(400);
	h.check((await toast()) === null && (await page.locator('#stale-modules').count()) === 0, '5.1 a module this build does not know is never stale');

	h.check(h.pageErrors(A).length === 0, 'no page errors');
	await h.finish(browser);
});
