// 18-B: a floating window can never end up bigger than the screen.
//
// The trap this closes: the only way to resize is the bottom-right grip, so a
// window larger than the viewport puts its own grip off-screen and can never be
// shrunk again. Three defences, all checked here — the corner stops at the
// viewport edge while dragging, a size restored from localStorage is re-fitted
// on load, and a double-click on the grip resets the size outright.
const h = require('./helpers.cjs');
const path = require('path');
const { pathToFileURL } = require('url');

h.run(async () => {
	// ---- pure helpers first: the rules, without a browser ------------------
	// (windowSize.js is DOM-free and ESM, so it loads straight into node)
	const { clampWinSize, clampResize } = await import(
		pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', 'windowSize.js')).href
	);
	// the viewport cap must WIN over the minimum — the old `Math.max(min, …)`
	// ordering is exactly what produced a window wider than the screen
	global.window = { innerWidth: 320, innerHeight: 480 };
	let fit = clampWinSize(720, 440, { minW: 420, minH: 280 });
	h.check(fit.w <= 320 && fit.h <= 480, `a 420px minimum cannot exceed a 320px viewport (${fit.w}x${fit.h})`);

	global.window = { innerWidth: 1200, innerHeight: 800 };
	fit = clampWinSize(720, 440, { minW: 420, minH: 280 });
	h.check(fit.w === 720 && fit.h === 440, `a size that already fits is untouched (${fit.w}x${fit.h})`);

	// the corner may not pass the viewport edge, so the grip stays grabbable
	fit = clampResize(2000, 2000, 400, 300, { minW: 280, minH: 240 });
	h.check(400 + fit.w <= 1200 && 300 + fit.h <= 800, `the corner stops at the edge (right=${400 + fit.w}, bottom=${300 + fit.h})`);

	// a window shoved partly off the LEFT may use the space it has, and a
	// negative anchor must not inflate the cap
	fit = clampResize(5000, 5000, -100, -50, { minW: 280, minH: 240 });
	h.check(fit.w <= 1192 && fit.h <= 792, `a negative anchor does not inflate the cap (${fit.w}x${fit.h})`);
	delete global.window;

	// ---- and now the real windows -------------------------------------------
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const viewport = await A.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

	// Seed every window's persisted size ENORMOUS, then reload: this is the
	// "saved on a bigger monitor" case, and the whole point is that it heals.
	await A.page.evaluate(() => {
		localStorage.setItem('explorerWinW', '5000');
		localStorage.setItem('explorerWinH', '4000');
		localStorage.setItem('uvWinW', '5000');
		localStorage.setItem('uvWinH', '4000');
		localStorage.setItem('animationWinW', '5000');
		localStorage.setItem('animationWinH', '4000');
		localStorage.setItem('flowWinW', '5000');
		localStorage.setItem('flowWinH', '4000');
		// the toolbox rides dragWindow's own record
		localStorage.setItem('win:meshToolbox', JSON.stringify({ left: 40, top: 90, w: 5000 }));
		localStorage.setItem('objectListRect', JSON.stringify({ left: 350, top: 100, width: 5000, height: 4000 }));
		// undock them so the floating sizes actually apply
		localStorage.setItem('explorerDocked', 'false');
		localStorage.setItem('uvDocked', 'false');
		localStorage.setItem('animationDocked', 'false');
		localStorage.setItem('flowDocked', 'false');
	});
	await h.freshReload(A);
	await A.page.waitForTimeout(2500);

	const sized = await A.page.evaluate(() => ({
		explorerW: parseInt(localStorage.getItem('explorerWinW') ?? '0'),
		flowW: parseInt(localStorage.getItem('flowWinW') ?? '0')
	}));
	// the stored value is only rewritten on the next save; what matters is the
	// RENDERED size, checked per window below
	void sized;

	/** open a window and measure what the user actually sees */
	async function measure(page, opener, selector) {
		await page.evaluate(opener);
		await page.waitForTimeout(900);
		return page.evaluate((sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
		}, selector);
	}

	const windows = [
		['Explorer', () => window.__stores.explorerClose.set(false), '#explorer-window'],
		['Node editor', () => window.__stores.flowGraphClose.set(false), '#flow-window'],
		['UV editor', () => window.__stores.uvEditorClose.set(false), '#uv-window'],
		['Animation', () => window.__stores.animationClose.set(false), '#animation-window']
	];
	for (const [name, opener, sel] of windows) {
		const box = await measure(A.page, opener, sel);
		if (!box) {
			h.check(false, `${name}: window did not open (${sel})`);
			continue;
		}
		h.check(
			box.w <= viewport.w && box.h <= viewport.h,
			`${name} restores INSIDE the viewport (${box.w}x${box.h} in ${viewport.w}x${viewport.h})`
		);
		// and the grip is on-screen, which is the property that actually matters
		h.check(
			box.right <= viewport.w + 1 && box.bottom <= viewport.h + 1,
			`${name}'s resize grip is reachable (corner at ${box.right},${box.bottom})`
		);
	}

	// the object list: same story, its own hand-rolled rect
	const listBox = await measure(A.page, () => window.__stores.objectListClose.set(false), '#object-list');
	if (listBox) {
		h.check(
			listBox.w <= viewport.w && listBox.h <= viewport.h,
			`object list restores INSIDE the viewport (${listBox.w}x${listBox.h})`
		);
		h.check(
			listBox.right <= viewport.w + 1 && listBox.bottom <= viewport.h + 1,
			`object list's grip is reachable (corner at ${listBox.right},${listBox.bottom})`
		);
	} else {
		console.log('  (object list not open — skipping its rect checks)');
	}

	// ---- the toolbox (dragWindow's own resizable path) ----------------------
	// close the editor windows first: on a small viewport they cover most of the
	// screen, and "another window is on top of this one" is normal windowing, not
	// the bug under test (an unreachable grip on an EMPTY desktop is)
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.explorerClose.set(true);
		s.flowGraphClose.set(true);
		s.uvEditorClose.set(true);
		s.animationClose.set(true);
		s.objectListClose.set(true);
	});
	await A.page.waitForTimeout(500);
	await A.page.evaluate(async () => {
		const { commandsHandler, objectsGroup, objectActions, faceEdit } = window.__stores;
		commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 700));
		let group = null;
		objectsGroup.subscribe((g) => (group = g))();
		const box = group.children[group.children.length - 1];
		objectActions.selectObject(box.uuid);
		faceEdit.enterFaceEdit(box.uuid);
	});
	await A.page.waitForTimeout(900);

	const toolbox = await A.page.evaluate(() => {
		const el = document.querySelector('#mesh-edit-popup');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { w: Math.round(r.width), right: Math.round(r.right) };
	});
	h.check(!!toolbox, 'the mesh toolbox is open');
	if (toolbox)
		h.check(
			toolbox.w <= viewport.w && toolbox.right <= viewport.w + 1,
			`a 5000px persisted toolbox width is refitted (${toolbox.w}px, right edge ${toolbox.right})`
		);

	// Dragging the grip cannot take the corner off-screen — and, just as important,
	// the window must not JUMP. Park it well to the right first: capping at "the
	// viewport width" alone (the old rule) let it grow to the full width, and the
	// position clamp then yanked it back to the left edge under the user's cursor.
	// Bounding the size by the anchor limits the WIDTH instead, so it stays put.
	const dragged = await A.page.evaluate(async () => {
		const el = document.querySelector('#mesh-edit-popup');
		const grip = el?.querySelector('.dw-resize');
		if (!grip) return null;
		// move it with the REAL header drag — writing style.left directly would
		// desync dragWindow's own model and the check would prove nothing
		const header = el.querySelector('.toolbox-header');
		const drag = (type, dx) =>
			header.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 2, movementX: dx, movementY: 0 }));
		drag('pointerdown', 0);
		for (let i = 0; i < 22; i++) drag('pointermove', 40);
		drag('pointerup', 0);
		await new Promise((r) => setTimeout(r, 200));
		const parkedAt = Math.round(el.getBoundingClientRect().left);
		const send = (type, dx) =>
			grip.dispatchEvent(
				new PointerEvent(type, { bubbles: true, pointerId: 1, movementX: dx, movementY: 0 })
			);
		send('pointerdown', 0);
		for (let i = 0; i < 40; i++) send('pointermove', 200); // pull far past the edge
		send('pointerup', 0);
		await new Promise((r) => setTimeout(r, 200));
		const rect = el.getBoundingClientRect();
		return { parkedAt, w: Math.round(rect.width), left: Math.round(rect.left), right: Math.round(rect.right) };
	});
	h.check(!!dragged, 'the toolbox grip exists');
	if (dragged) {
		h.check(dragged.parkedAt >= 700, `premise: the window is parked right (left ${dragged.parkedAt})`);
		h.check(
			dragged.right <= viewport.w + 1,
			`dragging the grip 8000px right keeps the corner on-screen (right edge ${dragged.right} of ${viewport.w})`
		);
		h.check(
			Math.abs(dragged.left - dragged.parkedAt) <= 2,
			`and the window does not jump back to the left edge (${dragged.parkedAt} -> ${dragged.left})`
		);
	}

	// double-click the grip: back to the CSS default width, position kept
	const afterReset = await A.page.evaluate(async () => {
		const el = document.querySelector('#mesh-edit-popup');
		const before = el.getBoundingClientRect();
		el.querySelector('.dw-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 250));
		const after = el.getBoundingClientRect();
		let stored = null;
		try {
			stored = JSON.parse(localStorage.getItem('win:meshToolbox') ?? 'null');
		} catch {}
		return {
			widthBefore: Math.round(before.width),
			widthAfter: Math.round(after.width),
			leftBefore: Math.round(before.left),
			leftAfter: Math.round(after.left),
			storedW: stored?.w ?? null,
			inlineWidth: el.style.width
		};
	});
	h.check(
		afterReset.widthAfter < afterReset.widthBefore,
		`double-click shrinks the toolbox back (${afterReset.widthBefore} -> ${afterReset.widthAfter})`
	);
	h.check(afterReset.inlineWidth === '', 'the inline width is removed, so the CSS default wins again');
	h.check(afterReset.storedW === null || afterReset.storedW === undefined, 'the persisted size is dropped');
	h.check(
		Math.abs(afterReset.leftAfter - afterReset.leftBefore) <= 2,
		`the window stays where the user put it (${afterReset.leftBefore} -> ${afterReset.leftAfter})`
	);

	// ---- a shrinking viewport re-fits what is already open ------------------
	await A.page.setViewportSize({ width: 700, height: 560 });
	await A.page.waitForTimeout(900);
	const afterShrink = await A.page.evaluate(() => {
		const out = {};
		for (const [name, sel] of [
			['explorer', '#explorer-window'],
			['flow', '#flow-window'],
			['toolbox', '#mesh-edit-popup']
		]) {
			const el = document.querySelector(sel);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			out[name] = { w: Math.round(r.width), h: Math.round(r.height) };
		}
		return out;
	});
	for (const [name, box] of Object.entries(afterShrink))
		h.check(box.w <= 700 && box.h <= 560, `${name} re-fits when the viewport shrinks (${box.w}x${box.h})`);

	// The toolbox is WIDTH-resizable only (dragWindow axis:'x') so its height hugs
	// its content — which is how its own grip ended up at y=830 on a 720px
	// viewport, off-screen and unreachable by a real mouse (this is what a user
	// hits as "I can't resize it back"). The body scrolls instead.
	const toolboxFit = await A.page.evaluate(() => {
		const el = document.querySelector('#mesh-edit-popup');
		const body = el?.querySelector('.toolbox-body');
		const grip = el?.querySelector('.dw-resize');
		if (!el || !body || !grip) return null;
		const r = el.getBoundingClientRect();
		const g = grip.getBoundingClientRect();
		return {
			bottom: Math.round(r.bottom),
			scrolls: body.scrollHeight > body.clientHeight,
			overflowY: getComputedStyle(body).overflowY,
			// the property that actually matters: can a real pointer reach the grip?
			atGrip: document.elementFromPoint(g.x + 8, g.y + 8)?.className ?? 'nothing'
		};
	});
	h.check(!!toolboxFit, 'the toolbox is still open for the height checks');
	if (toolboxFit) {
		h.check(toolboxFit.bottom <= 560 + 1, `the toolbox fits the viewport height (bottom ${toolboxFit.bottom} of 560)`);
		h.check(toolboxFit.overflowY === 'auto', `its body scrolls instead of overflowing (overflow-y: ${toolboxFit.overflowY})`);
		h.check(toolboxFit.scrolls, 'and it really is scrolling at this height (premise: the content is taller)');
		h.check(
			String(toolboxFit.atGrip).includes('dw-resize'),
			`a real pointer can reach the resize grip (elementFromPoint: ${toolboxFit.atGrip})`
		);
	}

	await h.finish(browser);
});
