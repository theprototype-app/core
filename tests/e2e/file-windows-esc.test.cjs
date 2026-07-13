// Phase 197 fix: Esc closes the floating file windows (image preview + code
// editor) rather than the Explorer. The code editor, if it has unsaved edits,
// asks to save first (Save / Don't save / Cancel).
const h = require('./helpers.cjs');

const imgOpen = (A) => A.page.evaluate(() => { let v; window.__stores.fileWindows.imagePreviewTarget.subscribe((x) => (v = x))(); return !!v; });
const txtOpen = (A) => A.page.evaluate(() => { let v; window.__stores.fileWindows.textEditorTarget.subscribe((x) => (v = x))(); return !!v; });

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// image preview: opens, focuses itself, Esc closes it
	await A.page.evaluate(() => window.__stores.fileWindows.openImagePreview({ title: 'pic', url: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' }));
	await A.page.waitForTimeout(300);
	h.check(await imgOpen(A), 'image preview opens');
	await A.page.waitForTimeout(200);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check(!(await imgOpen(A)), 'Esc closes the image preview');

	// code editor with NO edits: Esc closes cleanly (no prompt)
	await A.page.evaluate(() => window.__stores.fileWindows.openTextEditor({ title: 'clean.txt', code: 'hello', onSave: () => {} }));
	await A.page.waitForTimeout(300);
	h.check(await txtOpen(A), 'code editor opens');
	await A.page.locator('#text-editor-window .cm-content').click();
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check(!(await txtOpen(A)), 'Esc closes a clean editor immediately');

	// code editor WITH edits: Esc keeps it open + shows a save prompt toast
	let saved = false;
	await A.page.exposeFunction('__markSaved', () => (saved = true));
	await A.page.evaluate(() => window.__stores.fileWindows.openTextEditor({ title: 'dirty.txt', code: 'hello', onSave: () => window.__markSaved() }));
	await A.page.waitForTimeout(300);
	await A.page.locator('#text-editor-window .cm-content').click();
	await A.page.keyboard.type(' world'); // makes it dirty
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	const promptText = await A.page.evaluate(() => document.querySelector('#text-editor-window')?.textContent || '');
	h.check((await txtOpen(A)) && /Save changes to/.test(promptText), 'dirty editor Esc keeps it open + shows the in-window save dialog');
	// the dialog lives inside the editor window (not a toast)
	h.check(await A.page.locator('#text-editor-window #text-editor-savenclose').count() === 1, 'save dialog is in-window with Save/Discard/Cancel');

	await h.finish(browser);
});
