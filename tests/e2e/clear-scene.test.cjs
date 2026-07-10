// Phase 61: clear scene v2 — confirmation, replicates to peers, module content clears.
const h = require('./helpers.cjs');

const childCount = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children.length ?? -1))())
	);

const pianoPresent = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalScene.subscribe((s) => r(!!s?.getObjectByName('piano-module')))()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// content everywhere: objects from both sides + piano module content
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await B.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create sphere 1'));
	await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.moduleSDK.moduleMenuItems.subscribe((items) => {
					items.find((i) => i.label === 'Piano: spawn / remove')?.action();
					resolve();
				})();
			})
	);
	await h.eventually(() => childCount(B.page), (n) => n === 2, 'both objects on B');
	await h.eventually(() => pianoPresent(B.page), (v) => v === true, 'piano content on B');

	// clear via the sidebar with the confirmation toast
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(400);
	await A.page.getByText('Clear Scene', { exact: true }).click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.getByText(/Clear the scene for everyone/).isVisible(),
		'confirmation toast appears'
	);

	// cancel first — nothing happens
	await A.page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await A.page.waitForTimeout(400);
	h.check((await childCount(A.page)) === 2, 'cancel keeps the scene');

	// confirm — everything clears on BOTH peers, including module content
	await A.page.getByText('Clear Scene', { exact: true }).click();
	await A.page.waitForTimeout(300);
	await A.page.getByRole('button', { name: 'Clear', exact: true }).click();
	await h.eventually(() => childCount(A.page), (n) => n === 0, 'objects cleared on A');
	await h.eventually(() => childCount(B.page), (n) => n === 0, 'clear replicated to B');
	await h.eventually(() => pianoPresent(A.page), (v) => v === false, 'module content cleared on A');
	await h.eventually(() => pianoPresent(B.page), (v) => v === false, 'module content cleared on B');

	// B gets told who did it
	const toasts = await B.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.toastStore.subscribe((t) =>
					r(t.map((x) => (typeof x === 'string' ? x : x.text)).join('|'))
				)()
			)
	);
	h.check(toasts.includes('cleared the scene'), 'peers see who cleared');

	await h.finish(browser);
});
