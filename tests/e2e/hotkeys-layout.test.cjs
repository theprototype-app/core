// 24-A1: hotkeys on every keyboard layout. `comboOf` used to build the combo from
// `event.key` — the CHARACTER the layout produced — so on a Russian/Greek/Hebrew
// layout `G` arrived as `п`/`γ`/`ד` and every letter shortcut was dead. The rule is
// now HYBRID (keyOf.js): an ASCII letter/digit in `key` wins (AZERTY, Dvorak keep
// their printed labels), anything else falls back to the physical `event.code`.
//
// Playwright presses use the US layout, so a foreign layout is SYNTHESISED here:
// `new KeyboardEvent('keydown', { key: 'п', code: 'KeyG' })` on window is exactly
// what Chromium delivers on ЙЦУКЕН. Section 1 pins the registry — every combo the
// app registers must come out byte-identical for a US-layout press, which is the
// "no regression for anyone" half of the rule.
const h = require('./helpers.cjs');

const camPos = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c?.position?.toArray()))())
	);
const moved = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const childCount = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));
const transformMode = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.transformMode.subscribe((m) => r(m))()));

/** dispatch a synthetic keydown (and optional keyup) on window */
const press = (page, init, holdMs = 0) =>
	page.evaluate(
		async ({ init, holdMs }) => {
			window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
			if (holdMs > 0) {
				await new Promise((r) => setTimeout(r, holdMs));
				window.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init }));
			}
		},
		{ init, holdMs }
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// --- 1. the registry is byte-identical for US-layout presses --------------------
	const pin = await A.page.evaluate(() => {
		const { shortcuts, comboOf } = window.__stores.shortcutsRegistry;
		const NAMED_CODE = { '?': 'Slash', '/': 'Slash', '.': 'Period', ',': 'Comma', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote', '-': 'Minus', '=': 'Equal', ' ': 'Space' };
		const rows = shortcuts.filter((s) => s.keys && !/\s/.test(s.keys));
		const bad = [];
		for (const s of rows) {
			const parts = String(s.keys).split('+');
			const last = parts.pop();
			const init = {
				ctrlKey: parts.includes('Ctrl'),
				altKey: parts.includes('Alt'),
				shiftKey: parts.includes('Shift')
			};
			if (/^[A-Z]$/.test(last)) Object.assign(init, { key: init.shiftKey ? last : last.toLowerCase(), code: 'Key' + last });
			else if (/^[0-9]$/.test(last)) Object.assign(init, { key: last, code: 'Digit' + last });
			else Object.assign(init, { key: last, code: NAMED_CODE[last] || last });
			const got = comboOf(new KeyboardEvent('keydown', init));
			if (got !== s.keys) bad.push(s.id + ': ' + s.keys + ' -> ' + got);
		}
		return { total: rows.length, bad };
	});
	h.check(pin.total >= 30, `registry pin covers ${pin.total} combos`);
	h.check(pin.bad.length === 0, `every US-layout press reproduces its combo (${pin.bad.join('; ') || 'none differ'})`);

	// --- 2. the leaf's edge cases -------------------------------------------------
	const edges = await A.page.evaluate(() => {
		const { comboOf } = window.__stores.shortcutsRegistry;
		const ev = (init) => new KeyboardEvent('keydown', init);
		return {
			cyrillicG: comboOf(ev({ key: 'п', code: 'KeyG' })),
			cyrillicCtrlZ: comboOf(ev({ key: 'я', code: 'KeyZ', ctrlKey: true })),
			capsCyrillic: comboOf(ev({ key: 'Ф', code: 'KeyA' })),
			greek: comboOf(ev({ key: 'γ', code: 'KeyG' })),
			hebrew: comboOf(ev({ key: 'ד', code: 'KeyG' })),
			dvorakF: comboOf(ev({ key: 'f', code: 'KeyU' })),
			azertyA: comboOf(ev({ key: 'a', code: 'KeyQ' })),
			shiftDigit: comboOf(ev({ key: '!', code: 'Digit1', shiftKey: true })),
			punctuation: comboOf(ev({ key: '?', code: 'Slash', shiftKey: true })),
			named: comboOf(ev({ key: 'Escape', code: 'Escape' })),
			emptyCode: comboOf(ev({ key: 'g', code: '' })),
			noKey: comboOf(ev({ code: 'KeyG' })),
			composing: comboOf(ev({ key: 'Process', code: 'KeyG', isComposing: true })),
			dead: comboOf(ev({ key: 'Dead', code: 'Quote' })),
			nothing: (() => { try { return comboOf({}); } catch (e) { return 'THREW ' + e.message; } })()
		};
	});
	h.check(edges.cyrillicG === 'G', `Cyrillic п on KeyG -> G (${edges.cyrillicG})`);
	h.check(edges.cyrillicCtrlZ === 'Ctrl+Z', `Cyrillic Ctrl+я on KeyZ -> Ctrl+Z (${edges.cyrillicCtrlZ})`);
	h.check(edges.capsCyrillic === 'A', `Caps Lock Cyrillic Ф on KeyA -> A (${edges.capsCyrillic})`);
	h.check(edges.greek === 'G' && edges.hebrew === 'G', `Greek/Hebrew letters resolve by position (${edges.greek}/${edges.hebrew})`);
	h.check(edges.dvorakF === 'F', `Dvorak: key f on KeyU stays F — the printed label wins when ASCII (${edges.dvorakF})`);
	h.check(edges.azertyA === 'A', `AZERTY: key a on KeyQ stays A (${edges.azertyA})`);
	h.check(edges.shiftDigit === 'Shift+1', `Shift+1 stays Shift+1, never "!" (${edges.shiftDigit})`);
	h.check(edges.punctuation === 'Shift+?', `punctuation stays by key (${edges.punctuation})`);
	h.check(edges.named === 'Escape', `named keys unchanged (${edges.named})`);
	h.check(edges.emptyCode === 'G', `an empty code (soft keyboard) falls through to key (${edges.emptyCode})`);
	h.check(edges.noKey === 'G', `a missing key with a Key* code resolves physically (${edges.noKey})`);
	h.check(edges.composing === 'KeyG', `IME composition never matches a letter (${edges.composing})`);
	h.check(edges.dead === 'Quote', `a dead key answers with its code (${edges.dead})`);
	h.check(edges.nothing === '', `an event with neither key nor code does not throw (${JSON.stringify(edges.nothing)})`);

	// --- 3. Cyrillic G grabs (transform mode -> translate) -----------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setTransformMode('rotate'));
	h.check((await transformMode(A.page)) === 'rotate', 'precondition: mode is rotate');
	await press(A.page, { key: 'п', code: 'KeyG' });
	await A.page.waitForTimeout(150);
	h.check((await transformMode(A.page)) === 'translate', 'п on the G key (Russian layout) switches to Move');
	// and the layout flag is up for Settings
	const seen = await A.page.evaluate(() => new Promise((r) => window.__stores.shortcutsRegistry.nonLatinLayoutSeen.subscribe((v) => r(v))()));
	h.check(seen === true, 'nonLatinLayoutSeen flips after a non-Latin keydown');

	// --- 4. Cyrillic Ctrl+Z undoes a create ------------------------------------------
	const before = await childCount(A.page);
	await A.page.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [3, 0.5, -2]));
	await A.page.waitForTimeout(300);
	const after = await childCount(A.page);
	h.check(after === before + 1, `a box was created (${before} -> ${after})`);
	await press(A.page, { key: 'я', code: 'KeyZ', ctrlKey: true });
	await A.page.waitForTimeout(400);
	const undone = await childCount(A.page);
	h.check(undone === before, `Ctrl+я on the Z key undoes it (${after} -> ${undone})`);

	// --- 5. Dvorak-style f on KeyU still focuses (key wins when ASCII) ---------------
	await A.page.evaluate(() => window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [6, 0.5, -4]));
	await A.page.waitForTimeout(300);
	const uuid = await A.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children[g.children.length - 1].uuid))())
	);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), uuid);
	await A.page.keyboard.press('Escape'); // close whatever the create opened
	await A.page.waitForTimeout(200);
	const targetBefore = await A.page.evaluate(() => new Promise((r) => window.__stores.orbitControls.subscribe((c) => r(c?.target?.toArray()))()));
	await press(A.page, { key: 'f', code: 'KeyU' });
	await A.page.waitForTimeout(900); // flyTo eases over 400ms
	const targetAfter = await A.page.evaluate(() => new Promise((r) => window.__stores.orbitControls.subscribe((c) => r(c?.target?.toArray()))()));
	const toBox = Math.hypot(targetAfter[0] - 6, targetAfter[1] - 0.5, targetAfter[2] + 4);
	h.check(
		moved(targetBefore, targetAfter) > 0.5 && toBox < 1.5,
		`f on KeyU (Dvorak) focuses the box (target moved ${moved(targetBefore, targetAfter).toFixed(2)}, ${toBox.toFixed(2)} from it)`
	);

	// --- 6. Cyrillic ц on KeyW flies the camera forward -----------------------------
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(200);
	const c0 = await camPos(A.page);
	await press(A.page, { key: 'ц', code: 'KeyW' }, 500);
	await A.page.waitForTimeout(200);
	const c1 = await camPos(A.page);
	h.check(moved(c0, c1) > 0.1, `ц on the W key flies the camera (moved ${moved(c0, c1).toFixed(2)})`);
	// and a Cyrillic keyup RELEASES it (no stuck key)
	await A.page.waitForTimeout(400);
	const c2 = await camPos(A.page);
	h.check(moved(c1, c2) < 0.05, `keyup with ц releases the key (drift ${moved(c1, c2).toFixed(3)})`);

	// --- 7. Settings ▸ Shortcuts says which printed key on a non-Latin layout --------
	// Stub Chromium's layout map with a Russian one BEFORE a fresh load: the panel then
	// renders "G · п on your layout" beside letter combos and no note (the map answers).
	await A.ctx.addInitScript(() => {
		const RU = { KeyG: 'п', KeyF: 'а', KeyZ: 'я', KeyW: 'ц', KeyA: 'ф', KeyS: 'ы', KeyD: 'в', KeyQ: 'й', KeyE: 'у', KeyH: 'р', KeyT: 'е', KeyY: 'н', KeyU: 'г', KeyI: 'ш', KeyO: 'щ', KeyP: 'з', KeyR: 'к', KeyJ: 'о', KeyK: 'л', KeyL: 'д', KeyB: 'и', KeyC: 'с', KeyM: 'ь', KeyN: 'т', KeyV: 'м', KeyX: 'ч' };
		Object.defineProperty(navigator, 'keyboard', {
			configurable: true,
			value: { getLayoutMap: () => Promise.resolve(new Map(Object.entries(RU))) }
		});
	});
	await h.freshReload(A);
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('shortcuts');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForSelector('#shortcut-grid', { timeout: 15000 });
	await A.page.waitForTimeout(500);
	const hint = await A.page.evaluate(() => {
		const row = document.querySelector('[data-shortcut="transform.grab"]');
		return row?.querySelector('.shortcut-layout')?.textContent?.trim() ?? null;
	});
	h.check(hint === '· п on your layout', `Shortcuts panel shows the layout's own label for G (${JSON.stringify(hint)})`);
	const digitHint = await A.page.evaluate(() => !!document.querySelector('[data-shortcut="transform.move"] .shortcut-layout'));
	h.check(!digitHint, 'digit rows carry no layout hint');
	const note = await A.page.$('#shortcut-layout-note');
	h.check(!note, 'no "physical key" note while the browser can map labels itself');

	// --- 8. ...and the note where the API is missing (Firefox/Safari) after a non-Latin press
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.ctx.addInitScript(() => {
		Object.defineProperty(navigator, 'keyboard', { configurable: true, value: undefined });
	});
	await h.freshReload(A);
	await press(A.page, { key: 'п', code: 'KeyG' });
	await A.page.waitForTimeout(100);
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('shortcuts');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForSelector('#shortcut-grid', { timeout: 15000 });
	await A.page.waitForTimeout(300);
	const noteText = await A.page.evaluate(() => document.querySelector('#shortcut-layout-note')?.textContent?.trim() ?? null);
	h.check(
		!!noteText && /physical key position/.test(noteText),
		`without getLayoutMap, a non-Latin press surfaces the physical-key note (${JSON.stringify(noteText)})`
	);
	const noHints = await A.page.evaluate(() => document.querySelectorAll('.shortcut-layout').length);
	h.check(noHints === 0, 'no per-row hints without a layout map');

	await h.finish(browser);
});
