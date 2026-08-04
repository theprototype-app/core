// 15-Q: context-menu redesign — header target strip, quiet section labels,
// per-row icons, right-aligned shortcut hints, hover-intent submenus, a
// type-to-filter row on dense menus (flattened command-palette matches, Enter
// runs the top hit), and Show/Hide REMOVED (the object list's eye toggle owns
// visibility — an object hidden from the menu can't be right-clicked back).
// Functionality is otherwise unchanged; context-menu-v2/overflow keep passing.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a named box, selected, direct object menu opened via the store
	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'Crate 7';
		w.objectActions.selectObject(box.uuid);
		w.objectContextMenu.set({ x: 200, y: 120, uuid: box.uuid });
		return box.uuid;
	});
	await A.page.waitForTimeout(400);

	// ---------- header strip + sections + icons + hints ----------
	const chrome = await A.page.evaluate(() => {
		const menu = document.querySelector('[role="menu"]');
		const header = menu?.querySelector('.ctx-header');
		const sections = [...(menu?.querySelectorAll('.ctx-section') ?? [])].map((s) => s.textContent?.trim());
		const rows = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
		const focusRow = rows.find((r) => r.textContent?.includes('Focus camera'));
		const deleteRow = rows.find((r) => r.textContent?.includes('Delete'));
		return {
			headerText: header?.textContent?.trim() ?? '',
			badge: header?.querySelector('.ctx-badge')?.textContent?.trim(),
			sections,
			focusHasIcon: !!focusRow?.querySelector('.ctx-ico svg'),
			focusHint: focusRow?.querySelector('.ctx-hint')?.textContent?.trim(),
			deleteHint: deleteRow?.querySelector('.ctx-hint')?.textContent?.trim(),
			deleteIsLast: rows[rows.length - 1] === deleteRow,
			labels: rows.map((r) => r.textContent?.trim() ?? '')
		};
	});
	h.check(chrome.headerText.includes('Crate 7'), `header names the target ("${chrome.headerText}")`);
	h.check(chrome.badge === 'Mesh', `header carries the type badge (${chrome.badge})`);
	h.check(
		['Edit', 'Physics & effects', 'Share'].every((s) => chrome.sections.includes(s)),
		`section labels render (${chrome.sections.filter(Boolean)})`
	);
	h.check(chrome.focusHasIcon, 'rows carry lucide icons');
	h.check(chrome.focusHint === 'F' && chrome.deleteHint === 'Del', `shortcut hints render (${chrome.focusHint}/${chrome.deleteHint})`);
	h.check(chrome.deleteIsLast, 'Delete sits last, after the divider');
	h.check(
		!chrome.labels.some((l) => /^(Hide|Show)\b/.test(l)),
		'Show/Hide is gone (the object-list eye owns visibility)'
	);

	// the header names a SET when multi
	const multiHeader = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.objectContextMenu.set(null);
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const other = g.children[g.children.length - 1];
		w.objectActions.applySelectionSet([uuid, other.uuid]);
		w.objectContextMenu.set({ x: 200, y: 120, uuid });
		await new Promise((r) => setTimeout(r, 300));
		const text = document.querySelector('.ctx-header')?.textContent?.trim() ?? '';
		w.objectContextMenu.set(null);
		w.objectActions.deselectObject();
		return text;
	}, uuid);
	h.check(multiHeader.includes('2 objects selected'), `multi header names the set ("${multiHeader}")`);

	// ---------- 16-P1: the filter is mounted + focused but HIDDEN until typing ----
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 220, y: 140, point: [0, 0, 0] }));
	await A.page.waitForTimeout(400);
	const hidden = await A.page.evaluate(() => {
		const input = document.querySelector('.ctx-filter-input');
		const row = document.querySelector('.ctx-filter');
		const itemRow = document.querySelector('[role="menu"] [role="menuitem"]');
		return {
			present: !!input,
			focused: document.activeElement === input,
			rowHeight: row?.getBoundingClientRect().height ?? -1,
			itemHeight: itemRow?.getBoundingClientRect().height ?? -1
		};
	});
	h.check(hidden.present && hidden.focused, 'the filter input is mounted and focused (it owns the keyboard)');
	h.check(hidden.rowHeight === 0, `but takes no space until you type (height ${hidden.rowHeight})`);

	const filter = await A.page.evaluate(async () => {
		const input = document.querySelector('.ctx-filter-input');
		// type "snap to sur" — a submenu-only action must surface, path-prefixed
		input.value = 'snap to sur';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 200));
		const row = document.querySelector('.ctx-filter');
		const itemRow = document.querySelector('.ctx-match');
		return {
			matches: [...document.querySelectorAll('.ctx-match')].map((m) => m.textContent?.trim()),
			rowHeight: row?.getBoundingClientRect().height ?? -1,
			itemHeight: itemRow?.getBoundingClientRect().height ?? -1
		};
	});
	h.check(filter.rowHeight > 0, 'typing reveals the filter row');
	h.check(
		Math.abs(filter.rowHeight - filter.itemHeight) <= 2,
		`the revealed row is item-sized (${Math.round(filter.rowHeight)}px vs ${Math.round(filter.itemHeight)}px)`
	);
	h.check(
		filter.matches.some((m) => m.includes('Snapping ▸') && m.includes('Snap to surface')),
		`submenu actions surface flattened with their path (${filter.matches})`
	);

	// Enter runs the TOP hit — "Snap to surface" toggles the surfaceSnap store
	const ran = await A.page.evaluate(async () => {
		const before = await new Promise((r) => window.__stores.snapping.surfaceSnap.subscribe((v) => r(v))());
		const input = document.querySelector('.ctx-filter-input');
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await new Promise((r) => setTimeout(r, 200));
		const after = await new Promise((r) => window.__stores.snapping.surfaceSnap.subscribe((v) => r(v))());
		const menuGone = !document.querySelector('[role="menu"]');
		// restore
		if (after !== before) window.__stores.snapping.surfaceSnap.set(before);
		return { toggled: after !== before, menuGone };
	});
	h.check(ran.toggled, 'Enter runs the top filtered action');
	h.check(ran.menuGone, 'running an action closes the menu');

	// ---------- 16-Q1: search mode is STICKY, and the menu keeps its anchor -------
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 220, y: 140, point: [0, 0, 0] }));
	await A.page.waitForTimeout(400);
	const sticky = await A.page.evaluate(async () => {
		const input = document.querySelector('.ctx-filter-input');
		const menu = () => document.querySelector('[role="menu"]');
		const type = async (value) => {
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			await new Promise((r) => setTimeout(r, 200));
		};
		const key = async (k) => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
			await new Promise((r) => setTimeout(r, 200));
		};
		const topBefore = menu().getBoundingClientRect().top;
		await type('grid');
		const filtered = document.querySelectorAll('.ctx-match').length;
		// DELETE the query: the box must stay, now listing everything
		await type('');
		const browsing = document.querySelectorAll('.ctx-match').length;
		const rowStillThere = (document.querySelector('.ctx-filter')?.getBoundingClientRect().height ?? 0) > 0;
		const topWhileBrowsing = menu().getBoundingClientRect().top;
		const scrolls = menu().scrollHeight > menu().clientHeight;
		// Esc leaves search, back to the grouped menu
		await key('Escape');
		const grouped = !!menu()?.textContent?.includes('Snapping') && document.querySelectorAll('.ctx-match').length === 0;
		const rowHidden = (document.querySelector('.ctx-filter')?.getBoundingClientRect().height ?? 0) === 0;
		return { topBefore, filtered, browsing, rowStillThere, topWhileBrowsing, scrolls, grouped, rowHidden };
	});
	h.check(sticky.filtered > 0, `typing filters (${sticky.filtered} matches)`);
	h.check(
		sticky.rowStillThere && sticky.browsing > sticky.filtered,
		`clearing the query KEEPS the search box and lists everything (${sticky.browsing} rows)`
	);
	h.check(
		Math.abs(sticky.topWhileBrowsing - sticky.topBefore) < 2,
		`the menu keeps the anchor it opened at (top ${sticky.topBefore} -> ${sticky.topWhileBrowsing})`
	);
	h.check(sticky.scrolls, 'a long list scrolls inside the menu instead of moving it');
	h.check(sticky.grouped && sticky.rowHidden, 'Esc returns to the grouped menu and hides the box');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// ---------- 16-P1: arrow navigation ----------
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 220, y: 140, point: [0, 0, 0] }));
	await A.page.waitForTimeout(400);
	const nav = await A.page.evaluate(async () => {
		const input = document.querySelector('.ctx-filter-input');
		const key = async (k) => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
			await new Promise((r) => setTimeout(r, 120));
		};
		const activeLabel = () => document.querySelector('[data-ctx-active="true"]')?.textContent?.trim() ?? null;
		const rows = [...document.querySelectorAll('[role="menu"] > [role="menuitem"]')].map((r) =>
			r.textContent?.trim()
		);
		await key('ArrowDown');
		const first = activeLabel();
		await key('ArrowDown');
		const second = activeLabel();
		await key('ArrowUp');
		const backToFirst = activeLabel();
		// walk down to a row WITH children ("Add"), then Enter opens its submenu
		let guard = 0;
		while (guard++ < 12 && !(activeLabel() ?? '').startsWith('Add')) await key('ArrowDown');
		const onParent = activeLabel();
		await key('Enter');
		// the submenu is the fixed box without a role
		const submenuOpen = [...document.querySelectorAll('div[style*="position"], div')].some(
			(d) => getComputedStyle(d).position === 'fixed' && !d.getAttribute('role') && d.querySelector('[role="menuitem"]')
		);
		const insideSubmenu = activeLabel();
		await key('Escape'); // leaves the submenu, keeps the menu open
		const stillOpen = !!document.querySelector('[role="menu"]');
		const submenuClosed = ![...document.querySelectorAll('div')].some(
			(d) => getComputedStyle(d).position === 'fixed' && !d.getAttribute('role') && d.querySelector('[role="menuitem"]')
		);
		return { rows, first, second, backToFirst, onParent, submenuOpen, insideSubmenu, stillOpen, submenuClosed };
	});
	h.check(nav.first === nav.rows[0], `ArrowDown highlights the first row (${nav.first})`);
	h.check(nav.second && nav.second !== nav.first, `ArrowDown moves on (${nav.second})`);
	h.check(nav.backToFirst === nav.first, 'ArrowUp moves back');
	h.check(nav.submenuOpen, `Enter on "${nav.onParent}" opens its submenu`);
	h.check(
		(nav.insideSubmenu ?? '').startsWith('Mesh'),
		`the highlight moves INTO the submenu, not the parent row (${nav.insideSubmenu})`
	);
	h.check(nav.stillOpen && nav.submenuClosed, 'Escape inside a submenu closes only the submenu');

	// ---------- 16-Q1: stepping out of a submenu keeps the parent's cursor -------
	const cursorMemory = await A.page.evaluate(async () => {
		const input = document.querySelector('.ctx-filter-input');
		const key = async (k) => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
			await new Promise((r) => setTimeout(r, 130));
		};
		const activeLabel = () => document.querySelector('[data-ctx-active="true"]')?.textContent?.trim() ?? null;
		// walk down a few rows to a submenu row that is NOT the first row
		let guard = 0;
		while (guard++ < 12 && !(activeLabel() ?? '').startsWith('Tools')) await key('ArrowDown');
		const parentRow = activeLabel();
		await key('Enter'); // into Tools
		const inside = activeLabel();
		await key('Escape'); // back out
		const backOn = activeLabel();
		return { parentRow, inside, backOn };
	});
	h.check(
		(cursorMemory.parentRow ?? '').startsWith('Tools') && !!cursorMemory.inside,
		`descended into a submenu from a mid-list row (${cursorMemory.parentRow} -> ${cursorMemory.inside})`
	);
	h.check(
		(cursorMemory.backOn ?? '').startsWith('Tools'),
		`stepping back keeps the cursor on the row we came from (${cursorMemory.backOn})`
	);
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// ---------- Esc semantics: query → search mode → menu (16-Q1: search is sticky,
	// so leaving it is its own step) ----------
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 220, y: 140, point: [0, 0, 0] }));
	await A.page.waitForTimeout(400);
	const esc = await A.page.evaluate(async () => {
		const input = document.querySelector('.ctx-filter-input');
		const esc = async () => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			await new Promise((r) => setTimeout(r, 160));
		};
		input.value = 'grid';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 150));
		await esc();
		const clearedNotClosed = !!document.querySelector('[role="menu"]') && input.value === '';
		const stillSearching = document.querySelectorAll('.ctx-match').length > 0;
		await esc();
		const groupedAgain =
			!!document.querySelector('[role="menu"]') && document.querySelectorAll('.ctx-match').length === 0;
		await esc();
		const closed = !document.querySelector('[role="menu"]');
		return { clearedNotClosed, stillSearching, groupedAgain, closed };
	});
	h.check(esc.clearedNotClosed && esc.stillSearching, 'Esc clears the query but stays in search');
	h.check(esc.groupedAgain, 'a second Esc leaves search for the grouped menu');
	h.check(esc.closed, 'a third Esc closes the menu');


	// ---------- 16-Q5: opening rules + the search box keeps the top -------------
	const placement = await A.page.evaluate(async () => {
		const w = window.__stores;
		const open = async (y) => {
			w.viewportMenu.set(null);
			await new Promise((r) => setTimeout(r, 150));
			w.viewportMenu.set({ x: 240, y, point: [0, 0, 0] });
			await new Promise((r) => setTimeout(r, 350));
			const el = document.querySelector('[role="menu"]');
			const rect = el.getBoundingClientRect();
			return {
				top: Math.round(rect.top),
				bottom: Math.round(rect.bottom),
				scrolls: el.scrollHeight > el.clientHeight + 1,
				vh: window.innerHeight
			};
		};
		const roomy = await open(80);
		const tight = await open(window.innerHeight - 40);
		const input = document.querySelector('.ctx-filter-input');
		const topBeforeSearch = document.querySelector('[role="menu"]').getBoundingClientRect().top;
		input.value = 'e';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 400));
		const menu = document.querySelector('[role="menu"]');
		const searching = menu.getBoundingClientRect();
		const grip = !!menu.querySelector('.ctx-grip');
		w.viewportMenu.set(null);
		return {
			roomy,
			tight,
			topBeforeSearch: Math.round(topBeforeSearch),
			searchTop: Math.round(searching.top),
			searchHeight: Math.round(searching.height),
			grip
		};
	});
	h.check(
		Math.abs(placement.roomy.top - 80) <= 2,
		`with room below, the menu opens AT the cursor (top ${placement.roomy.top})`
	);
	h.check(
		placement.tight.bottom <= placement.tight.vh && !placement.tight.scrolls,
		`with no room below it shifts UP, bottom inside, no scrollbar (${JSON.stringify(placement.tight)})`
	);
	h.check(
		Math.abs(placement.searchTop - placement.topBeforeSearch) <= 2,
		`searching keeps the top where it was (${placement.topBeforeSearch} -> ${placement.searchTop})`
	);
	h.check(
		placement.searchHeight <= 400,
		`the search list keeps a reasonable height instead of unfolding (${placement.searchHeight}px)`
	);
	h.check(placement.grip, 'a resize grip appears while searching');

	await h.finish(browser);
});
