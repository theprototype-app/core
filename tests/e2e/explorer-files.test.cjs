// Phase 107: file UX — click shows properties in the Inspector, double-click
// opens the floating code editor (Ctrl+S saves back, hash changes) or the
// zoomable image preview; the shared CodeMirror is dark now.
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(500);
	await A.page.evaluate(async (png) => {
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		await window.__stores.explorer.importFiles(
			[
				new File([bytes], 'pixel.png', { type: 'image/png' }),
				new File([new Blob(['line one\nline two\nline three'])], 'notes.txt', { type: 'text/plain' })
			],
			null
		);
	}, TINY_PNG);
	await A.page.waitForTimeout(900);

	// 197 note: single-click SELECTS; the Properties (ⓘ) panel shows the details
	// once it's open (via its tab or right-click Properties). Open the tab, pick.
	await A.page.locator('[data-ws-mode="props"]').first().click();
	await A.page.waitForTimeout(200);
	await A.page.locator('.explorer-card', { hasText: 'notes.txt' }).click();
	await A.page.waitForTimeout(700);
	const props = await A.page.evaluate(() => {
		const panel = document.querySelector('.ws-panel-secondary');
		return { open: !!panel, text: panel?.textContent ?? '' };
	});
	h.check(props.open && props.text.includes('notes.txt'), 'selecting a file shows it in the Properties panel');
	h.check(/Kind/.test(props.text) && /text/i.test(props.text), `properties show Kind + type (${props.open})`);

	// double-click text -> floating dark editor; Ctrl+S saves (hash changes)
	const hashBefore = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.explorer.explorerItems.subscribe((items) =>
					resolve(items.find((i) => i.name === 'notes.txt')?.hash)
				)();
			})
	);
	await A.page.locator('.explorer-card', { hasText: 'notes.txt' }).dblclick();
	await A.page.waitForTimeout(1200);
	h.check(await A.page.locator('#text-editor-window').isVisible(), 'double-click opens the floating editor');
	const darkEditor = await A.page.evaluate(() => {
		const cm = document.querySelector('#text-editor-window .cm-editor');
		return cm ? getComputedStyle(cm).backgroundColor : '';
	});
	h.check(darkEditor.includes('17, 24, 39'), `the editor is dark (${darkEditor})`);
	await A.page.locator('#text-editor-window .cm-content').click();
	await A.page.keyboard.type('added ');
	await A.page.keyboard.press('Control+s');
	await A.page.waitForTimeout(600);
	const hashAfter = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.explorer.explorerItems.subscribe((items) =>
					resolve(items.find((i) => i.name === 'notes.txt')?.hash)
				)();
			})
	);
	h.check(hashBefore !== hashAfter, 'Ctrl+S saves back (hash recomputed)');
	const savedText = await A.page.evaluate(async () => {
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		const blob = await window.__stores.explorer.itemBlob(items.find((i) => i.name === 'notes.txt').id);
		return blob.text();
	});
	h.check(/added /.test(savedText), 'edited content round-trips');
	await A.page.locator('#text-editor-window button[title="Close"]').click();

	// double-click image -> preview window with zoom
	await A.page.locator('.explorer-card', { hasText: 'pixel.png' }).dblclick();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#image-preview-window').isVisible(), 'image preview window opens');
	await A.page.locator('#image-preview-window button[title="Zoom in"]').click();
	await A.page.locator('#image-preview-window button[title="Zoom in"]').click();
	await A.page.waitForTimeout(200);
	const zoom = await A.page.evaluate(() => document.querySelector('#image-zoom')?.textContent ?? '');
	h.check(zoom === '156%', `zoom controls work (${zoom})`);
	await A.page.locator('#image-preview-window button[title="Close"]').click();

	await h.finish(browser);
});
