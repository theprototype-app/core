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
//
// W1 (this round, from the user's on-device pass) adds four:
//   · the Customize list is `keepOpen` — a toggle re-renders the rows IN PLACE
//     instead of dismissing the list you are working through
//   · Move left / Move right move ONE VISUAL SLOT, so a button next to the play
//     button crosses it and nothing else moves (it used to swap two cells at once)
//   · reorder ‹ › live on each Customize row
//   · the collapsed bar is the well ALONE — no chevron cell — and the way back is
//     the FAB's own menu, with Settings' Reset window positions as the hatch for
//     iOS Safari, where a long press fires no `contextmenu` at all
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

/** the play FAB's own right-click menu (the only door out of a collapsed bar) */
async function fabMenu(page) {
	await page.locator('#play-button').click({ button: 'right' });
	await page.waitForTimeout(350);
}

/** is the shared ContextMenu still on screen? */
const menuOpen = (page) => page.evaluate(() => !!document.querySelector('[role="menu"]'));

/** press a Customize row's inline reorder control (a real button, by its label) */
async function rowArrow(page, label) {
	await page.locator(`[role="menu"] button[aria-label="${label}"]`).click();
	await page.waitForTimeout(350);
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
		titles.join(' | ') === '—',
		`W1: collapsed down to the well ALONE — the chevron cell is gone (${titles.join(' | ')})`
	);
	h.check(
		await A.page.evaluate(() => !document.querySelector('#controls-pill p[title="Expand toolbar"]')),
		'no expand chevron is rendered anywhere on the bar'
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
	await fabMenu(A.page);
	menu = await rows(A.page);
	h.check(
		menu.some((r) => r.label === 'Play (desktop)') && menu.some((r) => r.label === 'Customize toolbar…'),
		`the FAB menu still opens collapsed, modes + tail (${menu.map((r) => r.label).join(' | ')})`
	);
	h.check(!menu.some((r) => r.label === 'Hide button'), 'the play button is never offered "Hide button"');
	h.check(
		menu.some((r) => r.label === 'Expand toolbar') && !menu.some((r) => r.label === 'Collapse toolbar'),
		`W1: collapsed, the tail's collapse row IS the way out (${menu.map((r) => r.label).join(' | ')})`
	);
	h.check(
		menu.find((r) => r.label === 'Move left')?.disabled === true &&
			menu.find((r) => r.label === 'Move right')?.disabled === true,
		'and moving cells is refused while there is only one cell to move'
	);

	// ---- EXPAND, from the FAB menu (the chevron it used to leave behind is gone) -----
	await pick(A.page, 'Expand toolbar');
	titles = await barTitles(A.page);
	h.check(
		titles.length === 6 && titles.includes('Explorer'),
		`the FAB menu brings the bar back exactly as it was (${titles.join(' | ')})`
	);
	h.check((await layout(A.page))?.collapsed === false, 'expanding persisted too');

	// ---- RESET ---------------------------------------------------------------------
	await cellMenu(A.page, 'Explorer');
	await pick(A.page, 'Customize toolbar…');
	h.check(
		(await rows(A.page)).filter((r) => r.checked).length === 5,
		'premise: Customize opens showing the hidden button unchecked'
	);
	await pick(A.page, 'Reset toolbar');
	// W1: Reset is `keepOpen` too, so the list itself has to show the restored roster
	h.check(await menuOpen(A.page), 'Reset toolbar leaves the Customize list up');
	h.check(
		(await rows(A.page)).filter((r) => r.checked).length === 6,
		`and the rows re-rendered IN PLACE — all six read checked again (${(await rows(A.page)).filter((r) => r.checked).length})`
	);
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

	// ---- W1: ONE VISUAL SLOT, and crossing the play button --------------------------
	// The report was "Move left and right near play just swap items around the play
	// button": the old code moved `order` and `spacerIndex` as two independent things,
	// so a step next to the well moved TWO cells. A move is a splice on the visual row
	// now — the button and the well trade places and nothing else shifts.
	const noWell = (list) => list.filter((t) => t !== '—');
	h.check(
		(await barTitles(A.page)).join(' | ') === DEFAULT.join(' | '),
		'premise: the default row, with the well between Scale and Object list'
	);
	await cellMenu(A.page, 'Scale (3)'); // the cell immediately LEFT of the FAB
	await pick(A.page, 'Move right');
	titles = await barTitles(A.page);
	h.check(
		titles.indexOf('—') === 2 && titles[3] === 'Scale (3)',
		`Scale crossed the play button in ONE step (${titles.join(' | ')})`
	);
	h.check(
		noWell(titles).join(' | ') === noWell(DEFAULT).join(' | '),
		`and every other button kept its slot — only the pair swapped (${noWell(titles).join(' | ')})`
	);
	saved = await layout(A.page);
	h.check(
		saved && saved.spacerIndex === 2 && saved.order.join(',') === 'move,rotate,scale,objects,flow,explorer',
		`the RECORD is derived from the row: the well moved, the order did not (spacerIndex=${saved?.spacerIndex} order=${saved?.order.join(',')})`
	);
	await cellMenu(A.page, 'Scale (3)');
	await pick(A.page, 'Move left');
	titles = await barTitles(A.page);
	h.check(titles.join(' | ') === DEFAULT.join(' | '), `Move left undoes it exactly (${titles.join(' | ')})`);

	// the FAB walks the same row: moving the well left is the same single step
	await fabMenu(A.page);
	await pick(A.page, 'Move left');
	titles = await barTitles(A.page);
	h.check(
		titles.indexOf('—') === 2 && noWell(titles).join(' | ') === noWell(DEFAULT).join(' | '),
		`the play button's own Move left walks the well one place (${titles.join(' | ')})`
	);
	await fabMenu(A.page);
	await pick(A.page, 'Move right');
	h.check((await barTitles(A.page)).join(' | ') === DEFAULT.join(' | '), 'and back');

	// ends clamp: the leftmost cell cannot go further left, the rightmost further right
	await cellMenu(A.page, 'Move (1)');
	menu = await rows(A.page);
	h.check(
		menu.find((r) => r.label === 'Move left')?.disabled === true &&
			menu.find((r) => r.label === 'Move right')?.disabled === false,
		'the leftmost cell refuses Move left and offers Move right'
	);
	await closeMenus(A.page);
	await cellMenu(A.page, 'Explorer');
	menu = await rows(A.page);
	h.check(
		menu.find((r) => r.label === 'Move right')?.disabled === true,
		'the rightmost cell refuses Move right'
	);
	await closeMenus(A.page);

	// ---- W1: the Customize list STAYS OPEN and re-renders in place -------------------
	await cellMenu(A.page, 'Move (1)');
	await pick(A.page, 'Customize toolbar…');
	const objectRow = () => rows(A.page).then((list) => list.find((r) => r.label === 'Object list (O)'));
	h.check((await objectRow())?.checked === true, 'premise: Object list reads checked');
	await pick(A.page, 'Object list (O)');
	h.check(await menuOpen(A.page), 'toggling a button does NOT dismiss the Customize list (keepOpen)');
	h.check(
		(await objectRow())?.checked === false,
		'the row flipped IN PLACE — the open menu shows the state it just wrote'
	);
	h.check(
		!(await barTitles(A.page)).includes('Object list (O)'),
		'and the bar really lost the button'
	);
	await pick(A.page, 'Object list (O)');
	h.check(
		(await objectRow())?.checked === true && (await barTitles(A.page)).includes('Object list (O)'),
		'a second click in the same open menu puts it back'
	);

	// ---- W1: reorder from the Customize rows themselves -------------------------------
	// Per-row ‹ › rather than menu commands: the row already means "this button", and
	// "Move <the one you clicked last> left" would be a mode nobody can see.
	await rowArrow(A.page, 'Move Rotate (2) left');
	titles = await barTitles(A.page);
	h.check(
		titles.slice(0, 2).join(' | ') === 'Rotate (2) | Move (1)',
		`the row's ‹ moved that button one place left (${titles.join(' | ')})`
	);
	h.check(await menuOpen(A.page), 'and the list stayed up for the next adjustment');
	h.check(
		await A.page.evaluate(
			() =>
				document.querySelector('[role="menu"] button[aria-label="Move Rotate (2) left"]')?.disabled === true
		),
		'its ‹ is refused now that it is leftmost — the arrows re-rendered too'
	);
	await closeMenus(A.page);
	await h.freshReload(A);
	await A.page.waitForTimeout(600);
	titles = await barTitles(A.page);
	h.check(
		titles.slice(0, 2).join(' | ') === 'Rotate (2) | Move (1)',
		`the Customize reorder survived a reload (${titles.join(' | ')})`
	);

	// back to the defaults for the sections below
	await cellMenu(A.page, 'Explorer');
	await pick(A.page, 'Customize toolbar…');
	await pick(A.page, 'Reset toolbar');
	await closeMenus(A.page);
	h.check(
		(await barTitles(A.page)).join(' | ') === DEFAULT.join(' | '),
		'reset back to the default roster'
	);

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

	// ---- W1: the safety hatch — Settings' Reset window positions ---------------------
	// Every door back out of a customized toolbar is a right-click, and iOS Safari
	// fires no `contextmenu` at all. The app's existing "put my chrome back" button
	// takes the toolbar with it, LIVE (a resetter, not a stored value read at boot).
	await fabMenu(A.page);
	await pick(A.page, 'Collapse toolbar');
	h.check((await barTitles(A.page)).join(' | ') === '—', 'premise: the bar is collapsed to the well');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	// the button lives under INTERFACE ▸ Windows & chrome, and a collapsed
	// AccordionItem renders no body at all in flowbite 1.x — so the section has to be
	// opened before anything can be found inside it
	await A.page.getByText('Interface', { exact: true }).first().click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.evaluate(() => !!document.querySelector('#reset-windows')),
		'premise: Settings ▸ Interface carries the Reset window positions button'
	);
	// a DOM click, like reset-windows.test.cjs: the modal's own chrome is in the way
	await A.page.evaluate(() => document.querySelector('#reset-windows')?.click());
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(300);
	titles = await barTitles(A.page);
	h.check(
		titles.join(' | ') === DEFAULT.join(' | '),
		`Reset window positions restores the default toolbar LIVE, no reload (${titles.join(' | ')})`
	);
	h.check((await layout(A.page)) === null, 'and it clears the stored layout record');

	h.check(h.pageErrors(A).length === 0, `the page threw nothing (${h.pageErrors(A).join(' / ')})`);
	await h.finish(browser);
});
