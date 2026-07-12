// Phase 178: the Explorer tree's Library and Scene sections have expand/collapse
// carets; collapsing hides their children; the state persists to localStorage.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	await A.page.evaluate(() => window.__stores.explorer.createFolder('MyFolder', null));
	await A.page.waitForTimeout(300);

	const folderRow = () => A.page.locator('#explorer-tree button', { hasText: 'MyFolder' });
	const sceneSub = () => A.page.locator('#explorer-tree button', { hasText: 'audio' });

	// both sections expanded by default
	h.check(await A.page.locator('#library-caret').isVisible(), 'Library has an expand caret');
	h.check(await A.page.locator('#scene-caret').isVisible(), 'Scene has an expand caret');
	h.check(await folderRow().isVisible(), 'a Library folder shows while expanded');
	h.check(await sceneSub().isVisible(), 'Scene sub-entries show while expanded');

	// collapse Library -> its folders hide
	await A.page.locator('#library-caret').click();
	await A.page.waitForTimeout(200);
	h.check(!(await folderRow().isVisible()), 'collapsing Library hides its folders');
	h.check(await sceneSub().isVisible(), 'collapsing Library leaves Scene alone');

	// collapse Scene -> its sub-entries hide
	await A.page.locator('#scene-caret').click();
	await A.page.waitForTimeout(200);
	h.check(!(await sceneSub().isVisible()), 'collapsing Scene hides its sub-entries');

	// persisted
	const persisted = await A.page.evaluate(() => ({
		lib: localStorage.getItem('explorerLibraryExpanded'),
		scene: localStorage.getItem('explorerSceneExpanded')
	}));
	h.check(persisted.lib === 'false' && persisted.scene === 'false', 'collapsed state persists to localStorage');

	// re-expand Library restores the folder
	await A.page.locator('#library-caret').click();
	await A.page.waitForTimeout(200);
	h.check(await folderRow().isVisible(), 're-expanding Library restores its folders');

	await h.finish(browser);
});
