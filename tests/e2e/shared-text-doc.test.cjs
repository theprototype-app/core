// 50 Y2 — EXPLORER TEXT DOCUMENTS IN THE CODE TAB, shared the same way as code (two peers).
//   1 the properties pane's "Edit" on a .txt opens it as a Code tab, not the old floating window
//   2 both peers in notes.txt type at once; both keep their text
//   3 Ctrl+S writes the document's bytes to the file as plain text
// (v1.41.0: "Edit" opens the floating text window, each peer edits alone)
const h = require('./helpers.cjs');

const SHOTS = process.env.YJS_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: SHOTS + '/' + name });

const tabsOf = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.codeWorkspace.codeTabs.subscribe((v) => r(JSON.parse(JSON.stringify(v))))()));
const tabFor = async (page, pred) => (await tabsOf(page)).find(pred) ?? null;
const paneOf = async (page, pred) => {
	const t = await tabFor(page, pred);
	return t ? page.locator(`[data-pane="${t.id}"]`) : null;
};
async function waitShared(page, pred, label, timeout = 45000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const pane = await paneOf(page, pred);
		if (pane && (await pane.locator('[data-shared="true"]').count())) return true;
		await page.waitForTimeout(300);
	}
	console.log('  (' + label + ': the editor never reported a shared binding)');
	return false;
}
async function caretTo(page, pane, keys) {
	await pane.locator('.cm-content').click();
	for (const k of keys) await page.keyboard.press(k);
}

h.run(async () => {
	const browser = await h.launch();
	// the Explorer's properties pane (where "Edit" lives) is a remembered panel: open on Properties
	const storage = { 'shared:shareNewFiles': 'never', 'ws:explorer:secondaryOpen': 'true', 'ws:explorer:secondaryMode': 'props' };
	const A = await h.setupPage(browser, 'A', { storage });
	const B = await h.setupPage(browser, 'B', { storage });
	await h.connect(B, A);

	// the same file on both peers (a shared library would deliver it; seeded here so the suite is about editing)
	const NOTES = 'Shopping list\n- apples\n';
	const ids = {};
	for (const [name, P] of [['A', A], ['B', B]]) {
		ids[name] = await P.page.evaluate(async (text) => {
			const ex = window.__stores.explorer;
			await ex.loadExplorer();
			const item = await ex.addItemFromBytes(new TextEncoder().encode(text).buffer, 'notes.txt', null);
			return item.id;
		}, NOTES);
	}

	// ---------------------------------------------------------------- 1 "Edit" opens a Code tab
	await A.page.evaluate(() => {
		window.__stores.explorerClose.set(false);
		window.__stores.bottomDock.bottomDockActive.set('explorer');
	});
	await A.page.locator('.explorer-card', { hasText: 'notes.txt' }).first().click({ timeout: 30000 });
	await A.page.waitForTimeout(500);
	await A.page
		.getByRole('button', { name: 'Edit', exact: true })
		.first()
		.click({ timeout: 30000 })
		.catch(async (e) => {
			await shot(A.page, 'zz-edit-button.png');
			throw e;
		});
	const isNotes = (t) => t.title === 'notes.txt';
	await h.eventually(() => tabFor(A.page, isNotes), (t) => !!t, '"Edit" on a text document opens it as a Code tab', 45000);
	await h.eventually(
		() => tabFor(A.page, isNotes),
		(t) => !!t && t.kind === 'file' && t.lang === 'text',
		'the tab is a plain-text document (no parse check, no script badges)',
		5000
	);
	h.check((await A.page.locator('#text-editor-window').count()) === 0, 'the old floating text window does not open');
	await h.eventually(
		() => A.page.locator('#code-ws-toolbar .code-kind').textContent().catch(() => ''),
		(t) => /Text document/.test(t ?? ''),
		'the toolbar calls it a Text document',
		10000
	);

	// ---------------------------------------------------------------- 2 both type at once
	await B.page.evaluate((itemId) => window.__stores.codeWorkspace.openCode({ source: 'text', ref: { itemId } }), ids.B);
	const n1 = await waitShared(A.page, isNotes, 'A notes');
	const n2 = await waitShared(B.page, isNotes, 'B notes');
	h.check(n1 && n2, "both peers' notes.txt tabs bind to one shared document");
	const nA = await paneOf(A.page, isNotes);
	const nB = await paneOf(B.page, isNotes);
	await caretTo(A.page, nA, ['Control+End']);
	await caretTo(B.page, nB, ['Control+Home', 'End']);
	await Promise.all([A.page.keyboard.insertText('- pears\n'), B.page.keyboard.insertText(' (Saturday)')]);
	const NOTES2 = 'Shopping list (Saturday)\n- apples\n- pears\n';
	await h.eventually(
		async () => [(await tabFor(A.page, isNotes))?.code, (await tabFor(B.page, isNotes))?.code],
		([a, b]) => a === NOTES2 && b === NOTES2,
		'two people editing a text document both keep their text',
		15000
	);
	await shot(A.page, '03-text-document-shared-A.png');

	// ---------------------------------------------------------------- 3 saving writes the file
	await nB.locator('.cm-content').click();
	await B.page.keyboard.press('Control+S');
	await h.eventually(
		() => B.page.evaluate(async (id) => await (await window.__stores.explorer.itemBlob(id)).text(), ids.B),
		(t) => t === NOTES2,
		"Ctrl+S writes the document's bytes to the file, as plain text",
		15000
	);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors on either peer');
	await h.finish(browser);
});
