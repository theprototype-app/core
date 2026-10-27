// Phase 107: file UX — click shows properties in the Inspector, double-click
// opens a text file for editing (Ctrl+S saves back, hash changes) or the
// zoomable image preview. 50 Y2: a text document opens as a Code tab (shared
// through Yjs), not the old floating text window.
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

	// double-click text -> a Code tab (50 Y2, was the floating text window); Ctrl+S saves (hash changes)
	const itemOf = () =>
		A.page.evaluate(
			() =>
				new Promise((resolve) => {
					window.__stores.explorer.explorerItems.subscribe((items) =>
						resolve(items.find((i) => i.name === 'notes.txt'))
					)();
				})
		);
	const hashBefore = (await itemOf())?.hash;
	await A.page.locator('.explorer-card', { hasText: 'notes.txt' }).dblclick();
	const tabsOf = () =>
		A.page.evaluate(() => new Promise((r) => window.__stores.codeWorkspace.codeTabs.subscribe((v) => r(JSON.parse(JSON.stringify(v))))()));
	const notesTab = async () => (await tabsOf()).find((t) => t.title === 'notes.txt') ?? null;
	await h.eventually(
		notesTab,
		(t) => !!t && t.lang === 'text',
		'double-click opens the text file as a plain-text Code tab',
		30000
	);
	h.check((await A.page.locator('#text-editor-window').count()) === 0, 'the old floating text window does not open');
	const pane = A.page.locator(`[data-pane="${(await notesTab())?.id}"]`);
	await pane.locator('.cm-content').click({ timeout: 30000 });
	await A.page.keyboard.press('Control+End');
	await A.page.keyboard.type(' added');
	await A.page.keyboard.press('Control+s');
	await h.eventually(async () => (await itemOf())?.hash, (v) => !!v && v !== hashBefore, 'Ctrl+S saves back (hash recomputed)', 15000);
	const savedText = await A.page.evaluate(async () => {
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		const blob = await window.__stores.explorer.itemBlob(items.find((i) => i.name === 'notes.txt').id);
		return blob.text();
	});
	h.check(/ added/.test(savedText), 'edited content round-trips');
	if (!(await A.page.locator('.explorer-card', { hasText: 'pixel.png' }).isVisible())) {
		await A.page.locator('#explorer-slot').click();
		await A.page.waitForTimeout(500);
	}

	// double-click image -> preview window with zoom
	await A.page.locator('.explorer-card', { hasText: 'pixel.png' }).dblclick();
	const preview = await A.page.locator('#image-preview-window').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
	h.check(preview, 'image preview window opens');
	await A.page.locator('#image-preview-window button[title="Zoom in"]').click();
	await A.page.locator('#image-preview-window button[title="Zoom in"]').click();
	await A.page.waitForTimeout(200);
	const zoom = await A.page.evaluate(() => document.querySelector('#image-zoom')?.textContent ?? '');
	h.check(zoom === '156%', `zoom controls work (${zoom})`);
	await A.page.locator('#image-preview-window button[title="Close"]').click();

	await h.finish(browser);
});
