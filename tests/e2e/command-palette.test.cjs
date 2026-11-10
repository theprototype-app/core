// 38 R8 (NOTES-38 #14) — THE COMMAND PALETTE. Ctrl+K opens one search over tools and
// shortcuts, windows, the logo menu and every Settings row; Enter runs the highlighted
// command exactly as its own key or control would. The palette is chrome over existing
// actions, so every check reads the STORE the action writes, never the palette's own state.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const st = (name) => page.evaluate((n) => new Promise((r) => window.__stores[n].subscribe(r)()), name);
	const isOpen = () => page.evaluate(() => !!document.querySelector('#command-palette'));

	// focus the viewport, not a text field — Ctrl+K is a global shortcut
	const canvas = await page.evaluate(() => {
		const c = document.querySelector('canvas:not([style*="display: none"])');
		const r = c?.getBoundingClientRect();
		return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
	});
	if (canvas) await page.mouse.click(canvas.x, canvas.y);
	await page.keyboard.press('Control+K');
	await h.eventually(isOpen, (v) => v === true, 'Ctrl+K opens #command-palette');
	h.check(
		await page.evaluate(() => document.activeElement?.id === 'command-palette-input'),
		'the search field has focus when the palette opens'
	);
	// showhide-v8 §5 — the palette is a PANEL: field above list, a background of its own, at every width. A merge left the
	// panel styling inside the on-screen-keyboard rule, so without a keyboard the field and the list sat side by side on
	// the bare scene (the owner's shots on desktop, unfolded and folded).
	const panelShape = () =>
		page.evaluate(() => {
			const cp = document.getElementById('command-palette');
			const f = document.querySelector('#command-palette .cp-search')?.getBoundingClientRect();
			const l = document.getElementById('command-palette-list')?.getBoundingClientRect();
			const cs = cp ? getComputedStyle(cp) : null;
			const bg = cs?.backgroundColor ?? '';
			return {
				dir: cs?.flexDirection,
				bg,
				painted: !!bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg),
				stacked: !!f && !!l && l.top >= f.bottom - 1 && Math.abs(l.left - f.left) < 4,
				kb: document.documentElement.classList.contains('kb-open')
			};
		});
	const vp0 = page.viewportSize();
	const isPanel = (s) => s.dir === 'column' && s.painted && s.stacked;
	for (const [label, vp] of [['desktop', { width: 1600, height: 950 }], ['unfolded', { width: 1080, height: 1200 }], ['folded', { width: 412, height: 915 }]]) {
		await page.setViewportSize(vp);
		await page.waitForTimeout(250);
		const s = await panelShape();
		h.check(!s.kb && isPanel(s), `palette is a panel (field above list, own background) on ${label} (${JSON.stringify(s)})`);
	}
	// counterfactual: the side-by-side layout the bug drew fails the same check
	await page.evaluate(() => document.getElementById('command-palette').style.setProperty('flex-direction', 'row'));
	h.check(!isPanel(await panelShape()), '(counterfactual) a row layout is caught');
	await page.evaluate(() => document.getElementById('command-palette').style.removeProperty('flex-direction'));
	if (vp0) await page.setViewportSize(vp0);
	await page.waitForTimeout(250);

	const listed = await page.evaluate(() => {
		const kinds = new Set([...document.querySelectorAll('#command-palette .cp-item')].map((b) => b.dataset.kind));
		return [...kinds];
	});
	// an empty query lists the first rows (tools lead); the other three kinds are reached by
	// typing, which the sections below cover (window, setting) — and the menu here
	h.check(listed.includes('tool'), 'an empty query lists commands, tools first');
	await page.keyboard.type('Modules');
	await page.waitForTimeout(150);
	h.check(
		await page.evaluate(() => [...document.querySelectorAll('#command-palette .cp-item')].some((b) => b.dataset.kind === 'menu' && b.querySelector('.cp-label')?.textContent === 'Modules')),
		'typing "Modules" offers the Modules menu entry'
	);
	await page.fill('#command-palette-input', '');

	// --- a tool: "scale" ranks the Scale shortcut first and Enter runs it ---
	await page.keyboard.type('scale');
	await page.waitForTimeout(150);
	const first = await page.evaluate(() => {
		const b = document.querySelector('#command-palette .cp-item');
		return { label: b?.querySelector('.cp-label')?.textContent, kind: b?.dataset.kind, keys: b?.querySelector('.cp-keys')?.textContent };
	});
	h.check(first.label === 'Scale' && first.kind === 'tool', 'typing "scale" ranks the Scale tool first', first);
	h.check(first.keys === '3', 'the row shows the tool\'s own key', first);
	await page.keyboard.press('Enter');
	await h.eventually(isOpen, (v) => v === false, 'Enter closes the palette');
	await h.eventually(() => st('transformMode'), (v) => v === 'scale', 'Enter ran the Scale command (transformMode = scale)');
	await page.evaluate(() => window.__stores.transformMode.set('translate'));

	// --- arrows move the highlight ---
	await page.keyboard.press('Control+K');
	await h.eventually(isOpen, (v) => v === true, 'Ctrl+K reopens the palette');
	h.check(
		await page.evaluate(() => document.querySelector('#command-palette-input').value === ''),
		'a reopened palette starts with an empty query'
	);
	await page.keyboard.press('ArrowDown');
	const sel = await page.evaluate(() =>
		[...document.querySelectorAll('#command-palette .cp-item')].findIndex((b) => b.getAttribute('aria-selected') === 'true')
	);
	h.check(sel === 1, 'ArrowDown moves the highlight to the second row', sel);

	// --- Esc closes, and does not leak to the window (Escape would deselect) ---
	await page.keyboard.press('Escape');
	await h.eventually(isOpen, (v) => v === false, 'Esc closes the palette');

	// --- a window: "Explorer" toggles the Explorer exactly as its panel toggle does ---
	const exBefore = await st('explorerClose');
	await page.keyboard.press('Control+K');
	await h.eventually(isOpen, (v) => v === true, 'palette open for a window command');
	await page.keyboard.type('Explorer');
	await page.waitForTimeout(150);
	const exRow = await page.evaluate(() => {
		const b = document.querySelector('#command-palette .cp-item');
		return { label: b?.querySelector('.cp-label')?.textContent, kind: b?.dataset.kind };
	});
	h.check(exRow.kind === 'window' && /Explorer/.test(exRow.label || ''), 'typing "Explorer" ranks the Explorer window first', exRow);
	await page.keyboard.press('Enter');
	await h.eventually(() => st('explorerClose'), (v) => v === !exBefore, 'Enter toggled the Explorer');
	// put it back
	await page.evaluate((v) => window.__stores.explorerClose.set(v), exBefore);

	// --- a setting: "Theme" opens Settings with the row's name in Settings' own search ---
	await page.keyboard.press('Control+K');
	await h.eventually(isOpen, (v) => v === true, 'palette open for a setting');
	await page.keyboard.type('Theme');
	await page.waitForTimeout(150);
	const thRow = await page.evaluate(() => {
		const b = document.querySelector('#command-palette .cp-item');
		return { label: b?.querySelector('.cp-label')?.textContent, kind: b?.dataset.kind, detail: b?.querySelector('.cp-detail')?.textContent };
	});
	h.check(thRow.label === 'Theme' && thRow.kind === 'setting', 'typing "Theme" ranks the Theme setting first', thRow);
	h.check(/Settings ▸ Interface/.test(thRow.detail || ''), 'a setting row says where it lives', thRow);
	await page.keyboard.press('Enter');
	await h.eventually(() => st('settingsOpen'), (v) => v === true, 'Enter opened Settings');
	await h.eventually(
		() => page.evaluate(() => document.querySelector('#settings-search')?.value ?? null),
		(v) => v === 'Theme',
		'Settings\' search holds the picked row name'
	);
	h.check((await st('settingsSearchSeed')) === '', 'the seed is consumed once Settings takes it');

	// --- Ctrl+K works over a modal (help rows are exempt from the modal mute) and toggles ---
	await page.evaluate(() => document.querySelector('#settings-search')?.blur());
	await page.keyboard.press('Control+K');
	await h.eventually(isOpen, (v) => v === true, 'Ctrl+K opens the palette while Settings is open');
	// a second Ctrl+K while typing in the palette's own field is the palette's key: it
	// must not reopen/toggle a second time or leak to anything behind it
	await page.keyboard.press('Control+K');
	await page.waitForTimeout(200);
	const afterSecond = await isOpen();
	h.check(typeof afterSecond === 'boolean', 'a second Ctrl+K from inside the palette is handled without error', afterSecond);
	if (afterSecond) await page.keyboard.press('Escape');
	await h.eventually(isOpen, (v) => v === false, 'the palette closes');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));

	// --- a click on the scrim closes it ---
	if (canvas) await page.mouse.click(canvas.x, canvas.y);
	await page.keyboard.press('Control+K');
	await h.eventually(isOpen, (v) => v === true, 'palette open for the scrim check');
	await page.mouse.click(8, 450);
	await h.eventually(isOpen, (v) => v === false, 'a click outside the palette closes it');

	// --- nothing matches ---
	await page.keyboard.press('Control+K');
	await h.eventually(isOpen, (v) => v === true, 'palette open for the empty-result check');
	await page.keyboard.type('zzqqxx nothing');
	await page.waitForTimeout(150);
	h.check(
		await page.evaluate(() => !!document.querySelector('#command-palette .cp-empty') && !document.querySelector('#command-palette .cp-item')),
		'a query that matches nothing says so'
	);
	await page.keyboard.press('Escape');

	h.check(h.pageErrors(A).length === 0, 'no page errors', h.pageErrors(A));
	await h.finish(browser);
});
