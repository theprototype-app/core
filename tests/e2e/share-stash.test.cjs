// Phase 50.4: share-or-stash on connect — merging two NON-empty scenes asks
// each side about its own objects; Share keeps the normal sync, Stash saves a
// session and joins clean (no deletes broadcast).
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

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	// both sides own objects BEFORE connecting
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere 1');
	});
	await B.page.evaluate(() =>
		window.__stores.commandsHandler.sceneCommand('/create Cylinder 1 1 2')
	);
	await A.page.waitForTimeout(400);

	await h.connect(B, A);

	// each side gets the question about ITS objects
	await h.eventually(
		() => A.page.getByText(/Share your 2 objects/).isVisible().catch(() => false),
		(v) => v === true,
		'A asked about its 2 objects'
	);
	await h.eventually(
		() => B.page.getByText(/Share your 1 object\b/).isVisible().catch(() => false),
		(v) => v === true,
		'B asked about its 1 object'
	);

	// A shares, B stashes
	await A.page.getByRole('button', { name: 'Share', exact: true }).click();
	await B.page.getByRole('button', { name: 'Stash', exact: true }).click();

	await h.eventually(
		() => Promise.all([objectNames(A.page), objectNames(B.page)]),
		([a, b]) =>
			a.length === 2 &&
			a.includes('Box') &&
			a.includes('Sphere') &&
			!a.includes('Cylinder') &&
			b.length === 2 &&
			b.includes('Box') &&
			b.includes('Sphere'),
		'both converge on the shared objects only',
		15000
	);

	// B keeps its cylinder one click away in Sessions
	const stash = await B.page.evaluate(async () => {
		await window.__stores.sessions.loadSessions();
		const list = await new Promise((r) =>
			window.__stores.sessions.sessions.subscribe(r)()
		);
		return list.find((s) => s.name.startsWith('Stashed before joining'));
	});
	h.check(!!stash && stash.count === 1, 'stash session saved with the cylinder');

	await h.finish(browser);
});
