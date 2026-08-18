// A4 — the HUD dock tab: the 2D layout editor, driven through its REAL opener.
//
// The plan's own risk list, asserted: ONE undo reverts a whole drag; anchor + offset
// survive a dock resize; the artboard element and the RUNTIME element compute the same
// rect (which is the point of sharing HudElement rather than re-drawing on a canvas);
// Delete does not delete the selected 3D OBJECT; and a screen switch keeps per-screen
// selection.
//
// The tab is opened the way a user opens it — the dock's "+" add-menu — because a feature
// whose entry point the suite supplies itself is invisible when the entry point is broken
// (the shader-tab lesson).
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-editor
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ---- 1. it is the 6th FLOW_FAMILY member, opened from the real add-menu --
	const family = await page.evaluate(() => window.__stores.bottomDock.FLOW_FAMILY);
	h.check(
		family.length === 6 && family[5] === 'hud',
		`'hud' is the sixth FLOW_FAMILY member (${JSON.stringify(family)})`
	);
	const title = await page.evaluate(() => window.__stores.bottomDock.DOCK_TITLES.hud);
	h.check(title === 'HUD editor', `and has a dock title (${title})`);

	// open the Node editor dock first, so its tab strip (with the "+") is on screen
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1400);
	const plus = await page.evaluate(() => {
		const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '＋');
		if (!btn) return null;
		const r = btn.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	h.check(!!plus, 'the dock tab strip offers a "+" add button');
	await page.mouse.click(plus.x, plus.y);
	await page.waitForTimeout(700);
	const menuHasHud = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] *')].some((el) =>
			/HUD editor/.test(el.textContent ?? '')
		)
	);
	h.check(menuHasHud, 'and the menu lists the HUD editor');
	await page.evaluate(() => {
		const row = [...document.querySelectorAll('[role="menu"] *')].find(
			(el) => el.children.length === 0 && /HUD editor/.test(el.textContent ?? '')
		);
		/** @type {any} */ (row)?.click();
	});
	await page.waitForTimeout(1600);

	const opened = await page.evaluate(() => ({
		dock: !!document.querySelector('#hud-dock'),
		board: !!document.querySelector('#hud-board'),
		visible: (() => {
			let k;
			window.__stores.bottomDock.visibleDockKey.subscribe((v) => (k = v))();
			return k;
		})(),
		docCreated: !!window.__stores.hudDocs.hudDocOf('scene')
	}));
	h.check(opened.dock && opened.board, 'clicking it opens the HUD dock with its artboard');
	h.check(opened.visible === 'hud', `and makes it the visible dock panel (${opened.visible})`);
	h.check(opened.docCreated, 'and a document exists to author into');

	// ---- 2. add an element through the toolbar ------------------------------
	const added = await page.evaluate(async () => {
		const btn = document.querySelector('#hud-dock button[title="Add text"]');
		/** @type {any} */ (btn)?.click();
		await new Promise((r) => setTimeout(r, 600));
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		return {
			count: doc.screens[0].elements.length,
			items: document.querySelectorAll('#hud-board [data-hud-item]').length,
			selected: document.querySelectorAll('#hud-board .hud-item-on').length
		};
	});
	h.check(added.count === 1, `the toolbar adds an element (${added.count})`);
	h.check(added.items === 1, `the artboard renders it (${added.items})`);
	h.check(added.selected === 1, `and selects it, so the properties pane has a target (${added.selected})`);

	// ---- 3. THE ARTBOARD AND THE RUNTIME AGREE -----------------------------
	// This is the whole reason the artboard reuses HudElement instead of drawing on a
	// canvas. Compared as FRACTIONS of their stage, since the artboard is scaled to fit.
	const agree = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		// 21-D5 hides the HUD in the VIEWPORT while the editor is open (a user asked why they
		// were seeing it twice), so this comparison - artboard rect vs RUNTIME rect - needs
		// the preview on. That is the eye toggle's own store, not a test-only door.
		H.hudPreviewInViewport.set(true);
		const doc = H.hudDocOf('scene');
		const id = doc.screens[0].elements[0].id;
		H.updateHudElement('scene', doc.screens[0].id, id, {
			anchor: 'bottom-right',
			x: 64,
			y: 48,
			w: 200,
			h: 40
		});
		await new Promise((r) => setTimeout(r, 700));
		const item = document.querySelector(`#hud-board [data-hud-item="${id}"]`);
		const board = document.querySelector('#hud-board');
		const live = document.querySelector(`#hud-layer [data-hud-id="${id}"]`);
		if (!item || !board || !live) return null;
		const ir = item.getBoundingClientRect();
		const br = board.getBoundingClientRect();
		const lr = live.getBoundingClientRect();
		return {
			// distance from the element's right/bottom edge to the stage's, as a fraction
			board: {
				rightFrac: (br.right - ir.right) / br.width,
				bottomFrac: (br.bottom - ir.bottom) / br.height,
				wFrac: ir.width / br.width
			},
			live: {
				rightFrac: (window.innerWidth - lr.right) / window.innerWidth,
				bottomFrac: (window.innerHeight - lr.bottom) / window.innerHeight,
				wFrac: lr.width / window.innerWidth
			}
		};
	});
	h.check(!!agree, 'premise: the element is on the artboard AND in the runtime layer');
	h.check(
		Math.abs(agree.board.rightFrac - agree.live.rightFrac) < 0.02,
		`the artboard and the runtime place it the same distance from the right (${agree.board.rightFrac.toFixed(4)} vs ${agree.live.rightFrac.toFixed(4)})`
	);
	h.check(
		Math.abs(agree.board.wFrac - agree.live.wFrac) < 0.02,
		`and at the same relative width (${agree.board.wFrac.toFixed(4)} vs ${agree.live.wFrac.toFixed(4)})`
	);

	// ---- 4. a DRAG is ONE undo entry ---------------------------------------
	const drag = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const doc = H.hudDocOf('scene');
		const sid = doc.screens[0].id;
		const id = doc.screens[0].elements[0].id;
		// back to a simple top-left anchor so the drag maths is easy to read
		H.updateHudElement('scene', sid, id, { anchor: 'top-left', x: 100, y: 100, w: 160, h: 32 });
		return { id, sid };
	});
	await page.waitForTimeout(600);
	const grip = await page.evaluate((d) => {
		const item = document.querySelector(`#hud-board [data-hud-item="${d.id}"]`);
		const r = item.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	}, drag);
	const underGrip = await page.evaluate(
		(pt) => document.elementFromPoint(pt.x, pt.y)?.closest('[data-hud-item]')?.getAttribute('data-hud-item'),
		grip
	);
	h.check(underGrip === drag.id, `premise: the press lands on the element (${underGrip})`);

	const before = await page.evaluate((d) => {
		const el = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id);
		return { x: el.x, y: el.y };
	}, drag);
	await page.mouse.move(grip.x, grip.y);
	await page.mouse.down();
	// many small moves, so a compounding bug would show up as an overshoot
	for (let i = 1; i <= 12; i++) await page.mouse.move(grip.x + i * 6, grip.y + i * 3);
	await page.mouse.up();
	await page.waitForTimeout(700);
	const afterDrag = await page.evaluate((d) => {
		const el = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id);
		return { x: el.x, y: el.y };
	}, drag);
	h.check(
		afterDrag.x !== before.x || afterDrag.y !== before.y,
		`the drag moved it (${before.x},${before.y} -> ${afterDrag.x},${afterDrag.y})`
	);
	// 72 screen px right / 36 down, divided by the artboard scale, snapped to 8px. A
	// COMPOUNDING apply would land far past this.
	h.check(
		afterDrag.x - before.x < 400 && afterDrag.y - before.y < 300,
		`by an amount proportional to the pointer, not compounded (dx=${afterDrag.x - before.x}, dy=${afterDrag.y - before.y})`
	);
	const undone = await page.evaluate(async (d) => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 500));
		const el = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id);
		return { x: el.x, y: el.y };
	}, drag);
	h.check(
		undone.x === before.x && undone.y === before.y,
		`and ONE undo reverts the WHOLE drag (${undone.x},${undone.y})`
	);

	// ---- 5. anchor + offset survive a DOCK RESIZE --------------------------
	// The reason anchors are a 9-grid plus pixels rather than fractions.
	const beforeResize = await page.evaluate((d) => {
		const el = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id);
		const live = document.querySelector(`#hud-layer [data-hud-id="${d.id}"]`).getBoundingClientRect();
		return { x: el.x, y: el.y, anchor: el.anchor, liveLeft: Math.round(live.left), liveW: Math.round(live.width) };
	}, drag);
	await page.evaluate(() => window.__stores.bottomDock.dockHeight.set(520));
	await page.waitForTimeout(900);
	const afterResize = await page.evaluate((d) => {
		const el = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id);
		const live = document.querySelector(`#hud-layer [data-hud-id="${d.id}"]`).getBoundingClientRect();
		const board = document.querySelector('#hud-board').getBoundingClientRect();
		return {
			x: el.x,
			y: el.y,
			anchor: el.anchor,
			liveLeft: Math.round(live.left),
			liveW: Math.round(live.width),
			boardW: Math.round(board.width)
		};
	}, drag);
	h.check(
		afterResize.x === beforeResize.x && afterResize.y === beforeResize.y && afterResize.anchor === beforeResize.anchor,
		`a dock resize changes NO authored value (${JSON.stringify(afterResize)})`
	);
	h.check(
		afterResize.liveLeft === beforeResize.liveLeft && afterResize.liveW === beforeResize.liveW,
		`and the runtime element does not move or stretch (${beforeResize.liveLeft}/${beforeResize.liveW} -> ${afterResize.liveLeft}/${afterResize.liveW})`
	);
	await page.evaluate(() => window.__stores.bottomDock.dockHeight.set(320));
	await page.waitForTimeout(600);

	// ---- 6. DELETE removes the element and NOT the selected object ---------
	// Unhandled, Delete deletes the 3D object — the exact trap the UV editor documented.
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1600);
	const withObject = await page.evaluate(() => {
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		return read(window.__stores.objectsGroup).then((g) => {
			let n = 0;
			g.traverse((o) => {
				if (o.isMesh) n++;
			});
			return n;
		});
	});
	h.check(withObject > 0, `premise: a box exists and is selected (${withObject} meshes)`);

	const deleted = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const doc = H.hudDocOf('scene');
		const sid = doc.screens[0].id;
		// add a second element and select it, so there is something to delete
		const el = H.addHudElement('scene', sid, { kind: 'text', label: 'doomed', anchor: 'top-left', x: 300, y: 40 });
		await new Promise((r) => setTimeout(r, 600));
		const item = document.querySelector(`#hud-board [data-hud-item="${el.id}"]`);
		const r = item.getBoundingClientRect();
		return { id: el.id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	await page.mouse.click(deleted.x, deleted.y);
	await page.waitForTimeout(400);
	await page.keyboard.press('Delete');
	await page.waitForTimeout(900);
	const afterDelete = await page.evaluate(() => {
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		return read(window.__stores.objectsGroup).then((g) => {
			let meshes = 0;
			g.traverse((o) => {
				if (o.isMesh) meshes++;
			});
			return {
				meshes,
				elements: window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.map((e) => e.label)
			};
		});
	});
	h.check(
		!afterDelete.elements.includes('doomed'),
		`Delete removes the selected ELEMENT (${JSON.stringify(afterDelete.elements)})`
	);
	h.check(
		afterDelete.meshes === withObject,
		`and the 3D object is UNTOUCHED — Delete is swallowed (${withObject} -> ${afterDelete.meshes} meshes)`
	);

	// ---- 7. a screen switch keeps PER-SCREEN selection ---------------------
	const perScreen = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const doc = H.hudDocOf('scene');
		const first = doc.screens[0].id;
		const second = H.addHudScreen('scene', 'Second');
		H.addHudElement('scene', second, { kind: 'button', label: 'on two', anchor: 'center' });
		await new Promise((r) => setTimeout(r, 700));
		// pick on screen ONE
		const onOne = document.querySelector('#hud-board [data-hud-item]');
		/** @type {any} */ (onOne)?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		await new Promise((r) => setTimeout(r, 300));
		const pickOne = [...document.querySelectorAll('#hud-board .hud-item-on')].map((e) => e.getAttribute('data-hud-item'));
		// switch to screen TWO through its real sidebar row
		const rows = [...document.querySelectorAll('#hud-dock .hud-screen-name')];
		const secondRow = rows.find((r) => /Second/.test(r.textContent ?? ''));
		/** @type {any} */ (secondRow)?.click();
		await new Promise((r) => setTimeout(r, 600));
		const onTwo = [...document.querySelectorAll('#hud-board .hud-item-on')].length;
		const twoItems = document.querySelectorAll('#hud-board [data-hud-item]').length;
		// and back
		const firstRow = [...document.querySelectorAll('#hud-dock .hud-screen-name')].find(
			(r) => !/Second/.test(r.textContent ?? '')
		);
		/** @type {any} */ (firstRow)?.click();
		await new Promise((r) => setTimeout(r, 600));
		const backAgain = [...document.querySelectorAll('#hud-board .hud-item-on')].map((e) => e.getAttribute('data-hud-item'));
		return { first, second, pickOne, onTwo, twoItems, backAgain };
	});
	h.check(perScreen.pickOne.length === 1, `premise: something is picked on screen one (${JSON.stringify(perScreen.pickOne)})`);
	h.check(perScreen.twoItems === 1, `switching screens shows the OTHER screen's elements (${perScreen.twoItems})`);
	h.check(
		perScreen.onTwo === 0,
		`with nothing selected there yet — selection is per SCREEN (${perScreen.onTwo})`
	);
	h.check(
		JSON.stringify(perScreen.backAgain) === JSON.stringify(perScreen.pickOne),
		`and coming back restores the original pick (${JSON.stringify(perScreen.backAgain)})`
	);

	// ---- 8. the right-click menu is OURS, not the browser's ---------------
	// A menu opens on the button RELEASE and `contextmenu` is dispatched AFTER mouseup, so
	// a real right-click is the only honest way to check this.
	// CAPTURE phase at window level, holding the event OBJECT. A bubble-phase listener
	// here would never fire: the artboard handler calls stopPropagation, which is itself
	// part of the contract. `defaultPrevented` is a live property, so reading it after the
	// dispatch has finished reports the preventDefault the handler called downstream.
	await page.evaluate(() => {
		window.__ctxEvents = [];
		window.addEventListener(
			'contextmenu',
			(e) => window.__ctxEvents.push(e),
			true
		);
		window.__ctxBubbled = 0;
		window.addEventListener('contextmenu', () => window.__ctxBubbled++);
	});
	const boardPoint = await page.evaluate(() => {
		const b = document.querySelector('#hud-board').getBoundingClientRect();
		// the CENTRE of an empty quadrant: a corner can sit under the size grip or an
		// element, and a point outside the board raises the BROWSER menu instead
		const x = Math.round(b.x + b.width * 0.75);
		const y = Math.round(b.y + b.height * 0.75);
		const at = document.elementFromPoint(x, y);
		return { x, y, hit: at?.id || at?.className || at?.tagName };
	});
	h.check(
		/hud-board|hud-item/.test(String(boardPoint.hit)),
		`premise: the right-click point is ON the artboard (${boardPoint.hit})`
	);
	await page.mouse.click(boardPoint.x, boardPoint.y, { button: 'right' });
	await page.waitForTimeout(700);
	const ctx = await page.evaluate(() => ({
		prevented: window.__ctxEvents.map((e) => e.defaultPrevented),
		targets: window.__ctxEvents.map((e) => e.target?.id || e.target?.className || e.target?.tagName),
		bubbled: window.__ctxBubbled,
		menuOpen: !!document.querySelector('[role="menu"]')
	}));
	h.check(ctx.menuOpen, 'a real right-click opens OUR context menu on the artboard');
	h.check(
		ctx.prevented.length > 0 && ctx.prevented.every(Boolean),
		`and the browser own menu is prevented (${JSON.stringify(ctx.prevented)} on ${JSON.stringify(ctx.targets)})`
	);
	h.check(
		ctx.bubbled === 0,
		`and the event never reaches the window in the bubble phase, so no ancestor can also act on it (${ctx.bubbled})`
	);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);

	// ---- 9. the tab comes back after PLAY MODE (flowDockSnapshot) ---------
	// Miss the snapshot line in Controls and the tab is gone for good.
	const playRound = await page.evaluate(async () => {
		const s = window.__stores;
		const wasOpen = !s.hudEditorClose ? null : (() => {
			let v;
			s.hudEditorClose.subscribe((x) => (v = x))();
			return v;
		})();
		return { wasOpen };
	});
	h.check(playRound.wasOpen === false, `premise: the HUD editor is open (close=${playRound.wasOpen})`);
	// the Controls button is what carries the snapshot logic
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1000);
	const hidden = await page.evaluate(() => {
		let hud, flow;
		window.__stores.hudEditorClose.subscribe((v) => (hud = v))();
		window.__stores.flowGraphClose.subscribe((v) => (flow = v))();
		return { hud, flow, dockInDom: !!document.querySelector('#hud-dock') };
	});
	h.check(hidden.hud === true && hidden.flow === true, 'toggling the dock off hides the HUD tab with the family');
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1400);
	const back = await page.evaluate(() => {
		let hud;
		window.__stores.hudEditorClose.subscribe((v) => (hud = v))();
		return { hud, dockInDom: !!document.querySelector('#hud-dock') };
	});
	h.check(
		back.hud === false,
		`and toggling it on RESTORES the HUD tab — the flowDockSnapshot line (close=${back.hud})`
	);

	await h.finish(browser);
});
