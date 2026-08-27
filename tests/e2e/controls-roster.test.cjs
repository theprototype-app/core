// Phase 4b: the Controls pill is a DATA ROSTER, not seven hand-written cells.
// It renders `visibleCells` — the shown buttons with the play FAB's well spliced in
// at `spacerIndex` — from a layout record persisted to localStorage under
// `controlsLayout`, and every cell carries a right-click menu that can reorder it,
// hide it, collapse the whole bar or open the Customize checklist.
//
// Everything here is driven the way a user drives it: a REAL right-click on a REAL
// cell, then a real click on a `[role=menuitem]` row. Two documented traps are why:
// ContextMenu's rows are DIVs with role=menuitem (a `button` selector returns []),
// and `checked` renders as bold + a tinted pill, never a glyph — so a probe looking
// for a tick reports the feature missing.
const h = require('./helpers.cjs');

/** the bar as the user sees it: cell titles left to right, `—` for the FAB's well */
const barTitles = (page) =>
	page.evaluate(() =>
		[...(document.querySelector('#controls-pill')?.firstElementChild?.children ?? [])].map(
			(el) => el.getAttribute('title') ?? '—'
		)
	);

const layout = (page) =>
	page.evaluate(() => {
		const raw = localStorage.getItem('controlsLayout');
		return raw ? JSON.parse(raw) : null;
	});

const rows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((el) => ({
			label: el.textContent.trim(),
			checked: el.className.includes('ctx-checked'),
			weight: getComputedStyle(el).fontWeight,
			disabled: el.className.includes('cursor-default')
		}))
	);

const closeMenus = async (page) => {
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
};

/** right-click a toolbar cell by its title and wait for its menu */
async function cellMenu(page, title) {
	await page.locator(`#controls-pill p[title="${title}"]`).click({ button: 'right' });
	await page.waitForTimeout(350);
}

async function pick(page, name) {
	await page.getByRole('menuitem', { name, exact: true }).click();
	await page.waitForTimeout(400);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- premise: the default roster, in the default order ------------------------
	const DEFAULT = ['Move (1)', 'Rotate (2)', 'Scale (3)', '—', 'Object list (O)', 'Node editor (N)', 'Explorer'];
	let titles = await barTitles(A.page);
	h.check(
		titles.join(' | ') === DEFAULT.join(' | '),
		`premise: six buttons around the play well, in order (${titles.join(' | ')})`
	);
	h.check(
		await A.page.evaluate(() => !!document.querySelector('#controls-pill #play-button')),
		'premise: the play FAB lives INSIDE the bar now (it tracks the well)'
	);
	h.check(
		(await layout(A.page)) === null,
		'premise: an untouched toolbar writes nothing to localStorage'
	);

	// ---- HIDE a button through the real Customize menu ----------------------------
	await cellMenu(A.page, 'Move (1)');
	let menu = await rows(A.page);
	h.check(
		menu.some((r) => r.label === 'Customize toolbar…'),
		`a cell's menu carries the shared toolbar tail (${menu.map((r) => r.label).join(' | ')})`
	);
	h.check(
		menu.find((r) => r.label === 'Move left')?.disabled === true,
		'Move left is refused on the leftmost cell'
	);
	await pick(A.page, 'Customize toolbar…');

	menu = await rows(A.page);
	h.check(
		menu.filter((r) => r.checked).length === 6,
		`Customize lists all six buttons as shown (${menu.filter((r) => r.checked).length})`
	);
	const rotate = menu.find((r) => r.label === 'Rotate (2)');
	h.check(
		rotate && rotate.checked && Number(rotate.weight) >= 600,
		`a shown button reads checked as BOLD + tint, not a glyph (weight ${rotate?.weight})`
	);
	h.check(
		menu.some((r) => r.label === 'Reset toolbar'),
		'Customize offers Reset toolbar'
	);

	await pick(A.page, 'Rotate (2)');
	titles = await barTitles(A.page);
	h.check(!titles.includes('Rotate (2)'), `Rotate left the bar (${titles.join(' | ')})`);
	h.check(titles.length === 6, `the bar lost exactly one cell (${titles.length})`);
	h.check(
		titles.indexOf('—') === 2,
		`the well stayed between the same neighbours — spacerIndex followed the hide (${titles.indexOf('—')})`
	);
	let saved = await layout(A.page);
	h.check(
		saved && saved.hidden.join(',') === 'rotate' && saved.spacerIndex === 2,
		`the layout persisted (hidden=${saved?.hidden} spacerIndex=${saved?.spacerIndex})`
	);

	// ---- and it SURVIVES a reload -------------------------------------------------
	await h.freshReload(A);
	await A.page.waitForTimeout(600);
	titles = await barTitles(A.page);
	h.check(
		!titles.includes('Rotate (2)') && titles.length === 6,
		`the hidden button is still hidden after a reload (${titles.join(' | ')})`
	);
	h.check(titles.indexOf('—') === 2, 'the well came back where it was left');

	// ---- REORDER: Move right on Move ----------------------------------------------
	await cellMenu(A.page, 'Move (1)');
	await pick(A.page, 'Move right');
	titles = await barTitles(A.page);
	h.check(
		titles.slice(0, 2).join(' | ') === 'Scale (3) | Move (1)',
		`Move swapped with its right-hand neighbour (${titles.join(' | ')})`
	);
	saved = await layout(A.page);
	h.check(
		saved && saved.order.slice(0, 3).join(',') === 'scale,rotate,move',
		`the new order persisted, hidden entries kept in place (${saved?.order.join(',')})`
	);

	// ---- COLLAPSE ------------------------------------------------------------------
	await cellMenu(A.page, 'Explorer');
	await pick(A.page, 'Collapse toolbar');
	titles = await barTitles(A.page);
	h.check(
		titles.join(' | ') === '— | Expand toolbar',
		`collapsed down to the well plus the way out (${titles.join(' | ')})`
	);
	h.check(
		await A.page.evaluate(() => {
			const fab = document.querySelector('#controls-pill #play-button');
			if (!fab) return false;
			const r = fab.getBoundingClientRect();
			// `closest`, not `===`: the glyph is an <svg> CHILD of the FAB and it is what
			// sits under the centre pixel — the FAB itself is only the hit target
			return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#play-button') === fab;
		}),
		'the play FAB is still the thing under its own centre — collapsing does not bury it'
	);
	h.check(
		(await layout(A.page))?.collapsed === true,
		'the collapsed state persisted'
	);

	// the FAB's own menu still works while collapsed (the mode rows plus the tail)
	await A.page.locator('#play-button').click({ button: 'right' });
	await A.page.waitForTimeout(350);
	menu = await rows(A.page);
	h.check(
		menu.some((r) => r.label === 'Play (desktop)') && menu.some((r) => r.label === 'Customize toolbar…'),
		`the FAB menu still opens collapsed, modes + tail (${menu.map((r) => r.label).join(' | ')})`
	);
	h.check(!menu.some((r) => r.label === 'Hide button'), 'the play button is never offered "Hide button"');
	await closeMenus(A.page);

	// ---- EXPAND, by clicking the chevron the collapse left behind -------------------
	await A.page.locator('#controls-pill p[title="Expand toolbar"]').click();
	await A.page.waitForTimeout(400);
	titles = await barTitles(A.page);
	h.check(
		titles.length === 6 && titles.includes('Explorer'),
		`the chevron brings the bar back exactly as it was (${titles.join(' | ')})`
	);
	h.check((await layout(A.page))?.collapsed === false, 'expanding persisted too');

	// ---- RESET ---------------------------------------------------------------------
	await cellMenu(A.page, 'Explorer');
	await pick(A.page, 'Customize toolbar…');
	await pick(A.page, 'Reset toolbar');
	titles = await barTitles(A.page);
	h.check(
		titles.join(' | ') === DEFAULT.join(' | '),
		`Reset restores the default roster and order (${titles.join(' | ')})`
	);
	h.check(
		(await layout(A.page)) === null,
		'Reset CLEARS the stored record rather than writing the defaults back'
	);
	await h.freshReload(A);
	await A.page.waitForTimeout(600);
	titles = await barTitles(A.page);
	h.check(titles.join(' | ') === DEFAULT.join(' | '), 'and the default survives a reload');

	// ---- the two panel-specific menus ----------------------------------------------
	await cellMenu(A.page, 'Node editor (N)');
	menu = await rows(A.page);
	h.check(
		menu.some((r) => r.label === 'Open Node editor') && menu.some((r) => r.label.includes('Flow Code')),
		`the Node editor cell offers Open + the dock's shared "+" list (${menu.length} rows)`
	);
	await closeMenus(A.page);

	await cellMenu(A.page, 'Explorer');
	menu = await rows(A.page);
	const docked = menu.find((r) => r.label === 'Open as dock tab');
	const floating = menu.find((r) => r.label === 'Open as floating window');
	h.check(
		docked && floating && docked.checked && !floating.checked,
		`the Explorer cell offers both modes, the current one checked (${docked?.checked}/${floating?.checked})`
	);
	await pick(A.page, 'Open as floating window');
	// the toolbar ASKS through the arm store and the panel's own `setDocked` acts — so
	// the flag, the render branch and the dock occupancy all move together. Writing
	// `explorerDocked` from the toolbar instead is measurably inert: the panel reads it
	// once at mount, so nothing would move until the next reload.
	await h.eventually(
		() => A.page.evaluate(() => localStorage.getItem('explorerDocked')),
		(v) => v === 'false',
		'picking the floating mode moves the flag the panel keeps in step with itself'
	);
	await h.eventually(
		() => A.page.evaluate(() => !!document.querySelector('#explorer-window')),
		(v) => v === true,
		'and the panel really is the FLOATING window now, not just a flag nobody read'
	);

	h.check(h.pageErrors(A).length === 0, `the page threw nothing (${h.pageErrors(A).join(' / ')})`);
	await h.finish(browser);
});
