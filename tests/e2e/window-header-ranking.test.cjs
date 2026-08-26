// R22 ROUND 25 — WHAT A NARROW WINDOW HEADER KEEPS.
//
//   "if window size is small (or resized) without space to show all header text/buttons
//    and no space for buttons arrows left/right (with number of total files), cog and X
//    should always show, the rest hide"
//   "for preview of objects/images window there is still size when X is not seen, but
//    100% - + are visible, hide them before X disappears"
//   "same for explorer undocked header if no space (dock button and X button should be
//    always visible), you may hide Explorer text keeping only its Lucide icon and hide
//    search assets box, hide project name"
//   "same for object list window, probably smallest size just should show lucide icon and
//    hide Objects text"
//
// THE RULE THESE THREE SHARE, and the reason they are one suite: when a flex row overflows,
// what falls off the end is whatever is LAST in the markup — and in every one of these
// headers that is the way OUT (the close button, or the dock). So each header needs a
// ranking that sheds its expendable pieces early enough that the row still fits, and the
// test of a ranking is not "does something hide" but "is the exit still there when it
// does".
//
// MEASURED WITH A ResizeObserver in all three, never a media query: a floating window is
// resized by its own grip and can be 240px wide on a 1440px screen, so the viewport says
// nothing about it. A container query would read the right box but brings containment that
// makes the element a containing block for `position: fixed` descendants — the documented
// transform/backdrop-filter trap by another door, and all three of these host menus.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- window-header-ranking
const h = require('./helpers.cjs');

/** width of an element, 0 when it is not drawn — `display: none` reports 0 */
const widths = (peer, sel, ids) =>
	peer.page.evaluate(
		({ sel, ids }) => {
			const root = document.querySelector(sel);
			if (!root) return null;
			const out = { _w: Math.round(root.getBoundingClientRect().width) };
			for (const [key, q] of Object.entries(ids)) {
				const el = root.querySelector(q);
				out[key] = el ? Math.round(el.getBoundingClientRect().width) : 0;
			}
			return out;
		},
		{ sel, ids }
	);

/** does the row overflow its own box — the thing that pushes the exit off the end */
const overflows = (peer, sel) =>
	peer.page.evaluate((s) => {
		const el = document.querySelector(s);
		return el ? el.scrollWidth > el.clientWidth + 1 : null;
	}, sel);

const setW = (peer, sel, px) =>
	peer.page.evaluate(
		({ s, px }) => {
			const el = document.querySelector(s);
			if (el) el.style.width = px + 'px';
		},
		{ s: sel, px }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.explorer && !!window.__stores?.filePreview, null, {
		timeout: 30000
	});
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.explorer.clearLibrary();
	});

	// =====================================================================================
	// 1. THE PREVIEW WINDOW — the zoom trio goes before the exit can be pushed off
	// =====================================================================================
	const img = await page.evaluate(async () => {
		const png = [
			137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0,
			0, 0, 253, 212, 154, 115, 0, 0, 0, 22, 73, 68, 65, 84, 120, 156, 99, 252, 207, 192, 240, 159,
			129, 129, 129, 137, 129, 129, 1, 0, 39, 226, 4, 253, 55, 194, 200, 216, 0, 0, 0, 0, 73, 69, 78,
			68, 174, 66, 96, 130
		];
		return (await window.__stores.explorer.addItemFromBytes(new Uint8Array(png).buffer, 'wide.png', null))
			.id;
	});
	await page.waitForTimeout(800);
	// OPEN IT ONLY IF IT IS SHUT: '#explorer-slot' TOGGLES, so a bare click is right only if
	// you already know which way it will go. Clicking blind is what made this section pass
	// and fail on alternate runs while nothing about the app changed.
	if (!(await page.locator('#explorer-grid').count())) {
		await page.locator('#explorer-slot').click({ timeout: 20000 });
	}
	await h.eventually(
		() => page.locator('[data-card-id="' + img + '"]').count(),
		(n) => n === 1,
		'premise: the library card is on screen',
		15000
	);
	await page.locator('[data-card-id="' + img + '"]').dblclick();
	await page.waitForTimeout(1200);

	const PV = '#image-preview-window';
	const PVH = PV + ' .ui-panel-header';
	const pvIds = {
		prev: '#preview-prev',
		place: '#preview-place',
		next: '#preview-next',
		up: '#preview-up',
		title: '.pv-title',
		zoom: '#image-zoom',
		cog: '#preview-cog',
		close: 'button[title="Close"]'
	};
	const wide = await widths(A, PVH, pvIds);
	h.check(
		!!wide && wide.zoom > 0 && wide.title > 0 && wide.up > 0,
		'premise: at 520px the preview header shows everything (' + JSON.stringify(wide) + ')'
	);

	// THE REPORTED SIZE: wide enough that the zoom trio still rendered, narrow enough that
	// the close button had been pushed off the end.
	await setW(A, PV, 340);
	await page.waitForTimeout(600);
	const mid = await widths(A, PVH, pvIds);
	h.check(mid.zoom === 0, 'at 340px the zoom trio has gone — the wheel and a double-click still do it');
	h.check(
		mid.close > 0 && mid.cog > 0,
		'...which is the point: the cog and the EXIT are still there (' + JSON.stringify(mid) + ')'
	);
	h.check(
		mid.prev > 0 && mid.place > 0 && mid.next > 0,
		'...and so is the walk, which is the group the user asked to pin'
	);
	h.check((await overflows(A, PVH)) === false, '...and the row is not overflowing at all');

	// and all the way down
	for (const w of [300, 260, 220, 190]) {
		await setW(A, PV, w);
		await page.waitForTimeout(450);
		const g = await widths(A, PVH, pvIds);
		h.check(
			g.close > 0 && g.cog > 0 && g.prev > 0 && g.place > 0 && g.next > 0,
			'at ' + w + 'px the walk, the cog and the exit all survive (' + JSON.stringify(g) + ')'
		);
		h.check((await overflows(A, PVH)) === false, '...with no overflow at ' + w + 'px');
	}
	const tiny = await widths(A, PVH, pvIds);
	h.check(tiny.title === 0 && tiny.up === 0, 'the title and the up-a-folder button are what paid for it');
	await setW(A, PV, 520);
	await page.waitForTimeout(500);
	const back = await widths(A, PVH, pvIds);
	h.check(
		back.title > 0 && back.up > 0 && back.zoom > 0,
		'widening brings every piece back — a fit, not a mode (' + JSON.stringify(back) + ')'
	);
	await page.locator(PV + ' button[title="Close"]').click();
	await page.waitForTimeout(400);

	// =====================================================================================
	// 2. THE EXPLORER, UNDOCKED — the dock and the exit are the two that must never go
	// =====================================================================================
	await page.evaluate(() => window.__stores.explorerClose.set(false));
	await page.waitForTimeout(400);
	if (!(await page.locator('#explorer-window').count())) {
		await page.locator('#explorer-undock').click();
		await page.waitForTimeout(700);
	}
	const EX = '#explorer-window';
	const EXH = EX + ' .ui-panel-header';
	const exIds = {
		search: '#explorer-search',
		filter: '#explorer-filter',
		view: '#explorer-view-thumbnails',
		log: '#explorer-transfers',
		identity: '#explorer-identity',
		dock: '#explorer-dock',
		close: 'button[title="Close"]'
	};
	const exWide = await widths(A, EXH, exIds);
	h.check(
		!!exWide && exWide.search > 0 && exWide.dock > 0 && exWide.close > 0,
		'premise: the floating Explorer shows its search, its dock and its exit (' +
			JSON.stringify(exWide) +
			')'
	);
	const labelled = await page.evaluate(
		() => document.querySelector('#explorer-window .ui-panel-header span')?.textContent?.trim() ?? ''
	);
	h.check(/Explorer/.test(labelled), 'premise: and it says its own name (' + labelled + ')');

	for (const w of [500, 400, 320, 260]) {
		await setW(A, EX, w);
		await page.waitForTimeout(500);
		const g = await widths(A, EXH, exIds);
		h.check(
			g.dock > 0 && g.close > 0,
			'at ' + w + 'px the DOCK and the EXIT are still there (' + JSON.stringify(g) + ')'
		);
		h.check((await overflows(A, EXH)) === false, '...and the row does not overflow at ' + w + 'px');
	}
	const exTiny = await widths(A, EXH, exIds);
	h.check(exTiny.search === 0, 'the search box is what goes first — the grid is right there');
	h.check(exTiny.identity === 0, '...then the project chip');
	const iconOnly = await page.evaluate(() => {
		const s = document.querySelector('#explorer-window .ui-panel-header span');
		return { text: s?.textContent?.trim() ?? '', svg: !!s?.querySelector('svg') };
	});
	h.check(
		iconOnly.text === '' && iconOnly.svg,
		'...and the word "Explorer" gives way to its icon alone, as asked (' + JSON.stringify(iconOnly) + ')'
	);
	await setW(A, EX, 760);
	await page.waitForTimeout(500);
	const exBack = await page.evaluate(
		() => document.querySelector('#explorer-window .ui-panel-header span')?.textContent?.trim() ?? ''
	);
	h.check(/Explorer/.test(exBack), 'and widening brings the name back (' + exBack + ')');

	// =====================================================================================
	// 3. THE OBJECT LIST — the same, down to an icon
	// =====================================================================================
	await page.evaluate(() => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(600);
	const OB = '#object-list';
	const OBH = OB + ' .ui-panel-header';
	const obIds = { search: '#object-search', close: 'button[title="Close (O)"]' };
	const obWide = await widths(A, OBH, obIds);
	h.check(
		!!obWide && obWide.search > 0 && obWide.close > 0,
		'premise: the object list shows its search and its exit (' + JSON.stringify(obWide) + ')'
	);
	const obLabel = await page.evaluate(
		() => document.querySelector('#object-list .ui-panel-header span')?.textContent?.trim() ?? ''
	);
	h.check(/Objects/.test(obLabel), 'premise: and it says its name (' + obLabel + ')');

	for (const w of [240, 200, 170]) {
		await setW(A, OB, w);
		await page.waitForTimeout(500);
		const g = await widths(A, OBH, obIds);
		h.check(g.close > 0, 'at ' + w + 'px the object list keeps its exit (' + JSON.stringify(g) + ')');
		h.check((await overflows(A, OBH)) === false, '...and does not overflow at ' + w + 'px');
	}
	const obTiny = await page.evaluate(() => {
		const s = document.querySelector('#object-list .ui-panel-header span');
		return {
			text: s?.textContent?.trim() ?? '',
			svg: !!s?.querySelector('svg'),
			search: !!document.querySelector('#object-search')
		};
	});
	h.check(!obTiny.search, 'its search box goes first too');
	h.check(
		obTiny.text === '' && obTiny.svg,
		'...and at its smallest it is the lucide icon alone, as asked (' + JSON.stringify(obTiny) + ')'
	);
	await setW(A, OB, 320);
	await page.waitForTimeout(500);
	h.check(
		/Objects/.test(
			await page.evaluate(
				() => document.querySelector('#object-list .ui-panel-header span')?.textContent?.trim() ?? ''
			)
		),
		'and widening brings its name back'
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
