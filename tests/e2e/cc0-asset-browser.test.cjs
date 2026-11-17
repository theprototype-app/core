// 47-cc0 (C1/C2) — the free CC0 Asset Browser, on RECORDED fixtures (tests/e2e/cc0Fixtures.cjs:
// real list answers recorded 2026-10-16, tiny generated files behind them, every request through
// page.route — no live network). Two desktop peers + one phone page.
//   1 open from the main menu · desktop default 2k · list, search, category (real clicks)
//   2 a model over the 25 MB cap at 2k is refused with "Pick 1k" (nothing lands)
//   3 a model at 1k -> ONE packed .glb through the Explorer import entry -> a Library item in
//     "Poly Haven" carrying the CC0 source -> the Explorer Properties pane names it
//   4 Add to scene -> the placed object carries userData.source on BOTH peers (+ the Inspector)
//   5 an HDRI -> a Library item (kind hdri) -> the environment's sky on BOTH peers
//   6 an ambientCG material (through the relay) -> a material preset with its maps + source ->
//     applied to a box on BOTH peers (+ the Inspector names it); the relay is asked with q/category
//   7 a Poly Haven texture set -> a preset
//   8 errors: the site answering 503 (saved list kept + the banner / a clear message + Try again),
//     the relay down, offline — each a sentence a person can act on
//   9 the dock: the window docks as a hosted tab
//  10 a phone (Find N6 folded, touch): a bottom sheet, 2 columns, 1k by default
// Evidence screenshots: E2E_EVIDENCE (default ~/.code/lanes-30/after-47/47-cc0).
const h = require('./helpers.cjs');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { makeCc0Network } = require('./cc0Fixtures.cjs');

const EVIDENCE = process.env.E2E_EVIDENCE || path.join(os.homedir(), '.code/lanes-30/after-47/47-cc0');
try {
	fs.mkdirSync(EVIDENCE, { recursive: true });
} catch {}
const shot = async (/** @type {any} */ page, /** @type {string} */ name) => {
	try {
		await page.screenshot({ path: path.join(EVIDENCE, name) });
	} catch {}
};

/** read a store off the debug hook @param {any} page @param {string} expr e.g. 'explorer.explorerItems' */
const store = (page, expr) =>
	page.evaluate((e) => {
		const s = e.split('.').reduce((o, k) => o?.[k], window.__tp?.test.v1);
		let v;
		s.subscribe((x) => (v = x))();
		return JSON.parse(JSON.stringify(v ?? null, (k, val) => (k === 'thumbnail' || k === 'map' || k === 'normalMap' ? (val ? '[data]' : val) : val)));
	}, expr);
const grid = (page) => page.$eval('#asset-browser-grid', (e) => ({ kind: e.dataset.kind, count: Number(e.dataset.count) })).catch(() => null);
const cardHeld = (page, id) => page.$eval(`.ab-card[data-asset-id="${id}"]`, (e) => e.dataset.held === 'true').catch(() => false);
const cardError = (page, id) => page.$eval(`.ab-card[data-asset-id="${id}"] .ab-card-error`, (e) => e.textContent?.trim() ?? '').catch(() => '');
/** the object with this uuid, flattened for a check @param {any} page @param {string} uuid */
const objectFacts = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		const m = Array.isArray(o.material) ? null : o.material;
		return { name: o.name, source: o.userData?.source ?? null, map: !!m?.map, normalMap: !!m?.normalMap, cc0: m?.userData?.cc0Source ?? null };
	}, uuid);

async function waitHeldOrError(page, id, timeout = 60000) {
	const ok = await page
		.waitForFunction((i) => document.querySelector(`.ab-card[data-asset-id="${i}"]`)?.dataset.held === 'true' || !!document.querySelector(`.ab-card[data-asset-id="${i}"] .ab-card-error`), id, { timeout })
		.then(() => true)
		.catch(() => false);
	if (!ok) {
		const why = await page.evaluate((i) => {
			let jobs;
			window.__tp.test.v1.cc0.cc0Jobs.subscribe((x) => (jobs = x))();
			return { jobs, card: document.querySelector(`.ab-card[data-asset-id="${i}"]`)?.outerHTML?.slice(0, 600) ?? 'NO CARD', kind: document.querySelector('#asset-browser-grid')?.dataset.kind };
		}, id);
		console.log('  waitHeldOrError ' + id + ' timed out: ' + JSON.stringify(why) + ' errors: ' + JSON.stringify(page.__errors.slice(-3)));
	}
}
async function openTab(page, key) {
	await page.click('#asset-browser-tab-' + key);
	await page.waitForFunction((k) => document.querySelector('#asset-browser-grid')?.dataset.kind === k && (Number(document.querySelector('#asset-browser-grid')?.dataset.count) > 0 || !!document.querySelector('#asset-browser-status[data-state=error]')), key, { timeout: 30000 }).catch(() => {});
}

h.run(async () => {
	const net = makeCc0Network();
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await net.routes(A.page);
	await net.routes(B.page);
	// connect FIRST, while both worlds are empty (no connect decision to answer)
	await h.connect(B, A);
	const { model, hdri, texture, material } = net.ids;
	const page = A.page;

	// ---- 1. open, list, search, category --------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.closeMenu.set(false));
	await page.locator('#open-asset-browser').click();
	await page.waitForSelector('#asset-browser-window', { timeout: 20000 });
	h.check(true, '1.1 the main menu row opens the Asset Browser');
	await page.waitForFunction(() => Number(document.querySelector('#asset-browser-grid')?.dataset.count) > 0, null, { timeout: 30000 }).catch(() => {});
	const g1 = await grid(page);
	h.check(g1?.kind === 'models' && g1.count === 3, `1.2 the Models tab lists the recorded models (${JSON.stringify(g1)})`);
	h.check((await page.getAttribute('#asset-browser-res-2k', 'aria-checked')) === 'true', '1.3 a desktop defaults to 2k');
	const thumb = await page.$eval(`.ab-card[data-asset-id="wooden_crate_02"] img`, (e) => e.getAttribute('src')).catch(() => '');
	h.check(/^https:\/\/cdn\.polyhaven\.com\/asset_img\/thumbs\/wooden_crate_02\.png/.test(thumb ?? ''), '1.4 cards show the Poly Haven thumbnail');
	await page.fill('#asset-browser-search', 'crate');
	await page.waitForTimeout(300);
	const ids1 = await page.$$eval('.ab-card', (els) => els.map((e) => e.dataset.assetId));
	h.check(ids1.length === 1 && ids1[0] === 'wooden_crate_02', `1.5 search "crate" narrows to the crate (${ids1})`);
	await page.fill('#asset-browser-search', '');
	await page.click('#asset-browser-category');
	await page.getByRole('option', { name: /^Seating/ }).click();
	await page.waitForTimeout(300);
	const ids2 = await page.$$eval('.ab-card', (els) => els.map((e) => e.dataset.assetId));
	h.check(ids2.length === 1 && ids2[0] === 'ArmChair_01', `1.6 the Seating category narrows to the chair (${ids2})`);
	await shot(page, '01-models-category.png');
	await page.click('#asset-browser-category');
	await page.getByRole('option', { name: 'All categories' }).click();
	await page.waitForTimeout(200);

	// ---- 2. over the cap at 2k --------------------------------------------------------------
	await page.locator(`.ab-card[data-asset-id="${model}"] [data-act="library"]`).click();
	await waitHeldOrError(page, model, 20000);
	const err2 = await cardError(page, model);
	h.check(/25 MB/.test(err2) && /Pick 1k/.test(err2), `2.1 a 2k model over the Library cap is refused in words ("${err2}")`);
	const items2 = await store(page, 'explorer.explorerItems');
	h.check(!items2.some((i) => i.source?.id === model), '2.2 nothing landed in the Library');

	// ---- 3. a model at 1k -> the Library ----------------------------------------------------
	await page.click('#asset-browser-res-1k');
	h.check((await page.getAttribute('#asset-browser-res-1k', 'aria-checked')) === 'true', '3.1 the resolution pick switches to 1k');
	await page.locator(`.ab-card[data-asset-id="${model}"] [data-act="library"]`).click();
	await waitHeldOrError(page, model);
	h.check(await cardHeld(page, model), `3.2 the card turns "in your library" (${await cardError(page, model)})`);
	const items3 = await store(page, 'explorer.explorerItems');
	const folders3 = await store(page, 'explorer.explorerFolders');
	const item = items3.find((i) => i.source?.id === model);
	h.check(!!item && item.kind === 'object' && /\.glb$/.test(item.name), `3.3 ONE .glb Library item (${item?.name})`);
	h.check(item?.source?.site === 'polyhaven' && item?.source?.license === 'CC0' && item?.source?.authors?.length > 0 && /^https:\/\/polyhaven\.com\/a\//.test(item?.source?.url ?? ''), '3.4 it carries the CC0 source (site, authors, licence, url)');
	h.check(folders3.find((f) => f.id === item?.folderId)?.name === 'Poly Haven', '3.5 it lands in the "Poly Haven" folder');
	const glb = await page.evaluate(async (id) => {
		const blob = await window.__tp.test.v1.explorer.itemBlob(id);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const dv = new DataView(bytes.buffer);
		const len = dv.getUint32(12, true);
		const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
		return { magic: dv.getUint32(0, true) === 0x46546c67, images: json.images?.map((i) => ({ bv: i.bufferView, uri: i.uri ?? null })), extras: json.scenes?.[0]?.extras?.source ?? null, copyright: json.asset?.copyright ?? '' };
	}, item?.id);
	h.check(glb.magic && glb.images.every((i) => Number.isInteger(i.bv) && !i.uri), '3.6 the textures are packed INSIDE the .glb (no external uris)');
	h.check(glb.extras?.id === model && /CC0/.test(glb.copyright), '3.7 the credit rides the file itself (scene extras + asset.copyright)');
	// Properties
	await page.locator(`.ab-card[data-asset-id="${model}"] [data-act="show"]`).click();
	await page.waitForTimeout(1500);
	await page.locator('#asset-browser-close').click();
	await page.locator(`[data-card-id="${item?.id}"]`).first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
	await page.waitForTimeout(800);
	const props = await page.$eval('#explorer-cc0-source', (e) => ({ text: e.textContent?.replace(/\s+/g, ' ').trim(), href: e.querySelector('a')?.getAttribute('href') })).catch(() => null);
	h.check(!!props && /CC0/.test(props.text ?? '') && /Poly Haven/.test(props.text ?? '') && props.href === item?.source?.url, `3.8 the Explorer Properties pane names the source (${props?.text})`);
	await shot(page, '02-explorer-properties.png');
	await page.evaluate(() => window.__tp.test.v1.explorerClose.set(true));

	// ---- 4. Add to scene: on both peers --------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.cc0State.openAssetBrowser());
	await page.waitForSelector(`.ab-card[data-asset-id="${model}"] [data-act="place"]`, { timeout: 20000 });
	await page.locator(`.ab-card[data-asset-id="${model}"] [data-act="place"]`).click();
	// 47-int: since 46 P2 a model import first loads the lazy import optimizer and hashes the file, so the
	// object lands 2-10 s after the click on a loaded box — poll (the explorer-drop precedent)
	await page
		.waitForFunction((id) => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); return g.children.some((c) => c.userData?.source?.id === id); }, model, { timeout: 20000 })
		.catch(() => {});
	const placed = await page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		return g.children.find((c) => c.userData?.source?.id === id)?.uuid ?? null;
	}, model);
	h.check(!!placed, '4.1 Add to scene places the model, carrying userData.source');
	await h.eventually(() => objectFacts(B.page, placed), (f) => f?.source?.site === 'polyhaven' && f?.source?.id === model, '4.2 the peer receives the object WITH its CC0 source', 20000);
	await page.evaluate((u) => window.__tp.test.v1.objectActions.applySelectionSet([u], true), placed);
	await page.waitForSelector('#inspector-cc0-source', { timeout: 15000 }).catch(() => {});
	const insp = await page.$eval('#inspector-cc0-source', (e) => e.textContent?.replace(/\s+/g, ' ').trim()).catch(() => '');
	h.check(/CC0/.test(insp ?? '') && /Poly Haven/.test(insp ?? ''), `4.3 the Inspector names where the object came from (${insp})`);
	await shot(page, '03-placed-inspector.png');
	await page.evaluate(() => window.__tp.test.v1.inspectorClose?.set(true));

	// ---- 5. an HDRI -> the sky, on both peers -------------------------------------------------
	await openTab(page, 'hdris');
	h.check((await grid(page))?.count === 2, '5.1 the HDRIs tab lists the recorded skies');
	await page.locator(`.ab-card[data-asset-id="${hdri}"] [data-act="sky"]`).click();
	await waitHeldOrError(page, hdri);
	const items5 = await store(page, 'explorer.explorerItems');
	const sky = items5.find((i) => i.source?.id === hdri);
	h.check(sky?.kind === 'hdri' && /\.hdr$/.test(sky?.name ?? ''), `5.2 the .hdr is a Library item of kind hdri (${sky?.name}) ${await cardError(page, hdri)}`);
	const envA = await page.evaluate(() => window.__tp.test.v1.environment.presetPayload()?.hdri?.src ?? null);
	h.check(!!sky && envA === 'hash:' + sky.hash, `5.3 the environment lights the scene with it (${envA})`);
	await h.eventually(() => B.page.evaluate(() => window.__tp.test.v1.environment.presetPayload()?.hdri?.src ?? null), (s) => !!sky && s === 'hash:' + sky.hash, '5.4 the peer gets the same sky', 20000);
	await shot(page, '04-hdri-sky.png');

	// ---- 6. an ambientCG material through the relay -> applied to a box -----------------------
	const box = await page.evaluate(async () => {
		window.__tp.test.v1.addObjects.spawnAtPoint('/create box', [2, 0.5, 0]);
		await new Promise((r) => setTimeout(r, 1500));
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const b = [...g.children].reverse().find((c) => c.isMesh && !c.userData?.source);
		window.__tp.test.v1.objectActions.applySelectionSet([b.uuid]);
		return b.uuid;
	});
	await openTab(page, 'materials');
	const g6 = await grid(page);
	h.check(g6?.kind === 'materials' && g6.count === 3, `6.1 the Materials tab lists ambientCG through the relay (${JSON.stringify(g6)})`);
	await page.fill('#asset-browser-search', 'oak');
	await h.eventually(async () => Object.keys(net.counts).filter((k) => k.startsWith('relay-assets:')), (keys) => keys.some((k) => /^relay-assets:oak:/.test(k)), '6.2 a search asks the relay with q=', 20000);
	await page.waitForTimeout(300);
	await page.click('#asset-browser-category');
	await page.getByRole('option', { name: /^Wood/ }).first().click();
	await page.waitForTimeout(600);
	h.check(Object.keys(net.counts).some((k) => /^relay-assets:oak:Wood/.test(k)), '6.3 a category asks the relay with category=');
	await page.locator(`.ab-card[data-asset-id="${material}"] [data-act="apply"]`).click();
	await waitHeldOrError(page, material);
	h.check(await cardHeld(page, material), `6.4 the material is saved to the library (${await cardError(page, material)})`);
	const presets = await store(page, 'materialPresets.materialPresets');
	const preset = presets.find((p) => p.payload?.source?.id === material);
	h.check(!!preset && preset.payload.map === '[data]' && preset.payload.normalMap === '[data]' && preset.payload.source.site === 'ambientcg' && preset.payload.source.license === 'CC0', '6.5 a material preset with colour + normal maps and the CC0 source');
	h.check((net.counts['acg-cdn'] ?? 0) >= 1, '6.6 the zip came from the CDN the relay pointed at (no bytes through the relay)');
	const boxA = await objectFacts(page, box);
	h.check(!!boxA?.map && !!boxA?.normalMap && boxA?.cc0?.id === material, `6.7 applied to the selected box (${JSON.stringify(boxA)})`);
	await h.eventually(() => objectFacts(B.page, box), (f) => !!f?.map && f?.cc0?.id === material, '6.8 the peer sees the box wear it', 20000);
	await page.evaluate((u) => window.__tp.test.v1.objectActions.applySelectionSet([u], true), box);
	await page.waitForSelector('#inspector-cc0-material', { timeout: 15000 }).catch(() => {});
	const inspM = await page.$eval('#inspector-cc0-material', (e) => e.textContent?.replace(/\s+/g, ' ').trim()).catch(() => '');
	h.check(/ambientCG/.test(inspM ?? '') && /CC0/.test(inspM ?? ''), `6.9 the Inspector's material section names the source (${inspM})`);
	await shot(page, '05-material-applied.png');
	await page.evaluate(() => window.__tp.test.v1.inspectorClose?.set(true));

	// ---- 7. a Poly Haven texture set -> a preset ------------------------------------------------
	await openTab(page, 'textures');
	await page.locator(`.ab-card[data-asset-id="${texture}"] [data-act="library"]`).click();
	await waitHeldOrError(page, texture, 120000);
	const presets7 = await store(page, 'materialPresets.materialPresets');
	const p7 = presets7.find((p) => p.payload?.source?.id === texture);
	h.check(!!p7 && p7.payload.map === '[data]' && p7.payload.source.site === 'polyhaven', `7.1 a texture set becomes a preset with its maps + source (${await cardError(page, texture)})`);

	// ---- 8. errors -------------------------------------------------------------------------------
	net.state.phStatus = 503;
	await openTab(page, 'models');
	await page.click('#asset-browser-refresh');
	await page.waitForSelector('#asset-browser-stale', { timeout: 15000 }).catch(() => {});
	const stale = await page.$eval('#asset-browser-stale', (e) => e.textContent?.replace(/\s+/g, ' ').trim()).catch(() => '');
	h.check(/saved/.test(stale ?? '') && /503/.test(stale ?? '') && (await grid(page))?.count === 3, `8.1 the site down: the saved list stays, and the banner says so (${stale})`);
	// a tab never saved: the cache entry is dropped first
	await page.evaluate(async () => {
		const { idbKeys, idbDelete } = window.__tp.test.v1.idb; // the debug hook: a deployed build has no /src paths
		for (const k of await idbKeys()) if (String(k).startsWith('cc0:') && /t=hdris|categories\/hdris/.test(String(k))) await idbDelete(k);
		window.__tp.test.v1.cc0Fetch.forgetCc0Memo();
	});
	await openTab(page, 'hdris');
	const err8 = await page.$eval('#asset-browser-status[data-state=error]', (e) => e.textContent?.replace(/\s+/g, ' ').trim()).catch(() => '');
	h.check(/503/.test(err8 ?? '') && /Try again/.test(err8 ?? ''), `8.2 nothing saved + the site down: a clear message with Try again (${err8})`);
	await shot(page, '06-api-error.png');
	net.state.phStatus = 200;
	await page.getByRole('button', { name: 'Try again' }).click();
	await page.waitForFunction(() => Number(document.querySelector('#asset-browser-grid')?.dataset.count) > 0, null, { timeout: 15000 }).catch(() => {});
	h.check((await grid(page))?.count === 2, '8.3 Try again recovers once the site answers');
	net.state.relayStatus = 502;
	await openTab(page, 'materials');
	await page.fill('#asset-browser-search', 'zzz-never-asked');
	await page.waitForSelector('#asset-browser-status[data-state=error]', { timeout: 10000 }).catch(() => {});
	const err8r = await page.$eval('#asset-browser-status[data-state=error]', (e) => e.textContent?.replace(/\s+/g, ' ').trim()).catch(() => '');
	h.check(/relay/.test(err8r ?? '') && /502/.test(err8r ?? ''), `8.4 the relay down: it says the relay did not answer (${err8r})`);
	net.state.relayStatus = 200;
	await page.fill('#asset-browser-search', '');
	await openTab(page, 'models');
	await A.ctx.setOffline(true);
	net.state.offline = true;
	await page.waitForTimeout(500);
	const off = await page.$eval('#asset-browser-stale', (e) => e.textContent?.replace(/\s+/g, ' ').trim()).catch(() => '');
	h.check(/offline/i.test(off ?? ''), `8.5 offline: the banner says so (${off})`);
	await page.locator(`.ab-card[data-asset-id="potted_plant_02"] [data-act="library"]`).click();
	await waitHeldOrError(page, 'potted_plant_02', 15000);
	const errOff = await cardError(page, 'potted_plant_02');
	h.check(/offline/i.test(errOff), `8.6 offline: a download says why it cannot happen (${errOff})`);
	await shot(page, '07-offline.png');
	await A.ctx.setOffline(false);
	net.state.offline = false;

	// ---- 9. docks like the other hosted windows ---------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.dockHost.setHostedDocked('assets', true));
	await page.waitForTimeout(1200);
	const docked = await page.evaluate(() => {
		let v;
		window.__tp.test.v1.dockHost.hostedTabsOpen.subscribe((x) => (v = x))();
		return { tab: !!v.assets, inDock: !!document.querySelector('#asset-browser-window')?.closest('[data-pd-host], .pd-body, #bottom-dock, [data-dock-body]') || !!document.querySelector('[data-pd-host="assets"]') };
	});
	h.check(docked.tab, `9.1 it docks as a hosted tab (${JSON.stringify(docked)})`);
	await shot(page, '08-docked.png');
	await page.evaluate(() => window.__tp.test.v1.dockHost.setHostedDocked('assets', false));

	// ---- 10. a phone ---------------------------------------------------------------------------
	const C = await h.setupPageQuiet(browser, 'C', [A, B], { context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, isMobile: true, hasTouch: true } });
	await net.routes(C.page);
	await C.page.evaluate(() => window.__tp.test.v1.cc0State.openAssetBrowser());
	await C.page.waitForFunction(() => Number(document.querySelector('#asset-browser-grid')?.dataset.count) > 0, null, { timeout: 30000 }).catch(() => {});
	const phone = await C.page.evaluate(() => {
		const w = document.querySelector('#asset-browser-window');
		const r = w?.getBoundingClientRect();
		const cols = getComputedStyle(document.querySelector('#asset-browser-grid')).gridTemplateColumns.split(' ').length;
		return { left: r?.left, right: r?.right, bottom: r?.bottom, top: r?.top, vw: innerWidth, vh: innerHeight, cols, shell: document.documentElement.classList.contains('phone-shell') };
	});
	h.check(phone.shell && Math.abs(phone.left) < 2 && Math.abs(phone.right - phone.vw) < 2 && phone.bottom <= phone.vh + 1 && phone.top > 0, `10.1 a phone: a full-width bottom sheet (${JSON.stringify(phone)})`);
	h.check(phone.cols === 2, '10.2 two columns of cards');
	h.check((await C.page.getAttribute('#asset-browser-res-1k', 'aria-checked')) === 'true', '10.3 a phone defaults to 1k');
	await shot(C.page, '09-phone.png');

	await h.finish(browser);
});
