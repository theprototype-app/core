// 36 F20 / F21 — A SUPERSEDED LOAD MUST NEVER WIN, AND A LOAD SAYS SO FROM THE CLICK.
//
// The report (1.23, production): "I opened Island Ocean (slow first load, no clear progress), then
// opened another level; later the island finished and REPLACED the level I had opened."
//
// Reproduced on 1.23.0 with this suite: `loadRemoteScene` downloaded, unzipped and asked its dialogs
// BEFORE `applySession` began a load job, so the click owned nothing while it waited — a second
// scene opened meanwhile loaded and finished, and then the first one's apply started as the
// newest load of all and replaced it. Nothing was on screen during the download either (the modal
// closes on the click and the bar only existed once the apply began).
//
//   1. Templates ▸ Examples ▸ "Slow island" (its download held 4 s): the bar says "Loading Slow
//      island" within a second, in the fetching phase (F21).
//   2. Open "Quick room" meanwhile: it loads; when the island's bytes arrive 4 s later the scene is
//      STILL the room, with no island object, and no bar left up (F20).
//   3. The bar has no Cancel button (36 S5); an un-superseded load applies normally.
//   4. A scene whose animated rig is still downloading is superseded: the rig never lands in the
//      newer scene (the restore had no job guard).
//   5. Two Sessions-manager style requests in a row (requestLoadSession): only the second applies.
//
// Hermetic: the scenes feed is mocked (page.route on the jsDelivr scenes path), the scenes are
// real .tpscene zips built in the page.
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');

const HOLD_MS = 4000;

const names = (page) =>
	page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return (group?.children ?? []).map((c) => c.name);
	});
const loadJob = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.sceneLoader.sceneLoad.subscribe((x) => (v = x))();
		return v ? { name: v.name, phase: v.phase } : null;
	});

h.run(async () => {
	// GPU backend: on software GL this page draws ~4 frames a second and every click waits
	// seconds for the element to be stable — longer than the held download it races
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// -- real session payloads, built with the page's own THREE (current format)
	const scenes = await page.evaluate(() => {
		const s = window.__stores;
		const mk = (name, x) => {
			const m = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial({ color: 0x88aaff }));
			m.name = name;
			m.position.set(x, 0.5, 0);
			return m.toJSON();
		};
		const payload = (name, objs) => ({ format: 1, name, count: objs.length, objects: objs, nodes: [], edges: [], annotations: [], joints: [], camera: null });
		return {
			island: payload('Slow island', [mk('islandA', 0), mk('islandB', 2)]),
			room: payload('Quick room', [mk('roomA', -2), mk('roomB', -4)])
		};
	});
	const zip = (payload) => Buffer.from(zipSync({ 'session.json': strToU8(JSON.stringify(payload)) }));
	const islandZip = zip(scenes.island);
	const roomZip = zip(scenes.room);

	// THE HOLD LIVES IN THE PAGE: a route handler that awaits a timer stalls every later
	// Playwright action for as long as it waits (measured: each click took the whole hold), so
	// the page's own fetch waits instead — the request is then served at once, after the hold
	await page.evaluate((hold) => {
		const real = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = String(input?.url ?? input);
			if (/__f20\/rig\.gltf/.test(url)) window.__f20RigAsked = true;
			if (/slow-island\/scene\.tpscene|__f20\/rig\.gltf/.test(url)) await new Promise((r) => setTimeout(r, hold));
			return real(input, init);
		};
	}, HOLD_MS);
	let islandHeld = 0; // how many island downloads were served (after the hold)
	await page.route('**/cdn.jsdelivr.net/**', async (route) => {
		const url = route.request().url();
		if (!url.includes('/theprototype-app/scenes@')) return route.continue();
		if (url.endsWith('/index.json'))
			return route.fulfill({
				json: {
					version: 2,
					templates: [],
					examples: [
						{ slug: 'slow-island', title: 'Slow island', description: 'held download', scene: 'examples/slow-island/scene.tpscene', license: 'CC0-1.0', tags: [] },
						{ slug: 'quick-room', title: 'Quick room', description: 'fast', scene: 'examples/quick-room/scene.tpscene', license: 'CC0-1.0', tags: [] }
					],
					games: []
				}
			});
		if (url.includes('slow-island/scene.tpscene')) {
			islandHeld++;
			return route.fulfill({ body: islandZip, contentType: 'application/zip' });
		}
		if (url.includes('quick-room/scene.tpscene')) return route.fulfill({ body: roomZip, contentType: 'application/zip' });
		if (url.endsWith('.webp')) return route.fulfill({ status: 404 });
		return route.continue();
	});

	const openExamples = async () => {
		await page.locator('#logo-menu').click();
		await page.waitForTimeout(250);
		await page.locator('#open-templates').click();
		await page.locator('#templates-tab-examples').click();
		await h.eventually(() => page.locator('[data-scene-slug="quick-room"]').isVisible(), (v) => v === true, 'example cards render', 10000);
	};

	// ---- 1 + 2: the reported sequence -------------------------------------------------------
	await openExamples();
	const t0 = Date.now();
	await page.locator('[data-scene-slug="slow-island"]').click();
	// F21: the click owns a visible load at once — before a single byte arrived
	await h.eventually(() => loadJob(page), (v) => !!v, 'a load job exists while the island downloads', 1500);
	const early = await loadJob(page);
	h.check(early?.name === 'Slow island' && early?.phase === 'fetching', `the job is the island, fetching (${JSON.stringify(early)})`);
	await h.eventually(() => page.locator('#scene-load-bar').isVisible(), (v) => v === true, 'the load bar is on screen during the download', 2000);
	const barText = (await page.locator('#scene-load-bar').innerText()).replace(/\s+/g, ' ');
	h.check(/Slow island/.test(barText) && /download/i.test(barText), `the bar says what it is doing ("${barText}")`);

	// the user opens another level while the island is still downloading
	await openExamples();
	await page.locator('[data-scene-slug="quick-room"]').click();
	await h.eventually(
		() => names(page),
		(n) => n.includes('roomA') && n.includes('roomB'),
		'the room loads while the island is still downloading',
		15000
	);
	h.check(Date.now() - t0 < HOLD_MS, `premise: the room landed before the island's bytes (${Date.now() - t0} ms < ${HOLD_MS})`);
	// the island's download completes now — and must change nothing
	await h.eventually(() => Promise.resolve(islandHeld), (n) => n >= 1, 'the island download was served', HOLD_MS + 3000);
	await page.waitForTimeout(2500);
	const after = await names(page);
	h.check(after.includes('roomA') && !after.includes('islandA') && !after.includes('islandB'), `the room is still the scene (${after.join(',')})`);
	h.check((await loadJob(page)) === null, 'no load bar left up');

	// ---- 3: no Cancel button (36 S5): opening another scene is how a load is abandoned -------
	await openExamples();
	await page.locator('[data-scene-slug="slow-island"]').click();
	await h.eventually(() => page.locator('#scene-load-bar').isVisible(), (v) => v === true, 'the bar is up during the download', 2000);
	h.check((await page.locator('#scene-load-cancel').count()) === 0, 'the load bar offers no Cancel button (S5)');
	const served = islandHeld;
	await h.eventually(() => Promise.resolve(islandHeld), (n) => n > served, 'the island download completes', HOLD_MS + 3000);
	await h.eventually(() => names(page), (n) => n.includes('islandA'), 'an un-superseded load applies normally', 8000);

	// ---- 4: an animated rig still downloading when a newer load supersedes --------------------
	const rigGltf = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'rig-node' }] }));
	let rigServed = 0;
	await page.route('**/__f20/rig.gltf', (route) => {
		rigServed++;
		return route.fulfill({ body: rigGltf, contentType: 'model/gltf+json' });
	});
	const rigUuid = 'f20f20f2-0000-4000-8000-000000000001';
	await page.evaluate(
		({ island, rigUuid }) => {
			const rigged = {
				...island,
				name: 'Rigged island',
				animated: [{ uuid: rigUuid, name: 'Slow rig', kind: 'gltf', animRef: { pack: 'f20', item: 'rig', path: location.origin + '/__f20/rig.gltf' } }]
			};
			// not awaited: the newer load below supersedes it while the rig downloads
			window.__stores.sessions.applySession(rigged, { backup: false, quiet: true });
		},
		{ island: scenes.island, rigUuid }
	);
	await h.eventually(() => names(page), (n) => n.includes('islandA'), 'the rigged island built its objects', 8000);
	// supersede only once the rig is really on its way: the parse-side guard is what is tested
	await h.eventually(() => page.evaluate(() => window.__f20RigAsked === true), (v) => v, 'premise: the rig download has started', 8000);
	await page.evaluate((room) => window.__stores.sessions.applySession(room, { backup: false, quiet: true }), scenes.room);
	await h.eventually(() => names(page), (n) => n.includes('roomA') && !n.includes('islandA'), 'the newer room replaced the island', 8000);
	await h.eventually(() => Promise.resolve(rigServed), (n) => n >= 1, 'the rig download was served', 6000);
	await page.waitForTimeout(1500);
	const rigLanded = await page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return !!group.getObjectByProperty('uuid', uuid);
	}, rigUuid);
	h.check(!rigLanded, 'the superseded scene\'s rig never lands in the newer scene');

	// ---- 5: two Sessions requests — the second one wins --------------------------------------
	const order = await page.evaluate(async ({ island, room }) => {
		const s = window.__stores.sessions;
		// slow the FIRST request down the way an idb read / a dialog would: its payload is
		// handed to requestLoadPayload only after a delay, while the second goes straight on
		const { claimLoad } = window.__stores.sceneLoader;
		const first = (async () => {
			const job = claimLoad ? claimLoad('first') : undefined; // (absent on 1.23.0: the repro run)
			await new Promise((r) => setTimeout(r, 1500));
			return s.requestLoadPayload({ ...island, name: 'First' }, { job });
		})();
		await new Promise((r) => setTimeout(r, 100));
		const second = s.requestLoadPayload({ ...room, name: 'Second' });
		return { first: await first, second: await second };
	}, scenes);
	await page.waitForTimeout(800);
	const after5 = await names(page);
	h.check(order.second === true && order.first === false, `the newer request applies, the older reports it did not (${JSON.stringify(order)})`);
	h.check(after5.includes('roomA') && !after5.includes('islandA'), `the older request replaced nothing (${after5.join(',')})`);

	h.check(h.pageErrors(A).length === 0, 'no page errors (' + h.pageErrors(A).join(' | ') + ')');
	await h.finish(browser);
});
