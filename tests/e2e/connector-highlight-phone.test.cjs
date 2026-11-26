// 107 select-files — the Code highlight row on a PHONE (the lane-side stand-in for the HONOR row): the assistant's
// show {code} highlights lines in the person's Code tab and never focuses the editor, so no caret and no on-screen
// keyboard comes up (on a phone a focused contenteditable IS the keyboard). An N6 context (phone UA, touch, isMobile).
//   1. show code {line, to}: the range is highlighted, the editor is not focused, nothing editable has focus
//   2. find: the same, and the page does not scroll the editor's input into a keyboard position (visualViewport unchanged)
//   3. focus: true focuses the editor (the counterfactual: the check above can see a focus when there is one)
// Run: APP_URL='https://theprototype.app:7245/' npm run e2e -- connector-highlight-phone
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'Phone', { context: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, userAgent: h.N6_UA } });
	const page = P.page;
	await page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	const relay = await fakeRelay(page);
	await installProvider(page);
	await page.evaluate(() => document.getElementById('connect-claude-button')?.click());
	await h.eventually(() => connectorPhase(P), (p) => p === 'connected', 'connected', 20000);
	let seq = 0;
	const call = async (tool, args = {}, scope = 'edit', timeout = 60000) => {
		const id = 'p' + ++seq;
		relay.call(id, tool, args, scope);
		return relay.answer(id, timeout);
	};
	const short = (x) => JSON.stringify(x).slice(0, 260);
	const focusState = () =>
		page.evaluate(() => {
			const el = /** @type {any} */ (document.activeElement);
			const editable = !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|number|password|)$/i.test(el.type ?? '')));
			return { editable, inEditor: !!el?.closest?.('.cm-editor'), focusedEditor: !!document.querySelector('.cm-editor.cm-focused'), vv: Math.round(window.visualViewport?.height ?? 0), sel: document.querySelectorAll('.cm-selectionBackground').length };
		});
	await page.evaluate(() => { const s = window.__tp.test.v1.safeStorage; s.setItem('show:allow:code', 'always'); s.setItem('show:allow:panel', 'always'); });
	await call('files', { action: 'create', path: 'Scripts/phone.js', text: 'let a = 1;\nfunction open() {\n  door.open();\n}\n// end' });
	await page.evaluate(() => document.activeElement?.blur?.());
	const before = await focusState();

	// ---- 1 ----------------------------------------------------------------------------------------------------
	const c1 = await call('show', { action: 'code', path: 'Scripts/phone.js', line: 2, to: 3 });
	h.check(c1?.result?.highlighted === true && c1.result.focused === false, `show code highlights on a phone (${short(c1)})`);
	await h.eventually(() => page.evaluate(() => document.querySelectorAll('.cm-editor').length), (n) => n > 0, 'the Code tab shows the file', 10000);
	await new Promise((r) => setTimeout(r, 1200));
	const f1 = await focusState();
	h.check(!f1.editable && !f1.inEditor && !f1.focusedEditor, `nothing editable has focus: no caret, no keyboard (${JSON.stringify(f1)})`);
	h.check(f1.sel > 0, `the range is drawn (${f1.sel})`);

	// ---- 2 ----------------------------------------------------------------------------------------------------
	const c2 = await call('show', { action: 'code', path: 'phone.js', find: 'door.open' });
	h.check(c2?.result?.highlighted === true && JSON.stringify(c2.result.selected) === JSON.stringify({ from: [3, 2], to: [3, 11] }), `find highlights the match (${short(c2)})`);
	await new Promise((r) => setTimeout(r, 800));
	const f2 = await focusState();
	h.check(!f2.editable && !f2.focusedEditor, `still nothing focused (${JSON.stringify(f2)})`);
	h.check(f2.vv === before.vv, `the visual viewport did not change size (${before.vv} -> ${f2.vv})`);

	// ---- 3 ----------------------------------------------------------------------------------------------------
	const c3 = await call('show', { action: 'code', path: 'phone.js', line: 2, focus: true });
	h.check(c3?.result?.focused === true, `focus: true asks for the caret (${short(c3)})`);
	await h.eventually(() => focusState(), (s) => s.focusedEditor && s.inEditor, 'the counterfactual: focus: true focuses the editor', 6000);

	await h.finish(browser);
});
