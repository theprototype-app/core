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
	// W8b: the list MIRRORS THE BAR, so the play well is a row of it too — six buttons
	// plus Play. It reads checked (it IS on the bar) and carries no toggle, because
	// there is no toolbar without a way to press play.
	h.check(
		menu.filter((r) => r.checked).length === 7,
		`Customize lists the six buttons AND the play well as on the bar (${menu.filter((r) => r.checked).length})`
	);
	h.check(
		menu.some((r) => r.label === 'Play' && r.checked),
		`the play well is a row of the list (${menu.map((r) => r.label).join(' | ')})`
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
		(await rows(A.page)).filter((r) => r.checked).length === 6,
		'premise: Customize opens showing the hidden button unchecked (5 buttons + Play)'
	);
	await pick(A.page, 'Reset toolbar');
	// W1: Reset is `keepOpen` too, so the list itself has to show the restored roster
	h.check(await menuOpen(A.page), 'Reset toolbar leaves the Customize list up');
	h.check(
		(await rows(A.page)).filter((r) => r.checked).length === 7,
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

	// ---- W1/W8b: reorder from the Customize rows themselves ---------------------------
	// Per-row controls rather than menu commands: the row already means "this button",
	// and "Move <the one you clicked last> left" would be a mode nobody can see.
	// W8b turned them into ▲/▼ — a VERTICAL list means up and down, and up is toward the
	// LEFT end of the bar, which is the end the first row shows.
	await rowArrow(A.page, 'Move Rotate (2) up');
	titles = await barTitles(A.page);
	h.check(
		titles.slice(0, 2).join(' | ') === 'Rotate (2) | Move (1)',
		`the row's ▲ moved that button one place toward the left end (${titles.join(' | ')})`
	);
	h.check(await menuOpen(A.page), 'and the list stayed up for the next adjustment');
	h.check(
		await A.page.evaluate(
			() => document.querySelector('[role="menu"] button[aria-label="Move Rotate (2) up"]')?.disabled === true
		),
		'its ▲ is refused now that it is the first row — the arrows re-rendered too'
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

	// ---- W8a: the tail every toolbar menu carries grew two rows ---------------------
	// They sit in the SHARED tail, so the play FAB carries them too — which is the one
	// that matters, since a collapsed bar is the FAB and nothing else.
	await cellMenu(A.page, 'Move (1)');
	let tail = await rows(A.page);
	h.check(
		tail.some((r) => r.label === 'Move toolbar'),
		'a cell menu offers Move toolbar'
	);
	h.check(
		tail.some((r) => r.label === 'Reset toolbar position' && r.disabled),
		'...and Reset toolbar position, disabled while the bar has never been moved'
	);
	await closeMenus(A.page);
	await fabMenu(A.page);
	tail = await rows(A.page);
	h.check(
		tail.some((r) => r.label === 'Move toolbar') && tail.some((r) => r.label === 'Reset toolbar position'),
		'...and the play FAB carries both rows too (one shared tail)'
	);
	await closeMenus(A.page);

	// ---- W8a: "Toolbar always on top" is about Z, not geometry -----------------------
	// The two prefs are independent: `floatingToolbar` decides whether the bar LIFTS when
	// a dock opens, this one decides who wins the pixel. With it OFF the bar drops to the
	// drawer tier, where a FLOATING WINDOW covers it — a case the geometry pref cannot
	// express at all, since a window is not the dock.
	const zOf = (sel) =>
		A.page.evaluate((s) => {
			const el = document.querySelector(s);
			return el ? parseInt(getComputedStyle(el).zIndex || '0') : null;
		}, sel);
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(500);
	const listZ = await zOf('#object-list');
	h.check(
		typeof listZ === 'number' && listZ >= 40,
		`premise: a floating window sits on the window tier (z ${listZ})`
	);
	let pillZ = await zOf('#controls-pill');
	h.check(pillZ > listZ, `on by default, the toolbar beats a floating window (z ${pillZ} > ${listZ})`);
	await A.page.evaluate(() => window.__stores.toolbarAlwaysOnTop.set(false));
	await A.page.waitForTimeout(400);
	pillZ = await zOf('#controls-pill');
	h.check(pillZ < listZ, `switched off, the window beats the toolbar instead (z ${pillZ} < ${listZ})`);
	// ...and it is genuinely independent of the geometry pref: the bar still anchors on
	// the dock inset, which is the other pref's job
	const geomStill = await A.page.evaluate(
		() => document.getElementById('controls-pill')?.getAttribute('style') ?? ''
	);
	h.check(
		geomStill.includes('--bottom-inset'),
		'...while still anchoring on --bottom-inset, so the two prefs are independent'
	);
	await A.page.evaluate(() => window.__stores.toolbarAlwaysOnTop.set(true));
	await A.page.waitForTimeout(300);
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(300);

	// ═══ W8b ═══════════════════════════════════════════════════════════════════════
	// Three user reports, one theme: the roster was too rigid. The bar can only hold the
	// six ids it shipped with, the Customize arrows were unusable, and there was no fast
	// way to put a dock view one press away.
	const resetAll = async () => {
		await A.page.evaluate(() => localStorage.removeItem('controlsLayout'));
		await h.freshReload(A);
		await A.page.waitForTimeout(700);
	};
	const dockKey = () =>
		A.page.evaluate(() => {
			let k = null;
			window.__stores.bottomDock.visibleDockKey.subscribe((v) => (k = v))();
			return k;
		});
	const openCustomize = async (from = 'Move (1)') => {
		await cellMenu(A.page, from);
		await pick(A.page, 'Customize toolbar…');
	};

	await resetAll();

	// ---- THE DEFAULT SETUP IS UNCHANGED (the "keep the current default" contract) ----
	// Widening the roster must be invisible to anyone who never opens Customize, so this
	// pins the exact cells, their order AND the well's index — not just a count.
	titles = await barTitles(A.page);
	h.check(
		titles.join(' | ') === DEFAULT.join(' | ') && titles.indexOf('—') === 3,
		`W8b: the default bar is byte-identical — same six, same order, same well slot (${titles.join(' | ')})`
	);
	h.check(
		(await layout(A.page)) === null,
		'W8b: and a profile that never opens Customize still writes nothing'
	);
	await openCustomize();
	menu = await rows(A.page);
	const OPTIONAL = ['Flow Code', 'Animation', 'UV editor', 'Shader editor', 'HUD editor'];
	h.check(
		OPTIONAL.every((t) => menu.some((r) => r.label === t)),
		`the five remaining dock views are LISTED in Customize (${menu.map((r) => r.label).join(' | ')})`
	);
	h.check(
		OPTIONAL.every((t) => !menu.find((r) => r.label === t)?.checked),
		'...every one of them unchecked — optional means off until asked for'
	);
	h.check(
		OPTIONAL.every((t) => !titles.includes(t)),
		'...and none of them on the bar'
	);
	h.check(
		await A.page.evaluate(() =>
			['Flow Code', 'Animation', 'UV editor', 'Shader editor', 'HUD editor'].every(
				(t) => document.querySelector(`[role="menu"] button[aria-label="Move ${t} up"]`)?.disabled === true
			)
		),
		'an off-bar row cannot be reordered — it has no place in the bar, so its arrows are greyed'
	);
	// the ends clamp, on the DEFAULT bar where the first and last rows are known
	h.check(
		await A.page.evaluate(
			() => document.querySelector('[role="menu"] button[aria-label="Move Move (1) up"]')?.disabled === true
		),
		'▲ is refused on the first row'
	);
	h.check(
		await A.page.evaluate(
			() => document.querySelector('[role="menu"] button[aria-label="Move Explorer down"]')?.disabled === true
		),
		'▼ is refused on the last row'
	);
	h.check(
		await A.page.evaluate(
			() =>
				document.querySelector('[role="menu"] button[aria-label="Move Move (1) down"]')?.disabled === false &&
				document.querySelector('[role="menu"] button[aria-label="Move Explorer up"]')?.disabled === false
		),
		'...while the other direction stays live on both'
	);

	// ---- THE ARROW "MESS", MEASURED AND FIXED ---------------------------------------
	// What the user hit, reproduced before the fix: the list was ordered by the STORED
	// order (hidden entries interleaved) while a move only swapped SHOWN buttons, so one
	// press leapfrogged any hidden row between them — two rows travelled, and the ticks
	// appeared to scramble around the unticked one. The list mirrors the visual row now,
	// so a press is exactly one row and can never touch a visibility bit.
	await pick(A.page, 'Rotate (2)'); // hide it: a hidden row now sits BETWEEN the others
	h.check(
		!(await barTitles(A.page)).includes('Rotate (2)'),
		'premise: Rotate is off the bar, so a hidden row is in play'
	);
	const shownBefore = await rows(A.page).then((r) => r.filter((x) => x.checked).map((x) => x.label));
	await rowArrow(A.page, 'Move Move (1) down');
	titles = await barTitles(A.page);
	h.check(
		titles.slice(0, 2).join(' | ') === 'Scale (3) | Move (1)',
		`▼ moved Move exactly ONE place, not past the hidden row (${titles.join(' | ')})`
	);
	const shownAfter = await rows(A.page).then((r) => r.filter((x) => x.checked).map((x) => x.label));
	h.check(
		shownBefore.slice().sort().join(',') === shownAfter.slice().sort().join(','),
		`REORDERING CHANGED NO VISIBILITY — the same set is on the bar (${shownAfter.join(' | ')})`
	);
	// THE LIST *IS* THE BAR, top-to-bottom = left-to-right, play well included. This is
	// what makes the ▲/▼ mapping self-evident, and it is the fix for the leapfrog: the
	// old list was ordered by the STORED order with hidden entries interleaved, so a
	// move that swapped two SHOWN buttons jumped the row over the hidden one between
	// them and the ticks appeared to scramble.
	const barCells = (await barTitles(A.page)).map((t) => (t === '—' ? 'Play' : t));
	h.check(
		shownAfter.join(' | ') === barCells.join(' | '),
		`the Customize rows mirror the bar exactly, well included (rows: ${shownAfter.join(' | ')} / bar: ${barCells.join(' | ')})`
	);
	h.check(
		(await layout(A.page))?.hidden.join(',') === 'rotate',
		'...and the stored hidden list is untouched by the move'
	);

	// "the row you moved stays the row you moved": svelte MOVES the row's DOM node
	// (ContextMenuItems keys on `key`) instead of rewriting the labels in place, so the
	// control you just pressed travels with its button and stays focused. Tagging the
	// node is what makes that unambiguous — under the old unkeyed block the tag would be
	// left behind on whichever row took the slot.
	await A.page.evaluate(() => {
		const el = document.querySelector('[role="menu"] button[aria-label="Move Move (1) down"]');
		if (el) el.dataset.w8b = 'tagged';
	});
	await rowArrow(A.page, 'Move Move (1) down');
	h.check(
		await A.page.evaluate(
			() =>
				document.querySelector('[role="menu"] button[aria-label="Move Move (1) down"]')?.dataset.w8b ===
				'tagged'
		),
		'the moved row keeps its own DOM node — the control travels with the button it names'
	);
	h.check(
		await A.page.evaluate(
			() => document.activeElement?.getAttribute('aria-label') === 'Move Move (1) down'
		),
		'...and stays focused, so a repeat press keeps walking the SAME button'
	);
	titles = await barTitles(A.page);
	h.check(
		titles.indexOf('Move (1)') === 2 && titles.indexOf('—') === 1,
		`a second press walked it one further, across the play well (${titles.join(' | ')})`
	);
	// the two controls must be DISTINGUISHABLE: `Icon`'s map is `MAP[name] ?? Box`, and
	// `chevron-left`/`chevron-right` were in no map at all, so both reorder controls had
	// been drawing the same square since they shipped — which is why the report asks for
	// "normal arrows" at all.
	h.check(
		await A.page.evaluate(() => {
			const up = document.querySelector('[role="menu"] button[aria-label="Move Scale (3) up"] svg');
			const down = document.querySelector('[role="menu"] button[aria-label="Move Scale (3) down"] svg');
			return !!up && !!down && up.innerHTML !== down.innerHTML;
		}),
		'▲ and ▼ render DIFFERENT glyphs (they were two identical fallback boxes)'
	);
	await closeMenus(A.page);
	await resetAll();

	// ---- OPTIONAL VIEWS BECOME REAL BUTTONS -----------------------------------------
	await openCustomize();
	await pick(A.page, 'Animation');
	titles = await barTitles(A.page);
	h.check(
		titles.includes('Animation') && titles.length === 8,
		`enabling Animation put it on the bar (${titles.join(' | ')})`
	);
	h.check(
		titles.join(' | ') === [...DEFAULT, 'Animation'].join(' | '),
		'...appended at the right end, every existing cell untouched'
	);
	await closeMenus(A.page);
	await h.freshReload(A);
	await A.page.waitForTimeout(700);
	h.check(
		(await barTitles(A.page)).includes('Animation'),
		'the optional button SURVIVES a reload (loadLayout used to filter it straight back out)'
	);
	// and it is a real button: pressing it runs the same decision tree the Node editor
	// button and the N key run, which is the whole reason it is worth having
	await A.page.locator('#controls-pill p[title="Animation"]').click();
	await h.eventually(dockKey, (k) => k === 'animation', 'pressing it opens the Animation dock tab');
	await A.page.locator('#controls-pill p[title="Animation"]').click();
	await h.eventually(
		() => A.page.evaluate(() => !!document.querySelector('#controls-pill p[title="Animation"] .text-primary-500')),
		(v) => v === false,
		'...and pressing it again hides the panel, which the "+" list can never do'
	);
	await openCustomize();
	await pick(A.page, 'Animation');
	h.check(
		!(await barTitles(A.page)).includes('Animation'),
		'disabling it takes it off the bar again'
	);
	await closeMenus(A.page);
	await resetAll();

	// ---- SWAP WITH ▸ -----------------------------------------------------------------
	// One press to trade a cell you do not use for a dock view you do. The bar keeps its
	// shape: same cell count, same well slot, nothing else moves.
	const before = await barTitles(A.page);
	await cellMenu(A.page, 'Rotate (2)');
	await A.page.getByRole('menuitem', { name: 'Swap with' }).hover();
	await A.page.waitForTimeout(450);
	menu = await rows(A.page);
	h.check(
		OPTIONAL.every((t) => menu.some((r) => r.label === t)),
		`Swap with ▸ offers every button not on the bar (${menu.map((r) => r.label).join(' | ')})`
	);
	h.check(
		!menu.some((r) => r.label === 'Explorer') && !menu.some((r) => r.label === 'Object list (O)'),
		'...and never one that is already a cell of the bar'
	);
	await A.page.getByRole('menuitem', { name: 'UV editor', exact: true }).click();
	await A.page.waitForTimeout(400);
	titles = await barTitles(A.page);
	h.check(
		titles[1] === 'UV editor',
		`the swapped-in button took the exact slot (${titles.join(' | ')})`
	);
	h.check(
		titles.length === before.length && titles.indexOf('—') === before.indexOf('—'),
		'the bar kept its shape — same cell count, same well slot'
	);
	h.check(!titles.includes('Rotate (2)'), 'and the swapped-out button left the bar');
	await A.page.locator('#controls-pill p[title="UV editor"]').click();
	await h.eventually(dockKey, (k) => k === 'uv', 'the swapped-in button really opens its view');
	// the button it replaced is offerable again — that is what "becomes available" means
	await cellMenu(A.page, 'Move (1)');
	await A.page.getByRole('menuitem', { name: 'Swap with' }).hover();
	await A.page.waitForTimeout(450);
	h.check(
		(await rows(A.page)).some((r) => r.label === 'Rotate (2)'),
		'the swapped-OUT button is back on offer'
	);
	await closeMenus(A.page);

	// ---- ONE TREE FOR EVERY PANEL, INCLUDING THE DOCK-ONLY ONE -----------------------
	// The ShaderEditor is the single view with no `docked` flag, no dragWindow and no
	// window chrome. Without `dockOnly` the tree reads it as floating-only and tries to
	// raise a window that does not exist, so the button does nothing at all.
	await resetAll();
	await openCustomize();
	await pick(A.page, 'Shader editor');
	await closeMenus(A.page);
	await A.page.locator('#controls-pill p[title="Shader editor"]').click();
	await h.eventually(dockKey, (k) => k === 'shader', 'the dock-only Shader editor opens DOCKED');
	h.check(
		await A.page.evaluate(() => {
			let occ = {};
			window.__stores.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
			return !!occ.shader?.present;
		}),
		'...as a dock OCCUPANT — there is no floating mode for it to have tried'
	);
	await A.page.locator('#controls-pill p[title="Shader editor"]').click();
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let v = true;
				window.__stores.shaderEditorClose.subscribe((x) => (v = x))();
				return v;
			}),
		(v) => v === true,
		'...and a second press closes it — a dock-only panel has exactly two states'
	);
	await resetAll();

	h.check(h.pageErrors(A).length === 0, `the page threw nothing (${h.pageErrors(A).join(' / ')})`);
	await h.finish(browser);
});
