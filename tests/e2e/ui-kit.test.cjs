// 38 R2 + R3: the redesign tokens and the UI-kit primitives, driven on the dev-only /kit page
// (no app boot, no peers). What it pins:
//   - TOKENS: the default dark theme leaves the five legacy-colliding names (--text --text-2
//     --border --accent --surface-2) UNDEFINED on :root — the ~400 per-site fallbacks that keep
//     the default look unchanged — while inside `.tp-ui` they carry the SPEC values; light has
//     its own; a custom .theme.json with legacy keys only DERIVES every redesign token; every
//     text pair in the kit's contrast table is >= 4.5:1 in dark, light and that custom theme.
//   - Toggle (aria-pressed, click + Space, disabled), Segmented (radiogroup, ONE tab stop,
//     arrows move + select, wrap, skip disabled), Tabs (tablist, automatic activation, panel
//     wiring, disabled skipped), Chips (single + multi).
//   - Sheet: open at a detent, handle keys, Escape, a slow drag settles on the NEAREST detent,
//     a fast flick moves ONE detent, a drag below peek dismisses.
//   - PropRow passes DragRow through untouched: scrub (with its start/end bracket), Shift =
//     fine, click-to-type, Esc reverts, and the slider drives the same onchange.
const h = require('./helpers.cjs');

const KIT = h.URL.replace(/\/?$/, '/') + 'kit';

h.run(async () => {
	const browser = await h.launch();
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	/** @type {string[]} */
	page.__errors = [];
	page.on('pageerror', (e) => page.__errors.push(e.message));

	/** @param {string} theme */
	async function open(theme) {
		await page.goto(KIT + '?theme=' + theme, { waitUntil: 'networkidle', timeout: 90000 });
		await page.waitForSelector('#kit-contrast tbody tr', { timeout: 60000 });
		await page.waitForTimeout(300);
	}
	/** resolved custom properties on :root and on the kit's .tp-ui root */
	const tokens = (/** @type {string[]} */ names) =>
		page.evaluate((names) => {
			const root = getComputedStyle(document.documentElement);
			const ui = getComputedStyle(/** @type {Element} */ (document.querySelector('.kit')));
			/** @type {Record<string, {root: string, ui: string}>} */
			const out = {};
			for (const n of names) out[n] = { root: root.getPropertyValue(n).trim(), ui: ui.getPropertyValue(n).trim() };
			return out;
		}, names);
	const lowContrast = () =>
		page.$$eval('#kit-contrast tbody tr', (rows) =>
			rows.filter((r) => Number(r.getAttribute('data-ratio')) < 4.5).map((r) => r.textContent?.replace(/\s+/g, ' ').trim())
		);

	// ---------------- tokens ----------------
	await open('dark');
	let t = await tokens(['--text', '--border', '--accent', '--surface-2', '--text-2', '--bg-app', '--surface-1', '--accent-fill']);
	h.check(['--text', '--border', '--accent', '--surface-2', '--text-2'].every((n) => t[n].root === ''), 'dark: the five colliding names stay UNDEFINED on :root (legacy fallbacks keep the default look)');
	h.check(t['--text'].ui === '#e6e9ef' && t['--accent'].ui === '#3b7cf0' && t['--surface-2'].ui === '#1b212d', `dark: .tp-ui carries the SPEC values (${t['--text'].ui} ${t['--accent'].ui} ${t['--surface-2'].ui})`);
	h.check(t['--bg-app'].root === '#0b0e14' && t['--surface-1'].root === '#151a24', 'dark: the other SPEC tokens are global');
	h.check(t['--accent-fill'].ui === '#2f6fe0', `dark: filled buttons use #2f6fe0 inside the scope (${t['--accent-fill'].ui})`);
	h.check(t['--accent-fill'].root === '#2563eb', 'dark: the legacy --accent-fill outside the scope is unchanged');
	let low = await lowContrast();
	h.check(low.length === 0, 'dark: every kit text pair >= 4.5:1' + (low.length ? ' — ' + low.join(' | ') : ''));

	await open('light');
	t = await tokens(['--text', '--surface-2', '--bg-app', '--surface-1']);
	h.check(t['--text'].root === '#111827' && t['--surface-2'].root === '#e5e7eb', 'light: the phase-89 legacy values on :root are untouched');
	h.check(t['--text'].ui === '#141922' && t['--surface-2'].ui === '#f5f7fa' && t['--surface-1'].root === '#ffffff', 'light: the redesign values inside .tp-ui');
	low = await lowContrast();
	h.check(low.length === 0, 'light: every kit text pair >= 4.5:1' + (low.length ? ' — ' + low.join(' | ') : ''));

	await open('custom');
	t = await tokens(['--surface-1', '--bg-app', '--surface-inset', '--text-muted', '--accent', '--accent-soft']);
	h.check(t['--surface-1'].ui === '#1a1528' && t['--bg-app'].ui === '#120f1c' && t['--surface-inset'].ui === '#150f22', 'custom (legacy keys only): surfaces derive from --surface / --surface-deep / --field');
	h.check(t['--accent'].ui === '#b47af2' && t['--text-muted'].ui === '#aa9dd0', 'custom: its own accent and muted reach the scope');
	const softBg = await page.evaluate(() => {
		const el = document.createElement('i');
		el.style.background = 'var(--accent-soft)';
		document.querySelector('.kit')?.appendChild(el);
		const c = getComputedStyle(el).backgroundColor;
		el.remove();
		return c;
	});
	h.check(!/^rgba?\(0, 0, 0(, 0)?\)$/.test(softBg) && softBg !== 'rgb(34, 48, 74)', `custom: --accent-soft is mixed from ITS accent, not the dark literal (${softBg})`);
	low = await lowContrast();
	h.check(low.length === 0, 'custom: every kit text pair >= 4.5:1' + (low.length ? ' — ' + low.join(' | ') : ''));
	const pressedChip = await page.$eval('#kit-chips [aria-pressed="true"]', (el) => getComputedStyle(el).borderColor);
	h.check(pressedChip === 'rgb(180, 122, 242)', `custom: a selected chip paints in the custom accent (${pressedChip})`);

	await open('dark');
	const saved = await page.evaluate(() => localStorage.getItem('theme'));
	h.check(saved !== 'custom-kit' && saved !== 'custom', 'the kit never writes the app theme it previews');

	// ---------------- Toggle ----------------
	const tg = page.locator('[data-testid="kit-toggle-off"]');
	h.check((await tg.getAttribute('aria-pressed')) === 'false', 'Toggle starts off (aria-pressed=false)');
	await tg.click();
	h.check((await tg.getAttribute('aria-pressed')) === 'true', 'Toggle: click turns it on');
	await tg.focus();
	await page.keyboard.press('Space');
	h.check((await tg.getAttribute('aria-pressed')) === 'false', 'Toggle: Space turns it off');
	const dis = page.getByRole('button', { name: 'Disabled off' });
	await dis.click({ force: true });
	h.check((await dis.getAttribute('aria-pressed')) === 'false', 'Toggle: disabled ignores a click');
	const size = await tg.boundingBox();
	h.check(!!size && Math.round(size.width) === 40 && Math.round(size.height) === 24, `Toggle is 40x24 on desktop (${size?.width}x${size?.height})`);

	// ---------------- Segmented ----------------
	const seg = page.locator('[data-testid="kit-seg-text"]');
	h.check((await seg.getAttribute('role')) === 'radiogroup', 'Segmented is a radiogroup');
	const radios = seg.getByRole('radio');
	const checkedLabel = async () => (await seg.locator('[aria-checked="true"]').textContent())?.trim();
	await radios.nth(1).click();
	h.check((await checkedLabel()) === 'Always', 'Segmented: click selects');
	h.check((await seg.locator('[tabindex="0"]').count()) === 1, 'Segmented: exactly one tab stop');
	await page.keyboard.press('ArrowRight');
	h.check((await checkedLabel()) === 'Never', 'Segmented: ArrowRight moves AND selects');
	await page.keyboard.press('ArrowRight');
	h.check((await checkedLabel()) === 'Auto', 'Segmented: wraps at the end');
	const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
	h.check(focused === 'Auto', 'Segmented: focus follows the selection');
	const states = page.getByRole('radiogroup', { name: 'States' });
	await states.getByRole('radio', { name: 'Off' }).click();
	await page.keyboard.press('ArrowRight');
	h.check((await states.locator('[aria-checked="true"]').textContent())?.trim() === 'On', 'Segmented: a disabled option is skipped');

	// ---------------- Tabs ----------------
	const tabs = page.getByRole('tablist', { name: 'Modules' });
	const panel = page.locator('[data-testid="kit-tab-panel"]');
	await tabs.getByRole('tab', { name: /^User/ }).click();
	h.check((await panel.textContent())?.includes('user') === true, 'Tabs: click switches the panel');
	await page.keyboard.press('ArrowRight');
	h.check((await panel.textContent())?.includes('browse') === true, 'Tabs: ArrowRight activates the next tab');
	await page.keyboard.press('ArrowRight');
	h.check((await panel.textContent())?.includes('core') === true, 'Tabs: the disabled tab is skipped and the strip wraps');
	await page.keyboard.press('End');
	h.check((await panel.textContent())?.includes('browse') === true, 'Tabs: End = last ENABLED tab');
	const wiring = await page.evaluate(() => {
		const p = document.querySelector('[role="tabpanel"]#kit-mod-panel-browse');
		const tab = document.getElementById(p?.getAttribute('aria-labelledby') ?? '');
		return !!p && tab?.getAttribute('aria-selected') === 'true' && tab?.getAttribute('aria-controls') === p.id;
	});
	h.check(wiring, 'Tabs: tab and tabpanel are wired (aria-controls / aria-labelledby)');
	const vertical = await page.keyboard.press('ArrowDown').then(() => panel.textContent());
	h.check(vertical?.includes('browse') === true, 'Tabs: a horizontal strip ignores ArrowDown');

	// ---------------- Chips ----------------
	const single = page.locator('[data-testid="kit-chips-single"]');
	await single.getByRole('button', { name: 'Night' }).click();
	h.check((await single.locator('[aria-pressed="true"]').count()) === 1 && (await single.getByRole('button', { name: 'Night' }).getAttribute('aria-pressed')) === 'true', 'Chips: single choice keeps exactly one pressed');
	const multi = page.getByRole('group', { name: 'Object filters' });
	await multi.getByRole('button', { name: /Groups/ }).click();
	h.check((await multi.locator('[aria-pressed="true"]').count()) === 3, 'Chips: multiple adds to the set');

	// ---------------- Sheet ----------------
	const sheetState = () => page.locator('[data-testid="kit-sheet-state"]').textContent();
	const sheetEl = page.locator('[data-testid="kit-sheet-el"]');
	const sheetHeight = async () => {
		const box = await sheetEl.boundingBox();
		return box ? Math.round(900 - box.y) : 0; // visible height above the viewport bottom
	};
	await page.click('[data-testid="kit-sheet-half"]');
	await page.waitForTimeout(400);
	h.check((await sheetEl.getAttribute('data-detent')) === 'half', 'Sheet opens at half');
	h.check(Math.abs((await sheetHeight()) - 450) <= 2, `Sheet: half = 50% of the viewport (${await sheetHeight()}px)`);
	const handle = page.locator('.sh-handle');
	await handle.focus();
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(350);
	h.check((await sheetEl.getAttribute('data-detent')) === 'full', 'Sheet: ArrowUp on the handle steps to full');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(350);
	h.check((await sheetEl.getAttribute('data-detent')) === 'peek', 'Sheet: ArrowDown steps back down to peek');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check((await sheetState())?.includes('closed') === true, 'Sheet: Escape closes it');

	/** drag the handle by dy, `steps` moves `pause` ms apart @param {number} dy @param {number} steps @param {number} pause */
	async function dragHandle(dy, steps, pause) {
		const b = await handle.boundingBox();
		if (!b) return;
		const x = b.x + b.width / 2;
		const y = b.y + b.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) {
			await page.mouse.move(x, y + (dy * i) / steps);
			if (pause) await page.waitForTimeout(pause);
		}
		await page.mouse.up();
		await page.waitForTimeout(400);
	}
	// slow drag from half up to just short of full: the NEAREST detent (full)
	await page.click('[data-testid="kit-sheet-half"]');
	await page.waitForTimeout(400);
	await dragHandle(-300, 20, 60);
	h.check((await sheetEl.getAttribute('data-detent')) === 'full', 'Sheet: a slow drag settles on the nearest detent (half → full)');
	// a fast flick DOWN a short way from full: one detent down, though full is nearer
	await dragHandle(80, 3, 0);
	h.check((await sheetEl.getAttribute('data-detent')) === 'half', 'Sheet: a fast flick moves one detent (full → half)');
	// a slow drag far below peek: dismissed
	await dragHandle(420, 20, 60);
	h.check((await sheetState())?.includes('closed') === true, 'Sheet: dragging below peek dismisses it');

	// ---------------- PropRow → DragRow, unchanged ----------------
	const readout = () => page.locator('[data-testid="kit-prop-readout"]').textContent();
	const box = page.locator('#kit-exposure');
	await box.scrollIntoViewIfNeeded(); // raw mouse events need it on screen (.kit is the scroller)
	const vb = await box.boundingBox();
	if (vb) {
		const y = vb.y + vb.height / 2;
		await page.mouse.move(vb.x + 20, y);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(vb.x + 20 + i * 5, y);
		await page.mouse.up();
	}
	let r = await readout();
	h.check(/Exposure 1\.50/.test(r ?? ''), `PropRow: a 50px scrub moves the value by step x px through DragRow (${r?.match(/Exposure [\d.]+/)?.[0]})`);
	h.check(/scrubs started 1, ended 1/.test(r ?? ''), 'PropRow: onscrubstart / onscrubend pass through (one undo bracket)');
	if (vb) {
		const y = vb.y + vb.height / 2;
		await page.keyboard.down('Shift');
		await page.mouse.move(vb.x + 20, y);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(vb.x + 20 + i * 5, y);
		await page.mouse.up();
		await page.keyboard.up('Shift');
	}
	r = await readout();
	h.check(/Exposure 1\.55/.test(r ?? ''), `PropRow: Shift scrubs at a tenth (${r?.match(/Exposure [\d.]+/)?.[0]})`);
	await box.click();
	await page.waitForTimeout(100); // DragRow selects all on the next frame, so typing replaces
	await page.keyboard.type('2.5');
	r = await readout();
	h.check(/Exposure 2\.50/.test(r ?? ''), 'PropRow: click-to-type applies live');
	// Esc after ARROW steps restores the focus-time value (number-fields' case). NOT after
	// typing: DragRow's blur() fires the native `change` with the typed text still in the box,
	// which re-commits it — a pre-existing DragRow behaviour (QUESTIONS-38-tokens Q4), locked
	// by SPEC §0, so PropRow passes it through as it is.
	await page.keyboard.press('Escape'); // leaves 2.50 (see above)
	await box.click();
	await page.waitForTimeout(100);
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('ArrowUp');
	r = await readout();
	h.check(/Exposure 2\.52/.test(r ?? ''), `PropRow: ArrowUp steps one minor unit (${r?.match(/Exposure [\d.]+/)?.[0]})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(100);
	r = await readout();
	h.check(/Exposure 2\.50/.test(r ?? ''), `PropRow: Esc restores the value it was focused with (${r?.match(/Exposure [\d.]+/)?.[0]})`);
	await page.$eval('#kit-proprow input[type="range"]', (el) => {
		const input = /** @type {HTMLInputElement} */ (el);
		input.value = '0.75';
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	r = await readout();
	h.check(/Exposure 0\.75/.test(r ?? ''), 'PropRow: the slider drives the same onchange');
	const mono = await page.$eval('#kit-exposure', (el) => getComputedStyle(el).fontFamily);
	h.check(/Plex Mono/.test(mono), `PropRow: the value box is mono (${mono})`);

	h.check(page.__errors.length === 0, 'no page errors on /kit' + (page.__errors.length ? ': ' + page.__errors[0] : ''));
	await h.finish(browser);
});
