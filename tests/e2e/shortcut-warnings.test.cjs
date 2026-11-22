// 44 L4 — THE svelte-put/shortcut WARNING FLOOD. The user's 1.34 diagnostics bundle was 199 lines, 180 of them
// "[svelte-put/shortcut] Trigger should have either `key` or `code`…": Nodes.svelte handed xyflow
// `deleteKey={null}` / `panActivationKey={null}` (both belong to the keymap registry), and xyflow 1.7 turns a
// null key into a trigger with NO key, which @svelte-put/shortcut warns about on every keydown AND keyup.
// This suite types with the node editor open and counts those warnings at the console (helpers' page.__console
// sees every message from before the first navigation). That Delete / Backspace still delete through the
// registry is node-ux-keys' job (run beside this one).
// Counterfactual: on origin/feat/43-int the count is ~4 per key press (red); after the fix it is 0.
const h = require('./helpers.cjs');
const WARN = /svelte-put\/shortcut/;
const warnings = (P) => P.page.__console.filter((m) => WARN.test(m.text)).length;

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'keys', { context: { viewport: { width: 1440, height: 900 } }, storage: { toastsInDrawerOnly: 'true' } });
	const page = P.page;
	await page.evaluate(() => window.__tp.test.v1.flowGraphClose.set(false));
	await page.waitForTimeout(1500);
	const pane = await page.evaluate(() => {
		const r = document.querySelector('.svelte-flow__pane')?.getBoundingClientRect();
		return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
	});
	h.check(!!pane, `premise: the node editor is open (${JSON.stringify(pane)})`);
	const w0 = warnings(P);

	// typing over the pane: letters, modifiers, arrows, Delete/Backspace, Space — 12 key presses
	await page.mouse.click(pane.x, pane.y);
	for (const k of ['a', 'b', 'Shift', 'Control', 'Alt', 'ArrowLeft', 'ArrowRight', 'Escape', 'Delete', 'Backspace', 'Space', 'x']) {
		await page.keyboard.press(k);
		await page.waitForTimeout(40);
	}
	// and somewhere else entirely (the shortcut listeners are on the WINDOW)
	await page.mouse.click(700, 120);
	for (const k of ['q', 'w', 'e']) await page.keyboard.press(k);
	await page.waitForTimeout(300);
	const w1 = warnings(P) - w0;
	h.check(w1 === 0, `15 key presses with the node editor open raise no "[svelte-put/shortcut]" warning (${w1})`);
	await h.finish(browser);
});
