// Phase 197: Explorer tree reorg. Library is always open (no caret) with its
// folders + New folder scrolling at the top; Prefabs/Packs/Scene are pinned
// BELOW the New folder button, and Scene's sub-groups always show (no caret).
// (Replaces the phase-178 Library/Scene collapse carets, which were removed.)
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

	// Library/Scene no longer have section carets; their contents always show
	h.check((await A.page.locator('#library-caret').count()) === 0, 'Library has no section caret (always open)');
	h.check((await A.page.locator('#scene-caret').count()) === 0, 'Scene has no section caret');
	h.check(await folderRow().isVisible(), 'a Library folder always shows');
	// Scene is collapsed by default; double-clicking it reveals the sub-groups
	h.check(!(await sceneSub().isVisible()), 'Scene sub-groups hidden by default');
	await A.page.locator('#scene-folder').dblclick();
	await A.page.waitForTimeout(200);
	h.check(await sceneSub().isVisible(), 'double-click Scene reveals its sub-groups');

	// Prefabs/Packs/Scene are pinned BELOW the New folder button (DOM order)
	const order = await A.page.evaluate(() => {
		const html = document.querySelector('#explorer-tree').innerHTML;
		return {
			newFolder: html.indexOf('New folder'),
			prefabs: html.indexOf('prefabs-folder'),
			scene: html.indexOf('scene-folder')
		};
	});
	h.check(
		order.newFolder >= 0 && order.prefabs > order.newFolder && order.scene > order.newFolder,
		'Prefabs + Scene sit below the New folder button'
	);

	await h.finish(browser);
});
