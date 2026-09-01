// FLOATING WINDOWS: show / raise / hide from the toolbar, and click-to-front.
//
// Two defects, one theme — a floating window you could not bring forward.
//
// 1. `focusStack` takes an optional KEY, and that key is the only way `raiseWindow` /
//    `isTopVisibleWindow` can address a window. W8b gave the roster buttons for Flow
//    Code, Animation, UV and HUD, but those four windows still registered
//    `use:focusStack` with NO key — so `byKey` never held them, steps 1 and 3 of
//    `togglePanel` (raise on open, raise-before-close when buried) silently no-opped,
//    and only the two windows keyed in cb3c059 (Flow, Explorer) worked. Section 1
//    drives all four through their REAL toolbar buttons.
//
// 2. `windowFocus.apply()` ranked the stack from the BOTTOM (`40 + min(index, 4)`),
//    which clamps everything from the fifth window up onto z=44. Measured with all
//    seven floating panels open, FIVE windows read 44 at once — so raising one changed
//    no number anybody could see and DOM order decided who painted on top. The
//    capture-phase pointerdown raise has been in `focusStack` since phase 82 and was
//    never the broken half; the arithmetic was. Ranking from the TOP makes the raised
//    window the only one at 44. Section 2 is that, through a real mouse.
const h = require('./helpers.cjs');

/**
 * The four windows W8b gave buttons to but never keyed, plus the two that worked — and
 * since the merge the SHADER editor, the EIGHTH floating window, which arrived from the
 * other lane. It is not a footnote here: this suite's whole thesis is a rule about the
 * SIZE of the stack ("everything from the fifth window up collapses onto 44"), so a
 * suite that measures seven understates the very band it exists to police. That lane
 * keys its window `focusStack={'shader'}`, so it belongs in the same loop as the four
 * this one keyed — and until the merge nothing had ever driven that combination.
 */
const VIEWS = [
	{ key: 'flowcode', title: 'Flow Code', sel: '#flow-code-window', store: 'flowCodeClose' },
	{ key: 'animation', title: 'Animation', sel: '#animation-window', store: 'animationClose' },
	{ key: 'uv', title: 'UV editor', sel: '#uv-window', store: 'uvEditorClose' },
	{ key: 'shader', title: 'Shader editor', sel: '#shader-window', store: 'shaderEditorClose' },
	{ key: 'hud', title: 'HUD editor', sel: '#hud-window', store: 'hudEditorClose' }
];

const ALL_SEL =
	'#flow-window,#flow-code-window,#animation-window,#uv-window,#shader-window,#hud-window,#explorer-window,#object-list';

/** every floating window that is actually on screen, with its z, top-most last */
const shown = (page) =>
	page.evaluate((sel) =>
		[...document.querySelectorAll(sel)]
			.filter((n) => getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 10)
			.map((n) => ({ id: n.id, z: +getComputedStyle(n).zIndex || 0 }))
			.sort((a, b) => a.z - b.z),
	ALL_SEL);

const closedOf = (page, store) =>
	page.evaluate((s) => {
		let v;
		window.__stores[s].subscribe((x) => (v = x))();
		return v;
	}, store);

const clickBtn = async (page, title) => {
	await page.evaluate((t) => document.querySelector(`#controls-pill p[title="${t}"]`)?.click(), title);
	await page.waitForTimeout(550);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// every dock view opens FLOATING, and the four optional roster buttons are on the bar
	await page.evaluate(() => {
		for (const k of ['flowDocked', 'flowCodeDocked', 'animationDocked', 'uvDocked', 'shaderDocked', 'hudDocked', 'explorerDocked'])
			localStorage.setItem(k, 'false');
		localStorage.setItem(
			'controlsLayout',
			JSON.stringify({
				order: ['move', 'rotate', 'scale', 'objects', 'flow', 'explorer', 'flowcode', 'animation', 'uv', 'shader', 'hud'],
				hidden: [],
				spacerIndex: 3,
				collapsed: false,
				posX: null
			})
		);
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await page.waitForTimeout(1200);

	const bar = await page.evaluate(() =>
		[...document.querySelectorAll('#controls-pill p[title]')].map((p) => p.getAttribute('title'))
	);
	h.check(
		VIEWS.every((v) => bar.includes(v.title)),
		`0.0 premise: every optional roster button is on the bar, the Shader editor included (${bar.join(' | ')})`
	);

	// ---- 1. each newly-keyed window: open+raise / raise-when-buried / hide ----------
	for (const v of VIEWS) {
		h.check((await closedOf(page, v.store)) === true, `1.${v.key}.0 premise: the ${v.title} window starts closed`);

		// (a) CLOSED -> opens, and lands on top
		await clickBtn(page, v.title);
		let closed = await closedOf(page, v.store);
		let list = await shown(page);
		h.check(closed === false, `1.${v.key}.1 its button OPENS it (closed=${closed})`);
		h.check(
			list.length > 0 && list[list.length - 1].id === v.sel.slice(1),
			`1.${v.key}.2 and it is the top-most window on screen (${list.map((w) => `${w.id}:${w.z}`).join(' ')})`
		);

		// (b) BURY it under another window, then press again -> RAISED, never closed.
		// This is the step that could not work at all without a focusStack key.
		await clickBtn(page, 'Explorer');
		list = await shown(page);
		const buried = list.findIndex((w) => w.id === v.sel.slice(1));
		h.check(
			buried >= 0 && buried < list.length - 1,
			`1.${v.key}.3 the Explorer buries it (${list.map((w) => `${w.id}:${w.z}`).join(' ')})`
		);

		await clickBtn(page, v.title);
		closed = await closedOf(page, v.store);
		list = await shown(page);
		h.check(
			closed === false,
			`1.${v.key}.4 pressing its button while BURIED does not close it (closed=${closed})`
		);
		h.check(
			list[list.length - 1].id === v.sel.slice(1),
			`1.${v.key}.5 it is raised to the front instead (${list.map((w) => `${w.id}:${w.z}`).join(' ')})`
		);

		// (c) now that it IS on top, the same press hides it
		await clickBtn(page, v.title);
		closed = await closedOf(page, v.store);
		h.check(closed === true, `1.${v.key}.6 and pressing it again — now on top — HIDES it (closed=${closed})`);

		await clickBtn(page, 'Explorer'); // put the Explorer back the way we found it
		await page.waitForTimeout(200);
	}

	// ---- 2. CLICK-TO-FRONT with a real mouse ---------------------------------------
	await page.evaluate(() => {
		const s = window.__stores;
		s.explorerClose.set(true);
		s.objectListClose.set(true);
		s.flowGraphClose.set(false);
		s.hudEditorClose.set(false);
		s.uvEditorClose.set(false);
		s.shaderEditorClose.set(false);
		s.animationClose.set(false);
		s.flowCodeClose.set(false);
	});
	await page.waitForTimeout(2200);

	let list = await shown(page);
	h.check(list.length >= 4, `2.0 premise: several floating windows are open at once (${list.length})`);
	// THE GUARANTEE IS AT THE TOP, and only at the top. The band is 40..44 — five slots —
	// so "every z is distinct" is not a property of the ranking, it is an accident of
	// opening exactly five windows, which is what this suite used to do. Adding the
	// shader made six and the bottom two correctly met the 40 FLOOR that windowFocus
	// documents ("windows past the fifth share the 40 floor... at the end of the stack
	// nobody is looking at"). What the fix actually promises, and all click-to-front
	// needs, is that whatever you press ends up STRICTLY above everything else.
	const top = list[list.length - 1];
	h.check(
		top.z === 44 && list.filter((w) => w.z === 44).length === 1,
		`2.1 the top-most window is UNIQUELY 44 — five used to share it, which is why a click could not win (${list
			.map((w) => `${w.id}:${w.z}`)
			.join(' ')})`
	);
	h.check(
		list.every((w, i) => i === 0 || w.z >= list[i - 1].z) && list[0].z >= 40,
		`2.1b ...and the whole stack stays inside the 40..44 band, under the HUD at 45 (${list
			.map((w) => w.z)
			.join(',')})`
	);

	// the lowest window, a point on it that is genuinely exposed, and a point where it
	// is overlapped by something else
	const geom = await page.evaluate((sel) => {
		const wins = [...document.querySelectorAll(sel)]
			.filter((n) => getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 10)
			.map((n) => ({ id: n.id, z: +getComputedStyle(n).zIndex || 0, r: n.getBoundingClientRect() }))
			.sort((a, b) => a.z - b.z);
		if (wins.length < 2) return null;
		const low = wins[0];
		// an EXPOSED point: scan the low window and take the first pixel that really
		// resolves to it (never trust arithmetic about who is on top — ask the browser)
		let exposed = null;
		for (let y = low.r.top + 6; y < low.r.bottom - 6 && !exposed; y += 12)
			for (let x = low.r.left + 6; x < low.r.right - 6 && !exposed; x += 12) {
				const el = document.elementFromPoint(x, y);
				if (el && el.closest(`#${low.id}`)) exposed = { x: Math.round(x), y: Math.round(y) };
			}
		// an OVERLAP point: inside the low window, currently owned by a DIFFERENT window
		let overlap = null;
		for (let y = low.r.top + 6; y < low.r.bottom - 6 && !overlap; y += 12)
			for (let x = low.r.left + 6; x < low.r.right - 6 && !overlap; x += 12) {
				const el = document.elementFromPoint(x, y);
				const win = el?.closest(sel);
				if (win && win.id !== low.id) overlap = { x: Math.round(x), y: Math.round(y), owner: win.id };
			}
		return { low: { id: low.id, z: low.z }, exposed, overlap, all: wins.map((w) => `${w.id}:${w.z}`) };
	}, ALL_SEL);

	h.check(!!geom?.exposed, `2.2 the lowest window (${geom?.low.id}) has an exposed pixel to press`);
	h.check(
		!!geom?.overlap,
		`2.3 and a pixel where another window covers it — ${geom?.overlap?.owner} owns ${JSON.stringify(geom?.overlap && { x: geom.overlap.x, y: geom.overlap.y })}`
	);

	if (geom?.exposed && geom?.overlap) {
		await page.mouse.click(geom.exposed.x, geom.exposed.y);
		await page.waitForTimeout(450);
		list = await shown(page);
		const top = list[list.length - 1];
		h.check(
			top.id === geom.low.id,
			`2.4 clicking the LOWEST window brings it to the front (${geom.low.id} was z=${geom.low.z}; now ${list
				.map((w) => `${w.id}:${w.z}`)
				.join(' ')})`
		);
		const ownerNow = await page.evaluate(
			([x, y, sel]) => document.elementFromPoint(x, y)?.closest(sel)?.id ?? 'none',
			[geom.overlap.x, geom.overlap.y, ALL_SEL]
		);
		h.check(
			ownerNow === geom.low.id,
			`2.5 and it now OWNS the overlapping pixel that ${geom.overlap.owner} held — the z change is real, not just a number (${ownerNow})`
		);
	}

	// ---- 3. raising must not steal a click from what was clicked -------------------
	// The raise is a capture-phase pointerdown, so this is the property that says it
	// stays a passive observer: pressing a text field inside a window focuses it.
	const typed = await page.evaluate((sel) => {
		const wins = [...document.querySelectorAll(sel)].filter(
			(n) => getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 10
		);
		for (const w of wins) {
			const input = [...w.querySelectorAll('input')].find((i) => {
				const r = i.getBoundingClientRect();
				return r.width > 20 && r.height > 6 && getComputedStyle(i).display !== 'none' && !i.disabled;
			});
			if (input) {
				const r = input.getBoundingClientRect();
				return { win: w.id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
			}
		}
		return null;
	}, ALL_SEL);

	if (typed) {
		await page.mouse.click(typed.x, typed.y);
		await page.waitForTimeout(350);
		const focused = await page.evaluate(() => {
			const a = document.activeElement;
			return { tag: a?.tagName ?? 'none', inWin: !!a?.closest('#flow-window,#flow-code-window,#animation-window,#uv-window,#shader-window,#hud-window,#explorer-window,#object-list') };
		});
		h.check(
			focused.tag === 'INPUT' && focused.inWin,
			`3.0 clicking a text field inside ${typed.win} still focuses it — the capture-phase raise does not swallow the press (activeElement=${focused.tag})`
		);
	} else {
		h.check(true, '3.0 (no eligible text field on screen to probe — skipped)');
	}

	// ---- 3b. THE DOCK KEY (T) MUST NOT DISTURB THE FLOATING STACK ------------------
	// The other lane's `toggleDock` minimizes and restores the bottom dock. The dock is
	// its own tier (`--z-bottom`, 35) and these windows are the 40..44 band, so the two
	// have no business touching — but `apply()` re-ranks the WHOLE order on every
	// register/destroy, and a panel changing mode is exactly a destroy. Worth pinning
	// rather than assuming: the failure it would produce (a click-to-front that stops
	// working after you minimize the dock once) is the kind nobody files as a dock bug.
	const zMap = async () => Object.fromEntries((await shown(page)).map((w) => [w.id, w.z]));
	const pressT = async () => {
		await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
		await page.keyboard.press('t');
		await page.waitForTimeout(550);
	};
	const dockMin = () =>
		page.evaluate(() => {
			let v;
			window.__stores.bottomDock.dockMinimized.subscribe((x) => (v = x))();
			return v;
		});

	// Every panel here is FLOATING, so the dock is EMPTY — and T's third state docks the
	// last-active view rather than reading as broken. That is the two lanes meeting: a
	// window LEAVES the floating stack, and `apply()` re-ranks what is left. Assert that
	// deliberately instead of being surprised by it, then test the minimize cycle from a
	// dock that actually holds something (which is the only state that can minimize).
	const beforeDock = await zMap();
	await pressT();
	const afterDock = await zMap();
	h.check(
		(await dockMin()) === false && Object.keys(afterDock).length === Object.keys(beforeDock).length - 1,
		`3b.0 T on an EMPTY dock docks one view, so it leaves the floating stack (${Object.keys(beforeDock).length} -> ${Object.keys(afterDock).length} floating)`
	);
	h.check(
		Object.values(afterDock).filter((z) => z === 44).length === 1,
		`3b.0b ...and the windows left behind re-rank with a single top (${JSON.stringify(afterDock)})`
	);

	await pressT();
	const minimized = await dockMin();
	const duringT = await zMap();
	h.check(minimized === true, `3b.1a with the dock populated, T minimizes it (dockMinimized=${minimized})`);
	h.check(
		JSON.stringify(duringT) === JSON.stringify(afterDock),
		`3b.1 ...and leaves every floating z untouched — the dock is its own tier (${JSON.stringify(duringT)})`
	);

	await pressT();
	const afterT = await zMap();
	h.check((await dockMin()) === false, '3b.2a T brings the dock back');
	h.check(
		JSON.stringify(afterT) === JSON.stringify(afterDock),
		`3b.2 ...and restoring it disturbs the floating z no more than minimizing did (${JSON.stringify(afterT)})`
	);

	// and click-to-front still works AFTER the dock has been toggled — the property that
	// would actually be lost if a re-rank had gone wrong while the dock came and went
	const lowId = (await shown(page))[0].id;
	const spot = await page.evaluate((id) => {
		const w = document.getElementById(id);
		const r = w.getBoundingClientRect();
		for (let y = r.top + 6; y < r.bottom - 6; y += 12)
			for (let x = r.left + 6; x < r.right - 6; x += 12)
				if (document.elementFromPoint(x, y)?.closest('#' + id)) return { x: Math.round(x), y: Math.round(y) };
		return null;
	}, lowId);
	if (spot) {
		await page.mouse.click(spot.x, spot.y);
		await page.waitForTimeout(400);
		const list3 = await shown(page);
		h.check(
			list3[list3.length - 1].id === lowId,
			`3b.3 click-to-front still raises the lowest window after a dock round trip (${lowId} -> ${list3
				.map((w) => `${w.id}:${w.z}`)
				.join(' ')})`
		);
	} else {
		h.check(false, '3b.3 no exposed pixel on the lowest window to press');
	}

	h.check(h.pageErrors(A).length === 0, `4.0 the page threw nothing (${h.pageErrors(A).join(' / ')})`);
	await h.finish(browser);
});
