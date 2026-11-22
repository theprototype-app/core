// 103 H14 + owner rows 7-10 (lane 103-menu-palette) — THE MAIN MENU, Ctrl+K AND YOUR KEYMAPS.
//   §1 main menu: the Ctrl+K row and Settings are locked, only the rows between scroll; the fade lives only inside the
//      scroller and only on the side with hidden rows (row 7: the pinned rows never dim, nothing fades at rest at the
//      top); a mouse drag scrolls with momentum, a press under 6 px is still a click, a drag never activates a row, the
//      pointer never changes; the wheel still scrolls.
//   §2 Ctrl+K on the desktop: change a shortcut in place (chip, Add shortcut, right-click ▸ Change / Reset / Open in
//      Settings, F2 from the keyboard), Enter saves, Esc cancels, Backspace = no key, a taken key shows in the row
//      (Replace / Cancel), a fixed row is greyed with its reason, the palette stays open and says what changed, and
//      Settings ▸ Shortcuts shows the same binding. Row 8: one right-aligned key column, one row height.
//   §3 Ctrl+K on a phone (N6 folded / unfolded emulation): the main menu's sheet, search on top, above the keyboard,
//      no key column, swipe down closes.
//   §4 Settings ▸ Shortcuts ▸ Keymap (rows 9 + 10): Save current as…, the changed dot + Save changes / Discard, the
//      switch that asks, export / import, the three resets with counted confirms.
//   §5 unused = zero change: opening and closing the menu and the palette writes no new key.
// SHOTS_ONLY=1 takes only the row-8 screenshots (1280, 1920, the phone drawer) — for the BEFORE set on the base.
// Run: APP_URL=https://theprototype.app:7186/ npm run e2e -- menu-palette-103
const h = require('./helpers.cjs');
const path = require('node:path');
const fs = require('node:fs');

const SHOTS = process.env.EVIDENCE_DIR || path.join(__dirname, '..', '..', 'test-results', '103-menu-palette');
const PHASE = process.env.BEFORE ? 'before' : 'after';
const SHOTS_ONLY = process.env.SHOTS_ONLY === '1';
const UA = 'Mozilla/5.0 (Linux; Android 16; CPH2765) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const N6_FOLDED = { width: 380, height: 792 };
const N6_UNFOLDED = { width: 749, height: 747 };

/** @param {any} page @param {string} name */
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${PHASE}-${name}.png`) }).catch(() => {});
/** @param {any} page @param {(...a: any[]) => any} fn @param {any} [arg] */
const S = (page, fn, arg) => page.evaluate(fn, arg);

/** @param {any} page */
async function openMenu(page) {
	await S(page, () => {
		window.__tp.test.v1.settingsOpen.set(false);
		window.__tp.test.v1.closeMenu.set(false);
	});
	await page.waitForSelector('#sidebar70', { timeout: 8000 });
	await page.waitForTimeout(400);
}
/** @param {any} page */
async function closeMenu(page) {
	await S(page, () => window.__tp.test.v1.closeMenu.set(true));
	await page.waitForTimeout(250);
}
/** @param {any} page */
async function openPalette(page, query = '') {
	await S(page, () => window.__tp.test.v1.commandPaletteOpen.set(true));
	await page.waitForSelector('#command-palette-input', { timeout: 15000 });
	await page.fill('#command-palette-input', query);
	await page.waitForTimeout(250);
}
/** @param {any} page */
async function closePalette(page) {
	await S(page, () => window.__tp.test.v1.commandPaletteOpen.set(false));
	await page.waitForTimeout(250);
}
/** @param {any} page @param {string} id */
const binding = (page, id) => S(page, (i) => window.__tp.test.v1.shortcutsRegistry.bindingOf(i), id);
/** @param {any} page @param {string} id */
const row = (page, id) => page.locator(`#command-palette .cp-item[data-shortcut="${id}"]`).first();

/** the menu's geometry: locked rows, the scroller, the fade @param {any} page */
function readMenu(page) {
	return S(page, () => {
		const nav = document.getElementById('sidebar70');
		const sc = document.getElementById('sidebar70-scroll');
		const search = document.getElementById('open-command-palette');
		const foot = nav?.querySelector('.side-foot');
		if (!nav || !sc || !search || !foot) return null;
		const r = (/** @type {Element} */ e) => {
			const b = e.getBoundingClientRect();
			return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
		};
		const mask = (/** @type {Element} */ e) => {
			const cs = getComputedStyle(e);
			return cs.maskImage || cs.webkitMaskImage || 'none';
		};
		return {
			more: sc.scrollHeight - sc.clientHeight,
			top: Math.round(sc.scrollTop),
			fade: sc.dataset.fadeY || '',
			scMask: mask(sc),
			navMask: mask(nav),
			searchMask: mask(search),
			footMask: mask(foot),
			searchIn: sc.contains(search),
			footIn: sc.contains(foot),
			search: r(search),
			foot: r(foot),
			sc: r(sc)
		};
	});
}

h.run(async () => {
	fs.mkdirSync(SHOTS, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 560 } } });
	const page = A.page;

	if (SHOTS_ONLY) {
		for (const [w, hgt] of [[1280, 800], [1920, 1080]]) {
			await page.setViewportSize({ width: w, height: hgt });
			await page.waitForTimeout(500);
			await openMenu(page);
			await shot(page, `menu-${w}`);
			await closeMenu(page);
			await openPalette(page, '');
			await shot(page, `palette-${w}`);
			await openPalette(page, 'move');
			await shot(page, `palette-move-${w}`);
			await closePalette(page);
			await S(page, () => {
				window.__tp.test.v1.settingsSection.set('shortcuts');
				window.__tp.test.v1.settingsOpen.set(true);
			});
			await page.waitForTimeout(1500);
			await shot(page, `settings-shortcuts-${w}`);
			await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
			await page.waitForTimeout(400);
		}
		for (const [label, vp] of [['n6-folded', N6_FOLDED], ['n6-unfolded', N6_UNFOLDED]]) {
			const P = await h.setupPage(browser, label, { context: { viewport: vp, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA } });
			await openPalette(P.page, '');
			await P.page.waitForTimeout(500);
			await shot(P.page, `palette-${label}`);
			await P.ctx.close();
		}
		return h.finish(browser);
	}

	// ---------------------------------------------------------------- §5 premise: a fresh profile writes nothing new --
	const NEW_KEYS = ['keymapsSaved', 'keymapActive', 'paletteSheetH', 'shortcutOverrides', 'keymapPreset'];
	const storedKeys = () => S(page, (keys) => keys.filter((k) => localStorage.getItem(k) !== null), NEW_KEYS);

	// ---------------------------------------------------------------- §1 the main menu --
	await openMenu(page);
	const m0 = await readMenu(page);
	h.check(!!m0 && m0.more > 40, `1.0 (premise) at 1280x560 the menu's rows scroll (${JSON.stringify(m0)})`);
	if (!m0) throw new Error('no menu');
	h.check(!m0.searchIn && !m0.footIn, '1.1 the Ctrl+K row and the Settings footer sit outside the scroller (locked)');
	const positions = [];
	for (const to of [0, Math.round(m0.more / 2), 99999]) {
		await S(page, (t) => {
			const sc = /** @type {HTMLElement} */ (document.getElementById('sidebar70-scroll'));
			sc.scrollTop = t;
		}, to);
		await page.waitForTimeout(180);
		positions.push(await readMenu(page));
	}
	const [atTop, atMid, atEnd] = /** @type {any[]} */ (positions);
	h.check(
		positions.every((p) => p && p.search.top === m0.search.top && p.foot.top === m0.foot.top),
		`1.2 scrolled to the top, the middle and the end, the two locked rows do not move (${positions.map((p) => p && `${p.search.top}/${p.foot.top}`).join(' ')})`
	);
	h.check(atTop.fade === 'end' && atMid.fade === 'both' && atEnd.fade === 'start', `1.3 row 7: the fade is only on the side with hidden rows — top ${atTop.fade}, middle ${atMid.fade}, end ${atEnd.fade}`);
	h.check(atTop.scMask !== 'none' && !/^linear-gradient\(transparent/.test(atTop.scMask), `1.4 row 7: at rest at the top the first scrolling row is fully clear (the mask fades the bottom only: ${atTop.scMask.slice(0, 70)})`);
	h.check(
		positions.every((p) => p.navMask === 'none' && p.searchMask === 'none' && p.footMask === 'none'),
		`1.5 row 7: the pinned rows never dim — no mask on the menu, the Ctrl+K row or Settings (counterfactual: the base faded the whole #sidebar70)`
	);
	h.check(atTop.sc.top >= atTop.search.bottom - 1 && atTop.sc.bottom <= atTop.foot.top + 1, '1.6 the fade lives inside the scrolling area, between the two locked rows');
	await shot(page, 'menu-1280x560-top');

	// drag-scroll vs click (row 1)
	await S(page, () => ((/** @type {HTMLElement} */ (document.getElementById('sidebar70-scroll'))).scrollTop = 0));
	await page.waitForTimeout(150);
	const target = await S(page, () => {
		const b = document.getElementById('open-checkpoints')?.getBoundingClientRect();
		const sc = document.getElementById('sidebar70-scroll')?.getBoundingClientRect();
		return b && sc ? { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2), scTop: Math.round(sc.top), scBottom: Math.round(sc.bottom) } : null;
	});
	h.check(!!target && target.y > target.scTop && target.y < target.scBottom, `1.7 (premise) the Checkpoints row is in view at the top (${JSON.stringify(target)})`);
	if (!target) throw new Error('no row');
	const cursorAt = (/** @type {number} */ x, /** @type {number} */ y) => S(page, ([px, py]) => getComputedStyle(/** @type {Element} */ (document.elementFromPoint(px, py))).cursor, [x, y]);
	const cursor0 = await cursorAt(target.x, target.y);
	// a press that travels 4 px is still a click
	await page.mouse.move(target.x, target.y);
	await page.mouse.down();
	await page.mouse.move(target.x + 1, target.y + 4, { steps: 3 });
	await page.mouse.up();
	await page.waitForTimeout(500);
	const clicked = await S(page, () => new Promise((r) => window.__tp.test.v1.checkpointsOpen.subscribe(r)()));
	h.check(clicked === true, `1.8 row 1: a press that travels 4 px (< 6) is still a click on the row (Checkpoints opened: ${clicked})`);
	await S(page, () => window.__tp.test.v1.checkpointsOpen.set(false));
	await page.waitForTimeout(300);
	await openMenu(page);
	await S(page, () => ((/** @type {HTMLElement} */ (document.getElementById('sidebar70-scroll'))).scrollTop = 0));
	await page.waitForTimeout(150);
	await page.mouse.move(target.x, target.y);
	await page.mouse.down();
	const during = [];
	for (let i = 1; i <= 8; i++) {
		await page.mouse.move(target.x, target.y - i * 12);
		if (i === 4) during.push(await cursorAt(target.x, target.y - i * 12));
	}
	const atRelease = await S(page, () => Math.round((/** @type {HTMLElement} */ (document.getElementById('sidebar70-scroll'))).scrollTop));
	await page.mouse.up();
	await page.waitForTimeout(450);
	const after = await S(page, () => ({
		top: Math.round((/** @type {HTMLElement} */ (document.getElementById('sidebar70-scroll'))).scrollTop),
		open: !!document.getElementById('sidebar70'),
		checkpoints: !!document.querySelector('#checkpoints-window, #checkpoints-panel'),
		bodyCursor: document.body.style.cursor || '',
		htmlCursor: document.documentElement.style.cursor || ''
	}));
	const cpOpen = await S(page, () => new Promise((r) => window.__tp.test.v1.checkpointsOpen.subscribe(r)()));
	h.check(atRelease >= 60, `1.9 row 1: a 96 px mouse drag scrolls the rows (${atRelease} px)`);
	h.check(after.open && cpOpen === false, `1.10 row 1: the drag activated no row (menu still open: ${after.open}, Checkpoints: ${cpOpen})`);
	h.check(after.top > atRelease, `1.11 row 1: a little momentum after the release (${atRelease} -> ${after.top} px)`);
	h.check(during[0] === cursor0 && !/grab|move|scroll/.test(String(during[0])) && !after.bodyCursor && !after.htmlCursor, `1.12 row 1: the pointer never changes (${cursor0} -> ${during[0]})`);
	const beforeWheel = after.top;
	await page.mouse.move(target.x, target.y);
	await page.mouse.wheel(0, -200);
	await page.waitForTimeout(400);
	const wheel = await S(page, () => Math.round((/** @type {HTMLElement} */ (document.getElementById('sidebar70-scroll'))).scrollTop));
	h.check(wheel < beforeWheel, `1.13 the wheel still scrolls (${beforeWheel} -> ${wheel})`);
	// keyboard: Tab / arrows to the last Help row still bring it into view, never under the locked footer
	await S(page, () => document.getElementById('report-bug')?.focus());
	await page.waitForTimeout(300);
	const kb = await S(page, () => {
		const b = /** @type {HTMLElement} */ (document.getElementById('report-bug')).getBoundingClientRect();
		const f = /** @type {HTMLElement} */ (document.querySelector('#sidebar70 .side-foot')).getBoundingClientRect();
		return { bottom: Math.round(b.bottom), foot: Math.round(f.top) };
	});
	h.check(kb.bottom <= kb.foot + 1, `1.14 a focused last row sits above the locked footer, never under it (${JSON.stringify(kb)})`);
	const hint = await S(page, () => document.querySelector('#open-command-palette .side-hint')?.textContent);
	h.check(hint === 'Ctrl+K', `1.15 row 8: the Ctrl+K row's key is the shared chip, same text (${hint})`);
	await closeMenu(page);

	// ---------------------------------------------------------------- §2 Ctrl+K on the desktop --
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.waitForTimeout(400);
	h.check((await storedKeys()).length === 0, `5.1 unused = zero change: a fresh profile has none of ${NEW_KEYS.join(', ')} after the menu opened, dragged and closed`);
	const canvas = await S(page, () => {
		const c = document.querySelector('canvas:not([style*="display: none"])');
		const r = c?.getBoundingClientRect();
		return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
	});
	if (canvas) await page.mouse.click(canvas.x, canvas.y);
	await page.keyboard.press('Control+K');
	await page.waitForSelector('#command-palette-input', { timeout: 15000 });
	h.check(await S(page, () => document.activeElement?.id === 'command-palette-input'), '2.0 Ctrl+K opens the palette (a lazy chunk now) with the field focused');
	await page.fill('#command-palette-input', 'move rotate scale');
	await page.fill('#command-palette-input', '');
	await page.waitForTimeout(300);
	// row 8: one right-aligned key column, one row height, labels truncate before the chips
	const align = await S(page, () => {
		const items = [...document.querySelectorAll('#command-palette .cp-item')].slice(0, 14);
		const cols = items.map((i) => i.querySelector('.cp-keycol')?.getBoundingClientRect()).filter(Boolean);
		const chips = items.map((i) => i.querySelector('.cp-keycol .kc')?.getBoundingClientRect()).filter(Boolean);
		const labels = items.map((i) => getComputedStyle(/** @type {Element} */ (i.querySelector('.cp-label'))).textOverflow);
		return {
			rights: [...new Set(cols.map((c) => Math.round(/** @type {DOMRect} */ (c).right)))],
			chipRights: [...new Set(chips.map((c) => Math.round(/** @type {DOMRect} */ (c).right)))],
			heights: [...new Set(items.map((i) => Math.round(i.getBoundingClientRect().height)))],
			labels: [...new Set(labels)],
			minW: Math.min(...cols.map((c) => Math.round(/** @type {DOMRect} */ (c).width)))
		};
	});
	h.check(align.rights.length === 1 && align.minW >= 110, `2.1 row 8: every row's key column ends at one right edge, one width (${JSON.stringify(align)})`);
	h.check(align.chipRights.length <= 2, `2.2 row 8: the chips are right-aligned in it (${align.chipRights})`);
	h.check(align.heights.length === 1 && align.heights[0] === 32, `2.3 row 8: one row height, 32 px (${align.heights})`);
	h.check(align.labels.length === 1 && align.labels[0] === 'ellipsis', '2.4 row 8: labels truncate with an ellipsis before they push the chip');
	await shot(page, 'palette-1280');

	const moveLabel = 'Move (translate)';
	await page.fill('#command-palette-input', 'Move translate');
	await page.waitForTimeout(250);
	const multi = await S(page, () => document.querySelector('#command-palette .cp-item[data-shortcut="transform.move"] .kc')?.textContent);
	h.check(multi === '1', `2.5 (premise) Move (translate) is listed with its key 1 (${multi})`);
	// click the chip -> capture -> Enter saves
	await row(page, 'transform.move').locator('.cp-chip-btn').click();
	await page.waitForTimeout(150);
	h.check((await row(page, 'transform.move').locator('.cp-capture').count()) === 1, '2.6 row 4: clicking the chip turns it into a capture');
	await page.keyboard.press('Alt+Shift+M');
	await page.waitForTimeout(100);
	const pending = await row(page, 'transform.move').locator('.cp-capture').textContent();
	h.check(pending === 'Alt+Shift+M' && (await binding(page, 'transform.move')) === '1', `2.7 the pressed keys wait for Enter (${pending}, still ${await binding(page, 'transform.move')})`);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(250);
	const status1 = await page.locator('#command-palette .cp-status').textContent();
	h.check((await binding(page, 'transform.move')) === 'Alt+Shift+M', '2.8 row 4: Enter saves the new key');
	h.check(/^Shortcut for Move \(translate\) set to Alt\+Shift\+M/.test(String(status1)) && (await page.locator('#command-palette').count()) === 1, `2.9 the palette stays open and says what changed ("${status1}")`);
	// Esc cancels, and does not close the palette
	await row(page, 'transform.move').locator('.cp-chip-btn').click();
	await page.keyboard.press('Alt+Shift+N');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check((await binding(page, 'transform.move')) === 'Alt+Shift+M' && (await page.locator('#command-palette').count()) === 1, '2.10 row 4: Esc cancels the capture (nothing changes, the palette stays)');
	// conflict: Rotate's key 2
	await row(page, 'transform.move').locator('.cp-chip-btn').click();
	await page.keyboard.press('2');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(250);
	const clash = await row(page, 'transform.move').locator('.cp-conflict').textContent().catch(() => '');
	h.check(/2\s*Used by Rotate/.test(String(clash)) && (await binding(page, 'transform.move')) === 'Alt+Shift+M', `2.11 row 4: a taken key shows in the row ("${String(clash).trim()}")`);
	await row(page, 'transform.move').locator('.cp-cancel').click();
	await page.waitForTimeout(200);
	h.check((await row(page, 'transform.move').locator('.cp-conflict').count()) === 0 && (await binding(page, 'transform.rotate')) === '2', '2.12 ...Cancel leaves both rows as they were');
	await row(page, 'transform.move').locator('.cp-chip-btn').click();
	await page.keyboard.press('2');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(200);
	await row(page, 'transform.move').locator('.cp-replace').click();
	await page.waitForTimeout(250);
	const status2 = await page.locator('#command-palette .cp-status').textContent();
	h.check((await binding(page, 'transform.move')) === '2' && (await binding(page, 'transform.rotate')) === '', `2.13 ...Replace: Move takes 2, Rotate is left with no key ("${status2}")`);
	// Backspace = no key
	await page.fill('#command-palette-input', 'Rotate');
	await page.waitForTimeout(250);
	await row(page, 'transform.rotate').hover();
	await page.waitForTimeout(100);
	const addVisible = await row(page, 'transform.rotate').locator('.cp-add').isVisible();
	h.check(addVisible, '2.14 row 4: a row with no key shows a faint "Add shortcut" on hover');
	await row(page, 'transform.rotate').locator('.cp-add').click();
	await page.keyboard.press('Alt+Shift+R');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(200);
	h.check((await binding(page, 'transform.rotate')) === 'Alt+Shift+R', '2.15 ...and Add shortcut binds one');
	await row(page, 'transform.rotate').locator('.cp-chip-btn').click();
	await page.keyboard.press('Backspace');
	await page.waitForTimeout(80);
	const none = await row(page, 'transform.rotate').locator('.cp-capture').textContent();
	await page.keyboard.press('Enter');
	await page.waitForTimeout(200);
	const storedEmpty = await S(page, () => JSON.parse(localStorage.getItem('shortcutOverrides') || '{}')['transform.rotate']);
	h.check(none === 'No key' && (await binding(page, 'transform.rotate')) === '' && storedEmpty === '', `2.16 row 4: Backspace then Enter leaves the row with no key, stored ("${none}", stored ${JSON.stringify(storedEmpty)})`);
	// right-click: Reset to default
	await row(page, 'transform.rotate').click({ button: 'right' });
	await page.waitForSelector('[role="menu"]', { timeout: 4000 });
	const items = await S(page, () => [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] .ctx-row')].map((e) => (e.textContent || '').trim()).filter(Boolean));
	h.check(['Change shortcut', 'Reset to default', 'Open in Settings'].every((w) => items.some((t) => t.startsWith(w))), `2.17 row 4: the right-click menu: Change shortcut, Reset to default, Open in Settings ▸ Shortcuts (${JSON.stringify(items)})`);
	await page.locator('[role="menu"]').getByText('Reset to default', { exact: false }).first().click();
	await page.waitForTimeout(250);
	h.check((await binding(page, 'transform.rotate')) === '2', `2.18 ...Reset to default puts the active keymap's key back (${await binding(page, 'transform.rotate')})`);
	// F2: the keyboard path (row 5)
	await page.fill('#command-palette-input', 'Scale');
	await page.waitForTimeout(250);
	await page.focus('#command-palette-input');
	const scaleIdx = await S(page, () => [...document.querySelectorAll('#command-palette .cp-item')].findIndex((e) => e.getAttribute('data-shortcut') === 'transform.scale'));
	for (let i = 0; i < scaleIdx; i++) await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(150);
	const footHint = await page.locator('#command-palette-change-key').textContent().catch(() => '');
	h.check(/F2\s*Change shortcut/.test(String(footHint)), `2.19 row 5: with a row active the footer names the key that starts the capture ("${footHint}")`);
	await page.keyboard.press('F2');
	await page.waitForTimeout(120);
	h.check((await row(page, 'transform.scale').locator('.cp-capture').count()) === 1, '2.20 row 5: F2 starts the capture on the active row, no mouse');
	await page.keyboard.press('Alt+Shift+S');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(200);
	h.check((await binding(page, 'transform.scale')) === 'Alt+Shift+S', '2.21 ...and Enter saves it');
	await shot(page, 'palette-move-1280');
	// Open in Settings ▸ Shortcuts: lands on that row, filtered; Settings shows the same binding
	await row(page, 'transform.scale').click({ button: 'right' });
	await page.waitForSelector('[role="menu"]', { timeout: 4000 });
	await page.locator('[role="menu"]').getByText('Open in Settings', { exact: false }).first().click();
	await page.waitForTimeout(1800);
	const settingsRow = await S(page, () => {
		const r = document.querySelector('#shortcut-grid [data-shortcut="transform.scale"]');
		const vis = [...document.querySelectorAll('#shortcut-grid [data-shortcut]')].filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null).length;
		return { keys: r?.querySelector('.shortcut-keys')?.textContent ?? null, shown: !!r && /** @type {HTMLElement} */ (r).offsetParent !== null, visible: vis, palette: !!document.getElementById('command-palette') };
	});
	h.check(settingsRow.shown && settingsRow.keys === 'Alt+Shift+S' && !settingsRow.palette, `2.22 Open in Settings ▸ Shortcuts lands on that row and Settings shows the same binding (${JSON.stringify(settingsRow)})`);
	h.check(settingsRow.visible >= 1 && settingsRow.visible <= 6, `2.23 ...filtered to it (${settingsRow.visible} rows shown)`);
	await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(500);
	// a fixed row: greyed with the reason
	await S(page, () => window.__tp.test.v1.focusMode.enterFocus('viewport'));
	await page.waitForTimeout(400);
	await openPalette(page, 'Leave focus mode');
	const fixed = await S(page, () => {
		const r = document.querySelector('#command-palette .cp-item[data-shortcut="view.focus-exit"]');
		const locked = r?.querySelector('.cp-keys-locked');
		return { listed: !!r, title: locked?.getAttribute('title') ?? null, text: locked?.textContent ?? null, button: !!r?.querySelector('.cp-chip-btn, .cp-add') };
	});
	h.check(fixed.listed && fixed.text === 'Escape' && /Escape always leaves focus mode/.test(String(fixed.title)) && !fixed.button, `2.24 row 4: a row that cannot be changed shows its key greyed, the reason on hover (${JSON.stringify(fixed)})`);
	await page.keyboard.press('F2');
	await page.waitForTimeout(120);
	h.check((await page.locator('#command-palette .cp-capture').count()) === 0, '2.25 ...and F2 does not start a capture on it');
	await closePalette(page);
	await S(page, () => window.__tp.test.v1.focusMode.exitFocus());
	await page.waitForTimeout(300);
	// Settings ▸ Shortcuts at 1280: one key column, one row height (row 8)
	await S(page, () => {
		window.__tp.test.v1.settingsSection.set('shortcuts');
		window.__tp.test.v1.settingsOpen.set(true);
	});
	await page.waitForSelector('#shortcut-grid', { timeout: 10000 });
	await page.waitForTimeout(800);
	const sAlign = await S(page, () => {
		const rows = [...document.querySelectorAll('#shortcut-grid .setting-row')].slice(0, 16);
		const cells = rows.map((r) => r.querySelector('.sc-keycell')?.getBoundingClientRect()).filter(Boolean);
		return {
			rights: [...new Set(cells.map((c) => Math.round(/** @type {DOMRect} */ (c).right)))],
			heights: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))],
			chip: !!document.querySelector('#shortcut-grid .shortcut-keys .kc-key')
		};
	});
	h.check(sAlign.rights.length <= 2 && sAlign.chip, `2.26 row 8: Settings ▸ Shortcuts keys sit in one right-aligned column of the shared chips (${JSON.stringify(sAlign)})`);
	h.check(sAlign.heights.includes(32) && sAlign.heights.every((x) => x === 32 || x === 33), `2.27 row 8: Settings rows are the palette's height (${sAlign.heights})`);
	await shot(page, 'settings-shortcuts-1280');
	await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(400);
	await page.setViewportSize({ width: 1920, height: 1080 });
	await page.waitForTimeout(500);
	await openPalette(page, '');
	await shot(page, 'palette-1920');
	await closePalette(page);
	await openMenu(page);
	await shot(page, 'menu-1920');
	await closeMenu(page);

	// ---------------------------------------------------------------- §4 your keymaps + the resets --
	await page.setViewportSize({ width: 1280, height: 900 });
	await S(page, () => window.__tp.test.v1.shortcutsRegistry.resetAllShortcuts());
	await S(page, () => {
		window.__tp.test.v1.settingsSection.set('shortcuts');
		window.__tp.test.v1.settingsOpen.set(true);
	});
	await page.waitForSelector('#keymap-save-as', { timeout: 15000 });
	await page.waitForTimeout(500);
	h.check((await page.locator('#keymap-dirty').count()) === 0, '4.1 (premise) after Reset everything ThePrototype shows no changed dot');
	await S(page, () => window.__tp.test.v1.shortcutsRegistry.setOverride('transform.move', 'Alt+Shift+M'));
	await page.locator('#keymap-preset').dispatchEvent('change').catch(() => {});
	// the card redraws on its own signal: nudge it through the grid's version by a no-op click on the card
	await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(300);
	await S(page, () => window.__tp.test.v1.settingsOpen.set(true));
	await page.waitForSelector('#keymap-save-as', { timeout: 10000 });
	await page.waitForTimeout(500);
	h.check((await page.locator('#keymap-dirty').count()) === 1 && /1 shortcut changed/.test(String(await page.locator('#keymap-changed').textContent())), '4.2 row 9: a rebind on a built-in preset shows the changed dot + "Save as… / Discard"');
	await page.click('#keymap-save-as');
	await page.fill('#keymap-name', 'Lane keys');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(400);
	const saved = await S(page, () => ({ list: JSON.parse(localStorage.getItem('keymapsSaved') || '[]'), active: localStorage.getItem('keymapActive'), selected: /** @type {HTMLSelectElement} */ (document.getElementById('keymap-preset')).selectedOptions[0]?.textContent }));
	h.check(saved.list.length === 1 && saved.list[0].name === 'Lane keys' && saved.list[0].base === 'theprototype' && saved.list[0].changes['transform.move'] === 'Alt+Shift+M' && saved.active === saved.list[0].id && saved.selected === 'Lane keys', `4.3 row 9: Save current as… stores the base preset + the changes and switches to it (${JSON.stringify(saved)})`);
	h.check((await page.locator('#keymap-dirty').count()) === 0, '4.4 ...and it is clean');
	// change it, then switch away: asked first
	await S(page, () => window.__tp.test.v1.shortcutsRegistry.setOverride('transform.scale', 'Alt+Shift+K'));
	await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(300);
	await S(page, () => window.__tp.test.v1.settingsOpen.set(true));
	await page.waitForSelector('#keymap-dirty', { timeout: 10000 });
	await page.selectOption('#keymap-preset', 'preset:blender');
	await page.waitForSelector('#confirm-dialog-discard', { timeout: 5000 });
	const askText = await S(page, () => document.querySelector('.cf')?.textContent || '');
	h.check(/Save changes to Lane keys/.test(askText) && /1 shortcut/.test(askText), `4.5 row 9: switching away from a changed keymap asks first: Save changes / Discard / Cancel ("${askText.replace(/\s+/g, ' ').slice(0, 120)}")`);
	await page.click('#confirm-dialog-cancel');
	await page.waitForTimeout(300);
	const stayed = await S(page, () => ({ sel: /** @type {HTMLSelectElement} */ (document.getElementById('keymap-preset')).value, scale: window.__tp.test.v1.shortcutsRegistry.bindingOf('transform.scale') }));
	h.check(stayed.scale === 'Alt+Shift+K' && stayed.sel !== 'preset:blender', `4.6 ...Cancel keeps the keymap and the change (${JSON.stringify(stayed)})`);
	await page.selectOption('#keymap-preset', 'preset:blender');
	await page.waitForSelector('#confirm-dialog-save', { timeout: 5000 });
	await page.click('#confirm-dialog-save');
	await page.waitForTimeout(600);
	const switched = await S(page, () => ({ preset: localStorage.getItem('keymapPreset'), active: localStorage.getItem('keymapActive'), list: JSON.parse(localStorage.getItem('keymapsSaved') || '[]'), move: window.__tp.test.v1.shortcutsRegistry.bindingOf('transform.now-move') }));
	h.check(switched.preset === 'blender' && !switched.active && switched.list[0].changes['transform.scale'] === 'Alt+Shift+K' && switched.move === 'G', `4.7 ...Save changes saves Lane keys, then Blender style is in force (${JSON.stringify(switched)})`);
	// back to Lane keys: its keys again
	await page.selectOption('#keymap-preset', { label: 'Lane keys' });
	await page.waitForTimeout(600);
	h.check((await binding(page, 'transform.move')) === 'Alt+Shift+M' && (await binding(page, 'transform.scale')) === 'Alt+Shift+K' && (await binding(page, 'transform.now-move')) === '', '4.8 row 9: switching back puts Lane keys in force (its base ThePrototype + its changes)');
	// export
	const [download] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#keymap-export')]);
	const file = path.join(SHOTS, 'lane-keys.keymap.json');
	await download.saveAs(file);
	const json = JSON.parse(fs.readFileSync(file, 'utf8'));
	h.check(json.format === 'theprototype-keymap' && json.version === 1 && json.name === 'Lane keys' && json.base === 'theprototype' && json.changes['transform.move'] === 'Alt+Shift+M', `4.9 row 9: Export downloads a small JSON keymap (${download.suggestedFilename()}, ${fs.statSync(file).size} bytes)`);
	// import (a renamed copy)
	const imp = path.join(SHOTS, 'imported.keymap.json');
	fs.writeFileSync(imp, JSON.stringify({ ...json, name: 'From a file', base: 'unity', changes: { 'transform.rotate': 'Alt+Shift+T' } }));
	await page.setInputFiles('#keymap-import-file', imp);
	await page.waitForTimeout(600);
	const opts = await S(page, () => [.../** @type {HTMLSelectElement} */ (document.getElementById('keymap-preset')).options].map((o) => o.textContent));
	h.check(opts.includes('From a file') && (await binding(page, 'transform.rotate')) === '2', `4.10 row 9: Import adds the keymap (not switched to) (${JSON.stringify(opts)})`);
	await page.selectOption('#keymap-preset', { label: 'From a file' });
	await page.waitForTimeout(600);
	h.check((await binding(page, 'transform.rotate')) === 'Alt+Shift+T' && (await S(page, () => localStorage.getItem('keymapPreset'))) === 'unity', '4.11 ...and switching to it uses its base (Unity) + its change');
	// rename / duplicate / delete
	await page.click('#keymap-rename');
	await page.fill('#keymap-name', 'Imported');
	await page.click('#keymap-name-ok');
	await page.click('#keymap-duplicate');
	await page.waitForTimeout(400);
	const names = await S(page, () => JSON.parse(localStorage.getItem('keymapsSaved') || '[]').map((k) => k.name));
	h.check(JSON.stringify(names) === JSON.stringify(['Lane keys', 'Imported', 'Imported copy']), `4.12 row 9: rename and duplicate (${JSON.stringify(names)})`);
	// row 10: reset this keymap (counted confirm)
	await page.click('#keymap-reset-keymap');
	await page.waitForSelector('#confirm-dialog-ok', { timeout: 5000 });
	const resetMsg = await S(page, () => document.querySelector('.cf')?.textContent || '');
	h.check(/Reset Imported to Unity/.test(resetMsg) && /1 shortcut goes back/.test(resetMsg), `4.13 row 10: "Reset this keymap" says what changes ("${resetMsg.replace(/\s+/g, ' ').slice(0, 110)}")`);
	await page.click('#confirm-dialog-ok');
	await page.waitForTimeout(400);
	h.check((await binding(page, 'transform.rotate')) === '2', '4.14 ...and puts the base preset key back');
	await page.click('#keymap-delete');
	await page.waitForSelector('#confirm-dialog-ok', { timeout: 5000 });
	await page.click('#confirm-dialog-ok');
	await page.waitForTimeout(400);
	h.check((await S(page, () => JSON.parse(localStorage.getItem('keymapsSaved') || '[]').length)) === 2 && !(await S(page, () => localStorage.getItem('keymapActive'))), '4.15 row 9: Delete removes it; the keys stay in force on its base');
	// row 10, level one: a row's reset asks
	await S(page, () => window.__tp.test.v1.shortcutsRegistry.setOverride('transform.move', 'Alt+Shift+M'));
	await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(300);
	await S(page, () => window.__tp.test.v1.settingsOpen.set(true));
	await page.waitForSelector('#shortcut-grid [data-shortcut="transform.move"] .shortcut-reset', { timeout: 10000 });
	await page.click('#shortcut-grid [data-shortcut="transform.move"] .shortcut-reset');
	await page.waitForSelector('#confirm-dialog-ok', { timeout: 5000 });
	const oneMsg = await S(page, () => document.querySelector('.cf')?.textContent || '');
	h.check(/Alt\+Shift\+M back to 1/.test(oneMsg), `4.16 row 10: one shortcut's reset says what changes ("${oneMsg.replace(/\s+/g, ' ').slice(0, 110)}")`);
	await page.click('#confirm-dialog-ok');
	await page.waitForTimeout(300);
	h.check((await binding(page, 'transform.move')) === '1', '4.17 ...and resets it');
	// row 10, level three: everything (counted)
	await S(page, () => {
		const r = window.__tp.test.v1.shortcutsRegistry;
		r.setOverride('transform.move', 'Alt+Shift+M');
		r.setOverride('transform.scale', 'Alt+Shift+K');
	});
	const expectN = await S(page, () => window.__tp.test.v1.shortcutsRegistry.changedFromDefaultsCount());
	await page.click('#keymap-reset-all');
	await page.waitForSelector('#confirm-dialog-ok', { timeout: 5000 });
	const allMsg = await S(page, () => document.querySelector('.cf')?.textContent || '');
	h.check(new RegExp(`${expectN} shortcuts go back to the ThePrototype defaults`).test(allMsg) && /keymap goes back to ThePrototype/.test(allMsg) && /saved keymaps stay/.test(allMsg), `4.18 row 10: "Reset everything" says how many bindings change (${expectN}: "${allMsg.replace(/\s+/g, ' ').slice(0, 150)}")`);
	await page.click('#confirm-dialog-ok');
	await page.waitForTimeout(500);
	const reset = await S(page, () => ({ preset: localStorage.getItem('keymapPreset'), ov: localStorage.getItem('shortcutOverrides'), saved: JSON.parse(localStorage.getItem('keymapsSaved') || '[]').length, n: window.__tp.test.v1.shortcutsRegistry.changedFromDefaultsCount() }));
	h.check(reset.preset === null && reset.ov === null && reset.saved === 2 && reset.n === 0, `4.19 ...everything is ThePrototype again; the saved keymaps stay (${JSON.stringify(reset)})`);
	await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(300);

	// ---------------------------------------------------------------- §3 Ctrl+K on a phone --
	for (const [label, vp] of [['n6-folded', N6_FOLDED], ['n6-unfolded', N6_UNFOLDED]]) {
		const P = await h.setupPage(browser, label, { context: { viewport: vp, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA } });
		const pp = P.page;
		const shell = await S(pp, () => document.documentElement.classList.contains('phone-shell'));
		await openMenu(pp);
		const menuBox = await S(pp, () => {
			const r = /** @type {HTMLElement} */ (document.getElementById('sidebar70')).getBoundingClientRect();
			return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), radius: getComputedStyle(/** @type {Element} */ (document.getElementById('sidebar70'))).borderTopLeftRadius };
		});
		await closeMenu(pp);
		await openPalette(pp, '');
		await pp.waitForTimeout(400);
		const sheet = await S(pp, () => {
			const cp = /** @type {HTMLElement} */ (document.getElementById('command-palette'));
			const r = cp.getBoundingClientRect();
			const s = /** @type {HTMLElement} */ (cp.querySelector('.cp-search')).getBoundingClientRect();
			const l = /** @type {HTMLElement} */ (document.getElementById('command-palette-list')).getBoundingClientRect();
			return {
				layout: cp.dataset.layout,
				left: Math.round(r.left),
				right: Math.round(r.right),
				bottom: Math.round(r.bottom),
				radius: getComputedStyle(cp).borderTopLeftRadius,
				grip: !!cp.querySelector('[data-sheet-grip-zone]'),
				searchFirst: s.bottom <= l.top + 1,
				keys: cp.querySelectorAll('.cp-keycol, .cp-keys, .cp-chip-btn, .cp-add').length,
				foot: !!cp.querySelector('.cp-foot')
			};
		});
		h.check(shell, `3.0 (premise) ${label} runs the phone shell`);
		h.check(sheet.layout === 'sheet' && sheet.grip && sheet.searchFirst, `3.1 row 3 ${label}: Ctrl+K is a sheet with the grip and the search on top (${JSON.stringify(sheet)})`);
		h.check(sheet.left === menuBox.left && sheet.right === menuBox.right && Math.abs(sheet.bottom - menuBox.bottom) <= 1 && sheet.radius === menuBox.radius, `3.2 ${label}: ...the main menu's sheet: same edges, bottom and corners (${JSON.stringify(menuBox)})`);
		h.check(sheet.keys === 0 && !sheet.foot, `3.3 ${label}: no shortcut column and no shortcut editing on a phone`);
		await shot(pp, `palette-${label}`);
		// the on-screen keyboard: the sheet sits above it
		const kb = await S(pp, () => {
			document.documentElement.style.setProperty('--kb-inset', '300px');
			document.documentElement.classList.add('kb-open');
			const r = /** @type {HTMLElement} */ (document.getElementById('command-palette')).getBoundingClientRect();
			const out = { bottom: Math.round(r.bottom), top: Math.round(r.top), vh: innerHeight };
			document.documentElement.style.removeProperty('--kb-inset');
			document.documentElement.classList.remove('kb-open');
			return out;
		});
		h.check(kb.bottom <= kb.vh - 300 + 1 && kb.top >= 0, `3.4 ${label}: with the keyboard up the sheet ends above it and stays on screen (${JSON.stringify(kb)})`);
		// swipe down on the grip closes it
		const grip = await S(pp, () => {
			const g = /** @type {HTMLElement} */ (document.querySelector('#command-palette [data-sheet-grip-zone]')).getBoundingClientRect();
			return { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) };
		});
		const cdp = await pp.context().newCDPSession(pp);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: grip.x, y: grip.y }] });
		for (let i = 1; i <= 14; i++) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: grip.x, y: grip.y + i * 45 }] });
			await pp.waitForTimeout(16);
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await pp.waitForTimeout(700);
		const closed = await S(pp, () => new Promise((r) => window.__tp.test.v1.commandPaletteOpen.subscribe(r)()));
		h.check(closed === false, `3.5 row 3 ${label}: a swipe down on the grip closes it`);
		await P.ctx.close();
	}

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A).slice(0, 3))})`);
	await h.finish(browser);
});
