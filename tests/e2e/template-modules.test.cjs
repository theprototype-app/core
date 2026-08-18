// A6.2: a scene declares which MODULES its flow needs, and the player is told before
// the scene lands looking broken.
//
// Two halves:
//   - the requirement is DERIVED from what the flow actually uses (never from what
//     happens to be installed), and shares the handshake's {id, version} shape
//   - the prompt runs after the format confirm and BEFORE any restore or asset loop,
//     so a CANCELLED import mutates nothing - which is the assertion that matters,
//     because "it looked fine" is what a half-applied import also looks like
//
// The gallery is mocked hermetically (page.route on the modules CDN, discriminated by
// REPO PATH - packs.js also fetches an index.json from cdn.jsdelivr.net at boot).
//
// Run: $env:APP_URL='https://localhost:5204/'; npm run e2e -- template-modules
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'template-modules');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.moduleRequirements, { timeout: 30000 });

	// a real, installable module zip served from the mocked gallery: manifest at the
	// ZIP ROOT (a nested folder fails with "zip has no manifest.json at its root")
	const moduleJs = [
		'export default {',
		"  id: 'gizmomod',",
		"  name: 'Gizmo Module',",
		"  version: '2.1.0',",
		"  description: 'mocked gallery module',",
		'  register(api) {',
		"    api.registerNodeGroup({ group: 'Gizmo', items: [{ type: 'gizmoknob', label: 'Gizmo knob', params: [] }] });",
		"    api.registerEffect('gizmoknob', () => {});",
		'  }',
		'};'
	].join('\n');
	const manifest = JSON.stringify({
		id: 'gizmomod',
		name: 'Gizmo Module',
		version: '2.1.0',
		format: 1,
		entry: 'module.js',
		files: ['module.js']
	});

	let galleryMode = 'ready'; // 'ready' | 'missing' (module not listed)
	await page.route('**/cdn.jsdelivr.net/**', (route) => {
		const url = route.request().url();
		if (!url.includes('/theprototype-app/modules@')) return route.continue();
		if (url.endsWith('/index.json'))
			return route.fulfill({
				json:
					galleryMode === 'ready'
						? [
								{
									id: 'gizmomod',
									name: 'Gizmo Module',
									version: '2.1.0',
									description: 'mocked gallery module',
									author: 'theprototype-app',
									source: 'modules/gizmomod',
									zip: 'gizmomod.zip'
								}
							]
						: []
			});
		if (url.endsWith('/modules/gizmomod/manifest.json'))
			return route.fulfill({ body: manifest, contentType: 'application/json' });
		if (url.endsWith('/modules/gizmomod/module.js'))
			return route.fulfill({ body: moduleJs, contentType: 'text/javascript' });
		return route.continue();
	});

	// ---- 1. requirements are DERIVED from the flow ---------------------------
	// Nothing installed, nothing used: the list must be empty, or buildSessionPayload
	// would stamp a `modules` field onto every ordinary scene.
	const empty = await page.evaluate(() => window.__stores.moduleRequirements.moduleRequirements());
	h.check(empty.length === 0, 'a scene using no module nodes requires nothing (' + empty.length + ')');

	// install the module for real (the local zip path), then USE one of its nodes
	await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{
				id: 'gizmomod',
				name: 'Gizmo Module',
				version: '2.1.0',
				register(api) {
					api.registerNodeGroup({
						group: 'Gizmo',
						items: [{ type: 'gizmoknob', label: 'Gizmo knob', params: [] }]
					});
					api.registerEffect('gizmoknob', () => {});
				}
			}
		]);
	});
	await page.waitForTimeout(600);
	const installedButUnused = await page.evaluate(() =>
		window.__stores.moduleRequirements.moduleRequirements()
	);
	h.check(
		installedButUnused.length === 0,
		'an INSTALLED but unused module is still not a requirement - the list is derived from USE (' +
			JSON.stringify(installedButUnused) +
			')'
	);

	const derived = await page.evaluate(() => {
		const s = window.__stores;
		s.updateGraph(s.SCENE_GRAPH, () => ({
			nodes: [
				{ id: 'g1', type: 'gizmoknob', position: { x: 40, y: 40 }, data: { type: 'gizmoknob' } },
				{ id: 'c1', type: 'counter', position: { x: 260, y: 40 }, data: { type: 'counter' } }
			],
			edges: []
		}));
		return {
			required: s.moduleRequirements.moduleRequirements(),
			payloadModules: s.sessions.buildSessionPayload('needs gizmomod').modules ?? null,
			handshake: s.moduleSDK.moduleVersions()
		};
	});
	h.check(derived.required.length === 1 && derived.required[0].id === 'gizmomod', 'using its node makes it a requirement');
	h.check(derived.required[0].version === '2.1.0', 'carried with its version (' + derived.required[0].version + ')');
	// ONE shape for "which modules" in the whole system - the handshake's
	const shapeMatch = await page.evaluate(() => {
		const s = window.__stores;
		const req = s.moduleRequirements.moduleRequirements()[0];
		const hs = s.moduleSDK.moduleVersions().find((/** @type {any} */ m) => m.id === 'gizmomod');
		return JSON.stringify(Object.keys(req).sort()) === JSON.stringify(Object.keys(hs).sort());
	});
	h.check(shapeMatch, 'the requirement shape is byte-identical to the handshake entry');
	h.check(
		JSON.stringify(derived.payloadModules) === JSON.stringify(derived.required),
		'and the payload carries exactly that list'
	);
	h.check(
		!derived.required.some((/** @type {any} */ e) => e.id === 'counter'),
		'a CORE node type contributes no requirement'
	);

	// ---- 2. classify against this device ------------------------------------
	const classified = await page.evaluate(() => {
		const s = window.__stores;
		return {
			ready: s.moduleRequirements.classifyRequirements([{ id: 'gizmomod', version: '2.1.0' }]),
			missing: s.moduleRequirements.classifyRequirements([{ id: 'nosuchmod', version: '1.0.0' }]),
			junk: s.moduleRequirements.classifyRequirements('not a list')
		};
	});
	h.check(classified.ready.satisfied && classified.ready.ready.length === 1, 'an installed module classifies as ready');
	h.check(classified.missing.missing.length === 1 && !classified.missing.satisfied, 'an absent one classifies as missing');
	h.check(classified.junk.wanted.length === 0, 'a garbage/absent field means nothing is needed');

	// ---- 3. the prompt, and CANCEL mutates nothing --------------------------
	// A .tpscene naming a module nobody has. Import it and press Cancel: no session
	// slot may be written, because the prompt sits above finishImport for exactly this.
	const tpscene = Buffer.from(
		zipSync({
			'session.json': strToU8(
				JSON.stringify({
					format: 1,
					name: 'Needs A Module',
					count: 0,
					objects: [],
					graphs: {},
					nodes: [],
					edges: [],
					annotations: [],
					joints: [],
					camera: null,
					modules: [{ id: 'gizmomod', version: '2.1.0' }, { id: 'ghostmod', version: '1.0.0' }]
				})
			)
		})
	);
	const slotsBefore = await page.evaluate(async () => {
		await window.__stores.sessions.loadSessions();
		return new Promise((r) => window.__stores.sessions.sessions.subscribe((l) => r(l.length))());
	});
	// kick the import off without awaiting it - it blocks on the dialog
	await page.evaluate((bytes) => {
		window.__importResult = 'pending';
		window.__stores.sessions
			.importSessionZip(new Uint8Array(bytes).buffer)
			.then((p) => (window.__importResult = p ? 'applied' : 'cancelled'));
	}, Array.from(tpscene));
	await h.eventually(
		() => page.locator('#confirm-dialog-install').count(),
		(n) => n === 1,
		'a scene naming an uninstalled module prompts before anything is touched'
	);
	const promptText = await page.evaluate(
		() => new Promise((r) => window.__stores.confirmDialog.confirmDialog.subscribe((d) => r(d?.message ?? ''))())
	);
	h.check(/ghostmod/.test(promptText), 'the prompt names the missing module: ' + JSON.stringify(promptText.slice(0, 90)));
	// the sentence users would otherwise file as a bug
	h.check(/each player needs this module/i.test(promptText), 'and says installing it here installs it for THIS player only');
	h.check(
		!/gizmomod/.test(promptText.split('Each player')[0]),
		'an already-installed module is NOT listed as missing'
	);
	h.check(await page.locator('#confirm-dialog-cancel').count() === 1, 'Cancel is offered');
	await page.locator('#confirm-dialog-cancel').click();
	await h.eventually(
		() => page.evaluate(() => window.__importResult),
		(v) => v === 'cancelled',
		'Cancel resolves the import as a silent no-op'
	);
	const slotsAfter = await page.evaluate(async () => {
		await window.__stores.sessions.loadSessions();
		return new Promise((r) => window.__stores.sessions.sessions.subscribe((l) => r(l.length))());
	});
	h.check(slotsAfter === slotsBefore, 'and NO session slot was written (' + slotsBefore + ' -> ' + slotsAfter + ')');

	// ---- 4. Load anyway proceeds -------------------------------------------
	// Advisory by design: a scene the player wants to look at must never be
	// un-openable because a module is absent.
	await page.evaluate((bytes) => {
		window.__importResult = 'pending';
		window.__stores.sessions
			.importSessionZip(new Uint8Array(bytes).buffer)
			.then((p) => (window.__importResult = p ? 'applied' : 'cancelled'));
	}, Array.from(tpscene));
	await h.eventually(
		() => page.locator('#confirm-dialog-anyway').count(),
		(n) => n === 1,
		'the prompt offers Load anyway'
	);
	await page.locator('#confirm-dialog-anyway').click();
	await h.eventually(
		() => page.evaluate(() => window.__importResult),
		(v) => v === 'applied',
		'Load anyway imports the scene regardless'
	);

	// ---- 5. Install pulls from the gallery ---------------------------------
	// Reuses the Browse tab's own machinery, so there is no second install path: the
	// mocked gallery serves a real manifest + entry file and the module must LOAD.
	await page.evaluate((bytes) => {
		window.__importResult = 'pending';
		window.__stores.sessions
			.importSessionZip(new Uint8Array(bytes).buffer)
			.then((p) => (window.__importResult = p ? 'applied' : 'cancelled'));
	}, Array.from(tpscene));
	await h.eventually(
		() => page.locator('#confirm-dialog-install').count(),
		(n) => n === 1,
		'premise: the Install choice is offered again'
	);
	await page.locator('#confirm-dialog-install').click();
	await h.eventually(
		() => page.evaluate(() => window.__importResult),
		(v) => v === 'applied',
		'Install then proceeds with the import',
		25000
	);
	// ghostmod is not in the gallery at all, so it must be REPORTED, never silently
	// skipped - the honest half of "no silent caps"
	const reported = await page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.toastStore.subscribe((/** @type {any[]} */ list) =>
					r(list.map((t) => (typeof t === 'string' ? t : t.text)).join(' | '))
				)()
			)
	);
	// match the SENTENCE, not just the id: peer-server retry toasts share the stack and
	// a bare /ghostmod/ could pass off any of them
	const notInstalled = /Could not install: [^|]*ghostmod/.test(reported);
	h.check(notInstalled, 'a module the gallery does not list is reported, never silently skipped');

	// ---- 6. an ENABLE-only case -------------------------------------------
	// A module that IS installed but switched off is a different answer: nothing to
	// download, just a flag to flip.
	await page.evaluate(() => {
		window.__stores.moduleSDK.disabledModules.set(['gizmomod']);
	});
	await page.waitForTimeout(300);
	const offClass = await page.evaluate(() =>
		window.__stores.moduleRequirements.classifyRequirements([{ id: 'gizmomod', version: '2.1.0' }])
	);
	h.check(offClass.disabled.length === 1 && !offClass.satisfied, 'a switched-off module classifies as disabled, not missing');
	const onlyDisabled = Buffer.from(
		zipSync({
			'session.json': strToU8(
				JSON.stringify({
					format: 1,
					name: 'Needs It On',
					count: 0,
					objects: [],
					graphs: {},
					nodes: [],
					edges: [],
					modules: [{ id: 'gizmomod', version: '2.1.0' }]
				})
			)
		})
	);
	await page.evaluate((bytes) => {
		window.__importResult = 'pending';
		window.__stores.sessions
			.importSessionZip(new Uint8Array(bytes).buffer)
			.then((p) => (window.__importResult = p ? 'applied' : 'cancelled'));
	}, Array.from(onlyDisabled));
	await h.eventually(
		() => page.locator('#confirm-dialog-enable').count(),
		(n) => n === 1,
		'a disabled-only requirement offers Enable and no Install'
	);
	h.check(await page.locator('#confirm-dialog-install').count() === 0, 'with nothing to download, Install is not offered');
	await page.locator('#confirm-dialog-enable').click();
	await h.eventually(
		() => page.evaluate(() => new Promise((r) => window.__stores.moduleSDK.disabledModules.subscribe((l) => r(l))())),
		(list) => !list.includes('gizmomod'),
		'Enable switches it back on'
	);

	h.check(h.pageErrors(peer).length === 0, 'no page errors: ' + h.pageErrors(peer).join(' | '));
	await h.finish(browser);
});
