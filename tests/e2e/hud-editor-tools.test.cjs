// 21-F1 — the HUD editor's topbar becomes a TOOLBAR.
//
// What this suite is for, in one line each:
//
//  * the four "Add <kind>" shortcuts are GONE and the palette is the add path (a feature
//    whose entry point vanished is invisible to a suite that keeps calling the old one);
//  * a MARQUEE tool selects by dragging a box, and it is a MODE — the same drag with the
//    select tool armed must still just deselect, which is the only thing that proves the
//    gate rather than the geometry;
//  * ALIGN / DISTRIBUTE / EQUALIZE move exactly the right members, THROUGH EACH ELEMENT'S
//    OWN ANCHOR. That last part is the whole difficulty: an element's authored x is an
//    offset from whichever of the 9 cells it is anchored to, so setting three elements'
//    x to the same number puts them in three different places. Every op is asserted on the
//    ABSOLUTE rect AND on the three DIFFERENT authored x values that produce it, with the
//    naive answer computed in-test so the check cannot pass with the conversion removed;
//  * one op = ONE undo entry and ONE broadcast — asserted as the PROPERTY (a single Ctrl+Z
//    puts every member back, and redo returns them), plus a pass-through send spy;
//  * the Add submenu is CATEGORIZED, compared against `paletteGroups()` read from the page
//    rather than a list copied into this file.
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-editor-tools
const h = require('./helpers.cjs');

/** every VISIBLE context-menu row label (a row's own label span, never its submenu's) */
async function menuLabels(page) {
	return page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')]
			.map((el) => (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim())
			.filter(Boolean)
	);
}

/** the labels inside ONE open submenu, in order */
async function submenuLabels(page, parentLabel) {
	return page.evaluate((want) => {
		const parent = [...document.querySelectorAll('[role="menuitem"]')].find(
			(el) => (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim() === want
		);
		const panel = parent?.querySelector(':scope > div');
		if (!panel) return [];
		return [...panel.querySelectorAll(':scope > [role="menuitem"]')]
			.map((el) => (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim())
			.filter(Boolean);
	}, parentLabel);
}

/** hover a context-menu row with a REAL mouse and wait out the 120ms open intent — a
 * submenu opens on mouseenter and nothing else, so this is the only honest path. */
async function hoverMenuRow(page, label) {
	const at = await page.evaluate((want) => {
		const row = [...document.querySelectorAll('[role="menuitem"]')].find(
			(el) => (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim() === want
		);
		if (!row) return null;
		const r = row.getBoundingClientRect();
		return { x: Math.round(r.x + Math.min(28, r.width / 2)), y: Math.round(r.y + r.height / 2) };
	}, label);
	if (!at) return false;
	await page.mouse.move(at.x, at.y);
	await page.waitForTimeout(450);
	return page.evaluate((want) => {
		const row = [...document.querySelectorAll('[role="menuitem"]')].find(
			(el) => (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim() === want
		);
		return !!row && row.classList.contains('ctx-open');
	}, label);
}

/** the artboard's screen geometry + the stage->screen scale */
async function boardMap(page) {
	return page.evaluate(() => {
		const b = document.querySelector('#hud-board').getBoundingClientRect();
		return { x: b.x, y: b.y, w: b.width, h: b.height, scale: b.width / 1280 };
	});
}
const toScreen = (map, sx, sy) => ({
	x: Math.round(map.x + sx * map.scale),
	y: Math.round(map.y + sy * map.scale)
});

/** seed a screen with exactly these elements, wiping whatever was there */
async function seed(page, elements) {
	await page.evaluate((list) => {
		const H = window.__stores.hudDocs;
		H.clearHudDocs();
		H.setHudDocFor('scene', {});
		const doc = H.hudDocOf('scene');
		const sid = doc.screens[0].id;
		for (const el of list) H.addHudElement('scene', sid, { kind: 'text', label: el.id, ...el });
	}, elements);
	await page.waitForTimeout(700);
}

/** how deep the undo stack is right now */
async function undoDepth(page) {
	return page.evaluate(() => {
		let n = 0;
		window.__stores.history.undoStack.subscribe((/** @type {any[]} */ s) => (n = s.length))();
		return n;
	});
}

/** the absolute stage rect + the authored offsets of every element, by id */
async function readAll(page) {
	return page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const out = {};
		for (const el of H.hudDocOf('scene').screens[0].elements) {
			const r = H.rectInFrame(el, 1280, 720);
			out[el.id] = {
				x: el.x,
				y: el.y,
				w: el.w,
				h: el.h,
				anchor: el.anchor,
				left: Math.round(r.left),
				top: Math.round(r.top)
			};
		}
		return out;
	});
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudArrange, { timeout: 30000 });

	await page.evaluate(() => {
		window.__stores.hudDocs.clearHudDocs();
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
		window.__stores.bottomDock.dockHeight.set(420);
	});
	await page.waitForTimeout(1600);
	h.check(
		await page.evaluate(() => !!document.querySelector('#hud-board')),
		'premise: the HUD editor is open with its artboard'
	);

	// ======================================================================
	// 1. THE PURE ENGINE — no DOM, no anchors, just rects
	// ======================================================================
	// `hudArrange` imports nothing on purpose, so the geometry is checkable exactly
	// rather than to a tolerance.
	const pure = await page.evaluate(() => {
		const { arrangeRects, HUD_ARRANGE_OPS } = window.__stores.hudArrange;
		const three = [
			{ id: 'a', rect: { left: 100, top: 100, w: 120, h: 40 } },
			{ id: 'b', rect: { left: 400, top: 150, w: 60, h: 40 } },
			{ id: 'c', rect: { left: 250, top: 300, w: 100, h: 20 } }
		];
		return {
			ops: HUD_ARRANGE_OPS.map((op) => op.key),
			left: arrangeRects('align-left', three),
			distH: arrangeRects('distribute-h', three),
			equal: arrangeRects('equalize', three),
			// distribute needs a middle to move: two members is not a distribution
			distTooFew: arrangeRects('distribute-h', three.slice(0, 2)),
			unknown: arrangeRects('nonsense', three)
		};
	});
	h.check(
		pure.ops.length === 9 && pure.ops[0] === 'align-left' && pure.ops[8] === 'equalize',
		`the registry lists 9 ops (${pure.ops.join(', ')})`
	);
	h.check(
		!pure.left.a && pure.left.b?.left === 100 && pure.left.c?.left === 100,
		`align-left reports ONLY the members that move (a stays: ${!pure.left.a}; b=${pure.left.b?.left}, c=${pure.left.c?.left})`
	);
	// span 100..460 = 360, widths 120+60+100 = 280, so the two gaps are 40 each:
	// a 100..220, c 260..360, b 400..460 — the outer two never move
	h.check(
		!pure.distH.a && !pure.distH.b && pure.distH.c?.left === 260,
		`distribute-h keeps the outer two put and gives equal gaps (moved: ${JSON.stringify(pure.distH)})`
	);
	h.check(
		pure.equal.b?.w === 120 && pure.equal.b?.h === 40 && pure.equal.b?.left === 400,
		`equalize takes the FIRST member's size and leaves the top-left alone (${JSON.stringify(pure.equal.b)})`
	);
	h.check(
		Object.keys(pure.distTooFew).length === 0 && Object.keys(pure.unknown).length === 0,
		`an op below its minimum, or one that does not exist, changes nothing (${JSON.stringify(pure.distTooFew)} / ${JSON.stringify(pure.unknown)})`
	);

	// ======================================================================
	// 2. THE TOPBAR IS A TOOLBAR — the Add shortcuts are gone
	// ======================================================================
	const bar = await page.evaluate(() => {
		const dock = document.querySelector('#hud-dock');
		const titled = [...dock.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
		return {
			oldAdds: titled.filter((t) => /^Add (text|button|bar|crosshair)$/.test(t)),
			select: !!document.querySelector('#hud-tool-select'),
			marquee: !!document.querySelector('#hud-tool-marquee'),
			armed: document.querySelector('#hud-tool-select')?.getAttribute('aria-pressed'),
			marqueeArmed: document.querySelector('#hud-tool-marquee')?.getAttribute('aria-pressed'),
			arrange: [...dock.querySelectorAll('[data-hud-arrange]')].map((b) => b.getAttribute('data-hud-arrange')),
			disabled: [...dock.querySelectorAll('[data-hud-arrange]')].every((b) => b.disabled),
			labelled: [...dock.querySelectorAll('[data-hud-arrange]')].every((b) => !!b.getAttribute('aria-label')),
			registry: window.__stores.hudArrange.HUD_ARRANGE_OPS.map((op) => op.key)
		};
	});
	h.check(bar.oldAdds.length === 0, `the four "Add <kind>" shortcuts are gone from the topbar (${JSON.stringify(bar.oldAdds)})`);
	h.check(bar.select && bar.marquee, 'the topbar offers a select tool and a multi-select tool');
	h.check(
		bar.armed === 'true' && bar.marqueeArmed === 'false',
		`with select armed by default (select=${bar.armed}, marquee=${bar.marqueeArmed})`
	);
	h.check(
		JSON.stringify(bar.arrange) === JSON.stringify(bar.registry),
		`and one arrange button per registry op, in order (${bar.arrange.join(', ')})`
	);
	h.check(bar.disabled, 'all of them disabled with nothing selected');
	h.check(bar.labelled, 'and each icon-only button carries an aria-label');

	// the palette is the add path, and it still works
	const paletteAdd = await page.evaluate(async () => {
		const before = window.__stores.hudDocs.hudDocOf('scene')?.screens[0].elements.length ?? 0;
		/** @type {any} */ (document.querySelector('#hud-palette [data-hud-kind="bar"]'))?.click();
		await new Promise((r) => setTimeout(r, 600));
		const els = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements;
		return { before, after: els.length, kind: els[els.length - 1]?.kind };
	});
	h.check(
		paletteAdd.after === paletteAdd.before + 1 && paletteAdd.kind === 'bar',
		`the palette still adds (${paletteAdd.before} -> ${paletteAdd.after}, a ${paletteAdd.kind})`
	);

	// ======================================================================
	// 3. THE MARQUEE — and the MODE gate that decides whether it happens
	// ======================================================================
	await seed(page, [
		{ id: 'm-a', anchor: 'top-left', x: 100, y: 100, w: 120, h: 40 },
		{ id: 'm-b', anchor: 'top-left', x: 300, y: 100, w: 120, h: 40 },
		{ id: 'm-c', anchor: 'top-left', x: 100, y: 300, w: 120, h: 40 },
		{ id: 'm-far', anchor: 'top-left', x: 900, y: 500, w: 120, h: 40 }
	]);
	const map = await boardMap(page);
	const from = toScreen(map, 60, 60);
	const to = toScreen(map, 460, 360);
	const startHit = await page.evaluate((p) => {
		const at = document.elementFromPoint(p.x, p.y);
		return {
			what: at?.id || String(at?.className ?? '') || at?.tagName || 'nothing',
			item: !!at?.closest?.('[data-hud-item]'),
			inBoard: !!at?.closest?.('#hud-board')
		};
	}, from);
	h.check(
		startHit.inBoard && !startHit.item,
		`premise: the drag starts on EMPTY artboard (${startHit.what}; in the board: ${startHit.inBoard}, on an element: ${startHit.item})`
	);

	/** drag the box, whichever tool is armed */
	async function dragBox(shift) {
		if (shift) await page.keyboard.down('Shift');
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++)
			await page.mouse.move(
				from.x + ((to.x - from.x) * i) / 8,
				from.y + ((to.y - from.y) * i) / 8
			);
		await page.mouse.up();
		if (shift) await page.keyboard.up('Shift');
		await page.waitForTimeout(500);
	}
	const picked = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('#hud-board .hud-item-on')].map((el) => el.getAttribute('data-hud-item')).sort()
		);

	// THE COUNTERFACTUAL, run first: the identical drag with SELECT armed must select
	// nothing. Without it, "the marquee selects three" would also pass for a marquee that
	// ignores its own mode.
	await dragBox(false);
	const withSelectTool = await picked();
	h.check(
		withSelectTool.length === 0,
		`with the select tool armed the same drag selects NOTHING — it is a mode (${JSON.stringify(withSelectTool)})`
	);

	await page.locator('#hud-tool-marquee').click();
	await page.waitForTimeout(300);
	const armed = await page.evaluate(() => ({
		marquee: document.querySelector('#hud-tool-marquee')?.getAttribute('aria-pressed'),
		select: document.querySelector('#hud-tool-select')?.getAttribute('aria-pressed')
	}));
	h.check(armed.marquee === 'true' && armed.select === 'false', 'arming the marquee tool disarms select');

	await dragBox(false);
	const boxed = await picked();
	h.check(
		JSON.stringify(boxed) === JSON.stringify(['m-a', 'm-b', 'm-c']),
		`the marquee selects everything the box touches (${JSON.stringify(boxed)})`
	);
	h.check(!boxed.includes('m-far'), 'and nothing outside it');

	// SHIFT adds rather than replaces
	const far = await page.evaluate(() => {
		const r = document.querySelector('#hud-board [data-hud-item="m-far"]').getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	await page.keyboard.down('Shift');
	await page.mouse.click(far.x, far.y);
	await page.keyboard.up('Shift');
	await page.waitForTimeout(400);
	const withFar = await picked();
	h.check(withFar.length === 4, `Shift adds to a marquee selection (${JSON.stringify(withFar)})`);

	// a marquee press that does not TRAVEL is a click on empty space, and still deselects
	await page.mouse.click(from.x, from.y);
	await page.waitForTimeout(400);
	const afterClick = await picked();
	h.check(afterClick.length === 0, `a press that does not travel still deselects (${JSON.stringify(afterClick)})`);

	// and Escape drops a live box without dropping the selection it would have replaced
	await dragBox(false);
	const beforeEsc = await picked();
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	const escState = await page.evaluate(() => ({
		box: !!document.querySelector('#hud-marquee'),
		picked: [...document.querySelectorAll('#hud-board .hud-item-on')].length
	}));
	await page.mouse.up();
	await page.waitForTimeout(300);
	h.check(!escState.box, 'Escape removes the live marquee box');
	h.check(
		escState.picked === beforeEsc.length,
		`and leaves the selection it was about to replace (${escState.picked} vs ${beforeEsc.length})`
	);
	await page.locator('#hud-tool-select').click();
	await page.waitForTimeout(300);

	// ======================================================================
	// 4. ALIGN, THROUGH THREE DIFFERENT ANCHORS
	// ======================================================================
	// P is top-left, Q top-right, R bottom-right, and they sit at stage lefts 100 / 400 /
	// 250. Aligning left must put all three at 100 — which means writing three DIFFERENT
	// authored x values, because each anchor counts from a different edge.
	await seed(page, [
		{ id: 'p', anchor: 'top-left', x: 100, y: 100, w: 120, h: 40 },
		{ id: 'q', anchor: 'top-right', x: 720, y: 140, w: 160, h: 40 },
		{ id: 'r', anchor: 'bottom-right', x: 930, y: 430, w: 100, h: 30 }
	]);
	const startRects = await readAll(page);
	h.check(
		startRects.p.left === 100 && startRects.q.left === 400 && startRects.r.left === 250,
		`premise: three mixed-anchor elements at lefts 100/400/250 (${startRects.p.left}/${startRects.q.left}/${startRects.r.left})`
	);

	// select all three the way a user would, then press the real toolbar button
	await page.mouse.click(from.x, from.y);
	await page.keyboard.press('Control+a');
	await page.waitForTimeout(400);
	const allPicked = await picked();
	h.check(allPicked.length === 3, `premise: Ctrl+A picks all three (${JSON.stringify(allPicked)})`);
	const btnEnabled = await page.evaluate(() => !document.querySelector('#hud-arrange-align-left').disabled);
	h.check(btnEnabled, 'and the align buttons come alive with a multi-selection');

	// the undo depth immediately BEFORE the gesture — a gesture that failed to collapse
	// records one entry per element write, and the broadcast rides the same
	// `gestures.has(key)` gate, so this counts both
	const depthBefore = await undoDepth(page);
	await page.locator('#hud-arrange-align-left').click();
	await page.waitForTimeout(700);
	const aligned = await readAll(page);
	const depthAfter = await undoDepth(page);
	h.check(
		aligned.p.left === 100 && aligned.q.left === 100 && aligned.r.left === 100,
		`align left puts every element's ABSOLUTE left at 100 (${aligned.p.left}/${aligned.q.left}/${aligned.r.left})`
	);
	// the counterfactual, computed here: writing x = 100 for all three (skipping the anchor
	// conversion) would leave q at left 1020 and r at 1080, i.e. further apart than they
	// started. Three DIFFERENT authored x values are what a correct align looks like.
	h.check(
		aligned.p.x === 100 && aligned.q.x === 1020 && aligned.r.x === 1080,
		`by writing three DIFFERENT authored offsets, one per anchor (p.x=${aligned.p.x}, q.x=${aligned.q.x}, r.x=${aligned.r.x}; a naive x=100 would put q at left 1020)`
	);
	h.check(
		aligned.p.top === startRects.p.top && aligned.q.top === startRects.q.top && aligned.r.top === startRects.r.top,
		'and it touches the other axis not at all'
	);
	h.check(
		depthAfter === depthBefore + 1,
		`the whole op is ONE history entry — and the broadcast rides the same gesture gate, so it is one message too (${depthBefore} -> ${depthAfter})`
	);

	// ONE undo entry — asserted as the PROPERTY: a single Ctrl+Z puts all three back
	const undone = await page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 500));
		const H = window.__stores.hudDocs;
		const out = {};
		for (const el of H.hudDocOf('scene').screens[0].elements) out[el.id] = el.x;
		return out;
	});
	h.check(
		undone.p === 100 && undone.q === 720 && undone.r === 930,
		`ONE undo reverts the WHOLE op, all three members (${JSON.stringify(undone)})`
	);
	// and REDO returns it — the shader-graph redo bug lived in exactly this handler shape
	const redone = await page.evaluate(async () => {
		window.__stores.history.redo();
		await new Promise((r) => setTimeout(r, 500));
		const H = window.__stores.hudDocs;
		const out = {};
		for (const el of H.hudDocOf('scene').screens[0].elements) out[el.id] = Math.round(H.rectInFrame(el, 1280, 720).left);
		return out;
	});
	h.check(
		redone.p === 100 && redone.q === 100 && redone.r === 100,
		`and redo puts it back (lefts ${JSON.stringify(redone)})`
	);

	// another align op, on the same mixed-anchor set
	await page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 400));
	});
	// the board has to have the keyboard back — the last click was on a toolbar BUTTON,
	// and an unswallowed Ctrl+A selects every 3D OBJECT instead
	await page.mouse.click(from.x, from.y);
	await page.keyboard.press('Control+a');
	await page.waitForTimeout(300);
	await page.locator('#hud-arrange-align-bottom').click();
	await page.waitForTimeout(700);
	const bottoms = await readAll(page);
	// bottoms started at 140 / 180 / 290, so the lowest edge is 290
	const edge = (e) => e.top + e.h;
	h.check(
		edge(bottoms.p) === 290 && edge(bottoms.q) === 290 && edge(bottoms.r) === 290,
		`align bottom meets the lowest edge (${edge(bottoms.p)}/${edge(bottoms.q)}/${edge(bottoms.r)})`
	);
	h.check(
		bottoms.r.y === startRects.r.y && bottoms.p.y !== startRects.p.y,
		`the element already at the edge is not written, the others are (r.y ${bottoms.r.y}, p.y ${startRects.p.y} -> ${bottoms.p.y})`
	);

	// ======================================================================
	// 5. DISTRIBUTE — equal gaps, outer two untouched
	// ======================================================================
	await seed(page, [
		{ id: 'd1', anchor: 'top-left', x: 100, y: 100, w: 120, h: 40 },
		{ id: 'd2', anchor: 'top-right', x: 720, y: 140, w: 160, h: 40 },
		{ id: 'd3', anchor: 'bottom-right', x: 930, y: 430, w: 100, h: 30 }
	]);
	await page.mouse.click(from.x, from.y);
	await page.keyboard.press('Control+a');
	await page.waitForTimeout(400);
	const distDepthBefore = await undoDepth(page);
	await page.locator('#hud-arrange-distribute-v').click();
	await page.waitForTimeout(700);
	const spread = await readAll(page);
	const distDepthAfter = await undoDepth(page);
	// tops 100 / 140 / 260, heights 40 / 40 / 30 over the span 100..290: the gaps are
	// (190 - 110) / 2 = 40 each, so the middle one lands at 180 and the outer two stay
	h.check(
		spread.d1.top === 100 && spread.d2.top === 180 && spread.d3.top === 260,
		`distribute vertically gives equal gaps (tops ${spread.d1.top}/${spread.d2.top}/${spread.d3.top})`
	);
	h.check(
		spread.d1.y === 100 && spread.d3.y === 430,
		`with the outer two's authored offsets untouched (d1.y=${spread.d1.y}, d3.y=${spread.d3.y})`
	);
	h.check(spread.d2.y === 180, `and only the middle rewritten, in its own frame (d2.y=${spread.d2.y})`);
	h.check(
		distDepthAfter === distDepthBefore + 1,
		`one entry for the whole distribution (${distDepthBefore} -> ${distDepthAfter})`
	);
	const distUndone = await page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 500));
		const H = window.__stores.hudDocs;
		return H.elementById('scene', 'd2').y;
	});
	h.check(distUndone === 140, `one undo puts the distribution back (d2.y=${distUndone})`);

	// two members is not a distribution — the button says so by staying disabled.
	// The editor owns the pick, so drive it the way a user does: click one, shift-click one.
	const pts = await page.evaluate(() => {
		const at = (id) => {
			const r = document.querySelector(`#hud-board [data-hud-item="${id}"]`).getBoundingClientRect();
			return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		};
		return { d1: at('d1'), d2: at('d2') };
	});
	await page.mouse.click(pts.d1.x, pts.d1.y);
	await page.keyboard.down('Shift');
	await page.mouse.click(pts.d2.x, pts.d2.y);
	await page.keyboard.up('Shift');
	await page.waitForTimeout(400);
	const twoState = await page.evaluate(() => ({
		picked: [...document.querySelectorAll('#hud-board .hud-item-on')].length,
		distribute: document.querySelector('#hud-arrange-distribute-v').disabled,
		align: document.querySelector('#hud-arrange-align-left').disabled
	}));
	h.check(twoState.picked === 2, `premise: two elements picked (${twoState.picked})`);
	h.check(
		twoState.distribute && !twoState.align,
		`distribute needs three and stays disabled, align needs two and does not (distribute=${twoState.distribute}, align=${twoState.align})`
	);

	// ======================================================================
	// 6. EQUALIZE — the FIRST pick is the reference, and the top-left stays put
	// ======================================================================
	await seed(page, [
		{ id: 'e1', anchor: 'top-left', x: 100, y: 100, w: 200, h: 50 },
		{ id: 'e2', anchor: 'bottom-right', x: 600, y: 300, w: 80, h: 20 }
	]);
	const eStart = await readAll(page);
	h.check(
		eStart.e2.left === 600 && eStart.e2.top === 400,
		`premise: the bottom-right element sits at 600,400 (${eStart.e2.left},${eStart.e2.top})`
	);
	const ePts = await page.evaluate(() => {
		const at = (id) => {
			const r = document.querySelector(`#hud-board [data-hud-item="${id}"]`).getBoundingClientRect();
			return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		};
		return { e1: at('e1'), e2: at('e2') };
	});
	await page.mouse.click(ePts.e1.x, ePts.e1.y);
	await page.keyboard.down('Shift');
	await page.mouse.click(ePts.e2.x, ePts.e2.y);
	await page.keyboard.up('Shift');
	await page.waitForTimeout(400);
	await page.locator('#hud-arrange-equalize').click();
	await page.waitForTimeout(700);
	const equalized = await readAll(page);
	h.check(
		equalized.e2.w === 200 && equalized.e2.h === 50,
		`equalize gives the second pick the FIRST one's size (${equalized.e2.w}x${equalized.e2.h})`
	);
	h.check(
		equalized.e1.w === 200 && equalized.e1.h === 50 && equalized.e1.x === 100,
		'and leaves the reference exactly as it was'
	);
	h.check(
		equalized.e2.left === 600 && equalized.e2.top === 400,
		`the resized element does not MOVE — its top-left is where it was (${equalized.e2.left},${equalized.e2.top})`
	);
	// which for a bottom-right anchor means its authored offsets had to change WITH the
	// size: x = 1280 - 600 - 200, y = 720 - 400 - 50
	h.check(
		equalized.e2.x === 480 && equalized.e2.y === 270,
		`by rewriting its offsets for the new size (x ${eStart.e2.x} -> ${equalized.e2.x}, y ${eStart.e2.y} -> ${equalized.e2.y})`
	);
	const eqUndone = await page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 500));
		const el = window.__stores.hudDocs.elementById('scene', 'e2');
		return { w: el.w, h: el.h, x: el.x, y: el.y };
	});
	h.check(
		eqUndone.w === 80 && eqUndone.h === 20 && eqUndone.x === 600 && eqUndone.y === 300,
		`one undo restores the size AND the offsets together (${JSON.stringify(eqUndone)})`
	);

	// ======================================================================
	// 7. THE CATEGORIZED ADD MENU — compared against the registry, not a copy
	// ======================================================================
	const registry = await page.evaluate(() =>
		window.__stores.hudKinds.paletteGroups().map((entry) => ({
			group: entry.group,
			items: entry.items.map((def) => def.label)
		}))
	);
	h.check(registry.length >= 3, `premise: the registry has ${registry.length} palette groups`);

	const menuAt = await page.evaluate(() => {
		const b = document.querySelector('#hud-board').getBoundingClientRect();
		return { x: Math.round(b.x + b.width * 0.3), y: Math.round(b.y + b.height * 0.2) };
	});
	await page.mouse.click(menuAt.x, menuAt.y, { button: 'right' });
	await page.waitForTimeout(700);
	const top = await menuLabels(page);
	h.check(top.includes('Add'), `the artboard menu leads with an Add submenu (${top.join(', ')})`);
	h.check(
		top.includes('Align') && top.includes('Arrange'),
		'and carries the same arrange ops as the topbar, grouped'
	);
	h.check(await hoverMenuRow(page, 'Add'), 'hovering Add opens it');
	const groups = await submenuLabels(page, 'Add');
	h.check(
		JSON.stringify(groups) === JSON.stringify(registry.map((r) => r.group)),
		`its children are EXACTLY the registry's palette groups, in order (${groups.join(', ')})`
	);
	h.check(await hoverMenuRow(page, registry[0].group), `hovering ${registry[0].group} opens its kinds`);
	const firstGroup = await submenuLabels(page, registry[0].group);
	h.check(
		JSON.stringify(firstGroup) === JSON.stringify(registry[0].items),
		`and that group lists exactly the registry's kinds, by LABEL (${firstGroup.length} of ${registry[0].items.length})`
	);
	// clicking one adds it AT the right-click point (the E1.2 contract, still true)
	const wantKind = registry[0].items[0];
	const beforeAdd = await page.evaluate(() => window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.length);
	await page.evaluate((label) => {
		const row = [...document.querySelectorAll('[role="menuitem"]')].find(
			(el) => (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim() === label
		);
		/** @type {any} */ (row)?.click();
	}, wantKind);
	await page.waitForTimeout(700);
	const afterAdd = await page.evaluate((pt) => {
		const H = window.__stores.hudDocs;
		const els = H.hudDocOf('scene').screens[0].elements;
		const el = els[els.length - 1];
		const node = document.querySelector(`#hud-board [data-hud-item="${el.id}"]`);
		const r = node?.getBoundingClientRect();
		return {
			count: els.length,
			cx: r ? Math.round(r.x + r.width / 2) : null,
			cy: r ? Math.round(r.y + r.height / 2) : null,
			wantX: pt.x,
			wantY: pt.y
		};
	}, menuAt);
	h.check(afterAdd.count === beforeAdd + 1, `a menu kind adds it (${beforeAdd} -> ${afterAdd.count})`);
	h.check(
		Math.abs(afterAdd.cx - afterAdd.wantX) <= 4 && Math.abs(afterAdd.cy - afterAdd.wantY) <= 4,
		`at the right-click point (${afterAdd.cx},${afterAdd.cy} vs ${afterAdd.wantX},${afterAdd.wantY})`
	);

	// the arrange ops in the menu obey the same minimums the buttons do
	await page.mouse.click(from.x, from.y);
	await page.waitForTimeout(300);
	await page.mouse.click(menuAt.x, menuAt.y, { button: 'right' });
	await page.waitForTimeout(600);
	await hoverMenuRow(page, 'Align');
	const alignRows = await page.evaluate(() => {
		const parent = [...document.querySelectorAll('[role="menuitem"]')].find(
			(el) => (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim() === 'Align'
		);
		const panel = parent?.querySelector(':scope > div');
		return [...(panel?.querySelectorAll(':scope > [role="menuitem"]') ?? [])].map((el) => ({
			label: (el.querySelector(':scope > span > span.flex-1')?.textContent ?? '').trim(),
			dim: el.className.includes('text-gray-400')
		}));
	});
	h.check(alignRows.length === 6, `the Align submenu carries the six align ops (${alignRows.length})`);
	h.check(
		alignRows.every((r) => r.dim),
		'all greyed out with nothing selected, exactly like the buttons'
	);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);

	await h.finish(browser);
});
