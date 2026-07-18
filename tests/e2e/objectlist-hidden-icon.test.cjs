// Phase 171: the object list marks hidden objects with a persistent eye-slash
// icon (the eye toggle only shows on hover), so hidden rows read at a glance.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = g.children[g.children.length - 1].uuid;
	});
	await A.page.waitForTimeout(400);

	const markers = () => A.page.locator('#object-list .hidden-marker').count();
	const before = await markers();

	await A.page.evaluate(() => window.__stores.objectActions.toggleObjectVisibility(window.__box));
	await A.page.waitForTimeout(300);
	const afterHide = await markers();

	await A.page.evaluate(() => window.__stores.objectActions.toggleObjectVisibility(window.__box));
	await A.page.waitForTimeout(300);
	const afterShow = await markers();

	h.check(before === 0, 'no hidden markers when everything is visible');
	h.check(afterHide >= 1, 'hiding an object shows a persistent hidden marker in its row');
	h.check(afterShow === 0, 'showing it again clears the marker');

	await h.finish(browser);
});
