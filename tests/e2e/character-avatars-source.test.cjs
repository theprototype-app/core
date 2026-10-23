// 57 M5 — the Asset Browser's Avatars tab (the Open Source Avatars registry): CC0 collections list by
// default, CC-BY ones only when asked, "Add to scene" places the VRM as a character, and a CC-BY
// avatar keeps its credit — Export then asks for it. The registry and the files are ROUTED to local
// fixtures (a VRM built in-test), so the suite needs no network.
const h = require('./helpers.cjs');
const { mixamoGlb, toVrm } = require('./characterFixtures.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const { page } = A;
	const vrm = Buffer.from(
		toVrm(await mixamoGlb(page, { hair: true }), {
			version: '0',
			meta: { licenseName: 'CC0', commercialUssageName: 'Allow', title: 'Fixture' }
		})
	);
	const projects = [
		{
			id: 'free-set',
			name: 'Free Set',
			creator_id: 'Test-Maker',
			license: 'CC0',
			avatar_data_file: 'avatars/free-set.json'
		},
		{
			id: 'credit-set',
			name: 'Credit Set',
			creator_id: 'Credit-Maker',
			license: 'CC-BY',
			avatar_data_file: 'avatars/credit-set.json'
		}
	];
	const avatar = (id, name) => ({
		id,
		name,
		format: 'VRM',
		is_public: true,
		is_draft: false,
		model_file_url: 'https://arweave.net/' + id,
		thumbnail_url: ''
	});
	const lists = {
		'free-set': [avatar('free1', 'Freebie'), avatar('free2', 'Freebie Two')],
		'credit-set': [avatar('cred1', 'Credited')]
	};
	let registryHits = 0;
	await page.route(
		/cdn\.jsdelivr\.net\/gh\/ToxSam\/open-source-avatars@[0-9a-f]+\/data\/.*/,
		(route) => {
			registryHits++;
			const url = route.request().url();
			if (url.endsWith('/projects.json'))
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(projects)
				});
			const m = url.match(/avatars\/([\w-]+)\.json$/);
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(lists[m?.[1]] ?? [])
			});
		}
	);
	await page.route(/arweave\.net\/(free1|free2|cred1)$/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/octet-stream',
			body: vrm,
			headers: { 'access-control-allow-origin': '*' }
		})
	);

	await page.evaluate(() => window.__stores.cc0State.assetBrowserOpen.set(true));
	await page.waitForSelector('#asset-browser-window', { timeout: 20000 });
	await page.click('#asset-browser-tab-avatars');
	await h.eventually(
		() => page.locator('#asset-browser-grid .ab-card').count(),
		(n) => n === 2,
		'Avatars: the two CC0 avatars list by default (the CC-BY one does not)'
	);
	h.check(registryHits >= 2, 'the registry was read through the pinned CDN path');
	await page.check('#asset-browser-ccby');
	await h.eventually(
		() => page.locator('#asset-browser-grid .ab-card').count(),
		(n) => n === 3,
		'Include CC-BY: the credited one joins'
	);
	const by = await page
		.locator('#asset-browser-grid .ab-card[data-asset-id="cred1"] .ab-by')
		.textContent();
	h.check(/CC-BY-4\.0/.test(by ?? ''), `the card says its licence (${by})`);

	await page.click('#asset-browser-grid .ab-card[data-asset-id="cred1"] [data-act="place-avatar"]');
	const uuidOf = () =>
		page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.objectsGroup.subscribe((g) =>
						r(g?.children.find((c) => c.name === 'Credited')?.uuid ?? null)
					)()
				)
		);
	await h.eventually(uuidOf, (u) => !!u, 'Add to scene: the avatar is placed');
	const u = await uuidOf();
	h.check(
		(await page.evaluate((u) => window.__stores.animatedImports.animatedImportKind(u), u)) ===
			'vrm',
		'as a VRM character'
	);
	const lic = await page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(window.__stores.provenance.licenceOf(g.getObjectByProperty('uuid', u).userData))
				)()
			),
		u
	);
	h.check(
		lic?.id === 'CC-BY-4.0' && lic.author === 'Credit Maker' && lic.credit === true,
		`it keeps its credit (${JSON.stringify(lic)})`
	);

	const ex = await page.evaluate(() => {
		const s = window.__stores.exportStores;
		s.publishExportTab.set('export');
		s.publishExportOpen.set(true);
		return true;
	});
	await page.waitForSelector('#licence-warnings-export', { timeout: 20000 });
	const text = await page.evaluate(
		() => document.querySelector('#licence-warnings-export')?.textContent ?? ''
	);
	h.check(
		ex && /Credited/.test(text) && /credit Credit Maker/.test(text),
		`Export asks for the credit (${text.replace(/\s+/g, ' ').slice(0, 120)})`
	);

	await h.finish(browser);
});
