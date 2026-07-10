// Phase 50: sessions — save/load solo, proposal flow with peers (accept +
// decline), selective object import, export/import round-trip.
const h = require('./helpers.cjs');

const objectNames = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r((g?.children ?? []).map((c) => c.name))
				)()
			)
	);
const sessionList = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.sessions.sessions.subscribe(r)())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// build a small scene and save it
	await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create sphere 1');
		await new Promise((r) => setTimeout(r, 300));
		await window.__stores.sessions.saveSession('SceneOne');
	});
	let list = await sessionList(A.page);
	h.check(list.length === 1 && list[0].name === 'SceneOne' && list[0].count === 2, 'session saved with meta');
	h.check(!!list[0].thumbnail, 'thumbnail rendered');

	// clear, then solo load applies immediately (and stashes nothing extra — scene was empty)
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(300);
	await A.page.evaluate((id) => window.__stores.sessions.requestLoadSession(id), list[0].id);
	await h.eventually(
		() => objectNames(A.page),
		(names) => names.includes('Box') && names.includes('Sphere'),
		'solo load restored the scene'
	);

	// selective import: bring only the Box in as a fresh copy
	const before = (await objectNames(A.page)).length;
	await A.page.evaluate(async (id) => {
		const s = window.__stores.sessions;
		const payload = await s.getSession(id);
		const entries = s.sessionObjectList(payload);
		const box = entries.find((e) => e.name === 'Box');
		s.importObjects(payload, [box.index]);
	}, list[0].id);
	await h.eventually(
		() => objectNames(A.page),
		(names) => names.length === before + 1,
		'selective import added exactly one object'
	);

	// export → import round-trip creates a second slot
	await A.page.evaluate(async (id) => {
		const s = window.__stores.sessions;
		const payload = await s.getSession(id);
		const json = s.exportSession(payload);
		await s.importSession(json);
	}, list[0].id);
	list = await sessionList(A.page);
	h.check(list.length === 2, 'export/import round-trip created a new slot');

	// ---- proposal flow with a connected peer ----
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await A.page.waitForTimeout(500);

	// B declines first: nothing changes on B
	const target = list.find((s) => s.name === 'SceneOne');
	await A.page.evaluate((id) => window.__stores.sessions.requestLoadSession(id), target.id);
	await B.page.waitForTimeout(800);
	h.check(
		await B.page.getByText(/wants to load session/).isVisible(),
		'B sees the proposal toast'
	);
	await B.page.getByRole('button', { name: 'Decline', exact: true }).click();
	await A.page.waitForTimeout(800);
	h.check(
		await A.page.getByText(/declined the session load/).isVisible(),
		'A is told about the decline'
	);

	// then B accepts: the load applies and replicates
	await A.page.evaluate((id) => window.__stores.sessions.requestLoadSession(id), target.id);
	await B.page.waitForTimeout(800);
	await B.page.getByRole('button', { name: 'Accept', exact: true }).click();
	await h.eventually(
		() => Promise.all([objectNames(A.page), objectNames(B.page)]),
		([a, b]) =>
			a.filter((n) => n === 'Box').length === 1 &&
			a.includes('Sphere') &&
			b.filter((n) => n === 'Box').length === 1 &&
			b.includes('Sphere'),
		'accepted load replaced the scene on both peers',
		15000
	);

	await h.finish(browser);
});
